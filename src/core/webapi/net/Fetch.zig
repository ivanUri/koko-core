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
const HttpClient = @import("../../browser/HttpClient.zig");

const js = @import("../../js/js.zig");
const Page = @import("../../browser/Page.zig");
const URL = @import("../../browser/URL.zig");

const Blob = @import("../Blob.zig");
const Request = @import("Request.zig");
const Response = @import("Response.zig");
const FetchRedirectState = @import("FetchRedirectState.zig");
const Integrity = @import("Integrity.zig");
const AbortSignal = @import("../AbortSignal.zig");
const ReadableStream = @import("../streams/ReadableStream.zig");
const DOMException = @import("../../dom/DOMException.zig");
const ReferrerPolicy = @import("../../browser/ReferrerPolicy.zig");
const http = @import("../../../runtime/network/http.zig");

const log = @import("../../../support/log.zig");
const Execution = js.Execution;
const Frame = @import("../../browser/Frame.zig");
const RealmLifecycleKernel = @import("../../../runtime/RealmLifecycleKernel.zig");
const IS_DEBUG = @import("builtin").mode == .Debug;

const Fetch = @This();

_exec: *const Execution,
_task_owner: RealmLifecycleKernel.TaskOwner,
_url: []const u8,
_buf: std.ArrayList(u8),
_response: *Response,
_resolver: js.PromiseResolver.Global,
_owns_response: bool,
_signal: ?*AbortSignal,
_mode: Request.Mode,
_integrity: []const u8,
_method: []const u8,
_fetch_resolved: bool = false,
_stream: ?*ReadableStream = null,
_keepalive: bool = false,

pub const Input = Request.Input;
pub const InitOpts = Request.InitOpts;

pub fn init(input: Input, options: ?InitOpts, exec: *const Execution) !js.Promise {
    const resolver = exec.context.local.?.createPromiseResolver();

    const request = Request.init(input, options, exec) catch |err| switch (err) {
        error.TypeError => {
            resolver.rejectError("fetch init", .{ .type_error = "" });
            return resolver.promise();
        },
        else => return err,
    };

    if (request._body_stream != null) {
        resolver.rejectError("streaming upload", .{ .type_error = "" });
        return resolver.promise();
    }

    if (request._signal) |signal| {
        if (signal._aborted) {
            resolver.reject("fetch aborted", DOMException.init("The operation was aborted.", "AbortError"));
            return resolver.promise();
        }
    }

    if (std.mem.startsWith(u8, request._url, "blob:")) {
        return handleBlobUrl(request, resolver, exec);
    }

    if (request._mode == .@"same-origin" and !exec.isSameOrigin(request._url)) {
        resolver.rejectError("fetch same-origin", .{ .type_error = "Failed to fetch" });
        return resolver.promise();
    }

    const response = try Response.init(null, .{ .status = 0 }, exec);
    errdefer response.deinit(exec.context.page);

    const arena = response._arena;
    const req_headers = try request.getHeaders(exec);
    const method_name = request._method;
    const http_method = request.httpMethod();
    const custom_method: ?[:0]const u8 = if (std.meta.stringToEnum(http.Method, method_name) == null)
        try exec.call_arena.dupeZ(u8, method_name)
    else
        null;

    const redirect_state = try arena.create(FetchRedirectState.State);
    redirect_state.* = .{
        .exec = exec,
        .arena = arena,
        .request_headers = req_headers,
        .referrer = try arena.dupe(u8, request._referrer),
        .referrer_policy = try arena.dupe(u8, request._referrer_policy),
        .referrer_source_url = try arena.dupeZ(u8, exec.url.*),
        .body_content_type = request._body_content_type,
    };

    const fetch = try arena.create(Fetch);
    fetch.* = .{
        ._exec = exec,
        ._task_owner = exec.captureTaskOwner(),
        ._buf = .empty,
        ._url = try arena.dupe(u8, request._url),
        ._resolver = try resolver.persist(),
        ._response = response,
        ._owns_response = true,
        ._signal = request._signal,
        ._mode = request._mode,
        ._integrity = request._integrity,
        ._method = try arena.dupe(u8, method_name),
        ._keepalive = request._keepalive,
    };

    const session = exec.context.page.session;
    const http_client = &session.browser.http_client;
    const headers = try FetchRedirectState.buildWireHeaders(redirect_state, request._url, request._body, method_name);

    if (comptime IS_DEBUG) {
        log.debug(.http, "fetch", .{ .url = request._url });
    }

    const cookie_jar = switch (request._credentials) {
        .omit => null,
        .include => &session.cookie_jar,
        .@"same-origin" => if (exec.isSameOrigin(request._url)) &session.cookie_jar else null,
    };

    RealmLifecycleKernel.tracePromiseSchedule(exec.frameId(), exec.realmEpoch(), .fetch_completion);

    const raw_post_body = request._body != null and request._body_content_type == null;
    const curl_default_headers = !raw_post_body;

    try http_client.request(.{
        .ctx = fetch,
        .params = .{
            .url = request._url,
            .method = http_method,
            .custom_method = custom_method,
            .frame_id = exec.frameId(),
            .loader_id = exec.loaderId(),
            .body = request._body,
            .headers = headers,
            .resource_type = .fetch,
            .cookie_jar = cookie_jar,
            .cookie_origin = exec.url.*,
            .top_level_cookie_url = exec.topLevelCookieUrl(),
            .notification = session.notification,
            .curl_default_headers = curl_default_headers,
            .raw_post_body = raw_post_body,
            .redirect_refresh_ctx = redirect_state,
            .redirect_header_rebuild = FetchRedirectState.rebuildHeaders,
            .keepalive = request._keepalive,
        },
        .start_callback = httpStartCallback,
        .header_callback = httpHeaderDoneCallback,
        .data_callback = httpDataCallback,
        .done_callback = httpDoneCallback,
        .error_callback = httpErrorCallback,
        .shutdown_callback = httpShutdownCallback,
    });
    return resolver.promise();
}

