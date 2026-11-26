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

const std = @import("std");
const assert = @import("../../../support/assert.zig").assert;

const id = @import("../id.zig");
const CDP = @import("../CDP.zig");

const URL = @import("../../../core/browser/URL.zig");
const Mime = @import("../../../core/browser/Mime.zig");
const runtime_io = @import("../../../support/io.zig");
const Notification = @import("../../../runtime/Notification.zig");
const timestamp = @import("../../../support/datetime.zig").timestamp;
const Transfer = @import("../../../core/browser/HttpClient.zig").Transfer;
const Request = @import("../../../core/browser/HttpClient.zig").Request;
const Response = @import("../../../core/browser/HttpClient.zig").Response;

const CdpStorage = @import("storage.zig");

const log = @import("../../../support/log.zig");
const Allocator = std.mem.Allocator;

pub fn processMessage(cmd: *CDP.Command) !void {
    const action = std.meta.stringToEnum(enum {
        enable,
        disable,
        setCacheDisabled,
        clearBrowserCache,
        emulateNetworkConditions,
        setBypassServiceWorker,
        setExtraHTTPHeaders,
        setUserAgentOverride,
        deleteCookies,
        clearBrowserCookies,
        setCookie,
        setCookies,
        getCookies,
        getAllCookies,
        getRequestPostData,
        getResponseBody,
    }, cmd.input.action) orelse return error.UnknownMethod;

    switch (action) {
        .enable => return enable(cmd),
        .disable => return disable(cmd),
        .setCacheDisabled => return setCacheDisabled(cmd),
        .clearBrowserCache => return clearBrowserCache(cmd),
        .emulateNetworkConditions => return emulateNetworkConditions(cmd),
        .setBypassServiceWorker => return setBypassServiceWorker(cmd),
        .setUserAgentOverride => return @import("emulation.zig").setUserAgentOverride(cmd),
        .setExtraHTTPHeaders => return setExtraHTTPHeaders(cmd),
        .deleteCookies => return deleteCookies(cmd),
        .clearBrowserCookies => return clearBrowserCookies(cmd),
        .setCookie => return setCookie(cmd),
        .setCookies => return setCookies(cmd),
        .getCookies => return getCookies(cmd),
        .getAllCookies => return getAllCookies(cmd),
        .getRequestPostData => return getRequestPostData(cmd),
        .getResponseBody => return getResponseBody(cmd),
    }
}

fn enable(cmd: *CDP.Command) !void {
    const bc = cmd.browser_context orelse return error.BrowserContextNotLoaded;
    try bc.networkEnable();
    return cmd.sendResult(null, .{});
}

fn disable(cmd: *CDP.Command) !void {
    const bc = cmd.browser_context orelse return error.BrowserContextNotLoaded;
    bc.networkDisable();
    return cmd.sendResult(null, .{});
}

fn setCacheDisabled(cmd: *CDP.Command) !void {
    const params = (try cmd.params(struct {
        cacheDisabled: bool,
    })) orelse return error.InvalidParams;
    const bc = cmd.browser_context orelse return error.BrowserContextNotLoaded;
    bc.session.browser.http_client.network.cache_disabled = params.cacheDisabled;
    return cmd.sendResult(null, .{});
}

fn clearBrowserCache(cmd: *CDP.Command) !void {
    // Koko's cache is a content-addressed filesystem cache. Clear the cache
    // directory itself, rather than merely toggling cache_disabled: the latter
    // would leave stale entries available to later requests.
    _ = try cmd.params(struct {});

    const bc = cmd.browser_context orelse return error.BrowserContextNotLoaded;
    const cache_path = bc.session.browser.app.config.httpCacheDir() orelse {
        return cmd.sendResult(null, .{});
    };

    var dir = std.Io.Dir.cwd().openDir(runtime_io.get(), cache_path, .{
        .iterate = true,
        .follow_symlinks = false,
        .access_sub_paths = false,
    }) catch |err| switch (err) {
        error.FileNotFound => return cmd.sendResult(null, .{}),
        else => return err,
    };
    defer dir.close(runtime_io.get());

    var it = dir.iterate();
    while (try it.next(runtime_io.get())) |entry| {
        if (entry.kind != .file) continue;
        if (!std.mem.endsWith(u8, entry.name, ".cache") and
            !std.mem.endsWith(u8, entry.name, ".cache.tmp")) continue;
        dir.deleteFile(runtime_io.get(), entry.name) catch |err| switch (err) {
            error.FileNotFound => {},
            else => return err,
        };
    }

    return cmd.sendResult(null, .{});
}

