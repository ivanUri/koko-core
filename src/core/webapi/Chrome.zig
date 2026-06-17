// Minimal window.chrome stub for Blink-like environments.
// Intentionally omits chrome.runtime to avoid hasBadChromeRuntime signals.

const js = @import("../js/js.zig");

const Chrome = @This();

_pad: bool = false,

pub const init: Chrome = .{};

pub const JsApi = struct {
    pub const bridge = js.Bridge(Chrome);

    pub const Meta = struct {
        pub const name = "Chrome";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };
};