fn handleBlobUrl(request: *Request, resolver: js.PromiseResolver, exec: *const Execution) !js.Promise {
    if (!std.mem.eql(u8, request._method, "GET")) {
        resolver.rejectError("fetch blob method", .{ .type_error = "" });
        return resolver.promise();
    }

    const url = request._url;
    const blob: *Blob = exec.lookupBlobUrl(url) orelse {
        resolver.rejectError("fetch blob error", .{ .type_error = "BlobNotFound" });
        return resolver.promise();
    };

    const response = try Response.init(null, .{ .status = 200 }, exec);
    response._body = .{ .bytes = try response._arena.dupe(u8, blob._slice) };
    response._url = try response._arena.dupeZ(u8, url);
    response._type = .basic;

    const content_type = try Blob.validateMimeType(response._arena, blob._mime, true);
    try response._headers.appendResponse("Content-Type", content_type, exec);

    const content_length = try std.fmt.allocPrint(response._arena, "{d}", .{blob._slice.len});
    try response._headers.appendResponse("Content-Length", content_length, exec);

    const js_val = try exec.context.local.?.zigValueToJs(response, .{});
    resolver.resolve("fetch blob done", js_val);
    return resolver.promise();
}

fn httpStartCallback(response: HttpClient.Response) !void {
    const self: *Fetch = @ptrCast(@alignCast(response.ctx));
    if (comptime IS_DEBUG) {
        log.debug(.http, "request start", .{ .url = self._url, .source = "fetch" });
    }
    self._response._http_response = response;
}

/// Safe AbortSignal probe. After navigation the signal object may already be
/// freed with the old document; only dereference when the fetch's task owner
/// epoch is still current (nytimes.com UAF at signal._aborted).
fn fetchSignalAborted(self: *Fetch) bool {
    if (self._exec.isTaskOwnerStale(self._task_owner)) {
        self._signal = null;
        return true;
    }
    if (self._signal) |signal| {
        return signal._aborted;
    }
    return false;
}

