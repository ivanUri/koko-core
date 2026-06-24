// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

const js = @import("../js/js.zig");
const Frame = @import("../browser/Frame.zig");
const TaggedOpaque = @import("../js/TaggedOpaque.zig");

const type_mapping_json = @embedFile("assets/chrome-trusted-types-mapping.json");

pub fn registerTypes() []const type {
    return &.{
        TrustedTypePolicyFactory,
        TrustedTypePolicy,
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

fn invokePolicyTransform(
    callback: ?js.Function.Global,
    input: []const u8,
    frame: *Frame,
) ![]const u8 {
    const cb = callback orelse return error.TypeError;
    const local = frame.js.local orelse return error.NotHandled;
    const result = try local.toLocal(cb).call([]const u8, .{input});
    return try frame.dupeString(result);
}

fn lookupTypeName(
    mapping: js.Object,
    tag_name: []const u8,
    section: []const u8,
    key: []const u8,
    frame: *Frame,
) !?[]const u8 {
    const try_tag = struct {
        fn run(map: js.Object, tag: []const u8, sec: []const u8, k: []const u8, f: *Frame) !?[]const u8 {
            const tag_val = map.get(tag) catch return null;
            if (!tag_val.isObject()) return null;
            const tag_obj = tag_val.toObject();
            const section_val = tag_obj.get(sec) catch return null;
            if (!section_val.isObject()) return null;
            const section_obj = section_val.toObject();
            const type_val = section_obj.get(k) catch return null;
            const slice = try type_val.toStringSliceWithAlloc(f.call_arena);
            return try f.dupeString(slice);
        }
    };

    if (try try_tag.run(mapping, tag_name, section, key, frame)) |name| {
        return name;
    }
    return try_tag.run(mapping, "*", section, key, frame);
}

fn getTypeMappingValue(frame: *Frame) !js.Value {
    if (frame._trusted_types_mapping) |global| {
        const local = frame.js.local orelse return error.NotHandled;
        return .{ .local = local, .handle = @ptrCast(global.local(local).handle) };
    }
    const local = frame.js.local orelse return error.NotHandled;
    const value = try local.parseJSON(type_mapping_json);
    frame._trusted_types_mapping = try value.persist();
    return value;
}

pub const TrustedTypePolicy = struct {
    _name: []const u8,
    _create_html: ?js.Function.Global = null,
    _create_script: ?js.Function.Global = null,
    _create_script_url: ?js.Function.Global = null,

    pub fn getName(self: *const TrustedTypePolicy) []const u8 {
        return self._name;
    }

    pub fn createHTML(self: *const TrustedTypePolicy, input: []const u8, frame: *Frame) !*TrustedHTML {
        const value = try invokePolicyTransform(self._create_html, input, frame);
        return frame._factory.create(TrustedHTML{ ._value = value });
    }

    pub fn createScript(self: *const TrustedTypePolicy, input: []const u8, frame: *Frame) !*TrustedScript {
        const value = try invokePolicyTransform(self._create_script, input, frame);
        return frame._factory.create(TrustedScript{ ._value = value });
    }

    pub fn createScriptURL(self: *const TrustedTypePolicy, input: []const u8, frame: *Frame) !*TrustedScriptURL {
        const value = try invokePolicyTransform(self._create_script_url, input, frame);
        return frame._factory.create(TrustedScriptURL{ ._value = value });
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(TrustedTypePolicy);
        pub const Meta = struct {
            pub const name = "TrustedTypePolicy";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
        };
        pub const name = bridge.accessor(TrustedTypePolicy.getName, null, .{});
        pub const createHTML = bridge.function(TrustedTypePolicy.createHTML, .{});
        pub const createScript = bridge.function(TrustedTypePolicy.createScript, .{});
        pub const createScriptURL = bridge.function(TrustedTypePolicy.createScriptURL, .{});
    };
};

pub const TrustedTypePolicyFactory = struct {
    _pad: bool = false,

    fn persistOptionCallback(opts: js.Object, key: []const u8) !?js.Function.Global {
        const func = opts.getFunction(key) catch return null;
        return if (func) |f| try f.persist() else null;
    }

    pub fn createPolicy(
        self: *const TrustedTypePolicyFactory,
        name: []const u8,
        options: ?js.Object,
        frame: *Frame,
    ) !*TrustedTypePolicy {
        _ = self;

        var create_html: ?js.Function.Global = null;
        var create_script: ?js.Function.Global = null;
        var create_script_url: ?js.Function.Global = null;

        if (options) |opts| {
            create_html = try persistOptionCallback(opts, "createHTML");
            create_script = try persistOptionCallback(opts, "createScript");
            create_script_url = try persistOptionCallback(opts, "createScriptURL");
        }

        return frame._factory.create(TrustedTypePolicy{
            ._name = try frame.dupeString(name),
            ._create_html = create_html,
            ._create_script = create_script,
            ._create_script_url = create_script_url,
        });
    }

    fn makeTrustedHTML(value: []const u8, frame: *Frame) !*TrustedHTML {
        return frame._factory.create(TrustedHTML{ ._value = try frame.dupeString(value) });
    }

    fn makeTrustedScript(value: []const u8, frame: *Frame) !*TrustedScript {
        return frame._factory.create(TrustedScript{ ._value = try frame.dupeString(value) });
    }

    pub fn getEmptyHTML(self: *const TrustedTypePolicyFactory, frame: *Frame) !*TrustedHTML {
        _ = self;
        return makeTrustedHTML("", frame);
    }

    pub fn getEmptyScript(self: *const TrustedTypePolicyFactory, frame: *Frame) !*TrustedScript {
        _ = self;
        return makeTrustedScript("", frame);
    }

    pub fn getDefaultPolicy(self: *const TrustedTypePolicyFactory) ?*TrustedTypePolicy {
        _ = self;
        return null;
    }

    pub fn getTypeMapping(self: *const TrustedTypePolicyFactory, frame: *Frame) !js.Value {
        _ = self;
        return try getTypeMappingValue(frame);
    }

    pub fn getAttributeType(
        self: *const TrustedTypePolicyFactory,
        tag_name: []const u8,
        attribute: []const u8,
        _: ?[]const u8,
        frame: *Frame,
    ) !?[]const u8 {
        _ = self;
        const mapping_val = try getTypeMappingValue(frame);
        return lookupTypeName(mapping_val.toObject(), tag_name, "attributes", attribute, frame);
    }

    pub fn getPropertyType(
        self: *const TrustedTypePolicyFactory,
        tag_name: []const u8,
        property: []const u8,
        _: ?[]const u8,
        frame: *Frame,
    ) !?[]const u8 {
        _ = self;
        const mapping_val = try getTypeMappingValue(frame);
        return lookupTypeName(mapping_val.toObject(), tag_name, "properties", property, frame);
    }

    fn isTrustedType(comptime T: type, value: js.Value) bool {
        if (!value.isObject()) return false;
        _ = TaggedOpaque.fromJS(*T, @ptrCast(value.handle)) catch return false;
        return true;
    }

    pub fn isHTML(self: *const TrustedTypePolicyFactory, value: js.Value) bool {
        _ = self;
        return isTrustedType(TrustedHTML, value);
    }

    pub fn isScript(self: *const TrustedTypePolicyFactory, value: js.Value) bool {
        _ = self;
        return isTrustedType(TrustedScript, value);
    }

    pub fn isScriptURL(self: *const TrustedTypePolicyFactory, value: js.Value) bool {
        _ = self;
        return isTrustedType(TrustedScriptURL, value);
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
            fn get(s: *const TrustedTypePolicyFactory, frame: *Frame) !*TrustedHTML {
                return s.getEmptyHTML(frame);
            }
        }.get, null, .{});
        pub const emptyScript = bridge.accessor(struct {
            fn get(s: *const TrustedTypePolicyFactory, frame: *Frame) !*TrustedScript {
                return s.getEmptyScript(frame);
            }
        }.get, null, .{});
        pub const defaultPolicy = bridge.accessor(TrustedTypePolicyFactory.getDefaultPolicy, null, .{});
        pub const createPolicy = bridge.function(TrustedTypePolicyFactory.createPolicy, .{});
        pub const getAttributeType = bridge.function(TrustedTypePolicyFactory.getAttributeType, .{});
        pub const getPropertyType = bridge.function(TrustedTypePolicyFactory.getPropertyType, .{});
        pub const getTypeMapping = bridge.function(TrustedTypePolicyFactory.getTypeMapping, .{});
        pub const isHTML = bridge.function(TrustedTypePolicyFactory.isHTML, .{});
        pub const isScript = bridge.function(TrustedTypePolicyFactory.isScript, .{});
        pub const isScriptURL = bridge.function(TrustedTypePolicyFactory.isScriptURL, .{});
    };
};
