//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

const std = @import("std");
const assert = @import("../../support/assert.zig").assert;
const builtin = @import("builtin");

const HttpClient = @import("HttpClient.zig");
const LoadGuard = @import("LoadGuard.zig");
const ContentSecurityPolicy = @import("ContentSecurityPolicy.zig");
const http = @import("../../runtime/network/http.zig");
const GoogleSigninDebug = @import("GoogleSigninDebug.zig");

const js = @import("../js/js.zig");
const URL = @import("URL.zig");
const Session = @import("Session.zig");
const Frame = @import("Frame.zig");
const WorkerGlobalScope = @import("../webapi/WorkerGlobalScope.zig");

const Element = @import("../dom/Element.zig");

const log = @import("../../support/log.zig");
const String = @import("../../support/string.zig").String;
const Allocator = std.mem.Allocator;
const IS_DEBUG = builtin.mode == .Debug;
const JS_CALL_LOG_ENV = "VELORA_JS_CALL_LOG";

fn jsCallLogEnabled() bool {
    const value = std.posix.getenv(JS_CALL_LOG_ENV) orelse return false;
    return value.len > 0 and !std.mem.eql(u8, value, "0") and !std.mem.eql(u8, value, "false");
}

fn appendJsStringLiteral(list: *std.ArrayList(u8), arena: Allocator, value: []const u8) !void {
    try list.append(arena, '"');
    for (value) |c| {
        switch (c) {
            '\\' => try list.appendSlice(arena, "\\\\"),
            '"' => try list.appendSlice(arena, "\\\""),
            '\n' => try list.appendSlice(arena, "\\n"),
            '\r' => try list.appendSlice(arena, "\\r"),
            '\t' => try list.appendSlice(arena, "\\t"),
            else => try list.append(arena, c),
        }
    }
    try list.append(arena, '"');
}

fn instrumentClassicScript(arena: Allocator, src: []const u8, script_url: []const u8) ![]const u8 {
    const hook =
        \\(function(){
        \\  if (globalThis.__veloraJsCallLogHooked) return;
        \\  Object.defineProperty(globalThis, "__veloraJsCallLogHooked", { value: true, configurable: true });
        \\  const scriptUrl = 
    ;
    const hook_tail =
        \\;
        \\  const log = (kind, fn) => { try {
        \\    const raw = String((new Error()).stack || "").split("\n").slice(2, 9);
        \\    const frame = raw.find(line => line.includes(scriptUrl)) || raw[0] || "";
        \\    console.log("[velora-js-call] file=" + scriptUrl + " kind=" + kind + " fn=" + ((fn && (fn.name || fn.displayName)) || "<anonymous>") + " at=" + frame.trim());
        \\  } catch (_) {} };
        \\  const seen = new WeakMap();
        \\  const wrap = (kind, fn) => {
        \\    if (typeof fn !== "function") return fn;
        \\    const old = seen.get(fn); if (old) return old;
        \\    const wrapped = function(...args) { log(kind, fn); return Reflect.apply(fn, this, args); };
        \\    try { Object.defineProperty(wrapped, "name", { value: fn.name || "veloraWrapped", configurable: true }); } catch (_) {}
        \\    seen.set(fn, wrapped);
        \\    return wrapped;
        \\  };
        \\  for (const name of ["setTimeout", "setInterval"]) {
        \\    const original = globalThis[name];
        \\    if (typeof original === "function") globalThis[name] = function(fn, ...args) { return Reflect.apply(original, this, [wrap(name, fn), ...args]); };
        \\  }
        \\  if (typeof globalThis.queueMicrotask === "function") {
        \\    const original = globalThis.queueMicrotask;
        \\    globalThis.queueMicrotask = function(fn) { return Reflect.apply(original, this, [wrap("queueMicrotask", fn)]); };
        \\  }
        \\  const et = globalThis.EventTarget && globalThis.EventTarget.prototype;
        \\  if (et && typeof et.addEventListener === "function") {
        \\    const original = et.addEventListener;
        \\    et.addEventListener = function(type, fn, opts) { return Reflect.apply(original, this, [type, wrap("event:" + type, fn), opts]); };
        \\  }
        \\  const pp = globalThis.Promise && globalThis.Promise.prototype;
        \\  if (pp) for (const name of ["then", "catch", "finally"]) {
        \\    const original = pp[name];
        \\    if (typeof original === "function") pp[name] = function(...callbacks) { return Reflect.apply(original, this, callbacks.map(fn => wrap("promise." + name, fn))); };
        \\  }
        \\  for (const target of [globalThis.navigator, globalThis.document, globalThis.screen, globalThis.performance]) {
        \\    if (!target) continue;
        \\    let proto = Object.getPrototypeOf(target);
        \\    while (proto && proto !== Object.prototype) {
        \\      for (const key of Object.getOwnPropertyNames(proto)) { try {
        \\        if (key === "constructor") continue;
        \\        const desc = Object.getOwnPropertyDescriptor(proto, key);
        \\        if (!desc || desc.configurable === false || typeof desc.value !== "function") continue;
        \\        Object.defineProperty(proto, key, { ...desc, value: wrap("api:" + key, desc.value) });
        \\      } catch (_) {} }
        \\      proto = Object.getPrototypeOf(proto);
        \\    }
        \\  }
        \\})();
        \\
    ;
    var out: std.ArrayList(u8) = .empty;
    try out.appendSlice(arena, hook);
    try appendJsStringLiteral(&out, arena, script_url);
    try out.appendSlice(arena, hook_tail);
    try out.append(arena, '\n');
    try out.appendSlice(arena, src);
    return out.items;
}

const ScriptManagerBase = @This();

