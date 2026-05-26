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

//! SDP parser for WebRTC DataChannel sessions.
//!
//! Parses RFC 8866 SDP from remote peer. Defensive:
//!   - Handles both \r\n and \n line endings.
//!   - Ignores unknown attributes.
//!   - Does not allocate; all strings point into the input buffer.
//!
//! Only extracts fields needed for ICE + DTLS + SCTP:
//!   - a=ice-ufrag, a=ice-pwd
//!   - a=fingerprint:<hash> <value>
//!   - a=setup:<role>
//!   - a=sctp-port:<port>
//!   - a=max-message-size:<size>
//!   - a=candidate:<...>
//!
//! Caller must ensure the input buffer remains valid for the lifetime
//! of the ParsedSdp struct (zero-copy slices into input).

const std = @import("std");

pub const ParseError = error{
    InvalidSdp,
    MissingIceUfrag,
    MissingIcePwd,
    MissingFingerprint,
    MissingSetup,
};

pub const DtlsSetup = enum { actpass, active, passive, holdconn };

pub const ParsedCandidate = struct {
    foundation: []const u8,
    component: u8,
    transport: []const u8,
    priority: u32,
    address: []const u8,
    port: u16,
    typ: []const u8,
    related_address: ?[]const u8,
    related_port: ?u16,
};

/// Maximum number of candidates that can be parsed in a single SDP.
const MAX_CANDIDATES = 64;

pub const ParsedSdp = struct {
    ice_ufrag: []const u8,
    ice_pwd: []const u8,
    /// Fingerprint hash algorithm (e.g., "sha-256")
    fingerprint_hash: []const u8,
    /// Fingerprint value (e.g., "AA:BB:CC:...")
    fingerprint_value: []const u8,
    setup: DtlsSetup,
    sctp_port: u16,
    max_message_size: u64,
    candidates: [MAX_CANDIDATES]ParsedCandidate,
    candidate_count: usize,
};

/// Parse SDP from `input`. Zero-copy — slices point into `input`.
/// `input` must remain valid as long as ParsedSdp is used.
pub fn parse(input: []const u8) !ParsedSdp {
    var result = ParsedSdp{
        .ice_ufrag = "",
        .ice_pwd = "",
        .fingerprint_hash = "",
        .fingerprint_value = "",
        .setup = .actpass,
        .sctp_port = 5000,
        .max_message_size = 262144,
        .candidates = undefined,
        .candidate_count = 0,
    };
    // Zero-init candidates array
    for (&result.candidates) |*c| {
        c.* = ParsedCandidate{
            .foundation = "",
            .component = 1,
            .transport = "UDP",
            .priority = 0,
            .address = "",
            .port = 0,
            .typ = "host",
            .related_address = null,
            .related_port = null,
        };
    }

    var have_ufrag = false;
    var have_pwd = false;
    var have_fp = false;
    var have_setup = false;

    var lines = lineIterator(input);
    while (lines.next()) |line| {
        if (line.len < 2 or line[1] != '=') continue;

        const kind = line[0];
        const value = line[2..];

        if (kind == 'a') {
            // Attribute line
            if (stripPrefix(value, "ice-ufrag:")) |v| {
                result.ice_ufrag = trim(v);
                have_ufrag = true;
            } else if (stripPrefix(value, "ice-pwd:")) |v| {
                result.ice_pwd = trim(v);
                have_pwd = true;
            } else if (stripPrefix(value, "fingerprint:")) |v| {
                // fingerprint:<hash> <value>
                const sp = std.mem.indexOfScalar(u8, v, ' ') orelse continue;
                result.fingerprint_hash = trim(v[0..sp]);
                result.fingerprint_value = trim(v[sp + 1 ..]);
                have_fp = true;
            } else if (stripPrefix(value, "setup:")) |v| {
                const sv = trim(v);
                result.setup = parseSetup(sv) orelse .actpass;
                have_setup = true;
            } else if (stripPrefix(value, "sctp-port:")) |v| {
                result.sctp_port = std.fmt.parseInt(u16, trim(v), 10) catch 5000;
            } else if (stripPrefix(value, "max-message-size:")) |v| {
                result.max_message_size = std.fmt.parseInt(u64, trim(v), 10) catch 262144;
            } else if (stripPrefix(value, "candidate:")) |v| {
                if (result.candidate_count < MAX_CANDIDATES) {
                    if (parseCandidate(v)) |cand| {
                        result.candidates[result.candidate_count] = cand;
                        result.candidate_count += 1;
                    }
                }
            }
        }
    }

    if (!have_ufrag) return ParseError.MissingIceUfrag;
    if (!have_pwd) return ParseError.MissingIcePwd;
    if (!have_fp) return ParseError.MissingFingerprint;
    _ = have_setup; // setup defaults to actpass if missing

    return result;
}

