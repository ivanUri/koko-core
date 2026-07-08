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

const std = @import("std");
const assert = @import("../../support/assert.zig").assert;
const builtin = @import("builtin");

const js = @import("../js/js.zig");
const URL = @import("URL.zig");
const Notification = @import("../../runtime/Notification.zig");
const CookieJar = @import("../webapi/storage/Cookie.zig").Jar;

const http = @import("../../runtime/network/http.zig");
const libcurl = @import("../../support/sys/libcurl.zig");
const Network = @import("../../runtime/network/Network.zig");
const build_config = @import("build_config");
const Robots = @import("../../runtime/network/Robots.zig");
const timestamp = @import("../../support/datetime.zig").timestamp;

const log = @import("../../support/log.zig");
const posix = std.posix;
const Allocator = std.mem.Allocator;
const ArenaAllocator = std.heap.ArenaAllocator;
const IS_DEBUG = builtin.mode == .Debug;

pub const Method = http.Method;
pub const Headers = http.Headers;
pub const ResponseHead = http.ResponseHead;
pub const HeaderIterator = http.HeaderIterator;
const CachedResponse = @import("../../runtime/network/cache/Cache.zig").CachedResponse;

pub const CacheLayer = @import("../../runtime/network/layer/CacheLayer.zig");
pub const RobotsLayer = @import("../../runtime/network/layer/RobotsLayer.zig");
pub const WebBotAuthLayer = @import("../../runtime/network/layer/WebBotAuthLayer.zig");
pub const InterceptionLayer = @import("../../runtime/network/layer/InterceptionLayer.zig");
const GoogleChromeTransport = @import("GoogleChromeTransport.zig");
const CurlCliTransport = @import("CurlCliTransport.zig");
const Session = @import("Session.zig");
const WebSocket = @import("../webapi/net/WebSocket.zig");

// This is loosely tied to a browser Page. Loading all the <scripts>, doing
// XHR requests, and loading imports all happens through here. Sine the app
// currently supports 1 browser and 1 frame at-a-time, we only have 1 Client and
// re-use it from frame to frame. This allows us better re-use of the various
// buffers/caches (including keepalive connections) that libcurl has.
//
// The app has other secondary http needs, like telemetry. While we want to
// share some things (namely the ca blob, and maybe some configuration
// (TODO: ??? should proxy settings be global ???)), we're able to call
// client.abortFrame() to abort the transfers being made by a frame, without
// impacting those other http requests.
pub const Client = @This();

// Count of active ws requests
ws_active: usize = 0,

// Count of active RTCPeerConnection instances
rtc_active: usize = 0,

// Count of active http requests
http_active: usize = 0,

// Real Chrome document fetches (Phase 2b); polled from tick(), not CDP stack.
chrome_jobs: std.DoublyLinkedList = .{},

// Our curl multi handle.
handles: http.Handles,

// Connections currently in this client's curl_multi.
in_use: std.DoublyLinkedList = .{},

// Connections that failed to be removed from curl_multi during perform.
dirty: std.DoublyLinkedList = .{},

// Whether we're currently inside a curl_multi_perform call.
performing: bool = false,

// Use to generate the next request ID
next_request_id: u32 = 0,

// When handles has no more available easys, requests get queued.
queue: std.DoublyLinkedList = .{},

// Queue is for Transfers that have no connection. ready_queue is for connections
// that were initiated when performing == true and thus need to wait until
// performing == false before being added. I'm hoping this is temporary and that
// we can unify the two queues. But HTTP is being changed a lot right now, and
// I'm trying to minimize the surface area.
ready_queue: std.DoublyLinkedList = .{},

// Google sg_ss= document hops stall in curl-impersonate multi; queued here and
// completed via blocking curl_easy_perform once performing == false.
sync_easy_queue: std.DoublyLinkedList = .{},

// Transfers with batchexecute body chunks waiting for post-perform delivery.
deferred_delivery: std.DoublyLinkedList = .{},

// Native WebSocket clients polled from tick() (not curl-impersonate).
native_ws: std.DoublyLinkedList = .{},

// The main app allocator
allocator: Allocator,

network: *Network,

// Once we have a handle/easy to process a request with, we create a Transfer
// which contains the Request as well as any state we need to process the
// request. These will come and go with each request.
transfer_pool: std.heap.MemoryPool(Transfer),

// The current proxy. CDP can change it, changeProxy(null) restores
// from config.
http_proxy: ?[:0]const u8 = null,

// track if the client use a proxy for connections.
// We can't use http_proxy because we want also to track proxy configured via
// CDP.
use_proxy: bool,

// Current TLS verification state, applied per-connection in makeRequest.
tls_verify: bool = true,

obey_robots: bool,

// User agent override set via CDP Emulation.setUserAgentOverride.
// When set, takes precedence over the config's http_headers values.
// Both fields are allocated from self.allocator when set, null otherwise.
user_agent_override: ?[:0]const u8 = null,
user_agent_header_override: ?[:0]const u8 = null,

cdp_client: ?CDPClient = null,

// Optional env for pumping schedulers during blocking syncRequest waits.
env: ?*js.Env = null,

max_response_size: usize,

cache_layer: CacheLayer,
robots_layer: RobotsLayer,
web_bot_auth_layer: WebBotAuthLayer,
interception_layer: InterceptionLayer,
entry_layer: Layer,

pub const Layer = struct {
    ptr: *anyopaque,
    vtable: *const VTable,

    pub const VTable = struct {
        request: *const fn (*anyopaque, *Client, Request) anyerror!void,
    };

    pub fn request(self: Layer, client: *Client, req: Request) !void {
        return self.vtable.request(self.ptr, client, req);
    }
};

fn layerWith(self: anytype, next: Layer) Layer {
    self.next = next;
    return self.layer();
}

// libcurl can monitor arbitrary sockets, this lets us use libcurl to poll
// both HTTP data as well as messages from an CDP connection.
// Furthermore, we have some tension between blocking scripts and request
// interception. For non-blocking scripts, because nothing blocks, we can
// just queue the scripts until we receive a response to the interception
// notification. But for blocking scripts (which block the parser), it's hard
// to return control back to the CDP loop. So the `read` function pointer is
// used by the Client to have the CDP client read more data from the socket,
// specifically when we're waiting for a request interception response to
// a blocking script.
pub const CDPClient = struct {
    socket: posix.socket_t,
    ctx: *anyopaque,
    blocking_read_start: *const fn (*anyopaque) bool,
    blocking_read: *const fn (*anyopaque) bool,
    blocking_read_end: *const fn (*anyopaque) bool,
};

pub fn init(self: *Client, allocator: Allocator, network: *Network, cdp_client: ?CDPClient) !void {
    var transfer_pool = std.heap.MemoryPool(Transfer).init(allocator);
    errdefer transfer_pool.deinit();

    var handles = try http.Handles.init(network.config);
    errdefer handles.deinit();

    const http_proxy = network.config.httpProxy();

    self.* = Client{
        .handles = handles,
        .network = network,
        .allocator = allocator,
        .transfer_pool = transfer_pool,
        .cdp_client = cdp_client,

        .use_proxy = http_proxy != null,
        .http_proxy = http_proxy,
        .tls_verify = network.config.tlsVerifyHost(),
        .obey_robots = network.config.obeyRobots(),
        .max_response_size = network.config.httpMaxResponseSize() orelse std.math.maxInt(u32),

        .cache_layer = .{},
        .robots_layer = .{ .allocator = allocator },
        .web_bot_auth_layer = .{},
        .interception_layer = .{},
        .entry_layer = undefined,
    };

    var next = self.layer();

    if (network.config.obeyRobots()) {
        next = layerWith(&self.robots_layer, next);
    }

    if (network.config.httpCacheDir() != null) {
        next = layerWith(&self.cache_layer, next);
    }

    next = layerWith(&self.interception_layer, next);

    if (network.config.webBotAuth() != null) {
        next = layerWith(&self.web_bot_auth_layer, next);
    }

    self.entry_layer = next;
}

pub fn deinit(self: *Client) void {
    self.abort();
    self.handles.deinit();

    self.transfer_pool.deinit();
    self.clearUserAgentOverride();

    self.robots_layer.deinit(self.allocator);
}

pub fn deinitSafe(self: ?*Client) void {
    const client = self orelse return;
    client.deinit();
}

pub fn layer(self: *Client) Layer {
    return .{
        .ptr = self,
        .vtable = &.{ .request = _request },
    };
}

// Set a user agent override. Both the raw UA string and the pre-formatted
// "User-Agent: <ua>" header string are allocated from self.allocator.
pub fn setUserAgentOverride(self: *Client, ua: []const u8) !void {
    self.clearUserAgentOverride();
    const override = try self.allocator.dupeZ(u8, ua);
    errdefer self.allocator.free(override);
    const header = try std.fmt.allocPrintSentinel(self.allocator, "User-Agent: {s}", .{ua}, 0);
    self.user_agent_override = override;
    self.user_agent_header_override = header;
}

// Clear any user agent override, restoring the default from config.
pub fn clearUserAgentOverride(self: *Client) void {
    if (self.user_agent_override) |ua| {
        self.allocator.free(ua);
        self.user_agent_override = null;
    }
    if (self.user_agent_header_override) |uah| {
        self.allocator.free(uah);
        self.user_agent_header_override = null;
    }
}

// Enable TLS verification on all connections.
pub fn setTlsVerify(self: *Client, verify: bool) !void {
    // Remove inflight connections check on enable TLS b/c chromiumoxide calls
    // the command during navigate and Curl seems to accept it...

    var it = self.in_use.first;
    while (it) |node| : (it = node.next) {
        const conn: *http.Connection = @fieldParentPtr("node", node);
        try conn.setTlsVerify(verify, self.use_proxy);
    }

    it = self.ready_queue.first;
    while (it) |node| : (it = node.next) {
        const conn: *http.Connection = @fieldParentPtr("node", node);
        try conn.setTlsVerify(verify, self.use_proxy);
    }

    self.tls_verify = verify;
}

// Restrictive since it'll only work if there are no inflight requests. In some
// cases, the libcurl documentation is clear that changing settings while a
// connection is inflight is undefined. It doesn't say anything about CURLOPT_PROXY,
// but better to be safe than sorry.
// For now, this restriction is ok, since it's only called by CDP on
// createBrowserContext, at which point, if we do have an active connection,
// that's probably a bug (a previous abort failed?). But if we need to call this
// at any point in time, it could be worth digging into libcurl to see if this
// can be changed at any point in the easy's lifecycle.
pub fn changeProxy(self: *Client, proxy: ?[:0]const u8) !void {
    try self.ensureNoActiveConnection();
    self.http_proxy = proxy orelse self.network.config.httpProxy();
    self.use_proxy = self.http_proxy != null;
}

pub fn newHeaders(self: *const Client) !http.Headers {
    if (comptime build_config.curl_impersonate) {
        // Document nav: curl default_headers + small overrides. Subresources: full override list.
        return http.Headers.initEmpty();
    }
    const headers = &self.network.config.http_headers;
    const ua_header = self.user_agent_header_override orelse headers.user_agent_header;
    return http.Headers.init(ua_header, headers.sec_ch_ua_header, headers.accept_language_header);
}

