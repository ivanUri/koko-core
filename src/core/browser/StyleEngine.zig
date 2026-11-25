// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published
// by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

const std = @import("std");
const Abi = @import("style_engine/abi.zig");

/// Per-Frame owner of the Stylo bridge handle.
///
/// The public API uses stable node IDs rather than DOM pointers.  A future
/// Frame adapter can translate Koko's stable DOM identity to these IDs without
/// making the C ABI depend on Zig's internal DOM layout.
pub const StyleEngine = struct {
    const Self = @This();

    pub const AbiApi = Abi.Api;
    pub const FrameId = Abi.FrameId;
    pub const NodeId = Abi.NodeId;
    pub const Generation = Abi.Generation;

    pub const DomInvalidationKind = enum(u32) {
        subtree = 0,
        attributes = 1,
        text = 2,
        node_inserted = 3,
        node_removed = 4,
        document = 5,
    };

    pub const Status = enum {
        ready,
        ok,
        bridge_unavailable,
        bridge_unsupported,
        bridge_not_ready,
        bridge_error,
        out_of_memory,
        invalid_argument,
        stale_generation,
        output_buffer_too_small,
        closed,
    };

    pub const InitOptions = struct {
        frame_id: FrameId,
        bridge: ?*const AbiApi = null,
    };

    /// String queries write into caller-owned storage.  `bytes_written` is
    /// non-zero only for a successful query or `output_buffer_too_small`.
    /// The caller may inspect `output[0..bytes_written]` only when status is
    /// `.ok`; the bridge never owns that memory.
    pub const QueryResult = struct {
        status: Status,
        bytes_written: usize = 0,

        pub fn isOk(self: QueryResult) bool {
            return self.status == .ok;
        }
    };

    /// A CSS boolean is optional because false and unavailable are different
    /// states.  `value` is non-null only when `status == .ok`.
    pub const BoolResult = struct {
        status: Status,
        value: ?bool = null,

        pub fn isOk(self: BoolResult) bool {
            return self.status == .ok;
        }
    };

    pub const FlushResult = struct {
        status: Status,
        generation: Generation = 0,
        changed_node_count: usize = 0,
    };

    frame_id: FrameId,
    generation_value: Generation = 1,
    api: ?AbiApi = null,
    engine: ?*anyopaque = null,
    availability: Status,
    alive: bool = true,

    pub fn init(options: InitOptions) StyleEngine {
        var self = StyleEngine{
            .frame_id = options.frame_id,
            .availability = if (options.bridge == null) .bridge_unavailable else .ready,
        };

        const bridge = options.bridge orelse return self;
        self.api = bridge.*;
        if (self.api.?.abi_version != Abi.abi_version) {
            self.availability = .bridge_unsupported;
            self.api = null;
            return self;
        }

        const create = self.api.?.create orelse {
            self.availability = .bridge_unsupported;
            self.api = null;
            return self;
        };

        var handle: ?*anyopaque = null;
        const code = create(self.api.?.user_data, self.frame_id, &handle);
        if (code != Abi.status_ok or handle == null) {
            self.availability = mapStatus(code);
            if (code == Abi.status_ok) self.availability = .bridge_error;
            self.api = null;
            return self;
        }

        self.engine = handle;
        return self;
    }

    /// Idempotent.  The bridge destroy callback is called at most once.
    pub fn deinit(self: *Self) void {
        if (!self.alive) return;
        self.alive = false;
        if (self.api) |api| {
            if (api.destroy) |destroy| destroy(api.user_data, self.engine);
        }
        self.engine = null;
        self.api = null;
        self.availability = .closed;
    }

    pub fn frameId(self: *const Self) FrameId {
        return self.frame_id;
    }

    pub fn generation(self: *const Self) Generation {
        return self.generation_value;
    }

    /// Reports bridge/lifetime availability, not the result of the last call.
    pub fn status(self: *const Self) Status {
        return if (!self.alive) .closed else self.availability;
    }

    pub fn invalidateStylesheets(self: *Self) Status {
        if (!self.alive) return .closed;
        self.bumpGeneration();
        const api = self.api orelse return self.status();
        const invalidate = api.invalidate_stylesheets orelse return .bridge_unsupported;
        return mapStatus(invalidate(api.user_data, self.engine, self.generation_value));
    }

    pub fn invalidateDom(self: *Self, node_id: NodeId, kind: DomInvalidationKind) Status {
        if (!self.alive) return .closed;
        self.bumpGeneration();
        const api = self.api orelse return self.status();
        const invalidate = api.invalidate_dom orelse return .bridge_unsupported;
        return mapStatus(invalidate(api.user_data, self.engine, node_id, @intFromEnum(kind), self.generation_value));
    }

    /// Publish a complete stylesheet snapshot in one bridge call. The bridge
    /// owns no input memory after this synchronous operation returns.
    pub fn replaceStylesheets(self: *Self, inputs: []const Abi.StylesheetInput) Status {
        if (!self.alive) return .closed;
        const api = self.api orelse return self.status();
        const replace = api.replace_stylesheets orelse return .bridge_unsupported;
        const ptr: [*c]const Abi.StylesheetInput = if (inputs.len == 0) null else inputs.ptr;
        self.bumpGeneration();
        return mapStatus(replace(api.user_data, self.engine, ptr, inputs.len));
    }

    pub fn stylesheetCount(self: *Self) struct { status: Status, value: usize = 0 } {
        if (!self.alive) return .{ .status = .closed };
        const api = self.api orelse return .{ .status = self.status() };
        const count = api.stylesheet_count orelse return .{ .status = .bridge_unsupported };
        var value: usize = 0;
        const result_status = mapStatus(count(api.user_data, self.engine, &value));
        return .{ .status = result_status, .value = if (result_status == .ok) value else 0 };
    }

    /// Synchronize one authoritative DOM node through the bridge. This is
    /// separate from invalidation so the resolver can refresh callback-backed
    /// metadata before a style flush.
    pub fn syncNode(self: *Self, node_id: NodeId) Status {
        if (!self.alive) return .closed;
        if (node_id == 0) return .invalid_argument;
        const api = self.api orelse return self.status();
        const sync = api.sync_node orelse return .bridge_unsupported;
        return mapStatus(sync(api.user_data, self.engine, node_id));
    }

    /// Drop callback-backed node metadata at a document boundary. Stable node
    /// IDs never cross navigation, even though the bridge is per-frame.
    pub fn resetDocument(self: *Self) Status {
        if (!self.alive) return .closed;
        const api = self.api orelse return self.status();
        const reset = api.reset_document orelse return .bridge_unsupported;
        self.bumpGeneration();
        return mapStatus(reset(api.user_data, self.engine));
    }

    pub fn flushStyles(self: *Self, nodes: []const NodeId) FlushResult {
        if (!self.alive) return .{ .status = .closed };
        const api = self.api orelse return .{ .status = self.status() };
        const flush = api.flush_styles orelse return .{ .status = .bridge_unsupported };
        const ptr: [*c]const NodeId = if (nodes.len == 0) null else nodes.ptr;
        var result = Abi.FlushResult{};
        const flush_status = mapStatus(flush(api.user_data, self.engine, ptr, nodes.len, &result));
        if (flush_status != .ok) return .{ .status = flush_status };
        return .{
            .status = .ok,
            .generation = result.generation,
            .changed_node_count = result.changed_node_count,
        };
    }

    pub fn prepareForLayout(self: *Self) Status {
        if (!self.alive) return .closed;
        const api = self.api orelse return self.status();
        const prepare = api.prepare_for_layout orelse return .bridge_unsupported;
        return mapStatus(prepare(api.user_data, self.engine, self.generation_value));
    }

    pub fn computedValue(self: *Self, node_id: NodeId, property: []const u8, output: []u8) QueryResult {
        return self.queryString(node_id, property, output, self.apiFn(.computed_value));
    }

    pub fn customProperty(self: *Self, node_id: NodeId, property: []const u8, output: []u8) QueryResult {
        return self.queryString(node_id, property, output, self.apiFn(.custom_property));
    }

    pub fn computedPseudoValue(
        self: *Self,
        node_id: NodeId,
        pseudo: []const u8,
        property: []const u8,
        output: []u8,
    ) QueryResult {
        if (!self.alive) return .{ .status = .closed };
        if (pseudo.len == 0 or property.len == 0) return .{ .status = .invalid_argument };
        const api = self.api orelse return .{ .status = self.status() };
        const query = api.computed_pseudo_value orelse return .{ .status = .bridge_unsupported };
        var written: usize = 0;
        const code = query(
            api.user_data,
            self.engine,
            node_id,
            .{ .ptr = pseudo.ptr, .len = pseudo.len },
            .{ .ptr = property.ptr, .len = property.len },
            .{ .ptr = if (output.len == 0) null else output.ptr, .len = output.len },
            &written,
        );
        const result_status = mapStatus(code);
        if (result_status == .ok) {
            if (written > output.len) return .{ .status = .bridge_error };
            return .{ .status = .ok, .bytes_written = written };
        }
        if (result_status == .output_buffer_too_small) {
            return .{ .status = result_status, .bytes_written = written };
        }
        return .{ .status = result_status };
    }

    pub fn lastError(self: *Self, output: []u8) QueryResult {
        if (!self.alive) return .{ .status = .closed };
        const api = self.api orelse return .{ .status = self.status() };
        const query = api.last_error orelse return .{ .status = .bridge_unsupported };
        var written: usize = 0;
        const result_status = mapStatus(query(
            api.user_data,
            self.engine,
            .{ .ptr = if (output.len == 0) null else output.ptr, .len = output.len },
            &written,
        ));
        if (result_status == .ok or result_status == .output_buffer_too_small) {
            return .{ .status = result_status, .bytes_written = written };
        }
        return .{ .status = result_status };
    }

    pub fn layoutProperty(self: *Self, node_id: NodeId, property: []const u8, output: []u8) QueryResult {
        return self.queryString(node_id, property, output, self.apiFn(.layout_property));
    }

    /// Returns whether Stylo computed the node as hidden.  A null value means
    /// no CSS answer was produced.
    pub fn visibility(self: *Self, node_id: NodeId) BoolResult {
        return self.queryBool(node_id, self.apiFnBool(.visibility));
    }

    /// Returns whether Stylo computed `pointer-events: none` for the node.
    pub fn pointerEvents(self: *Self, node_id: NodeId) BoolResult {
        return self.queryBool(node_id, self.apiFnBool(.pointer_events));
    }

    pub fn isHidden(self: *Self, node_id: NodeId) BoolResult {
        return self.visibility(node_id);
    }

    pub fn hasPointerEventsNone(self: *Self, node_id: NodeId) BoolResult {
        return self.pointerEvents(node_id);
    }

    fn bumpGeneration(self: *Self) void {
        self.generation_value +%= 1;
        if (self.generation_value == 0) self.generation_value = 1;
    }

    const QueryOperation = enum { computed_value, custom_property, layout_property };
    const BoolOperation = enum { visibility, pointer_events };

    fn apiFn(self: *const Self, operation: QueryOperation) ?Abi.QueryFn {
        const api = self.api orelse return null;
        return switch (operation) {
            .computed_value => api.computed_value,
            .custom_property => api.custom_property,
            .layout_property => api.layout_property,
        };
    }

    fn apiFnBool(self: *const Self, operation: BoolOperation) ?Abi.BoolQueryFn {
        const api = self.api orelse return null;
        return switch (operation) {
            .visibility => api.visibility,
            .pointer_events => api.pointer_events,
        };
    }

    fn queryString(
        self: *Self,
        node_id: NodeId,
        property: []const u8,
        output: []u8,
        query: ?Abi.QueryFn,
    ) QueryResult {
        if (!self.alive) return .{ .status = .closed };
        if (property.len == 0) return .{ .status = .invalid_argument };
        const api = self.api orelse return .{ .status = self.status() };
        const query_fn = query orelse return .{ .status = .bridge_unsupported };

        var written: usize = 0;
        const code = query_fn(
            api.user_data,
            self.engine,
            node_id,
            .{
                .ptr = if (property.len == 0) null else property.ptr,
                .len = property.len,
            },
            .{
                .ptr = if (output.len == 0) null else output.ptr,
                .len = output.len,
            },
            &written,
        );
        const result_status = mapStatus(code);
        if (result_status == .ok) {
            if (written > output.len) return .{ .status = .bridge_error };
            return .{ .status = .ok, .bytes_written = written };
        }
        if (result_status == .output_buffer_too_small) {
            return .{ .status = result_status, .bytes_written = written };
        }
        return .{ .status = result_status };
    }

    fn queryBool(self: *Self, node_id: NodeId, query: ?Abi.BoolQueryFn) BoolResult {
        if (!self.alive) return .{ .status = .closed };
        const api = self.api orelse return .{ .status = self.status() };
        const query_fn = query orelse return .{ .status = .bridge_unsupported };
        var value: u8 = 0;
        const result_status = mapStatus(query_fn(api.user_data, self.engine, node_id, self.generation_value, &value));
        if (result_status != .ok) return .{ .status = result_status };
        if (value > 1) return .{ .status = .bridge_error };
        return .{ .status = .ok, .value = value == 1 };
    }
};

