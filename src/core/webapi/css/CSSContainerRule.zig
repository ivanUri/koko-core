const std = @import("std");

const js = @import("../../js/js.zig");
const Frame = @import("../../browser/Frame.zig");
const CSSRule = @import("CSSRule.zig");
const CSSConditionRule = @import("CSSConditionRule.zig");

const CSSContainerRule = @This();

_proto: *CSSConditionRule,
_container_name: []const u8 = "",
_container_query: []const u8 = "",

pub fn init(raw_css_text: []const u8, frame: *Frame) !*CSSContainerRule {
    const condition_rule = try CSSConditionRule.init(frame);
    const container_rule = try frame._factory.create(CSSContainerRule{ ._proto = condition_rule });
    condition_rule._proto = try CSSRule.init(.{ .container = container_rule }, frame);
    condition_rule._proto._raw_css_text = try frame.dupeString(raw_css_text);

    const trimmed = std.mem.trim(u8, raw_css_text, &std.ascii.whitespace);
    const open = std.mem.indexOfScalar(u8, trimmed, '{') orelse trimmed.len;
    const header = std.mem.trim(u8, trimmed[0..open], &std.ascii.whitespace);
    if (std.ascii.startsWithIgnoreCase(header, "@container")) {
        const prelude = std.mem.trim(u8, header["@container".len..], &std.ascii.whitespace);
        if (std.mem.indexOfScalar(u8, prelude, '(')) |query_start| {
            container_rule._container_name = try frame.dupeString(std.mem.trim(u8, prelude[0..query_start], &std.ascii.whitespace));
            container_rule._container_query = try frame.dupeString(std.mem.trim(u8, prelude[query_start..], &std.ascii.whitespace));
        } else {
            container_rule._container_name = try frame.dupeString(prelude);
        }
        container_rule._proto._condition_text = if (container_rule._container_name.len == 0)
            container_rule._container_query
        else if (container_rule._container_query.len == 0)
            container_rule._container_name
        else
            try std.fmt.allocPrint(frame.arena, "{s} {s}", .{ container_rule._container_name, container_rule._container_query });
    }
    return container_rule;
}

pub fn getContainerName(self: *const CSSContainerRule) []const u8 {
    return self._container_name;
}

pub fn getContainerQuery(self: *const CSSContainerRule) []const u8 {
    return self._container_query;
}

pub fn getConditionText(self: *const CSSContainerRule) []const u8 {
    return self._proto._condition_text;
}

pub fn getCssText(self: *CSSContainerRule, frame: *Frame) ![]const u8 {
    const carrier = self._proto._proto;
    const rules = (try CSSRule.getCssRules(carrier, frame)) orelse return "";
    var output = std.Io.Writer.Allocating.init(frame.call_arena);
    try output.writer.print("@container{s} {{\n", .{if (self._proto._condition_text.len == 0) "" else try std.fmt.allocPrint(frame.call_arena, " {s}", .{self._proto._condition_text})});
    for (0..rules.length()) |index| {
        const child = rules.item(index) orelse continue;
        try output.writer.print("  {s}\n", .{try child.getCssText(frame)});
    }
    try output.writer.writeByte('}');
    return output.written();
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(CSSContainerRule);

    pub const Meta = struct {
        pub const name = "CSSContainerRule";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };

    pub const containerName = bridge.accessor(CSSContainerRule.getContainerName, null, .{});
    pub const containerQuery = bridge.accessor(CSSContainerRule.getContainerQuery, null, .{});
    pub const conditionText = bridge.accessor(CSSContainerRule.getConditionText, null, .{});
};
