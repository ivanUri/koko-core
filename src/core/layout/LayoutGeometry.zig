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

pub const Generation = u64;

pub const Error = error{
    InvalidNumber,
    InvalidNodeId,
    InvalidDocumentId,
    NegativeSize,
    InvalidScale,
};

/// An identity allocated by Koko's authoritative DOM.
///
/// This is deliberately not a pointer.  The DOM adapter can keep the value
/// stable while an underlying Zig node moves, and the document component keeps
/// handles from different documents distinct.
pub const NodeId = struct {
    value: u64,

    pub fn init(value: u64) Error!NodeId {
        if (value == 0) return error.InvalidNodeId;
        return .{ .value = value };
    }

    pub fn eql(self: NodeId, other: NodeId) bool {
        return self.value == other.value;
    }
};

/// A document or browsing-context identity.  Zero is reserved for an
/// uninitialized handle so teardown cannot accidentally look like a valid
/// document.
pub const DocumentId = struct {
    value: u64,

    pub fn init(value: u64) Error!DocumentId {
        if (value == 0) return error.InvalidDocumentId;
        return .{ .value = value };
    }

    pub fn eql(self: DocumentId, other: DocumentId) bool {
        return self.value == other.value;
    }
};

pub const NodeHandle = struct {
    document: DocumentId,
    node: NodeId,

    pub fn init(document: DocumentId, node: NodeId) NodeHandle {
        return .{ .document = document, .node = node };
    }

    pub fn eql(self: NodeHandle, other: NodeHandle) bool {
        return self.document.eql(other.document) and self.node.eql(other.node);
    }
};

pub const Viewport = struct {
    width: f64,
    height: f64,
    scroll_x: f64,
    scroll_y: f64,
    device_scale_factor: f64,

    pub fn init(
        width: f64,
        height: f64,
        scroll_x: f64,
        scroll_y: f64,
        device_scale_factor: f64,
    ) Error!Viewport {
        if (!isFinite(width) or !isFinite(height) or !isFinite(scroll_x) or !isFinite(scroll_y)) {
            return error.InvalidNumber;
        }
        if (width < 0 or height < 0) return error.NegativeSize;
        if (!isFinite(device_scale_factor) or device_scale_factor <= 0) {
            return error.InvalidScale;
        }
        return .{
            .width = width,
            .height = height,
            .scroll_x = scroll_x,
            .scroll_y = scroll_y,
            .device_scale_factor = device_scale_factor,
        };
    }

    pub fn eql(self: Viewport, other: Viewport) bool {
        return self.width == other.width and
            self.height == other.height and
            self.scroll_x == other.scroll_x and
            self.scroll_y == other.scroll_y and
            self.device_scale_factor == other.device_scale_factor;
    }
};

pub const Rect = struct {
    x: f64,
    y: f64,
    width: f64,
    height: f64,

    pub fn init(x: f64, y: f64, width: f64, height: f64) Error!Rect {
        if (!isFinite(x) or !isFinite(y) or !isFinite(width) or !isFinite(height)) {
            return error.InvalidNumber;
        }
        if (width < 0 or height < 0) return error.NegativeSize;
        return .{ .x = x, .y = y, .width = width, .height = height };
    }

    pub fn right(self: Rect) f64 {
        return self.x + self.width;
    }

    pub fn bottom(self: Rect) f64 {
        return self.y + self.height;
    }

    pub fn eql(self: Rect, other: Rect) bool {
        return self.x == other.x and self.y == other.y and
            self.width == other.width and self.height == other.height;
    }
};

pub const BoxEdges = struct {
    top: f64,
    right: f64,
    bottom: f64,
    left: f64,

    pub fn init(top: f64, right: f64, bottom: f64, left: f64) Error!BoxEdges {
        if (!isFinite(top) or !isFinite(right) or !isFinite(bottom) or !isFinite(left)) {
            return error.InvalidNumber;
        }
        if (top < 0 or right < 0 or bottom < 0 or left < 0) {
            return error.NegativeSize;
        }
        return .{ .top = top, .right = right, .bottom = bottom, .left = left };
    }
};

