const js = @import("../../js/js.zig");
const Frame = @import("../../browser/Frame.zig");
const CSSRule = @import("CSSRule.zig");

const CSSConditionRule = @This();

_proto: *CSSRule,
_condition_text: []const u8 = "",

pub fn init(frame: *Frame) !*CSSConditionRule {
    return frame._factory.create(CSSConditionRule{
        ._proto = undefined,
    });
}

pub fn getConditionText(self: *const CSSConditionRule) []const u8 {
    return self._condition_text;
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(CSSConditionRule);

    pub const Meta = struct {
        pub const name = "CSSConditionRule";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };

    pub const conditionText = bridge.accessor(CSSConditionRule.getConditionText, null, .{});
};
