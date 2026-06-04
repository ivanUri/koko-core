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

const js = @import("../../js/js.zig");
const Execution = js.Execution;
const Canvas = @import("../element/html/Canvas.zig");

pub fn registerTypes() []const type {
    return &.{
        WebGLRenderingContext,
        // Extension types should be runtime generated. We might want
        // to revisit this.
        Extension.Type.WEBGL_debug_renderer_info,
        Extension.Type.WEBGL_lose_context,
        Extension.Type.EXT_texture_filter_anisotropic,
        Extension.Type.WEBGL_draw_buffers,
        WebGLBuffer,
        WebGLShader,
        WebGLProgram,
        WebGLTexture,
        WebGLFramebuffer,
        WebGLRenderbuffer,
        WebGLUniformLocation,
    };
}

const WebGLRenderingContext = @This();

/// Reference to the parent canvas element, or null if created from OffscreenCanvas.
/// https://developer.mozilla.org/en-US/docs/Web/API/WebGLRenderingContext/canvas
_canvas: ?*Canvas = null,

pub const ARRAY_BUFFER: u64 = 0x8892;
pub const ELEMENT_ARRAY_BUFFER: u64 = 0x8893;
pub const STATIC_DRAW: u64 = 0x88E4;
pub const FLOAT: u64 = 0x1406;
pub const TRIANGLES: u64 = 0x0004;
pub const POINTS: u64 = 0x0000;
pub const LINES: u64 = 0x0001;
pub const COLOR_BUFFER_BIT: u64 = 0x4000;
pub const DEPTH_BUFFER_BIT: u64 = 0x0100;
pub const STENCIL_BUFFER_BIT: u64 = 0x0400;
pub const VERTEX_SHADER: u64 = 0x8B31;
pub const FRAGMENT_SHADER: u64 = 0x8B30;
pub const COMPILE_STATUS: u64 = 0x8B81;
pub const LINK_STATUS: u64 = 0x8B82;
pub const VERSION: u64 = 0x1F02;
pub const VENDOR: u64 = 0x1F00;
pub const RENDERER: u64 = 0x1F01;
pub const SHADING_LANGUAGE_VERSION: u64 = 0x8B8C;
pub const MAX_TEXTURE_SIZE: u64 = 0x0D33;
pub const MAX_CUBE_MAP_TEXTURE_SIZE: u64 = 0x851C;
pub const MAX_RENDERBUFFER_SIZE: u64 = 0x84E8;
pub const MAX_VIEWPORT_DIMS: u64 = 0x0D3A;
pub const MAX_VERTEX_ATTRIBS: u64 = 0x8869;
pub const MAX_VERTEX_UNIFORM_VECTORS: u64 = 0x8DFB;
pub const MAX_VARYING_VECTORS: u64 = 0x8DFC;
pub const MAX_COMBINED_TEXTURE_IMAGE_UNITS: u64 = 0x8B4D;
pub const MAX_VERTEX_TEXTURE_IMAGE_UNITS: u64 = 0x8B4C;
pub const MAX_TEXTURE_IMAGE_UNITS: u64 = 0x8872;
pub const MAX_FRAGMENT_UNIFORM_VECTORS: u64 = 0x8DFD;
pub const ALIASED_LINE_WIDTH_RANGE: u64 = 0x846E;
pub const ALIASED_POINT_SIZE_RANGE: u64 = 0x846D;
pub const RED_BITS: u64 = 0x0D52;
pub const GREEN_BITS: u64 = 0x0D53;
pub const BLUE_BITS: u64 = 0x0D54;
pub const ALPHA_BITS: u64 = 0x0D55;
pub const DEPTH_BITS: u64 = 0x0D56;
pub const STENCIL_BITS: u64 = 0x0D57;
pub const MAX_VERTEX_TEXTURE_IMAGE_UNITS_WEBGL: u64 = MAX_VERTEX_TEXTURE_IMAGE_UNITS;
pub const HIGH_FLOAT: u64 = 0x8DF2;
pub const MEDIUM_FLOAT: u64 = 0x8DF1;
pub const LOW_FLOAT: u64 = 0x8DF0;
pub const HIGH_INT: u64 = 0x8DF5;
pub const MEDIUM_INT: u64 = 0x8DF4;
pub const LOW_INT: u64 = 0x8DF3;

// Pixel format / type constants used in readPixels
pub const RGBA: u64 = 0x1908;
pub const UNSIGNED_BYTE: u64 = 0x1401;

