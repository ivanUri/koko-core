const std = @import("std");

const js = @import("../../js/js.zig");
const Frame = @import("../../browser/Frame.zig");
const Parser = @import("../../browser/css/Parser.zig");

const Element = @import("../../dom/Element.zig");
const Node = @import("../../dom/Node.zig");

const CSSRuleList = @import("CSSRuleList.zig");
const CSSRule = @import("CSSRule.zig");
const CSSStyleRule = @import("CSSStyleRule.zig");

const log = @import("../../../support/log.zig");

const CSSStyleSheet = @This();

pub const CSSError = error{
    OutOfMemory,
    IndexSizeError,
    WriteFailed,
    StringTooLarge,
    SyntaxError,
};

_href: ?[]const u8 = null,
_title: []const u8 = "",
_disabled: bool = false,
_css_rules: ?*CSSRuleList = null,
_owner_rule: ?*CSSRule = null,
_owner_node: ?*Element = null,

pub fn init(frame: *Frame) !*CSSStyleSheet {
    return frame._factory.create(CSSStyleSheet{});
}

pub fn initWithHref(href: []const u8, frame: *Frame) !*CSSStyleSheet {
    return frame._factory.create(CSSStyleSheet{
        ._href = try frame.dupeString(href),
    });
}

pub fn initWithOwner(owner: *Element, frame: *Frame) !*CSSStyleSheet {
    return frame._factory.create(CSSStyleSheet{ ._owner_node = owner });
}

pub fn getOwnerNode(self: *const CSSStyleSheet) ?*Element {
    return self._owner_node;
}

fn ownerFrameFor(self: *const CSSStyleSheet, caller: *Frame) *Frame {
    const owner = self.getOwnerNode() orelse return caller;
    return owner.asNode().ownerFrame(caller);
}

pub fn getHref(self: *const CSSStyleSheet) ?[]const u8 {
    return self._href;
}

pub fn getTitle(self: *const CSSStyleSheet) []const u8 {
    return self._title;
}

pub fn getDisabled(self: *const CSSStyleSheet) bool {
    return self._disabled;
}

pub fn setDisabled(self: *CSSStyleSheet, disabled: bool) void {
    self._disabled = disabled;
}

pub fn getCssRules(self: *CSSStyleSheet, frame: *Frame) !*CSSRuleList {
    if (self._css_rules) |rules| return rules;

    const rules = try CSSRuleList.init(frame);
    self._css_rules = rules;

    if (self.getOwnerNode()) |owner| {
        if (owner.is(Element.Html.Style)) |style| {
            const text = try style.asNode().getTextContentAlloc(frame.call_arena);
            try self.replaceSync(text, frame);
        }
    }

    return rules;
}

pub fn getOwnerRule(self: *const CSSStyleSheet) ?*CSSRule {
    return self._owner_rule;
}

/// Map an at-rule source string to a CSSRule type tag for placeholder entries.
/// Full at-rule CSSOM objects (CSSMediaRule, etc.) are not implemented yet; we
/// still need stable cssRules indices so CSS-in-JS insertRule/deleteRule pairs
/// (BBC/Next, Expo/Reanimated, styled-jsx) do not throw IndexSizeError.
fn placeholderTypeForAtRule(rule: []const u8) CSSRule.Type {
    const trimmed = std.mem.trim(u8, rule, &std.ascii.whitespace);
    if (std.ascii.startsWithIgnoreCase(trimmed, "@media")) return .{ .media = {} };
    if (std.ascii.startsWithIgnoreCase(trimmed, "@keyframes") or std.ascii.startsWithIgnoreCase(trimmed, "@-webkit-keyframes")) return .{ .keyframes = {} };
    if (std.ascii.startsWithIgnoreCase(trimmed, "@font-face")) return .{ .font_face = {} };
    if (std.ascii.startsWithIgnoreCase(trimmed, "@import")) return .{ .import = {} };
    if (std.ascii.startsWithIgnoreCase(trimmed, "@supports")) return .{ .supports = {} };
    if (std.ascii.startsWithIgnoreCase(trimmed, "@charset")) return .{ .charset = {} };
    if (std.ascii.startsWithIgnoreCase(trimmed, "@namespace")) return .{ .namespace = {} };
    if (std.ascii.startsWithIgnoreCase(trimmed, "@counter-style")) return .{ .counter_style = {} };
    // @layer, @container, @property, @starting-style, etc. — keep a neutral slot.
    return .{ .supports = {} };
}

fn clampInsertIndex(requested_index: u32, length: u32) u32 {
    // Per spec, index > length should throw IndexSizeError. Because we still
    // have incomplete at-rule support and historical length skew, clamp to tail.
    // See #2214 (and the sibling #1970 / #1972 tolerance for at-rules).
    if (requested_index > length) {
        log.debug(.not_implemented, "insertRule clamped index", .{});
        return length;
    }
    return requested_index;
}

