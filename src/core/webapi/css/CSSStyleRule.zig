const std = @import("std");
const js = @import("../../js/js.zig");
const Frame = @import("../../browser/Frame.zig");
const CSSRule = @import("CSSRule.zig");
const CSSStyleProperties = @import("CSSStyleProperties.zig");
const SelectorParser = @import("../selector/Parser.zig");

const CSSStyleRule = @This();

_proto: *CSSRule,
_selector_text: []const u8 = "",
_style: ?*CSSStyleProperties = null,

pub fn init(frame: *Frame) !*CSSStyleRule {
    const style_rule = try frame._factory.create(CSSStyleRule{
        ._proto = undefined,
    });
    style_rule._proto = try CSSRule.init(.{ .style = style_rule }, frame);
    return style_rule;
}

pub fn getSelectorText(self: *const CSSStyleRule) []const u8 {
    return self._selector_text;
}

/// CSSOM: parse the selector; on failure leave the previous value unchanged.
/// On success store the serialized form (An+B normalization, etc.).
pub fn setSelectorText(self: *CSSStyleRule, text: []const u8, frame: *Frame) !void {
    const trimmed = std.mem.trim(u8, text, &std.ascii.whitespace);
    if (trimmed.len == 0) return;

    const selectors = SelectorParser.parseList(frame.call_arena, trimmed) catch {
        // Invalid selector → attribute must not change.
        return;
    };
    if (selectors.len == 0) return;

    var buf = std.Io.Writer.Allocating.init(frame.call_arena);
    for (selectors, 0..) |sel, i| {
        if (i > 0) try buf.writer.writeAll(", ");
        try sel.format(&buf.writer);
    }
    self._selector_text = try frame.dupeString(buf.written());
}

pub fn getStyle(self: *CSSStyleRule, frame: *Frame) !*CSSStyleProperties {
    if (self._style) |style| {
        return style;
    }
    const style = try CSSStyleProperties.init(null, false, frame);
    self._style = style;
    return style;
}

pub fn getCssText(self: *CSSStyleRule, frame: *Frame) ![]const u8 {
    const style_props = try self.getStyle(frame);
    const style = style_props.asCSSStyleDeclaration();
    var buf = std.Io.Writer.Allocating.init(frame.call_arena);
    try buf.writer.print("{s} {{ ", .{self._selector_text});
    try style.format(&buf.writer);
    try buf.writer.writeAll(" }");
    return buf.written();
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(CSSStyleRule);

    pub const Meta = struct {
        pub const name = "CSSStyleRule";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };

    pub const selectorText = bridge.accessor(CSSStyleRule.getSelectorText, CSSStyleRule.setSelectorText, .{});
    pub const style = bridge.accessor(CSSStyleRule.getStyle, null, .{});
    pub const cssText = bridge.accessor(CSSStyleRule.getCssText, null, .{});
};
