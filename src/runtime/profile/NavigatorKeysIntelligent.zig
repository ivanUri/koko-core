const std = @import("std");

const Frame = @import("../../core/browser/Frame.zig");
const js = @import("../../core/js/js.zig");

pub fn installOnDocument(frame: *Frame, context: *js.Context) void {
    const profile = frame.loadedProfile();
    if (profile.mode != .antidetect) return;
    const keys = profile.navigator_keys;
    if (keys.len == 0) return;

    var ls: js.Local.Scope = undefined;
    context.localScope(&ls);
    defer ls.deinit();

    const install_script = buildInstallScript(frame.arena, keys) catch return;
    ls.local.eval(install_script, "navigator-keys-install") catch |err| {
        const log = @import("../../support/log.zig");
        log.warn(.js, "navigator keys install", .{ .err = err });
        return;
    };

    // Native FunctionTemplate Object.keys (iframe clean toString safe).
    const NativeBuiltinHooks = @import("NativeBuiltinHooks.zig");
    NativeBuiltinHooks.installObjectKeys(frame, context);
}

fn keysToJson(allocator: std.mem.Allocator, keys: []const []const u8) ![]const u8 {
    var json = std.ArrayList(u8).initCapacity(allocator, keys.len * 20) catch return error.OutOfMemory;
    errdefer json.deinit(allocator);
    try json.append(allocator, '[');
    for (keys, 0..) |key, idx| {
        if (idx > 0) try json.append(allocator, ',');
        try json.append(allocator, '"');
        for (key) |c| {
            switch (c) {
                '\\' => try json.appendSlice(allocator, "\\\\"),
                '"' => try json.appendSlice(allocator, "\\\""),
                else => try json.append(allocator, c),
            }
        }
        try json.append(allocator, '"');
    }
    try json.append(allocator, ']');
    return json.toOwnedSlice(allocator);
}

fn buildInstallScript(allocator: std.mem.Allocator, keys: []const []const u8) ![]const u8 {
    const keys_json = try keysToJson(allocator, keys);
    return std.fmt.allocPrint(
        allocator,
        \\(function(){{const keys={s};const navProto=Object.getPrototypeOf(navigator);const own=new Set(Object.keys(navProto));for(const k of keys){{if(own.has(k))continue;if(k in navProto){{const cur=navProto[k];Object.defineProperty(navProto,k,{{value:cur,enumerable:true,configurable:true,writable:true}});own.add(k);continue;}}Object.defineProperty(navProto,k,{{value:undefined,enumerable:true,configurable:true,writable:true}});own.add(k);}}}})();
    ,
        .{keys_json},
    );
}
