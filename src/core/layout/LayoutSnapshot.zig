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
const Geometry = @import("LayoutGeometry.zig");

pub const LayoutSnapshot = @This();

pub const Generation = Geometry.Generation;
pub const NodeId = Geometry.NodeId;
pub const DocumentId = Geometry.DocumentId;
pub const NodeHandle = Geometry.NodeHandle;
pub const Viewport = Geometry.Viewport;
pub const Rect = Geometry.Rect;
pub const BoxEdges = Geometry.BoxEdges;
pub const BoxMetrics = Geometry.BoxMetrics;
pub const DirtyGenerations = Geometry.DirtyGenerations;
pub const DirtyReason = Geometry.DirtyReason;
pub const GenerationToken = Geometry.GenerationToken;

pub const UnsupportedReason = enum {
    not_integrated,
    layout_not_flushed,
    node_not_in_document,
    detached,
    feature_not_supported,
    stale,
};

/// No geometry is exposed in the unsupported branch.  Consumers must handle
/// this state instead of interpreting zero as a real layout result.
pub const State = union(enum) {
    unsupported: UnsupportedReason,
    available: struct {
        metrics: BoxMetrics,
    },
};

pub const FlushRequest = struct {
    node: NodeHandle,
    viewport: Viewport,
    generations: GenerationToken,
};

pub const FlushResult = struct {
    snapshot: LayoutSnapshot,
};

pub const FlushError = error{
    Unsupported,
    InvalidResult,
    StaleResult,
};

pub const FlushFn = *const fn (context: ?*anyopaque, request: FlushRequest) FlushError!FlushResult;

/// A deliberately narrow hook for the future Taffy/Parley coordinator.  The
/// callback is invoked only when the requested snapshot is unsupported or
/// stale; a missing callback returns `Unsupported` and cannot manufacture a
/// rectangle.
pub const FlushHooks = struct {
    context: ?*anyopaque = null,
    flush: ?FlushFn = null,

    pub fn flushIfNeeded(
        self: FlushHooks,
        snapshot: *LayoutSnapshot,
        viewport: Viewport,
        generations: DirtyGenerations,
    ) FlushError!void {
        const current = generations.token();
        if (snapshot.isFresh(viewport, current)) return;

        const callback = self.flush orelse return error.Unsupported;
        const result = try callback(self.context, .{
            .node = snapshot.node,
            .viewport = viewport,
            .generations = current,
        });
        if (!result.snapshot.node.eql(snapshot.node) or
            !result.snapshot.viewport.eql(viewport))
        {
            return error.InvalidResult;
        }
        if (!result.snapshot.generations.eql(current)) return error.StaleResult;
        snapshot.* = result.snapshot;
    }
};

node: NodeHandle,
viewport: Viewport,
generations: GenerationToken,
state: State,

pub fn unsupported(
    node: NodeHandle,
    viewport: Viewport,
    generations: GenerationToken,
    reason: UnsupportedReason,
) LayoutSnapshot {
    return .{
        .node = node,
        .viewport = viewport,
        .generations = generations,
        .state = .{ .unsupported = reason },
    };
}

pub fn available(
    node: NodeHandle,
    viewport: Viewport,
    generations: GenerationToken,
    metrics_value: BoxMetrics,
) LayoutSnapshot {
    return .{
        .node = node,
        .viewport = viewport,
        .generations = generations,
        .state = .{ .available = .{ .metrics = metrics_value } },
    };
}

pub fn isAvailable(self: *const LayoutSnapshot) bool {
    return switch (self.state) {
        .available => true,
        .unsupported => false,
    };
}

pub fn nodeHandle(self: *const LayoutSnapshot) NodeHandle {
    return self.node;
}

pub fn viewportValue(self: *const LayoutSnapshot) Viewport {
    return self.viewport;
}

pub fn generationToken(self: *const LayoutSnapshot) GenerationToken {
    return self.generations;
}

pub fn unsupportedReason(self: *const LayoutSnapshot) ?UnsupportedReason {
    return switch (self.state) {
        .unsupported => |reason| reason,
        .available => null,
    };
}

pub fn metrics(self: *const LayoutSnapshot) ?*const BoxMetrics {
    return switch (self.state) {
        .unsupported => null,
        .available => |*value| &value.metrics,
    };
}

pub fn borderBox(self: *const LayoutSnapshot) ?Rect {
    const value = self.metrics() orelse return null;
    return value.border_box;
}

pub fn isFresh(self: *const LayoutSnapshot, viewport: Viewport, generations: GenerationToken) bool {
    return self.isAvailable() and self.viewport.eql(viewport) and self.generations.eql(generations);
}

test "unsupported snapshots never expose fabricated geometry" {
    const document = try DocumentId.init(1);
    const node = try NodeId.init(2);
    const handle = NodeHandle.init(document, node);
    const viewport = try Viewport.init(800, 600, 0, 0, 1);
    const generations = (DirtyGenerations{}).token();
    const snapshot = LayoutSnapshot.unsupported(handle, viewport, generations, .not_integrated);

    try std.testing.expect(!snapshot.isAvailable());
    try std.testing.expectEqual(UnsupportedReason.not_integrated, snapshot.unsupportedReason().?);
    try std.testing.expect(snapshot.metrics() == null);
    try std.testing.expect(snapshot.borderBox() == null);
}

const FlushContext = struct {
    metrics: BoxMetrics,
    calls: usize = 0,
};

fn flushTest(context: ?*anyopaque, request: FlushRequest) FlushError!FlushResult {
    const state: *FlushContext = @ptrCast(@alignCast(context.?));
    state.calls += 1;
    return .{ .snapshot = LayoutSnapshot.available(
        request.node,
        request.viewport,
        request.generations,
        state.metrics,
    ) };
}

test "flush hook is lazy and only runs for stale snapshots" {
    const document = try DocumentId.init(1);
    const node = try NodeId.init(2);
    const handle = NodeHandle.init(document, node);
    const viewport = try Viewport.init(800, 600, 0, 0, 1);
    const content = try Rect.init(0, 0, 100, 20);
    const edges = try BoxEdges.init(0, 0, 0, 0);
    const box = BoxMetrics.init(content, content, content, content, edges, edges, edges);
    var context = FlushContext{ .metrics = box };
    var snapshot = LayoutSnapshot.unsupported(handle, viewport, (DirtyGenerations{}).token(), .layout_not_flushed);
    var hooks = FlushHooks{ .context = &context, .flush = flushTest };
    var dirty = DirtyGenerations{};

    try hooks.flushIfNeeded(&snapshot, viewport, dirty);
    try std.testing.expect(snapshot.isAvailable());
    try std.testing.expectEqual(@as(usize, 1), context.calls);

    try hooks.flushIfNeeded(&snapshot, viewport, dirty);
    try std.testing.expectEqual(@as(usize, 1), context.calls);

    _ = dirty.markDirty(.style);
    try hooks.flushIfNeeded(&snapshot, viewport, dirty);
    try std.testing.expectEqual(@as(usize, 2), context.calls);
}