fn mapStatus(code: Abi.StatusCode) StyleEngine.Status {
    return switch (code) {
        Abi.status_ok => .ok,
        Abi.status_unavailable => .bridge_unavailable,
        Abi.status_invalid_argument => .invalid_argument,
        Abi.status_unsupported => .bridge_unsupported,
        Abi.status_not_ready => .bridge_not_ready,
        Abi.status_stale_generation => .stale_generation,
        Abi.status_out_of_memory => .out_of_memory,
        Abi.status_buffer_too_small => .output_buffer_too_small,
        Abi.status_internal_error => .bridge_error,
        else => .bridge_error,
    };
}

test "StyleEngine reports unavailable without fabricated CSS values" {
    var engine = StyleEngine.init(.{ .frame_id = 7 });
    defer engine.deinit();

    try std.testing.expectEqual(StyleEngine.Status.bridge_unavailable, engine.status());
    var output: [32]u8 = undefined;
    const result = engine.computedValue(1, "display", &output);
    try std.testing.expectEqual(StyleEngine.Status.bridge_unavailable, result.status);
    try std.testing.expectEqual(@as(usize, 0), result.bytes_written);
}

test "StyleEngine generation advances only for live invalidations" {
    var engine = StyleEngine.init(.{ .frame_id = 11 });
    try std.testing.expectEqual(@as(u64, 1), engine.generation());
    try std.testing.expectEqual(StyleEngine.Status.bridge_unavailable, engine.invalidateStylesheets());
    try std.testing.expectEqual(@as(u64, 2), engine.generation());
    try std.testing.expectEqual(StyleEngine.Status.bridge_unavailable, engine.invalidateDom(3, .attributes));
    try std.testing.expectEqual(@as(u64, 3), engine.generation());
    engine.deinit();
    try std.testing.expectEqual(StyleEngine.Status.closed, engine.invalidateDom(3, .text));
    try std.testing.expectEqual(@as(u64, 3), engine.generation());
    engine.deinit();
}

