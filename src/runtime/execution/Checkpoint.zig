//! Durable, reconstructible execution-checkpoint metadata.
//!
//! A checkpoint is deliberately limited to browser state that Koko can
//! serialize and restore in a new process. It is not a V8 heap snapshot and
//! must never be represented as one.

const std = @import("std");

pub const schema_version: u32 = 1;
pub const manifest_filename = "manifest.json";

pub const Manifest = struct {
    schemaVersion: u32 = schema_version,
    kind: []const u8 = "reconstructible",
    createdAtMs: i64,
    url: []const u8,
    cookieCount: usize,
    localStorageEntries: usize,
    sessionStorageEntries: usize,
    indexedDbState: []const u8 = "metadata-only",
    limitations: []const []const u8 = &.{
        "JavaScript heap, timer queues, workers, Cache Storage and server-side session state are not restored.",
        "Replay requires an explicit network policy; unmatched requests must not silently reach the Internet in strict mode.",
    },
};

pub fn write(directory: []const u8, manifest: Manifest) !void {
    try std.fs.cwd().makePath(directory);
    const path = try std.fs.path.join(std.heap.page_allocator, &.{ directory, manifest_filename });
    defer std.heap.page_allocator.free(path);

    var buffer: [8192]u8 = undefined;
    var file = try std.fs.cwd().atomicFile(path, .{ .make_path = true, .write_buffer = &buffer });
    defer file.deinit();
    try std.json.Stringify.value(manifest, .{}, &file.file_writer.interface);
    try file.file_writer.interface.writeByte('\n');
    try file.file_writer.file.sync();
    try file.renameIntoPlace();
}

/// Validate only the checkpoint format. Restoring browser state remains the
/// caller's responsibility, so a manifest cannot accidentally promise more
/// than the files it accompanies.
pub fn validate(allocator: std.mem.Allocator, directory: []const u8) !void {
    const path = try std.fs.path.join(allocator, &.{ directory, manifest_filename });
    defer allocator.free(path);
    const raw = try std.fs.cwd().readFileAlloc(allocator, path, 64 * 1024);
    defer allocator.free(raw);
    const parsed = try std.json.parseFromSlice(struct { schemaVersion: u32, kind: []const u8 }, allocator, raw, .{
        .ignore_unknown_fields = true,
    });
    defer parsed.deinit();
    if (parsed.value.schemaVersion != schema_version or !std.mem.eql(u8, parsed.value.kind, "reconstructible")) {
        return error.UnsupportedCheckpoint;
    }
}

test "execution checkpoint manifest rejects incompatible version" {
    const testing = std.testing;
    const parsed = try std.json.parseFromSlice(
        struct { schemaVersion: u32, kind: []const u8 },
        testing.allocator,
        "{\"schemaVersion\":2,\"kind\":\"reconstructible\"}",
        .{},
    );
    defer parsed.deinit();
    try testing.expect(parsed.value.schemaVersion != schema_version);
}
