const std = @import("std");

const URL = @import("URL.zig");

const log = @import("../../support/log.zig");
const Allocator = std.mem.Allocator;
const SpecifierMap = std.json.ArrayHashMap(?[]const u8);

const ImportMap = @This();

/// Entries are sorted longest-first so exact and prefix matching is
/// deterministic and follows the import-maps specificity rule.
imports: []const Entry = &.{},
scopes: []const Scope = &.{},

const Entry = struct {
    specifier: []const u8,
    resolved: ?[:0]const u8,
};

const Scope = struct {
    prefix: []const u8,
    imports: []const Entry,
};

pub const empty: ImportMap = .{};

/// Merge a document import map. Existing definitions win, matching the
/// browser rule for multiple import-map scripts processed in document order.
pub fn merge(self: *ImportMap, arena: Allocator, base: [:0]const u8, json: []const u8) !void {
    const incoming = try parse(arena, base, json);
    self.imports = try mergeEntries(arena, self.imports, incoming.imports);
    self.scopes = try mergeScopes(arena, self.scopes, incoming.scopes);
}

fn mergeEntries(arena: Allocator, existing: []const Entry, incoming: []const Entry) ![]const Entry {
    if (incoming.len == 0) return existing;
    var out = try std.ArrayList(Entry).initCapacity(arena, existing.len + incoming.len);
    out.appendSliceAssumeCapacity(existing);
    for (incoming) |entry| {
        if (findEntry(existing, entry.specifier) == null) out.appendAssumeCapacity(entry);
    }
    sortEntries(out.items);
    return out.items;
}

fn mergeScopes(arena: Allocator, existing: []const Scope, incoming: []const Scope) ![]const Scope {
    if (incoming.len == 0) return existing;
    var out = try std.ArrayList(Scope).initCapacity(arena, existing.len + incoming.len);
    for (existing) |scope| {
        if (findScope(incoming, scope.prefix)) |other| {
            out.appendAssumeCapacity(.{ .prefix = scope.prefix, .imports = try mergeEntries(arena, scope.imports, other.imports) });
        } else out.appendAssumeCapacity(scope);
    }
    for (incoming) |scope| {
        if (findScope(existing, scope.prefix) == null) out.appendAssumeCapacity(scope);
    }
    std.sort.pdq(Scope, out.items, {}, struct {
        fn lessThan(_: void, a: Scope, b: Scope) bool {
            return a.prefix.len > b.prefix.len;
        }
    }.lessThan);
    return out.items;
}

fn findEntry(entries: []const Entry, key: []const u8) ?usize {
    for (entries, 0..) |entry, i| if (std.mem.eql(u8, entry.specifier, key)) return i;
    return null;
}

fn findScope(scopes_: []const Scope, prefix: []const u8) ?Scope {
    for (scopes_) |scope| if (std.mem.eql(u8, scope.prefix, prefix)) return scope;
    return null;
}

fn parse(arena: Allocator, base: [:0]const u8, json: []const u8) !ImportMap {
    const parsed = std.json.parseFromSliceLeaky(struct {
        imports: ?SpecifierMap = null,
        scopes: ?std.json.ArrayHashMap(SpecifierMap) = null,
    }, arena, json, .{ .ignore_unknown_fields = true }) catch |err| {
        log.warn(.js, "importmap json parse", .{ .err = err });
        return error.InvalidImportMap;
    };

    return .{
        .imports = if (parsed.imports) |entries| try normalizeEntries(arena, base, entries) else &.{},
        .scopes = if (parsed.scopes) |scopes_| try normalizeScopes(arena, base, scopes_) else &.{},
    };
}

fn normalizeEntries(arena: Allocator, base: [:0]const u8, entries: SpecifierMap) ![]const Entry {
    var out = try std.ArrayList(Entry).initCapacity(arena, entries.map.count());
    var it = entries.map.iterator();
    while (it.next()) |kv| {
        const key = normalizeKey(arena, base, kv.key_ptr.*) catch continue;
        const resolved: ?[:0]const u8 = if (kv.value_ptr.*) |address| blk: {
            const url = URL.resolve(arena, base, address, .{ .always_dupe = true }) catch {
                log.warn(.js, "importmap invalid address", .{ .specifier = key, .address = address });
                break :blk null;
            };
            if (endsWithSlash(key) and !endsWithSlash(url)) {
                log.warn(.js, "importmap slash mismatch", .{ .specifier = key, .address = address });
                break :blk null;
            }
            break :blk url;
        } else null;
        out.appendAssumeCapacity(.{ .specifier = key, .resolved = resolved });
    }
    sortEntries(out.items);
    return out.items;
}

fn normalizeScopes(arena: Allocator, base: [:0]const u8, scopes_: std.json.ArrayHashMap(SpecifierMap)) ![]const Scope {
    var out = try std.ArrayList(Scope).initCapacity(arena, scopes_.map.count());
    var it = scopes_.map.iterator();
    while (it.next()) |kv| {
        const prefix = URL.resolve(arena, base, kv.key_ptr.*, .{ .always_dupe = true }) catch continue;
        out.appendAssumeCapacity(.{ .prefix = prefix, .imports = try normalizeEntries(arena, base, kv.value_ptr.*) });
    }
    std.sort.pdq(Scope, out.items, {}, struct {
        fn lessThan(_: void, a: Scope, b: Scope) bool {
            return a.prefix.len > b.prefix.len;
        }
    }.lessThan);
    return out.items;
}

