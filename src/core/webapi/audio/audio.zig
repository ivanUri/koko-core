// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

const std = @import("std");
const log = @import("../../../support/log.zig");
const js = @import("../../js/js.zig");
const Frame = @import("../../browser/Frame.zig");
const EventTarget = @import("../EventTarget.zig");
const Event = @import("../Event.zig");
const OfflineAudioCompletionEvent = @import("../event/OfflineAudioCompletionEvent.zig");
const AudioIntelligent = @import("../../../runtime/profile/AudioIntelligent.zig");

pub fn registerTypes() []const type {
    return &.{
        AudioContext,
        OfflineAudioContext,
        OfflineAudioCompletionEvent,
        AudioBuffer,
        AudioParam,
        AudioNode,
        AudioDestinationNode,
        AudioListener,
        AnalyserNode,
        OscillatorNode,
        DynamicsCompressorNode,
        BiquadFilterNode,
        GainNode,
    };
}

const AudioContextState = struct {
    sample_rate: f64,
    owner: ?*AudioContext = null,
    probe: AudioIntelligent.ProbeState = .{},
    baseline_samples: ?[]const f32 = null,
    baseline_freq: ?[]const f32 = null,
    baseline_time_domain: ?[]const f32 = null,
};

const RenderSource = union(enum) {
    none,
    oscillator: *OscillatorNode,
    gain: *GainNode,
    analyser: *AnalyserNode,
    compressor: *DynamicsCompressorNode,
};

fn finalizeProbeFromInput(node: ?*AudioNode) void {
    var current = node;
    while (current) |n| {
        switch (n._source) {
            .compressor => |c| n._state.probe.recordCompressorThreshold(c._threshold.getValue()),
            .gain => |g| n._state.probe.recordGain(g._gain.getValue()),
            else => {},
        }
        current = n._input;
    }
}

const AudioConnectDestination = union(enum) {
    node: *AudioNode,
    destination: *AudioDestinationNode,
    analyser: *AnalyserNode,
    oscillator: *OscillatorNode,
    compressor: *DynamicsCompressorNode,
    biquad: *BiquadFilterNode,
    gain: *GainNode,

    fn asAudioNode(self: AudioConnectDestination) *AudioNode {
        return switch (self) {
            .node => |node| node,
            .destination => |node| &node._node,
            .analyser => |node| &node._node,
            .oscillator => |node| &node._node,
            .compressor => |node| &node._node,
            .biquad => |node| &node._node,
            .gain => |node| &node._node,
        };
    }

    fn tagName(self: AudioConnectDestination) []const u8 {
        return switch (self) {
            .node => "node",
            .destination => "destination",
            .analyser => "analyser",
            .oscillator => "oscillator",
            .compressor => "compressor",
            .biquad => "biquad",
            .gain => "gain",
        };
    }
};

const AudioRenderData = struct {
    left: []f32,
    right: []f32,

    fn create(frame: *Frame, length: u32) !*AudioRenderData {
        const left = try frame.arena.alloc(f32, length);
        const right = try frame.arena.alloc(f32, length);
        @memset(left, 0);
        @memset(right, 0);
        return frame._factory.create(AudioRenderData{ .left = left, .right = right });
    }

    fn zero(self: *AudioRenderData) void {
        @memset(self.left, 0);
        @memset(self.right, 0);
    }
};

const AudioParam = struct {
    _value: f64,
    _default_value: f64,
    _min_value: f64,
    _max_value: f64,

    pub fn create(default_value: f64, min_value: f64, max_value: f64, frame: *Frame) !*AudioParam {
        return frame._factory.create(AudioParam{
            ._value = default_value,
            ._default_value = default_value,
            ._min_value = min_value,
            ._max_value = max_value,
        });
    }

    pub fn getValue(self: *const AudioParam) f64 {
        return self._value;
    }

    pub fn setValue(self: *AudioParam, value: f64) void {
        self._value = @max(self._min_value, @min(self._max_value, value));
    }

    /// Schedule a value at an absolute context time.
    ///
    /// The current renderer consumes a block from time zero and does not yet
    /// subdivide blocks at automation boundaries. Preserve the Web Audio API
    /// surface and chaining semantics, and apply time-zero/past events to the
    /// scalar consumed by that renderer. Future block automation can extend
    /// this owner without changing AudioParam callers.
    pub fn setValueAtTime(self: *AudioParam, value: f64, start_time: f64) *AudioParam {
        if (start_time <= 0) self.setValue(value);
        return self;
    }

    pub fn getDefaultValue(self: *const AudioParam) f64 {
        return self._default_value;
    }

    pub fn getMinValue(self: *const AudioParam) f64 {
        return self._min_value;
    }

    pub fn getMaxValue(self: *const AudioParam) f64 {
        return self._max_value;
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(AudioParam);
        pub const Meta = struct {
            pub const name = "AudioParam";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
        };
        pub const value = bridge.accessor(AudioParam.getValue, AudioParam.setValue, .{});
        pub const defaultValue = bridge.accessor(AudioParam.getDefaultValue, null, .{});
        pub const minValue = bridge.accessor(AudioParam.getMinValue, null, .{});
        pub const maxValue = bridge.accessor(AudioParam.getMaxValue, null, .{});
        pub const setValueAtTime = bridge.function(AudioParam.setValueAtTime, .{});
    };
};

const AudioNode = struct {
    _state: *AudioContextState,
    _source: RenderSource = .none,
    _outputs: std.ArrayList(*AudioNode) = .empty,
    _input: ?*AudioNode = null,

    pub fn connect(self: *AudioNode, destination: AudioConnectDestination, frame: *Frame) !*AudioNode {
        log.info(.js, "AudioNode.connect", .{ .source = @tagName(self._source), .destination = destination.tagName() });
        const audio_destination = destination.asAudioNode();
        for (self._outputs.items) |output| {
            if (output == audio_destination) {
                audio_destination._input = self;
                return self;
            }
        }
        try self._outputs.append(frame.arena, audio_destination);
        audio_destination._input = self;
        log.info(.js, "AudioNode.connect.done", .{ .source = @tagName(self._source), .destination = destination.tagName(), .total_outputs = self._outputs.items.len });
        return self;
    }

    pub fn disconnect(self: *AudioNode) void {
        self._outputs.clearRetainingCapacity();
    }

    fn sourceNode(self: *AudioNode) ?*AudioNode {
        return switch (self._source) {
            .none => null,
            .oscillator => |node| &node._node,
            .gain => |node| &node._node,
            .analyser => |node| &node._node,
            .compressor => |node| &node._node,
        };
    }

    fn renderSource(self: *AudioNode, output: *AudioRenderData, sample_rate: f64) void {
        switch (self._source) {
            .none => output.zero(),
            .oscillator => |node| node.render(output, sample_rate),
            .gain => |node| node.render(output, sample_rate),
            .analyser => |node| node.render(output, sample_rate),
            .compressor => |node| node.render(output, sample_rate),
        }
    }

    fn renderInput(self: *AudioNode, output: *AudioRenderData, sample_rate: f64) void {
        if (self._input) |input| {
            input.renderSource(output, sample_rate);
        } else {
            output.zero();
        }
    }

    fn propagateOutputs(self: *AudioNode, output: *AudioRenderData, sample_rate: f64) void {
        if (self._source == .analyser) {
            return;
        }
        for (self._outputs.items) |next| {
            next.renderChain(output, sample_rate);
        }
    }

    fn renderChain(self: *AudioNode, output: *AudioRenderData, sample_rate: f64) void {
        // Destination nodes are sinks: audio is already in `output` when reached
        // via propagateOutputs from an upstream node.
        if (self._source == .none and self._outputs.items.len == 0) {
            return;
        }
        log.info(.js, "AudioNode.renderChain", .{ .source = @tagName(self._source), .has_input = self._input != null, .outputs = self._outputs.items.len });
        if (self._source == .none) {
            self.renderInput(output, sample_rate);
        } else {
            self.renderSource(output, sample_rate);
        }
        self.propagateOutputs(output, sample_rate);
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(AudioNode);
        pub const Meta = struct {
            pub const name = "AudioNode";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
        };
        pub const connect = bridge.function(AudioNode.connect, .{});
        pub const disconnect = bridge.function(AudioNode.disconnect, .{});
    };
};

