const Frame = @import("../../core/browser/Frame.zig");
const WebGLRenderingContext = @import("../../core/webapi/canvas/WebGLRenderingContext.zig");
const WebGLParameters = @import("WebGLParameters.zig");
const js = @import("../../core/js/js.zig");

pub const Baseline = struct {
    read_width: i32,
    read_height: i32,
    pixels: []const u8,
    pixels2: []const u8,
    data_uri: ?[]const u8,
    data_uri2: ?[]const u8,
};

pub fn baseline(frame: *Frame) ?Baseline {
    const profile = frame.loadedProfile();
    if (profile.mode != .antidetect) return null;
    const pixels = profile.webgl_probe_pixels orelse return null;
    if (pixels.len == 0) return null;
    return .{
        .read_width = profile.webgl_probe_read_width,
        .read_height = profile.webgl_probe_read_height,
        .pixels = pixels,
        .pixels2 = profile.webgl_probe_pixels2 orelse &.{},
        .data_uri = profile.webgl_probe_data_uri,
        .data_uri2 = profile.webgl_probe_data_uri2,
    };
}

pub fn dataUrlBaseline(
    frame: *Frame,
    _: u32,
    _: u32,
    is_webgl2: bool,
) ?[]const u8 {
    const bl = baseline(frame) orelse return null;
    if (is_webgl2) return bl.data_uri2;
    return bl.data_uri;
}

fn canvasDimensions(ctx: *const WebGLRenderingContext) ?struct { width: u32, height: u32 } {
    if (ctx._offscreen_canvas) |oc| {
        return .{ .width = oc.getWidth(), .height = oc.getHeight() };
    }
    if (ctx._canvas) |c| {
        return .{ .width = c.getWidth(), .height = c.getHeight() };
    }
    return null;
}

pub fn parameterValue(frame: *Frame, pname: u32) ?WebGLParameters.Value {
    const profile = frame.loadedProfile();
    if (profile.mode != .antidetect) return null;
    return WebGLParameters.get(&profile.webgl_probe_parameters, pname);
}

pub fn parameterJsValue(frame: *Frame, pname: u32, local: *const js.Local) !?js.Value {
    const val = parameterValue(frame, pname) orelse return null;
    return try WebGLParameters.toJs(val, local);
}

pub fn readPixelsBaseline(
    frame: *Frame,
    ctx: *const WebGLRenderingContext,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) ?[]const u8 {
    const bl = baseline(frame) orelse return null;
    if (x != 0 or y != 0) return null;
    if (width != bl.read_width or height != bl.read_height) return null;

    const dims = canvasDimensions(ctx) orelse return null;
    if (dims.width != 256 or dims.height != 256) return null;

    if (ctx._is_webgl2) {
        if (bl.pixels2.len == 0) return null;
        return bl.pixels2;
    }
    return bl.pixels;
}
