const std = @import("std");
const Profile = @import("Profile.zig");
const Spoofing = @import("Spoofing.zig");
const TransportProfile = @import("TransportProfile.zig");

/// Canonical browser identity consumed by every observable subsystem.
/// Large captured probe payloads retain LoadedProfile's arena ownership;
/// `surfaces` is their canonical manifest and is validated before startup.
pub const BrowserPersona = struct {
    family: Family,
    version: Version,
    identity: Profile.IdentityProfile,
    network: Network,
    features: FeatureMatrix,
    surfaces: Surfaces = .{},

    pub const Family = enum {
        chrome,
        firefox,
        safari,

        pub fn parse(raw: []const u8) ?Family {
            if (std.mem.eql(u8, raw, "chrome")) return .chrome;
            if (std.mem.eql(u8, raw, "firefox")) return .firefox;
            if (std.mem.eql(u8, raw, "safari")) return .safari;
            return null;
        }

        pub fn inferFromUserAgent(user_agent: []const u8) Family {
            if (std.mem.indexOf(u8, user_agent, "Firefox/") != null) return .firefox;
            if (std.mem.indexOf(u8, user_agent, "Safari/") != null and
                std.mem.indexOf(u8, user_agent, "Chrome/") == null and
                std.mem.indexOf(u8, user_agent, "Chromium/") == null)
                return .safari;
            return .chrome;
        }
    };

    pub const Brand = struct {
        brand: []const u8,
        version: []const u8,
    };

    pub const Version = struct {
        major: ?u32,
        full: []const u8,

        pub fn fromIdentity(family: Family, user_agent: []const u8, full: []const u8) Version {
            return .{
                .major = if (family == .chrome)
                    if (Spoofing.extractChromeVersion(user_agent)) |version| version.major else null
                else
                    null,
                .full = full,
            };
        }
    };

    pub const PluginSpec = struct {
        name: []const u8,
        filename: []const u8,
        description: []const u8,
        mime_type: []const u8,
        mime_suffixes: []const u8,
    };

    pub const Surfaces = struct {
        plugins: []const PluginSpec = &.{},
        has_canvas_probe: bool = false,
        has_audio_probe: bool = false,
        has_webgl_probe: bool = false,
    };

    pub const PermissionState = enum { granted, prompt, denied, unknown };

    pub const Network = struct {
        user_agent: [:0]const u8,
        brands: []const Brand,
        sec_ch_ua: [:0]const u8,
        accept_language: [:0]const u8,
        prefers_color_scheme: []const u8,
        transport_target: TransportProfile.Target,
        impersonate: [:0]const u8,
    };

    pub const FeatureMatrix = struct {
        chrome_major: ?u32,
        user_agent_data: bool,
        webgl2: bool,
        media_capabilities: bool,
        bluetooth: bool,
        usb: bool,
        serial: bool,

        pub fn forIdentity(family: Family, user_agent: []const u8) FeatureMatrix {
            const chrome = if (family == .chrome)
                if (Spoofing.extractChromeVersion(user_agent)) |v| v.major else null
            else
                null;
            return .{
                .chrome_major = chrome,
                .user_agent_data = chrome != null and chrome.? >= 89,
                .webgl2 = chrome == null or chrome.? >= 56,
                .media_capabilities = chrome == null or chrome.? >= 66,
                .bluetooth = chrome == null or chrome.? >= 56,
                .usb = chrome == null or chrome.? >= 61,
                .serial = chrome == null or chrome.? >= 89,
            };
        }
    };

    pub const WebRtcPolicy = struct {
        allow_non_proxied_udp: bool,
        emit_synthetic_candidates: bool = false,
    };

    pub fn webRtcPolicy(_: *const BrowserPersona, proxy_enabled: bool) WebRtcPolicy {
        return .{ .allow_non_proxied_udp = !proxy_enabled };
    }

    pub fn permissionState(self: *const BrowserPersona, name: []const u8) PermissionState {
        if (self.family != .chrome) return .unknown;
        const granted = [_][]const u8{
            "accelerometer",
            "background-fetch",
            "background-sync",
            "gyroscope",
            "magnetometer",
            "screen-wake-lock",
        };
        for (granted) |candidate| {
            if (std.mem.eql(u8, name, candidate)) return .granted;
        }
        const prompt = [_][]const u8{
            "camera",
            "display-capture",
            "geolocation",
            "microphone",
            "midi",
            "notifications",
            "persistent-storage",
        };
        for (prompt) |candidate| {
            if (std.mem.eql(u8, name, candidate)) return .prompt;
        }
        return .unknown;
    }

    pub fn validate(self: *const BrowserPersona) !void {
        if (self.identity.languages.len == 0) return error.PersonaLanguagesEmpty;
        if (!std.mem.eql(u8, self.identity.user_agent_fallback, self.network.user_agent))
            return error.PersonaUserAgentMismatch;
        if (!std.mem.eql(u8, self.identity.locale, self.identity.languages[0]))
            return error.PersonaLocaleLanguageMismatch;
        if (!acceptLanguageStartsWith(self.network.accept_language, self.identity.languages[0]))
            return error.PersonaAcceptLanguageMismatch;
        if (self.identity.screen.color_depth != self.identity.screen.pixel_depth)
            return error.PersonaColorDepthMismatch;
        if (self.identity.screen.avail_width > self.identity.screen.width or
            self.identity.screen.avail_height > self.identity.screen.height)
            return error.PersonaScreenMetricsMismatch;
        if (self.identity.window.inner_width > self.identity.window.outer_width or
            self.identity.window.inner_height > self.identity.window.outer_height)
            return error.PersonaWindowMetricsMismatch;
        if (self.identity.hardware_concurrency == 0 or self.identity.device_memory <= 0)
            return error.PersonaHardwareInvalid;
        if (self.identity.webgl.unmasked_vendor.len == 0 or
            self.identity.webgl.unmasked_renderer.len == 0)
            return error.PersonaGpuMissing;
        if (self.surfaces.has_canvas_probe and self.identity.fonts.len == 0)
            return error.PersonaCanvasFontsMismatch;
        if (self.surfaces.has_webgl_probe and
            (self.identity.webgl.vendor.len == 0 or self.identity.webgl.renderer.len == 0))
            return error.PersonaWebGlProbeGpuMismatch;
        if (!std.mem.eql(u8, self.version.full, self.identity.ua_full_version))
            return error.PersonaVersionMismatch;
        switch (self.identity.persona_id) {
            .macos_catalina_intel, .macos_sonoma_intel => {
                if (!std.mem.eql(u8, self.identity.navigator_platform, "MacIntel"))
                    return error.PersonaOsPlatformMismatch;
            },
            .windows_11_intel => {
                if (!std.mem.eql(u8, self.identity.navigator_platform, "Win32"))
                    return error.PersonaOsPlatformMismatch;
            },
        }

        if (self.family == .chrome and self.features.chrome_major != null) {
            if (self.version.major != self.features.chrome_major)
                return error.PersonaFeatureVersionMismatch;
            if (!self.features.user_agent_data or self.network.brands.len == 0)
                return error.PersonaClientHintsMissing;
            try Spoofing.validateAntidetectConsistency(
                self.network.user_agent,
                @as([]const Spoofing.Brand, @ptrCast(self.network.brands)),
                self.identity.ua_full_version,
            );
            if (!Spoofing.uaPlatformMatchesNavigator(
                self.network.user_agent,
                self.identity.navigator_platform,
            )) return error.PersonaPlatformMismatch;
            if (!Spoofing.uaChPlatformMatchesNavigator(
                self.identity.navigator_platform,
                self.identity.ua_data_platform,
            )) return error.PersonaUaDataPlatformMismatch;

            const expected_transport = TransportProfile.Target.resolve(null, self.network.user_agent);
            if (expected_transport != self.network.transport_target)
                return error.PersonaTransportVersionMismatch;
        }
        if (!std.mem.eql(
            u8,
            self.network.impersonate,
            self.network.transport_target.curlImpersonate(),
        )) return error.PersonaTransportTargetMismatch;
    }
};

