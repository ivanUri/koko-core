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

const js = @import("../js/js.zig");
const Scheduler = @import("../js/Scheduler.zig");

const URL = @import("../browser/URL.zig");
const Frame = @import("../browser/Frame.zig");
const Session = @import("../browser/Session.zig");
const HttpClient = @import("../browser/HttpClient.zig");
const ContentSecurityPolicy = @import("../browser/ContentSecurityPolicy.zig");
const ReferrerPolicy = @import("../browser/ReferrerPolicy.zig");

const Blob = @import("Blob.zig");
const EventTarget = @import("EventTarget.zig");
const MessageEvent = @import("event/MessageEvent.zig");
const Event = @import("Event.zig");
const ErrorEvent = @import("event/ErrorEvent.zig");
const WorkerGlobalScope = @import("WorkerGlobalScope.zig");
const MessagePort = @import("MessagePort.zig");

const log = @import("../../support/log.zig");
const Execution = js.Execution;
const Allocator = std.mem.Allocator;
const IS_DEBUG = @import("builtin").mode == .Debug;

const Worker = @This();

// used by HttpClient when generating notification
// Ultimately used by CDP to generate request/loader ids.
_frame_id: u32,
_loader_id: u32,

_proto: *EventTarget,
_frame: *Frame,
_arena: Allocator,
_worker_scope: *WorkerGlobalScope,

_url: [:0]const u8,
_terminated: bool = false,
_script_loaded: bool = false,
_bootstrap_complete: bool = false,
/// True only while `loadInitialScript` / module eval is on the worker V8 stack.
/// Outbound `postMessage` during this window must queue — entering the parent
/// frame's Local.Scope mid-worker-eval returns Script::Run null with no
/// TryCatch exception (agent blob bootstrap posts `[2]` at end of classic body).
_initial_eval_active: bool = false,
/// After deferred parent flush, worker→page posts must not sit in
/// `_pending_inbound_messages` (Fingerprint agent replies from onmessage).
_parent_delivery_ready: bool = false,
_script_buffer: std.ArrayList(u8) = .empty,
_http_response: ?HttpClient.Response = null,
_debug_next_message_id: u64 = 1,
_pending_inbound_messages: std.ArrayListUnmanaged(PendingInboundMessage) = .{},
_pending_undelivered: std.ArrayListUnmanaged(PendingInboundMessage) = .{},

// Event handlers
_on_error: ?js.Function.Global = null,
_on_message: ?js.Function.Global = null,
_on_messageerror: ?js.Function.Global = null,

/// Page Worker.onerror may be assigned after construction; defer load/runtime errors.
_pending_page_error: enum { none, load, runtime } = .none,
_pending_error_message: ?[]const u8 = null,
_pending_error_filename: ?[]const u8 = null,
_pending_error_line: u32 = 0,
_pending_error_col: u32 = 0,

_script_type: WorkerType = .classic,
_credentials: WorkerCredentials = .@"same-origin",
_script_csp: ?ContentSecurityPolicy.Policy = null,
_referrer_policy: ReferrerPolicy.Policy = .@"strict-origin-when-cross-origin",
_shared_mode: bool = false,
_shared_runtime: ?*anyopaque = null,
_shared_script_ready_cb: ?*const fn (*Worker) void = null,
_shared_script_error_cb: ?*const fn (*Worker, []const u8) void = null,

pub const WorkerType = enum {
    classic,
    module,
    pub const js_enum_from_string = true;
};

pub const WorkerCredentials = enum {
    omit,
    @"same-origin",
    include,
    pub const js_enum_from_string = true;
};

pub const WorkerOptions = struct {
    type: ?WorkerType = null,
    credentials: ?WorkerCredentials = null,
};

pub fn shouldSendCookies(self: *const Worker, request_url: [:0]const u8) bool {
    return switch (self._script_type) {
        // Classic workers ignore the credentials option but only attach cookies
        // to same-origin fetches (cross-origin dynamic import() never sends them).
        .classic => self._worker_scope.isSameOrigin(request_url),
        .module => switch (self._credentials) {
            .omit => false,
            .include => true,
            .@"same-origin" => self._worker_scope.isSameOrigin(request_url),
        },
    };
}

pub fn initSharedHost(
    url: []const u8,
    options: WorkerOptions,
    frame: *Frame,
    script_ready_cb: *const fn (*Worker) void,
    script_error_cb: *const fn (*Worker, []const u8) void,
) !*Worker {
    const session = frame._session;

    const script_type = options.type orelse .classic;
    const credentials: WorkerCredentials = if (script_type == .classic)
        .include
    else
        options.credentials orelse .@"same-origin";

    if (!URL.canParse(url, frame.url)) {
        return error.SyntaxError;
    }

    const arena = try session.getArena(.large, "SharedWorker.host");
    errdefer session.releaseArena(arena);

    const resolved_url = try URL.resolve(arena, frame.url, url, .{ .encoding = frame.charset });
    const self = try frame._page.factory.eventTargetWithAllocator(arena, Worker{
        ._arena = arena,
        ._proto = undefined,
        ._frame = frame,
        ._url = resolved_url,
        ._worker_scope = undefined,
        ._frame_id = session.nextFrameId(),
        ._loader_id = session.nextLoaderId(),
        ._script_type = script_type,
        ._credentials = credentials,
        ._shared_mode = true,
        ._shared_script_ready_cb = script_ready_cb,
        ._shared_script_error_cb = script_error_cb,
    });
    self._worker_scope = try WorkerGlobalScope.init(self, resolved_url, true);
    errdefer self._worker_scope.deinit();
    try frame.trackWorker(self);

    if (std.mem.startsWith(u8, url, "blob:")) {
        const blob: *Blob = frame.js.execution.lookupBlobUrl(url) orelse {
            log.warn(.js, "invalid blob", .{ .target = "shared-worker" });
            return error.BlobNotFound;
        };
        const script_copy = try arena.dupe(u8, blob._slice);
        try self.scheduleDeferredBlobScript(script_copy);
        return self;
    }

    if (std.mem.startsWith(u8, url, "data:")) {
        const script_body = WorkerGlobalScope.decodeDataUrlJavaScript(arena, url) catch {
            return error.NetworkError;
        };
        const script_copy = try arena.dupe(u8, script_body);
        try self.scheduleDeferredBlobScript(script_copy);
        return self;
    }

    const http_client = &session.browser.http_client;
    var headers = try http_client.newHeaders();
    try frame.headersForRequest(&headers, .{
        .request_url = resolved_url,
        .resource_type = .worker,
        .referrer_source_url = frame.url,
        .referrer_policy = frame.referrer_policy,
    });
    http_client.request(.{
        .ctx = self,
        .params = .{
            .url = resolved_url,
            .method = .GET,
            .headers = headers,
            .frame_id = self._frame_id,
            .loader_id = self._loader_id,
            .resource_type = .worker,
            .cookie_jar = &session.cookie_jar,
            .cookie_origin = frame.url,
            .top_level_cookie_url = frame.topLevelUrl(),
            .omit_cookies = !self.shouldSendCookies(resolved_url),
            // Abort with the document frame on root re-nav (not worker frame_id alone).
            .attribution_frame = frame,
            .notification = session.notification,
        },
        .header_callback = httpHeaderCallback,
        .data_callback = httpDataCallback,
        .done_callback = httpDoneCallback,
        .error_callback = httpErrorCallback,
    }) catch |err| {
        log.err(.browser, "SharedWorker request", .{ .url = resolved_url, .err = err });
        return err;
    };
    return self;
}

