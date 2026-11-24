//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

const std = @import("std");
const builtin = @import("builtin");
const runtime_io = @import("../support/io.zig");

const Config = @import("Config.zig");
const Snapshot = @import("../core/js/Snapshot.zig");
const Platform = @import("../core/js/Platform.zig");
const Telemetry = @import("telemetry/telemetry.zig").Telemetry;

const Storage = @import("storage/Storage.zig");
const Network = @import("network/Network.zig");
pub const ScaleMetrics = @import("ScaleMetrics.zig");
pub const ArenaPool = @import("ArenaPool.zig");

const log = @import("../support/log.zig");
const Allocator = std.mem.Allocator;
const nanoTimestamp = @import("../support/datetime.zig").nanoTimestamp;

const App = @This();

/// Process-local startup breakdown. These timings are intentionally passive:
/// they are captured during initialization but never participate in runtime
/// scheduling. Adapters and benchmark harnesses can use them to separate
/// process/App startup from Browser/V8/session costs.
pub const StartupMetrics = struct {
    total_us: u64 = 0,
    platform_us: u64 = 0,
    snapshot_us: u64 = 0,
    storage_us: u64 = 0,
    network_us: u64 = 0,
    app_dir_us: u64 = 0,
    telemetry_us: u64 = 0,
    arena_pool_us: u64 = 0,
};

network: Network,
config: *const Config,
storage: Storage,
platform: Platform,
snapshot: Snapshot,
telemetry: Telemetry,
allocator: Allocator,
arena_pool: ArenaPool,
metrics: ScaleMetrics,
app_dir_path: ?[]const u8,
startup: StartupMetrics,

pub fn init(allocator: Allocator, config: *const Config) !*App {
    const started_ns = nanoTimestamp(.monotonic);

    const platform_started_ns = nanoTimestamp(.monotonic);
    const platform = try Platform.init();
    errdefer platform.deinit();
    const platform_us = elapsedUs(platform_started_ns);

    const snapshot_started_ns = nanoTimestamp(.monotonic);
    const snapshot = try Snapshot.load();
    errdefer snapshot.deinit();
    const snapshot_us = elapsedUs(snapshot_started_ns);

    const storage_started_ns = nanoTimestamp(.monotonic);
    var storage = try Storage.init(allocator, config);
    errdefer storage.deinit(allocator);
    const storage_us = elapsedUs(storage_started_ns);

    const app = try allocator.create(App);
    errdefer allocator.destroy(app);

    app.* = .{
        .config = config,
        .allocator = allocator,
        .platform = platform,
        .snapshot = snapshot,
        .storage = storage,
        .network = undefined,
        .app_dir_path = undefined,
        .telemetry = undefined,
        .arena_pool = undefined,
        .metrics = .{},
        .startup = .{},
    };

    const network_started_ns = nanoTimestamp(.monotonic);
    app.network = try Network.init(allocator, app, config);
    app.network.metrics = &app.metrics;
    errdefer app.network.deinit();
    const network_us = elapsedUs(network_started_ns);

    const app_dir_started_ns = nanoTimestamp(.monotonic);
    app.app_dir_path = getAndMakeAppDir(allocator);
    const app_dir_us = elapsedUs(app_dir_started_ns);

    const telemetry_started_ns = nanoTimestamp(.monotonic);
    app.telemetry = try Telemetry.init(app, config.mode);
    errdefer app.telemetry.deinit(allocator);
    const telemetry_us = elapsedUs(telemetry_started_ns);

    const arena_pool_started_ns = nanoTimestamp(.monotonic);
    app.arena_pool = ArenaPool.init(allocator, .{});
    app.arena_pool.metrics = &app.metrics;
    errdefer app.arena_pool.deinit();
    const arena_pool_us = elapsedUs(arena_pool_started_ns);

    app.startup = .{
        .total_us = elapsedUs(started_ns),
        .platform_us = platform_us,
        .snapshot_us = snapshot_us,
        .storage_us = storage_us,
        .network_us = network_us,
        .app_dir_us = app_dir_us,
        .telemetry_us = telemetry_us,
        .arena_pool_us = arena_pool_us,
    };

    return app;
}

pub fn startupMetrics(self: *const App) StartupMetrics {
    return self.startup;
}

pub fn shutdown(self: *const App) bool {
    return self.network.shutdown.load(.acquire);
}

/// Returns an immutable snapshot for diagnostics and benchmark adapters. The
/// counters are intentionally process-local and never participate in runtime
/// decisions, so reading them cannot change scheduling behavior.
pub fn scaleMetrics(self: *const App) ScaleMetrics.Snapshot {
    return self.metrics.snapshot();
}

pub fn deinit(self: *App) void {
    const allocator = self.allocator;
    if (self.app_dir_path) |app_dir_path| {
        allocator.free(app_dir_path);
        self.app_dir_path = null;
    }
    self.telemetry.deinit(allocator);
    self.network.deinit();
    self.snapshot.deinit();
    self.platform.deinit();
    self.arena_pool.deinit();
    self.storage.deinit(allocator);

    allocator.destroy(self);
}

fn getAndMakeAppDir(allocator: Allocator) ?[]const u8 {
    if (@import("builtin").is_test) {
        return allocator.dupe(u8, "/tmp") catch unreachable;
    }
    const base = switch (builtin.os.tag) {
        .macos => runtime_io.getenv("HOME"),
        .windows => runtime_io.getenv("LOCALAPPDATA"),
        else => runtime_io.getenv("XDG_DATA_HOME") orelse runtime_io.getenv("HOME"),
    } orelse return null;
    const suffix = switch (builtin.os.tag) {
        .macos => "Library/Application Support/koko",
        .windows => "koko",
        else => if (runtime_io.getenv("XDG_DATA_HOME") != null) "koko" else ".local/share/koko",
    };
    const app_dir_path = std.fs.path.join(allocator, &.{ base, suffix }) catch |err| {
        log.warn(.app, "get data dir", .{ .err = err });
        return null;
    };

    std.Io.Dir.cwd().createDirPath(runtime_io.get(), app_dir_path) catch |err| switch (err) {
        error.PathAlreadyExists => return app_dir_path,
        else => {
            allocator.free(app_dir_path);
            log.warn(.app, "create data dir", .{ .err = err, .path = app_dir_path });
            return null;
        },
    };
    return app_dir_path;
}

fn elapsedUs(started_ns: i128) u64 {
    const elapsed = nanoTimestamp(.monotonic) - started_ns;
    if (elapsed <= 0) return 0;
    return @intCast(@divTrunc(elapsed, std.time.ns_per_us));
}
