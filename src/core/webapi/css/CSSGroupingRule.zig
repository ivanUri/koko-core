const js = @import("../../js/js.zig");
const Frame = @import("../../browser/Frame.zig");
const CSSRule = @import("CSSRule.zig");
const CSSRuleList = @import("CSSRuleList.zig");

const CSSGroupingRule = @This();

_proto: *CSSRule,

pub fn init(frame: *Frame) !*CSSGroupingRule {
    return frame._factory.create(CSSGroupingRule{ ._proto = undefined });
}

pub fn getCssRules(self: *CSSGroupingRule, frame: *Frame) !?*CSSRuleList {
    return CSSRule.getCssRules(self._proto, frame);
}

pub fn insertRule(self: *CSSGroupingRule, rule: []const u8, maybe_index: ?u32, frame: *Frame) !u32 {
    return CSSRule.insertRule(self._proto, rule, maybe_index, frame);
}

pub fn deleteRule(self: *CSSGroupingRule, index: u32, frame: *Frame) !void {
    return CSSRule.deleteRule(self._proto, index, frame);
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(CSSGroupingRule);

    pub const Meta = struct {
        pub const name = "CSSGroupingRule";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };

    pub const cssRules = bridge.accessor(CSSGroupingRule.getCssRules, null, .{ .null_as_undefined = true });
    pub const insertRule = bridge.function(CSSGroupingRule.insertRule, .{ .dom_exception = true });
    pub const deleteRule = bridge.function(CSSGroupingRule.deleteRule, .{ .dom_exception = true });
};
