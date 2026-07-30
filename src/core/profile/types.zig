const std = @import("std");

pub const PersonaId = enum {
    macos_catalina_intel,
    macos_sonoma_intel,
    windows_11_intel,
};

pub const ScreenProfile = struct {
    width: u32,
    height: u32,
    avail_width: u32,
    avail_height: u32,
    device_pixel_ratio: f64,
    color_depth: u8,
    pixel_depth: u8,
    touch: bool,
};

/// Viewport chrome — distinct from screen.* (full display).
pub const WindowProfile = struct {
    inner_width: u32,
    inner_height: u32,
    outer_width: u32,
    outer_height: u32,
};

pub const WebGLProfile = struct {
    version: []const u8,
    vendor: []const u8,
    renderer: []const u8,
    shading_language_version: []const u8,
    unmasked_vendor: []const u8,
    unmasked_renderer: []const u8,
    max_texture_size: u32,
    max_cube_map_texture_size: u32,
    max_renderbuffer_size: u32,
    max_vertex_attribs: u32,
    max_vertex_uniform_vectors: u32,
    max_varying_vectors: u32,
    max_combined_texture_image_units: u32,
    max_vertex_texture_image_units: u32,
    max_texture_image_units: u32,
    max_fragment_uniform_vectors: u32,
    max_draw_buffers: u32,
    max_color_attachments_webgl2: u32 = 8,
    max_samples_webgl2: u32 = 4,
    max_3d_texture_size_webgl2: u32 = 2048,
    max_array_texture_layers_webgl2: u32 = 2048,
    max_texture_max_anisotropy: u32,
    max_viewport_dims: [2]i32,
    aliased_line_width_range: [2]f32,
    aliased_point_size_range: [2]f32,
    extensions: []const []const u8,
    extensions_webgl2: []const []const u8 = &.{},
};

pub const IdentityProfile = struct {
    persona_id: PersonaId,
    navigator_platform: []const u8,
    ua_data_platform: []const u8,
    ua_architecture: []const u8,
    ua_bitness: []const u8,
    locale: []const u8,
    languages: []const []const u8,
    timezone: []const u8,
    hardware_concurrency: u32,
    device_memory: f64,
    max_touch_points: u32,
    pdf_viewer_enabled: bool,
    global_privacy_control: bool,
    vendor: []const u8,
    user_agent_fallback: []const u8,
    app_version: []const u8 = "1.0",
    platform_version: []const u8 = "",
    ua_full_version: []const u8 = "1.0.0.0",
    ua_mobile: bool = false,
    screen: ScreenProfile,
    window: WindowProfile,
    webgl: WebGLProfile,
    fonts: []const []const u8,
};

pub fn defaultWindowForScreen(screen: ScreenProfile) WindowProfile {
    const inner_w = @min(screen.width, 1280);
    const inner_h = @min(screen.height, 720);
    return .{
        .inner_width = inner_w,
        .inner_height = inner_h,
        .outer_width = inner_w + 2,
        .outer_height = inner_h + 80,
    };
}

pub fn isFontFamilyAvailable(profile: *const IdentityProfile, family: []const u8) bool {
    for (profile.fonts) |available| {
        if (std.ascii.eqlIgnoreCase(family, available)) return true;
    }
    return false;
}