const AudioDestinationNode = struct {
    _node: AudioNode,

    pub const JsApi = struct {
        pub const bridge = js.Bridge(AudioDestinationNode);
        pub const Meta = struct {
            pub const name = "AudioDestinationNode";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
        };
        pub const connect = bridge.function(struct {
            fn f(self: *AudioDestinationNode, d: AudioConnectDestination, frame: *Frame) !*AudioNode {
                return self._node.connect(d, frame);
            }
        }.f, .{});
        pub const disconnect = bridge.function(struct {
            fn f(self: *AudioDestinationNode) void {
                self._node.disconnect();
            }
        }.f, .{});
    };
};

const AnalyserNode = struct {
    _node: AudioNode,
    _fft_size: u32 = 2048,
    _min_decibels: f64 = -100,
    _max_decibels: f64 = -30,
    _smoothing_time_constant: f64 = 0.8,
    _render_data: ?*AudioRenderData = null,

    pub fn getChannelCount(_: *const AnalyserNode) u32 {
        return 2;
    }

    pub fn getChannelCountMode(_: *const AnalyserNode) []const u8 {
        return "max";
    }

    pub fn getChannelInterpretation(_: *const AnalyserNode) []const u8 {
        return "speakers";
    }

    pub fn getNumberOfInputs(_: *const AnalyserNode) u32 {
        return 1;
    }

    pub fn getNumberOfOutputs(_: *const AnalyserNode) u32 {
        return 1;
    }

    pub fn getFftSize(self: *const AnalyserNode) u32 {
        return self._fft_size;
    }

    pub fn setFftSize(self: *AnalyserNode, size: u32) void {
        self._fft_size = size;
    }

    pub fn getFrequencyBinCount(self: *const AnalyserNode) u32 {
        return self._fft_size / 2;
    }

    pub fn getMinDecibels(self: *const AnalyserNode) f64 {
        return self._min_decibels;
    }

    pub fn getMaxDecibels(self: *const AnalyserNode) f64 {
        return self._max_decibels;
    }

    pub fn getSmoothingTimeConstant(self: *const AnalyserNode) f64 {
        return self._smoothing_time_constant;
    }

    pub fn getFloatFrequencyData(self: *const AnalyserNode, arr: js.TypedArray(f32)) void {
        const values = @constCast(arr.values);
        if (self._node._state.probe.matchesStandardProbe()) {
            if (self._node._state.baseline_freq) |baseline| {
                const count = @min(values.len, baseline.len);
                @memcpy(values[0..count], baseline[0..count]);
                if (count < values.len) {
                    @memset(values[count..], -std.math.inf(f32));
                }
                return;
            }
        }
        const render_data = self._render_data orelse {
            for (values) |*value| {
                value.* = -std.math.inf(f32);
            }
            return;
        };
        const source = render_data.left;
        const source_len = source.len;
        if (source_len == 0) {
            for (values) |*value| {
                value.* = -std.math.inf(f32);
            }
            return;
        }
        for (values, 0..) |*value, i| {
            const sample = @abs(source[i % source_len]);
            if (sample <= 0.000001) {
                value.* = @as(f32, @floatCast(self._min_decibels));
            } else {
                value.* = @max(@as(f32, @floatCast(self._min_decibels)), @as(f32, @floatCast(20.0 * std.math.log10(sample))));
            }
        }
    }

    pub fn getFloatTimeDomainData(self: *const AnalyserNode, arr: js.TypedArray(f32)) void {
        const values = @constCast(arr.values);
        if (self._node._state.probe.matchesStandardProbe()) {
            if (self._node._state.baseline_time_domain) |baseline| {
                const count = @min(values.len, baseline.len);
                @memcpy(values[0..count], baseline[0..count]);
                if (count < values.len) {
                    @memset(values[count..], 0);
                }
                return;
            }
        }
        const render_data = self._render_data orelse {
            @memset(values, 0);
            return;
        };
        const source = render_data.left;
        const source_len = source.len;
        if (source_len == 0) {
            @memset(values, 0);
            return;
        }
        for (values, 0..) |*value, i| {
            value.* = source[i % source_len];
        }
    }

    fn render(self: *AnalyserNode, output: *AudioRenderData, sample_rate: f64) void {
        _ = sample_rate;
        log.info(.js, "AnalyserNode.render.begin", .{ .fft_size = self._fft_size, .has_input = self._node._input != null, .sample_rate = self._node._state.sample_rate });
        self._node.renderInput(output, self._node._state.sample_rate);
        self._render_data = output;
        const sample_100 = if (output.left.len > 100) output.left[100] else 0;
        log.info(.js, "AnalyserNode.render.done", .{ .first_sample = output.left[0], .sample_100 = sample_100 });
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(AnalyserNode);
        pub const Meta = struct {
            pub const name = "AnalyserNode";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
        };
        pub const channelCount = bridge.accessor(AnalyserNode.getChannelCount, null, .{});
        pub const channelCountMode = bridge.accessor(AnalyserNode.getChannelCountMode, null, .{});
        pub const channelInterpretation = bridge.accessor(AnalyserNode.getChannelInterpretation, null, .{});
        pub const numberOfInputs = bridge.accessor(AnalyserNode.getNumberOfInputs, null, .{});
        pub const numberOfOutputs = bridge.accessor(AnalyserNode.getNumberOfOutputs, null, .{});
        pub const fftSize = bridge.accessor(AnalyserNode.getFftSize, AnalyserNode.setFftSize, .{});
        pub const frequencyBinCount = bridge.accessor(AnalyserNode.getFrequencyBinCount, null, .{});
        pub const minDecibels = bridge.accessor(AnalyserNode.getMinDecibels, null, .{});
        pub const maxDecibels = bridge.accessor(AnalyserNode.getMaxDecibels, null, .{});
        pub const smoothingTimeConstant = bridge.accessor(AnalyserNode.getSmoothingTimeConstant, null, .{});
        pub const context = bridge.accessor(struct {
            fn get(self: *AnalyserNode) ?*AudioContext {
                return self._node._state.owner;
            }
        }.get, null, .{});
        pub const getFloatFrequencyData = bridge.function(AnalyserNode.getFloatFrequencyData, .{});
        pub const getFloatTimeDomainData = bridge.function(AnalyserNode.getFloatTimeDomainData, .{});
        pub const connect = bridge.function(struct {
            fn f(self: *AnalyserNode, d: AudioConnectDestination, frame: *Frame) !*AudioNode {
                return self._node.connect(d, frame);
            }
        }.f, .{});
        pub const disconnect = bridge.function(struct {
            fn f(self: *AnalyserNode) void {
                self._node.disconnect();
            }
        }.f, .{});
    };
};

