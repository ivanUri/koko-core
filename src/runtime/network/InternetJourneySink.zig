//! Optional local observability sink for completed HTTP transfers.
//! The network layer owns the measurements; consumers only receive immutable
//! JSONL snapshots after CURLMSG_DONE and before the pooled handle is reset.

const std = @import("std");
const builtin = @import("builtin");
const http = @import("http.zig");

const Self = @This();

pub const ResponseMetadata = struct {
    method: []const u8,
    redirect_count: u32,
    content_type: ?[]const u8,
};

// A browser process may own multiple Network instances. They can share the
// same observability file, so serialization must live at module/process scope
// rather than on an individual sink.
var process_mutex: std.Thread.Mutex = .{};
var process_sequence: u64 = 0;
var previous_sample: ?ProcessSample = null;

allocator: std.mem.Allocator,
file: std.fs.File,

pub fn initFromEnvironment(allocator: std.mem.Allocator) !?Self {
    const path = std.process.getEnvVarOwned(allocator, "KOKO_INTERNET_JOURNEY_FILE") catch |err| switch (err) {
        error.EnvironmentVariableNotFound => return null,
        else => return err,
    };
    defer allocator.free(path);

    const file = std.fs.cwd().openFile(path, .{ .mode = .write_only }) catch |err| switch (err) {
        error.FileNotFound => try std.fs.cwd().createFile(path, .{}),
        else => return err,
    };
    try file.seekFromEnd(0);
    return .{ .allocator = allocator, .file = file };
}

pub fn deinit(self: *Self) void {
    self.file.close();
}

pub fn emit(
    self: *Self,
    conn: *const http.Connection,
    timing: http.Connection.TransferTiming,
    metadata: ResponseMetadata,
    failed: bool,
) !void {
    process_mutex.lock();
    defer process_mutex.unlock();

    const url = if (conn.getEffectiveUrl() catch null) |url_ptr|
        std.mem.span(url_ptr)
    else
        "";
    const response_code = conn.getResponseCode() catch 0;
    const now = std.time.milliTimestamp();
    const session_id = "koko-core";
    const content_encoding = headerValue(conn, "content-encoding");
    const cache_control = headerValue(conn, "cache-control");
    const server = headerValue(conn, "server");
    const age = headerValue(conn, "age");
    const via = headerValue(conn, "via");
    const etag = headerValue(conn, "etag");
    const content_length = headerValue(conn, "content-length");
    const compressed_size = if (content_length) |value| std.fmt.parseInt(u64, std.mem.trim(u8, value, " \t\r\n"), 10) catch null else null;

    const Stage = struct { id: []const u8, duration_us: u64, measurement: []const u8 = "measured" };
    const connection_reused = timing.num_connects == 0 and timing.connection_id >= 0;
    const cache_decision = if (response_code == 304) "revalidated" else "network";
    const stages = [_]Stage{
        .{ .id = "queue", .duration_us = timing.queue_us },
        .{ .id = "cache", .duration_us = 0, .measurement = "not-timed" },
        .{ .id = "dns", .duration_us = timing.dns_us },
        .{ .id = "routing", .duration_us = 0, .measurement = "unavailable" },
        .{ .id = "proxy", .duration_us = 0, .measurement = if (timing.used_proxy) "not-timed" else "unavailable" },
        .{ .id = "tcp", .duration_us = timing.tcp_us },
        .{ .id = "tls", .duration_us = timing.tls_us },
        .{ .id = "request", .duration_us = timing.request_us },
        .{ .id = "redirect", .duration_us = 0, .measurement = if (metadata.redirect_count > 0) "not-timed" else "unavailable" },
        .{ .id = "server", .duration_us = timing.server_us },
        .{ .id = "response", .duration_us = timing.transfer_us },
        .{ .id = "received", .duration_us = 0, .measurement = "boundary" },
    };

    // A failed transfer still emits the complete schema, but only the stage
    // where the network invariant broke is marked as the failure point. Later
    // stages are explicitly skipped so consumers cannot render a false
    // successful journey.
    const failed_stage: ?[]const u8 = if (!failed) null else if (timing.dns_us == 0 and timing.primary_ip == null) "dns" else if (timing.tcp_us == 0 and timing.primary_ip != null) "tcp" else if (timing.tls_us == 0 and timing.num_connects > 0) "tls" else if (timing.server_us == 0 and response_code == 0) "server" else "response";
    var failed_index: ?usize = null;
    if (failed_stage) |stage_id| for (stages, 0..) |stage, index| {
        if (std.mem.eql(u8, stage.id, stage_id)) failed_index = index;
    };

    var output: std.Io.Writer.Allocating = .init(self.allocator);
    defer output.deinit();
    const writer = &output.writer;
    try writer.writeByte('[');
    for (stages, 0..) |stage, index| {
        process_sequence += 1;
        if (index > 0) try writer.writeByte(',');
        const event_id = try std.fmt.allocPrint(self.allocator, "journey-{d}", .{process_sequence});
        defer self.allocator.free(event_id);
        const stage_status = if (failed_index) |failure_index| blk: {
            if (index == failure_index and std.mem.eql(u8, stage.id, failed_stage.?)) break :blk "error";
            if (index > failure_index) break :blk "skipped";
            break :blk "ok";
        } else "ok";
        try std.json.Stringify.value(.{
            .id = event_id,
            .sessionId = session_id,
            .sequence = process_sequence,
            .timestamp = now,
            .duration = @as(f64, @floatFromInt(stage.duration_us)) / 1000.0,
            .kind = "network",
            .name = stage.id,
            .status = stage_status,
            .payload = .{
                .journeyStage = stage.id,
                .failureStage = failed_stage,
                .url = url,
                .responseStatus = response_code,
                .responseBodyBytes = timing.response_body_bytes,
                .compressedSizeBytes = compressed_size,
                .uncompressedSizeBytes = timing.response_body_bytes,
                .responseMemoryBytes = timing.response_body_bytes,
                .responseMemoryState = "estimated_from_transfer_size",
                .contentEncoding = content_encoding,
                .primaryIp = timing.primary_ip,
                .connectionId = timing.connection_id,
                .numConnects = timing.num_connects,
                .connectionReused = connection_reused,
                .usedProxy = timing.used_proxy,
                .cacheDecision = cache_decision,
                .httpVersion = conn.httpProtocolLabel(),
                .method = metadata.method,
                .redirectCount = metadata.redirect_count,
                .contentType = metadata.content_type,
                .cacheControl = cache_control,
                .server = server,
                .age = age,
                .via = via,
                .etag = etag,
                .measurement = durationMeasurement(stage.id, stage.duration_us, stage.measurement, connection_reused),
                .terminalStatus = if (failed) "error" else "ok",
            },
        }, .{ .emit_null_optional_fields = false }, writer);
    }
    try writer.writeAll("]\n");
    // Other Network-owned sinks may have advanced the shared file since this
    // handle was opened. Re-resolve EOF while holding the process lock.
    try self.file.seekFromEnd(0);
    try self.file.writeAll(output.written());
}

