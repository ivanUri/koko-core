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
const color = @import("../../browser/color.zig");

/// Pixel buffer for canvas rendering.
/// Stores RGBA pixels in row-major order.
pub const PixelBuffer = struct {
    width: u32,
    height: u32,
    pixels: []u8, // RGBA format, 4 bytes per pixel
    allocator: std.mem.Allocator,

    /// Initialize a new pixel buffer with given dimensions.
    pub fn init(width: u32, height: u32, allocator: std.mem.Allocator) !*PixelBuffer {
        const pixel_count = width * height;
        const byte_count = pixel_count * 4; // RGBA = 4 bytes per pixel

        const pixels = try allocator.alloc(u8, byte_count);

        const buffer = try allocator.create(PixelBuffer);
        buffer.* = .{
            .width = width,
            .height = height,
            .pixels = pixels,
            .allocator = allocator,
        };

        return buffer;
    }

    /// Free the pixel buffer.
    pub fn deinit(self: *PixelBuffer) void {
        self.allocator.free(self.pixels);
        self.allocator.destroy(self);
    }

    /// Clear the entire buffer with a single color.
    pub fn clear(self: *PixelBuffer, rgba: color.RGBA) void {
        const r = rgba.r;
        const g = rgba.g;
        const b = rgba.b;
        const a = rgba.a;

        var i: usize = 0;
        while (i < self.pixels.len) : (i += 4) {
            self.pixels[i] = r;
            self.pixels[i + 1] = g;
            self.pixels[i + 2] = b;
            self.pixels[i + 3] = a;
        }
    }

    /// Set a single pixel at (x, y).
    pub fn setPixel(self: *PixelBuffer, x: u32, y: u32, rgba: color.RGBA) void {
        if (x >= self.width or y >= self.height) return;

        const index = (y * self.width + x) * 4;
        self.pixels[index] = rgba.r;
        self.pixels[index + 1] = rgba.g;
        self.pixels[index + 2] = rgba.b;
        self.pixels[index + 3] = rgba.a;
    }

    /// Get a single pixel at (x, y).
    pub fn getPixel(self: *const PixelBuffer, x: u32, y: u32) color.RGBA {
        if (x >= self.width or y >= self.height) {
            return color.RGBA.Named.transparent;
        }

        const index = (y * self.width + x) * 4;
        return .{
            .r = self.pixels[index],
            .g = self.pixels[index + 1],
            .b = self.pixels[index + 2],
            .a = self.pixels[index + 3],
        };
    }

    /// Fill a rectangle with a color.
    /// Handles alpha blending if the fill color has alpha < 255.
    pub fn fillRect(self: *PixelBuffer, x: f64, y: f64, w: f64, h: f64, rgba: color.RGBA) void {
        // Convert float coordinates to integers
        const x0 = @as(i32, @intFromFloat(@floor(x)));
        const y0 = @as(i32, @intFromFloat(@floor(y)));
        const x1 = @as(i32, @intFromFloat(@floor(x + w)));
        const y1 = @as(i32, @intFromFloat(@floor(y + h)));

        // Clamp to buffer bounds
        const start_x = @max(0, x0);
        const start_y = @max(0, y0);
        const end_x = @min(@as(i32, @intCast(self.width)), x1);
        const end_y = @min(@as(i32, @intCast(self.height)), y1);

        if (start_x >= end_x or start_y >= end_y) return;

        // Fast path: opaque fill (no blending needed)
        if (rgba.a == 255) {
            var py: i32 = start_y;
            while (py < end_y) : (py += 1) {
                var px: i32 = start_x;
                while (px < end_x) : (px += 1) {
                    self.setPixel(@intCast(px), @intCast(py), rgba);
                }
            }
            return;
        }

        // Slow path: alpha blending
        const src_alpha = @as(f32, @floatFromInt(rgba.a)) / 255.0;
        const inv_alpha = 1.0 - src_alpha;

        var py: i32 = start_y;
        while (py < end_y) : (py += 1) {
            var px: i32 = start_x;
            while (px < end_x) : (px += 1) {
                const dst = self.getPixel(@intCast(px), @intCast(py));

                // Alpha compositing: src over dst
                const r = @as(u8, @intFromFloat(@as(f32, @floatFromInt(rgba.r)) * src_alpha + @as(f32, @floatFromInt(dst.r)) * inv_alpha));
                const g = @as(u8, @intFromFloat(@as(f32, @floatFromInt(rgba.g)) * src_alpha + @as(f32, @floatFromInt(dst.g)) * inv_alpha));
                const b = @as(u8, @intFromFloat(@as(f32, @floatFromInt(rgba.b)) * src_alpha + @as(f32, @floatFromInt(dst.b)) * inv_alpha));
                const a = @as(u8, @intFromFloat(@min(255.0, @as(f32, @floatFromInt(rgba.a)) + @as(f32, @floatFromInt(dst.a)) * inv_alpha)));

                self.setPixel(@intCast(px), @intCast(py), .{ .r = r, .g = g, .b = b, .a = a });
            }
        }
    }

    /// Clear a rectangle (transparent, no alpha blending).
    pub fn clearRect(self: *PixelBuffer, x: f64, y: f64, w: f64, h: f64) void {
        const x0 = @as(i32, @intFromFloat(@floor(x)));
        const y0 = @as(i32, @intFromFloat(@floor(y)));
        const x1 = @as(i32, @intFromFloat(@floor(x + w)));
        const y1 = @as(i32, @intFromFloat(@floor(y + h)));

        const start_x = @max(0, x0);
        const start_y = @max(0, y0);
        const end_x = @min(@as(i32, @intCast(self.width)), x1);
        const end_y = @min(@as(i32, @intCast(self.height)), y1);

        if (start_x >= end_x or start_y >= end_y) return;

        const transparent = color.RGBA.Named.transparent;
        var py: i32 = start_y;
        while (py < end_y) : (py += 1) {
            var px: i32 = start_x;
            while (px < end_x) : (px += 1) {
                self.setPixel(@intCast(px), @intCast(py), transparent);
            }
        }
    }
};

