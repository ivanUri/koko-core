// Fetch Google document navigations via real Chrome (Playwright helper script).
const std = @import("std");
const base64 = std.base64;
const posix = std.posix;
const log = @import("../../support/log.zig");

const http = @import("../../runtime/network/http.zig");

const Allocator = std.mem.Allocator;

pub const Document = struct {
    status: u16,
    final_url: [:0]const u8,
    content_type: []const u8,
    body: []const u8,
    protocol: ?[]const u8 = null,
};

/// Non-blocking child-process fetch polled from HttpClient.tick().
pub const AsyncJob = struct {
    arena: Allocator,
    stdin_json: []const u8,
    aborted: bool = false,
    spawned: bool = false,
    /// Set after poll() reaps the child via waitpid(WNOHANG).
    child_waited: bool = false,
    child: ?std.process.Child = null,
    stdout: std.ArrayList(u8) = .empty,
    stderr: std.ArrayList(u8) = .empty,
    document: ?Document = null,
    err: ?anyerror = null,

    pub fn spawn(allocator: Allocator, url: [:0]const u8, headers: http.Headers) !*AsyncJob {
        const stdin_json = try buildRequestJson(allocator, url, headers);
        const self = try allocator.create(AsyncJob);
        self.* = .{
            .arena = allocator,
            .stdin_json = stdin_json,
        };
        return self;
    }

    /// Child-process cleanup only. All other fields live on `self.arena` and are
    /// released when HttpClient.deinitRequest() returns the arena to the pool.
    pub fn deinit(self: *AsyncJob, _: Allocator) void {
        if (self.child) |*child| {
            if (!self.child_waited) {
                _ = child.kill() catch {};
                _ = child.wait() catch {};
            }
            if (child.stdout) |stdout| stdout.close();
            if (child.stderr) |stderr| stderr.close();
        }
    }

    pub fn poll(self: *AsyncJob) PollStatus {
        if (self.aborted) return .{ .aborted = {} };
        if (self.err != null) return .{ .err = self.err.? };
        if (self.document != null) return .{ .document = self.document.? };

        if (!self.spawned) {
            self.spawnChild() catch |err| {
                self.err = err;
                return .{ .err = err };
            };
            self.spawned = true;
            return .running;
        }

        const child = &self.child.?;
        self.drainPipe(child.stdout, &self.stdout) catch |err| {
            self.err = err;
            return .{ .err = err };
        };
        self.drainPipe(child.stderr, &self.stderr) catch |err| {
            self.err = err;
            return .{ .err = err };
        };

        const wait = posix.waitpid(child.id, 1); // WNOHANG
        if (wait.pid == 0) return .running;
        // Child exited — drain any remaining pipe bytes before parsing JSON.
        self.drainPipe(child.stdout, &self.stdout) catch |err| {
            self.err = err;
            return .{ .err = err };
        };
        self.drainPipe(child.stderr, &self.stderr) catch |err| {
            self.err = err;
            return .{ .err = err };
        };
        self.child_waited = true;
        if (!posix.W.IFEXITED(wait.status)) {
            self.err = error.ChromeTransportFailed;
            return .{ .err = error.ChromeTransportFailed };
        }
        const code = posix.W.EXITSTATUS(wait.status);
        if (code != 0) {
            log.err(.http, "chrome transport failed", .{
                .stderr = self.stderr.items,
                .exit = code,
            });
            self.err = error.ChromeTransportFailed;
            return .{ .err = error.ChromeTransportFailed };
        }
        self.document = parseResponse(self.arena, self.stdout.items) catch |err| {
            self.err = err;
            return .{ .err = err };
        };
        return .{ .document = self.document.? };
    }

    pub const PollStatus = union(enum) {
        running,
        aborted: void,
        err: anyerror,
        document: Document,
    };

    fn spawnChild(self: *AsyncJob) !void {
        const script = scriptPath() orelse return error.ChromeTransportScriptNotFound;
        var child = std.process.Child.init(&.{ "node", script }, self.arena);
        if (std.posix.getenv("KOKO_ROOT")) |root| {
            child.cwd = root;
        }
        var env_map = try std.process.getEnvMap(self.arena);
        if (env_map.get("KOKO_CHROME_SPAWN") == null) {
            try env_map.put("KOKO_CHROME_SPAWN", "1");
        }
        child.env_map = &env_map;
        child.stdin_behavior = .Pipe;
        child.stdout_behavior = .Pipe;
        child.stderr_behavior = .Pipe;
        try child.spawn();

        if (child.stdin) |stdin| {
            try stdin.writeAll(self.stdin_json);
            stdin.close();
        }
        if (child.stdout) |stdout| try setNonBlocking(stdout);
        if (child.stderr) |stderr| try setNonBlocking(stderr);

        self.child = child;
    }

    fn setNonBlocking(file: std.fs.File) !void {
        const fd = file.handle;
        const flags = try posix.fcntl(fd, posix.F.GETFL, 0);
        const nonblocking = @as(u32, @bitCast(posix.O{ .NONBLOCK = true }));
        _ = try posix.fcntl(fd, posix.F.SETFL, flags | nonblocking);
    }

    fn drainPipe(self: *AsyncJob, pipe: ?std.fs.File, buf: *std.ArrayList(u8)) !void {
        const file = pipe orelse return;
        var tmp: [16 * 1024]u8 = undefined;
        while (true) {
            const n = posix.read(file.handle, &tmp) catch |err| switch (err) {
                error.WouldBlock => return,
                else => return err,
            };
            if (n == 0) return;
            try buf.appendSlice(self.arena, tmp[0..n]);
        }
    }
};