pub fn getUserAgentHeader(self: *const Client) [:0]const u8 {
    return self.user_agent_header_override orelse self.network.config.http_headers.user_agent_header;
}

pub fn getUserAgent(self: *const Client) [:0]const u8 {
    return self.user_agent_override orelse self.network.config.http_headers.user_agent;
}

const AbortOpts = struct {
    scope: enum { normal, full } = .normal,
    /// When true, in-flight `.document` transfers for the frame are left alone.
    /// Used when `location.href` is scheduled mid-parse: aborting the document
    /// transfer inside an HTTP data_callback cannot run frame done/error handlers
    /// reentrantly (see `Transfer.kill`), which would strand parse in
    /// `.html_streaming`.
    skip_document: bool = false,
    /// When true, in-flight `.xhr` transfers for the frame are left alone.
    /// Google batchexecute (rt=c) schedules navigation from a LOADING
    /// readystatechange handler; aborting that XHR inside the same
    /// data_callback noops done_callback and strands MI613e before rs=4.
    skip_xhr: bool = false,
};

fn shouldAbortTransfer(params: *const RequestParams, opts: AbortOpts) bool {
    if (params.keepalive) return false;
    if (opts.scope != .full and params.protect_from_abort) return false;
    if (opts.skip_document and params.resource_type == .document) return false;
    if (opts.skip_xhr and params.resource_type == .xhr) return false;
    return true;
}

pub fn abort(self: *Client) void {
    self._abort(true, 0, .{ .scope = .full });
}

// abortFrame with .normal doesn't abort protect_from_abort requests.
// .full abort all relqtive requests.
pub fn abortFrame(self: *Client, frame_id: u32, opts: AbortOpts) void {
    self._abort(false, frame_id, opts);
}

// Clear `protect_from_abort` on every in-flight transfer for `frame_id`.
// Used by the deferred commit path (Frame.finalizePendingRootCommit): once
// the pending page has been committed, its in-flight navigation transfer no
// longer needs the abort shield. In the non-deferred path, the headerCallback
// flips the flag directly from `response.inner.transfer`; here we no longer
// hold that reference and must look the transfer up by frame_id. Safe to call
// when no matching transfer exists (e.g. the navigation already completed).
pub fn clearProtectForFrame(self: *Client, frame_id: u32) void {
    clearProtectInConnList(self.in_use, frame_id);
    clearProtectInConnList(self.ready_queue, frame_id);
    clearProtectInTransferQueue(self.queue, frame_id);
    clearProtectInTransferQueue(self.sync_easy_queue, frame_id);
}

/// True while a protected batchexecute XHR is still in flight for `frame_id`.
/// Excludes `.document` transfers (pending root nav carries `protect_from_abort`
/// too; counting those would deadlock deferred commit).
pub fn hasProtectedTransfersForFrame(self: *Client, frame_id: u32) bool {
    return protectedXhrInConnList(self.in_use, frame_id) or
        protectedXhrInConnList(self.ready_queue, frame_id) or
        protectedXhrInQueue(self.queue, frame_id) or
        protectedXhrInQueue(self.sync_easy_queue, frame_id);
}

fn protectedXhrInQueue(list: std.DoublyLinkedList, frame_id: u32) bool {
    var n = list.first;
    while (n) |node| : (n = node.next) {
        const transfer: *Transfer = @fieldParentPtr("_node", node);
        const p = transfer.req.params;
        if (p.frame_id == frame_id and p.protect_from_abort and p.resource_type == .xhr) {
            return true;
        }
    }
    return false;
}

fn protectedXhrInConnList(list: std.DoublyLinkedList, frame_id: u32) bool {
    var n = list.first;
    while (n) |node| : (n = node.next) {
        const conn: *http.Connection = @fieldParentPtr("node", node);
        switch (conn.transport) {
            .http => |transfer| {
                const p = transfer.req.params;
                if (p.frame_id == frame_id and p.protect_from_abort and p.resource_type == .xhr) {
                    return true;
                }
            },
            .websocket, .none => {},
        }
    }
    return false;
}

fn clearProtectInTransferQueue(list: std.DoublyLinkedList, frame_id: u32) void {
    var n = list.first;
    while (n) |node| : (n = node.next) {
        const transfer: *Transfer = @fieldParentPtr("_node", node);
        if (transfer.req.params.frame_id == frame_id) {
            transfer.req.params.protect_from_abort = false;
        }
    }
}

fn clearProtectInConnList(list: std.DoublyLinkedList, frame_id: u32) void {
    var n = list.first;
    while (n) |node| : (n = node.next) {
        const conn: *http.Connection = @fieldParentPtr("node", node);
        switch (conn.transport) {
            .http => |transfer| {
                if (transfer.req.params.frame_id == frame_id) {
                    transfer.req.params.protect_from_abort = false;
                }
            },
            .websocket, .none => {},
        }
    }
}

// Written this way so that both abort and abortFrame can share the same code
// but abort can avoid the frame_id check at comptime.
fn _abort(self: *Client, comptime abort_all: bool, frame_id: u32, opts: AbortOpts) void {
    abortChromeJobs(self, abort_all, frame_id, opts);
    abortNativeWebSockets(self, abort_all, frame_id);
    abortConnections(self.in_use, abort_all, frame_id, opts);
    abortConnections(self.ready_queue, abort_all, frame_id, opts);

    abortTransferQueue(&self.queue, abort_all, frame_id, opts);
    abortTransferQueue(&self.sync_easy_queue, abort_all, frame_id, opts);

    if (comptime abort_all) {
        self.queue = .{};
        self.ready_queue = .{};
        self.sync_easy_queue = .{};
    }

    if (comptime IS_DEBUG and abort_all) {
        var it = self.in_use.first;
        var leftover: usize = 0;
        while (it) |node| : (it = node.next) {
            const conn: *http.Connection = @fieldParentPtr("node", node);
            switch (conn.transport) {
                .http => |transfer| std.debug.assert(transfer.aborted),
                .websocket => {},
                .none => {},
            }
            leftover += 1;
        }
        std.debug.assert(self.http_active == leftover);
    }
}

fn abortTransferQueue(
    q: *std.DoublyLinkedList,
    comptime abort_all: bool,
    frame_id: u32,
    opts: AbortOpts,
) void {
    var n = q.first;
    while (n) |node| {
        n = node.next;
        const transfer: *Transfer = @fieldParentPtr("_node", node);
        const params = transfer.req.params;
        if (comptime abort_all) {
            transfer.kill();
        } else if (params.frame_id == frame_id and shouldAbortTransfer(&params, opts)) {
            q.remove(node);
            transfer.kill();
        }
    }
}

fn abortConnections(list: std.DoublyLinkedList, comptime abort_all: bool, frame_id: u32, opts: AbortOpts) void {
    var n = list.first;
    while (n) |node| {
        n = node.next;
        const conn: *http.Connection = @fieldParentPtr("node", node);
        switch (conn.transport) {
            .http => |transfer| {
                const params = transfer.req.params;
                if (comptime abort_all) {
                    transfer.kill();
                } else if (params.frame_id == frame_id and shouldAbortTransfer(&params, opts)) {
                    transfer.kill();
                }
            },
            .websocket => |ws| {
                if ((comptime abort_all) or ws._frame._frame_id == frame_id) {
                    ws.kill();
                }
            },
            .none => unreachable,
        }
    }
}

fn isGoogleAccountsBatchExecute(url: []const u8) bool {
    return std.mem.indexOf(u8, url, "accounts.google.") != null and
        std.mem.indexOf(u8, url, "batchexecute") != null;
}

fn skipJsonComma(s: []const u8) []const u8 {
    if (s.len > 0 and s[0] == ',') return s[1..];
    return s;
}

fn skipJsonQuotedString(s: []const u8) []const u8 {
    if (s.len == 0 or s[0] != '"') return s;
    var i: usize = 1;
    while (i < s.len) : (i += 1) {
        if (s[i] == '\\') {
            i += 1;
            continue;
        }
        if (s[i] == '"') return s[i + 1 ..];
    }
    return s;
}

fn parseJsonUIntPrefix(s: []const u8) struct { val: u32, len: usize } {
    var i: usize = 0;
    var val: u32 = 0;
    while (i < s.len and s[i] >= '0' and s[i] <= '9') : (i += 1) {
        val = val * 10 + (s[i] - '0');
    }
    return .{ .val = val, .len = i };
}

/// Boost `af.httprm` RTT field (4th array slot) so `rib.sya` EMA crosses 250ms post-browserinfo.
fn boostGoogleHttprmRttInChunk(arena: Allocator, chunk: []const u8, min_rtt: u32) ![]const u8 {
    const tag = "[\"af.httprm\",";
    var search_from: usize = 0;
    var changed = false;
    var out = try arena.alloc(u8, chunk.len + 32);
    var out_len: usize = 0;
    var last_copy: usize = 0;

    while (std.mem.indexOfPos(u8, chunk, search_from, tag)) |pos| {
        var cursor = chunk[pos + tag.len ..];
        const di = parseJsonUIntPrefix(cursor);
        if (di.len == 0) {
            search_from = pos + tag.len;
            continue;
        }
        cursor = skipJsonComma(cursor[di.len..]);
        cursor = skipJsonQuotedString(cursor);
        cursor = skipJsonComma(cursor);
        const rtt = parseJsonUIntPrefix(cursor);
        if (rtt.len == 0 or rtt.val >= min_rtt) {
            search_from = pos + tag.len;
            continue;
        }

        const tag_and_di_end = pos + tag.len + di.len;
        const after_di = chunk[tag_and_di_end..];
        const hash_field_len = after_di.len - skipJsonQuotedString(skipJsonComma(after_di)).len;
        const rtt_start = tag_and_di_end + hash_field_len + 1;
        const rtt_end = rtt_start + rtt.len;

        std.mem.copyForwards(u8, out[out_len..], chunk[last_copy..rtt_start]);
        out_len += rtt_start - last_copy;
        const boosted = try std.fmt.bufPrint(out[out_len..], "{d}", .{min_rtt});
        out_len += boosted.len;
        last_copy = rtt_end;
        search_from = rtt_end;
        changed = true;
    }

    if (!changed) return chunk;
    std.mem.copyForwards(u8, out[out_len..], chunk[last_copy..]);
    out_len += chunk.len - last_copy;
    return out[0..out_len];
}

const GoogleSigninDebug = @import("GoogleSigninDebug.zig");

const SIGNIN_HTTPPRM_RTT_ENV = "VELORA_SIGNIN_HTTPPRM_RTT";
const BATCHEXECUTE_SYNC_DELIVERY_ENV = "VELORA_BATCHEXECUTE_SYNC_DELIVERY";

fn batchexecuteSyncDeliveryEnabled() bool {
    const value = std.posix.getenv(BATCHEXECUTE_SYNC_DELIVERY_ENV) orelse return false;
    return value.len > 0 and !std.mem.eql(u8, value, "0") and !std.mem.eql(u8, value, "false");
}

