const std = @import("std");
const js = @import("../../js/js.zig");
const Frame = @import("../../browser/Frame.zig");
const Parser = @import("../../browser/css/Parser.zig");

const CSSStyleRule = @import("CSSStyleRule.zig");
const CSSMediaRule = @import("CSSMediaRule.zig");
const CSSSupportsRule = @import("CSSSupportsRule.zig");
const CSSKeyframesRule = @import("CSSKeyframesRule.zig");
const CSSKeyframeRule = @import("CSSKeyframeRule.zig");
const CSSStyleSheet = @import("CSSStyleSheet.zig");
const CSSRuleList = @import("CSSRuleList.zig");

const CSSRule = @This();

pub const Type = union(enum) {
    style: *CSSStyleRule,
    charset: void,
    import: void,
    media: *CSSMediaRule,
    font_face: void,
    frame: void,
    keyframes: *CSSKeyframesRule,
    keyframe: *CSSKeyframeRule,
    margin: void,
    namespace: void,
    counter_style: void,
    supports: *CSSSupportsRule,
    document: void,
    font_feature_values: void,
    viewport: void,
    region_style: void,
};

_type: Type,
_raw_css_text: ?[]const u8 = null,
_children: ?*CSSRuleList = null,
_children_initialized: bool = false,
_parent_rule: ?*CSSRule = null,
_parent_style_sheet: ?*CSSStyleSheet = null,

pub fn as(self: *CSSRule, comptime T: type) *T {
    return self.is(T).?;
}

pub fn is(self: *CSSRule, comptime T: type) ?*T {
    switch (self._type) {
        .style => |r| return if (T == CSSStyleRule) r else null,
        .media => |r| return if (T == CSSMediaRule) r else null,
        .supports => |r| return if (T == CSSSupportsRule) r else null,
        .keyframes => |r| return if (T == CSSKeyframesRule) r else null,
        .keyframe => |r| return if (T == CSSKeyframeRule) r else null,
        else => return null,
    }
}

pub fn init(rule_type: Type, frame: *Frame) !*CSSRule {
    return frame._factory.create(CSSRule{
        ._type = rule_type,
    });
}

pub fn initRaw(rule_type: Type, raw_css_text: []const u8, frame: *Frame) !*CSSRule {
    switch (rule_type) {
        .media => |media_rule| {
            media_rule._proto._proto._raw_css_text = try frame.dupeString(raw_css_text);
            return media_rule._proto._proto;
        },
        else => {},
    }
    return frame._factory.create(CSSRule{
        ._type = rule_type,
        ._raw_css_text = try frame.dupeString(raw_css_text),
    });
}

pub fn initAtRule(raw_css_text: []const u8, frame: *Frame) !*CSSRule {
    const trimmed = std.mem.trim(u8, raw_css_text, &std.ascii.whitespace);
    if (std.ascii.startsWithIgnoreCase(trimmed, "@media")) {
        const media_rule = try CSSMediaRule.init(raw_css_text, frame);
        return media_rule._proto._proto;
    }
    if (std.ascii.startsWithIgnoreCase(trimmed, "@supports")) {
        const supports_rule = try CSSSupportsRule.init(raw_css_text, frame);
        return supports_rule._proto._proto;
    }
    if (std.ascii.startsWithIgnoreCase(trimmed, "@keyframes") or std.ascii.startsWithIgnoreCase(trimmed, "@-webkit-keyframes")) {
        const keyframes_rule = try CSSKeyframesRule.init(raw_css_text, frame);
        return keyframes_rule._proto;
    }
    return initRaw(placeholderTypeForAtRule(raw_css_text), raw_css_text, frame);
}

fn children(self: *CSSRule, frame: *Frame) !*CSSRuleList {
    if (self._children) |list| return list;
    const list = try CSSRuleList.init(frame);
    self._children = list;
    return list;
}

fn isGroupingType(rule_type: Type) bool {
    return switch (rule_type) {
        .media, .keyframes, .supports, .document, .font_feature_values, .viewport => true,
        else => false,
    };
}

