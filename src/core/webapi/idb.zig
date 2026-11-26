// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 or any later version.

const std = @import("std");
const js = @import("../js/js.zig");
const Frame = @import("../browser/Frame.zig");
const EventTarget = @import("EventTarget.zig");
const Event = @import("Event.zig");
const RealmLifecycleKernel = @import("../../runtime/RealmLifecycleKernel.zig");

// IndexedDB is request/event based, not Promise based.  The storage backend
// below is deliberately in-memory for now, but the API objects and their
// lifecycle match the web-platform boundary so a persistent backend can be
// substituted without changing callers.

pub fn registerTypes() []const type {
    return &.{
        IDBFactory,
        IDBRequest,
        IDBOpenDBRequest,
        IDBDatabase,
        DOMStringList,
        IDBObjectStore,
        IDBIndex,
        IDBCursor,
        IDBKeyRange,
        IDBTransaction,
    };
}

const KeyPath = union(enum) {
    string: []const u8,
    compound: []const []const u8,
};

const IndexData = struct {
    name: []const u8,
    key_path: []const u8,
    unique: bool = false,
    multi_entry: bool = false,
};

const Record = struct {
    key: js.Value.Global,
    value: js.Value.Global,
};

const StoreData = struct {
    name: []const u8,
    key_path: ?KeyPath = null,
    auto_increment: bool = false,
    next_key: u64 = 1,
    records: std.StringHashMapUnmanaged(Record) = .empty,
    indexes: std.StringHashMapUnmanaged(*IndexData) = .empty,
};

const DatabaseData = struct {
    name: []const u8,
    version: u32,
    stores: std.StringHashMapUnmanaged(*StoreData) = .empty,
};

const Mutation = union(enum) {
    put: struct {
        store: *StoreData,
        key_text: []const u8,
        key: js.Value.Global,
        value: js.Value.Global,
    },
    delete: struct { store: *StoreData, key_text: []const u8 },
    clear: *StoreData,
};

fn optionalProperty(value: js.Value, name: []const u8) ?js.Value {
    if (!value.isObject()) return null;
    return value.toObject().get(name) catch null;
}

fn parseKeyPath(value: js.Value, arena: std.mem.Allocator) !?KeyPath {
    if (value.isNullOrUndefined()) return null;
    if (value.isString()) |string| {
        return .{ .string = try arena.dupe(u8, try string.toSlice()) };
    }
    if (!value.isArray()) return error.InvalidArgument;
    const array = value.toArray();
    const paths = try arena.alloc([]const u8, array.len());
    for (paths, 0..) |*path, i| {
        const item = try array.get(@intCast(i));
        const string = item.isString() orelse return error.InvalidArgument;
        path.* = try arena.dupe(u8, try string.toSlice());
    }
    return .{ .compound = paths };
}

fn pathValue(value: js.Value, path: []const u8) !?js.Value {
    var current = value;
    var parts = std.mem.splitScalar(u8, path, '.');
    while (parts.next()) |part| {
        if (part.len == 0 or !current.isObject()) return null;
        current = current.toObject().get(part) catch return null;
        if (current.isUndefined()) return null;
    }
    return current;
}

fn valueForKeyPath(value: js.Value, key_path: KeyPath) !?js.Value {
    return switch (key_path) {
        .string => |path| pathValue(value, path),
        .compound => |paths| blk: {
            const array = value.local.newArray(@intCast(paths.len));
            for (paths, 0..) |path, i| {
                const item = (try pathValue(value, path)) orelse break :blk null;
                _ = try array.set(@intCast(i), item, .{});
            }
            break :blk array.toValue();
        },
    };
}

pub const IDBRequest = struct {
    _proto: *EventTarget,
    _frame: *Frame,
    _result: ?js.Value.Global = null,
    _ready_state: enum { pending, done } = .pending,
    _on_success: ?js.Function.Global = null,
    _on_error: ?js.Function.Global = null,

    pub fn asEventTarget(self: *IDBRequest) *EventTarget {
        return self._proto;
    }

    pub fn getResult(self: *const IDBRequest, frame: *Frame) !js.Value {
        const local = frame.js.local.?;
        return if (self._result) |*result| result.local(local) else try local.zigValueToJs(js.Undefined{}, .{});
    }

    pub fn getError(_: *const IDBRequest) ?js.Value {
        return null;
    }

    pub fn getReadyState(self: *const IDBRequest) []const u8 {
        return @tagName(self._ready_state);
    }

    pub fn getOnSuccess(self: *const IDBRequest) ?js.Function.Global {
        return self._on_success;
    }
    pub fn setOnSuccess(self: *IDBRequest, cb: ?js.Function.Global) void {
        self._on_success = cb;
    }
    pub fn getOnError(self: *const IDBRequest) ?js.Function.Global {
        return self._on_error;
    }
    pub fn setOnError(self: *IDBRequest, cb: ?js.Function.Global) void {
        self._on_error = cb;
    }

    fn succeed(self: *IDBRequest, value: js.Value) anyerror!void {
        // Ordinary values are cloned at the IndexedDB boundary. Host objects
        // such as IDBCursor cannot be structured-cloned; they are persistent
        // API objects whose identity must be returned by the request.
        const cloned = value.structuredClone() catch {
            // Native IndexedDB objects (for example IDBCursor) are returned
            // by identity and are not structured-cloneable. Other objects
            // still use the normal clone path above.
            if (value.isObject()) {
                self._result = try value.persist();
                self._ready_state = .done;
                const event = try Event.initTrusted(comptime .wrap("success"), .{}, self._frame._page);
                try self._frame._event_manager.dispatchDirect(self._proto, event, self._on_success, .{
                    .context = "IDBRequest.success",
                });
                return;
            }
            return error.JsException;
        };
        self._result = try cloned.persist();
        self._ready_state = .done;
        const event = try Event.initTrusted(comptime .wrap("success"), .{}, self._frame._page);
        try self._frame._event_manager.dispatchDirect(self._proto, event, self._on_success, .{
            .context = "IDBRequest.success",
        });
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(IDBRequest);
        pub const Meta = struct {
            pub const name = "IDBRequest";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
        };
        pub const Prototype = EventTarget;
        pub const result = bridge.accessor(IDBRequest.getResult, null, .{});
        pub const @"error" = bridge.accessor(IDBRequest.getError, null, .{});
        pub const readyState = bridge.accessor(IDBRequest.getReadyState, null, .{});
        pub const onsuccess = bridge.accessor(IDBRequest.getOnSuccess, IDBRequest.setOnSuccess, .{});
        pub const onerror = bridge.accessor(IDBRequest.getOnError, IDBRequest.setOnError, .{});
    };
};

