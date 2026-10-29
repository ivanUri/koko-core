// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

const std = @import("std");

/// Normalize the Canvas 2D line dash sequence once at the Web API boundary.
///
/// The HTML canvas algorithm rejects negative/non-finite entries and repeats
/// odd-length sequences so callers can store a canonical pattern. The caller
/// owns the returned memory through the supplied arena.
pub fn normalize(allocator: std.mem.Allocator, segments: []const f64) ![]const f64 {
    for (segments) |segment| {
        if (!std.math.isFinite(segment) or segment < 0.0) return error.IndexSizeError;
    }

    if (segments.len == 0) return &.{};

    const length = if (segments.len % 2 == 0)
        segments.len
    else
        std.math.mul(usize, segments.len, 2) catch return error.IndexSizeError;
    const normalized = try allocator.alloc(f64, length);
    @memcpy(normalized[0..segments.len], segments);
    if (length != segments.len) @memcpy(normalized[segments.len..], segments);
    return normalized;
}

test "Canvas line dash normalization repeats odd patterns" {
    const allocator = std.testing.allocator;
    const normalized = try normalize(allocator, &.{ 4.0, 2.0, 1.0 });
    defer allocator.free(normalized);
    try std.testing.expectEqualSlices(f64, &.{ 4.0, 2.0, 1.0, 4.0, 2.0, 1.0 }, normalized);
}

test "Canvas line dash normalization rejects invalid segments" {
    try std.testing.expectError(error.IndexSizeError, normalize(std.testing.allocator, &.{-1.0}));
    try std.testing.expectError(error.IndexSizeError, normalize(std.testing.allocator, &.{std.math.nan(f64)}));
}