/// On Chrome and Safari, a call to `getSupportedExtensions` returns total of 39.
/// The reference for it lists lesser number of extensions:
/// https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/Using_Extensions#extension_list
pub const Extension = union(enum) {
    ANGLE_instanced_arrays: void,
    EXT_blend_minmax: void,
    EXT_clip_control: void,
    EXT_color_buffer_half_float: void,
    EXT_depth_clamp: void,
    EXT_disjoint_timer_query: void,
    EXT_float_blend: void,
    EXT_frag_depth: void,
    EXT_polygon_offset_clamp: void,
    EXT_shader_texture_lod: void,
    EXT_texture_compression_bptc: void,
    EXT_texture_compression_rgtc: void,
    EXT_texture_filter_anisotropic: *Type.EXT_texture_filter_anisotropic,
    EXT_texture_mirror_clamp_to_edge: void,
    EXT_sRGB: void,
    KHR_parallel_shader_compile: void,
    OES_element_index_uint: void,
    OES_fbo_render_mipmap: void,
    OES_standard_derivatives: void,
    OES_texture_float: void,
    OES_texture_float_linear: void,
    OES_texture_half_float: void,
    OES_texture_half_float_linear: void,
    OES_vertex_array_object: void,
    WEBGL_blend_func_extended: void,
    WEBGL_color_buffer_float: void,
    WEBGL_compressed_texture_astc: void,
    WEBGL_compressed_texture_etc: void,
    WEBGL_compressed_texture_etc1: void,
    WEBGL_compressed_texture_pvrtc: void,
    WEBGL_compressed_texture_s3tc: void,
    WEBGL_compressed_texture_s3tc_srgb: void,
    WEBGL_debug_renderer_info: *Type.WEBGL_debug_renderer_info,
    WEBGL_debug_shaders: void,
    WEBGL_depth_texture: void,
    WEBGL_draw_buffers: *Type.WEBGL_draw_buffers,
    WEBGL_lose_context: *Type.WEBGL_lose_context,
    WEBGL_multi_draw: void,
    WEBGL_polygon_mode: void,

    /// Reified enum type from the fields of this union.
    const Kind = blk: {
        const info = @typeInfo(Extension).@"union";
        const fields = info.fields;
        var items: [fields.len]std.builtin.Type.EnumField = undefined;
        for (fields, 0..) |field, i| {
            items[i] = .{ .name = field.name, .value = i };
        }

        break :blk @Type(.{
            .@"enum" = .{
                .tag_type = std.math.IntFittingRange(0, if (fields.len == 0) 0 else fields.len - 1),
                .fields = &items,
                .decls = &.{},
                .is_exhaustive = true,
            },
        });
    };

    /// Returns the `Extension.Kind` by its name.
    fn find(name: []const u8) ?Kind {
        // Just to make you really sad, this function has to be case-insensitive.
        // So here we copy what's being done in `std.meta.stringToEnum` but replace
        // the comparison function.
        const kvs = comptime build_kvs: {
            const T = Extension.Kind;
            const EnumKV = struct { []const u8, T };
            var kvs_array: [@typeInfo(T).@"enum".fields.len]EnumKV = undefined;
            for (@typeInfo(T).@"enum".fields, 0..) |enumField, i| {
                kvs_array[i] = .{ enumField.name, @field(T, enumField.name) };
            }
            break :build_kvs kvs_array[0..];
        };
        const Map = std.StaticStringMapWithEql(Extension.Kind, std.static_string_map.eqlAsciiIgnoreCase);
        const map = Map.initComptime(kvs);
        return map.get(name);
    }

    /// Extension types.
    pub const Type = struct {
        pub const WEBGL_debug_renderer_info = struct {
            _: u8 = 0,
            pub const UNMASKED_VENDOR_WEBGL: u64 = 0x9245;
            pub const UNMASKED_RENDERER_WEBGL: u64 = 0x9246;

            pub const JsApi = struct {
                pub const bridge = js.Bridge(WEBGL_debug_renderer_info);

                pub const Meta = struct {
                    pub const name = "WEBGL_debug_renderer_info";

                    pub const prototype_chain = bridge.prototypeChain();
                    pub var class_id: bridge.ClassId = undefined;
                };

                pub const UNMASKED_VENDOR_WEBGL = bridge.property(WEBGL_debug_renderer_info.UNMASKED_VENDOR_WEBGL, .{ .template = false, .readonly = true });
                pub const UNMASKED_RENDERER_WEBGL = bridge.property(WEBGL_debug_renderer_info.UNMASKED_RENDERER_WEBGL, .{ .template = false, .readonly = true });
            };
        };

        pub const WEBGL_lose_context = struct {
            _: u8 = 0,
            pub fn loseContext(_: *const WEBGL_lose_context) void {}
            pub fn restoreContext(_: *const WEBGL_lose_context) void {}

            pub const JsApi = struct {
                pub const bridge = js.Bridge(WEBGL_lose_context);

                pub const Meta = struct {
                    pub const name = "WEBGL_lose_context";

                    pub const prototype_chain = bridge.prototypeChain();
                    pub var class_id: bridge.ClassId = undefined;
                };

                pub const loseContext = bridge.function(WEBGL_lose_context.loseContext, .{ .noop = true });
                pub const restoreContext = bridge.function(WEBGL_lose_context.restoreContext, .{ .noop = true });
            };
        };

        pub const EXT_texture_filter_anisotropic = struct {
            _: u8 = 0,
            /// GL_MAX_TEXTURE_MAX_ANISOTROPY_EXT
            pub const MAX_TEXTURE_MAX_ANISOTROPY_EXT: u64 = 0x84FF;
            /// GL_TEXTURE_MAX_ANISOTROPY_EXT
            pub const TEXTURE_MAX_ANISOTROPY_EXT: u64 = 0x84FE;

            pub const JsApi = struct {
                pub const bridge = js.Bridge(EXT_texture_filter_anisotropic);

                pub const Meta = struct {
                    pub const name = "EXT_texture_filter_anisotropic";
                    pub const prototype_chain = bridge.prototypeChain();
                    pub var class_id: bridge.ClassId = undefined;
                };

                pub const MAX_TEXTURE_MAX_ANISOTROPY_EXT = bridge.property(EXT_texture_filter_anisotropic.MAX_TEXTURE_MAX_ANISOTROPY_EXT, .{ .template = false, .readonly = true });
                pub const TEXTURE_MAX_ANISOTROPY_EXT = bridge.property(EXT_texture_filter_anisotropic.TEXTURE_MAX_ANISOTROPY_EXT, .{ .template = false, .readonly = true });
            };
        };

        pub const WEBGL_draw_buffers = struct {
            _: u8 = 0,
            /// GL_MAX_DRAW_BUFFERS_WEBGL
            pub const MAX_DRAW_BUFFERS_WEBGL: u64 = 0x8824;
            /// GL_DRAW_BUFFER0_WEBGL .. DRAW_BUFFER15_WEBGL
            pub const DRAW_BUFFER0_WEBGL: u64 = 0x8825;
            pub const DRAW_BUFFER1_WEBGL: u64 = 0x8826;
            pub const COLOR_ATTACHMENT0_WEBGL: u64 = 0x8CE0;

            pub const JsApi = struct {
                pub const bridge = js.Bridge(WEBGL_draw_buffers);

                pub const Meta = struct {
                    pub const name = "WEBGL_draw_buffers";
                    pub const prototype_chain = bridge.prototypeChain();
                    pub var class_id: bridge.ClassId = undefined;
                };

                pub const MAX_DRAW_BUFFERS_WEBGL = bridge.property(WEBGL_draw_buffers.MAX_DRAW_BUFFERS_WEBGL, .{ .template = false, .readonly = true });
                pub const DRAW_BUFFER0_WEBGL = bridge.property(WEBGL_draw_buffers.DRAW_BUFFER0_WEBGL, .{ .template = false, .readonly = true });
                pub const DRAW_BUFFER1_WEBGL = bridge.property(WEBGL_draw_buffers.DRAW_BUFFER1_WEBGL, .{ .template = false, .readonly = true });
                pub const COLOR_ATTACHMENT0_WEBGL = bridge.property(WEBGL_draw_buffers.COLOR_ATTACHMENT0_WEBGL, .{ .template = false, .readonly = true });
            };
        };
    };
};

