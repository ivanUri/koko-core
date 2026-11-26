const std = @import("std");
const js = @import("../../js/js.zig");
const Frame = @import("../../browser/Frame.zig");
const CSSRule = @import("CSSRule.zig");

const CSSLayerStatementRule = @This();

_proto: *CSSRule,
_name_list: []const []const u8 = &.{},

pub fn init(raw_css_text: []const u8, frame: *Frame) !*CSSLayerStatementRule {
    const rule = try frame._factory.create(CSSLayerStatementRule{ ._proto = undefined });
    rule._proto = try CSSRule.init(.{ .layer_statement = rule }, frame);
    rule._proto._raw_css_text = try frame.dupeString(raw_css_text);

    const trimmed = std.mem.trim(u8, raw_css_text, &std.ascii.whitespace);
    const semi = std.mem.indexOfScalar(u8, trimmed, ';') orelse trimmed.len;
    const header = std.mem.trim(u8, trimmed[0..semi], &std.ascii.whitespace);
    if (std.ascii.startsWithIgnoreCase(header, "@layer")) {
        const names = std.mem.trim(u8, header["@layer".len..], &std.ascii.whitespace);
        var count: usize = 0;
        var it = std.mem.splitScalar(u8, names, ',');
        while (it.next()) |_| count += 1;

        const list = try frame.arena.alloc([]const u8, count);
        var index: usize = 0;
        it = std.mem.splitScalar(u8, names, ',');
        while (it.next()) |name| : (index += 1) {
            list[index] = try frame.dupeString(std.mem.trim(u8, name, &std.ascii.whitespace));
        }
        rule._name_list = list;
    }
    return rule;
}

pub fn getNameList(self: *const CSSLayerStatementRule) []const []const u8 {
    return self._name_list;
}

pub fn getCssText(self: *const CSSLayerStatementRule, frame: *Frame) ![]const u8 {
    var output = std.Io.Writer.Allocating.init(frame.call_arena);
    try output.writer.writeAll("@layer ");
    for (self._name_list, 0..) |name, index| {
        if (index > 0) try output.writer.writeAll(", ");
        try output.writer.writeAll(name);
    }
    try output.writer.writeByte(';');
    return output.written();
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(CSSLayerStatementRule);

    pub const Meta = struct {
        pub const name = "CSSLayerStatementRule";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };

    pub const nameList = bridge.accessor(CSSLayerStatementRule.getNameList, null, .{});
};