fn emulateNetworkConditions(cmd: *CDP.Command) !void {
    const params = (try cmd.params(struct {
        offline: bool,
        latency: f64,
        downloadThroughput: f64,
        uploadThroughput: f64,
        connectionType: ?enum {
            none,
            cellular2g,
            cellular3g,
            cellular4g,
            bluetooth,
            ethernet,
            wifi,
            wimax,
            other,
        } = null,
        packetLoss: ?f64 = null,
        packetQueueLength: ?i32 = null,
        packetReordering: ?bool = null,
    })) orelse return error.InvalidParams;

    if (!std.math.isFinite(params.latency) or params.latency < 0 or
        !std.math.isFinite(params.downloadThroughput) or params.downloadThroughput < 0 or
        !std.math.isFinite(params.uploadThroughput) or params.uploadThroughput < 0) return error.InvalidParams;
    if (params.packetLoss) |loss| {
        if (!std.math.isFinite(loss) or loss < 0 or loss > 100) return error.InvalidParams;
    }

    log.warn(.not_implemented, "Network.emulateNetworkConditions", .{
        .info = "the transport scheduler has no latency, throughput, or offline producer",
    });
    return error.NotImplemented;
}

fn setBypassServiceWorker(cmd: *CDP.Command) !void {
    const params = (try cmd.params(struct {
        bypass: bool,
    })) orelse return error.InvalidParams;
    _ = params;
    log.warn(.not_implemented, "Network.setBypassServiceWorker", .{
        .info = "service-worker interception is not implemented by the runtime",
    });
    return error.NotImplemented;
}

fn setExtraHTTPHeaders(cmd: *CDP.Command) !void {
    const params = (try cmd.params(struct {
        headers: std.json.ArrayHashMap([]const u8),
    })) orelse return error.InvalidParams;

    const bc = cmd.browser_context orelse return error.BrowserContextNotLoaded;

    // Copy the headers onto the browser context arena
    const arena = bc.arena;
    const extra_headers = &bc.extra_headers;

    extra_headers.clearRetainingCapacity();
    try extra_headers.ensureTotalCapacity(arena, params.headers.map.count());
    var it = params.headers.map.iterator();
    while (it.next()) |header| {
        const header_string = try std.fmt.allocPrintSentinel(arena, "{s}: {s}", .{ header.key_ptr.*, header.value_ptr.* }, 0);
        extra_headers.appendAssumeCapacity(header_string);
    }

    return cmd.sendResult(null, .{});
}

const Cookie = @import("../../../core/webapi/storage/storage.zig").Cookie;

// Only matches the cookie on provided parameters
fn cookieMatches(cookie: *const Cookie, name: []const u8, domain: ?[]const u8, path: ?[]const u8) bool {
    if (!std.mem.eql(u8, cookie.name, name)) return false;

    if (domain) |domain_| {
        const c_no_dot = if (std.mem.startsWith(u8, cookie.domain, ".")) cookie.domain[1..] else cookie.domain;
        const d_no_dot = if (std.mem.startsWith(u8, domain_, ".")) domain_[1..] else domain_;
        if (!std.mem.eql(u8, c_no_dot, d_no_dot)) return false;
    }
    if (path) |path_| {
        if (!std.mem.eql(u8, cookie.path, path_)) return false;
    }
    return true;
}

fn cookieDomainMatchesUrl(cookie: *const Cookie, host: []const u8) bool {
    if (cookie.domain.len == 0) return false;
    if (cookie.domain[0] != '.') return std.mem.eql(u8, cookie.domain, host);

    const domain = cookie.domain[1..];
    return std.mem.eql(u8, domain, host) or std.mem.endsWith(u8, host, cookie.domain);
}

fn deleteCookies(cmd: *CDP.Command) !void {
    const params = (try cmd.params(struct {
        name: []const u8,
        url: ?[:0]const u8 = null,
        domain: ?[]const u8 = null,
        path: ?[]const u8 = null,
        partitionKey: ?CdpStorage.CookiePartitionKey = null,
    })) orelse return error.InvalidParams;

    const bc = cmd.browser_context orelse return error.BrowserContextNotLoaded;
    const cookies = &bc.session.cookie_jar.cookies;

    // When partitionKey is set, only delete cookies in that CHIPS partition.
    // When absent, delete matching cookies regardless of partition (Chrome-like
    // for unpartitioned deletes; Puppeteer setCookie still works).
    const want_partition = params.partitionKey != null;
    const partition_site: ?[]const u8 = if (params.partitionKey) |pk| pk.topLevelSite else null;

    // CDP's URL form matches the cookie's domain against the URL host and uses
    // RFC 6265 path-match semantics. It is not an exact comparison against the
    // URL's default path: a cookie set without an explicit path is commonly
    // stored at "/" and must still be deleted for a deeper URL.
    const url_host = if (params.url) |url| URL.getHostname(url) else null;
    const url_path = if (params.url) |url| URL.getPathname(url) else null;
    const exact_domain = if (params.domain) |domain|
        try Cookie.parseDomain(cmd.arena, params.url, domain)
    else
        null;
    const exact_path = if (params.path) |path|
        try Cookie.parsePath(cmd.arena, params.url, path)
    else
        null;

    var index = cookies.items.len;
    while (index > 0) {
        index -= 1;
        const cookie = &cookies.items[index];

        if (!cookieMatches(cookie, params.name, exact_domain, exact_path)) continue;
        if (exact_domain == null) {
            if (url_host) |host| {
                if (!cookieDomainMatchesUrl(cookie, host)) continue;
            }
        }
        if (exact_path == null) {
            if (url_path) |path| {
                if (!Cookie.pathMatches(cookie.path, path)) continue;
            }
        }

        if (want_partition) {
            // Only CHIPS cookies in the given top-level site partition.
            if (!cookie.partitioned) continue;
            const site = cookie.partition_site orelse continue;
            const want = partition_site orelse continue;
            // Compare schemeful sites loosely (allow missing trailing slash).
            if (!partitionSitesEqual(site, want)) continue;
        }

        cookies.swapRemove(index).deinit();
    }
    return cmd.sendResult(null, .{});
}

