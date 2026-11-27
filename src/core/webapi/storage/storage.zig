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
const js = @import("../../js/js.zig");
const Frame = @import("../../browser/Frame.zig");
const StorageEvent = @import("../event/StorageEvent.zig");
const RealmLifecycleKernel = @import("../../../runtime/RealmLifecycleKernel.zig");

const Allocator = std.mem.Allocator;

pub fn registerTypes() []const type {
    return &.{Lookup};
}

pub const Cookie = @import("Cookie.zig");

pub const Shed = struct {
    _origins: std.StringHashMapUnmanaged(*Bucket) = .empty,

    pub fn deinit(self: *Shed, allocator: Allocator) void {
        var it = self._origins.iterator();
        while (it.next()) |kv| {
            allocator.free(kv.key_ptr.*);
            allocator.destroy(kv.value_ptr.*);
        }
        self._origins.deinit(allocator);
    }

    pub fn getOrPut(self: *Shed, allocator: Allocator, origin: []const u8) !*Bucket {
        if (self._origins.get(origin)) |bucket| return bucket;

        const bucket = try allocator.create(Bucket);
        errdefer allocator.destroy(bucket);
        bucket.* = .{};

        const owned_origin = try allocator.dupe(u8, origin);
        errdefer allocator.free(owned_origin);
        try self._origins.putNoClobber(allocator, owned_origin, bucket);
        return bucket;
    }
};

pub const Bucket = struct {
    local: Lookup = .{ .scope = .local },
    session: Lookup = .{ .scope = .session },
};

