// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

const js = @import("../js/js.zig");
const Frame = @import("../browser/Frame.zig");
const EventTarget = @import("EventTarget.zig");
const Event = @import("Event.zig");
const std = @import("std");

pub fn registerTypes() []const type {
    return &.{
        RTCPeerConnectionJs,
        RTCDataChannelJs,
        RTCSessionDescription,
        RTCIceCandidate,
    };
}

pub const RTCSessionDescription = struct {
    _type: []const u8 = "offer",
    _sdp: []const u8 = "",

    pub fn getType(self: *const RTCSessionDescription) []const u8 {
        return self._type;
    }

    pub fn getSdp(self: *const RTCSessionDescription) []const u8 {
        return self._sdp;
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(RTCSessionDescription);
        pub const Meta = struct {
            pub const name = "RTCSessionDescription";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
            pub const empty_with_no_proto = true;
        };
        pub const @"type" = bridge.accessor(RTCSessionDescription.getType, null, .{});
        pub const sdp = bridge.accessor(RTCSessionDescription.getSdp, null, .{});
    };
};

pub const RTCIceCandidate = struct {
    _candidate: []const u8 = "",
    _sdpMid: ?[]const u8 = null,
    _sdpMLineIndex: ?u16 = null,

    pub fn getCandidate(self: *const RTCIceCandidate) []const u8 {
        return self._candidate;
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(RTCIceCandidate);
        pub const Meta = struct {
            pub const name = "RTCIceCandidate";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
            pub const empty_with_no_proto = true;
        };
        pub const candidate = bridge.accessor(RTCIceCandidate.getCandidate, null, .{});
    };
};

pub const RTCDataChannelJs = struct {
    _proto: *EventTarget,
    _label: []const u8,
    _ready_state: []const u8 = "connecting",

    pub fn getLabel(self: *const RTCDataChannelJs) []const u8 {
        return self._label;
    }

    pub fn getReadyState(self: *const RTCDataChannelJs) []const u8 {
        return self._ready_state;
    }

    pub fn send(self: *RTCDataChannelJs, _: js.Value) void {
        _ = self;
    }

    pub fn close(self: *RTCDataChannelJs) void {
        self._ready_state = "closed";
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(RTCDataChannelJs);
        pub const Meta = struct {
            pub const name = "RTCDataChannel";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
        };
        pub const label = bridge.accessor(RTCDataChannelJs.getLabel, null, .{});
        pub const readyState = bridge.accessor(RTCDataChannelJs.getReadyState, null, .{});
        pub const send = bridge.function(RTCDataChannelJs.send, .{});
        pub const close = bridge.function(RTCDataChannelJs.close, .{});
    };
};