pub fn init(url: []const u8, options: ?WorkerOptions, exec: *Execution) !*Worker {
    const frame = switch (exec.context.global) {
        .frame => |f| f,
        // Nested dedicated workers: parent browsing context is still the document.
        .worker => |wgs| wgs._worker._frame,
    };
    const session = frame._session;

    const opts = options orelse WorkerOptions{};
    const script_type = opts.type orelse .classic;
    const credentials: WorkerCredentials = if (script_type == .classic)
        .include
    else
        opts.credentials orelse .@"same-origin";

    if (!URL.canParse(url, exec.url.*)) {
        return error.SyntaxError;
    }

    const arena = try session.getArena(.large, "Worker");
    errdefer session.releaseArena(arena);

    const resolved_url = try URL.resolve(arena, exec.url.*, url, .{ .encoding = frame.charset });
    const self = try frame._page.factory.eventTargetWithAllocator(arena, Worker{
        ._arena = arena,
        ._proto = undefined,
        ._frame = frame,
        ._url = resolved_url,
        ._worker_scope = undefined,
        ._frame_id = session.nextFrameId(),
        ._loader_id = session.nextLoaderId(),
        ._script_type = script_type,
        ._credentials = credentials,
    });
    self._worker_scope = try WorkerGlobalScope.init(self, resolved_url, false);
    errdefer self._worker_scope.deinit();
    try frame.trackWorker(self);

    if (std.mem.startsWith(u8, url, "blob:")) {
        errdefer frame.removeWorker(self);
        const blob: *Blob = exec.lookupBlobUrl(url) orelse {
            log.warn(.js, "invalid blob", .{ .target = "worker" });
            return error.BlobNotFound;
        };
        const script_copy = try arena.dupe(u8, blob._slice);
        try self.scheduleDeferredBlobScript(script_copy);
        return self;
    }

    if (std.mem.startsWith(u8, url, "data:")) {
        errdefer frame.removeWorker(self);
        const script_body = WorkerGlobalScope.decodeDataUrlJavaScript(arena, url) catch {
            frame.removeWorker(self);
            return error.NetworkError;
        };
        const script_copy = try arena.dupe(u8, script_body);
        try self.scheduleDeferredBlobScript(script_copy);
        return self;
    }

    const http_client = &session.browser.http_client;
    var headers = try http_client.newHeaders();
    try frame.headersForRequest(&headers, .{
        .request_url = resolved_url,
        .resource_type = .worker,
        .referrer_source_url = frame.url,
        .referrer_policy = frame.referrer_policy,
    });
    http_client.request(.{
        .ctx = self,
        .params = .{
            .url = resolved_url,
            .method = .GET,
            .headers = headers,
            .frame_id = self._frame_id,
            .loader_id = self._loader_id,
            .resource_type = .worker,
            .cookie_jar = &session.cookie_jar,
            .cookie_origin = frame.url,
            .top_level_cookie_url = frame.topLevelUrl(),
            .omit_cookies = !self.shouldSendCookies(resolved_url),
            .attribution_frame = frame,
            .notification = session.notification,
        },
        .header_callback = httpHeaderCallback,
        .data_callback = httpDataCallback,
        .done_callback = httpDoneCallback,
        .error_callback = httpErrorCallback,
    }) catch |err| {
        log.err(.browser, "Worker request", .{ .url = resolved_url, .err = err });
        frame.removeWorker(self);
        return err;
    };
    return self;
}

fn cancelDeferredScriptTasks(scheduler: *Scheduler, worker: *Worker) void {
    const Matcher = struct {
        var target: *Worker = undefined;
        fn match(ctx: *anyopaque, callback: Scheduler.Callback) bool {
            if (callback != DeferBlobScriptCallback.run and callback != DeferFetchedScriptCallback.run) {
                return false;
            }
            const entry: *DeferBlobScriptCallback = @ptrCast(@alignCast(ctx));
            return entry.worker == target;
        }
    };
    Matcher.target = worker;
    scheduler.cancelTasks(Matcher.match);
}

/// Abort the worker, drop parent-frame references, and release resources.
pub fn destroy(self: *Worker) void {
    if (self._terminated) return;
    // Shared worker script hosts are not tracked on frame.workers.
    if (!self._shared_mode) {
        cancelDeferredScriptTasks(&self._frame.js.scheduler, self);
        self._frame.removeWorker(self);
    }
    self.deinitForSession(self._frame._session);
}

// Called from Frame.deinit when the frame is destroyed (workers already drained
// via terminateAllWorkers, so the frame list is usually empty).
pub fn deinit(self: *Worker) void {
    self.deinitForSession(self._frame._session);
}

/// Tear down without dereferencing `self._frame` (shared worker hosts may
/// outlive the creating frame's heap allocation during session teardown).
pub fn deinitForSession(self: *Worker, session: *Session) void {
    if (self._terminated) return;
    self._terminated = true;
    self._bootstrap_complete = false;
    self._parent_delivery_ready = false;
    // Cancel only this worker's *script* transfer (and same frame_id work), but
    // do not abort `.fetch` / `.xhr` sharing the synthetic worker frame_id.
    // Fingerprint agent can start config GET (`fetch …/e?region=us`) while a
    // short-lived collection worker is torn down; abortFrame(.full) was killing
    // that fetch (CDP Shutdown) before body, blocking identify→/api/event.
    // Explicit worker HTTP response is aborted below; parent document re-nav
    // still cancels via attribution_frame on the parent Frame.
    session.browser.http_client.abortFrame(self._frame_id, .{
        .scope = .full,
        .skip_fetch = true,
        .skip_xhr = true,
    });
    if (self._http_response) |res| {
        res.abort(error.Abort);
        self._http_response = null;
    }
    self.releasePendingInboundMessages();
    self._worker_scope.deinitForSession(session);
    session.releaseArena(self._arena);
}

pub fn asEventTarget(self: *Worker) *EventTarget {
    return self._proto;
}

