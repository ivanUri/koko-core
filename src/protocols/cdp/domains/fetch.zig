// Copyright (C) 2023-2025    Koko (Selecy SAS)

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

const HttpClient = @import("../../../core/browser/HttpClient.zig");
const http = @import("../../../runtime/network/http.zig");
const Notification = @import("../../../runtime/Notification.zig");

const id = @import("../id.zig");
const CDP = @import("../CDP.zig");

const network = @import("network.zig");

const log = @import("../../../support/log.zig");
const Allocator = std.mem.Allocator;

pub fn processMessage(cmd: *CDP.Command) !void {
    const action = std.meta.stringToEnum(enum {
        disable,
        enable,
        continueRequest,
        failRequest,
        fulfillRequest,
        continueWithAuth,
    }, cmd.input.action) orelse return error.UnknownMethod;

    switch (action) {
        .disable => return disable(cmd),
        .enable => return enable(cmd),
        .continueRequest => return continueRequest(cmd),
        .continueWithAuth => return continueWithAuth(cmd),
        .failRequest => return failRequest(cmd),
        .fulfillRequest => return fulfillRequest(cmd),
    }
}

// Stored in CDP
pub const InterceptState = struct {
    allocator: Allocator,
    waiting: std.AutoArrayHashMapUnmanaged(u32, Pending),
    patterns: std.ArrayListUnmanaged(StoredPattern),

    const Pending = union(enum) {
        transfer: *HttpClient.Transfer,
        request: HttpClient.Request,
    };

    const StoredPattern = struct {
        url_pattern: []u8,
        resource_type: ?ResourceType,
        request_stage: RequestStage,
    };

    pub fn init(allocator: Allocator) !InterceptState {
        return .{
            .waiting = .empty,
            .allocator = allocator,
            .patterns = .empty,
        };
    }

    pub fn empty(self: *const InterceptState) bool {
        return self.waiting.count() == 0;
    }

    pub fn putRequest(self: *InterceptState, request: HttpClient.Request) !void {
        return self.waiting.put(self.allocator, request.params.request_id, .{ .request = request });
    }

    pub fn putTransfer(self: *InterceptState, transfer: *HttpClient.Transfer) !void {
        return self.waiting.put(self.allocator, transfer.id, .{ .transfer = transfer });
    }

    pub fn remove(self: *InterceptState, request_id: u32) ?Pending {
        const entry = self.waiting.fetchSwapRemove(request_id) orelse return null;
        return entry.value;
    }

    // Drop every pending entry. Called from page.zig's frameRemove hook
    // when the active Page is being torn down: the per-frame arena that
    // backs `Pending.request.params.{arena, url, headers, body}` is about
    // to be released back to the pool, and the in-flight `Pending.transfer`
    // for this frame will be killed by HttpClient.abortFrame in
    // Frame.deinit. Holding on to either kind of entry across the teardown
    // turns into a dangling pointer that the next continueRequest /
    // fulfillRequest / failRequest / continueWithAuth would dereference
    // (UAF segfault). The CDP client receives a clean RequestNotFound
    // error if it replies after the page is gone.
    pub fn clear(self: *InterceptState) void {
        self.waiting.clearRetainingCapacity();
    }

    pub fn deinit(self: *InterceptState) void {
        self.clearPatterns();
        self.patterns.deinit(self.allocator);
        self.waiting.deinit(self.allocator);
    }

    pub fn setPatterns(self: *InterceptState, patterns: []const RequestPattern) !void {
        self.clearPatterns();
        errdefer self.clearPatterns();

        // An omitted patterns parameter means all requests at the request
        // stage, matching the Fetch domain default.
        if (patterns.len == 0) {
            try self.patterns.append(self.allocator, .{
                .url_pattern = try self.allocator.dupe(u8, "*"),
                .resource_type = null,
                .request_stage = .Request,
            });
            return;
        }

        for (patterns) |pattern| {
            try self.patterns.append(self.allocator, .{
                .url_pattern = try self.allocator.dupe(u8, pattern.urlPattern),
                .resource_type = pattern.resourceType,
                .request_stage = pattern.requestStage,
            });
        }
    }

    pub fn clearPatterns(self: *InterceptState) void {
        for (self.patterns.items) |pattern| {
            self.allocator.free(pattern.url_pattern);
        }
        self.patterns.clearRetainingCapacity();
    }

    pub fn matches(self: *const InterceptState, request: *const HttpClient.Request) bool {
        for (self.patterns.items) |pattern| {
            if (pattern.request_stage != .Request) continue;
            if (pattern.resource_type) |resource_type| {
                if (!resourceTypeMatches(resource_type, request.params.resource_type)) continue;
            }
            if (wildcardMatch(pattern.url_pattern, request.params.url)) return true;
        }
        return false;
    }

    pub fn pendingIntercepts(self: *const InterceptState) []Pending {
        return self.waiting.values();
    }
};

