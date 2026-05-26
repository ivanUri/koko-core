// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

//! RTCPeerConnection — WebRTC spec §4.
//!
//! Architecture:
//!   RTCPeerConnection (JS thread)
//!     │
//!     ├── WebRtcThread (network thread, owns ICE/DTLS/SCTP)
//!     │     ├── IceAgent         (UDP socket, STUN, connectivity checks)
//!     │     ├── DtlsTransport    (BoringSSL, memory BIOs)
//!     │     └── SctpTransport    (usrsctp, SCTP association)
//!     │
//!     ├── RtcCommandQueue  (JS→network, MPSC lock-free)
//!     ├── RtcEventQueue    (network→JS, MPSC lock-free)
//!     └── channels[]       (RTCDataChannel*, owned by PeerConnection)
//!
//! Lifecycle (offerer side):
//!   1. new RTCPeerConnection(config)         → state: new
//!   2. createOffer()                          → build SDP, set localDescription
//!   3. setLocalDescription(offer)            → start ICE gathering
//!   4. onicecandidate events                 → send via signaling
//!   5. setRemoteDescription(answer)          → extract remote ICE + DTLS
//!   6. addIceCandidate(cand)                 → add remote candidates
//!   7. ICE connects → DTLS handshake → SCTP association
//!   8. createDataChannel("label")            → RTCDataChannel (connecting)
//!   9. datachannel.onopen                    → RTCDataChannel (open)
//!  10. dc.send("hello")                      → enqueue to SCTP
//!  11. close()                               → teardown
//!
//! Answerer lifecycle is symmetric with createAnswer() and passive DTLS.
//!
//! Signaling states (spec §4.3.1):
//!   stable → have-local-offer → have-remote-pranswer → stable
//!   stable → have-remote-offer → have-local-pranswer → stable
//!
//! ICE states: new → checking → connected → completed | failed | disconnected | closed
//! Connection states: new → connecting → connected | failed | disconnected | closed
//!
//! Thread safety:
//!   - All public methods: JS thread only.
//!   - drainEvents(): called from JS event loop tick.
//!   - No mutex needed on RTCPeerConnection fields (JS thread owns them).

const std = @import("std");
const Allocator = std.mem.Allocator;

const log = @import("../../../../support/log.zig");
const RtcEventQueue = @import("../../../../runtime/network/RtcEventQueue.zig");
const RtcCommandQueue = @import("../../../../runtime/network/RtcCommandQueue.zig");
const WebRtcThread = @import("../../../../runtime/network/WebRtcThread.zig");
const IceAgent = @import("IceAgent.zig");
const SdpBuilder = @import("SdpBuilder.zig");
const RTCDataChannel = @import("RTCDataChannel.zig");

const RTCPeerConnection = @This();

// ---------------------------------------------------------------------------
// State enums (WebRTC spec)
// ---------------------------------------------------------------------------

pub const SignalingState = enum {
    stable,
    have_local_offer,
    have_remote_offer,
    have_local_pranswer,
    have_remote_pranswer,
    closed,
};

pub const IceGatheringState = enum { new, gathering, complete };

pub const IceConnectionState = enum {
    new, checking, connected, completed, failed, disconnected, closed,
};