/// Returns the canvas element that created this context (null if OffscreenCanvas).
/// https://developer.mozilla.org/en-US/docs/Web/API/WebGLRenderingContext/canvas
pub fn getCanvas(self: *const WebGLRenderingContext) ?*Canvas {
    return self._canvas;
}

/// Returns the drawing buffer width (matches the canvas width attribute, default 300).
pub fn getDrawingBufferWidth(self: *const WebGLRenderingContext) u32 {
    return if (self._canvas) |c| c.getWidth() else 300;
}

/// Returns the drawing buffer height (matches the canvas height attribute, default 150).
pub fn getDrawingBufferHeight(self: *const WebGLRenderingContext) u32 {
    return if (self._canvas) |c| c.getHeight() else 150;
}

/// This actually takes "GLenum" which, in fact, is a fancy way to say number.
/// Return value also depends on what's being passed as `pname`; we don't really
/// support any though.
pub fn getParameter(_: *const WebGLRenderingContext, pname: u32, exec: *Execution) !js.Value {
    const local = exec.context.local orelse return error.NotHandled;
    switch (pname) {
        VERSION => return (try local.zigValueToJs("WebGL 1.0 (OpenGL ES 2.0 Chromium)", .{})),
        VENDOR => return (try local.zigValueToJs("WebKit", .{})),
        RENDERER => return (try local.zigValueToJs("WebKit WebGL", .{})),
        SHADING_LANGUAGE_VERSION => return (try local.zigValueToJs("WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)", .{})),
        Extension.Type.WEBGL_debug_renderer_info.UNMASKED_VENDOR_WEBGL => return (try local.zigValueToJs("Google Inc. (Apple)", .{})),
        Extension.Type.WEBGL_debug_renderer_info.UNMASKED_RENDERER_WEBGL => return (try local.zigValueToJs("ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)", .{})),
        MAX_TEXTURE_SIZE, MAX_CUBE_MAP_TEXTURE_SIZE, MAX_RENDERBUFFER_SIZE => return (try local.zigValueToJs(@as(u32, 16384), .{})),
        MAX_VERTEX_ATTRIBS => return (try local.zigValueToJs(@as(u32, 16), .{})),
        MAX_VERTEX_UNIFORM_VECTORS => return (try local.zigValueToJs(@as(u32, 4096), .{})),
        MAX_VARYING_VECTORS => return (try local.zigValueToJs(@as(u32, 31), .{})),
        MAX_COMBINED_TEXTURE_IMAGE_UNITS => return (try local.zigValueToJs(@as(u32, 32), .{})),
        MAX_VERTEX_TEXTURE_IMAGE_UNITS => return (try local.zigValueToJs(@as(u32, 16), .{})),
        MAX_TEXTURE_IMAGE_UNITS => return (try local.zigValueToJs(@as(u32, 16), .{})),
        MAX_FRAGMENT_UNIFORM_VECTORS => return (try local.zigValueToJs(@as(u32, 1024), .{})),
        RED_BITS, GREEN_BITS, BLUE_BITS, ALPHA_BITS => return (try local.zigValueToJs(@as(u32, 8), .{})),
        DEPTH_BITS => return (try local.zigValueToJs(@as(u32, 24), .{})),
        STENCIL_BITS => return (try local.zigValueToJs(@as(u32, 0), .{})),
        ALIASED_LINE_WIDTH_RANGE, ALIASED_POINT_SIZE_RANGE => {
            const arr = local.createTypedArray(.float32, 2);
            const values = [_]f32{ 1, if (pname == ALIASED_POINT_SIZE_RANGE) 1024 else 1 };
            fillTypedArray(.float32, arr, values[0..]);
            return .{ .local = local, .handle = arr.handle };
        },
        MAX_VIEWPORT_DIMS => {
            const arr = local.createTypedArray(.int32, 2);
            const values = [_]i32{ 16384, 16384 };
            fillTypedArray(.int32, arr, values[0..]);
            return .{ .local = local, .handle = arr.handle };
        },
        // EXT_texture_filter_anisotropic
        Extension.Type.EXT_texture_filter_anisotropic.MAX_TEXTURE_MAX_ANISOTROPY_EXT => return (try local.zigValueToJs(@as(u32, 16), .{})),
        // WEBGL_draw_buffers
        Extension.Type.WEBGL_draw_buffers.MAX_DRAW_BUFFERS_WEBGL => return (try local.zigValueToJs(@as(u32, 8), .{})),
        else => return (try local.zigValueToJs(@as(u32, 0), .{})),
    }
}

