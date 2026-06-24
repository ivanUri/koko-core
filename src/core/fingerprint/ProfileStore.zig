const std = @import("std");
const c = std.c;
const Profile = @import("Profile.zig");
const HostEnvironment = @import("HostEnvironment.zig");
const Spoofing = @import("Spoofing.zig");
const TransportProfile = @import("TransportProfile.zig");
const MeasureTextIntelligent = @import("MeasureTextIntelligent.zig");
const CanvasIntelligent = @import("CanvasIntelligent.zig");

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

pub const BrowserFamily = enum {
    chrome,
    firefox,

    pub fn parse(raw: []const u8) ?BrowserFamily {
        if (std.mem.eql(u8, raw, "chrome")) return .chrome;
        if (std.mem.eql(u8, raw, "firefox")) return .firefox;
        return null;
    }

    pub fn inferFromUserAgent(user_agent: []const u8) BrowserFamily {
        if (std.mem.indexOf(u8, user_agent, "Firefox/") != null) return .firefox;
        return .chrome;
    }
};

pub const Brand = struct {
    brand: []const u8,
    version: []const u8,
};

pub const PluginSpec = struct {
    name: []const u8,
    filename: []const u8,
    description: []const u8,
    mime_type: []const u8,
    mime_suffixes: []const u8,
};

pub const SpeechVoiceSpec = struct {
    name: []const u8,
    lang: []const u8,
    local_service: bool,
    default_voice: bool,
};

/// macOS Chrome 149 — five internal PDF plugins (navigator.plugins.length === 5).
const default_chrome_plugins = [_]PluginSpec{
    .{
        .name = "PDF Viewer",
        .filename = "internal-pdf-viewer",
        .description = "Portable Document Format",
        .mime_type = "application/pdf",
        .mime_suffixes = "pdf",
    },
    .{
        .name = "Chrome PDF Viewer",
        .filename = "internal-pdf-viewer",
        .description = "Portable Document Format",
        .mime_type = "application/pdf",
        .mime_suffixes = "pdf",
    },
    .{
        .name = "Chromium PDF Viewer",
        .filename = "internal-pdf-viewer",
        .description = "Portable Document Format",
        .mime_type = "application/pdf",
        .mime_suffixes = "pdf",
    },
    .{
        .name = "Microsoft Edge PDF Viewer",
        .filename = "internal-pdf-viewer",
        .description = "Portable Document Format",
        .mime_type = "application/pdf",
        .mime_suffixes = "pdf",
    },
    .{
        .name = "WebKit built-in PDF",
        .filename = "internal-pdf-viewer",
        .description = "Portable Document Format",
        .mime_type = "application/pdf",
        .mime_suffixes = "pdf",
    },
};

