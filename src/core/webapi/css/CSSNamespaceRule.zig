const std = @import("std");

const js = @import("../../js/js.zig");
const Frame = @import("../../browser/Frame.zig");
const CSSRule = @import("CSSRule.zig");

const CSSNamespaceRule = @This();

_proto: *CSSRule,
_prefix: []const u8 = "",
_namespace_uri: []const u8 = "",

pub fn init(raw_css_text: []const u8, frame: *Frame) !*CSSNamespaceRule {
    const rule = try frame._factory.create(CSSNamespaceRule{ ._proto = undefined });
    rule._proto = try CSSRule.init(.{ .namespace = rule }, frame);
    rule._proto._raw_css_text = try frame.dupeString(raw_css_text);

    const trimmed = std.mem.trim(u8, raw_css_text, &std.ascii.whitespace);
    const prelude = if (std.ascii.startsWithIgnoreCase(trimmed, "@namespace"))
        std.mem.trim(u8, trimmed["@namespace".len..], &std.ascii.whitespace)
    else
        "";
    const parsed = parsePrelude(prelude);
    rule._prefix = try frame.dupeString(parsed.prefix);
    rule._namespace_uri = try frame.dupeString(parsed.uri);
    return rule;
}

const ParsedPrelude = struct { prefix: []const u8, uri: []const u8 };

fn parsePrelude(text: []const u8) ParsedPrelude {
    var rest = std.mem.trim(u8, text, &std.ascii.whitespace);
    var prefix: []const u8 = "";
    if (rest.len > 0 and !std.ascii.startsWithIgnoreCase(rest, "url(")) {
        const end = std.mem.indexOfAny(u8, rest, &std.ascii.whitespace) orelse rest.len;
        prefix = rest[0..end];
        rest = std.mem.trim(u8, rest[end..], &std.ascii.whitespace);
    }
    var uri = rest;
    if (std.ascii.startsWithIgnoreCase(rest, "url(")) {
        if (std.mem.lastIndexOfScalar(u8, rest, ')')) |close| {
            uri = std.mem.trim(u8, rest[4..close], &std.ascii.whitespace);
        }
    }
    if (uri.len >= 2 and ((uri[0] == '"' and uri[uri.len - 1] == '"') or (uri[0] == '\'' and uri[uri.len - 1] == '\''))) {
        uri = uri[1 .. uri.len - 1];
    }
    return .{ .prefix = prefix, .uri = uri };
}

pub fn getPrefix(self: *const CSSNamespaceRule) []const u8 {
    return self._prefix;
}

pub fn getNamespaceURI(self: *const CSSNamespaceRule) []const u8 {
    return self._namespace_uri;
}

pub fn getCssText(self: *const CSSNamespaceRule, frame: *Frame) ![]const u8 {
    var output = std.Io.Writer.Allocating.init(frame.call_arena);
    if (self._prefix.len == 0) {
        try output.writer.print("@namespace url(\"{s}\");", .{self._namespace_uri});
    } else {
        try output.writer.print("@namespace {s} url(\"{s}\");", .{ self._prefix, self._namespace_uri });
    }
    return output.written();
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(CSSNamespaceRule);

    pub const Meta = struct {
        pub const name = "CSSNamespaceRule";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };

    pub const prefix = bridge.accessor(CSSNamespaceRule.getPrefix, null, .{});
    pub const namespaceURI = bridge.accessor(CSSNamespaceRule.getNamespaceURI, null, .{});
    pub const cssText = bridge.accessor(CSSNamespaceRule.getCssText, null, .{});
};
