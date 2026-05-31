// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

const js = @import("../js/js.zig");
const Frame = @import("../browser/Frame.zig");

pub fn registerTypes() []const type {
    return &.{
        TrustedTypePolicyFactory,
        TrustedHTML,
        TrustedScript,
        TrustedScriptURL,
    };
}

pub const TrustedHTML = struct {
    _value: []const u8,

    pub fn toString(self: *const TrustedHTML) []const u8 {
        return self._value;
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(TrustedHTML);
        pub const Meta = struct {
            pub const name = "TrustedHTML";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
        };
        pub const toString = bridge.function(TrustedHTML.toString, .{});
    };
};

pub const TrustedScript = struct {
    _value: []const u8,

    pub fn toString(self: *const TrustedScript) []const u8 {
        return self._value;
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(TrustedScript);
        pub const Meta = struct {
            pub const name = "TrustedScript";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
        };
        pub const toString = bridge.function(TrustedScript.toString, .{});
    };
};

pub const TrustedScriptURL = struct {
    _value: []const u8,

    pub fn toString(self: *const TrustedScriptURL) []const u8 {
        return self._value;
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(TrustedScriptURL);
        pub const Meta = struct {
            pub const name = "TrustedScriptURL";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
        };
        pub const toString = bridge.function(TrustedScriptURL.toString, .{});
    };
};

pub const TrustedTypePolicyFactory = struct {
    _pad: bool = false,

    pub fn createHTML(self: *const TrustedTypePolicyFactory, input: []const u8, frame: *Frame) !*TrustedHTML {
        _ = self;
        return frame._factory.create(TrustedHTML{ ._value = input });
    }

    pub fn createScript(self: *const TrustedTypePolicyFactory, input: []const u8, frame: *Frame) !*TrustedScript {
        _ = self;
        return frame._factory.create(TrustedScript{ ._value = input });
    }

    pub fn createScriptURL(self: *const TrustedTypePolicyFactory, input: []const u8, frame: *Frame) !*TrustedScriptURL {
        _ = self;
        return frame._factory.create(TrustedScriptURL{ ._value = input });
    }

    pub fn getEmptyHTML(self: *const TrustedTypePolicyFactory, frame: *Frame) !*TrustedHTML {
        return self.createHTML("", frame);
    }

    pub fn isHTML(self: *const TrustedTypePolicyFactory, _: js.Value) bool {
        _ = self;
        return false;
    }

    pub fn isScript(self: *const TrustedTypePolicyFactory, _: js.Value) bool {
        _ = self;
        return false;
    }

    pub fn isScriptURL(self: *const TrustedTypePolicyFactory, _: js.Value) bool {
        _ = self;
        return false;
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(TrustedTypePolicyFactory);
        pub const Meta = struct {
            pub const name = "TrustedTypePolicyFactory";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
            pub const empty_with_no_proto = true;
        };
        pub const emptyHTML = bridge.accessor(struct {
            fn get(s: *TrustedTypePolicyFactory, frame: *Frame) !*TrustedHTML {
                return s.getEmptyHTML(frame);
            }
        }.get, null, .{});
        pub const createHTML = bridge.function(TrustedTypePolicyFactory.createHTML, .{});
        pub const createScript = bridge.function(TrustedTypePolicyFactory.createScript, .{});
        pub const createScriptURL = bridge.function(TrustedTypePolicyFactory.createScriptURL, .{});
        pub const isHTML = bridge.function(TrustedTypePolicyFactory.isHTML, .{});
        pub const isScript = bridge.function(TrustedTypePolicyFactory.isScript, .{});
        pub const isScriptURL = bridge.function(TrustedTypePolicyFactory.isScriptURL, .{});
    };
};
