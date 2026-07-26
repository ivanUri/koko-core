//
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
const RC = @import("../../../support/rc.zig").RC;

const js = @import("../../js/js.zig");
const Page = @import("../../browser/Page.zig");
const HttpClient = @import("../../browser/HttpClient.zig");
const URL = @import("../../browser/URL.zig");

const Blob = @import("../Blob.zig");
const ReadableStream = @import("../streams/ReadableStream.zig");

const Headers = @import("Headers.zig");
const FormData = @import("FormData.zig");

const Execution = js.Execution;
const Allocator = std.mem.Allocator;

const Response = @This();

pub const Type = enum {
    basic,
    cors,
    default,
    @"error",
    @"opaque",
    opaqueredirect,
};

_rc: RC(u8) = .{},
_status: u16,
_arena: Allocator,
_headers: *Headers,
_body: Body = .empty,
_body_used: bool = false,
_type: Type,
_status_text: []const u8,
_url: [:0]const u8,
_is_redirected: bool,
_http_response: ?HttpClient.Response = null,
_pending_fetch_page: ?*Page = null,

const Body = union(enum) {
    empty,
    bytes: []const u8,
    stream: *ReadableStream,
};

fn blobBodyBytes(arena: Allocator, js_val: js.Value) !?[]const u8 {
    const File = @import("../File.zig");
    const TaggedOpaque = @import("../../js/TaggedOpaque.zig");
    if (js_val.isBranded(File)) {
        const file = try TaggedOpaque.fromJS(*File, @ptrCast(js_val.toObject().handle));
        return try arena.dupe(u8, file.getDataSlice());
    }
    if (js_val.local.jsValueToZig(*Blob, js_val)) |blob_obj| {
        return try arena.dupe(u8, blob_obj.getSlice());
    } else |_| {}
    return null;
}

const InitOpts = struct {
    status: u16 = 200,
    headers: ?Headers.InitOpts = null,
    statusText: ?[]const u8 = null,
};

/// Body discriminant: tracks whether body came from a string (has default Content-Type)
/// or a buffer source (no default Content-Type per Fetch spec §2.2.1).
pub const BodyInit = union(enum) {
    stream: *ReadableStream,
    /// Plain string — gets Content-Type: text/plain;charset=UTF-8
    string: []const u8,
    /// Raw bytes / TypedArray / ArrayBuffer — NO default Content-Type
    buffer: []const u8,
    /// Legacy alias kept for fetch() internal path (treated as string)
    bytes: []const u8,
    js_val: js.Value,
};

pub fn init(body_: ?BodyInit, opts_: ?InitOpts, exec: *const Execution) !*Response {
    const session = exec.context.page.session;
    const arena = try session.getArena(.large, "Response");
    errdefer session.releaseArena(arena);

    const opts = opts_ orelse InitOpts{};
    const status_text = if (opts.statusText) |st| try arena.dupe(u8, st) else "";

    // Build headers first so we can conditionally set Content-Type from body.
    const headers = try Headers.init(opts.headers, exec);

    // Parse body from the union, tracking whether Content-Type must be inferred.
    const body: Body = blk: {
        const b = body_ orelse break :blk .empty;
        switch (b) {
            .string => |s| {
                // String body → Content-Type: text/plain;charset=UTF-8 (if not already set).
                if (try headers.get("content-type", exec) == null) {
                    try headers.set("content-type", "text/plain;charset=UTF-8", exec);
                }
                break :blk .{ .bytes = try arena.dupe(u8, s) };
            },
            .buffer => |buf| {
                // Buffer/TypedArray/ArrayBuffer → NO default Content-Type per spec.
                break :blk .{ .bytes = try arena.dupe(u8, buf) };
            },
            .bytes => |body_bytes| break :blk .{ .bytes = try arena.dupe(u8, body_bytes) },
            .stream => |stream| break :blk .{ .stream = stream },
            .js_val => |js_val| {
                if (js_val.isNullOrUndefined()) {
                    break :blk .empty;
                }
                if (try blobBodyBytes(arena, js_val)) |body_bytes| {
                    break :blk .{ .bytes = body_bytes };
                }
                // Treat js_val as string body for Content-Type purposes.
                if (try headers.get("content-type", exec) == null) {
                    try headers.set("content-type", "text/plain;charset=UTF-8", exec);
                }
                break :blk .{ .bytes = try arena.dupe(u8, try js_val.toStringSmart()) };
            },
        }
        break :blk .empty;
    };

    const self = try arena.create(Response);
    // Programmatically constructed Response has type "default" per Fetch spec §2.2.
    // Only fetch()-returned responses get "basic", "cors", or "opaque".
    self.* = .{
        ._arena = arena,
        ._status = opts.status,
        ._status_text = status_text,
        ._url = "",
        ._body = body,
        ._type = .default,
        ._is_redirected = false,
        ._headers = headers,
    };
    return self;
}

