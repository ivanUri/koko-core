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

const js = @import("../../../js/js.zig");
const Frame = @import("../../../browser/Frame.zig");

const Node = @import("../../../dom/Node.zig");
const Element = @import("../../../dom/Element.zig");
const Media = @import("Media.zig");

const String = @import("../../../../support/string.zig").String;

const Audio = @This();

_proto: *Media,

pub fn constructor(maybe_url: ?String, frame: *Frame) !*Media {
    const node = try frame.createElementNS(.html, "audio", null);
    const el = node.as(Element);

    const list = try el.getOrCreateAttributeList(frame);
    // Always set to "auto" initially.
    _ = try list.putSafe(comptime .wrap("preload"), comptime .wrap("auto"), el, frame);
    // Set URL if provided.
    if (maybe_url) |url| {
        _ = try list.putSafe(comptime .wrap("src"), url, el, frame);
    }

    return node.as(Media);
}

pub fn asMedia(self: *Audio) *Media {
    return self._proto;
}

pub fn asElement(self: *Audio) *Element {
    return self._proto.asElement();
}

pub fn asNode(self: *Audio) *Node {
    return self.asElement().asNode();
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(Audio);

    pub const Meta = struct {
        pub const name = "HTMLAudioElement";
        pub const constructor_alias = "Audio";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };

    pub const constructor = bridge.constructor(Audio.constructor, .{});
};
