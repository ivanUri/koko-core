const Base = @This();

pub const JsApi = struct {
    pub const Meta = struct {
        pub const name = "Base";
        pub const constructor_alias = "BaseAlias";
        pub const enumerable = true;
    };

    pub const constructor = bridge.constructor(Base.init, .{});
    pub const staticThing = bridge.function(Base.staticThing, .{ .static = true, .length = 2 });
    // WPT-only testdriver surface; it is not part of the production surface.
    pub const webdriver = bridge.accessor(Base.getWebdriver, null, .{ .wpt_only = true });
    pub const renamed = bridge.function(Base.noop, .{ .js_name = "renamed", .noop = true });
    pub const value = bridge.accessor(Base.getValue, Base.setValue, .{ .deletable = false });
    pub const ANSWER = bridge.property(42, .{ .template = true });
    pub const items = bridge.indexedWithSetterDeleter(Base.getItem, Base.items, Base.setItem, Base.deleteItem, .{ .enumerable = true });
};

fn init(url: []const u8, optional: ?u8, frame: *Frame) void {}
fn staticThing(first: []const u8, second: u8) void {}
fn noop() void {}
fn getWebdriver() bool { return true; }
fn getValue() u8 { return 1; }
fn setValue(value: u8) void {}
fn getItem(index: u32) u8 { return 0; }
fn items() []u8 { return &.{}; }
fn setItem(index: u32, value: u8) void {}
fn deleteItem(index: u32) void {}
