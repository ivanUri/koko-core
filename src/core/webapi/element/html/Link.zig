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
const js = @import("../../../js/js.zig");
const Frame = @import("../../../browser/Frame.zig");
const HttpClient = @import("../../../browser/HttpClient.zig");
const LoadGuard = @import("../../../browser/LoadGuard.zig");
const URL = @import("../../../browser/URL.zig");
const Event = @import("../../Event.zig");
const CSSStyleSheet = @import("../../css/CSSStyleSheet.zig");

const Node = @import("../../../dom/Node.zig");
const Element = @import("../../../dom/Element.zig");
const HtmlElement = @import("../Html.zig");

const Link = @This();
_proto: *HtmlElement,
_preload_loading: bool = false,
_preload_url: ?[:0]const u8 = null,
_stylesheet_loading: bool = false,
_stylesheet_url: ?[:0]const u8 = null,
_sheet: ?*CSSStyleSheet = null,

pub fn asElement(self: *Link) *Element {
    return self._proto._proto;
}
pub fn asConstElement(self: *const Link) *const Element {
    return self._proto._proto;
}
pub fn asNode(self: *Link) *Node {
    return self.asElement().asNode();
}

pub fn getHref(self: *Link, frame: *Frame) ![]const u8 {
    const element = self.asElement();
    const href = element.getAttributeSafe(comptime .wrap("href")) orelse return "";
    if (href.len == 0) {
        return "";
    }
    return element.asNode().resolveURL(href, frame, .{});
}

pub fn setHref(self: *Link, value: []const u8, frame: *Frame) !void {
    const element = self.asElement();
    try element.setAttributeSafe(comptime .wrap("href"), .wrap(value), frame);

    if (element.asNode().isConnected()) {
        try self.linkAddedCallback(frame);
    }
}

pub fn getRel(self: *Link) []const u8 {
    return self.asElement().getAttributeSafe(comptime .wrap("rel")) orelse return "";
}

pub fn setRel(self: *Link, value: []const u8, frame: *Frame) !void {
    try self.asElement().setAttributeSafe(comptime .wrap("rel"), .wrap(value), frame);
    if (self.asElement().asNode().isConnected()) {
        try self.linkAddedCallback(frame);
    }
}

pub fn getAs(self: *const Link) []const u8 {
    return self.asConstElement().getAttributeSafe(comptime .wrap("as")) orelse "";
}

pub fn setAs(self: *Link, value: []const u8, frame: *Frame) !void {
    return self.asElement().setAttributeSafe(comptime .wrap("as"), .wrap(value), frame);
}

pub fn getCrossOrigin(self: *const Link) ?[]const u8 {
    return self.asConstElement().getAttributeSafe(comptime .wrap("crossOrigin"));
}

pub fn setCrossOrigin(self: *Link, value: []const u8, frame: *Frame) !void {
    var normalized: []const u8 = "anonymous";
    if (std.ascii.eqlIgnoreCase(value, "use-credentials")) {
        normalized = "use-credentials";
    }
    return self.asElement().setAttributeSafe(comptime .wrap("crossOrigin"), .wrap(normalized), frame);
}

pub fn linkAddedCallback(self: *Link, frame: *Frame) !void {
    // if we're planning on navigating to another frame, don't trigger load event.
    if (frame.isGoingAway()) {
        return;
    }

    const element = self.asElement();

    const rel = element.getAttributeSafe(comptime .wrap("rel")) orelse return;

    if (std.mem.eql(u8, rel, "modulepreload")) {
        const href = element.getAttributeSafe(comptime .wrap("href")) orelse return;
        if (href.len == 0) return;
        const resolved = try self.asNode().resolveURL(href, frame, .{});
        const resolved_z: [:0]const u8 = resolved.ptr[0..resolved.len :0];
        try frame._script_manager.base.preloadImport(resolved_z, frame.base());
        return;
    }

    const is_stylesheet = std.ascii.eqlIgnoreCase(rel, "stylesheet");
    const is_preload = std.mem.eql(u8, rel, "preload");
    if (!is_stylesheet and !is_preload) {
        return;
    }

    const href = element.getAttributeSafe(comptime .wrap("href")) orelse return;
    if (href.len == 0) {
        return;
    }

    if (is_preload and std.ascii.eqlIgnoreCase(self.getAs(), "image")) {
        try self.fetchPreloadImage(frame, href);
        return;
    }

    if (is_stylesheet) {
        try self.fetchStylesheet(frame, href);
        return;
    }

    try frame.queueLoad(self._proto);
}

