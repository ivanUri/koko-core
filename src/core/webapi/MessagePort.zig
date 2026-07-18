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
const TaggedOpaque = @import("../js/TaggedOpaque.zig");

const EventTarget = @import("EventTarget.zig");
const MessageEvent = @import("event/MessageEvent.zig");

const Frame = @import("../browser/Frame.zig");
const Worker = @import("Worker.zig");
const log = @import("../../support/log.zig");

const Allocator = std.mem.Allocator;

fn scheduleDeferredPump(exec: *const js.Execution) void {
    const frame: *Frame = switch (exec.context.global) {
        .frame => |f| f,
        .worker => |wgs| wgs._worker._frame,
    };
    scheduleDeferredMessageDelivery(frame) catch |err| {
        log.warn(.browser, "MessagePort pump", .{ .err = err });
    };
}

/// Retry parked MessagePort deliveries (pending_deliveries) on a fresh task.
/// Critical for React 18 MessageChannel scheduling: first delay-0 callback may
/// still see call_depth/V8 stack and park; without reschedule, CSR never flushes.
fn scheduleDeferredFlush(exec: *const js.Execution, port: *MessagePort) void {
    const frame: *Frame = switch (exec.context.global) {
        .frame => |f| f,
        .worker => |wgs| wgs._worker._frame,
    };
    const arena = frame.getArena(.tiny, "MessagePort.deferFlush") catch |err| {
        log.warn(.browser, "MessagePort deferFlush arena", .{ .err = err });
        return;
    };
    const callback = arena.create(DeferFlushCallback) catch {
        frame.releaseArena(arena);
        return;
    };
    callback.* = .{ .frame = frame, .port = port, .arena = arena, .attempts = 0 };
    frame.js.scheduler.add(callback, DeferFlushCallback.run, 0, .{
        .name = "MessagePort.deferFlush",
        .low_priority = false,
        .finalizer = DeferFlushCallback.cancelled,
    }) catch {
        frame.releaseArena(arena);
    };
}

const DeferFlushCallback = struct {
    frame: *Frame,
    port: *MessagePort,
    arena: Allocator,
    attempts: u8,

    fn cancelled(ctx: *anyopaque) void {
        const self: *DeferFlushCallback = @ptrCast(@alignCast(ctx));
        self.frame.releaseArena(self.arena);
    }

    fn run(ctx: *anyopaque) !?u32 {
        const self: *DeferFlushCallback = @ptrCast(@alignCast(ctx));
        if (self.port._closed) {
            self.frame.releaseArena(self.arena);
            return null;
        }
        self.port.flushPendingDeliveries() catch |err| {
            log.warn(.browser, "MessagePort.deferFlush", .{ .err = err });
        };
        if (self.port._pending_deliveries.items.len > 0 and self.attempts < 32) {
            self.attempts += 1;
            // Still gated (e.g. mid-eval): retry next tick, keep arena alive.
            return 0;
        }
        self.frame.releaseArena(self.arena);
        return null;
    }
};

fn scheduleDeferredMessageDelivery(frame: *Frame) !void {
    const arena = try frame.getArena(.tiny, "MessagePort.deferDelivery");
    errdefer frame.releaseArena(arena);

    const callback = try arena.create(DeferMessageDeliveryCallback);
    callback.* = .{ .frame = frame, .arena = arena };

    try frame.js.scheduler.add(callback, DeferMessageDeliveryCallback.run, 0, .{
        .name = "MessagePort.deferDelivery",
        .low_priority = false,
        .finalizer = DeferMessageDeliveryCallback.cancelled,
    });
}

const DeferMessageDeliveryCallback = struct {
    frame: *Frame,
    arena: Allocator,

    fn cancelled(ctx: *anyopaque) void {
        const self: *DeferMessageDeliveryCallback = @ptrCast(@alignCast(ctx));
        self.frame.releaseArena(self.arena);
    }

    fn run(ctx: *anyopaque) !?u32 {
        const self: *DeferMessageDeliveryCallback = @ptrCast(@alignCast(ctx));
        defer self.frame.releaseArena(self.arena);
        Worker.pumpMessageDelivery(self.frame);
        return null;
    }
};