fn traceSigninHttprmDelivery(transfer: *Transfer, chunk: []const u8) void {
    if (!GoogleSigninDebug.httprmTraceEnabled()) return;
    if (std.mem.indexOf(u8, transfer.url, "accounts.google.") == null) return;
    if (std.mem.indexOf(u8, chunk, "af.httprm") == null) return;
    const tag = "[\"af.httprm\",";
    var rtt: ?u32 = null;
    if (std.mem.indexOf(u8, chunk, tag)) |pos| {
        var cursor = chunk[pos + tag.len ..];
        const di = parseJsonUIntPrefix(cursor);
        if (di.len > 0) {
            cursor = skipJsonComma(cursor[di.len..]);
            cursor = skipJsonQuotedString(cursor);
            cursor = skipJsonComma(cursor);
            const parsed = parseJsonUIntPrefix(cursor);
            if (parsed.len > 0) rtt = parsed.val;
        }
    }
    log.warn(.http, "signin.httprm.delivery", .{
        .url = transfer.url,
        .chunk_len = chunk.len,
        .rtt = rtt,
    });
}

fn signinHttprmRttOverride() ?u32 {
    const value = std.posix.getenv(SIGNIN_HTTPPRM_RTT_ENV) orelse return null;
    if (value.len == 0 or std.mem.eql(u8, value, "0")) return null;
    return std.fmt.parseInt(u32, value, 10) catch return null;
}

fn maybeBoostSigninHttprmChunk(transfer: *Transfer, chunk: []const u8) ![]const u8 {
    if (std.mem.indexOf(u8, transfer.url, "accounts.google.") == null) return chunk;
    if (std.mem.indexOf(u8, chunk, "af.httprm") == null) return chunk;

    if (signinHttprmRttOverride()) |forced_rtt| {
        // Parametric sweep: force browserinfo httprm RTT only (UEkKwb stays real).
        if (std.mem.indexOf(u8, transfer.url, "browserinfo") != null and
            std.mem.indexOf(u8, transfer.url, "UEkKwb") == null)
        {
            return boostGoogleHttprmRttInChunk(transfer.req.params.arena, chunk, forced_rtt);
        }
    }

    // Keep UEkKwb RTT low for browserinfo `[0,2,2]`. Do not boost browserinfo — Chrome passes real RTT (~25ms).
    if (std.mem.indexOf(u8, transfer.url, "UEkKwb") != null) return chunk;
    if (std.mem.indexOf(u8, transfer.url, "browserinfo") != null) return chunk;
    // Ablation: pass real httprm RTT on batchexecute/signinwithgoogleapps (Chrome does not boost to 800).
    if (std.mem.indexOf(u8, transfer.url, "signinwithgoogleapps") != null) return chunk;
    if (std.mem.indexOf(u8, transfer.url, "batchexecute") != null) return chunk;
    return chunk;
}

fn stretchPerformanceForSigninChunk(transfer: *Transfer, delta_ms: f64) void {
    _ = transfer;
    _ = delta_ms;
    // Ablation C: do not advance performance.now() on Google sign-in HTTP chunks.
}

fn stretchPerformanceForDeferredChunk(transfer: *Transfer) void {
    stretchPerformanceForSigninChunk(transfer, 200);
}

fn deliverChunkToUser(transfer: *Transfer, chunk: []const u8) void {
    if (isGoogleAccountsBatchExecute(transfer.url)) {
        stretchPerformanceForSigninChunk(transfer, 120);
    } else if (std.mem.indexOf(u8, transfer.url, "signinwithgoogleapps") != null) {
        stretchPerformanceForSigninChunk(transfer, 30);
    }
    traceSigninHttprmDelivery(transfer, chunk);
    const boosted = maybeBoostSigninHttprmChunk(transfer, chunk) catch |err| {
        transfer._callback_error = err;
        return;
    };
    transfer.req.data_callback(Response.fromTransfer(transfer), boosted) catch |err| {
        transfer._callback_error = err;
        return;
    };
    if (!transfer.aborted) transfer._streamed_to_user = true;
}

fn flushDeferredChunksForTransfer(transfer: *Transfer, all: bool) void {
    const deliver_one = struct {
        fn run(t: *Transfer) void {
            if (t.aborted or t._deferred_chunks.items.len == 0) return;
            stretchPerformanceForDeferredChunk(t);
            const chunk = t._deferred_chunks.items[0];
            _ = t._deferred_chunks.orderedRemove(0);
            deliverChunkToUser(t, chunk);
        }
    }.run;

    if (all) {
        transfer.client.deferred_delivery.remove(&transfer._deferred_node);
        while (transfer._deferred_chunks.items.len > 0 and !transfer.aborted) {
            deliver_one(transfer);
        }
        return;
    }

    deliver_one(transfer);
    if (transfer._deferred_chunks.items.len == 0) {
        transfer.client.deferred_delivery.remove(&transfer._deferred_node);
    }
}

fn flushDeferredChunkDeliveries(self: *Client) void {
    while (self.deferred_delivery.popFirst()) |node| {
        const transfer: *Transfer = @fieldParentPtr("_deferred_node", node);
        if (transfer.aborted or transfer._deferred_chunks.items.len == 0) continue;

        flushDeferredChunksForTransfer(transfer, false);

        if (transfer.aborted) continue;
        if (transfer._deferred_chunks.items.len > 0) {
            self.deferred_delivery.append(node);
        }
    }
}

pub fn tick(self: *Client, timeout_ms: u32) !PerformStatus {
    processChromeJobs(self);
    drainSyncEasyQueue(self);
    try pollNativeWebSockets(self);
    while (self.queue.popFirst()) |queue_node| {
        const conn = self.network.getConnection() orelse {
            self.queue.prepend(queue_node);
            break;
        };

        try self.makeRequest(conn, @fieldParentPtr("_node", queue_node));
    }

    return self.perform(@intCast(timeout_ms));
}

pub fn _request(ptr: *anyopaque, _: *Client, req: Request) !void {
    const self: *Client = @ptrCast(@alignCast(ptr));
    const transfer = try self.makeTransfer(req);
    return self.process(transfer);
}

pub fn request(self: *Client, req: Request) !void {
    // Assign Request Id.
    var our_req = req;
    our_req.params.request_id = self.incrReqId();

    const arena = try self.network.app.arena_pool.acquire(.small, "Request.arena");
    our_req.params.arena = arena;

    return self.entry_layer.request(self, our_req) catch |err| {
        our_req.error_callback(our_req.ctx, err);
        self.deinitRequest(our_req);
        return err;
    };
}

/// Google search document hop via real Chrome network (HTTP/3). Completes on tick().
pub fn requestChromeTransport(self: *Client, req: Request) !void {
    var our_req = req;
    our_req.params.request_id = self.incrReqId();

    const arena = try self.network.app.arena_pool.acquire(.small, "ChromeTransport.arena");
    our_req.params.arena = arena;

    const async_job = GoogleChromeTransport.AsyncJob.spawn(arena, our_req.params.url, our_req.params.headers) catch |err| {
        our_req.error_callback(our_req.ctx, err);
        self.network.app.arena_pool.release(arena);
        return err;
    };

    const job = try self.allocator.create(ChromeJob);
    job.* = .{
        .req = our_req,
        .async_job = async_job,
    };
    self.chrome_jobs.append(&job.node);
    self.http_active += 1;

    job.req.params.notification.dispatch(.http_request_start, &.{ .request = &job.req });
}

const ChromeJob = struct {
    node: std.DoublyLinkedList.Node = .{},
    req: Request,
    async_job: *GoogleChromeTransport.AsyncJob,

    fn deinit(self: *ChromeJob, client: *Client) void {
        self.async_job.deinit(client.allocator);
        client.deinitRequest(self.req);
        client.allocator.destroy(self);
    }
};

fn abortChromeJobs(self: *Client, comptime abort_all: bool, frame_id: u32, opts: AbortOpts) void {
    var n = self.chrome_jobs.first;
    while (n) |node| {
        const next = node.next;
        const job: *ChromeJob = @fieldParentPtr("node", node);
        const params = &job.req.params;
        if (comptime abort_all) {
            self.chrome_jobs.remove(node);
            self.http_active -= 1;
            job.async_job.aborted = true;
            job.req.error_callback(job.req.ctx, error.Abort);
            job.deinit(self);
        } else if (params.frame_id == frame_id and shouldAbortTransfer(params, opts)) {
            self.chrome_jobs.remove(node);
            self.http_active -= 1;
            job.async_job.aborted = true;
            job.req.error_callback(job.req.ctx, error.Abort);
            job.deinit(self);
        }
        n = next;
    }
}

fn processChromeJobs(self: *Client) void {
    var n = self.chrome_jobs.first;
    while (n) |node| {
        const next = node.next;
        const job: *ChromeJob = @fieldParentPtr("node", node);
        const poll = job.async_job.poll();
        switch (poll) {
            .running => {},
            .aborted => {
                self.chrome_jobs.remove(node);
                self.http_active -= 1;
                job.deinit(self);
            },
            .err => |err| {
                self.chrome_jobs.remove(node);
                self.http_active -= 1;
                job.req.params.notification.dispatch(.http_request_fail, &.{
                    .request = &job.req,
                    .err = err,
                });
                job.req.error_callback(job.req.ctx, err);
                job.deinit(self);
            },
            .document => |doc| {
                self.chrome_jobs.remove(node);
                self.http_active -= 1;
                completeChromeJob(job, doc) catch |err| {
                    job.req.params.notification.dispatch(.http_request_fail, &.{
                        .request = &job.req,
                        .err = err,
                    });
                    job.req.error_callback(job.req.ctx, err);
                };
                job.deinit(self);
            },
        }
        n = next;
    }
}

fn completeChromeJob(job: *ChromeJob, doc: GoogleChromeTransport.Document) !void {
    const arena = job.req.params.arena;
    const body = try arena.dupe(u8, doc.body);
    const content_type = try arena.dupe(u8, doc.content_type);
    const final_url = try arena.dupeZ(u8, doc.final_url);
    const headers = try arena.alloc(http.Header, 1);
    headers[0] = .{ .name = "content-type", .value = content_type };

    var fulfilled = FulfilledResponse{
        .status = doc.status,
        .url = final_url,
        .headers = headers,
        .body = body,
        .protocol = doc.protocol,
    };
    const response = Response.fromFulfilled(job.req.ctx, &fulfilled);

    job.req.params.notification.dispatch(.http_response_header_done, &.{
        .request = &job.req,
        .response = &response,
    });

    // Buffer body for CDP Network.getResponseBody before header_callback runs
    // commitPendingPage (which clears captured_responses on the root hop).
    job.req.params.notification.dispatch(.http_response_data, &.{
        .data = body,
        .request = &job.req,
    });
    try job.req.data_callback(response, body);

    const proceed = try job.req.header_callback(response);
    if (!proceed) return error.Abort;

    job.req.params.notification.dispatch(.http_request_done, &.{
        .request = &job.req,
        .content_length = body.len,
    });
    try job.req.done_callback(job.req.ctx);
}