fn httpHeaderCallback(response: HttpClient.Response) !bool {
    const self: *Worker = @ptrCast(@alignCast(response.ctx));
    if (self._terminated) return false;

    const status = response.status() orelse return false;
    if (status < 200 or status >= 300) {
        log.warn(.browser, "Worker status", .{
            .url = self._url,
            .status = status,
        });
        return false;
    }

    self._http_response = response;
    if (response.contentLength()) |cl| {
        try self._script_buffer.ensureTotalCapacity(self._arena, cl);
    }

    self._script_csp = null;
    self._referrer_policy = .@"strict-origin-when-cross-origin";
    var hdr_it = response.headerIterator();
    while (hdr_it.next()) |hdr| {
        if (std.ascii.eqlIgnoreCase(hdr.name, "content-security-policy")) {
            self._script_csp = ContentSecurityPolicy.Policy.parse(self._arena, hdr.value) catch null;
        } else if (std.ascii.eqlIgnoreCase(hdr.name, "referrer-policy")) {
            self._referrer_policy = ReferrerPolicy.Policy.parse(hdr.value);
        }
    }

    return true;
}

fn httpDataCallback(response: HttpClient.Response, data: []const u8) !void {
    const self: *Worker = @ptrCast(@alignCast(response.ctx));
    if (self._terminated) return;
    try self._script_buffer.appendSlice(self._arena, data);
}

fn httpDoneCallback(ctx: *anyopaque) !void {
    const self: *Worker = @ptrCast(@alignCast(ctx));
    if (self._terminated) return;
    self._http_response = null;
    self._script_loaded = true;

    const url = self._url;
    const script = self._script_buffer.items;

    if (comptime IS_DEBUG) {
        log.info(.browser, "worker fetch done", .{
            .url = url,
            .len = script.len,
        });
    }

    const script_copy = try self._arena.dupe(u8, script);
    try self.scheduleDeferredFetchedScript(script_copy);
}

fn scheduleDeferredFetchedScript(self: *Worker, script: []const u8) !void {
    const frame = self._frame;
    const arena = try frame.getArena(.medium, "Worker.deferFetchedScript");
    errdefer frame.releaseArena(arena);

    const callback = try arena.create(DeferFetchedScriptCallback);
    callback.* = .{ .worker = self, .script = script, .arena = arena };

    // Worker script eval must run on the worker scheduler, never nested inside a
    // frame microtask checkpoint (DisallowJavascriptExecution / SIGSEGV).
    const scheduler = &self._worker_scope.js.scheduler;

    try scheduler.add(callback, DeferFetchedScriptCallback.run, 0, .{
        .name = "Worker.deferFetchedScript",
        .low_priority = false,
        .finalizer = DeferFetchedScriptCallback.cancelled,
    });
}

fn scheduleDeferredMacrotaskPump(frame: *Frame) void {
    frame.scheduleDeferredMacrotaskPump(0) catch |err| {
        log.warn(.browser, "worker pump macrotasks", .{ .err = err });
    };
}

/// CreepJS getWorkerData uses two setTimeout(0) rounds after creep.js eval.
const bootstrap_drain_max_passes: u32 = 128;
const bootstrap_pump_max_rounds: u32 = 48;

pub fn pumpBootstrapContext(ctx: *js.Context, env: *js.Env) void {
    const exec = &ctx.execution;
    if (exec.realmState() == .dead) return;
    if (!exec.canEnterJs(.strict_active)) return;
    // Shared host reentrancy policy (architecture: JsEntryGate).
    if (js.JsEntryGate.mustQueueAsTask(exec)) return;

    var hs: js.HandleScope = undefined;
    const entered = ctx.enter(&hs) orelse return;
    defer entered.exit();

    var pass: u8 = 0;
    while (pass < 32) : (pass += 1) {
        if (!ctx.scheduler.hasReadyTasks()) break;
        _ = ctx.scheduler.runOne() catch break;
        var mt: u8 = 0;
        while (mt < 8) : (mt += 1) {
            env.performMicrotaskCheckpoint(ctx);
        }
    }
}

fn drainBootstrapSchedulers(self: *Worker) !void {
    const env = &self._frame._session.browser.env;
    var pass: u32 = 0;
    while (pass < bootstrap_drain_max_passes) : (pass += 1) {
        var any_ready = false;
        if (self._worker_scope.js.scheduler.hasReadyTasks()) {
            any_ready = true;
            pumpBootstrapContext(self._worker_scope.js, env);
        }
        if (self._frame.js.scheduler.hasReadyTasks()) {
            any_ready = true;
            pumpBootstrapContext(self._frame.js, env);
        }
        if (!any_ready) break;
    }
}

fn loadInitialScript(self: *Worker, script: []const u8) !void {
    if (self._script_type == .module) {
        try self.loadInitialModule(script);
        return;
    }

    {
        var ls: js.Local.Scope = undefined;
        self._worker_scope.js.localScope(&ls);
        defer ls.deinit();

        var try_catch: js.TryCatch = undefined;
        try_catch.init(&ls.local);

        const PendingSharedRuntimeError = struct {
            message: []const u8,
            line: u32,
        };
        var pending_shared_runtime_error: ?PendingSharedRuntimeError = null;
        defer if (pending_shared_runtime_error) |pending| {
            self._worker_scope.reportSharedScriptRuntimeError(
                pending.message,
                self._url,
                pending.line,
                0,
            );
        };
        defer try_catch.deinit();

        // reCAPTCHA's worker bootstrap posts to the parent during importScripts and
        // expects a synchronous reply before the initial eval returns — but only
        // *after* we leave the worker Script::Run stack. Mark bootstrap complete
        // for messaging policy, keep `_initial_eval_active` so mid-eval posts queue.
        self._bootstrap_complete = true;
        self._initial_eval_active = true;
        defer self._initial_eval_active = false;

        const script_parse_ok = ls.local.canCompileScript(script, self._url);
        // WPT worker scripts assign onmessage/onerror on the global object; wrapping
        // in an IIFE can leave those handlers off the Zig accessor slots.
        // Step markers survive empty-TryCatch aborts (agent blob diagnostics).
        const eval_source = std.fmt.allocPrint(self._arena,
            \\globalThis.__veloraWorkerStep=0;
            \\try{{
            \\globalThis.__veloraWorkerStep=1;
            \\{s}
            \\globalThis.__veloraWorkerStep=99;
            \\}}catch(e){{
            \\globalThis.__veloraWorkerStep=-(globalThis.__veloraWorkerStep||1);
            \\globalThis.__veloraWorkerErr=String(e&&e.stack||e);
            \\throw e;
            \\}}
        , .{script}) catch script;

        // Parent classic-script watchdogs share the isolate. A prior Terminate
        // left on the isolate makes Script::Run return null with no exception.
        const env = &self._frame._session.browser.env;
        env.cancelTerminate();

        _ = ls.local.eval(eval_source, self._url) catch |err| {
            const terminating = env.isExecutionTerminating();
            if (terminating) env.cancelTerminate();
            const caught = try_catch.caughtOrError(self._arena, err);
            var step: i32 = -999;
            var err_txt: []const u8 = "";
            if (ls.local.exec("globalThis.__veloraWorkerStep|0", null)) |sv| {
                step = sv.toZig(i32) catch -998;
            } else |_| {}
            if (ls.local.exec("globalThis.__veloraWorkerErr||''", null)) |ev| {
                if (ev.isString()) |js_str| {
                    err_txt = js_str.toSliceWithAlloc(self._arena) catch "";
                }
            } else |_| {}
            log.err(.browser, "worker script error", .{
                .url = self._url,
                .err = err,
                .parse_ok = script_parse_ok,
                .has_caught = try_catch.hasCaught(),
                .terminating = terminating,
                .step = step,
                .js_err = err_txt,
                .parent_call_depth = self._frame.js.call_depth,
                .checkpoint_active = env.checkpoint_active,
                .caught = caught,
                .script_len = script.len,
            });
            if (self._shared_mode and script_parse_ok) {
                const message = caught.exception orelse @errorName(err);
                const line = caught.line orelse 0;
                if (try_catch.exceptionValue()) |ex| {
                    try self._worker_scope.reportUncaughtException(
                        ex,
                        message,
                        self._url,
                        line,
                        0,
                    );
                } else {
                    pending_shared_runtime_error = .{ .message = message, .line = line };
                }
            } else {
                const message = caught.exception orelse @errorName(err);
                const line = caught.line orelse 0;
                if (script_parse_ok) {
                    const error_temp: ?js.Value.Temp = if (try_catch.exceptionValue()) |ex|
                        ex.temp() catch null
                    else
                        null;
                    self.fireRuntimeErrorEventFromFrame(
                        message,
                        self._url,
                        line,
                        0,
                        error_temp,
                    );
                } else {
                    self.fireLoadErrorEventFromFrame(message);
                }
                return;
            }
        };
        // Parent postMessage() may already be queued on the worker scheduler while
        // this eval was in flight. Sync onmessage/onerror slots before pumping so
        // inbound delivery does not land in _pending_undelivered with null Zig slots.
        self._worker_scope.syncScriptHandlerSlotsFromLocal(&ls.local);
        try self._worker_scope.flushPendingUndelivered();
        ls.local.runMacrotasks();
    }
    if (self._shared_mode) {
        if (self._shared_script_ready_cb) |cb| cb(self);
    }
    // Drain worker↔page scheduler queues only after the worker local scope exits.
    // Pumping the parent frame while the worker context is still entered breaks
    // MessageEvent delivery (WPT message-event / Worker_basic).
    try drainBootstrapSchedulers(self);
    // CreepJS worker scope chains setTimeout (queueEvent) after eval; pump the
    // worker scheduler on the next frame turn so getWorkerData can postMessage.
    try self.scheduleDeferredWorkerPump(0);
    try self.finishInitialScriptLoad();
}

