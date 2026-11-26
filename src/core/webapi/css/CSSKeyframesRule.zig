const std = @import("std");

const js = @import("../../js/js.zig");
const Frame = @import("../../browser/Frame.zig");
const Parser = @import("../../browser/css/Parser.zig");
const CSSRule = @import("CSSRule.zig");
const CSSKeyframeRule = @import("CSSKeyframeRule.zig");
const CSSRuleList = @import("CSSRuleList.zig");

const CSSKeyframesRule = @This();

_proto: *CSSRule,
_name: []const u8 = "",

pub fn init(raw_css_text: []const u8, frame: *Frame) !*CSSKeyframesRule {
    const keyframes = try frame._factory.create(CSSKeyframesRule{
        ._proto = undefined,
    });
    keyframes._proto = try CSSRule.init(.{ .keyframes = keyframes }, frame);
    keyframes._proto._raw_css_text = try frame.dupeString(raw_css_text);

    const trimmed = std.mem.trim(u8, raw_css_text, &std.ascii.whitespace);
    const open = std.mem.indexOfScalar(u8, trimmed, '{') orelse trimmed.len;
    const header = std.mem.trim(u8, trimmed[0..open], &std.ascii.whitespace);
    const at_name = if (std.ascii.startsWithIgnoreCase(header, "@-webkit-keyframes"))
        "@-webkit-keyframes"
    else
        "@keyframes";
    if (std.ascii.startsWithIgnoreCase(header, at_name)) {
        var name = std.mem.trim(u8, header[at_name.len..], &std.ascii.whitespace);
        if (name.len >= 2 and ((name[0] == '"' and name[name.len - 1] == '"') or (name[0] == '\'' and name[name.len - 1] == '\''))) {
            name = name[1 .. name.len - 1];
        }
        keyframes._name = try frame.dupeString(name);
    }
    return keyframes;
}

pub fn createChild(rule: Parser.Rule, frame: *Frame) !*CSSRule {
    const keyframe = try CSSKeyframeRule.init(rule.selector, rule.block, frame);
    return keyframe._proto;
}

pub fn getName(self: *const CSSKeyframesRule) []const u8 {
    return self._name;
}

pub fn setName(self: *CSSKeyframesRule, name: []const u8, frame: *Frame) void {
    self._name = frame.dupeString(std.mem.trim(u8, name, &std.ascii.whitespace)) catch self._name;
}

pub fn getLength(self: *CSSKeyframesRule, frame: *Frame) !u32 {
    const rules = (try CSSRule.getCssRules(self._proto, frame)) orelse return 0;
    return rules.length();
}

pub fn getItem(self: *CSSKeyframesRule, index: usize, frame: *Frame) !?*CSSRule {
    const rules = (try CSSRule.getCssRules(self._proto, frame)) orelse return null;
    return rules.item(index);
}

pub fn appendRule(self: *CSSKeyframesRule, source: []const u8, frame: *Frame) !void {
    if (!hasSingleRule(source)) return;
    var iterator = Parser.parseStylesheet(source);
    const item = iterator.nextItem() orelse return;
    const parsed = switch (item) {
        .style => |rule| rule,
        .at_rule => return,
    };
    const child = createChild(parsed, frame) catch return;
    const rules = (try CSSRule.getCssRules(self._proto, frame)) orelse return error.InvalidState;
    child._parent_rule = self._proto;
    if (self._proto._parent_style_sheet) |sheet| child.setParentStyleSheet(sheet);
    try rules.insert(rules.length(), child, frame);
    if (self._proto._parent_style_sheet) |sheet| try sheet.notifyRuleMutation(frame);
}

pub fn findRule(self: *CSSKeyframesRule, key_text: []const u8, frame: *Frame) !?*CSSKeyframeRule {
    const requested = normalizeForLookup(key_text);
    const rules = (try CSSRule.getCssRules(self._proto, frame)) orelse return null;
    var index = rules.length();
    while (index > 0) {
        index -= 1;
        const child = rules.item(index) orelse continue;
        if (child.is(CSSKeyframeRule)) |keyframe| {
            if (std.mem.eql(u8, keyframe.getKeyText(), requested)) return keyframe;
        }
    }
    return null;
}

