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
const Frame = @import("../../browser/Frame.zig");

pub fn registerTypes() []const type {
    return &.{
        WebGLRenderingContext,
        // Extension types should be runtime generated. We might want
        // to revisit this.
        Extension.Type.WEBGL_debug_renderer_info,
        Extension.Type.WEBGL_lose_context,
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
    EXT_texture_filter_anisotropic: void,
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
    WEBGL_draw_buffers: void,
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
    };
};

/// This actually takes "GLenum" which, in fact, is a fancy way to say number.
/// Return value also depends on what's being passed as `pname`; we don't really
/// support any though.
pub fn getParameter(_: *const WebGLRenderingContext, pname: u32) []const u8 {
    return switch (pname) {
        VERSION => "WebGL 1.0 (OpenGL ES 2.0 Chromium)",
        VENDOR => "WebKit",
        RENDERER => "WebKit WebGL",
        SHADING_LANGUAGE_VERSION => "WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)",
        Extension.Type.WEBGL_debug_renderer_info.UNMASKED_VENDOR_WEBGL => "Google Inc. (Apple)",
        Extension.Type.WEBGL_debug_renderer_info.UNMASKED_RENDERER_WEBGL => "ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)",
        else => "",
    };
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

pub fn createBuffer(_: *const WebGLRenderingContext, frame: *Frame) !*WebGLBuffer {
    return frame._factory.create(WebGLBuffer{});
}

pub fn createShader(_: *const WebGLRenderingContext, _: u32, frame: *Frame) !*WebGLShader {
    return frame._factory.create(WebGLShader{});
}

pub fn createProgram(_: *const WebGLRenderingContext, frame: *Frame) !*WebGLProgram {
    return frame._factory.create(WebGLProgram{});
}

pub fn createTexture(_: *const WebGLRenderingContext, frame: *Frame) !*WebGLTexture {
    return frame._factory.create(WebGLTexture{});
}

pub fn createFramebuffer(_: *const WebGLRenderingContext, frame: *Frame) !*WebGLFramebuffer {
    return frame._factory.create(WebGLFramebuffer{});
}

pub fn createRenderbuffer(_: *const WebGLRenderingContext, frame: *Frame) !*WebGLRenderbuffer {
    return frame._factory.create(WebGLRenderbuffer{});
}

pub fn getUniformLocation(_: *const WebGLRenderingContext, _: *const WebGLProgram, _: []const u8, frame: *Frame) !*WebGLUniformLocation {
    return frame._factory.create(WebGLUniformLocation{});
}

pub fn noop(_: *const WebGLRenderingContext) void {}

/// Enables a WebGL extension.
pub fn getExtension(_: *const WebGLRenderingContext, name: []const u8, frame: *Frame) !?Extension {
    const tag = Extension.find(name) orelse return null;

    return switch (tag) {
        .WEBGL_debug_renderer_info => {
            const info = try frame._factory.create(Extension.Type.WEBGL_debug_renderer_info{});
            return .{ .WEBGL_debug_renderer_info = info };
        },
        .WEBGL_lose_context => {
            const ctx = try frame._factory.create(Extension.Type.WEBGL_lose_context{});
            return .{ .WEBGL_lose_context = ctx };
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
    pub const createBuffer = bridge.function(WebGLRenderingContext.createBuffer, .{});
    pub const createShader = bridge.function(WebGLRenderingContext.createShader, .{});
    pub const createProgram = bridge.function(WebGLRenderingContext.createProgram, .{});
    pub const createTexture = bridge.function(WebGLRenderingContext.createTexture, .{});
    pub const createFramebuffer = bridge.function(WebGLRenderingContext.createFramebuffer, .{});
    pub const createRenderbuffer = bridge.function(WebGLRenderingContext.createRenderbuffer, .{});
    pub const getUniformLocation = bridge.function(WebGLRenderingContext.getUniformLocation, .{});
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
    pub const enableVertexAttribArray = bridge.function(WebGLRenderingContext.noop, .{ .noop = true });
    pub const vertexAttribPointer = bridge.function(WebGLRenderingContext.noop, .{ .noop = true });
    pub const drawArrays = bridge.function(WebGLRenderingContext.noop, .{ .noop = true });
    pub const drawElements = bridge.function(WebGLRenderingContext.noop, .{ .noop = true });
    pub const getExtension = bridge.function(WebGLRenderingContext.getExtension, .{});
    pub const getSupportedExtensions = bridge.function(WebGLRenderingContext.getSupportedExtensions, .{});

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
