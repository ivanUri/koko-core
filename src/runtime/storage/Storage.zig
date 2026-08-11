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
const log = @import("../../support/log.zig");
const Config = @import("../Config.zig");
const Blackhole = @import("Blackhole.zig");
const SqliteStore = @import("sqlite/Store.zig");
pub const model = @import("Command.zig");

const Allocator = std.mem.Allocator;

const Storage = @This();

pub const EngineType = enum {
    none,
    sqlite,
};

const Engine = union(EngineType) {
    none: Blackhole,
    sqlite: *SqliteStore,
};

engine: Engine,

pub fn init(allocator: Allocator, config: *const Config) !Storage {
    const engine_type = config.storageEngine() orelse .sqlite;
    const engine = initEngine(allocator, engine_type, config) catch |err| {
        log.fatal(.storage, "storage setup", .{ .engine = engine_type, .err = err });
        return err;
    };

    return .{
        .engine = engine,
    };
}

fn initEngine(allocator: Allocator, engine_type: EngineType, config: *const Config) !Engine {
    switch (engine_type) {
        .none => return .{ .none = Blackhole{} },
        .sqlite => {
            if (config.storageSqlitePath()) |sqlite_path| {
                return .{ .sqlite = try SqliteStore.create(allocator, sqlite_path, config.activeProfileDir()) };
            }
            const sqlite_path = try std.fmt.allocPrintSentinel(allocator, "{s}/Storage.sqlite", .{config.activeProfileDir()}, 0);
            defer allocator.free(sqlite_path);
            return .{ .sqlite = try SqliteStore.create(allocator, sqlite_path, config.activeProfileDir()) };
        },
    }
}

pub fn deinit(self: *Storage, allocator: Allocator) void {
    switch (self.engine) {
        .none => |*engine| engine.deinit(allocator),
        .sqlite => |engine| engine.destroy(),
    }
}

pub fn usesSqlite(self: *const Storage) bool {
    return switch (self.engine) {
        .sqlite => true,
        .none => false,
    };
}

pub fn hasProfile(self: *Storage) !bool {
    return switch (self.engine) {
        .none => false,
        .sqlite => |engine| engine.hasProfile(),
    };
}

pub fn loadLocal(self: *Storage, allocator: Allocator) ![]model.StoredLocal {
    return switch (self.engine) {
        .none => try allocator.alloc(model.StoredLocal, 0),
        .sqlite => |engine| engine.loadLocal(allocator),
    };
}

pub fn loadCookies(self: *Storage, allocator: Allocator) ![]model.StoredCookie {
    return switch (self.engine) {
        .none => try allocator.alloc(model.StoredCookie, 0),
        .sqlite => |engine| engine.loadCookies(allocator),
    };
}

pub fn localSet(self: *Storage, origin: []const u8, key: []const u8, value: []const u8) !void {
    switch (self.engine) {
        .none => {},
        .sqlite => |engine| try engine.localSet(origin, key, value),
    }
}

pub fn localRemove(self: *Storage, origin: []const u8, key: []const u8) !void {
    switch (self.engine) {
        .none => {},
        .sqlite => |engine| try engine.localRemove(origin, key),
    }
}

pub fn localClear(self: *Storage, origin: []const u8) !void {
    switch (self.engine) {
        .none => {},
        .sqlite => |engine| try engine.localClear(origin),
    }
}

pub fn cookieUpsert(self: *Storage, cookie: anytype) !void {
    switch (self.engine) {
        .none => {},
        .sqlite => |engine| try engine.cookieUpsert(cookie),
    }
}

pub fn cookieDelete(self: *Storage, cookie: anytype) !void {
    switch (self.engine) {
        .none => {},
        .sqlite => |engine| try engine.cookieDelete(cookie),
    }
}

pub fn cookieClear(self: *Storage) !void {
    switch (self.engine) {
        .none => {},
        .sqlite => |engine| try engine.cookieClear(),
    }
}

pub fn flush(self: *Storage) !void {
    switch (self.engine) {
        .none => {},
        .sqlite => |engine| try engine.flush(),
    }
}
