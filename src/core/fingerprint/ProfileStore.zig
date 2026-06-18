const std = @import("std");
const c = std.c;
const Profile = @import("Profile.zig");

extern fn setenv(name: [*:0]const u8, value: [*:0]const u8, override: c_int) c_int;

pub const Mode = enum {
    velora,
    antidetect,

    pub fn parse(raw: []const u8) ?Mode {
        if (std.mem.eql(u8, raw, "velora")) return .velora;
        if (std.mem.eql(u8, raw, "antidetect")) return .antidetect;
        return null;
    }
};

pub const Brand = struct {
    brand: []const u8,
    version: []const u8,
};

pub const LoadedProfile = struct {
    arena: std.heap.ArenaAllocator,
    mode: Mode,
    id: []const u8,
    identity: Profile.IdentityProfile,
    languages: []const []const u8,
    fonts: []const []const u8,
    webgl_extensions: []const []const u8,
    http: struct {
        user_agent: [:0]const u8,
        brands: []Brand,
        sec_ch_ua: [:0]const u8,
        accept_language: [:0]const u8,
    },

    pub fn deinit(self: *LoadedProfile) void {
        self.arena.deinit();
        self.* = undefined;
    }

    pub fn identityPtr(self: *const LoadedProfile) *const Profile.IdentityProfile {
        return &self.identity;
    }

    pub fn allowsMozillaUserAgent(self: *const LoadedProfile) bool {
        return self.mode == .antidetect;
    }
};

const JsonBrand = struct {
    brand: []const u8,
    version: []const u8,
};

const JsonNavigator = struct {
    userAgent: []const u8,
    platform: []const u8,
    languages: []const []const u8,
    hardwareConcurrency: u32,
    deviceMemory: f64,
    maxTouchPoints: u32,
    vendor: []const u8,
    pdfViewerEnabled: bool = true,
    appVersion: []const u8 = "1.0",
};

const JsonUserAgentData = struct {
    brands: []const JsonBrand,
    platform: []const u8,
    platformVersion: []const u8 = "",
    architecture: []const u8,
    bitness: []const u8,
    uaFullVersion: []const u8 = "1.0.0.0",
    mobile: bool = false,
};

const JsonScreen = struct {
    width: u32,
    height: u32,
    availWidth: u32,
    availHeight: u32,
    devicePixelRatio: f64,
    colorDepth: u8,
    pixelDepth: u8,
    touch: bool = false,
};

const JsonWebGL = struct {
    version: []const u8,
    vendor: []const u8,
    renderer: []const u8,
    shadingLanguageVersion: []const u8,
    unmaskedVendor: []const u8,
    unmaskedRenderer: []const u8,
    maxTextureSize: u32 = 16384,
    maxCubeMapTextureSize: u32 = 16384,
    maxRenderbufferSize: u32 = 16384,
    maxVertexAttribs: u32 = 16,
    maxVertexUniformVectors: u32 = 4096,
    maxVaryingVectors: u32 = 31,
    maxCombinedTextureImageUnits: u32 = 32,
    maxVertexTextureImageUnits: u32 = 16,
    maxTextureImageUnits: u32 = 16,
    maxFragmentUniformVectors: u32 = 1024,
    maxDrawBuffers: u32 = 8,
    maxTextureMaxAnisotropy: u32 = 16,
    maxViewportDims: [2]i32 = .{ 16384, 16384 },
    aliasedLineWidthRange: [2]f32 = .{ 1, 1 },
    aliasedPointSizeRange: [2]f32 = .{ 1, 1024 },
    extensions: []const []const u8,
};

const JsonProfile = struct {
    version: u32,
    id: []const u8,
    mode: []const u8,
    navigator: JsonNavigator,
    userAgentData: JsonUserAgentData,
    screen: JsonScreen,
    webgl: JsonWebGL,
    fonts: []const []const u8,
    timezone: []const u8,
    locale: []const u8,
};

pub fn resolve(name: ?[]const u8) !LoadedProfile {
    const path = try profilePath(name);
    defer if (path.allocated) std.heap.page_allocator.free(path.slice);

    const bytes = std.fs.cwd().readFileAlloc(std.heap.page_allocator, path.slice, 1024 * 1024) catch |err| switch (err) {
        error.FileNotFound => {
            var embedded = try fromEmbedded(name);
            applyProcessTimezone(&embedded);
            return embedded;
        },
        else => return err,
    };
    defer std.heap.page_allocator.free(bytes);

    var loaded = try parseJson(bytes);
    applyProcessTimezone(&loaded);
    return loaded;
}

fn applyProcessTimezone(profile: *const LoadedProfile) void {
    const tz = profile.identity.timezone;
    if (tz.len == 0 or tz.len >= 96) return;
    var buf: [96:0]u8 = undefined;
    @memcpy(buf[0..tz.len], tz);
    buf[tz.len] = 0;
    _ = setenv("TZ", &buf, 1);
}

