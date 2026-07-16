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

    const prune_script = buildPruneScript(frame.arena, keys) catch return;
    ls.local.eval(prune_script, "window-keys-prune") catch |err| {
        const log = @import("../../support/log.zig");
        log.warn(.js, "window keys prune", .{ .err = err });
    };

    const hook_script = buildOwnPropertyNamesHook(frame.arena, keys) catch return;
    ls.local.eval(hook_script, "window-keys-opn-hook") catch |err| {
        const log = @import("../../support/log.zig");
        log.warn(.js, "window keys opn hook", .{ .err = err });
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

/// Globals written by real site runtimes (Next/Turbopack/React/etc.). Antidetect
/// prune must not delete these — SPA bootstrap (window.next, TURBOPACK) is wiped
/// ~100ms after install and soft-nav /login never completes (dovihome-sale).
const runtime_assigned_json =
    \\["Fingerprint","Creep","knitsail","td","next","TURBOPACK","TURBOPACK_NEXT_CHUNK_URLS","React","ReactDOM","ReactDOMClient","__VUE__","__NUXT__","ng","angular","Vue","VueRouter","webpackChunk_N_E"]
;

fn buildPruneScript(allocator: std.mem.Allocator, keys: []const []const u8) ![]const u8 {
    const keys_json = try keysToJson(allocator, keys);
    return std.fmt.allocPrint(
        allocator,
        \\(function(){{const allowed=new Set({s});const runtimeAssigned=new Set({s});const prune=[];for(const k of Object.getOwnPropertyNames(globalThis)){{if(/_|\\d{{3,}}/.test(k))continue;if(allowed.has(k)||runtimeAssigned.has(k))continue;prune.push(k)}}for(const k of prune){{try{{delete globalThis[k]}}catch(e){{}}}}}})();
    ,
        .{ keys_json, runtime_assigned_json },
    );
}

fn buildOwnPropertyNamesHook(allocator: std.mem.Allocator, keys: []const []const u8) ![]const u8 {
    const keys_json = try keysToJson(allocator, keys);
    return std.fmt.allocPrint(
        allocator,
        \\(function(){{const order={s};const orig=Object.getOwnPropertyNames;const noise=/_|\\d{{3,}}/;Object.getOwnPropertyNames=function(o){{const names=orig.call(Object,o);const filtered=names.filter((k)=>!noise.test(k));if(filtered.length<900)return names;const seen=new Set();const out=[];for(const k of order){{if(names.includes(k)&&!seen.has(k)){{out.push(k);seen.add(k)}}}}for(const k of names){{if(seen.has(k))continue;if(noise.test(k))continue;out.push(k);seen.add(k)}}return out}}}})();
    ,
        .{keys_json},
    );
}

fn buildBatchScript(allocator: std.mem.Allocator, keys: []const []const u8) ![]const u8 {
    const keys_json = try keysToJson(allocator, keys);
    return std.fmt.allocPrint(
        allocator,
        \\(function(){{const keys={s};const own=new Set(Object.getOwnPropertyNames(globalThis));const runtimeAssigned=new Set({s});for(const k of keys){{if(own.has(k))continue;if(runtimeAssigned.has(k))continue;if(k.startsWith("on")&&k.length>2){{Object.defineProperty(globalThis,k,{{value:null,enumerable:true,configurable:true,writable:true}});own.add(k);continue;}}if(k in globalThis){{const cur=globalThis[k];Object.defineProperty(globalThis,k,{{value:cur,enumerable:true,configurable:true,writable:true}});own.add(k);continue;}}Object.defineProperty(globalThis,k,{{value:undefined,enumerable:true,configurable:true,writable:true}});own.add(k);}}}})();
    ,
        .{ keys_json, runtime_assigned_json },
    );
}