/// After a MessagePort `message` event, pump worker/page timer queues so the next
/// `postMessage` round-trip is not stalled (WPT structured-clone Blob `compare_Blob`
/// uses `await Response#arrayBuffer()` between sequential port tests).
fn pumpMessagingAfterDispatch(exec: *const js.Execution) void {
    const frame: *Frame = switch (exec.context.global) {
        .frame => |f| f,
        .worker => |wgs| wgs._worker._frame,
    };
    Worker.pumpMessageDelivery(frame);
    if (exec.context.global == .frame) {
        frame.scheduleDeferredMacrotaskPump(0) catch |err| {
            log.warn(.browser, "MessagePort macrotask pump", .{ .err = err });
        };
    }
}

const MessagePort = @This();

_proto: *EventTarget,
_enabled: bool = false,
_closed: bool = false,
_on_message: ?js.Function.Global = null,
_on_message_error: ?js.Function.Global = null,
_entangled_port: ?*MessagePort = null,
_pending_messages: std.ArrayList(js.Value.Temp) = .{},
_pending_deliveries: std.ArrayList(js.Value.Temp) = .{},
// The execution context that currently owns this port (updated on transfer).
_active_exec: *const js.Execution,

pub fn init(exec: *const js.Execution) !*MessagePort {
    const port = try exec._factory.eventTarget(MessagePort{
        ._proto = undefined,
        ._active_exec = exec,
    });
    return port;
}

pub fn asEventTarget(self: *MessagePort) *EventTarget {
    return self._proto;
}

pub fn entangle(port1: *MessagePort, port2: *MessagePort) void {
    port1._entangled_port = port2;
    port2._entangled_port = port1;
}

pub fn activeExecution(self: *const MessagePort) *const js.Execution {
    return self._active_exec;
}

/// Detach this port from `sender_exec` and attach it to `receiver_exec`.
pub fn transferTo(self: *MessagePort, sender_exec: *const js.Execution, receiver_exec: *const js.Execution) void {
    if (self._active_exec.context == sender_exec.context) {
        _ = sender_exec.context.identity.identity_map.remove(@intFromPtr(self));
    }
    self._active_exec = receiver_exec;
}

/// Parse postMessage's optional second argument: sequence, `{transfer: sequence}`, or absent.
pub fn parseTransferArg(local: *const js.Local, transfer_arg: ?js.Value) ![]js.Value {
    const arg = transfer_arg orelse return &.{};
    if (arg.isNullOrUndefined()) return &.{};

    const sequence = if (arg.isArray())
        arg
    else if (arg.isObject())
        arg.toObject().get("transfer") catch return error.TypeError
    else
        return error.TypeError;

    if (sequence.isNullOrUndefined()) return &.{};
    if (!sequence.isArray()) return error.TypeError;

    const js_arr = sequence.toArray();
    const len = js_arr.len();
    const items = try local.call_arena.alloc(js.Value, len);
    for (items, 0..) |*slot, i| {
        const item = try js_arr.get(@intCast(i));
        if (item.isNull()) return error.TypeError;
        slot.* = item;
    }
    return items;
}

pub fn processTransferList(
    transfer: []js.Value,
    sender_exec: *const js.Execution,
    receiver_exec: *const js.Execution,
    arena: Allocator,
) ![]*MessagePort {
    var ports: std.ArrayList(*MessagePort) = .{};
    errdefer ports.deinit(arena);

    for (transfer) |item| {
        if (item.isNull()) return error.TypeError;
        if (item.isArrayBuffer()) continue;
        if (!item.isObject()) return error.DataClone;
        const port = TaggedOpaque.fromJS(*MessagePort, @ptrCast(item.handle)) catch return error.DataClone;
        if (port._closed) return error.DataClone;
        if (port._active_exec.context != sender_exec.context) return error.DataClone;
        port.transferTo(sender_exec, receiver_exec);
        try ports.append(arena, port);
    }

    return try ports.toOwnedSlice(arena);
}