fn httpHeaderDoneCallback(response: HttpClient.Response) !bool {
    const self: *Fetch = @ptrCast(@alignCast(response.ctx));

    if (fetchSignalAborted(self)) {
        return false;
    }

    const arena = self._response._arena;
    if (response.contentLength()) |cl| {
        try self._buf.ensureTotalCapacity(arena, cl);
    }

    const res = self._response;

    if (comptime IS_DEBUG) {
        log.debug(.http, "request header", .{
            .source = "fetch",
            .url = self._url,
            .status = response.status(),
        });
    }

    const status = response.status().?;
    // Redirect hops are handled internally; only materialize the final response.
    // 304 Not Modified is terminal (Fetch conditional GET), not a redirect hop.
    if (status >= 300 and status < 400 and status != 304) return true;

    res._status = status;
    res._status_text = std.http.Status.phrase(@enumFromInt(status)) orelse "";
    res._url = try URL.withoutFragment(arena, response.url());
    res._is_redirected = response.redirectCount().? > 0;

    const exec = self._exec;
    const is_same_origin = isSameOriginResolved(exec, res._url);

    if (self._mode == .@"no-cors" and !is_same_origin) {
        applyOpaqueFilter(res);
        return true;
    }

    // Determine response type per Fetch spec §4.3:
    //   - same-origin → .basic
    //   - cross-origin + ACAO header present → .cors
    //   - cross-origin + no ACAO header → .opaque
    if (is_same_origin) {
        res._type = .basic;
    } else {
        var has_acao = false;
        var hdr_it = response.headerIterator();
        while (hdr_it.next()) |hdr| {
            if (std.ascii.eqlIgnoreCase(hdr.name, "access-control-allow-origin")) {
                has_acao = true;
                break;
            }
        }
        res._type = if (has_acao) .cors else .@"opaque";
    }

    var it = response.headerIterator();
    while (it.next()) |hdr| {
        try res._headers.appendResponse(hdr.name, hdr.value, exec);
    }

    if (self._integrity.len > 0 and responseHasNullBody(status, self._method)) {
        try rejectFetchNetworkError(self);
        return true;
    }

    if (fetchJsUnavailable(self)) {
        return true;
    }

    if (responseHasNullBody(status, self._method)) {
        try resolveFetchOnHeaders(self);
    } else {
        const stream = try ReadableStream.init(null, null, exec);
        res._body = .{ .stream = stream };
        self._stream = stream;
        // With subresource integrity, defer fetch resolution until the body is
        // complete and the digest can be verified (WPT integrity.sub).
        if (self._integrity.len == 0) {
            try resolveFetchOnHeaders(self);
        }
    }

    return true;
}

fn responseHasNullBody(status: u16, method: []const u8) bool {
    if (std.ascii.eqlIgnoreCase(method, "HEAD")) return true;
    return status == 204 or status == 205 or status == 304;
}

/// Keepalive (and any in-flight) fetches may outlive the initiating realm after
/// navigation / destroyContext. Complete the HTTP transfer but do not touch V8.
fn fetchJsUnavailable(self: *Fetch) bool {
    const exec = self._exec;
    if (exec.realmState() == .dead) return true;
    if (exec.isTaskOwnerStale(self._task_owner)) return true;
    if (!exec.canEnterJs(.allow_draining)) return true;
    return false;
}

/// Install a local scope for promise resolve/reject; no-op if context is gone.
fn fetchLocalScope(self: *Fetch, ls: *js.Local.Scope) bool {
    if (fetchJsUnavailable(self)) return false;
    return self._exec.context.tryLocalScope(ls);
}

fn releaseFetchResponse(self: *Fetch) void {
    if (!self._owns_response) return;
    // If the initiating realm navigated away or is dead, Page.deinit has
    // already released arenas (response._arena owns this Fetch). Drop
    // ownership only — response.deinit would double-free / UAF (nytimes.com).
    // Prefer task-owner stale over realmState: frame_id is reused across
    // pending→active commit, so realmState can look "active" while this
    // Fetch still points at torn-down memory.
    if (self._exec.isTaskOwnerStale(self._task_owner) or self._exec.realmState() == .dead) {
        self._owns_response = false;
        return;
    }
    self._response.deinit(self._exec.context.page);
    self._owns_response = false;
}

fn rejectFetchIntegrity(self: *Fetch) !void {
    const exec = self._exec;
    var blocked = exec.isTaskOwnerStale(self._task_owner);
    if (!blocked) {
        exec.validateJsEntry(.allow_draining, .fetch_completion) catch {
            blocked = true;
        };
    }
    var ls: js.Local.Scope = undefined;
    if (!self._exec.context.tryLocalScope(&ls)) {
        if (self._owns_response) {
            self._response.deinit(self._exec.context.page);
            self._owns_response = false;
        }
        return;
    }
    defer ls.deinit();

    if (blocked) {
        ls.toLocal(self._resolver).rejectError("fetch stale", .{ .type_error = "realm navigated" });
    } else {
        ls.toLocal(self._resolver).rejectError("fetch integrity", .{ .type_error = "Failed to fetch" });
    }
    if (self._owns_response) {
        self._response.deinit(exec.context.page);
        self._owns_response = false;
    }
}