pub fn deinit(self: *Response, page: *Page) void {
    if (self._pending_fetch_page) |owner_page| {
        owner_page.unregisterTerminalOwner(self);
        self._pending_fetch_page = null;
    }
    if (self._http_response) |resp| {
        resp.abort(error.Abort);
        self._http_response = null;
    }
    page.releaseArena(self._arena);
}

fn releasePendingFetch(ctx: *anyopaque, page: *Page) void {
    const self: *Response = @ptrCast(@alignCast(ctx));
    self._pending_fetch_page = null;
    self.deinit(page);
}

pub fn trackPendingFetch(self: *Response, page: *Page) !void {
    std.debug.assert(self._pending_fetch_page == null);
    try page.registerTerminalOwner(self, releasePendingFetch);
    self._pending_fetch_page = page;
}

pub fn transferPendingFetchToJs(self: *Response, page: *Page) void {
    if (self._pending_fetch_page == null) return;
    page.unregisterTerminalOwner(self);
    self._pending_fetch_page = null;
}

pub fn releaseRef(self: *Response, page: *Page) void {
    self._rc.release(self, page);
}

pub fn acquireRef(self: *Response) void {
    self._rc.acquire();
}

pub fn getStatus(self: *const Response) u16 {
    return self._status;
}

pub fn getStatusText(self: *const Response) []const u8 {
    return self._status_text;
}

pub fn getURL(self: *const Response) []const u8 {
    return self._url;
}

pub fn isRedirected(self: *const Response) bool {
    return self._is_redirected;
}

pub fn getHeaders(self: *const Response) *Headers {
    return self._headers;
}

pub fn getType(self: *const Response) []const u8 {
    return @tagName(self._type);
}

pub fn getBody(self: *Response, exec: *const Execution) !?*ReadableStream {
    return switch (self._body) {
        .empty => null,
        .stream => |stream| stream,
        .bytes => |body| {
            if (body.len == 0) {
                const stream = try ReadableStream.init(null, null, exec);
                try stream._controller.close();
                return stream;
            }
            return ReadableStream.initWithData(body, exec);
        },
    };
}

pub fn isOK(self: *const Response) bool {
    return self._status >= 200 and self._status <= 299;
}

pub fn getBodyUsed(self: *const Response) bool {
    // bodyless response is never "used" per spec
    return switch (self._body) {
        .empty => false,
        else => self._body_used,
    };
}

fn stripBom(data: []const u8) []const u8 {
    // Strip UTF-8 BOM (U+FEFF = EF BB BF) per Fetch spec body text decode
    if (data.len >= 3 and data[0] == 0xEF and data[1] == 0xBB and data[2] == 0xBF) {
        return data[3..];
    }
    return data;
}

pub fn getText(self: *Response, exec: *const Execution) !js.Promise {
    const local = exec.context.local.?;
    if (self._body_used) {
        return local.rejectPromise(.{ .type_error = "body has already been consumed" });
    }
    const body = switch (self._body) {
        .bytes => |b| b,
        .empty => {
            // null body: bodyUsed stays false, return empty string
            return local.resolvePromise(@as([]const u8, ""));
        },
        .stream => |stream| {
            self._body_used = true;
            return StreamConsumer.startText(stream, exec);
        },
    };
    self._body_used = true;
    return local.resolvePromise(stripBom(body));
}

pub fn getJson(self: *Response, exec: *const Execution) !js.Promise {
    const local = exec.context.local.?;
    if (self._body_used) {
        return local.rejectPromise(.{ .type_error = "body has already been consumed" });
    }
    switch (self._body) {
        .bytes => |body| {
            self._body_used = true;
            const value = local.parseJSON(body) catch {
                return local.rejectPromise(.{ .syntax_error = "failed to parse" });
            };
            return local.resolvePromise(try value.persist());
        },
        .empty => {
            self._body_used = false;
            return local.rejectPromise(.{ .syntax_error = "failed to parse" });
        },
        .stream => |stream| {
            self._body_used = true;
            return StreamConsumer.startJson(stream, exec);
        },
    }
}