pub fn postMessage(
    self: *MessagePort,
    message: js.Value.Temp,
    transfer_arg: ?js.Value,
    exec: *const js.Execution,
) !void {
    if (self._closed) {
        return;
    }

    if (self._active_exec.context != exec.context) {
        return error.InvalidStateError;
    }

    const other = self._entangled_port orelse return;
    if (other._closed) {
        return;
    }

    const receiver_exec = other._active_exec;

    const cloned_message, const transferred_ports = blk: {
        var source_ls: js.Local.Scope = undefined;
        exec.context.localScope(&source_ls);
        defer source_ls.deinit();
        var target_ls: js.Local.Scope = undefined;
        receiver_exec.context.localScope(&target_ls);
        defer target_ls.deinit();

        const transfer_list = try parseTransferArg(&source_ls.local, transfer_arg);
        const transfer_slice: ?[]const js.Value = if (transfer_list.len > 0) transfer_list else null;
        const cloned = try message.local(&source_ls.local).structuredCloneTo(&target_ls.local, transfer_slice);
        const ports = try processTransferList(
            transfer_list,
            exec,
            receiver_exec,
            receiver_exec.arena,
        );
        break :blk .{ try cloned.temp(), ports };
    };

    if (!other._enabled) {
        try other._pending_messages.append(receiver_exec.arena, cloned_message);
        return;
    }

    // When listeners are already registered, deliver synchronously so worker
    // onmessage → port.postMessage round-trips complete inside one postMessage
    // (WPT structured-clone/shared.html reuses the same port across 152 tests).
    if (try dispatchMessageNow(other, cloned_message, transferred_ports, receiver_exec)) {
        scheduleDeferredPump(receiver_exec);
        if (exec.context != receiver_exec.context) {
            scheduleDeferredPump(exec);
        }
        return;
    }

    try other.enqueueMessage(cloned_message, transferred_ports, receiver_exec, exec);
}

fn dispatchMessageNow(
    self: *MessagePort,
    message: js.Value.Temp,
    ports: []const *MessagePort,
    exec: *const js.Execution,
) !bool {
    if (self._closed) return false;

    // Sync path only when JsEntryGate allows — otherwise enqueue (HTML task).
    if (js.JsEntryGate.mustQueueAsTask(exec)) return false;

    const target = self.asEventTarget();
    if (!exec.hasDirectListeners(target, "message", self._on_message)) {
        return false;
    }

    try dispatchMessageForced(self, message, ports, exec);
    return true;
}

/// Task-path delivery (no sync reentrancy gates). Host scheduler already owns
/// this turn — see architecture ADR "queued task never re-gates".
fn dispatchMessageForced(
    self: *MessagePort,
    message: js.Value.Temp,
    ports: []const *MessagePort,
    exec: *const js.Execution,
) !void {
    if (self._closed) {
        message.release();
        return;
    }
    const target = self.asEventTarget();
    if (!exec.hasDirectListeners(target, "message", self._on_message)) {
        message.release();
        return;
    }

    const page = switch (exec.context.global) {
        .frame => |fr| fr._page,
        .worker => |wgs| wgs._worker._frame._page,
    };
    const event = (try MessageEvent.initTrusted(comptime .wrap("message"), .{
        .data = .{ .value = message },
        .ports = ports,
        .origin = "",
        .source = null,
    }, page)).asEvent();

    try exec.dispatch(target, event, self._on_message, .{ .context = "MessagePort message" });
    pumpMessagingAfterDispatch(exec);
}

fn enqueueMessage(
    self: *MessagePort,
    message: js.Value.Temp,
    ports: []const *MessagePort,
    receiver_exec: *const js.Execution,
    sender_exec: *const js.Execution,
) !void {
    const ports_copy = try receiver_exec.arena.dupe(*MessagePort, ports);
    const callback = try receiver_exec._factory.create(PostMessageCallback{
        .exec = receiver_exec,
        .port = self,
        .message = message,
        .ports = ports_copy,
    });

    try receiver_exec._scheduler.add(callback, PostMessageCallback.run, 0, .{
        .name = "MessagePort.postMessage",
        .low_priority = false,
    });

    // Defer pumpMessageDelivery (runOne) — never runMacrotasks from postMessage
    // (MAX_MACROTASK_RUN_DEPTH) and never pump synchronously (reentrancy).
    scheduleDeferredPump(receiver_exec);
    if (sender_exec.context != receiver_exec.context) {
        scheduleDeferredPump(sender_exec);
    }
}

