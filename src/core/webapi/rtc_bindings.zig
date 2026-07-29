// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

const js = @import("../js/js.zig");
const Frame = @import("../browser/Frame.zig");
const EventTarget = @import("EventTarget.zig");
const Event = @import("Event.zig");
const MessageEvent = @import("event/MessageEvent.zig");
const String = @import("../../support/string.zig").String;
const RTCPeerConnectionNative = @import("net/rtc/RTCPeerConnection.zig");
const RTCDataChannelNative = @import("net/rtc/RTCDataChannel.zig");
const std = @import("std");

pub fn registerTypes() []const type {
    return &.{
        RTCPeerConnectionJs,
        RTCDataChannelJs,
        RTCSessionDescription,
        RTCIceCandidate,
        RTCPeerConnectionIceEvent,
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
        };
        pub const @"type" = bridge.accessor(RTCSessionDescription.getType, null, .{});
        pub const sdp = bridge.accessor(RTCSessionDescription.getSdp, null, .{});
    };
};

pub const RTCIceCandidate = struct {
    _candidate: []const u8 = "",
    _sdp_mid: ?[]const u8 = null,
    _sdp_mline_index: ?u16 = null,
    _foundation: []const u8 = "",
    _type: []const u8 = "",
    _address: []const u8 = "",
    _port: u16 = 0,
    _protocol: []const u8 = "udp",

    pub fn getCandidate(self: *const RTCIceCandidate) []const u8 {
        return self._candidate;
    }

    pub fn getSdpMid(self: *const RTCIceCandidate) ?[]const u8 {
        return self._sdp_mid;
    }

    pub fn getSdpMLineIndex(self: *const RTCIceCandidate) ?u16 {
        return self._sdp_mline_index;
    }

    pub fn getFoundation(self: *const RTCIceCandidate) []const u8 {
        return self._foundation;
    }

    pub fn getTyp(self: *const RTCIceCandidate) []const u8 {
        return self._type;
    }

    pub fn getAddress(self: *const RTCIceCandidate) []const u8 {
        return self._address;
    }

    pub fn getPort(self: *const RTCIceCandidate) u16 {
        return self._port;
    }

    pub fn getProtocol(self: *const RTCIceCandidate) []const u8 {
        return self._protocol;
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(RTCIceCandidate);
        pub const Meta = struct {
            pub const name = "RTCIceCandidate";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
        };
        pub const candidate = bridge.accessor(RTCIceCandidate.getCandidate, null, .{});
        pub const sdpMid = bridge.accessor(RTCIceCandidate.getSdpMid, null, .{ .null_as_undefined = true });
        pub const sdpMLineIndex = bridge.accessor(RTCIceCandidate.getSdpMLineIndex, null, .{ .null_as_undefined = true });
        pub const foundation = bridge.accessor(RTCIceCandidate.getFoundation, null, .{});
        pub const @"type" = bridge.accessor(RTCIceCandidate.getTyp, null, .{});
        pub const address = bridge.accessor(RTCIceCandidate.getAddress, null, .{});
        pub const port = bridge.accessor(RTCIceCandidate.getPort, null, .{});
        pub const protocol = bridge.accessor(RTCIceCandidate.getProtocol, null, .{});
    };
};

