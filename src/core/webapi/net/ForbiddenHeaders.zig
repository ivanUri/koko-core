const std = @import("std");

const method_override_headers = [_][]const u8{
    "x-http-method-override",
    "x-http-method",
    "x-method-override",
};

const forbidden_header_names = [_][]const u8{
    "accept-charset",
    "accept-encoding",
    "access-control-request-headers",
    "access-control-request-method",
    "connection",
    "content-length",
    "cookie",
    "cookie2",
    "date",
    "dnt",
    "expect",
    "host",
    "keep-alive",
    "origin",
    "referer",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "via",
};

pub fn isForbiddenHeaderName(name: []const u8, buf: []u8) bool {
    if (name.len > buf.len) return isForbiddenHeaderNameSlow(name);
    const lower = std.ascii.lowerString(buf, name);

    if (std.mem.startsWith(u8, lower, "proxy-")) return true;
    if (std.mem.startsWith(u8, lower, "sec-")) return true;

    inline for (forbidden_header_names) |forbidden| {
        if (std.mem.eql(u8, lower, forbidden)) return true;
    }
    return false;
}

fn isForbiddenHeaderNameSlow(name: []const u8) bool {
    if (startsWithIgnoreCase(name, "proxy-")) return true;
    if (startsWithIgnoreCase(name, "sec-")) return true;
    inline for (forbidden_header_names) |forbidden| {
        if (eqlIgnoreCase(name, forbidden)) return true;
    }
    return false;
}

fn startsWithIgnoreCase(haystack: []const u8, prefix: []const u8) bool {
    if (haystack.len < prefix.len) return false;
    return std.ascii.eqlIgnoreCase(haystack[0..prefix.len], prefix);
}

fn eqlIgnoreCase(a: []const u8, b: []const u8) bool {
    return std.ascii.eqlIgnoreCase(a, b);
}

pub fn isMethodOverrideHeader(name: []const u8, buf: []u8) bool {
    if (name.len > buf.len) return false;
    const lower = std.ascii.lowerString(buf, name);
    inline for (method_override_headers) |header| {
        if (std.mem.eql(u8, lower, header)) return true;
    }
    return false;
}

fn isHttpWhitespace(c: u8) bool {
    return c == '\t' or c == ' ' or c == '\r' or c == '\n';
}

fn trimHttpWhitespace(value: []const u8) []const u8 {
    return std.mem.trim(u8, value, "\t \r\n");
}

fn isForbiddenMethodName(method: []const u8, buf: []u8) bool {
    if (method.len > buf.len) return false;
    const lower = std.ascii.lowerString(buf, method);
    return std.mem.eql(u8, lower, "connect") or
        std.mem.eql(u8, lower, "trace") or
        std.mem.eql(u8, lower, "track");
}

/// Split a header value on commas, respecting HTTP quoted-string syntax.
fn splitHeaderValue(value: []const u8, allocator: std.mem.Allocator, out: *std.ArrayList([]const u8)) !void {
    var i: usize = 0;
    while (i < value.len) {
        while (i < value.len and isHttpWhitespace(value[i])) i += 1;
        if (i >= value.len) break;

        if (value[i] == '"') {
            const inner = try collectQuotedString(value, &i, allocator);
            try out.append(allocator, inner);
            while (i < value.len and value[i] != ',') i += 1;
            if (i < value.len and value[i] == ',') i += 1;
            continue;
        }

        const start = i;
        while (i < value.len and value[i] != ',') i += 1;
        const segment = trimHttpWhitespace(value[start..i]);
        try out.append(allocator, try allocator.dupe(u8, segment));
        if (i < value.len and value[i] == ',') i += 1;
    }
}

fn collectQuotedString(input: []const u8, pos: *usize, allocator: std.mem.Allocator) ![]const u8 {
    std.debug.assert(pos.* < input.len and input[pos.*] == '"');
    pos.* += 1;

    var value: std.ArrayList(u8) = .empty;
    errdefer value.deinit(allocator);

    while (pos.* < input.len) {
        const c = input[pos.*];
        if (c == '"') {
            pos.* += 1;
            return try value.toOwnedSlice(allocator);
        }
        if (c == '\\') {
            pos.* += 1;
            if (pos.* >= input.len) {
                try value.append(allocator, '\\');
                break;
            }
            try value.append(allocator, input[pos.*]);
            pos.* += 1;
            continue;
        }
        const start = pos.*;
        while (pos.* < input.len and input[pos.*] != '"' and input[pos.*] != '\\') pos.* += 1;
        try value.appendSlice(allocator, input[start..pos.*]);
    }

    return try value.toOwnedSlice(allocator);
}

pub fn isForbiddenMethodOverrideValue(value: []const u8, buf: []u8, scratch: std.mem.Allocator) bool {
    var parts: std.ArrayList([]const u8) = .empty;
    defer {
        for (parts.items) |part| scratch.free(part);
        parts.deinit(scratch);
    }

    splitHeaderValue(value, scratch, &parts) catch return true;

    if (parts.items.len == 0) {
        const trimmed = trimHttpWhitespace(value);
        return isForbiddenMethodName(trimmed, buf);
    }

    for (parts.items) |part| {
        const trimmed = trimHttpWhitespace(part);
        if (trimmed.len == 0) continue;
        if (isForbiddenMethodName(trimmed, buf)) return true;
    }
    return false;
}

pub fn shouldOmitRequestHeader(name: []const u8, value: []const u8, buf: []u8, scratch: std.mem.Allocator) bool {
    if (isForbiddenHeaderName(name, buf)) return true;
    if (isMethodOverrideHeader(name, buf) and isForbiddenMethodOverrideValue(value, buf, scratch)) return true;
    return false;
}

test "ForbiddenHeaders: names and method override values" {
    var buf: [128]u8 = undefined;
    const scratch = std.testing.allocator;

    try std.testing.expect(isForbiddenHeaderName("Host", &buf));
    try std.testing.expect(isForbiddenHeaderName("Sec-Fetch-Mode", &buf));
    try std.testing.expect(isForbiddenHeaderName("Proxy-Authorization", &buf));
    try std.testing.expect(!isForbiddenHeaderName("X-Custom", &buf));

    try std.testing.expect(isForbiddenMethodOverrideValue(" connect", &buf, scratch));
    try std.testing.expect(isForbiddenMethodOverrideValue("GET,track ", &buf, scratch));
    try std.testing.expect(!isForbiddenMethodOverrideValue("GETTRACE", &buf, scratch));
    try std.testing.expect(!isForbiddenMethodOverrideValue("\",TRACE\",", &buf, scratch));
}
