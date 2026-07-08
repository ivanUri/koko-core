const std = @import("std");
const URL = @import("URL.zig");
const Allocator = std.mem.Allocator;

pub const Policy = struct {
    worker_src: ?SourceList = null,
    script_src: ?SourceList = null,
    script_src_elem: ?SourceList = null,

    pub fn parse(allocator: Allocator, header: []const u8) !Policy {
        var policy: Policy = .{};
        var it = std.mem.splitScalar(u8, header, ';');
        while (it.next()) |directive_chunk| {
            var tokens = std.mem.tokenizeAny(u8, std.mem.trim(u8, directive_chunk, &std.ascii.whitespace), &std.ascii.whitespace);
            const name = tokens.next() orelse continue;
            const list = try SourceList.parse(allocator, &tokens);
            if (std.ascii.eqlIgnoreCase(name, "worker-src")) {
                policy.worker_src = list;
            } else if (std.ascii.eqlIgnoreCase(name, "script-src")) {
                policy.script_src = list;
            } else if (std.ascii.eqlIgnoreCase(name, "script-src-elem")) {
                policy.script_src_elem = list;
            }
        }
        return policy;
    }

    pub fn allowsWorkerStaticImport(self: *const Policy, allocator: Allocator, document_url: [:0]const u8, request_url: [:0]const u8) bool {
        const list = self.worker_src orelse self.script_src orelse return true;
        return list.allows(allocator, document_url, request_url);
    }

    pub fn allowsDynamicImport(self: *const Policy, allocator: Allocator, document_url: [:0]const u8, request_url: [:0]const u8) bool {
        const list = self.script_src_elem orelse self.script_src orelse return true;
        return list.allows(allocator, document_url, request_url);
    }
};

const SourceList = struct {
    allow_self: bool = false,
    allow_star: bool = false,

    fn parse(allocator: Allocator, tokens: *std.mem.TokenIterator(u8, .any)) !SourceList {
        _ = allocator;
        var list: SourceList = .{};
        while (tokens.next()) |token| {
            if (std.mem.eql(u8, token, "'self'")) list.allow_self = true;
            if (std.mem.eql(u8, token, "*")) list.allow_star = true;
        }
        return list;
    }

    fn allows(self: SourceList, allocator: Allocator, document_url: [:0]const u8, request_url: [:0]const u8) bool {
        if (self.allow_star) return true;
        if (self.allow_self) {
            return originsMatch(allocator, document_url, request_url);
        }
        return false;
    }
};

fn originsMatch(allocator: Allocator, a_url: [:0]const u8, b_url: [:0]const u8) bool {
    const a_origin = URL.getOrigin(allocator, a_url) catch return false;
    const b_origin = URL.getOrigin(allocator, b_url) catch return false;
    return std.mem.eql(u8, a_origin orelse return false, b_origin orelse return false);
}

const testing = @import("../../testing/testing.zig");

test "CSP: worker-src self blocks cross-origin module import" {
    const policy = try Policy.parse(testing.allocator, "worker-src 'self' 'unsafe-inline'");
    try testing.expect(policy.allowsWorkerStaticImport(
        testing.allocator,
        "http://localhost:8000/workers/modules/resources/new-worker-window.html",
        "http://localhost:8000/workers/modules/resources/export-on-load-script.py",
    ));
    try testing.expect(!policy.allowsWorkerStaticImport(
        testing.allocator,
        "http://localhost:8000/workers/modules/resources/new-worker-window.html",
        "https://www1.localhost:8443/workers/modules/resources/export-on-load-script.py",
    ));
}

test "CSP: dynamic import uses script-src not worker-src" {
    const policy = try Policy.parse(testing.allocator, "worker-src 'self'; script-src * 'unsafe-inline'");
    try testing.expect(policy.allowsDynamicImport(
        testing.allocator,
        "http://localhost:8000/",
        "https://www1.localhost:8443/workers/modules/resources/export-on-load-script.py",
    ));
    const policy2 = try Policy.parse(testing.allocator, "script-src 'self' 'unsafe-inline'");
    try testing.expect(!policy2.allowsDynamicImport(
        testing.allocator,
        "http://localhost:8000/",
        "https://www1.localhost:8443/workers/modules/resources/export-on-load-script.py",
    ));
}