fn loadInitialModule(self: *Worker, script: []const u8) !void {
    {
        var ls: js.Local.Scope = undefined;
        self._worker_scope.js.localScope(&ls);
        defer ls.deinit();

        self._bootstrap_complete = true;
        self._initial_eval_active = true;
        defer self._initial_eval_active = false;

        {
            const flag_src =
                \\globalThis.__veloraWorkerIsModule=true;
            ;
            ls.local.eval(flag_src, "worker-module-flag") catch |err| {
                log.warn(.browser, "worker module flag", .{ .err = err });
            };
        }

        var try_catch: js.TryCatch = undefined;
        try_catch.init(&ls.local);
        defer try_catch.deinit();

        const ctx = self._worker_scope.js;
        ctx.module(false, &ls.local, script, self._url, true) catch |err| {
            const message = if (try_catch.hasCaught())
                try_catch.caughtOrError(self._arena, err).exception orelse @errorName(err)
            else
                @errorName(err);
            log.err(.browser, "worker module error", .{ .url = self._url, .message = message });
            self.fireErrorEventFromFrame(message, null);
            return;
        };

        self._worker_scope.syncScriptHandlerSlotsFromLocal(&ls.local);
        try self._worker_scope.flushPendingUndelivered();
        ls.local.runMacrotasks();
    }
    if (self._shared_mode) {
        if (self._shared_script_ready_cb) |cb| cb(self);
    }
    try drainBootstrapSchedulers(self);
    try self.scheduleDeferredWorkerPump(0);
    try self.finishInitialScriptLoad();
}

fn finishInitialScriptLoad(self: *Worker) !void {
    if (self._shared_mode) {
        return;
    }
    // Queue parent delivery for the next macrotask turn so Worker() can return
    // and onmessage handlers can be assigned first.
    try self.scheduleDeferredParentFlush();
}

fn scheduleDeferredWorkerPump(self: *Worker, round: u32) !void {
    const frame = self._frame;
    const arena = try frame.getArena(.tiny, "Worker.deferPump");
    errdefer frame.releaseArena(arena);

    const callback = try arena.create(DeferWorkerPumpCallback);
    callback.* = .{ .worker = self, .arena = arena, .round = round };

    try frame.js.scheduler.add(callback, DeferWorkerPumpCallback.run, 0, .{
        .name = "Worker.deferPump",
        .low_priority = false,
        .finalizer = DeferWorkerPumpCallback.cancelled,
    });
}

const DeferWorkerPumpCallback = struct {
    worker: *Worker,
    arena: Allocator,
    round: u32,

    fn cancelled(ctx: *anyopaque) void {
        const self: *DeferWorkerPumpCallback = @ptrCast(@alignCast(ctx));
        self.worker._frame.releaseArena(self.arena);
    }

    fn run(ctx: *anyopaque) !?u32 {
        const self: *DeferWorkerPumpCallback = @ptrCast(@alignCast(ctx));
        const worker = self.worker;
        if (worker._terminated) {
            worker._frame.releaseArena(self.arena);
            return null;
        }
        const frame = worker._frame;
        const browser = frame._session.browser;

        browser.runMacrotasks() catch |err| {
            log.warn(.browser, "worker deferred pump", .{ .err = err });
        };
        scheduleDeferredMacrotaskPump(frame);

        const worker_pending = worker._worker_scope.js.scheduler.hasReadyTasks();
        const frame_pending = frame.js.scheduler.hasReadyTasks();
        defer frame.releaseArena(self.arena);
        if ((worker_pending or frame_pending) and self.round + 1 < bootstrap_pump_max_rounds) {
            try worker.scheduleDeferredWorkerPump(self.round + 1);
        }
        return null;
    }
};

fn scheduleDeferredParentFlush(self: *Worker) !void {
    const frame = self._frame;
    const arena = try frame.getArena(.tiny, "Worker.deferFlush");
    errdefer frame.releaseArena(arena);

    const callback = try arena.create(DeferFlushCallback);
    callback.* = .{ .worker = self, .arena = arena };

    try frame.js.scheduler.add(callback, DeferFlushCallback.run, 0, .{
        .name = "Worker.deferFlush",
        .low_priority = false,
        .finalizer = DeferFlushCallback.cancelled,
    });
}

