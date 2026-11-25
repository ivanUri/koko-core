const std = @import("std");

const js = @import("../../js/js.zig");
const Frame = @import("../../browser/Frame.zig");
const CSSRule = @import("CSSRule.zig");
const CSSConditionRule = @import("CSSConditionRule.zig");
const CSSMediaList = @import("CSSMediaList.zig");

const CSSMediaRule = @This();

_proto: *CSSConditionRule,
_media: *CSSMediaList,

pub fn init(raw_css_text: []const u8, frame: *Frame) !*CSSMediaRule {
    const condition_rule = try CSSConditionRule.init(frame);
    const media_rule = try frame._factory.create(CSSMediaRule{
        ._proto = condition_rule,
        ._media = undefined,
    });
    condition_rule._proto = try CSSRule.init(.{ .media = media_rule }, frame);
    condition_rule._proto._raw_css_text = try frame.dupeString(raw_css_text);

    const trimmed = std.mem.trim(u8, raw_css_text, &std.ascii.whitespace);
    const open = std.mem.indexOfScalar(u8, trimmed, '{') orelse trimmed.len;
    const header = std.mem.trim(u8, trimmed[0..open], &std.ascii.whitespace);
    const condition = if (std.ascii.startsWithIgnoreCase(header, "@media"))
        std.mem.trim(u8, header["@media".len..], &std.ascii.whitespace)
    else
        "";
    var normalized = @constCast(try frame.dupeString(condition));
    if (normalized.len > 0) {
        _ = std.ascii.lowerString(normalized, normalized);
        if (std.mem.startsWith(u8, normalized, "all and ")) {
            normalized = normalized[8..];
        }
    }
    condition_rule._condition_text = normalized;
    media_rule._media = try CSSMediaList.init(normalized, frame);
    return media_rule;
}

pub fn getMedia(self: *CSSMediaRule) *CSSMediaList {
    return self._media;
}

pub fn setMedia(self: *CSSMediaRule, text: []const u8, frame: *Frame) !void {
    try self._media.setMediaText(text, frame);
}

pub fn getConditionText(self: *const CSSMediaRule) []const u8 {
    return self._media.getMediaText();
}

pub fn getCssText(self: *const CSSMediaRule, frame: *Frame) ![]const u8 {
    const carrier = self._proto._proto;
    const rules = (try CSSRule.getCssRules(carrier, frame)) orelse return "";
    const condition = self.getConditionText();

    var output = std.Io.Writer.Allocating.init(frame.call_arena);
    if (condition.len == 0) {
        try output.writer.writeAll("@media  {\n");
    } else {
        try output.writer.print("@media {s} {{\n", .{condition});
    }
    for (0..rules.length()) |index| {
        const child = rules.item(index) orelse continue;
        try output.writer.print("  {s}\n", .{try child.getCssText(frame)});
    }
    try output.writer.writeByte('}');
    return output.written();
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(CSSMediaRule);

    pub const Meta = struct {
        pub const name = "CSSMediaRule";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };

    pub const media = bridge.accessor(CSSMediaRule.getMedia, CSSMediaRule.setMedia, .{});
    pub const conditionText = bridge.accessor(CSSMediaRule.getConditionText, null, .{});
};
