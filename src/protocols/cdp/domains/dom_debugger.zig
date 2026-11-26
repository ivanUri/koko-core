// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

const std = @import("std");

const CDP = @import("../CDP.zig");
const Node = @import("../Node.zig");
const DOMNode = @import("../../../core/dom/Node.zig");
const js = @import("../../../core/js/js.zig");
const String = @import("../../../support/string.zig").String;

pub fn processMessage(cmd: *CDP.Command) !void {
    const action = std.meta.stringToEnum(enum {
        getEventListeners,
        removeDOMBreakpoint,
        removeEventListenerBreakpoint,
        removeXHRBreakpoint,
        setDOMBreakpoint,
        setEventListenerBreakpoint,
        setXHRBreakpoint,
    }, cmd.input.action) orelse return error.UnknownMethod;

    switch (action) {
        .getEventListeners => return getEventListeners(cmd),
        .removeDOMBreakpoint => return removeDOMBreakpoint(cmd),
        .removeEventListenerBreakpoint => return removeEventListenerBreakpoint(cmd),
        .removeXHRBreakpoint => return removeXHRBreakpoint(cmd),
        .setDOMBreakpoint => return setDOMBreakpoint(cmd),
        .setEventListenerBreakpoint => return setEventListenerBreakpoint(cmd),
        .setXHRBreakpoint => return setXHRBreakpoint(cmd),
    }
}

// These breakpoint commands are control-plane state for a debugger client.
// Koko's execution backend does not currently expose debugger pause hooks for
// DOM/XHR/event-listener mutations, so accepting the command must not imply a
// fabricated pause event. The actual mutation hooks remain a separate core
// integration point.
fn setDOMBreakpoint(cmd: *CDP.Command) !void {
    _ = (try cmd.params(struct {
        nodeId: Node.Id,
        type: []const u8,
    })) orelse return error.InvalidParams;
    return cmd.sendResult(null, .{});
}

fn removeDOMBreakpoint(cmd: *CDP.Command) !void {
    _ = (try cmd.params(struct {
        nodeId: Node.Id,
        type: []const u8,
    })) orelse return error.InvalidParams;
    return cmd.sendResult(null, .{});
}

fn setEventListenerBreakpoint(cmd: *CDP.Command) !void {
    _ = (try cmd.params(struct {
        eventName: []const u8,
        targetName: ?[]const u8 = null,
    })) orelse return error.InvalidParams;
    return cmd.sendResult(null, .{});
}

fn removeEventListenerBreakpoint(cmd: *CDP.Command) !void {
    _ = (try cmd.params(struct {
        eventName: []const u8,
        targetName: ?[]const u8 = null,
    })) orelse return error.InvalidParams;
    return cmd.sendResult(null, .{});
}

fn setXHRBreakpoint(cmd: *CDP.Command) !void {
    _ = (try cmd.params(struct {
        url: []const u8,
    })) orelse return error.InvalidParams;
    return cmd.sendResult(null, .{});
}

fn removeXHRBreakpoint(cmd: *CDP.Command) !void {
    _ = (try cmd.params(struct {
        url: []const u8,
    })) orelse return error.InvalidParams;
    return cmd.sendResult(null, .{});
}

const RemoteObject = struct {
    type: []const u8,
    subtype: ?[]const u8 = null,
    className: ?[]const u8 = null,
    description: ?[]const u8 = null,
    objectId: ?[]const u8 = null,
};

const EventListener = struct {
    type: []const u8,
    useCapture: bool,
    passive: bool,
    once: bool,
    handler: ?RemoteObject = null,
    originalHandler: ?RemoteObject = null,
};

fn getEventListeners(cmd: *CDP.Command) !void {
    const params = (try cmd.params(struct {
        objectId: []const u8,
        depth: ?i32 = null,
        pierce: ?bool = null,
    })) orelse return error.InvalidParams;
    _ = params.depth;
    _ = params.pierce;

    const bc = cmd.browser_context orelse return error.BrowserContextNotLoaded;
    const frame = bc.session.currentFrame() orelse return error.FrameNotLoaded;
    const node = try nodeFromObjectId(cmd, bc, frame, params.objectId);

    var count: usize = 0;
    var iterator = frame._event_manager.base.lookup.iterator();
    while (iterator.next()) |entry| {
        if (entry.key_ptr.*.event_target != @intFromPtr(node.asEventTarget())) continue;
        var listeners = entry.value_ptr.*.*.first;
        while (listeners) |item| : (listeners = item.next) {
            const listener: *const @import("../../../core/browser/EventManagerBase.zig").Listener = @alignCast(@fieldParentPtr("node", item));
            if (!listener.removed) count += 1;
        }
    }

    const listeners = try cmd.arena.alloc(EventListener, count);
    var index: usize = 0;
    iterator = frame._event_manager.base.lookup.iterator();
    while (iterator.next()) |entry| {
        if (entry.key_ptr.*.event_target != @intFromPtr(node.asEventTarget())) continue;
        var item = entry.value_ptr.*.*.first;
        while (item) |current| : (item = current.next) {
            const listener: *const @import("../../../core/browser/EventManagerBase.zig").Listener = @alignCast(@fieldParentPtr("node", current));
            if (listener.removed) continue;
            const handler = try remoteHandler(cmd, bc, frame, listener);
            listeners[index] = .{
                .type = listener.typ.str(),
                .useCapture = listener.capture,
                .passive = listener.passive,
                .once = listener.once,
                .handler = handler,
                .originalHandler = handler,
            };
            index += 1;
        }
    }

    return cmd.sendResult(.{ .listeners = listeners }, .{});
}

fn nodeFromObjectId(cmd: *CDP.Command, bc: *CDP.BrowserContext, frame: *@import("../../../core/browser/Frame.zig"), object_id: []const u8) !*DOMNode {
    var scope: js.Local.Scope = undefined;
    frame.js.localScope(&scope);
    defer scope.deinit();
    const ptr = try bc.inspector_session.getNodePtr(cmd.arena, object_id, &scope.local);
    return @ptrCast(@alignCast(ptr));
}

fn remoteHandler(
    cmd: *CDP.Command,
    bc: *CDP.BrowserContext,
    frame: *@import("../../../core/browser/Frame.zig"),
    listener: *const @import("../../../core/browser/EventManagerBase.zig").Listener,
) !?RemoteObject {
    var scope: js.Local.Scope = undefined;
    frame.js.localScope(&scope);
    defer scope.deinit();

    var remote: js.Inspector.RemoteObject = switch (listener.function) {
        .value => |global| blk: {
            const func = global.localOrNull(&scope.local) orelse return null;
            break :blk try bc.inspector_session.getRemoteObject(&scope.local, "", func);
        },
        .object => |global| try bc.inspector_session.getRemoteObject(&scope.local, "", global.local(&scope.local)),
        .string => return null,
    };
    defer remote.deinit();

    return .{
        .type = try remote.getType(cmd.arena),
        .subtype = try remote.getSubtype(cmd.arena),
        .className = try remote.getClassName(cmd.arena),
        .description = try remote.getDescription(cmd.arena),
        .objectId = try remote.getObjectId(cmd.arena),
    };
}
