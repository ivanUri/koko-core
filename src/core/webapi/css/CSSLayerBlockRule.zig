const std = @import("std");
const js = @import("../../js/js.zig");
const Frame = @import("../../browser/Frame.zig");
const CSSRule = @import("CSSRule.zig");
const CSSGroupingRule = @import("CSSGroupingRule.zig");

const CSSLayerBlockRule = @This();

_proto: *CSSGroupingRule,
_name: []const u8 = "",

pub fn init(raw_css_text: []const u8, frame: *Frame) !*CSSLayerBlockRule {
    const grouping = try CSSGroupingRule.init(frame);
    const rule = try frame._factory.create(CSSLayerBlockRule{ ._proto = grouping });
    grouping._proto = try CSSRule.init(.{ .layer_block = rule }, frame);
    grouping._proto._raw_css_text = try frame.dupeString(raw_css_text);

    const trimmed = std.mem.trim(u8, raw_css_text, &std.ascii.whitespace);
    const open = std.mem.indexOfScalar(u8, trimmed, '{') orelse trimmed.len;
    const header = std.mem.trim(u8, trimmed[0..open], &std.ascii.whitespace);
    if (std.ascii.startsWithIgnoreCase(header, "@layer")) {
        rule._name = try frame.dupeString(std.mem.trim(u8, header["@layer".len..], &std.ascii.whitespace));
    }
    return rule;
}

pub fn getName(self: *const CSSLayerBlockRule) []const u8 {
    return self._name;
}

pub fn getCssText(self: *CSSLayerBlockRule, frame: *Frame) ![]const u8 {
    const carrier = self._proto._proto;
    const rules = (try CSSRule.getCssRules(carrier, frame)) orelse return "";
    var output = std.Io.Writer.Allocating.init(frame.call_arena);
    if (self._name.len == 0) {
        try output.writer.writeAll("@layer {\n");
    } else {
        try output.writer.print("@layer {s} {{\n", .{self._name});
    }
    for (0..rules.length()) |index| {
        const child = rules.item(index) orelse continue;
        try output.writer.print("  {s}\n", .{try child.getCssText(frame)});
    }
    try output.writer.writeByte('}');
    return output.written();
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(CSSLayerBlockRule);

    pub const Meta = struct {
        pub const name = "CSSLayerBlockRule";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };

    pub const name = bridge.accessor(CSSLayerBlockRule.getName, null, .{});
};
