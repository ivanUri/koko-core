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

// The struct is like a mix of Page and Window, but a very limited Page and
// a very limited Window. This dual-purpose does make it a bit harder to know
// what's what...e.g what is a WebAPI call and what it called internally.

const std = @import("std");

const JS = @import("../js/js.zig");
const URL = @import("../browser/URL.zig");
const Frame = @import("../browser/Frame.zig");
const Page = @import("../browser/Page.zig");
const Factory = @import("../browser/Factory.zig");
const Session = @import("../browser/Session.zig");
const HttpClient = @import("../browser/HttpClient.zig");
const EventManagerBase = @import("../browser/EventManagerBase.zig");
const ScriptManagerBase = @import("../browser/ScriptManagerBase.zig");

const Blob = @import("Blob.zig");
const Event = @import("Event.zig");
const Worker = @import("Worker.zig");
const Crypto = @import("Crypto.zig");
const Console = @import("Console.zig");
const Timers = @import("Timers.zig");
const EventTarget = @import("EventTarget.zig");
const MessageEvent = @import("event/MessageEvent.zig");
const ErrorEvent = @import("event/ErrorEvent.zig");
const Fetch = @import("net/Fetch.zig");
const Performance = @import("Performance.zig");
const WorkerNavigator = @import("WorkerNavigator.zig");
const WorkerLocation = @import("WorkerLocation.zig");

const builtin = @import("builtin");
const IS_DEBUG = builtin.mode == .Debug;

const log = @import("../../support/log.zig");
const RealmLifecycleKernel = @import("../../runtime/RealmLifecycleKernel.zig");
const Allocator = std.mem.Allocator;

const MessagePort = @import("MessagePort.zig");

const WorkerGlobalScope = @This();

// Meant to follow the same field naming as Page so that an anytype of generic
// can access these the same for a Page of a WGS.
// These fields represent the "Page"-like component of the WGS
_page: *Page,
_session: *Session,
_factory: *Factory,
_identity: JS.Identity = .{},
arena: Allocator,
call_arena: Allocator,
url: [:0]const u8,
// Same-origin constraint: a worker's origin is inherited from its parent frame.
origin: ?[]const u8 = null,
buf: [1024]u8 = undefined, // same size as frame.buf
// Document charset (matches Page.charset). Workers default to UTF-8.
charset: []const u8 = "UTF-8",
js: *JS.Context,

// Blob URL registry for URL.createObjectURL/revokeObjectURL.
_blob_urls: std.StringHashMapUnmanaged(*Blob) = .{},

// Reference back to the Worker object (for postMessage to frame)
_worker: *Worker,

// HTTP attribution. Mirrors Frame's fields so that generic code over
// (Frame|WorkerGlobalScope) can read them uniformly. Populated from the
// owning Worker at init.
_frame_id: u32,
_loader_id: u32,

_realm_epoch: RealmLifecycleKernel.Epoch = 0,
_realm_state: RealmLifecycleKernel.State = .active,

// Event management for non-DOM targets in worker context
_event_manager: EventManagerBase,

// Handles module imports (static + dynamic). No parser integration since
// workers don't have <script> tags.
_script_manager: ScriptManagerBase,

// These fields represent the "Window"-like component of the WGS
_closed: bool = false,
_proto: *EventTarget,
_console: Console = .init,
_crypto: Crypto = .init,
_navigator: WorkerNavigator = .init,
_location: *WorkerLocation,
_performance: Performance,
_on_error: ?JS.Function.Global = null,
_on_rejection_handled: ?JS.Function.Global = null,
_on_unhandled_rejection: ?JS.Function.Global = null,
_on_message: ?JS.Function.Global = null,
_on_messageerror: ?JS.Function.Global = null,
_debug_next_message_id: u64 = 1,

_timers: Timers = .{},