pub fn arrayBuffer(self: *Response, exec: *const Execution) !js.Promise {
    const local = exec.context.local.?;
    if (self._body_used) {
        return local.rejectPromise(.{ .type_error = "body has already been consumed" });
    }
    return switch (self._body) {
        .bytes => |body| blk: {
            self._body_used = true;
            break :blk local.resolvePromise(js.ArrayBuffer{ .values = body });
        },
        .empty => local.resolvePromise(js.ArrayBuffer{ .values = "" }),
        .stream => |stream| blk: {
            self._body_used = true;
            break :blk StreamConsumer.start(stream, exec);
        },
    };
}

/// Async consumer for reading all data from a ReadableStream
const StreamConsumer = struct {
    const ReadableStreamDefaultReader = @import("../streams/ReadableStreamDefaultReader.zig");

    execution: *const Execution,
    total_len: usize,
    arena: Allocator,
    reader: *ReadableStreamDefaultReader,
    chunks: std.ArrayList([]const u8),
    resolver: js.PromiseResolver.Global,
    mode: Mode,

    const Mode = enum {
        array_buffer,
        text,
        json,
    };

    fn start(stream: *ReadableStream, exec: *const Execution) !js.Promise {
        return startWithMode(stream, exec, .array_buffer);
    }

    fn startText(stream: *ReadableStream, exec: *const Execution) !js.Promise {
        return startWithMode(stream, exec, .text);
    }

    fn startJson(stream: *ReadableStream, exec: *const Execution) !js.Promise {
        return startWithMode(stream, exec, .json);
    }

    fn startWithMode(stream: *ReadableStream, exec: *const Execution, mode: Mode) !js.Promise {
        const local = exec.context.local.?;
        var resolver = local.createPromiseResolver();
        const promise = resolver.promise();

        const reader = try stream.getReader(exec);

        const state = try exec.arena.create(StreamConsumer);
        state.* = .{
            .execution = exec,
            .reader = reader,
            .chunks = .empty,
            .total_len = 0,
            .arena = exec.arena,
            .resolver = try resolver.persist(),
            .mode = mode,
        };

        try state.pumpRead();
        return promise;
    }

    fn pumpRead(self: *StreamConsumer) !void {
        const local = self.execution.context.local.?;
        const read_promise = try self.reader.read(self.execution);

        const then_fn = local.newCallback(onReadFulfilled, self);
        const catch_fn = local.newCallback(onReadRejected, self);

        _ = read_promise.thenAndCatch(then_fn, catch_fn) catch {
            self.finish(local, null);
        };
    }

    // Must match the JS shape of ReadableStreamDefaultReader.ReadResult after
    // the Zig→JS union unwrap: when done=true, `value` is undefined (empty
    // chunk). A non-optional js.Value failed conversion, threw inside the
    // then-callback, and left the outer arrayBuffer/text/json promise hanging
    // forever (Amazon AWS WAF NetworkBandwidth / fetch().arrayBuffer()).
    const ReadData = struct {
        done: bool,
        value: ?js.Value = null,
    };

    fn onReadFulfilled(self: *StreamConsumer, data_: ?ReadData) void {
        const local = self.execution.context.local orelse {
            // Context gone; nothing we can settle on V8.
            return;
        };

        const data = data_ orelse {
            return self.finish(local, null);
        };

        self._onReadFulfilled(data) catch {
            self.finish(local, null);
        };
    }

    fn _onReadFulfilled(self: *StreamConsumer, data: ReadData) !void {
        const exec = self.execution;
        const local = exec.context.local.?;

        if (data.done) {
            // Stream is finished, concatenate all chunks and resolve
            self.reader.releaseLock();
            const result = try self.concatenateChunks(exec.call_arena);
            switch (self.mode) {
                .array_buffer => local.toLocal(self.resolver).resolve("arrayBuffer complete", js.ArrayBuffer{ .values = result }),
                .text => local.toLocal(self.resolver).resolve("text complete", stripBom(result)),
                .json => {
                    const value = local.parseJSON(result) catch {
                        local.toLocal(self.resolver).rejectError("json parse", .{ .syntax_error = "failed to parse" });
                        return;
                    };
                    local.toLocal(self.resolver).resolve("json complete", try value.persist());
                },
            }
            return;
        }

        // Collect the chunk data (undefined/null when producer sent empty chunk)
        const value = data.value orelse {
            try self.pumpRead();
            return;
        };
        if (!value.isUndefined()) {
            // Try to get bytes from the value (could be Uint8Array or string)
            if (value.isTypedArray() or value.isArrayBufferView() or value.isArrayBuffer()) {
                if (local.jsValueToZig([]u8, value)) |typed_data| {
                    const chunk_copy = try self.arena.dupe(u8, typed_data);
                    try self.chunks.append(self.arena, chunk_copy);
                    self.total_len += chunk_copy.len;
                } else |_| {}
            } else if (value.isString()) |str| {
                const slice = try str.toSlice();
                const chunk_copy = try self.arena.dupe(u8, slice);
                try self.chunks.append(self.arena, chunk_copy);
                self.total_len += chunk_copy.len;
            }
        }
        try self.pumpRead();
    }

    fn onReadRejected(self: *StreamConsumer) void {
        if (self.execution.context.local) |local| {
            self.finish(local, null);
        }
    }

    fn concatenateChunks(self: *StreamConsumer, allocator: Allocator) ![]const u8 {
        if (self.chunks.items.len == 0) {
            return "";
        }
        if (self.chunks.items.len == 1) {
            return self.chunks.items[0];
        }
        return std.mem.join(allocator, "", self.chunks.items);
    }

    fn finish(self: *StreamConsumer, local: *const js.Local, err: ?[]const u8) void {
        self.reader.releaseLock();
        switch (self.mode) {
            .json => local.toLocal(self.resolver).rejectError("json stream read", .{ .syntax_error = err orelse "failed to parse" }),
            else => local.toLocal(self.resolver).rejectError("stream body read", .{ .type_error = err orelse "Failed to read stream" }),
        }
    }
};

