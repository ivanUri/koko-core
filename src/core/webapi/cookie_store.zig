// Cookie Store API — window.cookieStore singleton for Google Identity / Accounts UI.

const js = @import("../js/js.zig");
const Frame = @import("../browser/Frame.zig");

pub fn registerTypes() []const type {
    return &.{CookieStore};
}

pub const CookieStore = struct {
    _pad: bool = false,

    pub fn get(self: *const CookieStore, _: []const u8, frame: *Frame) !js.Promise {
        _ = self;
        const local = frame.js.local orelse return error.NotHandled;
        return local.resolvePromise(null);
    }

    pub fn set(self: *const CookieStore, _: js.Value, frame: *Frame) !js.Promise {
        _ = self;
        const local = frame.js.local orelse return error.NotHandled;
        return local.resolvePromise(js.Undefined{});
    }

    pub fn delete(self: *const CookieStore, _: []const u8, frame: *Frame) !js.Promise {
        _ = self;
        const local = frame.js.local orelse return error.NotHandled;
        return local.resolvePromise(js.Undefined{});
    }

    pub fn getAll(self: *const CookieStore, frame: *Frame) !js.Promise {
        _ = self;
        const local = frame.js.local orelse return error.NotHandled;
        return local.resolvePromise(local.newArray(0));
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(CookieStore);
        pub const Meta = struct {
            pub const name = "CookieStore";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
            pub const empty_with_no_proto = true;
        };
        pub const get = bridge.function(CookieStore.get, .{});
        pub const set = bridge.function(CookieStore.set, .{});
        pub const delete = bridge.function(CookieStore.delete, .{});
        pub const getAll = bridge.function(CookieStore.getAll, .{});
    };
};