// Either a *Frame (for page ScriptManagers) or *WorkerGlobalScope (for workers).
// Used from HTTP callbacks that only have a *Script in hand; the Script reaches
// the owner through its manager pointer.
pub const Owner = union(enum) {
    frame: *Frame,
    worker: *WorkerGlobalScope,

    pub fn url(self: Owner) [:0]const u8 {
        return switch (self) {
            .frame => |f| f.url,
            .worker => |w| w.url,
        };
    }

    pub fn topLevelCookieUrl(self: Owner) [:0]const u8 {
        return switch (self) {
            .frame => |f| f.topLevelUrl(),
            .worker => |w| w.url,
        };
    }

    pub fn frameId(self: Owner) u32 {
        return switch (self) {
            .frame => |f| f._frame_id,
            .worker => |w| w._worker._frame_id,
        };
    }

    pub fn attributionFrame(self: Owner) *anyopaque {
        return switch (self) {
            .frame => |f| f,
            .worker => |w| @ptrCast(w._worker._frame),
        };
    }

    pub fn loaderId(self: Owner) u32 {
        return switch (self) {
            .frame => |f| f._loader_id,
            .worker => |w| w._worker._loader_id,
        };
    }

    pub fn session(self: Owner) *Session {
        return switch (self) {
            .frame => |f| f._session,
            .worker => |w| w._session,
        };
    }

    pub fn jsContext(self: Owner) *js.Context {
        return switch (self) {
            .frame => |f| f.js,
            .worker => |w| w.js,
        };
    }

    pub fn captureTaskOwner(self: Owner) LoadGuard.TaskOwner {
        return self.jsContext().execution.captureTaskOwner();
    }

    pub fn addHeaders(self: Owner, headers: *HttpClient.Headers, opts: Frame.HeadersForRequestOpts) !void {
        switch (self) {
            .frame => |f| try f.headersForRequest(headers, opts),
            .worker => |w| try w.headersForRequest(headers, opts),
        }
    }

    pub fn omitCookies(self: Owner, request_url: [:0]const u8) bool {
        return switch (self) {
            .frame => false,
            .worker => |w| !w._worker.shouldSendCookies(request_url),
        };
    }

    pub fn parentFrame(self: Owner) *Frame {
        return switch (self) {
            .frame => |f| f,
            .worker => |w| w._worker._frame,
        };
    }

    pub fn cspAllowsStaticModuleImport(self: Owner, request_url: [:0]const u8) bool {
        const frame = self.parentFrame();
        const policy = frame.content_security_policy orelse return true;
        return policy.allowsWorkerStaticImport(frame.arena, frame.url, request_url);
    }

    pub fn cspAllowsDynamicModuleImport(self: Owner, request_url: [:0]const u8) bool {
        return switch (self) {
            .frame => true,
            .worker => |w| blk: {
                const policy = w._worker._script_csp orelse return true;
                const frame = w._worker._frame;
                break :blk policy.allowsDynamicImport(frame.arena, frame.url, request_url);
            },
        };
    }

    pub fn hasOpaqueOrigin(self: Owner) bool {
        return switch (self) {
            .frame => false,
            .worker => |w| w.origin == null,
        };
    }

    pub fn opaqueOriginAllowsModuleFetch(self: Owner, response: HttpClient.Response, request_url: []const u8) bool {
        if (!self.hasOpaqueOrigin()) return true;
        if (std.mem.startsWith(u8, request_url, "data:")) return true;
        var it = response.headerIterator();
        while (it.next()) |hdr| {
            if (std.ascii.eqlIgnoreCase(hdr.name, "access-control-allow-origin")) {
                return hdr.value.len > 0;
            }
        }
        return false;
    }
};

owner: Owner,

// used to prevent recursive evaluation
is_evaluating: bool,

// Only once this is true can deferred scripts be run
static_scripts_done: bool,

// Async scripts and dynamic import() fetches. Frame .async classic scripts
// execute in insertion order once each predecessor has finished loading
// (boq-identity and similar loaders inject many async scripts in dependency
// order but smaller chunks can finish downloading first).
async_scripts: std.DoublyLinkedList,

// List of deferred scripts. These must be executed in order, but only once
// dom_loaded == true. Workers never populate this list.
defer_scripts: std.DoublyLinkedList,

// When an async script is ready, it's queued here.
ready_scripts: std.DoublyLinkedList,

shutdown: bool = false,

client: *HttpClient,
allocator: Allocator,

/// Detached HTTP callback contexts whose Script arenas were released while a
/// transfer may still hold the ctx pointer. Freed on reset/deinit after kill+tick.
orphaned_http_ctxs: std.ArrayListUnmanaged(*Script.HttpCtx) = .empty,

// See ScriptManager.zig for the type's documentation.
imported_modules: std.StringHashMapUnmanaged(ImportedModule),

// Mapping between module specifier and resolution.
// see https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/script/type/importmap
// For workers this stays empty (only Frame authors importmaps via
// ScriptManager.parseImportmap).
importmap: std.StringHashMapUnmanaged([:0]const u8),

// Called at the end of evaluate() after all Base-owned work has run. Frame
// wrapper uses this to drain defer_scripts and fire documentIsLoaded /
// scriptsCompletedLoading. Null for workers.
tail_hook: ?*const fn (*ScriptManagerBase) void,

pub fn init(allocator: Allocator, http_client: *HttpClient, owner: Owner) ScriptManagerBase {
    return .{
        .owner = owner,
        .async_scripts = .{},
        .defer_scripts = .{},
        .ready_scripts = .{},
        .importmap = .empty,
        .is_evaluating = false,
        .allocator = allocator,
        .imported_modules = .empty,
        .client = http_client,
        .static_scripts_done = false,
        .tail_hook = null,
    };
}

pub fn deinit(self: *ScriptManagerBase) void {
    // necessary to free any arenas scripts may be referencing
    self.reset();
    self.reapOrphanedHttpCtxs();

    self.imported_modules.deinit(self.allocator);
    // we don't deinit self.importmap b/c we use the owner's arena for its
    // allocations.
}

/// `imported_modules` keys are always allocated with `allocator.dupeZ` (buffer
/// length = key.len + 1 for the NUL). Freeing them as plain `[]const u8` of
/// `key.len` triggers DebugAllocator "Invalid free" / off-by-one (seen on
/// nytimes.com when module preloads are reset mid-navigation).
fn freeImportedModuleKey(allocator: Allocator, key: []const u8) void {
    const z: [:0]const u8 = key.ptr[0..key.len :0];
    allocator.free(z);
}

fn clearImportedModules(self: *ScriptManagerBase) void {
    var it = self.imported_modules.iterator();
    while (it.next()) |entry| {
        switch (entry.value_ptr.state) {
            .done => |script| script.deinit(),
            else => {},
        }
        freeImportedModuleKey(self.allocator, entry.key_ptr.*);
    }
    self.imported_modules.clearRetainingCapacity();
}

pub fn reset(self: *ScriptManagerBase) void {
    clearImportedModules(self);

    // The importmap's keys/values were allocated from the owner's arena, which
    // has been reset. Can't use clearAndRetainCapacity — that space is no
    // longer ours.
    self.importmap = .empty;

    clearList(&self.defer_scripts);
    clearList(&self.async_scripts);
    clearList(&self.ready_scripts);
    self.static_scripts_done = false;
    // Script.deinit nulls HttpCtx.script; free the ctx shells after lists clear.
    self.reapOrphanedHttpCtxs();
}

fn reapOrphanedHttpCtxs(self: *ScriptManagerBase) void {
    for (self.orphaned_http_ctxs.items) |ctx| {
        self.allocator.destroy(ctx);
    }
    self.orphaned_http_ctxs.clearRetainingCapacity();
}

