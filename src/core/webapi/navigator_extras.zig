// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

const js = @import("../js/js.zig");
const Frame = @import("../browser/Frame.zig");

pub fn registerTypes() []const type {
    return &.{
        MediaDevices,
        Clipboard,
        CredentialsContainer,
        Bluetooth,
        GPU,
        USB,
        Serial,
        HID,
        Keyboard,
        LockManager,
        WakeLock,
        ContactsManager,
        ServiceWorkerContainer,
    };
}

fn emptyInterface(comptime interface_name: []const u8) type {
    return struct {
        const Outer = @This();
        _pad: bool = false,
        pub const JsApi = struct {
            pub const bridge = js.Bridge(Outer);
            pub const Meta = struct {
                pub const name = interface_name;
                pub const prototype_chain = bridge.prototypeChain();
                pub var class_id: bridge.ClassId = undefined;
                pub const empty_with_no_proto = true;
            };
        };
    };
}

pub const Bluetooth = emptyInterface("Bluetooth");
pub const GPU = emptyInterface("GPU");
pub const USB = emptyInterface("USB");
pub const Serial = emptyInterface("Serial");
pub const HID = emptyInterface("HID");
pub const Keyboard = emptyInterface("Keyboard");
pub const MediaDevices = struct {
    _pad: bool = false,

    pub fn enumerateDevices(self: *const MediaDevices, frame: *Frame) !js.Promise {
        _ = self;
        const local = frame.js.local orelse return error.NotHandled;
        return local.resolvePromise(local.newArray(0));
    }

    pub fn getUserMedia(self: *const MediaDevices, _: js.Value, frame: *Frame) !js.Promise {
        _ = self;
        const local = frame.js.local orelse return error.NotHandled;
        return local.rejectPromise(.{ .dom_exception = .{ .err = error.SecurityError } });
    }

    pub fn getDisplayMedia(self: *const MediaDevices, _: js.Value, frame: *Frame) !js.Promise {
        _ = self;
        const local = frame.js.local orelse return error.NotHandled;
        return local.rejectPromise(.{ .dom_exception = .{ .err = error.SecurityError } });
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(MediaDevices);
        pub const Meta = struct {
            pub const name = "MediaDevices";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
            pub const empty_with_no_proto = true;
        };
        pub const enumerateDevices = bridge.function(MediaDevices.enumerateDevices, .{});
        pub const getUserMedia = bridge.function(MediaDevices.getUserMedia, .{ .dom_exception = true });
        pub const getDisplayMedia = bridge.function(MediaDevices.getDisplayMedia, .{ .dom_exception = true });
    };
};

pub const Clipboard = struct {
    _pad: bool = false,

    pub fn readText(self: *const Clipboard, frame: *Frame) !js.Promise {
        _ = self;
        const local = frame.js.local orelse return error.NotHandled;
        return local.resolvePromise(local.newString(""));
    }

    pub fn writeText(self: *const Clipboard, _: []const u8, frame: *Frame) !js.Promise {
        _ = self;
        const local = frame.js.local orelse return error.NotHandled;
        return local.resolvePromise(js.Undefined{});
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(Clipboard);
        pub const Meta = struct {
            pub const name = "Clipboard";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
            pub const empty_with_no_proto = true;
        };
        pub const readText = bridge.function(Clipboard.readText, .{});
        pub const writeText = bridge.function(Clipboard.writeText, .{});
    };
};

pub const CredentialsContainer = struct {
    _pad: bool = false,

    pub fn get(self: *const CredentialsContainer, frame: *Frame) !js.Promise {
        _ = self;
        const local = frame.js.local orelse return error.NotHandled;
        return local.resolvePromise(null);
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(CredentialsContainer);
        pub const Meta = struct {
            pub const name = "CredentialsContainer";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
            pub const empty_with_no_proto = true;
        };
        pub const get = bridge.function(CredentialsContainer.get, .{});
    };
};

pub const LockManager = struct {
    _pad: bool = false,

    pub fn request(self: *const LockManager, _: []const u8, frame: *Frame) !js.Promise {
        _ = self;
        const local = frame.js.local orelse return error.NotHandled;
        const obj = local.newObject();
        return local.resolvePromise(obj);
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(LockManager);
        pub const Meta = struct {
            pub const name = "LockManager";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
            pub const empty_with_no_proto = true;
        };
        pub const request = bridge.function(LockManager.request, .{});
    };
};

pub const WakeLock = struct {
    _pad: bool = false,

    pub fn request(self: *const WakeLock, _: []const u8, frame: *Frame) !js.Promise {
        _ = self;
        const local = frame.js.local orelse return error.NotHandled;
        return local.rejectPromise(.{ .dom_exception = .{ .err = error.SecurityError } });
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(WakeLock);
        pub const Meta = struct {
            pub const name = "WakeLock";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
            pub const empty_with_no_proto = true;
        };
        pub const request = bridge.function(WakeLock.request, .{ .dom_exception = true });
    };
};

pub const ContactsManager = struct {
    _pad: bool = false,

    pub fn select(self: *const ContactsManager, frame: *Frame) !js.Promise {
        _ = self;
        const local = frame.js.local orelse return error.NotHandled;
        return local.rejectPromise(.{ .dom_exception = .{ .err = error.SecurityError } });
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(ContactsManager);
        pub const Meta = struct {
            pub const name = "ContactsManager";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
            pub const empty_with_no_proto = true;
        };
        pub const select = bridge.function(ContactsManager.select, .{ .dom_exception = true });
    };
};

pub const ServiceWorkerContainer = struct {
    _pad: bool = false,

    pub fn getRegistration(self: *const ServiceWorkerContainer, frame: *Frame) !js.Promise {
        _ = self;
        const local = frame.js.local orelse return error.NotHandled;
        return local.resolvePromise(js.Undefined{});
    }

    pub fn getRegistrations(self: *const ServiceWorkerContainer, frame: *Frame) !js.Promise {
        _ = self;
        const local = frame.js.local orelse return error.NotHandled;
        return local.resolvePromise(local.newArray(0));
    }

    pub fn register(self: *const ServiceWorkerContainer, _: []const u8, frame: *Frame) !js.Promise {
        _ = self;
        const local = frame.js.local orelse return error.NotHandled;
        return local.rejectPromise(.{ .dom_exception = .{ .err = error.NotSupported } });
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(ServiceWorkerContainer);
        pub const Meta = struct {
            pub const name = "ServiceWorkerContainer";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
            pub const empty_with_no_proto = true;
        };
        pub const getRegistration = bridge.function(ServiceWorkerContainer.getRegistration, .{});
        pub const getRegistrations = bridge.function(ServiceWorkerContainer.getRegistrations, .{});
        pub const register = bridge.function(ServiceWorkerContainer.register, .{ .dom_exception = true });
    };
};