fn scheduleDeferredBlobScript(self: *Worker, script: []const u8) !void {
    const frame = self._frame;
    const arena = try frame.getArena(.medium, "Worker.deferBlobScript");
    errdefer frame.releaseArena(arena);

    const callback = try arena.create(DeferBlobScriptCallback);
    callback.* = .{ .worker = self, .script = script, .arena = arena };

    const scheduler = &self._worker_scope.js.scheduler;

    try scheduler.add(callback, DeferBlobScriptCallback.run, 0, .{
        .name = "Worker.deferBlobScript",
        .low_priority = false,
        .finalizer = DeferBlobScriptCallback.cancelled,
    });
}

const DeferFetchedScriptCallback = struct {
    worker: *Worker,
    script: []const u8,
    arena: Allocator,

    fn cancelled(ctx: *anyopaque) void {
        const self: *DeferFetchedScriptCallback = @ptrCast(@alignCast(ctx));
        self.worker._frame.releaseArena(self.arena);
    }

    fn run(ctx: *anyopaque) !?u32 {
        const self: *DeferFetchedScriptCallback = @ptrCast(@alignCast(ctx));
        defer self.worker._frame.releaseArena(self.arena);
        if (self.worker._terminated) return null;
        try self.worker.loadInitialScript(self.script);
        return null;
    }
};

const DeferBlobScriptCallback = struct {
    worker: *Worker,
    script: []const u8,
    arena: Allocator,

    fn cancelled(ctx: *anyopaque) void {
        const self: *DeferBlobScriptCallback = @ptrCast(@alignCast(ctx));
        self.worker._frame.releaseArena(self.arena);
    }

    fn run(ctx: *anyopaque) !?u32 {
        const self: *DeferBlobScriptCallback = @ptrCast(@alignCast(ctx));
        defer self.worker._frame.releaseArena(self.arena);
        if (self.worker._terminated) return null;
        self.worker._script_loaded = true;
        try self.worker.loadInitialScript(self.script);
        return null;
    }
};

const DeferFlushCallback = struct {
    worker: *Worker,
    arena: Allocator,

    fn cancelled(ctx: *anyopaque) void {
        const self: *DeferFlushCallback = @ptrCast(@alignCast(ctx));
        self.worker._frame.releaseArena(self.arena);
    }

    fn run(ctx: *anyopaque) !?u32 {
        const self: *DeferFlushCallback = @ptrCast(@alignCast(ctx));
        defer self.worker._frame.releaseArena(self.arena);
        if (self.worker._terminated) return null;

        try self.worker.flushPendingInboundMessages();
        try self.worker.flushPendingUndelivered();
        pumpMessageDelivery(self.worker._frame);
        // Bootstrap handshake (importScripts + MessageChannel setup) is done.
        self.worker._bootstrap_complete = false;
        self.worker._parent_delivery_ready = true;
        return null;
    }
};

fn httpErrorCallback(ctx: *anyopaque, err: anyerror) void {
    const self: *Worker = @ptrCast(@alignCast(ctx));
    if (self._terminated) return;
    self._http_response = null;

    log.err(.browser, "worker fetch error", .{
        .url = self._worker_scope.url,
        .err = err,
    });

    const message = self._arena.dupe(u8, @errorName(err)) catch {
        self.fireErrorEventFromFrame(@errorName(err), null);
        return;
    };
    self.scheduleDeferredWorkerError(message) catch {
        self.fireErrorEventFromFrame(message, null);
    };
}

fn scheduleDeferredWorkerError(self: *Worker, message: []const u8) !void {
    const frame = self._frame;
    const arena = try frame.getArena(.tiny, "Worker.deferError");
    errdefer frame.releaseArena(arena);

    const msg_copy = try arena.dupe(u8, message);

    const callback = try arena.create(DeferErrorCallback);
    callback.* = .{ .worker = self, .message = msg_copy, .arena = arena };

    try frame.js.scheduler.add(callback, DeferErrorCallback.run, 0, .{
        .name = "Worker.deferError",
        .low_priority = false,
        .finalizer = DeferErrorCallback.cancelled,
    });
}

const DeferErrorCallback = struct {
    worker: *Worker,
    message: []const u8,
    arena: Allocator,

    fn cancelled(ctx: *anyopaque) void {
        const self: *DeferErrorCallback = @ptrCast(@alignCast(ctx));
        self.worker._frame.releaseArena(self.arena);
    }

    fn run(ctx: *anyopaque) !?u32 {
        const self: *DeferErrorCallback = @ptrCast(@alignCast(ctx));
        defer self.worker._frame.releaseArena(self.arena);
        if (self.worker._terminated) return null;
        self.worker.fireLoadErrorEventFromFrame(self.message);
        return null;
    }
};

// Fire a load/parse error on the page Worker (plain Event, not ErrorEvent).
fn fireLoadErrorEventFromFrame(self: *Worker, message: []const u8) void {
    if (self._shared_mode) {
        if (self._shared_script_error_cb) |cb| cb(self, message);
        return;
    }
    var ls: js.Local.Scope = undefined;
    self._frame.js.localScope(&ls);
    defer ls.deinit();

    self._dispatchLoadErrorEvent(message) catch |err| {
        log.warn(.browser, "worker fire load error", .{ .err = err, .message = message });
    };
}

fn fireRuntimeErrorEventFromFrame(
    self: *Worker,
    message: []const u8,
    filename: []const u8,
    line: u32,
    col: u32,
    error_value: ?js.Value.Temp,
) void {
    if (self._shared_mode) {
        if (error_value) |ev| ev.release();
        if (self._shared_script_error_cb) |cb| cb(self, message);
        return;
    }
    var ls: js.Local.Scope = undefined;
    self._frame.js.localScope(&ls);
    defer ls.deinit();

    self._dispatchRuntimeErrorEvent(message, filename, line, col, error_value) catch |err| {
        if (error_value) |ev| ev.release();
        log.warn(.browser, "worker fire runtime error", .{ .err = err, .message = message });
    };
}

fn fireErrorEventFromFrame(self: *Worker, message: []const u8, error_value: ?js.Value.Temp) void {
    if (error_value) |ev| ev.release();
    self.fireLoadErrorEventFromFrame(message);
}

fn queuePendingPageError(
    self: *Worker,
    kind: @TypeOf(self._pending_page_error),
    message: []const u8,
    filename: []const u8,
    line: u32,
    col: u32,
) void {
    self._pending_page_error = kind;
    self._pending_error_message = self._arena.dupe(u8, message) catch {
        self._pending_error_message = message;
        return;
    };
    self._pending_error_filename = self._arena.dupe(u8, filename) catch {
        self._pending_error_filename = filename;
        return;
    };
    self._pending_error_line = line;
    self._pending_error_col = col;
    self.scheduleDeferredPendingError() catch |err| {
        log.warn(.browser, "Worker.scheduleDeferredPendingError", .{ .err = err });
    };
}