/// The four CSS box rectangles and their edge widths.  The rectangles are
/// supplied by the layout engine; this type never derives a missing box from
/// another box, because doing so would fabricate geometry before Taffy has
/// produced a result.
pub const BoxMetrics = struct {
    content_box: Rect,
    padding_box: Rect,
    border_box: Rect,
    margin_box: Rect,
    padding: BoxEdges,
    border: BoxEdges,
    margin: BoxEdges,

    pub fn init(
        content_box: Rect,
        padding_box: Rect,
        border_box: Rect,
        margin_box: Rect,
        padding: BoxEdges,
        border: BoxEdges,
        margin: BoxEdges,
    ) BoxMetrics {
        return .{
            .content_box = content_box,
            .padding_box = padding_box,
            .border_box = border_box,
            .margin_box = margin_box,
            .padding = padding,
            .border = border,
            .margin = margin,
        };
    }

    pub fn eql(self: BoxMetrics, other: BoxMetrics) bool {
        return self.content_box.eql(other.content_box) and
            self.padding_box.eql(other.padding_box) and
            self.border_box.eql(other.border_box) and
            self.margin_box.eql(other.margin_box) and
            std.meta.eql(self.padding, other.padding) and
            std.meta.eql(self.border, other.border) and
            std.meta.eql(self.margin, other.margin);
    }
};

pub const DirtyReason = enum {
    dom,
    style,
    viewport,
    fonts,
};

pub const GenerationToken = struct {
    dom: Generation,
    style: Generation,
    viewport: Generation,
    fonts: Generation,

    pub fn eql(self: GenerationToken, other: GenerationToken) bool {
        return self.dom == other.dom and self.style == other.style and
            self.viewport == other.viewport and self.fonts == other.fonts;
    }
};

/// Monotonic invalidation clocks shared by the DOM, Stylo, viewport, and
/// Parley/font integration points.  A layout snapshot is fresh only when all
/// four clocks match the snapshot token.
pub const DirtyGenerations = struct {
    dom: Generation = 1,
    style: Generation = 1,
    viewport: Generation = 1,
    fonts: Generation = 1,

    pub fn markDirty(self: *DirtyGenerations, reason: DirtyReason) Generation {
        const field = switch (reason) {
            .dom => &self.dom,
            .style => &self.style,
            .viewport => &self.viewport,
            .fonts => &self.fonts,
        };
        field.* = nextGeneration(field.*);
        return field.*;
    }

    pub fn token(self: DirtyGenerations) GenerationToken {
        return .{
            .dom = self.dom,
            .style = self.style,
            .viewport = self.viewport,
            .fonts = self.fonts,
        };
    }
};

fn isFinite(value: f64) bool {
    return std.math.isFinite(value);
}

fn nextGeneration(value: Generation) Generation {
    return if (value == std.math.maxInt(Generation)) 1 else value + 1;
}

test "layout geometry rejects invalid measurements" {
    try std.testing.expectError(error.InvalidNodeId, NodeId.init(0));
    try std.testing.expectError(error.InvalidDocumentId, DocumentId.init(0));
    try std.testing.expectError(error.NegativeSize, Rect.init(0, 0, -1, 1));
    try std.testing.expectError(error.InvalidNumber, Rect.init(std.math.nan(f64), 0, 1, 1));
    try std.testing.expectError(error.InvalidScale, Viewport.init(1, 1, 0, 0, 0));
}

test "dirty generations produce comparable snapshots" {
    var dirty = DirtyGenerations{};
    const first = dirty.token();
    _ = dirty.markDirty(.style);
    const second = dirty.token();
    try std.testing.expect(!first.eql(second));
    try std.testing.expectEqual(@as(Generation, 2), second.style);
    try std.testing.expectEqual(first.dom, second.dom);
}
