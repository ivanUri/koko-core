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
const CDP = @import("../CDP.zig");
const log = @import("../../../support/log.zig");

pub fn processMessage(cmd: *CDP.Command) !void {
    const action = std.meta.stringToEnum(enum {
        dispatchKeyEvent,
        dispatchMouseEvent,
        insertText,
        cancelDragging,
        dispatchTouchEvent,
        setIgnoreInputEvents,
        synthesizeScrollGesture,
    }, cmd.input.action) orelse return error.UnknownMethod;

    switch (action) {
        .dispatchKeyEvent => return dispatchKeyEvent(cmd),
        .dispatchMouseEvent => return dispatchMouseEvent(cmd),
        .insertText => return insertText(cmd),
        .cancelDragging => return cancelDragging(cmd),
        .dispatchTouchEvent => return dispatchTouchEvent(cmd),
        .setIgnoreInputEvents => return setIgnoreInputEvents(cmd),
        .synthesizeScrollGesture => return synthesizeScrollGesture(cmd),
    }
}

// https://chromedevtools.github.io/devtools-protocol/tot/Input/#method-dispatchKeyEvent
fn dispatchKeyEvent(cmd: *CDP.Command) !void {
    const params = (try cmd.params(struct {
        type: Type,
        key: []const u8 = "",
        code: ?[]const u8 = null,
        text: ?[]const u8 = null,
        unmodifiedText: ?[]const u8 = null,
        windowsVirtualKeyCode: ?i32 = null,
        nativeVirtualKeyCode: ?i32 = null,
        modifiers: u4 = 0,
        location: ?u32 = null,
        isKeypad: ?bool = null,

        const Type = enum {
            keyDown,
            keyUp,
            rawKeyDown,
            char,
        };
    })) orelse return error.InvalidParams;

    _ = params.text;
    _ = params.unmodifiedText;
    _ = params.windowsVirtualKeyCode;
    _ = params.nativeVirtualKeyCode;
    _ = params.location;
    _ = params.isKeypad;

    try cmd.sendResult(null, .{});

    // rawKeyDown is a Chrome-internal event type not used for JS dispatch
    if (params.type == .rawKeyDown) return;

    const bc = cmd.browser_context orelse return;
    const frame = bc.session.currentFrame() orelse return;

    const KeyboardEvent = @import("../../../core/webapi/event/KeyboardEvent.zig");
    const keyboard_event = try KeyboardEvent.initTrusted(switch (params.type) {
        .keyDown => comptime .wrap("keydown"),
        .keyUp => comptime .wrap("keyup"),
        .char => comptime .wrap("keypress"),
        .rawKeyDown => unreachable,
    }, .{
        .key = params.key,
        .code = params.code,
        .altKey = params.modifiers & 1 == 1,
        .ctrlKey = params.modifiers & 2 == 2,
        .metaKey = params.modifiers & 4 == 4,
        .shiftKey = params.modifiers & 8 == 8,
    }, frame);
    try frame.triggerKeyboard(keyboard_event);
    // result already sent
}

// https://chromedevtools.github.io/devtools-protocol/tot/Input/#method-dispatchMouseEvent
fn dispatchMouseEvent(cmd: *CDP.Command) !void {
    const params = (try cmd.params(struct {
        x: f64,
        y: f64,
        type: Type,
        button: ?enum { none, left, middle, right, back, forward } = null,
        buttons: ?i32 = null,
        clickCount: ?i32 = null,
        deltaX: ?f64 = null,
        deltaY: ?f64 = null,
        modifiers: ?u4 = null,
        pointerType: ?[]const u8 = null,

        const Type = enum {
            mousePressed,
            mouseReleased,
            mouseMoved,
            mouseWheel,
        };
    })) orelse return error.InvalidParams;

    _ = params.button;
    _ = params.buttons;
    _ = params.clickCount;
    _ = params.modifiers;
    _ = params.pointerType;

    try cmd.sendResult(null, .{});

    const InputController = @import("../../../core/browser/InputController.zig");
    const HumanInput = @import("../../../core/browser/HumanInput.zig");

    switch (params.type) {
        .mouseMoved => {
            const bc = cmd.browser_context orelse return;
            const frame = bc.session.currentFrame() orelse return;
            // Response already sent — avoid hit-test/event dispatch blocking the transport.
            InputController.stashPointerAt(frame, params.x, params.y);
        },
        .mouseWheel => {
            const bc = cmd.browser_context orelse return;
            const frame = bc.session.currentFrame() orelse return;
            const delta_y = params.deltaY orelse 120;
            try HumanInput.wheelScroll(frame, delta_y, .{ .steps = 4, .step_delay_ms = 8 });
        },
        .mousePressed => {
            const bc = cmd.browser_context orelse return;
            const frame = bc.session.currentFrame() orelse return;
            try frame.scheduleCdpMousePress(params.x, params.y);
        },
        .mouseReleased => {
            const bc = cmd.browser_context orelse return;
            const frame = bc.session.currentFrame() orelse return;
            try frame.scheduleCdpMouseRelease(params.x, params.y);
        },
    }
    // result already sent; each mouse half runs on its own scheduler tick
}