/// Allocate a stable HTTP callback context that outlives the Script arena.
/// Transfer.req.ctx points here so late error/done after Script.deinit is safe.
pub fn attachHttpCtx(self: *ScriptManagerBase, script: *Script) !*Script.HttpCtx {
    const ctx = try self.allocator.create(Script.HttpCtx);
    ctx.* = .{ .script = script, .manager = self };
    script.http_ctx = ctx;
    return ctx;
}

pub fn retireHttpCtx(self: *ScriptManagerBase, ctx: *Script.HttpCtx) void {
    ctx.script = null;
    self.orphaned_http_ctxs.append(self.allocator, ctx) catch {
        // Best-effort: free immediately if we cannot track it.
        self.allocator.destroy(ctx);
    };
}

fn clearList(list: *std.DoublyLinkedList) void {
    while (list.popFirst()) |n| {
        const script: *Script = @fieldParentPtr("node", n);
        script.deinit();
    }
}

pub const ModuleReferrerKind = enum {
    none,
    worker_static,
    worker_dynamic,
};

fn moduleReferrerKind(self: *const ScriptManagerBase) ModuleReferrerKind {
    return switch (self.owner) {
        .worker => .worker_static,
        .frame => .none,
    };
}

pub fn getHeaders(
    self: *ScriptManagerBase,
    request_url: [:0]const u8,
    resource_type: HttpClient.RequestParams.ResourceType,
    referrer_kind: ModuleReferrerKind,
) !http.Headers {
    var headers = try self.client.newHeaders();
    const referrer_opts: Frame.HeadersForRequestOpts = switch (referrer_kind) {
        .none => .{ .request_url = request_url, .resource_type = resource_type },
        .worker_static => blk: {
            const frame = self.owner.parentFrame();
            break :blk .{
                .request_url = request_url,
                .resource_type = resource_type,
                .referrer_source_url = self.owner.url(),
                .referrer_policy = frame.referrer_policy,
            };
        },
        .worker_dynamic => blk: {
            break :blk switch (self.owner) {
                .worker => |w| .{
                    .request_url = request_url,
                    .resource_type = resource_type,
                    .referrer_source_url = self.owner.url(),
                    .referrer_policy = w._worker._referrer_policy,
                },
                .frame => .{ .request_url = request_url, .resource_type = resource_type },
            };
        },
    };
    try self.owner.addHeaders(&headers, referrer_opts);
    return headers;
}

fn acquireArena(self: *ScriptManagerBase, size_or_bucket: anytype, debug: []const u8) !Allocator {
    return self.owner.session().getArena(size_or_bucket, debug);
}

fn releaseArena(self: *ScriptManagerBase, arena: Allocator) void {
    self.owner.session().releaseArena(arena);
}

pub fn scriptList(self: *ScriptManagerBase, script: *const Script) *std.DoublyLinkedList {
    return switch (script.extra) {
        .import, .import_async => &self.async_scripts,
        .frame => |fe| switch (fe.mode) {
            .normal => unreachable, // not added to a list, executed immediately
            .@"defer" => &self.defer_scripts,
            .async => &self.async_scripts,
        },
    };
}

// Resolve a module specifier to a valid URL.
fn completeDataUrlModuleScript(self: *ScriptManagerBase, script: *Script, owned_url: [:0]const u8) !void {
    const body = WorkerGlobalScope.decodeDataUrlJavaScript(script.arena, owned_url) catch {
        self.async_scripts.remove(&script.node);
        if (self.imported_modules.getPtr(owned_url)) |entry| {
            entry.state = .err;
        }
        script.deinit();
        return;
    };
    script.status = 200;
    script.complete = true;
    try script.source.remote.appendSlice(script.arena, body);
    self.async_scripts.remove(&script.node);
    const entry = self.imported_modules.getPtr(owned_url) orelse {
        script.deinit();
        return error.UnknownModule;
    };
    entry.state = .{ .done = script };
    entry.buffer = script.source.remote;
}

pub fn resolveSpecifier(self: *ScriptManagerBase, arena: Allocator, base: [:0]const u8, specifier: [:0]const u8) ![:0]const u8 {
    // If the specifier is mapped in the importmap, return the pre-resolved
    // value. For workers this map is empty.
    if (self.importmap.get(specifier)) |s| {
        return s;
    }

    return URL.resolve(arena, base, specifier, .{ .always_dupe = true });
}

pub fn preloadImport(self: *ScriptManagerBase, url: [:0]const u8, referrer: []const u8) !void {
    switch (self.owner) {
        .worker => {
            if (!self.owner.cspAllowsStaticModuleImport(url)) {
                const gop = try self.imported_modules.getOrPut(self.allocator, url);
                if (!gop.found_existing) {
                    const owned_url = try self.allocator.dupeZ(u8, url);
                    gop.key_ptr.* = owned_url;
                    gop.value_ptr.* = .{ .state = .err };
                }
                return;
            }
        },
        .frame => {},
    }

    if (self.imported_modules.get(url)) |entry| {
        switch (entry.state) {
            .done, .loading => {
                log.debug(.js, "module cache hit", .{ .url = url, .state = @tagName(entry.state) });
                return;
            },
            .err => {
                if (self.imported_modules.fetchRemove(url)) |kv| {
                    freeImportedModuleKey(self.allocator, kv.key);
                }
            },
        }
    }

    const gop = try self.imported_modules.getOrPut(self.allocator, url);
    if (gop.found_existing) {
        return;
    }
    errdefer _ = self.imported_modules.remove(url);
    const owned_url = try self.allocator.dupeZ(u8, url);
    gop.key_ptr.* = owned_url;
    errdefer if (self.imported_modules.fetchRemove(owned_url)) |kv| {
        freeImportedModuleKey(self.allocator, kv.key);
    };

    const arena = try self.acquireArena(.large, "SM.preloadImport");
    errdefer self.releaseArena(arena);

    const script = try arena.create(Script);
    script.* = .{
        .arena = arena,
        .url = owned_url,
        .node = .{},
        .manager = self,
        .complete = false,
        .source = .{ .remote = .{} },
        .extra = .import,
        .guard = LoadGuard.Guard.init(&self.owner.jsContext().execution),
    };

    gop.value_ptr.* = ImportedModule{};
    log.debug(.js, "module fetch", .{ .url = url, .ptr = @intFromPtr(gop.value_ptr), .from = @tagName(gop.value_ptr.state), .to = "fetching" });

    if (comptime IS_DEBUG) {
        var ls: js.Local.Scope = undefined;
        self.owner.jsContext().localScope(&ls);
        defer ls.deinit();

        log.debug(.http, "script queue", .{
            .url = url,
            .ctx = "module",
            .referrer = referrer,
            .stack = ls.local.stackTrace() catch "???",
        });
    }

    // This seems wrong since we're not dealing with an async import (unlike
    // getAsyncModule below), but all we're trying to do here is pre-load the
    // script for execution at some point in the future (when waitForImport is
    // called).
    self.async_scripts.append(&script.node);

    if (std.mem.startsWith(u8, owned_url, "data:")) {
        try self.completeDataUrlModuleScript(script, owned_url);
        return;
    }

    const session = self.owner.session();
    const http_ctx = try self.attachHttpCtx(script);
    self.client.request(.{
        .ctx = http_ctx,
        .params = .{
            .url = owned_url,
            .method = .GET,
            .frame_id = self.owner.frameId(),
            .attribution_frame = self.owner.attributionFrame(),
            .loader_id = self.owner.loaderId(),
            .headers = try self.getHeaders(owned_url, .script, self.moduleReferrerKind()),
            .cookie_jar = &session.cookie_jar,
            .cookie_origin = self.owner.url(),
            .top_level_cookie_url = self.owner.topLevelCookieUrl(),
            .omit_cookies = self.owner.omitCookies(owned_url),
            .resource_type = .script,
            .notification = session.notification,
        },
        .start_callback = if (log.enabled(.http, .debug)) Script.HttpCtx.startCallback else null,
        .header_callback = Script.HttpCtx.headerCallback,
        .data_callback = Script.HttpCtx.dataCallback,
        .done_callback = Script.HttpCtx.doneCallback,
        .error_callback = Script.HttpCtx.errorCallback,
        .shutdown_callback = Script.HttpCtx.shutdownCallback,
    }) catch |err| {
        self.async_scripts.remove(&script.node);
        script.http_ctx = null;
        self.retireHttpCtx(http_ctx);
        return err;
    };
}