fn partitionSitesEqual(a: []const u8, b: []const u8) bool {
    if (std.mem.eql(u8, a, b)) return true;
    // "https://example.com" vs "https://example.com/"
    const a_trim = std.mem.trimEnd(u8, a, "/");
    const b_trim = std.mem.trimEnd(u8, b, "/");
    return std.mem.eql(u8, a_trim, b_trim);
}

fn clearBrowserCookies(cmd: *CDP.Command) !void {
    // Network.clearBrowserCookies takes no parameters per the CDP spec, but most
    // CDP clients (chrome-remote-interface, chromedp, custom websocket clients)
    // include an empty `"params":{}` object on every command for ergonomics.
    // Chrome accepts that and clears the jar; reject only on truly malformed JSON.
    const bc = cmd.browser_context orelse return error.BrowserContextNotLoaded;
    bc.session.cookie_jar.clearRetainingCapacity();
    return cmd.sendResult(null, .{});
}

fn setCookie(cmd: *CDP.Command) !void {
    const params = (try cmd.params(
        CdpStorage.CdpCookie,
    )) orelse return error.InvalidParams;

    const bc = cmd.browser_context orelse return error.BrowserContextNotLoaded;
    try CdpStorage.setCdpCookie(&bc.session.cookie_jar, params);

    try cmd.sendResult(.{ .success = true }, .{});
}

fn setCookies(cmd: *CDP.Command) !void {
    const params = (try cmd.params(struct {
        cookies: []const CdpStorage.CdpCookie,
    })) orelse return error.InvalidParams;

    const bc = cmd.browser_context orelse return error.BrowserContextNotLoaded;
    for (params.cookies) |param| {
        try CdpStorage.setCdpCookie(&bc.session.cookie_jar, param);
    }

    try cmd.sendResult(null, .{});
}

const GetCookiesParam = struct {
    urls: ?[]const [:0]const u8 = null,
};
fn getCookies(cmd: *CDP.Command) !void {
    const bc = cmd.browser_context orelse return error.BrowserContextNotLoaded;
    const params = (try cmd.params(GetCookiesParam)) orelse GetCookiesParam{};

    // If not specified, use the URLs of the page and all of its subframes. TODO subframes
    const frame_url = if (bc.session.currentFrame()) |frame| frame.url else null;
    const param_urls = params.urls orelse &[_][:0]const u8{frame_url orelse return error.InvalidParams};

    var urls = try std.ArrayList(CdpStorage.PreparedUri).initCapacity(cmd.arena, param_urls.len);
    for (param_urls) |url| {
        urls.appendAssumeCapacity(.{
            .host = try Cookie.parseDomain(cmd.arena, url, null),
            .path = try Cookie.parsePath(cmd.arena, url, null),
            .secure = URL.isHTTPS(url),
        });
    }

    var jar = &bc.session.cookie_jar;
    jar.removeExpired(null);
    const writer = CdpStorage.CookieWriter{ .cookies = jar.cookies.items, .urls = urls.items };
    try cmd.sendResult(.{ .cookies = writer }, .{});
}

fn getAllCookies(cmd: *CDP.Command) !void {
    // Returns every cookie in the jar regardless of the current frame's origin.
    // Mirrors Chrome's Network.getAllCookies and Storage.getCookies (without
    // the latter's browserContextId filter, since Network commands are scoped
    // to the current browser context already).
    const bc = cmd.browser_context orelse return error.BrowserContextNotLoaded;
    var jar = &bc.session.cookie_jar;
    jar.removeExpired(null);
    const writer = CdpStorage.CookieWriter{ .cookies = jar.cookies.items };
    try cmd.sendResult(.{ .cookies = writer }, .{});
}

fn requestIdMatches(request: *const Request, request_id: []const u8) bool {
    const actual = id.toRequestId(request);
    return std.mem.eql(u8, &actual, request_id);
}

fn findRequestPostDataInConnections(
    list: std.DoublyLinkedList,
    request_id: []const u8,
) ?[]const u8 {
    var node = list.first;
    while (node) |current| : (node = current.next) {
        const connection: *@import("../../../runtime/network/http.zig").Connection = @fieldParentPtr("node", current);
        switch (connection.transport) {
            .http => |transfer| {
                if (requestIdMatches(&transfer.req, request_id)) return transfer.req.params.body;
            },
            .websocket, .none => {},
        }
    }
    return null;
}

