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
};

const RenderSource = union(enum) {
    none,
    oscillator: *OscillatorNode,
    gain: *GainNode,
    analyser: *AnalyserNode,
    compressor: *DynamicsCompressorNode,
};

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
            value.* = if (sample <= 0.000001) -std.math.inf(f32) else 20.0 * std.math.log10(sample);
        }
    }

    pub fn getFloatTimeDomainData(self: *const AnalyserNode, arr: js.TypedArray(f32)) void {
        const values = @constCast(arr.values);
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

    pub fn setType(self: *OscillatorNode, v: []const u8) void {
        self._type = v;
    }

    pub fn start(self: *OscillatorNode, when: ?f64) void {
        log.info(.js, "OscillatorNode.start", .{ .when = when orelse 0, .type = self._type, .frequency = self._frequency.getValue() });
        self._start_time = when orelse 0;
        self._started = true;
    }

    pub fn stop(self: *OscillatorNode, when: ?f64) void {
        self._stop_time = when;
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
            const sample = @as(f32, @floatCast(@sin(omega * t)));
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
    _reduction: f64 = -20.538288116455078,
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

    fn render(self: *DynamicsCompressorNode, output: *AudioRenderData, sample_rate: f64) void {
        _ = sample_rate;
        log.info(.js, "DynamicsCompressorNode.render.begin", .{ .threshold = self._threshold.getValue(), .ratio = self._ratio.getValue(), .attack = self._attack.getValue(), .has_input = self._node._input != null });
        self._node.renderInput(output, self._node._state.sample_rate);
        const threshold = @as(f32, @floatCast(@abs(self._threshold.getValue()) / 100.0));
        const ratio = @as(f32, @floatCast(self._ratio.getValue() / 20.0));
        const attack = @as(f32, @floatCast(self._attack.getValue()));
        log.info(.js, "DynamicsCompressorNode.render.input_processed", .{ .threshold_raw = self._threshold.getValue(), .threshold_scaled = threshold, .ratio_raw = self._ratio.getValue(), .ratio_scaled = ratio });
        for (output.left, output.right) |*left, *right| {
            const left_abs = @abs(left.*);
            const right_abs = @abs(right.*);
            if (left_abs > threshold) {
                left.* *= 1.0 - @min(@as(f32, 0.85), ratio * 0.25 + attack * 0.1);
            }
            if (right_abs > threshold) {
                right.* *= 1.0 - @min(@as(f32, 0.85), ratio * 0.25 + attack * 0.1);
            }
        }
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

    fn create(channels: u32, length: u32, sample_rate: f64, frame: *Frame) !*AudioBuffer {
        const total_len = @as(usize, channels) * @as(usize, length);
        const data = try frame.arena.alloc(f32, total_len);
        @memset(data, 0);
        return frame._factory.create(AudioBuffer{
            ._channels = channels,
            ._length = length,
            ._sample_rate = sample_rate,
            ._data = data,
        });
    }

    fn channelSlice(self: *const AudioBuffer, channel: u32) []f32 {
        const start = @as(usize, channel) * @as(usize, self._length);
        const end = start + @as(usize, self._length);
        return self._data[start..end];
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

    pub fn getChannelData(self: *const AudioBuffer, channel: u32, frame: *Frame) !js.Value {
        if (channel >= self._channels) return error.IndexSizeError;
        const slice = self.channelSlice(channel);
        const sample_0 = if (slice.len > 0) slice[0] else 0;
        const sample_100 = if (slice.len > 100) slice[100] else 0;
        log.info(.js, "AudioBuffer.getChannelData", .{ .channel = channel, .channels = self._channels, .length = self._length, .first_sample = sample_0, .sample_100 = sample_100 });
        const local = frame.js.local orelse return error.NotHandled;
        const arr = local.createTypedArray(.float32, self._length);
        const values = typedArrayData(f32, arr.handle) orelse return error.NotHandled;
        @memcpy(values[0..self._length], self.channelSlice(channel));
        const values_100 = if (self._length > 100) values[100] else 0;
        log.info(.js, "AudioBuffer.getChannelData.done", .{ .values_first = values[0], .values_100 = values_100 });
        return .{ .local = local, .handle = arr.handle };
    }

    pub fn copyFromChannel(self: *const AudioBuffer, destination: js.TypedArray(f32), channel: u32, buffer_offset_: ?u32) !void {
        if (channel >= self._channels) return error.IndexSizeError;
        const buffer_offset = buffer_offset_ orelse 0;
        if (buffer_offset > self._length) return error.IndexSizeError;
        const source = self.channelSlice(channel);
        const dst = @constCast(destination.values);
        const available = source[@as(usize, buffer_offset)..];
        const count = @min(dst.len, available.len);
        if (count > 0) {
            @memcpy(dst[0..count], available[0..count]);
        }
        if (dst.len > count) {
            @memset(dst[count..], 0);
        }
    }

    pub fn copyToChannel(self: *AudioBuffer, source: js.TypedArray(f32), channel: u32, buffer_offset_: ?u32) !void {
        if (channel >= self._channels) return error.IndexSizeError;
        const buffer_offset = buffer_offset_ orelse 0;
        if (buffer_offset > self._length) return error.IndexSizeError;
        const destination = self.channelSlice(channel);
        const available = destination[@as(usize, buffer_offset)..];
        const count = @min(source.values.len, available.len);
        if (count > 0) {
            @memcpy(available[0..count], source.values[0..count]);
        }
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(AudioBuffer);
        pub const Meta = struct {
            pub const name = "AudioBuffer";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
        };
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
        return initContext(frame, 44100);
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

    fn renderOffline(self: *AudioContext, frame: *Frame, length: u32) !*AudioBuffer {
        log.info(.js, "AudioContext.renderOffline.begin", .{ .length = length, .sample_rate = self.getSampleRate() });

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

        const buffer = try AudioBuffer.create(2, length, self._state.sample_rate, frame);

        log.info(.js, "AudioContext.renderOffline.buffer_created", .{ .channels = 2, .length = length, .sample_rate = self._state.sample_rate });

        @memcpy(buffer.channelSlice(0), render_data.left[0..@as(usize, length)]);
        @memcpy(buffer.channelSlice(1), render_data.right[0..@as(usize, length)]);

        const buf_sample_100 = if (length > 100) buffer.channelSlice(0)[100] else 0;
        log.info(.js, "AudioContext.renderOffline.done", .{ .channel_0_first = buffer.channelSlice(0)[0], .channel_0_sample_100 = buf_sample_100, .channel_1_first = buffer.channelSlice(1)[0] });

        return buffer;
    }

    pub fn createAnalyser(self: *AudioContext, frame: *Frame) !*AnalyserNode {
        const node = try frame._factory.create(AnalyserNode{ ._node = .{ ._state = self.nodeState(), ._source = .none, ._outputs = .empty, ._input = null }, ._render_data = self._last_render_data });
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

pub const OfflineAudioContext = struct {
    _proto: *EventTarget,
    _ctx: *AudioContext,
    _length: u32,
    _on_complete: ?js.Function.Temp = null,
    _last_complete_event: ?*Event = null,

    pub fn constructor(channels: u32, length: u32, sample_rate: f64, frame: *Frame) !*OfflineAudioContext {
        log.info(.js, "OfflineAudioContext.constructor", .{ .channels = channels, .length = length, .sample_rate = sample_rate });
        const state = try frame._factory.create(AudioContextState{ .sample_rate = sample_rate, .owner = null });
        const destination = try AudioContext.createDestination(state, frame);
        const listener = try AudioContext.createListener(frame);
        const inner_ctx = try AudioContext.initWithState(state, destination, listener, frame);
        state.owner = inner_ctx;
        const ctx = try frame._factory.eventTarget(OfflineAudioContext{
            ._proto = undefined,
            ._ctx = inner_ctx,
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

        const TaskData = struct {
            ctx: *OfflineAudioContext,
            frame: *Frame,
            global_resolver: js.PromiseResolver.Global,
        };

        const data = try frame.arena.create(TaskData);
        data.* = .{
            .ctx = self,
            .frame = frame,
            .global_resolver = global_resolver,
        };

        try frame.js.scheduler.add(data, struct {
            fn run(ctx: *anyopaque) !?u32 {
                const d: *TaskData = @ptrCast(@alignCast(ctx));
                var ls: js.Local.Scope = undefined;
                d.frame.js.localScope(&ls);

                const buf = d.ctx._ctx.renderOffline(d.frame, d.ctx._length) catch |err| {
                    log.err(.js, "OfflineAudioContext.startRendering.error", .{ .err = err });
                    const error_msg = ls.local.newString("Failed to render audio");
                    _ = ls.local.toLocal(d.global_resolver).reject("OfflineAudioContext.startRendering", error_msg);
                    return null;
                };

                d.ctx.dispatchCompleteEvent(buf, d.frame) catch |err| {
                    log.err(.js, "OfflineAudioContext.dispatchCompleteEvent.error", .{ .err = err });
                };

                log.info(.js, "OfflineAudioContext.complete_event.dispatch", .{});
                _ = ls.local.toLocal(d.global_resolver).resolve("OfflineAudioContext.startRendering", buf);

                return null;
            }
        }.run, 0, .{ .name = "OfflineAudioContext.startRendering" });

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