const RequestPattern = struct {
    // Wildcards ('*' -> zero or more, '?' -> exactly one) are allowed.
    // Escape character is backslash. Omitting is equivalent to "*".
    urlPattern: []const u8 = "*",
    resourceType: ?ResourceType = null,
    requestStage: RequestStage = .Request,
};
const ResourceType = enum {
    Document,
    Stylesheet,
    Image,
    Media,
    Font,
    Script,
    TextTrack,
    XHR,
    Fetch,
    Prefetch,
    EventSource,
    WebSocket,
    Manifest,
    SignedExchange,
    Ping,
    CSPViolationReport,
    Preflight,
    FedCM,
    Other,
};
const RequestStage = enum {
    Request,
    Response,
};

const EnableParam = struct {
    patterns: []RequestPattern = &.{},
    handleAuthRequests: bool = false,
};
const ErrorReason = enum {
    Failed,
    Aborted,
    TimedOut,
    AccessDenied,
    ConnectionClosed,
    ConnectionReset,
    ConnectionRefused,
    ConnectionAborted,
    ConnectionFailed,
    NameNotResolved,
    InternetDisconnected,
    AddressUnreachable,
    BlockedByClient,
    BlockedByResponse,
};

fn disable(cmd: *CDP.Command) !void {
    const bc = cmd.browser_context orelse return error.BrowserContextNotLoaded;
    bc.fetchDisable();
    return cmd.sendResult(null, .{});
}

fn enable(cmd: *CDP.Command) !void {
    const params = (try cmd.params(EnableParam)) orelse EnableParam{};
    if (!arePatternsSupported(params.patterns)) {
        log.warn(.not_implemented, "Fetch.enable", .{ .params = "pattern" });
        return error.NotImplemented;
    }

    const bc = cmd.browser_context orelse return error.BrowserContextNotLoaded;
    try bc.intercept_state.setPatterns(params.patterns);
    try bc.fetchEnable(params.handleAuthRequests);

    return cmd.sendResult(null, .{});
}

fn arePatternsSupported(patterns: []RequestPattern) bool {
    if (patterns.len == 0) {
        return true;
    }
    for (patterns) |pattern| {
        // Response-stage interception requires response callbacks and a
        // different continuation path; do not acknowledge it as if it were
        // request-stage interception.
        if (pattern.requestStage != .Request) return false;
    }
    return true;
}

fn resourceTypeMatches(pattern: ResourceType, actual: HttpClient.RequestParams.ResourceType) bool {
    return switch (pattern) {
        .Document => actual == .document,
        .Stylesheet => actual == .stylesheet,
        .Image => actual == .image,
        .Script => actual == .script or actual == .worker,
        .XHR => actual == .xhr,
        .Fetch => actual == .fetch,
        .Ping => actual == .beacon,
        // Koko's HTTP layer does not currently classify these resource types.
        .Media, .Font, .TextTrack, .Prefetch, .EventSource, .WebSocket, .Manifest, .SignedExchange, .CSPViolationReport, .Preflight, .FedCM, .Other => false,
    };
}

