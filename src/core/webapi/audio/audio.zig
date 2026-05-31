// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

const std = @import("std");
const js = @import("../../js/js.zig");
const Frame = @import("../../browser/Frame.zig");
const EventTarget = @import("../EventTarget.zig");

pub fn registerTypes() []const type {
    return &.{
        AudioContext,
        OfflineAudioContext,
        AudioBuffer,
        AudioNode,
        AudioDestinationNode,
        AnalyserNode,
        OscillatorNode,
        DynamicsCompressorNode,
        BiquadFilterNode,
        GainNode,
    };
}

const AudioContextState = struct {
    sample_rate: f64,
};

const AudioNode = struct {
    _state: *AudioContextState,

    pub fn connect(self: *AudioNode, destination: *AudioNode) *AudioNode {
        _ = destination;
        return self;
    }

    pub fn disconnect(_: *AudioNode) void {}

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
            fn f(self: *AudioDestinationNode, d: *AudioNode) *AudioNode {
                return self._node.connect(d);
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

    pub fn getFftSize(self: *const AnalyserNode) u32 {
        return self._fft_size;
    }

    pub fn setFftSize(self: *AnalyserNode, size: u32) void {
        self._fft_size = size;
    }

    pub fn getFloatFrequencyData(_: *const AnalyserNode, _: js.TypedArray(f32)) void {}

    pub const JsApi = struct {
        pub const bridge = js.Bridge(AnalyserNode);
        pub const Meta = struct {
            pub const name = "AnalyserNode";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
        };
        pub const fftSize = bridge.accessor(AnalyserNode.getFftSize, AnalyserNode.setFftSize, .{});
        pub const getFloatFrequencyData = bridge.function(AnalyserNode.getFloatFrequencyData, .{});
        pub const connect = bridge.function(struct {
            fn f(self: *AnalyserNode, d: *AudioNode) *AudioNode {
                return self._node.connect(d);
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
    _frequency: f64 = 440,
    _type: []const u8 = "sine",

    pub fn getFrequency(self: *const OscillatorNode) f64 {
        return self._frequency;
    }

    pub fn setFrequency(self: *OscillatorNode, v: f64) void {
        self._frequency = v;
    }

    pub fn getType(self: *const OscillatorNode) []const u8 {
        return self._type;
    }

    pub fn setType(self: *OscillatorNode, v: []const u8) void {
        self._type = v;
    }

    pub fn start(self: *OscillatorNode, _: ?f64) void {
        _ = self;
    }

    pub fn stop(self: *OscillatorNode, _: ?f64) void {
        _ = self;
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(OscillatorNode);
        pub const Meta = struct {
            pub const name = "OscillatorNode";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
        };
        pub const frequency = bridge.accessor(OscillatorNode.getFrequency, OscillatorNode.setFrequency, .{});
        pub const @"type" = bridge.accessor(OscillatorNode.getType, OscillatorNode.setType, .{});
        pub const start = bridge.function(OscillatorNode.start, .{});
        pub const stop = bridge.function(OscillatorNode.stop, .{});
        pub const connect = bridge.function(struct {
            fn f(self: *OscillatorNode, d: *AudioNode) *AudioNode {
                return self._node.connect(d);
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

    pub const JsApi = struct {
        pub const bridge = js.Bridge(DynamicsCompressorNode);
        pub const Meta = struct {
            pub const name = "DynamicsCompressorNode";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
        };
        pub const connect = bridge.function(struct {
            fn f(self: *DynamicsCompressorNode, d: *AudioNode) *AudioNode {
                return self._node.connect(d);
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

    pub const JsApi = struct {
        pub const bridge = js.Bridge(BiquadFilterNode);
        pub const Meta = struct {
            pub const name = "BiquadFilterNode";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
        };
        pub const connect = bridge.function(struct {
            fn f(self: *BiquadFilterNode, d: *AudioNode) *AudioNode {
                return self._node.connect(d);
            }
        }.f, .{});
        pub const disconnect = bridge.function(struct {
            fn f(self: *BiquadFilterNode) void {
                self._node.disconnect();
            }
        }.f, .{});
    };
};

const GainNode = struct {
    _node: AudioNode,
    _gain: f64 = 1,

    pub fn getGain(self: *const GainNode) f64 {
        return self._gain;
    }

    pub fn setGain(self: *GainNode, v: f64) void {
        self._gain = v;
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(GainNode);
        pub const Meta = struct {
            pub const name = "GainNode";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
        };
        pub const gain = bridge.accessor(GainNode.getGain, GainNode.setGain, .{});
        pub const connect = bridge.function(struct {
            fn f(self: *GainNode, d: *AudioNode) *AudioNode {
                return self._node.connect(d);
            }
        }.f, .{});
        pub const disconnect = bridge.function(struct {
            fn f(self: *GainNode) void {
                self._node.disconnect();
            }
        }.f, .{});
    };
};

const AudioBuffer = struct {
    _channels: u32,
    _length: u32,
    _sample_rate: f64,

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
        const local = frame.js.local orelse return error.NotHandled;
        const arr = local.createTypedArray(.float32, self._length);
        fillChannelData(arr, channel, self._length);
        return .{ .local = local, .handle = arr.handle };
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
    };
};

fn fillChannelData(arr: js.ArrayBufferRef(.float32), channel: u32, length: u32) void {
    const v8 = js.v8;
    const view: *const v8.ArrayBufferView = @ptrCast(arr.handle);
    const byte_len = v8.v8__ArrayBufferView__ByteLength(view);
    const byte_offset = v8.v8__ArrayBufferView__ByteOffset(view);
    const array_buffer = v8.v8__ArrayBufferView__Buffer(view) orelse return;
    const backing_store_ptr = v8.v8__ArrayBuffer__GetBackingStore(array_buffer);
    const backing_store_handle = v8.std__shared_ptr__v8__BackingStore__get(&backing_store_ptr) orelse return;
    const data: [*]f32 = @ptrCast(@alignCast(v8.v8__BackingStore__Data(backing_store_handle)));
    const base = data + byte_offset / @sizeOf(f32);
    const n = @min(length, @as(u32, @intCast(byte_len / @sizeOf(f32))));
    var i: u32 = 0;
    while (i < n) : (i += 1) {
        const t = @as(f32, @floatFromInt(i)) / 44100.0;
        const ch = @as(f32, @floatFromInt(channel + 1));
        base[i] = @sin(t * 440.0 * std.math.pi * 2.0) * 0.5 * ch;
    }
}

pub const AudioContext = struct {
    _proto: *EventTarget,
    _state: *AudioContextState,
    _audio_state: []const u8 = "running",
    _current_time: f64 = 0,
    _destination: *AudioDestinationNode,

    pub fn constructor(_: ?js.Value, frame: *Frame) !*AudioContext {
        return initContext(frame, 44100);
    }

    fn initContext(frame: *Frame, sample_rate: f64) !*AudioContext {
        const state = try frame._factory.create(AudioContextState{ .sample_rate = sample_rate });
        const dest = try frame._factory.create(AudioDestinationNode{
            ._node = .{ ._state = state },
        });
        const self = try frame._factory.eventTarget(AudioContext{
            ._proto = undefined,
            ._state = state,
            ._destination = dest,
        });
        return self;
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

    pub fn createAnalyser(self: *AudioContext, frame: *Frame) !*AnalyserNode {
        return frame._factory.create(AnalyserNode{ ._node = .{ ._state = self.nodeState() } });
    }

    pub fn createOscillator(self: *AudioContext, frame: *Frame) !*OscillatorNode {
        return frame._factory.create(OscillatorNode{ ._node = .{ ._state = self.nodeState() } });
    }

    pub fn createDynamicsCompressor(self: *AudioContext, frame: *Frame) !*DynamicsCompressorNode {
        return frame._factory.create(DynamicsCompressorNode{ ._node = .{ ._state = self.nodeState() } });
    }

    pub fn createBiquadFilter(self: *AudioContext, frame: *Frame) !*BiquadFilterNode {
        return frame._factory.create(BiquadFilterNode{ ._node = .{ ._state = self.nodeState() } });
    }

    pub fn createGain(self: *AudioContext, frame: *Frame) !*GainNode {
        return frame._factory.create(GainNode{ ._node = .{ ._state = self.nodeState() } });
    }

    pub fn decodeAudioData(self: *AudioContext, _: js.ArrayBuffer, frame: *Frame) !js.Promise {
        const buf = try frame._factory.create(AudioBuffer{
            ._channels = 2,
            ._length = 44100,
            ._sample_rate = self._state.*.sample_rate,
        });
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

const OfflineAudioContext = struct {
    _ctx: *AudioContext,
    _length: u32,

    pub fn constructor(channels: u32, length: u32, sample_rate: f64, frame: *Frame) !*OfflineAudioContext {
        _ = channels;
        const ctx = try AudioContext.initContext(frame, sample_rate);
        return frame._factory.create(OfflineAudioContext{
            ._ctx = ctx,
            ._length = length,
        });
    }

    pub fn getLength(self: *const OfflineAudioContext) u32 {
        return self._length;
    }

    pub fn startRendering(self: *OfflineAudioContext, frame: *Frame) !js.Promise {
        const buf = try frame._factory.create(AudioBuffer{
            ._channels = 2,
            ._length = self._length,
            ._sample_rate = self._ctx.getSampleRate(),
        });
        return frame.js.local.?.resolvePromise(buf);
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
        pub const startRendering = bridge.function(OfflineAudioContext.startRendering, .{});
    };
};