fn resolveFetchAfterBody(self: *Fetch) !void {
    const exec = self._exec;
    var blocked = exec.isTaskOwnerStale(self._task_owner);
    if (!blocked) {
        exec.validateJsEntry(.allow_draining, .fetch_completion) catch {
            blocked = true;
        };
    }
    if (blocked) {
        const cur = exec.captureTaskOwner();
        RealmLifecycleKernel.tracePromiseDropStale(exec.frameId(), self._task_owner.epoch, cur.epoch, .fetch_completion);
        var ls: js.Local.Scope = undefined;
        if (!self._exec.context.tryLocalScope(&ls)) {
            if (self._owns_response) {
                self._response.deinit(self._exec.context.page);
                self._owns_response = false;
            }
            return;
        }
        defer ls.deinit();
        ls.toLocal(self._resolver).rejectError("fetch stale", .{ .type_error = "realm navigated" });
        if (self._owns_response) {
            self._response.deinit(exec.context.page);
            self._owns_response = false;
        }
        return;
    }

    if (self._mode == .@"same-origin" and !isSameOriginResolved(exec, self._response._url)) {
        var ls: js.Local.Scope = undefined;
        if (!self._exec.context.tryLocalScope(&ls)) {
            if (self._owns_response) {
                self._response.deinit(self._exec.context.page);
                self._owns_response = false;
            }
            return;
        }
        defer ls.deinit();
        defer if (self._owns_response) {
            self._response.deinit(exec.context.page);
            self._owns_response = false;
        };
        return ls.toLocal(self._resolver).rejectError("fetch same-origin redirect", .{ .type_error = "Failed to fetch" });
    }

    var ls: js.Local.Scope = undefined;
    if (!self._exec.context.tryLocalScope(&ls)) {
        if (self._owns_response) {
            self._response.deinit(self._exec.context.page);
            self._owns_response = false;
        }
        return;
    }
    defer ls.deinit();

    const js_val = try ls.local.zigValueToJs(self._response, .{});
    self._fetch_resolved = true;
    self._owns_response = false;
    ls.toLocal(self._resolver).resolve("fetch done", js_val);
}

fn rejectFetchNetworkError(self: *Fetch) !void {
    const exec = self._exec;
    var blocked = exec.isTaskOwnerStale(self._task_owner);
    if (!blocked) {
        exec.validateJsEntry(.allow_draining, .fetch_completion) catch {
            blocked = true;
        };
    }
    var ls: js.Local.Scope = undefined;
    if (!self._exec.context.tryLocalScope(&ls)) {
        if (self._owns_response) {
            self._response.deinit(self._exec.context.page);
            self._owns_response = false;
        }
        return;
    }
    defer ls.deinit();

    if (blocked) {
        ls.toLocal(self._resolver).rejectError("fetch stale", .{ .type_error = "realm navigated" });
    } else {
        ls.toLocal(self._resolver).rejectError("fetch error", .{ .type_error = "fetch error" });
    }
    if (self._owns_response) {
        self._response.deinit(exec.context.page);
        self._owns_response = false;
    }
}

fn isSameOriginResolved(exec: *const Execution, url: []const u8) bool {
    const resolved = URL.resolve(exec.call_arena, exec.base(), url, .{
        .always_dupe = false,
        .encoding = exec.charset.*,
    }) catch return false;
    return exec.isSameOrigin(resolved);
}

