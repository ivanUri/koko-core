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
const Element = @import("../dom/Element.zig");
const IFrame = @import("../webapi/element/html/IFrame.zig");

pub const Flags = struct {
    is_sandboxed: bool = false,
    allow_same_origin: bool = false,
    allow_scripts: bool = false,
};

pub fn parse(iframe: *IFrame) Flags {
    const element = iframe.asElement();
    const raw = element.getAttributeSafe(comptime .wrap("sandbox")) orelse return .{};
    if (raw.len == 0) {
        return .{ .is_sandboxed = true };
    }

    var flags: Flags = .{ .is_sandboxed = true };
    var it = std.mem.tokenizeAny(u8, raw, " \t\n\r\x0C");
    while (it.next()) |token| {
        if (std.ascii.eqlIgnoreCase(token, "allow-same-origin")) flags.allow_same_origin = true;
        if (std.ascii.eqlIgnoreCase(token, "allow-scripts")) flags.allow_scripts = true;
    }
    return flags;
}

pub fn blocksScripts(flags: Flags) bool {
    return flags.is_sandboxed and !flags.allow_scripts;
}

pub fn usesOpaqueOrigin(flags: Flags) bool {
    return flags.is_sandboxed and !flags.allow_same_origin;
}