const PathResult = struct {
    slice: []const u8,
    allocated: bool,
};

fn profilePath(name: ?[]const u8) !PathResult {
    const profile_name = name orelse "velora";
    if (std.mem.eql(u8, profile_name, "velora")) {
        return .{ .slice = "browser/velora.json", .allocated = false };
    }
    if (std.mem.indexOfScalar(u8, profile_name, '/')) |_| {
        return .{ .slice = profile_name, .allocated = false };
    }
    const path = try std.fmt.allocPrint(std.heap.page_allocator, "browser/profiles/{s}.json", .{profile_name});
    return .{ .slice = path, .allocated = true };
}

fn fromEmbedded(name: ?[]const u8) !LoadedProfile {
    _ = name;
    const src = Profile.defaultIdentity();
    var profile: LoadedProfile = .{
        .arena = std.heap.ArenaAllocator.init(std.heap.page_allocator),
        .mode = .velora,
        .id = "velora",
        .identity = src.*,
        .languages = src.languages,
        .fonts = src.fonts,
        .webgl_extensions = src.webgl.extensions,
        .http = undefined,
    };
    errdefer profile.deinit();

    const allocator = profile.arena.allocator();
    profile.id = try allocator.dupe(u8, "velora");
    profile.http.user_agent = try allocator.dupeZ(u8, src.user_agent_fallback);
    profile.http.brands = try allocator.alloc(Brand, 1);
    profile.http.brands[0] = .{ .brand = "Velora", .version = "1" };
    profile.http.sec_ch_ua = try buildSecChUa(allocator, profile.http.brands);
    profile.http.accept_language = try buildAcceptLanguage(allocator, src.languages[0], if (src.languages.len > 1) src.languages[1] else "en");
    return profile;
}

fn parseJson(bytes: []const u8) !LoadedProfile {
    var parsed = try std.json.parseFromSlice(JsonProfile, std.heap.page_allocator, bytes, .{});
    defer parsed.deinit();

    const doc = parsed.value;
    const mode = Mode.parse(doc.mode) orelse return error.InvalidProfile;
    if (doc.version != 1) return error.UnsupportedProfileVersion;
    if (doc.navigator.languages.len == 0) return error.InvalidProfile;
    if (doc.userAgentData.brands.len == 0) return error.InvalidProfile;

    try validateAntidetect(mode, doc.navigator.userAgent, doc.userAgentData.brands);

    var profile: LoadedProfile = .{
        .arena = std.heap.ArenaAllocator.init(std.heap.page_allocator),
        .mode = mode,
        .id = "",
        .identity = undefined,
        .languages = &.{},
        .fonts = &.{},
        .webgl_extensions = &.{},
        .http = undefined,
    };
    errdefer profile.deinit();

    const allocator = profile.arena.allocator();
    profile.id = try allocator.dupe(u8, doc.id);

    profile.languages = try dupeStringList(allocator, doc.navigator.languages);
    profile.fonts = try dupeStringList(allocator, doc.fonts);
    profile.webgl_extensions = try dupeStringList(allocator, doc.webgl.extensions);

    profile.http.user_agent = try allocator.dupeZ(u8, doc.navigator.userAgent);
    profile.http.brands = try allocator.alloc(Brand, doc.userAgentData.brands.len);
    for (doc.userAgentData.brands, 0..) |brand, i| {
        profile.http.brands[i] = .{
            .brand = try allocator.dupe(u8, brand.brand),
            .version = try allocator.dupe(u8, brand.version),
        };
    }
    profile.http.sec_ch_ua = try buildSecChUa(allocator, profile.http.brands);
    profile.http.accept_language = try buildAcceptLanguage(
        allocator,
        doc.navigator.languages[0],
        if (doc.navigator.languages.len > 1) doc.navigator.languages[1] else "en",
    );

    profile.identity = .{
        .persona_id = .macos_catalina_intel,
        .navigator_platform = try allocator.dupe(u8, doc.navigator.platform),
        .ua_data_platform = try allocator.dupe(u8, doc.userAgentData.platform),
        .ua_architecture = try allocator.dupe(u8, doc.userAgentData.architecture),
        .ua_bitness = try allocator.dupe(u8, doc.userAgentData.bitness),
        .locale = try allocator.dupe(u8, doc.locale),
        .languages = profile.languages,
        .timezone = try allocator.dupe(u8, doc.timezone),
        .hardware_concurrency = doc.navigator.hardwareConcurrency,
        .device_memory = doc.navigator.deviceMemory,
        .max_touch_points = doc.navigator.maxTouchPoints,
        .pdf_viewer_enabled = doc.navigator.pdfViewerEnabled,
        .global_privacy_control = true,
        .vendor = try allocator.dupe(u8, doc.navigator.vendor),
        .user_agent_fallback = profile.http.user_agent,
        .app_version = try allocator.dupe(u8, doc.navigator.appVersion),
        .platform_version = try allocator.dupe(u8, doc.userAgentData.platformVersion),
        .ua_full_version = try allocator.dupe(u8, doc.userAgentData.uaFullVersion),
        .ua_mobile = doc.userAgentData.mobile,
        .screen = .{
            .width = doc.screen.width,
            .height = doc.screen.height,
            .avail_width = doc.screen.availWidth,
            .avail_height = doc.screen.availHeight,
            .device_pixel_ratio = doc.screen.devicePixelRatio,
            .color_depth = doc.screen.colorDepth,
            .pixel_depth = doc.screen.pixelDepth,
            .touch = doc.screen.touch,
        },
        .webgl = .{
            .version = try allocator.dupe(u8, doc.webgl.version),
            .vendor = try allocator.dupe(u8, doc.webgl.vendor),
            .renderer = try allocator.dupe(u8, doc.webgl.renderer),
            .shading_language_version = try allocator.dupe(u8, doc.webgl.shadingLanguageVersion),
            .unmasked_vendor = try allocator.dupe(u8, doc.webgl.unmaskedVendor),
            .unmasked_renderer = try allocator.dupe(u8, doc.webgl.unmaskedRenderer),
            .max_texture_size = doc.webgl.maxTextureSize,
            .max_cube_map_texture_size = doc.webgl.maxCubeMapTextureSize,
            .max_renderbuffer_size = doc.webgl.maxRenderbufferSize,
            .max_vertex_attribs = doc.webgl.maxVertexAttribs,
            .max_vertex_uniform_vectors = doc.webgl.maxVertexUniformVectors,
            .max_varying_vectors = doc.webgl.maxVaryingVectors,
            .max_combined_texture_image_units = doc.webgl.maxCombinedTextureImageUnits,
            .max_vertex_texture_image_units = doc.webgl.maxVertexTextureImageUnits,
            .max_texture_image_units = doc.webgl.maxTextureImageUnits,
            .max_fragment_uniform_vectors = doc.webgl.maxFragmentUniformVectors,
            .max_draw_buffers = doc.webgl.maxDrawBuffers,
            .max_texture_max_anisotropy = doc.webgl.maxTextureMaxAnisotropy,
            .max_viewport_dims = doc.webgl.maxViewportDims,
            .aliased_line_width_range = doc.webgl.aliasedLineWidthRange,
            .aliased_point_size_range = doc.webgl.aliasedPointSizeRange,
            .extensions = profile.webgl_extensions,
        },
        .fonts = profile.fonts,
    };

    return profile;
}