pub fn emitBrowserStage(
    self: *Self,
    stage: []const u8,
    duration_us: u64,
    frame_id: u32,
    loader_id: u32,
    measurement_state: []const u8,
    process: []const u8,
    thread: []const u8,
) !void {
    process_mutex.lock();
    defer process_mutex.unlock();
    process_sequence += 1;
    var output: std.Io.Writer.Allocating = .init(self.allocator);
    defer output.deinit();
    const event_id = try std.fmt.allocPrint(self.allocator, "browser-{d}", .{process_sequence});
    defer self.allocator.free(event_id);
    const sample = readProcessSample();
    try std.json.Stringify.value(.{.{
        .id = event_id,
        .sessionId = "koko-core",
        .sequence = process_sequence,
        .timestamp = std.time.milliTimestamp(),
        .duration = @as(f64, @floatFromInt(duration_us)) / 1000.0,
        .kind = "render",
        .name = stage,
        .status = "ok",
        .payload = .{
            .browserStage = stage,
            .systemStage = systemStageForBrowserStage(stage),
            .frameId = frame_id,
            .loaderId = loader_id,
            .measurementState = measurement_state,
            .process = process,
            .thread = thread,
            .processName = process,
            .threadName = thread,
            .processId = std.c.getpid(),
            .threadId = std.Thread.getCurrentId(),
            .logicalCpuCount = sample.logical_cpu_count,
            .physicalMemoryBytes = sample.physical_memory_bytes,
            .residentMemoryBytes = sample.resident_memory_bytes,
            .cpuPercent = sample.cpu_percent,
            .contextSwitches = sample.context_switches,
            .diskReadBytes = sample.disk_read_bytes,
            .diskWriteBytes = sample.disk_write_bytes,
            .systemSampleState = sample.state,
        },
    }}, .{}, &output.writer);
    try output.writer.writeByte('\n');
    try self.file.seekFromEnd(0);
    try self.file.writeAll(output.written());
}