fn findRequestPostDataInQueue(
    list: std.DoublyLinkedList,
    request_id: []const u8,
) ?[]const u8 {
    var node = list.first;
    while (node) |current| : (node = current.next) {
        const transfer: *Transfer = @fieldParentPtr("_node", current);
        if (requestIdMatches(&transfer.req, request_id)) return transfer.req.params.body;
    }
    return null;
}

fn getRequestPostData(cmd: *CDP.Command) !void {
    const params = (try cmd.params(struct {
        requestId: []const u8,
    })) orelse return error.InvalidParams;
    const bc = cmd.browser_context orelse return error.BrowserContextNotLoaded;
    const client = &bc.session.browser.http_client;

    if (findRequestPostDataInConnections(client.in_use, params.requestId)) |body| {
        return cmd.sendResult(.{ .postData = body }, .{});
    }
    if (findRequestPostDataInConnections(client.ready_queue, params.requestId)) |body| {
        return cmd.sendResult(.{ .postData = body }, .{});
    }
    if (findRequestPostDataInQueue(client.queue, params.requestId)) |body| {
        return cmd.sendResult(.{ .postData = body }, .{});
    }

    // The runtime does not retain completed request bodies. Returning a
    // not-found error is preferable to fabricating post data after teardown.
    return error.RequestNotFound;
}

fn getResponseBody(cmd: *CDP.Command) !void {
    const params = (try cmd.params(struct {
        requestId: []const u8, // "REQ-{d}" or "LID-{d}"
    })) orelse return error.InvalidParams;

    const key = try keyFromRequestId(params.requestId);
    const bc = cmd.browser_context orelse return error.BrowserContextNotLoaded;
    const resp = bc.captured_responses.getPtr(key) orelse return error.RequestNotFound;

    if (!resp.must_encode) {
        return cmd.sendResult(.{
            .body = resp.data.items,
            .base64Encoded = false,
        }, .{});
    }

    const encoded_len = std.base64.standard.Encoder.calcSize(resp.data.items.len);
    const encoded = try cmd.arena.alloc(u8, encoded_len);
    _ = std.base64.standard.Encoder.encode(encoded, resp.data.items);

    return cmd.sendResult(.{
        .body = encoded,
        .base64Encoded = true,
    }, .{});
}

pub fn httpRequestFail(bc: *CDP.BrowserContext, msg: *const Notification.RequestFail) !void {
    // It's possible that the request failed because we aborted when the client
    // sent Target.closeTarget. In that case, bc.session_id will be cleared
    // already, and we can skip sending these messages to the client.
    const session_id = bc.session_id orelse return;

    // Isn't possible to do a network request within a Browser (which our
    // notification is tied to), without a frame.
    assert(bc.session.hasPage(), "CDP.network.httpRequestFail null frame", .{});

    // We're missing a bunch of fields, but, for now, this seems like enough
    try bc.cdp.sendEvent("Network.loadingFailed", .{
        .requestId = &id.toRequestId(msg.request),
        // Seems to be what chrome answers with. I assume it depends on the type of error?
        .type = "Ping",
        .errorText = msg.err,
        .canceled = false,
    }, .{ .session_id = session_id });
}

pub fn httpRequestStart(bc: *CDP.BrowserContext, msg: *const Notification.RequestStart) !void {
    // detachTarget could be called, in which case, we still have a frame doing
    // things, but no session.
    const session_id = bc.session_id orelse return;

    const req = msg.request;
    const frame_id = req.params.frame_id;
    const frame = bc.session.findFrameForHttpAttribution(frame_id) orelse return;

    // Modify request with extra CDP headers
    for (bc.extra_headers.items) |extra| {
        try req.params.headers.add(extra);
    }

    const request_id = id.toRequestId(req);

    try bc.cdp.sendEvent("Network.requestWillBeSent", .{
        .frameId = &id.toFrameId(frame_id),
        .requestId = &request_id,
        .loaderId = &id.toLoaderId(req.params.loader_id),
        .type = req.params.resource_type.string(),
        .documentURL = frame.url,
        .request = RequestWriter.init(req),
        .initiator = .{ .type = "other" },
        .redirectHasExtraInfo = true,
        .hasUserGesture = false,
        .timestamp = timestamp(.monotonic),
        .wallTime = timestamp(.clock),
    }, .{ .session_id = session_id });

    try bc.cdp.sendEvent("Network.requestWillBeSentExtraInfo", .{
        .requestId = &request_id,
        .associatedCookies = &.{},
        .headers = RequestHeadersWriter.init(req),
        .connectTiming = .{ .requestTime = timestamp(.monotonic) },
    }, .{ .session_id = session_id });
}

