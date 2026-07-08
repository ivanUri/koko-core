//
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

//! WebSocket bootstrapping over HTTP/2 (RFC 8441) via nghttp2.

const std = @import("std");

const TlsIo = @import("TlsIo.zig");
const WsConnection = @import("WsConnection.zig");

const Allocator = std.mem.Allocator;

const ng = @cImport({
    @cInclude("nghttp2/nghttp2.h");
});

pub const H2WsSession = @This();

allocator: Allocator,
tls: *TlsIo,
reader: *WsConnection.Reader(false),
session: *ng.nghttp2_session,
callbacks: *ng.nghttp2_session_callbacks,
user_data: *UserData,
stream_id: i32 = -1,
/// True during init while the underlying socket is blocking.
blocking: bool = false,
handshake_done: bool = false,
handshake_failed: bool = false,
goaway_received: bool = false,
remote_settings_seen: bool = false,
pending_send: ?[]u8 = null,
pending_send_pos: usize = 0,
response_status: i32 = 0,
negotiated_protocol: []const u8 = "",
protocol_header: ?[]const u8 = null,
/// Populated with Set-Cookie values from the CONNECT response (owned by caller's list).
set_cookies_out: *std.ArrayList([]const u8),

const UserData = struct {
    h2: *H2WsSession,
};

/// Chrome-like User-Agent for WebSocket CONNECT handshakes (RFC 8441).
const default_user_agent =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

pub fn init(
    allocator: Allocator,
    tls: *TlsIo,
    reader: *WsConnection.Reader(false),
    url_host: []const u8,
    path: []const u8,
    search: []const u8,
    origin: []const u8,
    protocols: []const []const u8,
    set_cookies_out: *std.ArrayList([]const u8),
) !H2WsSession {
    var callbacks: ?*ng.nghttp2_session_callbacks = null;
    if (ng.nghttp2_session_callbacks_new(&callbacks) != 0) return error.H2InitFailed;
    const cb = callbacks.?;

    var option: ?*ng.nghttp2_option = null;
    if (ng.nghttp2_option_new(&option) != 0) {
        ng.nghttp2_session_callbacks_del(cb);
        return error.H2InitFailed;
    }
    defer ng.nghttp2_option_del(option.?);

    const ud = try allocator.create(UserData);

    ng.nghttp2_session_callbacks_set_send_callback2(cb, sendCallback);
    ng.nghttp2_session_callbacks_set_on_header_callback(cb, onHeader);
    ng.nghttp2_session_callbacks_set_on_data_chunk_recv_callback(cb, onDataChunk);
    ng.nghttp2_session_callbacks_set_on_frame_recv_callback(cb, onFrameRecv);
    ng.nghttp2_session_callbacks_set_on_stream_close_callback(cb, onStreamClose);
    ng.nghttp2_session_callbacks_set_on_invalid_header_callback(cb, onInvalidHeader);

    var session: ?*ng.nghttp2_session = null;
    if (ng.nghttp2_session_client_new2(&session, cb, ud, option.?) != 0) {
        allocator.destroy(ud);
        ng.nghttp2_session_callbacks_del(cb);
        return error.H2InitFailed;
    }
    const sess = session.?;

    var self = H2WsSession{
        .allocator = allocator,
        .tls = tls,
        .reader = reader,
        .session = sess,
        .callbacks = cb,
        .user_data = ud,
        .blocking = true,
        .set_cookies_out = set_cookies_out,
    };
    ud.h2 = &self;
    errdefer self.deinit();

    const settings = [_]ng.nghttp2_settings_entry{
        .{ .settings_id = ng.NGHTTP2_SETTINGS_ENABLE_CONNECT_PROTOCOL, .value = 1 },
    };
    if (ng.nghttp2_submit_settings(sess, ng.NGHTTP2_FLAG_NONE, &settings, settings.len) != 0)
        return error.H2InitFailed;
    try self.flushSession();
    try self.pumpUntilRemoteConnectProtocol();

    var path_buf: [512]u8 = undefined;
    const full_path = if (search.len > 0)
        try std.fmt.bufPrint(&path_buf, "{s}{s}", .{ path, search })
    else
        path;

    var nva_list: [16]ng.nghttp2_nv = undefined;
    var nva_len: usize = 0;

    nva_list[nva_len] = makeNv(":method", "CONNECT");
    nva_len += 1;
    nva_list[nva_len] = makeNv(":protocol", "websocket");
    nva_len += 1;
    nva_list[nva_len] = makeNv(":path", full_path);
    nva_len += 1;
    nva_list[nva_len] = makeNv(":authority", url_host);
    nva_len += 1;
    nva_list[nva_len] = makeNv(":scheme", "https");
    nva_len += 1;

    if (origin.len > 0 and !std.mem.eql(u8, origin, "null")) {
        nva_list[nva_len] = makeNv("origin", origin);
        nva_len += 1;
    }

    nva_list[nva_len] = makeNv("user-agent", default_user_agent);
    nva_len += 1;
    nva_list[nva_len] = makeNv("sec-websocket-version", "13");
    nva_len += 1;

    if (protocols.len > 0) {
        const joined = try std.mem.join(allocator, ", ", protocols);
        self.protocol_header = joined;
        nva_list[nva_len] = makeNv("sec-websocket-protocol", joined);
        nva_len += 1;
    }

    const sid = try submitConnectStream(sess, nva_list[0..nva_len]);
    self.stream_id = sid;

    try self.flushSession();
    try self.pumpUntilHandshake();

    self.blocking = false;
    return self;
}