pub fn emitBrowserScript(self: *Self, duration_us: u64, frame_id: u32, loader_id: u32, url: []const u8, script_kind: []const u8) !void {
    process_mutex.lock();
    defer process_mutex.unlock();
    process_sequence += 1;
    var output: std.Io.Writer.Allocating = .init(self.allocator);
    defer output.deinit();
    const event_id = try std.fmt.allocPrint(self.allocator, "browser-{d}", .{process_sequence});
    defer self.allocator.free(event_id);
    const sample = readProcessSample();
    try std.json.Stringify.value(.{.{
        .id = event_id,
        .sessionId = "koko-core",
        .sequence = process_sequence,
        .timestamp = std.time.milliTimestamp(),
        .duration = @as(f64, @floatFromInt(duration_us)) / 1000.0,
        .kind = "render",
        .name = "javascript",
        .status = "ok",
        .payload = .{ .browserStage = "javascript", .systemStage = "thread-scheduler", .scriptUrl = url, .scriptKind = script_kind, .functionName = "<script>", .callId = event_id, .callKind = "script", .callDepth = @as(u8, 0), .frameId = frame_id, .loaderId = loader_id, .measurementState = "measured", .process = "Renderer", .thread = "Main", .processName = "Renderer", .threadName = "Main", .processId = std.c.getpid(), .threadId = std.Thread.getCurrentId(), .logicalCpuCount = sample.logical_cpu_count, .physicalMemoryBytes = sample.physical_memory_bytes, .residentMemoryBytes = sample.resident_memory_bytes, .cpuPercent = sample.cpu_percent, .contextSwitches = sample.context_switches, .diskReadBytes = sample.disk_read_bytes, .diskWriteBytes = sample.disk_write_bytes, .systemSampleState = sample.state },
    }}, .{}, &output.writer);
    try output.writer.writeByte('\n');
    try self.file.seekFromEnd(0);
    try self.file.writeAll(output.written());
}

fn headerValue(conn: *const http.Connection, comptime name: [:0]const u8) ?[]const u8 {
    const header = conn.getResponseHeader(name, 0) orelse return null;
    return header.value;
}

fn durationMeasurement(stage: []const u8, duration_us: u64, measurement: []const u8, connection_reused: bool) []const u8 {
    if (duration_us == 0 and std.mem.eql(u8, measurement, "measured")) {
        if (connection_reused and (std.mem.eql(u8, stage, "dns") or std.mem.eql(u8, stage, "tcp") or std.mem.eql(u8, stage, "tls"))) return "reused";
        return "unavailable";
    }
    return measurement;
}

const ProcessSample = struct {
    logical_cpu_count: u32 = 0,
    physical_memory_bytes: ?u64 = null,
    resident_memory_bytes: ?u64 = null,
    cpu_percent: ?f64 = null,
    context_switches: ?u64 = null,
    disk_read_bytes: ?u64 = null,
    disk_write_bytes: ?u64 = null,
    cpu_time_us: ?u64 = null,
    wall_time_us: i128 = 0,
    state: []const u8 = "sampled",
};

fn readProcessSample() ProcessSample {
    var sample = ProcessSample{
        .logical_cpu_count = @intCast(std.Thread.getCpuCount() catch 0),
        .physical_memory_bytes = physicalMemoryBytes(),
        .wall_time_us = std.time.microTimestamp(),
    };

    if (readRusage()) |usage| {
        sample.resident_memory_bytes = usage.resident_memory_bytes;
        sample.context_switches = usage.context_switches;
        sample.disk_read_bytes = usage.disk_read_bytes;
        sample.disk_write_bytes = usage.disk_write_bytes;
        sample.cpu_time_us = usage.cpu_time_us;
    } else {
        sample.state = "rusage-unavailable";
    }

    if (sample.cpu_time_us) |cpu_time| {
        if (previous_sample) |previous| {
            if (previous.cpu_time_us) |previous_cpu_time| {
                const wall_delta = sample.wall_time_us - previous.wall_time_us;
                if (wall_delta > 0 and cpu_time >= previous_cpu_time) {
                    const cpu_delta = cpu_time - previous_cpu_time;
                    const cpu_ratio = @as(f64, @floatFromInt(cpu_delta)) / @as(f64, @floatFromInt(wall_delta));
                    const cores = @max(sample.logical_cpu_count, 1);
                    sample.cpu_percent = @min(100.0, cpu_ratio / @as(f64, @floatFromInt(cores)) * 100.0);
                }
            }
        }
    }
    previous_sample = sample;
    return sample;
}

const RusageSnapshot = struct {
    resident_memory_bytes: u64,
    context_switches: u64,
    disk_read_bytes: u64,
    disk_write_bytes: u64,
    cpu_time_us: u64,
};