pub fn httpResponseHeaderDone(arena: Allocator, bc: *CDP.BrowserContext, msg: *const Notification.ResponseHeaderDone) !void {
    // detachTarget could be called, in which case, we still have a frame doing
    // things, but no session.
    const session_id = bc.session_id orelse return;

    const req = msg.request;

    const request_id = id.toRequestId(req);

    try bc.cdp.sendEvent("Network.responseReceived", .{
        .frameId = &id.toFrameId(req.params.frame_id),
        .requestId = &request_id,
        .loaderId = &id.toLoaderId(req.params.loader_id),
        .type = req.params.resource_type.string(),
        .response = ResponseWriter.init(arena, msg.response),
        .hasExtraInfo = true,
    }, .{ .session_id = session_id });

    try bc.cdp.sendEvent("Network.responseReceivedExtraInfo", .{
        .requestId = &request_id,
        .blockedCookies = &.{},
        .headers = ResponseHeadersWriter.init(arena, msg.response),
        .resourceIPAddressSpace = "Unknown",
        .statusCode = msg.response.status() orelse 0,
        .cookiePartitionKey = .{ .topLevelSite = "", .hasCrossSiteAncestor = false },
    }, .{ .session_id = session_id });
}

pub fn httpRequestDone(bc: *CDP.BrowserContext, msg: *const Notification.RequestDone) !void {
    // detachTarget could be called, in which case, we still have a frame doing
    // things, but no session.
    const session_id = bc.session_id orelse return;
    const req = msg.request;
    try bc.cdp.sendEvent("Network.loadingFinished", .{
        .requestId = &id.toRequestId(req),
        .encodedDataLength = msg.content_length,
    }, .{ .session_id = session_id });
}

const CdpRequestHeaderEntry = struct {
    name: []const u8,
    value: []const u8,
};

fn cdpRequestHeadersContain(entries: []const CdpRequestHeaderEntry, name: []const u8) bool {
    for (entries) |entry| {
        if (std.ascii.eqlIgnoreCase(entry.name, name)) return true;
    }
    return false;
}

fn appendOrMergeCdpRequestHeader(
    arena: Allocator,
    entries: *std.ArrayListUnmanaged(CdpRequestHeaderEntry),
    name: []const u8,
    value: []const u8,
) !void {
    for (entries.items) |*entry| {
        if (std.ascii.eqlIgnoreCase(entry.name, name)) {
            const sep = if (std.ascii.eqlIgnoreCase(name, "Cookie")) "; " else "\n";
            entry.value = try std.fmt.allocPrint(arena, "{s}{s}{s}", .{ entry.value, sep, value });
            return;
        }
    }
    try entries.append(arena, .{
        .name = try arena.dupe(u8, name),
        .value = try arena.dupe(u8, value),
    });
}

/// CDP request headers JSON must not duplicate header names. curl-impersonate may
/// emit multiple Cookie lines; getCookieString() would add another if missing.
fn writeCdpRequestHeadersObject(request: *Request, jws: anytype) !void {
    const arena = request.params.arena;
    var entries: std.ArrayListUnmanaged(CdpRequestHeaderEntry) = .empty;
    defer entries.deinit(arena);

    var it = request.params.headers.iterator();
    while (it.next()) |hdr| {
        try appendOrMergeCdpRequestHeader(arena, &entries, hdr.name, hdr.value);
    }
    if (!cdpRequestHeadersContain(entries.items, "Cookie")) {
        if (try request.getCookieString()) |cookies| {
            try appendOrMergeCdpRequestHeader(arena, &entries, "Cookie", cookies);
        }
    }
    if (!cdpRequestHeadersContain(entries.items, "Referer")) {
        if (request.params.referer) |referer| {
            try appendOrMergeCdpRequestHeader(arena, &entries, "Referer", referer);
        }
    }

    try jws.beginObject();
    for (entries.items) |entry| {
        try jws.objectField(entry.name);
        try jws.write(entry.value);
    }
    try jws.endObject();
}

pub const RequestWriter = struct {
    request: *Request,

    pub fn init(request: *Request) RequestWriter {
        return .{
            .request = request,
        };
    }

    pub fn jsonStringify(self: *const RequestWriter, jws: anytype) !void {
        self._jsonStringify(jws) catch return error.WriteFailed;
    }

    fn _jsonStringify(self: *const RequestWriter, jws: anytype) !void {
        const request = self.request;

        try jws.beginObject();
        {
            try jws.objectField("url");
            try jws.write(request.params.url);
        }

        {
            const frag = URL.getHash(request.params.url);
            if (frag.len > 0) {
                try jws.objectField("urlFragment");
                try jws.write(frag);
            }
        }

        {
            try jws.objectField("method");
            try jws.write(@tagName(request.params.method));
        }

        {
            try jws.objectField("hasPostData");
            try jws.write(request.params.body != null);
        }

        {
            try jws.objectField("headers");
            try writeCdpRequestHeadersObject(request, jws);
        }
        try jws.endObject();
    }
};

const RequestHeadersWriter = struct {
    request: *Request,

    pub fn init(request: *Request) RequestHeadersWriter {
        return .{ .request = request };
    }

    pub fn jsonStringify(self: *const RequestHeadersWriter, jws: anytype) error{WriteFailed}!void {
        self._jsonStringify(jws) catch return error.WriteFailed;
    }

    fn _jsonStringify(self: *const RequestHeadersWriter, jws: anytype) !void {
        try writeCdpRequestHeadersObject(self.request, jws);
    }
};