// https://chromedevtools.github.io/devtools-protocol/tot/Input/#method-insertText
fn insertText(cmd: *CDP.Command) !void {
    const params = (try cmd.params(struct {
        text: []const u8, // The text to insert
    })) orelse return error.InvalidParams;

    const bc = cmd.browser_context orelse return;
    const frame = bc.session.currentFrame() orelse return;

    try frame.insertText(params.text);

    try cmd.sendResult(null, .{});
}

fn cancelDragging(cmd: *CDP.Command) !void {
    log.warn(.not_implemented, "Input.cancelDragging", .{ .info = "drag controller has no cancellation producer" });
    return cmd.sendResult(null, .{});
}

fn dispatchTouchEvent(cmd: *CDP.Command) !void {
    const params = (try cmd.params(struct {
        type: enum { touchStart, touchMove, touchEnd, touchCancel },
        touchPoints: []const struct {
            x: f64,
            y: f64,
            radiusX: ?f64 = null,
            radiusY: ?f64 = null,
            rotationAngle: ?f64 = null,
            force: ?f64 = null,
            id: ?i32 = null,
        },
        modifiers: ?u8 = null,
    })) orelse return error.InvalidParams;
    _ = params;
    log.warn(.not_implemented, "Input.dispatchTouchEvent", .{ .info = "touch input has no native producer" });
    return cmd.sendResult(null, .{});
}

fn setIgnoreInputEvents(cmd: *CDP.Command) !void {
    const params = (try cmd.params(struct {
        ignore: bool,
    })) orelse return error.InvalidParams;
    _ = params;
    log.warn(.not_implemented, "Input.setIgnoreInputEvents", .{ .info = "input controller has no ignore-state producer" });
    return cmd.sendResult(null, .{});
}

fn synthesizeScrollGesture(cmd: *CDP.Command) !void {
    const params = (try cmd.params(struct {
        gestureSourceType: ?enum { default, touch, mouse } = null,
        x: ?f64 = null,
        y: ?f64 = null,
        xDistance: ?f64 = null,
        yDistance: ?f64 = null,
        xOverscroll: ?f64 = null,
        yOverscroll: ?f64 = null,
        speed: ?i32 = null,
        maxTimeIntoGesture: ?i32 = null,
        preventFling: ?bool = null,
        repeatCount: ?i32 = null,
        repeatDelayMs: ?i32 = null,
        interactionMarkerName: ?[]const u8 = null,
    })) orelse return error.InvalidParams;

    _ = params.gestureSourceType;
    _ = params.x;
    _ = params.y;
    _ = params.xOverscroll;
    _ = params.yOverscroll;
    _ = params.speed;
    _ = params.maxTimeIntoGesture;
    _ = params.preventFling;
    _ = params.repeatCount;
    _ = params.repeatDelayMs;
    _ = params.interactionMarkerName;

    const bc = cmd.browser_context orelse return error.BrowserContextNotLoaded;
    const frame = bc.session.currentFrame() orelse return error.FrameNotLoaded;
    if (params.yDistance) |distance| {
        const next_y = @max(@as(i32, 0), @as(i32, @intCast(frame.window.getScrollY())) + @as(i32, @intFromFloat(-distance)));
        try frame.window.scrollTo(.{ .x = @intCast(frame.window.getScrollX()) }, next_y, frame);
    }
    if (params.xDistance) |distance| {
        const next_x = @max(@as(i32, 0), @as(i32, @intCast(frame.window.getScrollX())) + @as(i32, @intFromFloat(-distance)));
        try frame.window.scrollTo(.{ .x = next_x }, @intCast(frame.window.getScrollY()), frame);
    }
    return cmd.sendResult(null, .{});
}