fn fetchStylesheet(self: *Link, frame: *Frame, href: []const u8) !void {
    const scratch = try frame.getArena(.small, "Link.stylesheet");
    var caller_owns_scratch = true;
    errdefer if (caller_owns_scratch) frame.releaseArena(scratch);

    const resolved = try URL.resolve(scratch, frame.base(), href, .{ .encoding = frame.charset });
    const owned_url = try frame.arena.dupeZ(u8, resolved);

    if (self._stylesheet_loading) {
        if (self._stylesheet_url) |previous| {
            if (std.mem.eql(u8, previous, owned_url)) {
                frame.releaseArena(scratch);
                caller_owns_scratch = false;
                return;
            }
        }
    } else if (self._stylesheet_url) |previous| {
        if (std.mem.eql(u8, previous, owned_url) and self._sheet != null) {
            frame.releaseArena(scratch);
            caller_owns_scratch = false;
            return;
        }
    }

    self._stylesheet_loading = true;
    self._stylesheet_url = owned_url;
    self._sheet = null;

    const session = frame._session;
    const http_client = &session.browser.http_client;
    var headers = try http_client.newHeaders();
    try frame.headersForRequest(&headers, .{
        .request_url = owned_url,
        .resource_type = .stylesheet,
        .include_origin_header = self.getCrossOrigin() != null,
    });

    const arena = scratch;
    const load = try arena.create(StylesheetLoad);
    load.* = .{
        .link = self,
        .frame = frame,
        .arena = arena,
        .url = owned_url,
        .guard = LoadGuard.Guard.init(&frame.js.execution),
    };

    // From this point the callback chain owns the arena, including synchronous
    // request errors that invoke errorCallback before returning.
    caller_owns_scratch = false;
    try http_client.request(.{
        .ctx = load,
        .params = .{
            .url = owned_url,
            .method = .GET,
            .frame_id = frame._frame_id,
            .attribution_frame = frame,
            .loader_id = frame._loader_id,
            .headers = headers,
            .cookie_jar = &session.cookie_jar,
            .cookie_origin = frame.url,
            .top_level_cookie_url = frame.topLevelUrl(),
            .resource_type = .stylesheet,
            .notification = session.notification,
        },
        .header_callback = StylesheetLoad.headerCallback,
        .data_callback = StylesheetLoad.dataCallback,
        .done_callback = StylesheetLoad.doneCallback,
        .error_callback = StylesheetLoad.errorCallback,
        .shutdown_callback = StylesheetLoad.shutdownCallback,
    });
}

