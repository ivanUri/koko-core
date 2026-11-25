const std = @import("std");
const js = @import("../../js/js.zig");
const Frame = @import("../../browser/Frame.zig");
const Parser = @import("../../browser/css/Parser.zig");

const CSSStyleRule = @import("CSSStyleRule.zig");

const CSSRule = @This();

pub const Type = union(enum) {
    style: *CSSStyleRule,
    charset: void,
    import: void,
    media: void,
    font_face: void,
    frame: void,
    keyframes: void,
    keyframe: void,
    margin: void,
    namespace: void,
    counter_style: void,
    supports: void,
    document: void,
    font_feature_values: void,
    viewport: void,
    region_style: void,
};

_type: Type,
_raw_css_text: ?[]const u8 = null,
_children: std.ArrayListUnmanaged(*CSSRule) = .empty,
_children_initialized: bool = false,

pub fn as(self: *CSSRule, comptime T: type) *T {
    return self.is(T).?;
}

pub fn is(self: *CSSRule, comptime T: type) ?*T {
    switch (self._type) {
        .style => |r| return if (T == CSSStyleRule) r else null,
        else => return null,
    }
}

pub fn init(rule_type: Type, frame: *Frame) !*CSSRule {
    return frame._factory.create(CSSRule{
        ._type = rule_type,
    });
}

pub fn initRaw(rule_type: Type, raw_css_text: []const u8, frame: *Frame) !*CSSRule {
    return frame._factory.create(CSSRule{
        ._type = rule_type,
        ._raw_css_text = try frame.dupeString(raw_css_text),
    });
}

fn isGroupingType(rule_type: Type) bool {
    return switch (rule_type) {
        .media, .keyframes, .supports, .document, .font_feature_values, .viewport => true,
        else => false,
    };
}

fn placeholderTypeForAtRule(rule: []const u8) Type {
    const trimmed = std.mem.trim(u8, rule, &std.ascii.whitespace);
    if (std.ascii.startsWithIgnoreCase(trimmed, "@media")) return .{ .media = {} };
    if (std.ascii.startsWithIgnoreCase(trimmed, "@keyframes") or std.ascii.startsWithIgnoreCase(trimmed, "@-webkit-keyframes")) return .{ .keyframes = {} };
    if (std.ascii.startsWithIgnoreCase(trimmed, "@font-face")) return .{ .font_face = {} };
    if (std.ascii.startsWithIgnoreCase(trimmed, "@import")) return .{ .import = {} };
    if (std.ascii.startsWithIgnoreCase(trimmed, "@supports")) return .{ .supports = {} };
    if (std.ascii.startsWithIgnoreCase(trimmed, "@charset")) return .{ .charset = {} };
    if (std.ascii.startsWithIgnoreCase(trimmed, "@namespace")) return .{ .namespace = {} };
    if (std.ascii.startsWithIgnoreCase(trimmed, "@counter-style")) return .{ .counter_style = {} };
    return .{ .supports = {} };
}

fn createStyleChild(rule: Parser.Rule, frame: *Frame) !*CSSRule {
    const style_rule = try CSSStyleRule.init(frame);
    try style_rule.setSelectorText(rule.selector, frame);
    const style_props = try style_rule.getStyle(frame);
    try style_props.asCSSStyleDeclaration().setCssText(rule.block, frame);
    return style_rule._proto;
}

fn ensureChildren(self: *CSSRule, frame: *Frame) !void {
    if (self._children_initialized or !isGroupingType(self._type)) return;
    self._children_initialized = true;

    const raw = self._raw_css_text orelse return;
    const open = std.mem.indexOfScalar(u8, raw, '{') orelse return;
    const close = std.mem.lastIndexOfScalar(u8, raw, '}') orelse raw.len;
    if (close <= open) return;

    var iterator = Parser.parseStylesheet(raw[open + 1 .. close]);
    while (iterator.nextItem()) |item| {
        const child = switch (item) {
            .style => |rule| try createStyleChild(rule, frame),
            .at_rule => |at_rule| try initRaw(placeholderTypeForAtRule(at_rule), at_rule, frame),
        };
        try self._children.append(frame.arena, child);
    }
}