pub fn getShaderPrecisionFormat(_: *const WebGLRenderingContext, _: u32, precision_type: u32, exec: *Execution) !js.Value {
    const local = exec.context.local orelse return error.NotHandled;
    const obj = local.newObject();
    const is_float = precision_type == LOW_FLOAT or precision_type == MEDIUM_FLOAT or precision_type == HIGH_FLOAT;
    _ = try obj.set("rangeMin", if (is_float) @as(i32, 127) else @as(i32, 31), .{});
    _ = try obj.set("rangeMax", if (is_float) @as(i32, 127) else @as(i32, 30), .{});
    _ = try obj.set("precision", if (is_float) @as(i32, 23) else @as(i32, 0), .{});
    return obj.toValue();
}

pub fn readPixels(_: *const WebGLRenderingContext, x: i32, y: i32, width: i32, height: i32, _: u32, _: u32, pixels: js.Value, exec: *Execution) !void {
    _ = exec;
    if (!pixels.isTypedArray()) return;
    const safe_width: usize = @intCast(@max(width, 0));
    const safe_height: usize = @intCast(@max(height, 0));
    const count = safe_width * safe_height * 4;
    if (pixels.toZig(js.TypedArray(u8))) |arr| {
        const out = @constCast(arr.values[0..@min(arr.values.len, count)]);
        for (0..out.len / 4) |i| {
            const px = i % safe_width;
            const py = i / safe_width;
            const base = i * 4;
            out[base + 0] = @intCast((px * 31 + @as(usize, @intCast(@max(x, 0))) * 17 + 41) & 0xff);
            out[base + 1] = @intCast((py * 47 + @as(usize, @intCast(@max(y, 0))) * 13 + 73) & 0xff);
            out[base + 2] = @intCast(((px ^ py) * 19 + 109) & 0xff);
            out[base + 3] = 255;
        }
    } else |_| {}
}

