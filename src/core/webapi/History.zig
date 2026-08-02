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
const js = @import("../js/js.zig");

const Frame = @import("../browser/Frame.zig");
const Location = @import("Location.zig");
const PopStateEvent = @import("event/PopStateEvent.zig");
const URL = @import("URL.zig");

const History = @This();

const ScrollRestoration = enum { auto, manual };

_scroll_restoration: ScrollRestoration = .auto,
// History belongs to a browsing context, not to whichever realm happened to
// invoke a method through WindowProxy. The bridge-provided Frame is therefore
// only a fallback before the context is published.
_frame: ?*Frame = null,

pub fn onNewFrame(self: *History, frame: *Frame) void {
    self._frame = frame;
}

pub fn onRemoveFrame(self: *History) void {
    self._frame = null;
}

fn ownerFrame(self: *const History, fallback: *Frame) *Frame {
    return self._frame orelse fallback;
}

pub fn getLength(self: *const History, fallback: *Frame) u32 {
    const frame = self.ownerFrame(fallback);
    return @intCast(frame.navigationStore()._entries.items.len);
}

pub fn getState(self: *const History, fallback: *Frame) !?js.Value {
    const frame = self.ownerFrame(fallback);
    if (frame.navigationStore().getCurrentEntry()._state.value) |state| {
        const value = try frame.js.local.?.parseJSON(state);
        return value;
    } else return null;
}

pub fn getScrollRestoration(self: *History) []const u8 {
    return @tagName(self._scroll_restoration);
}

pub fn setScrollRestoration(self: *History, str: []const u8) void {
    if (std.meta.stringToEnum(ScrollRestoration, str)) |sr| {
        self._scroll_restoration = sr;
    }
}

fn applyHistoryUrl(frame: *Frame, url: [:0]const u8) !void {
    frame.url = url;
    // Mutate Location in place — do not replace the Location pointer. Replacing
    // it can leave JS-held Location identities on a stale URL while document.URL
    // (frame.url) already moved, which breaks SPA routers (signup.live.com).
    frame.window._location._url = try URL.init(url, null, &frame.js.execution);
    // Keep document.URL in lockstep when the document caches its own URL.
    frame.document._url = url;
}

fn canRewriteUrl(frame: *const Frame, url: [:0]const u8) bool {
    // An srcdoc document may rewrite only the fragment of about:srcdoc.
    // Relative references resolve against its creator-base snapshot, but that
    // does not authorize changing the inline document to the resolved URL.
    if (std.mem.startsWith(u8, frame.url, "about:srcdoc")) {
        if (!std.mem.startsWith(u8, url, "about:srcdoc")) return false;
        const suffix = url["about:srcdoc".len..];
        return suffix.len == 0 or suffix[0] == '#';
    }
    return frame.isSameOrigin(url);
}

pub fn pushState(self: *History, state: js.Value, _: ?[]const u8, _url: ?[]const u8, fallback: *Frame) !void {
    const frame = self.ownerFrame(fallback);
    const arena = frame._session.arena;
    const url = if (_url) |u|
        try @import("../browser/URL.zig").resolve(arena, frame.base(), u, .{ .always_dupe = true })
    else
        try arena.dupeZ(u8, frame.url);

    if (!canRewriteUrl(frame, url)) return error.SecurityError;

    const json = state.toJson(arena) catch return error.DataClone;
    _ = try frame.navigationStore().pushEntry(url, .{ .source = .history, .value = json }, frame, true);

    try applyHistoryUrl(frame, url);
}

pub fn replaceState(self: *History, state: js.Value, _: ?[]const u8, _url: ?[]const u8, fallback: *Frame) !void {
    const frame = self.ownerFrame(fallback);
    const arena = frame._session.arena;
    const url = if (_url) |u|
        try @import("../browser/URL.zig").resolve(arena, frame.base(), u, .{ .always_dupe = true })
    else
        try arena.dupeZ(u8, frame.url);

    if (!canRewriteUrl(frame, url)) return error.SecurityError;

    const json = state.toJson(arena) catch return error.DataClone;
    _ = try frame.navigationStore().replaceEntry(url, .{ .source = .history, .value = json }, frame, true);

    try applyHistoryUrl(frame, url);
}

fn goInner(delta: i32, frame: *Frame) !void {
    // 0 behaves the same as no argument, both reloading the frame.

    const navigation = frame.navigationStore();
    const current = navigation._index;
    const index_s: i64 = @intCast(@as(i64, @intCast(current)) + @as(i64, @intCast(delta)));
    if (index_s < 0 or index_s > navigation._entries.items.len - 1) {
        return;
    }

    const index = @as(usize, @intCast(index_s));
    const entry = navigation._entries.items[index];

    if (entry._url) |url| {
        if (frame.isSameOrigin(url)) {
            const target = frame.window.asEventTarget();
            if (frame._event_manager.hasDirectListeners(target, "popstate", frame.window._on_popstate)) {
                const event = (try PopStateEvent.initTrusted(comptime .wrap("popstate"), .{ .state = entry._state.value }, frame)).asEvent();
                try frame._event_manager.dispatchDirect(target, event, frame.window._on_popstate, .{ .context = "Pop State" });
            }
        }
    }

    _ = try navigation.navigateInner(entry._url, .{ .traverse = index }, frame);
}

pub fn back(self: *History, fallback: *Frame) !void {
    const frame = self.ownerFrame(fallback);
    try goInner(-1, frame);
}

pub fn forward(self: *History, fallback: *Frame) !void {
    const frame = self.ownerFrame(fallback);
    try goInner(1, frame);
}

pub fn go(self: *History, delta: ?i32, fallback: *Frame) !void {
    const frame = self.ownerFrame(fallback);
    try goInner(delta orelse 0, frame);
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(History);

    pub const Meta = struct {
        pub const name = "History";
        pub var class_id: bridge.ClassId = 0;
        pub const prototype_chain = bridge.prototypeChain();
    };

    pub const length = bridge.accessor(History.getLength, null, .{});
    pub const scrollRestoration = bridge.accessor(History.getScrollRestoration, History.setScrollRestoration, .{});
    pub const state = bridge.accessor(History.getState, null, .{});
    pub const pushState = bridge.function(History.pushState, .{ .dom_exception = true });
    pub const replaceState = bridge.function(History.replaceState, .{ .dom_exception = true });
    pub const back = bridge.function(History.back, .{});
    pub const forward = bridge.function(History.forward, .{});
    pub const go = bridge.function(History.go, .{});
};

const testing = @import("../../testing/testing.zig");
test "WebApi: History" {
    try testing.htmlRunner("history.html", .{});
    try testing.htmlRunner("history_url_update.html", .{});
}