pub fn getCssRules(self: *CSSRule, frame: *Frame) !?js.Object.Global {
    if (!isGroupingType(self._type)) return null;
    try ensureChildren(self, frame);
    const local = frame.js.local orelse return null;
    const array = local.newArray(@intCast(self._children.items.len));
    for (self._children.items, 0..) |child, index| {
        if (!(try array.set(@intCast(index), child, .{}))) return error.JsException;
    }
    return try array.toObject().persist();
}

pub fn insertRule(self: *CSSRule, rule: []const u8, maybe_index: ?u32, frame: *Frame) !u32 {
    if (!isGroupingType(self._type)) return error.InvalidState;
    try ensureChildren(self, frame);

    const requested_index = maybe_index orelse 0;
    if (requested_index > self._children.items.len) return error.IndexSizeError;

    var iterator = Parser.parseStylesheet(rule);
    const item = iterator.nextItem() orelse return error.SyntaxError;
    if (iterator.nextItem() != null) return error.SyntaxError;
    const child = switch (item) {
        .style => |parsed| try createStyleChild(parsed, frame),
        .at_rule => return error.HierarchyError,
    };
    try self._children.insert(frame.arena, requested_index, child);
    return requested_index;
}

pub fn getType(self: *const CSSRule) u16 {
    return @as(u16, @intFromEnum(std.meta.activeTag(self._type))) + 1;
}

pub fn getCssText(self: *const CSSRule, frame: *Frame) ![]const u8 {
    switch (self._type) {
        .style => |style_rule| return style_rule.getCssText(frame),
        else => {
            const raw = self._raw_css_text orelse return "";
            if (!self._children_initialized or self._children.items.len == 0) return raw;
            const open = std.mem.indexOfScalar(u8, raw, '{') orelse return raw;
            var output: std.ArrayList(u8) = .empty;
            try output.appendSlice(frame.call_arena, raw[0 .. open + 1]);
            for (self._children.items) |child| {
                try output.appendSlice(frame.call_arena, try child.getCssText(frame));
                try output.append(frame.call_arena, ' ');
            }
            try output.append(frame.call_arena, '}');
            return output.items;
        },
    }
}

pub fn getParentRule(_: *const CSSRule) ?*CSSRule {
    return null;
}

pub fn getParentStyleSheet(self: *const CSSRule) ?*CSSRule {
    _ = self;
    return null;
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(CSSRule);

    pub const Meta = struct {
        pub const name = "CSSRule";
        // The current rule wrapper owns the grouping-rule surface used by
        // CSSMediaRule (cssRules/insertRule). Keep the legacy interface name
        // available until the rule list gains runtime subtype objects.
        pub const constructor_alias = "CSSMediaRule";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };

    pub const STYLE_RULE = 1;
    pub const CHARSET_RULE = 2;
    pub const IMPORT_RULE = 3;
    pub const MEDIA_RULE = 4;
    pub const FONT_FACE_RULE = 5;
    pub const PAGE_RULE = 6;
    pub const KEYFRAMES_RULE = 7;
    pub const KEYFRAME_RULE = 8;
    pub const MARGIN_RULE = 9;
    pub const NAMESPACE_RULE = 10;
    pub const COUNTER_STYLE_RULE = 11;
    pub const SUPPORTS_RULE = 12;
    pub const DOCUMENT_RULE = 13;
    pub const FONT_FEATURE_VALUES_RULE = 14;
    pub const VIEWPORT_RULE = 15;
    pub const REGION_STYLE_RULE = 16;

    pub const @"type" = bridge.accessor(CSSRule.getType, null, .{});
    pub const cssText = bridge.accessor(CSSRule.getCssText, null, .{});
    pub const cssRules = bridge.accessor(CSSRule.getCssRules, null, .{ .null_as_undefined = true });
    pub const insertRule = bridge.function(CSSRule.insertRule, .{ .dom_exception = true });
    pub const parentRule = bridge.accessor(CSSRule.getParentRule, null, .{});
    pub const parentStyleSheet = bridge.accessor(CSSRule.getParentStyleSheet, null, .{});
};
