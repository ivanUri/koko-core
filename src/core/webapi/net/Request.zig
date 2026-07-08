// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

const std = @import("std");

const js = @import("../../js/js.zig");
const http = @import("../../../runtime/network/http.zig");

const URL = @import("../../browser/URL.zig");
const Headers = @import("Headers.zig");
const Blob = @import("../Blob.zig");
const AbortSignal = @import("../AbortSignal.zig");
const FormData = @import("FormData.zig");
const RequestBody = @import("RequestBody.zig");
const ReadableStream = @import("../streams/ReadableStream.zig");

const Execution = js.Execution;
const Allocator = std.mem.Allocator;

const Request = @This();

_url: [:0]const u8,
_method: []const u8,
_headers: ?*Headers,
_body: ?[]const u8,
_body_stream: ?*ReadableStream,
_body_content_type: ?[]const u8,
_body_used: bool,
_arena: Allocator,
_cache: Cache,
_credentials: Credentials,
_signal: ?*AbortSignal,
_mode: Mode,
_redirect: Redirect,
_duplex: Duplex,
_referrer: []const u8,
_referrer_policy: []const u8,
_integrity: []const u8,
_destination: []const u8,
_keepalive: bool,
_is_reload_navigation: bool,
_is_history_navigation: bool,

pub const Input = union(enum) {
    request: *Request,
    url: [:0]const u8,
};

pub const Priority = enum {
    high,
    low,
    auto,
    pub const js_enum_from_string = true;
};

pub const InitOpts = struct {
    method: ?[]const u8 = null,
    headers: ?Headers.InitOpts = null,
    body: ?js.Value = null,
    cache: Cache = .default,
    credentials: Credentials = .@"same-origin",
    signal: ?*AbortSignal = null,
    priority: Priority = .auto,
    referrer: ?[]const u8 = null,
    referrerPolicy: ?[]const u8 = null,
    mode: Mode = .cors,
    redirect: Redirect = .follow,
    integrity: ?[]const u8 = null,
    keepalive: bool = false,
    duplex: ?Duplex = null,
};

pub const Mode = enum {
    navigate,
    @"same-origin",
    @"no-cors",
    cors,
    pub const js_enum_from_string = true;
};

pub const Redirect = enum {
    follow,
    @"error",
    manual,
    pub const js_enum_from_string = true;
};

pub const Duplex = enum {
    half,
    pub const js_enum_from_string = true;
};

const Credentials = enum {
    omit,
    include,
    @"same-origin",
    pub const js_enum_from_string = true;
};

const Cache = enum {
    default,
    @"no-store",
    reload,
    @"no-cache",
    @"force-cache",
    @"only-if-cached",
    pub const js_enum_from_string = true;
};

