const std = @import("std");

const Frame = @import("../../core/browser/Frame.zig");
const js = @import("../../core/js/js.zig");

const batch_size = 128;

pub fn installOnDocument(frame: *Frame, context: *js.Context) void {
    const profile = frame.loadedProfile();
    if (profile.mode != .antidetect) return;
    const keys = profile.window_keys;
    if (keys.len == 0) return;

    var ls: js.Local.Scope = undefined;
    context.localScope(&ls);
    defer ls.deinit();

    var i: usize = 0;
    while (i < keys.len) {
        const end = @min(i + batch_size, keys.len);
        const script = buildBatchScript(frame.arena, keys[i..end]) catch return;
        ls.local.eval(script, "window-keys-install") catch |err| {
            const log = @import("../../support/log.zig");
            log.warn(.js, "window keys install", .{ .err = err, .batch = i / batch_size });
            return;
        };
        i = end;
    }

    // Never replace Object.getOwnPropertyNames in one realm. Even a native
    // FunctionTemplate has different identity/realm semantics from Chrome's
    // intrinsic and is observable by comparing against a clean iframe.
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

fn buildBatchScript(allocator: std.mem.Allocator, keys: []const []const u8) ![]const u8 {
    const keys_json = try keysToJson(allocator, keys);
    return std.fmt.allocPrint(
        allocator,
        \\(function(){{const keys={s};const own=new Set(Object.getOwnPropertyNames(globalThis));for(const k of keys){{if(own.has(k))continue;if(k.startsWith("on")&&k.length>2){{Object.defineProperty(globalThis,k,{{value:null,enumerable:true,configurable:true,writable:true}});own.add(k);continue;}}if(k in globalThis){{const cur=globalThis[k];Object.defineProperty(globalThis,k,{{value:cur,enumerable:true,configurable:true,writable:true}});own.add(k);continue;}}Object.defineProperty(globalThis,k,{{value:undefined,enumerable:true,configurable:true,writable:true}});own.add(k);}}}})();
    ,
        .{keys_json},
    );
}
