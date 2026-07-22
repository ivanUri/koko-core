//! Replace JS-level Object/eval shims with V8 FunctionTemplate natives so
//! `Function.prototype.toString` (including iframe clean toString) returns
//! `function name() { [native code] }` — Fingerprint Pro anti_detect / BAS path.
const std = @import("std");

const Frame = @import("../../core/browser/Frame.zig");
const js = @import("../../core/js/js.zig");
const v8 = js.v8;
const Caller = js.Caller;
const TrustedScript = @import("../../core/webapi/trusted_types.zig").TrustedScript;
const TaggedOpaque = @import("../../core/js/TaggedOpaque.zig");

const OpnState = struct {
    original: js.Function.Global,
    order: []const []const u8,
    /// First successful reordered list (window-scale). Fingerprint Pro agent
    /// calls OPN many times; recomputing 900+ strings each call times out.
    cached: ?js.Object.Global = null,
};

const KeysState = struct {
    original: js.Function.Global,
    order: []const []const u8,
    navigator: js.Object.Global,
    nav_proto: js.Object.Global,
};

const EvalState = struct {
    original: js.Function.Global,
};

/// TrustedTypes-aware eval: unwrap TrustedScript then call intrinsic eval.
/// Must look fully native (iframe toString) — no JS wrapper.
pub fn installEval(context: *js.Context) void {
    var ls: js.Local.Scope = undefined;
    context.localScope(&ls);
    defer ls.deinit();
    const local = &ls.local;

    const global_handle = v8.v8__Context__Global(local.handle) orelse return;
    const global = js.Object{ .local = local, .handle = global_handle };
    const orig_fn = global.getFunction("eval") catch return orelse return;
    const original = orig_fn.persist() catch return;

    const state = context.arena.create(EvalState) catch return;
    state.* = .{ .original = original };

    const replacement = makeNativeFunction(local, "eval", 1, evalCallback, state) orelse return;
    const replacement_val = js.Value{ .local = local, .handle = @ptrCast(replacement.handle) };
    if (global.defineOwnProperty("eval", replacement_val, v8.DontEnum) != true) {
        _ = global.set("eval", replacement, .{}) catch {};
    }
}

/// Profile-ordered Object.getOwnPropertyNames (CreepJS windowFeatures).
pub fn installGetOwnPropertyNames(frame: *Frame, context: *js.Context) void {
    const profile = frame.loadedProfile();
    if (profile.mode != .antidetect) return;
    const order = profile.window_keys;
    if (order.len == 0) return;

    var ls: js.Local.Scope = undefined;
    context.localScope(&ls);
    defer ls.deinit();
    const local = &ls.local;

    const global_handle = v8.v8__Context__Global(local.handle) orelse return;
    const global = js.Object{ .local = local, .handle = global_handle };
    const object_val = global.get("Object") catch return;
    if (!object_val.isObject()) return;
    const object = object_val.toObject();

    const orig_fn = object.getFunction("getOwnPropertyNames") catch return orelse return;
    const original = orig_fn.persist() catch return;

    const state = context.arena.create(OpnState) catch return;
    state.* = .{ .original = original, .order = order, .cached = null };

    const replacement = makeNativeFunction(local, "getOwnPropertyNames", 1, opnCallback, state) orelse return;
    const replacement_val = js.Value{ .local = local, .handle = @ptrCast(replacement.handle) };
    if (object.defineOwnProperty("getOwnPropertyNames", replacement_val, v8.DontEnum) != true) {
        _ = object.set("getOwnPropertyNames", replacement, .{}) catch {};
    }
}

/// Profile-ordered Object.keys for navigator / Navigator.prototype (CreepJS).
pub fn installObjectKeys(frame: *Frame, context: *js.Context) void {
    const profile = frame.loadedProfile();
    if (profile.mode != .antidetect) return;
    const order = profile.navigator_keys;
    if (order.len == 0) return;

    var ls: js.Local.Scope = undefined;
    context.localScope(&ls);
    defer ls.deinit();
    const local = &ls.local;

    const global_handle = v8.v8__Context__Global(local.handle) orelse return;
    const global = js.Object{ .local = local, .handle = global_handle };
    const object_val = global.get("Object") catch return;
    if (!object_val.isObject()) return;
    const object = object_val.toObject();

    const nav_val = global.get("navigator") catch return;
    if (!nav_val.isObject()) return;
    const nav_obj = nav_val.toObject();
    const nav_proto_handle = v8.v8__Object__GetPrototype(nav_obj.handle) orelse return;
    const nav_proto = js.Object{ .local = local, .handle = nav_proto_handle };

    const orig_fn = object.getFunction("keys") catch return orelse return;
    const original = orig_fn.persist() catch return;
    const nav_global = nav_obj.persist() catch return;
    const proto_global = nav_proto.persist() catch return;

    const state = context.arena.create(KeysState) catch return;
    state.* = .{
        .original = original,
        .order = order,
        .navigator = nav_global,
        .nav_proto = proto_global,
    };

    const replacement = makeNativeFunction(local, "keys", 1, keysCallback, state) orelse return;
    const replacement_val = js.Value{ .local = local, .handle = @ptrCast(replacement.handle) };
    if (object.defineOwnProperty("keys", replacement_val, v8.DontEnum) != true) {
        _ = object.set("keys", replacement, .{}) catch {};
    }
}