pub fn waitForImport(self: *ScriptManagerBase, url: [:0]const u8) !ModuleSource {
    const entry = self.imported_modules.getEntry(url) orelse {
        // It shouldn't be possible for v8 to ask for a module that we didn't
        // `preloadImport` above.
        return error.UnknownModule;
    };

    const was_evaluating = self.is_evaluating;
    self.is_evaluating = true;
    defer self.is_evaluating = was_evaluating;

    var client = self.client;
    while (true) {
        switch (entry.value_ptr.state) {
            .loading => {
                _ = try client.tick(200);
                continue;
            },
            .done => |script| {
                log.debug(.js, "module cache hit", .{ .url = url, .state = @tagName(entry.value_ptr.state), .ptr = @intFromPtr(entry.value_ptr) });
                return .{
                    .buffer = entry.value_ptr.buffer,
                    .shared = true,
                    .script = script,
                };
            },
            .err => return error.Failed,
        }
    }
}

pub fn getAsyncImport(self: *ScriptManagerBase, url: [:0]const u8, cb: ImportAsync.Callback, cb_data: *anyopaque, referrer: []const u8) !void {
    if (!self.owner.cspAllowsDynamicModuleImport(url)) {
        cb(cb_data, error.Failed);
        return;
    }

    if (std.mem.startsWith(u8, url, "data:")) {
        const arena = try self.acquireArena(.large, "SM.getAsyncImport.data");
        errdefer self.releaseArena(arena);
        const body = WorkerGlobalScope.decodeDataUrlJavaScript(arena, url) catch {
            cb(cb_data, error.Failed);
            return;
        };
        const script = try arena.create(Script);
        var buffer: std.ArrayList(u8) = .empty;
        try buffer.appendSlice(arena, body);
        script.* = .{
            .arena = arena,
            .url = url,
            .node = .{},
            .manager = self,
            .complete = true,
            .status = 200,
            .source = .{ .remote = buffer },
            .extra = .{ .import_async = .{
                .callback = cb,
                .data = cb_data,
            } },
            .guard = LoadGuard.Guard.init(&self.owner.jsContext().execution),
        };
        cb(cb_data, .{
            .shared = false,
            .script = script,
            .buffer = buffer,
        });
        return;
    }

    const arena = try self.acquireArena(.large, "SM.getAsyncImport");
    errdefer self.releaseArena(arena);

    const script = try arena.create(Script);
    script.* = .{
        .arena = arena,
        .url = url,
        .node = .{},
        .manager = self,
        .complete = false,
        .source = .{ .remote = .{} },
        .extra = .{ .import_async = .{
            .callback = cb,
            .data = cb_data,
        } },
        .guard = LoadGuard.Guard.init(&self.owner.jsContext().execution),
    };

    if (comptime IS_DEBUG) {
        var ls: js.Local.Scope = undefined;
        self.owner.jsContext().localScope(&ls);
        defer ls.deinit();

        log.debug(.http, "script queue", .{
            .url = url,
            .ctx = "dynamic module",
            .referrer = referrer,
            .stack = ls.local.stackTrace() catch "???",
        });
    }

    // It's possible, but unlikely, for client.request to immediately finish
    // a request, thus calling our callback. We generally don't want a call
    // from v8 (which is why we're here), to result in a new script evaluation.
    // So we block even the slightest change that `client.request` immediately
    // executes a callback.
    const was_evaluating = self.is_evaluating;
    self.is_evaluating = true;
    defer self.is_evaluating = was_evaluating;

    const session = self.owner.session();
    self.async_scripts.append(&script.node);
    const http_ctx = try self.attachHttpCtx(script);
    self.client.request(.{
        .ctx = http_ctx,
        .params = .{
            .url = url,
            .method = .GET,
            .frame_id = self.owner.frameId(),
            .attribution_frame = self.owner.attributionFrame(),
            .loader_id = self.owner.loaderId(),
            .headers = try self.getHeaders(url, .script, .worker_dynamic),
            .resource_type = .script,
            .cookie_jar = &session.cookie_jar,
            .cookie_origin = self.owner.url(),
            .top_level_cookie_url = self.owner.topLevelCookieUrl(),
            .omit_cookies = self.owner.omitCookies(url),
            .notification = session.notification,
        },
        .start_callback = if (log.enabled(.http, .debug)) Script.HttpCtx.startCallback else null,
        .header_callback = Script.HttpCtx.headerCallback,
        .data_callback = Script.HttpCtx.dataCallback,
        .done_callback = Script.HttpCtx.doneCallback,
        .error_callback = Script.HttpCtx.errorCallback,
        .shutdown_callback = Script.HttpCtx.shutdownCallback,
    }) catch |err| {
        self.async_scripts.remove(&script.node);
        script.http_ctx = null;
        self.retireHttpCtx(http_ctx);
        return err;
    };
}