test "StyleEngine generation never publishes zero after wraparound" {
    var engine = StyleEngine.init(.{ .frame_id = 13 });
    engine.generation_value = std.math.maxInt(u64);
    try std.testing.expectEqual(StyleEngine.Status.bridge_unavailable, engine.invalidateStylesheets());
    try std.testing.expectEqual(@as(u64, 1), engine.generation());
    engine.deinit();
}

test "StyleEngine lifetime is idempotent and status is explicit" {
    var engine = StyleEngine.init(.{ .frame_id = 12 });
    try std.testing.expectEqual(StyleEngine.Status.bridge_unavailable, engine.status());
    engine.deinit();
    try std.testing.expectEqual(StyleEngine.Status.closed, engine.status());
    engine.deinit();
    try std.testing.expectEqual(StyleEngine.Status.closed, engine.status());
}

const FakeBridgeState = struct {
    create_frame_id: StyleEngine.FrameId = 0,
    last_generation: StyleEngine.Generation = 0,
    invalidation_count: u32 = 0,
    stylesheet_replace_count: u32 = 0,
    sync_count: u32 = 0,
    reset_count: u32 = 0,
    flush_count: u32 = 0,
    destroy_count: u32 = 0,
};

fn fakeCreate(
    user_data: ?*anyopaque,
    frame_id: StyleEngine.FrameId,
    out_engine: *?*anyopaque,
) callconv(.c) Abi.StatusCode {
    const state: *FakeBridgeState = @ptrCast(@alignCast(user_data.?));
    state.create_frame_id = frame_id;
    out_engine.* = @ptrCast(state);
    return Abi.status_ok;
}