const StylesheetLoad = struct {
    link: *Link,
    frame: *Frame,
    arena: std.mem.Allocator,
    url: [:0]const u8,
    status: u16 = 0,
    truncated: bool = false,
    guard: LoadGuard.Guard,
    body: std.ArrayList(u8) = .empty,

    const max_css_bytes = 4 * 1024 * 1024;

    fn deliverable(self: *const StylesheetLoad) bool {
        const frame = self.frame;
        return self.guard.isDeliverableForRealm(.{
            .realm_id = frame._frame_id,
            .epoch = frame._realm_epoch,
            .document_id = frame._loader_id,
        }, .{
            .realm_dead_or_draining = frame._realm_state == .dead or frame._realm_state == .draining,
            .going_away = frame.isGoingAway(),
        });
    }

    fn headerCallback(response: HttpClient.Response) !bool {
        const self: *StylesheetLoad = @ptrCast(@alignCast(response.ctx));
        self.status = response.status() orelse 0;
        return true;
    }

    fn dataCallback(response: HttpClient.Response, data: []const u8) !void {
        const self: *StylesheetLoad = @ptrCast(@alignCast(response.ctx));
        if (self.body.items.len >= max_css_bytes) {
            self.truncated = true;
            return;
        }
        const remaining = max_css_bytes - self.body.items.len;
        try self.body.appendSlice(self.arena, data[0..@min(data.len, remaining)]);
        if (data.len > remaining) self.truncated = true;
    }

    fn doneCallback(ctx: *anyopaque) !void {
        const self: *StylesheetLoad = @ptrCast(@alignCast(ctx));
        defer self.finish();
        self.link._stylesheet_loading = false;
        if (!self.deliverable()) return;

        if (self.status < 200 or self.status > 299 or self.truncated) {
            try self.dispatchError();
            return;
        }

        const sheet = CSSStyleSheet.initWithHrefOwner(self.url, self.link.asElement(), self.frame) catch {
            try self.dispatchError();
            return;
        };
        const sheets = self.frame.document.getStyleSheets(self.frame) catch {
            try self.dispatchError();
            return;
        };
        sheet.replaceSync(self.body.items, self.frame) catch {
            try self.dispatchError();
            return;
        };
        sheets.add(sheet, self.frame) catch {
            try self.dispatchError();
            return;
        };
        self.link._sheet = sheet;
        try self.frame.queueLoad(self.link._proto);
    }

    fn errorCallback(ctx: *anyopaque, _: anyerror) void {
        const self: *StylesheetLoad = @ptrCast(@alignCast(ctx));
        defer self.finish();
        self.link._stylesheet_loading = false;
        if (!self.deliverable()) return;
        self.dispatchError() catch {};
    }

    fn shutdownCallback(ctx: *anyopaque) void {
        const self: *StylesheetLoad = @ptrCast(@alignCast(ctx));
        self.link._stylesheet_loading = false;
        self.finish();
    }

    fn dispatchError(self: *StylesheetLoad) !void {
        const callback = try self.frame.arena.create(LinkErrorCallback);
        callback.* = .{
            .frame = self.frame,
            .link = self.link,
            .task_owner = self.frame.js.execution.captureTaskOwner(),
        };
        try self.frame.js.scheduler.add(callback, LinkErrorCallback.run, 0, .{
            .name = "Link.stylesheetError",
            .low_priority = false,
        });
    }

    fn finish(self: *StylesheetLoad) void {
        if (self.guard.isFinished()) return;
        self.guard.finished = true;
        self.body.deinit(self.arena);
        self.frame.releaseArena(self.arena);
    }
};

