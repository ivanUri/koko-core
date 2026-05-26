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

//! MPSC command queue: JS thread → WebRTC network thread.
//!
//! The JS thread is the sole producer; the network thread is the sole consumer.
//! Uses the same lock-free atomic-stack pattern as RtcEventQueue.
//!
//! Ownership:
//!   - JS thread allocates Node from its arena.
//!   - Network thread owns each Node after drain; must free via the
//!     allocator stored in the Node.
//!   - send/binary data slices are allocated from the JS arena and
//!     must be freed by the network thread after usrsctp_sendv().

const std = @import("std");
const Allocator = std.mem.Allocator;

/// Commands flowing from the JS thread to the WebRTC network thread.
pub const RtcCommand = union(enum) {
    /// Send an SCTP message on a data channel.
    sctp_send: SctpSendCmd,
    /// Close a specific data channel (stream_id).
    sctp_close_channel: u16,
    /// Add a remote ICE candidate for connectivity checks.
    add_remote_candidate: RemoteCandidateCmd,
    /// Begin ICE gathering (called after setLocalDescription).
    start_gathering: StartGatheringCmd,
    /// Start DTLS handshake after ICE connected.
    start_dtls: DtlsRole,
    /// Graceful shutdown of the entire PeerConnection.
    shutdown,

    pub const SctpSendCmd = struct {
        stream_id: u16,
        /// PPID: 51=string, 53=string_empty, 56=binary, 57=binary_empty
        ppid: u32,
        ordered: bool,
        /// max_retransmits == null means reliable.
        max_retransmits: ?u16,
        /// Owned slice; network thread must free via `alloc`.
        data: []const u8,
        alloc: Allocator,
    };

    pub const RemoteCandidateCmd = struct {
        foundation: [32]u8,
        foundation_len: u8,
        component: u8,
        priority: u32,
        address: [64]u8,
        address_len: u8,
        port: u16,
        typ: CandidateType,
        related_address: [64]u8,
        related_address_len: u8,
        related_port: u16,

        pub const CandidateType = enum { host, srflx, prflx, relay };
    };

    pub const StartGatheringCmd = struct {
        /// Copy of local ufrag/pwd for STUN auth.
        ufrag: [8]u8,
        pwd: [24]u8,
        /// STUN server address (optional).
        stun_host: [256]u8,
        stun_host_len: u8,
        stun_port: u16,
    };

    pub const DtlsRole = enum { client, server };
};

pub const Node = struct {
    next: std.atomic.Value(?*Node) = .init(null),
    cmd: RtcCommand,
};

const RtcCommandQueue = @This();

_head: std.atomic.Value(?*Node) = .init(null),

pub fn init() RtcCommandQueue {
    return .{};
}

/// Push a command (JS thread).
pub fn push(self: *RtcCommandQueue, node: *Node) void {
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

/// Drain all pending commands (network thread only).
/// Returns in FIFO order.
pub fn drainAll(self: *RtcCommandQueue, out: *std.ArrayList(*Node)) !void {
    var node = self._head.swap(null, .acquire);

    var tmp: [128]*Node = undefined;
    var count: usize = 0;

    while (node) |n| {
        if (count < tmp.len) {
            tmp[count] = n;
            count += 1;
        }
        node = n.next.load(.monotonic);
    }

    var i: usize = count;
    while (i > 0) {
        i -= 1;
        try out.append(tmp[i]);
    }
}

/// Returns true if the queue has pending commands (approximate).
pub fn hasCmds(self: *const RtcCommandQueue) bool {
    return self._head.load(.monotonic) != null;
}