fn fakeDestroy(user_data: ?*anyopaque, engine: ?*anyopaque) callconv(.c) void {
    _ = engine;
    const state: *FakeBridgeState = @ptrCast(@alignCast(user_data.?));
    state.destroy_count += 1;
}

fn fakeInvalidateStylesheets(
    user_data: ?*anyopaque,
    engine: ?*anyopaque,
    generation: StyleEngine.Generation,
) callconv(.c) Abi.StatusCode {
    _ = engine;
    const state: *FakeBridgeState = @ptrCast(@alignCast(user_data.?));
    state.last_generation = generation;
    state.invalidation_count += 1;
    return Abi.status_ok;
}

fn fakeInvalidateDom(
    user_data: ?*anyopaque,
    engine: ?*anyopaque,
    node_id: StyleEngine.NodeId,
    kind: u32,
    generation: StyleEngine.Generation,
) callconv(.c) Abi.StatusCode {
    _ = engine;
    _ = node_id;
    _ = kind;
    const state: *FakeBridgeState = @ptrCast(@alignCast(user_data.?));
    state.last_generation = generation;
    state.invalidation_count += 1;
    return Abi.status_ok;
}

fn fakeReplaceStylesheets(
    user_data: ?*anyopaque,
    engine: ?*anyopaque,
    inputs: [*c]const Abi.StylesheetInput,
    count: usize,
) callconv(.c) Abi.StatusCode {
    _ = engine;
    const state: *FakeBridgeState = @ptrCast(@alignCast(user_data.?));
    if (count != 0 and inputs == null) return Abi.status_invalid_argument;
    state.stylesheet_replace_count += 1;
    return Abi.status_ok;
}

