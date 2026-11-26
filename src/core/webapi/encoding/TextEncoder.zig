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
const js = @import("../../js/js.zig");

const TextEncoder = @This();
_pad: bool = false,

pub fn init() TextEncoder {
    return .{};
}

pub fn encode(_: *const TextEncoder, v_: ?js.Value) !js.TypedArray(u8) {
    const v = v_ orelse return .{ .values = "" };

    if (v.isUndefined()) {
        return .{ .values = "" };
    }

    if (v.isNull()) {
        return .{ .values = "null" };
    }

    const str = try v.toStringSlice();
    if (!std.unicode.utf8ValidateSlice(str)) {
        return error.InvalidUtf8;
    }

    return .{ .values = str };
}

/// Encode a string into an existing Uint8Array without allocating a second
/// buffer. `read` is measured in UTF-16 code units while `written` is the
/// number of UTF-8 bytes copied, matching the Encoding Standard contract.
pub fn encodeInto(_: *const TextEncoder, source: []const u8, destination: js.TypedArray(u8), exec: *const js.Execution) !js.Value {
    const local = exec.context.local orelse return error.JsEntryIllegal;
    var read: usize = 0;
    var written: usize = 0;
    var i: usize = 0;
    const output = @constCast(destination.values);

    while (i < source.len) {
        const cp_len = std.unicode.utf8ByteSequenceLength(source[i]) catch 1;
        if (i + cp_len > source.len) break;
        const cp = std.unicode.utf8Decode(source[i .. i + cp_len]) catch 0xFFFD;
        const utf8_len: usize = if (cp <= 0x7f) 1 else if (cp <= 0x7ff) 2 else if (cp <= 0xffff) 3 else 4;
        if (written + utf8_len > output.len) break;
        @memcpy(output[written .. written + utf8_len], source[i .. i + cp_len]);
        written += utf8_len;
        read += if (cp > 0xffff) 2 else 1;
        i += cp_len;
    }

    const result = local.newObject();
    _ = try result.set("read", read, .{});
    _ = try result.set("written", written, .{});
    return result.toValue();
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(TextEncoder);

    pub const Meta = struct {
        pub const name = "TextEncoder";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
        pub const empty_with_no_proto = true;
    };

    pub const constructor = bridge.constructor(TextEncoder.init, .{});
    pub const encode = bridge.function(TextEncoder.encode, .{ .as_typed_array = true });
    pub const encodeInto = bridge.function(TextEncoder.encodeInto, .{});
    pub const encoding = bridge.property("utf-8", .{ .template = false });
};

const testing = @import("../../../testing/testing.zig");
test "WebApi: TextEncoder" {
    try testing.htmlRunner("encoding/text_encoder.html", .{});
}
