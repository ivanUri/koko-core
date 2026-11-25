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

// A constructed sheet may be adopted by more than one document or shadow
// scope.  Keep only the owning frame and a reference count here: retaining a
// ShadowRoot pointer would make a detached root observable after its slab is
// recycled.  The frame owns the sheet's lifetime and is also the invalidation
// boundary used by the style engine.
const StyleScopeOwner = struct {
    frame: *Frame,
    references: usize = 0,
};

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
_stylo_source: ?[]const u8 = null,
_owner_rule: ?*CSSRule = null,
_owner_node: ?*Element = null,
_style_scope_owners: std.ArrayListUnmanaged(StyleScopeOwner) = .empty,

pub fn init(frame: *Frame) !*CSSStyleSheet {
    return frame._factory.create(CSSStyleSheet{});
}

pub fn initWithHref(href: []const u8, frame: *Frame) !*CSSStyleSheet {
    return frame._factory.create(CSSStyleSheet{
        ._href = try frame.dupeString(href),
    });
}

pub fn initWithHrefOwner(href: []const u8, owner: *Element, frame: *Frame) !*CSSStyleSheet {
    return frame._factory.create(CSSStyleSheet{
        ._href = try frame.dupeString(href),
        ._owner_node = owner,
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

pub fn registerStyleScopeOwner(self: *CSSStyleSheet, frame: *Frame) !void {
    for (self._style_scope_owners.items) |*owner| {
        if (owner.frame == frame) {
            owner.references += 1;
            return;
        }
    }

    try self._style_scope_owners.append(frame.arena, .{
        .frame = frame,
        .references = 1,
    });
}

pub fn unregisterStyleScopeOwner(self: *CSSStyleSheet, frame: *Frame) void {
    for (self._style_scope_owners.items, 0..) |*owner, index| {
        if (owner.frame != frame) continue;
        if (owner.references > 1) {
            owner.references -= 1;
        } else {
            _ = self._style_scope_owners.swapRemove(index);
        }
        return;
    }
}

fn reportStyleSheetEngineStatus(operation: []const u8, frame: *Frame) void {
    const status = frame.styleEngine().status();
    if (status != .ok and status != .ready) {
        log.debug(.not_implemented, "Stylo CSS stylesheet status", .{
            .operation = operation,
            .status = @tagName(status),
        });
    }
}

fn notifyStyleSheetMutation(self: *const CSSStyleSheet, operation: []const u8, frame: *Frame) void {
    const owner_frame = ownerFrameFor(self, frame);
    // Frame.styleSheetChanged keeps the legacy cache coherent and forwards the
    // invalidation through the per-frame StyleEngine owner.
    owner_frame.styleSheetChanged(if (self.getOwnerNode()) |owner| owner.asNode() else null);

    // Constructed sheets have no owner node.  Notify every frame that has a
    // live scoped reference so a replaceSync/insertRule/deleteRule mutation
    // invalidates all adopted shadow scopes, not just the caller's document.
    for (self._style_scope_owners.items) |scope| {
        if (scope.frame.isGoingAway()) continue;
        scope.frame.adoptedStyleSheetsChanged();
    }
    reportStyleSheetEngineStatus(operation, owner_frame);
}

pub fn setDisabled(self: *CSSStyleSheet, disabled: bool, frame: *Frame) void {
    if (self._disabled == disabled) return;
    self._disabled = disabled;
    notifyStyleSheetMutation(self, "disabled", frame);
}

pub fn getCssRules(self: *CSSStyleSheet, frame: *Frame) !*CSSRuleList {
    if (self._css_rules) |rules| return rules;

    const rules = try CSSRuleList.init(frame);
    self._css_rules = rules;

    if (self.getOwnerNode()) |owner| {
        if (owner.is(Element.Html.Style)) |style| {
            const text = try style.asNode().getTextContentAlloc(frame.call_arena);
            try self.replaceSync(text, frame);
            // Parsing the owner element's source initializes CSSOM objects but
            // must not make that temporary serialization authoritative.
            self._stylo_source = null;
        }
    }

    return rules;
}

/// Drop the parsed CSSOM view after the owning <style> text changes.
pub fn sourceTextChanged(self: *CSSStyleSheet) void {
    self._css_rules = null;
    self._stylo_source = null;
}

pub fn getOwnerRule(self: *const CSSStyleSheet) ?*CSSRule {
    return self._owner_rule;
}

fn attachParentStyleSheet(self: *CSSStyleSheet, rule: *CSSRule, frame: *Frame) !void {
    _ = frame;
    rule.setParentStyleSheet(self);
}

/// Return the current stylesheet source for the Stylo bridge. Author sheets
/// owned by a <style> element use the authoritative text node; constructed
/// CSSOM sheets are serialized from their CSSRuleList.
pub fn getTextForStyleEngine(self: *CSSStyleSheet, frame: *Frame) ![]const u8 {
    if (self._stylo_source) |source| return source;
    if (self.getOwnerNode()) |owner| {
        if (owner.is(Element.Html.Style)) |_| {
            if (self._css_rules == null) {
                return try owner.asNode().getTextContentAlloc(frame.call_arena);
            }
        }
    }
    const rules = self._css_rules orelse return "";
    var output: std.ArrayList(u8) = .empty;
    for (0..rules.length()) |index| {
        const rule = rules.item(index) orelse continue;
        try output.appendSlice(frame.call_arena, try rule.getCssText(frame));
    }
    return try output.toOwnedSlice(frame.call_arena);
}

fn refreshStyloSource(self: *CSSStyleSheet, frame: *Frame) !void {
    const rules = self._css_rules orelse {
        self._stylo_source = null;
        return;
    };
    var output: std.ArrayList(u8) = .empty;
    for (0..rules.length()) |index| {
        const rule = rules.item(index) orelse continue;
        try output.appendSlice(frame.call_arena, try rule.getCssText(frame));
    }
    // The snapshot survives this JS binding and is consumed by the next
    // getComputedStyle() call during prepareForLayout().  call_arena is reset
    // when the top-level native binding returns, so storing a slice allocated
    // there leaves a dangling CSS source after insertRule()/deleteRule().
    self._stylo_source = try frame.dupeString(output.items);
}

pub fn notifyRuleMutation(self: *CSSStyleSheet, frame: *Frame) !void {
    try self.refreshStyloSource(frame);
    notifyStyleSheetMutation(self, "groupingRuleMutation", frame);
}

fn validateInsertIndex(requested_index: u32, length: u32) !u32 {
    if (requested_index > length) return error.IndexSizeError;
    return requested_index;
}

fn insertAtRule(self: *CSSStyleSheet, rule: []const u8, requested_index: u32, frame: *Frame) !u32 {
    const rules = try self.getCssRules(frame);
    const index = try validateInsertIndex(requested_index, rules.length());
    const at_rule = try CSSRule.initAtRule(rule, frame);
    try rules.insert(index, at_rule, frame);
    try self.attachParentStyleSheet(at_rule, frame);
    try self.refreshStyloSource(frame);
    notifyStyleSheetMutation(self, "insertRule", frame);
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
            return self.insertAtRule(rule, requested_index, frame);
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
    const index = try validateInsertIndex(requested_index, rules.length());
    try rules.insert(index, style_rule._proto, frame);
    try self.attachParentStyleSheet(style_rule._proto, frame);
    try self.refreshStyloSource(frame);

    notifyStyleSheetMutation(self, "insertRule", frame);

    return index;
}

pub fn deleteRule(self: *CSSStyleSheet, index: u32, frame: *Frame) !void {
    const rules = try self.getCssRules(frame);
    try rules.remove(index);
    try self.refreshStyloSource(frame);

    notifyStyleSheetMutation(self, "deleteRule", frame);
}

/// Legacy CSSOM alias for insertRule(). The historical API returns -1 on
/// success and defaults the index to the current rule-list length.
pub fn addRule(
    self: *CSSStyleSheet,
    selector_: ?[]const u8,
    style_: ?[]const u8,
    maybe_index: ?u32,
    frame: *Frame,
) !i32 {
    const selector = selector_ orelse "undefined";
    const style_text = style_ orelse "";
    const rules = try self.getCssRules(frame);
    const requested_index = maybe_index orelse rules.length();
    const index = try validateInsertIndex(requested_index, rules.length());

    // The legacy API accepts an at-rule selector and a complete nested rule
    // as its style argument.  Chromium serializes addRule("@media ...",
    // "selector { ... }") as one CSSMediaRule rather than a CSSStyleRule
    // whose selector happens to begin with '@'.
    const trimmed_selector = std.mem.trim(u8, selector, &std.ascii.whitespace);
    if (std.mem.startsWith(u8, trimmed_selector, "@")) {
        var source = std.Io.Writer.Allocating.init(frame.call_arena);
        try source.writer.print("{s} {{ {s} }}", .{ trimmed_selector, style_text });
        _ = try insertAtRule(self, source.written(), index, frame);
        return -1;
    }

    const style_rule = try CSSStyleRule.init(frame);
    try style_rule.setSelectorText(selector, frame);
    const style_props = try style_rule.getStyle(frame);
    try style_props.asCSSStyleDeclaration().setCssText(style_text, frame);
    try rules.insert(index, style_rule._proto, frame);
    try self.attachParentStyleSheet(style_rule._proto, frame);
    try self.refreshStyloSource(frame);
    notifyStyleSheetMutation(self, "addRule", frame);
    return -1;
}

pub fn removeRule(self: *CSSStyleSheet, maybe_index: ?u32, frame: *Frame) !void {
    try self.deleteRule(maybe_index orelse 0, frame);
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
                try self.attachParentStyleSheet(style_rule._proto, frame);
                index += 1;
            },
            .at_rule => |at_text| {
                // Keep cssRules length aligned with real browsers so callers that
                // index into sheets (or round-trip insertRule/deleteRule) work.
                const at_rule = try CSSRule.initAtRule(at_text, frame);
                try rules.insert(index, at_rule, frame);
                try self.attachParentStyleSheet(at_rule, frame);
                index += 1;
            },
        }
    }

    self._stylo_source = try frame.dupeString(text);
    notifyStyleSheetMutation(self, "replaceSync", frame);
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
    pub const rules = bridge.accessor(CSSStyleSheet.getCssRules, null, .{});
    pub const ownerRule = bridge.accessor(CSSStyleSheet.getOwnerRule, null, .{});
    pub const insertRule = bridge.function(CSSStyleSheet.insertRule, .{ .dom_exception = true });
    pub const deleteRule = bridge.function(CSSStyleSheet.deleteRule, .{ .dom_exception = true });
    pub const addRule = bridge.function(CSSStyleSheet.addRule, .{ .dom_exception = true });
    pub const removeRule = bridge.function(CSSStyleSheet.removeRule, .{ .dom_exception = true });
    pub const replace = bridge.function(CSSStyleSheet.replace, .{});
    pub const replaceSync = bridge.function(CSSStyleSheet.replaceSync, .{});
};

const testing = @import("../../../testing/testing.zig");
test "WebApi: CSSStyleSheet" {
    const filter: testing.LogFilter = .init(&.{.js});
    defer filter.deinit();
    try testing.htmlRunner("css/stylesheet.html", .{});
}
