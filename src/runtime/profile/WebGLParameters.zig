const std = @import("std");
const js = @import("../../core/js/js.zig");

pub const Value = union(enum) {
    u32_val: u32,
    string: []const u8,
    bool_val: bool,
    f32_array: []const f32,
};

pub const Map = std.AutoArrayHashMapUnmanaged(u32, Value);

const GLenumMap = std.StaticStringMap(u32).initComptime(.{
    .{ "ALIASED_POINT_SIZE_RANGE", 0x846D },
    .{ "ALIASED_LINE_WIDTH_RANGE", 0x846E },
    .{ "STENCIL_VALUE_MASK", 0x0B93 },
    .{ "STENCIL_WRITEMASK", 0x0B94 },
    .{ "STENCIL_BACK_VALUE_MASK", 0x8CA4 },
    .{ "STENCIL_BACK_WRITEMASK", 0x8CA5 },
    .{ "MAX_TEXTURE_SIZE", 0x0D33 },
    .{ "MAX_VIEWPORT_DIMS", 0x0D3A },
    .{ "SUBPIXEL_BITS", 0x0D50 },
    .{ "MAX_VERTEX_ATTRIBS", 0x8869 },
    .{ "MAX_VERTEX_UNIFORM_VECTORS", 0x8DFB },
    .{ "MAX_VARYING_VECTORS", 0x8DFC },
    .{ "MAX_COMBINED_TEXTURE_IMAGE_UNITS", 0x8B4D },
    .{ "MAX_VERTEX_TEXTURE_IMAGE_UNITS", 0x8B4C },
    .{ "MAX_TEXTURE_IMAGE_UNITS", 0x8872 },
    .{ "MAX_FRAGMENT_UNIFORM_VECTORS", 0x8DFD },
    .{ "SHADING_LANGUAGE_VERSION", 0x8B8C },
    .{ "VENDOR", 0x1F00 },
    .{ "RENDERER", 0x1F01 },
    .{ "VERSION", 0x1F02 },
    .{ "MAX_CUBE_MAP_TEXTURE_SIZE", 0x851C },
    .{ "MAX_RENDERBUFFER_SIZE", 0x84E8 },
    .{ "UNMASKED_VENDOR_WEBGL", 0x9245 },
    .{ "UNMASKED_RENDERER_WEBGL", 0x9246 },
    .{ "MAX_3D_TEXTURE_SIZE", 0x8073 },
    .{ "MAX_ELEMENTS_VERTICES", 0x80E8 },
    .{ "MAX_ELEMENTS_INDICES", 0x80E9 },
    .{ "MAX_TEXTURE_LOD_BIAS", 0x84FD },
    .{ "MAX_DRAW_BUFFERS", 0x8824 },
    .{ "MAX_FRAGMENT_UNIFORM_COMPONENTS", 0x8B49 },
    .{ "MAX_VERTEX_UNIFORM_COMPONENTS", 0x8B4A },
    .{ "MAX_ARRAY_TEXTURE_LAYERS", 0x88FF },
    .{ "MAX_PROGRAM_TEXEL_OFFSET", 0x8905 },
    .{ "MAX_VARYING_COMPONENTS", 0x8B4B },
    .{ "MAX_TRANSFORM_FEEDBACK_SEPARATE_COMPONENTS", 0x8C80 },
    .{ "MAX_TRANSFORM_FEEDBACK_INTERLEAVED_COMPONENTS", 0x8C8A },
    .{ "MAX_TRANSFORM_FEEDBACK_SEPARATE_ATTRIBS", 0x8C8B },
    .{ "MAX_COLOR_ATTACHMENTS", 0x8CDF },
    .{ "MAX_SAMPLES", 0x8D57 },
    .{ "MAX_VERTEX_UNIFORM_BLOCKS", 0x8A2B },
    .{ "MAX_FRAGMENT_UNIFORM_BLOCKS", 0x8A2D },
    .{ "MAX_COMBINED_UNIFORM_BLOCKS", 0x8A2E },
    .{ "MAX_UNIFORM_BUFFER_BINDINGS", 0x8A2F },
    .{ "MAX_UNIFORM_BLOCK_SIZE", 0x8A30 },
    .{ "MAX_COMBINED_VERTEX_UNIFORM_COMPONENTS", 0x8A31 },
    .{ "MAX_COMBINED_FRAGMENT_UNIFORM_COMPONENTS", 0x8A33 },
    .{ "MAX_VERTEX_OUTPUT_COMPONENTS", 0x9122 },
    .{ "MAX_FRAGMENT_INPUT_COMPONENTS", 0x9125 },
    .{ "MAX_SERVER_WAIT_TIMEOUT", 0x9111 },
    .{ "MAX_ELEMENT_INDEX", 0x8D6A },
    .{ "MAX_CLIENT_WAIT_TIMEOUT_WEBGL", 0x9247 },
    .{ "MAX_TEXTURE_MAX_ANISOTROPY_EXT", 0x84FF },
    .{ "MAX_DRAW_BUFFERS_WEBGL", 0x8824 },
});

