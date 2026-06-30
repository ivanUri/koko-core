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

pub fn processMessage(cmd: *CDP.Command) !void {
    const action = std.meta.stringToEnum(enum {
        dispatchKeyEvent,
        dispatchMouseEvent,
        insertText,
    }, cmd.input.action) orelse return error.UnknownMethod;

    switch (action) {
        .dispatchKeyEvent => return dispatchKeyEvent(cmd),
        .dispatchMouseEvent => return dispatchMouseEvent(cmd),
        .insertText => return insertText(cmd),
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
            frame.stashCdpMousePress(params.x, params.y);
        },
        .mouseReleased => {
            const bc = cmd.browser_context orelse return;
            const frame = bc.session.currentFrame() orelse return;
            try frame.scheduleCdpMouseRelease(params.x, params.y);
        },
    }
    // result already sent; press/release run on the next scheduler tick
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
