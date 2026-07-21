const std = @import("std");

const Allocator = std.mem.Allocator;

/// Chromium `variations.ClientVariations` wire formula for `X-Client-Data`.
///
/// Source of truth (Chromium):
/// - `components/variations/proto/client_variations.proto`
/// - `VariationsIdsProvider::GenerateBase64EncodedProto`
///
/// ```
/// message ClientVariations {
///   repeated int32 variation_id = 1;          // google-web analysis IDs
///   repeated int32 trigger_variation_id = 3;  // server-affecting IDs
/// }
/// X-Client-Data = Base64(standard)(Serialize(proto))
/// // empty id set → empty string → Chrome omits the header
/// ```
///
/// This module only implements the **encoding formula**. It does **not** hardcode
/// a captured base64 blob. Active IDs come from session entropy / env / (future) Finch.
/// Encode active variation IDs the way Chromium builds `X-Client-Data`.
/// Returns owned base64, or empty slice when there are no IDs (caller omits header).
pub fn encodeBase64(
    allocator: Allocator,
    variation_ids: []const i32,
    trigger_variation_ids: []const i32,
) ![]u8 {
    var ids = try allocator.dupe(i32, variation_ids);
    defer allocator.free(ids);
    var triggers = try allocator.dupe(i32, trigger_variation_ids);
    defer allocator.free(triggers);
    const n_ids = sortUnique(ids);
    const n_tr = sortUnique(triggers);
    const ids_u = ids[0..n_ids];
    const triggers_u = triggers[0..n_tr];

    if (ids_u.len == 0 and triggers_u.len == 0) {
        return try allocator.dupe(u8, "");
    }

    var raw: std.ArrayList(u8) = .empty;
    errdefer raw.deinit(allocator);

    for (ids_u) |id| {
        // proto2 int32: non-negative study IDs encode as plain unsigned varint.
        try appendProtoVarintField(allocator, &raw, 1, @intCast(id));
    }
    for (triggers_u) |id| {
        try appendProtoVarintField(allocator, &raw, 3, @intCast(id));
    }

    const enc = std.base64.standard.Encoder;
    const out_len = enc.calcSize(raw.items.len);
    const out = try allocator.alloc(u8, out_len);
    _ = enc.encode(out, raw.items);
    raw.deinit(allocator);
    return out;
}

/// Decode base64 `X-Client-Data` into variation / trigger id lists (testing + debug).
pub fn decodeBase64(
    allocator: Allocator,
    b64: []const u8,
) !struct { variation_ids: []i32, trigger_variation_ids: []i32 } {
    const dec = std.base64.standard.Decoder;
    const max = try dec.calcSizeForSlice(b64);
    const buf = try allocator.alloc(u8, max);
    defer allocator.free(buf);
    try dec.decode(buf, b64);
    // calcSizeForSlice is exact for valid padding
    const raw = buf[0..max];

    var vars: std.ArrayList(i32) = .empty;
    errdefer vars.deinit(allocator);
    var triggers: std.ArrayList(i32) = .empty;
    errdefer triggers.deinit(allocator);

    var i: usize = 0;
    while (i < raw.len) {
        const key = raw[i];
        i += 1;
        const field: u32 = key >> 3;
        const wtype: u3 = @truncate(key & 0x7);
        if (wtype != 0) return error.UnsupportedWireType;
        const val, const next = try readVarint(raw, i);
        i = next;
        const id: i32 = @intCast(val);
        if (field == 1) {
            try vars.append(allocator, id);
        } else if (field == 3) {
            try triggers.append(allocator, id);
        }
    }

    return .{
        .variation_ids = try vars.toOwnedSlice(allocator),
        .trigger_variation_ids = try triggers.toOwnedSlice(allocator),
    };
}

/// Session-stable Google-web variation IDs (Chromium field 1), from client entropy.
///
/// Real Chrome fills this from Finch field trials + first-run randomization seed
/// (`clientservices.googleapis.com/chrome-variations/seed`). Until Velora runs that
/// seed stack, we only mirror the **client entropy half**: a per-session id set that
/// is stable for the session and produced via the same encode formula — never a
/// frozen base64 capture string in source or JSON.
///
/// Cold Chrome hop-1 almost always has exactly one field-1 id; we match that shape.
pub fn sessionGoogleWebIds(seed: u64, out: *[1]i32) void {
    var hasher = std.hash.Wyhash.init(seed);
    hasher.update("chrome.client_variations.google_web");
    const mixed = hasher.final();
    // Positive int32; avoid 0.
    const id: i32 = @intCast(@as(u32, @truncate(mixed % 0x7fff_ff00)) + 1);
    out.* = .{id};
}