fn placeholderTypeForAtRule(rule: []const u8) Type {
    const trimmed = std.mem.trim(u8, rule, &std.ascii.whitespace);
    // @media is materialized by initAtRule so its runtime subtype is retained.
    // These at-rules are materialized by initAtRule before this fallback is
    // reached. Keep the fallback as a raw placeholder for malformed input.
    if (std.ascii.startsWithIgnoreCase(trimmed, "@keyframes") or std.ascii.startsWithIgnoreCase(trimmed, "@-webkit-keyframes")) return .{ .font_face = {} };
    if (std.ascii.startsWithIgnoreCase(trimmed, "@font-face")) return .{ .font_face = {} };
    if (std.ascii.startsWithIgnoreCase(trimmed, "@import")) return .{ .import = {} };
    if (std.ascii.startsWithIgnoreCase(trimmed, "@supports")) return .{ .font_face = {} };
    if (std.ascii.startsWithIgnoreCase(trimmed, "@charset")) return .{ .charset = {} };
    if (std.ascii.startsWithIgnoreCase(trimmed, "@namespace")) return .{ .namespace = {} };
    if (std.ascii.startsWithIgnoreCase(trimmed, "@counter-style")) return .{ .counter_style = {} };
    return .{ .font_face = {} };
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
    const rules = try children(self, frame);

    const raw = self._raw_css_text orelse return;
    const open = std.mem.indexOfScalar(u8, raw, '{') orelse return;
    const close = std.mem.lastIndexOfScalar(u8, raw, '}') orelse raw.len;
    if (close <= open) return;

    var iterator = Parser.parseStylesheet(raw[open + 1 .. close]);
    while (iterator.nextItem()) |item| {
        const child = switch (item) {
            .style => |rule| switch (self._type) {
                .keyframes => try CSSKeyframesRule.createChild(rule, frame),
                else => try createStyleChild(rule, frame),
            },
            .at_rule => |at_rule| try initAtRule(at_rule, frame),
        };
        child._parent_rule = self;
        if (self._parent_style_sheet) |sheet| child.setParentStyleSheet(sheet);
        try rules.insert(rules.length(), child, frame);
    }
}

pub fn getCssRules(self: *CSSRule, frame: *Frame) !?*CSSRuleList {
    if (!isGroupingType(self._type)) return null;
    try ensureChildren(self, frame);
    return self._children;
}

pub fn insertRule(self: *CSSRule, rule: []const u8, maybe_index: ?u32, frame: *Frame) !u32 {
    if (!isGroupingType(self._type)) return error.InvalidState;
    try ensureChildren(self, frame);
    const rules = self._children orelse return error.InvalidState;

    const requested_index = maybe_index orelse 0;
    if (requested_index > rules.length()) return error.IndexSizeError;

    var iterator = Parser.parseStylesheet(rule);
    const item = iterator.nextItem() orelse return error.SyntaxError;
    if (iterator.nextItem() != null) return error.SyntaxError;
    const child = switch (item) {
        .style => |parsed| try createStyleChild(parsed, frame),
        .at_rule => return error.HierarchyError,
    };
    child._parent_rule = self;
    if (self._parent_style_sheet) |sheet| child.setParentStyleSheet(sheet);
    try rules.insert(requested_index, child, frame);
    if (self._parent_style_sheet) |sheet| try sheet.notifyRuleMutation(frame);
    return requested_index;
}

pub fn deleteRule(self: *CSSRule, index: u32, frame: *Frame) !void {
    if (!isGroupingType(self._type)) return error.InvalidState;
    try ensureChildren(self, frame);
    const rules = self._children orelse return error.InvalidState;
    const child = rules.item(index) orelse return error.IndexSizeError;
    child._parent_rule = null;
    child._parent_style_sheet = null;
    try rules.remove(index);
    if (self._parent_style_sheet) |sheet| try sheet.notifyRuleMutation(frame);
}

