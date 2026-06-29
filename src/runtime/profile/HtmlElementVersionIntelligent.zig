const std = @import("std");

const Frame = @import("../../core/browser/Frame.zig");
const js = @import("../../core/js/js.zig");

const batch_size = 128;

pub fn installOnDocument(frame: *Frame, context: *js.Context) void {
    const profile = frame.loadedProfile();
    if (profile.mode != .antidetect) return;
    const keys = profile.html_element_keys;
    if (keys.len == 0) return;

    var ls: js.Local.Scope = undefined;
    context.localScope(&ls);
    defer ls.deinit();

    var i: usize = 0;
    while (i < keys.len) {
        const end = @min(i + batch_size, keys.len);
        const script = buildBatchScript(frame.arena, keys[i..end]) catch return;
        ls.local.eval(script, "html-element-keys-install") catch |err| {
            const log = @import("../../support/log.zig");
            log.warn(.js, "html element keys install", .{ .err = err, .batch = i / batch_size });
            return;
        };
        i = end;
    }

    const prune_script = buildPruneScript(frame.arena, keys) catch return;
    ls.local.eval(prune_script, "html-element-keys-prune") catch |err| {
        const log = @import("../../support/log.zig");
        log.warn(.js, "html element keys prune", .{ .err = err });
    };
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

fn buildPruneScript(allocator: std.mem.Allocator, keys: []const []const u8) ![]const u8 {
    const keys_json = try keysToJson(allocator, keys);
    return std.fmt.allocPrint(
        allocator,
        \\(function(){{const allowed=new Set({s});let proto=Object.getPrototypeOf(document.documentElement);while(proto){{for(const k of Object.getOwnPropertyNames(proto)){{if(allowed.has(k))continue;const d=Object.getOwnPropertyDescriptor(proto,k);if(d&&d.enumerable){{try{{Object.defineProperty(proto,k,{{...d,enumerable:false}})}}catch(e){{}}}}}}proto=Object.getPrototypeOf(proto)}}}})();
    ,
        .{keys_json},
    );
}

fn buildBatchScript(allocator: std.mem.Allocator, keys: []const []const u8) ![]const u8 {
    const keys_json = try keysToJson(allocator, keys);
    return std.fmt.allocPrint(
        allocator,
        \\(function(){{const keys={s};const el=document.documentElement;for(const k of keys){{let v=undefined;try{{if(k in el)v=el[k]}}catch(e){{}}try{{delete el[k]}}catch(e){{}}Object.defineProperty(el,k,{{value:v,enumerable:true,configurable:true,writable:true}});}}}})();
    ,
        .{keys_json},
    );
}