pub fn init(worker: *Worker, url: [:0]const u8) !*WorkerGlobalScope {
    const arena = worker._arena;
    const parent = worker._frame;
    const session = worker._frame._session;

    const call_arena = try session.getArena(.small, "WorkerGlobalScope.call_arena");
    errdefer session.releaseArena(call_arena);

    const factory = parent._factory;
    const self = try factory.eventTargetWithAllocator(arena, WorkerGlobalScope{
        .url = url,
        .arena = arena,
        .origin = parent.origin,
        .js = undefined,
        .call_arena = call_arena,
        ._session = session,
        ._page = parent._page,
        ._identity = .{},
        ._proto = undefined,
        ._factory = factory,
        ._worker = worker,
        ._frame_id = worker._frame_id,
        ._loader_id = worker._loader_id,
        ._performance = Performance.init(),
        ._event_manager = .init(arena),
        ._script_manager = undefined,
        ._location = try WorkerLocation.init(url, &parent.js.execution, factory),
    });
    errdefer factory.destroy(self);

    self._script_manager = ScriptManagerBase.init(
        arena,
        &session.browser.http_client,
        .{ .worker = self },
    );

    self.js = try session.browser.env.createWorkerContext(self, .{
        .call_arena = call_arena,
        .identity_arena = arena,
        .identity = &self._identity,
    });

    return self;
}

pub fn realmEpoch(self: *const WorkerGlobalScope) RealmLifecycleKernel.Epoch {
    return self._realm_epoch;
}

pub fn realmSchedulingActive(self: *const WorkerGlobalScope) bool {
    return self._realm_state == .active;
}

pub fn realmState(self: *const WorkerGlobalScope) RealmLifecycleKernel.State {
    return self._realm_state;
}

fn enterRealmDraining(self: *WorkerGlobalScope) void {
    if (self._realm_state == .active) {
        self._realm_state = .draining;
        RealmLifecycleKernel.trace(.realm_draining, self._frame_id, null, null);
    }
}

fn enterRealmDead(self: *WorkerGlobalScope) void {
    if (self._realm_state != .dead) {
        self._realm_state = .dead;
        RealmLifecycleKernel.trace(.realm_dead, self._frame_id, self.realmEpoch(), null);
    }
}

pub fn deinit(self: *WorkerGlobalScope) void {
    self.enterRealmDraining();
    self._identity.deinit();
    self._script_manager.deinit();

    const page = self._page;
    var it = self._blob_urls.valueIterator();
    while (it.next()) |blob| {
        blob.*.releaseRef(page);
    }
    self.enterRealmDead();
    page.session.browser.env.destroyContext(self.js);
    page.releaseArena(self.call_arena);
}

pub fn base(self: *const WorkerGlobalScope) [:0]const u8 {
    return self.url;
}

pub fn asEventTarget(self: *WorkerGlobalScope) *EventTarget {
    return self._proto;
}

// Dispatch an event to listeners on the given target within this worker context.
pub fn dispatch(
    self: *WorkerGlobalScope,
    target: *EventTarget,
    event: *Event,
    handler: anytype,
    comptime opts: EventManagerBase.DispatchDirectOptions,
) !void {
    try self._event_manager.dispatchDirect(
        self.call_arena,
        self.js,
        target,
        event,
        handler,
        self._page,
        opts,
    );
}

pub fn hasDirectListeners(self: *WorkerGlobalScope, target: *EventTarget, typ: []const u8, handler: anytype) bool {
    return self._event_manager.hasDirectListeners(target, typ, handler);
}

// Workers don't have their own Referer; per spec, dedicated worker requests
// use the parent document's URL. Delegate to the owning frame.
pub fn headersForRequest(self: *WorkerGlobalScope, headers: *HttpClient.Headers, opts: Frame.HeadersForRequestOpts) !void {
    return self._worker._frame.headersForRequest(headers, opts);
}

pub fn isSameOrigin(self: *const WorkerGlobalScope, url: [:0]const u8) bool {
    const current_origin = self.origin orelse return false;

    if (!std.mem.startsWith(u8, url, current_origin)) {
        return false;
    }
    return std.mem.eql(u8, URL.getHost(url), URL.getHost(current_origin));
}

pub fn lookupBlobUrl(self: *WorkerGlobalScope, url: []const u8) ?*Blob {
    return self._blob_urls.get(url);
}

pub fn getSelf(self: *WorkerGlobalScope) *WorkerGlobalScope {
    return self;
}

pub fn getConsole(self: *WorkerGlobalScope) *Console {
    return &self._console;
}

pub fn getCrypto(self: *WorkerGlobalScope) *Crypto {
    return &self._crypto;
}

pub fn getPerformance(self: *WorkerGlobalScope) *Performance {
    return &self._performance;
}

pub fn getNavigator(self: *WorkerGlobalScope) *WorkerNavigator {
    return &self._navigator;
}

pub fn getLocation(self: *WorkerGlobalScope) *WorkerLocation {
    return self._location;
}

pub fn getOnError(self: *const WorkerGlobalScope) ?JS.Function.Global {
    return self._on_error;
}