fn fetchPreloadImage(self: *Link, frame: *Frame, href: []const u8) !void {
    // Same arena ownership rules as Image.load: early-return / err paths must
    // release, and after http_client.request the PreloadLoad callbacks own it.
    // Shein (and other image-heavy sites) fire many <link rel=preload as=image>;
    // returning on a duplicate URL without releaseArena left Link.preload
    // arenas leaked → Debug ArenaPool panic on browser teardown.
    const scratch = try frame.getArena(.small, "Link.preload");
    var caller_owns_scratch = true;
    errdefer if (caller_owns_scratch) frame.releaseArena(scratch);

    const resolved = try URL.resolve(scratch, frame.base(), href, .{ .encoding = frame.charset });
    const owned_url = try frame.arena.dupeZ(u8, resolved);
    const preload_key = try frame.imagePreloadKey(
        frame.arena,
        owned_url,
        self.getCrossOrigin(),
    );

    if (self._preload_loading) {
        if (self._preload_url) |prev| {
            if (std.mem.eql(u8, prev, owned_url)) {
                frame.releaseArena(scratch);
                caller_owns_scratch = false;
                return;
            }
        }
    } else if (self._preload_url) |prev| {
        if (std.mem.eql(u8, prev, owned_url)) {
            frame.releaseArena(scratch);
            caller_owns_scratch = false;
            return;
        }
    }

    self._preload_loading = true;
    self._preload_url = owned_url;

    const arena = scratch;
    const load = try arena.create(PreloadLoad);
    load.* = .{
        .link = self,
        .frame = frame,
        .arena = arena,
        .guard = LoadGuard.Guard.init(&frame.js.execution),
        .preload_key = preload_key,
    };

    if (!try frame.beginImagePreload(preload_key)) {
        caller_owns_scratch = false;
        _ = try frame.useImagePreload(preload_key, load, PreloadLoad.preloadResultCallback);
        return;
    }

    const session = frame._session;
    const http_client = &session.browser.http_client;
    var headers = try http_client.newHeaders();
    try frame.headersForRequest(&headers, .{
        .request_url = owned_url,
        .resource_type = .image,
        // A preload must use the same request mode and credentials contract as
        // the eventual image consumer. Plain `as=image` is no-CORS; an explicit
        // crossorigin attribute opts the preload into CORS.
        .include_origin_header = self.getCrossOrigin() != null,
    });

    // Handoff before entering the async client (may call errorCallback sync).
    caller_owns_scratch = false;
    try http_client.request(.{
        .ctx = load,
        .params = .{
            .url = owned_url,
            .method = .GET,
            .frame_id = frame._frame_id,
            .attribution_frame = frame,
            .loader_id = frame._loader_id,
            .headers = headers,
            .cookie_jar = &session.cookie_jar,
            .cookie_origin = frame.url,
            .top_level_cookie_url = frame.topLevelUrl(),
            .resource_type = .image,
            .notification = session.notification,
        },
        .header_callback = PreloadLoad.headerCallback,
        .data_callback = PreloadLoad.dataCallback,
        .done_callback = PreloadLoad.doneCallback,
        .error_callback = PreloadLoad.errorCallback,
        .shutdown_callback = PreloadLoad.shutdownCallback,
    });
}

const PreloadLoad = struct {
    link: *Link,
    frame: *Frame,
    arena: std.mem.Allocator,
    status: u16 = 0,
    guard: LoadGuard.Guard,
    preload_key: []const u8,
    probe: std.ArrayList(u8) = .empty,

    const max_probe_bytes = 512 * 1024;

    fn deliverable(self: *const PreloadLoad) bool {
        const frame = self.frame;
        return self.guard.isDeliverableForRealm(.{
            .realm_id = frame._frame_id,
            .epoch = frame._realm_epoch,
            .document_id = frame._loader_id,
        }, .{
            .realm_dead_or_draining = frame._realm_state == .dead or frame._realm_state == .draining,
            .going_away = frame.isGoingAway(),
        });
    }

    fn headerCallback(response: HttpClient.Response) !bool {
        const self: *PreloadLoad = @ptrCast(@alignCast(response.ctx));
        self.status = response.status() orelse 0;
        return true;
    }

    fn dataCallback(response: HttpClient.Response, data: []const u8) !void {
        const self: *PreloadLoad = @ptrCast(@alignCast(response.ctx));
        if (self.probe.items.len >= max_probe_bytes) return;
        const remaining = max_probe_bytes - self.probe.items.len;
        try self.probe.appendSlice(self.arena, data[0..@min(data.len, remaining)]);
    }

    fn shutdownCallback(ctx: *anyopaque) void {
        const self: *PreloadLoad = @ptrCast(@alignCast(ctx));
        // Always clear loading + release arena; do not require deliverable.
        if (self.link._preload_loading) self.link._preload_loading = false;
        self.frame.completeImagePreload(self.preload_key, false, &.{}) catch {};
        self.finish();
    }

    fn doneCallback(ctx: *anyopaque) !void {
        const self: *PreloadLoad = @ptrCast(@alignCast(ctx));
        defer self.finish();
        // Settle flag even when the realm is going away so a later same-URL
        // preload does not think a fetch is still in flight.
        self.link._preload_loading = false;
        if (!self.deliverable()) return;

        const ok = self.status >= 200 and self.status <= 299;
        try self.frame.completeImagePreload(self.preload_key, ok, self.probe.items);
        if (ok) {
            try self.frame.queueLoad(self.link._proto);
        } else {
            try self.dispatchError();
        }
    }

    fn errorCallback(ctx: *anyopaque, _: anyerror) void {
        const self: *PreloadLoad = @ptrCast(@alignCast(ctx));
        defer self.finish();
        self.link._preload_loading = false;
        self.frame.completeImagePreload(self.preload_key, false, &.{}) catch {};
        if (!self.deliverable()) return;
        self.dispatchError() catch {};
    }

    fn preloadResultCallback(ctx: *anyopaque, result: Frame.ImagePreloadResult) !void {
        const self: *PreloadLoad = @ptrCast(@alignCast(ctx));
        defer self.finish();
        self.link._preload_loading = false;
        if (!self.deliverable()) return;
        if (result.ok) {
            try self.frame.queueLoad(self.link._proto);
        } else {
            try self.dispatchError();
        }
    }

    fn dispatchError(self: *PreloadLoad) !void {
        // Link resource errors are queued tasks. A preload can fail while a
        // framework is synchronously committing href/rel attributes; firing
        // the listener on that stack re-enters the commit before it unwinds.
        const callback = try self.frame.arena.create(LinkErrorCallback);
        callback.* = .{
            .frame = self.frame,
            .link = self.link,
            .task_owner = self.frame.js.execution.captureTaskOwner(),
        };
        try self.frame.js.scheduler.add(callback, LinkErrorCallback.run, 0, .{
            .name = "Link.error",
            .low_priority = false,
        });
    }

    fn finish(self: *PreloadLoad) void {
        if (self.guard.isFinished()) return;
        self.guard.finished = true;
        self.frame.releaseArena(self.arena);
    }
};

