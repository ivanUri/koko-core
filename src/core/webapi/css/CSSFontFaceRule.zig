const std = @import("std");

const js = @import("../../js/js.zig");
const Frame = @import("../../browser/Frame.zig");
const CSSRule = @import("CSSRule.zig");
const CSSStyleProperties = @import("CSSStyleProperties.zig");

const CSSFontFaceRule = @This();

_proto: *CSSRule,
_style: ?*CSSStyleProperties = null,

pub fn init(raw_css_text: []const u8, frame: *Frame) !*CSSFontFaceRule {
    const rule = try frame._factory.create(CSSFontFaceRule{ ._proto = undefined });
    rule._proto = try CSSRule.init(.{ .font_face = rule }, frame);
    rule._proto._raw_css_text = try frame.dupeString(raw_css_text);
    const style = try rule.getStyle(frame);
    try style.asCSSStyleDeclaration().setCssText(blockBody(raw_css_text) orelse "", frame);
    return rule;
}

pub fn getStyle(self: *CSSFontFaceRule, frame: *Frame) !*CSSStyleProperties {
    if (self._style) |style| return style;
    const style = try CSSStyleProperties.init(null, false, frame);
    self._style = style;
    return style;
}

pub fn setStyle(self: *CSSFontFaceRule, text: []const u8, frame: *Frame) !void {
    try (try self.getStyle(frame)).asCSSStyleDeclaration().setCssText(text, frame);
}

pub fn getCssText(self: *CSSFontFaceRule, frame: *Frame) ![]const u8 {
    const style_text = try (try self.getStyle(frame)).asCSSStyleDeclaration().getCssText(frame);
    var output = std.Io.Writer.Allocating.init(frame.call_arena);
    if (style_text.len == 0) {
        try output.writer.writeAll("@font-face { }");
    } else {
        try output.writer.print("@font-face {{ {s} }}", .{style_text});
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
    pub const bridge = js.Bridge(CSSFontFaceRule);

    pub const Meta = struct {
        pub const name = "CSSFontFaceRule";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };

    pub const style = bridge.accessor(CSSFontFaceRule.getStyle, CSSFontFaceRule.setStyle, .{});
    pub const cssText = bridge.accessor(CSSFontFaceRule.getCssText, null, .{});
};