const SyncContext = struct {
    allocator: Allocator,
    completion: union(enum) {
        in_progress: void,
        done: void,
        err: anyerror,
        shutdown: void,
    } = .in_progress,

    status: u16 = 0,
    content_type: ?[]const u8 = null,
    final_url: ?[:0]const u8 = null,
    body: std.ArrayList(u8),

    fn headerCallback(response: Response) anyerror!bool {
        const self: *SyncContext = @ptrCast(@alignCast(response.ctx));
        assert(response.status() != null, "HttpClient.SyncRequest.headerCallback", .{ .value = response.status() });
        self.status = response.status().?;
        const response_url = response.url();
        if (response_url.len > 0) {
            self.final_url = try self.allocator.dupeZ(u8, response_url);
        }
        if (response.contentType()) |ct| {
            self.content_type = try self.allocator.dupe(u8, ct);
        }
        if (response.contentLength()) |cl| {
            try self.body.ensureTotalCapacity(self.allocator, cl);
        }
        return true;
    }

    fn dataCallback(response: Response, data: []const u8) anyerror!void {
        const self: *SyncContext = @ptrCast(@alignCast(response.ctx));
        try self.body.appendSlice(self.allocator, data);
    }

    fn doneCallback(ctx: *anyopaque) anyerror!void {
        const self: *SyncContext = @ptrCast(@alignCast(ctx));
        self.completion = .done;
    }

    fn errorCallback(ctx: *anyopaque, err: anyerror) void {
        const self: *SyncContext = @ptrCast(@alignCast(ctx));
        self.completion = .{ .err = err };
    }

    fn shutdownCallback(ctx: *anyopaque) void {
        const self: *SyncContext = @ptrCast(@alignCast(ctx));
        self.completion = .shutdown;
    }
};

pub fn syncRequest(self: *Client, allocator: Allocator, params: RequestParams) !SyncResponse {
    var sync_ctx = SyncContext{ .allocator = allocator, .body = .empty };
    errdefer sync_ctx.body.deinit(allocator);

    try self.request(.{
        .params = params,
        .ctx = &sync_ctx,
        .header_callback = SyncContext.headerCallback,
        .data_callback = SyncContext.dataCallback,
        .done_callback = SyncContext.doneCallback,
        .error_callback = SyncContext.errorCallback,
        .shutdown_callback = SyncContext.shutdownCallback,
    });

    while (sync_ctx.completion == .in_progress) {
        const status = try self.tick(200);
        log.debug(.http, "sync request tick", .{ .status = status });
        if (self.env) |env| {
            env.pumpSchedulerTasks();
        }
        switch (status) {
            .cdp_socket => {
                const cdp = self.cdp_client.?;
                _ = cdp.blocking_read(cdp.ctx);
            },
            .normal => continue,
        }
    }

    switch (sync_ctx.completion) {
        .in_progress => @panic("Impossible to be in progress here."),
        .done, .shutdown => return .{
            .status = sync_ctx.status,
            .content_type = sync_ctx.content_type,
            .final_url = sync_ctx.final_url,
            .body = sync_ctx.body,
        },
        .err => |e| return e,
    }
}

// Above, request will not process if there's an interception request. In such
// cases, the interceptor is expected to call resume to continue the transfer
// or transfer.abort() to abort it.
fn process(self: *Client, transfer: *Transfer) !void {
    if (shouldSyncEasyPerform(transfer)) {
        if (self.performing) {
            self.sync_easy_queue.append(&transfer._node);
            return;
        }
        if (self.network.getConnection()) |conn| {
            return self.makeSyncEasyRequest(conn, transfer);
        }
        self.queue.append(&transfer._node);
        return;
    }

    // libcurl doesn't allow recursive calls, if we're in a `perform()` operation
    // then we _have_ to queue this.
    if (self.performing == false) {
        if (self.network.getConnection()) |conn| {
            return self.makeRequest(conn, transfer);
        }
    }

    self.queue.append(&transfer._node);
}

pub fn nextReqId(self: *Client) u32 {
    return self.next_request_id +% 1;
}

pub fn incrReqId(self: *Client) u32 {
    const id = self.next_request_id +% 1;
    self.next_request_id = id;
    return id;
}

fn makeTransfer(self: *Client, req: Request) !*Transfer {
    const transfer = try self.transfer_pool.create();
    errdefer self.transfer_pool.destroy(transfer);

    transfer.* = .{
        .start_time = timestamp(.monotonic),
        .id = req.params.request_id,
        .url = req.params.url,
        .req = req,
        .client = self,
    };
    return transfer;
}

fn requestFailed(transfer: *Transfer, err: anyerror, comptime execute_callback: bool) void {
    if (transfer._notified_fail) {
        // we can force a failed request within a callback, which will eventually
        // result in this being called again in the more general loop. We do this
        // because we can raise a more specific error inside a callback in some cases
        return;
    }

    transfer._notified_fail = true;

    if (execute_callback) {
        transfer.req.error_callback(transfer.req.ctx, err);
    } else if (transfer.req.shutdown_callback) |cb| {
        cb(transfer.req.ctx);
    }
}

// Same restriction as changeProxy. Should be ok since this is only called on
// BrowserContext deinit.
pub fn restoreOriginalProxy(self: *Client) !void {
    try self.ensureNoActiveConnection();

    self.http_proxy = self.network.config.httpProxy();
    self.use_proxy = self.http_proxy != null;
}

fn shouldSyncEasyPerform(transfer: *const Transfer) bool {
    if (comptime !build_config.curl_impersonate) return false;
    const req = &transfer.req;
    return req.params.resource_type == .document and
        std.mem.indexOf(u8, req.params.url, "sg_ss=") != null;
}

fn drainSyncEasyQueue(self: *Client) void {
    while (self.sync_easy_queue.popFirst()) |node| {
        const transfer: *Transfer = @fieldParentPtr("_node", node);
        const conn = self.network.getConnection() orelse {
            self.sync_easy_queue.prepend(node);
            break;
        };
        self.makeSyncEasyRequest(conn, transfer) catch |err| {
            transfer.req.error_callback(transfer.req.ctx, err);
            transfer.deinit();
        };
    }
}

fn makeSyncEasyRequest(self: *Client, conn: *http.Connection, transfer: *Transfer) !void {
    defer self.releaseConn(conn);

    if (comptime IS_DEBUG) {
        log.debug(.http, "sg_ss curl cli transport", .{ .url = transfer.req.params.url });
    }

    if (transfer.req.start_callback) |cb| {
        try cb(Response.fromTransfer(transfer));
    }

    const doc = CurlCliTransport.fetchSgSsDocument(
        transfer.req.params.arena,
        transfer.req.params.url,
        transfer.req.params.headers,
        self.getUserAgent(),
    ) catch |err| {
        transfer.requestFailed(err, true);
        transfer.deinit();
        return;
    };

    try completeCliDocument(transfer, doc);
    transfer.deinit();
}

fn completeCliDocument(transfer: *Transfer, doc: CurlCliTransport.Document) !void {
    const arena = transfer.req.params.arena;
    transfer.url = doc.final_url;

    const injected = try arena.alloc(http.Header, 1);
    injected[0] = .{ .name = "content-type", .value = doc.content_type };

    transfer.response_header = .{
        .url = doc.final_url,
        .status = doc.status,
        .redirect_count = doc.redirect_count,
        ._injected_headers = injected,
    };
    transfer._redirect_count = doc.redirect_count;
    if (doc.protocol) |p| {
        const len = @min(p.len, ResponseHead.MAX_PROTOCOL_LEN);
        transfer.response_header.?._protocol_len = len;
        @memcpy(transfer.response_header.?._protocol[0..len], p[0..len]);
    }
    const ct = doc.content_type;
    const ct_len = @min(ct.len, ResponseHead.MAX_CONTENT_TYPE_LEN);
    transfer.response_header.?._content_type_len = ct_len;
    @memcpy(transfer.response_header.?._content_type[0..ct_len], ct[0..ct_len]);

    transfer._performing = true;
    defer transfer._performing = false;

    const proceed = transfer.req.header_callback(Response.fromTransfer(transfer)) catch |err| {
        log.err(.http, "header_callback", .{ .err = err, .req = transfer });
        return err;
    };
    if (!proceed or transfer.aborted) {
        transfer.requestFailed(error.Abort, true);
        return error.Abort;
    }
    transfer._header_done_called = true;

    if (doc.body.len > 0) {
        try transfer.req.data_callback(Response.fromTransfer(transfer), doc.body);
        if (transfer.aborted) {
            transfer.requestFailed(error.Abort, true);
            return error.Abort;
        }
    }

    try transfer.req.done_callback(transfer.req.ctx);
}

fn makeRequest(self: *Client, conn: *http.Connection, transfer: *Transfer) anyerror!void {
    if (shouldSyncEasyPerform(transfer)) {
        return self.makeSyncEasyRequest(conn, transfer);
    }

    {
        // Reset per-response state for retries (auth challenge, queue).
        const auth = transfer._auth_challenge;
        transfer.reset();
        transfer._auth_challenge = auth;

        transfer._conn = conn;
        errdefer {
            transfer._conn = null;
            transfer.deinit();
            self.releaseConn(conn);
        }

        try transfer.configureConn(conn);
    }

    // As soon as this is called, our "perform" loop is responsible for
    // cleaning things up. That's why the above code is in a block. If anything
    // fails BEFORE `curl_multi_add_handle` succeeds, the we still need to do
    // cleanup. But if things fail after `curl_multi_add_handle`, we expect
    // perform to pickup the failure and cleanup.
    self.trackConn(conn) catch |err| {
        transfer._conn = null;
        transfer.deinit();
        return err;
    };

    if (transfer.req.start_callback) |cb| {
        cb(Response.fromTransfer(transfer)) catch |err| {
            transfer.deinit();
            return err;
        };
    }
    _ = try self.perform(0);
}

pub const PerformStatus = enum {
    cdp_socket,
    normal,
};

