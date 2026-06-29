const WebGLRenderingContext = @import("WebGLRenderingContext.zig");
const js = @import("../../js/js.zig");
const Execution = js.Execution;
const Frame = @import("../../browser/Frame.zig");
const Canvas = @import("../element/html/Canvas.zig");
const OffscreenCanvas = @import("OffscreenCanvas.zig");

/// WebGL2 context — same layout as WebGLRenderingContext with _is_webgl2 = true.
pub const WebGL2RenderingContext = struct {
    _canvas: ?*Canvas = null,
    _offscreen_canvas: ?*OffscreenCanvas = null,
    _is_webgl2: bool = true,

    fn asWebGL(self: *const WebGL2RenderingContext) *const WebGLRenderingContext {
        return @ptrCast(@alignCast(self));
    }

    pub fn getParameter(self: *const WebGL2RenderingContext, pname: u32, exec: *Execution) !js.Value {
        return WebGLRenderingContext.getParameter(@constCast(self.asWebGL()), pname, exec);
    }
    pub fn getContextAttributes(self: *const WebGL2RenderingContext) WebGLRenderingContext.ContextAttributes {
        return WebGLRenderingContext.getContextAttributes(@constCast(self.asWebGL()));
    }
    pub fn isContextLost(self: *const WebGL2RenderingContext) bool {
        return WebGLRenderingContext.isContextLost(@constCast(self.asWebGL()));
    }
    pub fn getShaderParameter(self: *const WebGL2RenderingContext, shader: *const WebGLRenderingContext.WebGLShader, pname: u32) bool {
        return WebGLRenderingContext.getShaderParameter(@constCast(self.asWebGL()), shader, pname);
    }
    pub fn getProgramParameter(self: *const WebGL2RenderingContext, program: *const WebGLRenderingContext.WebGLProgram, pname: u32) bool {
        return WebGLRenderingContext.getProgramParameter(@constCast(self.asWebGL()), program, pname);
    }
    pub fn getShaderInfoLog(self: *const WebGL2RenderingContext, shader: *const WebGLRenderingContext.WebGLShader) []const u8 {
        return WebGLRenderingContext.getShaderInfoLog(@constCast(self.asWebGL()), shader);
    }
    pub fn getProgramInfoLog(self: *const WebGL2RenderingContext, program: *const WebGLRenderingContext.WebGLProgram) []const u8 {
        return WebGLRenderingContext.getProgramInfoLog(@constCast(self.asWebGL()), program);
    }
    pub fn getError(self: *const WebGL2RenderingContext) u32 {
        return WebGLRenderingContext.getError(@constCast(self.asWebGL()));
    }
    pub fn getShaderPrecisionFormat(self: *const WebGL2RenderingContext, shader_type: u32, precision_type: u32, exec: *Execution) !js.Value {
        return WebGLRenderingContext.getShaderPrecisionFormat(@constCast(self.asWebGL()), shader_type, precision_type, exec);
    }
    pub fn readPixels(self: *const WebGL2RenderingContext, x: i32, y: i32, width: i32, height: i32, format: u32, pixel_type: u32, pixels: js.Value, exec: *Execution) !void {
        return WebGLRenderingContext.readPixels(@constCast(self.asWebGL()), x, y, width, height, format, pixel_type, pixels, exec);
    }
    pub fn createBuffer(self: *const WebGL2RenderingContext, exec: *Execution) !*WebGLRenderingContext.WebGLBuffer {
        return WebGLRenderingContext.createBuffer(@constCast(self.asWebGL()), exec);
    }
    pub fn createShader(self: *const WebGL2RenderingContext, shader_type: u32, exec: *Execution) !*WebGLRenderingContext.WebGLShader {
        return WebGLRenderingContext.createShader(@constCast(self.asWebGL()), shader_type, exec);
    }
    pub fn createProgram(self: *const WebGL2RenderingContext, exec: *Execution) !*WebGLRenderingContext.WebGLProgram {
        return WebGLRenderingContext.createProgram(@constCast(self.asWebGL()), exec);
    }
    pub fn createTexture(self: *const WebGL2RenderingContext, exec: *Execution) !*WebGLRenderingContext.WebGLTexture {
        return WebGLRenderingContext.createTexture(@constCast(self.asWebGL()), exec);
    }
    pub fn createFramebuffer(self: *const WebGL2RenderingContext, exec: *Execution) !*WebGLRenderingContext.WebGLFramebuffer {
        return WebGLRenderingContext.createFramebuffer(@constCast(self.asWebGL()), exec);
    }
    pub fn createRenderbuffer(self: *const WebGL2RenderingContext, exec: *Execution) !*WebGLRenderingContext.WebGLRenderbuffer {
        return WebGLRenderingContext.createRenderbuffer(@constCast(self.asWebGL()), exec);
    }
    pub fn getUniformLocation(self: *const WebGL2RenderingContext, program: *const WebGLRenderingContext.WebGLProgram, name: []const u8, exec: *Execution) !*WebGLRenderingContext.WebGLUniformLocation {
        return WebGLRenderingContext.getUniformLocation(@constCast(self.asWebGL()), program, name, exec);
    }
    pub fn getAttribLocation(self: *const WebGL2RenderingContext, program: *const WebGLRenderingContext.WebGLProgram, name: []const u8) i32 {
        return WebGLRenderingContext.getAttribLocation(@constCast(self.asWebGL()), program, name);
    }
    pub fn noop(_: *const WebGL2RenderingContext) void {}
    pub fn getExtension(self: *const WebGL2RenderingContext, name: []const u8, exec: *Execution) !?WebGLRenderingContext.Extension {
        return WebGLRenderingContext.getExtension(@constCast(self.asWebGL()), name, exec);
    }
    pub fn getSupportedExtensions(self: *const WebGL2RenderingContext, exec: *Execution) []const []const u8 {
        return WebGLRenderingContext.getSupportedExtensions(@constCast(self.asWebGL()), exec);
    }
    pub fn getCanvas(self: *const WebGL2RenderingContext, frame: *Frame) js.Value {
        return WebGLRenderingContext.getCanvas(@constCast(self.asWebGL()), frame);
    }
    pub fn getDrawingBufferWidth(self: *const WebGL2RenderingContext) u32 {
        return WebGLRenderingContext.getDrawingBufferWidth(@constCast(self.asWebGL()));
    }
    pub fn getDrawingBufferHeight(self: *const WebGL2RenderingContext) u32 {
        return WebGLRenderingContext.getDrawingBufferHeight(@constCast(self.asWebGL()));
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(WebGL2RenderingContext);

        pub const Meta = struct {
            pub const name = "WebGL2RenderingContext";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
        };

        pub const getParameter = bridge.function(WebGL2RenderingContext.getParameter, .{});
        pub const getContextAttributes = bridge.function(WebGL2RenderingContext.getContextAttributes, .{});
        pub const isContextLost = bridge.function(WebGL2RenderingContext.isContextLost, .{});
        pub const getShaderParameter = bridge.function(WebGL2RenderingContext.getShaderParameter, .{});
        pub const getProgramParameter = bridge.function(WebGL2RenderingContext.getProgramParameter, .{});
        pub const getShaderInfoLog = bridge.function(WebGL2RenderingContext.getShaderInfoLog, .{});
        pub const getProgramInfoLog = bridge.function(WebGL2RenderingContext.getProgramInfoLog, .{});
        pub const getError = bridge.function(WebGL2RenderingContext.getError, .{});
        pub const getShaderPrecisionFormat = bridge.function(WebGL2RenderingContext.getShaderPrecisionFormat, .{});
        pub const readPixels = bridge.function(WebGL2RenderingContext.readPixels, .{});
        pub const createBuffer = bridge.function(WebGL2RenderingContext.createBuffer, .{});
        pub const createShader = bridge.function(WebGL2RenderingContext.createShader, .{});
        pub const createProgram = bridge.function(WebGL2RenderingContext.createProgram, .{});
        pub const createTexture = bridge.function(WebGL2RenderingContext.createTexture, .{});
        pub const createFramebuffer = bridge.function(WebGL2RenderingContext.createFramebuffer, .{});
        pub const createRenderbuffer = bridge.function(WebGL2RenderingContext.createRenderbuffer, .{});
        pub const getUniformLocation = bridge.function(WebGL2RenderingContext.getUniformLocation, .{});
        pub const getAttribLocation = bridge.function(WebGL2RenderingContext.getAttribLocation, .{});
        pub const uniform1f = bridge.function(WebGL2RenderingContext.noop, .{ .noop = true });
        pub const uniform2f = bridge.function(WebGL2RenderingContext.noop, .{ .noop = true });
        pub const uniform3f = bridge.function(WebGL2RenderingContext.noop, .{ .noop = true });
        pub const uniform4f = bridge.function(WebGL2RenderingContext.noop, .{ .noop = true });
        pub const uniform1i = bridge.function(WebGL2RenderingContext.noop, .{ .noop = true });
        pub const uniform2i = bridge.function(WebGL2RenderingContext.noop, .{ .noop = true });
        pub const uniform3i = bridge.function(WebGL2RenderingContext.noop, .{ .noop = true });
        pub const uniform4i = bridge.function(WebGL2RenderingContext.noop, .{ .noop = true });
        pub const uniform1fv = bridge.function(WebGL2RenderingContext.noop, .{ .noop = true });
        pub const uniform2fv = bridge.function(WebGL2RenderingContext.noop, .{ .noop = true });
        pub const uniform3fv = bridge.function(WebGL2RenderingContext.noop, .{ .noop = true });
        pub const uniform4fv = bridge.function(WebGL2RenderingContext.noop, .{ .noop = true });
        pub const uniform1iv = bridge.function(WebGL2RenderingContext.noop, .{ .noop = true });
        pub const uniform2iv = bridge.function(WebGL2RenderingContext.noop, .{ .noop = true });
        pub const uniform3iv = bridge.function(WebGL2RenderingContext.noop, .{ .noop = true });
        pub const uniform4iv = bridge.function(WebGL2RenderingContext.noop, .{ .noop = true });
        pub const uniformMatrix2fv = bridge.function(WebGL2RenderingContext.noop, .{ .noop = true });
        pub const uniformMatrix3fv = bridge.function(WebGL2RenderingContext.noop, .{ .noop = true });
        pub const uniformMatrix4fv = bridge.function(WebGL2RenderingContext.noop, .{ .noop = true });
        pub const bindBuffer = bridge.function(WebGL2RenderingContext.noop, .{ .noop = true });
        pub const bufferData = bridge.function(WebGL2RenderingContext.noop, .{ .noop = true });
        pub const shaderSource = bridge.function(WebGL2RenderingContext.noop, .{ .noop = true });
        pub const compileShader = bridge.function(WebGL2RenderingContext.noop, .{ .noop = true });
        pub const attachShader = bridge.function(WebGL2RenderingContext.noop, .{ .noop = true });
        pub const linkProgram = bridge.function(WebGL2RenderingContext.noop, .{ .noop = true });
        pub const useProgram = bridge.function(WebGL2RenderingContext.noop, .{ .noop = true });
        pub const viewport = bridge.function(WebGL2RenderingContext.noop, .{ .noop = true });
        pub const clearColor = bridge.function(WebGL2RenderingContext.noop, .{ .noop = true });
        pub const clear = bridge.function(WebGL2RenderingContext.noop, .{ .noop = true });
        pub const bindTexture = bridge.function(WebGL2RenderingContext.noop, .{ .noop = true });
        pub const texImage2D = bridge.function(WebGL2RenderingContext.noop, .{ .noop = true });
        pub const texParameteri = bridge.function(WebGL2RenderingContext.noop, .{ .noop = true });
        pub const activeTexture = bridge.function(WebGL2RenderingContext.noop, .{ .noop = true });
        pub const enableVertexAttribArray = bridge.function(WebGL2RenderingContext.noop, .{ .noop = true });
        pub const vertexAttribPointer = bridge.function(WebGL2RenderingContext.noop, .{ .noop = true });
        pub const drawArrays = bridge.function(WebGL2RenderingContext.noop, .{ .noop = true });
        pub const drawElements = bridge.function(WebGL2RenderingContext.noop, .{ .noop = true });
        pub const getExtension = bridge.function(WebGL2RenderingContext.getExtension, .{});
        pub const getSupportedExtensions = bridge.function(WebGL2RenderingContext.getSupportedExtensions, .{});

        pub const canvas = bridge.accessor(WebGL2RenderingContext.getCanvas, null, .{});
        pub const drawingBufferWidth = bridge.accessor(WebGL2RenderingContext.getDrawingBufferWidth, null, .{});
        pub const drawingBufferHeight = bridge.accessor(WebGL2RenderingContext.getDrawingBufferHeight, null, .{});

        pub const ALIASED_POINT_SIZE_RANGE = bridge.property(WebGLRenderingContext.ALIASED_POINT_SIZE_RANGE, .{ .template = false, .readonly = true });
        pub const ALIASED_LINE_WIDTH_RANGE = bridge.property(WebGLRenderingContext.ALIASED_LINE_WIDTH_RANGE, .{ .template = false, .readonly = true });
        pub const STENCIL_VALUE_MASK = bridge.property(WebGLRenderingContext.STENCIL_VALUE_MASK, .{ .template = false, .readonly = true });
        pub const STENCIL_WRITEMASK = bridge.property(WebGLRenderingContext.STENCIL_WRITEMASK, .{ .template = false, .readonly = true });
        pub const STENCIL_BACK_VALUE_MASK = bridge.property(WebGLRenderingContext.STENCIL_BACK_VALUE_MASK, .{ .template = false, .readonly = true });
        pub const STENCIL_BACK_WRITEMASK = bridge.property(WebGLRenderingContext.STENCIL_BACK_WRITEMASK, .{ .template = false, .readonly = true });
        pub const MAX_TEXTURE_SIZE = bridge.property(WebGLRenderingContext.MAX_TEXTURE_SIZE, .{ .template = false, .readonly = true });
        pub const MAX_VIEWPORT_DIMS = bridge.property(WebGLRenderingContext.MAX_VIEWPORT_DIMS, .{ .template = false, .readonly = true });
        pub const SUBPIXEL_BITS = bridge.property(WebGLRenderingContext.SUBPIXEL_BITS, .{ .template = false, .readonly = true });
        pub const MAX_VERTEX_ATTRIBS = bridge.property(WebGLRenderingContext.MAX_VERTEX_ATTRIBS, .{ .template = false, .readonly = true });
        pub const MAX_VERTEX_UNIFORM_VECTORS = bridge.property(WebGLRenderingContext.MAX_VERTEX_UNIFORM_VECTORS, .{ .template = false, .readonly = true });
        pub const MAX_VARYING_VECTORS = bridge.property(WebGLRenderingContext.MAX_VARYING_VECTORS, .{ .template = false, .readonly = true });
        pub const MAX_COMBINED_TEXTURE_IMAGE_UNITS = bridge.property(WebGLRenderingContext.MAX_COMBINED_TEXTURE_IMAGE_UNITS, .{ .template = false, .readonly = true });
        pub const MAX_VERTEX_TEXTURE_IMAGE_UNITS = bridge.property(WebGLRenderingContext.MAX_VERTEX_TEXTURE_IMAGE_UNITS, .{ .template = false, .readonly = true });
        pub const MAX_TEXTURE_IMAGE_UNITS = bridge.property(WebGLRenderingContext.MAX_TEXTURE_IMAGE_UNITS, .{ .template = false, .readonly = true });
        pub const MAX_FRAGMENT_UNIFORM_VECTORS = bridge.property(WebGLRenderingContext.MAX_FRAGMENT_UNIFORM_VECTORS, .{ .template = false, .readonly = true });
        pub const SHADING_LANGUAGE_VERSION = bridge.property(WebGLRenderingContext.SHADING_LANGUAGE_VERSION, .{ .template = false, .readonly = true });
        pub const VENDOR = bridge.property(WebGLRenderingContext.VENDOR, .{ .template = false, .readonly = true });
        pub const RENDERER = bridge.property(WebGLRenderingContext.RENDERER, .{ .template = false, .readonly = true });
        pub const VERSION = bridge.property(WebGLRenderingContext.VERSION, .{ .template = false, .readonly = true });
        pub const MAX_CUBE_MAP_TEXTURE_SIZE = bridge.property(WebGLRenderingContext.MAX_CUBE_MAP_TEXTURE_SIZE, .{ .template = false, .readonly = true });
        pub const MAX_RENDERBUFFER_SIZE = bridge.property(WebGLRenderingContext.MAX_RENDERBUFFER_SIZE, .{ .template = false, .readonly = true });
        pub const MAX_3D_TEXTURE_SIZE = bridge.property(WebGLRenderingContext.MAX_3D_TEXTURE_SIZE, .{ .template = false, .readonly = true });
        pub const MAX_ELEMENTS_VERTICES = bridge.property(WebGLRenderingContext.MAX_ELEMENTS_VERTICES, .{ .template = false, .readonly = true });
        pub const MAX_ELEMENTS_INDICES = bridge.property(WebGLRenderingContext.MAX_ELEMENTS_INDICES, .{ .template = false, .readonly = true });
        pub const MAX_TEXTURE_LOD_BIAS = bridge.property(WebGLRenderingContext.MAX_TEXTURE_LOD_BIAS, .{ .template = false, .readonly = true });
        pub const MAX_DRAW_BUFFERS = bridge.property(WebGLRenderingContext.MAX_DRAW_BUFFERS, .{ .template = false, .readonly = true });
        pub const MAX_FRAGMENT_UNIFORM_COMPONENTS = bridge.property(WebGLRenderingContext.MAX_FRAGMENT_UNIFORM_COMPONENTS, .{ .template = false, .readonly = true });
        pub const MAX_VERTEX_UNIFORM_COMPONENTS = bridge.property(WebGLRenderingContext.MAX_VERTEX_UNIFORM_COMPONENTS, .{ .template = false, .readonly = true });
        pub const MAX_ARRAY_TEXTURE_LAYERS = bridge.property(WebGLRenderingContext.MAX_ARRAY_TEXTURE_LAYERS, .{ .template = false, .readonly = true });
        pub const MAX_PROGRAM_TEXEL_OFFSET = bridge.property(WebGLRenderingContext.MAX_PROGRAM_TEXEL_OFFSET, .{ .template = false, .readonly = true });
        pub const MAX_VARYING_COMPONENTS = bridge.property(WebGLRenderingContext.MAX_VARYING_COMPONENTS, .{ .template = false, .readonly = true });
        pub const MAX_TRANSFORM_FEEDBACK_SEPARATE_COMPONENTS = bridge.property(WebGLRenderingContext.MAX_TRANSFORM_FEEDBACK_SEPARATE_COMPONENTS, .{ .template = false, .readonly = true });
        pub const MAX_TRANSFORM_FEEDBACK_INTERLEAVED_COMPONENTS = bridge.property(WebGLRenderingContext.MAX_TRANSFORM_FEEDBACK_INTERLEAVED_COMPONENTS, .{ .template = false, .readonly = true });
        pub const MAX_TRANSFORM_FEEDBACK_SEPARATE_ATTRIBS = bridge.property(WebGLRenderingContext.MAX_TRANSFORM_FEEDBACK_SEPARATE_ATTRIBS, .{ .template = false, .readonly = true });
        pub const MAX_COLOR_ATTACHMENTS = bridge.property(WebGLRenderingContext.MAX_COLOR_ATTACHMENTS, .{ .template = false, .readonly = true });
        pub const MAX_SAMPLES = bridge.property(WebGLRenderingContext.MAX_SAMPLES, .{ .template = false, .readonly = true });
        pub const MAX_VERTEX_UNIFORM_BLOCKS = bridge.property(WebGLRenderingContext.MAX_VERTEX_UNIFORM_BLOCKS, .{ .template = false, .readonly = true });
        pub const MAX_FRAGMENT_UNIFORM_BLOCKS = bridge.property(WebGLRenderingContext.MAX_FRAGMENT_UNIFORM_BLOCKS, .{ .template = false, .readonly = true });
        pub const MAX_COMBINED_UNIFORM_BLOCKS = bridge.property(WebGLRenderingContext.MAX_COMBINED_UNIFORM_BLOCKS, .{ .template = false, .readonly = true });
        pub const MAX_UNIFORM_BUFFER_BINDINGS = bridge.property(WebGLRenderingContext.MAX_UNIFORM_BUFFER_BINDINGS, .{ .template = false, .readonly = true });
        pub const MAX_UNIFORM_BLOCK_SIZE = bridge.property(WebGLRenderingContext.MAX_UNIFORM_BLOCK_SIZE, .{ .template = false, .readonly = true });
        pub const MAX_COMBINED_VERTEX_UNIFORM_COMPONENTS = bridge.property(WebGLRenderingContext.MAX_COMBINED_VERTEX_UNIFORM_COMPONENTS, .{ .template = false, .readonly = true });
        pub const MAX_COMBINED_FRAGMENT_UNIFORM_COMPONENTS = bridge.property(WebGLRenderingContext.MAX_COMBINED_FRAGMENT_UNIFORM_COMPONENTS, .{ .template = false, .readonly = true });
        pub const MAX_VERTEX_OUTPUT_COMPONENTS = bridge.property(WebGLRenderingContext.MAX_VERTEX_OUTPUT_COMPONENTS, .{ .template = false, .readonly = true });
        pub const MAX_FRAGMENT_INPUT_COMPONENTS = bridge.property(WebGLRenderingContext.MAX_FRAGMENT_INPUT_COMPONENTS, .{ .template = false, .readonly = true });
        pub const MAX_SERVER_WAIT_TIMEOUT = bridge.property(WebGLRenderingContext.MAX_SERVER_WAIT_TIMEOUT, .{ .template = false, .readonly = true });
        pub const MAX_ELEMENT_INDEX = bridge.property(WebGLRenderingContext.MAX_ELEMENT_INDEX, .{ .template = false, .readonly = true });
        pub const MAX_CLIENT_WAIT_TIMEOUT_WEBGL = bridge.property(WebGLRenderingContext.MAX_CLIENT_WAIT_TIMEOUT_WEBGL, .{ .template = false, .readonly = true });

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
        pub const HIGH_FLOAT = bridge.property(WebGLRenderingContext.HIGH_FLOAT, .{ .template = false, .readonly = true });
        pub const MEDIUM_FLOAT = bridge.property(WebGLRenderingContext.MEDIUM_FLOAT, .{ .template = false, .readonly = true });
        pub const LOW_FLOAT = bridge.property(WebGLRenderingContext.LOW_FLOAT, .{ .template = false, .readonly = true });
        pub const HIGH_INT = bridge.property(WebGLRenderingContext.HIGH_INT, .{ .template = false, .readonly = true });
        pub const MEDIUM_INT = bridge.property(WebGLRenderingContext.MEDIUM_INT, .{ .template = false, .readonly = true });
        pub const LOW_INT = bridge.property(WebGLRenderingContext.LOW_INT, .{ .template = false, .readonly = true });
        pub const RGBA = bridge.property(WebGLRenderingContext.RGBA, .{ .template = false, .readonly = true });
        pub const UNSIGNED_BYTE = bridge.property(WebGLRenderingContext.UNSIGNED_BYTE, .{ .template = false, .readonly = true });
    };
};