fn makeNativeFunction(
    local: *const js.Local,
    name: []const u8,
    length: u32,
    callback: *const fn (?*const v8.FunctionCallbackInfo) callconv(.c) void,
    state: *anyopaque,
) ?js.Function {
    const external = local.isolate.createExternal(state);
    const template = v8.v8__FunctionTemplate__New__Config(local.isolate.handle, &.{
        .callback = callback,
        .data = @ptrCast(external),
        .length = @intCast(length),
        .behavior = v8.kConstructorBehavior_Throw,
        .side_effect_type = v8.kSideEffectType_HasSideEffect,
    }) orelse return null;
    const name_handle = local.isolate.initStringHandle(name);
    v8.v8__FunctionTemplate__SetClassName(template, name_handle);
    v8.v8__FunctionTemplate__ReadOnlyPrototype(template);
    const handle = v8.v8__FunctionTemplate__GetFunction(template, local.handle) orelse return null;
    return .{ .local = local, .handle = handle };
}

fn evalCallback(info_handle: ?*const v8.FunctionCallbackInfo) callconv(.c) void {
    const info = Caller.FunctionCallbackInfo{ .handle = info_handle.? };
    const state: *EvalState = @ptrCast(@alignCast(info.getData() orelse return));

    var caller: Caller = undefined;
    if (!caller.initFromHandle(info_handle)) return;
    defer caller.deinit();
    const local = &caller.local;

    const argc = info.length();
    var arg0: ?*const v8.Value = null;
    if (argc >= 1) {
        const a = info.getArg(0, local);
        arg0 = a.handle;
        // Unwrap TrustedScript → string (Chrome eval behavior).
        if (a.isObject()) {
            if (TaggedOpaque.fromJS(*TrustedScript, a.toObject().handle)) |ts| {
                const s = ts.toString();
                const str_handle = local.isolate.initStringHandle(s);
                arg0 = @ptrCast(str_handle);
            } else |_| {}
        }
    }

    var v8_args: [1]?*const v8.Value = .{arg0};
    const call_argc: c_int = if (argc >= 1) 1 else 0;
    const orig = state.original.local(local);
    const result_handle = v8.v8__Function__Call(
        orig.handle,
        local.handle,
        info.getThis(),
        call_argc,
        if (call_argc > 0) @ptrCast(&v8_args) else null,
    ) orelse return;
    info.getReturnValue().setValueHandle(result_handle);
}

fn opnCallback(info_handle: ?*const v8.FunctionCallbackInfo) callconv(.c) void {
    const info = Caller.FunctionCallbackInfo{ .handle = info_handle.? };
    const state: *OpnState = @ptrCast(@alignCast(info.getData() orelse return));

    var caller: Caller = undefined;
    if (!caller.initFromHandle(info_handle)) return;
    defer caller.deinit();
    const local = &caller.local;

    if (info.length() < 1) {
        // Match native TypeError path via original.
        callOriginalPassthrough(state.original, info, local, 0, null);
        return;
    }

    const arg = info.getArg(0, local);
    var v8_args = [_]?*const v8.Value{arg.handle};
    const orig = state.original.local(local);
    const result_handle = v8.v8__Function__Call(
        orig.handle,
        local.handle,
        info.getThis(),
        1,
        @ptrCast(&v8_args),
    ) orelse return;

    // Reorder only large window-like objects (CreepJS phantom path, ≥900 keys).
    const names_arr = js.Array{ .local = local, .handle = @ptrCast(result_handle) };
    const n = names_arr.len();
    if (n < 900 or state.order.len == 0) {
        info.getReturnValue().setValueHandle(result_handle);
        return;
    }

    // Serve cached reorder (Pro agent re-OPNs window repeatedly).
    if (state.cached) |cached| {
        const cached_obj = cached.local(local);
        info.getReturnValue().setValueHandle(@ptrCast(cached_obj.handle));
        return;
    }

    const arena = local.call_arena;
    var present = std.StringHashMapUnmanaged(void){};
    defer present.deinit(arena);
    present.ensureTotalCapacity(arena, @intCast(n)) catch {
        info.getReturnValue().setValueHandle(result_handle);
        return;
    };

    var name_slices = arena.alloc([]const u8, n) catch {
        info.getReturnValue().setValueHandle(result_handle);
        return;
    };
    var filtered: usize = 0;
    var i: usize = 0;
    while (i < n) : (i += 1) {
        const item = names_arr.get(@intCast(i)) catch {
            info.getReturnValue().setValueHandle(result_handle);
            return;
        };
        const s = item.toStringSliceWithAlloc(arena) catch {
            info.getReturnValue().setValueHandle(result_handle);
            return;
        };
        name_slices[i] = s;
        present.putAssumeCapacity(s, {});
        if (!isNoiseKey(s)) filtered += 1;
    }
    if (filtered < 900) {
        info.getReturnValue().setValueHandle(result_handle);
        return;
    }

    var seen = std.StringHashMapUnmanaged(void){};
    defer seen.deinit(arena);
    seen.ensureTotalCapacity(arena, @intCast(n)) catch {};
    var out = std.ArrayListUnmanaged([]const u8){};
    defer out.deinit(arena);
    out.ensureTotalCapacity(arena, n) catch {};

    for (state.order) |k| {
        if (!present.contains(k)) continue;
        const gop = seen.getOrPut(arena, k) catch continue;
        if (gop.found_existing) continue;
        out.appendAssumeCapacity(k);
    }
    for (name_slices) |k| {
        if (isNoiseKey(k)) continue;
        const gop = seen.getOrPut(arena, k) catch continue;
        if (gop.found_existing) continue;
        out.appendAssumeCapacity(k);
    }

    const js_arr = local.newArray(@intCast(out.items.len));
    for (out.items, 0..) |k, idx| {
        _ = js_arr.set(@intCast(idx), k, .{}) catch {};
    }
    // Persist for subsequent OPN calls in this document.
    if (js_arr.toObject().persist()) |g| {
        state.cached = g;
    } else |_| {}
    info.getReturnValue().set(js_arr.toValue());
}