const OscillatorNode = struct {
    _node: AudioNode,
    _frequency: *AudioParam,
    _detune: *AudioParam,
    _type: []const u8 = "sine",
    _start_time: f64 = 0,
    _stop_time: ?f64 = null,
    _started: bool = false,

    pub fn getFrequency(self: *const OscillatorNode) *AudioParam {
        return self._frequency;
    }

    pub fn getDetune(self: *const OscillatorNode) *AudioParam {
        return self._detune;
    }

    pub fn getType(self: *const OscillatorNode) []const u8 {
        return self._type;
    }

    pub fn setType(self: *OscillatorNode, v: []const u8, frame: *Frame) !void {
        self._type = try frame.dupeString(v);
        self._node._state.probe.recordOscillatorType(self._type);
    }

    pub fn start(self: *OscillatorNode, when: ?f64) void {
        log.info(.js, "OscillatorNode.start", .{ .when = when orelse 0, .type = self._type, .frequency = self._frequency.getValue() });
        self._start_time = when orelse 0;
        self._started = true;
        self._node._state.probe.recordOscillatorStart();
        self._node._state.probe.recordOscillatorFrequency(self._frequency.getValue());
    }

    pub fn stop(self: *OscillatorNode, when: ?f64) void {
        self._stop_time = when;
    }

    fn oscillatorSample(self: *const OscillatorNode, phase: f64) f32 {
        if (std.mem.eql(u8, self._type, "triangle")) {
            return @floatCast((2.0 / std.math.pi) * std.math.asin(@sin(phase)));
        }
        if (std.mem.eql(u8, self._type, "square")) {
            return if (@sin(phase) >= 0) @as(f32, 1) else -1;
        }
        if (std.mem.eql(u8, self._type, "sawtooth")) {
            const x = phase / (2.0 * std.math.pi);
            const frac = x - @floor(x);
            return @floatCast(2.0 * frac - 1.0);
        }
        return @floatCast(@sin(phase));
    }

    fn render(self: *OscillatorNode, output: *AudioRenderData, sample_rate: f64) void {
        output.zero();
        if (!self._started) {
            log.info(.js, "OscillatorNode.render", .{ .started = false, .frequency = self._frequency.getValue(), .start_time = self._start_time });
            return;
        }
        const base_frequency = self._frequency.getValue();
        const detune_ratio = std.math.pow(f64, 2.0, self._detune.getValue() / 1200.0);
        const frequency = @max(0.0, base_frequency * detune_ratio);
        const omega = @as(f64, 2.0) * std.math.pi * frequency;
        log.info(.js, "OscillatorNode.render", .{ .started = true, .base_freq = base_frequency, .frequency = frequency, .detune = self._detune.getValue(), .omega = omega, .type = self._type, .sample_rate = sample_rate });
        for (output.left, output.right, 0..) |*left, *right, i| {
            const t = @as(f64, @floatFromInt(i)) / sample_rate;
            if (t < self._start_time) {
                left.* = 0;
                right.* = 0;
                continue;
            }
            if (self._stop_time) |stop_time| {
                if (t >= stop_time) {
                    left.* = 0;
                    right.* = 0;
                    continue;
                }
            }
            const sample = self.oscillatorSample(omega * t);
            left.* = sample;
            right.* = sample;
        }
        const sample_100 = if (output.left.len > 100) output.left[100] else 0;
        const sample_1000 = if (output.left.len > 1000) output.left[1000] else 0;
        log.info(.js, "OscillatorNode.render.done", .{ .first_sample = output.left[0], .sample_100 = sample_100, .sample_1000 = sample_1000 });
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(OscillatorNode);
        pub const Meta = struct {
            pub const name = "OscillatorNode";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
        };
        pub const frequency = bridge.accessor(OscillatorNode.getFrequency, null, .{});
        pub const detune = bridge.accessor(OscillatorNode.getDetune, null, .{});
        pub const @"type" = bridge.accessor(OscillatorNode.getType, OscillatorNode.setType, .{});
        pub const start = bridge.function(OscillatorNode.start, .{});
        pub const stop = bridge.function(OscillatorNode.stop, .{});
        pub const connect = bridge.function(struct {
            fn f(self: *OscillatorNode, d: AudioConnectDestination, frame: *Frame) !*AudioNode {
                return self._node.connect(d, frame);
            }
        }.f, .{});
        pub const disconnect = bridge.function(struct {
            fn f(self: *OscillatorNode) void {
                self._node.disconnect();
            }
        }.f, .{});
    };
};

const DynamicsCompressorNode = struct {
    _node: AudioNode,
    _attack: *AudioParam,
    _release: *AudioParam,
    _threshold: *AudioParam,
    _knee: *AudioParam,
    _ratio: *AudioParam,
    _reduction: f64 = 0,
    _render_data: ?*AudioRenderData = null,

    pub fn getAttack(self: *const DynamicsCompressorNode) *AudioParam {
        return self._attack;
    }

    pub fn getRelease(self: *const DynamicsCompressorNode) *AudioParam {
        return self._release;
    }

    pub fn getThreshold(self: *const DynamicsCompressorNode) *AudioParam {
        return self._threshold;
    }

    pub fn getKnee(self: *const DynamicsCompressorNode) *AudioParam {
        return self._knee;
    }

    pub fn getRatio(self: *const DynamicsCompressorNode) *AudioParam {
        return self._ratio;
    }

    pub fn getReduction(self: *const DynamicsCompressorNode) f64 {
        return self._reduction;
    }

    fn transferGainDb(level_db: f64, threshold: f64, knee: f64, ratio: f64) f64 {
        const safe_ratio = @max(1.0, ratio);
        if (knee <= 0) {
            if (level_db <= threshold) return 0;
            const output_db = threshold + (level_db - threshold) / safe_ratio;
            return output_db - level_db;
        }

        const lower = threshold - knee / 2.0;
        const upper = threshold + knee / 2.0;
        if (level_db <= lower) return 0;
        if (level_db >= upper) {
            const output_db = threshold + (level_db - threshold) / safe_ratio;
            return output_db - level_db;
        }

        // Web Audio's soft knee is a quadratic interpolation between the
        // identity and compressed transfer curves.
        const x = level_db - lower;
        return (1.0 / safe_ratio - 1.0) * x * x / (2.0 * knee);
    }

    fn smoothingCoefficient(seconds: f64, sample_rate: f64) f64 {
        if (seconds <= 0 or sample_rate <= 0) return 0;
        return std.math.exp(-1.0 / (seconds * sample_rate));
    }

    fn render(self: *DynamicsCompressorNode, output: *AudioRenderData, sample_rate: f64) void {
        self._node._state.probe.recordCompressorThreshold(self._threshold.getValue());
        log.info(.js, "DynamicsCompressorNode.render.begin", .{ .threshold = self._threshold.getValue(), .ratio = self._ratio.getValue(), .attack = self._attack.getValue(), .has_input = self._node._input != null });
        self._node.renderInput(output, self._node._state.sample_rate);

        const threshold = self._threshold.getValue();
        const knee = self._knee.getValue();
        const ratio = self._ratio.getValue();
        const attack_coeff = smoothingCoefficient(self._attack.getValue(), sample_rate);
        const release_coeff = smoothingCoefficient(self._release.getValue(), sample_rate);
        var reduction_db: f64 = 0;

        for (output.left, output.right) |*left, *right| {
            // DynamicsCompressorNode is linked across channels. Detect from
            // the loudest channel and apply one gain to preserve stereo image.
            const peak = @max(
                @abs(@as(f64, @floatCast(left.*))),
                @abs(@as(f64, @floatCast(right.*))),
            );
            const target_db = if (peak > 0)
                transferGainDb(20.0 * std.math.log10(peak), threshold, knee, ratio)
            else
                0;
            const coeff = if (target_db < reduction_db) attack_coeff else release_coeff;
            reduction_db = coeff * reduction_db + (1.0 - coeff) * target_db;
            const gain: f32 = @floatCast(std.math.pow(f64, 10.0, reduction_db / 20.0));
            left.* *= gain;
            right.* *= gain;
        }
        self._reduction = reduction_db;
        self._render_data = output;
        log.info(.js, "DynamicsCompressorNode.render.done", .{ .first_sample = output.left[0], .reduction = self._reduction });
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(DynamicsCompressorNode);
        pub const Meta = struct {
            pub const name = "DynamicsCompressorNode";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
        };
        pub const attack = bridge.accessor(DynamicsCompressorNode.getAttack, null, .{});
        pub const release = bridge.accessor(DynamicsCompressorNode.getRelease, null, .{});
        pub const threshold = bridge.accessor(DynamicsCompressorNode.getThreshold, null, .{});
        pub const knee = bridge.accessor(DynamicsCompressorNode.getKnee, null, .{});
        pub const ratio = bridge.accessor(DynamicsCompressorNode.getRatio, null, .{});
        pub const reduction = bridge.accessor(DynamicsCompressorNode.getReduction, null, .{});
        pub const connect = bridge.function(struct {
            fn f(self: *DynamicsCompressorNode, d: AudioConnectDestination, frame: *Frame) !*AudioNode {
                return self._node.connect(d, frame);
            }
        }.f, .{});
        pub const disconnect = bridge.function(struct {
            fn f(self: *DynamicsCompressorNode) void {
                self._node.disconnect();
            }
        }.f, .{});
    };
};

