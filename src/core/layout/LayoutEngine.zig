// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published
// by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

const std = @import("std");

const CSession = opaque {};

const CProperty = extern struct {
    name: [*c]const u8,
    name_len: usize,
    value: [*c]const u8,
    value_len: usize,
};

pub const Geometry = extern struct {
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    border_left: f32,
    border_right: f32,
    border_top: f32,
    border_bottom: f32,
    padding_left: f32,
    padding_right: f32,
    padding_top: f32,
    padding_bottom: f32,
    margin_left: f32,
    margin_right: f32,
    margin_top: f32,
    margin_bottom: f32,
};

const StatusCode = i32;
const status_ok: StatusCode = 0;
const status_not_ready: StatusCode = 3;
const status_unsupported: StatusCode = 6;

extern fn koko_layout_session_new() ?*CSession;
extern fn koko_layout_session_free(session: ?*CSession) void;
extern fn koko_layout_session_reset(session: ?*CSession) StatusCode;
extern fn koko_layout_node_new(session: ?*CSession) u64;
extern fn koko_layout_node_free(session: ?*CSession, node: u64) StatusCode;
extern fn koko_layout_node_set_computed_style(
    session: ?*CSession,
    node: u64,
    properties: [*c]const CProperty,
    property_count: u64,
    viewport_width: f32,
    viewport_height: f32,
) StatusCode;
extern fn koko_layout_node_set_text_style(
    session: ?*CSession,
    node: u64,
    properties: [*c]const CProperty,
    property_count: u64,
) StatusCode;
extern fn koko_layout_node_set_text(
    session: ?*CSession,
    node: u64,
    text: [*c]const u8,
    text_len: u64,
) StatusCode;
extern fn koko_layout_append_child(session: ?*CSession, parent: u64, child: u64) StatusCode;
extern fn koko_layout_compute(
    session: ?*CSession,
    root: u64,
    viewport_width: f32,
    viewport_height: f32,
) StatusCode;
extern fn koko_layout_snapshot_batch(
    session: ?*const CSession,
    nodes: [*c]const u64,
    count: u64,
    output: [*c]Geometry,
    output_capacity: u64,
    output_count: *u64,
) StatusCode;
extern fn koko_layout_snapshot_absolute_batch(
    session: ?*const CSession,
    nodes: [*c]const u64,
    count: u64,
    output: [*c]Geometry,
    output_capacity: u64,
    output_count: *u64,
) StatusCode;

pub const Property = struct {
    name: []const u8,
    value: []const u8,
};

pub const Status = enum {
    ok,
    unavailable,
    not_ready,
    unsupported,
    invalid_argument,
    internal_error,

    fn fromCode(code: StatusCode) Status {
        return switch (code) {
            status_ok => .ok,
            status_not_ready => .not_ready,
            status_unsupported => .unsupported,
            1 => .invalid_argument,
            2, 4, 5 => .internal_error,
            else => .internal_error,
        };
    }
};