fn dupeStringList(allocator: std.mem.Allocator, src: []const []const u8) ![]const []const u8 {
    const out = try allocator.alloc([]const u8, src.len);
    for (src, 0..) |item, i| {
        out[i] = try allocator.dupe(u8, item);
    }
    return out;
}

fn buildSecChUa(allocator: std.mem.Allocator, brands: []const Brand) ![:0]u8 {
    var list = try std.ArrayList(u8).initCapacity(allocator, 64);
    errdefer list.deinit(allocator);
    try list.appendSlice(allocator, "Sec-Ch-Ua:");
    for (brands, 0..) |brand, i| {
        const sep = if (i == 0) " " else ", ";
        try list.appendSlice(allocator, sep);
        try list.writer(allocator).print("\"{s}\";v=\"{s}\"", .{ brand.brand, brand.version });
    }
    try list.append(allocator, 0);
    const slice = try list.toOwnedSlice(allocator);
    return slice[0 .. slice.len - 1 :0];
}

fn buildAcceptLanguage(allocator: std.mem.Allocator, primary: []const u8, secondary: []const u8) ![:0]u8 {
    return try std.fmt.allocPrintSentinel(allocator, "Accept-Language: {s},{s};q=0.9", .{ primary, secondary }, 0);
}

fn validateAntidetect(mode: Mode, user_agent: []const u8, brands: []const JsonBrand) !void {
    if (mode != .antidetect) return;
    if (std.ascii.indexOfIgnoreCase(user_agent, "mozilla/") == null) return error.InvalidProfile;
    var has_chrome_brand = false;
    for (brands) |brand| {
        if (std.mem.eql(u8, brand.brand, "Chromium") or
            std.mem.eql(u8, brand.brand, "Google Chrome"))
        {
            has_chrome_brand = true;
        }
    }
    if (!has_chrome_brand) return error.InvalidProfile;
}

const testing = @import("../../testing/testing.zig");

test "ProfileStore: load velora profile" {
    const profile = try resolve("velora");
    defer profile.deinit();
    try testing.expectEqual(Mode.velora, profile.mode);
    try testing.expect(profile.http.brands.len >= 1);
}

test "ProfileStore: load chrome antidetect profile" {
    const profile = try resolve("chrome-macos-catalina");
    defer profile.deinit();
    try testing.expectEqual(Mode.antidetect, profile.mode);
    try testing.expect(std.mem.indexOf(u8, profile.http.user_agent, "Chrome") != null);
}