fn fillTypedArray(comptime kind: js.ArrayType, arr: js.ArrayBufferRef(kind), values: anytype) void {
    const v8 = js.v8;
    const T = switch (kind) {
        .int8 => i8,
        .uint8, .uint8_clamped => u8,
        .int16 => i16,
        .uint16 => u16,
        .int32 => i32,
        .uint32 => u32,
        .float16 => f16,
        .float32 => f32,
        .float64 => f64,
    };
    const view: *const v8.ArrayBufferView = @ptrCast(arr.handle);
    const byte_len = v8.v8__ArrayBufferView__ByteLength(view);
    const byte_offset = v8.v8__ArrayBufferView__ByteOffset(view);
    const array_buffer = v8.v8__ArrayBufferView__Buffer(view) orelse return;
    const backing_store_ptr = v8.v8__ArrayBuffer__GetBackingStore(array_buffer);
    const backing_store_handle = v8.std__shared_ptr__v8__BackingStore__get(&backing_store_ptr) orelse return;
    const data: [*]T = @ptrCast(@alignCast(v8.v8__BackingStore__Data(backing_store_handle)));
    const base = data + byte_offset / @sizeOf(T);
    const n = @min(values.len, byte_len / @sizeOf(T));
    for (values[0..n], 0..) |value, i| {
        base[i] = @as(T, value);
    }
}

pub fn getContextAttributes(_: *const WebGLRenderingContext) ContextAttributes {
    return .{};
}

pub fn isContextLost(_: *const WebGLRenderingContext) bool {
    return false;
}

pub fn getShaderParameter(_: *const WebGLRenderingContext, _: *const WebGLShader, pname: u32) bool {
    return pname == COMPILE_STATUS;
}

pub fn getProgramParameter(_: *const WebGLRenderingContext, _: *const WebGLProgram, pname: u32) bool {
    return pname == LINK_STATUS;
}

pub fn getShaderInfoLog(_: *const WebGLRenderingContext, _: *const WebGLShader) []const u8 {
    return "";
}

pub fn getProgramInfoLog(_: *const WebGLRenderingContext, _: *const WebGLProgram) []const u8 {
    return "";
}

pub fn getError(_: *const WebGLRenderingContext) u32 {
    return 0;
}

pub fn createBuffer(_: *const WebGLRenderingContext, exec: *Execution) !*WebGLBuffer {
    return exec._factory.create(WebGLBuffer{});
}

pub fn createShader(_: *const WebGLRenderingContext, _: u32, exec: *Execution) !*WebGLShader {
    return exec._factory.create(WebGLShader{});
}

pub fn createProgram(_: *const WebGLRenderingContext, exec: *Execution) !*WebGLProgram {
    return exec._factory.create(WebGLProgram{});
}

pub fn createTexture(_: *const WebGLRenderingContext, exec: *Execution) !*WebGLTexture {
    return exec._factory.create(WebGLTexture{});
}

pub fn createFramebuffer(_: *const WebGLRenderingContext, exec: *Execution) !*WebGLFramebuffer {
    return exec._factory.create(WebGLFramebuffer{});
}

pub fn createRenderbuffer(_: *const WebGLRenderingContext, exec: *Execution) !*WebGLRenderbuffer {
    return exec._factory.create(WebGLRenderbuffer{});
}

pub fn getUniformLocation(_: *const WebGLRenderingContext, _: *const WebGLProgram, _: []const u8, exec: *Execution) !*WebGLUniformLocation {
    return exec._factory.create(WebGLUniformLocation{});
}

/// Returns the location of an attribute variable in a given WebGLProgram.
/// Per the WebGL spec, returns -1 if the name does not correspond to an active attribute.
/// Since rendering is a no-op stub, we always return -1 (no active attributes).
pub fn getAttribLocation(_: *const WebGLRenderingContext, _: *const WebGLProgram, _: []const u8) i32 {
    return -1;
}

pub fn noop(_: *const WebGLRenderingContext) void {}

/// Enables a WebGL extension.
pub fn getExtension(_: *const WebGLRenderingContext, name: []const u8, exec: *Execution) !?Extension {
    const tag = Extension.find(name) orelse return null;

    return switch (tag) {
        .WEBGL_debug_renderer_info => {
            const info = try exec._factory.create(Extension.Type.WEBGL_debug_renderer_info{});
            return .{ .WEBGL_debug_renderer_info = info };
        },
        .WEBGL_lose_context => {
            const ctx = try exec._factory.create(Extension.Type.WEBGL_lose_context{});
            return .{ .WEBGL_lose_context = ctx };
        },
        .EXT_texture_filter_anisotropic => {
            const ext = try exec._factory.create(Extension.Type.EXT_texture_filter_anisotropic{});
            return .{ .EXT_texture_filter_anisotropic = ext };
        },
        .WEBGL_draw_buffers => {
            const ext = try exec._factory.create(Extension.Type.WEBGL_draw_buffers{});
            return .{ .WEBGL_draw_buffers = ext };
        },
        inline else => |comptime_enum| @unionInit(Extension, @tagName(comptime_enum), {}),
    };
}