fn fakeSyncNode(
    user_data: ?*anyopaque,
    engine: ?*anyopaque,
    node_id: StyleEngine.NodeId,
) callconv(.c) Abi.StatusCode {
    _ = engine;
    const state: *FakeBridgeState = @ptrCast(@alignCast(user_data.?));
    if (node_id == 0) return Abi.status_invalid_argument;
    state.sync_count += 1;
    return Abi.status_ok;
}

fn fakeResetDocument(
    user_data: ?*anyopaque,
    engine: ?*anyopaque,
) callconv(.c) Abi.StatusCode {
    _ = engine;
    const state: *FakeBridgeState = @ptrCast(@alignCast(user_data.?));
    state.reset_count += 1;
    return Abi.status_ok;
}

fn fakeFlushStyles(
    user_data: ?*anyopaque,
    engine: ?*anyopaque,
    nodes: [*c]const StyleEngine.NodeId,
    node_count: usize,
    out_result: *Abi.FlushResult,
) callconv(.c) Abi.StatusCode {
    _ = engine;
    const state: *FakeBridgeState = @ptrCast(@alignCast(user_data.?));
    if (node_count != 0 and nodes == null) return Abi.status_invalid_argument;
    state.flush_count += 1;
    out_result.* = .{ .generation = state.last_generation, .changed_node_count = node_count };
    return Abi.status_ok;
}

fn fakePrepareForLayout(
    user_data: ?*anyopaque,
    engine: ?*anyopaque,
    generation: StyleEngine.Generation,
) callconv(.c) Abi.StatusCode {
    _ = engine;
    const state: *FakeBridgeState = @ptrCast(@alignCast(user_data.?));
    state.last_generation = generation;
    return Abi.status_ok;
}

fn fakeComputedValue(
    user_data: ?*anyopaque,
    engine: ?*anyopaque,
    node_id: StyleEngine.NodeId,
    name: Abi.StringSlice,
    output: Abi.Buffer,
    out_len: *usize,
) callconv(.c) Abi.StatusCode {
    _ = user_data;
    _ = engine;
    _ = node_id;
    const property = name.ptr[0..name.len];
    const value = if (std.mem.eql(u8, property, "display")) "block" else "";
    out_len.* = value.len;
    if (output.len < value.len) return Abi.status_buffer_too_small;
    if (value.len != 0) @memcpy(output.ptr[0..value.len], value);
    return Abi.status_ok;
}