pub fn deinit(self: *H2WsSession) void {
    if (self.pending_send) |buf| self.allocator.free(buf);
    ng.nghttp2_session_del(self.session);
    ng.nghttp2_session_callbacks_del(self.callbacks);
    if (self.protocol_header) |p| self.allocator.free(p);
    if (self.negotiated_protocol.len > 0) self.allocator.free(self.negotiated_protocol);
    self.allocator.destroy(self.user_data);
}

pub fn pump(self: *H2WsSession) !void {
    if (self.blocking) {
        try self.blockingPump();
    } else {
        try self.nonblockingPump();
    }
}

fn blockingPump(self: *H2WsSession) !void {
    var tls_buf: [16384]u8 = undefined;
    while (true) {
        const n = try self.tls.readBlocking(&tls_buf);
        if (n == 0) return error.ConnectionClosed;
        const consumed = ng.nghttp2_session_mem_recv(self.session, tls_buf[0..n].ptr, n);
        if (consumed < 0) return error.H2ProtocolError;
        try self.flushSession();
        if (self.handshake_done) return;
        return;
    }
}

fn nonblockingPump(self: *H2WsSession) !void {
    var tls_buf: [16384]u8 = undefined;
    const n = self.tls.read(&tls_buf) catch |err| switch (err) {
        error.WouldBlock => return,
        else => return err,
    };
    if (n == 0) return error.ConnectionClosed;
    const consumed = ng.nghttp2_session_mem_recv(self.session, tls_buf[0..n].ptr, n);
    if (consumed < 0) return error.H2ProtocolError;
    try self.flushSession();
}

pub fn submitBytes(self: *H2WsSession, data: []const u8) !void {
    if (self.pending_send != null) return error.H2Busy;

    const owned = try self.allocator.dupe(u8, data);
    errdefer self.allocator.free(owned);

    self.pending_send = owned;
    self.pending_send_pos = 0;

    var provider = ng.nghttp2_data_provider2{
        .source = .{ .ptr = @ptrCast(self) },
        .read_callback = dataReadCallback,
    };

    const rv = ng.nghttp2_submit_data2(self.session, ng.NGHTTP2_FLAG_NONE, self.stream_id, &provider);
    if (rv != 0) {
        self.allocator.free(owned);
        self.pending_send = null;
        self.pending_send_pos = 0;
        return error.H2SubmitFailed;
    }
    try self.flushSession();
}

fn pumpUntilRemoteConnectProtocol(self: *H2WsSession) !void {
    var attempts: u32 = 0;
    while (!self.remote_settings_seen or
        ng.nghttp2_session_get_remote_settings(self.session, ng.NGHTTP2_SETTINGS_ENABLE_CONNECT_PROTOCOL) == 0)
    {
        try self.pump();
        attempts += 1;
        if (attempts > 64) return error.H2SettingsTimeout;
    }
}