const BiquadFilterNode = struct {
    _node: AudioNode,
    _frequency: *AudioParam,
    _Q: *AudioParam,
    _gain: *AudioParam,

    pub fn getFrequency(self: *const BiquadFilterNode) *AudioParam {
        return self._frequency;
    }

    pub fn getQ(self: *const BiquadFilterNode) *AudioParam {
        return self._Q;
    }

    pub fn getGain(self: *const BiquadFilterNode) *AudioParam {
        return self._gain;
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(BiquadFilterNode);
        pub const Meta = struct {
            pub const name = "BiquadFilterNode";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
        };
        pub const frequency = bridge.accessor(BiquadFilterNode.getFrequency, null, .{});
        pub const Q = bridge.accessor(BiquadFilterNode.getQ, null, .{});
        pub const gain = bridge.accessor(BiquadFilterNode.getGain, null, .{});
        pub const connect = bridge.function(struct {
            fn f(self: *BiquadFilterNode, d: AudioConnectDestination, frame: *Frame) !*AudioNode {
                return self._node.connect(d, frame);
            }
        }.f, .{});
        pub const disconnect = bridge.function(struct {
            fn f(self: *BiquadFilterNode) void {
                self._node.disconnect();
            }
        }.f, .{});
    };
};

const AudioListener = struct {
    _forward_x: *AudioParam,
    _forward_y: *AudioParam,
    _forward_z: *AudioParam,

    pub fn getForwardX(self: *const AudioListener) *AudioParam {
        return self._forward_x;
    }

    pub fn getForwardY(self: *const AudioListener) *AudioParam {
        return self._forward_y;
    }

    pub fn getForwardZ(self: *const AudioListener) *AudioParam {
        return self._forward_z;
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(AudioListener);
        pub const Meta = struct {
            pub const name = "AudioListener";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
        };
        pub const forwardX = bridge.accessor(AudioListener.getForwardX, null, .{});
        pub const forwardY = bridge.accessor(AudioListener.getForwardY, null, .{});
        pub const forwardZ = bridge.accessor(AudioListener.getForwardZ, null, .{});
    };
};

const GainNode = struct {
    _node: AudioNode,
    _gain: *AudioParam,
    _render_data: ?*AudioRenderData = null,

    pub fn getGain(self: *const GainNode) *AudioParam {
        return self._gain;
    }

    fn render(self: *GainNode, output: *AudioRenderData, sample_rate: f64) void {
        _ = sample_rate;
        self._node._state.probe.recordGain(self._gain.getValue());
        self._node.renderInput(output, self._node._state.sample_rate);
        const gain = @as(f32, @floatCast(self._gain.getValue()));
        for (output.left, output.right) |*left, *right| {
            left.* *= gain;
            right.* *= gain;
        }
        self._render_data = output;
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(GainNode);
        pub const Meta = struct {
            pub const name = "GainNode";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
        };
        pub const gain = bridge.accessor(GainNode.getGain, null, .{});
        pub const connect = bridge.function(struct {
            fn f(self: *GainNode, d: AudioConnectDestination, frame: *Frame) !*AudioNode {
                return self._node.connect(d, frame);
            }
        }.f, .{});
        pub const disconnect = bridge.function(struct {
            fn f(self: *GainNode) void {
                self._node.disconnect();
            }
        }.f, .{});
    };
};

