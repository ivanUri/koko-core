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

const js = @import("../../js/js.zig");
const Frame = @import("../../browser/Frame.zig");

const CData = @import("../CData.zig");
const CSSStyleSheet = @import("../css/CSSStyleSheet.zig");

const ProcessingInstruction = @This();

_proto: *CData,
_target: []const u8,
_sheet: ?*CSSStyleSheet = null,

pub fn getTarget(self: *const ProcessingInstruction) []const u8 {
    return self._target;
}

pub fn getSheet(self: *ProcessingInstruction, frame: *Frame) !?*CSSStyleSheet {
    if (self._sheet) |sheet| return sheet;
    if (!std.mem.eql(u8, self._target, "xml-stylesheet")) return null;

    const data = self._proto._data.str();
    const href_raw = extractQuotedAttribute(data, "href") orelse return null;
    const href = try decodeXmlEntities(frame.call_arena, href_raw);

    const sheet = try CSSStyleSheet.initWithHref(href, frame);
    self._sheet = sheet;
    return sheet;
}

fn extractQuotedAttribute(data: []const u8, attr: []const u8) ?[]const u8 {
    var i: usize = 0;
    while (i < data.len) {
        if (i + attr.len < data.len and std.mem.eql(u8, data[i .. i + attr.len], attr)) {
            var j = i + attr.len;
            while (j < data.len and std.ascii.isWhitespace(data[j])) : (j += 1) {}
            if (j >= data.len or data[j] != '=') {
                i += 1;
                continue;
            }
            j += 1;
            while (j < data.len and std.ascii.isWhitespace(data[j])) : (j += 1) {}
            if (j >= data.len) return null;
            const quote = data[j];
            if (quote != '"' and quote != '\'') {
                i += 1;
                continue;
            }
            j += 1;
            const start = j;
            while (j < data.len and data[j] != quote) : (j += 1) {}
            return data[start..j];
        }
        i += 1;
    }
    return null;
}

fn decodeXmlEntities(allocator: std.mem.Allocator, input: []const u8) ![]const u8 {
    var out: std.ArrayListUnmanaged(u8) = .empty;
    errdefer out.deinit(allocator);

    var i: usize = 0;
    while (i < input.len) {
        if (input[i] != '&') {
            try out.append(allocator, input[i]);
            i += 1;
            continue;
        }

        if (std.mem.startsWith(u8, input[i..], "&amp;")) {
            try out.append(allocator, '&');
            i += 5;
        } else if (std.mem.startsWith(u8, input[i..], "&apos;")) {
            try out.append(allocator, '\'');
            i += 6;
        } else if (std.mem.startsWith(u8, input[i..], "&quot;")) {
            try out.append(allocator, '"');
            i += 6;
        } else if (std.mem.startsWith(u8, input[i..], "&lt;")) {
            try out.append(allocator, '<');
            i += 4;
        } else if (std.mem.startsWith(u8, input[i..], "&gt;")) {
            try out.append(allocator, '>');
            i += 4;
        } else if (std.mem.startsWith(u8, input[i..], "&#x")) {
            const end = std.mem.indexOfScalar(u8, input[i..], ';') orelse {
                try out.append(allocator, input[i]);
                i += 1;
                continue;
            };
            const hex = input[i + 3 .. i + end];
            const cp = std.fmt.parseInt(u21, hex, 16) catch {
                try out.append(allocator, input[i]);
                i += 1;
                continue;
            };
            var buf: [4]u8 = undefined;
            const len = try std.unicode.utf8Encode(cp, &buf);
            try out.appendSlice(allocator, buf[0..len]);
            i += end + 1;
        } else if (std.mem.startsWith(u8, input[i..], "&#")) {
            const end = std.mem.indexOfScalar(u8, input[i..], ';') orelse {
                try out.append(allocator, input[i]);
                i += 1;
                continue;
            };
            const digits = input[i + 2 .. i + end];
            const cp = std.fmt.parseInt(u21, digits, 10) catch {
                try out.append(allocator, input[i]);
                i += 1;
                continue;
            };
            var buf: [4]u8 = undefined;
            const len = try std.unicode.utf8Encode(cp, &buf);
            try out.appendSlice(allocator, buf[0..len]);
            i += end + 1;
        } else {
            try out.append(allocator, input[i]);
            i += 1;
        }
    }

    return out.toOwnedSlice(allocator);
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(ProcessingInstruction);

    pub const Meta = struct {
        pub const name = "ProcessingInstruction";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
        pub const enumerable = false;
    };

    pub const target = bridge.accessor(ProcessingInstruction.getTarget, null, .{});
    pub const sheet = bridge.accessor(ProcessingInstruction.getSheet, null, .{ .null_as_undefined = true });
};

const testing = @import("../../../testing/testing.zig");
test "WebApi: ProcessingInstruction" {
    try testing.htmlRunner("processing_instruction.html", .{});
}
