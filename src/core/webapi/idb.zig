// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

const js = @import("../js/js.zig");
const Frame = @import("../browser/Frame.zig");

pub fn registerTypes() []const type {
    return &.{
        IDBFactory,
        IDBDatabase,
        IDBObjectStore,
        IDBTransaction,
    };
}

pub const IDBObjectStore = struct {
    _pad: bool = false,
    _name: []const u8 = "",

    pub const JsApi = struct {
        pub const bridge = js.Bridge(IDBObjectStore);
        pub const Meta = struct {
            pub const name = "IDBObjectStore";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
            pub const empty_with_no_proto = true;
        };
    };
};

pub const IDBTransaction = struct {
    _pad: bool = false,

    pub const JsApi = struct {
        pub const bridge = js.Bridge(IDBTransaction);
        pub const Meta = struct {
            pub const name = "IDBTransaction";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
            pub const empty_with_no_proto = true;
        };
    };
};

pub const IDBDatabase = struct {
    _name: []const u8,
    _version: u32,

    pub fn getName(self: *const IDBDatabase) []const u8 {
        return self._name;
    }

    pub fn getVersion(self: *const IDBDatabase) u32 {
        return self._version;
    }

    pub fn objectStoreNames(_: *const IDBDatabase, frame: *Frame) !js.Value {
        const local = frame.js.local orelse return error.NotHandled;
        return local.newArray(0).toValue();
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
        pub const objectStoreNames = bridge.function(IDBDatabase.objectStoreNames, .{});
    };
};

pub const IDBFactory = struct {
    _pad: bool = false,

    pub fn open(self: *const IDBFactory, name: []const u8, version: ?u32, frame: *Frame) !js.Promise {
        _ = self;
        const local = frame.js.local orelse return error.NotHandled;
        const db = try frame._factory.create(IDBDatabase{
            ._name = name,
            ._version = version orelse 1,
        });
        return local.resolvePromise(db);
    }

    pub fn deleteDatabase(self: *const IDBFactory, _: []const u8, frame: *Frame) !js.Promise {
        _ = self;
        const local = frame.js.local orelse return error.NotHandled;
        return local.resolvePromise(js.Undefined{});
    }

    pub fn databases(self: *const IDBFactory, frame: *Frame) !js.Promise {
        _ = self;
        const local = frame.js.local orelse return error.NotHandled;
        return local.resolvePromise(local.newArray(0));
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(IDBFactory);
        pub const Meta = struct {
            pub const name = "IDBFactory";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
            pub const empty_with_no_proto = true;
        };
        pub const open = bridge.function(IDBFactory.open, .{});
        pub const deleteDatabase = bridge.function(IDBFactory.deleteDatabase, .{});
        pub const databases = bridge.function(IDBFactory.databases, .{});
    };
};