pub fn blob(self: *Response, exec: *const Execution) !js.Promise {
    const local = exec.context.local.?;
    if (self._body_used) {
        return local.rejectPromise(.{ .type_error = "body has already been consumed" });
    }
    const body = switch (self._body) {
        .bytes => |b| b,
        .empty => {
            const content_type = try self._headers.get("content-type", exec) orelse "";
            const b = try Blob.initFromBytes("", content_type, true, exec.context.page);
            return local.resolvePromise(b);
        },
        .stream => return local.rejectPromise(.{ .type_error = "Cannot read blob from stream body" }),
    };
    self._body_used = true;
    const content_type = try self._headers.get("content-type", exec) orelse "";
    const b = try Blob.initFromBytes(body, content_type, true, exec.context.page);
    return local.resolvePromise(b);
}

pub fn bytes(self: *Response, exec: *const Execution) !js.Promise {
    const local = exec.context.local.?;
    if (self._body_used) {
        return local.rejectPromise(.{ .type_error = "body has already been consumed" });
    }
    const body = switch (self._body) {
        .bytes => |b| blk: {
            self._body_used = true;
            break :blk b;
        },
        .empty => "",
        .stream => return local.rejectPromise(.{ .type_error = "Cannot read bytes from stream body" }),
    };
    return local.resolvePromise(js.TypedArray(u8){ .values = body });
}

pub fn formData(self: *Response, exec: *const Execution) !js.Promise {
    const local = exec.context.local.?;
    if (self._body_used) {
        return local.rejectPromise(.{ .type_error = "body has already been consumed" });
    }
    const content_type = try self._headers.get("content-type", exec) orelse "";
    if (!FormData.isUrlEncodedContentType(content_type)) {
        return local.rejectPromise(.{ .type_error = "body is not a URL-encoded form" });
    }
    const body = switch (self._body) {
        .bytes => |b| blk: {
            self._body_used = true;
            break :blk b;
        },
        .empty => {
            const fd = try FormData.fromUrlEncodedBody("", exec);
            return local.resolvePromise(fd);
        },
        .stream => return local.rejectPromise(.{ .type_error = "Cannot read formData from stream body" }),
    };
    const fd = try FormData.fromUrlEncodedBody(body, exec);
    return local.resolvePromise(fd);
}