pub fn buildRequestJson(allocator: Allocator, url: [:0]const u8, headers: http.Headers) ![]const u8 {
    var buf: std.ArrayList(u8) = .empty;
    defer buf.deinit(allocator);
    try buf.append(allocator, '{');
    try buf.writer(allocator).print("\"url\":", .{});
    try appendJsonString(allocator, &buf, url);
    try buf.appendSlice(allocator, ",\"headers\":[");
    var first = true;
    var it = headers.iterator();
    while (it.next()) |hdr| {
        if (!first) try buf.append(allocator, ',');
        first = false;
        try buf.append(allocator, '[');
        try appendJsonString(allocator, &buf, hdr.name);
        try buf.append(allocator, ',');
        try appendJsonString(allocator, &buf, hdr.value);
        try buf.append(allocator, ']');
    }
    try buf.appendSlice(allocator, "]}");
    return try buf.toOwnedSlice(allocator);
}

fn appendJsonString(allocator: Allocator, buf: *std.ArrayList(u8), s: []const u8) !void {
    try buf.append(allocator, '"');
    for (s) |c| {
        switch (c) {
            '"' => try buf.appendSlice(allocator, "\\\""),
            '\\' => try buf.appendSlice(allocator, "\\\\"),
            '\n' => try buf.appendSlice(allocator, "\\n"),
            '\r' => try buf.appendSlice(allocator, "\\r"),
            '\t' => try buf.appendSlice(allocator, "\\t"),
            else => try buf.append(allocator, c),
        }
    }
    try buf.append(allocator, '"');
}

fn scriptPath() ?[:0]const u8 {
    if (std.posix.getenv("KOKO_CHROME_TRANSPORT_SCRIPT")) |p| return p;
    return "scripts/chrome-google-transport.mjs";
}

fn parseResponse(allocator: Allocator, stdout: []const u8) !Document {
    const parsed = try std.json.parseFromSliceLeaky(struct {
        @"error": ?[]const u8 = null,
        status: ?u16 = null,
        finalUrl: ?[]const u8 = null,
        contentType: ?[]const u8 = null,
        bodyBase64: ?[]const u8 = null,
        protocol: ?[]const u8 = null,
    }, allocator, stdout, .{ .ignore_unknown_fields = true });

    if (parsed.@"error" != null or parsed.status == null) {
        return error.ChromeTransportBadResponse;
    }

    const body = blk: {
        const b64 = parsed.bodyBase64 orelse break :blk try allocator.alloc(u8, 0);
        const decoder = base64.standard.Decoder;
        const decoded_len = try decoder.calcSizeForSlice(b64);
        const decoded = try allocator.alloc(u8, decoded_len);
        try decoder.decode(decoded, b64);
        break :blk decoded;
    };
    const final_url = try allocator.dupeZ(u8, parsed.finalUrl orelse "");
    const content_type = try allocator.dupe(u8, parsed.contentType orelse "text/html; charset=UTF-8");

    return .{
        .status = parsed.status.?,
        .final_url = final_url,
        .content_type = content_type,
        .body = body,
        .protocol = if (parsed.protocol) |p| try allocator.dupe(u8, p) else null,
    };
}