/// Match Fetch.urlPattern without allocating. '*' matches zero or more
/// characters, '?' matches one, and '\\' quotes the following character.
fn wildcardMatch(pattern: []const u8, text: []const u8) bool {
    var pattern_index: usize = 0;
    var text_index: usize = 0;
    var star_index: ?usize = null;
    var star_text_index: usize = 0;

    while (text_index < text.len) {
        if (pattern_index < pattern.len) {
            const ch = pattern[pattern_index];
            if (ch == '*') {
                star_index = pattern_index;
                pattern_index += 1;
                star_text_index = text_index;
                continue;
            }
            if (ch == '\\' and pattern_index + 1 < pattern.len) {
                if (pattern[pattern_index + 1] == text[text_index]) {
                    pattern_index += 2;
                    text_index += 1;
                    continue;
                }
            } else if (ch == '?' or ch == text[text_index]) {
                pattern_index += 1;
                text_index += 1;
                continue;
            }
        }

        if (star_index) |star| {
            pattern_index = star + 1;
            star_text_index += 1;
            text_index = star_text_index;
            continue;
        }
        return false;
    }

    while (pattern_index < pattern.len and pattern[pattern_index] == '*') {
        pattern_index += 1;
    }
    return pattern_index == pattern.len;
}

pub fn requestIntercept(bc: *CDP.BrowserContext, intercept: *const Notification.RequestIntercept) !void {
    // detachTarget could be called, in which case, we still have a frame doing
    // things, but no session.
    const session_id = bc.session_id orelse return;

    // We keep it around to wait for modifications to the request.
    // TODO: What to do when receiving replies for a previous frame's requests?

    const request = intercept.request;
    if (!bc.intercept_state.matches(request)) return;
    try bc.intercept_state.putRequest(request.*);

    try bc.cdp.sendEvent("Fetch.requestPaused", .{
        .requestId = &id.toInterceptId(request.params.request_id),
        .frameId = &id.toFrameId(request.params.frame_id),
        .request = network.RequestWriter.init(request),
        .resourceType = switch (request.params.resource_type) {
            .script, .worker => "Script",
            .xhr => "XHR",
            .document => "Document",
            .fetch => "Fetch",
            .beacon => "Ping",
            .image => "Image",
            .stylesheet => "Stylesheet",
        },
        .networkId = &id.toRequestId(request), // matches the Network REQ-ID
    }, .{ .session_id = session_id });

    log.debug(.cdp, "request intercept", .{
        .state = "paused",
        .id = request.params.request_id,
        .url = request.params.url,
    });
    // Await either continueRequest, failRequest or fulfillRequest

    intercept.wait_for_interception.* = true;
}

fn continueRequest(cmd: *CDP.Command) !void {
    const bc = cmd.browser_context orelse return error.BrowserContextNotLoaded;
    const params = (try cmd.params(struct {
        requestId: []const u8, // INT-{d}"
        url: ?[]const u8 = null,
        method: ?[]const u8 = null,
        postData: ?[]const u8 = null,
        headers: ?[]const http.Header = null,
        interceptResponse: bool = false,
    })) orelse return error.InvalidParams;

    if (params.interceptResponse) {
        return error.NotImplemented;
    }

    var intercept_state = &bc.intercept_state;
    const request_id = try idFromRequestId(params.requestId);

    const pending = intercept_state.remove(request_id) orelse {
        // Navigation tore down the frame; stale intercept reply — noop success.
        return cmd.sendResult(null, .{});
    };
    var request = pending.request;

    log.debug(.cdp, "request intercept", .{
        .state = "continue",
        .id = request.params.request_id,
        .url = request.params.url,
        .new_url = params.url,
    });

    const arena = request.params.arena;
    // Update the request with the new parameters
    if (params.url) |url| {
        request.params.url = try arena.dupeZ(u8, url);
    }
    if (params.method) |method| {
        request.params.method = std.meta.stringToEnum(http.Method, method) orelse return error.InvalidParams;
    }

    if (params.headers) |headers| {
        request.params.headers.deinit();

        var buf: std.ArrayList(u8) = .empty;
        var new_headers = try bc.cdp.browser.http_client.newHeaders();
        for (headers) |hdr| {
            defer buf.clearRetainingCapacity();
            const line = try std.fmt.allocPrint(cmd.arena, "{s}: {s}", .{ hdr.name, hdr.value });
            try buf.appendSlice(cmd.arena, line);
            try buf.append(cmd.arena, 0);
            try new_headers.add(buf.items[0 .. buf.items.len - 1 :0]);
        }
        request.params.headers = new_headers;
    }

    if (params.postData) |b| {
        const decoder = std.base64.standard.Decoder;
        const body = try arena.alloc(u8, try decoder.calcSizeForSlice(b));
        try decoder.decode(body, b);
        request.params.body = body;
    }

    // todo: replace.
    const client = &bc.cdp.browser.http_client;
    try client.interception_layer.continueRequest(client, request);
    return cmd.sendResult(null, .{});
}