fn fakeVisibility(
    user_data: ?*anyopaque,
    engine: ?*anyopaque,
    node_id: StyleEngine.NodeId,
    generation: StyleEngine.Generation,
    out_value: *u8,
) callconv(.c) Abi.StatusCode {
    _ = user_data;
    _ = engine;
    _ = node_id;
    _ = generation;
    out_value.* = 1;
    return Abi.status_ok;
}

test "StyleEngine adapter forwards the stable C ABI" {
    var state = FakeBridgeState{};
    var api = StyleEngine.AbiApi{
        .abi_version = Abi.abi_version,
        .user_data = &state,
        .create = fakeCreate,
        .destroy = fakeDestroy,
        .invalidate_stylesheets = fakeInvalidateStylesheets,
        .invalidate_dom = fakeInvalidateDom,
        .replace_stylesheets = fakeReplaceStylesheets,
        .sync_node = fakeSyncNode,
        .reset_document = fakeResetDocument,
        .flush_styles = fakeFlushStyles,
        .prepare_for_layout = fakePrepareForLayout,
        .computed_value = fakeComputedValue,
        .custom_property = null,
        .layout_property = null,
        .visibility = fakeVisibility,
        .pointer_events = null,
    };

    var engine = StyleEngine.init(.{ .frame_id = 41, .bridge = &api });
    defer engine.deinit();
    try std.testing.expectEqual(StyleEngine.Status.ready, engine.status());
    try std.testing.expectEqual(@as(u64, 41), state.create_frame_id);
    try std.testing.expectEqual(StyleEngine.Status.ok, engine.prepareForLayout());

    var output: [16]u8 = undefined;
    const computed = engine.computedValue(9, "display", &output);
    try std.testing.expectEqual(StyleEngine.Status.ok, computed.status);
    try std.testing.expectEqualStrings("block", output[0..computed.bytes_written]);

    const too_small = engine.computedValue(9, "display", output[0..2]);
    try std.testing.expectEqual(StyleEngine.Status.output_buffer_too_small, too_small.status);
    try std.testing.expectEqual(@as(usize, 5), too_small.bytes_written);
    try std.testing.expectEqual(StyleEngine.Status.bridge_unsupported, engine.customProperty(9, "--x", &output).status);

    try std.testing.expectEqual(StyleEngine.Status.ok, engine.invalidateStylesheets());
    try std.testing.expectEqual(@as(u64, 2), engine.generation());
    try std.testing.expectEqual(@as(u64, 2), state.last_generation);
    try std.testing.expectEqual(StyleEngine.Status.ok, engine.invalidateDom(9, .attributes));
    try std.testing.expectEqual(@as(u64, 3), state.last_generation);
    try std.testing.expectEqual(@as(u32, 2), state.invalidation_count);

    const css = "div { color: red }";
    const sheet = Abi.StylesheetInput{
        .sheet_id = 1,
        .scope_id = 0,
        .origin = .author,
        .enabled = 1,
        .css = .{ .ptr = css.ptr, .len = css.len },
    };
    try std.testing.expectEqual(StyleEngine.Status.ok, engine.replaceStylesheets(&.{sheet}));
    try std.testing.expectEqual(@as(u64, 4), engine.generation());
    try std.testing.expectEqual(@as(u32, 1), state.stylesheet_replace_count);
    try std.testing.expectEqual(StyleEngine.Status.ok, engine.syncNode(9));
    const flushed = engine.flushStyles(&.{9});
    try std.testing.expectEqual(StyleEngine.Status.ok, flushed.status);
    try std.testing.expectEqual(@as(usize, 1), flushed.changed_node_count);
    try std.testing.expectEqual(@as(u32, 1), state.sync_count);
    try std.testing.expectEqual(@as(u32, 1), state.flush_count);
    try std.testing.expectEqual(StyleEngine.Status.ok, engine.resetDocument());
    try std.testing.expectEqual(@as(u32, 1), state.reset_count);

    const hidden = engine.visibility(9);
    try std.testing.expectEqual(StyleEngine.Status.ok, hidden.status);
    try std.testing.expectEqual(@as(?bool, true), hidden.value);
    try std.testing.expectEqual(StyleEngine.Status.bridge_unsupported, engine.pointerEvents(9).status);

    engine.deinit();
    try std.testing.expectEqual(@as(u32, 1), state.destroy_count);
}
