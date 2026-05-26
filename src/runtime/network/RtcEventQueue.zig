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

//! Lock-free MPSC (multi-producer, single-consumer) event queue.
//!
//! The WebRTC network thread is the producer; the JS thread is the sole consumer.
//! Producers push() under their own thread without holding any lock.
//! The consumer drains via drainAll() from the JS scheduler tick.
//!
//! Ownership:
//!   - The network thread allocates Node objects from the arena it controls.
//!   - After drainAll() the JS thread owns each Node and must free it.
//!   - The queue does NOT free nodes; the consumer is responsible.

const std = @import("std");
const Allocator = std.mem.Allocator;

/// Events flowing from the WebRTC network thread to the JS thread.
pub const RtcEvent = union(enum) {
    /// A local ICE candidate was gathered.
    ice_candidate: IceCandidateEvent,
    /// ICE gathering finished (end-of-candidates).
    ice_gathering_complete,
    /// ICE connection state changed.
    ice_connection_state: IceConnectionState,
    /// DTLS handshake completed successfully.
    dtls_handshake_done,
    /// DTLS encountered a fatal error.
    dtls_failed: DtlsError,
    /// An SCTP DATA_CHANNEL_OPEN message arrived for a new channel.
    sctp_channel_open: SctpChannelInfo,
    /// An SCTP data message arrived for an existing channel.
    sctp_data: SctpDataEvent,
    /// SCTP association is established; all pending channels can open.
    sctp_connected,
    /// A data channel was closed by the remote peer.
    sctp_channel_closed: u16, // stream_id
    /// The peer connection was shut down cleanly by the network thread.
    shutdown_ack,
    /// Overall connection state change.
    connection_state: ConnectionState,

    pub const IceCandidateEvent = struct {
        foundation: [32]u8,
        foundation_len: u8,
        component: u8,
        protocol: Protocol,
        priority: u32,
        address: [64]u8,
        address_len: u8,
        port: u16,
        typ: CandidateType,
        /// For srflx/prflx: the base (local) address.
        related_address: [64]u8,
        related_address_len: u8,
        related_port: u16,

        pub const Protocol = enum { udp, tcp };
        pub const CandidateType = enum { host, srflx, prflx, relay };
    };

    pub const IceConnectionState = enum {
        new,
        checking,
        connected,
        completed,
        failed,
        disconnected,
        closed,
    };

    pub const DtlsError = enum {
        handshake_timeout,
        certificate_rejected,
        internal,
    };

    pub const SctpChannelInfo = struct {
        stream_id: u16,
        label: [256]u8,
        label_len: u16,
        protocol: [256]u8,
        protocol_len: u16,
        ordered: bool,
        max_retransmits: ?u16,
        max_packet_life_time: ?u16,
    };

    pub const SctpDataEvent = struct {
        stream_id: u16,
        ppid: u32,
        /// Owned by the node's arena; consumer must free.
        data: []u8,
    };

    pub const ConnectionState = enum {
        new,
        connecting,
        connected,
        disconnected,
        failed,
        closed,
    };
};

pub const Node = struct {
    /// Intrusive linked-list pointer; managed by the queue.
    next: std.atomic.Value(?*Node) = .init(null),
    event: RtcEvent,
};

const RtcEventQueue = @This();

/// Atomic stack head. null = empty.
/// The network thread prepends; the JS thread reverses on drain.
_head: std.atomic.Value(?*Node) = .init(null),

pub fn init() RtcEventQueue {
    return .{};
}

/// Push an event from the network thread (or any producer thread).
/// `node` must outlive the drain() call on the JS thread.
pub fn push(self: *RtcEventQueue, node: *Node) void {
    // CAS loop: swap head with node, set node.next = old head.
    var old = self._head.load(.monotonic);
    while (true) {
        node.next.store(old, .monotonic);
        if (self._head.cmpxchgWeak(old, node, .release, .monotonic)) |actual| {
            old = actual;
        } else {
            break;
        }
    }
}

/// Drain all pending nodes into `out` (JS thread only).
/// Returns nodes in FIFO order (oldest first).
/// Caller is responsible for freeing each Node.
pub fn drainAll(self: *RtcEventQueue, out: *std.ArrayList(*Node)) !void {
    // Atomically take the whole stack.
    var node = self._head.swap(null, .acquire);

    // The stack is in LIFO order; reverse it into `out`.
    // We collect into a temporary slice first for reversal.
    var tmp: [256]*Node = undefined;
    var count: usize = 0;

    while (node) |n| {
        if (count < tmp.len) {
            tmp[count] = n;
            count += 1;
        }
        node = n.next.load(.monotonic);
    }

    // Append in reverse (oldest-first).
    var i: usize = count;
    while (i > 0) {
        i -= 1;
        try out.append(tmp[i]);
    }
}

/// Returns true if the queue is non-empty.
/// Approximate (no acquire fence); use only for scheduler hints.
pub fn hasEvents(self: *const RtcEventQueue) bool {
    return self._head.load(.monotonic) != null;
}