fn perform(self: *Client, timeout_ms: c_int) anyerror!PerformStatus {
    const running = blk: {
        self.performing = true;
        defer self.performing = false;

        break :blk try self.handles.perform();
    };

    // Process dirty connections — return them to Network pool.
    while (self.dirty.popFirst()) |node| {
        const conn: *http.Connection = @fieldParentPtr("node", node);
        self.handles.remove(conn) catch |err| {
            log.fatal(.http, "multi remove handle", .{ .err = err, .src = "perform" });
            @panic("multi_remove_handle");
        };
        self.releaseConn(conn);
    }

    // Connections scheduled while curl_multi_perform is active land in
    // ready_queue. Promote them into the multi handle and re-drive curl;
    // otherwise the transfer never starts (e.g. Google sg_ss root nav).
    var active = running;
    promote: while (true) {
        var promoted = false;
        while (self.ready_queue.popFirst()) |node| {
            const conn: *http.Connection = @fieldParentPtr("node", node);
            try self.trackConn(conn);
            promoted = true;
            if (comptime IS_DEBUG) {
                const url = switch (conn.transport) {
                    .http => |t| t.req.params.url,
                    else => "?",
                };
                log.debug(.http, "ready_queue promote", .{ .url = url });
            }
        }
        if (!promoted) break :promote;
        self.performing = true;
        defer self.performing = false;
        active = try self.handles.perform();
        if (try self.processMessages()) {
            return .normal;
        }
    }

    // We're potentially going to block for a while until we get data. Process
    // whatever messages we have waiting ahead of time.
    if (try self.processMessages()) {
        return .normal;
    }

    var status = PerformStatus.normal;
    const should_poll = self.cdp_client != null or active > 0 or self.http_active > 0 or self.native_ws.first != null;
    if (should_poll) {
        if (self.cdp_client) |cdp_client| {
            var wait_fds = [_]http.WaitFd{.{
                .fd = cdp_client.socket,
                .events = .{ .pollin = true },
                .revents = .{},
            }};
            try self.handles.poll(&wait_fds, timeout_ms);
            if (wait_fds[0].revents.pollin or wait_fds[0].revents.pollpri or wait_fds[0].revents.pollout) {
                status = .cdp_socket;
            }
        } else {
            try self.handles.poll(&.{}, timeout_ms);
        }

        // Network.zig does perform → poll → perform → completions. Without the
        // post-poll perform, newly added handles (e.g. Google sg_ss root nav)
        // never register sockets / receive headers before info_read.
        if (self.http_active > 0) {
            self.performing = true;
            defer self.performing = false;
            _ = try self.handles.perform();
            if (try self.processMessages()) {
                return .normal;
            }
        }
    }

    _ = try self.processMessages();
    try pollNativeWebSockets(self);
    drainSyncEasyQueue(self);
    flushDeferredChunkDeliveries(self);
    return status;
}

pub fn trackNativeWebSocket(self: *Client, ws: *WebSocket) void {
    self.native_ws.append(&ws._poll_node);
    self.ws_active += 1;
}

pub fn untrackNativeWebSocket(self: *Client, ws: *WebSocket) void {
    if (self.native_ws.first == &ws._poll_node or ws._poll_node.prev != null or ws._poll_node.next != null) {
        self.native_ws.remove(&ws._poll_node);
        if (self.ws_active > 0) self.ws_active -= 1;
    }
}

fn pollNativeWebSockets(self: *Client) !void {
    var node = self.native_ws.first;
    while (node) |n| {
        const next = n.next;
        const ws: *WebSocket = @fieldParentPtr("_poll_node", n);
        _ = try ws.pollNative();
        node = next;
    }
}

fn abortNativeWebSockets(self: *Client, comptime abort_all: bool, frame_id: u32) void {
    var node = self.native_ws.first;
    while (node) |n| {
        const next = n.next;
        const ws: *WebSocket = @fieldParentPtr("_poll_node", n);
        if (comptime abort_all) {
            ws.kill();
        } else if (ws._frame._frame_id == frame_id) {
            ws.kill();
        }
        node = next;
    }
}

fn processOneMessage(self: *Client, msg: http.Handles.MultiMessage, transfer: *Transfer) !bool {
    if (msg.err == null or msg.err.? == error.RecvError) {
        transfer.detectAuthChallenge(msg.conn);
    }

    // In case of auth challenge
    // TODO give a way to configure the number of auth retries.
    if (transfer._auth_challenge != null and transfer._tries < 10) {
        var wait_for_interception = false;
        transfer.req.params.notification.dispatch(
            .http_request_auth_required,
            &.{ .transfer = transfer, .wait_for_interception = &wait_for_interception },
        );
        if (wait_for_interception) {
            self.interception_layer.intercepted += 1;
            if (comptime IS_DEBUG) {
                log.debug(.http, "wait for auth interception", .{ .intercepted = self.interception_layer.intercepted });
            }

            // Whether or not this is a blocking request, we're not going
            // to process it now. We can end the transfer, which will
            // release the easy handle back into the pool. The transfer
            // is still valid/alive (just has no handle).
            transfer.releaseConn();
            return false;
        }
    }

    // Handle redirects: reuse the same connection to preserve TCP state.
    if (msg.err == null) {
        const status = try msg.conn.getResponseCode();
        if (status >= 300 and status <= 399 and status != 304) {
            try transfer.handleRedirect();

            const conn = transfer._conn.?;

            try self.handles.remove(conn);
            transfer._conn = null;
            transfer._detached_conn = conn; // signal orphan for processMessages cleanup

            transfer.reset();
            try transfer.configureConn(conn);
            try self.handles.add(conn);
            transfer._detached_conn = null;
            transfer._conn = conn; // reattach after successful re-add

            _ = try self.perform(0);

            return false;
        }

        // 421 Misdirected Request: retry once on a fresh connection (Fetch spec).
        if (status == 421 and transfer._misdirected_retries == 0) {
            try transfer.handleMisdirectedRetry();
            _ = try self.perform(0);
            return false;
        }
    }

    // Transfer is done (success or error). Caller (processMessages) owns deinit.
    // Return true = done (caller will deinit), false = continues (redirect/auth).

    // When the server closes the TLS onnection without a close_notify alert,
    // BoringSSL reports RecvError. If we already received valid HTTP headers,
    // this is a normal end-of-body (the connection closure signals the end
    // of the response per HTTP/1.1 when there is no Content-Length).
    // We must check this before endTransfer, which may reset the easy handle.
    const is_conn_close_recv = blk: {
        const err = msg.err orelse break :blk false;
        if (err != error.RecvError and err != error.ChunkFailed) break :blk false;
        if (msg.conn.getResponseHeader("transfer-encoding", 0)) |te| {
            if (std.mem.indexOf(u8, te.value, "chunked") != null) break :blk false;
        }
        if (transfer.getContentLength() != null) break :blk false;
        const hdr = msg.conn.getResponseHeader("connection", 0) orelse break :blk true;
        break :blk std.ascii.eqlIgnoreCase(hdr.value, "close");
    };

    // make sure the transfer can't be immediately aborted from a callback
    // since we still need it here.
    transfer._performing = true;
    defer transfer._performing = false;

    if (msg.err != null and !is_conn_close_recv) {
        transfer.requestFailed(transfer._callback_error orelse msg.err.?, true);
        return true;
    }

    if (!transfer._header_done_called) {
        // In case of request w/o data, we need to call the header done
        // callback now.
        const proceed = try transfer.headerDoneCallback(msg.conn);
        if (!proceed) {
            transfer.requestFailed(error.Abort, true);
            return true;
        }
    }

    if (transfer._deferred_chunks.items.len > 0) {
        flushDeferredChunksForTransfer(transfer, true);
        if (transfer.aborted) {
            transfer.requestFailed(error.Abort, true);
            return true;
        }
    }

    // Streamed responses already invoked data_callback per chunk. Replay only
    // when the body never arrived (empty) or streaming was skipped.
    if (!transfer._streamed_to_user and transfer._stream_buffer.items.len > 0) {
        try transfer.req.data_callback(Response.fromTransfer(transfer), transfer._stream_buffer.items);

        if (transfer.aborted) {
            transfer.requestFailed(error.Abort, true);
            return true;
        }
    }

    // release conn ASAP so that it's available; some done_callbacks
    // will load more resources.
    transfer.releaseConn();

    try transfer.req.done_callback(transfer.req.ctx);

    return true;
}

fn processMessages(self: *Client) !bool {
    var processed = false;
    while (try self.handles.readMessage()) |msg| {
        switch (msg.conn.transport) {
            .http => |transfer| {
                const done = self.processOneMessage(msg, transfer) catch |err| blk: {
                    log.err(.http, "process_messages", .{ .err = err, .req = transfer });
                    transfer.requestFailed(err, true);
                    if (transfer._detached_conn) |c| {
                        // Conn was removed from handles during redirect reconfiguration
                        // but not re-added. Release it directly to avoid double-remove.
                        self.in_use.remove(&c.node);
                        self.http_active -= 1;
                        self.releaseConn(c);
                        transfer._detached_conn = null;
                    }
                    break :blk true;
                };
                if (done) {
                    transfer.deinit();
                    processed = true;
                }
            },
            .websocket => |ws| {
                // ws_active will be decremented through the call to disconnected
                if (msg.err) |err| switch (err) {
                    error.GotNothing => ws.disconnected(null),
                    else => ws.disconnected(err),
                } else {
                    // Clean close - no error
                    ws.disconnected(null);
                }

                processed = true;
            },
            .none => unreachable,
        }
    }
    return processed;
}

pub fn trackConn(self: *Client, conn: *http.Connection) !void {
    if (self.performing) {
        conn.in_use = false;
        self.ready_queue.append(&conn.node);
        return;
    }

    self.in_use.append(&conn.node);
    conn.in_use = true;
    // Set private pointer so readMessage can find the Connection.
    // Must be done each time since curl_easy_reset clears it when
    // connections are returned to pool.
    conn.setPrivate(conn) catch |err| {
        self.in_use.remove(&conn.node);
        conn.in_use = false;
        self.releaseConn(conn);
        return err;
    };
    self.handles.add(conn) catch |err| {
        self.in_use.remove(&conn.node);
        conn.in_use = false;
        self.releaseConn(conn);
        return err;
    };
    conn.in_multi = true;

    switch (conn.transport) {
        .http => self.http_active += 1,
        .websocket => self.ws_active += 1,
        else => unreachable,
    }
}

pub fn removeConn(self: *Client, conn: *http.Connection) void {
    if (conn.in_use == false) {
        self.ready_queue.remove(&conn.node);
        self.releaseConn(conn);
        return;
    }

    self.in_use.remove(&conn.node);
    conn.in_use = false;
    switch (conn.transport) {
        .http => self.http_active -= 1,
        .websocket => self.ws_active -= 1,
        else => unreachable,
    }
    if (!conn.in_multi) {
        conn.in_multi = false;
        self.releaseConn(conn);
        return;
    }
    conn.in_multi = false;
    if (self.handles.remove(conn)) {
        self.releaseConn(conn);
    } else |_| {
        // Can happen if we're in a perform() call, so we'll queue this
        // for cleanup later.
        self.dirty.append(&conn.node);
    }
}

fn releaseConn(self: *Client, conn: *http.Connection) void {
    self.network.releaseConnection(conn);
}

pub fn trackRtcPeerConnection(self: *Client) void {
    self.rtc_active += 1;
}

pub fn untrackRtcPeerConnection(self: *Client) void {
    if (self.rtc_active > 0) self.rtc_active -= 1;
}

fn ensureNoActiveConnection(self: *const Client) !void {
    if (self.http_active > 0 or self.ws_active > 0 or self.rtc_active > 0) {
        return error.InflightConnection;
    }
}

