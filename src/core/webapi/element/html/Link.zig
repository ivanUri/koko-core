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
const URL = @import("../../../browser/URL.zig");
const Event = @import("../../Event.zig");

const Node = @import("../../../dom/Node.zig");
const Element = @import("../../../dom/Element.zig");
const HtmlElement = @import("../Html.zig");

const Link = @This();
_proto: *HtmlElement,
_preload_loading: bool = false,
_preload_url: ?[:0]const u8 = null,

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

    const loadable_rels = std.StaticStringMap(void).initComptime(.{
        .{ "stylesheet", {} },
        .{ "preload", {} },
    });
    if (loadable_rels.has(rel) == false) {
        return;
    }

    const href = element.getAttributeSafe(comptime .wrap("href")) orelse return;
    if (href.len == 0) {
        return;
    }

    if (std.mem.eql(u8, rel, "preload") and std.ascii.eqlIgnoreCase(self.getAs(), "image")) {
        try self.fetchPreloadImage(frame, href);
        return;
    }

    try frame.queueLoad(self._proto);
}

fn fetchPreloadImage(self: *Link, frame: *Frame, href: []const u8) !void {
    const scratch = try frame.getArena(.small, "Link.preload");
    const resolved = try URL.resolve(scratch, frame.base(), href, .{ .encoding = frame.charset });
    const owned_url = try frame.arena.dupeZ(u8, resolved);

    if (self._preload_loading) {
        if (self._preload_url) |prev| {
            if (std.mem.eql(u8, prev, owned_url)) return;
        }
    } else if (self._preload_url) |prev| {
        if (std.mem.eql(u8, prev, owned_url)) return;
    }

    self._preload_loading = true;
    self._preload_url = owned_url;

    const load = try scratch.create(PreloadLoad);
    load.* = .{
        .link = self,
        .frame = frame,
        .arena = scratch,
    };

    const session = frame._session;
    const http_client = &session.browser.http_client;
    var headers = try http_client.newHeaders();
    try frame.headersForRequest(&headers, .{
        .request_url = owned_url,
        .resource_type = .image,
    });

    try http_client.request(.{
        .ctx = load,
        .params = .{
            .url = owned_url,
            .method = .GET,
            .frame_id = frame._frame_id,
            .loader_id = frame._loader_id,
            .headers = headers,
            .cookie_jar = &session.cookie_jar,
            .cookie_origin = frame.url,
            .resource_type = .image,
            .notification = session.notification,
        },
        .header_callback = PreloadLoad.headerCallback,
        .data_callback = PreloadLoad.dataCallback,
        .done_callback = PreloadLoad.doneCallback,
        .error_callback = PreloadLoad.errorCallback,
    });
}

const PreloadLoad = struct {
    link: *Link,
    frame: *Frame,
    arena: std.mem.Allocator,
    status: u16 = 0,

    fn headerCallback(response: HttpClient.Response) !bool {
        const self: *PreloadLoad = @ptrCast(@alignCast(response.ctx));
        self.status = response.status() orelse 0;
        return true;
    }

    fn dataCallback(_: HttpClient.Response, _: []const u8) !void {}

    fn doneCallback(ctx: *anyopaque) !void {
        const self: *PreloadLoad = @ptrCast(@alignCast(ctx));
        defer self.finish();

        self.link._preload_loading = false;
        const ok = self.status >= 200 and self.status <= 299;

        if (ok) {
            try self.frame.queueLoad(self.link._proto);
        } else {
            try self.dispatchError();
        }
    }

    fn errorCallback(ctx: *anyopaque, _: anyerror) void {
        const self: *PreloadLoad = @ptrCast(@alignCast(ctx));
        self.link._preload_loading = false;
        self.dispatchError() catch {};
        self.finish();
    }

    fn dispatchError(self: *PreloadLoad) !void {
        const html = self.link._proto;
        if (html.hasAttributeFunction(.onerror, self.frame)) {
            const event = try Event.initTrusted(comptime .wrap("error"), .{}, self.frame._page);
            try self.frame._event_manager.dispatch(html.asEventTarget(), event);
        }
    }

    fn finish(self: *PreloadLoad) void {
        self.frame.releaseArena(self.arena);
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
    pub const crossOrigin = bridge.accessor(Link.getCrossOrigin, Link.setCrossOrigin, .{});
    pub const relList = bridge.accessor(_getRelList, null, .{ .null_as_undefined = true });

    fn _getRelList(self: *Link, frame: *Frame) !?*@import("../../collections.zig").DOMTokenList {
        const element = self.asElement();
        // relList is only valid for HTML <link> elements, not SVG or MathML
        if (element._namespace != .html) {
            return null;
        }
        return element.getRelList(frame);
    }
};

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