pub const RTCPeerConnectionIceEvent = struct {
    _proto: *Event,
    _candidate: ?*RTCIceCandidate = null,

    const IceEventOptions = struct {
        candidate: ?*RTCIceCandidate = null,
    };

    const Options = Event.inheritOptions(RTCPeerConnectionIceEvent, IceEventOptions);

    pub fn initTrusted(typ: String, opts_: ?Options, frame: *Frame) !*RTCPeerConnectionIceEvent {
        const arena = try frame.getArena(.tiny, "RTCPeerConnectionIceEvent.trusted");
        errdefer frame.releaseArena(arena);
        const opts = opts_ orelse Options{};
        const event = try frame._factory.event(
            arena,
            typ,
            RTCPeerConnectionIceEvent{
                ._proto = undefined,
                ._candidate = opts.candidate,
            },
        );
        Event.populatePrototypes(event, opts, true);
        return event;
    }

    pub fn asEvent(self: *RTCPeerConnectionIceEvent) *Event {
        return self._proto;
    }

    pub fn getCandidate(self: *const RTCPeerConnectionIceEvent) ?*RTCIceCandidate {
        return self._candidate;
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(RTCPeerConnectionIceEvent);
        pub const Meta = struct {
            pub const name = "RTCPeerConnectionIceEvent";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
        };
        pub const candidate = bridge.accessor(RTCPeerConnectionIceEvent.getCandidate, null, .{ .null_as_undefined = true });
    };
};

