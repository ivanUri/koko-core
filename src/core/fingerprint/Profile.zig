const std = @import("std");

pub const PersonaId = enum {
    macos_catalina_intel,
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
    max_texture_max_anisotropy: u32,
    max_viewport_dims: [2]i32,
    aliased_line_width_range: [2]f32,
    aliased_point_size_range: [2]f32,
    extensions: []const []const u8,
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
    webgl: WebGLProfile,
    fonts: []const []const u8,
};

const macos_catalina_intel_languages = [_][]const u8{ "en-US", "en" };
const macos_catalina_intel_webgl_extensions = [_][]const u8{
    "ANGLE_instanced_arrays",
    "EXT_blend_minmax",
    "EXT_color_buffer_half_float",
    "EXT_disjoint_timer_query",
    "EXT_float_blend",
    "EXT_frag_depth",
    "EXT_shader_texture_lod",
    "EXT_texture_filter_anisotropic",
    "EXT_sRGB",
    "OES_element_index_uint",
    "OES_fbo_render_mipmap",
    "OES_standard_derivatives",
    "OES_texture_float",
    "OES_texture_float_linear",
    "OES_texture_half_float",
    "OES_texture_half_float_linear",
    "OES_vertex_array_object",
    "WEBGL_blend_func_extended",
    "WEBGL_color_buffer_float",
    "WEBGL_compressed_texture_s3tc",
    "WEBGL_compressed_texture_s3tc_srgb",
    "WEBGL_debug_renderer_info",
    "WEBGL_debug_shaders",
    "WEBGL_depth_texture",
    "WEBGL_draw_buffers",
    "WEBGL_lose_context",
};

const macos_catalina_intel_fonts = [_][]const u8{
    // macOS 10.9–10.15-11 system fonts (CreepJS APPLE_FONTS through Catalina/Big Sur)
    "American Typewriter",
    "American Typewriter Semibold",
    "Futura",
    "Futura Bold",
    "Galvji",
    "Geneva",
    "Helvetica Neue",
    "InaiMathi Bold",
    "Kohinoor Devanagari Medium",
    "Luminari",
    "MuktaMahee Regular",
    "PingFang HK Light",
    "SignPainter-HouseScript Semibold",
    // Common macOS UI / canvas fonts
    "Apple Color Emoji",
    "Arial",
    "Arial Hebrew",
    "Courier",
    "Courier New",
    "Georgia",
    "Helvetica",
    "Lucida Grande",
    "Menlo",
    "Monaco",
    "Palatino",
    "Times",
    "Times New Roman",
    "Zapfino",
    ".AppleSystemUIFont",
    "-apple-system",
    "BlinkMacSystemFont",
    "system-ui",
    "sans-serif",
    "serif",
    "monospace",
    "cursive",
    "fantasy",
};

pub const macos_catalina_intel = IdentityProfile{
    .persona_id = .macos_catalina_intel,
    .navigator_platform = "MacIntel",
    .ua_data_platform = "macOS",
    .ua_architecture = "x86",
    .ua_bitness = "64",
    .locale = "en-US",
    .languages = &macos_catalina_intel_languages,
    .timezone = "Asia/Saigon",
    .hardware_concurrency = 4,
    .device_memory = 8.0,
    .max_touch_points = 0,
    .pdf_viewer_enabled = true,
    .global_privacy_control = true,
    .vendor = "",
    .user_agent_fallback = "Velora/1.0 (Macintosh; Intel Mac OS X 10_15_7)",
    .app_version = "1.0",
    .platform_version = "",
    .ua_full_version = "1.0.0.0",
    .ua_mobile = false,
    .screen = .{
        .width = 1920,
        .height = 1080,
        .avail_width = 1920,
        .avail_height = 1040,
        .device_pixel_ratio = 1.0,
        .color_depth = 24,
        .pixel_depth = 24,
        .touch = false,
    },
    .webgl = .{
        .version = "WebGL 1.0 (OpenGL ES 2.0 Chromium)",
        .vendor = "WebKit",
        .renderer = "WebKit WebGL",
        .shading_language_version = "WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)",
        .unmasked_vendor = "Intel Inc.",
        .unmasked_renderer = "Intel Iris OpenGL Engine",
        .max_texture_size = 16384,
        .max_cube_map_texture_size = 16384,
        .max_renderbuffer_size = 16384,
        .max_vertex_attribs = 16,
        .max_vertex_uniform_vectors = 4096,
        .max_varying_vectors = 31,
        .max_combined_texture_image_units = 32,
        .max_vertex_texture_image_units = 16,
        .max_texture_image_units = 16,
        .max_fragment_uniform_vectors = 1024,
        .max_draw_buffers = 8,
        .max_texture_max_anisotropy = 16,
        .max_viewport_dims = .{ 16384, 16384 },
        .aliased_line_width_range = .{ 1, 1 },
        .aliased_point_size_range = .{ 1, 1024 },
        .extensions = &macos_catalina_intel_webgl_extensions,
    },
    .fonts = &macos_catalina_intel_fonts,
};

pub fn defaultIdentity() *const IdentityProfile {
    return &macos_catalina_intel;
}

pub fn isFontFamilyAvailable(profile: *const IdentityProfile, family: []const u8) bool {
    for (profile.fonts) |available| {
        if (std.ascii.eqlIgnoreCase(family, available)) return true;
    }
    return false;
}

pub fn defaultIsFontFamilyAvailable(family: []const u8) bool {
    return isFontFamilyAvailable(defaultIdentity(), family);
}
