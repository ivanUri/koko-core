const std = @import("std");

const Frame = @import("../../core/browser/Frame.zig");

/// CreepJS / Picasso standard OfflineAudioContext probe graph.
pub const ProbeState = struct {
    offline_channels: u32 = 0,
    offline_length: u32 = 0,
    offline_sample_rate: f64 = 0,
    oscillator_triangle: bool = false,
    oscillator_frequency: f64 = 0,
    compressor_threshold: f64 = 0,
    gain_value: f64 = 0,
    oscillator_started: bool = false,

    pub fn recordOffline(self: *ProbeState, channels: u32, length: u32, sample_rate: f64) void {
        self.offline_channels = channels;
        self.offline_length = length;
        self.offline_sample_rate = sample_rate;
    }

    pub fn recordOscillatorType(self: *ProbeState, osc_type: []const u8) void {
        self.oscillator_triangle = std.mem.eql(u8, osc_type, "triangle");
    }

    pub fn recordOscillatorFrequency(self: *ProbeState, frequency: f64) void {
        self.oscillator_frequency = frequency;
    }

    pub fn recordOscillatorStart(self: *ProbeState) void {
        self.oscillator_started = true;
    }

    pub fn recordCompressorThreshold(self: *ProbeState, threshold: f64) void {
        self.compressor_threshold = threshold;
    }

    pub fn recordGain(self: *ProbeState, gain: f64) void {
        self.gain_value = gain;
    }

    pub fn matchesStandardProbe(self: ProbeState) bool {
        if (self.offline_channels != 1) return false;
        if (self.offline_length != 5000) return false;
        if (self.offline_sample_rate != 44100) return false;
        if (!self.oscillator_triangle) return false;
        if (!self.oscillator_started) return false;
        if (@abs(self.oscillator_frequency - 10000) > 0.01) return false;
        if (@abs(self.compressor_threshold - (-50)) > 0.01) return false;
        if (@abs(self.gain_value - 0.5) > 0.01) return false;
        return true;
    }
};

pub const Baseline = struct {
    samples: []const f32,
    freq: []const f32,
};

pub fn baseline(frame: *Frame) ?Baseline {
    const profile = frame.loadedProfile();
    if (profile.mode != .antidetect) return null;
    const samples = profile.audio_probe_samples orelse return null;
    const freq = profile.audio_probe_freq orelse return null;
    if (samples.len == 0 or freq.len == 0) return null;
    return .{ .samples = samples, .freq = freq };
}

pub fn shouldUseBaseline(state: ProbeState, frame: *Frame) bool {
    if (!state.matchesStandardProbe()) return false;
    return baseline(frame) != null;
}
