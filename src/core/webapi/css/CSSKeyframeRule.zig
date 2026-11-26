const std = @import("std");

const js = @import("../../js/js.zig");
const Frame = @import("../../browser/Frame.zig");
const CSSRule = @import("CSSRule.zig");
const CSSStyleProperties = @import("CSSStyleProperties.zig");

const CSSKeyframeRule = @This();

_proto: *CSSRule,
_key_text: []const u8 = "0%",
_style: ?*CSSStyleProperties = null,

pub fn init(key_text: []const u8, block: []const u8, frame: *Frame) !*CSSKeyframeRule {
    const keyframe = try frame._factory.create(CSSKeyframeRule{
        ._proto = undefined,
    });
    keyframe._proto = try CSSRule.init(.{ .keyframe = keyframe }, frame);
    try keyframe.setKeyText(key_text, frame);
    const style = try keyframe.getStyle(frame);
    try style.asCSSStyleDeclaration().setCssText(block, frame);
    return keyframe;
}

pub fn getKeyText(self: *const CSSKeyframeRule) []const u8 {
    return self._key_text;
}

pub fn setKeyText(self: *CSSKeyframeRule, text: []const u8, frame: *Frame) !void {
    const normalized = try normalizeKeyText(text, frame);
    self._key_text = normalized;
}

pub fn getStyle(self: *CSSKeyframeRule, frame: *Frame) !*CSSStyleProperties {
    if (self._style) |style| return style;
    const style = try CSSStyleProperties.init(null, false, frame);
    self._style = style;
    return style;
}

/// CSSOM [PutForwards=cssText].
pub fn setStyle(self: *CSSKeyframeRule, text: []const u8, frame: *Frame) !void {
    const style = try self.getStyle(frame);
    try style.asCSSStyleDeclaration().setCssText(text, frame);
}

pub fn getCssText(self: *CSSKeyframeRule, frame: *Frame) ![]const u8 {
    const style = (try self.getStyle(frame)).asCSSStyleDeclaration();
    const style_text = try style.getCssText(frame);
    var output = std.Io.Writer.Allocating.init(frame.call_arena);
    if (style_text.len == 0) {
        try output.writer.print("{s} {{ }}", .{self._key_text});
    } else {
        try output.writer.print("{s} {{ {s} }}", .{ self._key_text, style_text });
    }
    return output.written();
}

fn normalizeKeyText(text: []const u8, frame: *Frame) ![]const u8 {
    const trimmed = std.mem.trim(u8, text, &std.ascii.whitespace);
    if (trimmed.len == 0) return error.SyntaxError;

    var output = std.ArrayList(u8).empty;
    var iterator = std.mem.splitScalar(u8, trimmed, ',');
    var count: usize = 0;
    while (iterator.next()) |part| {
        const token = std.mem.trim(u8, part, &std.ascii.whitespace);
        if (token.len == 0) return error.SyntaxError;
        if (count > 0) try output.appendSlice(frame.call_arena, ", ");
        try appendNormalizedKey(token, &output, frame);
        count += 1;
    }
    if (count == 0) return error.SyntaxError;
    return try frame.dupeString(output.items);
}

fn appendNormalizedKey(token: []const u8, output: *std.ArrayList(u8), frame: *Frame) !void {
    if (std.ascii.eqlIgnoreCase(token, "from")) {
        try output.appendSlice(frame.call_arena, "0%");
        return;
    }
    if (std.ascii.eqlIgnoreCase(token, "to")) {
        try output.appendSlice(frame.call_arena, "100%");
        return;
    }
    if (token[token.len - 1] != '%') return error.SyntaxError;
    const number = std.mem.trim(u8, token[0 .. token.len - 1], &std.ascii.whitespace);
    if (number.len == 0) return error.SyntaxError;
    const value = std.fmt.parseFloat(f64, number) catch return error.SyntaxError;
    if (!std.math.isFinite(value) or value < 0 or value > 100) return error.SyntaxError;

    var buffer: [64]u8 = undefined;
    const formatted = std.fmt.bufPrint(&buffer, "{d}", .{value}) catch return error.SyntaxError;
    try output.appendSlice(frame.call_arena, formatted);
    try output.append(frame.call_arena, '%');
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(CSSKeyframeRule);

    pub const Meta = struct {
        pub const name = "CSSKeyframeRule";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };

    pub const keyText = bridge.accessor(CSSKeyframeRule.getKeyText, CSSKeyframeRule.setKeyText, .{ .dom_exception = true });
    pub const style = bridge.accessor(CSSKeyframeRule.getStyle, CSSKeyframeRule.setStyle, .{});
    pub const cssText = bridge.accessor(CSSKeyframeRule.getCssText, null, .{});
};
