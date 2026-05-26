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

//! SCTP transport over DTLS — RFC 8261 / draft-ietf-rtcweb-data-channel.
//!
//! Uses usrsctp as a userspace SCTP stack:
//!   - All usrsctp API calls happen on the WebRTC network thread (serialized).
//!   - No usrsctp calls are made from the JS thread.
//!   - Incoming DTLS-decrypted data → usrsctp_conninput()
//!   - usrsctp_sendv() → DTLS encrypt → UDP send
//!
//! DATA_CHANNEL_OPEN / DATA_CHANNEL_ACK (RFC 8832) are handled here.
//! Events are posted to RtcEventQueue for JS thread consumption.
//!
//! Stream ID allocation:
//!   - Offerer: even stream IDs (0, 2, 4, ...)
//!   - Answerer: odd stream IDs (1, 3, 5, ...)
//!
//! PPID values (RFC 8832 §8.2.4):
//!   51 = WebRTC String
//!   52 = WebRTC Binary Partial (deprecated)
//!   53 = WebRTC String Empty
//!   56 = WebRTC Binary
//!   57 = WebRTC Binary Empty

const std = @import("std");
const posix = std.posix;
const Allocator = std.mem.Allocator;

const log = @import("../../../../support/log.zig");
const RtcEventQueue = @import("../../../../runtime/network/RtcEventQueue.zig");
const DtlsTransport = @import("DtlsTransport.zig");

const usrsctp = @cImport({
    @cInclude("usrsctp.h");
});

const SctpTransport = @This();

pub const State = enum { new, connecting, connected, closed, failed };

// PPID constants
pub const PPID_STRING: u32 = 51;
pub const PPID_STRING_EMPTY: u32 = 53;
pub const PPID_BINARY: u32 = 56;
pub const PPID_BINARY_EMPTY: u32 = 57;

// DATA_CHANNEL_OPEN message type
const DC_OPEN_MSG_TYPE: u8 = 0x03;
const DC_ACK_MSG_TYPE: u8 = 0x02;
const DC_PPID_CONTROL: u32 = 50;

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

_alloc: Allocator,
_event_queue: *RtcEventQueue,
_dtls: *DtlsTransport,

_sock: ?*usrsctp.struct_socket,
_state: State,

/// Port numbers (same value used for local and remote per convention).
_local_port: u16,
_remote_port: u16,

/// Opaque pointer passed to usrsctp callbacks — points to this struct.
/// usrsctp requires a stable pointer; SctpTransport must not move.
_self_ptr: *SctpTransport,

// ---------------------------------------------------------------------------
// usrsctp global init (call once per process)
// ---------------------------------------------------------------------------

var _global_init_done: std.atomic.Value(bool) = .init(false);

pub fn globalInit() void {
    if (_global_init_done.swap(true, .acq_rel)) return;

    usrsctp.usrsctp_init(0, sendCb, null);
    usrsctp.usrsctp_sysctl_set_sctp_blackhole(2);
    usrsctp.usrsctp_sysctl_set_sctp_no_csum_on_loopback(0);
}

pub fn globalDeinit() void {
    if (!_global_init_done.load(.acquire)) return;
    usrsctp.usrsctp_finish();
}

// ---------------------------------------------------------------------------
// Init / deinit
// ---------------------------------------------------------------------------

pub fn init(
    alloc: Allocator,
    event_queue: *RtcEventQueue,
    dtls: *DtlsTransport,
    local_port: u16,
    remote_port: u16,
) !*SctpTransport {
    const self = try alloc.create(SctpTransport);
    errdefer alloc.destroy(self);

    self.* = .{
        ._alloc = alloc,
        ._event_queue = event_queue,
        ._dtls = dtls,
        ._sock = null,
        ._state = .new,
        ._local_port = local_port,
        ._remote_port = remote_port,
        ._self_ptr = self,
    };

    // Register this instance with usrsctp via addr_family trick
    usrsctp.usrsctp_register_address(self);

    return self;
}

