const std = @import("std");

const js = @import("../../js/js.zig");
const HttpClient = @import("../../browser/HttpClient.zig");
const ReferrerPolicy = @import("../../browser/ReferrerPolicy.zig");
const Frame = @import("../../browser/Frame.zig");

const Headers = @import("Headers.zig");
const http = @import("../../../runtime/network/http.zig");
const Execution = js.Execution;

pub const State = struct {
    exec: *const Execution,
    arena: std.mem.Allocator,
    request_headers: *Headers,
    referrer: []const u8,
    referrer_policy: []const u8,
    referrer_source_url: [:0]const u8,
    body_content_type: ?[]const u8,
};

pub fn buildWireHeaders(
    state: *const State,
    request_url: [:0]const u8,
    body: ?[]const u8,
    method_name: []const u8,
) !HttpClient.Headers {
    const exec = state.exec;
    const alloc = state.arena;
    const http_client = &exec.context.page.session.browser.http_client;
    var headers = try http_client.newHeaders();
    const req_headers = state.request_headers;
    const is_get_or_head = std.mem.eql(u8, method_name, "GET") or std.mem.eql(u8, method_name, "HEAD");

    if (state.body_content_type) |ct| {
        if (try req_headers.get("content-type", exec) == null) {
            try req_headers.set("content-type", ct, exec);
        }
    }
    try req_headers.populateHttpHeader(alloc, &headers, exec.buf);

    const zero_length_body = body == null and !is_get_or_head and
        (std.mem.eql(u8, method_name, "POST") or std.mem.eql(u8, method_name, "PUT") or
            std.mem.eql(u8, method_name, "PATCH") or std.mem.eql(u8, method_name, "DELETE"));
    if (zero_length_body) {
        const cl_hdr = try std.mem.concatWithSentinel(alloc, u8, &.{"Content-Length: 0"}, 0);
        try headers.add(cl_hdr);
    } else if (body) |b| {
        // Raw binary POST uses UPLOAD read callback; curl does not set Content-Length.
        if (state.body_content_type == null and try req_headers.get("content-length", exec) == null) {
            const cl_hdr = try std.fmt.allocPrintSentinel(alloc, "Content-Length: {d}", .{b.len}, 0);
            try headers.add(cl_hdr);
        }
    }

    var header_opts: Frame.HeadersForRequestOpts = .{
        .request_url = request_url,
        .resource_type = .fetch,
        .include_origin_header = !is_get_or_head,
        .header_arena = alloc,
    };
    if (std.mem.eql(u8, state.referrer, "about:client")) {
        header_opts.referrer_source_url = state.referrer_source_url;
        if (state.referrer_policy.len > 0) {
            header_opts.referrer_policy = ReferrerPolicy.Policy.parse(state.referrer_policy);
        }
    } else if (state.referrer.len == 0) {
        header_opts.referer = "";
    } else {
        header_opts.referer = ReferrerPolicy.sanitizeReferrerUrl(alloc, state.referrer) catch state.referrer;
        if (state.referrer_policy.len > 0) {
            header_opts.referrer_policy = ReferrerPolicy.Policy.parse(state.referrer_policy);
        }
    }
    try exec.headersForRequest(&headers, header_opts);
    return headers;
}

fn methodNameFromTransfer(params: *const HttpClient.RequestParams) [:0]const u8 {
    if (params.custom_method) |m| return m;
    return switch (params.method) {
        .GET => "GET",
        .POST => "POST",
        .PUT => "PUT",
        .DELETE => "DELETE",
        .HEAD => "HEAD",
        .OPTIONS => "OPTIONS",
        .PATCH => "PATCH",
        .PROPFIND => "PROPFIND",
    };
}

/// Called from HttpClient.configureConn on redirect retry (_tries > 0).
pub fn rebuildHeaders(ctx: *anyopaque, transfer: *HttpClient.Transfer, conn: *http.Connection) !void {
    const state: *State = @ptrCast(@alignCast(ctx));
    const params = &transfer.req.params;
    const method_name = methodNameFromTransfer(params);

    try conn.clearHeaders();
    params.headers = try buildWireHeaders(state, params.url, params.body, method_name);

    const raw_post_body = params.body != null and state.body_content_type == null;
    params.raw_post_body = raw_post_body;
    params.curl_default_headers = !raw_post_body;
}

pub fn refresh(_: *anyopaque, _: *HttpClient.Transfer, _: [:0]const u8) !void {}