fn keysCallback(info_handle: ?*const v8.FunctionCallbackInfo) callconv(.c) void {
    const info = Caller.FunctionCallbackInfo{ .handle = info_handle.? };
    const state: *KeysState = @ptrCast(@alignCast(info.getData() orelse return));

    var caller: Caller = undefined;
    if (!caller.initFromHandle(info_handle)) return;
    defer caller.deinit();
    const local = &caller.local;

    if (info.length() < 1) {
        callOriginalPassthrough(state.original, info, local, 0, null);
        return;
    }

    const arg = info.getArg(0, local);
    var v8_args = [_]?*const v8.Value{arg.handle};
    const orig = state.original.local(local);
    const result_handle = v8.v8__Function__Call(
        orig.handle,
        local.handle,
        info.getThis(),
        1,
        @ptrCast(&v8_args),
    ) orelse return;

    if (!arg.isObject()) {
        info.getReturnValue().setValueHandle(result_handle);
        return;
    }
    const arg_obj = arg.toObject();
    const is_nav = state.navigator.isEqual(arg_obj);
    const is_proto = state.nav_proto.isEqual(arg_obj);
    if (!is_nav and !is_proto) {
        info.getReturnValue().setValueHandle(result_handle);
        return;
    }

    const names_arr = js.Array{ .local = local, .handle = @ptrCast(result_handle) };
    const n = names_arr.len();
    const arena = local.call_arena;
    var name_set = std.StringHashMapUnmanaged(void){};
    defer name_set.deinit(arena);
    var i: usize = 0;
    while (i < n) : (i += 1) {
        const item = names_arr.get(@intCast(i)) catch continue;
        const s = item.toStringSliceWithAlloc(arena) catch continue;
        name_set.put(arena, s, {}) catch {};
    }

    var out = std.ArrayListUnmanaged([]const u8){};
    defer out.deinit(arena);
    for (state.order) |k| {
        if (name_set.contains(k)) out.append(arena, k) catch {};
    }

    const js_arr = local.newArray(@intCast(out.items.len));
    for (out.items, 0..) |k, idx| {
        _ = js_arr.set(@intCast(idx), k, .{}) catch {};
    }
    info.getReturnValue().set(js_arr.toValue());
}

fn callOriginalPassthrough(
    original: js.Function.Global,
    info: Caller.FunctionCallbackInfo,
    local: *const js.Local,
    argc: c_int,
    args: ?[*]?*const v8.Value,
) void {
    const orig = original.local(local);
    const result_handle = v8.v8__Function__Call(
        orig.handle,
        local.handle,
        info.getThis(),
        argc,
        args,
    ) orelse return;
    info.getReturnValue().setValueHandle(result_handle);
}

/// Matches WindowKeys JS noise filter: `/_|\\d{3,}/`
fn isNoiseKey(k: []const u8) bool {
    if (std.mem.indexOfScalar(u8, k, '_') != null) return true;
    var digit_run: usize = 0;
    for (k) |c| {
        if (c >= '0' and c <= '9') {
            digit_run += 1;
            if (digit_run >= 3) return true;
        } else {
            digit_run = 0;
        }
    }
    return false;
}