const ResponseHeadersWriter = struct {
    arena: Allocator,
    response: *const Response,

    pub fn init(arena: Allocator, response: *const Response) ResponseHeadersWriter {
        return .{ .arena = arena, .response = response };
    }

    pub fn jsonStringify(self: *const ResponseHeadersWriter, jws: anytype) error{WriteFailed}!void {
        self._jsonStringify(jws) catch return error.WriteFailed;
    }

    fn _jsonStringify(self: *const ResponseHeadersWriter, jws: anytype) !void {
        var it = self.response.headerIterator();
        var map: std.StringArrayHashMapUnmanaged([]const u8) = .empty;
        while (it.next()) |hdr| {
            const gop = try map.getOrPut(self.arena, hdr.name);
            if (gop.found_existing) {
                const joined = try std.fmt.allocPrint(self.arena, "{s}\n{s}", .{ gop.value_ptr.*, hdr.value });
                gop.value_ptr.* = joined;
            } else {
                gop.value_ptr.* = try self.arena.dupe(u8, hdr.value);
            }
        }
        try jws.beginObject();
        var map_it = map.iterator();
        while (map_it.next()) |entry| {
            try jws.objectField(entry.key_ptr.*);
            try jws.write(entry.value_ptr.*);
        }
        try jws.endObject();
    }
};

const ResponseWriter = struct {
    arena: Allocator,
    response: *const Response,

    fn init(arena: Allocator, response: *const Response) ResponseWriter {
        return .{
            .arena = arena,
            .response = response,
        };
    }

    pub fn jsonStringify(self: *const ResponseWriter, jws: anytype) !void {
        self._jsonStringify(jws) catch return error.WriteFailed;
    }

    fn _jsonStringify(self: *const ResponseWriter, jws: anytype) !void {
        const response = self.response;

        try jws.beginObject();
        {
            try jws.objectField("url");
            try jws.write(response.url());
        }

        if (response.status()) |status| {
            try jws.objectField("status");
            try jws.write(status);

            try jws.objectField("statusText");
            try jws.write(@as(std.http.Status, @enumFromInt(status)).phrase() orelse "Unknown");
        }

        if (response.protocol()) |protocol| {
            try jws.objectField("protocol");
            try jws.write(protocol);
        }

        {
            const mime: Mime = blk: {
                if (response.contentType()) |ct| {
                    break :blk try Mime.parse(ct);
                }
                break :blk .unknown;
            };

            try jws.objectField("mimeType");
            try jws.write(mime.contentTypeString());
            try jws.objectField("charset");
            try jws.write(mime.charsetString());
        }

        {
            try jws.objectField("timing");
            try jws.write(.{
                // TODO: fix
                .requestTime = -1,
                .connectEnd = -1,
                .connectStart = -1,
                .dnsEnd = -1,
                .dnsStart = -1,
                .proxyEnd = -1,
                .proxyStart = -1,
                .receiveHeadersEnd = -1,
                .receiveHeadersStart = -1,
                .sendEnd = -1,
                .sendStart = -1,
                .sslEnd = -1,
                .sslStart = -1,
            });
        }

        {
            // chromedp doesn't like having duplicate header names. It's pretty
            // common to get these from a server (e.g. for Cache-Control), but
            // Chrome joins these. So we have to too.
            const arena = self.arena;
            var it = response.headerIterator();
            var map: std.StringArrayHashMapUnmanaged([]const u8) = .empty;
            while (it.next()) |hdr| {
                const gop = try map.getOrPut(arena, hdr.name);
                if (gop.found_existing) {
                    // yes, chrome joins multi-value headers with a \n
                    gop.value_ptr.* = try std.mem.join(arena, "\n", &.{ gop.value_ptr.*, hdr.value });
                } else {
                    gop.value_ptr.* = hdr.value;
                }
            }

            try jws.objectField("headers");
            try jws.write(std.json.ArrayHashMap([]const u8){ .map = map });
        }
        try jws.endObject();
    }
};

fn keyFromRequestId(request_id: []const u8) !CDP.BrowserContext.CapturedResponseKey {
    const key = std.fmt.parseInt(u32, request_id[4..], 10) catch return error.InvalidParams;

    return if (std.mem.startsWith(u8, request_id, "LID-"))
        .{ .id = key, .kind = .loader }
    else
        .{ .id = key, .kind = .request };
}

