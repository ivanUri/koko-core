const std = @import("std");

const Frame = @import("../../core/browser/Frame.zig");
const NativeCanvas = @import("NativeCanvas.zig");

pub const ProbeId = enum {
    none,
    canvas_240_velora,
    canvas_50_text,
    canvas_50_emoji,
    canvas_75_data,
    canvas_75_paint,
    canvas_75_paint_cpu,
    canvas_mods_pixel_image,
    canvas_2_low_entropy,
};

/// Tracks canvas 2D draw ops for Chrome-captured fingerprint probes.
pub const ProbeState = struct {
    active: ProbeId = .none,
    low_entropy_ready: bool = false,
    canvas_75_dataurl_count: u8 = 0,

    pub fn reset(self: *ProbeState) void {
        self.* = .{};
    }

    pub fn recordDimensions(self: *ProbeState, width: u32, height: u32) void {
        if (width == 240 and height == 60) {
            self.active = .canvas_240_velora;
            self.low_entropy_ready = false;
            return;
        }
        if (width == 50 and height == 50) {
            // Distinguished by subsequent fillText.
            self.active = .none;
            self.low_entropy_ready = false;
            return;
        }
        if (width == 2 and height == 2) {
            self.active = .canvas_2_low_entropy;
            self.low_entropy_ready = false;
            return;
        }
        self.active = .none;
        self.low_entropy_ready = false;
    }

    pub fn recordFillText(
        self: *ProbeState,
        width: u32,
        height: u32,
        font: []const u8,
        text: []const u8,
        x: f64,
        y: f64,
    ) void {
        if (width == 240 and height == 60 and std.mem.eql(u8, text, "velora") and x == 2 and y == 2) {
            const parsed = NativeCanvas.parseFont(font);
            if (parsed.size == 14 and fontFamilyMatchesArial(parsed.family)) {
                self.active = .canvas_240_velora;
            }
            return;
        }
        if (width == 50 and height == 50 and std.mem.eql(u8, text, "velora") and x == 2 and y == 2) {
            const parsed = NativeCanvas.parseFont(font);
            if (parsed.size == 14 and fontFamilyMatchesArial(parsed.family)) {
                self.active = .canvas_50_text;
            }
            return;
        }
        if (width == 50 and height == 50 and std.mem.eql(u8, text, "😀") and x == 2 and y == 2) {
            const parsed = NativeCanvas.parseFont(font);
            if (parsed.size == 14 and fontFamilyMatchesArial(parsed.family)) {
                self.active = .canvas_50_emoji;
            }
            return;
        }
        if (width == 50 and height == 50 and std.mem.eql(u8, text, "A") and x == 7 and y == 37) {
            const parsed = NativeCanvas.parseFont(font);
            if (parsed.size == 50) {
                self.active = .canvas_50_text;
            }
            return;
        }
        if (width == 50 and height == 50 and std.mem.eql(u8, text, "👾") and x == 0 and y == 37) {
            const parsed = NativeCanvas.parseFont(font);
            if (parsed.size == 35) {
                self.active = .canvas_50_emoji;
            }
        }
    }

    pub fn recordLowEntropyArc(self: *ProbeState, width: u32, height: u32) void {
        if (width == 2 and height == 2) {
            self.active = .canvas_2_low_entropy;
            self.low_entropy_ready = true;
        }
    }
};

fn fontFamilyMatchesArial(family: []const u8) bool {
    var it = std.mem.splitScalar(u8, family, ',');
    while (it.next()) |part| {
        const trimmed = std.mem.trim(u8, part, " \t\"'");
        if (std.ascii.eqlIgnoreCase(trimmed, "Arial")) return true;
    }
    return std.ascii.eqlIgnoreCase(family, "Arial");
}

pub fn baselineDataUrl(frame: *Frame, probe: ProbeId) ?[]const u8 {
    const profile = frame.loadedProfile();
    if (profile.mode != .antidetect) return null;
    return profile.canvas_probe_data_url_for(probe);
}

pub fn baselineImageData(frame: *Frame, probe: ProbeId) ?[]const u8 {
    const profile = frame.loadedProfile();
    if (profile.mode != .antidetect) return null;
    return profile.canvas_image_data_for(probe);
}

pub fn consumeCanvas75DataUrl(state: *ProbeState, frame: *Frame, desynchronized: bool) ?[]const u8 {
    if (desynchronized) {
        if (state.canvas_75_dataurl_count >= 1) return null;
        state.canvas_75_dataurl_count += 1;
        return baselineDataUrl(frame, .canvas_75_paint_cpu);
    }
    if (state.canvas_75_dataurl_count >= 2) return null;
    const id: ProbeId = if (state.canvas_75_dataurl_count == 0) .canvas_75_data else .canvas_75_paint;
    state.canvas_75_dataurl_count += 1;
    return baselineDataUrl(frame, id);
}

pub fn consumeCanvas40ModsDataUrl(_: *ProbeState, frame: *Frame, width: u32, height: u32) ?[]const u8 {
    if (width != 40 or height != 40) return null;
    return baselineDataUrl(frame, .canvas_mods_pixel_image);
}

pub fn shouldUseDataUrlBaseline(state: ProbeState, frame: *Frame) ?[]const u8 {
    if (state.active == .none or state.active == .canvas_2_low_entropy) return null;
    return baselineDataUrl(frame, state.active);
}

pub fn shouldUseImageDataBaseline(state: ProbeState, frame: *Frame) ?[]const u8 {
    if (state.active != .canvas_2_low_entropy or !state.low_entropy_ready) return null;
    return baselineImageData(frame, .canvas_2_low_entropy);
}
