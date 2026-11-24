// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published
// by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

/// Stable, pointer/length-only ABI shared by Koko and the Stylo bridge.
///
/// This module deliberately contains no extern declarations for named
/// symbols.  The bridge is supplied as an optional function table, so a
/// Koko build and its unit tests do not need a Rust archive at link time.
pub const abi_version: u32 = 1;

pub const FrameId = u64;
pub const NodeId = u64;
pub const Generation = u64;

pub const StatusCode = i32;
pub const status_ok: StatusCode = 0;
pub const status_unavailable: StatusCode = 1;
pub const status_invalid_argument: StatusCode = 2;
pub const status_unsupported: StatusCode = 3;
pub const status_not_ready: StatusCode = 4;
pub const status_stale_generation: StatusCode = 5;
pub const status_internal_error: StatusCode = 6;
pub const status_out_of_memory: StatusCode = 7;
pub const status_buffer_too_small: StatusCode = 8;

/// A C-compatible borrowed UTF-8 byte string.  The bridge must not retain it.
pub const StringSlice = extern struct {
    ptr: [*c]const u8,
    len: usize,
};

/// A caller-owned writable byte buffer.  The bridge must not retain it.
pub const Buffer = extern struct {
    ptr: [*c]u8,
    len: usize,
};

pub const CreateFn = *const fn (
    user_data: ?*anyopaque,
    frame_id: FrameId,
    out_engine: *?*anyopaque,
) callconv(.c) StatusCode;

pub const DestroyFn = *const fn (
    user_data: ?*anyopaque,
    engine: ?*anyopaque,
) callconv(.c) void;

pub const InvalidateStylesheetsFn = *const fn (
    user_data: ?*anyopaque,
    engine: ?*anyopaque,
    generation: Generation,
) callconv(.c) StatusCode;

pub const InvalidateDomFn = *const fn (
    user_data: ?*anyopaque,
    engine: ?*anyopaque,
    node_id: NodeId,
    kind: u32,
    generation: Generation,
) callconv(.c) StatusCode;

pub const PrepareForLayoutFn = *const fn (
    user_data: ?*anyopaque,
    engine: ?*anyopaque,
    generation: Generation,
) callconv(.c) StatusCode;

pub const QueryFn = *const fn (
    user_data: ?*anyopaque,
    engine: ?*anyopaque,
    node_id: NodeId,
    name: StringSlice,
    output: Buffer,
    out_len: *usize,
) callconv(.c) StatusCode;

pub const BoolQueryFn = *const fn (
    user_data: ?*anyopaque,
    engine: ?*anyopaque,
    node_id: NodeId,
    generation: Generation,
    out_value: *u8,
) callconv(.c) StatusCode;

/// The bridge entry points are passed by the embedding/build integration.
/// Every field is optional so partial rollout can report `unsupported` rather
/// than fail at link time or invent a CSS value.
pub const Api = extern struct {
    abi_version: u32,
    user_data: ?*anyopaque,
    create: ?CreateFn,
    destroy: ?DestroyFn,
    invalidate_stylesheets: ?InvalidateStylesheetsFn,
    invalidate_dom: ?InvalidateDomFn,
    prepare_for_layout: ?PrepareForLayoutFn,
    computed_value: ?QueryFn,
    custom_property: ?QueryFn,
    layout_property: ?QueryFn,
    visibility: ?BoolQueryFn,
    pointer_events: ?BoolQueryFn,
};
