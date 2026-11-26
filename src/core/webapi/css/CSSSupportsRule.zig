const std = @import("std");

const js = @import("../../js/js.zig");
const Frame = @import("../../browser/Frame.zig");
const CSSRule = @import("CSSRule.zig");
const CSSConditionRule = @import("CSSConditionRule.zig");

const CSSSupportsRule = @This();

_proto: *CSSConditionRule,

pub fn init(raw_css_text: []const u8, frame: *Frame) !*CSSSupportsRule {
    const condition_rule = try CSSConditionRule.init(frame);
    const supports_rule = try frame._factory.create(CSSSupportsRule{
        ._proto = condition_rule,
    });
    condition_rule._proto = try CSSRule.init(.{ .supports = supports_rule }, frame);
    condition_rule._proto._raw_css_text = try frame.dupeString(raw_css_text);

    const trimmed = std.mem.trim(u8, raw_css_text, &std.ascii.whitespace);
    const open = std.mem.indexOfScalar(u8, trimmed, '{') orelse trimmed.len;
    const header = std.mem.trim(u8, trimmed[0..open], &std.ascii.whitespace);
    if (std.ascii.startsWithIgnoreCase(header, "@supports")) {
        condition_rule._condition_text = try frame.dupeString(std.mem.trim(u8, header["@supports".len..], &std.ascii.whitespace));
    }
    return supports_rule;
}

pub fn getCssText(self: *CSSSupportsRule, frame: *Frame) ![]const u8 {
    const carrier = self._proto._proto;
    const rules = (try CSSRule.getCssRules(carrier, frame)) orelse return "";
    var output = std.Io.Writer.Allocating.init(frame.call_arena);
    try output.writer.print("@supports {s} {{\n", .{self._proto._condition_text});
    for (0..rules.length()) |index| {
        const child = rules.item(index) orelse continue;
        try output.writer.print("  {s}\n", .{try child.getCssText(frame)});
    }
    try output.writer.writeByte('}');
    return output.written();
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(CSSSupportsRule);

    pub const Meta = struct {
        pub const name = "CSSSupportsRule";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };

    pub const cssText = bridge.accessor(CSSSupportsRule.getCssText, null, .{});
};