fn tryFlushPendingPageError(self: *Worker) void {
    const kind = self._pending_page_error;
    if (kind == .none) return;
    const message = self._pending_error_message orelse return;
    const filename = self._pending_error_filename orelse "";
    const line = self._pending_error_line;
    const col = self._pending_error_col;

    const frame = self._frame;
    const target = self.asEventTarget();
    if (!frame._event_manager.hasDirectListeners(target, "error", self._on_error)) return;

    self._pending_page_error = .none;
    self._pending_error_message = null;
    self._pending_error_filename = null;

    switch (kind) {
        .load => self.fireLoadErrorEventFromFrame(message),
        .runtime => self.fireRuntimeErrorEventFromFrame(message, filename, line, col, null),
        .none => {},
    }
}

fn scheduleDeferredPendingError(self: *Worker) !void {
    const frame = self._frame;
    const arena = try frame.getArena(.tiny, "Worker.deferPendingError");
    errdefer frame.releaseArena(arena);

    const callback = try arena.create(DeferPendingErrorCallback);
    callback.* = .{ .worker = self, .arena = arena };

    try frame.js.scheduler.add(callback, DeferPendingErrorCallback.run, 0, .{
        .name = "Worker.deferPendingError",
        .low_priority = false,
        .finalizer = DeferPendingErrorCallback.cancelled,
    });
}

const DeferPendingErrorCallback = struct {
    worker: *Worker,
    arena: Allocator,

    fn cancelled(ctx: *anyopaque) void {
        const self: *DeferPendingErrorCallback = @ptrCast(@alignCast(ctx));
        self.worker._frame.releaseArena(self.arena);
    }

    fn run(ctx: *anyopaque) !?u32 {
        const self: *DeferPendingErrorCallback = @ptrCast(@alignCast(ctx));
        defer self.worker._frame.releaseArena(self.arena);
        tryFlushPendingPageError(self.worker);
        return null;
    }
};

fn _dispatchLoadErrorEvent(self: *Worker, message: []const u8) !void {
    const frame = self._frame;
    const target = self.asEventTarget();
    const on_error = self._on_error;

    if (!frame._event_manager.hasDirectListeners(target, "error", on_error)) {
        queuePendingPageError(self, .load, message, "", 0, 0);
        return;
    }

    // WPT check-error-arguments.js expects args[0].constructor === Event (not ErrorEvent).
    const error_event = try Event.initTrusted(comptime .wrap("error"), .{
        .bubbles = false,
        .cancelable = true,
    }, frame._page);

    try frame._event_manager.dispatchDirect(target, error_event, on_error, .{
        .context = "Worker.onerror",
    });
}

fn _dispatchRuntimeErrorEvent(
    self: *Worker,
    message: []const u8,
    filename: []const u8,
    line: u32,
    col: u32,
    error_value: ?js.Value.Temp,
) !void {
    const frame = self._frame;
    const target = self.asEventTarget();
    const on_error = self._on_error;

    if (!frame._event_manager.hasDirectListeners(target, "error", on_error)) {
        if (error_value) |ev| ev.release();
        queuePendingPageError(self, .runtime, message, filename, line, col);
        return;
    }

    const error_event = try ErrorEvent.initTrusted(comptime .wrap("error"), .{
        .@"error" = error_value,
        .message = message,
        .filename = filename,
        .lineno = line,
        .colno = col,
        .bubbles = false,
        .cancelable = true,
    }, frame._page);

    try frame._event_manager.dispatchDirect(target, error_event.asEvent(), on_error, .{
        .context = "Worker.onerror",
    });
}

pub fn terminate(self: *Worker) void {
    self.destroy();
}

// Posts a message from the frame to the worker.
pub fn postMessage(self: *Worker, data: js.Value, transfer_arg: ?js.Value) !void {
    const message_id = self._debug_nextMessageId();
    if (comptime IS_DEBUG) {
        log.info(.browser, "worker postMessage to worker", .{
            .worker_id = self._frame_id,
            .message_id = message_id,
        });
    }

    const transfer_list = try MessagePort.parseTransferArg(data.local, transfer_arg);
    const transferred_ports = try MessagePort.processTransferList(
        transfer_list,
        &self._frame.js.execution,
        &self._worker_scope.js.execution,
        self._arena,
    );

    try self._worker_scope.receiveMessage(data, message_id, transferred_ports, transfer_list);
    pumpMessageDelivery(self._frame);
}

/// True while a dedicated worker is still in its initial bootstrap eval
/// (including nested importScripts). reCAPTCHA expects synchronous
/// worker↔page MessageChannel round-trips during this window.
pub fn bootstrapMessagingActive(exec: *const Execution) bool {
    return switch (exec.context.global) {
        .worker => |wgs| wgs._worker._bootstrap_complete,
        .frame => |frame| blk: {
            for (frame.workers.items) |worker| {
                if (worker._bootstrap_complete) break :blk true;
            }
            break :blk false;
        },
    };
}

/// Pump worker↔page scheduler queues via `runOne()` (safe on the V8 central stack
/// only — not nested inside Script.eval / DOM API / HTTP doneCallback).
pub fn pumpMessageDelivery(frame: *Frame) void {
    const env = &frame._session.browser.env;
    // Nested host stack (V8 / script eval / transfer) is unsafe for runOne pumps.
    if (js.JsEntryGate.mustQueueAsTask(&frame.js.execution)) return;
    var pass: u32 = 0;
    while (pass < bootstrap_drain_max_passes) : (pass += 1) {
        var any_ready = false;
        if (frame.js.scheduler.hasReadyTasks()) {
            any_ready = true;
            pumpBootstrapContext(frame.js, env);
        }
        for (frame.workers.items) |worker| {
            if (worker._terminated) continue;
            if (!worker._worker_scope.js.scheduler.hasReadyTasks()) continue;
            any_ready = true;
            pumpBootstrapContext(worker._worker_scope.js, env);
        }
        if (!any_ready) break;
    }
}

pub fn pumpBootstrapMessaging(exec: *const Execution) void {
    if (!bootstrapMessagingActive(exec)) return;
    const env = exec.context.env;
    switch (exec.context.global) {
        .worker => |wgs| {
            pumpBootstrapContext(wgs.js, env);
            pumpBootstrapContext(wgs._worker._frame.js, env);
        },
        .frame => |frame| {
            pumpMessageDelivery(frame);
        },
    }
}

fn dispatchInboundTempNow(
    self: *Worker,
    cloned_data: js.Value.Temp,
    message_id: u64,
    ports: []const *MessagePort,
) !bool {
    _ = message_id;
    if (self._terminated) return false;
    const frame = self._frame;
    const exec = &frame.js.execution;
    if (exec.realmState() == .dead) return false;

    const target = self.asEventTarget();
    const on_message = self._on_message;
    if (!frame._event_manager.hasDirectListeners(target, "message", on_message)) {
        return false;
    }

    var ls: js.Local.Scope = undefined;
    frame.js.localScope(&ls);
    defer ls.deinit();

    const event = (try MessageEvent.initTrusted(comptime .wrap("message"), .{
        .data = .{ .value = cloned_data },
        .ports = ports,
        .bubbles = false,
        .cancelable = false,
    }, frame._page)).asEvent();

    try frame._event_manager.dispatchDirect(target, event, on_message, .{ .context = "Worker.receiveMessage" });
    pumpMessageDelivery(frame);
    return true;
}