pub fn init(input: Input, opts_: ?InitOpts, exec: *const Execution) !*Request {
    const arena = exec.arena;
    const url = switch (input) {
        .url => |u| try URL.resolve(arena, exec.base(), u, .{ .always_dupe = true, .encoding = exec.charset.* }),
        .request => |r| try arena.dupeZ(u8, r._url),
    };

    const opts = opts_ orelse InitOpts{};
    const method = if (opts.method) |m|
        try parseMethod(m, exec)
    else switch (input) {
        .url => "GET",
        .request => |r| r._method,
    };

    const headers = if (opts.headers) |headers_init| switch (headers_init) {
        .obj => |h| h,
        else => try Headers.init(headers_init, exec),
    } else switch (input) {
        .url => null,
        .request => |r| r._headers,
    };

    const materialized: RequestBody.Materialized = if (opts.body) |body_val|
        try RequestBody.materialize(body_val, exec)
    else switch (input) {
        .url => .{},
        .request => |r| .{
            .bytes = r._body,
            .stream = r._body_stream,
            .content_type = r._body_content_type,
        },
    };
    const body = materialized.bytes;
    const body_stream = materialized.stream;
    const body_content_type = materialized.content_type;

    const body_from_init = opts.body != null;
    const duplex_explicit = opts.duplex != null;
    const duplex = opts.duplex orelse .half;

    if (body_stream) |stream| {
        if (body_from_init) {
            if (!duplex_explicit or duplex != .half) return error.TypeError;
            if (stream.getLocked()) return error.TypeError;
        }
    } else if (duplex_explicit and duplex != .half) {
        return error.TypeError;
    }

    const signal = if (opts.signal) |s|
        s
    else switch (input) {
        .url => null,
        .request => |r| r._signal,
    };

    const referrer = if (opts.referrer) |r|
        try arena.dupe(u8, r)
    else switch (input) {
        .url => "about:client",
        .request => |r| r._referrer,
    };

    const referrer_policy = if (opts.referrerPolicy) |rp|
        try arena.dupe(u8, rp)
    else switch (input) {
        .url => "",
        .request => |r| r._referrer_policy,
    };

    const integrity = if (opts.integrity) |i|
        try arena.dupe(u8, i)
    else switch (input) {
        .url => "",
        .request => |r| r._integrity,
    };

    const mode = switch (input) {
        .url => opts.mode,
        .request => |r| if (opts_ != null) opts.mode else r._mode,
    };
    const redirect = switch (input) {
        .url => opts.redirect,
        .request => |r| if (opts_ != null) opts.redirect else r._redirect,
    };
    const stored_duplex = switch (input) {
        .url => duplex,
        .request => |r| if (opts_ != null) duplex else r._duplex,
    };

    return exec._factory.create(Request{
        ._url = url,
        ._arena = arena,
        ._method = method,
        ._headers = headers,
        ._cache = opts.cache,
        ._credentials = opts.credentials,
        ._body = body,
        ._body_stream = body_stream,
        ._body_content_type = body_content_type,
        ._body_used = false,
        ._signal = signal,
        ._mode = mode,
        ._redirect = redirect,
        ._duplex = stored_duplex,
        ._referrer = referrer,
        ._referrer_policy = referrer_policy,
        ._integrity = integrity,
        ._destination = switch (input) {
            .url => "",
            .request => |r| r._destination,
        },
        ._keepalive = if (opts.keepalive) true else switch (input) {
            .url => false,
            .request => |r| r._keepalive,
        },
        ._is_reload_navigation = switch (input) {
            .url => false,
            .request => |r| r._is_reload_navigation,
        },
        ._is_history_navigation = switch (input) {
            .url => false,
            .request => |r| r._is_history_navigation,
        },
    });
}

fn parseMethod(method: []const u8, exec: *const Execution) ![]const u8 {
    if (method.len == 0) {
        return error.InvalidMethod;
    }

    const lower = std.ascii.lowerString(exec.buf, method);

    inline for (.{ "connect", "trace", "track" }) |forbidden| {
        if (std.mem.eql(u8, lower, forbidden)) {
            return error.InvalidMethod;
        }
    }

    const normalized = std.StaticStringMap([]const u8).initComptime(.{
        .{ "get", "GET" },
        .{ "post", "POST" },
        .{ "delete", "DELETE" },
        .{ "put", "PUT" },
        .{ "patch", "PATCH" },
        .{ "head", "HEAD" },
        .{ "options", "OPTIONS" },
        .{ "propfind", "PROPFIND" },
    });
    if (normalized.get(lower)) |known| {
        return known;
    }

    return try exec.arena.dupe(u8, method);
}

pub fn getUrl(self: *const Request) []const u8 {
    return self._url;
}

pub fn getMethod(self: *const Request) []const u8 {
    return self._method;
}

pub fn httpMethod(self: *const Request) http.Method {
    return std.meta.stringToEnum(http.Method, self._method) orelse .POST;
}

pub fn getCache(self: *const Request) []const u8 {
    return @tagName(self._cache);
}

pub fn getCredentials(self: *const Request) []const u8 {
    return @tagName(self._credentials);
}

pub fn getSignal(self: *const Request) ?*AbortSignal {
    return self._signal;
}

pub fn getMode(self: *const Request) []const u8 {
    return @tagName(self._mode);
}

pub fn getRedirect(self: *const Request) []const u8 {
    return @tagName(self._redirect);
}

pub fn getDuplex(self: *const Request) []const u8 {
    return @tagName(self._duplex);
}

