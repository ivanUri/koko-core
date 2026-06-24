const std = @import("std");
const builtin = @import("builtin");

const Frame = @import("../browser/Frame.zig");
const color = @import("../browser/color.zig");
const PixelBuffer = @import("../webapi/canvas/PixelBuffer.zig").PixelBuffer;

extern fn velora_canvas_fill_text(
    pixels: [*]u8,
    width: u32,
    height: u32,
    text: [*:0]const u8,
    x: f64,
    y: f64,
    font_size: f64,
    font_family: [*:0]const u8,
    r: u8,
    g: u8,
    b: u8,
    a: u8,
) bool;

pub fn useNativeText(frame: *const Frame) bool {
    if (frame.loadedProfile().mode != .antidetect) return false;
    return builtin.os.tag == .macos;
}

pub fn parseFont(font: []const u8) struct { size: f64, family: []const u8 } {
    var size: f64 = 10;
    var family: []const u8 = "sans-serif";

    const trimmed = std.mem.trim(u8, font, " \t\r\n");
    if (std.mem.indexOf(u8, trimmed, "px")) |px| {
        const num = std.mem.trim(u8, trimmed[0..px], " \t");
        size = std.fmt.parseFloat(f64, num) catch size;
        const rest = std.mem.trim(u8, trimmed[px + 2 ..], " \t");
        if (rest.len > 0) family = rest;
    }

    return .{ .size = size, .family = family };
}

pub fn fillText(
    buffer: *PixelBuffer,
    text: []const u8,
    x: f64,
    y: f64,
    font: []const u8,
    fill_style: color.RGBA,
    frame: *Frame,
) !void {
    if (comptime builtin.os.tag != .macos) return error.UnsupportedPlatform;

    const parsed = parseFont(font);
    const family_z = try frame.call_arena.dupeZ(u8, parsed.family);
    const text_z = try frame.call_arena.dupeZ(u8, text);

    const ok = velora_canvas_fill_text(
        buffer.pixels.ptr,
        buffer.width,
        buffer.height,
        text_z,
        x,
        y,
        parsed.size,
        family_z,
        fill_style.r,
        fill_style.g,
        fill_style.b,
        fill_style.a,
    );
    if (!ok) return error.NativeCanvasTextFailed;
}

const testing = @import("../../testing/testing.zig");

test "NativeCanvas: parseFont" {
    const p = parseFont("14px Arial");
    try testing.expectEqual(@as(f64, 14), p.size);
    try testing.expect(std.mem.eql(u8, "Arial", p.family));
}