fn dispatchInboundMessageNow(
    self: *Worker,
    data: js.Value,
    message_id: u64,
    ports: []const *MessagePort,
    transfer_list: ?[]const js.Value,
) !bool {
    const cloned_data = try self.cloneMessageToFrameWithTransfer(data, transfer_list);
    return self.dispatchInboundTempNow(cloned_data, message_id, ports);
}

// Called internally by WorkerGlobalScope when it wants to post a message to us
pub fn receiveMessage(
    self: *Worker,
    data: js.Value,
    message_id: u64,
    ports: []const *MessagePort,
    transfer_list: ?[]const js.Value,
) !void {
    // Mid-initial-eval: never enter parent Local to clone — queue worker-side
    // Temp and clone on flush after Script::Run returns.
    if (self._initial_eval_active) {
        const ports_copy = try self._arena.dupe(*MessagePort, ports);
        const worker_temp = try data.temp();
        try self._pending_inbound_messages.append(self._arena, .{
            .message_id = message_id,
            .data = worker_temp,
            .ports = ports_copy,
            .needs_frame_clone = true,
        });
        log.info(.browser, "worker postMessage mid-initial-eval", .{
            .worker_id = self._frame_id,
            .message_id = message_id,
            .queue_len = self._pending_inbound_messages.items.len,
        });
        return;
    }

    if (try self.dispatchInboundMessageNow(data, message_id, ports, transfer_list)) return;

    if (!self._bootstrap_complete and !self._parent_delivery_ready) {
        const cloned_data = try self.cloneMessageToFrameWithTransfer(data, transfer_list);
        const ports_copy = try self._arena.dupe(*MessagePort, ports);

        try self._pending_inbound_messages.append(self._arena, .{
            .message_id = message_id,
            .data = cloned_data,
            .ports = ports_copy,
        });

        if (comptime IS_DEBUG) {
            log.info(.browser, "worker defer inbound message", .{
                .worker_id = self._frame_id,
                .message_id = message_id,
                .queue_len = self._pending_inbound_messages.items.len,
            });
        }
        return;
    }

    try self.enqueueInboundMessage(data, message_id, ports, transfer_list);
}

pub fn getOnMessage(self: *const Worker) ?js.Function.Global {
    return self._on_message;
}

pub fn setOnMessage(self: *Worker, setter: ?FunctionSetter) void {
    self._on_message = getFunctionFromSetter(setter);
    self.flushPendingUndelivered() catch |err| {
        log.warn(.browser, "Worker.flushPendingUndelivered", .{ .err = err });
    };
    self.scheduleDeferredFlushUndelivered() catch |err| {
        log.warn(.browser, "Worker.scheduleDeferredFlushUndelivered", .{ .err = err });
    };
}

pub fn scheduleDeferredFlushUndelivered(self: *Worker) !void {
    const frame = self._frame;
    const arena = try frame.getArena(.tiny, "Worker.deferFlushUndelivered");
    errdefer frame.releaseArena(arena);

    const callback = try arena.create(DeferFlushUndeliveredCallback);
    callback.* = .{ .worker = self, .arena = arena };

    try frame.js.scheduler.add(callback, DeferFlushUndeliveredCallback.run, 0, .{
        .name = "Worker.deferFlushUndelivered",
        .low_priority = false,
        .finalizer = DeferFlushUndeliveredCallback.cancelled,
    });
}

const DeferFlushUndeliveredCallback = struct {
    worker: *Worker,
    arena: Allocator,

    fn cancelled(ctx: *anyopaque) void {
        const self: *DeferFlushUndeliveredCallback = @ptrCast(@alignCast(ctx));
        self.worker._frame.releaseArena(self.arena);
    }

    fn run(ctx: *anyopaque) !?u32 {
        const self: *DeferFlushUndeliveredCallback = @ptrCast(@alignCast(ctx));
        defer self.worker._frame.releaseArena(self.arena);
        if (self.worker._terminated) return null;
        try self.worker.flushPendingUndelivered();
        return null;
    }
};

pub fn flushPendingUndelivered(self: *Worker) !void {
    const frame = self._frame;
    const target = self.asEventTarget();

    while (self._pending_undelivered.items.len > 0) {
        if (!frame._event_manager.hasDirectListeners(target, "message", self._on_message)) {
            break;
        }
        const pending = self._pending_undelivered.orderedRemove(0);
        if (try self.dispatchInboundTempNow(pending.data, pending.message_id, pending.ports)) {
            continue;
        }
        try self.enqueueInboundTempMessage(pending.data, pending.message_id, pending.ports);
    }
    pumpMessageDelivery(frame);
}

pub fn getOnMessageError(self: *const Worker) ?js.Function.Global {
    return self._on_messageerror;
}

pub fn setOnMessageError(self: *Worker, setter: ?FunctionSetter) void {
    self._on_messageerror = getFunctionFromSetter(setter);
}

pub fn getOnError(self: *const Worker) ?js.Function.Global {
    return self._on_error;
}

pub fn setOnError(self: *Worker, setter: ?FunctionSetter) void {
    self._on_error = getFunctionFromSetter(setter);
    tryFlushPendingPageError(self);
}

const FunctionSetter = union(enum) {
    func: js.Function.Global,
    anything: js.Value,
};

fn getFunctionFromSetter(setter_: ?FunctionSetter) ?js.Function.Global {
    const setter = setter_ orelse return null;
    return switch (setter) {
        .func => |func| func,
        .anything => null,
    };
}

fn _debug_nextMessageId(self: *Worker) u64 {
    const id = self._debug_next_message_id;
    self._debug_next_message_id += 1;
    return id;
}

fn _debug_schedulerQueueLen(_: *Worker, scheduler: anytype) usize {
    _ = scheduler;
    return 0;
}

fn enqueueInboundTempMessage(self: *Worker, cloned_data: js.Value.Temp, message_id: u64, ports: []const *MessagePort) !void {
    const frame = self._frame;
    const message_arena = try frame.getArena(.tiny, "Worker.receiveMessage");
    errdefer frame.releaseArena(message_arena);

    const ports_copy = try message_arena.dupe(*MessagePort, ports);

    const callback = try message_arena.create(ReceiveMessageCallback);
    callback.* = .{
        .worker = self,
        .data = cloned_data,
        .ports = ports_copy,
        .arena = message_arena,
        .message_id = message_id,
    };

    const queue_len = self._debug_schedulerQueueLen(self._worker_scope.js.scheduler);
    if (comptime IS_DEBUG) {
        log.info(.browser, "worker enqueue inbound message", .{
            .worker_id = self._frame_id,
            .message_id = message_id,
            .queue_len = queue_len,
        });
    }

    // Worker→page messages must run on the parent frame scheduler so the
    // Worker object's message handlers execute in the document realm.
    try self._frame.js.scheduler.add(callback, ReceiveMessageCallback.run, 0, .{
        .name = "Worker.receiveMessage",
        .low_priority = false,
        .finalizer = ReceiveMessageCallback.cancelled,
    });
    pumpMessageDelivery(frame);
}