fn pumpUntilHandshake(self: *H2WsSession) !void {
    var attempts: u32 = 0;
    while (!self.handshake_done) {
        try self.blockingPump();
        attempts += 1;
        if (attempts > 32) return error.H2HandshakeTimeout;
        if (self.goaway_received) return error.H2ProtocolError;
        if (self.handshake_failed) return error.H2ConnectRejected;
        if (self.response_status != 0 and self.response_status != 200) return error.H2ConnectRejected;
    }
}

fn flushSession(self: *H2WsSession) !void {
    while (ng.nghttp2_session_want_write(self.session) != 0) {
        const rv = ng.nghttp2_session_send(self.session);
        if (rv == ng.NGHTTP2_ERR_WOULDBLOCK) return;
        if (rv != 0) return error.H2SendFailed;
    }
}

fn submitConnectStream(sess: *ng.nghttp2_session, nva: []ng.nghttp2_nv) !i32 {
    const sid = ng.nghttp2_submit_request(sess, null, nva.ptr, nva.len, null, null);
    if (sid >= 0) return sid;

    const hdr_sid = ng.nghttp2_submit_headers(
        sess,
        ng.NGHTTP2_FLAG_NONE,
        -1,
        null,
        nva.ptr,
        nva.len,
        null,
    );
    if (hdr_sid < 0) return error.H2ConnectFailed;
    return hdr_sid;
}

fn makeNv(name: []const u8, value: []const u8) ng.nghttp2_nv {
    return .{
        .name = @constCast(name.ptr),
        .namelen = name.len,
        .value = @constCast(value.ptr),
        .valuelen = value.len,
        .flags = ng.NGHTTP2_NV_FLAG_NONE,
    };
}

fn sendCallback(
    session: ?*ng.nghttp2_session,
    data: [*c]const u8,
    length: usize,
    flags: c_int,
    user_data: ?*anyopaque,
) callconv(.c) ng.nghttp2_ssize {
    _ = session;
    _ = flags;
    const ud: *UserData = @ptrCast(@alignCast(user_data));
    const h2 = ud.h2;
    const slice = @as([*]const u8, @ptrCast(data))[0..length];
    if (h2.blocking) {
        h2.tls.writeBlocking(slice) catch return ng.NGHTTP2_ERR_CALLBACK_FAILURE;
        return @intCast(length);
    }
    var pos: usize = 0;
    while (pos < slice.len) {
        const written = h2.tls.write(slice[pos..]) catch return ng.NGHTTP2_ERR_CALLBACK_FAILURE;
        if (written == 0) return ng.NGHTTP2_ERR_WOULDBLOCK;
        pos += written;
    }
    return @intCast(length);
}

fn onFrameRecv(
    session: ?*ng.nghttp2_session,
    frame: [*c]const ng.nghttp2_frame,
    user_data: ?*anyopaque,
) callconv(.c) c_int {
    _ = session;
    const ud: *UserData = @ptrCast(@alignCast(user_data));
    const h2 = ud.h2;
    const frame_type = frame.*.hd.type;
    if (frame_type == ng.NGHTTP2_SETTINGS and (frame.*.hd.flags & ng.NGHTTP2_FLAG_ACK) == 0) {
        h2.remote_settings_seen = true;
    } else if (frame_type == ng.NGHTTP2_GOAWAY) {
        if (!h2.handshake_done) h2.goaway_received = true;
    } else if (frame_type == ng.NGHTTP2_RST_STREAM) {
        if (frame.*.hd.stream_id == h2.stream_id and !h2.handshake_done) {
            h2.handshake_failed = true;
        }
    }
    return 0;
}

fn onStreamClose(
    session: ?*ng.nghttp2_session,
    stream_id: i32,
    error_code: u32,
    user_data: ?*anyopaque,
) callconv(.c) c_int {
    _ = session;
    _ = error_code;
    const ud: *UserData = @ptrCast(@alignCast(user_data));
    const h2 = ud.h2;
    if (stream_id == h2.stream_id and !h2.handshake_done) {
        h2.handshake_failed = true;
    }
    return 0;
}

fn onInvalidHeader(
    session: ?*ng.nghttp2_session,
    frame: [*c]const ng.nghttp2_frame,
    name: [*c]const u8,
    namelen: usize,
    value: [*c]const u8,
    valuelen: usize,
    flags: u8,
    user_data: ?*anyopaque,
) callconv(.c) c_int {
    _ = session;
    _ = frame;
    _ = name;
    _ = namelen;
    _ = value;
    _ = valuelen;
    _ = flags;
    _ = user_data;
    return 0;
}

