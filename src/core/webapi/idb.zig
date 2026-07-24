// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 or any later version.

const std = @import("std");
const js = @import("../js/js.zig");
const Frame = @import("../browser/Frame.zig");
const EventTarget = @import("EventTarget.zig");
const Event = @import("Event.zig");

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
        IDBTransaction,
    };
}

const Record = struct {
    key: js.Value.Global,
    value: js.Value.Global,
};

const StoreData = struct {
    name: []const u8,
    records: std.StringHashMapUnmanaged(Record) = .empty,
};

const DatabaseData = struct {
    name: []const u8,
    version: u32,
    stores: std.StringHashMapUnmanaged(*StoreData) = .empty,
};

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

    fn succeed(self: *IDBRequest, value: js.Value) !void {
        self._result = try (try value.structuredClone()).persist();
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
        const arena = self._frame._page.frame_arena;
        const gop = try self._factory._databases.getOrPut(arena, self._name);
        const created = !gop.found_existing;
        if (created) {
            const db_data = try arena.create(DatabaseData);
            db_data.* = .{
                .name = self._name,
                .version = self._requested_version orelse 1,
            };
            gop.value_ptr.* = db_data;
        }
        const data = gop.value_ptr.*;
        const requested = self._requested_version orelse data.version;
        if (requested < data.version or requested == 0) return error.VersionError;

        const db = try self._frame._factory.create(IDBDatabase{
            ._frame = self._frame,
            ._data = data,
        });
        self._result = db;

        if (created or requested > data.version) {
            data.version = requested;
            const txn = try self._frame._factory.eventTarget(IDBTransaction{
                ._proto = undefined,
                ._frame = self._frame,
                ._database = db,
                ._mode = "versionchange",
                ._active = true,
            });
            self._transaction = txn;
            const event = try Event.init("upgradeneeded", .{}, self._frame._page);
            try self._frame._event_manager.dispatchDirect(self._proto, event, self._on_upgrade_needed, .{
                .context = "IDBOpenDBRequest.upgradeneeded",
            });
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

    pub fn getName(self: *const IDBDatabase) []const u8 {
        return self._data.name;
    }
    pub fn getVersion(self: *const IDBDatabase) u32 {
        return self._data.version;
    }

    pub fn objectStoreNames(self: *IDBDatabase, frame: *Frame) !*DOMStringList {
        return frame._factory.create(DOMStringList{ ._database = self });
    }

    pub fn createObjectStore(self: *IDBDatabase, name: []const u8, frame: *Frame) !*IDBObjectStore {
        const arena = frame._page.frame_arena;
        const owned_name = try arena.dupe(u8, name);
        const gop = try self._data.stores.getOrPut(arena, owned_name);
        if (gop.found_existing) return error.ConstraintError;
        const data = try arena.create(StoreData);
        data.* = .{ .name = owned_name };
        gop.value_ptr.* = data;
        return frame._factory.create(IDBObjectStore{
            ._frame = frame,
            ._transaction = null,
            ._data = data,
        });
    }

    pub fn deleteObjectStore(self: *IDBDatabase, name: []const u8) !void {
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
    };
};

// The IndexedDB name lists use the legacy DOMStringList Web IDL interface,
// not Array. Keep this as a live view so schema changes made during an upgrade
// are immediately observable through an already-retrieved list.
pub const DOMStringList = struct {
    _database: *IDBDatabase,

    pub fn getLength(self: *const DOMStringList) u32 {
        return @intCast(self._database._data.stores.count());
    }

    pub fn contains(self: *const DOMStringList, name: []const u8) bool {
        return self._database._data.stores.contains(name);
    }

    pub fn item(self: *const DOMStringList, index: u32) ?[]const u8 {
        var it = self._database._data.stores.keyIterator();
        var current: u32 = 0;
        while (it.next()) |name| : (current += 1) {
            if (current == index) return name.*;
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
        self._active = false;
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

pub const IDBObjectStore = struct {
    _frame: *Frame,
    _transaction: ?*IDBTransaction,
    _data: *StoreData,

    pub fn getName(self: *const IDBObjectStore) []const u8 {
        return self._data.name;
    }

    fn request(self: *IDBObjectStore) !*IDBRequest {
        return self._frame._factory.eventTarget(IDBRequest{
            ._proto = undefined,
            ._frame = self._frame,
        });
    }

    fn keyString(self: *IDBObjectStore, key: js.Value) ![]const u8 {
        return key.toStringSliceWithAlloc(self._frame._page.frame_arena);
    }

    pub fn put(self: *IDBObjectStore, value: js.Value, key: js.Value) !*IDBRequest {
        const request_ = try self.request();
        const key_text = try self.keyString(key);
        const cloned_key = try (try key.structuredClone()).persist();
        const cloned_value = try (try value.structuredClone()).persist();
        try self._data.records.put(self._frame._page.frame_arena, key_text, .{
            .key = cloned_key,
            .value = cloned_value,
        });
        try self.scheduleSuccess(request_, key);
        return request_;
    }

    pub fn add(self: *IDBObjectStore, value: js.Value, key: js.Value) !*IDBRequest {
        const key_text = try self.keyString(key);
        if (self._data.records.contains(key_text)) return error.ConstraintError;
        return self.put(value, key);
    }

    pub fn get(self: *IDBObjectStore, key: js.Value) !*IDBRequest {
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
        const request_ = try self.request();
        _ = self._data.records.remove(try self.keyString(key));
        try self.scheduleSuccess(request_, try self._frame.js.local.?.zigValueToJs(js.Undefined{}, .{}));
        return request_;
    }

    pub fn clear(self: *IDBObjectStore) !*IDBRequest {
        const request_ = try self.request();
        self._data.records.clearRetainingCapacity();
        try self.scheduleSuccess(request_, try self._frame.js.local.?.zigValueToJs(js.Undefined{}, .{}));
        return request_;
    }

    pub fn count(self: *IDBObjectStore, frame: *Frame) !*IDBRequest {
        const request_ = try self.request();
        try self.scheduleSuccess(request_, try frame.js.local.?.zigValueToJs(self._data.records.count(), .{}));
        return request_;
    }

    const Success = struct {
        request: *IDBRequest,
        value: js.Value.Global,
        fn run(ptr: *anyopaque) anyerror!?u32 {
            const self: *Success = @ptrCast(@alignCast(ptr));
            var scope: js.Local.Scope = undefined;
            self.request._frame.js.localScope(&scope);
            defer scope.deinit();
            try self.request.succeed(self.value.local(&scope.local));
            return null;
        }
    };

    fn scheduleSuccess(self: *IDBObjectStore, request_: *IDBRequest, value: js.Value) !void {
        const callback = try self._frame._factory.create(Success{
            .request = request_,
            .value = try (try value.structuredClone()).persist(),
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
        pub const put = bridge.function(IDBObjectStore.put, .{});
        pub const add = bridge.function(IDBObjectStore.add, .{});
        pub const get = bridge.function(IDBObjectStore.get, .{});
        pub const delete = bridge.function(IDBObjectStore.delete, .{});
        pub const clear = bridge.function(IDBObjectStore.clear, .{});
        pub const count = bridge.function(IDBObjectStore.count, .{});
    };
};

pub const IDBFactory = struct {
    _databases: std.StringHashMapUnmanaged(*DatabaseData) = .empty,

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
        });
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