pub fn setOnError(self: *WorkerGlobalScope, setter: ?FunctionSetter) void {
    self._on_error = getFunctionFromSetter(setter);
}

pub fn getOnRejectionHandled(self: *const WorkerGlobalScope) ?JS.Function.Global {
    return self._on_rejection_handled;
}

pub fn setOnRejectionHandled(self: *WorkerGlobalScope, setter: ?FunctionSetter) void {
    self._on_rejection_handled = getFunctionFromSetter(setter);
}

pub fn getOnUnhandledRejection(self: *const WorkerGlobalScope) ?JS.Function.Global {
    return self._on_unhandled_rejection;
}

pub fn setOnUnhandledRejection(self: *WorkerGlobalScope, setter: ?FunctionSetter) void {
    self._on_unhandled_rejection = getFunctionFromSetter(setter);
}

pub fn getOnMessage(self: *const WorkerGlobalScope) ?JS.Function.Global {
    return self._on_message;
}

pub fn setOnMessage(self: *WorkerGlobalScope, setter: ?FunctionSetter) void {
    self._on_message = getFunctionFromSetter(setter);
}

pub fn getOnMessageError(self: *const WorkerGlobalScope) ?JS.Function.Global {
    return self._on_messageerror;
}

pub fn setOnMessageError(self: *WorkerGlobalScope, setter: ?FunctionSetter) void {
    self._on_messageerror = getFunctionFromSetter(setter);
}

// Posts a message from the worker back to the frame.
// The message is cloned via structured clone and dispatched on the Worker object.
pub fn postMessage(self: *WorkerGlobalScope, data: JS.Value, transfer: ?[]JS.Value) !void {
    const message_id = self._debug_nextMessageId();
    if (comptime IS_DEBUG) {
        log.info(.browser, "worker postMessage to page", .{
            .worker_id = self._frame_id,
            .message_id = message_id,
        });
    }

    const frame = self._worker._frame;
    const transferred_ports = if (transfer) |list|
        try MessagePort.processTransferList(list, &self.js.execution, &frame.js.execution, self.arena)
    else
        &[_]*MessagePort{};

    try self._worker.receiveMessage(data, message_id, transferred_ports);
    // Ensure the parent frame can dispatch the queued Worker message event.
    self._worker._frame._session.browser.runMacrotasks() catch |err| {
        log.warn(.browser, "worker postMessage pump", .{ .err = err });
    };
}

// Called internally by Worker when it wants to post a message to us
pub fn receiveMessage(self: *WorkerGlobalScope, data: JS.Value, message_id: u64, ports: []const *MessagePort) !void {
    if (self._closed) {
        return;
    }

    const cloned_data: ?JS.Value.Temp = blk: {
        var source_ls: JS.Local.Scope = undefined;
        self._worker._frame.js.localScope(&source_ls);
        defer source_ls.deinit();
        var target_ls: JS.Local.Scope = undefined;
        self.js.localScope(&target_ls);
        defer target_ls.deinit();

        const cloned = data.structuredCloneTo(&target_ls.local) catch break :blk null;
        break :blk cloned.temp() catch break :blk null;
    };

    const session = self._session;

    const message_arena = try session.getArena(.tiny, "WorkerGlobalScope.receiveMessage");
    errdefer session.releaseArena(message_arena);

    const ports_copy = try message_arena.dupe(*MessagePort, ports);

    const callback = try message_arena.create(ReceiveMessageCallback);
    callback.* = .{
        .data = cloned_data,
        .ports = ports_copy,
        .worker_scope = self,
        .arena = message_arena,
        .message_id = message_id,
    };

    const queue_len = self._debug_schedulerQueueLen(self.js.scheduler);
    if (comptime IS_DEBUG) {
        log.info(.browser, "worker enqueue inbound message", .{
            .worker_id = self._frame_id,
            .message_id = message_id,
            .queue_len = queue_len,
        });
    }

    try self.js.scheduler.add(callback, ReceiveMessageCallback.run, 0, .{
        .name = "WorkerGlobalScope.receiveMessage",
        .low_priority = false,
        .finalizer = ReceiveMessageCallback.cancelled,
    });
}

pub fn btoa(_: *const WorkerGlobalScope, input: JS.String.OneByte, exec: *JS.Execution) ![]const u8 {
    return @import("encoding/base64.zig").encode(exec.call_arena, input.bytes);
}