fn onHeader(
    session: ?*ng.nghttp2_session,
    frame: [*c]const ng.nghttp2_frame,
    name: [*c]const u8,
    namelen: usize,
    value: [*c]const u8,
    valuelen: usize,
    flags: u8,
    user_data: ?*anyopaque,
) callconv(.c) c_int {
    _ = session;
    _ = flags;
    const ud: *UserData = @ptrCast(@alignCast(user_data));
    const h2 = ud.h2;
    const frame_ptr = frame.*;

    if (frame_ptr.hd.type != ng.NGHTTP2_HEADERS) return 0;
    if (frame_ptr.hd.stream_id != h2.stream_id) return 0;

    const hdr_name = name[0..namelen];
    const hdr_value = value[0..valuelen];

    switch (frame_ptr.headers.cat) {
        ng.NGHTTP2_HCAT_RESPONSE => {
            if (std.mem.eql(u8, hdr_name, ":status")) {
                h2.response_status = std.fmt.parseInt(i32, hdr_value, 10) catch 0;
                if (h2.response_status == 200) h2.handshake_done = true;
            } else if (std.ascii.eqlIgnoreCase(hdr_name, "sec-websocket-protocol")) {
                if (h2.negotiated_protocol.len > 0) h2.allocator.free(h2.negotiated_protocol);
                h2.negotiated_protocol = h2.allocator.dupe(u8, hdr_value) catch "";
            } else if (std.ascii.eqlIgnoreCase(hdr_name, "set-cookie")) {
                const duped = h2.allocator.dupe(u8, hdr_value) catch return 0;
                h2.set_cookies_out.append(h2.allocator, duped) catch {
                    h2.allocator.free(duped);
                };
            }
        },
        ng.NGHTTP2_HCAT_HEADERS => {
            if (std.ascii.eqlIgnoreCase(hdr_name, "set-cookie")) {
                const duped = h2.allocator.dupe(u8, hdr_value) catch return 0;
                h2.set_cookies_out.append(h2.allocator, duped) catch {
                    h2.allocator.free(duped);
                };
            }
        },
        else => {},
    }

    return 0;
}

fn onDataChunk(
    session: ?*ng.nghttp2_session,
    flags: u8,
    stream_id: i32,
    data: [*c]const u8,
    len: usize,
    user_data: ?*anyopaque,
) callconv(.c) c_int {
    _ = session;
    _ = flags;
    const ud: *UserData = @ptrCast(@alignCast(user_data));
    const h2 = ud.h2;
    if (stream_id != h2.stream_id) return 0;
    const chunk = data[0..len];
    const reader = h2.reader;
    if (reader.len + chunk.len > reader.buf.len) return ng.NGHTTP2_ERR_CALLBACK_FAILURE;
    @memcpy(reader.buf[reader.len..][0..chunk.len], chunk);
    reader.len += chunk.len;
    return 0;
}

fn dataReadCallback(
    session: ?*ng.nghttp2_session,
    stream_id: i32,
    buf: [*c]u8,
    length: usize,
    data_flags: [*c]u32,
    source: [*c]ng.nghttp2_data_source,
    user_data: ?*anyopaque,
) callconv(.c) ng.nghttp2_ssize {
    _ = session;
    _ = stream_id;
    _ = user_data;
    const h2: *H2WsSession = @ptrCast(@alignCast(source[0].ptr));
    const pending = h2.pending_send orelse {
        data_flags[0] = ng.NGHTTP2_DATA_FLAG_EOF;
        return 0;
    };
    const remain = pending[h2.pending_send_pos..];
    const to_copy = @min(length, remain.len);
    @memcpy(@as([*]u8, @ptrCast(buf))[0..to_copy], remain[0..to_copy]);
    h2.pending_send_pos += to_copy;
    if (h2.pending_send_pos >= pending.len) {
        data_flags[0] = ng.NGHTTP2_DATA_FLAG_EOF;
        if (h2.pending_send) |owned| {
            h2.allocator.free(owned);
            h2.pending_send = null;
            h2.pending_send_pos = 0;
        }
    }
    return @intCast(to_copy);
}