const testing = @import("../../../testing/testing.zig");

test "PixelBuffer: create and clear" {
    const allocator = testing.allocator;

    const buffer = try PixelBuffer.init(10, 10, allocator);
    defer buffer.deinit();

    try testing.expectEqual(@as(u32, 10), buffer.width);
    try testing.expectEqual(@as(u32, 10), buffer.height);
    try testing.expectEqual(@as(usize, 400), buffer.pixels.len); // 10*10*4

    // Clear to red
    buffer.clear(color.RGBA{ .r = 255, .g = 0, .b = 0, .a = 255 });

    // Check first pixel
    const pixel = buffer.getPixel(0, 0);
    try testing.expectEqual(@as(u8, 255), pixel.r);
    try testing.expectEqual(@as(u8, 0), pixel.g);
    try testing.expectEqual(@as(u8, 0), pixel.b);
    try testing.expectEqual(@as(u8, 255), pixel.a);
}

test "PixelBuffer: setPixel and getPixel" {
    const allocator = testing.allocator;

    const buffer = try PixelBuffer.init(5, 5, allocator);
    defer buffer.deinit();

    buffer.clear(color.RGBA.Named.transparent);

    // Set a blue pixel at (2, 3)
    buffer.setPixel(2, 3, color.RGBA{ .r = 0, .g = 0, .b = 255, .a = 255 });

    const pixel = buffer.getPixel(2, 3);
    try testing.expectEqual(@as(u8, 0), pixel.r);
    try testing.expectEqual(@as(u8, 0), pixel.g);
    try testing.expectEqual(@as(u8, 255), pixel.b);
    try testing.expectEqual(@as(u8, 255), pixel.a);

    // Check out of bounds returns transparent
    const oob = buffer.getPixel(100, 100);
    try testing.expectEqual(@as(u8, 0), oob.a);
}

test "PixelBuffer: fillRect opaque" {
    const allocator = testing.allocator;

    const buffer = try PixelBuffer.init(10, 10, allocator);
    defer buffer.deinit();

    buffer.clear(color.RGBA.Named.white);

    // Fill a 3x3 red rectangle at (2, 2)
    buffer.fillRect(2.0, 2.0, 3.0, 3.0, color.RGBA{ .r = 255, .g = 0, .b = 0, .a = 255 });

    // Check inside the rectangle
    const inside = buffer.getPixel(3, 3);
    try testing.expectEqual(@as(u8, 255), inside.r);

    // Check outside the rectangle
    const outside = buffer.getPixel(0, 0);
    try testing.expectEqual(@as(u8, 255), outside.r);
    try testing.expectEqual(@as(u8, 255), outside.g);
    try testing.expectEqual(@as(u8, 255), outside.b);
}

test "PixelBuffer: clearRect" {
    const allocator = testing.allocator;

    const buffer = try PixelBuffer.init(10, 10, allocator);
    defer buffer.deinit();

    buffer.clear(color.RGBA{ .r = 100, .g = 100, .b = 100, .a = 255 });

    // Clear a rectangle
    buffer.clearRect(2.0, 2.0, 3.0, 3.0);

    // Check cleared area is transparent
    const cleared = buffer.getPixel(3, 3);
    try testing.expectEqual(@as(u8, 0), cleared.a);

    // Check outside is still gray
    const outside = buffer.getPixel(0, 0);
    try testing.expectEqual(@as(u8, 100), outside.r);
}