pub fn deleteRule(self: *CSSKeyframesRule, key_text: []const u8, frame: *Frame) !void {
    const requested = normalizeForLookup(key_text);
    const rules = (try CSSRule.getCssRules(self._proto, frame)) orelse return;
    for (0..rules.length()) |index| {
        const child = rules.item(index) orelse continue;
        if (child.is(CSSKeyframeRule)) |keyframe| {
            if (std.mem.eql(u8, keyframe.getKeyText(), requested)) {
                child._parent_rule = null;
                child._parent_style_sheet = null;
                try rules.remove(@intCast(index));
                if (self._proto._parent_style_sheet) |sheet| try sheet.notifyRuleMutation(frame);
                return;
            }
        }
    }
}

pub fn getCssText(self: *CSSKeyframesRule, frame: *Frame) ![]const u8 {
    const rules = (try CSSRule.getCssRules(self._proto, frame)) orelse return "";
    const name = serializedName(self._name);
    var output = std.Io.Writer.Allocating.init(frame.call_arena);
    try output.writer.print("@keyframes {s} {{\n", .{name});
    for (0..rules.length()) |index| {
        const child = rules.item(index) orelse continue;
        try output.writer.print("  {s}\n", .{try child.getCssText(frame)});
    }
    try output.writer.writeByte('}');
    return output.written();
}

fn serializedName(name: []const u8) []const u8 {
    if (std.ascii.eqlIgnoreCase(name, "initial") or std.ascii.eqlIgnoreCase(name, "none") or std.ascii.eqlIgnoreCase(name, "default")) {
        if (std.ascii.eqlIgnoreCase(name, "initial")) return "\"initial\"";
        if (std.ascii.eqlIgnoreCase(name, "none")) return "\"none\"";
        return "\"default\"";
    }
    return name;
}

fn hasSingleRule(source: []const u8) bool {
    const open = std.mem.indexOfScalar(u8, source, '{') orelse return false;
    var depth: usize = 0;
    var close: ?usize = null;
    var index = open;
    while (index < source.len) : (index += 1) {
        switch (source[index]) {
            '{' => depth += 1,
            '}' => {
                if (depth == 0) return false;
                depth -= 1;
                if (depth == 0) {
                    close = index;
                    break;
                }
            },
            else => {},
        }
    }
    const end = close orelse return false;
    var rest = std.mem.trim(u8, source[end + 1 ..], &std.ascii.whitespace);
    while (std.mem.startsWith(u8, rest, "/*")) {
        const comment_end = std.mem.indexOf(u8, rest[2..], "*/") orelse return false;
        rest = std.mem.trim(u8, rest[comment_end + 4 ..], &std.ascii.whitespace);
    }
    return rest.len == 0;
}

fn normalizeForLookup(text: []const u8) []const u8 {
    const trimmed = std.mem.trim(u8, text, &std.ascii.whitespace);
    if (std.ascii.eqlIgnoreCase(trimmed, "from")) return "0%";
    if (std.ascii.eqlIgnoreCase(trimmed, "to")) return "100%";
    return trimmed;
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(CSSKeyframesRule);

    pub const Meta = struct {
        pub const name = "CSSKeyframesRule";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };

    pub const name = bridge.accessor(CSSKeyframesRule.getName, CSSKeyframesRule.setName, .{});
    pub const length = bridge.accessor(CSSKeyframesRule.getLength, null, .{});
    pub const @"[]" = bridge.indexed(CSSKeyframesRule.getItem, null, .{ .null_as_undefined = true });
    pub const appendRule = bridge.function(CSSKeyframesRule.appendRule, .{ .dom_exception = true });
    pub const findRule = bridge.function(CSSKeyframesRule.findRule, .{ .null_as_undefined = false });
    pub const deleteRule = bridge.function(CSSKeyframesRule.deleteRule, .{ .dom_exception = true });
};