pub fn atob(_: *const WorkerGlobalScope, input: JS.String.OneByte, exec: *JS.Execution) !JS.String.OneByte {
    const bytes = try @import("encoding/base64.zig").decode(exec.call_arena, input.bytes);
    return .{ .bytes = bytes };
}

pub fn structuredClone(_: *const WorkerGlobalScope, value: JS.Value) !JS.Value {
    return value.structuredClone();
}

pub fn unhandledPromiseRejection(self: *WorkerGlobalScope, no_handler: bool, rejection: JS.PromiseRejection) !void {
    if (comptime IS_DEBUG) {
        log.debug(.js, "unhandled rejection", .{
            .target = "worker",
            .value = rejection.reason(),
            .stack = rejection.local.stackTrace() catch |err| @errorName(err) orelse "???",
        });
    } else {
        log.warn(.js, "unhandled rejection", .{
            .target = "worker",
            .value = rejection.reason(),
        });
    }

    const event_name, const attribute_callback = blk: {
        if (no_handler) {
            break :blk .{ "unhandledrejection", self._on_unhandled_rejection };
        }
        break :blk .{ "rejectionhandled", self._on_rejection_handled };
    };

    const target = self.asEventTarget();
    if (self._event_manager.hasDirectListeners(target, event_name, attribute_callback)) {
        const event = (try @import("event/PromiseRejectionEvent.zig").init(event_name, .{
            .reason = if (rejection.reason()) |r| try r.temp() else null,
            .promise = try rejection.promise().temp(),
        }, self._page)).asEvent();
        // Ignore any errors from dispatching the event to avoid crashing
        self.dispatch(target, event, attribute_callback, .{}) catch |err| {
            log.warn(.js, "failed to dispatch unhandledrejection event", .{ .err = err });
        };
    }
}

pub fn close(self: *WorkerGlobalScope) void {
    // TOOD: we should also stop new tasks from being scheduled
    self.js.scheduler.reset();
    self._closed = true;
}

fn _debug_nextMessageId(self: *WorkerGlobalScope) u64 {
    const id = self._debug_next_message_id;
    self._debug_next_message_id += 1;
    return id;
}

fn _debug_schedulerQueueLen(_: *WorkerGlobalScope, scheduler: anytype) usize {
    _ = scheduler;
    return 0;
}

pub fn importScripts(self: *WorkerGlobalScope, urls: []const [:0]const u8) !void {
    const session = self._session;
    const arena = try session.getArena(.large, "importScript");
    defer session.releaseArena(arena);

    for (urls) |url| {
        defer session.arena_pool.resetRetain(arena);
        try self.importScript(arena, url);
    }
}

fn importScript(self: *WorkerGlobalScope, arena: Allocator, url: [:0]const u8) !void {
    const session = self._session;

    const resolved_url = try URL.resolve(arena, self.url, url, .{});

    const http_client = &session.browser.http_client;

    var headers = try http_client.newHeaders();
    try self.headersForRequest(&headers, .{
        .request_url = resolved_url,
        .resource_type = .script,
    });

    const response = http_client.syncRequest(arena, .{
        .url = resolved_url,
        .method = .GET,
        .frame_id = self._frame_id,
        .loader_id = self._loader_id,
        .headers = headers,
        .cookie_jar = &session.cookie_jar,
        .cookie_origin = self.url,
        .resource_type = .script,
        .notification = session.notification,
    }) catch |err| {
        log.warn(.http, "importScript", .{ .url = resolved_url, .err = err });
        return error.NetworkError;
    };

    if (response.status != 200) {
        log.warn(.http, "importScript", .{ .url = resolved_url, .status = response.status });
        return error.NetworkError;
    }

    var ls: JS.Local.Scope = undefined;
    self.js.localScope(&ls);
    defer ls.deinit();

    var try_catch: JS.TryCatch = undefined;
    try_catch.init(&ls.local);
    defer try_catch.deinit();

    // Imported classic scripts often end with `.call(this)`. Wrap like the
    // initial worker bootstrap so `this` resolves to the worker global.
    const wrapped_script = try std.fmt.allocPrint(
        arena,
        "(function(){{\n{s}\n}}).call(globalThis);",
        .{response.body.items},
    );

    session.browser.env.pumpSchedulerTasks();
    _ = ls.local.eval(wrapped_script, url) catch |err| {
        const caught = try_catch.caughtOrError(arena, err);
        log.err(.browser, "importScript", .{
            .url = resolved_url,
            .body_len = response.body.items.len,
            .err = err,
            .caught = caught,
        });
        return err;
    };

    ls.local.runMacrotasks();
    session.browser.runMacrotasks() catch |err| {
        log.warn(.browser, "importScript pump", .{ .err = err });
    };
}

