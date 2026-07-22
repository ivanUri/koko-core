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

const URL = @import("URL.zig");
const U = @import("../browser/URL.zig");
const Frame = @import("../browser/Frame.zig");

const Location = @This();

_url: *URL,

pub fn init(raw_url: [:0]const u8, frame: *Frame) !*Location {
    const url = try URL.init(raw_url, null, &frame.js.execution);
    return frame._factory.create(Location{
        ._url = url,
    });
}

/// Browsing-context URL is the source of truth after history.pushState /
/// replaceState. Relying only on cached `_url` can leave window.location
/// stale while document.URL already moved (signup.live.com SPA routes).
fn liveRaw(_: *const Location, frame: *Frame) [:0]const u8 {
    return frame.url;
}

pub fn getPathname(self: *const Location, frame: *Frame) []const u8 {
    return U.getPathname(self.liveRaw(frame));
}

pub fn getProtocol(self: *const Location, frame: *Frame) []const u8 {
    return U.getProtocol(self.liveRaw(frame));
}

pub fn getHostname(self: *const Location, frame: *Frame) []const u8 {
    return U.getHostname(self.liveRaw(frame));
}

pub fn getHost(self: *const Location, frame: *Frame) []const u8 {
    return U.getHost(self.liveRaw(frame));
}

pub fn getPort(self: *const Location, frame: *Frame) []const u8 {
    return U.getPort(self.liveRaw(frame));
}

pub fn getOrigin(self: *const Location, frame: *Frame) ![]const u8 {
    _ = self;
    return (try U.getOrigin(frame.call_arena, frame.url)) orelse "null";
}

pub fn getSearch(self: *const Location, frame: *Frame) []const u8 {
    return U.getSearch(self.liveRaw(frame));
}

pub fn getHash(self: *const Location, frame: *Frame) []const u8 {
    return U.getHash(self.liveRaw(frame));
}

pub fn setPathname(_: *const Location, pathname: []const u8, frame: *Frame) !void {
    const new_url = try U.setPathname(frame.url, pathname, frame.call_arena);
    return frame.scheduleNavigation(new_url, .{
        .reason = .script,
        .kind = .{ .push = null },
    }, .{ .script = frame });
}

pub fn setSearch(_: *const Location, search: []const u8, frame: *Frame) !void {
    const new_url = try U.setSearch(frame.url, search, frame.call_arena);
    return frame.scheduleNavigation(new_url, .{
        .reason = .script,
        .kind = .{ .push = null },
    }, .{ .script = frame });
}

pub fn setHash(_: *const Location, hash: []const u8, frame: *Frame) !void {
    const normalized_hash = blk: {
        if (hash.len == 0) {
            const old_url = frame.url;

            break :blk if (std.mem.indexOfScalar(u8, old_url, '#')) |index|
                old_url[0..index]
            else
                old_url;
        } else if (hash[0] == '#')
            break :blk hash
        else
            break :blk try std.fmt.allocPrint(frame.call_arena, "#{s}", .{hash});
    };

    return frame.scheduleNavigation(normalized_hash, .{
        .reason = .script,
        .kind = .{ .replace = null },
    }, .{ .script = frame });
}

pub fn assign(_: *const Location, url: [:0]const u8, frame: *Frame) !void {
    return frame.scheduleNavigation(url, .{ .reason = .script, .kind = .{ .push = null } }, .{ .script = frame });
}

pub fn replace(_: *const Location, url: [:0]const u8, frame: *Frame) !void {
    return frame.scheduleNavigation(url, .{ .reason = .script, .kind = .{ .replace = null } }, .{ .script = frame });
}

pub fn reload(_: *const Location, frame: *Frame) !void {
    return frame.scheduleNavigation(frame.url, .{ .reason = .script, .kind = .reload }, .{ .script = frame });
}

pub fn toString(self: *const Location, frame: *Frame) [:0]const u8 {
    return self.liveRaw(frame);
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(Location);

    pub const Meta = struct {
        pub const name = "Location";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };

    pub const toString = bridge.function(Location.toString, .{});
    pub const href = bridge.accessor(Location.toString, setHref, .{});
    fn setHref(self: *const Location, url: [:0]const u8, frame: *Frame) !void {
        return self.assign(url, frame);
    }

    pub const search = bridge.accessor(Location.getSearch, Location.setSearch, .{});
    pub const hash = bridge.accessor(Location.getHash, Location.setHash, .{});
    pub const pathname = bridge.accessor(Location.getPathname, Location.setPathname, .{});
    pub const hostname = bridge.accessor(Location.getHostname, null, .{});
    pub const host = bridge.accessor(Location.getHost, null, .{});
    pub const port = bridge.accessor(Location.getPort, null, .{});
    pub const origin = bridge.accessor(Location.getOrigin, null, .{});
    pub const protocol = bridge.accessor(Location.getProtocol, null, .{});
    pub const assign = bridge.function(Location.assign, .{});
    pub const replace = bridge.function(Location.replace, .{});
    pub const reload = bridge.function(Location.reload, .{});
};