fn flushPendingMessages(self: *MessagePort) !void {
    const exec = self._active_exec;
    for (self._pending_messages.items) |message| {
        try self.enqueueMessage(message, &.{}, exec, exec);
    }
    self._pending_messages.clearRetainingCapacity();
}

fn releasePendingMessages(self: *MessagePort) void {
    for (self._pending_messages.items) |message| {
        message.release();
    }
    self._pending_messages.clearRetainingCapacity();
    for (self._pending_deliveries.items) |message| {
        message.release();
    }
    self._pending_deliveries.clearRetainingCapacity();
}

pub fn start(self: *MessagePort) !void {
    if (self._closed) {
        return;
    }
    self._enabled = true;
    try self.flushPendingMessages();
    try self.flushPendingDeliveries();
}

pub fn close(self: *MessagePort) void {
    self._closed = true;
    self.releasePendingMessages();

    // Break entanglement
    if (self._entangled_port) |other| {
        other._entangled_port = null;
    }
    self._entangled_port = null;
}

pub fn getOnMessage(self: *const MessagePort) ?js.Function.Global {
    return self._on_message;
}

pub fn setOnMessage(self: *MessagePort, cb: ?js.Function.Global) !void {
    self._on_message = cb;
    // HTML: assigning onmessage enables the port message queue.
    if (cb != null) {
        try self.start();
    }
    try self.flushPendingDeliveries();
}

pub fn flushPendingDeliveries(self: *MessagePort) !void {
    const exec = self._active_exec;

    while (self._pending_deliveries.items.len > 0) {
        const message = self._pending_deliveries.orderedRemove(0);
        // Sync flush (start/setOnmessage) may still be nested: re-park + deferFlush.
        // PostMessageCallback task path uses dispatchMessageForced without this gate.
        if (js.JsEntryGate.mustQueueAsTask(exec)) {
            try self._pending_deliveries.append(exec.arena, message);
            scheduleDeferredFlush(exec, self);
            break;
        }
        try dispatchMessageForced(self, message, &.{}, exec);
    }

    js.EventLoop.afterTask(exec);
}

pub fn getOnMessageError(self: *const MessagePort) ?js.Function.Global {
    return self._on_message_error;
}

pub fn setOnMessageError(self: *MessagePort, cb: ?js.Function.Global) !void {
    self._on_message_error = cb;
}

const PostMessageCallback = struct {
    port: *MessagePort,
    message: js.Value.Temp,
    ports: []const *MessagePort,
    exec: *const js.Execution,

    fn deinit(self: *PostMessageCallback) void {
        self.exec._factory.destroy(self);
    }

    fn run(ctx: *anyopaque) !?u32 {
        const self: *PostMessageCallback = @ptrCast(@alignCast(ctx));
        defer self.deinit();

        if (self.port._closed) {
            return null;
        }

        // Task path: no sync gates (JsEntryGate rule — queued work never re-parks).
        try dispatchMessageForced(self.port, self.message, self.ports, self.exec);
        // Chained port posts (React host scheduler) drain via shared EventLoop.
        js.EventLoop.afterTask(self.exec);
        return null;
    }
};

pub const JsApi = struct {
    pub const bridge = js.Bridge(MessagePort);

    pub const Meta = struct {
        pub const name = "MessagePort";
        pub var class_id: bridge.ClassId = undefined;
        pub const prototype_chain = bridge.prototypeChain();
    };

    pub const postMessage = bridge.function(MessagePort.postMessage, .{ .dom_exception = true });
    pub const start = bridge.function(MessagePort.start, .{ .dom_exception = true });
    pub const close = bridge.function(MessagePort.close, .{});

    pub const onmessage = bridge.accessor(MessagePort.getOnMessage, MessagePort.setOnMessage, .{});
    pub const onmessageerror = bridge.accessor(MessagePort.getOnMessageError, MessagePort.setOnMessageError, .{});
};