pub const IDBOpenDBRequest = struct {
    _proto: *EventTarget,
    _frame: *Frame,
    _factory: *IDBFactory,
    _name: []const u8,
    _requested_version: ?u32,
    _result: ?*IDBDatabase = null,
    _transaction: ?*IDBTransaction = null,
    _ready_state: enum { pending, done } = .pending,
    _on_success: ?js.Function.Global = null,
    _on_error: ?js.Function.Global = null,
    _on_upgrade_needed: ?js.Function.Global = null,
    _on_blocked: ?js.Function.Global = null,
    _task_owner: ?RealmLifecycleKernel.TaskOwner = null,
    _cancelled: bool = false,

    pub fn getResult(self: *const IDBOpenDBRequest) ?*IDBDatabase {
        return self._result;
    }
    pub fn getTransaction(self: *const IDBOpenDBRequest) ?*IDBTransaction {
        return self._transaction;
    }
    pub fn getError(_: *const IDBOpenDBRequest) ?js.Value {
        return null;
    }
    pub fn getReadyState(self: *const IDBOpenDBRequest) []const u8 {
        return @tagName(self._ready_state);
    }
    pub fn getOnSuccess(self: *const IDBOpenDBRequest) ?js.Function.Global {
        return self._on_success;
    }
    pub fn setOnSuccess(self: *IDBOpenDBRequest, cb: ?js.Function.Global) void {
        self._on_success = cb;
    }
    pub fn getOnError(self: *const IDBOpenDBRequest) ?js.Function.Global {
        return self._on_error;
    }
    pub fn setOnError(self: *IDBOpenDBRequest, cb: ?js.Function.Global) void {
        self._on_error = cb;
    }
    pub fn getOnUpgradeNeeded(self: *const IDBOpenDBRequest) ?js.Function.Global {
        return self._on_upgrade_needed;
    }
    pub fn setOnUpgradeNeeded(self: *IDBOpenDBRequest, cb: ?js.Function.Global) void {
        self._on_upgrade_needed = cb;
    }
    pub fn getOnBlocked(self: *const IDBOpenDBRequest) ?js.Function.Global {
        return self._on_blocked;
    }
    pub fn setOnBlocked(self: *IDBOpenDBRequest, cb: ?js.Function.Global) void {
        self._on_blocked = cb;
    }

    fn run(ptr: *anyopaque) anyerror!?u32 {
        const self: *IDBOpenDBRequest = @ptrCast(@alignCast(ptr));
        if (self._cancelled) return null;

        // IndexedDB.open is a host task. It must not re-enter a navigated or
        // detached realm, even if the task was already popped before the
        // scheduler reset ran.
        const exec = &self._frame.js.execution;
        if (self._task_owner) |owner| {
            // IndexedDB callbacks are ordinary task-queue work.  A root realm
            // may be in `draining` immediately after parsing while its load
            // handlers are still allowed to enqueue and run host tasks.  The
            // strict-active gate dropped every open request in that window,
            // leaving the request pending forever.  Keep the owner/epoch
            // check for teardown safety, but use the same draining policy as
            // timers, fetch completion, and other deferred Web APIs.
            if (exec.isTaskOwnerStale(owner) or !exec.canEnterJs(.allow_draining)) {
                self._cancelled = true;
                return null;
            }
        }

        const arena = self._frame._page.frame_arena;
        const gop = try self._factory._databases.getOrPut(arena, self._name);
        const created = !gop.found_existing;
        if (created) {
            const db_data = try arena.create(DatabaseData);
            db_data.* = .{
                .name = self._name,
                // A newly-created database starts at version 0. The first
                // open must therefore run a versionchange transaction even
                // when the caller omits the version argument.
                .version = 0,
            };
            gop.value_ptr.* = db_data;
        }
        const data = gop.value_ptr.*;
        const requested = self._requested_version orelse if (data.version == 0) 1 else data.version;
        if (requested < data.version or requested == 0) return error.VersionError;

        const db = try self._frame._factory.create(IDBDatabase{
            ._frame = self._frame,
            ._data = data,
        });
        self._result = db;

        if (created or requested > data.version) {
            const txn = try self._frame._factory.eventTarget(IDBTransaction{
                ._proto = undefined,
                ._frame = self._frame,
                ._database = db,
                ._mode = "versionchange",
                ._active = true,
            });
            self._transaction = txn;
            db._version_transaction = txn;
            const event = try Event.initTrustedSlice("upgradeneeded", .{}, self._frame._page);
            try self._frame._event_manager.dispatchDirect(self._proto, event, self._on_upgrade_needed, .{
                .context = "IDBOpenDBRequest.upgradeneeded",
            });
            if (self._cancelled or exec.isTaskOwnerStale(self._task_owner.?)) return null;
            if (txn._aborted) return null;
            try txn.commitMutations();
            data.version = requested;
            db._version_transaction = null;
        }

        if (self._transaction) |txn| txn._active = false;
        self._transaction = null;
        self._ready_state = .done;
        const success = try Event.initTrusted(comptime .wrap("success"), .{}, self._frame._page);
        try self._frame._event_manager.dispatchDirect(self._proto, success, self._on_success, .{
            .context = "IDBOpenDBRequest.success",
        });
        return null;
    }

    fn cancelled(ptr: *anyopaque) void {
        const self: *IDBOpenDBRequest = @ptrCast(@alignCast(ptr));
        self._cancelled = true;
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(IDBOpenDBRequest);
        pub const Meta = struct {
            pub const name = "IDBOpenDBRequest";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
        };
        pub const Prototype = EventTarget;
        pub const result = bridge.accessor(IDBOpenDBRequest.getResult, null, .{});
        pub const @"error" = bridge.accessor(IDBOpenDBRequest.getError, null, .{});
        pub const readyState = bridge.accessor(IDBOpenDBRequest.getReadyState, null, .{});
        pub const transaction = bridge.accessor(IDBOpenDBRequest.getTransaction, null, .{});
        pub const onsuccess = bridge.accessor(IDBOpenDBRequest.getOnSuccess, IDBOpenDBRequest.setOnSuccess, .{});
        pub const onerror = bridge.accessor(IDBOpenDBRequest.getOnError, IDBOpenDBRequest.setOnError, .{});
        pub const onupgradeneeded = bridge.accessor(IDBOpenDBRequest.getOnUpgradeNeeded, IDBOpenDBRequest.setOnUpgradeNeeded, .{});
        pub const onblocked = bridge.accessor(IDBOpenDBRequest.getOnBlocked, IDBOpenDBRequest.setOnBlocked, .{});
    };
};