pub fn getReferrer(self: *const Request) []const u8 {
    return self._referrer;
}

pub fn getReferrerPolicy(self: *const Request) []const u8 {
    return self._referrer_policy;
}

pub fn getIntegrity(self: *const Request) []const u8 {
    return self._integrity;
}

pub fn getDestination(self: *const Request) []const u8 {
    return self._destination;
}

pub fn getKeepalive(self: *const Request) bool {
    return self._keepalive;
}

pub fn getIsReloadNavigation(self: *const Request) bool {
    return self._is_reload_navigation;
}

pub fn getIsHistoryNavigation(self: *const Request) bool {
    return self._is_history_navigation;
}

pub fn getBody(self: *Request, exec: *const Execution) !?*ReadableStream {
    _ = exec;
    return self._body_stream;
}

pub fn textStream(self: *Request, exec: *const Execution) !*ReadableStream {
    if (self._body_used) {
        return error.TypeError;
    }
    const body = self._body orelse {
        const stream = try ReadableStream.init(null, null, exec);
        try stream._controller.close();
        return stream;
    };
    self._body_used = true;
    return ReadableStream.initWithData(body, exec);
}

pub fn getHeaders(self: *Request, exec: *const Execution) !*Headers {
    if (self._headers) |headers| {
        return headers;
    }

    const headers = try Headers.init(null, exec);
    self._headers = headers;
    return headers;
}

fn stripBom(data: []const u8) []const u8 {
    // Strip UTF-8 BOM (U+FEFF = EF BB BF) per Fetch spec body text decode
    if (data.len >= 3 and data[0] == 0xEF and data[1] == 0xBB and data[2] == 0xBF) {
        return data[3..];
    }
    return data;
}

pub fn getBodyUsed(self: *const Request) bool {
    // null body is never "used" per spec
    if (self._body == null) return false;
    return self._body_used;
}

pub fn blob(self: *Request, exec: *const Execution) !js.Promise {
    const local = exec.context.local.?;
    if (self._body_used) {
        return local.rejectPromise(.{ .type_error = "body has already been consumed" });
    }
    const body = self._body orelse {
        const headers = try self.getHeaders(exec);
        const content_type = try headers.get("content-type", exec) orelse "";
        const b = try Blob.initFromBytes("", content_type, true, exec.context.page);
        return local.resolvePromise(b);
    };
    self._body_used = true;
    const headers = try self.getHeaders(exec);
    const content_type = try headers.get("content-type", exec) orelse "";
    const b = try Blob.initFromBytes(body, content_type, true, exec.context.page);
    return local.resolvePromise(b);
}

pub fn text(self: *Request, exec: *const Execution) !js.Promise {
    const local = exec.context.local.?;
    if (self._body_used) {
        return local.rejectPromise(.{ .type_error = "body has already been consumed" });
    }
    const body = self._body orelse return local.resolvePromise(@as([]const u8, ""));
    self._body_used = true;
    return local.resolvePromise(stripBom(body));
}

pub fn json(self: *Request, exec: *const Execution) !js.Promise {
    const local = exec.context.local.?;
    if (self._body_used) {
        return local.rejectPromise(.{ .type_error = "body has already been consumed" });
    }
    const body = self._body orelse return local.rejectPromise(.{ .syntax_error = "failed to parse" });
    self._body_used = true;
    const value = local.parseJSON(body) catch {
        return local.rejectPromise(.{ .syntax_error = "failed to parse" });
    };
    return local.resolvePromise(try value.persist());
}

pub fn arrayBuffer(self: *Request, exec: *const Execution) !js.Promise {
    const local = exec.context.local.?;
    if (self._body_used) {
        return local.rejectPromise(.{ .type_error = "body has already been consumed" });
    }
    const body = self._body orelse return local.resolvePromise(js.ArrayBuffer{ .values = "" });
    self._body_used = true;
    return local.resolvePromise(js.ArrayBuffer{ .values = body });
}