pub fn getType(self: *const CSSRule) u16 {
    return @as(u16, @intFromEnum(std.meta.activeTag(self._type))) + 1;
}

pub fn getGroupingCssText(self: *const CSSRule, frame: *Frame) anyerror![]const u8 {
    const raw = self._raw_css_text orelse return "";
    const rules = self._children orelse return raw;
    if (!self._children_initialized or rules.length() == 0) return raw;
    const open = std.mem.indexOfScalar(u8, raw, '{') orelse return raw;
    var output: std.ArrayList(u8) = .empty;
    try output.appendSlice(frame.call_arena, raw[0 .. open + 1]);
    for (0..rules.length()) |index| {
        const child = rules.item(index) orelse continue;
        try output.appendSlice(frame.call_arena, try child.getCssText(frame));
        try output.append(frame.call_arena, ' ');
    }
    try output.append(frame.call_arena, '}');
    return output.items;
}

pub fn getCssText(self: *const CSSRule, frame: *Frame) anyerror![]const u8 {
    switch (self._type) {
        .style => |style_rule| return style_rule.getCssText(frame),
        .media => |media_rule| return media_rule.getCssText(frame),
        .supports => |supports_rule| return supports_rule.getCssText(frame),
        .keyframes => |keyframes_rule| return keyframes_rule.getCssText(frame),
        .keyframe => |keyframe_rule| return keyframe_rule.getCssText(frame),
        else => return getGroupingCssText(self, frame),
    }
}

pub fn getParentRule(self: *const CSSRule) ?*CSSRule {
    return self._parent_rule;
}

pub fn setParentStyleSheet(self: *CSSRule, sheet: *CSSStyleSheet) void {
    self._parent_style_sheet = sheet;
}

pub fn getParentStyleSheet(self: *const CSSRule) ?*CSSStyleSheet {
    return self._parent_style_sheet;
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(CSSRule);

    pub const Meta = struct {
        pub const name = "CSSRule";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };

    pub const STYLE_RULE = bridge.property(1, .{ .template = true });
    pub const CHARSET_RULE = bridge.property(2, .{ .template = true });
    pub const IMPORT_RULE = bridge.property(3, .{ .template = true });
    pub const MEDIA_RULE = bridge.property(4, .{ .template = true });
    pub const FONT_FACE_RULE = bridge.property(5, .{ .template = true });
    pub const PAGE_RULE = bridge.property(6, .{ .template = true });
    pub const KEYFRAMES_RULE = bridge.property(7, .{ .template = true });
    pub const KEYFRAME_RULE = bridge.property(8, .{ .template = true });
    pub const MARGIN_RULE = bridge.property(9, .{ .template = true });
    pub const NAMESPACE_RULE = bridge.property(10, .{ .template = true });
    pub const COUNTER_STYLE_RULE = bridge.property(11, .{ .template = true });
    pub const SUPPORTS_RULE = bridge.property(12, .{ .template = true });
    pub const DOCUMENT_RULE = bridge.property(13, .{ .template = true });
    pub const FONT_FEATURE_VALUES_RULE = bridge.property(14, .{ .template = true });
    pub const VIEWPORT_RULE = bridge.property(15, .{ .template = true });
    pub const REGION_STYLE_RULE = bridge.property(16, .{ .template = true });

    pub const @"type" = bridge.accessor(CSSRule.getType, null, .{});
    pub const cssText = bridge.accessor(CSSRule.getCssText, null, .{});
    pub const cssRules = bridge.accessor(CSSRule.getCssRules, null, .{ .null_as_undefined = true });
    pub const insertRule = bridge.function(CSSRule.insertRule, .{ .dom_exception = true });
    pub const deleteRule = bridge.function(CSSRule.deleteRule, .{ .dom_exception = true });
    pub const parentRule = bridge.accessor(CSSRule.getParentRule, null, .{});
    pub const parentStyleSheet = bridge.accessor(CSSRule.getParentStyleSheet, null, .{});
};