fn resolveFetchOnHeaders(self: *Fetch) !void {
    const exec = self._exec;
    var blocked = exec.isTaskOwnerStale(self._task_owner);
    if (!blocked) {
        exec.validateJsEntry(.allow_draining, .fetch_completion) catch {
            blocked = true;
        };
    }
    if (blocked) {
        const cur = exec.captureTaskOwner();
        RealmLifecycleKernel.tracePromiseDropStale(exec.frameId(), self._task_owner.epoch, cur.epoch, .fetch_completion);
        var ls: js.Local.Scope = undefined;
        if (!self._exec.context.tryLocalScope(&ls)) {
            if (self._owns_response) {
                self._response.deinit(self._exec.context.page);
                self._owns_response = false;
            }
            return;
        }
        defer ls.deinit();
        ls.toLocal(self._resolver).rejectError("fetch stale", .{ .type_error = "realm navigated" });
        if (self._owns_response) {
            self._response.deinit(exec.context.page);
            self._owns_response = false;
        }
        return;
    }

    if (self._mode == .@"same-origin" and !isSameOriginResolved(exec, self._response._url)) {
        var ls: js.Local.Scope = undefined;
        if (!self._exec.context.tryLocalScope(&ls)) {
            if (self._owns_response) {
                self._response.deinit(self._exec.context.page);
                self._owns_response = false;
            }
            return;
        }
        defer ls.deinit();
        defer if (self._owns_response) {
            self._response.deinit(exec.context.page);
            self._owns_response = false;
        };
        return ls.toLocal(self._resolver).rejectError("fetch same-origin redirect", .{ .type_error = "Failed to fetch" });
    }

    var ls: js.Local.Scope = undefined;
    if (!self._exec.context.tryLocalScope(&ls)) {
        if (self._owns_response) {
            self._response.deinit(self._exec.context.page);
            self._owns_response = false;
        }
        return;
    }
    defer ls.deinit();

    const js_val = try ls.local.zigValueToJs(self._response, .{});
    self._fetch_resolved = true;
    self._owns_response = false;
    ls.toLocal(self._resolver).resolve("fetch headers", js_val);
}

fn applyOpaqueFilter(res: *Response) void {
    res._type = .@"opaque";
    res._status = 0;
    res._status_text = "";
    res._url = "";
    res._headers._list = .{};
}

fn httpDataCallback(response: HttpClient.Response, data: []const u8) !void {
    const self: *Fetch = @ptrCast(@alignCast(response.ctx));

    // Check if aborted (epoch-gated; signal may be freed after navigation)
    if (fetchSignalAborted(self)) {
        return error.Abort;
    }

    try self._buf.appendSlice(self._response._arena, data);

    if (fetchJsUnavailable(self)) return;

    if (self._stream) |stream| {
        const copy = try self._response._arena.dupe(u8, data);
        try stream._controller.enqueue(.{ .uint8array = .{ .values = copy } });
    }
}

fn httpDoneCallback(ctx: *anyopaque) !void {
    const self: *Fetch = @ptrCast(@alignCast(ctx));
    var response = self._response;
    response._http_response = null;

    log.info(.http, "request complete", .{
        .source = "fetch",
        .url = self._url,
        .status = response._status,
        .len = self._buf.items.len,
    });

    const exec = self._exec;

    if (fetchJsUnavailable(self)) {
        releaseFetchResponse(self);
        return;
    }

    if (!self._fetch_resolved and self._stream != null) {
        if (self._integrity.len > 0) {
            const is_opaque = response._type == .@"opaque";
            const ok = !is_opaque and Integrity.verify(self._integrity, self._buf.items, exec.call_arena);
            if (!ok) {
                if (self._stream) |stream| {
                    try stream._controller.doError("Failed to fetch");
                }
                try rejectFetchIntegrity(self);
                return;
            }
        }
        if (self._stream) |stream| {
            if (stream._state == .readable) {
                try stream._controller.close();
            }
        }
        try resolveFetchAfterBody(self);
        return;
    }

    if (self._fetch_resolved) {
        if (self._integrity.len > 0) {
            const is_opaque = response._type == .@"opaque";
            const ok = !is_opaque and Integrity.verify(self._integrity, self._buf.items, exec.call_arena);
            if (!ok) {
                if (self._stream) |stream| {
                    try stream._controller.doError("Failed to fetch");
                }
                return;
            }
        }
        if (self._stream) |stream| {
            if (stream._state == .readable) {
                try stream._controller.close();
            }
        }
        return;
    }

    response._body = .{ .bytes = self._buf.items };
    var blocked = exec.isTaskOwnerStale(self._task_owner);
    if (!blocked) {
        exec.validateJsEntry(.allow_draining, .fetch_completion) catch {
            blocked = true;
        };
    }
    if (blocked) {
        const cur = exec.captureTaskOwner();
        RealmLifecycleKernel.tracePromiseDropStale(exec.frameId(), self._task_owner.epoch, cur.epoch, .fetch_completion);
        var ls: js.Local.Scope = undefined;
        if (!self._exec.context.tryLocalScope(&ls)) {
            if (self._owns_response) {
                self._response.deinit(self._exec.context.page);
                self._owns_response = false;
            }
            return;
        }
        defer ls.deinit();
        ls.toLocal(self._resolver).rejectError("fetch stale", .{ .type_error = "realm navigated" });
        if (self._owns_response) {
            response.deinit(exec.context.page);
            self._owns_response = false;
        }
        return;
    }

    var ls: js.Local.Scope = undefined;
    if (!self._exec.context.tryLocalScope(&ls)) {
        if (self._owns_response) {
            self._response.deinit(self._exec.context.page);
            self._owns_response = false;
        }
        return;
    }
    defer ls.deinit();

    // Capture resolver before response.deinit: Fetch lives in response._arena.
    if (self._mode == .@"same-origin" and !isSameOriginResolved(exec, response._url)) {
        const resolver = self._resolver;
        defer if (self._owns_response) {
            response.deinit(exec.context.page);
            self._owns_response = false;
        };
        return ls.toLocal(resolver).rejectError("fetch same-origin redirect", .{ .type_error = "Failed to fetch" });
    }

    if (self._integrity.len > 0) {
        const is_opaque = response._type == .@"opaque";
        const ok = !is_opaque and Integrity.verify(self._integrity, self._buf.items, exec.call_arena);
        if (!ok) {
            const resolver = self._resolver;
            defer if (self._owns_response) {
                response.deinit(exec.context.page);
                self._owns_response = false;
            };
            return ls.toLocal(resolver).rejectError("fetch integrity", .{ .type_error = "Failed to fetch" });
        }
    }

    const js_val = try ls.local.zigValueToJs(self._response, .{});
    self._owns_response = false;
    return ls.toLocal(self._resolver).resolve("fetch done", js_val);
}