pub fn reportError(self: *WorkerGlobalScope, err: JS.Value) !void {
    const error_event = try ErrorEvent.initTrusted(comptime .wrap("error"), .{
        .@"error" = try err.temp(),
        .message = err.toStringSlice() catch "Unknown error",
        .bubbles = false,
        .cancelable = true,
    }, self._page);

    // Invoke onerror callback if set (per WHATWG spec, this is called
    // with 5 arguments: message, source, lineno, colno, error)
    // If it returns true, the event is cancelled.
    var prevent_default = false;
    if (self._on_error) |on_error| {
        var ls: JS.Local.Scope = undefined;
        self.js.localScope(&ls);
        defer ls.deinit();

        const local_func = ls.toLocal(on_error);
        const result = local_func.call(JS.Value, .{
            error_event._message,
            error_event._filename,
            error_event._line_number,
            error_event._column_number,
            err,
        }) catch null;

        // Per spec: returning true from onerror cancels the event
        if (result) |r| {
            prevent_default = r.isTrue();
        }
    }

    const event = error_event.asEvent();
    event._prevent_default = prevent_default;
    // Pass null as handler: onerror was already called above with 5 args.
    // We still dispatch so that addEventListener('error', ...) listeners fire.
    try self.dispatch(self.asEventTarget(), event, null, .{});

    if (comptime builtin.is_test == false) {
        if (!event._prevent_default) {
            log.warn(.js, "worker.reportError", .{
                .message = error_event._message,
                .filename = error_event._filename,
                .line_number = error_event._line_number,
                .column_number = error_event._column_number,
            });
        }
    }
}

pub fn fetch(_: *const WorkerGlobalScope, input: Fetch.Input, options: ?Fetch.InitOpts, exec: *const JS.Execution) !JS.Promise {
    return Fetch.init(input, options, exec);
}

pub fn queueMicrotask(self: *WorkerGlobalScope, cb: JS.Function) void {
    self.js.queueMicrotaskFunc(cb);
}

pub fn setTimeout(self: *WorkerGlobalScope, handler: Timers.LegacyHandler, delay_ms: ?u32, params: []JS.Value.Temp, exec: *JS.Execution) !u32 {
    const cb = try handler.resolve(exec);
    return self._timers.schedule(exec, cb, delay_ms orelse 0, .{
        .repeat = false,
        .params = params,
        .name = "worker.setTimeout",
    });
}

pub fn clearTimeout(self: *WorkerGlobalScope, id: u32) void {
    self._timers.clear(id);
}

pub fn setInterval(self: *WorkerGlobalScope, handler: Timers.LegacyHandler, delay_ms: ?u32, params: []JS.Value.Temp, exec: *JS.Execution) !u32 {
    const cb = try handler.resolve(exec);
    return self._timers.schedule(exec, cb, delay_ms orelse 0, .{
        .repeat = true,
        .params = params,
        .name = "worker.setInterval",
    });
}

pub fn clearInterval(self: *WorkerGlobalScope, id: u32) void {
    self._timers.clear(id);
}

const FunctionSetter = union(enum) {
    func: JS.Function.Global,
    anything: JS.Value,
};

fn getFunctionFromSetter(setter_: ?FunctionSetter) ?JS.Function.Global {
    const setter = setter_ orelse return null;
    return switch (setter) {
        .func => |func| func,
        .anything => null,
    };
}