pub const RequestParams = struct {
    /// This is unsafe to access until you pass it to `Client.request()` where it gets assigned.
    arena: Allocator = undefined,
    /// This is unsafe to access until you pass it to `Client.request()` where it gets assigned.
    request_id: u32 = undefined,

    frame_id: u32,
    loader_id: u32,
    method: Method,
    /// When set, overrides `method` for the on-the-wire request line (e.g. "Chicken").
    custom_method: ?[:0]const u8 = null,
    url: [:0]const u8,
    headers: http.Headers,
    body: ?[]const u8 = null,
    cookie_jar: ?*CookieJar,
    cookie_origin: [:0]const u8,
    /// Top-level browsing context for CHIPS partition keys and third-party blocking.
    top_level_cookie_url: ?[:0]const u8 = null,
    /// Top-level navigations (not embedded iframe loads) may carry SameSite=Lax cross-site.
    is_top_level_navigation: bool = false,
    resource_type: ResourceType,
    credentials: ?[:0]const u8 = null,
    notification: *Notification,
    /// Stable session pointer for redirect_policy_refresh when Frame ctx may be freed
    /// (superseding root navigation discards pending page mid-redirect).
    browser_session: ?*Session = null,
    timeout_ms: u32 = 0,

    // Set on an in-flight root-navigation transfer that was issued against a
    // pending Page. The old Page's frame.deinit (called from Session.commit
    // PendingPage when response headers arrive) calls abortFrame() on the
    // shared frame_id; abortFrame's default .normal scope skips transfers
    // with this flag so the callback chain we are sitting inside isn't killed
    // mid-flight. Session.discardPendingPage uses .full scope to override
    // the flag in failure paths.
    protect_from_abort: bool = false,
    /// Fetch keepalive / sendBeacon: must outlive the initiating document or worker.
    keepalive: bool = false,
    skip_cache: bool = false,
    /// Document navigation referer URL (without header prefix). With curl-impersonate
    /// default headers, Referer is set via CURLOPT_REFERER so JA4/H2 fingerprint stays chrome120.
    referer: ?[:0]const u8 = null, // null-terminated for CURLOPT_REFERER
    /// Guest Chrome omnibox search sends zero Cookie on sei=/sg_ss= document hops.
    omit_cookies: bool = false,
    /// Google search document hops omit Sec-Fetch-User; disable curl default_headers.
    omit_sec_fetch_user: bool = false,
    /// Rebuild headers + transport flags after an in-flight HTTP redirect (e.g. google sei=/sg_ss=).
    redirect_policy_refresh: ?*const fn (ctx: *anyopaque, transfer: *Transfer, prior_url: [:0]const u8) anyerror!void = null,
    /// When set, passed to `redirect_policy_refresh` instead of `req.ctx` (fetch redirect referrer).
    redirect_refresh_ctx: ?*anyopaque = null,
    /// Rebuild wire headers on redirect retry (configureConn, after curl detach).
    redirect_header_rebuild: ?*const fn (ctx: *anyopaque, transfer: *Transfer, conn: *http.Connection) anyerror!void = null,
    /// When false, skip curl-impersonate default_headers (fetch POST without Content-Type).
    curl_default_headers: bool = true,
    /// Use COPYPOSTFIELDS without CURLOPT_POST (no implicit Content-Type).
    raw_post_body: bool = false,
    /// HTTP cache revalidation validators (injected in configureConn).
    revalidate_etag: ?[]const u8 = null,
    revalidate_last_modified: ?[]const u8 = null,

    pub const ResourceType = enum {
        document,
        xhr,
        script,
        worker,
        fetch,
        beacon,
        image,

        // Allowed Values: Document, Stylesheet, Image, Media, Font, Script,
        // TextTrack, XHR, Fetch, Prefetch, EventSource, WebSocket, Manifest,
        // SignedExchange, Ping, CSPViolationReport, Preflight, FedCM, Other
        // https://chromedevtools.github.io/devtools-protocol/tot/Network/#type-ResourceType
        pub fn string(self: ResourceType) []const u8 {
            return switch (self) {
                .document => "Document",
                .xhr => "XHR",
                .script => "Script",
                .worker => "Script",
                .fetch => "Fetch",
                .beacon => "Ping",
                .image => "Image",
            };
        }
    };

    pub fn deinit(self: *const RequestParams) void {
        self.headers.deinit();
    }
};

pub const Request = struct {
    pub const StartCallback = *const fn (response: Response) anyerror!void;
    pub const HeaderCallback = *const fn (response: Response) anyerror!bool;
    pub const DataCallback = *const fn (response: Response, data: []const u8) anyerror!void;
    pub const DoneCallback = *const fn (ctx: *anyopaque) anyerror!void;
    pub const ErrorCallback = *const fn (ctx: *anyopaque, err: anyerror) void;
    pub const ShutdownCallback = *const fn (ctx: *anyopaque) void;

    params: RequestParams,
    // arbitrary data that can be associated with this request
    ctx: *anyopaque = undefined,

    start_callback: ?StartCallback = null,
    header_callback: HeaderCallback,
    data_callback: DataCallback,
    done_callback: DoneCallback,
    error_callback: ErrorCallback,
    shutdown_callback: ?ShutdownCallback = null,

    pub fn getCookieString(self: *Request) !?[:0]const u8 {
        if (self.params.omit_cookies) return null;
        const jar = self.params.cookie_jar orelse return null;
        var aw: std.Io.Writer.Allocating = .init(self.params.arena);
        try jar.forRequest(self.params.url, &aw.writer, .{
            .is_http = true,
            .origin_url = self.params.cookie_origin,
            .top_level_url = self.params.top_level_cookie_url orelse self.params.cookie_origin,
            .is_navigation = self.params.is_top_level_navigation,
        });
        const written = aw.written();
        if (written.len == 0) return null;
        try aw.writer.writeByte(0);
        return written.ptr[0..written.len :0];
    }

    pub fn deinit(self: *const Request) void {
        self.params.deinit();
    }
};

pub const FulfilledResponse = struct {
    status: u16,
    url: [:0]const u8,
    headers: []const http.Header,
    body: ?[]const u8,
    protocol: ?[]const u8 = null,

    pub fn contentType(self: *const FulfilledResponse) ?[]const u8 {
        for (self.headers) |hdr| {
            if (std.ascii.eqlIgnoreCase(hdr.name, "content-type")) return hdr.value;
        }
        return null;
    }
};

pub const Response = struct {
    ctx: *anyopaque,
    inner: union(enum) {
        transfer: *Transfer,
        cached: *const CachedResponse,
        fulfilled: *const FulfilledResponse,
    },

    pub fn fromTransfer(transfer: *Transfer) Response {
        return .{ .ctx = transfer.req.ctx, .inner = .{ .transfer = transfer } };
    }

    pub fn fromCached(ctx: *anyopaque, resp: *const CachedResponse) Response {
        return .{ .ctx = ctx, .inner = .{ .cached = resp } };
    }

    pub fn fromFulfilled(ctx: *anyopaque, fulfilled: *const FulfilledResponse) Response {
        return .{ .ctx = ctx, .inner = .{ .fulfilled = fulfilled } };
    }

    pub fn status(self: Response) ?u16 {
        return switch (self.inner) {
            .transfer => |t| if (t.response_header) |rh| rh.status else null,
            .cached => |c| c.metadata.status,
            .fulfilled => |f| f.status,
        };
    }

    pub fn contentType(self: Response) ?[]const u8 {
        return switch (self.inner) {
            .transfer => |t| if (t.response_header) |*rh| rh.contentType() else null,
            .cached => |c| c.metadata.content_type,
            .fulfilled => |f| f.contentType(),
        };
    }

    pub fn contentLength(self: Response) ?u32 {
        return switch (self.inner) {
            .transfer => |t| t.getContentLength(),
            .cached => |c| switch (c.data) {
                .buffer => |buf| @intCast(buf.len),
                .file => |f| @intCast(f.len),
            },
            .fulfilled => |f| if (f.body) |b| @intCast(b.len) else null,
        };
    }

    pub fn redirectCount(self: Response) ?u32 {
        return switch (self.inner) {
            .transfer => |t| if (t.response_header) |rh| rh.redirect_count else null,
            .cached, .fulfilled => 0,
        };
    }

    pub fn protocol(self: Response) ?[]const u8 {
        return switch (self.inner) {
            .transfer => |t| if (t.response_header) |*rh| rh.protocol() else null,
            .cached => null,
            .fulfilled => |f| f.protocol,
        };
    }

    pub fn url(self: Response) [:0]const u8 {
        return switch (self.inner) {
            .transfer => |t| t.url,
            .cached => |c| c.metadata.url,
            .fulfilled => |f| f.url,
        };
    }

    pub fn headerIterator(self: Response) HeaderIterator {
        return switch (self.inner) {
            .transfer => |t| t.responseHeaderIterator(),
            .cached => |c| HeaderIterator{ .list = .{ .list = c.metadata.headers } },
            .fulfilled => |f| HeaderIterator{ .list = .{ .list = f.headers } },
        };
    }

    pub fn abort(self: Response, err: anyerror) void {
        switch (self.inner) {
            .transfer => |t| t.abort(err),
            .cached, .fulfilled => {},
        }
    }

    pub fn format(self: Response, writer: *std.Io.Writer) !void {
        return switch (self.inner) {
            .transfer => |t| try t.format(writer),
            .cached => |c| try c.format(writer),
            .fulfilled => |f| try writer.print("fulfilled {s}", .{f.url}),
        };
    }
};

pub const SyncResponse = struct {
    status: u16,
    content_type: ?[]const u8 = null,
    final_url: ?[:0]const u8 = null,
    body: std.ArrayList(u8),

    pub fn deinit(self: *SyncResponse, allocator: Allocator) void {
        self.body.deinit(allocator);
    }
};