// https://chromedevtools.github.io/devtools-protocol/tot/Fetch/#type-AuthChallengeResponse
const AuthChallengeResponse = enum {
    Default,
    CancelAuth,
    ProvideCredentials,
};

fn continueWithAuth(cmd: *CDP.Command) !void {
    const bc = cmd.browser_context orelse return error.BrowserContextNotLoaded;
    const params = (try cmd.params(struct {
        requestId: []const u8, // "INT-{d}"
        authChallengeResponse: struct {
            response: AuthChallengeResponse,
            username: []const u8 = "",
            password: []const u8 = "",
        },
    })) orelse return error.InvalidParams;

    var intercept_state = &bc.intercept_state;
    const request_id = try idFromRequestId(params.requestId);
    const pending = intercept_state.remove(request_id) orelse {
        return cmd.sendResult(null, .{});
    };
    const transfer = pending.transfer;
    const request = transfer.req;

    log.debug(.cdp, "request intercept", .{
        .state = "continue with auth",
        .id = request.params.request_id,
        .response = params.authChallengeResponse.response,
    });

    const client = &bc.cdp.browser.http_client;

    if (params.authChallengeResponse.response != .ProvideCredentials) {
        transfer.abortAuthChallenge();
        return cmd.sendResult(null, .{});
    }

    // cancel the request, deinit the transfer on error.
    errdefer transfer.abortAuthChallenge();

    const arena = request.params.arena;
    transfer.updateCredentials(try std.fmt.allocPrintSentinel(
        arena,
        "{s}:{s}",
        .{
            params.authChallengeResponse.username,
            params.authChallengeResponse.password,
        },
        0,
    ));

    try client.continueTransfer(transfer);
    return cmd.sendResult(null, .{});
}

fn fulfillRequest(cmd: *CDP.Command) !void {
    const bc = cmd.browser_context orelse return error.BrowserContextNotLoaded;

    const params = (try cmd.params(struct {
        requestId: []const u8, // "INT-{d}"
        responseCode: u16,
        responseHeaders: ?[]const http.Header = null,
        binaryResponseHeaders: ?[]const u8 = null,
        body: ?[]const u8 = null,
        responsePhrase: ?[]const u8 = null,
    })) orelse return error.InvalidParams;

    if (params.binaryResponseHeaders != null) {
        log.warn(.not_implemented, "Fetch.fulfillRequest", .{ .param = "binaryResponseHeaders" });
        return error.NotImplemented;
    }

    var intercept_state = &bc.intercept_state;
    const request_id = try idFromRequestId(params.requestId);

    const pending = intercept_state.remove(request_id) orelse {
        return cmd.sendResult(null, .{});
    };
    var request = pending.request;

    log.debug(.cdp, "request intercept", .{
        .state = "fulfilled",
        .id = request.params.request_id,
        .url = request.params.url,
        .status = params.responseCode,
        .body = params.body != null,
    });

    var body: ?[]const u8 = null;
    if (params.body) |b| {
        const decoder = std.base64.standard.Decoder;
        const buf = try request.params.arena.alloc(u8, try decoder.calcSizeForSlice(b));
        try decoder.decode(buf, b);
        body = buf;
    }

    const client = &bc.cdp.browser.http_client;
    try client.interception_layer.fulfillRequest(client, request, params.responseCode, params.responseHeaders orelse &.{}, body);
    return cmd.sendResult(null, .{});
}

