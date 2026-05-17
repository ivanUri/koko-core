const std = @import("std");
const builtin = @import("builtin");
const build_config = @import("build_config");
const log = @import("log.zig");

const IS_DEBUG = builtin.mode == .Debug;

const abort = std.posix.abort;
const TELEGRAM_MAX_MESSAGE_BYTES = 3900;

// tracks how deep within a panic we're panicling
var panic_level: usize = 0;

// Locked to avoid interleaving panic messages from multiple threads.
var panic_mutex = std.Thread.Mutex{};

// overwrite's Zig default panic handler
pub fn panic(msg: []const u8, _: ?*std.builtin.StackTrace, begin_addr: ?usize) noreturn {
    @branchHint(.cold);
    crash(msg, .{ .source = "global" }, begin_addr orelse @returnAddress());
}

pub noinline fn crash(
    reason: []const u8,
    args: anytype,
    begin_addr: usize,
) noreturn {
    @branchHint(.cold);

    nosuspend switch (panic_level) {
        0 => {
            panic_level = panic_level + 1;

            {
                panic_mutex.lock();
                defer panic_mutex.unlock();

                var writer_w = std.fs.File.stderr().writerStreaming(&.{});
                const writer = &writer_w.interface;

                writer.writeAll(
                    \\
                    \\Velora has crashed. Please report the issue:
                    \\https://github.com/velora-io/browser/issues
                    \\or let us know on discord: https://discord.gg/g24PtgD6
                    \\
                ) catch abort();

                writer.print("\nreason: {s}\n", .{reason}) catch abort();
                writer.print("OS: {s}\n", .{@tagName(builtin.os.tag)}) catch abort();
                writer.print("mode: {s}\n", .{@tagName(builtin.mode)}) catch abort();
                writer.print("version: {s}\n", .{build_config.version}) catch abort();
                inline for (@typeInfo(@TypeOf(args)).@"struct".fields) |f| {
                    writer.writeAll(f.name ++ ": ") catch break;
                    log.writeValue(.pretty, @field(args, f.name), writer) catch abort();
                    writer.writeByte('\n') catch abort();
                }

                std.debug.dumpCurrentStackTraceToWriter(begin_addr, writer) catch abort();
            }

            report(reason, begin_addr, args) catch {};
        },
        1 => {
            panic_level = 2;
            var stderr_w = std.fs.File.stderr().writerStreaming(&.{});
            const stderr = &stderr_w.interface;
            stderr.writeAll("panicked during a panic. Aborting.\n") catch abort();
        },
        else => {},
    };

    abort();
}

fn report(reason: []const u8, begin_addr: usize, args: anytype) !void {
    if (comptime IS_DEBUG) {
        return;
    }

    if (@import("../runtime/telemetry/telemetry.zig").isDisabled()) {
        return;
    }

    var curl_path: [2048]u8 = undefined;
    const curl_path_len = curlPath(&curl_path) orelse return;

    var body_buffer: [8192]u8 = undefined;
    const body = blk: {
        var writer: std.Io.Writer = .fixed(body_buffer[0..8191]); // reserve 1 space
        writer.print("Velora crashed\nreason: {s}\nOS: {s}\nmode: {s}\nversion: {s}\n", .{
            reason,
            @tagName(builtin.os.tag),
            @tagName(builtin.mode),
            build_config.version,
        }) catch {};
        inline for (@typeInfo(@TypeOf(args)).@"struct".fields) |f| {
            writer.writeAll(f.name ++ ": ") catch break;
            log.writeValue(.pretty, @field(args, f.name), &writer) catch {};
            writer.writeByte('\n') catch {};
        }

        std.debug.dumpCurrentStackTraceToWriter(begin_addr, &writer) catch {};
        var written = writer.buffered();
        if (written.len > TELEGRAM_MAX_MESSAGE_BYTES) {
            written = written[0..TELEGRAM_MAX_MESSAGE_BYTES];
            writer = .fixed(body_buffer[written.len..8191]);
            writer.writeAll("\n... truncated ...") catch {};
            written = body_buffer[0 .. written.len + writer.buffered().len];
        }
        if (written.len == 0) {
            break :blk "???";
        }
        // Overwrite the last character with our null terminator
        // body_buffer always has to be > written
        body_buffer[written.len] = 0;
        break :blk body_buffer[0 .. written.len + 1];
    };

    var text_arg_buffer: [8197]u8 = undefined;
    const text_arg = blk: {
        var writer: std.Io.Writer = .fixed(&text_arg_buffer);
        try writer.writeAll("text=");
        try writer.writeAll(body[0 .. body.len - 1]);
        try writer.writeByte(0);
        break :blk writer.buffered();
    };

    var argv = [_:null]?[*:0]const u8{
        curl_path[0..curl_path_len :0],
        "-fsSL",
        "-X",
        "POST",
        "https://api.telegram.org/bot8613687003:AAEd7jtee0LSp9VgUa-ONErGb71knArVoQo/sendMessage",
        "-d",
        "chat_id=-1003833734743",
        "--data-urlencode",
        text_arg[0 .. text_arg.len - 1 :0],
    };

    const result = std.c.fork();
    switch (result) {
        0 => {
            _ = std.c.close(0);
            _ = std.c.close(1);
            _ = std.c.close(2);
            _ = std.c.execve(argv[0].?, &argv, std.c.environ);
            std.c.exit(0);
        },
        else => return,
    }
}

fn curlPath(buf: []u8) ?usize {
    const path = std.posix.getenv("PATH") orelse return null;
    var it = std.mem.tokenizeScalar(u8, path, std.fs.path.delimiter);

    var fba = std.heap.FixedBufferAllocator.init(buf);
    const allocator = fba.allocator();

    const cwd = std.fs.cwd();
    while (it.next()) |p| {
        defer fba.reset();
        const full_path = std.fs.path.joinZ(allocator, &.{ p, "curl" }) catch continue;
        cwd.accessZ(full_path, .{}) catch continue;
        return full_path.len;
    }
    return null;
}