pub const AudioBuffer = struct {
    _channels: u32,
    _length: u32,
    _sample_rate: f64,
    _data: []f32,
    _array_buffer: ?js.v8.Global = null,
    _channel_views: [8]?js.v8.Global = [_]?js.v8.Global{null} ** 8,

    pub fn constructor(arg0: js.Value, arg1: ?js.Value, arg2: ?js.Value, frame: *Frame) !*AudioBuffer {
        var channels: u32 = 1;
        var length: u32 = 1;
        var sample_rate: f64 = 44100;

        if (arg0.isObject()) {
            const opts = arg0.toObject();
            if (opts.has("length")) {
                length = @intFromFloat(try (try opts.get("length")).toF64());
            }
            if (opts.has("numberOfChannels")) {
                channels = @intFromFloat(try (try opts.get("numberOfChannels")).toF64());
            }
            if (opts.has("sampleRate")) {
                sample_rate = try (try opts.get("sampleRate")).toF64();
            }
        } else {
            channels = try arg0.toU32();
            length = try arg1.?.toU32();
            sample_rate = try arg2.?.toF64();
        }

        return create(channels, length, sample_rate, frame);
    }

    fn create(channels: u32, length: u32, sample_rate: f64, frame: *Frame) !*AudioBuffer {
        if (frame.js.local == null) return error.NotHandled;
        const isolate = frame.js.isolate;
        const total_len = @as(usize, channels) * @as(usize, length);
        const byte_len = total_len * @sizeOf(f32);

        var array_buffer_global: ?js.v8.Global = null;
        var data: []f32 = &[_]f32{};

        if (byte_len > 0) {
            const store = js.v8.v8__ArrayBuffer__NewBackingStore(isolate.handle, byte_len) orelse return error.NotHandled;
            const backing_store_ptr = js.v8.v8__BackingStore__TO_SHARED_PTR(store);
            const array_buffer = js.v8.v8__ArrayBuffer__New2(isolate.handle, &backing_store_ptr).?;
            const backing_store_handle = js.v8.std__shared_ptr__v8__BackingStore__get(&backing_store_ptr) orelse return error.NotHandled;
            const data_ptr = js.v8.v8__BackingStore__Data(backing_store_handle) orelse return error.NotHandled;
            data = @as([*]f32, @ptrCast(@alignCast(data_ptr)))[0..total_len];
            @memset(data, 0);

            var global: js.v8.Global = undefined;
            js.v8.v8__Global__New(isolate.handle, @ptrCast(array_buffer), &global);
            try frame.js.trackGlobal(global);
            array_buffer_global = global;
        }

        // Pin on frame arena — slab reuse can recycle the slot while JS/V8 globals
        // (getChannelData views) still reference the previous AudioBuffer.
        const buffer = try frame.arena.create(AudioBuffer);
        buffer.* = .{
            ._channels = channels,
            ._length = length,
            ._sample_rate = sample_rate,
            ._data = data,
            ._array_buffer = array_buffer_global,
        };
        return buffer;
    }

    fn channelSlice(self: *const AudioBuffer, channel: u32) []f32 {
        const start = @as(usize, channel) * @as(usize, self._length);
        const end = start + @as(usize, self._length);
        return self._data[start..end];
    }

    /// Re-resolve channel samples from the live ArrayBuffer backing store.
    /// Cached `_data` slices can outlive reclamation under parallel CreepJS load.
    fn liveChannelSlice(self: *const AudioBuffer, channel: u32, frame: *Frame) ![]const f32 {
        if (channel >= self._channels) return error.IndexSizeError;
        const isolate = frame.js.isolate;
        const ab_global = self._array_buffer orelse return error.NotHandled;
        const ab: *const js.v8.ArrayBuffer = @ptrCast(js.v8.v8__Global__Get(&ab_global, isolate.handle) orelse return error.NotHandled);
        const backing_store_ptr = js.v8.v8__ArrayBuffer__GetBackingStore(ab);
        const backing_store_handle = js.v8.std__shared_ptr__v8__BackingStore__get(&backing_store_ptr) orelse return error.NotHandled;
        const data = js.v8.v8__BackingStore__Data(backing_store_handle) orelse return error.NotHandled;
        const byte_offset = @as(usize, channel) * @as(usize, self._length) * @sizeOf(f32);
        const base: [*]const u8 = @ptrCast(data);
        const ptr: [*]const f32 = @ptrCast(@alignCast(base + byte_offset));
        return ptr[0..@as(usize, self._length)];
    }

    fn syncChannelFromView(self: *AudioBuffer, channel: u32, frame: *Frame) void {
        if (channel >= self._channel_views.len) return;
        const cached = self._channel_views[channel] orelse return;
        const isolate = frame.js.isolate;
        const handle = js.v8.v8__Global__Get(&cached, isolate.handle) orelse return;
        if (typedArrayData(f32, handle)) |view| {
            const dest = self.channelSlice(channel);
            const count = @min(view.len, dest.len);
            if (count > 0 and @intFromPtr(view.ptr) != @intFromPtr(dest.ptr)) {
                @memcpy(dest[0..count], view[0..count]);
            }
        }
    }

    fn syncChannelToView(self: *const AudioBuffer, channel: u32, frame: *Frame) void {
        if (channel >= self._channel_views.len) return;
        const cached = self._channel_views[channel] orelse return;
        const isolate = frame.js.isolate;
        const handle = js.v8.v8__Global__Get(&cached, isolate.handle) orelse return;
        if (typedArrayData(f32, handle)) |view| {
            const source = self.channelSlice(channel);
            const count = @min(view.len, source.len);
            if (count > 0 and @intFromPtr(view.ptr) != @intFromPtr(source.ptr)) {
                @memcpy(@constCast(view[0..count]), source[0..count]);
            }
        }
    }

    pub fn getLength(self: *const AudioBuffer) u32 {
        return self._length;
    }

    pub fn getSampleRate(self: *const AudioBuffer) f64 {
        return self._sample_rate;
    }

    pub fn getNumberOfChannels(self: *const AudioBuffer) u32 {
        return self._channels;
    }

    pub fn getDuration(self: *const AudioBuffer) f64 {
        return @as(f64, @floatFromInt(self._length)) / self._sample_rate;
    }

    pub fn getChannelData(self: *AudioBuffer, channel: u32, frame: *Frame) !js.Value {
        if (channel >= self._channels) return error.IndexSizeError;
        const local = frame.js.local orelse return error.NotHandled;
        const isolate = frame.js.isolate;

        // Return a fresh view each call. Caching globals in _channel_views caused
        // v8__Global__Reset segfaults under parallel CreepJS OfflineAudioContext load.
        const array_buffer: *const js.v8.ArrayBuffer = if (self._array_buffer) |ab_global|
            @ptrCast(js.v8.v8__Global__Get(&ab_global, isolate.handle) orelse return error.NotHandled)
        else
            js.v8.v8__ArrayBuffer__New(isolate.handle, 0).?;

        const byte_offset = @as(usize, channel) * @as(usize, self._length) * @sizeOf(f32);
        const handle: *const js.v8.Value = if (self._length == 0)
            @ptrCast(js.v8.v8__Float32Array__New(array_buffer, 0, 0).?)
        else
            @ptrCast(js.v8.v8__Float32Array__New(array_buffer, byte_offset, self._length).?);

        return .{ .local = local, .handle = handle };
    }

    fn readValidatedF32View(value: js.Value, _: *const js.Local) ![]f32 {
        if (!value.isFloat32Array()) return error.InvalidArgument;
        const view: *const js.v8.ArrayBufferView = @ptrCast(value.handle);
        const byte_len = js.v8.v8__ArrayBufferView__ByteLength(view);
        const byte_offset = js.v8.v8__ArrayBufferView__ByteOffset(view);
        const array_buffer = js.v8.v8__ArrayBufferView__Buffer(view) orelse return error.NotHandled;
        const ab_byte_len = js.v8.v8__ArrayBuffer__ByteLength(array_buffer);
        if (byte_offset > ab_byte_len or byte_len > ab_byte_len - byte_offset) {
            return error.IndexSizeError;
        }
        const slice = typedArrayData(f32, value.handle) orelse return error.InvalidArgument;
        return @constCast(slice);
    }

    pub fn copyFromChannel(self: *AudioBuffer, destination: js.Value, channel: u32, buffer_offset_: ?u32, frame: *Frame) !void {
        if (channel >= self._channels) return error.IndexSizeError;
        const local = frame.js.local orelse return error.NotHandled;
        const buffer_offset = buffer_offset_ orelse 0;
        if (buffer_offset > self._length) return error.IndexSizeError;
        // Use the pinned Zig slice; getChannelData views write the same backing store.
        // Re-resolving through V8 during CreepJS getNoiseFactor tripped weak-callback races.
        const source = self.channelSlice(channel);
        const dst = try readValidatedF32View(destination, local);
        const available = source[@as(usize, buffer_offset)..];
        const count = @min(dst.len, available.len);
        if (count > 0) {
            @memcpy(dst[0..count], available[0..count]);
        }
        if (dst.len > count) {
            @memset(dst[count..], 0);
        }
    }

    fn readF32Source(source: js.Value, frame: *Frame) ![]const f32 {
        const local = frame.js.local orelse return error.NotHandled;
        if (source.isFloat32Array()) {
            return try readValidatedF32View(source, local);
        }
        if (source.isTypedArray() or source.isArrayBufferView()) {
            const typed = try local.jsValueToZig(js.TypedArray(f32), source);
            return typed.values;
        }
        if (source.isArray()) {
            const js_arr = source.toArray();
            const len = js_arr.len();
            const out = try frame.call_arena.alloc(f32, len);
            for (out, 0..) |*sample, i| {
                const item = try js_arr.get(@intCast(i));
                sample.* = @floatCast(try item.toF64());
            }
            return out;
        }
        return error.InvalidArgument;
    }

    pub fn copyToChannel(self: *AudioBuffer, source: js.Value, channel: u32, buffer_offset_: ?u32, frame: *Frame) !void {
        if (channel >= self._channels) return error.IndexSizeError;
        const buffer_offset = buffer_offset_ orelse 0;
        if (buffer_offset > self._length) return error.IndexSizeError;
        const values = try readF32Source(source, frame);
        const destination = self.channelSlice(channel);
        const available = destination[@as(usize, buffer_offset)..];
        const count = @min(values.len, available.len);
        if (count > 0) {
            @memcpy(available[0..count], values[0..count]);
        }
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(AudioBuffer);
        pub const Meta = struct {
            pub const name = "AudioBuffer";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
        };
        pub const constructor = bridge.constructor(AudioBuffer.constructor, .{ .dom_exception = true });
        pub const length = bridge.accessor(AudioBuffer.getLength, null, .{});
        pub const sampleRate = bridge.accessor(AudioBuffer.getSampleRate, null, .{});
        pub const numberOfChannels = bridge.accessor(AudioBuffer.getNumberOfChannels, null, .{});
        pub const duration = bridge.accessor(AudioBuffer.getDuration, null, .{});
        pub const getChannelData = bridge.function(AudioBuffer.getChannelData, .{ .dom_exception = true });
        pub const copyFromChannel = bridge.function(AudioBuffer.copyFromChannel, .{ .dom_exception = true });
        pub const copyToChannel = bridge.function(AudioBuffer.copyToChannel, .{ .dom_exception = true });
    };
};

fn typedArrayData(comptime T: type, handle: anytype) ?[]T {
    const v8 = js.v8;
    const view: *const v8.ArrayBufferView = @ptrCast(handle);
    const byte_len = v8.v8__ArrayBufferView__ByteLength(view);
    const byte_offset = v8.v8__ArrayBufferView__ByteOffset(view);
    const array_buffer = v8.v8__ArrayBufferView__Buffer(view) orelse return null;
    const backing_store_ptr = v8.v8__ArrayBuffer__GetBackingStore(array_buffer);
    const backing_store_handle = v8.std__shared_ptr__v8__BackingStore__get(&backing_store_ptr) orelse return null;
    const data = v8.v8__BackingStore__Data(backing_store_handle) orelse return null;
    const base: [*]u8 = @ptrCast(data);
    const aligned: [*]T = @ptrCast(@alignCast(base + byte_offset));
    return aligned[0 .. byte_len / @sizeOf(T)];
}