fn acceptLanguageStartsWith(header: []const u8, language: []const u8) bool {
    const prefix = "Accept-Language: ";
    if (!std.mem.startsWith(u8, header, prefix)) return false;
    const value = header[prefix.len..];
    if (!std.mem.startsWith(u8, value, language)) return false;
    return value.len == language.len or value[language.len] == ',' or value[language.len] == ';' or value[language.len] == 0;
}

fn testingPersona() BrowserPersona {
    const identity = Profile.defaultIdentity().*;
    const target = TransportProfile.Target.chrome146;
    return .{
        .family = .chrome,
        .version = BrowserPersona.Version.fromIdentity(
            .chrome,
            "Velora/1.0 (Macintosh; Intel Mac OS X 10_15_7)",
            identity.ua_full_version,
        ),
        .identity = identity,
        .network = .{
            .user_agent = "Velora/1.0 (Macintosh; Intel Mac OS X 10_15_7)",
            .brands = &.{.{ .brand = "Velora", .version = "1" }},
            .sec_ch_ua = "Sec-Ch-Ua: \"Velora\";v=\"1\"",
            .accept_language = "Accept-Language: en-US,en;q=0.9",
            .prefers_color_scheme = "light",
            .transport_target = target,
            .impersonate = target.curlImpersonate(),
        },
        .features = BrowserPersona.FeatureMatrix.forIdentity(
            .chrome,
            "Velora/1.0 (Macintosh; Intel Mac OS X 10_15_7)",
        ),
    };
}

test "BrowserPersona validates cross-layer identity" {
    var persona = testingPersona();
    try persona.validate();

    persona.network.accept_language = "Accept-Language: fr-FR,fr;q=0.9";
    try std.testing.expectError(error.PersonaAcceptLanguageMismatch, persona.validate());
}

test "BrowserPersona WebRTC proxy policy is fail closed" {
    const persona = testingPersona();
    const direct = persona.webRtcPolicy(false);
    try std.testing.expect(direct.allow_non_proxied_udp);
    try std.testing.expect(!direct.emit_synthetic_candidates);
    const proxied = persona.webRtcPolicy(true);
    try std.testing.expect(!proxied.allow_non_proxied_udp);
    try std.testing.expect(!proxied.emit_synthetic_candidates);
}
