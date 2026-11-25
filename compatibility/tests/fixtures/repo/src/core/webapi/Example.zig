const Example = @This();

pub const JsApi = struct {
    pub const Meta = struct {
        pub const name = "Example";
    };

    pub const constructor = bridge.constructor(Example.init, .{});
    pub const value = bridge.accessor(Example.getValue, null, .{});
};

fn init() void {}
fn getValue() u8 { return 0; }