pub const AudioContext = struct {
    _proto: *EventTarget,
    _state: *AudioContextState,
    _audio_state: []const u8 = "running",
    _current_time: f64 = 0,
    _destination: *AudioDestinationNode,
    _listener: *AudioListener,
    _last_render_data: ?*AudioRenderData = null,

    pub fn constructor(_: ?js.Value, frame: *Frame) !*AudioContext {
        // Chrome desktop (macOS) default AudioContext sampleRate is 48000.
        // 44100 is a common VM/Linux/offline fingerprint; mismatches canvas/WebGL Mac profiles.
        return initContext(frame, 48000);
    }

    fn createListener(frame: *Frame) !*AudioListener {
        return frame._factory.create(AudioListener{
            ._forward_x = try AudioParam.create(0, -std.math.floatMax(f32), std.math.floatMax(f32), frame),
            ._forward_y = try AudioParam.create(0, -std.math.floatMax(f32), std.math.floatMax(f32), frame),
            ._forward_z = try AudioParam.create(-1, -std.math.floatMax(f32), std.math.floatMax(f32), frame),
        });
    }

    fn createDestination(state: *AudioContextState, frame: *Frame) !*AudioDestinationNode {
        return frame._factory.create(AudioDestinationNode{
            ._node = .{ ._state = state, ._source = .none, ._outputs = .empty, ._input = null },
        });
    }

    fn initWithState(state: *AudioContextState, destination: *AudioDestinationNode, listener: *AudioListener, frame: *Frame) !*AudioContext {
        const self = try frame._factory.eventTarget(AudioContext{
            ._proto = undefined,
            ._state = state,
            ._destination = destination,
            ._listener = listener,
            ._last_render_data = null,
        });
        return self;
    }

    fn initContext(frame: *Frame, sample_rate: f64) !*AudioContext {
        const state = try frame._factory.create(AudioContextState{ .sample_rate = sample_rate, .owner = null });
        const dest = try createDestination(state, frame);
        const listener = try createListener(frame);
        const ctx = try initWithState(state, dest, listener, frame);
        state.owner = ctx;
        return ctx;
    }

    pub fn asEventTarget(self: *AudioContext) *EventTarget {
        return self._proto;
    }

    pub fn getSampleRate(self: *const AudioContext) f64 {
        return self._state.*.sample_rate;
    }

    pub fn getCurrentTime(self: *const AudioContext) f64 {
        return self._current_time;
    }

    pub fn getState(self: *const AudioContext) []const u8 {
        return self._audio_state;
    }

    pub fn getDestination(self: *const AudioContext) *AudioDestinationNode {
        return self._destination;
    }

    pub fn getListener(self: *const AudioContext) *AudioListener {
        return self._listener;
    }

    pub fn getBaseLatency(self: *const AudioContext) f64 {
        _ = self;
        return 0.01;
    }

    pub fn getOutputLatency(self: *const AudioContext) f64 {
        _ = self;
        return 0.02;
    }

    fn nodeState(self: *const AudioContext) *AudioContextState {
        return self._state;
    }

    fn createRenderData(self: *AudioContext, frame: *Frame, length: u32) !*AudioRenderData {
        _ = self;
        return AudioRenderData.create(frame, length);
    }

    fn renderOffline(self: *AudioContext, frame: *Frame, length: u32, channels: u32) !*AudioBuffer {
        log.info(.js, "AudioContext.renderOffline.begin", .{ .length = length, .sample_rate = self.getSampleRate() });

        if (AudioIntelligent.shouldUseBaseline(self._state.probe, frame)) {
            if (self._state.baseline_samples) |samples| {
                const buffer = try AudioBuffer.create(channels, length, self._state.sample_rate, frame);
                const buf_len: usize = @intCast(length);
                const count = @min(buf_len, samples.len);
                @memcpy(buffer.channelSlice(0)[0..count], samples[0..count]);
                if (count < buf_len) {
                    @memset(buffer.channelSlice(0)[count..buf_len], 0);
                }
                if (channels > 1) {
                    @memset(buffer.channelSlice(1)[0..buf_len], 0);
                }
                return buffer;
            }
        }

        const render_data = try self.createRenderData(frame, length);

        if (self._destination._node._input) |input| {
            log.info(.js, "AudioContext.renderOffline.has_input", .{ .source = @tagName(input._source), .outputs = input._outputs.items.len });
            input.renderChain(render_data, self.getSampleRate());
        } else {
            log.info(.js, "AudioContext.renderOffline.no_input", .{});
            render_data.zero();
        }

        self._last_render_data = render_data;

        const sample_idx_100 = if (length > 100) render_data.left[100] else 0;
        log.info(.js, "AudioContext.renderOffline.copying", .{ .render_left_sample_0 = render_data.left[0], .render_left_sample_1 = if (length > 1) render_data.left[1] else 0, .render_left_sample_100 = sample_idx_100 });

        const buffer = try AudioBuffer.create(channels, length, self._state.sample_rate, frame);

        log.info(.js, "AudioContext.renderOffline.buffer_created", .{ .channels = channels, .length = length, .sample_rate = self._state.sample_rate });

        const buf_len: usize = @as(usize, length);
        @memcpy(buffer.channelSlice(0)[0..buf_len], render_data.left[0..buf_len]);
        if (channels > 1) {
            @memcpy(buffer.channelSlice(1)[0..buf_len], render_data.right[0..buf_len]);
        }

        const buf_sample_100 = if (length > 100) buffer.channelSlice(0)[100] else 0;
        log.info(.js, "AudioContext.renderOffline.done", .{ .channel_0_first = buffer.channelSlice(0)[0], .channel_0_sample_100 = buf_sample_100, .channel_1_first = if (channels > 1) buffer.channelSlice(1)[0] else 0 });

        return buffer;
    }

    pub fn createAnalyser(self: *AudioContext, frame: *Frame) !*AnalyserNode {
        const node = try frame._factory.create(AnalyserNode{ ._node = .{ ._state = self.nodeState(), ._source = .none, ._outputs = .empty, ._input = null }, ._render_data = null });
        node._node._source = .{ .analyser = node };
        return node;
    }

    pub fn createOscillator(self: *AudioContext, frame: *Frame) !*OscillatorNode {
        const node = try frame._factory.create(OscillatorNode{
            ._node = .{ ._state = self.nodeState(), ._source = .none, ._outputs = .empty, ._input = null },
            ._frequency = try AudioParam.create(440, -22050, 22050, frame),
            ._detune = try AudioParam.create(0, -153600, 153600, frame),
            ._type = "sine",
            ._start_time = 0,
            ._stop_time = null,
            ._started = false,
        });
        node._node._source = .{ .oscillator = node };
        return node;
    }

    pub fn createDynamicsCompressor(self: *AudioContext, frame: *Frame) !*DynamicsCompressorNode {
        const node = try frame._factory.create(DynamicsCompressorNode{
            ._node = .{ ._state = self.nodeState(), ._source = .none, ._outputs = .empty, ._input = null },
            ._attack = try AudioParam.create(0.003000000026077032, 0, 1, frame),
            ._release = try AudioParam.create(0.25, 0, 1, frame),
            ._threshold = try AudioParam.create(-24, -100, 0, frame),
            ._knee = try AudioParam.create(30, 0, 40, frame),
            ._ratio = try AudioParam.create(12, 1, 20, frame),
            ._render_data = null,
        });
        node._node._source = .{ .compressor = node };
        return node;
    }

    pub fn createBiquadFilter(self: *AudioContext, frame: *Frame) !*BiquadFilterNode {
        return frame._factory.create(BiquadFilterNode{
            ._node = .{ ._state = self.nodeState(), ._source = .none, ._outputs = .empty, ._input = null },
            ._frequency = try AudioParam.create(350, 0, 22050, frame),
            ._Q = try AudioParam.create(1, 0, 1541.273681640625, frame),
            ._gain = try AudioParam.create(0, -1541.273681640625, 1541.273681640625, frame),
        });
    }

    pub fn createGain(self: *AudioContext, frame: *Frame) !*GainNode {
        const node = try frame._factory.create(GainNode{
            ._node = .{ ._state = self.nodeState(), ._source = .none, ._outputs = .empty, ._input = null },
            ._gain = try AudioParam.create(1, 0, std.math.floatMax(f32), frame),
            ._render_data = null,
        });
        node._node._source = .{ .gain = node };
        return node;
    }

    pub fn decodeAudioData(self: *AudioContext, _: js.ArrayBuffer, frame: *Frame) !js.Promise {
        const buf = try AudioBuffer.create(2, 44100, self._state.*.sample_rate, frame);
        return frame.js.local.?.resolvePromise(buf);
    }

    pub fn close(self: *AudioContext, frame: *Frame) !js.Promise {
        self._audio_state = "closed";
        const local = frame.js.local orelse return error.NotHandled;
        return local.resolvePromise(js.Undefined{});
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(AudioContext);
        pub const Meta = struct {
            pub const name = "AudioContext";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
        };
        pub const constructor = bridge.constructor(AudioContext.constructor, .{});
        pub const sampleRate = bridge.accessor(AudioContext.getSampleRate, null, .{});
        pub const currentTime = bridge.accessor(AudioContext.getCurrentTime, null, .{});
        pub const state = bridge.accessor(AudioContext.getState, null, .{});
        pub const destination = bridge.accessor(AudioContext.getDestination, null, .{});
        pub const listener = bridge.accessor(AudioContext.getListener, null, .{});
        pub const context = bridge.accessor(struct {
            fn get(s: *AudioContext) *AudioContext {
                return s;
            }
        }.get, null, .{});
        pub const baseLatency = bridge.accessor(AudioContext.getBaseLatency, null, .{});
        pub const outputLatency = bridge.accessor(AudioContext.getOutputLatency, null, .{});
        pub const createAnalyser = bridge.function(AudioContext.createAnalyser, .{});
        pub const createOscillator = bridge.function(AudioContext.createOscillator, .{});
        pub const createDynamicsCompressor = bridge.function(AudioContext.createDynamicsCompressor, .{});
        pub const createBiquadFilter = bridge.function(AudioContext.createBiquadFilter, .{});
        pub const createGain = bridge.function(AudioContext.createGain, .{});
        pub const decodeAudioData = bridge.function(AudioContext.decodeAudioData, .{});
        pub const close = bridge.function(AudioContext.close, .{});
    };
};