pub fn bytes(self: *Request, exec: *const Execution) !js.Promise {
    const local = exec.context.local.?;
    if (self._body_used) {
        return local.rejectPromise(.{ .type_error = "body has already been consumed" });
    }
    const body = self._body orelse return local.resolvePromise(js.TypedArray(u8){ .values = "" });
    self._body_used = true;
    return local.resolvePromise(js.TypedArray(u8){ .values = body });
}

pub fn formData(self: *Request, exec: *const Execution) !js.Promise {
    const local = exec.context.local.?;
    if (self._body_used) {
        return local.rejectPromise(.{ .type_error = "body has already been consumed" });
    }
    const headers = try self.getHeaders(exec);
    const content_type = try headers.get("content-type", exec) orelse "";
    if (!FormData.isUrlEncodedContentType(content_type)) {
        return local.rejectPromise(.{ .type_error = "body is not a URL-encoded form" });
    }
    const body = self._body orelse {
        const fd = try FormData.fromUrlEncodedBody("", exec);
        return local.resolvePromise(fd);
    };
    self._body_used = true;
    const fd = try FormData.fromUrlEncodedBody(body, exec);
    return local.resolvePromise(fd);
}

pub fn clone(self: *const Request, exec: *const Execution) !*Request {
    return exec._factory.create(Request{
        ._url = self._url,
        ._arena = self._arena,
        ._method = self._method,
        ._headers = self._headers,
        ._cache = self._cache,
        ._credentials = self._credentials,
        ._body = self._body,
        ._body_stream = self._body_stream,
        ._body_content_type = self._body_content_type,
        ._body_used = false,
        ._signal = self._signal,
        ._mode = self._mode,
        ._redirect = self._redirect,
        ._duplex = self._duplex,
        ._referrer = self._referrer,
        ._referrer_policy = self._referrer_policy,
        ._integrity = self._integrity,
        ._destination = self._destination,
        ._keepalive = self._keepalive,
        ._is_reload_navigation = self._is_reload_navigation,
        ._is_history_navigation = self._is_history_navigation,
    });
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(Request);

    pub const Meta = struct {
        pub const name = "Request";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };

    pub const constructor = bridge.constructor(Request.init, .{});
    pub const url = bridge.accessor(Request.getUrl, null, .{});
    pub const method = bridge.accessor(Request.getMethod, null, .{});
    pub const headers = bridge.accessor(Request.getHeaders, null, .{});
    pub const cache = bridge.accessor(Request.getCache, null, .{});
    pub const credentials = bridge.accessor(Request.getCredentials, null, .{});
    pub const signal = bridge.accessor(Request.getSignal, null, .{});
    pub const mode = bridge.accessor(Request.getMode, null, .{});
    pub const redirect = bridge.accessor(Request.getRedirect, null, .{});
    pub const duplex = bridge.accessor(Request.getDuplex, null, .{});
    pub const referrer = bridge.accessor(Request.getReferrer, null, .{});
    pub const referrerPolicy = bridge.accessor(Request.getReferrerPolicy, null, .{});
    pub const integrity = bridge.accessor(Request.getIntegrity, null, .{});
    pub const destination = bridge.accessor(Request.getDestination, null, .{});
    pub const keepalive = bridge.accessor(Request.getKeepalive, null, .{});
    pub const isReloadNavigation = bridge.accessor(Request.getIsReloadNavigation, null, .{});
    pub const isHistoryNavigation = bridge.accessor(Request.getIsHistoryNavigation, null, .{});
    pub const body = bridge.accessor(Request.getBody, null, .{});
    pub const bodyUsed = bridge.accessor(Request.getBodyUsed, null, .{});
    pub const textStream = bridge.function(Request.textStream, .{});
    pub const blob = bridge.function(Request.blob, .{});
    pub const text = bridge.function(Request.text, .{});
    pub const json = bridge.function(Request.json, .{});
    pub const arrayBuffer = bridge.function(Request.arrayBuffer, .{});
    pub const bytes = bridge.function(Request.bytes, .{});
    pub const formData = bridge.function(Request.formData, .{});
    pub const clone = bridge.function(Request.clone, .{});
};

const testing = @import("../../../testing/testing.zig");
test "WebApi: Request" {
    try testing.htmlRunner("net/request.html", .{});
}