pub const IDBDatabase = struct {
    _frame: *Frame,
    _data: *DatabaseData,
    _closed: bool = false,
    _version_transaction: ?*IDBTransaction = null,
    _on_close: ?js.Function.Global = null,

    pub fn getName(self: *const IDBDatabase) []const u8 {
        return self._data.name;
    }
    pub fn getVersion(self: *const IDBDatabase) u32 {
        return self._data.version;
    }

    pub fn objectStoreNames(self: *IDBDatabase, frame: *Frame) !*DOMStringList {
        return frame._factory.create(DOMStringList{ ._database = self });
    }

    pub fn createObjectStore(self: *IDBDatabase, name: []const u8, options: ?js.Value, frame: *Frame) !*IDBObjectStore {
        const version_transaction = self._version_transaction orelse return error.InvalidStateError;
        if (!version_transaction._active or !std.mem.eql(u8, version_transaction._mode, "versionchange")) {
            return error.InvalidStateError;
        }
        const arena = frame._page.frame_arena;
        const owned_name = try arena.dupe(u8, name);
        const gop = try self._data.stores.getOrPut(arena, owned_name);
        if (gop.found_existing) return error.ConstraintError;
        const data = try arena.create(StoreData);
        data.* = .{ .name = owned_name };
        if (options) |opts| {
            if (optionalProperty(opts, "keyPath")) |key_path| {
                data.key_path = try parseKeyPath(key_path, arena);
            }
            if (optionalProperty(opts, "autoIncrement")) |auto_increment| {
                if (!auto_increment.isNullOrUndefined()) data.auto_increment = auto_increment.toBool();
            }
        }
        gop.value_ptr.* = data;
        return frame._factory.create(IDBObjectStore{
            ._frame = frame,
            ._transaction = version_transaction,
            ._data = data,
        });
    }

    pub fn deleteObjectStore(self: *IDBDatabase, name: []const u8) !void {
        const version_transaction = self._version_transaction orelse return error.InvalidStateError;
        if (!version_transaction._active or !std.mem.eql(u8, version_transaction._mode, "versionchange")) {
            return error.InvalidStateError;
        }
        if (!self._data.stores.remove(name)) return error.NotFoundError;
    }

    pub fn transaction(self: *IDBDatabase, names: js.Value, mode: ?[]const u8, frame: *Frame) !*IDBTransaction {
        _ = names;
        if (self._closed) return error.InvalidStateError;
        return frame._factory.eventTarget(IDBTransaction{
            ._proto = undefined,
            ._frame = frame,
            ._database = self,
            ._mode = mode orelse "readonly",
            ._active = true,
        });
    }

    pub fn close(self: *IDBDatabase) void {
        self._closed = true;
    }

    pub fn getOnClose(self: *const IDBDatabase) ?js.Function.Global {
        return self._on_close;
    }

    pub fn setOnClose(self: *IDBDatabase, cb: ?js.Function.Global) void {
        self._on_close = cb;
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(IDBDatabase);
        pub const Meta = struct {
            pub const name = "IDBDatabase";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
        };
        pub const name = bridge.accessor(IDBDatabase.getName, null, .{});
        pub const version = bridge.accessor(IDBDatabase.getVersion, null, .{});
        pub const objectStoreNames = bridge.accessor(IDBDatabase.objectStoreNames, null, .{});
        pub const createObjectStore = bridge.function(IDBDatabase.createObjectStore, .{});
        pub const deleteObjectStore = bridge.function(IDBDatabase.deleteObjectStore, .{});
        pub const transaction = bridge.function(IDBDatabase.transaction, .{});
        pub const close = bridge.function(IDBDatabase.close, .{});
        pub const onclose = bridge.accessor(IDBDatabase.getOnClose, IDBDatabase.setOnClose, .{});
    };
};

// The IndexedDB name lists use the legacy DOMStringList Web IDL interface,
// not Array. Keep this as a live view so schema changes made during an upgrade
// are immediately observable through an already-retrieved list.
pub const DOMStringList = struct {
    _database: ?*IDBDatabase = null,
    _store: ?*StoreData = null,

    fn namesCount(self: *const DOMStringList) usize {
        if (self._store) |store| return store.indexes.count();
        if (self._database) |database| return database._data.stores.count();
        return 0;
    }

    fn namesContains(self: *const DOMStringList, name: []const u8) bool {
        if (self._store) |store| return store.indexes.contains(name);
        if (self._database) |database| return database._data.stores.contains(name);
        return false;
    }

    pub fn getLength(self: *const DOMStringList) u32 {
        return @intCast(self.namesCount());
    }

    pub fn contains(self: *const DOMStringList, name: []const u8) bool {
        return self.namesContains(name);
    }

    pub fn item(self: *const DOMStringList, index: u32) ?[]const u8 {
        if (self._store) |store| {
            var current: u32 = 0;
            var it = store.indexes.keyIterator();
            while (it.next()) |name| : (current += 1) {
                if (current == index) return name.*;
            }
            return null;
        }
        if (self._database) |database| {
            var current: u32 = 0;
            var it = database._data.stores.keyIterator();
            while (it.next()) |name| : (current += 1) {
                if (current == index) return name.*;
            }
        }
        return null;
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(DOMStringList);
        pub const Meta = struct {
            pub const name = "DOMStringList";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
        };
        pub const length = bridge.accessor(DOMStringList.getLength, null, .{});
        pub const contains = bridge.function(DOMStringList.contains, .{});
        pub const item = bridge.function(DOMStringList.item, .{});
    };
};