pub const LoadedProfile = struct {
    arena: std.heap.ArenaAllocator,
    mode: Mode,
    browser_family: BrowserFamily = .chrome,
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
        prefers_color_scheme: []const u8 = "light",
    },
    transport: struct {
        target: TransportProfile.Target,
        impersonate: [:0]const u8,
    },
    plugins: []const PluginSpec,
    /// Chrome-captured data URL for the standard 240×60 canvas probe (antidetect only).
    canvas_probe_data_url: ?[]const u8 = null,
    canvas_probe_50_text: ?[]const u8 = null,
    canvas_probe_50_emoji: ?[]const u8 = null,
    canvas_probe_75_data: ?[]const u8 = null,
    canvas_probe_75_paint: ?[]const u8 = null,
    canvas_probe_2_pixels: ?[]const u8 = null,
    /// Chrome-captured OfflineAudioContext probe (5000 samples + FFT bins).
    audio_probe_samples: ?[]const f32 = null,
    audio_probe_freq: ?[]const f32 = null,
    speech_voices: []const SpeechVoiceSpec = &.{},
    measure_text_baseline: []const MeasureTextIntelligent.Entry = &.{},

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

    pub fn isFirefox(self: *const LoadedProfile) bool {
        return self.browser_family == .firefox;
    }

    pub fn canvas_probe_data_url_for(self: *const LoadedProfile, probe: CanvasIntelligent.ProbeId) ?[]const u8 {
        return switch (probe) {
            .canvas_240_velora => self.canvas_probe_data_url,
            .canvas_50_text => self.canvas_probe_50_text,
            .canvas_50_emoji => self.canvas_probe_50_emoji,
            .canvas_75_data => self.canvas_probe_75_data,
            .canvas_75_paint => self.canvas_probe_75_paint,
            else => null,
        };
    }

    pub fn canvas_image_data_for(self: *const LoadedProfile, probe: CanvasIntelligent.ProbeId) ?[]const u8 {
        return switch (probe) {
            .canvas_2_low_entropy => self.canvas_probe_2_pixels,
            else => null,
        };
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
    prefersColorScheme: []const u8 = "light",
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

const JsonWindow = struct {
    innerWidth: u32,
    innerHeight: u32,
    outerWidth: u32,
    outerHeight: u32,
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

const JsonTransport = struct {
    impersonate: []const u8 = "",
};

const JsonPlugin = struct {
    name: []const u8,
    filename: []const u8,
    description: []const u8 = "",
    mimeType: []const u8,
    mimeSuffixes: []const u8 = "pdf",
};

const JsonCanvasProbe = struct {
    dataUrl: []const u8 = "",
    dataUrlFile: []const u8 = "",
    probesFile: []const u8 = "",
};

const JsonAudioProbe = struct {
    dataFile: []const u8 = "",
};

const JsonMeasureTextBaseline = struct {
    dataFile: []const u8 = "",
};

const JsonMeasureTextEntry = struct {
    family: []const u8,
    text: []const u8,
    width: f64,
    actualBoundingBoxLeft: f64 = 0,
    actualBoundingBoxRight: f64 = 0,
    actualBoundingBoxAscent: f64 = 0,
    actualBoundingBoxDescent: f64 = 0,
    fontBoundingBoxAscent: f64 = 0,
    fontBoundingBoxDescent: f64 = 0,
};

const JsonAudioBaseline = struct {
    samples: []const f64,
    freq: []const f64,
    tailSum: f64 = 0,
};

const JsonSpeechVoice = struct {
    name: []const u8,
    lang: []const u8,
    localService: bool = true,
    default: bool = false,
};

const JsonProfile = struct {
    version: u32,
    id: []const u8,
    mode: []const u8,
    browserFamily: []const u8 = "",
    personaId: []const u8 = "",
    navigator: JsonNavigator,
    userAgentData: JsonUserAgentData,
    screen: JsonScreen,
    window: ?JsonWindow = null,
    webgl: JsonWebGL,
    fonts: []const []const u8 = &.{},
    fontsFile: []const u8 = "",
    timezone: []const u8,
    locale: []const u8,
    transport: JsonTransport = .{},
    plugins: []const JsonPlugin = &.{},
    canvasProbe: JsonCanvasProbe = .{},
    audioProbe: JsonAudioProbe = .{},
    speechVoicesFile: []const u8 = "",
    measureTextBaseline: JsonMeasureTextBaseline = .{},
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
    try applyHostEnvironment(&loaded);
    applyProcessTimezone(&loaded);
    return loaded;
}

fn applyHostEnvironment(profile: *LoadedProfile) !void {
    if (profile.mode != .antidetect) return;
    var snap = HostEnvironment.detect(profile.arena.allocator()) catch return;
    // Keep profile screen dimensions; host CG display (e.g. 1920×1080) mismatches
    // window viewport and Chrome's screen.* in windowed automation runs.
    snap.screen = null;
    try HostEnvironment.applyIdentity(&profile.identity, snap, profile.arena.allocator());
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
        .transport = undefined,
        .plugins = &.{},
    };
    errdefer profile.deinit();

    const allocator = profile.arena.allocator();
    profile.id = try allocator.dupe(u8, "velora");
    profile.http.user_agent = try allocator.dupeZ(u8, src.user_agent_fallback);
    profile.http.brands = try allocator.alloc(Brand, 1);
    profile.http.brands[0] = .{ .brand = "Velora", .version = "1" };
    profile.http.sec_ch_ua = try buildSecChUa(allocator, profile.http.brands);
    profile.http.accept_language = try buildAcceptLanguage(allocator, src.languages[0], if (src.languages.len > 1) src.languages[1] else "en");
    profile.http.prefers_color_scheme = "light";
    profile.transport.target = TransportProfile.Target.chrome146;
    profile.transport.impersonate = try allocator.dupeZ(u8, profile.transport.target.name());
    profile.plugins = try dupePluginSpecs(allocator, &default_chrome_plugins);
    return profile;
}

fn parseJson(bytes: []const u8) !LoadedProfile {
    var parsed = try std.json.parseFromSlice(JsonProfile, std.heap.page_allocator, bytes, .{});
    defer parsed.deinit();

    const doc = parsed.value;
    const mode = Mode.parse(doc.mode) orelse return error.InvalidProfile;
    if (doc.version != 1) return error.UnsupportedProfileVersion;
    if (doc.navigator.languages.len == 0) return error.InvalidProfile;
    const browser_family = if (doc.browserFamily.len > 0)
        BrowserFamily.parse(doc.browserFamily) orelse return error.InvalidProfile
    else
        BrowserFamily.inferFromUserAgent(doc.navigator.userAgent);

    if (browser_family == .chrome and doc.userAgentData.brands.len == 0) return error.InvalidProfile;

    try validateAntidetect(mode, doc.navigator.userAgent, doc.userAgentData.brands, browser_family);
    if (mode == .antidetect and browser_family == .chrome) {
        try Spoofing.validateAntidetectConsistency(
            doc.navigator.userAgent,
            @as([]const Spoofing.Brand, @ptrCast(doc.userAgentData.brands)),
            doc.userAgentData.uaFullVersion,
        );
        if (!Spoofing.uaPlatformMatchesNavigator(doc.navigator.userAgent, doc.navigator.platform)) {
            return error.InvalidProfile;
        }
    }

    var profile: LoadedProfile = .{
        .arena = std.heap.ArenaAllocator.init(std.heap.page_allocator),
        .mode = mode,
        .browser_family = browser_family,
        .id = "",
        .identity = undefined,
        .languages = &.{},
        .fonts = &.{},
        .webgl_extensions = &.{},
        .http = undefined,
        .transport = undefined,
        .plugins = &.{},
    };
    errdefer profile.deinit();

    const allocator = profile.arena.allocator();
    profile.id = try allocator.dupe(u8, doc.id);

    profile.languages = try dupeStringList(allocator, doc.navigator.languages);
    profile.fonts = try loadFonts(allocator, doc.fonts, doc.fontsFile);
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
    profile.http.prefers_color_scheme = try allocator.dupe(u8, doc.userAgentData.prefersColorScheme);

    const transport_target = TransportProfile.Target.resolve(
        if (doc.transport.impersonate.len > 0) doc.transport.impersonate else null,
        doc.navigator.userAgent,
    );

    profile.transport.target = transport_target;
    profile.transport.impersonate = try allocator.dupeZ(u8, transport_target.name());

    profile.plugins = if (doc.plugins.len > 0)
        try parsePlugins(allocator, doc.plugins)
    else if (mode == .antidetect and browser_family == .chrome)
        try dupePluginSpecs(allocator, &default_chrome_plugins)
    else
        &.{};

    profile.identity = .{
        .persona_id = try parsePersonaId(doc.personaId, doc.navigator.platform),
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
        .window = if (doc.window) |win| .{
            .inner_width = win.innerWidth,
            .inner_height = win.innerHeight,
            .outer_width = win.outerWidth,
            .outer_height = win.outerHeight,
        } else Profile.defaultWindowForScreen(.{
            .width = doc.screen.width,
            .height = doc.screen.height,
            .avail_width = doc.screen.availWidth,
            .avail_height = doc.screen.availHeight,
            .device_pixel_ratio = doc.screen.devicePixelRatio,
            .color_depth = doc.screen.colorDepth,
            .pixel_depth = doc.screen.pixelDepth,
            .touch = doc.screen.touch,
        }),
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

    profile.canvas_probe_data_url = try loadCanvasProbe(allocator, doc.canvasProbe);
    try loadCanvasProbes(allocator, doc.canvasProbe, &profile);
    try loadAudioProbe(allocator, doc.audioProbe, &profile);
    profile.speech_voices = try loadSpeechVoices(allocator, doc.speechVoicesFile);
    profile.measure_text_baseline = try loadMeasureTextBaseline(allocator, doc.measureTextBaseline);

    return profile;
}

fn loadMeasureTextBaseline(allocator: std.mem.Allocator, spec: JsonMeasureTextBaseline) ![]const MeasureTextIntelligent.Entry {
    if (spec.dataFile.len == 0) return &.{};
    const bytes = try std.fs.cwd().readFileAlloc(allocator, spec.dataFile, 32 * 1024 * 1024);
    const parsed = try std.json.parseFromSlice([]const JsonMeasureTextEntry, allocator, bytes, .{ .ignore_unknown_fields = true });
    defer parsed.deinit();
    const src = parsed.value;
    const out = try allocator.alloc(MeasureTextIntelligent.Entry, src.len);
    for (src, 0..) |e, i| {
        out[i] = .{
            .family = try allocator.dupe(u8, e.family),
            .text = try allocator.dupe(u8, e.text),
            .width = e.width,
            .actual_bounding_box_left = e.actualBoundingBoxLeft,
            .actual_bounding_box_right = e.actualBoundingBoxRight,
            .actual_bounding_box_ascent = e.actualBoundingBoxAscent,
            .actual_bounding_box_descent = e.actualBoundingBoxDescent,
            .font_bounding_box_ascent = e.fontBoundingBoxAscent,
            .font_bounding_box_descent = e.fontBoundingBoxDescent,
        };
    }
    return out;
}

fn loadFonts(allocator: std.mem.Allocator, embedded: []const []const u8, file_path: []const u8) ![]const []const u8 {
    if (embedded.len > 0) return dupeStringList(allocator, embedded);
    if (file_path.len == 0) return &.{};
    const bytes = try std.fs.cwd().readFileAlloc(allocator, file_path, 4 * 1024 * 1024);
    const parsed = try std.json.parseFromSlice([]const []const u8, allocator, bytes, .{ .ignore_unknown_fields = true });
    defer parsed.deinit();
    return dupeStringList(allocator, parsed.value);
}

fn loadSpeechVoices(allocator: std.mem.Allocator, file_path: []const u8) ![]const SpeechVoiceSpec {
    if (file_path.len == 0) return &.{};
    const bytes = try std.fs.cwd().readFileAlloc(allocator, file_path, 4 * 1024 * 1024);
    const parsed = try std.json.parseFromSlice([]const JsonSpeechVoice, allocator, bytes, .{ .ignore_unknown_fields = true });
    defer parsed.deinit();
    const src = parsed.value;
    const out = try allocator.alloc(SpeechVoiceSpec, src.len);
    for (src, 0..) |v, i| {
        out[i] = .{
            .name = try allocator.dupe(u8, v.name),
            .lang = try allocator.dupe(u8, v.lang),
            .local_service = v.localService,
            .default_voice = v.default,
        };
    }
    return out;
}

fn loadAudioProbe(allocator: std.mem.Allocator, probe: JsonAudioProbe, profile: *LoadedProfile) !void {
    if (probe.dataFile.len == 0) return;
    const bytes = std.fs.cwd().readFileAlloc(allocator, probe.dataFile, 4 * 1024 * 1024) catch return;
    defer allocator.free(bytes);

    const parsed = std.json.parseFromSlice(JsonAudioBaseline, allocator, bytes, .{ .ignore_unknown_fields = true }) catch return;
    defer parsed.deinit();
    const doc = parsed.value;
    if (doc.samples.len == 0 or doc.freq.len == 0) return;

    const samples = try allocator.alloc(f32, doc.samples.len);
    for (doc.samples, 0..) |v, i| samples[i] = @floatCast(v);
    const freq = try allocator.alloc(f32, doc.freq.len);
    for (doc.freq, 0..) |v, i| freq[i] = @floatCast(v);

    profile.audio_probe_samples = samples;
    profile.audio_probe_freq = freq;
}

fn loadCanvasProbe(allocator: std.mem.Allocator, probe: JsonCanvasProbe) !?[]const u8 {
    if (probe.dataUrl.len > 0) {
        return try allocator.dupe(u8, probe.dataUrl);
    }
    if (probe.dataUrlFile.len == 0) return null;
    const bytes = std.fs.cwd().readFileAlloc(allocator, probe.dataUrlFile, 64 * 1024) catch return null;
    return bytes;
}

const JsonCanvasProbesFile = struct {
    canvas_240_velora: []const u8 = "",
    canvas_50_text: []const u8 = "",
    canvas_50_emoji: []const u8 = "",
    canvas_75_data: []const u8 = "",
    canvas_75_paint: []const u8 = "",
    canvas_2_low_entropy: []const f64 = &.{},
};

fn loadCanvasProbes(allocator: std.mem.Allocator, probe: JsonCanvasProbe, profile: *LoadedProfile) !void {
    if (probe.probesFile.len == 0) return;
    const bytes = try std.fs.cwd().readFileAlloc(allocator, probe.probesFile, 2 * 1024 * 1024);
    const parsed = try std.json.parseFromSlice(JsonCanvasProbesFile, allocator, bytes, .{ .ignore_unknown_fields = true });
    defer parsed.deinit();
    const doc = parsed.value;

    if (profile.canvas_probe_data_url == null and doc.canvas_240_velora.len > 0) {
        profile.canvas_probe_data_url = try allocator.dupe(u8, doc.canvas_240_velora);
    }
    if (doc.canvas_50_text.len > 0) {
        profile.canvas_probe_50_text = try allocator.dupe(u8, doc.canvas_50_text);
    }
    if (doc.canvas_50_emoji.len > 0) {
        profile.canvas_probe_50_emoji = try allocator.dupe(u8, doc.canvas_50_emoji);
    }
    if (doc.canvas_75_data.len > 0) {
        profile.canvas_probe_75_data = try allocator.dupe(u8, doc.canvas_75_data);
    }
    if (doc.canvas_75_paint.len > 0) {
        profile.canvas_probe_75_paint = try allocator.dupe(u8, doc.canvas_75_paint);
    }
    if (doc.canvas_2_low_entropy.len > 0) {
        const pixels = try allocator.alloc(u8, doc.canvas_2_low_entropy.len);
        for (doc.canvas_2_low_entropy, 0..) |v, i| {
            const clamped = @min(@max(v, 0), 255);
            pixels[i] = @intFromFloat(clamped);
        }
        profile.canvas_probe_2_pixels = pixels;
    }
}

fn parsePlugins(allocator: std.mem.Allocator, src: []const JsonPlugin) ![]const PluginSpec {
    const out = try allocator.alloc(PluginSpec, src.len);
    for (src, 0..) |p, i| {
        out[i] = .{
            .name = try allocator.dupe(u8, p.name),
            .filename = try allocator.dupe(u8, p.filename),
            .description = try allocator.dupe(u8, p.description),
            .mime_type = try allocator.dupe(u8, p.mimeType),
            .mime_suffixes = try allocator.dupe(u8, p.mimeSuffixes),
        };
    }
    return out;
}

fn dupePluginSpecs(allocator: std.mem.Allocator, src: []const PluginSpec) ![]const PluginSpec {
    const out = try allocator.alloc(PluginSpec, src.len);
    for (src, 0..) |p, i| {
        out[i] = .{
            .name = try allocator.dupe(u8, p.name),
            .filename = try allocator.dupe(u8, p.filename),
            .description = try allocator.dupe(u8, p.description),
            .mime_type = try allocator.dupe(u8, p.mime_type),
            .mime_suffixes = try allocator.dupe(u8, p.mime_suffixes),
        };
    }
    return out;
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

fn parsePersonaId(raw: []const u8, platform: []const u8) !Profile.PersonaId {
    if (raw.len > 0) {
        if (std.mem.eql(u8, raw, "macos_sonoma_intel")) return .macos_sonoma_intel;
        if (std.mem.eql(u8, raw, "windows_11_intel")) return .windows_11_intel;
        if (std.mem.eql(u8, raw, "macos_catalina_intel")) return .macos_catalina_intel;
    }
    if (std.mem.eql(u8, platform, "Win32")) return .windows_11_intel;
    return .macos_catalina_intel;
}

fn validateAntidetect(
    mode: Mode,
    user_agent: []const u8,
    brands: []const JsonBrand,
    browser_family: BrowserFamily,
) !void {
    if (mode != .antidetect) return;
    if (std.ascii.indexOfIgnoreCase(user_agent, "mozilla/") == null) return error.InvalidProfile;
    switch (browser_family) {
        .chrome => {
            var has_chrome_brand = false;
            for (brands) |brand| {
                if (std.mem.eql(u8, brand.brand, "Chromium") or
                    std.mem.eql(u8, brand.brand, "Google Chrome"))
                {
                    has_chrome_brand = true;
                }
            }
            if (!has_chrome_brand) return error.InvalidProfile;
        },
        .firefox => {
            if (std.mem.indexOf(u8, user_agent, "Firefox/") == null) return error.InvalidProfile;
        },
    }
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

test "ProfileStore: load chrome-macos-sonoma with transport" {
    const profile = try resolve("chrome-macos-sonoma");
    defer profile.deinit();
    try testing.expectEqual(Mode.antidetect, profile.mode);
    try testing.expectEqual(BrowserFamily.chrome, profile.browser_family);
    try testing.expectEqual(TransportProfile.Target.chrome146, profile.transport.target);
    try testing.expect(std.mem.indexOf(u8, profile.http.user_agent, "Chrome/149") != null);
    try testing.expectEqual(@as(usize, 5), profile.plugins.len);
    try testing.expect(profile.fonts.len >= 800);
    try testing.expect(profile.speech_voices.len >= 190);
    try testing.expectEqual(@as(u8, 30), profile.identity.screen.color_depth);
}

test "ProfileStore: load firefox-macos profile" {
    const profile = try resolve("firefox-macos");
    defer profile.deinit();
    try testing.expectEqual(Mode.antidetect, profile.mode);
    try testing.expectEqual(BrowserFamily.firefox, profile.browser_family);
    try testing.expectEqual(TransportProfile.Target.firefox147, profile.transport.target);
    try testing.expect(std.mem.indexOf(u8, profile.http.user_agent, "Firefox/147") != null);
    try testing.expectEqual(@as(usize, 0), profile.plugins.len);
    try testing.expect(profile.canvas_probe_data_url == null);
}
