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

//! SDP offer/answer builder for WebRTC DataChannel-only sessions.
//!
//! Produces RFC 8866 SDP with:
//!   - Session-level: v=, o=, s=, t=, a=group:BUNDLE
//!   - Media section: m=application (SCTP over DTLS)
//!   - ICE: a=ice-ufrag, a=ice-pwd, a=ice-options:trickle
//!   - DTLS: a=fingerprint:sha-256, a=setup:actpass|active|passive
//!   - SCTP: a=sctp-port, a=max-message-size
//!   - Candidates: a=candidate (emitted separately via addIceCandidate)
//!
//! Line endings: \r\n (RFC 8866 §5).
//! All strings are ASCII-safe; no UTF-8 in SDP attributes.

const std = @import("std");
const Allocator = std.mem.Allocator;

pub const SdpRole = enum { offerer, answerer };
pub const DtlsSetup = enum { actpass, active, passive, holdconn };

pub const SdpParams = struct {
    /// ICE credentials
    local_ufrag: []const u8,
    local_pwd: []const u8,
    /// DTLS fingerprint (SHA-256, "AA:BB:..." format)
    fingerprint: []const u8,
    /// DTLS role for the a=setup attribute
    setup: DtlsSetup,
    /// SCTP port (default 5000)
    sctp_port: u16,
    /// Max message size (0 = unlimited per RFC)
    max_message_size: u64,
    /// Our ICE role (controlling = offerer)
    role: SdpRole,
    /// Gathered local candidates (may be empty for trickle ICE)
    candidates: []const CandidateLine,
    /// Session ID (monotonically increasing u64 — use timestamp)
    session_id: u64,
    /// Session version (increment on renegotiation)
    session_version: u64,
};

pub const CandidateLine = struct {
    foundation: []const u8,
    component: u8,
    transport: []const u8, // "UDP" or "TCP"
    priority: u32,
    address: []const u8,
    port: u16,
    typ: []const u8, // "host", "srflx", "prflx", "relay"
    related_address: ?[]const u8,
    related_port: ?u16,
};

/// Build an SDP offer or answer into `out`.
/// Returns the slice of `out` that was written.
pub fn build(out: *std.ArrayList(u8), params: SdpParams) ![]const u8 {
    const start = out.items.len;
    const w = out.writer(out.allocator);

    // v=0
    try w.writeAll("v=0\r\n");

    // o= <username> <session-id> <session-version> IN IP4 0.0.0.0
    try w.print("o=velora {d} {d} IN IP4 0.0.0.0\r\n", .{ params.session_id, params.session_version });

    // s=-
    try w.writeAll("s=-\r\n");

    // t=0 0
    try w.writeAll("t=0 0\r\n");

    // a=group:BUNDLE 0
    try w.writeAll("a=group:BUNDLE 0\r\n");

    // a=extmap-allow-mixed (Chrome compatibility)
    try w.writeAll("a=extmap-allow-mixed\r\n");

    // a=msid-semantic: WMS (required by Chrome)
    try w.writeAll("a=msid-semantic: WMS\r\n");

    // --- m= section (DataChannel) ---
    // m=application <port> UDP/DTLS/SCTP webrtc-datachannel
    try w.print("m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n", .{});

    // c=IN IP4 0.0.0.0
    try w.writeAll("c=IN IP4 0.0.0.0\r\n");

    // a=ice-ufrag:<ufrag>
    try w.print("a=ice-ufrag:{s}\r\n", .{params.local_ufrag});

    // a=ice-pwd:<pwd>
    try w.print("a=ice-pwd:{s}\r\n", .{params.local_pwd});

    // a=ice-options:trickle
    try w.writeAll("a=ice-options:trickle\r\n");

    // a=fingerprint:sha-256 <fingerprint>
    try w.print("a=fingerprint:sha-256 {s}\r\n", .{params.fingerprint});

    // a=setup:<role>
    const setup_str: []const u8 = switch (params.setup) {
        .actpass => "actpass",
        .active => "active",
        .passive => "passive",
        .holdconn => "holdconn",
    };
    try w.print("a=setup:{s}\r\n", .{setup_str});

    // a=mid:0
    try w.writeAll("a=mid:0\r\n");

    // a=sctp-port:<port>
    try w.print("a=sctp-port:{d}\r\n", .{params.sctp_port});

    // a=max-message-size:<size> (0 = no limit)
    try w.print("a=max-message-size:{d}\r\n", .{params.max_message_size});

    // a=candidate:<...> for each gathered candidate
    for (params.candidates) |cand| {
        try writeCandidateLine(w, cand);
    }

    // a=end-of-candidates (if we have all candidates already)
    // Only emit if candidates list is non-empty and gathering is complete.
    // RTCPeerConnection will add this separately when gathering completes.

    return out.items[start..];
}

fn writeCandidateLine(w: anytype, cand: CandidateLine) !void {
    // a=candidate:<foundation> <component> <transport> <priority> <address> <port> typ <type> [raddr <raddr> rport <rport>]
    if (cand.related_address) |raddr| {
        try w.print(
            "a=candidate:{s} {d} {s} {d} {s} {d} typ {s} raddr {s} rport {d}\r\n",
            .{ cand.foundation, cand.component, cand.transport, cand.priority, cand.address, cand.port, cand.typ, raddr, cand.related_port orelse 0 },
        );
    } else {
        try w.print(
            "a=candidate:{s} {d} {s} {d} {s} {d} typ {s}\r\n",
            .{ cand.foundation, cand.component, cand.transport, cand.priority, cand.address, cand.port, cand.typ },
        );
    }
}

/// Format a single a=candidate line into `buf`.
/// Used when emitting trickle ICE candidates via onicecandidate.
pub fn formatCandidateLine(buf: []u8, cand: CandidateLine) ![]const u8 {
    var fbs = std.io.fixedBufferStream(buf);
    const w = fbs.writer();
    try writeCandidateLine(w, cand);
    return fbs.getWritten();
}