// Called from the Page / Frame to signal it's done parsing the HTML, so
// deferred scripts can start evaluating. Workers never call this.
pub fn staticScriptsDone(self: *ScriptManagerBase) void {
    assert(self.static_scripts_done == false, "ScriptManagerBase.staticScriptsDone", .{});
    self.static_scripts_done = true;
    if (!self.evaluateOneScript()) {
        if (self.tail_hook) |hook| hook(self);
        return;
    }
    self.scheduleEvaluateSlice() catch {
        self.evaluate();
    };
}

const EvaluateSliceCallback = struct {
    manager: *ScriptManagerBase,

    fn run(ctx: *anyopaque) !?u32 {
        const self: *EvaluateSliceCallback = @ptrCast(@alignCast(ctx));
        if (!self.manager.evaluateOneScript()) {
            if (self.manager.tail_hook) |hook| hook(self.manager);
            return null;
        }
        self.manager.scheduleEvaluateSlice() catch {
            self.manager.evaluate();
        };
        return null;
    }
};

fn scheduleEvaluateSlice(self: *ScriptManagerBase) !void {
    const frame = self.owner.parentFrame();
    const callback = try frame.arena.create(EvaluateSliceCallback);
    callback.* = .{ .manager = self };
    try frame.js.scheduler.add(callback, EvaluateSliceCallback.run, 0, .{
        .name = "ScriptManager.evaluateSlice",
        .low_priority = false,
    });
}

fn hasPendingEvaluateWork(self: *ScriptManagerBase) bool {
    if (self.async_scripts.first) |n| {
        const script: *Script = @fieldParentPtr("node", n);
        switch (script.extra) {
            .frame => |fe| {
                if (fe.mode == .async and script.complete) return true;
            },
            else => {},
        }
    }
    if (self.ready_scripts.first != null) return true;
    if (!self.static_scripts_done) return false;
    if (self.defer_scripts.first) |n| {
        const script: *Script = @fieldParentPtr("node", n);
        if (script.complete) return true;
    }
    return false;
}

/// Run at most one ready/defer/async script. CDP interleaving: each slice ends
/// on a scheduler turn so inbound Runtime.evaluate is not starved (ebay.com).
fn evaluateOneScript(self: *ScriptManagerBase) bool {
    if (self.is_evaluating) return self.hasPendingEvaluateWork();
    self.is_evaluating = true;
    defer self.is_evaluating = false;

    if (self.async_scripts.first) |n| {
        var script: *Script = @fieldParentPtr("node", n);
        switch (script.extra) {
            .frame => |fe| {
                if (fe.mode != .async or !script.complete) return false;
                _ = self.async_scripts.popFirst();
                defer script.deinit();
                script.eval();
                self.serviceCdpInbound();
                return self.hasPendingEvaluateWork();
            },
            else => return false,
        }
    }

    if (self.ready_scripts.popFirst()) |n| {
        var script: *Script = @fieldParentPtr("node", n);
        switch (script.extra) {
            .frame => {
                defer script.deinit();
                script.eval();
                self.serviceCdpInbound();
                return self.hasPendingEvaluateWork();
            },
            .import_async => |ia| {
                if (script.status < 200 or script.status > 299) {
                    script.deinit();
                    ia.callback(ia.data, error.FailedToLoad);
                } else {
                    ia.callback(ia.data, .{
                        .shared = false,
                        .script = script,
                        .buffer = script.source.remote,
                    });
                }
                self.serviceCdpInbound();
                return self.hasPendingEvaluateWork();
            },
            .import => unreachable,
        }
    }

    if (!self.static_scripts_done) return false;

    if (self.defer_scripts.first) |n| {
        var script: *Script = @fieldParentPtr("node", n);
        if (!script.complete) return false;
        _ = self.defer_scripts.popFirst();
        defer script.deinit();
        script.eval();
        self.serviceCdpInbound();
        return self.hasPendingEvaluateWork();
    }

    return false;
}

/// Run downloaded frame `.async` scripts in insertion order. Callable while a
/// sync parent script is still evaluating — boq injects dependency chunks
/// during bootstrap and expects them to run before the parent continues.
pub fn drainOrderedAsyncScripts(self: *ScriptManagerBase) void {
    drain_async: while (self.async_scripts.first) |n| {
        var script: *Script = @fieldParentPtr("node", n);
        switch (script.extra) {
            .frame => |fe| {
                if (fe.mode != .async) break :drain_async;
                if (!script.complete) break :drain_async;
                _ = self.async_scripts.popFirst();
                defer script.deinit();
                script.eval();
            },
            else => break :drain_async,
        }
    }
}

fn serviceCdpInbound(self: *ScriptManagerBase) void {
    self.client.serviceInboundCdpIfReadable();
}

pub fn evaluate(self: *ScriptManagerBase) void {
    if (self.is_evaluating) {
        // Defer/defer_scripts/tail_hook must not run during sync script eval.
        // Async chunks still drain from doneCallback via drainOrderedAsyncScripts.
        return;
    }

    self.is_evaluating = true;
    defer self.is_evaluating = false;

    self.drainOrderedAsyncScripts();

    while (self.ready_scripts.popFirst()) |n| {
        var script: *Script = @fieldParentPtr("node", n);
        switch (script.extra) {
            .frame => {
                // Only .async mode reaches ready_scripts (defer stays in
                // defer_scripts, normal is sync and never queued).
                defer script.deinit();
                script.eval();
                self.serviceCdpInbound();
            },
            .import_async => |ia| {
                if (script.status < 200 or script.status > 299) {
                    script.deinit();
                    ia.callback(ia.data, error.FailedToLoad);
                } else {
                    ia.callback(ia.data, .{
                        .shared = false,
                        .script = script,
                        .buffer = script.source.remote,
                    });
                }
            },
            .import => unreachable, // .import doesn't go through ready_scripts
        }
    }

    if (self.static_scripts_done == false) {
        // We can only execute deferred scripts if
        // 1 - all the normal scripts are done
        // 2 - we've finished parsing the HTML and at least queued all the scripts
        // The last one isn't obvious, but it's possible for self.scripts to
        // be empty not because we're done executing all the normal scripts
        // but because we're done executing some (or maybe none), but we're still
        // parsing the HTML.
        return;
    }

    while (self.defer_scripts.first) |n| {
        var script: *Script = @fieldParentPtr("node", n);
        if (script.complete == false) return;
        defer {
            _ = self.defer_scripts.popFirst();
            script.deinit();
        }
        // Only frame scripts populate defer_scripts.
        script.eval();
        self.serviceCdpInbound();
    }

    // Frame wrapper uses this to fire documentIsLoaded and
    // scriptsCompletedLoading. Null for workers.
    if (self.tail_hook) |hook| hook(self);
}