pub fn loadFromJsonObject(allocator: std.mem.Allocator, value: ?std.json.Value, out: *Map) !void {
    const obj = switch (value orelse return) {
        .object => |o| o,
        else => return,
    };
    out.* = .empty;
    try out.ensureTotalCapacity(allocator, obj.count());
    var it = obj.iterator();
    while (it.next()) |entry| {
        const pname = GLenumMap.get(entry.key_ptr.*) orelse continue;
        const parsed = try parseValue(allocator, entry.value_ptr.*);
        try out.put(allocator, pname, parsed);
    }
}

fn parseValue(allocator: std.mem.Allocator, value: std.json.Value) !Value {
    return switch (value) {
        .string => |s| .{ .string = try allocator.dupe(u8, s) },
        .bool => |b| .{ .bool_val = b },
        .integer => |i| .{ .u32_val = @intCast(i) },
        .float => |f| .{ .u32_val = @intFromFloat(f) },
        .number_string => |s| .{ .u32_val = try std.fmt.parseInt(u32, s, 10) },
        .array => |*arr| blk: {
            const floats = try allocator.alloc(f32, arr.items.len);
            for (arr.items, 0..) |item, i| {
                floats[i] = switch (item) {
                    .integer => |n| @floatFromInt(n),
                    .float => |f| @floatCast(f),
                    else => 0,
                };
            }
            break :blk .{ .f32_array = floats };
        },
        else => error.UnexpectedParameterType,
    };
}

pub fn get(map: *const Map, pname: u32) ?Value {
    const idx = map.getIndex(pname) orelse return null;
    return map.values()[idx];
}

pub fn toJs(val: Value, local: *const js.Local) !js.Value {
    return switch (val) {
        .u32_val => |n| try local.zigValueToJs(n, .{}),
        .string => |s| try local.zigValueToJs(s, .{}),
        .bool_val => |b| try local.zigValueToJs(b, .{}),
        .f32_array => |arr| {
            const ta = local.createTypedArray(.float32, arr.len);
            const v8 = js.v8;
            const view: *const v8.ArrayBufferView = @ptrCast(ta.handle);
            const byte_len = v8.v8__ArrayBufferView__ByteLength(view);
            const byte_offset = v8.v8__ArrayBufferView__ByteOffset(view);
            const array_buffer = v8.v8__ArrayBufferView__Buffer(view) orelse return .{ .local = local, .handle = ta.handle };
            const backing_store_ptr = v8.v8__ArrayBuffer__GetBackingStore(array_buffer);
            const backing_store_handle = v8.std__shared_ptr__v8__BackingStore__get(&backing_store_ptr) orelse return .{ .local = local, .handle = ta.handle };
            const data: [*]f32 = @ptrCast(@alignCast(v8.v8__BackingStore__Data(backing_store_handle)));
            const base = data + byte_offset / @sizeOf(f32);
            const n = @min(arr.len, byte_len / @sizeOf(f32));
            @memcpy(base[0..n], arr[0..n]);
            return .{ .local = local, .handle = ta.handle };
        },
    };
}