fn httpErrorCallback(ctx: *anyopaque, err: anyerror) void {
    const self: *Fetch = @ptrCast(@alignCast(ctx));

    log.info(.http, "request error", .{
        .source = "fetch",
        .url = self._url,
        .status = self._response._status,
        .err = err,
    });

    var response = self._response;
    response._http_response = null;

    if (self._fetch_resolved) {
        // Body stream error path: only touch V8 if the initiating realm is
        // still enterable. After destroyContext (SPA nav / page teardown),
        // doError → localScope panics (nytimes.com mid-load aborts).
        if (!fetchJsUnavailable(self)) {
            if (self._stream) |stream| {
                stream._controller.doError("fetch error") catch {};
            }
        }
        return;
    }

    if (fetchJsUnavailable(self)) {
        releaseFetchResponse(self);
        return;
    }

    // the response is only passed on v8 on success, if we're here, it's safe to
    // clear this. (defer since `self is in the response's arena). Never deinit
    // when the realm is already dead — Page owns/released the arena.
    defer {
        if (self._owns_response and self._exec.realmState() != .dead) {
            self._owns_response = false;
            response.deinit(self._exec.context.page);
        } else {
            self._owns_response = false;
        }
    }

    const exec = self._exec;
    var blocked = exec.isTaskOwnerStale(self._task_owner);
    if (!blocked) {
        exec.validateJsEntry(.allow_draining, .fetch_completion) catch {
            blocked = true;
        };
    }

    var ls: js.Local.Scope = undefined;
    if (!fetchLocalScope(self, &ls)) {
        return;
    }
    defer ls.deinit();

    if (blocked) {
        const cur = exec.captureTaskOwner();
        RealmLifecycleKernel.tracePromiseDropStale(exec.frameId(), self._task_owner.epoch, cur.epoch, .fetch_completion);
        ls.toLocal(self._resolver).rejectError("fetch stale", .{ .type_error = "realm navigated" });
        return;
    }

    // fetch() must reject with a TypeError on network errors per spec
    ls.toLocal(self._resolver).rejectError("fetch error", .{ .type_error = "fetch error" });
}

fn httpShutdownCallback(ctx: *anyopaque) void {
    const self: *Fetch = @ptrCast(@alignCast(ctx));
    if (comptime IS_DEBUG) {
        // should always be true
        std.debug.assert(self._owns_response);
    }

    if (self._owns_response) {
        var response = self._response;
        response._http_response = null;
        response.deinit(self._exec.context.page);
        // Do not access `self` after this point: the Fetch struct was
        // allocated from response._arena which has been released.
    }
}

const testing = @import("../../../testing/testing.zig");
test "WebApi: fetch" {
    try testing.htmlRunner("net/fetch.html", .{});
}