pub const RTCDataChannelJs = struct {
    _proto: *EventTarget,
    _frame: *Frame,
    _native: *RTCDataChannelNative,

    pub fn getLabel(self: *const RTCDataChannelJs) []const u8 {
        return self._native.label;
    }

    pub fn getReadyState(self: *const RTCDataChannelJs) []const u8 {
        return switch (self._native.ready_state) {
            .connecting => "connecting",
            .open => "open",
            .closing => "closing",
            .closed => "closed",
        };
    }

    pub fn send(self: *RTCDataChannelJs, data: js.Value) void {
        if (data.isString()) |s| {
            const text = s.toSlice() catch return;
            self._native.sendText(text) catch return;
            return;
        }
        if (data.isArrayBuffer() or data.isArrayBufferView()) {
            const bytes = extractBytes(data) catch return;
            self._native.sendBinary(bytes) catch return;
        }
    }

    pub fn close(self: *RTCDataChannelJs) void {
        self._native.close();
    }

    fn extractBytes(data: js.Value) ![]const u8 {
        if (data.isArrayBuffer()) {
            const ab: js.ArrayBuffer = try data.toZig(js.ArrayBuffer);
            return ab.values;
        }
        const BinaryData = union(enum) {
            uint8: []u8,
            int8: []i8,
        };
        const binary = try data.toZig(BinaryData);
        return switch (binary) {
            .uint8 => |b| b,
            .int8 => |b| @as([*]u8, @ptrCast(b.ptr))[0..b.len],
        };
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
    _frame: *Frame,
    _native: *RTCPeerConnectionNative,
    _sdp_buf: std.ArrayList(u8),
    _local_description: ?*RTCSessionDescription = null,
    _remote_description: ?*RTCSessionDescription = null,
    _on_ice_candidate: ?js.Function.Global = null,
    _on_ice_gathering_state_change: ?js.Function.Global = null,
    _on_ice_connection_state_change: ?js.Function.Global = null,
    _on_connection_state_change: ?js.Function.Global = null,
    _on_signaling_state_change: ?js.Function.Global = null,
    _on_data_channel: ?js.Function.Global = null,
    _channels: std.AutoHashMap(u32, *RTCDataChannelJs),
    _destroyed: bool = false,

    pub fn constructor(config: ?js.Value, frame: *Frame) !*RTCPeerConnectionJs {
        var native_config = try parseConfig(frame.arena, config);
        // RTCPeerConnection is part of the browser network context. An HTTP
        // proxy cannot relay its UDP/STUN traffic, therefore direct candidate
        // gathering must be disabled rather than bypassing that context.
        native_config.allow_non_proxied_udp =
            frame._session.browser.http_client.currentProxy() == null;
        const native = try RTCPeerConnectionNative.create(frame.arena, native_config);

        const self = try frame._factory.eventTarget(RTCPeerConnectionJs{
            ._proto = undefined,
            ._frame = frame,
            ._native = native,
            ._sdp_buf = .empty,
            ._channels = std.AutoHashMap(u32, *RTCDataChannelJs).init(frame.arena),
        });

        native.handlers = .{
            .ctx = self,
            .on_ice_candidate = onNativeIceCandidate,
            .on_ice_gathering_complete = onNativeIceGatheringComplete,
            .on_ice_connection_state_change = onNativeIceConnectionStateChange,
            .on_connection_state_change = onNativeConnectionStateChange,
            .on_signaling_state_change = onNativeSignalingStateChange,
            .on_data_channel = onNativeDataChannel,
        };

        try frame.registerRtcPeerConnection(self);
        frame._session.browser.http_client.trackRtcPeerConnection();
        return self;
    }

    pub fn createOffer(self: *RTCPeerConnectionJs, options: ?js.Value, frame: *Frame) !js.Promise {
        const local = frame.js.local orelse return error.NotHandled;
        const opts = parseOfferOptions(options);
        self._native.setOfferOptions(opts);

        self._sdp_buf.clearRetainingCapacity();
        const sdp = try self._native.createOffer(&self._sdp_buf);

        const desc = try frame._factory.create(RTCSessionDescription{
            ._type = "offer",
            ._sdp = try frame.arena.dupe(u8, sdp),
        });
        self._local_description = desc;
        return local.resolvePromise(desc);
    }

    pub fn createAnswer(self: *RTCPeerConnectionJs, _: ?js.Value, frame: *Frame) !js.Promise {
        const local = frame.js.local orelse return error.NotHandled;
        self._sdp_buf.clearRetainingCapacity();
        const sdp = try self._native.createAnswer(&self._sdp_buf);

        const desc = try frame._factory.create(RTCSessionDescription{
            ._type = "answer",
            ._sdp = try frame.arena.dupe(u8, sdp),
        });
        self._local_description = desc;
        return local.resolvePromise(desc);
    }

    pub fn setLocalDescription(self: *RTCPeerConnectionJs, desc: *RTCSessionDescription, frame: *Frame) !js.Promise {
        self._local_description = desc;
        try self._native.setLocalDescription(desc._sdp);
        return frame.js.local.?.resolvePromise(js.Undefined{});
    }

    pub fn setRemoteDescription(self: *RTCPeerConnectionJs, desc: *RTCSessionDescription, frame: *Frame) !js.Promise {
        self._remote_description = desc;
        try self._native.setRemoteDescription(desc._sdp);
        return frame.js.local.?.resolvePromise(js.Undefined{});
    }

    pub fn addIceCandidate(self: *RTCPeerConnectionJs, candidate: js.Value, frame: *Frame) !js.Promise {
        const local = frame.js.local orelse return error.NotHandled;
        if (!candidate.isNull() and !candidate.isUndefined()) {
            const obj = candidate.toObject();
            if (obj.get("candidate")) |cand_str| {
                if (cand_str.isString()) |s| {
                    const text = try s.toSliceWithAlloc(frame.arena);
                    if (text.len > 0) try self._native.addIceCandidate(text);
                }
            } else |_| {}
        }
        return local.resolvePromise(js.Undefined{});
    }

    pub fn createDataChannel(self: *RTCPeerConnectionJs, label: []const u8, frame: *Frame) !*RTCDataChannelJs {
        const native_ch = try self._native.createDataChannel(label, .{});
        const js_ch = try wrapDataChannel(self, native_ch, frame);
        try self._channels.put(native_ch.js_channel_id, js_ch);
        return js_ch;
    }

    pub fn close(self: *RTCPeerConnectionJs) void {
        self.teardown();
    }

    pub fn destroy(self: *RTCPeerConnectionJs) void {
        self.teardown();
    }

    fn teardown(self: *RTCPeerConnectionJs) void {
        if (self._destroyed) return;
        self._destroyed = true;
        self._native.destroy();
        self._frame.unregisterRtcPeerConnection(self);
        self._frame._session.browser.http_client.untrackRtcPeerConnection();
    }

    pub fn drainEvents(self: *RTCPeerConnectionJs) void {
        if (self._destroyed) return;
        self._native.drainEvents();
    }

    pub fn getLocalDescription(self: *const RTCPeerConnectionJs) ?*RTCSessionDescription {
        return self._local_description;
    }

    pub fn getRemoteDescription(self: *const RTCPeerConnectionJs) ?*RTCSessionDescription {
        return self._remote_description;
    }

    pub fn getSignalingState(self: *const RTCPeerConnectionJs) []const u8 {
        return signalingStateStr(self._native.signaling_state);
    }

    pub fn getIceConnectionState(self: *const RTCPeerConnectionJs) []const u8 {
        return iceConnectionStateStr(self._native.ice_connection_state);
    }

    pub fn getConnectionState(self: *const RTCPeerConnectionJs) []const u8 {
        return connectionStateStr(self._native.connection_state);
    }

    pub fn getIceGatheringState(self: *const RTCPeerConnectionJs) []const u8 {
        return iceGatheringStateStr(self._native.ice_gathering_state);
    }

    pub fn setOnIceCandidate(self: *RTCPeerConnectionJs, cb: ?js.Function.Global) void {
        self._on_ice_candidate = cb;
    }

    pub fn getOnIceCandidate(self: *RTCPeerConnectionJs) ?js.Function.Global {
        return self._on_ice_candidate;
    }

    pub fn setOnIceGatheringStateChange(self: *RTCPeerConnectionJs, cb: ?js.Function.Global) void {
        self._on_ice_gathering_state_change = cb;
    }

    pub fn getOnIceGatheringStateChange(self: *RTCPeerConnectionJs) ?js.Function.Global {
        return self._on_ice_gathering_state_change;
    }

    fn wrapDataChannel(pc: *RTCPeerConnectionJs, native_ch: *RTCDataChannelNative, frame: *Frame) !*RTCDataChannelJs {
        const js_ch = try frame._factory.eventTarget(RTCDataChannelJs{
            ._proto = undefined,
            ._frame = frame,
            ._native = native_ch,
        });
        _ = native_ch.ref();
        native_ch.handlers = .{
            .ctx = js_ch,
            .on_open = onDataChannelOpen,
            .on_message = onDataChannelMessage,
            .on_close = onDataChannelClose,
        };
        _ = pc;
        return js_ch;
    }

    fn dispatchIceCandidate(self: *RTCPeerConnectionJs, candidate_line: []const u8, sdp_mid: []const u8) !void {
        const frame = self._frame;
        const cand = try makeIceCandidate(frame, candidate_line, sdp_mid);
        const event = try RTCPeerConnectionIceEvent.initTrusted(comptime .wrap("icecandidate"), .{
            .candidate = cand,
        }, frame);
        const target = self._proto;
        try frame._event_manager.dispatchDirect(target, event.asEvent(), self._on_ice_candidate, .{ .context = "RTCPeerConnection icecandidate" });
        patchLocalSdpWithCandidate(self, candidate_line, cand.getAddress()) catch {};
    }

    fn patchLocalSdpWithCandidate(self: *RTCPeerConnectionJs, candidate_line: []const u8, address: []const u8) !void {
        const desc = self._local_description orelse return;
        if (address.len == 0) return;

        const old = desc._sdp;
        var out: std.ArrayList(u8) = .empty;
        errdefer out.deinit(self._frame.arena);

        const conn_marker = "c=IN IP4 0.0.0.0";
        const replacement = try std.fmt.allocPrint(self._frame.arena, "c=IN IP4 {s}", .{address});
        var cursor: usize = 0;
        while (cursor < old.len) {
            const tail = old[cursor..];
            if (std.mem.indexOf(u8, tail, conn_marker)) |rel| {
                const pos = cursor + rel;
                try out.appendSlice(self._frame.arena, old[cursor..pos]);
                try out.appendSlice(self._frame.arena, replacement);
                cursor = pos + conn_marker.len;
            } else {
                try out.appendSlice(self._frame.arena, tail);
                break;
            }
        }
        if (out.items.len == 0) try out.appendSlice(self._frame.arena, old);

        var line = std.mem.trim(u8, candidate_line, " \t\r\n");
        if (std.mem.startsWith(u8, line, "a=")) line = line[2..];
        line = std.mem.trim(u8, line, " \t\r\n");
        const cand_attr = if (std.mem.startsWith(u8, line, "candidate:"))
            try std.fmt.allocPrint(self._frame.arena, "\r\na={s}", .{line})
        else
            try std.fmt.allocPrint(self._frame.arena, "\r\na=candidate:{s}", .{line});
        try out.appendSlice(self._frame.arena, cand_attr);

        desc._sdp = try out.toOwnedSlice(self._frame.arena);
    }

    fn dispatchGatheringComplete(self: *RTCPeerConnectionJs) !void {
        const frame = self._frame;
        const event = try RTCPeerConnectionIceEvent.initTrusted(comptime .wrap("icecandidate"), .{
            .candidate = null,
        }, frame);
        try frame._event_manager.dispatchDirect(self._proto, event.asEvent(), self._on_ice_candidate, .{ .context = "RTCPeerConnection icecandidate end" });
        const state_event = try Event.initTrusted(String.wrap("icegatheringstatechange"), .{}, frame._page);
        try frame._event_manager.dispatchDirect(self._proto, state_event, self._on_ice_gathering_state_change, .{ .context = "rtc gather" });
    }

    fn dispatchStateEvent(self: *RTCPeerConnectionJs, name: []const u8, handler: ?js.Function.Global) !void {
        const event = try Event.initTrusted(String.wrap(name), .{}, self._frame._page);
        try self._frame._event_manager.dispatchDirect(self._proto, event, handler, .{ .context = "rtc state" });
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
        pub const iceGatheringState = bridge.accessor(RTCPeerConnectionJs.getIceGatheringState, null, .{});
        pub const onicecandidate = bridge.accessor(RTCPeerConnectionJs.getOnIceCandidate, RTCPeerConnectionJs.setOnIceCandidate, .{});
        pub const onicegatheringstatechange = bridge.accessor(RTCPeerConnectionJs.getOnIceGatheringStateChange, RTCPeerConnectionJs.setOnIceGatheringStateChange, .{});
    };
};

fn onNativeIceCandidate(ctx: ?*anyopaque, candidate_line: []const u8, sdp_mid: []const u8) void {
    const self: *RTCPeerConnectionJs = @ptrCast(@alignCast(ctx.?));
    self.dispatchIceCandidate(candidate_line, sdp_mid) catch {};
}

fn onNativeIceGatheringComplete(ctx: ?*anyopaque) void {
    const self: *RTCPeerConnectionJs = @ptrCast(@alignCast(ctx.?));
    self.dispatchGatheringComplete() catch {};
}

fn onNativeIceConnectionStateChange(ctx: ?*anyopaque, state: RTCPeerConnectionNative.IceConnectionState) void {
    const self: *RTCPeerConnectionJs = @ptrCast(@alignCast(ctx.?));
    _ = state;
    self.dispatchStateEvent("iceconnectionstatechange", self._on_ice_connection_state_change) catch {};
}

fn onNativeConnectionStateChange(ctx: ?*anyopaque, state: RTCPeerConnectionNative.PeerConnectionState) void {
    const self: *RTCPeerConnectionJs = @ptrCast(@alignCast(ctx.?));
    _ = state;
    self.dispatchStateEvent("connectionstatechange", self._on_connection_state_change) catch {};
}

fn onNativeSignalingStateChange(ctx: ?*anyopaque, state: RTCPeerConnectionNative.SignalingState) void {
    const self: *RTCPeerConnectionJs = @ptrCast(@alignCast(ctx.?));
    _ = state;
    self.dispatchStateEvent("signalingstatechange", self._on_signaling_state_change) catch {};
}

fn onNativeDataChannel(ctx: ?*anyopaque, channel: *RTCDataChannelNative) void {
    const self: *RTCPeerConnectionJs = @ptrCast(@alignCast(ctx.?));
    const js_ch = self.wrapDataChannel(channel, self._frame) catch return;
    const event = Event.initTrusted(comptime .wrap("datachannel"), .{}, self._frame._page) catch return;
    // datachannel event would need RTCDataChannelEvent - skip for now, CreepJS doesn't use it
    _ = js_ch;
    _ = event;
}

fn onDataChannelOpen(ctx: ?*anyopaque) void {
    const js_ch: *RTCDataChannelJs = @ptrCast(@alignCast(ctx.?));
    const event = Event.initTrusted(comptime .wrap("open"), .{}, js_ch._frame._page) catch return;
    js_ch._frame._event_manager.dispatch(js_ch._proto, event) catch {};
}

fn onDataChannelMessage(ctx: ?*anyopaque, data: []const u8, is_binary: bool) void {
    const js_ch: *RTCDataChannelJs = @ptrCast(@alignCast(ctx.?));
    const msg_data: MessageEvent.Data = if (is_binary)
        .{ .arraybuffer = .{ .values = data } }
    else
        .{ .string = data };
    const event = MessageEvent.initTrusted(comptime .wrap("message"), .{ .data = msg_data }, js_ch._frame._page) catch return;
    js_ch._frame._event_manager.dispatch(js_ch._proto, event.asEvent()) catch {};
}

fn onDataChannelClose(ctx: ?*anyopaque) void {
    const js_ch: *RTCDataChannelJs = @ptrCast(@alignCast(ctx.?));
    const event = Event.initTrusted(comptime .wrap("close"), .{}, js_ch._frame._page) catch return;
    js_ch._frame._event_manager.dispatch(js_ch._proto, event) catch {};
}

fn makeIceCandidate(frame: *Frame, candidate_line: []const u8, sdp_mid: []const u8) !*RTCIceCandidate {
    var foundation: []const u8 = "";
    var typ: []const u8 = "";
    var address: []const u8 = "";
    var port: u16 = 0;
    var protocol: []const u8 = "udp";

    var line = std.mem.trim(u8, candidate_line, " \t\r\n");
    if (std.mem.startsWith(u8, line, "a=")) line = line[2..];
    if (std.mem.startsWith(u8, line, "candidate:")) line = line[10..];
    line = std.mem.trim(u8, line, " \t\r\n");

    var it = std.mem.splitScalar(u8, line, ' ');
    foundation = it.next() orelse "";
    _ = it.next(); // component
    if (it.next()) |proto| {
        var proto_buf: [8]u8 = undefined;
        protocol = std.ascii.lowerString(&proto_buf, proto);
    }
    _ = it.next(); // priority
    address = it.next() orelse "";
    if (it.next()) |port_str| port = std.fmt.parseInt(u16, port_str, 10) catch 0;
    while (it.next()) |tok| {
        if (std.mem.eql(u8, tok, "typ")) {
            typ = std.mem.trim(u8, it.next() orelse "", " \t\r\n");
            break;
        }
    }

    const full_line = try std.fmt.allocPrint(frame.arena, "candidate:{s}", .{line});

    return try frame._factory.create(RTCIceCandidate{
        ._candidate = full_line,
        ._sdp_mid = try frame.arena.dupe(u8, sdp_mid),
        ._sdp_mline_index = 0,
        ._foundation = try frame.arena.dupe(u8, foundation),
        ._type = try frame.arena.dupe(u8, typ),
        ._address = try frame.arena.dupe(u8, address),
        ._port = port,
        ._protocol = try frame.arena.dupe(u8, protocol),
    });
}

fn jsTruthy(v: js.Value) bool {
    if (v.toBool()) return true;
    if (v.isNumber() or v.isNumberObject()) {
        return (v.toF64() catch 0) != 0;
    }
    return false;
}

fn parseConfig(alloc: std.mem.Allocator, config_val: ?js.Value) !RTCPeerConnectionNative.Config {
    var servers: std.ArrayList(RTCPeerConnectionNative.IceServer) = .empty;
    errdefer {
        for (servers.items) |s| alloc.free(s.url);
        servers.deinit(alloc);
    }

    if (config_val) |cv| {
        const config_obj = cv.toObject();
        if (config_obj.get("iceServers")) |ice_servers| {
            if (ice_servers.isArray()) {
                var arr = ice_servers.toArray();
                const len = arr.len();
                var i: u32 = 0;
                while (i < len) : (i += 1) {
                    const server = arr.get(i) catch continue;
                    const server_obj = server.toObject();
                    // Chrome: `urls` (string|array). Legacy: singular `url`.
                    const urls_val = server_obj.get("urls") catch server_obj.get("url") catch continue;
                    if (urls_val.isArray()) {
                        var urls_arr = urls_val.toArray();
                        const urls_len = urls_arr.len();
                        var j: u32 = 0;
                        while (j < urls_len) : (j += 1) {
                            const url_val = urls_arr.get(j) catch continue;
                            if (url_val.isString()) |s| {
                                const url = try s.toSliceWithAlloc(alloc);
                                try servers.append(alloc, .{ .url = try alloc.dupe(u8, url) });
                            }
                        }
                    } else if (urls_val.isString()) |s| {
                        const url = try s.toSliceWithAlloc(alloc);
                        try servers.append(alloc, .{ .url = try alloc.dupe(u8, url) });
                    }
                }
            }
        } else |_| {}
    }

    const owned = try servers.toOwnedSlice(alloc);
    return .{ .ice_servers = owned };
}

fn parseOfferOptions(options: ?js.Value) RTCPeerConnectionNative.OfferOptions {
    var opts: RTCPeerConnectionNative.OfferOptions = .{
        .include_datachannel = true,
    };
    const val = options orelse return opts;
    if (!val.isObject()) return opts;

    const obj = val.toObject();
    if (obj.get("offerToReceiveAudio")) |v| {
        opts.offer_to_receive_audio = jsTruthy(v);
    } else |_| {}
    if (obj.get("offerToReceiveVideo")) |v| {
        opts.offer_to_receive_video = jsTruthy(v);
    } else |_| {}
    return opts;
}

fn signalingStateStr(state: RTCPeerConnectionNative.SignalingState) []const u8 {
    return switch (state) {
        .stable => "stable",
        .have_local_offer => "have-local-offer",
        .have_remote_offer => "have-remote-offer",
        .have_local_pranswer => "have-local-pranswer",
        .have_remote_pranswer => "have-remote-pranswer",
        .closed => "closed",
    };
}

fn iceConnectionStateStr(state: RTCPeerConnectionNative.IceConnectionState) []const u8 {
    return switch (state) {
        .new => "new",
        .checking => "checking",
        .connected => "connected",
        .completed => "completed",
        .failed => "failed",
        .disconnected => "disconnected",
        .closed => "closed",
    };
}

fn connectionStateStr(state: RTCPeerConnectionNative.PeerConnectionState) []const u8 {
    return switch (state) {
        .new => "new",
        .connecting => "connecting",
        .connected => "connected",
        .failed => "failed",
        .disconnected => "disconnected",
        .closed => "closed",
    };
}

fn iceGatheringStateStr(state: RTCPeerConnectionNative.IceGatheringState) []const u8 {
    return switch (state) {
        .new => "new",
        .gathering => "gathering",
        .complete => "complete",
    };
}