fn normalizeKey(arena: Allocator, base: [:0]const u8, key: []const u8) ![]const u8 {
    if (isUrlLike(key)) return URL.resolve(arena, base, key, .{ .always_dupe = true });
    return arena.dupe(u8, key);
}

fn sortEntries(entries: []Entry) void {
    std.sort.pdq(Entry, entries, {}, struct {
        fn lessThan(_: void, a: Entry, b: Entry) bool {
            return a.specifier.len > b.specifier.len;
        }
    }.lessThan);
}

fn isUrlLike(value: []const u8) bool {
    if (std.mem.startsWith(u8, value, "/") or std.mem.startsWith(u8, value, "./") or std.mem.startsWith(u8, value, "../")) return true;
    if (value.len == 0 or !std.ascii.isAlphabetic(value[0])) return false;
    for (value[1..]) |c| {
        if (c == ':') return true;
        if (!std.ascii.isAlphanumeric(c) and c != '+' and c != '-' and c != '.') return false;
    }
    return false;
}

fn endsWithSlash(value: []const u8) bool {
    return value.len > 0 and value[value.len - 1] == '/';
}

pub fn resolve(self: *const ImportMap, arena: Allocator, base: [:0]const u8, specifier: [:0]const u8) !?[:0]const u8 {
    const as_url = if (isUrlLike(specifier)) URL.resolve(arena, base, specifier, .{ .always_dupe = true }) catch null else null;
    const normalized: []const u8 = if (as_url) |url| url else specifier;

    for (self.scopes) |scope| {
        if (!scopeMatches(scope.prefix, base)) continue;
        if (try resolveEntries(arena, normalized, as_url, scope.imports)) |url| return url;
    }
    if (try resolveEntries(arena, normalized, as_url, self.imports)) |url| return url;
    return as_url;
}

fn scopeMatches(prefix: []const u8, base: []const u8) bool {
    return std.mem.eql(u8, prefix, base) or (endsWithSlash(prefix) and std.mem.startsWith(u8, base, prefix));
}

fn resolveEntries(arena: Allocator, normalized: []const u8, as_url: ?[:0]const u8, entries: []const Entry) !?[:0]const u8 {
    for (entries) |entry| {
        if (std.mem.eql(u8, entry.specifier, normalized)) return entry.resolved orelse error.SpecifierResolutionFailed;
        if (!endsWithSlash(entry.specifier) or !std.mem.startsWith(u8, normalized, entry.specifier)) continue;
        if (as_url) |url| if (!isSpecialUrl(url)) continue;
        const address = entry.resolved orelse return error.SpecifierResolutionFailed;
        const resolved = URL.resolve(arena, address, normalized[entry.specifier.len..], .{ .always_dupe = true }) catch return error.SpecifierResolutionFailed;
        if (!std.mem.startsWith(u8, resolved, address)) return error.SpecifierResolutionFailed;
        return resolved;
    }
    return null;
}

fn isSpecialUrl(url: []const u8) bool {
    const colon = std.mem.indexOfScalar(u8, url, ':') orelse return false;
    inline for (.{ "https", "http", "ws", "wss", "file", "ftp" }) |scheme| {
        if (std.ascii.eqlIgnoreCase(url[0..colon], scheme)) return true;
    }
    return false;
}

const testing = @import("../../testing/testing.zig");

test "ImportMap resolves exact, prefix, and scoped entries" {
    var map: ImportMap = .empty;
    try map.merge(testing.arena_allocator, "https://example.test/app/index.html", "{\"imports\":{\"pkg\":\"/global.js\",\"lib/\":\"/vendor/\"},\"scopes\":{\"/app/private/\":{\"pkg\":\"/private.js\"}}}");
    try testing.expectString("https://example.test/global.js", (try map.resolve(testing.arena_allocator, "https://example.test/app/main.js", "pkg")).?);
    try testing.expectString("https://example.test/vendor/a.js", (try map.resolve(testing.arena_allocator, "https://example.test/app/main.js", "lib/a.js")).?);
    try testing.expectString("https://example.test/private.js", (try map.resolve(testing.arena_allocator, "https://example.test/app/private/main.js", "pkg")).?);
}

test "ImportMap preserves first definition and blocks null/backtracking" {
    var map: ImportMap = .empty;
    try map.merge(testing.arena_allocator, "https://example.test/", "{\"imports\":{\"a\":\"/first.js\",\"blocked\":null,\"pkg/\":\"/modules/pkg/\"}}");
    try map.merge(testing.arena_allocator, "https://example.test/", "{\"imports\":{\"a\":\"/second.js\"}}");
    try testing.expectString("https://example.test/first.js", (try map.resolve(testing.arena_allocator, "https://example.test/main.js", "a")).?);
    try testing.expectError(error.SpecifierResolutionFailed, map.resolve(testing.arena_allocator, "https://example.test/main.js", "blocked"));
    try testing.expectError(error.SpecifierResolutionFailed, map.resolve(testing.arena_allocator, "https://example.test/main.js", "pkg/../escape.js"));
}