pub const PeerConnectionState = enum {
    new, connecting, connected, failed, disconnected, closed,
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

pub const IceServer = struct {
    url: []const u8, // "stun:host:port" or "turn:..."
    username: []const u8 = "",
    credential: []const u8 = "",
};

pub const Config = struct {
    ice_servers: []const IceServer = &.{},
    /// If true, this side is the offerer (ICE controlling).
    is_offerer: bool = true,
};

// ---------------------------------------------------------------------------
// Callbacks (set by JS binding layer)
// ---------------------------------------------------------------------------

pub const Handlers = struct {
    /// Called when a new local ICE candidate is gathered.
    on_ice_candidate: ?*const fn (ctx: ?*anyopaque, candidate: []const u8, sdp_mid: []const u8) void = null,
    /// Called when ICE gathering is complete.
    on_ice_gathering_complete: ?*const fn (ctx: ?*anyopaque) void = null,
    /// Called when iceConnectionState changes.
    on_ice_connection_state_change: ?*const fn (ctx: ?*anyopaque, state: IceConnectionState) void = null,
    /// Called when connectionState changes.
    on_connection_state_change: ?*const fn (ctx: ?*anyopaque, state: PeerConnectionState) void = null,
    /// Called when signalingState changes.
    on_signaling_state_change: ?*const fn (ctx: ?*anyopaque, state: SignalingState) void = null,
    /// Called when a remote DataChannel is opened (answerer side).
    on_data_channel: ?*const fn (ctx: ?*anyopaque, channel: *RTCDataChannel) void = null,
    /// Opaque context pointer passed to all callbacks.
    ctx: ?*anyopaque = null,
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_CHANNELS = 256;
const MAX_STUN_SERVER_LEN = 256;

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

_alloc: Allocator,
_config: Config,

// Network thread (heap-allocated, stable address)
_thread: *WebRtcThread,
_event_queue: *RtcEventQueue,
_cmd_queue: *RtcCommandQueue,

// State (JS thread only)
signaling_state: SignalingState,
ice_gathering_state: IceGatheringState,
ice_connection_state: IceConnectionState,
connection_state: PeerConnectionState,

// SDP (heap-allocated, owned)
_local_sdp: ?[]u8,
_remote_sdp: ?[]u8,

// Local description version
_session_id: u64,
_session_version: u64,

// Channels (indexed by stream_id)
_channels: [MAX_CHANNELS]?*RTCDataChannel,
_next_js_channel_id: u32,

// Pending createDataChannel calls (before SCTP is ready).
// Stored as PendingChannel until channel_created event arrives.
_pending_channels: [MAX_CHANNELS]?PendingChannel,
_pending_count: usize,

// Handlers
handlers: Handlers,

// STUN server address (parsed from config, sent to network thread)
_stun_addr: ?std.net.Address,

// Closed flag (atomic so drainEvents can check safely)
_closed: std.atomic.Value(bool),

// ---------------------------------------------------------------------------
// Pending channel info (pre-SCTP)
// ---------------------------------------------------------------------------

const PendingChannel = struct {
    js_channel_id: u32,
    label: []u8, // owned
    init: RTCDataChannel.Init,
    protocol: []u8, // owned
};

// ---------------------------------------------------------------------------
// Init / deinit
// ---------------------------------------------------------------------------

pub fn create(alloc: Allocator, config: Config) !*RTCPeerConnection {
    const self = try alloc.create(RTCPeerConnection);
    errdefer alloc.destroy(self);

    // Create cross-thread queues
    const event_queue = try alloc.create(RtcEventQueue);
    event_queue.* = RtcEventQueue.init();

    const cmd_queue = try alloc.create(RtcCommandQueue);
    cmd_queue.* = RtcCommandQueue.init();

    // Parse STUN server from config
    const stun_addr = parseFirstStunServer(config.ice_servers);

    // Create network thread
    const thread_config = WebRtcThread.Config{
        .stun_server = stun_addr,
        .ice_role = if (config.is_offerer) .controlling else .controlled,
    };
    const thread = try WebRtcThread.create(alloc, event_queue, cmd_queue, thread_config);
    errdefer thread.destroy();

    const now: u64 = @intCast(std.time.milliTimestamp());

    self.* = RTCPeerConnection{
        ._alloc = alloc,
        ._config = config,
        ._thread = thread,
        ._event_queue = event_queue,
        ._cmd_queue = cmd_queue,
        .signaling_state = .stable,
        .ice_gathering_state = .new,
        .ice_connection_state = .new,
        .connection_state = .new,
        ._local_sdp = null,
        ._remote_sdp = null,
        ._session_id = now,
        ._session_version = 1,
        ._channels = [_]?*RTCDataChannel{null} ** MAX_CHANNELS,
        ._next_js_channel_id = 1,
        ._pending_channels = [_]?PendingChannel{null} ** MAX_CHANNELS,
        ._pending_count = 0,
        .handlers = .{},
        ._stun_addr = stun_addr,
        ._closed = .init(false),
    };

    // Spawn network thread
    try thread.spawn();

    return self;
}

pub fn destroy(self: *RTCPeerConnection) void {
    self.close();

    // Wait for thread to exit
    self._thread.stop();
    self._thread.destroy();

    // Free channels
    for (&self._channels) |*slot| {
        if (slot.*) |ch| {
            ch.unref();
            slot.* = null;
        }
    }

    // Free pending channels
    for (self._pending_channels[0..self._pending_count]) |*pc| {
        if (pc.*) |p| {
            self._alloc.free(p.label);
            self._alloc.free(p.protocol);
        }
    }

    // Free SDPs
    if (self._local_sdp) |s| self._alloc.free(s);
    if (self._remote_sdp) |s| self._alloc.free(s);

    // Drain and free remaining event queue nodes
    while (self._event_queue.pop()) |node| {
        freeEventNode(self._alloc, node);
    }

    self._alloc.destroy(self._event_queue);
    self._alloc.destroy(self._cmd_queue);
    self._alloc.destroy(self);
}

// ---------------------------------------------------------------------------
// WebRTC API (JS thread)
// ---------------------------------------------------------------------------

/// createOffer() — RFC 8829 §4.1.6
pub fn createOffer(self: *RTCPeerConnection, out_buf: *std.ArrayList(u8)) ![]const u8 {
    if (self._closed.load(.acquire)) return error.PeerConnectionClosed;

    const params = self.buildSdpParams(.actpass);
    return SdpBuilder.build(out_buf, params);
}

/// createAnswer() — RFC 8829 §4.1.7
pub fn createAnswer(self: *RTCPeerConnection, out_buf: *std.ArrayList(u8)) ![]const u8 {
    if (self._closed.load(.acquire)) return error.PeerConnectionClosed;
    if (self.signaling_state != .have_remote_offer) return error.InvalidSignalingState;

    // Answerer uses active DTLS (since offerer uses actpass)
    const params = self.buildSdpParams(.active);
    return SdpBuilder.build(out_buf, params);
}

/// setLocalDescription(sdp)
pub fn setLocalDescription(self: *RTCPeerConnection, sdp: []const u8) !void {
    if (self._closed.load(.acquire)) return error.PeerConnectionClosed;

    // Store local SDP
    if (self._local_sdp) |s| self._alloc.free(s);
    self._local_sdp = try self._alloc.dupe(u8, sdp);

    // Transition signaling state
    if (self.signaling_state == .stable) {
        self.setSignalingState(.have_local_offer);
    } else if (self.signaling_state == .have_remote_offer) {
        self.setSignalingState(.stable);
    }

    // Kick ICE gathering
    self.startIceGathering();
}

/// setRemoteDescription(sdp)
pub fn setRemoteDescription(self: *RTCPeerConnection, sdp: []const u8) !void {
    if (self._closed.load(.acquire)) return error.PeerConnectionClosed;

    // Store remote SDP
    if (self._remote_sdp) |s| self._alloc.free(s);
    self._remote_sdp = try self._alloc.dupe(u8, sdp);

    // Transition signaling state
    if (self.signaling_state == .stable) {
        self.setSignalingState(.have_remote_offer);
    } else if (self.signaling_state == .have_local_offer) {
        self.setSignalingState(.stable);
    }

    // Send SDP to network thread (it extracts ICE + DTLS credentials)
    const sdp_copy = try self._alloc.dupe(u8, sdp);
    const node = try self._alloc.create(RtcCommandQueue.Node);
    node.* = .{ .cmd = .{ .set_remote_description = .{ .sdp_buf = sdp_copy } } };
    self._cmd_queue.push(node);
    self._thread.wake();
}

/// addIceCandidate(candidateStr) — candidateStr is the a=candidate:... value
pub fn addIceCandidate(self: *RTCPeerConnection, candidate_str: []const u8) !void {
    if (self._closed.load(.acquire)) return error.PeerConnectionClosed;

    const cand_copy = try self._alloc.dupe(u8, candidate_str);
    const node = try self._alloc.create(RtcCommandQueue.Node);
    node.* = .{ .cmd = .{ .add_ice_candidate = .{ .candidate_str = cand_copy } } };
    self._cmd_queue.push(node);
    self._thread.wake();
}

/// createDataChannel(label, init) — returns RTCDataChannel (connecting state)
pub fn createDataChannel(
    self: *RTCPeerConnection,
    label: []const u8,
    init: RTCDataChannel.Init,
) !*RTCDataChannel {
    if (self._closed.load(.acquire)) return error.PeerConnectionClosed;

    const js_id = self._next_js_channel_id;
    self._next_js_channel_id += 1;

    // Allocate a placeholder channel with stream_id = 0 (will be updated on channel_created event)
    const label_copy = try self._alloc.dupe(u8, label);
    const protocol_copy = try self._alloc.dupe(u8, init.protocol);

    const ch = try RTCDataChannel.create(self._alloc, self._cmd_queue, 0, js_id, label_copy, init);
    self._alloc.free(label_copy); // create() made its own copy
    errdefer ch.unref();

    // Register as pending (stream_id unknown until network thread responds)
    if (self._pending_count < MAX_CHANNELS) {
        const proto_copy2 = try self._alloc.dupe(u8, init.protocol);
        self._pending_channels[self._pending_count] = PendingChannel{
            .js_channel_id = js_id,
            .label = try self._alloc.dupe(u8, label),
            .init = init,
            .protocol = proto_copy2,
        };
        self._alloc.free(protocol_copy);
        self._pending_count += 1;
    }

    // Send create command to network thread
    const label_net = try self._alloc.dupe(u8, label);
    const proto_net = try self._alloc.dupe(u8, init.protocol);
    const node = try self._alloc.create(RtcCommandQueue.Node);
    node.* = .{ .cmd = .{ .create_data_channel = .{
        .js_channel_id = js_id,
        .label = label_net,
        .protocol = proto_net,
        .ordered = init.ordered,
        .max_retransmits = init.max_retransmits,
    } } };
    self._cmd_queue.push(node);
    self._thread.wake();

    return ch;
}

/// close() — RTCPeerConnection.close() spec
pub fn close(self: *RTCPeerConnection) void {
    if (self._closed.swap(true, .acq_rel)) return; // already closed

    // Close all channels
    for (&self._channels) |*slot| {
        if (slot.*) |ch| {
            ch.close();
        }
    }

    // Send close command to network thread
    const node = self._alloc.create(RtcCommandQueue.Node) catch return;
    node.* = .{ .cmd = .close };
    self._cmd_queue.push(node);
    self._thread.wake();

    self.setIceConnectionState(.closed);
    self.setConnectionState(.closed);
    self.setSignalingState(.closed);
}

// ---------------------------------------------------------------------------
// Event drain (call from JS event loop tick)
// ---------------------------------------------------------------------------

/// Process all pending events from the network thread.
/// Must be called periodically from the JS thread event loop.
pub fn drainEvents(self: *RTCPeerConnection) void {
    while (self._event_queue.pop()) |node| {
        self.handleEvent(node.event);
        freeEventNode(self._alloc, node);
    }
}

fn handleEvent(self: *RTCPeerConnection, event: RtcEventQueue.RtcEvent) void {
    switch (event) {
        .ice_candidate => |cand| {
            if (self.handlers.on_ice_candidate) |cb| {
                // Format as a=candidate line
                var buf: [512]u8 = undefined;
                const line = SdpBuilder.formatCandidateLine(&buf, .{
                    .foundation = cand.foundation[0..cand.foundation_len],
                    .component = cand.component,
                    .transport = "UDP",
                    .priority = cand.priority,
                    .address = cand.address[0..cand.address_len],
                    .port = cand.port,
                    .typ = candTypStr(cand.typ),
                    .related_address = if (cand.has_related) cand.related_address[0..cand.related_address_len] else null,
                    .related_port = if (cand.has_related) cand.related_port else null,
                }) catch return;
                cb(self.handlers.ctx, line, "0");
            }
            self.setIceGatheringState(.gathering);
        },

        .ice_gathering_complete => {
            self.setIceGatheringState(.complete);
            if (self.handlers.on_ice_gathering_complete) |cb| cb(self.handlers.ctx);
        },

        .ice_connected => {
            self.setIceConnectionState(.connected);
            self.setConnectionState(.connecting);
        },

        .ice_failed => {
            self.setIceConnectionState(.failed);
            self.setConnectionState(.failed);
        },

        .dtls_connected => {
            // DTLS done — connection is now "connected" once SCTP opens
        },

        .sctp_connected => {
            self.setConnectionState(.connected);
            // Flush any pending createDataChannel calls that couldn't run before SCTP was up
        },

        .channel_created => |info| {
            self.onChannelCreated(info.stream_id, info.js_channel_id);
        },

        .sctp_channel_open => |info| {
            // Remote-initiated channel (answerer side)
            self.onRemoteChannelOpen(info);
        },

        .sctp_data => |data| {
            defer self._alloc.free(data.data);
            if (data.stream_id < MAX_CHANNELS) {
                if (self._channels[data.stream_id]) |ch| {
                    ch.onMessage(data.data, data.ppid);
                }
            }
        },

        .sctp_channel_closed => |stream_id| {
            if (stream_id < MAX_CHANNELS) {
                if (self._channels[stream_id]) |ch| {
                    ch.onClose();
                    ch.unref();
                    self._channels[stream_id] = null;
                }
            }
        },

        .error_event => |msg| {
            log.warn(.webrtc, "RTCPeerConnection network error", .{ .msg = msg });
        },
    }
}

// ---------------------------------------------------------------------------
// Private: channel lifecycle
// ---------------------------------------------------------------------------

fn onChannelCreated(self: *RTCPeerConnection, stream_id: u16, js_channel_id: u32) void {
    // Find the pending channel with this js_channel_id
    for (self._pending_channels[0..self._pending_count], 0..) |*slot, i| {
        const pending = slot.* orelse continue;
        if (pending.js_channel_id != js_channel_id) continue;

        // Create the real channel with correct stream_id
        const ch = RTCDataChannel.create(
            self._alloc,
            self._cmd_queue,
            stream_id,
            js_channel_id,
            pending.label,
            pending.init,
        ) catch {
            log.warn(.webrtc, "failed to create RTCDataChannel for stream", .{ .stream_id = stream_id });
            self._alloc.free(pending.label);
            self._alloc.free(pending.protocol);
            slot.* = null;
            // Compact
            if (i + 1 < self._pending_count) {
                std.mem.copyForwards(?PendingChannel, self._pending_channels[i..], self._pending_channels[i + 1 .. self._pending_count]);
            }
            self._pending_count -= 1;
            return;
        };

        // Register in channel table
        if (stream_id < MAX_CHANNELS) {
            self._channels[stream_id] = ch;
        }

        self._alloc.free(pending.label);
        self._alloc.free(pending.protocol);
        slot.* = null;

        // Compact
        if (i + 1 < self._pending_count) {
            std.mem.copyForwards(?PendingChannel, self._pending_channels[i..], self._pending_channels[i + 1 .. self._pending_count]);
        }
        self._pending_count -= 1;

        // Channel is now open (DATA_CHANNEL_ACK received → sctp_connected event follows)
        ch.onOpen();
        return;
    }
}

fn onRemoteChannelOpen(self: *RTCPeerConnection, info: RtcEventQueue.RtcEvent.SctpChannelInfo) void {
    if (info.stream_id >= MAX_CHANNELS) return;

    const label = info.label[0..info.label_len];
    const protocol = info.protocol[0..info.protocol_len];

    const ch = RTCDataChannel.create(
        self._alloc,
        self._cmd_queue,
        info.stream_id,
        0, // remote-initiated channels don't have a js_channel_id
        label,
        .{
            .ordered = info.ordered,
        },
    ) catch return;
    _ = protocol;

    self._channels[info.stream_id] = ch;
    ch.onOpen();

    if (self.handlers.on_data_channel) |cb| cb(self.handlers.ctx, ch);
}

// ---------------------------------------------------------------------------
// Private: state transitions
// ---------------------------------------------------------------------------

fn setSignalingState(self: *RTCPeerConnection, s: SignalingState) void {
    if (self.signaling_state == s) return;
    self.signaling_state = s;
    if (self.handlers.on_signaling_state_change) |cb| cb(self.handlers.ctx, s);
}

fn setIceGatheringState(self: *RTCPeerConnection, s: IceGatheringState) void {
    if (self.ice_gathering_state == s) return;
    self.ice_gathering_state = s;
}

fn setIceConnectionState(self: *RTCPeerConnection, s: IceConnectionState) void {
    if (self.ice_connection_state == s) return;
    self.ice_connection_state = s;
    if (self.handlers.on_ice_connection_state_change) |cb| cb(self.handlers.ctx, s);
}

fn setConnectionState(self: *RTCPeerConnection, s: PeerConnectionState) void {
    if (self.connection_state == s) return;
    self.connection_state = s;
    if (self.handlers.on_connection_state_change) |cb| cb(self.handlers.ctx, s);
}

// ---------------------------------------------------------------------------
// Private: ICE gathering startup
// ---------------------------------------------------------------------------

fn startIceGathering(self: *RTCPeerConnection) void {
    if (self.ice_gathering_state != .new) return;
    self.setIceGatheringState(.gathering);

    const node = self._alloc.create(RtcCommandQueue.Node) catch return;
    node.* = .{ .cmd = .{ .start_gathering = self._stun_addr } };
    self._cmd_queue.push(node);
    self._thread.wake();
}

// ---------------------------------------------------------------------------
// Private: SDP params builder
// ---------------------------------------------------------------------------

fn buildSdpParams(self: *const RTCPeerConnection, setup: SdpBuilder.DtlsSetup) SdpBuilder.SdpParams {
    return .{
        .local_ufrag = self._thread.localUfrag(),
        .local_pwd = self._thread.localPwd(),
        .fingerprint = self._thread.dtlsFingerprint(),
        .setup = setup,
        .sctp_port = 5000,
        .max_message_size = 262144,
        .role = if (self._config.is_offerer) .offerer else .answerer,
        .candidates = &.{}, // trickle ICE — candidates sent via onicecandidate
        .session_id = self._session_id,
        .session_version = self._session_version,
    };
}

// ---------------------------------------------------------------------------
// Private: STUN server parsing
// ---------------------------------------------------------------------------

fn parseFirstStunServer(servers: []const IceServer) ?std.net.Address {
    for (servers) |srv| {
        // Handle "stun:hostname:port" or "stun:hostname"
        const url = srv.url;
        const rest = if (std.mem.startsWith(u8, url, "stun:")) url[5..] else continue;

        // Find port separator
        const colon_pos = std.mem.lastIndexOfScalar(u8, rest, ':');
        if (colon_pos) |cp| {
            const host = rest[0..cp];
            const port_str = rest[cp + 1 ..];
            const port = std.fmt.parseInt(u16, port_str, 10) catch 3478;
            const addr = std.net.Address.parseIp(host, port) catch continue;
            return addr;
        } else {
            const addr = std.net.Address.parseIp(rest, 3478) catch continue;
            return addr;
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Private: free event node memory
// ---------------------------------------------------------------------------

fn freeEventNode(alloc: Allocator, node: *RtcEventQueue.Node) void {
    switch (node.event) {
        .sctp_data => |d| alloc.free(d.data),
        else => {},
    }
    alloc.destroy(node);
}

// ---------------------------------------------------------------------------
// Private: candidate type string
// ---------------------------------------------------------------------------

fn candTypStr(typ: IceAgent.CandidateType) []const u8 {
    return switch (typ) {
        .host => "host",
        .srflx => "srflx",
        .prflx => "prflx",
        .relay => "relay",
    };
}