pub fn deinit(self: *SctpTransport) void {
    self.close();
    usrsctp.usrsctp_deregister_address(self);
    self._alloc.destroy(self);
}

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------

/// Connect the SCTP association. Call after DTLS handshake is complete.
pub fn connect(self: *SctpTransport) !void {
    if (self._state != .new) return;

    // Create SCTP socket (one-to-one, SOCK_STREAM semantics over DTLS)
    const sock = usrsctp.usrsctp_socket(
        usrsctp.AF_CONN,
        usrsctp.SOCK_STREAM,
        usrsctp.IPPROTO_SCTP,
        recvCb,
        null,
        0,
        self._self_ptr,
    ) orelse return error.SctpSocketFailed;

    self._sock = sock;

    // Set non-blocking
    _ = usrsctp.usrsctp_set_non_blocking(sock, 1);

    // Enable SCTP_NODELAY
    var nodelay: c_int = 1;
    _ = usrsctp.usrsctp_setsockopt(sock, usrsctp.IPPROTO_SCTP, usrsctp.SCTP_NODELAY, &nodelay, @sizeOf(c_int));

    // Subscribe to SCTP events
    var event: usrsctp.struct_sctp_event = std.mem.zeroes(usrsctp.struct_sctp_event);
    event.se_assoc_id = usrsctp.SCTP_ALL_ASSOC;
    event.se_on = 1;

    const events = [_]u16{
        usrsctp.SCTP_ASSOC_CHANGE,
        usrsctp.SCTP_PEER_ADDR_CHANGE,
        usrsctp.SCTP_SEND_FAILED_EVENT,
        usrsctp.SCTP_STREAM_RESET_EVENT,
        usrsctp.SCTP_STREAM_CHANGE_EVENT,
    };
    for (events) |ev_type| {
        event.se_type = ev_type;
        _ = usrsctp.usrsctp_setsockopt(sock, usrsctp.IPPROTO_SCTP, usrsctp.SCTP_EVENT, &event, @sizeOf(usrsctp.struct_sctp_event));
    }

    // Configure stream reset (required for DataChannel close)
    var reset: usrsctp.struct_sctp_assoc_value = .{
        .assoc_id = usrsctp.SCTP_ALL_ASSOC,
        .assoc_value = usrsctp.ENABLE_RESET_STREAM_REQ | usrsctp.ENABLE_RESET_ASSOC_REQ | usrsctp.ENABLE_CHANGE_ASSOC_REQ,
    };
    _ = usrsctp.usrsctp_setsockopt(sock, usrsctp.IPPROTO_SCTP, usrsctp.SCTP_ENABLE_STREAM_RESET, &reset, @sizeOf(usrsctp.struct_sctp_assoc_value));

    // Bind to local port
    var local_addr: usrsctp.struct_sockaddr_conn = std.mem.zeroes(usrsctp.struct_sockaddr_conn);
    local_addr.sconn_family = usrsctp.AF_CONN;
    local_addr.sconn_port = std.mem.nativeToBig(u16, self._local_port);
    local_addr.sconn_addr = self._self_ptr;

    _ = usrsctp.usrsctp_bind(sock, @ptrCast(&local_addr), @sizeOf(usrsctp.struct_sockaddr_conn));

    // Connect to remote port
    var remote_addr: usrsctp.struct_sockaddr_conn = std.mem.zeroes(usrsctp.struct_sockaddr_conn);
    remote_addr.sconn_family = usrsctp.AF_CONN;
    remote_addr.sconn_port = std.mem.nativeToBig(u16, self._remote_port);
    remote_addr.sconn_addr = self._self_ptr;

    const rc = usrsctp.usrsctp_connect(sock, @ptrCast(&remote_addr), @sizeOf(usrsctp.struct_sockaddr_conn));
    if (rc < 0 and posix.errno(rc) != .INPROGRESS) {
        return error.SctpConnectFailed;
    }

    self._state = .connecting;
    log.info(.webrtc, "SCTP connecting", .{ .local_port = self._local_port, .remote_port = self._remote_port });
}