pub const RTCPeerConnectionJs = struct {
    _proto: *EventTarget,
    _local_description: ?*RTCSessionDescription = null,
    _remote_description: ?*RTCSessionDescription = null,
    _signaling_state: []const u8 = "stable",
    _ice_connection_state: []const u8 = "new",
    _connection_state: []const u8 = "new",
    _on_ice_candidate: ?js.Function.Global = null,

    pub fn constructor(_: ?js.Value, frame: *Frame) !*RTCPeerConnectionJs {
        return frame._factory.eventTarget(RTCPeerConnectionJs{
            ._proto = undefined,
        });
    }

    pub fn createOffer(self: *RTCPeerConnectionJs, frame: *Frame) !js.Promise {
        const local = frame.js.local orelse return error.NotHandled;
        const desc = try frame._factory.create(RTCSessionDescription{
            ._type = "offer",
            ._sdp =
            \\v=0\r\n
            \\o=- 461743111479067411 2 IN IP4 192.168.1.100\r\n
            \\s=-\r\n
            \\t=0 0\r\n
            \\a=ice-options:trickle\r\n
            \\a=ice-ufrag:bk84\r\n
            \\a=ice-pwd:abcdef1234567890abcdef1234567890\r\n
            \\m=audio 56518 RTP/SAVPF 0\r\n
            \\c=IN IP4 192.168.1.100\r\n
            \\a=rtcp:56518 IN IP4 192.168.1.100\r\n
            \\a=ice-ufrag:bk84\r\n
            \\a=ice-pwd:abcdef1234567890abcdef1234567890\r\n
            \\a=ice-candidates:bk84\r\n
            \\a=fmtp:0\r\n
            ,
        });
        self._local_description = desc;
        self._signaling_state = "have-local-offer";
        return local.resolvePromise(desc);
    }

    pub fn createAnswer(self: *RTCPeerConnectionJs, frame: *Frame) !js.Promise {
        const local = frame.js.local orelse return error.NotHandled;
        const desc = try frame._factory.create(RTCSessionDescription{
            ._type = "answer",
            ._sdp =
            \\v=0\r\n
            \\o=- 461743111479067411 2 IN IP4 192.168.1.100\r\n
            \\s=-\r\n
            \\t=0 0\r\n
            \\a=ice-options:trickle\r\n
            \\a=ice-ufrag:bk84\r\n
            \\a=ice-pwd:abcdef1234567890abcdef1234567890\r\n
            \\m=audio 56518 RTP/SAVPF 0\r\n
            \\c=IN IP4 192.168.1.100\r\n
            \\a=rtcp:56518 IN IP4 192.168.1.100\r\n
            \\a=ice-ufrag:bk84\r\n
            \\a=ice-pwd:abcdef1234567890abcdef1234567890\r\n
            \\a=ice-candidates:bk84\r\n
            \\a=fmtp:0\r\n
            ,
        });
        self._local_description = desc;
        return local.resolvePromise(desc);
    }

    pub fn setLocalDescription(self: *RTCPeerConnectionJs, desc: *RTCSessionDescription, frame: *Frame) !js.Promise {
        self._local_description = desc;
        self._signaling_state = if (self._signaling_state[0] == 's') "have-local-offer" else self._signaling_state;
        // CreepJS reads IP from localDescription.sdp via regex `c=IN IP4 (\S+)`.
        return frame.js.local.?.resolvePromise(js.Undefined{});
    }

    pub fn setRemoteDescription(self: *RTCPeerConnectionJs, desc: *RTCSessionDescription, frame: *Frame) !js.Promise {
        self._remote_description = desc;
        const local = frame.js.local orelse return error.NotHandled;
        return local.resolvePromise(js.Undefined{});
    }

    pub fn addIceCandidate(self: *RTCPeerConnectionJs, _: js.Value, frame: *Frame) !js.Promise {
        _ = self;
        const local = frame.js.local orelse return error.NotHandled;
        return local.resolvePromise(js.Undefined{});
    }

    pub fn createDataChannel(_: *RTCPeerConnectionJs, label: []const u8, frame: *Frame) !*RTCDataChannelJs {
        return frame._factory.eventTarget(RTCDataChannelJs{
            ._proto = undefined,
            ._label = label,
        });
    }

    pub fn close(self: *RTCPeerConnectionJs) void {
        self._signaling_state = "closed";
        self._ice_connection_state = "closed";
        self._connection_state = "closed";
    }

    pub fn getLocalDescription(self: *const RTCPeerConnectionJs) ?*RTCSessionDescription {
        return self._local_description;
    }

    pub fn getRemoteDescription(self: *const RTCPeerConnectionJs) ?*RTCSessionDescription {
        return self._remote_description;
    }

    pub fn getSignalingState(self: *const RTCPeerConnectionJs) []const u8 {
        return self._signaling_state;
    }

    pub fn getIceConnectionState(self: *const RTCPeerConnectionJs) []const u8 {
        return self._ice_connection_state;
    }

    pub fn getConnectionState(self: *const RTCPeerConnectionJs) []const u8 {
        return self._connection_state;
    }

    pub fn setOnIceCandidate(self: *RTCPeerConnectionJs, cb: ?js.Function.Global) void {
        self._on_ice_candidate = cb;
    }

    pub fn getOnIceCandidate(self: *RTCPeerConnectionJs) ?js.Function.Global {
        return self._on_ice_candidate;
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(RTCPeerConnectionJs);
        pub const Meta = struct {
            pub const name = "RTCPeerConnection";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
        };
        pub const constructor = bridge.constructor(RTCPeerConnectionJs.constructor, .{});
        pub const createOffer = bridge.function(RTCPeerConnectionJs.createOffer, .{});
        pub const createAnswer = bridge.function(RTCPeerConnectionJs.createAnswer, .{});
        pub const setLocalDescription = bridge.function(RTCPeerConnectionJs.setLocalDescription, .{});
        pub const setRemoteDescription = bridge.function(RTCPeerConnectionJs.setRemoteDescription, .{});
        pub const addIceCandidate = bridge.function(RTCPeerConnectionJs.addIceCandidate, .{});
        pub const createDataChannel = bridge.function(RTCPeerConnectionJs.createDataChannel, .{});
        pub const close = bridge.function(RTCPeerConnectionJs.close, .{});
        pub const localDescription = bridge.accessor(RTCPeerConnectionJs.getLocalDescription, null, .{ .null_as_undefined = true });
        pub const remoteDescription = bridge.accessor(RTCPeerConnectionJs.getRemoteDescription, null, .{ .null_as_undefined = true });
        pub const signalingState = bridge.accessor(RTCPeerConnectionJs.getSignalingState, null, .{});
        pub const iceConnectionState = bridge.accessor(RTCPeerConnectionJs.getIceConnectionState, null, .{});
        pub const connectionState = bridge.accessor(RTCPeerConnectionJs.getConnectionState, null, .{});
        pub const onicecandidate = bridge.accessor(RTCPeerConnectionJs.getOnIceCandidate, RTCPeerConnectionJs.setOnIceCandidate, .{});
    };
};