/// Parse a single a=candidate line value (the part after "candidate:").
/// Returns null on parse failure (defensive: ignore malformed candidates).
pub fn parseCandidate(value: []const u8) ?ParsedCandidate {
    // Format: <foundation> <component> <transport> <priority> <address> <port> typ <type> [raddr <raddr> rport <rport>]
    var it = std.mem.splitScalar(u8, trim(value), ' ');

    const foundation = it.next() orelse return null;
    const component_str = it.next() orelse return null;
    const transport = it.next() orelse return null;
    const priority_str = it.next() orelse return null;
    const address = it.next() orelse return null;
    const port_str = it.next() orelse return null;
    const typ_kw = it.next() orelse return null;
    if (!std.mem.eql(u8, typ_kw, "typ")) return null;
    const typ = it.next() orelse return null;

    const component = std.fmt.parseInt(u8, component_str, 10) catch return null;
    const priority = std.fmt.parseInt(u32, priority_str, 10) catch return null;
    const port = std.fmt.parseInt(u16, port_str, 10) catch return null;

    var cand = ParsedCandidate{
        .foundation = foundation,
        .component = component,
        .transport = transport,
        .priority = priority,
        .address = address,
        .port = port,
        .typ = typ,
        .related_address = null,
        .related_port = null,
    };

    // Parse optional raddr / rport
    while (it.next()) |token| {
        if (std.mem.eql(u8, token, "raddr")) {
            cand.related_address = it.next();
        } else if (std.mem.eql(u8, token, "rport")) {
            const rport_str = it.next() orelse continue;
            cand.related_port = std.fmt.parseInt(u16, rport_str, 10) catch null;
        }
    }

    return cand;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

fn stripPrefix(s: []const u8, prefix: []const u8) ?[]const u8 {
    if (std.mem.startsWith(u8, s, prefix)) return s[prefix.len..];
    return null;
}

fn trim(s: []const u8) []const u8 {
    return std.mem.trim(u8, s, " \t\r\n");
}

fn parseSetup(s: []const u8) ?DtlsSetup {
    if (std.mem.eql(u8, s, "actpass")) return .actpass;
    if (std.mem.eql(u8, s, "active")) return .active;
    if (std.mem.eql(u8, s, "passive")) return .passive;
    if (std.mem.eql(u8, s, "holdconn")) return .holdconn;
    return null;
}

/// Iterator over SDP lines supporting both \r\n and \n.
const LineIterator = struct {
    buf: []const u8,
    pos: usize,

    fn next(self: *LineIterator) ?[]const u8 {
        if (self.pos >= self.buf.len) return null;
        const start = self.pos;
        while (self.pos < self.buf.len) {
            if (self.buf[self.pos] == '\n') {
                const end = if (self.pos > start and self.buf[self.pos - 1] == '\r')
                    self.pos - 1
                else
                    self.pos;
                self.pos += 1;
                return self.buf[start..end];
            }
            self.pos += 1;
        }
        // Last line without trailing newline
        if (self.pos > start) return self.buf[start..self.pos];
        return null;
    }
};

fn lineIterator(buf: []const u8) LineIterator {
    return .{ .buf = buf, .pos = 0 };
}