pub fn close(self: *SctpTransport) void {
    if (self._state == .closed) return;
    self._state = .closed;
    if (self._sock) |sock| {
        _ = usrsctp.usrsctp_shutdown(sock, usrsctp.SHUT_RDWR);
        usrsctp.usrsctp_close(sock);
        self._sock = null;
    }
}

// ---------------------------------------------------------------------------
// Data I/O
// ---------------------------------------------------------------------------

/// Feed decrypted SCTP bytes (from DTLS) into usrsctp.
pub fn injectIncoming(self: *SctpTransport, data: []const u8) void {
    usrsctp.usrsctp_conninput(self._self_ptr, data.ptr, @intCast(data.len), 0);
}

/// Send data on a specific stream.
pub fn sendData(
    self: *SctpTransport,
    stream_id: u16,
    ppid: u32,
    ordered: bool,
    max_retransmits: ?u16,
    data: []const u8,
) !void {
    if (self._state != .connected) return error.SctpNotConnected;
    const sock = self._sock orelse return error.SctpNotConnected;

    var sndinfo: usrsctp.struct_sctp_sndinfo = std.mem.zeroes(usrsctp.struct_sctp_sndinfo);
    sndinfo.snd_sid = stream_id;
    sndinfo.snd_ppid = std.mem.nativeToBig(u32, ppid);
    sndinfo.snd_flags = if (!ordered) usrsctp.SCTP_UNORDERED else 0;

    if (max_retransmits) |mr| {
        sndinfo.snd_flags |= usrsctp.SCTP_SENDALL;
        _ = mr; // usrsctp: set via SCTP_RTOINFO or per-send options
    }

    const rc = usrsctp.usrsctp_sendv(
        sock,
        data.ptr,
        @intCast(data.len),
        null,
        0,
        &sndinfo,
        @sizeOf(usrsctp.struct_sctp_sndinfo),
        usrsctp.SCTP_SENDV_SNDINFO,
        0,
    );

    if (rc < 0) {
        log.warn(.webrtc, "SCTP sendv failed", .{ .stream_id = stream_id, .errno = posix.errno(rc) });
        return error.SctpSendFailed;
    }
}

/// Open a new outgoing data channel (sends DATA_CHANNEL_OPEN).
pub fn openChannel(
    self: *SctpTransport,
    stream_id: u16,
    label: []const u8,
    protocol: []const u8,
    ordered: bool,
    max_retransmits: ?u16,
) !void {
    if (self._state != .connected) return error.SctpNotConnected;

    // Build DATA_CHANNEL_OPEN message (RFC 8832 §5.1)
    var buf: [512]u8 = undefined;
    var pos: usize = 0;

    buf[pos] = DC_OPEN_MSG_TYPE;
    pos += 1;

    // Channel type
    const chan_type: u8 = if (ordered)
        if (max_retransmits != null) 0x01 else 0x00 // reliable=0, partial_reliable_rexmit=1
    else if (max_retransmits != null) 0x81 else 0x80; // unordered reliable=0x80
    buf[pos] = chan_type;
    pos += 1;

    // Priority (0 = best-effort)
    std.mem.writeInt(u16, buf[pos..][0..2], 0, .big);
    pos += 2;

    // Reliability param
    std.mem.writeInt(u32, buf[pos..][0..4], max_retransmits orelse 0, .big);
    pos += 4;

    // Label length
    const label_capped = label[0..@min(label.len, 255)];
    std.mem.writeInt(u16, buf[pos..][0..2], @intCast(label_capped.len), .big);
    pos += 2;

    // Protocol length
    const proto_capped = protocol[0..@min(protocol.len, 255)];
    std.mem.writeInt(u16, buf[pos..][0..2], @intCast(proto_capped.len), .big);
    pos += 2;

    // Label
    @memcpy(buf[pos..][0..label_capped.len], label_capped);
    pos += label_capped.len;

    // Protocol
    @memcpy(buf[pos..][0..proto_capped.len], proto_capped);
    pos += proto_capped.len;

    try self.sendData(stream_id, DC_PPID_CONTROL, true, null, buf[0..pos]);
}