fn failRequest(cmd: *CDP.Command) !void {
    const bc = cmd.browser_context orelse return error.BrowserContextNotLoaded;
    const params = (try cmd.params(struct {
        requestId: []const u8, // "INT-{d}"
        errorReason: ErrorReason,
    })) orelse return error.InvalidParams;

    var intercept_state = &bc.intercept_state;
    const request_id = try idFromRequestId(params.requestId);

    const pending = intercept_state.remove(request_id) orelse {
        return cmd.sendResult(null, .{});
    };
    const request = pending.request;

    const client = &bc.cdp.browser.http_client;
    defer client.interception_layer.abortRequest(client, request);

    log.info(.cdp, "request intercept", .{
        .state = "fail",
        .id = request_id,
        .url = request.params.url,
        .reason = params.errorReason,
    });
    return cmd.sendResult(null, .{});
}

pub fn requestAuthRequired(bc: *CDP.BrowserContext, intercept: *const Notification.RequestAuthRequired) !void {
    // detachTarget could be called, in which case, we still have a frame doing
    // things, but no session.
    const session_id = bc.session_id orelse return;

    // We keep it around to wait for modifications to the request.
    // NOTE: we assume whomever created the request created it with a lifetime of the Page.
    // TODO: What to do when receiving replies for a previous frame's requests?

    const transfer = intercept.transfer;
    try bc.intercept_state.putTransfer(transfer);
    var request = transfer.req;

    const challenge = transfer._auth_challenge orelse return error.NullAuthChallenge;

    try bc.cdp.sendEvent("Fetch.authRequired", .{
        .requestId = &id.toInterceptId(request.params.request_id),
        .frameId = &id.toFrameId(request.params.frame_id),
        .request = network.RequestWriter.init(&request),
        .resourceType = switch (request.params.resource_type) {
            .script, .worker => "Script",
            .xhr => "XHR",
            .document => "Document",
            .fetch => "Fetch",
            .beacon => "Ping",
            .image => "Image",
            .stylesheet => "Stylesheet",
        },
        .authChallenge = .{
            .origin = "", // TODO get origin, could be the proxy address for example.
            .source = if (challenge.source) |s| (if (s == .server) "Server" else "Proxy") else "",
            .scheme = if (challenge.scheme) |s| (if (s == .digest) "digest" else "basic") else "",
            .realm = challenge.realm orelse "",
        },
        .networkId = &id.toRequestId(&request),
    }, .{ .session_id = session_id });

    log.debug(.cdp, "request auth required", .{
        .state = "paused",
        .id = request.params.request_id,
        .url = request.params.url,
    });
    // Await continueWithAuth

    intercept.wait_for_interception.* = true;
}

// Get u32 from requestId which is formatted as: "INT-{d}"
fn idFromRequestId(request_id: []const u8) !u32 {
    if (!std.mem.startsWith(u8, request_id, "INT-")) {
        return error.InvalidParams;
    }
    return std.fmt.parseInt(u32, request_id[4..], 10) catch return error.InvalidParams;
}

test "Fetch urlPattern wildcard matching" {
    try std.testing.expect(wildcardMatch("*", "https://example.test/path"));
    try std.testing.expect(wildcardMatch("*abbfetch-real*", "https://example.test/v0_2/fetch/abbfetch-real?x=1"));
    try std.testing.expect(!wildcardMatch("*abbfetch-real*", "https://example.test/v0_2/fetch/other"));
    try std.testing.expect(wildcardMatch("https://example.test/?", "https://example.test/a"));
    try std.testing.expect(!wildcardMatch("https://example.test/?", "https://example.test/ab"));
    try std.testing.expect(wildcardMatch("https://example.test/\\*", "https://example.test/*"));
}