/// Per-frame owner of a Rust Taffy/Parley session.
///
/// The session stores only Taffy's layout tree and Parley's font contexts.
/// Koko's Zig DOM remains authoritative; callers pass stable node identities
/// and borrowed computed-property bytes for synchronous batch conversion.
pub const LayoutEngine = struct {
    session: ?*CSession = null,
    alive: bool = false,
    generation: u64 = 1,

    pub fn init() LayoutEngine {
        const session = koko_layout_session_new();
        return .{ .session = session, .alive = session != null };
    }

    pub fn deinit(self: *LayoutEngine) void {
        if (!self.alive) return;
        koko_layout_session_free(self.session);
        self.session = null;
        self.alive = false;
        self.generation +%= 1;
        if (self.generation == 0) self.generation = 1;
    }

    pub fn status(self: *const LayoutEngine) Status {
        return if (!self.alive) .unavailable else .ok;
    }

    pub fn invalidate(self: *LayoutEngine) Status {
        if (!self.alive) return .unavailable;
        self.generation +%= 1;
        if (self.generation == 0) self.generation = 1;
        return .ok;
    }

    pub fn reset(self: *LayoutEngine) Status {
        if (!self.alive) return .unavailable;
        const result = Status.fromCode(koko_layout_session_reset(self.session));
        if (result == .ok) {
            self.generation +%= 1;
            if (self.generation == 0) self.generation = 1;
        }
        return result;
    }

    pub fn newNode(self: *LayoutEngine) ?u64 {
        if (!self.alive) return null;
        const node = koko_layout_node_new(self.session);
        return if (node == 0) null else node;
    }

    pub fn freeNode(self: *LayoutEngine, node: u64) Status {
        if (!self.alive or node == 0) return .invalid_argument;
        return Status.fromCode(koko_layout_node_free(self.session, node));
    }

    pub fn appendChild(self: *LayoutEngine, parent: u64, child: u64) Status {
        if (!self.alive or parent == 0 or child == 0) return .invalid_argument;
        return Status.fromCode(koko_layout_append_child(self.session, parent, child));
    }

    pub fn setComputedStyle(
        self: *LayoutEngine,
        node: u64,
        properties: []const Property,
        viewport_width: f32,
        viewport_height: f32,
    ) Status {
        if (!self.alive or node == 0) return .invalid_argument;
        if (!std.math.isFinite(viewport_width) or !std.math.isFinite(viewport_height)) {
            return .invalid_argument;
        }
        var abi: std.ArrayListUnmanaged(CProperty) = .empty;
        defer abi.deinit(std.heap.c_allocator);
        abi.ensureTotalCapacity(std.heap.c_allocator, properties.len) catch return .internal_error;
        for (properties) |property| {
            abi.appendAssumeCapacity(.{
                .name = if (property.name.len == 0) null else property.name.ptr,
                .name_len = property.name.len,
                .value = if (property.value.len == 0) null else property.value.ptr,
                .value_len = property.value.len,
            });
        }
        const pointer: [*c]const CProperty = if (abi.items.len == 0) null else abi.items.ptr;
        return Status.fromCode(koko_layout_node_set_computed_style(
            self.session,
            node,
            pointer,
            properties.len,
            viewport_width,
            viewport_height,
        ));
    }

    /// Apply only text shaping and line-breaking properties. Box properties
    /// remain unchanged, so text leaves do not need a full layout snapshot.
    pub fn setTextStyle(self: *LayoutEngine, node: u64, properties: []const Property) Status {
        if (!self.alive or node == 0) return .invalid_argument;
        var abi: std.ArrayListUnmanaged(CProperty) = .empty;
        defer abi.deinit(std.heap.c_allocator);
        abi.ensureTotalCapacity(std.heap.c_allocator, properties.len) catch return .internal_error;
        for (properties) |property| {
            abi.appendAssumeCapacity(.{
                .name = if (property.name.len == 0) null else property.name.ptr,
                .name_len = property.name.len,
                .value = if (property.value.len == 0) null else property.value.ptr,
                .value_len = property.value.len,
            });
        }
        const pointer: [*c]const CProperty = if (abi.items.len == 0) null else abi.items.ptr;
        return Status.fromCode(koko_layout_node_set_text_style(
            self.session,
            node,
            pointer,
            properties.len,
        ));
    }

    pub fn compute(self: *LayoutEngine, root: u64, viewport_width: f32, viewport_height: f32) Status {
        if (!self.alive or root == 0) return .invalid_argument;
        return Status.fromCode(koko_layout_compute(self.session, root, viewport_width, viewport_height));
    }

    pub fn setText(self: *LayoutEngine, node: u64, text: []const u8) Status {
        if (!self.alive or node == 0) return .invalid_argument;
        const pointer: [*c]const u8 = if (text.len == 0) null else text.ptr;
        return Status.fromCode(koko_layout_node_set_text(self.session, node, pointer, text.len));
    }

    pub fn snapshot(self: *const LayoutEngine, nodes: []const u64, output: []Geometry) Status {
        if (!self.alive or output.len < nodes.len) return .invalid_argument;
        var count: u64 = 0;
        const node_ptr: [*c]const u64 = if (nodes.len == 0) null else nodes.ptr;
        const output_ptr: [*c]Geometry = if (nodes.len == 0) null else output.ptr;
        const result_code = koko_layout_snapshot_batch(
            self.session,
            node_ptr,
            nodes.len,
            output_ptr,
            output.len,
            &count,
        );
        if (result_code != status_ok) return Status.fromCode(result_code);
        return if (count == nodes.len) .ok else .internal_error;
    }

    /// Snapshot coordinates accumulated through Taffy parents up to the root.
    /// The result is root/document-tree space; window scrolling, transforms,
    /// and iframe offsets are applied by the Zig coordinator.
    pub fn snapshotAbsolute(self: *const LayoutEngine, nodes: []const u64, output: []Geometry) Status {
        if (!self.alive or output.len < nodes.len) return .invalid_argument;
        var count: u64 = 0;
        const node_ptr: [*c]const u64 = if (nodes.len == 0) null else nodes.ptr;
        const output_ptr: [*c]Geometry = if (nodes.len == 0) null else output.ptr;
        const result_code = koko_layout_snapshot_absolute_batch(
            self.session,
            node_ptr,
            nodes.len,
            output_ptr,
            output.len,
            &count,
        );
        if (result_code != status_ok) return Status.fromCode(result_code);
        return if (count == nodes.len) .ok else .internal_error;
    }
};

test "layout engine reports unavailable after teardown" {
    var engine = LayoutEngine.init();
    if (engine.alive) {
        engine.deinit();
        try std.testing.expectEqual(Status.unavailable, engine.status());
        try std.testing.expectEqual(Status.unavailable, engine.invalidate());
    }
}