pub fn makeError(exec: *const Execution) !*Response {
    const response = try init(null, .{ .status = 0 }, exec);
    response._type = .@"error";
    return response;
}

pub fn makeRedirect(url: []const u8, status: ?u16, exec: *const Execution) !*Response {
    const resolved = try URL.resolve(exec.arena, exec.base(), url, .{ .always_dupe = true, .encoding = exec.charset.* });
    const st: u16 = status orelse 302;
    if (st < 300 or st > 399) return error.TypeError;

    const response = try init(null, .{ .status = st }, exec);
    response._type = .opaqueredirect;
    response._url = try response._arena.dupeZ(u8, resolved);
    try response._headers.set("Location", resolved, exec);
    return response;
}

pub fn makeJson(data: js.Value, init_: ?InitOpts, exec: *const Execution) !*Response {
    const json_str = data.toJson(exec.call_arena) catch return error.TypeError;
    const response = try init(.{ .string = json_str }, init_, exec);
    try response._headers.set("Content-Type", "application/json", exec);
    return response;
}

pub fn textStream(self: *Response, exec: *const Execution) !*ReadableStream {
    if (self._body_used) return error.TypeError;
    return switch (self._body) {
        .bytes => |body| blk: {
            self._body_used = true;
            break :blk try ReadableStream.initWithData(body, exec);
        },
        .empty => blk: {
            const stream = try ReadableStream.init(null, null, exec);
            try stream._controller.close();
            break :blk stream;
        },
        .stream => |stream| stream,
    };
}

pub fn clone(self: *const Response, exec: *const Execution) !*Response {
    const session = exec.context.page.session;
    const body_len = switch (self._body) {
        .bytes => |b| b.len,
        .empty => 0,
        .stream => 0,
    };
    const arena = try session.getArena(body_len + self._url.len + 256, "Response.clone");
    errdefer session.releaseArena(arena);

    const body: Body = switch (self._body) {
        .bytes => |b| .{ .bytes = try arena.dupe(u8, b) },
        .empty => .empty,
        .stream => .empty, // TODO: implement stream tee for proper cloning
    };
    const status_text = try arena.dupe(u8, self._status_text);
    const url = try arena.dupeZ(u8, self._url);

    const cloned = try arena.create(Response);
    cloned.* = .{
        ._arena = arena,
        ._status = self._status,
        ._status_text = status_text,
        ._url = url,
        ._body = body,
        ._type = self._type,
        ._is_redirected = self._is_redirected,
        ._headers = try Headers.init(.{ .obj = self._headers }, exec),
        ._http_response = null,
    };
    return cloned;
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(Response);

    pub const Meta = struct {
        pub const name = "Response";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };

    pub const constructor = bridge.constructor(Response.init, .{});
    pub const error_static = bridge.function(Response.makeError, .{ .static = true, .js_name = "error" });
    pub const redirect = bridge.function(Response.makeRedirect, .{ .static = true });
    pub const json_static = bridge.function(Response.makeJson, .{ .static = true, .js_name = "json" });
    pub const ok = bridge.accessor(Response.isOK, null, .{});
    pub const status = bridge.accessor(Response.getStatus, null, .{});
    pub const statusText = bridge.accessor(Response.getStatusText, null, .{});
    pub const @"type" = bridge.accessor(Response.getType, null, .{});
    pub const bodyUsed = bridge.accessor(Response.getBodyUsed, null, .{});
    pub const text = bridge.function(Response.getText, .{});
    pub const json = bridge.function(Response.getJson, .{});
    pub const textStream = bridge.function(Response.textStream, .{});
    pub const headers = bridge.accessor(Response.getHeaders, null, .{});
    pub const body = bridge.accessor(Response.getBody, null, .{});
    pub const url = bridge.accessor(Response.getURL, null, .{});
    pub const redirected = bridge.accessor(Response.isRedirected, null, .{});
    pub const arrayBuffer = bridge.function(Response.arrayBuffer, .{});
    pub const blob = bridge.function(Response.blob, .{});
    pub const bytes = bridge.function(Response.bytes, .{});
    pub const formData = bridge.function(Response.formData, .{});
    pub const clone = bridge.function(Response.clone, .{});
};

const testing = @import("../../../testing/testing.zig");
test "WebApi: Response" {
    try testing.htmlRunner("net/response.html", .{});
}