pub const Script = struct {
    complete: bool,
    status: u16 = 0,
    source: Source,
    url: []const u8,
    arena: Allocator,
    extra: Extra,
    node: std.DoublyLinkedList.Node,
    manager: *ScriptManagerBase,
    guard: LoadGuard.Guard,
    /// Stable HTTP callback shell (manager.allocator). Null after detach.
    http_ctx: ?*HttpCtx = null,

    // for debugging a rare production issue
    header_callback_called: bool = false,

    // for debugging a rare production issue
    debug_transfer_id: u32 = 0,
    debug_transfer_tries: u8 = 0,
    debug_transfer_aborted: bool = false,
    debug_transfer_bytes_received: usize = 0,
    debug_transfer_notified_fail: bool = false,
    debug_transfer_auth_challenge: bool = false,
    debug_transfer_easy_id: usize = 0,

    pub const Source = union(enum) {
        @"inline": []const u8,
        remote: std.ArrayList(u8),

        pub fn content(self: Source) []const u8 {
            return switch (self) {
                .remote => |buf| buf.items,
                .@"inline" => |c| c,
            };
        }
    };

    // The mode-specific extension. Only `.frame` carries frame-only state
    // (script_element, kind, *Frame); workers and dynamic JS imports use
    // `.import` / `.import_async` and never reach the .frame arm.
    pub const Extra = union(enum) {
        // Static module import — V8 resolution via imported_modules.
        import,
        // Dynamic JS import() — resolved via ready_scripts callback.
        import_async: ImportAsync,
        // <script> tag in a frame.
        frame: FrameExtra,

        pub const FrameExtra = struct {
            kind: Kind,
            mode: Mode,
            frame: *Frame,
            script_element: *Element.Html.Script,

            pub const Kind = enum {
                module,
                javascript,
                importmap,
            };

            pub const Mode = enum {
                // sync <script src="..."> — blocks parsing, evaluated
                // immediately at the end of addFromElement via syncRequest.
                normal,
                // <script defer> / <script type=module> — queued in
                // defer_scripts, drained in document order.
                @"defer",
                // <script async> / dynamically-inserted scripts — queued in
                // async_scripts; doneCallback marks complete and evaluate()
                // drains in insertion order.
                async,
            };
        };
    };

    fn execution(self: *const Script) *js.Execution {
        return switch (self.extra) {
            .frame => |fe| &fe.frame.js.execution,
            else => &self.manager.owner.jsContext().execution,
        };
    }

    fn deliverable(self: *const Script) bool {
        if (self.guard.isFinished()) return false;
        if (self.manager.shutdown) return false;
        return switch (self.extra) {
            // HTTP terminal callbacks can run after navigation abort while the
            // Script ctx is still alive. Do not read fe.frame — use manager.owner
            // (authoritative frame for this script manager) and bail on null.
            .frame => deliverableFrameScript(self),
            else => self.guard.isDeliverable(self.execution(), .{
                .manager_shutdown = false,
            }),
        };
    }

    fn deliverableFrameScript(self: *const Script) bool {
        const owner = self.manager.owner;
        const frame = owner.parentFrame();
        if (@intFromPtr(frame) == 0) return false;
        return self.guard.isDeliverableForRealm(owner.captureTaskOwner(), .{
            .manager_shutdown = false,
            .realm_dead_or_draining = frame._realm_state == .dead or frame._realm_state == .draining,
            .going_away = frame.isGoingAway(),
        });
    }

    /// Authoritative frame for frame-attached scripts — never read fe.frame after
    /// navigation abort / commitPendingPage may have torn the extra pointer down.
    fn activeFrame(self: *const Script) ?*Frame {
        if (self.guard.isFinished()) return null;
        if (self.manager.shutdown) return null;
        return switch (self.extra) {
            .frame => blk: {
                const frame = self.manager.owner.parentFrame();
                if (@intFromPtr(frame) == 0) return null;
                if (frame.isGoingAway()) return null;
                if (frame._realm_state == .dead or frame._realm_state == .draining) return null;
                break :blk frame;
            },
            else => null,
        };
    }

    pub fn deinit(self: *Script) void {
        if (self.guard.isFinished()) return;
        self.guard.finished = true;
        // Detach HTTP ctx *before* freeing the Script arena so late transfer
        // callbacks see script == null instead of UAF (nytimes.com).
        if (self.http_ctx) |ctx| {
            self.http_ctx = null;
            self.manager.retireHttpCtx(ctx);
        }
        self.manager.releaseArena(self.arena);
    }

    fn frameIsGoingAway(self: *const Script) bool {
        return switch (self.extra) {
            .frame => |fe| fe.frame.isGoingAway(),
            else => false,
        };
    }

    /// HTTP callback context allocated with ScriptManager.allocator so it
    /// outlives Script arenas released on navigation/reset.
    pub const HttpCtx = struct {
        script: ?*Script,
        manager: *ScriptManagerBase,

        fn scriptOrNull(ctx: *anyopaque) ?*Script {
            const self: *HttpCtx = @ptrCast(@alignCast(ctx));
            const script = self.script orelse return null;
            if (script.guard.isFinished()) return null;
            return script;
        }

        pub fn shutdownCallback(ctx: *anyopaque) void {
            const self: *HttpCtx = @ptrCast(@alignCast(ctx));
            const script = self.script orelse return;
            // Null first so re-entrant paths cannot re-enter Script after free.
            self.script = null;
            if (script.http_ctx == self) script.http_ctx = null;
            if (!script.guard.isFinished()) {
                script.manager.scriptList(script).remove(&script.node);
                // deinit skips retire when http_ctx already nulled; we own free.
                script.guard.finished = true;
                script.manager.releaseArena(script.arena);
            }
            self.manager.retireHttpCtx(self);
        }

        pub fn startCallback(response: HttpClient.Response) !void {
            log.debug(.http, "script fetch start", .{ .req = response });
        }

        pub fn headerCallback(response: HttpClient.Response) !bool {
            const script = scriptOrNull(response.ctx) orelse return false;
            return script.headerCallback(response);
        }

        pub fn dataCallback(response: HttpClient.Response, data: []const u8) !void {
            const script = scriptOrNull(response.ctx) orelse return;
            try script.dataCallback(response, data);
        }

        pub fn doneCallback(ctx: *anyopaque) !void {
            const self: *HttpCtx = @ptrCast(@alignCast(ctx));
            const script = self.script orelse return;
            if (script.guard.isFinished()) return;
            try script.doneCallback();
        }

        pub fn errorCallback(ctx: *anyopaque, err: anyerror) void {
            const self: *HttpCtx = @ptrCast(@alignCast(ctx));
            const script = self.script orelse return;
            if (script.guard.isFinished()) return;
            script.errorCallback(err);
        }
    };

    pub fn shutdownCallback(ctx: *anyopaque) void {
        // Legacy direct Script ctx path (should not be used for new requests).
        const self: *Script = @ptrCast(@alignCast(ctx));
        if (self.guard.isFinished()) return;
        self.manager.scriptList(self).remove(&self.node);
        self.deinit();
    }

    pub fn startCallback(response: HttpClient.Response) !void {
        log.debug(.http, "script fetch start", .{ .req = response });
    }

    pub fn headerCallback(self: *Script, response: HttpClient.Response) !bool {
        self.status = response.status().?;
        if (response.status() != 200) {
            log.info(.http, "script header", .{
                .req = response,
                .status = response.status(),
                .content_type = response.contentType(),
            });
            return false;
        }

        if (self.extra == .import_async and
            !self.manager.owner.opaqueOriginAllowsModuleFetch(response, self.url))
        {
            log.debug(.http, "opaque origin dynamic import blocked", .{ .url = self.url });
            return false;
        }

        if (comptime IS_DEBUG) {
            log.debug(.http, "script header", .{
                .req = response,
                .status = response.status(),
                .content_type = response.contentType(),
            });
        }

        switch (response.inner) {
            .transfer => |transfer| {
                // temp debug, trying to figure out why the next assert sometimes
                // fails. Is the buffer just corrupt or is headerCallback really
                // being called twice?
                assert(self.header_callback_called == false, "ScriptManagerBase.Header recall", .{
                    .m = @tagName(std.meta.activeTag(self.extra)),
                    .a1 = self.debug_transfer_id,
                    .a2 = self.debug_transfer_tries,
                    .a3 = self.debug_transfer_aborted,
                    .a4 = self.debug_transfer_bytes_received,
                    .a5 = self.debug_transfer_notified_fail,
                    .a8 = self.debug_transfer_auth_challenge,
                    .a9 = self.debug_transfer_easy_id,
                    .b1 = transfer.id,
                    .b2 = transfer._tries,
                    .b3 = transfer.aborted,
                    .b4 = transfer.bytes_received,
                    .b5 = transfer._notified_fail,
                    .b8 = transfer._auth_challenge != null,
                    .b9 = if (transfer._conn) |c| @intFromPtr(c._easy) else 0,
                });
                self.header_callback_called = true;
                self.debug_transfer_id = transfer.id;
                self.debug_transfer_tries = transfer._tries;
                self.debug_transfer_aborted = transfer.aborted;
                self.debug_transfer_bytes_received = transfer.bytes_received;
                self.debug_transfer_notified_fail = transfer._notified_fail;
                self.debug_transfer_auth_challenge = transfer._auth_challenge != null;
                self.debug_transfer_easy_id = if (transfer._conn) |c| @intFromPtr(c._easy) else 0;
            },
            else => {},
        }

        assert(self.source.remote.capacity == 0, "ScriptManagerBase.Header buffer", .{ .capacity = self.source.remote.capacity });
        var buffer: std.ArrayList(u8) = .empty;
        if (response.contentLength()) |cl| {
            try buffer.ensureTotalCapacity(self.arena, cl);
        }
        self.source = .{ .remote = buffer };
        return true;
    }

    pub fn dataCallback(self: *Script, response: HttpClient.Response, data: []const u8) !void {
        self._dataCallback(response, data) catch |err| {
            log.err(.http, "SM.dataCallback", .{ .err = err, .transfer = response, .len = data.len });
            return err;
        };
    }

    fn _dataCallback(self: *Script, _: HttpClient.Response, data: []const u8) !void {
        try self.source.remote.appendSlice(self.arena, data);
    }

    pub fn doneCallback(self: *Script) !void {
        if (self.guard.isFinished() or self.manager.shutdown) return;
        if (!self.deliverable()) return;
        self.complete = true;
        if (comptime IS_DEBUG) {
            log.debug(.http, "script fetch complete", .{ .req = self.url });
        }

        const manager = self.manager;
        switch (self.extra) {
            .frame => |fe| switch (fe.mode) {
                .async => manager.drainOrderedAsyncScripts(),
                .@"defer" => {}, // stays in defer_scripts; drained in order
                .normal => unreachable, // syncRequest path doesn't go through callbacks
            },
            .import_async => {
                manager.async_scripts.remove(&self.node);
                manager.ready_scripts.append(&self.node);
            },
            .import => {
                manager.async_scripts.remove(&self.node);
                const entry = manager.imported_modules.getPtr(self.url) orelse {
                    log.warn(.http, "module fetch done but entry missing", .{ .url = self.url });
                    self.deinit();
                    return;
                };
                log.debug(.js, "module fetch", .{ .url = self.url, .ptr = @intFromPtr(entry), .from = @tagName(entry.state), .to = "fetched" });
                entry.state = .{ .done = self };
                entry.buffer = self.source.remote;
            },
        }
        if (!manager.shutdown) manager.evaluate();
    }

    pub fn errorCallback(self: *Script, err: anyerror) void {
        // Guard first: after kill/shutdown/reset the Script arena may already
        // be finished. deliverable() reads finished before any other fields.
        if (self.guard.isFinished()) return;
        if (self.manager.shutdown) {
            // Navigation/teardown already owns cleanup (clearList / kill
            // shutdown_callback). Do not remove from lists or evaluate.
            self.deinit();
            return;
        }
        if (!self.deliverable()) return;
        const manager = self.manager;
        if (self.status == 404) {
            log.info(.http, "script 404", .{
                .req = self.url,
                .extra = std.meta.activeTag(self.extra),
            });
        } else {
            log.warn(.http, "script fetch error", .{
                .err = err,
                .req = self.url,
                .extra = std.meta.activeTag(self.extra),
                .status = self.status,
            });
        }

        if (self.extra == .frame and self.extra.frame.mode == .normal) {
            // This is blocked in a loop at the end of addFromElement, setting
            // it to complete with a status of 0 will signal the error.
            self.status = 0;
            self.complete = true;
            return;
        }

        manager.scriptList(self).remove(&self.node);

        switch (self.extra) {
            .import_async => |ia| {
                if (self.deliverable()) ia.callback(ia.data, error.FailedToLoad);
            },
            .import => {
                if (manager.imported_modules.getPtr(self.url)) |entry| {
                    entry.state = .err;
                }
            },
            // Frame <script> fetch failures must not re-enter evaluate() from the
            // HTTP tick. defer_scripts are drained from doneCallback /
            // staticScriptsDone; calling evaluate here raced aborted transfers
            // (e.g. BBC Optimizely) into V8 entry while the realm was still
            // initializing and segfaulted in compile.
            .frame => {
                self.deinit();
                return;
            },
        }
        self.deinit();
        if (!manager.shutdown) manager.evaluate();
    }

    fn pumpScriptScheduler(frame: *Frame, local: *const js.Local) void {
        // Fingerprint loader yb() may schedule 10ms iframe polls at the tail of
        // a long eval; drain overdue timers in a few passes so Y.ip settles.
        var pass: u8 = 0;
        while (pass < 12) : (pass += 1) {
            _ = frame.js.scheduler.run() catch |err| {
                log.err(.frame, "scheduler", .{ .err = err });
                break;
            };
            local.ctx.env.runMicrotasks(.after_evaluate);
            frame.pollCdpDuringLongWork();
            if (!frame.js.scheduler.hasReadyTasks()) break;
        }
    }

    // Frame-only. Asserts extra == .frame; callers from the worker path never
    // reach here (workers only produce .import / .import_async).
    pub fn eval(self: *Script) void {
        const fe = self.extra.frame;
        const frame = self.activeFrame() orelse return;

        const previous_script = frame.document._current_script;
        frame.document._current_script = fe.script_element;
        defer frame.document._current_script = previous_script;

        // Clear the document.write insertion point for this script
        const previous_write_insertion_point = frame.document._write_insertion_point;
        frame.document._write_insertion_point = null;
        defer frame.document._write_insertion_point = previous_write_insertion_point;

        // inline scripts aren't cached. remote ones are.
        const cacheable = self.source == .remote;

        const url = self.url;

        log.info(.browser, "executing script", .{
            .src = url,
            .kind = fe.kind,
            .cacheable = cacheable,
        });

        var ls: js.Local.Scope = undefined;
        frame.js.localScope(&ls);
        defer ls.deinit();

        const local = &ls.local;

        // Handle importmap special case here: the content is a JSON containing
        // imports.
        if (fe.kind == .importmap) {
            frame._script_manager.parseImportmap(self) catch |err| {
                log.err(.browser, "parse importmap script", .{
                    .err = err,
                    .src = url,
                    .kind = fe.kind,
                    .cacheable = cacheable,
                });
                self.executeCallback(comptime .wrap("error"));
                return;
            };
            self.executeCallback(comptime .wrap("load"));
            return;
        }

        defer frame._event_manager.clearIgnoreList();

        const success = blk: {
            const content = self.source.content();
            if (jsCallLogEnabled()) {
                log.info(.js, "script call log source", .{ .src = url, .kind = fe.kind });
            }
            switch (fe.kind) {
                .javascript => {
                    const eval_content = blk2: {
                        if (jsCallLogEnabled()) {
                            break :blk2 instrumentClassicScript(frame.call_arena, content, url) catch break :blk false;
                        }
                        if (self.manager.is_evaluating and GoogleSigninDebug.isBoqScript(url)) {
                            break :blk2 GoogleSigninDebug.prependBoqEvalShim(frame.call_arena, content) catch break :blk false;
                        }
                        break :blk2 content;
                    };
                    _ = local.eval(eval_content, url) catch |err| {
                        log.warn(.js, "eval script", .{ .url = url, .err = err, .cacheable = cacheable });
                        break :blk false;
                    };
                    frame.drainMicrotasksAfterDomInsertion();
                },
                .module => {
                    // We don't care about waiting for the evaluation here.
                    const module_url = if (cacheable)
                        URL.resolve(frame.js.arena, frame.base(), url, .{ .always_dupe = true }) catch break :blk false
                    else
                        url;
                    frame.js.module(false, local, content, module_url, cacheable) catch break :blk false;
                },
                .importmap => unreachable, // handled before the try/catch.
            }
            break :blk true;
        };

        if (comptime IS_DEBUG) {
            log.debug(.browser, "executed script", .{ .src = url, .success = success });
        }

        defer {
            // Parser-inserted scripts: defer microtasks + timers until the HTML
            // parser finishes (Blink/Chromium). knitsail reads readyState at nav.
            const env = local.ctx.env;
            const should_pump = !frame.isDocumentParsing() or !Frame.isGoogleKnitsailHost(frame.url);
            if (should_pump) {
                pumpScriptScheduler(frame, local);
                if (!frame.isDocumentParsing()) {
                    local.runMacrotasks();
                }
                // Fingerprint yb() resolves its iframe Promise after appendChild
                // returns; await continuations need multiple checkpoint passes.
                var pass: u8 = 0;
                while (pass < 8) : (pass += 1) {
                    env.runMicrotasks(.after_evaluate);
                    if (!env.checkpoint_pending) break;
                }
            }
        }

        if (success) {
            if (fe.kind == .javascript and GoogleSigninDebug.isBoqScript(url) and GoogleSigninDebug.isAccountsGoogleUrl(frame.url)) {
                _ = local.eval(GoogleSigninDebug.boq_zc_shim, "boq-zc-shim") catch {};
            }
            self.executeCallback(comptime .wrap("load"));
            return;
        }

        self.executeCallback(comptime .wrap("error"));
    }

    fn executeCallback(self: *const Script, typ: String) void {
        const fe = self.extra.frame;
        const frame = self.activeFrame() orelse return;
        const Event = @import("../webapi/Event.zig");
        const event = Event.initTrusted(typ, .{}, frame._page) catch |err| {
            log.warn(.js, "script internal callback", .{
                .url = self.url,
                .type = typ,
                .err = err,
            });
            return;
        };
        frame._event_manager.dispatchOpts(fe.script_element.asNode().asEventTarget(), event, .{ .apply_ignore = true }) catch |err| {
            log.warn(.js, "script callback", .{
                .url = self.url,
                .type = typ,
                .err = err,
            });
        };
    }
};

pub const ImportAsync = struct {
    data: *anyopaque,
    callback: ImportAsync.Callback,

    pub const Callback = *const fn (ptr: *anyopaque, result: anyerror!ModuleSource) void;
};

pub const ModuleSource = struct {
    shared: bool,
    script: *Script,
    buffer: std.ArrayList(u8),

    pub fn deinit(self: *ModuleSource) void {
        if (self.shared == false) {
            self.script.deinit();
        }
    }

    pub fn src(self: *const ModuleSource) []const u8 {
        return self.buffer.items;
    }
};

pub const ImportedModule = struct {
    state: State = .loading,
    buffer: std.ArrayList(u8) = .{},

    pub const State = union(enum) {
        err,
        loading,
        done: *Script,
    };
};