pub const IDBTransaction = struct {
    _proto: *EventTarget,
    _frame: *Frame,
    _database: *IDBDatabase,
    _mode: []const u8,
    _active: bool,
    _pending_requests: usize = 0,
    _completion_scheduled: bool = false,
    _aborted: bool = false,
    _abort_scheduled: bool = false,
    _mutations: std.ArrayListUnmanaged(Mutation) = .empty,
    _on_complete: ?js.Function.Global = null,
    _on_error: ?js.Function.Global = null,
    _on_abort: ?js.Function.Global = null,

    pub fn objectStore(self: *IDBTransaction, name: []const u8, frame: *Frame) !*IDBObjectStore {
        if (!self._active) return error.TransactionInactiveError;
        const data = self._database._data.stores.get(name) orelse return error.NotFoundError;
        return frame._factory.create(IDBObjectStore{ ._frame = frame, ._transaction = self, ._data = data });
    }
    pub fn getMode(self: *const IDBTransaction) []const u8 {
        return self._mode;
    }
    pub fn getDb(self: *const IDBTransaction) *IDBDatabase {
        return self._database;
    }
    pub fn abort(self: *IDBTransaction) void {
        if (!self._active or self._aborted) return;
        self._active = false;
        self._aborted = true;
        if (!self._abort_scheduled) {
            self._abort_scheduled = true;
            self._frame.js.scheduler.add(self, abortComplete, 0, .{
                .name = "IndexedDB transaction abort",
                .low_priority = false,
            }) catch {};
        }
    }

    fn queuePut(self: *IDBTransaction, store: *StoreData, key_text: []const u8, key: js.Value.Global, value: js.Value.Global) !void {
        try self._mutations.append(self._frame._page.frame_arena, .{ .put = .{
            .store = store,
            .key_text = key_text,
            .key = key,
            .value = value,
        } });
    }

    fn queueDelete(self: *IDBTransaction, store: *StoreData, key_text: []const u8) !void {
        try self._mutations.append(self._frame._page.frame_arena, .{ .delete = .{ .store = store, .key_text = key_text } });
    }

    fn queueClear(self: *IDBTransaction, store: *StoreData) !void {
        try self._mutations.append(self._frame._page.frame_arena, .{ .clear = store });
    }

    fn commitMutations(self: *IDBTransaction) !void {
        for (self._mutations.items) |mutation| switch (mutation) {
            .put => |put| try put.store.records.put(self._frame._page.frame_arena, put.key_text, .{ .key = put.key, .value = put.value }),
            .delete => |del| _ = del.store.records.remove(del.key_text),
            .clear => |store| store.records.clearRetainingCapacity(),
        };
        self._mutations.clearRetainingCapacity();
    }

    fn requestStarted(self: *IDBTransaction) void {
        self._pending_requests += 1;
    }

    fn requestFinished(self: *IDBTransaction) !void {
        if (self._pending_requests > 0) self._pending_requests -= 1;
        if (!self._active or self._pending_requests != 0 or self._completion_scheduled) return;
        self._completion_scheduled = true;
        try self._frame.js.scheduler.add(self, complete, 0, .{
            .name = "IndexedDB transaction complete",
            .low_priority = false,
        });
    }

    fn complete(ptr: *anyopaque) anyerror!?u32 {
        const self: *IDBTransaction = @ptrCast(@alignCast(ptr));
        self._completion_scheduled = false;
        if (!self._active or self._pending_requests != 0) return null;
        try self.commitMutations();
        self._active = false;
        const event = try Event.initTrusted(comptime .wrap("complete"), .{}, self._frame._page);
        try self._frame._event_manager.dispatchDirect(self._proto, event, self._on_complete, .{
            .context = "IDBTransaction.complete",
        });
        return null;
    }

    fn abortComplete(ptr: *anyopaque) anyerror!?u32 {
        const self: *IDBTransaction = @ptrCast(@alignCast(ptr));
        self._abort_scheduled = false;
        const event = try Event.initTrusted(comptime .wrap("abort"), .{}, self._frame._page);
        try self._frame._event_manager.dispatchDirect(self._proto, event, self._on_abort, .{
            .context = "IDBTransaction.abort",
        });
        return null;
    }
    pub fn getOnComplete(self: *const IDBTransaction) ?js.Function.Global {
        return self._on_complete;
    }
    pub fn setOnComplete(self: *IDBTransaction, cb: ?js.Function.Global) void {
        self._on_complete = cb;
    }
    pub fn getOnError(self: *const IDBTransaction) ?js.Function.Global {
        return self._on_error;
    }
    pub fn setOnError(self: *IDBTransaction, cb: ?js.Function.Global) void {
        self._on_error = cb;
    }
    pub fn getOnAbort(self: *const IDBTransaction) ?js.Function.Global {
        return self._on_abort;
    }
    pub fn setOnAbort(self: *IDBTransaction, cb: ?js.Function.Global) void {
        self._on_abort = cb;
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(IDBTransaction);
        pub const Meta = struct {
            pub const name = "IDBTransaction";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
        };
        pub const Prototype = EventTarget;
        pub const objectStore = bridge.function(IDBTransaction.objectStore, .{});
        pub const mode = bridge.accessor(IDBTransaction.getMode, null, .{});
        pub const db = bridge.accessor(IDBTransaction.getDb, null, .{});
        pub const abort = bridge.function(IDBTransaction.abort, .{});
        pub const oncomplete = bridge.accessor(IDBTransaction.getOnComplete, IDBTransaction.setOnComplete, .{});
        pub const onerror = bridge.accessor(IDBTransaction.getOnError, IDBTransaction.setOnError, .{});
        pub const onabort = bridge.accessor(IDBTransaction.getOnAbort, IDBTransaction.setOnAbort, .{});
    };
};

pub const IDBKeyRange = struct {
    _frame: *Frame,
    _lower: ?js.Value.Global = null,
    _upper: ?js.Value.Global = null,
    _lower_open: bool = false,
    _upper_open: bool = false,

    fn init(frame: *Frame, lower: ?js.Value, upper: ?js.Value, lower_open: bool, upper_open: bool) !*IDBKeyRange {
        return frame._factory.create(IDBKeyRange{
            ._frame = frame,
            ._lower = if (lower) |value| try (try value.structuredClone()).persist() else null,
            ._upper = if (upper) |value| try (try value.structuredClone()).persist() else null,
            ._lower_open = lower_open,
            ._upper_open = upper_open,
        });
    }

    pub fn only(value: js.Value, frame: *Frame) !*IDBKeyRange {
        return init(frame, value, value, false, false);
    }

    pub fn lowerBound(value: js.Value, open: ?bool, frame: *Frame) !*IDBKeyRange {
        return init(frame, value, null, open orelse false, false);
    }

    pub fn upperBound(value: js.Value, open: ?bool, frame: *Frame) !*IDBKeyRange {
        return init(frame, null, value, false, open orelse false);
    }

    pub fn bound(lower: js.Value, upper: js.Value, lower_open: ?bool, upper_open: ?bool, frame: *Frame) !*IDBKeyRange {
        if (compareKeyValues(lower, upper) == .gt) return error.DataError;
        return init(frame, lower, upper, lower_open orelse false, upper_open orelse false);
    }

    pub fn getLower(self: *const IDBKeyRange, frame: *Frame) ?js.Value {
        return if (self._lower) |*value| value.local(frame.js.local.?) else null;
    }

    pub fn getUpper(self: *const IDBKeyRange, frame: *Frame) ?js.Value {
        return if (self._upper) |*value| value.local(frame.js.local.?) else null;
    }

    pub fn getLowerOpen(self: *const IDBKeyRange) bool {
        return self._lower_open;
    }

    pub fn getUpperOpen(self: *const IDBKeyRange) bool {
        return self._upper_open;
    }

    fn includes(self: *const IDBKeyRange, value: js.Value) bool {
        if (self._lower) |*lower| {
            const order = compareKeyValues(value, lower.local(value.local));
            if (order == .lt or (order == .eq and self._lower_open)) return false;
        }
        if (self._upper) |*upper| {
            const order = compareKeyValues(value, upper.local(value.local));
            if (order == .gt or (order == .eq and self._upper_open)) return false;
        }
        return true;
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(IDBKeyRange);
        pub const Meta = struct {
            pub const name = "IDBKeyRange";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
        };
        pub const lower = bridge.accessor(IDBKeyRange.getLower, null, .{});
        pub const upper = bridge.accessor(IDBKeyRange.getUpper, null, .{});
        pub const lowerOpen = bridge.accessor(IDBKeyRange.getLowerOpen, null, .{});
        pub const upperOpen = bridge.accessor(IDBKeyRange.getUpperOpen, null, .{});
        pub const only = bridge.function(IDBKeyRange.only, .{ .static = true });
        pub const lowerBound = bridge.function(IDBKeyRange.lowerBound, .{ .static = true });
        pub const upperBound = bridge.function(IDBKeyRange.upperBound, .{ .static = true });
        pub const bound = bridge.function(IDBKeyRange.bound, .{ .static = true });
    };
};

const Query = union(enum) {
    all,
    exact: js.Value.Global,
    range: *IDBKeyRange,
};

