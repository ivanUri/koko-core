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

const log = @import("../../support/log.zig");

const Allocator = std.mem.Allocator;

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

pub fn processTransferList(
    transfer: []js.Value,
    sender_exec: *const js.Execution,
    receiver_exec: *const js.Execution,
    arena: Allocator,
) ![]*MessagePort {
    var ports: std.ArrayList(*MessagePort) = .{};
    errdefer ports.deinit(arena);

    for (transfer) |item| {
        if (!item.isObject()) return error.DataClone;
        const port = TaggedOpaque.fromJS(*MessagePort, @ptrCast(item.handle)) catch return error.DataClone;
        if (port._closed) return error.DataClone;
        if (port._active_exec.context != sender_exec.context) return error.DataClone;
        port.transferTo(sender_exec, receiver_exec);
        try ports.append(arena, port);
    }

    return try ports.toOwnedSlice(arena);
}

pub fn postMessage(self: *MessagePort, message: js.Value.Temp, exec: *const js.Execution) !void {
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

    const cloned_message = blk: {
        var source_ls: js.Local.Scope = undefined;
        exec.context.localScope(&source_ls);
        defer source_ls.deinit();
        var target_ls: js.Local.Scope = undefined;
        receiver_exec.context.localScope(&target_ls);
        defer target_ls.deinit();

        const cloned = message.local(&source_ls.local).structuredCloneTo(&target_ls.local) catch return;
        break :blk try cloned.temp();
    };

    if (!other._enabled) {
        try other._pending_messages.append(receiver_exec.arena, cloned_message);
        return;
    }

    try other.enqueueMessage(cloned_message, receiver_exec);
}

fn enqueueMessage(self: *MessagePort, message: js.Value.Temp, exec: *const js.Execution) !void {
    const callback = try exec._factory.create(PostMessageCallback{
        .exec = exec,
        .port = self,
        .message = message,
    });

    try exec._scheduler.add(callback, PostMessageCallback.run, 0, .{
        .name = "MessagePort.postMessage",
        .low_priority = false,
    });

    exec.context.page.session.browser.runMacrotasks() catch |err| {
        log.warn(.browser, "MessagePort pump", .{ .err = err });
    };
}

fn flushPendingMessages(self: *MessagePort) !void {
    const exec = self._active_exec;
    for (self._pending_messages.items) |message| {
        try self.enqueueMessage(message, exec);
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
    try self.flushPendingDeliveries();
}

pub fn flushPendingDeliveries(self: *MessagePort) !void {
    const exec = self._active_exec;
    const target = self.asEventTarget();

    while (self._pending_deliveries.items.len > 0) {
        if (!exec.hasDirectListeners(target, "message", self._on_message)) {
            break;
        }
        const message = self._pending_deliveries.orderedRemove(0);
        try self.enqueueMessage(message, exec);
    }

    exec.context.page.session.browser.runMacrotasks() catch |err| {
        log.warn(.browser, "MessagePort flush pump", .{ .err = err });
    };
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

        const target = self.port.asEventTarget();
        if (self.exec.hasDirectListeners(target, "message", self.port._on_message)) {
            const event = (MessageEvent.initTrusted(comptime .wrap("message"), .{
                .data = .{ .value = self.message },
                .origin = "",
                .source = null,
            }, self.exec.context.page) catch |err| {
                log.err(.dom, "MessagePort.postMessage", .{ .err = err });
                self.message.release();
                return null;
            }).asEvent();

            self.exec.dispatch(target, event, self.port._on_message, .{ .context = "MessagePort message" }) catch |err| {
                log.err(.dom, "MessagePort.postMessage", .{ .err = err });
            };
        } else {
            try self.port._pending_deliveries.append(self.exec.arena, self.message);
            return null;
        }

        self.exec.context.page.session.browser.runMacrotasks() catch |err| {
            log.warn(.browser, "MessagePort dispatch pump", .{ .err = err });
        };

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