const ReceiveMessageCallback = struct {
    data: ?JS.Value.Temp,
    ports: []const *MessagePort,
    arena: Allocator,
    worker_scope: *WorkerGlobalScope,
    message_id: u64,

    fn cancelled(ctx: *anyopaque) void {
        const self: *ReceiveMessageCallback = @ptrCast(@alignCast(ctx));
        if (self.data) |d| d.release();
        self.deinit();
    }

    fn deinit(self: *ReceiveMessageCallback) void {
        self.worker_scope._session.releaseArena(self.arena);
    }

    fn run(ctx: *anyopaque) !?u32 {
        const self: *ReceiveMessageCallback = @ptrCast(@alignCast(ctx));
        defer self.deinit();

        const worker_scope = self.worker_scope;
        const target = worker_scope.asEventTarget();

        if (comptime IS_DEBUG) {
            log.info(.browser, "worker dispatch inbound message", .{
                .worker_id = worker_scope._frame_id,
                .message_id = self.message_id,
                .queue_len = worker_scope._debug_schedulerQueueLen(worker_scope.js.scheduler),
            });
        }

        // If data is null, structured clone failed - fire messageerror
        if (self.data == null) {
            const on_messageerror = worker_scope._on_messageerror;
            if (!worker_scope._event_manager.hasDirectListeners(target, "messageerror", on_messageerror)) {
                return null;
            }
            const event = (try MessageEvent.initTrusted(comptime .wrap("messageerror"), .{
                .bubbles = false,
                .cancelable = false,
            }, worker_scope._page)).asEvent();
            try worker_scope.dispatch(target, event, on_messageerror, .{});
            return null;
        }

        const on_message = worker_scope._on_message;

        // Check if there are any listeners before creating the event
        if (!worker_scope._event_manager.hasDirectListeners(target, "message", on_message)) {
            self.data.?.release();
            return null;
        }

        const event = (try MessageEvent.initTrusted(comptime .wrap("message"), .{
            .data = .{ .value = self.data.? },
            .ports = self.ports,
            .bubbles = false,
            .cancelable = false,
        }, worker_scope._page)).asEvent();
        try worker_scope.dispatch(target, event, on_message, .{});
        pumpAfterWorkerMessage(worker_scope);
        return null;
    }
};

fn pumpAfterWorkerMessage(worker_scope: *WorkerGlobalScope) void {
    worker_scope._session.browser.runMacrotasks() catch |err| {
        log.warn(.browser, "worker pump macrotasks", .{ .err = err });
    };
}

pub const JsApi = struct {
    pub const bridge = JS.Bridge(WorkerGlobalScope);

    pub const Meta = struct {
        pub const name = "WorkerGlobalScope";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };

    pub const self = bridge.accessor(WorkerGlobalScope.getSelf, null, .{});
    pub const console = bridge.accessor(WorkerGlobalScope.getConsole, null, .{});
    pub const crypto = bridge.accessor(WorkerGlobalScope.getCrypto, null, .{});
    pub const performance = bridge.accessor(WorkerGlobalScope.getPerformance, null, .{});
    pub const navigator = bridge.accessor(WorkerGlobalScope.getNavigator, null, .{});
    pub const location = bridge.accessor(WorkerGlobalScope.getLocation, null, .{ .deletable = false });

    pub const onerror = bridge.accessor(WorkerGlobalScope.getOnError, WorkerGlobalScope.setOnError, .{});
    pub const onrejectionhandled = bridge.accessor(WorkerGlobalScope.getOnRejectionHandled, WorkerGlobalScope.setOnRejectionHandled, .{});
    pub const onunhandledrejection = bridge.accessor(WorkerGlobalScope.getOnUnhandledRejection, WorkerGlobalScope.setOnUnhandledRejection, .{});

    pub const btoa = bridge.function(WorkerGlobalScope.btoa, .{ .dom_exception = true });
    pub const atob = bridge.function(WorkerGlobalScope.atob, .{ .dom_exception = true });
    pub const structuredClone = bridge.function(WorkerGlobalScope.structuredClone, .{});
    pub const postMessage = bridge.function(WorkerGlobalScope.postMessage, .{});
    pub const reportError = bridge.function(WorkerGlobalScope.reportError, .{});
    pub const close = bridge.function(WorkerGlobalScope.close, .{});
    pub const fetch = bridge.function(WorkerGlobalScope.fetch, .{});
    pub const importScripts = bridge.function(WorkerGlobalScope.importScripts, .{ .dom_exception = true });
    pub const queueMicrotask = bridge.function(WorkerGlobalScope.queueMicrotask, .{});
    pub const setTimeout = bridge.function(WorkerGlobalScope.setTimeout, .{});
    pub const clearTimeout = bridge.function(WorkerGlobalScope.clearTimeout, .{});
    pub const setInterval = bridge.function(WorkerGlobalScope.setInterval, .{});
    pub const clearInterval = bridge.function(WorkerGlobalScope.clearInterval, .{});

    pub const onmessage = bridge.accessor(WorkerGlobalScope.getOnMessage, WorkerGlobalScope.setOnMessage, .{});
    pub const onmessageerror = bridge.accessor(WorkerGlobalScope.getOnMessageError, WorkerGlobalScope.setOnMessageError, .{});

    // Return false since workers don't have secure-context-only APIs
    pub const isSecureContext = bridge.property(false, .{ .template = false });
};