/// Returns a list of all the supported WebGL extensions.
pub fn getSupportedExtensions(_: *const WebGLRenderingContext) []const []const u8 {
    return std.meta.fieldNames(Extension.Kind);
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(WebGLRenderingContext);

    pub const Meta = struct {
        pub const name = "WebGLRenderingContext";

        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };

    pub const getParameter = bridge.function(WebGLRenderingContext.getParameter, .{});
    pub const getContextAttributes = bridge.function(WebGLRenderingContext.getContextAttributes, .{});
    pub const isContextLost = bridge.function(WebGLRenderingContext.isContextLost, .{});
    pub const getShaderParameter = bridge.function(WebGLRenderingContext.getShaderParameter, .{});
    pub const getProgramParameter = bridge.function(WebGLRenderingContext.getProgramParameter, .{});
    pub const getShaderInfoLog = bridge.function(WebGLRenderingContext.getShaderInfoLog, .{});
    pub const getProgramInfoLog = bridge.function(WebGLRenderingContext.getProgramInfoLog, .{});
    pub const getError = bridge.function(WebGLRenderingContext.getError, .{});
    pub const getShaderPrecisionFormat = bridge.function(WebGLRenderingContext.getShaderPrecisionFormat, .{});
    pub const readPixels = bridge.function(WebGLRenderingContext.readPixels, .{});
    pub const createBuffer = bridge.function(WebGLRenderingContext.createBuffer, .{});
    pub const createShader = bridge.function(WebGLRenderingContext.createShader, .{});
    pub const createProgram = bridge.function(WebGLRenderingContext.createProgram, .{});
    pub const createTexture = bridge.function(WebGLRenderingContext.createTexture, .{});
    pub const createFramebuffer = bridge.function(WebGLRenderingContext.createFramebuffer, .{});
    pub const createRenderbuffer = bridge.function(WebGLRenderingContext.createRenderbuffer, .{});
    pub const getUniformLocation = bridge.function(WebGLRenderingContext.getUniformLocation, .{});
    pub const getAttribLocation = bridge.function(WebGLRenderingContext.getAttribLocation, .{});
    pub const uniform1f = bridge.function(WebGLRenderingContext.noop, .{ .noop = true });
    pub const uniform2f = bridge.function(WebGLRenderingContext.noop, .{ .noop = true });
    pub const uniform3f = bridge.function(WebGLRenderingContext.noop, .{ .noop = true });
    pub const uniform4f = bridge.function(WebGLRenderingContext.noop, .{ .noop = true });
    pub const uniform1i = bridge.function(WebGLRenderingContext.noop, .{ .noop = true });
    pub const uniform2i = bridge.function(WebGLRenderingContext.noop, .{ .noop = true });
    pub const uniform3i = bridge.function(WebGLRenderingContext.noop, .{ .noop = true });
    pub const uniform4i = bridge.function(WebGLRenderingContext.noop, .{ .noop = true });
    pub const uniform1fv = bridge.function(WebGLRenderingContext.noop, .{ .noop = true });
    pub const uniform2fv = bridge.function(WebGLRenderingContext.noop, .{ .noop = true });
    pub const uniform3fv = bridge.function(WebGLRenderingContext.noop, .{ .noop = true });
    pub const uniform4fv = bridge.function(WebGLRenderingContext.noop, .{ .noop = true });
    pub const uniform1iv = bridge.function(WebGLRenderingContext.noop, .{ .noop = true });
    pub const uniform2iv = bridge.function(WebGLRenderingContext.noop, .{ .noop = true });
    pub const uniform3iv = bridge.function(WebGLRenderingContext.noop, .{ .noop = true });
    pub const uniform4iv = bridge.function(WebGLRenderingContext.noop, .{ .noop = true });
    pub const uniformMatrix2fv = bridge.function(WebGLRenderingContext.noop, .{ .noop = true });
    pub const uniformMatrix3fv = bridge.function(WebGLRenderingContext.noop, .{ .noop = true });
    pub const uniformMatrix4fv = bridge.function(WebGLRenderingContext.noop, .{ .noop = true });
    pub const bindBuffer = bridge.function(WebGLRenderingContext.noop, .{ .noop = true });
    pub const bufferData = bridge.function(WebGLRenderingContext.noop, .{ .noop = true });
    pub const shaderSource = bridge.function(WebGLRenderingContext.noop, .{ .noop = true });
    pub const compileShader = bridge.function(WebGLRenderingContext.noop, .{ .noop = true });
    pub const attachShader = bridge.function(WebGLRenderingContext.noop, .{ .noop = true });
    pub const linkProgram = bridge.function(WebGLRenderingContext.noop, .{ .noop = true });
    pub const useProgram = bridge.function(WebGLRenderingContext.noop, .{ .noop = true });
    pub const viewport = bridge.function(WebGLRenderingContext.noop, .{ .noop = true });
    pub const clearColor = bridge.function(WebGLRenderingContext.noop, .{ .noop = true });
    pub const clear = bridge.function(WebGLRenderingContext.noop, .{ .noop = true });
    pub const bindTexture = bridge.function(WebGLRenderingContext.noop, .{ .noop = true });
    pub const texImage2D = bridge.function(WebGLRenderingContext.noop, .{ .noop = true });
    pub const texParameteri = bridge.function(WebGLRenderingContext.noop, .{ .noop = true });
    pub const activeTexture = bridge.function(WebGLRenderingContext.noop, .{ .noop = true });
    pub const enableVertexAttribArray = bridge.function(WebGLRenderingContext.noop, .{ .noop = true });
    pub const vertexAttribPointer = bridge.function(WebGLRenderingContext.noop, .{ .noop = true });
    pub const drawArrays = bridge.function(WebGLRenderingContext.noop, .{ .noop = true });
    pub const drawElements = bridge.function(WebGLRenderingContext.noop, .{ .noop = true });
    pub const getExtension = bridge.function(WebGLRenderingContext.getExtension, .{});
    pub const getSupportedExtensions = bridge.function(WebGLRenderingContext.getSupportedExtensions, .{});

    pub const canvas = bridge.accessor(WebGLRenderingContext.getCanvas, null, .{});
    pub const drawingBufferWidth = bridge.accessor(WebGLRenderingContext.getDrawingBufferWidth, null, .{});
    pub const drawingBufferHeight = bridge.accessor(WebGLRenderingContext.getDrawingBufferHeight, null, .{});

    pub const ARRAY_BUFFER = bridge.property(WebGLRenderingContext.ARRAY_BUFFER, .{ .template = false, .readonly = true });
    pub const ELEMENT_ARRAY_BUFFER = bridge.property(WebGLRenderingContext.ELEMENT_ARRAY_BUFFER, .{ .template = false, .readonly = true });
    pub const STATIC_DRAW = bridge.property(WebGLRenderingContext.STATIC_DRAW, .{ .template = false, .readonly = true });
    pub const FLOAT = bridge.property(WebGLRenderingContext.FLOAT, .{ .template = false, .readonly = true });
    pub const TRIANGLES = bridge.property(WebGLRenderingContext.TRIANGLES, .{ .template = false, .readonly = true });
    pub const POINTS = bridge.property(WebGLRenderingContext.POINTS, .{ .template = false, .readonly = true });
    pub const LINES = bridge.property(WebGLRenderingContext.LINES, .{ .template = false, .readonly = true });
    pub const COLOR_BUFFER_BIT = bridge.property(WebGLRenderingContext.COLOR_BUFFER_BIT, .{ .template = false, .readonly = true });
    pub const DEPTH_BUFFER_BIT = bridge.property(WebGLRenderingContext.DEPTH_BUFFER_BIT, .{ .template = false, .readonly = true });
    pub const STENCIL_BUFFER_BIT = bridge.property(WebGLRenderingContext.STENCIL_BUFFER_BIT, .{ .template = false, .readonly = true });
    pub const VERTEX_SHADER = bridge.property(WebGLRenderingContext.VERTEX_SHADER, .{ .template = false, .readonly = true });
    pub const FRAGMENT_SHADER = bridge.property(WebGLRenderingContext.FRAGMENT_SHADER, .{ .template = false, .readonly = true });
    pub const COMPILE_STATUS = bridge.property(WebGLRenderingContext.COMPILE_STATUS, .{ .template = false, .readonly = true });
    pub const LINK_STATUS = bridge.property(WebGLRenderingContext.LINK_STATUS, .{ .template = false, .readonly = true });
    pub const VERSION = bridge.property(WebGLRenderingContext.VERSION, .{ .template = false, .readonly = true });
    pub const VENDOR = bridge.property(WebGLRenderingContext.VENDOR, .{ .template = false, .readonly = true });
    pub const RENDERER = bridge.property(WebGLRenderingContext.RENDERER, .{ .template = false, .readonly = true });
    pub const SHADING_LANGUAGE_VERSION = bridge.property(WebGLRenderingContext.SHADING_LANGUAGE_VERSION, .{ .template = false, .readonly = true });
    pub const MAX_TEXTURE_SIZE = bridge.property(WebGLRenderingContext.MAX_TEXTURE_SIZE, .{ .template = false, .readonly = true });
    pub const MAX_CUBE_MAP_TEXTURE_SIZE = bridge.property(WebGLRenderingContext.MAX_CUBE_MAP_TEXTURE_SIZE, .{ .template = false, .readonly = true });
    pub const MAX_RENDERBUFFER_SIZE = bridge.property(WebGLRenderingContext.MAX_RENDERBUFFER_SIZE, .{ .template = false, .readonly = true });
    pub const MAX_VIEWPORT_DIMS = bridge.property(WebGLRenderingContext.MAX_VIEWPORT_DIMS, .{ .template = false, .readonly = true });
    pub const MAX_VERTEX_ATTRIBS = bridge.property(WebGLRenderingContext.MAX_VERTEX_ATTRIBS, .{ .template = false, .readonly = true });
    pub const MAX_VERTEX_UNIFORM_VECTORS = bridge.property(WebGLRenderingContext.MAX_VERTEX_UNIFORM_VECTORS, .{ .template = false, .readonly = true });
    pub const MAX_VARYING_VECTORS = bridge.property(WebGLRenderingContext.MAX_VARYING_VECTORS, .{ .template = false, .readonly = true });
    pub const MAX_COMBINED_TEXTURE_IMAGE_UNITS = bridge.property(WebGLRenderingContext.MAX_COMBINED_TEXTURE_IMAGE_UNITS, .{ .template = false, .readonly = true });
    pub const MAX_VERTEX_TEXTURE_IMAGE_UNITS = bridge.property(WebGLRenderingContext.MAX_VERTEX_TEXTURE_IMAGE_UNITS, .{ .template = false, .readonly = true });
    pub const MAX_TEXTURE_IMAGE_UNITS = bridge.property(WebGLRenderingContext.MAX_TEXTURE_IMAGE_UNITS, .{ .template = false, .readonly = true });
    pub const MAX_FRAGMENT_UNIFORM_VECTORS = bridge.property(WebGLRenderingContext.MAX_FRAGMENT_UNIFORM_VECTORS, .{ .template = false, .readonly = true });
    pub const ALIASED_LINE_WIDTH_RANGE = bridge.property(WebGLRenderingContext.ALIASED_LINE_WIDTH_RANGE, .{ .template = false, .readonly = true });
    pub const ALIASED_POINT_SIZE_RANGE = bridge.property(WebGLRenderingContext.ALIASED_POINT_SIZE_RANGE, .{ .template = false, .readonly = true });
    pub const HIGH_FLOAT = bridge.property(WebGLRenderingContext.HIGH_FLOAT, .{ .template = false, .readonly = true });
    pub const MEDIUM_FLOAT = bridge.property(WebGLRenderingContext.MEDIUM_FLOAT, .{ .template = false, .readonly = true });
    pub const LOW_FLOAT = bridge.property(WebGLRenderingContext.LOW_FLOAT, .{ .template = false, .readonly = true });
    pub const HIGH_INT = bridge.property(WebGLRenderingContext.HIGH_INT, .{ .template = false, .readonly = true });
    pub const MEDIUM_INT = bridge.property(WebGLRenderingContext.MEDIUM_INT, .{ .template = false, .readonly = true });
    pub const LOW_INT = bridge.property(WebGLRenderingContext.LOW_INT, .{ .template = false, .readonly = true });
    pub const RGBA = bridge.property(WebGLRenderingContext.RGBA, .{ .template = false, .readonly = true });
    pub const UNSIGNED_BYTE = bridge.property(WebGLRenderingContext.UNSIGNED_BYTE, .{ .template = false, .readonly = true });
};

