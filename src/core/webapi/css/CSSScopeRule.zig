const std = @import("std");
const js = @import("../../js/js.zig");
const Frame = @import("../../browser/Frame.zig");
const CSSRule = @import("CSSRule.zig");
const CSSGroupingRule = @import("CSSGroupingRule.zig");

const CSSScopeRule = @This();

_proto: *CSSGroupingRule,
_condition_text: []const u8 = "",
_start: ?[]const u8 = null,
_end: ?[]const u8 = null,

pub fn init(raw_css_text: []const u8, frame: *Frame) !*CSSScopeRule {
    const grouping = try CSSGroupingRule.init(frame);
    const rule = try frame._factory.create(CSSScopeRule{ ._proto = grouping });
    grouping._proto = try CSSRule.init(.{ .scope = rule }, frame);
    grouping._proto._raw_css_text = try frame.dupeString(raw_css_text);

    const trimmed = std.mem.trim(u8, raw_css_text, &std.ascii.whitespace);
    const open = std.mem.indexOfScalar(u8, trimmed, '{') orelse trimmed.len;
    const header = std.mem.trim(u8, trimmed[0..open], &std.ascii.whitespace);
    if (std.ascii.startsWithIgnoreCase(header, "@scope")) {
        const prelude = std.mem.trim(u8, header["@scope".len..], &std.ascii.whitespace);
        rule._condition_text = try frame.dupeString(prelude);
        try parsePrelude(rule, prelude, frame);
    }
    return rule;
}

fn parsePrelude(rule: *CSSScopeRule, prelude: []const u8, frame: *Frame) !void {
    var rest = std.mem.trim(u8, prelude, &std.ascii.whitespace);
    if (std.ascii.startsWithIgnoreCase(rest, "to")) {
        rest = std.mem.trim(u8, rest[2..], &std.ascii.whitespace);
        rule._end = try parseSelector(rest, frame);
        return;
    }

    if (rest.len == 0 or rest[0] != '(') return;
    const root_end = matchingParen(rest) orelse return;
    rule._start = try frame.dupeString(std.mem.trim(u8, rest[1..root_end], &std.ascii.whitespace));
    rest = std.mem.trim(u8, rest[root_end + 1 ..], &std.ascii.whitespace);
    if (std.ascii.startsWithIgnoreCase(rest, "to")) {
        rest = std.mem.trim(u8, rest[2..], &std.ascii.whitespace);
        rule._end = try parseSelector(rest, frame);
    }
}

fn parseSelector(text: []const u8, frame: *Frame) !?[]const u8 {
    if (text.len == 0 or text[0] != '(') return null;
    const end = matchingParen(text) orelse return null;
    return try frame.dupeString(std.mem.trim(u8, text[1..end], &std.ascii.whitespace));
}

fn matchingParen(text: []const u8) ?usize {
    if (text.len == 0 or text[0] != '(') return null;
    var depth: usize = 0;
    var quote: u8 = 0;
    for (text, 0..) |c, index| {
        if (quote != 0) {
            if (c == quote and (index == 0 or text[index - 1] != '\\')) quote = 0;
            continue;
        }
        if (c == '"' or c == '\'') {
            quote = c;
        } else if (c == '(') {
            depth += 1;
        } else if (c == ')') {
            if (depth == 0) return null;
            depth -= 1;
            if (depth == 0) return index;
        }
    }
    return null;
}

pub fn getConditionText(self: *const CSSScopeRule) []const u8 {
    return self._condition_text;
}

pub fn getStart(self: *const CSSScopeRule) ?[]const u8 {
    return self._start;
}

pub fn getEnd(self: *const CSSScopeRule) ?[]const u8 {
    return self._end;
}

pub fn getCssText(self: *CSSScopeRule, frame: *Frame) ![]const u8 {
    const rules = (try CSSRule.getCssRules(self._proto._proto, frame)) orelse return "";
    var output = std.Io.Writer.Allocating.init(frame.call_arena);
    try output.writer.print("@scope{s} {{\n", .{if (self._condition_text.len == 0) "" else try std.fmt.allocPrint(frame.call_arena, " {s}", .{self._condition_text})});
    for (0..rules.length()) |index| {
        const child = rules.item(index) orelse continue;
        try output.writer.print("  {s}\n", .{try child.getCssText(frame)});
    }
    try output.writer.writeByte('}');
    return output.written();
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(CSSScopeRule);

    pub const Meta = struct {
        pub const name = "CSSScopeRule";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };

    pub const conditionText = bridge.accessor(CSSScopeRule.getConditionText, null, .{});
    pub const start = bridge.accessor(CSSScopeRule.getStart, null, .{});
    pub const end = bridge.accessor(CSSScopeRule.getEnd, null, .{});
};