fn insertPlaceholderAtRule(self: *CSSStyleSheet, rule: []const u8, requested_index: u32, frame: *Frame) !u32 {
    log.debug(.not_implemented, "CSSStyleSheet.insertRule at-rule placeholder", .{});
    const rules = try self.getCssRules(frame);
    const index = clampInsertIndex(requested_index, rules.length());
    const placeholder = try CSSRule.init(placeholderTypeForAtRule(rule), frame);
    try rules.insert(index, placeholder, frame);
    ownerFrameFor(self, frame)._style_manager.sheetModified();
    return index;
}

pub fn insertRule(self: *CSSStyleSheet, rule: []const u8, maybe_index: ?u32, frame: *Frame) !u32 {
    const requested_index = maybe_index orelse 0;
    var it = Parser.parseStylesheet(rule);
    const parsed_rule = it.next() orelse {
        if (it.has_skipped_at_rule) {
            // Previously returned requested_index without storing a rule, which
            // left cssRules.length short and made deleteRule(index) throw
            // IndexSizeError (seen on www.bbc.com/news during Next hydration).
            return self.insertPlaceholderAtRule(rule, requested_index, frame);
        }
        return error.SyntaxError;
    };

    if (it.next() != null) return error.SyntaxError;

    const style_rule = try CSSStyleRule.init(frame);
    try style_rule.setSelectorText(parsed_rule.selector, frame);

    const style_props = try style_rule.getStyle(frame);
    const style = style_props.asCSSStyleDeclaration();
    try style.setCssText(parsed_rule.block, frame);

    const rules = try self.getCssRules(frame);
    const index = clampInsertIndex(requested_index, rules.length());
    try rules.insert(index, style_rule._proto, frame);

    // Notify StyleManager that rules have changed
    ownerFrameFor(self, frame)._style_manager.sheetModified();

    return index;
}

pub fn deleteRule(self: *CSSStyleSheet, index: u32, frame: *Frame) !void {
    const rules = try self.getCssRules(frame);
    // Defensive: legacy sheets (or mixed insert paths) may still have index skew.
    // Prefer no-op over IndexSizeError so CSS-in-JS cleanup does not crash the page.
    if (index >= rules.length()) {
        log.debug(.not_implemented, "deleteRule no-op out-of-range index", .{});
        return;
    }
    try rules.remove(index);

    // Notify StyleManager that rules have changed
    ownerFrameFor(self, frame)._style_manager.sheetModified();
}

pub fn replace(self: *CSSStyleSheet, text: []const u8, frame: *Frame) CSSError!js.Promise {
    try self.replaceSync(text, frame);
    return frame.js.local.?.resolvePromise(self);
}

pub fn replaceSync(self: *CSSStyleSheet, text: []const u8, frame: *Frame) CSSError!void {
    const rules = try self.getCssRules(frame);
    rules.clear();

    var it = Parser.parseStylesheet(text);
    var index: u32 = 0;
    while (it.nextItem()) |item| {
        switch (item) {
            .style => |parsed_rule| {
                const style_rule = try CSSStyleRule.init(frame);
                try style_rule.setSelectorText(parsed_rule.selector, frame);

                const style_props = try style_rule.getStyle(frame);
                const style = style_props.asCSSStyleDeclaration();
                try style.setCssText(parsed_rule.block, frame);

                try rules.insert(index, style_rule._proto, frame);
                index += 1;
            },
            .at_rule => |at_text| {
                // Keep cssRules length aligned with real browsers so callers that
                // index into sheets (or round-trip insertRule/deleteRule) work.
                const placeholder = try CSSRule.init(placeholderTypeForAtRule(at_text), frame);
                try rules.insert(index, placeholder, frame);
                index += 1;
            },
        }
    }

    // Notify StyleManager that rules have changed
    ownerFrameFor(self, frame)._style_manager.sheetModified();
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(CSSStyleSheet);

    pub const Meta = struct {
        pub const name = "CSSStyleSheet";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };

    pub const constructor = bridge.constructor(CSSStyleSheet.init, .{});
    pub const ownerNode = bridge.accessor(CSSStyleSheet.getOwnerNode, null, .{ .null_as_undefined = true });
    pub const href = bridge.accessor(CSSStyleSheet.getHref, null, .{ .null_as_undefined = true });
    pub const title = bridge.accessor(CSSStyleSheet.getTitle, null, .{});
    pub const disabled = bridge.accessor(CSSStyleSheet.getDisabled, CSSStyleSheet.setDisabled, .{});
    pub const cssRules = bridge.accessor(CSSStyleSheet.getCssRules, null, .{});
    pub const ownerRule = bridge.accessor(CSSStyleSheet.getOwnerRule, null, .{});
    pub const insertRule = bridge.function(CSSStyleSheet.insertRule, .{ .dom_exception = true });
    pub const deleteRule = bridge.function(CSSStyleSheet.deleteRule, .{ .dom_exception = true });
    pub const replace = bridge.function(CSSStyleSheet.replace, .{});
    pub const replaceSync = bridge.function(CSSStyleSheet.replaceSync, .{});
};

const testing = @import("../../../testing/testing.zig");
test "WebApi: CSSStyleSheet" {
    const filter: testing.LogFilter = .init(&.{.js});
    defer filter.deinit();
    try testing.htmlRunner("css/stylesheet.html", .{});
}
