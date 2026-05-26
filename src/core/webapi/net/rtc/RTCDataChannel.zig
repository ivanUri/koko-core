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

//! RTCDataChannel — JS-side representation of a single SCTP stream.
//!
//! Ownership model:
//!   - RTCDataChannel is heap-allocated, ref-counted via Rc(RTCDataChannel).
//!   - RTCPeerConnection holds a strong reference to each open channel.
//!   - JS wrapper holds a strong reference via JSValue external.
//!
//! Thread safety:
//!   - All methods called only from JS thread.
//!   - send() posts a RtcCommand to the network thread (lock-free queue).
//!   - Incoming messages posted by network thread via RtcEventQueue, dispatched
//!     on JS thread via RTCPeerConnection.drainEvents().
//!
//! RTCReadyState mapping (WebRTC spec §5.2):
//!   connecting → open → closing → closed
//!
//! SCTP PPIDs:
//!   51 = WebRTC String
//!   53 = WebRTC String Empty
//!   56 = WebRTC Binary
//!   57 = WebRTC Binary Empty

const std = @import("std");
const Allocator = std.mem.Allocator;

const log = @import("../../../../support/log.zig");
const RtcCommandQueue = @import("../../../../runtime/network/RtcCommandQueue.zig");
const SctpTransport = @import("SctpTransport.zig");

pub const RTCDataChannel = @This();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

pub const ReadyState = enum(u8) {
    connecting = 0,
    open = 1,
    closing = 2,
    closed = 3,
};

pub const Init = struct {
    ordered: bool = true,
    max_retransmits: ?u16 = null,
    max_packet_life_time: ?u16 = null,
    protocol: []const u8 = "",
    negotiated: bool = false,
    id: ?u16 = null,
};

/// Callbacks dispatched on JS thread.
pub const Handlers = struct {
    on_open: ?*const fn (ctx: ?*anyopaque) void = null,
    on_message: ?*const fn (ctx: ?*anyopaque, data: []const u8, is_binary: bool) void = null,
    on_close: ?*const fn (ctx: ?*anyopaque) void = null,
    on_error: ?*const fn (ctx: ?*anyopaque, msg: []const u8) void = null,
    ctx: ?*anyopaque = null,
};

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

_alloc: Allocator,
_cmd_queue: *RtcCommandQueue,

/// SCTP stream ID assigned by WebRtcThread
stream_id: u16,

/// Unique ID for correlating createDataChannel command with channel_created event
js_channel_id: u32,

label: []const u8,
protocol: []const u8,

ordered: bool,
max_retransmits: ?u16,
max_packet_life_time: ?u16,
negotiated: bool,

ready_state: ReadyState,

/// Buffered amount (bytes queued for send, not yet delivered to OS).
/// Approximation: incremented on send(), decremented on network thread ACK.
buffered_amount: u64,

handlers: Handlers,

// Reference count (shared ownership between JS wrapper + PeerConnection)
_ref_count: u32,

// ---------------------------------------------------------------------------
// Init / deinit
// ---------------------------------------------------------------------------

pub fn create(
    alloc: Allocator,
    cmd_queue: *RtcCommandQueue,
    stream_id: u16,
    js_channel_id: u32,
    label: []const u8,
    init: Init,
) !*RTCDataChannel {
    const self = try alloc.create(RTCDataChannel);

    const label_copy = try alloc.dupe(u8, label);
    const protocol_copy = try alloc.dupe(u8, init.protocol);

    self.* = RTCDataChannel{
        ._alloc = alloc,
        ._cmd_queue = cmd_queue,
        .stream_id = stream_id,
        .js_channel_id = js_channel_id,
        .label = label_copy,
        .protocol = protocol_copy,
        .ordered = init.ordered,
        .max_retransmits = init.max_retransmits,
        .max_packet_life_time = init.max_packet_life_time,
        .negotiated = init.negotiated,
        .ready_state = .connecting,
        .buffered_amount = 0,
        .handlers = .{},
        ._ref_count = 1,
    };

    return self;
}

pub fn ref(self: *RTCDataChannel) *RTCDataChannel {
    self._ref_count += 1;
    return self;
}

pub fn unref(self: *RTCDataChannel) void {
    self._ref_count -= 1;
    if (self._ref_count == 0) {
        self._alloc.free(self.label);
        self._alloc.free(self.protocol);
        self._alloc.destroy(self);
    }
}

// ---------------------------------------------------------------------------
// Public API (JS thread only)
// ---------------------------------------------------------------------------

/// Send a text message.
pub fn sendText(self: *RTCDataChannel, text: []const u8) !void {
    if (self.ready_state != .open) return error.DataChannelNotOpen;

    const ppid: u32 = if (text.len == 0) SctpTransport.PPID_STRING_EMPTY else SctpTransport.PPID_STRING;
    try self.enqueueData(text, ppid);
}

/// Send binary data.
pub fn sendBinary(self: *RTCDataChannel, data: []const u8) !void {
    if (self.ready_state != .open) return error.DataChannelNotOpen;

    const ppid: u32 = if (data.len == 0) SctpTransport.PPID_BINARY_EMPTY else SctpTransport.PPID_BINARY;
    try self.enqueueData(data, ppid);
}

/// Initiate channel close (RTCDataChannel.close() spec).
pub fn close(self: *RTCDataChannel) void {
    if (self.ready_state == .closing or self.ready_state == .closed) return;
    self.ready_state = .closing;

    const node = self._alloc.create(RtcCommandQueue.Node) catch return;
    node.* = .{ .cmd = .{ .close_channel = self.stream_id } };
    self._cmd_queue.push(node);
}

// ---------------------------------------------------------------------------
// Internal: called by RTCPeerConnection.drainEvents()
// ---------------------------------------------------------------------------

pub fn onOpen(self: *RTCDataChannel) void {
    self.ready_state = .open;
    if (self.handlers.on_open) |cb| cb(self.handlers.ctx);
}

pub fn onMessage(self: *RTCDataChannel, data: []const u8, ppid: u32) void {
    const is_binary = (ppid == SctpTransport.PPID_BINARY or ppid == SctpTransport.PPID_BINARY_EMPTY);
    if (self.handlers.on_message) |cb| cb(self.handlers.ctx, data, is_binary);
}

pub fn onClose(self: *RTCDataChannel) void {
    self.ready_state = .closed;
    if (self.handlers.on_close) |cb| cb(self.handlers.ctx);
}

pub fn onError(self: *RTCDataChannel, msg: []const u8) void {
    if (self.handlers.on_error) |cb| cb(self.handlers.ctx, msg);
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

fn enqueueData(self: *RTCDataChannel, data: []const u8, ppid: u32) !void {
    const data_copy = try self._alloc.dupe(u8, data);

    const node = try self._alloc.create(RtcCommandQueue.Node);
    node.* = .{ .cmd = .{ .send_data = .{
        .stream_id = self.stream_id,
        .ppid = ppid,
        .ordered = self.ordered,
        .data = data_copy,
    } } };

    self.buffered_amount += data.len;
    self._cmd_queue.push(node);
}