fn compareKeyValues(a: js.Value, b: js.Value) std.math.Order {
    if (a.isNumber() and b.isNumber()) {
        const av = a.toF64() catch return .eq;
        const bv = b.toF64() catch return .eq;
        return std.math.order(av, bv);
    }
    if (a.isString() != null and b.isString() != null) {
        return std.mem.order(u8, a.toStringSlice() catch "", b.toStringSlice() catch "");
    }
    if (a.isArray() and b.isArray()) {
        const aa = a.toArray();
        const ba = b.toArray();
        const length = @min(aa.len(), ba.len());
        for (0..length) |i| {
            const order = compareKeyValues(aa.get(@intCast(i)) catch return .eq, ba.get(@intCast(i)) catch return .eq);
            if (order != .eq) return order;
        }
        return std.math.order(aa.len(), ba.len());
    }
    return std.mem.order(u8, a.toJson(a.local.call_arena) catch "", b.toJson(b.local.call_arena) catch "");
}

fn queryMatches(query: Query, key: js.Value) bool {
    return switch (query) {
        .all => true,
        .exact => |exact| compareKeyValues(key, exact.local(key.local)) == .eq,
        .range => |range| range.includes(key),
    };
}

fn queryFromValue(value: ?js.Value) !Query {
    const query = value orelse return .all;
    if (query.isNullOrUndefined()) return .all;
    if (query.isBranded(IDBKeyRange)) return .{ .range = try query.toZig(*IDBKeyRange) };
    return .{ .exact = try (try query.structuredClone()).persist() };
}

const CursorEntry = struct {
    record: *const Record,
    key: js.Value.Global,
};

fn sortEntries(local: *const js.Local, entries: []CursorEntry, reverse: bool) void {
    var i: usize = 1;
    while (i < entries.len) : (i += 1) {
        const item = entries[i];
        var j = i;
        while (j > 0) {
            const order = compareKeyValues(entries[j - 1].key.local(local), item.key.local(local));
            const should_move = if (reverse) order == .lt else order == .gt;
            if (!should_move) break;
            entries[j] = entries[j - 1];
            j -= 1;
        }
        entries[j] = item;
    }
}

pub const IDBCursor = struct {
    _frame: *Frame,
    _request: *IDBRequest,
    _transaction: *IDBTransaction,
    _entries: []CursorEntry,
    _direction: []const u8,
    _position: usize = 0,
    _ended: bool = false,

    pub fn getKey(self: *const IDBCursor, frame: *Frame) ?js.Value {
        if (self._ended or self._position >= self._entries.len) return null;
        return self._entries[self._position].key.local(frame.js.local.?);
    }

    pub fn getPrimaryKey(self: *const IDBCursor, frame: *Frame) ?js.Value {
        if (self._ended or self._position >= self._entries.len) return null;
        return self._entries[self._position].record.key.local(frame.js.local.?);
    }

    pub fn getValue(self: *const IDBCursor, frame: *Frame) ?js.Value {
        if (self._ended or self._position >= self._entries.len) return null;
        return self._entries[self._position].record.value.local(frame.js.local.?);
    }

    pub fn getDirection(self: *const IDBCursor) []const u8 {
        return self._direction;
    }

    fn schedule(self: *IDBCursor) !void {
        try self._frame.js.scheduler.add(self, step, 0, .{
            .name = "IndexedDB cursor step",
            .low_priority = false,
        });
    }

    fn step(ptr: *anyopaque) anyerror!?u32 {
        const self: *IDBCursor = @ptrCast(@alignCast(ptr));
        var scope: js.Local.Scope = undefined;
        self._frame.js.localScope(&scope);
        defer scope.deinit();
        if (self._position >= self._entries.len) {
            self._ended = true;
            try self._request.succeed(try scope.local.zigValueToJs(js.Undefined{}, .{}));
        } else {
            try self._request.succeed(try scope.local.zigValueToJs(self, .{}));
        }
        return null;
    }

    pub fn continueCursor(self: *IDBCursor, _: ?js.Value) !void {
        if (self._ended) return error.InvalidStateError;
        self._position += 1;
        try self.schedule();
    }

    pub fn advance(self: *IDBCursor, count: u32) !void {
        if (self._ended or count == 0) return error.TypeError;
        self._position += count;
        try self.schedule();
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(IDBCursor);
        pub const Meta = struct {
            pub const name = "IDBCursor";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
        };
        pub const key = bridge.accessor(IDBCursor.getKey, null, .{});
        pub const primaryKey = bridge.accessor(IDBCursor.getPrimaryKey, null, .{});
        pub const value = bridge.accessor(IDBCursor.getValue, null, .{});
        pub const direction = bridge.accessor(IDBCursor.getDirection, null, .{});
        pub const @"continue" = bridge.function(IDBCursor.continueCursor, .{ .js_name = "continue" });
        pub const advance = bridge.function(IDBCursor.advance, .{});
    };
};

