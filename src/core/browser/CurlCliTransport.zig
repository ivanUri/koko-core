// Fetch Google sg_ss= document hops via curl_chrome146 subprocess.
// In-process libcurl (multi or easy) can stall on multi-kB sg_ss URLs; the CLI
// binary completes in <1s with minimal headers (curl_chrome146 subprocess).
const std = @import("std");
const log = @import("../../support/log.zig");

const http = @import("../../runtime/network/http.zig");

const Allocator = std.mem.Allocator;

pub const Document = struct {
    status: u16,
    final_url: [:0]const u8,
    content_type: []const u8,
    body: []const u8,
    protocol: ?[]const u8 = null,
    redirect_count: u8 = 0,
};

/// Profile headers (incl. X-Browser) + curl_chrome146 TLS/HTTP2. Follows redirects like Chrome.
pub fn fetchSgSsDocument(
    allocator: Allocator,
    url: [:0]const u8,
    headers: http.Headers,
    user_agent: [:0]const u8,
) !Document {
    const curl_bin = try resolveCurlCliPath(allocator);
    var argv = std.ArrayList([]const u8).empty;
    defer argv.deinit(allocator);

    try argv.appendSlice(allocator, &.{ curl_bin, "-sS", "-L", "--max-redirs", "10", "--max-time", "15" });

    const ua_line = try std.fmt.allocPrintSentinel(allocator, "User-Agent: {s}", .{user_agent}, 0);
    try argv.append(allocator, "-H");
    try argv.append(allocator, ua_line);

    var it = headers.iterator();
    while (it.next()) |hdr| {
        if (std.ascii.eqlIgnoreCase(hdr.name, "cookie")) continue;
        if (std.ascii.eqlIgnoreCase(hdr.name, "user-agent")) continue;
        if (std.ascii.eqlIgnoreCase(hdr.name, "sec-fetch-user")) continue;
        const line = try std.fmt.allocPrintSentinel(allocator, "{s}: {s}", .{ hdr.name, hdr.value }, 0);
        try argv.append(allocator, "-H");
        try argv.append(allocator, line);
    }

    const write_fmt = "\\n---VELORA-META---\\nstatus=%{http_code} url=%{url_effective} proto=%{http_version} redirects=%{num_redirects}";
    try argv.appendSlice(allocator, &.{ "-w", write_fmt, url });

    var child = std.process.Child.init(argv.items, allocator);
    if (std.posix.getenv("VELORA_ROOT")) |root| {
        child.cwd = root;
    }
    child.stdout_behavior = .Pipe;
    child.stderr_behavior = .Ignore;
    try child.spawn();

    const stdout = try child.stdout.?.readToEndAlloc(allocator, 32 * 1024 * 1024);
    defer allocator.free(stdout);

    const term = try child.wait();
    if (term != .Exited or term.Exited != 0) {
        log.err(.http, "curl cli sg_ss failed", .{ .term = term });
        return error.CurlCliFailed;
    }

    return try parseCombinedOutput(allocator, stdout);
}

const meta_marker = "\n---VELORA-META---\n";

fn parseCombinedOutput(allocator: Allocator, stdout: []const u8) !Document {
    const meta_start = std.mem.indexOf(u8, stdout, meta_marker) orelse return error.CurlCliBadResponse;
    const body = stdout[0..meta_start];
    const meta = stdout[meta_start + meta_marker.len ..];

    var status: u16 = 0;
    var final_url: []const u8 = "";
    var proto: []const u8 = "";
    var redirect_count: u8 = 0;

    var it = std.mem.splitScalar(u8, meta, ' ');
    while (it.next()) |tok| {
        if (std.mem.startsWith(u8, tok, "status=")) {
            status = try std.fmt.parseInt(u16, tok["status=".len..], 10);
        } else if (std.mem.startsWith(u8, tok, "url=")) {
            final_url = tok["url=".len..];
        } else if (std.mem.startsWith(u8, tok, "proto=")) {
            proto = tok["proto=".len..];
        } else if (std.mem.startsWith(u8, tok, "redirects=")) {
            redirect_count = @intCast(try std.fmt.parseInt(u16, tok["redirects=".len..], 10));
        }
    }

    if (status == 0 or final_url.len == 0) return error.CurlCliBadResponse;

    const body_copy = try allocator.dupe(u8, body);
    const url_copy = try allocator.dupeZ(u8, final_url);
    const protocol = if (proto.len > 0) try allocator.dupe(u8, proto) else null;

    return .{
        .status = status,
        .final_url = url_copy,
        .content_type = "text/html; charset=UTF-8",
        .body = body_copy,
        .protocol = protocol,
        .redirect_count = redirect_count,
    };
}

fn resolveCurlCliPath(allocator: Allocator) ![:0]const u8 {
    if (std.posix.getenv("VELORA_CURL_IMPERSONATE")) |p| {
        return try allocator.dupeZ(u8, p);
    }
    const root = std.posix.getenv("VELORA_ROOT") orelse ".";
    return try std.fmt.allocPrintSentinel(
        allocator,
        "{s}/vendor/curl-impersonate/curl_chrome146",
        .{root},
        0,
    );
}
