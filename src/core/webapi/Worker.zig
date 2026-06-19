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

const URL = @import("../browser/URL.zig");
const Frame = @import("../browser/Frame.zig");
const HttpClient = @import("../browser/HttpClient.zig");

const Blob = @import("Blob.zig");
const EventTarget = @import("EventTarget.zig");
const MessageEvent = @import("event/MessageEvent.zig");
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
_script_loaded: bool = false,
_bootstrap_complete: bool = false,
_script_buffer: std.ArrayList(u8) = .empty,
_http_response: ?HttpClient.Response = null,
_debug_next_message_id: u64 = 1,
_pending_inbound_messages: std.ArrayListUnmanaged(PendingInboundMessage) = .{},

// Event handlers
_on_error: ?js.Function.Global = null,
_on_message: ?js.Function.Global = null,
_on_messageerror: ?js.Function.Global = null,

pub fn init(url: []const u8, exec: *Execution) !*Worker {
    const frame = switch (exec.context.global) {
        .frame => |f| f,
        .worker => return error.WorkerCannotCreateWorker,
    };
    const session = frame._session;

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
    });
    self._worker_scope = try WorkerGlobalScope.init(self, resolved_url);
    errdefer self._worker_scope.deinit();
    try frame.trackWorker(self);

    if (std.mem.startsWith(u8, url, "blob:")) {
        errdefer frame.removeWorker(self);
        const blob: *Blob = frame.lookupBlobUrl(url) orelse {
            log.warn(.js, "invalid blob", .{ .target = "worker" });
            return error.BlobNotFound;
        };
        try self.loadInitialScript(blob._slice);
        return self;
    }

    const http_client = &session.browser.http_client;
    http_client.request(.{
        .ctx = self,
        .params = .{
            .url = resolved_url,
            .method = .GET,
            .headers = try http_client.newHeaders(),
            .frame_id = self._frame_id,
            .loader_id = self._loader_id,
            .resource_type = .script,
            .cookie_jar = &session.cookie_jar,
            .cookie_origin = resolved_url,
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

// Called from Frame.deinit when the frame is destroyed, so we don't need to
// remove from the frame's worker list.
pub fn deinit(self: *Worker) void {
    // No pending frame for workers, so we can abort all frames.
    self._frame._session.browser.http_client.abortFrame(self._frame_id, .{ .scope = .full });
    if (self._http_response) |res| {
        res.abort(error.Abort);
        self._http_response = null;
    }
    self.releasePendingInboundMessages();
    self._worker_scope.deinit();
    self._frame._session.releaseArena(self._arena);
}

pub fn asEventTarget(self: *Worker) *EventTarget {
    return self._proto;
}

fn httpHeaderCallback(response: HttpClient.Response) !bool {
    const self: *Worker = @ptrCast(@alignCast(response.ctx));

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

    return true;
}

fn httpDataCallback(response: HttpClient.Response, data: []const u8) !void {
    const self: *Worker = @ptrCast(@alignCast(response.ctx));
    try self._script_buffer.appendSlice(self._arena, data);
}

fn httpDoneCallback(ctx: *anyopaque) !void {
    const self: *Worker = @ptrCast(@alignCast(ctx));
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

    try self.loadInitialScript(script);
}

fn pumpAfterWorkerMessage(frame: *Frame) void {
    frame._session.browser.runMacrotasks() catch |err| {
        log.warn(.browser, "worker pump macrotasks", .{ .err = err });
    };
}

fn loadInitialScript(self: *Worker, script: []const u8) !void {
    var ls: js.Local.Scope = undefined;
    self._worker_scope.js.localScope(&ls);
    defer ls.deinit();

    const wrapped_script = try std.fmt.allocPrint(
        self._arena,
        "(function(){{\n{s}\n}}).call(globalThis);",
        .{script},
    );

    var try_catch: js.TryCatch = undefined;
    try_catch.init(&ls.local);
    defer try_catch.deinit();

    _ = ls.local.eval(wrapped_script, self._url) catch |err| {
        const caught = try_catch.caughtOrError(self._arena, err);
        log.err(.browser, "worker script error", .{ .url = self._url, .caught = caught });
        self.fireErrorEvent(caught.exception orelse @errorName(err), null);
        return;
    };

    self._bootstrap_complete = true;
    ls.local.runMacrotasks();
    // Queue parent delivery for the next macrotask turn so Worker() can return
    // and onmessage handlers can be assigned first.
    try self.scheduleDeferredParentFlush();
}

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

        try self.worker.flushPendingInboundMessages();
        pumpAfterWorkerMessage(self.worker._frame);
        return null;
    }
};

fn httpErrorCallback(ctx: *anyopaque, err: anyerror) void {
    const self: *Worker = @ptrCast(@alignCast(ctx));
    self._http_response = null;

    log.err(.browser, "worker fetch error", .{
        .url = self._worker_scope.url,
        .err = err,
    });

    self.fireErrorEvent(@errorName(err), null);
}

// Fire an error event on the Worker object (parent context)
fn fireErrorEvent(self: *Worker, message: []const u8, error_value: ?js.Value.Temp) void {
    self._fireErrorEvent(message, error_value) catch |err| {
        log.warn(.browser, "worker fire error", .{ .err = err, .message = message });
    };
}

fn _fireErrorEvent(self: *Worker, message: []const u8, error_value: ?js.Value.Temp) !void {
    const frame = self._frame;
    const target = self.asEventTarget();
    const on_error = self._on_error;

    // Check if there are any listeners
    if (!frame._event_manager.hasDirectListeners(target, "error", on_error)) {
        if (error_value) |ev| ev.release();
        return;
    }

    const error_event = try ErrorEvent.initTrusted(comptime .wrap("error"), .{
        .@"error" = error_value,
        .message = message,
        .filename = self._url,
        .bubbles = false,
        .cancelable = true,
    }, frame._page);

    try frame._event_manager.dispatchDirect(target, error_event.asEvent(), on_error, .{
        .context = "Worker.onerror",
    });
}

pub fn terminate(self: *Worker) void {
    // Abort any pending script fetch
    if (self._http_response) |resp| {
        resp.abort(error.Abort);
        self._http_response = null;
    }
}

// Posts a message from the frame to the worker.
pub fn postMessage(self: *Worker, data: js.Value, transfer: ?[]js.Value) !void {
    const message_id = self._debug_nextMessageId();
    if (comptime IS_DEBUG) {
        log.info(.browser, "worker postMessage to worker", .{
            .worker_id = self._frame_id,
            .message_id = message_id,
        });
    }

    const transferred_ports = if (transfer) |list|
        try MessagePort.processTransferList(list, &self._frame.js.execution, &self._worker_scope.js.execution, self._arena)
    else
        &[_]*MessagePort{};

    try self._worker_scope.receiveMessage(data, message_id, transferred_ports);
}

// Called internally by WorkerGlobalScope when it wants to post a message to us
pub fn receiveMessage(self: *Worker, data: js.Value, message_id: u64, ports: []const *MessagePort) !void {
    if (!self._bootstrap_complete) {
        const cloned_data = try self.cloneMessageToFrame(data);
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

    try self.enqueueInboundMessage(data, message_id, ports);
}

pub fn getOnMessage(self: *const Worker) ?js.Function.Global {
    return self._on_message;
}

pub fn setOnMessage(self: *Worker, setter: ?FunctionSetter) void {
    self._on_message = getFunctionFromSetter(setter);
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

    const cloned = try data.structuredCloneTo(&target_ls.local);
    return try cloned.temp();
}

fn enqueueInboundMessage(self: *Worker, data: js.Value, message_id: u64, ports: []const *MessagePort) !void {
    const cloned_data = try self.cloneMessageToFrame(data);
    try self.enqueueInboundTempMessage(cloned_data, message_id, ports);
}

fn flushPendingInboundMessages(self: *Worker) !void {
    for (self._pending_inbound_messages.items) |pending| {
        if (comptime IS_DEBUG) {
            log.info(.browser, "worker flush inbound message", .{
                .worker_id = self._frame_id,
                .message_id = pending.message_id,
                .queue_len = self._pending_inbound_messages.items.len,
            });
        }
        try self.enqueueInboundTempMessage(pending.data, pending.message_id, pending.ports);
    }
    self._pending_inbound_messages.clearRetainingCapacity();
}

fn releasePendingInboundMessages(self: *Worker) void {
    for (self._pending_inbound_messages.items) |pending| {
        pending.data.release();
    }
    self._pending_inbound_messages.deinit(self._arena);
    self._pending_inbound_messages = .{};
}

const PendingInboundMessage = struct {
    message_id: u64,
    data: js.Value.Temp,
    ports: []const *MessagePort,
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

        const on_message = worker._on_message;

        // Check if there are any listeners before creating the event
        if (!frame._event_manager.hasDirectListeners(target, "message", on_message)) {
            data.release();
            return null;
        }

        const event = (try MessageEvent.initTrusted(comptime .wrap("message"), .{
            .data = .{ .value = data },
            .ports = self.ports,
            .bubbles = false,
            .cancelable = false,
        }, frame._page)).asEvent();

        try frame._event_manager.dispatchDirect(target, event, on_message, .{ .context = "Worker.receiveMessage" });

        pumpAfterWorkerMessage(frame);

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

    pub const constructor = bridge.constructor(Worker.init, .{});

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