pub const IDBIndex = struct {
    _frame: *Frame,
    _transaction: *IDBTransaction,
    _store: *StoreData,
    _data: *IndexData,

    pub fn getName(self: *const IDBIndex) []const u8 {
        return self._data.name;
    }

    pub fn getKeyPath(self: *const IDBIndex) []const u8 {
        return self._data.key_path;
    }

    pub fn getUnique(self: *const IDBIndex) bool {
        return self._data.unique;
    }

    pub fn getMultiEntry(self: *const IDBIndex) bool {
        return self._data.multi_entry;
    }

    pub fn getObjectStore(self: *IDBIndex, frame: *Frame) !*IDBObjectStore {
        return frame._factory.create(IDBObjectStore{
            ._frame = frame,
            ._transaction = self._transaction,
            ._data = self._store,
        });
    }

    const IndexRead = struct {
        request: *IDBRequest,
        index: *IDBIndex,
        query: Query,
        limit: ?u32,
        keys_only: bool,
        count_only: bool = false,

        fn run(ptr: *anyopaque) anyerror!?u32 {
            const self: *IndexRead = @ptrCast(@alignCast(ptr));
            errdefer self.index._transaction.requestFinished() catch {};
            var scope: js.Local.Scope = undefined;
            self.index._frame.js.localScope(&scope);
            defer scope.deinit();

            var entries = try self.collect(&scope.local);
            defer self.index._frame._page.frame_arena.free(entries);
            if (self.count_only) {
                try self.request.succeed(try scope.local.zigValueToJs(entries.len, .{}));
            } else {
                const max = self.limit orelse std.math.maxInt(u32);
                const entry_count = @min(entries.len, @as(usize, max));
                const result = scope.local.newArray(@intCast(entry_count));
                for (entries[0..entry_count], 0..) |entry, i| {
                    const value = if (self.keys_only) entry.record.key.local(&scope.local) else entry.record.value.local(&scope.local);
                    _ = try result.set(@intCast(i), value, .{});
                }
                try self.request.succeed(result.toValue());
            }
            try self.index._transaction.requestFinished();
            return null;
        }

        fn collect(self: *const IndexRead, local: *const js.Local) ![]CursorEntry {
            var entries: std.ArrayListUnmanaged(CursorEntry) = .empty;
            var records = self.index._store.records.valueIterator();
            while (records.next()) |record| {
                const value = record.value.local(local);
                const index_value = (try pathValue(value, self.index._data.key_path)) orelse continue;
                if (self.index._data.multi_entry and index_value.isArray()) {
                    const array = index_value.toArray();
                    for (0..array.len()) |i| {
                        const item = try array.get(@intCast(i));
                        if (!queryMatches(self.query, item)) continue;
                        try entries.append(self.index._frame._page.frame_arena, .{
                            .record = record,
                            .key = try (try item.structuredClone()).persist(),
                        });
                    }
                } else if (queryMatches(self.query, index_value)) {
                    try entries.append(self.index._frame._page.frame_arena, .{
                        .record = record,
                        .key = try (try index_value.structuredClone()).persist(),
                    });
                }
            }
            sortEntries(local, entries.items, false);
            return entries.toOwnedSlice(self.index._frame._page.frame_arena);
        }
    };

    fn read(self: *IDBIndex, query: ?js.Value, limit: ?u32, keys_only: bool, count_only: bool) !*IDBRequest {
        if (!self._transaction._active) return error.TransactionInactiveError;
        const request = try self._frame._factory.eventTarget(IDBRequest{
            ._proto = undefined,
            ._frame = self._frame,
        });
        self._transaction.requestStarted();
        errdefer {
            if (self._transaction._pending_requests > 0) self._transaction._pending_requests -= 1;
        }
        const callback = try self._frame._factory.create(IndexRead{
            .request = request,
            .index = self,
            .query = try queryFromValue(query),
            .limit = limit,
            .keys_only = keys_only,
            .count_only = count_only,
        });
        try self._frame.js.scheduler.add(callback, IndexRead.run, 0, .{
            .name = "IndexedDB index request",
            .low_priority = false,
        });
        return request;
    }

    pub fn get(self: *IDBIndex, query: js.Value) !*IDBRequest {
        return self.read(query, 1, false, false);
    }

    pub fn getKey(self: *IDBIndex, query: js.Value) !*IDBRequest {
        return self.read(query, 1, true, false);
    }

    pub fn getAll(self: *IDBIndex, query: ?js.Value, limit: ?u32) !*IDBRequest {
        return self.read(query, limit, false, false);
    }

    pub fn getAllKeys(self: *IDBIndex, query: ?js.Value, limit: ?u32) !*IDBRequest {
        return self.read(query, limit, true, false);
    }

    pub fn count(self: *IDBIndex, query: ?js.Value) !*IDBRequest {
        return self.read(query, null, true, true);
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(IDBIndex);
        pub const Meta = struct {
            pub const name = "IDBIndex";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
        };
        pub const name = bridge.accessor(IDBIndex.getName, null, .{});
        pub const keyPath = bridge.accessor(IDBIndex.getKeyPath, null, .{});
        pub const unique = bridge.accessor(IDBIndex.getUnique, null, .{});
        pub const multiEntry = bridge.accessor(IDBIndex.getMultiEntry, null, .{});
        pub const objectStore = bridge.accessor(IDBIndex.getObjectStore, null, .{});
        pub const get = bridge.function(IDBIndex.get, .{});
        pub const getKey = bridge.function(IDBIndex.getKey, .{});
        pub const getAll = bridge.function(IDBIndex.getAll, .{});
        pub const getAllKeys = bridge.function(IDBIndex.getAllKeys, .{});
        pub const count = bridge.function(IDBIndex.count, .{});
    };
};