pub const Lookup = struct {
    pub const Scope = enum { local, session };

    _data: std.StringHashMapUnmanaged([]const u8) = .empty,
    _size: usize = 0,
    scope: Scope = .local,

    const max_size = 5 * 1024 * 1024;

    pub fn getItem(self: *const Lookup, key_: ?[]const u8) ?[]const u8 {
        const k = key_ orelse return null;
        return self._data.get(k);
    }

    pub fn setItem(self: *Lookup, key_: ?[]const u8, value: []const u8, frame: *Frame) !void {
        const k = key_ orelse return;
        const old_value = self._data.get(k);
        if (old_value) |old| if (std.mem.eql(u8, old, value)) return;
        try self.put(frame._session.arena, k, value);
        if (self.scope == .local) frame._session.persistLocalSet(frame.origin orelse "null", k, value);
        dispatchStorageEvent(frame, k, old_value, value);
    }

    fn dispatchStorageEvent(source: *Frame, storage_key: ?[]const u8, old_value: ?[]const u8, new_value: ?[]const u8) void {
        const root = &source._page.frame;
        const allocator = source._session.browser.app.allocator;
        var recipients: std.ArrayList(*Frame) = .empty;
        defer recipients.deinit(allocator);

        // Snapshot before queueing anything. Event handlers must not be able
        // to mutate child_frames while this mutation is selecting recipients.
        dispatchStorageEventInTree(root, source, &recipients, allocator);
        for (recipients.items) |target| {
            queueStorageEvent(target, storage_key, old_value, new_value, source.url);
        }
    }

    fn dispatchStorageEventInTree(
        current: *Frame,
        source: *Frame,
        recipients: *std.ArrayList(*Frame),
        allocator: Allocator,
    ) void {
        if (current != source and
            !current._deinit_done and
            current._realm_state == .active and
            !current._detach_pending and
            current.document._frame == current and
            current.origin != null and
            source.origin != null and
            std.mem.eql(u8, current.origin.?, source.origin.?))
        {
            recipients.append(allocator, current) catch return;
        }
        for (current.child_frames.items) |child| {
            dispatchStorageEventInTree(child, source, recipients, allocator);
        }
    }

    fn queueStorageEvent(
        target: *Frame,
        storage_key: ?[]const u8,
        old_value: ?[]const u8,
        new_value: ?[]const u8,
        source_url: []const u8,
    ) void {
        if (target._realm_state != .active or
            target._deinit_done or
            target._detach_pending or
            target.document._frame != target)
        {
            return;
        }

        const arena = target.getArena(.tiny, "StorageEvent.delivery") catch return;
        var queued = false;
        defer if (!queued) target.releaseArena(arena);

        const task = arena.create(StorageEventDelivery) catch return;
        task.* = .{
            .target = target,
            .task_owner = target.js.execution.captureTaskOwner(),
            .arena = arena,
            .payload = StorageEvent.QueuedPayload.init(
                arena,
                storage_key,
                old_value,
                new_value,
                source_url,
            ) catch return,
        };

        target.js.scheduler.add(task, StorageEventDelivery.run, 0, .{
            .name = "StorageEvent.delivery",
            .finalizer = StorageEventDelivery.cancelled,
        }) catch return;

        queued = true;
    }

    const StorageEventDelivery = struct {
        target: *Frame,
        task_owner: RealmLifecycleKernel.TaskOwner,
        arena: Allocator,
        payload: StorageEvent.QueuedPayload,

        fn cancelled(ctx: *anyopaque) void {
            const self: *StorageEventDelivery = @ptrCast(@alignCast(ctx));
            self.target.releaseArena(self.arena);
        }

        fn run(ctx: *anyopaque) !?u32 {
            const self: *StorageEventDelivery = @ptrCast(@alignCast(ctx));
            defer self.target.releaseArena(self.arena);

            // The scheduler finalizer handles queued teardown. These checks
            // cover a task already popped while the frame is being detached
            // or its document generation has changed.
            if (self.target._deinit_done or
                self.target._detach_pending or
                self.target._realm_state != .active or
                self.target.document._frame != self.target or
                self.target.js.execution.isTaskOwnerStale(self.task_owner) or
                !self.target.js.execution.canEnterJs(.strict_active))
            {
                return null;
            }

            const event = StorageEvent.initTrustedFromQueuedPayload(
                comptime .wrap("storage"),
                self.payload,
                self.target,
            ) catch return null;
            self.target._event_manager.dispatch(
                self.target.window.asEventTarget(),
                event.asEvent(),
            ) catch {};
            return null;
        }
    };

    /// Insert or replace one value while preserving quota accounting if any
    /// allocation or validation step fails. Persistence loaders use the same
    /// path so restored state cannot bypass runtime quota invariants.
    pub fn put(self: *Lookup, allocator: Allocator, k: []const u8, value: []const u8) !void {
        const old_len = if (self._data.get(k)) |old_value| old_value.len else 0;
        const new_size = self._size - old_len + value.len;
        if (new_size > max_size) return error.QuotaExceeded;

        const value_owned = try allocator.dupe(u8, value);
        errdefer allocator.free(value_owned);

        const key_owned = try allocator.dupe(u8, k);
        errdefer allocator.free(key_owned);

        const gop = try self._data.getOrPut(allocator, key_owned);
        if (!gop.found_existing) {
            gop.key_ptr.* = key_owned;
        } else {
            allocator.free(key_owned);
        }
        gop.value_ptr.* = value_owned;
        self._size = new_size;
    }

    pub fn removeItem(self: *Lookup, key_: ?[]const u8, frame: *Frame) void {
        const k = key_ orelse return;
        if (self._data.get(k)) |value| {
            self._size -= value.len;
            _ = self._data.remove(k);
            if (self.scope == .local) frame._session.persistLocalRemove(frame.origin orelse "null", k);
            dispatchStorageEvent(frame, k, value, null);
        }
    }

    pub fn clear(self: *Lookup, frame: *Frame) void {
        if (self._data.count() == 0) return;
        self._data.clearRetainingCapacity();
        self._size = 0;
        if (self.scope == .local) frame._session.persistLocalClear(frame.origin orelse "null");
        dispatchStorageEvent(frame, null, null, null);
    }

    pub fn key(self: *const Lookup, index: u32) ?[]const u8 {
        var it = self._data.keyIterator();
        var i: u32 = 0;
        while (it.next()) |k| {
            if (i == index) {
                return k.*;
            }
            i += 1;
        }
        return null;
    }

    pub fn getLength(self: *const Lookup) u32 {
        return @intCast(self._data.count());
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(Lookup);

        pub const Meta = struct {
            pub const name = "Storage";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
        };

        pub const length = bridge.accessor(Lookup.getLength, null, .{});
        pub const getItem = bridge.function(Lookup.getItem, .{});
        pub const setItem = bridge.function(Lookup.setItem, .{ .dom_exception = true });
        pub const removeItem = bridge.function(Lookup.removeItem, .{});
        pub const clear = bridge.function(Lookup.clear, .{});
        pub const key = bridge.function(Lookup.key, .{});
        pub const @"[str]" = bridge.namedIndexed(Lookup.getItem, Lookup.setItem, null, null, .{ .null_as_undefined = true });
    };
};

const testing = @import("../../../testing/testing.zig");
test "WebApi: Storage" {
    try testing.htmlRunner("storage.html", .{});
}

test "WebApi: Storage failed replacement preserves quota accounting" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();

    var lookup: Lookup = .{};
    try lookup.put(arena.allocator(), "key", "x");

    const too_large = try arena.allocator().alloc(u8, Lookup.max_size + 1);
    @memset(too_large, 'x');
    try testing.expectError(error.QuotaExceeded, lookup.put(arena.allocator(), "key", too_large));
    try testing.expectEqual(@as(usize, 1), lookup._size);
    try testing.expectEqual("x", lookup.getItem("key").?);

    const fills_quota = try arena.allocator().alloc(u8, Lookup.max_size - 1);
    @memset(fills_quota, 'y');
    try lookup.put(arena.allocator(), "other", fills_quota);
    try testing.expectEqual(Lookup.max_size, lookup._size);
}