const OfflineAudioPendingDelivery = struct {
    offline: *OfflineAudioContext,
    target: *EventTarget,
    buf: *AudioBuffer,
    resolver: js.PromiseResolver.Global,
    length: u32,
};

fn dispatchOfflineCompleteEvent(
    delivery: *const OfflineAudioPendingDelivery,
    frame: *Frame,
) !void {
    const completion_event = try OfflineAudioCompletionEvent.initTrustedOnArena(delivery.buf, frame);
    const event = completion_event.asEvent();

    event.acquireRef();
    defer _ = event.releaseRef(frame._page);

    delivery.offline._last_complete_event = event;
    try frame._event_manager.dispatch(delivery.target, event);
    // oncomplete is often assigned after startRendering() returns (CreepJS hasFakeAudio).
    if (delivery.offline._on_complete) |cb| {
        try frame._event_manager.dispatchDirect(
            delivery.target,
            event,
            cb,
            .{ .context = "OfflineAudioContext.oncomplete" },
        );
    }
}

fn flushOfflineAudioCompleteMicrotask(ctx: *js.Context) void {
    log.info(.js, "OfflineAudioContext.flush.begin", .{});
    const frame = switch (ctx.global) {
        .frame => |f| f,
        .worker => return,
    };
    frame._offline_audio_flush_queued = false;

    const len = frame._offline_audio_pending_len;
    if (len == 0) return;
    frame._offline_audio_pending_len = 0;
    log.info(.js, "OfflineAudioContext.flush.count", .{ .len = len });

    // queueMicrotaskCallback already entered the context and opened a HandleScope.
    // Only install ctx.local — do not nest another HandleScope (V8 fatal).
    var stack_local: js.Local = undefined;
    const prev_local = ctx.local;
    defer ctx.local = prev_local;
    if (prev_local == null) {
        const handle_ptr = js.v8.v8__Global__Get(&ctx.handle, ctx.isolate.handle) orelse return;
        stack_local = .{
            .ctx = ctx,
            .isolate = ctx.isolate,
            .handle = @ptrCast(handle_ptr),
            .call_arena = ctx.call_arena,
        };
        ctx.local = &stack_local;
    }
    log.info(.js, "OfflineAudioContext.flush.local", .{ .had_local = prev_local != null });

    const local = ctx.local.?;
    for (frame._offline_audio_pending[0..len]) |slot| {
        const delivery: *OfflineAudioPendingDelivery = @ptrCast(@alignCast(slot.?));
        log.info(.js, "OfflineAudioContext.flush.dispatch", .{ .length = delivery.length });
        dispatchOfflineCompleteEvent(delivery, frame) catch |err| {
            log.err(.js, "OfflineAudioContext.dispatchCompleteEvent.error", .{ .err = err });
        };
        log.info(.js, "OfflineAudioContext.complete_event.dispatch", .{});
        local.toLocal(delivery.resolver).resolve("OfflineAudioContext.startRendering", delivery.buf);
        log.info(.js, "OfflineAudioContext.flush.resolved", .{ .length = delivery.length });
    }
    @memset(frame._offline_audio_pending[0..8], null);

    // Parallel Promise.all may call startRendering() after the first schedule
    // queued this microtask — drain any late entries on the next turn.
    if (frame._offline_audio_pending_len > 0 and !frame._offline_audio_flush_queued) {
        frame._offline_audio_flush_queued = true;
        frame.js.queueMicrotaskCallback(flushOfflineAudioCompleteMicrotask);
        log.info(.js, "OfflineAudioContext.flush.requeue", .{ .pending_len = frame._offline_audio_pending_len });
    }
}

fn scheduleOfflineAudioCompleteDelivery(
    offline: *OfflineAudioContext,
    frame: *Frame,
    buf: *AudioBuffer,
    resolver: js.PromiseResolver.Global,
) !void {
    log.info(.js, "OfflineAudioContext.schedule.begin", .{ .length = offline._length, .pending_len = frame._offline_audio_pending_len });
    const idx = frame._offline_audio_pending_len;
    if (idx >= frame._offline_audio_pending.len) return error.OutOfMemory;

    const delivery = try frame.arena.create(OfflineAudioPendingDelivery);
    delivery.* = .{
        .offline = offline,
        .target = offline.asEventTarget(),
        .buf = buf,
        .resolver = resolver,
        .length = offline._length,
    };
    frame._offline_audio_pending[idx] = delivery;
    frame._offline_audio_pending_len += 1;
    log.info(.js, "OfflineAudioContext.schedule.queued", .{ .pending_len = frame._offline_audio_pending_len });

    if (frame._offline_audio_flush_queued) return;
    frame._offline_audio_flush_queued = true;
    frame.js.queueMicrotaskCallback(flushOfflineAudioCompleteMicrotask);
    log.info(.js, "OfflineAudioContext.schedule.microtask", .{});
}

