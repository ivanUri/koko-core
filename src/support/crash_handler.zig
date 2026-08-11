const std = @import("std");
const builtin = @import("builtin");
const build_config = @import("build_config");
const log = @import("log.zig");

const abort = std.posix.abort;

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
                    \\Koko has crashed. Please report the issue:
                    \\https://github.com/ivanUri/koko/issues
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