const LinkErrorCallback = struct {
    frame: *Frame,
    link: *Link,
    task_owner: @import("../../../../runtime/RealmLifecycleKernel.zig").TaskOwner,

    fn run(ctx: *anyopaque) !?u32 {
        const self: *LinkErrorCallback = @ptrCast(@alignCast(ctx));
        if (self.frame.js.execution.isTaskOwnerStale(self.task_owner)) return null;
        const event = try Event.initTrusted(comptime .wrap("error"), .{}, self.frame._page);
        try self.frame._event_manager.dispatch(self.link._proto.asEventTarget(), event);
        return null;
    }
};

pub const JsApi = struct {
    pub const bridge = js.Bridge(Link);

    pub const Meta = struct {
        pub const name = "HTMLLinkElement";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };

    pub const as = bridge.accessor(Link.getAs, Link.setAs, .{});
    pub const rel = bridge.accessor(Link.getRel, Link.setRel, .{});
    pub const href = bridge.accessor(Link.getHref, Link.setHref, .{});
    pub const sheet = bridge.accessor(Link.getSheet, null, .{ .null_as_undefined = true });
    pub const crossOrigin = bridge.accessor(Link.getCrossOrigin, Link.setCrossOrigin, .{});
    pub const relList = bridge.accessor(_getRelList, null, .{ .null_as_undefined = true });
    pub const sizes = bridge.accessor(_getSizesList, null, .{ .null_as_undefined = true });

    fn _getRelList(self: *Link, frame: *Frame) !?*@import("../../collections.zig").DOMTokenList {
        const element = self.asElement();
        // relList is only valid for HTML <link> elements, not SVG or MathML
        if (element._namespace != .html) {
            return null;
        }
        return element.getRelList(frame);
    }

    fn _getSizesList(self: *Link, frame: *Frame) !?*@import("../../collections.zig").DOMTokenList {
        const element = self.asElement();
        if (element._namespace != .html) {
            return null;
        }
        return element.getSizesList(frame);
    }
};

pub fn getSheet(self: *Link, _: *Frame) ?*CSSStyleSheet {
    return self._sheet;
}

pub const Build = struct {
    pub fn created(node: *Node, frame: *Frame) !void {
        const self = node.as(Link);
        return self.linkAddedCallback(frame);
    }
};

const testing = @import("../../../../testing/testing.zig");
test "WebApi: HTML.Link" {
    try testing.htmlRunner("element/html/link.html", .{});
}