/// Close a specific stream (sends SCTP stream reset).
pub fn closeChannel(self: *SctpTransport, stream_id: u16) void {
    const sock = self._sock orelse return;
    var reset: usrsctp.struct_sctp_reset_streams = std.mem.zeroes(usrsctp.struct_sctp_reset_streams);
    reset.srs_assoc_id = usrsctp.SCTP_ALL_ASSOC;
    reset.srs_flags = usrsctp.SCTP_STREAM_RESET_OUTGOING;
    reset.srs_number_streams = 1;
    reset.srs_stream_list[0] = stream_id;
    _ = usrsctp.usrsctp_setsockopt(
        sock,
        usrsctp.IPPROTO_SCTP,
        usrsctp.SCTP_RESET_STREAMS,
        &reset,
        @sizeOf(usrsctp.struct_sctp_reset_streams),
    );
}

// ---------------------------------------------------------------------------
// usrsctp callbacks (called on WebRTC network thread only)
// ---------------------------------------------------------------------------

/// Called by usrsctp when it has data to send over the DTLS/UDP path.
export fn sendCb(
    addr: ?*anyopaque,
    buf: ?*anyopaque,
    length: usize,
    _: u8,
    _: u8,
) callconv(.C) c_int {
    const self: *SctpTransport = @ptrCast(@alignCast(addr orelse return -1));
    const data: [*]const u8 = @ptrCast(buf orelse return -1);

    // Encrypt via DTLS — we need sock + peer from the parent WebRtcThread.
    // For now, post to DTLS send; the thread passes those through context.
    // In WebRtcThread.zig, we store a pointer to sock+peer alongside SCTP.
    if (self._dtls._state == .connected) {
        // Send via DTLS — requires sock+peer which are stored in WebRtcThread.
        // The DTLS transport has the write BIO; we'll call it through the
        // stored context pointer set by WebRtcThread.
        if (g_send_ctx) |ctx| {
            self._dtls.send(data[0..length], ctx.sock, ctx.peer, ctx.peer_len) catch |err| {
                log.warn(.webrtc, "SCTP->DTLS send failed", .{ .err = err });
                return -1;
            };
        }
    }
    return 0;
}

/// Called by usrsctp when data arrives on a stream.
export fn recvCb(
    sock: ?*usrsctp.struct_socket,
    _: ?*anyopaque,
    buf: ?*anyopaque,
    length: usize,
    _: ?*usrsctp.struct_sctp_recvv_rn,
    _: usrsctp.socklen_t,
    flags: c_int,
    _: c_int,
    infotype: c_uint,
    _: ?*anyopaque,
) callconv(.C) c_int {
    _ = sock;
    _ = flags;

    const self_ptr = g_recv_ctx orelse return -1;
    const data: [*]const u8 = @ptrCast(buf orelse return -1);

    if (infotype == usrsctp.SCTP_RECVV_RCVINFO) {
        // Normal data
        const rcvinfo_ptr = g_recv_rcvinfo orelse return 0;
        const stream_id = rcvinfo_ptr.rcv_sid;
        const ppid = std.mem.bigToNative(u32, rcvinfo_ptr.rcv_ppid);

        self_ptr.handleIncomingData(stream_id, ppid, data[0..length]) catch |err| {
            log.warn(.webrtc, "SCTP recv handler error", .{ .err = err });
        };
    }

    return 0;
}