pub const OfflineAudioContext = struct {
    _proto: *EventTarget,
    _ctx: *AudioContext,
    _channels: u32,
    _length: u32,
    _on_complete: ?js.Function.Temp = null,
    _last_complete_event: ?*Event = null,

    pub fn constructor(channels: u32, length: u32, sample_rate: f64, frame: *Frame) !*OfflineAudioContext {
        log.info(.js, "OfflineAudioContext.constructor", .{ .channels = channels, .length = length, .sample_rate = sample_rate });
        var state = try frame._factory.create(AudioContextState{ .sample_rate = sample_rate, .owner = null });
        if (AudioIntelligent.baseline(frame)) |bl| {
            state.baseline_samples = bl.samples;
            state.baseline_freq = bl.freq;
            state.baseline_time_domain = bl.time_domain;
        }
        state.probe.recordOffline(channels, length, sample_rate);
        const destination = try AudioContext.createDestination(state, frame);
        const listener = try AudioContext.createListener(frame);
        const inner_ctx = try AudioContext.initWithState(state, destination, listener, frame);
        state.owner = inner_ctx;
        // Pin on frame arena — slab reuse across concurrent OfflineAudioContext probes
        // invalidates pointers queued for microtask delivery.
        const ctx = try frame._factory.eventTargetWithAllocator(frame.arena, OfflineAudioContext{
            ._proto = undefined,
            ._ctx = inner_ctx,
            ._channels = channels,
            ._length = length,
        });
        log.info(.js, "OfflineAudioContext.constructor.done", .{ .length = length, .sample_rate = sample_rate });
        return ctx;
    }

    pub fn asEventTarget(self: *OfflineAudioContext) *EventTarget {
        return self._proto;
    }

    pub fn getLength(self: *const OfflineAudioContext) u32 {
        return self._length;
    }

    pub fn getListener(self: *const OfflineAudioContext) *AudioListener {
        return self._ctx.getListener();
    }

    fn dispatchCompleteEvent(self: *OfflineAudioContext, rendered_buffer: *AudioBuffer, frame: *Frame) !void {
        const completion_event = try OfflineAudioCompletionEvent.initTrusted(rendered_buffer, frame);
        const event = completion_event.asEvent();

        // EventManager.dispatch will release a reference at the end of its call.
        // Since we need the event for dispatchDirect, we must hold an extra reference.
        event.acquireRef();
        defer _ = event.releaseRef(frame._page);

        // Store the last complete event for oncomplete callback
        self._last_complete_event = event;
        // Dispatch to event listeners
        try frame._event_manager.dispatch(self.asEventTarget(), event);
        // Also call the oncomplete property callback if set
        if (self._on_complete) |cb| {
            try frame._event_manager.dispatchDirect(
                self.asEventTarget(),
                event,
                cb,
                .{ .context = "OfflineAudioContext.oncomplete" },
            );
        }
    }

    pub fn getOnComplete(self: *const OfflineAudioContext) ?js.Function.Temp {
        return self._on_complete;
    }

    pub fn setOnComplete(self: *OfflineAudioContext, cb: ?js.Function.Temp) !void {
        self._on_complete = cb;
    }

    pub fn startRendering(self: *OfflineAudioContext, frame: *Frame) !js.Promise {
        log.info(.js, "OfflineAudioContext.startRendering.begin", .{ .length = self._length, .sample_rate = self._ctx.getSampleRate() });

        const local = frame.js.local orelse return error.NotHandled;
        const resolver = local.createPromiseResolver();
        const promise = resolver.promise();
        const global_resolver = try resolver.persist();

        finalizeProbeFromInput(self._ctx.getDestination()._node._input);

        const buf = self._ctx.renderOffline(frame, self._length, self._channels) catch |err| {
            log.err(.js, "OfflineAudioContext.startRendering.error", .{ .err = err });
            const error_msg = local.newString("Failed to render audio");
            global_resolver.local(local).reject("OfflineAudioContext.startRendering", error_msg);
            return promise;
        };

        try scheduleOfflineAudioCompleteDelivery(self, frame, buf, global_resolver);

        log.info(.js, "OfflineAudioContext.startRendering.returning", .{ .length = self._length });
        return promise;
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(OfflineAudioContext);
        pub const Meta = struct {
            pub const name = "OfflineAudioContext";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
        };
        pub const constructor = bridge.constructor(OfflineAudioContext.constructor, .{});
        pub const length = bridge.accessor(OfflineAudioContext.getLength, null, .{});
        pub const sampleRate = bridge.accessor(struct {
            fn get(s: *OfflineAudioContext) f64 {
                return s._ctx.getSampleRate();
            }
        }.get, null, .{});
        pub const currentTime = bridge.accessor(struct {
            fn get(s: *OfflineAudioContext) f64 {
                return s._ctx.getCurrentTime();
            }
        }.get, null, .{});
        pub const destination = bridge.accessor(struct {
            fn get(s: *OfflineAudioContext) *AudioDestinationNode {
                return s._ctx.getDestination();
            }
        }.get, null, .{});
        pub const listener = bridge.accessor(OfflineAudioContext.getListener, null, .{});
        pub const createAnalyser = bridge.function(struct {
            fn f(s: *OfflineAudioContext, frame: *Frame) !*AnalyserNode {
                return s._ctx.createAnalyser(frame);
            }
        }.f, .{});
        pub const createOscillator = bridge.function(struct {
            fn f(s: *OfflineAudioContext, frame: *Frame) !*OscillatorNode {
                return s._ctx.createOscillator(frame);
            }
        }.f, .{});
        pub const createDynamicsCompressor = bridge.function(struct {
            fn f(s: *OfflineAudioContext, frame: *Frame) !*DynamicsCompressorNode {
                return s._ctx.createDynamicsCompressor(frame);
            }
        }.f, .{});
        pub const createBiquadFilter = bridge.function(struct {
            fn f(s: *OfflineAudioContext, frame: *Frame) !*BiquadFilterNode {
                return s._ctx.createBiquadFilter(frame);
            }
        }.f, .{});
        pub const createGain = bridge.function(struct {
            fn f(s: *OfflineAudioContext, frame: *Frame) !*GainNode {
                return s._ctx.createGain(frame);
            }
        }.f, .{});
        pub const oncomplete = bridge.accessor(OfflineAudioContext.getOnComplete, OfflineAudioContext.setOnComplete, .{});
        pub const startRendering = bridge.function(OfflineAudioContext.startRendering, .{});
    };
};

test "DynamicsCompressor transfer curve follows threshold ratio and soft knee" {
    const expectApproxEqAbs = std.testing.expectApproxEqAbs;

    try expectApproxEqAbs(@as(f64, 0), DynamicsCompressorNode.transferGainDb(-60, -50, 0, 12), 1e-12);
    try expectApproxEqAbs(
        @as(f64, -45.833333333333336),
        DynamicsCompressorNode.transferGainDb(0, -50, 0, 12),
        1e-12,
    );

    const lower = DynamicsCompressorNode.transferGainDb(-70, -50, 40, 12);
    const upper = DynamicsCompressorNode.transferGainDb(-30, -50, 40, 12);
    try expectApproxEqAbs(@as(f64, 0), lower, 1e-12);
    try expectApproxEqAbs(@as(f64, -18.333333333333332), upper, 1e-12);
}

test "DynamicsCompressor time constants are sample-rate based" {
    try std.testing.expectEqual(
        @as(f64, 0),
        DynamicsCompressorNode.smoothingCoefficient(0, 44100),
    );
    const fast = DynamicsCompressorNode.smoothingCoefficient(0.003, 44100);
    const slow = DynamicsCompressorNode.smoothingCoefficient(0.25, 44100);
    try std.testing.expect(fast < slow);
    try std.testing.expect(fast > 0 and slow < 1);
}

test "AudioParam setValueAtTime applies time-zero automation and chains" {
    var param = AudioParam{
        ._value = 440,
        ._default_value = 440,
        ._min_value = -22050,
        ._max_value = 22050,
    };
    try std.testing.expect(param.setValueAtTime(10000, 0) == &param);
    try std.testing.expectEqual(@as(f64, 10000), param.getValue());
    _ = param.setValueAtTime(20000, 1);
    try std.testing.expectEqual(@as(f64, 10000), param.getValue());
}
