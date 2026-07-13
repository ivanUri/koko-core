const std = @import("std");
const js = @import("../../../js/js.zig");
const Frame = @import("../../../browser/Frame.zig");
const HttpClient = @import("../../../browser/HttpClient.zig");
const LoadGuard = @import("../../../browser/LoadGuard.zig");
const URL = @import("../../../browser/URL.zig");
const Event = @import("../../Event.zig");
const Node = @import("../../../dom/Node.zig");
const Element = @import("../../../dom/Element.zig");
const HtmlElement = @import("../Html.zig");

const Image = @This();
_proto: *HtmlElement,
_loading: bool = false,
_complete: bool = false,
_failed: bool = false,
_load_url: ?[:0]const u8 = null,

pub fn constructor(w_: ?u32, h_: ?u32, frame: *Frame) !*Image {
    const node = try frame.createElementNS(.html, "img", null);
    const el = node.as(Element);

    if (w_) |w| blk: {
        const w_string = std.fmt.bufPrint(&frame.buf, "{d}", .{w}) catch break :blk;
        try el.setAttributeSafe(comptime .wrap("width"), .wrap(w_string), frame);
    }
    if (h_) |h| blk: {
        const h_string = std.fmt.bufPrint(&frame.buf, "{d}", .{h}) catch break :blk;
        try el.setAttributeSafe(comptime .wrap("height"), .wrap(h_string), frame);
    }
    return el.as(Image);
}

pub fn asElement(self: *Image) *Element {
    return self._proto._proto;
}
pub fn asConstElement(self: *const Image) *const Element {
    return self._proto._proto;
}
pub fn asNode(self: *Image) *Node {
    return self.asElement().asNode();
}

pub fn getSrc(self: *const Image, frame: *Frame) ![]const u8 {
    const element = self.asConstElement();
    const src = element.getAttributeSafe(comptime .wrap("src")) orelse return "";
    if (src.len == 0) {
        return "";
    }
    return element.asConstNode().resolveURL(src, frame, .{});
}

pub fn setSrc(self: *Image, value: []const u8, frame: *Frame) !void {
    const element = self.asElement();
    try element.setAttributeSafe(comptime .wrap("src"), .wrap(value), frame);
    // No need to check if `Image` is connected to DOM; this is a special case.
    return self.imageAddedCallback(frame);
}

pub fn getAlt(self: *const Image) []const u8 {
    return self.asConstElement().getAttributeSafe(comptime .wrap("alt")) orelse "";
}

pub fn setAlt(self: *Image, value: []const u8, frame: *Frame) !void {
    try self.asElement().setAttributeSafe(comptime .wrap("alt"), .wrap(value), frame);
}

// `name` reflects the content attribute of the same name (per HTML spec
// for HTMLImageElement / nameditem semantics).
pub fn getName(self: *const Image) []const u8 {
    return self.asConstElement().getAttributeSafe(comptime .wrap("name")) orelse "";
}

pub fn setName(self: *Image, value: []const u8, frame: *Frame) !void {
    try self.asElement().setAttributeSafe(comptime .wrap("name"), .wrap(value), frame);
}

pub fn getWidth(self: *const Image) u32 {
    const attr = self.asConstElement().getAttributeSafe(comptime .wrap("width")) orelse return 0;
    return std.fmt.parseUnsigned(u32, attr, 10) catch 0;
}

pub fn setWidth(self: *Image, value: u32, frame: *Frame) !void {
    const str = try std.fmt.allocPrint(frame.call_arena, "{d}", .{value});
    try self.asElement().setAttributeSafe(comptime .wrap("width"), .wrap(str), frame);
}

pub fn getHeight(self: *const Image) u32 {
    const attr = self.asConstElement().getAttributeSafe(comptime .wrap("height")) orelse return 0;
    return std.fmt.parseUnsigned(u32, attr, 10) catch 0;
}

pub fn setHeight(self: *Image, value: u32, frame: *Frame) !void {
    const str = try std.fmt.allocPrint(frame.call_arena, "{d}", .{value});
    try self.asElement().setAttributeSafe(comptime .wrap("height"), .wrap(str), frame);
}

pub fn getCrossOrigin(self: *const Image) ?[]const u8 {
    return self.asConstElement().getAttributeSafe(comptime .wrap("crossorigin"));
}

pub fn setCrossOrigin(self: *Image, value: ?[]const u8, frame: *Frame) !void {
    if (value) |v| {
        return self.asElement().setAttributeSafe(comptime .wrap("crossorigin"), .wrap(v), frame);
    }
    return self.asElement().removeAttribute(comptime .wrap("crossorigin"), frame);
}

pub fn getLoading(self: *const Image) []const u8 {
    return self.asConstElement().getAttributeSafe(comptime .wrap("loading")) orelse "eager";
}

pub fn setLoading(self: *Image, value: []const u8, frame: *Frame) !void {
    try self.asElement().setAttributeSafe(comptime .wrap("loading"), .wrap(value), frame);
}

pub fn getNaturalWidth(_: *const Image) u32 {
    // this is a valid response under a number of normal conditions, but could
    // be used to detect the nature of Browser.
    return 0;
}

pub fn getNaturalHeight(_: *const Image) u32 {
    // this is a valid response under a number of normal conditions, but could
    // be used to detect the nature of Browser.
    return 0;
}

pub fn getComplete(self: *const Image) bool {
    const src = self.asConstElement().getAttributeSafe(comptime .wrap("src")) orelse return true;
    if (src.len == 0) return true;
    return !self._loading;
}