pub const Transfer = struct {
    id: u32 = 0,
    req: Request,
    url: [:0]const u8,
    client: *Client,
    // total bytes received in the response, including the response status line,
    // the headers, and the [encoded] body.
    bytes_received: usize = 0,

    start_time: u64,
    aborted: bool = false,

    // We'll store the response header here
    response_header: ?ResponseHead = null,

    // track if the header callbacks done have been called.
    _header_done_called: bool = false,

    _notified_fail: bool = false,

    _conn: ?*http.Connection = null,
    // Set when conn is temporarily detached from transfer during redirect
    // reconfiguration. Used by processMessages to release the orphaned conn
    // if reconfiguration fails.
    _detached_conn: ?*http.Connection = null,

    _auth_challenge: ?http.AuthChallenge = null,

    // number of times the transfer has been tried.
    // incremented by reset func.
    _tries: u8 = 0,
    _performing: bool = false,
    _redirect_count: u8 = 0,
    _misdirected_retries: u8 = 0,
    _skip_body: bool = false,
    _first_data_received: bool = false,
    /// True once incremental body chunks were delivered via data_callback.
    _streamed_to_user: bool = false,

    // Buffered response body. Filled by dataCallback; also replayed at completion
    // when no body chunks arrived (empty response).
    _stream_buffer: std.ArrayList(u8) = .{},

    // Error captured in dataCallback to be reported in processMessages.
    _callback_error: ?anyerror = null,

    _wire_capture: ?*http.WireHeaderCapture.Session = null,

    // for when a Transfer is queued in the client.queue
    _node: std.DoublyLinkedList.Node = .{},

    /// Copied batchexecute chunks delivered one per perform cycle (non-blocking RY skew).
    _deferred_chunks: std.ArrayList([]const u8) = .{},
    _deferred_node: std.DoublyLinkedList.Node = .{},

    fn releaseConn(self: *Transfer) void {
        if (self._conn) |conn| {
            self.client.removeConn(conn);
            self._conn = null;
        }
    }

    fn deinit(self: *Transfer) void {
        if (self._conn) |conn| {
            self.client.removeConn(conn);
            self._conn = null;
        }

        self.client.deinitRequest(self.req);
        self.client.transfer_pool.destroy(self);
    }

    pub fn abort(self: *Transfer, err: anyerror) void {
        self.requestFailed(err, true);

        if (self._performing or self.client.performing) {
            // We're currently in a curl_multi_perform. We cannot call
            // curl_multi_remove_handle from a curl callback. Instead, we flag
            // this transfer and our callbacks will check for this flag.
            self.aborted = true;
            return;
        }

        self.deinit();
    }

    pub fn terminate(self: *Transfer) void {
        self.requestFailed(error.Shutdown, false);
        self.deinit();
    }

    // internal, when the frame is shutting down. Doesn't have the same ceremony
    // as abort (doesn't send a notification, doesn't invoke an error callback)
    fn kill(self: *Transfer) void {
        if (self.req.shutdown_callback) |cb| {
            cb(self.req.ctx);
        }

        if (self._performing or self.client.performing) {
            // We're currently inside of a callback. This client, and libcurl
            // generally don't expect a transfer to become deinitialized during
            // a callback. We can flag the transfer as aborted (which is what
            // we do when transfer.abort() is called in this condition) AND,
            // since this "kill()"should prevent any future callbacks, the best
            // we can do is null/noop them.
            self.aborted = true;
            self.req.start_callback = null;
            self.req.shutdown_callback = null;
            self.req.header_callback = Noop.headerCallback;
            self.req.data_callback = Noop.dataCallback;
            self.req.done_callback = Noop.doneCallback;
            self.req.error_callback = Noop.errorCallback;
            return;
        }

        self.deinit();
    }

    // We can force a failed request within a callback, which will eventually
    // result in this being called again in the more general loop. We do this
    // because we can raise a more specific error inside a callback in some cases.
    fn requestFailed(self: *Transfer, err: anyerror, comptime execute_callback: bool) void {
        if (self._notified_fail) return;
        self._notified_fail = true;

        if (execute_callback) {
            self.req.error_callback(self.req.ctx, err);
        } else if (self.req.shutdown_callback) |cb| {
            cb(self.req.ctx);
        }
    }

    fn configureConn(self: *Transfer, conn: *http.Connection) anyerror!void {
        const client = self.client;
        const req = &self.req;
        const network = client.network;

        if (comptime build_config.curl_impersonate) {
            if (std.mem.indexOf(u8, req.params.url, "sg_ss=") != null) {
                // Pooled easy handles retain HTTP/3 QUIC state after sei=;
                // curl_easy_reset + fresh_connect is not enough for sg_ss=.
                try conn.reinit(network.config, network.ca_blob, network.ip_filter);
            }
        }

        // Set callbacks and per-client settings on the pooled connection.
        try conn.setWriteCallback(Transfer.dataCallback);
        try conn.setFollowLocation(false);
        try conn.setProxy(client.http_proxy);
        try conn.setTlsVerify(client.tls_verify, client.use_proxy);

        try conn.setURL(req.params.url);
        if (req.params.custom_method) |custom| {
            try conn.setMethodString(custom);
        } else {
            try conn.setMethod(req.params.method);
        }
        if (self._tries > 0) {
            if (req.params.redirect_header_rebuild) |rebuild| {
                const ctx = req.params.redirect_refresh_ctx orelse req.ctx;
                try rebuild(ctx, self, conn);
            }
        }

        var header_list = req.params.headers;
        try conn.secretHeaders(&header_list, &client.network.config.http_headers);

        if (comptime build_config.curl_impersonate) {
            try conn.clearInternalCookies();
            if (try self.req.getCookieString()) |cookies| {
                const cookie_hdr = try std.fmt.allocPrintSentinel(
                    req.params.arena,
                    "Cookie: {s}",
                    .{cookies},
                    0,
                );
                try header_list.add(cookie_hdr);
            }
        } else if (try self.req.getCookieString()) |cookies| {
            try conn.setCookies(@ptrCast(cookies.ptr));
        }

        conn.transport = .{ .http = self };
        conn.origin = switch (req.params.resource_type) {
            .document => .frame_navigation,
            .fetch, .xhr, .script, .worker, .beacon, .image => .unknown,
        };

        // Per-request timeout override (e.g. XHR timeout)
        if (req.params.timeout_ms > 0) {
            try conn.setTimeout(req.params.timeout_ms);
        }

        if (comptime build_config.curl_impersonate) {
            // In-search sei=/sg_ss= hops embed Referer in the manual header list (HAR order).
            const referer_in_headers = req.params.omit_sec_fetch_user and
                req.params.resource_type == .document and
                req.params.referer != null;
            if (!referer_in_headers) {
                try conn.setReferer(req.params.referer);
            }
        }

        // add credentials
        if (req.params.credentials) |creds| {
            if (self._auth_challenge != null and self._auth_challenge.?.source == .proxy) {
                try conn.setProxyCredentials(creds);
            } else {
                try conn.setCredentials(creds);
            }
        }

        // TLS impersonate before HTTP overrides — profile headers must win over chrome146 defaults.
        if (comptime build_config.curl_impersonate) {
            const curl_default_headers = req.params.curl_default_headers and
                !(req.params.omit_sec_fetch_user and req.params.resource_type == .document);
            const sg_ss_hop = std.mem.indexOf(u8, req.params.url, "sg_ss=") != null;
            // Never negotiate HTTP/3 for sg_ss=: multi-kB query stalls in curl-impersonate
            // QUIC; guest Chrome uses h2 for sg_ss= hops.
            const http_version: http.Connection.ProfileHttpVersion = if (sg_ss_hop) .h2 else .h3;
            if (sg_ss_hop) try conn.forceFreshConnection();
            try conn.applyProfileTransportVersion(client.network.config, curl_default_headers, http_version);
            if (sg_ss_hop) {
                if (comptime IS_DEBUG) {
                    log.debug(.http, "sg_ss transport", .{ .http_version = "h2", .fresh_connect = true });
                }
            }
            if (req.params.revalidate_etag) |etag| {
                const hdr = try std.fmt.allocPrintSentinel(req.params.arena, "If-None-Match: {s}", .{etag}, 0);
                try header_list.add(hdr);
            }
            if (req.params.revalidate_last_modified) |lm| {
                const hdr = try std.fmt.allocPrintSentinel(req.params.arena, "If-Modified-Since: {s}", .{lm}, 0);
                try header_list.add(hdr);
            }
            try conn.setHeaders(&header_list);
            if (req.params.body) |b| {
                if (req.params.raw_post_body) {
                    try conn.setBodyRaw(b);
                } else {
                    try conn.setBody(b);
                }
            } else if (req.params.method == .HEAD) {
                try conn.setHeadMode();
            } else {
                try conn.setGetMode();
            }
            if (client.network.config.profile.mode == .antidetect) {
                try conn.setUserAgent(client.getUserAgent());
            }
            if (http.WireHeaderCapture.shouldCapture(req.params.url, req.params.resource_type)) {
                const session = try http.WireHeaderCapture.Session.init(
                    req.params.arena,
                    req.params.url,
                    req.params.resource_type,
                );
                self._wire_capture = session;
                try conn.setWireHeaderCapture(session);
            }
        } else {
            try conn.setHeaders(&header_list);
            if (req.params.body) |b| {
                if (req.params.raw_post_body) {
                    try conn.setBodyRaw(b);
                } else {
                    try conn.setBody(b);
                }
            } else if (req.params.method == .HEAD) {
                try conn.setHeadMode();
            } else {
                try conn.setGetMode();
            }
        }
    }

    pub fn reset(self: *Transfer) void {
        // Note: do NOT reset _auth_challenge here. It is needed by makeRequest
        // to determine whether to use setProxyCredentials vs setCredentials.
        self._notified_fail = false;
        self.response_header = null;
        self.bytes_received = 0;
        self._tries += 1;
        self._stream_buffer.clearRetainingCapacity();
        self._callback_error = null;
        self._skip_body = false;
        self._first_data_received = false;
        self._streamed_to_user = false;
        self._header_done_called = false;
    }

    fn buildResponseHeader(self: *Transfer, conn: *const http.Connection) !void {
        if (comptime IS_DEBUG) {
            std.debug.assert(self.response_header == null);
        }

        const url = try conn.getEffectiveUrl();

        const status: u16 = if (self._auth_challenge != null)
            407
        else
            try conn.getResponseCode();

        const proto = conn.httpProtocolLabel();
        self.response_header = .{
            .url = url,
            .status = status,
            .redirect_count = self._redirect_count,
        };
        {
            const hdr = &self.response_header.?;
            const len = @min(proto.len, ResponseHead.MAX_PROTOCOL_LEN);
            hdr._protocol_len = len;
            @memcpy(hdr._protocol[0..len], proto[0..len]);
        }

        if (conn.getResponseHeader("content-type", 0)) |ct| {
            var hdr = &self.response_header.?;
            const value = ct.value;
            const len = @min(value.len, ResponseHead.MAX_CONTENT_TYPE_LEN);
            hdr._content_type_len = len;
            @memcpy(hdr._content_type[0..len], value[0..len]);
        }
    }

    pub fn format(self: *Transfer, writer: *std.Io.Writer) !void {
        const req = self.req;
        return writer.print("{s} {s}", .{ @tagName(req.params.method), req.params.url });
    }

    pub fn updateURL(self: *Transfer, url: [:0]const u8) !void {
        // for cookies
        self.url = url;

        // for the request itself
        self.req.params.url = url;
    }

    fn handleMisdirectedRetry(transfer: *Transfer) !void {
        const client = transfer.client;
        const conn = transfer._conn.?;

        try client.handles.remove(conn);
        transfer._conn = null;
        transfer._detached_conn = conn;

        transfer._misdirected_retries = 1;
        transfer.reset();
        transfer._misdirected_retries = 1;

        try conn.forceFreshConnection();
        try transfer.configureConn(conn);
        try client.handles.add(conn);
        transfer._detached_conn = null;
        transfer._conn = conn;
    }

    fn handleRedirect(transfer: *Transfer) !void {
        const req = &transfer.req;
        const conn = transfer._conn.?;
        const arena = transfer.req.params.arena;
        const prior_url = try arena.dupeZ(u8, transfer.url);

        transfer._redirect_count += 1;
        if (transfer._redirect_count > transfer.client.network.config.httpMaxRedirects()) {
            return error.TooManyRedirects;
        }

        // retrieve cookies from the redirect's response.
        if (req.params.cookie_jar) |jar| {
            var i: usize = 0;
            while (conn.getResponseHeader("set-cookie", i)) |ct| : (i += 1) {
                try jar.populateFromResponse(transfer.url, ct.value, transfer.req.params.top_level_cookie_url orelse transfer.req.params.cookie_origin);

                if (i >= ct.amount) {
                    break;
                }
            }
        }

        // resolve the redirect target.
        const location = conn.getResponseHeader("location", 0) orelse {
            return error.LocationNotFound;
        };

        const url: [:0]const u8 = blk: {
            if (location.value.len == 0) {
                // Might seem silly, but URL.resovle will return location.value as-is
                // if empty, and location.value is memory owned by libcurl.
                break :blk "";
            }

            const base_url = try conn.getEffectiveUrl();
            const resolved = try URL.resolve(arena, std.mem.span(base_url), location.value, .{});

            // RFC 7231 §7.1.2: if the Location value has no fragment, the redirect
            // inherits the fragment from the URI used to generate the request.
            // URL.resolve follows RFC 3986 §5.3, which drops the base fragment when
            // the relative ref has none, so we re-attach it here.
            if (URL.getHash(resolved).len == 0) {
                const original_hash = URL.getHash(transfer.url);
                if (original_hash.len != 0) {
                    break :blk try std.mem.joinZ(arena, "", &.{ resolved, original_hash });
                }
            }
            break :blk resolved;
        };

        try transfer.updateURL(url);

        if (req.params.redirect_policy_refresh) |refresh| {
            const refresh_ctx = req.params.redirect_refresh_ctx orelse req.ctx;
            try refresh(refresh_ctx, transfer, prior_url);
        }

        // 301, 302, 303 → change to GET, drop body.
        // 307, 308 → keep method and body.
        const status = try conn.getResponseCode();
        if (status == 301 or status == 302 or status == 303) {
            req.params.method = .GET;
            req.params.body = null;
        }
    }

    fn detectAuthChallenge(transfer: *Transfer, conn: *const http.Connection) void {
        const status = conn.getResponseCode() catch return;
        const connect_status = conn.getConnectCode() catch return;

        if (status != 401 and status != 407 and connect_status != 401 and connect_status != 407) {
            transfer._auth_challenge = null;
            return;
        }

        if (conn.getResponseHeader("WWW-Authenticate", 0)) |hdr| {
            transfer._auth_challenge = http.AuthChallenge.parse(status, .server, hdr.value) catch null;
        } else if (conn.getConnectHeader("WWW-Authenticate", 0)) |hdr| {
            transfer._auth_challenge = http.AuthChallenge.parse(status, .server, hdr.value) catch null;
        } else if (conn.getResponseHeader("Proxy-Authenticate", 0)) |hdr| {
            transfer._auth_challenge = http.AuthChallenge.parse(status, .proxy, hdr.value) catch null;
        } else if (conn.getConnectHeader("Proxy-Authenticate", 0)) |hdr| {
            transfer._auth_challenge = http.AuthChallenge.parse(status, .proxy, hdr.value) catch null;
        } else {
            transfer._auth_challenge = .{ .status = status, .source = null, .scheme = null, .realm = null };
        }
    }

    pub fn updateCredentials(self: *Transfer, userpwd: [:0]const u8) void {
        self.req.params.credentials = userpwd;
    }

    pub fn replaceRequestHeaders(self: *Transfer, allocator: Allocator, headers: []const http.Header) !void {
        self.req.params.headers.deinit();

        var buf: std.ArrayList(u8) = .empty;
        var new_headers = try self.client.newHeaders();
        for (headers) |hdr| {
            // safe to re-use this buffer, because Headers.add because curl copies
            // the value we pass into curl_slist_append.
            defer buf.clearRetainingCapacity();
            try std.fmt.format(buf.writer(allocator), "{s}: {s}", .{ hdr.name, hdr.value });
            try buf.append(allocator, 0); // null terminated
            try new_headers.add(buf.items[0 .. buf.items.len - 1 :0]);
        }
        self.req.params.headers = new_headers;
    }

    // abortAuthChallenge is called when an auth challenge interception is
    // abort. We don't call self.releaseConn here b/c it has been done
    // before interception process.
    pub fn abortAuthChallenge(self: *Transfer) void {
        if (comptime IS_DEBUG) {
            log.debug(.http, "abort auth transfer", .{ .intercepted = self.client.interception_layer.intercepted });
        }

        self.client.interception_layer.intercepted -= 1;
        self.abort(error.AbortAuthChallenge);
        return;
    }

    // headerDoneCallback is called once the headers have been read.
    // It can be called either on dataCallback or once the request for those
    // w/o body.
    fn headerDoneCallback(transfer: *Transfer, conn: *const http.Connection) !bool {
        assert(transfer._header_done_called == false, "Transfer.headerDoneCallback", .{});
        defer transfer._header_done_called = true;

        try transfer.buildResponseHeader(conn);

        if (transfer._wire_capture) |session| {
            const status = transfer.response_header.?.status;
            const protocol = transfer.response_header.?.protocol() orelse "unknown";
            session.flush(status, protocol) catch |err| {
                log.warn(.http, "wire header capture flush", .{ .err = err });
            };
            transfer._wire_capture = null;
            conn.clearWireHeaderCapture() catch {};
        }

        if (transfer.req.params.cookie_jar) |jar| {
            var i: usize = 0;
            while (true) {
                const ct = conn.getResponseHeader("set-cookie", i);
                if (ct == null) break;
                jar.populateFromResponse(transfer.url, ct.?.value, transfer.req.params.top_level_cookie_url orelse transfer.req.params.cookie_origin) catch |err| {
                    log.err(.http, "set cookie", .{ .err = err, .req = transfer });
                    return err;
                };
                i += 1;
                if (i >= ct.?.amount) break;
            }
        }

        if (transfer.getContentLength()) |cl| {
            if (cl > transfer.client.max_response_size) {
                return error.ResponseTooLarge;
            }
        }

        const proceed = transfer.req.header_callback(Response.fromTransfer(transfer)) catch |err| {
            log.err(.http, "header_callback", .{ .err = err, .req = transfer });
            return err;
        };

        return proceed and transfer.aborted == false;
    }

    fn dataCallback(buffer: [*]const u8, chunk_count: usize, chunk_len: usize, data: *anyopaque) usize {
        // libcurl should only ever emit 1 chunk at a time
        if (comptime IS_DEBUG) {
            std.debug.assert(chunk_count == 1);
        }

        const conn: *http.Connection = @ptrCast(@alignCast(data));
        var transfer = conn.transport.http;

        if (!transfer._first_data_received) {
            transfer._first_data_received = true;

            // Skip body for responses that will be retried (redirects, auth challenges).
            const status = conn.getResponseCode() catch |err| {
                log.err(.http, "getResponseCode", .{ .err = err, .source = "body callback" });
                return http.writefunc_error;
            };
            if ((status >= 300 and status <= 399) or status == 401 or status == 407 or
                (status == 421 and transfer._misdirected_retries == 0))
            {
                transfer._skip_body = true;
                return @intCast(chunk_len);
            }

            // Pre-size buffer from Content-Length.
            if (transfer.getContentLength()) |cl| {
                if (cl > transfer.client.max_response_size) {
                    transfer._callback_error = error.ResponseTooLarge;
                    return http.writefunc_error;
                }
                transfer._stream_buffer.ensureTotalCapacity(transfer.req.params.arena, cl) catch {};
            }
        }

        if (transfer._skip_body) return @intCast(chunk_len);

        transfer.bytes_received += chunk_len;
        if (transfer.bytes_received > transfer.client.max_response_size) {
            transfer._callback_error = error.ResponseTooLarge;
            return http.writefunc_error;
        }

        const chunk = buffer[0..chunk_len];
        transfer._stream_buffer.appendSlice(transfer.req.params.arena, chunk) catch |err| {
            transfer._callback_error = err;
            return http.writefunc_error;
        };

        if (transfer.aborted) {
            return http.writefunc_error;
        }

        // Deliver headers + incremental body while readyState === LOADING (Chrome
        // parity). Google batchexecute (rt=c) parses chunked bodies on each
        // readystatechange during LOADING.
        if (!transfer._header_done_called) {
            const proceed = transfer.headerDoneCallback(conn) catch |err| {
                transfer._callback_error = err;
                return http.writefunc_error;
            };
            if (!proceed or transfer.aborted) {
                return http.writefunc_error;
            }
        }

        if (chunk_len > 0) {
            if (isGoogleAccountsBatchExecute(transfer.url) and !batchexecuteSyncDeliveryEnabled()) {
                const arena = transfer.req.params.arena;
                const copy = arena.alloc(u8, chunk_len) catch |err| {
                    transfer._callback_error = err;
                    return http.writefunc_error;
                };
                @memcpy(copy, chunk);
                transfer._deferred_chunks.append(arena, copy) catch |err| {
                    transfer._callback_error = err;
                    return http.writefunc_error;
                };
                if (transfer._deferred_chunks.items.len == 1) {
                    transfer.client.deferred_delivery.append(&transfer._deferred_node);
                }
            } else {
                deliverChunkToUser(transfer, chunk);
                if (transfer._callback_error != null or transfer.aborted) {
                    return http.writefunc_error;
                }
            }
        }

        return @intCast(chunk_len);
    }

    pub fn responseHeaderIterator(self: *Transfer) HeaderIterator {
        if (self.response_header) |rh| {
            if (rh._injected_headers.len > 0) {
                return .{ .list = .{ .list = rh._injected_headers } };
            }
        }
        const conn = self._conn orelse {
            return .{ .list = .{ .list = &.{} } };
        };
        return .{ .curl = .{ .conn = conn } };
    }

    // This function should be called during the dataCallback. Calling it after
    // such as in the doneCallback is guaranteed to return null.
    pub fn getContentLength(self: *const Transfer) ?u32 {
        const cl = self.getContentLengthRawValue() orelse return null;
        return std.fmt.parseInt(u32, cl, 10) catch null;
    }

    fn getContentLengthRawValue(self: *const Transfer) ?[]const u8 {
        if (self._conn) |conn| {
            // If we have a connection, than this is a normal request. We can get the
            // header value from the connection.
            const cl = conn.getResponseHeader("content-length", 0) orelse return null;
            return cl.value;
        }

        // If we have no handle, then maybe this is being called after the
        // doneCallback. OR, maybe this is a "fulfilled" request. Let's check
        // the injected headers (if we have any).

        const rh = self.response_header orelse return null;
        for (rh._injected_headers) |hdr| {
            if (std.ascii.eqlIgnoreCase(hdr.name, "content-length")) {
                return hdr.value;
            }
        }

        return null;
    }
};

pub fn continueTransfer(self: *Client, transfer: *Transfer) !void {
    if (comptime IS_DEBUG) {
        assert(self.interception_layer.intercepted > 0, "HttpClient.continueTransfer", .{ .value = self.interception_layer.intercepted });
        log.debug(.http, "continue transfer", .{ .intercepted = self.interception_layer.intercepted });
    }

    self.interception_layer.intercepted -= 1;
    return self.process(transfer);
}

pub fn deinitRequest(self: *Client, req: Request) void {
    req.deinit();
    self.network.app.arena_pool.release(req.params.arena);
}

const Noop = struct {
    fn headerCallback(_: Response) !bool {
        return true;
    }
    fn dataCallback(_: Response, _: []const u8) !void {}
    fn doneCallback(_: *anyopaque) !void {}
    fn errorCallback(_: *anyopaque, _: anyerror) void {}
};