fn cloneMessageToFrame(self: *Worker, data: js.Value) !js.Value.Temp {
    // Worker->page messages must deserialize into the parent frame's realm so
    // `data instanceof Array` and other intrinsics match the main document.
    var source_ls: js.Local.Scope = undefined;
    self._worker_scope.js.localScope(&source_ls);
    defer source_ls.deinit();
    var target_ls: js.Local.Scope = undefined;
    self._frame.js.localScope(&target_ls);
    defer target_ls.deinit();

    const cloned = try data.structuredCloneTo(&target_ls.local, null);
    return try cloned.temp();
}

fn cloneMessageToFrameWithTransfer(self: *Worker, data: js.Value, transfer_list: ?[]const js.Value) !js.Value.Temp {
    var source_ls: js.Local.Scope = undefined;
    self._worker_scope.js.localScope(&source_ls);
    defer source_ls.deinit();
    var target_ls: js.Local.Scope = undefined;
    self._frame.js.localScope(&target_ls);
    defer target_ls.deinit();

    const cloned = try data.structuredCloneTo(&target_ls.local, transfer_list);
    return try cloned.temp();
}

fn enqueueInboundMessage(self: *Worker, data: js.Value, message_id: u64, ports: []const *MessagePort, transfer_list: ?[]const js.Value) !void {
    const cloned_data = try self.cloneMessageToFrameWithTransfer(data, transfer_list);
    try self.enqueueInboundTempMessage(cloned_data, message_id, ports);
}

fn cloneWorkerTempToFrame(self: *Worker, worker_temp: js.Value.Temp) !js.Value.Temp {
    var source_ls: js.Local.Scope = undefined;
    self._worker_scope.js.localScope(&source_ls);
    defer source_ls.deinit();
    var target_ls: js.Local.Scope = undefined;
    self._frame.js.localScope(&target_ls);
    defer target_ls.deinit();

    const local_val = source_ls.local.toLocal(worker_temp);
    defer worker_temp.release();
    const cloned = try local_val.structuredCloneTo(&target_ls.local, null);
    return try cloned.temp();
}

fn flushPendingInboundMessages(self: *Worker) !void {
    for (self._pending_inbound_messages.items) |pending| {
        if (comptime IS_DEBUG) {
            log.info(.browser, "worker flush inbound message", .{
                .worker_id = self._frame_id,
                .message_id = pending.message_id,
                .queue_len = self._pending_inbound_messages.items.len,
                .needs_frame_clone = pending.needs_frame_clone,
            });
        }
        const frame_data = if (pending.needs_frame_clone)
            try self.cloneWorkerTempToFrame(pending.data)
        else
            pending.data;
        try self.enqueueInboundTempMessage(frame_data, pending.message_id, pending.ports);
    }
    self._pending_inbound_messages.clearRetainingCapacity();
}

fn releasePendingInboundMessages(self: *Worker) void {
    for (self._pending_inbound_messages.items) |pending| {
        pending.data.release();
    }
    self._pending_inbound_messages.deinit(self._arena);
    self._pending_inbound_messages = .{};
    for (self._pending_undelivered.items) |pending| {
        pending.data.release();
    }
    self._pending_undelivered.deinit(self._arena);
    self._pending_undelivered = .{};
}

const PendingInboundMessage = struct {
    message_id: u64,
    data: js.Value.Temp,
    ports: []const *MessagePort,
    /// True when `data` is still a worker-realm Temp that must be structured-cloned
    /// into the parent frame before dispatch (queued mid-initial-eval).
    needs_frame_clone: bool = false,
};

const ReceiveMessageCallback = struct {
    data: anyerror!js.Value.Temp,
    ports: []const *MessagePort,
    arena: Allocator,
    worker: *Worker,
    message_id: u64,

    fn cancelled(ctx: *anyopaque) void {
        const self: *ReceiveMessageCallback = @ptrCast(@alignCast(ctx));
        if (self.data) |d| {
            d.release();
        } else |_| {}
        self.deinit();
    }

    fn deinit(self: *ReceiveMessageCallback) void {
        self.worker._frame._session.releaseArena(self.arena);
    }

    fn run(ctx: *anyopaque) !?u32 {
        const self: *ReceiveMessageCallback = @ptrCast(@alignCast(ctx));
        defer self.deinit();

        const worker = self.worker;
        if (worker._terminated) return null;
        const frame = worker._frame;
        const target = worker.asEventTarget();

        if (comptime IS_DEBUG) {
            log.info(.browser, "worker dispatch parent message", .{
                .worker_id = worker._frame_id,
                .message_id = self.message_id,
                .queue_len = worker._debug_schedulerQueueLen(frame.js.scheduler),
            });
        }

        // If data is null, structured clone failed - fire messageerror
        const data = self.data catch |err| {
            const on_messageerror = worker._on_messageerror;
            if (!frame._event_manager.hasDirectListeners(target, "messageerror", on_messageerror)) {
                return null;
            }
            const event = (try MessageEvent.initTrusted(comptime .wrap("messageerror"), .{
                .data = .{ .string = @errorName(err) },
                .bubbles = false,
                .cancelable = false,
            }, frame._page)).asEvent();
            try frame._event_manager.dispatchDirect(target, event, on_messageerror, .{ .context = "Worker.messageerror" });
            return null;
        };

        if (try worker.dispatchInboundTempNow(data, self.message_id, self.ports)) {
            return null;
        }

        // Queue until onmessage / addEventListener is registered (reCAPTCHA worker setup).
        const ports_copy = try worker._arena.dupe(*MessagePort, self.ports);
        try worker._pending_undelivered.append(worker._arena, .{
            .message_id = self.message_id,
            .data = data,
            .ports = ports_copy,
        });
        return null;
    }
};

pub const JsApi = struct {
    pub const bridge = js.Bridge(Worker);

    pub const Meta = struct {
        pub const name = "Worker";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };

    pub const constructor = bridge.constructor(Worker.init, .{ .dom_exception = true });

    pub const terminate = bridge.function(Worker.terminate, .{});
    pub const postMessage = bridge.function(Worker.postMessage, .{});

    pub const onmessage = bridge.accessor(Worker.getOnMessage, Worker.setOnMessage, .{});
    pub const onmessageerror = bridge.accessor(Worker.getOnMessageError, Worker.setOnMessageError, .{});
    pub const onerror = bridge.accessor(Worker.getOnError, Worker.setOnError, .{});
};

const testing = @import("../../testing/testing.zig");
test "WebApi: Worker" {
    try testing.htmlRunner("worker", .{});
}