const ContextAttributes = struct {
    alpha: bool = true,
    antialias: bool = true,
    depth: bool = true,
    desynchronized: bool = false,
    failIfMajorPerformanceCaveat: bool = false,
    powerPreference: []const u8 = "default",
    premultipliedAlpha: bool = true,
    preserveDrawingBuffer: bool = false,
    stencil: bool = false,
    xrCompatible: bool = false,
};

const WebGLBuffer = opaqueResource("WebGLBuffer");
const WebGLShader = opaqueResource("WebGLShader");
const WebGLProgram = opaqueResource("WebGLProgram");
const WebGLTexture = opaqueResource("WebGLTexture");
const WebGLFramebuffer = opaqueResource("WebGLFramebuffer");
const WebGLRenderbuffer = opaqueResource("WebGLRenderbuffer");
const WebGLUniformLocation = opaqueResource("WebGLUniformLocation");

fn opaqueResource(comptime type_name: []const u8) type {
    return struct {
        const Self = @This();

        _: u8 = 0,

        pub const JsApi = struct {
            pub const bridge = js.Bridge(Self);

            pub const Meta = struct {
                pub const name = type_name;
                pub const prototype_chain = bridge.prototypeChain();
                pub var class_id: bridge.ClassId = undefined;
            };
        };
    };
}

// getContext('web-gl') currently returns null, so this cannot be tested
// const testing = @import("../../../testing/testing.zig");
// test "WebApi: WebGLRenderingContext" {
//     try testing.htmlRunner("canvas/webgl_rendering_context.html", .{});
// }