pub const IDBObjectStore = struct {
    _frame: *Frame,
    _transaction: ?*IDBTransaction,
    _data: *StoreData,

    pub fn getName(self: *const IDBObjectStore) []const u8 {
        return self._data.name;
    }

    /// The transaction that owns this object store.
    ///
    /// IndexedDB exposes this as a read-only property on every
    /// IDBObjectStore.  In particular, callers commonly use it to attach
    /// `oncomplete`/`onerror` handlers after issuing a request.  Keeping the
    /// native transaction pointer on the store is also what preserves object
    /// identity (`store.transaction === transaction`) across the JS bridge.
    pub fn getTransaction(self: *const IDBObjectStore) ?*IDBTransaction {
        return self._transaction;
    }

    pub fn indexNames(self: *const IDBObjectStore, frame: *Frame) !*DOMStringList {
        return frame._factory.create(DOMStringList{ ._store = self._data });
    }

    fn request(self: *IDBObjectStore) !*IDBRequest {
        return self._frame._factory.eventTarget(IDBRequest{
            ._proto = undefined,
            ._frame = self._frame,
        });
    }

    fn keyString(self: *IDBObjectStore, key: js.Value) ![]const u8 {
        if (key.isNullOrUndefined() or key.isObject() and !key.isArray()) return error.DataError;
        return key.toJson(self._frame._page.frame_arena);
    }

    fn resolveKey(self: *IDBObjectStore, value: js.Value, explicit_key: ?js.Value) !js.Value {
        if (explicit_key) |key| {
            if (self._data.key_path != null) return error.DataError;
            _ = try self.keyString(key);
            return key;
        }
        if (self._data.key_path) |key_path| {
            return (try valueForKeyPath(value, key_path)) orelse return error.DataError;
        }
        if (self._data.auto_increment) {
            const key = try self._frame.js.local.?.zigValueToJs(self._data.next_key, .{});
            self._data.next_key += 1;
            return key;
        }
        return error.DataError;
    }

    fn hasPendingKey(self: *IDBObjectStore, key_text: []const u8) bool {
        const transaction = self._transaction orelse return false;
        var i = transaction._mutations.items.len;
        while (i > 0) {
            i -= 1;
            switch (transaction._mutations.items[i]) {
                .put => |pending_put| if (pending_put.store == self._data and std.mem.eql(u8, pending_put.key_text, key_text)) return true,
                .delete => |removed| if (removed.store == self._data and std.mem.eql(u8, removed.key_text, key_text)) return false,
                .clear => |store| if (store == self._data) return false,
            }
        }
        return false;
    }

    fn putResolved(self: *IDBObjectStore, value: js.Value, resolved_key: js.Value) !*IDBRequest {
        const transaction = self._transaction orelse return error.TransactionInactiveError;
        if (!transaction._active or std.mem.eql(u8, transaction._mode, "readonly")) return error.ReadOnlyError;
        const request_ = try self.request();
        const key_text = try self.keyString(resolved_key);
        const cloned_key = try (try resolved_key.structuredClone()).persist();
        const cloned_value = try (try value.structuredClone()).persist();
        try transaction.queuePut(self._data, key_text, cloned_key, cloned_value);
        try self.scheduleSuccess(request_, resolved_key);
        return request_;
    }

    pub fn put(self: *IDBObjectStore, value: js.Value, key: ?js.Value) !*IDBRequest {
        return self.putResolved(value, try self.resolveKey(value, key));
    }

    pub fn add(self: *IDBObjectStore, value: js.Value, key: ?js.Value) !*IDBRequest {
        const resolved_key = try self.resolveKey(value, key);
        const key_text = try self.keyString(resolved_key);
        if (self._data.records.contains(key_text) or self.hasPendingKey(key_text)) return error.ConstraintError;
        return self.putResolved(value, resolved_key);
    }

    pub fn createIndex(self: *IDBObjectStore, name: []const u8, key_path: js.Value, options: ?js.Value, frame: *Frame) !*IDBIndex {
        const transaction = self._transaction orelse return error.TransactionInactiveError;
        if (!transaction._active or !std.mem.eql(u8, transaction._mode, "versionchange")) return error.InvalidStateError;
        const path = key_path.isString() orelse return error.InvalidArgument;
        const arena = frame._page.frame_arena;
        const owned_name = try arena.dupe(u8, name);
        const owned_path = try arena.dupe(u8, try path.toSlice());
        if (self._data.indexes.contains(owned_name)) return error.ConstraintError;
        const index_data = try arena.create(IndexData);
        index_data.* = .{ .name = owned_name, .key_path = owned_path };
        if (options) |opts| {
            if (optionalProperty(opts, "unique")) |unique| index_data.unique = unique.toBool();
            if (optionalProperty(opts, "multiEntry")) |multi_entry| index_data.multi_entry = multi_entry.toBool();
        }
        try self._data.indexes.put(arena, owned_name, index_data);
        return frame._factory.create(IDBIndex{
            ._frame = frame,
            ._transaction = transaction,
            ._store = self._data,
            ._data = index_data,
        });
    }

    pub fn index(self: *IDBObjectStore, name: []const u8, frame: *Frame) !*IDBIndex {
        const transaction = self._transaction orelse return error.TransactionInactiveError;
        if (!transaction._active) return error.TransactionInactiveError;
        const index_data = self._data.indexes.get(name) orelse return error.NotFoundError;
        return frame._factory.create(IDBIndex{
            ._frame = frame,
            ._transaction = transaction,
            ._store = self._data,
            ._data = index_data,
        });
    }

    pub fn get(self: *IDBObjectStore, key: js.Value) !*IDBRequest {
        const transaction = self._transaction orelse return error.TransactionInactiveError;
        if (!transaction._active) return error.TransactionInactiveError;
        const request_ = try self.request();
        const key_text = try self.keyString(key);
        if (self._data.records.get(key_text)) |record| {
            try self.scheduleSuccess(request_, record.value.local(self._frame.js.local.?));
        } else {
            try self.scheduleSuccess(request_, try self._frame.js.local.?.zigValueToJs(js.Undefined{}, .{}));
        }
        return request_;
    }

    pub fn delete(self: *IDBObjectStore, key: js.Value) !*IDBRequest {
        const transaction = self._transaction orelse return error.TransactionInactiveError;
        if (!transaction._active or std.mem.eql(u8, transaction._mode, "readonly")) return error.ReadOnlyError;
        const request_ = try self.request();
        try transaction.queueDelete(self._data, try self.keyString(key));
        try self.scheduleSuccess(request_, try self._frame.js.local.?.zigValueToJs(js.Undefined{}, .{}));
        return request_;
    }

    pub fn clear(self: *IDBObjectStore) !*IDBRequest {
        const transaction = self._transaction orelse return error.TransactionInactiveError;
        if (!transaction._active or std.mem.eql(u8, transaction._mode, "readonly")) return error.ReadOnlyError;
        const request_ = try self.request();
        try transaction.queueClear(self._data);
        try self.scheduleSuccess(request_, try self._frame.js.local.?.zigValueToJs(js.Undefined{}, .{}));
        return request_;
    }

    pub fn count(self: *IDBObjectStore, query: ?js.Value, frame: *Frame) !*IDBRequest {
        const normalized_query = try queryFromValue(query);
        const request_ = try self.request();
        var total: usize = 0;
        var records = self._data.records.valueIterator();
        while (records.next()) |record| {
            if (queryMatches(normalized_query, record.key.local(frame.js.local.?))) total += 1;
        }
        try self.scheduleSuccess(request_, try frame.js.local.?.zigValueToJs(total, .{}));
        return request_;
    }

    pub fn getAllKeys(self: *IDBObjectStore, query: ?js.Value, limit: ?u32) !*IDBRequest {
        return self.scheduleRead(try self.request(), try queryFromValue(query), limit, true);
    }

    pub fn getAll(self: *IDBObjectStore, query: ?js.Value, limit: ?u32) !*IDBRequest {
        return self.scheduleRead(try self.request(), try queryFromValue(query), limit, false);
    }

    const ReadAll = struct {
        request: *IDBRequest,
        store: *StoreData,
        transaction: ?*IDBTransaction,
        query: Query,
        limit: ?u32,
        keys_only: bool,

        fn run(ptr: *anyopaque) anyerror!?u32 {
            const self: *ReadAll = @ptrCast(@alignCast(ptr));
            errdefer if (self.transaction) |transaction| transaction.requestFinished() catch {};
            var scope: js.Local.Scope = undefined;
            self.request._frame.js.localScope(&scope);
            defer scope.deinit();
            try self.request.succeed(try self.fill(&scope.local));
            if (self.transaction) |transaction| try transaction.requestFinished();
            return null;
        }

        /// Build the result when the request runs, then let `succeed` clone it
        /// once. The calling script does not walk or copy the store.
        fn fill(self: *const ReadAll, local: *const js.Local) !js.Value {
            const max = self.limit orelse std.math.maxInt(u32);
            if (max == 0) return local.newArray(0).toValue();
            var entries: std.ArrayListUnmanaged(CursorEntry) = .empty;
            var records = self.store.records.valueIterator();
            while (records.next()) |record| {
                if (queryMatches(self.query, record.key.local(local))) {
                    try entries.append(self.request._frame._page.frame_arena, .{ .record = record, .key = record.key });
                }
            }
            sortEntries(local, entries.items, false);
            const entry_count: u32 = @intCast(@min(entries.items.len, @as(usize, max)));
            const array = local.newArray(entry_count);
            for (entries.items[0..entry_count], 0..) |entry, i| {
                const source = if (self.keys_only) entry.record.key else entry.record.value;
                _ = try array.set(@intCast(i), source.local(local), .{});
            }
            return array.toValue();
        }
    };

    fn scheduleRead(self: *IDBObjectStore, request_: *IDBRequest, query: Query, limit: ?u32, keys_only: bool) !*IDBRequest {
        if (self._transaction) |transaction| transaction.requestStarted();
        errdefer if (self._transaction) |transaction| {
            if (transaction._pending_requests > 0) transaction._pending_requests -= 1;
        };
        const callback = try self._frame._factory.create(ReadAll{
            .request = request_,
            .store = self._data,
            .transaction = self._transaction,
            .query = query,
            .limit = limit,
            .keys_only = keys_only,
        });
        try self._frame.js.scheduler.add(callback, ReadAll.run, 0, .{
            .name = "IndexedDB request",
            .low_priority = false,
        });
        return request_;
    }

    pub fn openCursor(self: *IDBObjectStore, query: ?js.Value, direction: ?[]const u8, frame: *Frame) !*IDBRequest {
        const transaction = self._transaction orelse return error.TransactionInactiveError;
        if (!transaction._active) return error.TransactionInactiveError;
        const normalized_query = try queryFromValue(query);
        const cursor_request = try self.request();
        var entries: std.ArrayListUnmanaged(CursorEntry) = .empty;
        var records = self._data.records.valueIterator();
        while (records.next()) |record| {
            if (queryMatches(normalized_query, record.key.local(frame.js.local.?))) {
                try entries.append(frame._page.frame_arena, .{ .record = record, .key = record.key });
            }
        }
        const reverse = if (direction) |value| std.mem.eql(u8, value, "prev") or std.mem.eql(u8, value, "prevunique") else false;
        sortEntries(frame.js.local.?, entries.items, reverse);
        const cursor = try frame._factory.create(IDBCursor{
            ._frame = frame,
            ._request = cursor_request,
            ._transaction = transaction,
            ._entries = try entries.toOwnedSlice(frame._page.frame_arena),
            ._direction = try frame._page.frame_arena.dupe(u8, direction orelse "next"),
        });
        transaction.requestStarted();
        try cursor.schedule();
        return cursor_request;
    }

    const Success = struct {
        request: *IDBRequest,
        value: js.Value.Global,
        transaction: ?*IDBTransaction,
        fn run(ptr: *anyopaque) anyerror!?u32 {
            const self: *Success = @ptrCast(@alignCast(ptr));
            var scope: js.Local.Scope = undefined;
            self.request._frame.js.localScope(&scope);
            defer scope.deinit();
            try self.request.succeed(self.value.local(&scope.local));
            if (self.transaction) |transaction| try transaction.requestFinished();
            return null;
        }
    };

    fn scheduleSuccess(self: *IDBObjectStore, request_: *IDBRequest, value: js.Value) !void {
        if (self._transaction) |transaction| transaction.requestStarted();
        errdefer if (self._transaction) |transaction| {
            if (transaction._pending_requests > 0) transaction._pending_requests -= 1;
        };
        const callback = try self._frame._factory.create(Success{
            .request = request_,
            .value = try (try value.structuredClone()).persist(),
            .transaction = self._transaction,
        });
        try self._frame.js.scheduler.add(callback, Success.run, 0, .{
            .name = "IndexedDB request",
            .low_priority = false,
        });
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(IDBObjectStore);
        pub const Meta = struct {
            pub const name = "IDBObjectStore";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
        };
        pub const name = bridge.accessor(IDBObjectStore.getName, null, .{});
        pub const transaction = bridge.accessor(IDBObjectStore.getTransaction, null, .{});
        pub const indexNames = bridge.accessor(IDBObjectStore.indexNames, null, .{});
        pub const put = bridge.function(IDBObjectStore.put, .{});
        pub const add = bridge.function(IDBObjectStore.add, .{});
        pub const createIndex = bridge.function(IDBObjectStore.createIndex, .{});
        pub const index = bridge.function(IDBObjectStore.index, .{});
        pub const get = bridge.function(IDBObjectStore.get, .{});
        pub const delete = bridge.function(IDBObjectStore.delete, .{});
        pub const clear = bridge.function(IDBObjectStore.clear, .{});
        pub const count = bridge.function(IDBObjectStore.count, .{});
        pub const getAllKeys = bridge.function(IDBObjectStore.getAllKeys, .{});
        pub const getAll = bridge.function(IDBObjectStore.getAll, .{});
        pub const openCursor = bridge.function(IDBObjectStore.openCursor, .{});
    };
};

