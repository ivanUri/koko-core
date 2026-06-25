// Fetch Google sg_ss= document hops via curl_chrome146 subprocess.
// In-process libcurl (multi or easy) can stall on multi-kB sg_ss URLs; the CLI
// binary completes in <1s with minimal headers (see capture-and-curl-sgss.mjs).
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
};

/// Guest HAR: Referer + Sec-Fetch-* only; curl_chrome146 supplies UA/TLS/Accept.
pub fn fetchSgSsDocument(
    allocator: Allocator,
    url: [:0]const u8,
    headers: http.Headers,
) !Document {
    var referer: ?[]const u8 = null;
    var it = headers.iterator();
    while (it.next()) |hdr| {
        if (std.ascii.eqlIgnoreCase(hdr.name, "referer")) {
            referer = hdr.value;
        }
    }
    return fetchWithExtraHeaders(allocator, url, referer, &.{
        "Sec-Fetch-Site: same-origin",
        "Sec-Fetch-Mode: navigate",
        "Sec-Fetch-Dest: document",
    });
}

fn fetchWithExtraHeaders(
    allocator: Allocator,
    url: [:0]const u8,
    referer: ?[]const u8,
    extra: []const []const u8,
) !Document {
    const curl_bin = try resolveCurlCliPath(allocator);
    var argv = std.ArrayList([]const u8).empty;
    defer argv.deinit(allocator);

    try argv.appendSlice(allocator, &.{ curl_bin, "-sS", "--max-time", "15" });

    if (referer) |ref| {
        const line = try std.fmt.allocPrintSentinel(allocator, "Referer: {s}", .{ref}, 0);
        try argv.append(allocator, "-H");
        try argv.append(allocator, line);
    }
    for (extra) |hdr| {
        try argv.append(allocator, "-H");
        try argv.append(allocator, hdr);
    }

    const write_fmt = "\\n---VELORA-META---\\nstatus=%{http_code} url=%{url_effective} proto=%{http_version}";
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

    var it = std.mem.splitScalar(u8, meta, ' ');
    while (it.next()) |tok| {
        if (std.mem.startsWith(u8, tok, "status=")) {
            status = try std.fmt.parseInt(u16, tok["status=".len..], 10);
        } else if (std.mem.startsWith(u8, tok, "url=")) {
            final_url = tok["url=".len..];
        } else if (std.mem.startsWith(u8, tok, "proto=")) {
            proto = tok["proto=".len..];
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