// Global context for callbacks (set by WebRtcThread before usrsctp_conninput).
// usrsctp callbacks don't support user data via the send/recv callbacks cleanly;
// we use thread-local context since all calls happen on the WebRTC network thread.
pub const SendCtx = struct {
    sock: posix.socket_t,
    peer: *const posix.sockaddr,
    peer_len: posix.socklen_t,
};

var g_send_ctx: ?*const SendCtx = null;
var g_recv_ctx: ?*SctpTransport = null;
var g_recv_rcvinfo: ?*usrsctp.struct_sctp_rcvinfo = null;

/// Set before calling usrsctp_conninput / usrsctp_sendv.
pub fn setCallbackContext(self: *SctpTransport, send_ctx: ?*const SendCtx) void {
    g_send_ctx = send_ctx;
    g_recv_ctx = self;
}

// ---------------------------------------------------------------------------
// Private: incoming data handler
// ---------------------------------------------------------------------------

fn handleIncomingData(self: *SctpTransport, stream_id: u16, ppid: u32, data: []const u8) !void {
    if (ppid == DC_PPID_CONTROL) {
        try self.handleControlMessage(stream_id, data);
        return;
    }

    // Regular data — post to JS event queue
    // Allocate owned copy for the event (JS thread will free)
    const owned = try self._alloc.dupe(u8, data);
    const node = try self._alloc.create(RtcEventQueue.Node);
    node.* = .{ .event = .{ .sctp_data = .{
        .stream_id = stream_id,
        .ppid = ppid,
        .data = owned,
    } } };
    self._event_queue.push(node);
}

fn handleControlMessage(self: *SctpTransport, stream_id: u16, data: []const u8) !void {
    if (data.len < 1) return;

    switch (data[0]) {
        DC_OPEN_MSG_TYPE => {
            // Remote opened a data channel — parse and emit event
            if (data.len < 12) return;

            const chan_type = data[1];
            const label_len = std.mem.readInt(u16, data[8..10], .big);
            const proto_len = std.mem.readInt(u16, data[10..12], .big);

            var info: RtcEventQueue.RtcEvent.SctpChannelInfo = std.mem.zeroes(RtcEventQueue.RtcEvent.SctpChannelInfo);
            info.stream_id = stream_id;
            info.ordered = (chan_type & 0x80) == 0;

            const label_start: usize = 12;
            const label_end = @min(label_start + label_len, data.len);
            const actual_label = data[label_start..label_end];
            const ll = @min(actual_label.len, 255);
            @memcpy(info.label[0..ll], actual_label[0..ll]);
            info.label_len = @intCast(ll);

            const proto_start = label_start + label_len;
            const proto_end = @min(proto_start + proto_len, data.len);
            const actual_proto = data[proto_start..proto_end];
            const pl = @min(actual_proto.len, 255);
            @memcpy(info.protocol[0..pl], actual_proto[0..pl]);
            info.protocol_len = @intCast(pl);

            // Send DATA_CHANNEL_ACK
            var ack: [1]u8 = .{DC_ACK_MSG_TYPE};
            self.sendData(stream_id, DC_PPID_CONTROL, true, null, &ack) catch |err| {
                log.warn(.webrtc, "SCTP: failed to send DC_ACK", .{ .err = err });
            };

            const node = try self._alloc.create(RtcEventQueue.Node);
            node.* = .{ .event = .{ .sctp_channel_open = info } };
            self._event_queue.push(node);
        },

        DC_ACK_MSG_TYPE => {
            // Remote acknowledged our DATA_CHANNEL_OPEN — channel is open
            const node = try self._alloc.create(RtcEventQueue.Node);
            node.* = .{ .event = .sctp_connected };
            self._event_queue.push(node);
        },

        else => {
            log.warn(.webrtc, "SCTP: unknown control msg", .{ .type = data[0] });
        },
    }
}