const testing = @import("../testing.zig");
test "cdp.network setExtraHTTPHeaders" {
    var ctx = try testing.context();
    defer ctx.deinit();

    _ = try ctx.loadBrowserContext(.{ .id = "NID-A", .session_id = "NESI-A" });
    // try ctx.processMessage(.{ .id = 10, .method = "Target.createTarget", .params = .{ .url = "about/blank" } });

    try ctx.processMessage(.{
        .id = 3,
        .method = "Network.setExtraHTTPHeaders",
        .params = .{ .headers = .{ .foo = "bar" } },
    });

    try ctx.processMessage(.{
        .id = 4,
        .method = "Network.setExtraHTTPHeaders",
        .params = .{ .headers = .{ .food = "bars" } },
    });

    const bc = ctx.cdp().browser_context.?;
    try testing.expectEqual(bc.extra_headers.items.len, 1);
}

test "cdp.Network: cookies" {
    const ResCookie = CdpStorage.ResCookie;
    const CdpCookie = CdpStorage.CdpCookie;

    var ctx = try testing.context();
    defer ctx.deinit();
    const bc = try ctx.loadBrowserContext(.{ .id = "BID-S" });
    bc.session.cookie_jar.clearRetainingCapacity();

    // Initially empty
    try ctx.processMessage(.{
        .id = 3,
        .method = "Network.getCookies",
        .params = .{ .urls = &[_][]const u8{"https://example.com/pancakes"} },
    });
    try ctx.expectSentResult(.{ .cookies = &[_]ResCookie{} }, .{ .id = 3 });

    // Has cookies after setting them
    try ctx.processMessage(.{
        .id = 4,
        .method = "Network.setCookie",
        .params = CdpCookie{ .name = "test3", .value = "valuenot3", .url = "https://car.example.com/defnotpancakes" },
    });
    try ctx.expectSentResult(null, .{ .id = 4 });
    try ctx.processMessage(.{
        .id = 5,
        .method = "Network.setCookies",
        .params = .{
            .cookies = &[_]CdpCookie{
                .{ .name = "test3", .value = "value3", .url = "https://car.example.com/pan/cakes" },
                .{ .name = "test4", .value = "value4", .domain = "example.com", .path = "/mango" },
            },
        },
    });
    try ctx.expectSentResult(null, .{ .id = 5 });
    try ctx.processMessage(.{
        .id = 6,
        .method = "Network.getCookies",
        .params = .{ .urls = &[_][]const u8{"https://car.example.com/pan/cakes"} },
    });
    try ctx.expectSentResult(.{
        .cookies = &[_]ResCookie{
            .{ .name = "test3", .value = "value3", .domain = "car.example.com", .path = "/", .size = 11, .secure = true }, // No Pancakes!
        },
    }, .{ .id = 6 });

    // deleteCookies
    try ctx.processMessage(.{
        .id = 7,
        .method = "Network.deleteCookies",
        .params = .{ .name = "test3", .domain = "car.example.com" },
    });
    try ctx.expectSentResult(null, .{ .id = 7 });
    try ctx.processMessage(.{
        .id = 8,
        .method = "Storage.getCookies",
        .params = .{ .browserContextId = "BID-S" },
    });
    // Just the untouched test4 should be in the result
    try ctx.expectSentResult(.{ .cookies = &[_]ResCookie{.{ .name = "test4", .value = "value4", .domain = ".example.com", .path = "/mango", .size = 11 }} }, .{ .id = 8 });

    // Empty after clearBrowserCookies
    try ctx.processMessage(.{
        .id = 9,
        .method = "Network.clearBrowserCookies",
    });
    try ctx.expectSentResult(null, .{ .id = 9 });
    try ctx.processMessage(.{
        .id = 10,
        .method = "Storage.getCookies",
        .params = .{ .browserContextId = "BID-S" },
    });
    try ctx.expectSentResult(.{ .cookies = &[_]ResCookie{} }, .{ .id = 10 });
}

test "cdp.Network.deleteCookies matches URL cookie path semantics" {
    const CdpCookie = CdpStorage.CdpCookie;
    const ResCookie = CdpStorage.ResCookie;

    var ctx = try testing.context();
    defer ctx.deinit();
    _ = try ctx.loadBrowserContext(.{ .id = "BID-DELETE-URL" });

    // Network.setCookies currently gives an omitted path the CDP default "/".
    // Deleting by the same deep URL must use path-match semantics, not compare
    // that cookie path with the URL's RFC default path as an exact string.
    try ctx.processMessage(.{
        .id = 1,
        .method = "Network.setCookies",
        .params = .{
            .cookies = &[_]CdpCookie{
                .{ .name = "default_path", .value = "x", .url = "https://example.com/v2/t2a/netpage" },
            },
        },
    });
    try ctx.expectSentResult(null, .{ .id = 1 });

    try ctx.processMessage(.{
        .id = 2,
        .method = "Network.deleteCookies",
        .params = .{
            .name = "default_path",
            .url = "https://example.com/v2/t2a/netpage",
        },
    });
    try ctx.expectSentResult(null, .{ .id = 2 });

    try ctx.processMessage(.{
        .id = 3,
        .method = "Storage.getCookies",
        .params = .{ .browserContextId = "BID-DELETE-URL" },
    });
    try ctx.expectSentResult(.{ .cookies = &[_]ResCookie{} }, .{ .id = 3 });
}

