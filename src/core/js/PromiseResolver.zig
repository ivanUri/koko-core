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

const js = @import("js.zig");
const Env = @import("Env.zig");
const builtin = @import("builtin");

const DOMException = @import("../dom/DOMException.zig");

const v8 = js.v8;
const log = @import("../../support/log.zig");

const PromiseResolver = @This();

local: *const js.Local,
handle: *const v8.PromiseResolver,

pub fn init(local: *const js.Local) PromiseResolver {
    return .{
        .local = local,
        .handle = v8.v8__Promise__Resolver__New(local.handle).?,
    };
}

pub fn promise(self: PromiseResolver) js.Promise {
    return .{
        .local = self.local,
        .handle = v8.v8__Promise__Resolver__GetPromise(self.handle).?,
    };
}

pub fn resolve(self: PromiseResolver, comptime source: []const u8, value: anytype) void {
    self._resolve(value) catch |err| {
        log.err(.bug, "resolve", .{ .source = source, .err = err, .persistent = false });
    };
}

fn _resolve(self: PromiseResolver, value: anytype) !void {
    const local = self.local;
    const env = local.ctx.env;

    if (builtin.mode == .Debug) {
        log.info(.browser, "promise.resolve", .{
            .checkpoint_active = env.checkpoint_active,
            .checkpoint_pending = env.checkpoint_pending,
        });
    }

    const js_val = try local.zigValueToJs(value, .{});

    var out: v8.MaybeBool = undefined;
    v8.v8__Promise__Resolver__Resolve(self.handle, local.handle, js_val.handle, &out);
    if (!out.has_value or !out.value) {
        return error.FailedToResolvePromise;
    }
    // A native binding runs with the calling JavaScript job suspended. Promise
    // reactions must not run until that binding returns to V8: the caller still
    // has to receive the Promise and may attach handlers before the HTML
    // microtask checkpoint. Running a checkpoint here reports synchronously
    // rejected Web API promises as unhandled and permits arbitrary JS reentry in
    // the middle of a native operation.
    //
    // Caller.deinit marks the checkpoint pending and the script/task runner owns
    // the checkpoint after V8 unwinds. Settlements made outside a native binding
    // (for example an HTTP completion) retain the eager host checkpoint below.
    if (local.ctx.call_depth > 0 or env.checkpoint_active) {
        env.checkpoint_pending = true;
        return;
    }
    env.runMicrotasks(.promise_resolve);
}

pub fn reject(self: PromiseResolver, comptime source: []const u8, value: anytype) void {
    self._reject(source, value) catch |err| {
        log.err(.bug, "reject", .{ .source = source, .err = err, .persistent = false });
    };
}

pub const RejectError = union(enum) {
    /// Not to be confused with `DOMException`; this is bare `Error`.
    generic_error: []const u8,
    range_error: []const u8,
    reference_error: []const u8,
    syntax_error: []const u8,
    type_error: []const u8,
    /// DOM exceptions are unknown to V8, belongs to web standards.
    dom_exception: struct { err: anyerror },
};

/// Rejects the promise w/ an error object.
pub fn rejectError(
    self: PromiseResolver,
    comptime source: []const u8,
    err: RejectError,
) void {
    const handle = switch (err) {
        .generic_error => |msg| self.local.isolate.createError(msg),
        .range_error => |msg| self.local.isolate.createRangeError(msg),
        .reference_error => |msg| self.local.isolate.createReferenceError(msg),
        .syntax_error => |msg| self.local.isolate.createSyntaxError(msg),
        .type_error => |msg| self.local.isolate.createTypeError(msg),
        // "Exceptional".
        .dom_exception => |exception| {
            self._reject(source, DOMException.fromError(exception.err) orelse unreachable) catch |reject_err| {
                log.err(.bug, "rejectDomException", .{ .source = source, .err = reject_err, .persistent = false });
            };
            return;
        },
    };

    self._reject(source, js.Value{ .handle = handle, .local = self.local }) catch |reject_err| {
        log.err(.bug, "rejectError", .{ .source = source, .err = reject_err, .persistent = false });
    };
}

fn _reject(self: PromiseResolver, comptime source: []const u8, value: anytype) !void {
    const local = self.local;
    const env = local.ctx.env;

    if (builtin.mode == .Debug) {
        log.info(.browser, "promise.reject", .{
            .source = source,
            .checkpoint_active = env.checkpoint_active,
            .checkpoint_pending = env.checkpoint_pending,
        });
    }

    const js_val = try local.zigValueToJs(value, .{});

    var out: v8.MaybeBool = undefined;
    v8.v8__Promise__Resolver__Reject(self.handle, local.handle, js_val.handle, &out);
    if (!out.has_value or !out.value) {
        return error.FailedToRejectPromise;
    }
    // See _resolve: a rejected Promise must be observable by its JavaScript
    // caller before unhandled-rejection bookkeeping runs.
    if (local.ctx.call_depth > 0 or env.checkpoint_active) {
        env.checkpoint_pending = true;
        return;
    }
    env.runMicrotasks(.promise_reject);
}

pub fn persist(self: PromiseResolver) !Global {
    var ctx = self.local.ctx;
    var global: v8.Global = undefined;
    v8.v8__Global__New(ctx.isolate.handle, self.handle, &global);
    try ctx.trackGlobal(global);
    return .{ .handle = global };
}

pub const Global = struct {
    handle: v8.Global,

    pub fn deinit(self: *Global) void {
        v8.v8__Global__Reset(&self.handle);
    }

    pub fn local(self: *const Global, l: *const js.Local) PromiseResolver {
        return .{
            .local = l,
            .handle = @ptrCast(v8.v8__Global__Get(&self.handle, l.isolate.handle)),
        };
    }
};
