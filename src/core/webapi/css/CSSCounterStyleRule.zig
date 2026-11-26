const std = @import("std");

const js = @import("../../js/js.zig");
const Frame = @import("../../browser/Frame.zig");
const CSSRule = @import("CSSRule.zig");
const CSSStyleProperties = @import("CSSStyleProperties.zig");

const CSSCounterStyleRule = @This();

_proto: *CSSRule,
_name: []const u8 = "",
_style: ?*CSSStyleProperties = null,

pub fn init(raw_css_text: []const u8, frame: *Frame) !*CSSCounterStyleRule {
    const rule = try frame._factory.create(CSSCounterStyleRule{ ._proto = undefined });
    rule._proto = try CSSRule.init(.{ .counter_style = rule }, frame);
    rule._proto._raw_css_text = try frame.dupeString(raw_css_text);
    const trimmed = std.mem.trim(u8, raw_css_text, &std.ascii.whitespace);
    const open = std.mem.indexOfScalar(u8, trimmed, '{') orelse trimmed.len;
    const header = std.mem.trim(u8, trimmed[0..open], &std.ascii.whitespace);
    if (std.ascii.startsWithIgnoreCase(header, "@counter-style")) {
        const name = std.mem.trim(u8, header["@counter-style".len..], &std.ascii.whitespace);
        rule._name = try frame.dupeString(name);
    }
    const style = try rule.getStyle(frame);
    try style.asCSSStyleDeclaration().setCssText(blockBody(raw_css_text) orelse "", frame);
    return rule;
}

pub fn getName(self: *const CSSCounterStyleRule) []const u8 {
    return self._name;
}

pub fn getStyle(self: *CSSCounterStyleRule, frame: *Frame) !*CSSStyleProperties {
    if (self._style) |style| return style;
    const style = try CSSStyleProperties.init(null, false, frame);
    self._style = style;
    return style;
}

pub fn setStyle(self: *CSSCounterStyleRule, text: []const u8, frame: *Frame) !void {
    try (try self.getStyle(frame)).asCSSStyleDeclaration().setCssText(text, frame);
}

pub fn getCssText(self: *CSSCounterStyleRule, frame: *Frame) ![]const u8 {
    const style_text = try (try self.getStyle(frame)).asCSSStyleDeclaration().getCssText(frame);
    var output = std.Io.Writer.Allocating.init(frame.call_arena);
    if (style_text.len == 0) {
        try output.writer.print("@counter-style {s} {{ }}", .{self._name});
    } else {
        try output.writer.print("@counter-style {s} {{ {s} }}", .{ self._name, style_text });
    }
    return output.written();
}

fn blockBody(source: []const u8) ?[]const u8 {
    const open = std.mem.indexOfScalar(u8, source, '{') orelse return null;
    const close = std.mem.lastIndexOfScalar(u8, source, '}') orelse return null;
    if (close <= open) return null;
    return source[open + 1 .. close];
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(CSSCounterStyleRule);

    pub const Meta = struct {
        pub const name = "CSSCounterStyleRule";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };

    pub const name = bridge.accessor(CSSCounterStyleRule.getName, null, .{});
    pub const style = bridge.accessor(CSSCounterStyleRule.getStyle, CSSCounterStyleRule.setStyle, .{});
    pub const cssText = bridge.accessor(CSSCounterStyleRule.getCssText, null, .{});
};