test "cdp.Network: clearBrowserCookies accepts empty params object" {
    const CdpCookie = CdpStorage.CdpCookie;
    const ResCookie = CdpStorage.ResCookie;

    var ctx = try testing.context();
    defer ctx.deinit();
    _ = try ctx.loadBrowserContext(.{ .id = "BID-N1" });

    try ctx.processMessage(.{
        .id = 1,
        .method = "Network.setCookie",
        .params = CdpCookie{ .name = "foo", .value = "bar", .url = "https://example.com/" },
    });
    try ctx.expectSentResult(null, .{ .id = 1 });

    // Most CDP clients (chrome-remote-interface, chromedp, etc.) always include
    // a `params` field on every command, even for methods that take none.
    // Chrome ignores the empty object; we should too. Sent as raw JSON because
    // an empty Zig anonymous struct serializes as `[]`, not `{}`.
    try ctx.processMessage(
        \\{"id":2,"method":"Network.clearBrowserCookies","params":{}}
    );
    try ctx.expectSentResult(null, .{ .id = 2 });

    try ctx.processMessage(.{
        .id = 3,
        .method = "Storage.getCookies",
        .params = .{ .browserContextId = "BID-N1" },
    });
    try ctx.expectSentResult(.{ .cookies = &[_]ResCookie{} }, .{ .id = 3 });
}

test "cdp.Network: getAllCookies returns whole jar regardless of current origin" {
    const CdpCookie = CdpStorage.CdpCookie;
    const ResCookie = CdpStorage.ResCookie;

    var ctx = try testing.context();
    defer ctx.deinit();
    _ = try ctx.loadBrowserContext(.{ .id = "BID-N2" });

    // Two cookies on different origins. With no current frame URL,
    // Network.getCookies (no `urls`) would return -32602 InvalidParams;
    // Network.getAllCookies must still return both.
    try ctx.processMessage(.{
        .id = 1,
        .method = "Network.setCookies",
        .params = .{
            .cookies = &[_]CdpCookie{
                .{ .name = "a", .value = "1", .url = "https://example.com/" },
                .{ .name = "b", .value = "2", .url = "https://other.test/" },
            },
        },
    });
    try ctx.expectSentResult(null, .{ .id = 1 });

    // Empty params object — sent as raw JSON because an empty Zig anonymous
    // struct serializes as `[]`, not `{}`.
    try ctx.processMessage(
        \\{"id":2,"method":"Network.getAllCookies","params":{}}
    );
    try ctx.expectSentResult(.{
        .cookies = &[_]ResCookie{
            .{ .name = "a", .value = "1", .domain = "example.com", .path = "/", .size = 2, .secure = true },
            .{ .name = "b", .value = "2", .domain = "other.test", .path = "/", .size = 2, .secure = true },
        },
    }, .{ .id = 2 });

    // Also works without any params field at all (CDP-spec literal "no params").
    try ctx.processMessage(.{
        .id = 3,
        .method = "Network.getAllCookies",
    });
    try ctx.expectSentResult(.{
        .cookies = &[_]ResCookie{
            .{ .name = "a", .value = "1", .domain = "example.com", .path = "/", .size = 2, .secure = true },
            .{ .name = "b", .value = "2", .domain = "other.test", .path = "/", .size = 2, .secure = true },
        },
    }, .{ .id = 3 });
}

test "cdp.Network.getResponseBody preserves text and encodes binary" {
    var ctx = try testing.context();
    defer ctx.deinit();
    const bc = try ctx.loadBrowserContext(.{ .id = "BID-RESPONSE-BODY" });

    const text_key: CDP.BrowserContext.CapturedResponseKey = .{ .kind = .request, .id = 11 };
    const text_entry = try bc.captured_responses.getOrPut(bc.frame_arena, text_key);
    text_entry.value_ptr.* = .{ .must_encode = false, .data = .empty };
    try text_entry.value_ptr.data.appendSlice(bc.frame_arena, "REAL-SERVER-BODY-alpha7");

    try ctx.processMessage(.{
        .id = 1,
        .method = "Network.getResponseBody",
        .params = .{ .requestId = "REQ-11" },
    });
    try ctx.expectSentResult(.{
        .body = "REAL-SERVER-BODY-alpha7",
        .base64Encoded = false,
    }, .{ .id = 1 });

    const binary_key: CDP.BrowserContext.CapturedResponseKey = .{ .kind = .request, .id = 12 };
    const binary_entry = try bc.captured_responses.getOrPut(bc.frame_arena, binary_key);
    binary_entry.value_ptr.* = .{ .must_encode = true, .data = .empty };
    try binary_entry.value_ptr.data.appendSlice(bc.frame_arena, &[_]u8{ 0, 0xff, 0x7f });

    try ctx.processMessage(.{
        .id = 2,
        .method = "Network.getResponseBody",
        .params = .{ .requestId = "REQ-12" },
    });
    try ctx.expectSentResult(.{
        .body = "AP9/",
        .base64Encoded = true,
    }, .{ .id = 2 });
}