pub const IDBFactory = struct {
    _databases: std.StringHashMapUnmanaged(*DatabaseData) = .empty,

    pub const Snapshot = struct {
        name: []const u8,
        version: u32,
        object_store_count: usize,
        record_count: usize,
    };

    /// Returns metadata only. IndexedDB record values deliberately stay in
    /// the browser runtime and are never copied to durable observability logs.
    pub fn appendSnapshot(self: *const IDBFactory, entries: *std.ArrayListUnmanaged(Snapshot), allocator: std.mem.Allocator) !void {
        var database_iterator = self._databases.valueIterator();
        while (database_iterator.next()) |database| {
            var record_count: usize = 0;
            var stores = database.*.stores.valueIterator();
            while (stores.next()) |store| record_count += store.*.records.count();
            try entries.append(allocator, .{
                .name = database.*.name,
                .version = database.*.version,
                .object_store_count = database.*.stores.count(),
                .record_count = record_count,
            });
        }
    }

    pub fn open(self: *IDBFactory, name: []const u8, version: ?u32, frame: *Frame) !*IDBOpenDBRequest {
        const owned_name = try frame._page.frame_arena.dupe(u8, name);
        const request = try frame._factory.eventTarget(IDBOpenDBRequest{
            ._proto = undefined,
            ._frame = frame,
            ._factory = self,
            ._name = owned_name,
            ._requested_version = version,
        });
        try frame.js.scheduler.add(request, IDBOpenDBRequest.run, 0, .{
            .name = "IndexedDB.open",
            .low_priority = false,
            .finalizer = IDBOpenDBRequest.cancelled,
        });
        request._task_owner = frame.js.execution.captureTaskOwner();
        return request;
    }

    pub fn deleteDatabase(self: *IDBFactory, name: []const u8, frame: *Frame) !*IDBOpenDBRequest {
        _ = self._databases.remove(name);
        const request = try frame._factory.eventTarget(IDBOpenDBRequest{
            ._proto = undefined,
            ._frame = frame,
            ._factory = self,
            ._name = try frame._page.frame_arena.dupe(u8, name),
            ._requested_version = null,
        });
        request._ready_state = .done;
        return request;
    }

    pub fn databases(self: *IDBFactory, frame: *Frame) !js.Promise {
        const local = frame.js.local orelse return error.NotHandled;
        const array = local.newArray(@intCast(self._databases.count()));
        var it = self._databases.valueIterator();
        var i: u32 = 0;
        while (it.next()) |db| : (i += 1) {
            const obj = local.newObject();
            _ = try obj.set("name", db.*.name, .{});
            _ = try obj.set("version", db.*.version, .{});
            _ = try array.set(i, obj, .{});
        }
        return local.resolvePromise(array);
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(IDBFactory);
        pub const Meta = struct {
            pub const name = "IDBFactory";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
        };
        pub const open = bridge.function(IDBFactory.open, .{});
        pub const deleteDatabase = bridge.function(IDBFactory.deleteDatabase, .{});
        pub const databases = bridge.function(IDBFactory.databases, .{});
    };
};

test "WebApi: IndexedDB request lifecycle and CRUD" {
    const testing = @import("../../testing/testing.zig");
    try testing.htmlRunner("indexeddb.html", .{});
}