/// Used in `Page.nodeIsReady`.
pub fn imageAddedCallback(self: *Image, frame: *Frame) !void {
    // if we're planning on navigating to another frame, don't trigger load event.
    if (frame.isGoingAway()) {
        return;
    }

    const element = self.asElement();
    const src = element.getAttributeSafe(comptime .wrap("src")) orelse return;
    if (src.len == 0) return;

    const scratch = try frame.getArena(.small, "Image.load");
    errdefer frame.releaseArena(scratch);
    const resolved = try URL.resolve(scratch, frame.base(), src, .{ .encoding = frame.charset });
    const owned_url = try frame.arena.dupeZ(u8, resolved);

    if (self._loading) {
        if (self._load_url) |prev| {
            if (std.mem.eql(u8, prev, owned_url)) {
                frame.releaseArena(scratch);
                return;
            }
        }
    } else if (self._complete) {
        if (self._load_url) |prev| {
            if (std.mem.eql(u8, prev, owned_url)) {
                frame.releaseArena(scratch);
                return;
            }
        }
    }

    self._loading = true;
    self._complete = false;
    self._failed = false;
    self._load_url = owned_url;

    const arena = scratch;
    const load = try arena.create(ImageLoad);
    load.* = .{
        .image = self,
        .frame = frame,
        .arena = arena,
        .guard = LoadGuard.Guard.init(&frame.js.execution),
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
            .attribution_frame = frame,
            .loader_id = frame._loader_id,
            .headers = headers,
            .cookie_jar = &session.cookie_jar,
            .cookie_origin = frame.url,
            .top_level_cookie_url = frame.topLevelUrl(),
            .resource_type = .image,
            .notification = session.notification,
        },
        .header_callback = ImageLoad.headerCallback,
        .data_callback = ImageLoad.dataCallback,
        .done_callback = ImageLoad.doneCallback,
        .error_callback = ImageLoad.errorCallback,
        .shutdown_callback = ImageLoad.shutdownCallback,
    });
}

const ImageLoad = struct {
    image: *Image,
    frame: *Frame,
    arena: std.mem.Allocator,
    status: u16 = 0,
    guard: LoadGuard.Guard,

    fn deliverable(self: *const ImageLoad) bool {
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
        const self: *ImageLoad = @ptrCast(@alignCast(response.ctx));
        self.status = response.status() orelse 0;
        return true;
    }

    fn dataCallback(_: HttpClient.Response, _: []const u8) !void {}

    fn shutdownCallback(ctx: *anyopaque) void {
        const self: *ImageLoad = @ptrCast(@alignCast(ctx));
        self.finish();
    }

    fn doneCallback(ctx: *anyopaque) !void {
        const self: *ImageLoad = @ptrCast(@alignCast(ctx));
        defer self.finish();
        if (!self.deliverable()) return;

        const ok = self.status >= 200 and self.status <= 299;
        self.image._loading = false;
        self.image._complete = true;
        self.image._failed = !ok;

        if (ok) {
            try self.frame.queueLoad(self.image._proto);
        } else {
            try self.dispatchError();
        }
    }

    fn errorCallback(ctx: *anyopaque, _: anyerror) void {
        const self: *ImageLoad = @ptrCast(@alignCast(ctx));
        defer self.finish();
        if (!self.deliverable()) return;
        self.image._loading = false;
        self.image._complete = true;
        self.image._failed = true;
        self.dispatchError() catch {};
    }

    fn dispatchError(self: *ImageLoad) !void {
        const html = self.image._proto;
        if (html.hasAttributeFunction(.onerror, self.frame)) {
            const event = try Event.initTrusted(comptime .wrap("error"), .{}, self.frame._page);
            try self.frame._event_manager.dispatch(html.asEventTarget(), event);
        }
    }

    fn finish(self: *ImageLoad) void {
        if (self.guard.isFinished()) return;
        self.guard.finished = true;
        self.frame.releaseArena(self.arena);
    }
};

pub const JsApi = struct {
    pub const bridge = js.Bridge(Image);

    pub const Meta = struct {
        pub const name = "HTMLImageElement";
        pub const constructor_alias = "Image";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };

    pub const constructor = bridge.constructor(Image.constructor, .{});
    pub const src = bridge.accessor(Image.getSrc, Image.setSrc, .{});
    pub const currentSrc = bridge.accessor(Image.getSrc, null, .{});
    pub const alt = bridge.accessor(Image.getAlt, Image.setAlt, .{});
    pub const name = bridge.accessor(Image.getName, Image.setName, .{});
    pub const width = bridge.accessor(Image.getWidth, Image.setWidth, .{});
    pub const height = bridge.accessor(Image.getHeight, Image.setHeight, .{});
    pub const crossOrigin = bridge.accessor(Image.getCrossOrigin, Image.setCrossOrigin, .{});
    pub const loading = bridge.accessor(Image.getLoading, Image.setLoading, .{});
    pub const naturalWidth = bridge.accessor(Image.getNaturalWidth, null, .{});
    pub const naturalHeight = bridge.accessor(Image.getNaturalHeight, null, .{});
    pub const complete = bridge.accessor(Image.getComplete, null, .{});
};

pub const Build = struct {
    pub fn created(node: *Node, frame: *Frame) !void {
        const self = node.as(Image);
        return self.imageAddedCallback(frame);
    }
};

const testing = @import("../../../../testing/testing.zig");
test "WebApi: HTML.Image" {
    try testing.htmlRunner("element/html/image.html", .{});
}
