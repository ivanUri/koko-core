const std = @import("std");

const Frame = @import("../../core/browser/Frame.zig");
const js = @import("../../core/js/js.zig");

pub fn installOnDocument(frame: *Frame, context: *js.Context) void {
    const profile = frame.loadedProfile();
    if (profile.mode != .antidetect) return;
    const keys = profile.html_element_keys;
    if (keys.len == 0) return;

    var ls: js.Local.Scope = undefined;
    context.localScope(&ls);
    defer ls.deinit();

    const script = buildPrototypeScript(frame.arena, keys) catch return;
    ls.local.eval(script, "html-element-keys-install") catch |err| {
        const log = @import("../../support/log.zig");
        log.warn(.js, "html element keys install", .{ .err = err });
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

/// `html_element_keys` is the captured `for..in` surface of an HTML element:
/// enumerable properties grouped by their owning prototype. It is not an
/// own-property list for `document.documentElement`.
///
/// Shape only descriptors already supplied by the DOM implementation. Missing
/// Web APIs must be implemented by their owning interface rather than replaced
/// with `undefined` data properties here. Re-defining with a spread descriptor
/// preserves accessor identity, setters and writable/value semantics.
fn buildPrototypeScript(allocator: std.mem.Allocator, keys: []const []const u8) ![]const u8 {
    const keys_json = try keysToJson(allocator, keys);
    return std.fmt.allocPrint(
        allocator,
        \\(function(){{const keys={s};const allowed=new Set(keys);const el=document.documentElement;let proto=Object.getPrototypeOf(el);while(proto&&proto!==Object.prototype){{const descs=Object.getOwnPropertyDescriptors(proto);const own=Object.getOwnPropertyNames(proto);for(const k of own){{const d=descs[k];if(!d||!d.configurable)continue;const enumerable=allowed.has(k);if(d.enumerable!==enumerable){{Object.defineProperty(proto,k,{{...d,enumerable}});descs[k]={{...d,enumerable}};}}}}const ordered=[];for(const k of keys){{if(Object.prototype.hasOwnProperty.call(descs,k)&&descs[k].configurable)ordered.push(k);}}for(const k of ordered)delete proto[k];for(const k of ordered)Object.defineProperty(proto,k,descs[k]);proto=Object.getPrototypeOf(proto);}}}})();
    ,
        .{keys_json},
    );
}

test "html element key shaping preserves prototype ownership and descriptors" {
    const testing = std.testing;
    const script = try buildPrototypeScript(testing.allocator, &.{ "clientWidth", "click" });
    defer testing.allocator.free(script);

    try testing.expect(std.mem.indexOf(u8, script, "Object.getPrototypeOf(el)") != null);
    try testing.expect(std.mem.indexOf(u8, script, "Object.getOwnPropertyDescriptors(proto)") != null);
    try testing.expect(std.mem.indexOf(u8, script, "{...d,enumerable}") != null);
    try testing.expect(std.mem.indexOf(u8, script, "Object.defineProperty(el,") == null);
    try testing.expect(std.mem.indexOf(u8, script, "value:undefined") == null);
}
