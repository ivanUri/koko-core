const std = @import("std");

const Frame = @import("../../core/browser/Frame.zig");
const js = @import("../../core/js/js.zig");

pub const Entry = struct {
    method: []const u8,
    args_json: []const u8,
    result: f64,
};

pub fn installOnGlobal(frame: *Frame, context: *js.Context) void {
    const profile = frame.loadedProfile();
    if (profile.mode != .antidetect) return;
    const entries = profile.maths_baseline;
    if (entries.len == 0) return;

    const script = buildInstallScript(frame.arena, entries) catch return;

    var ls: js.Local.Scope = undefined;
    context.localScope(&ls);
    defer ls.deinit();

    ls.local.eval(script, "maths-baseline-install") catch |err| {
        const log = @import("../../support/log.zig");
        log.warn(.js, "maths baseline install", .{ .err = err });
    };
}

fn buildInstallScript(allocator: std.mem.Allocator, entries: []const Entry) ![]const u8 {
    var cases_json = std.ArrayList(u8).initCapacity(allocator, entries.len * 64) catch return error.OutOfMemory;
    errdefer cases_json.deinit(allocator);
    try cases_json.appendSlice(allocator, "[");
    for (entries, 0..) |entry, idx| {
        if (idx > 0) try cases_json.append(allocator, ',');
        try cases_json.writer(allocator).print(
            "{{\"m\":{s},\"a\":{s},\"r\":{d}}}",
            .{ try jsonString(allocator, entry.method), entry.args_json, entry.result },
        );
    }
    try cases_json.append(allocator, ']');
    const cases = try cases_json.toOwnedSlice(allocator);

    return std.fmt.allocPrint(
        allocator,
        \\(function(){{const C={s};const B={{}},O={{}},S=(a)=>a.map(v=>Object.is(v,-0)?"-0":String(v)).join("\\0");const eq=(a,b)=>Object.is(a,b)||(typeof a==="number"&&typeof b==="number"&&!Number.isNaN(a)&&!Number.isNaN(b)&&Math.abs(a-b)<1e-12);for(const c of C){{(B[c.m]??(B[c.m]={{}}))[S(c.a)]=c.r;(O[c.m]??(O[c.m]=[])).push(c.a)}}for(const m of Object.keys(B)){{const orig=Math[m];const map=B[m];const argsList=O[m];Math[m]=function(...args){{const k=S(args);if(k in map)return map[k];for(const ref of argsList){{if(ref.length===args.length&&ref.every((v,i)=>eq(v,args[i])))return map[S(ref)]}}return orig.apply(this,args)}}}}}})();
    ,
        .{cases},
    );
}

fn jsonString(allocator: std.mem.Allocator, s: []const u8) ![]const u8 {
    var out = std.ArrayList(u8).initCapacity(allocator, s.len + 2) catch return error.OutOfMemory;
    errdefer out.deinit(allocator);
    try out.append(allocator, '"');
    for (s) |c| {
        switch (c) {
            '\\' => try out.appendSlice(allocator, "\\\\"),
            '"' => try out.appendSlice(allocator, "\\\""),
            else => try out.append(allocator, c),
        }
    }
    try out.append(allocator, '"');
    return out.toOwnedSlice(allocator);
}