fn readRusage() ?RusageSnapshot {
    const usage = std.posix.getrusage(0);
    const user_us = timevalMicros(usage.utime);
    const system_us = timevalMicros(usage.stime);
    return .{
        .resident_memory_bytes = residentBytesFromRusage(usage.maxrss),
        .context_switches = nonNegativeInt(usage.nvcsw) + nonNegativeInt(usage.nivcsw),
        .disk_read_bytes = nonNegativeInt(usage.inblock) * 512,
        .disk_write_bytes = nonNegativeInt(usage.oublock) * 512,
        .cpu_time_us = user_us + system_us,
    };
}

fn timevalMicros(value: std.c.timeval) u64 {
    return nonNegativeInt(value.sec) * 1_000_000 + nonNegativeInt(value.usec);
}

fn nonNegativeInt(value: anytype) u64 {
    return if (value <= 0) 0 else @intCast(value);
}

fn residentBytesFromRusage(value: anytype) u64 {
    const rss = nonNegativeInt(value);
    return switch (builtin.os.tag) {
        .macos, .ios, .watchos, .tvos => rss,
        else => rss * 1024,
    };
}

fn physicalMemoryBytes() ?u64 {
    return switch (builtin.os.tag) {
        .macos => sysctlU64("hw.memsize"),
        else => null,
    };
}

fn sysctlU64(name: [*:0]const u8) ?u64 {
    var value: u64 = 0;
    var size: usize = @sizeOf(u64);
    if (std.c.sysctlbyname(name, &value, &size, null, 0) != 0) return null;
    if (value == 0) return null;
    return value;
}

/// Maps a browser-owned stage to the first OS/hardware subsystem that owns its
/// execution. This is an ownership boundary, not a synthetic measurement.
fn systemStageForBrowserStage(stage: []const u8) []const u8 {
    if (std.mem.eql(u8, stage, "javascript") or std.mem.eql(u8, stage, "dom") or std.mem.eql(u8, stage, "event-loop")) return "thread-scheduler";
    if (std.mem.eql(u8, stage, "paint") or std.mem.eql(u8, stage, "layout") or std.mem.eql(u8, stage, "style")) return "graphics-pipeline";
    if (std.mem.eql(u8, stage, "raster") or std.mem.eql(u8, stage, "composite")) return "gpu";
    if (std.mem.eql(u8, stage, "frame") or std.mem.eql(u8, stage, "present")) return "display";
    return "browser-processes";
}

test "InternetJourneySink stage durations are non-overlapping" {
    const timing = http.Connection.TransferTiming{
        .queue_us = 3_000,
        .dns_us = 4_000,
        .tcp_us = 18_000,
        .tls_us = 41_000,
        .request_us = 2_000,
        .server_us = 95_000,
        .transfer_us = 12_000,
        .total_us = 172_000,
        .response_body_bytes = 25_395,
        .primary_ip = "93.184.216.34",
        .connection_id = 7,
        .num_connects = 1,
        .used_proxy = false,
    };
    try std.testing.expectEqual(@as(u64, 175_000), timing.queue_us + timing.dns_us + timing.tcp_us + timing.tls_us + timing.request_us + timing.server_us + timing.transfer_us);
}

test "InternetJourneySink labels zero durations without inventing a measurement" {
    try std.testing.expectEqualStrings("unavailable", durationMeasurement("server", 0, "measured", false));
    try std.testing.expectEqualStrings("reused", durationMeasurement("tcp", 0, "measured", true));
    try std.testing.expectEqualStrings("boundary", durationMeasurement("received", 0, "boundary", false));
    try std.testing.expectEqualStrings("measured", durationMeasurement("tcp", 1, "measured", true));
}

test "InternetJourneySink maps browser stages to system ownership without site rules" {
    try std.testing.expectEqualStrings("thread-scheduler", systemStageForBrowserStage("javascript"));
    try std.testing.expectEqualStrings("graphics-pipeline", systemStageForBrowserStage("paint"));
    try std.testing.expectEqualStrings("gpu", systemStageForBrowserStage("composite"));
    try std.testing.expectEqualStrings("display", systemStageForBrowserStage("frame"));
    try std.testing.expectEqualStrings("browser-processes", systemStageForBrowserStage("parse"));
}

test "InternetJourneySink process sampler exposes real process counters" {
    const sample = readProcessSample();
    try std.testing.expect(sample.logical_cpu_count > 0);
    try std.testing.expect(sample.wall_time_us > 0);
    try std.testing.expect(sample.resident_memory_bytes == null or sample.resident_memory_bytes.? > 0);
    try std.testing.expect(sample.context_switches == null or sample.context_switches.? >= 0);
}
