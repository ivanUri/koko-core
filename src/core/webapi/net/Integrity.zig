const std = @import("std");
const libcrypto = @import("../../../support/sys/libcrypto.zig");

const Metadata = struct {
    algorithm: []const u8,
    hash: []const u8,
    strength: u16,
};

fn algorithmStrength(algorithm: []const u8) ?u16 {
    if (std.ascii.eqlIgnoreCase(algorithm, "sha512")) return 512;
    if (std.ascii.eqlIgnoreCase(algorithm, "sha384")) return 384;
    if (std.ascii.eqlIgnoreCase(algorithm, "sha256")) return 256;
    if (std.ascii.eqlIgnoreCase(algorithm, "sha1")) return 160;
    return null;
}

fn decodeBase64(encoded: []const u8, allocator: std.mem.Allocator) ![]u8 {
    const normalized = try normalizeBase64(encoded, allocator);
    defer allocator.free(normalized);

    const decoder = if (std.mem.indexOfScalar(u8, normalized, '-') != null or std.mem.indexOfScalar(u8, normalized, '_') != null)
        std.base64.url_safe.Decoder
    else
        std.base64.standard.Decoder;

    const decoded_len = try decoder.calcSizeForSlice(normalized);
    const out = try allocator.alloc(u8, decoded_len);
    errdefer allocator.free(out);

    try decoder.decode(out, normalized);
    return out;
}

fn normalizeBase64(encoded: []const u8, allocator: std.mem.Allocator) ![]u8 {
    if (std.mem.indexOfScalar(u8, encoded, '-') == null and std.mem.indexOfScalar(u8, encoded, '_') == null) {
        const pad = (4 - (encoded.len % 4)) % 4;
        if (pad == 0) return try allocator.dupe(u8, encoded);
        const out = try allocator.alloc(u8, encoded.len + pad);
        @memcpy(out[0..encoded.len], encoded);
        @memset(out[encoded.len..], '=');
        return out;
    }

    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);
    try out.ensureTotalCapacity(allocator, encoded.len + 4);

    for (encoded) |c| {
        const mapped: u8 = switch (c) {
            '-' => '+',
            '_' => '/',
            else => c,
        };
        try out.append(allocator, mapped);
    }

    const pad = (4 - (out.items.len % 4)) % 4;
    for (0..pad) |_| try out.append(allocator, '=');
    return try out.toOwnedSlice(allocator);
}

fn parseMetadataList(metadata: []const u8, allocator: std.mem.Allocator, out: *std.ArrayList(Metadata)) !void {
    var it = std.mem.tokenizeScalar(u8, metadata, ' ');
    while (it.next()) |token| {
        if (token.len == 0) continue;
        const dash = std.mem.indexOfScalar(u8, token, '-') orelse continue;
        const algorithm = token[0..dash];
        const hash = token[dash + 1 ..];
        if (hash.len == 0) continue;
        const strength = algorithmStrength(algorithm) orelse continue;
        try out.append(allocator, .{
            .algorithm = try allocator.dupe(u8, algorithm),
            .hash = try allocator.dupe(u8, hash),
            .strength = strength,
        });
    }
}

fn normalizeAlgorithmName(algorithm: []const u8) ?[]const u8 {
    if (std.ascii.eqlIgnoreCase(algorithm, "sha256")) return "SHA-256";
    if (std.ascii.eqlIgnoreCase(algorithm, "sha384")) return "SHA-384";
    if (std.ascii.eqlIgnoreCase(algorithm, "sha512")) return "SHA-512";
    if (std.ascii.eqlIgnoreCase(algorithm, "sha1")) return "SHA-1";
    return null;
}

fn digestBody(algorithm: []const u8, body: []const u8, scratch: std.mem.Allocator) ![]const u8 {
    const md_name = normalizeAlgorithmName(algorithm) orelse return error.UnsupportedAlgorithm;
    const md = libcrypto.findDigest(md_name) catch return error.UnsupportedAlgorithm;
    const out = try scratch.alloc(u8, libcrypto.EVP_MAX_MD_SIZE);
    var out_len: c_uint = 0;
    if (libcrypto.EVP_Digest(body.ptr, body.len, out.ptr, &out_len, md, null) != 1) {
        scratch.free(out);
        return error.DigestFailed;
    }
    return out[0..out_len];
}

fn metadataHashMatches(algorithm: []const u8, expected_hash: []const u8, body: []const u8, scratch: std.mem.Allocator) !bool {
    const digest_bytes = digestBody(algorithm, body, scratch) catch return false;
    defer scratch.free(digest_bytes);

    const decoded_expected = decodeBase64(expected_hash, scratch) catch return false;
    defer scratch.free(decoded_expected);

    return decoded_expected.len == digest_bytes.len and std.mem.eql(u8, decoded_expected, digest_bytes);
}

/// Returns true when metadata is empty or body matches per SRI strongest-algorithm rules.
pub fn verify(metadata: []const u8, body: []const u8, scratch: std.mem.Allocator) bool {
    if (metadata.len == 0) return true;

    var entries: std.ArrayList(Metadata) = .empty;
    defer {
        for (entries.items) |entry| {
            scratch.free(entry.algorithm);
            scratch.free(entry.hash);
        }
        entries.deinit(scratch);
    }

    parseMetadataList(metadata, scratch, &entries) catch return false;
    if (entries.items.len == 0) return false;

    var strongest: u16 = 0;
    for (entries.items) |entry| {
        if (entry.strength > strongest) strongest = entry.strength;
    }

    for (entries.items) |entry| {
        if (entry.strength < strongest) continue;
        if (metadataHashMatches(entry.algorithm, entry.hash, body, scratch) catch false) return true;
    }
    return false;
}

test "Integrity: top.txt sha hashes" {
    const body = "top";
    const scratch = std.testing.allocator;

    try std.testing.expect(verify("sha256-KHIDZcXnR2oBHk9DrAA+5fFiR6JjudYjqoXtMR1zvzk=", body, scratch));
    try std.testing.expect(verify("sha512-D6yns0qxG0E7+TwkevZ4Jt5t7Iy3ugmAajG/dlf6Pado1JqTyneKXICDiqFIkLMRExgtvg8PlxbKTkYfRejSOg==", body, scratch));
    try std.testing.expect(!verify("sha256-dKUcPOn/AlUjWIwcHeHNqYXPlvyGiq+2dWOdFcE+24I=", body, scratch));
}