/// Parse `VELORA_VARIATION_IDS=1,2,3` style lists (optional force / A/B).
pub fn parseIdList(allocator: Allocator, csv: []const u8) ![]i32 {
    var list: std.ArrayList(i32) = .empty;
    errdefer list.deinit(allocator);
    var it = std.mem.splitScalar(u8, csv, ',');
    while (it.next()) |part| {
        const t = std.mem.trim(u8, part, " \t");
        if (t.len == 0) continue;
        const v = try std.fmt.parseInt(i32, t, 10);
        try list.append(allocator, v);
    }
    return try list.toOwnedSlice(allocator);
}

fn appendProtoVarintField(
    allocator: Allocator,
    out: *std.ArrayList(u8),
    field_number: u32,
    value: u64,
) !void {
    // key = (field_number << 3) | 0 (varint wire type)
    try appendVarint(allocator, out, (@as(u64, field_number) << 3) | 0);
    try appendVarint(allocator, out, value);
}

fn appendVarint(allocator: Allocator, out: *std.ArrayList(u8), value: u64) !void {
    var v = value;
    while (v >= 0x80) {
        try out.append(allocator, @as(u8, @truncate(v)) | 0x80);
        v >>= 7;
    }
    try out.append(allocator, @truncate(v));
}

fn readVarint(buf: []const u8, start: usize) !struct { u64, usize } {
    var result: u64 = 0;
    var shift: u6 = 0;
    var i = start;
    while (i < buf.len) {
        const b = buf[i];
        i += 1;
        result |= @as(u64, b & 0x7f) << shift;
        if ((b & 0x80) == 0) return .{ result, i };
        shift += 7;
        if (shift >= 64) return error.VarintOverflow;
    }
    return error.TruncatedVarint;
}

/// Sort + unique in place; returns new length (valid prefix of `slice`).
pub fn sortUnique(slice: []i32) usize {
    if (slice.len <= 1) return slice.len;
    std.mem.sort(i32, slice, {}, std.sort.asc(i32));
    var w: usize = 1;
    var r: usize = 1;
    while (r < slice.len) : (r += 1) {
        if (slice[r] != slice[w - 1]) {
            slice[w] = slice[r];
            w += 1;
        }
    }
    return w;
}

const testing = @import("../../../testing/testing.zig");

test "ClientVariations: formula matches live Chrome captures" {
    // Live headed Chrome 150 hop-1 2026-07-19: CMjzygE= → field1=3324360
    {
        const b64 = try encodeBase64(testing.allocator, &[_]i32{3324360}, &[_]i32{});
        defer testing.allocator.free(b64);
        try testing.expectEqualStrings("CMjzygE=", b64);
    }
    // Prior ExtraInfo 2026-07-17: CLaAywE= → field1=3326006
    {
        const b64 = try encodeBase64(testing.allocator, &[_]i32{3326006}, &[_]i32{});
        defer testing.allocator.free(b64);
        try testing.expectEqualStrings("CLaAywE=", b64);
    }
    // Empty → omit header
    {
        const b64 = try encodeBase64(testing.allocator, &[_]i32{}, &[_]i32{});
        defer testing.allocator.free(b64);
        try testing.expectEqualStrings("", b64);
    }
}

test "ClientVariations: decode roundtrip" {
    const b64 = try encodeBase64(testing.allocator, &[_]i32{ 10, 3, 10 }, &[_]i32{7});
    defer testing.allocator.free(b64);
    const d = try decodeBase64(testing.allocator, b64);
    defer testing.allocator.free(d.variation_ids);
    defer testing.allocator.free(d.trigger_variation_ids);
    try testing.expectEqual(@as(usize, 2), d.variation_ids.len); // 3,10 unique sorted
    try testing.expectEqual(@as(i32, 3), d.variation_ids[0]);
    try testing.expectEqual(@as(i32, 10), d.variation_ids[1]);
    try testing.expectEqual(@as(i32, 7), d.trigger_variation_ids[0]);
}

test "ClientVariations: session ids stable per seed, not a fixed capture" {
    var a: [1]i32 = undefined;
    var b: [1]i32 = undefined;
    var c: [1]i32 = undefined;
    sessionGoogleWebIds(42, &a);
    sessionGoogleWebIds(42, &b);
    sessionGoogleWebIds(99, &c);
    try testing.expectEqual(a[0], b[0]);
    try testing.expect(a[0] != c[0]);
    try testing.expect(a[0] > 0);
}
