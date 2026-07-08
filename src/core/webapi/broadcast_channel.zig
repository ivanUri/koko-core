// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

const std = @import("std");

const js = @import("../js/js.zig");
const Frame = @import("../browser/Frame.zig");
const Page = @import("../browser/Page.zig");
const EventManagerBase = @import("../browser/EventManagerBase.zig");

const EventTarget = @import("EventTarget.zig");
const MessageEvent = @import("event/MessageEvent.zig");
const WorkerGlobalScope = @import("WorkerGlobalScope.zig");

const log = @import("../../support/log.zig");

pub fn registerTypes() []const type {
    return &.{BroadcastChannel};
}

pub const BroadcastChannel = struct {
    _proto: *EventTarget,
    _page: *Page,
    _name: []const u8,
    _registry_key: []const u8,
    _origin_key: []const u8,
    _context: ContextRef,
    _closed: bool = false,
    _on_message: ?js.Function.Global = null,
    _on_messageerror: ?js.Function.Global = null,

    const ContextRef = union(enum) {
        frame: *Frame,
        worker: *WorkerGlobalScope,
    };

    pub fn constructor(name: []const u8, exec: *const js.Execution) !*BroadcastChannel {
        const ctx = exec.context;
        const page = ctx.page;
        const owned_name = try page.frame_arena.dupe(u8, name);
        const registry_key = try page.broadcastChannelRegistryKey(ctx.origin.key, owned_name);

        const context_ref: ContextRef = switch (ctx.global) {
            .frame => |f| .{ .frame = f },
            .worker => |w| .{ .worker = w },
        };

        const factory_frame = switch (context_ref) {
            .frame => |f| f,
            .worker => |w| w._worker._frame,
        };

        const channel = try factory_frame._factory.eventTarget(BroadcastChannel{
            ._proto = undefined,
            ._page = page,
            ._name = owned_name,
            ._registry_key = registry_key,
            ._origin_key = ctx.origin.key,
            ._context = context_ref,
        });

        try page.registerBroadcastChannel(channel);
        return channel;
    }

    pub fn asEventTarget(self: *BroadcastChannel) *EventTarget {
        return self._proto;
    }

    pub fn registryKey(self: *const BroadcastChannel) []const u8 {
        return self._registry_key;
    }

    pub fn getName(self: *const BroadcastChannel) []const u8 {
        return self._name;
    }

    pub fn postMessage(self: *BroadcastChannel, message: js.Value.Temp, exec: *const js.Execution) !void {
        if (self._closed) return;

        const list = self._page.broadcast_channels.get(self._registry_key) orelse return;
        const sender_origin = exec.context.origin.key;

        for (list.items) |receiver| {
            if (receiver == self or receiver._closed) continue;
            try receiver.scheduleMessage(message, sender_origin);
        }
    }

    pub fn close(self: *BroadcastChannel) void {
        if (self._closed) return;
        self._closed = true;
        self._page.unregisterBroadcastChannel(self);
    }

    pub fn getOnMessage(self: *const BroadcastChannel) ?js.Function.Global {
        return self._on_message;
    }

    pub fn setOnMessage(self: *BroadcastChannel, cb: ?js.Function.Global) void {
        self._on_message = cb;
    }

    pub fn getOnMessageError(self: *const BroadcastChannel) ?js.Function.Global {
        return self._on_messageerror;
    }

    pub fn setOnMessageError(self: *BroadcastChannel, cb: ?js.Function.Global) void {
        self._on_messageerror = cb;
    }

    fn scheduleMessage(self: *BroadcastChannel, source: js.Value.Temp, sender_origin: []const u8) !void {
        const cloned = self.cloneMessage(source) catch |err| {
            try self.dispatchMessageError(err);
            return;
        };
        errdefer cloned.release();

        if (!self.hasListeners("message", self._on_message)) return;

        const callback = try self.ownerFrame()._factory.create(DeliverCallback{
            .channel = self,
            .message = cloned,
            .sender_origin = sender_origin,
        });

        try self.getScheduler().add(callback, DeliverCallback.run, 0, .{
            .name = "BroadcastChannel.postMessage",
            .low_priority = false,
        });
    }

    fn cloneMessage(self: *BroadcastChannel, message: js.Value.Temp) !js.Value.Temp {
        var ls: js.Local.Scope = undefined;
        self.getJsContext().localScope(&ls);
        defer ls.deinit();

        const cloned = try message.local(&ls.local).structuredCloneTo(&ls.local, null);
        return try cloned.temp();
    }

    fn dispatchMessageError(self: *BroadcastChannel, err: anyerror) !void {
        const target = self.asEventTarget();
        if (!self.hasListeners("messageerror", self._on_messageerror)) return;

        const event = (try MessageEvent.initTrusted(comptime .wrap("messageerror"), .{
            .data = .{ .string = @errorName(err) },
            .origin = self._origin_key,
        }, self._page)).asEvent();

        try self.dispatchDirect(target, event, self._on_messageerror, .{ .context = "BroadcastChannel.messageerror" });
    }

    fn deliverMessage(self: *BroadcastChannel, message: js.Value.Temp, sender_origin: []const u8) !void {
        if (self._closed) return;

        const target = self.asEventTarget();
        if (!self.hasListeners("message", self._on_message)) return;

        const event = (try MessageEvent.initTrusted(comptime .wrap("message"), .{
            .data = .{ .value = message },
            .origin = sender_origin,
        }, self._page)).asEvent();

        try self.dispatchDirect(target, event, self._on_message, .{ .context = "BroadcastChannel.message" });
    }

    fn hasListeners(self: *BroadcastChannel, comptime typ: []const u8, handler: anytype) bool {
        const target = self.asEventTarget();
        return switch (self._context) {
            .frame => |f| f._event_manager.hasDirectListeners(target, typ, handler),
            .worker => |w| w._event_manager.hasDirectListeners(target, typ, handler),
        };
    }

    fn dispatchDirect(self: *BroadcastChannel, target: *EventTarget, event: *@import("Event.zig"), handler: anytype, comptime opts: EventManagerBase.DispatchDirectOptions) !void {
        switch (self._context) {
            .frame => |f| try f._event_manager.dispatchDirect(target, event, handler, opts),
            .worker => |w| try w._event_manager.dispatchDirect(w.call_arena, w.js, target, event, handler, w._page, opts),
        }
    }

    fn ownerFrame(self: *BroadcastChannel) *Frame {
        return switch (self._context) {
            .frame => |f| f,
            .worker => |w| w._worker._frame,
        };
    }

    fn getJsContext(self: *BroadcastChannel) *js.Context {
        return switch (self._context) {
            .frame => |f| f.js,
            .worker => |w| w.js,
        };
    }

    fn getScheduler(self: *BroadcastChannel) *@import("../js/Scheduler.zig") {
        return switch (self._context) {
            .frame => |f| &f.js.scheduler,
            .worker => |w| &w.js.scheduler,
        };
    }

    const DeliverCallback = struct {
        channel: *BroadcastChannel,
        message: js.Value.Temp,
        sender_origin: []const u8,

        fn run(ctx: *anyopaque) !?u32 {
            const self: *DeliverCallback = @ptrCast(@alignCast(ctx));
            defer self.deinit();
            try self.channel.deliverMessage(self.message, self.sender_origin);
            return null;
        }

        fn deinit(self: *DeliverCallback) void {
            self.message.release();
            self.channel.ownerFrame()._factory.destroy(self);
        }
    };

    pub const JsApi = struct {
        pub const bridge = js.Bridge(BroadcastChannel);
        pub const Meta = struct {
            pub const name = "BroadcastChannel";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
        };
        pub const constructor = bridge.constructor(BroadcastChannel.constructor, .{});
        pub const name = bridge.accessor(BroadcastChannel.getName, null, .{});
        pub const postMessage = bridge.function(BroadcastChannel.postMessage, .{});
        pub const close = bridge.function(BroadcastChannel.close, .{});
        pub const onmessage = bridge.accessor(BroadcastChannel.getOnMessage, BroadcastChannel.setOnMessage, .{});
        pub const onmessageerror = bridge.accessor(BroadcastChannel.getOnMessageError, BroadcastChannel.setOnMessageError, .{});
    };
};
