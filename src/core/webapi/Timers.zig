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

// Shared bookkeeping for setTimeout / setInterval (and Window-only
// setImmediate / requestAnimationFrame / requestIdleCallback). Both Window
// and WorkerGlobalScope embed a Timers and forward their JS-bridged
// methods through `schedule` / `clear`.

const std = @import("std");

const js = @import("../js/js.zig");
const Frame = @import("../browser/Frame.zig");
const WorkerGlobalScope = @import("WorkerGlobalScope.zig");

const log = @import("../../support/log.zig");
const RealmLifecycleKernel = @import("../../runtime/RealmLifecycleKernel.zig");
const Allocator = std.mem.Allocator;

const Timers = @This();

_timer_id: u30 = 0,
_callbacks: std.AutoHashMapUnmanaged(u32, *ScheduleCallback) = .{},

pub const Mode = enum {
    idle,
    normal,
    animation_frame,
};

pub const ScheduleOpts = struct {
    repeat: bool,
    params: []js.Value.Temp,
    name: []const u8,
    low_priority: bool = false,
    mode: Mode = .normal,
};

pub fn schedule(
    self: *Timers,
    exec: *js.Execution,
    cb: js.Function.Temp,
    delay_ms: u32,
    opts: ScheduleOpts,
) !u32 {
    exec.validateJsEntry(.strict_active, .timer) catch return error.RealmInactive;

    if (self._callbacks.count() > 512) {
        // these are active
        return error.TooManyTimeout;
    }

    const arena = try exec.getArena(.tiny, "Timers.schedule");
    errdefer exec.releaseArena(arena);

    const timer_id = self._timer_id +% 1;
    self._timer_id = timer_id;

    var effective_delay = delay_ms;
    if (exec.timer_nesting_level >= 5 and effective_delay < 4) {
        effective_delay = 4;
    }
    // Fingerprint yb() I() polls iframe readyState with setTimeout(10) from a
    // Promise executor still nested inside appendChild. Chrome runs the poll on
    // the next turn; Velora must not stall until a deferred macrotask pump.
    if (exec.context.call_depth > 0 and effective_delay > 0 and effective_delay <= 10) {
        effective_delay = 0;
    }
    exec.timer_nesting_level +%= 1;

    var persisted_params: []js.Value.Temp = &.{};
    if (opts.params.len > 0) {
        persisted_params = try arena.dupe(js.Value.Temp, opts.params);
    }

    const gop = try self._callbacks.getOrPut(exec.arena, timer_id);
    if (gop.found_existing) {
        // 2^31 would have to wrap for this to happen.
        return error.TooManyTimeout;
    }
    errdefer _ = self._callbacks.remove(timer_id);

    const callback = try arena.create(ScheduleCallback);
    callback.* = .{
        .cb = cb,
        .exec = exec,
        .timers = self,
        .arena = arena,
        .mode = opts.mode,
        .name = opts.name,
        .timer_id = timer_id,
        .task_owner = exec.captureTaskOwner(),
        .params = persisted_params,
        .repeat_ms = if (opts.repeat) if (delay_ms == 0) 1 else delay_ms else null,
    };
    gop.value_ptr.* = callback;

    try exec.context.scheduler.add(callback, ScheduleCallback.run, effective_delay, .{
        .name = opts.name,
        .low_priority = opts.low_priority,
        .finalizer = ScheduleCallback.cancelled,
    });

    // Fingerprint yb() I() polls with setTimeout(10) after appendChild returns
    // from the Promise executor; run same-turn when nested (see effective_delay).
    if (effective_delay <= 10 and exec.context.call_depth > 0) {
        switch (exec.context.global) {
            .frame => |frame| {
                frame.pumpDueTimersNow(0);
                const env = &frame._session.browser.env;
                if (std.mem.indexOf(u8, frame.url, "fingerprint.com") != null) {
                    env.drainFingerprintYbMicrotasks(frame.js);
                } else {
                    var mt: u8 = 0;
                    while (mt < 8) : (mt += 1) {
                        env.performMicrotaskCheckpoint(frame.js);
                    }
                }
                frame.scheduleDeferredMacrotaskPump(0) catch |err| {
                    log.warn(.js, "timer defer pump", .{ .err = err, .delay = effective_delay });
                };
            },
            .worker => |wgs| {
                // Nested worker setTimeout(≤10ms) is coerced to 0; defer pump to the
                // next turn so clearTimeout in the same handler runs first.
                wgs._worker._frame.scheduleDeferredMacrotaskPump(0) catch |err| {
                    log.warn(.js, "worker timer defer pump", .{ .err = err, .delay = effective_delay });
                };
                if (effective_delay == 0) {
                    wgs._worker._frame.scheduleDeferredMacrotaskPump(10) catch |err| {
                        log.warn(.js, "worker timer defer pump10", .{ .err = err });
                    };
                }
            },
        }
    }

    return timer_id;
}

pub fn clear(self: *Timers, id: u32) void {
    var sc = self._callbacks.fetchRemove(id) orelse return;
    sc.value.removed = true;
}

// https://html.spec.whatwg.org/multipage/timers-and-user-prompts.html#dom-settimeout
// https://html.spec.whatwg.org/multipage/timers-and-user-prompts.html#timerhandler
// TimerHandler = Function or DOMString. When a string is passed, it is
// compiled into an anonymous function body, matching how legacy browsers
// (and all current UAs) interpret `setTimeout("foo()", 100)`.
pub const LegacyHandler = union(enum) {
    function: js.Function.Temp,
    string: js.String,

    pub fn resolve(handler: LegacyHandler, exec: *js.Execution) !js.Function.Temp {
        switch (handler) {
            .function => |fun| return fun,
            .string => |str| {
                const fun = try exec.context.local.?.compileFunction(str, &.{}, &.{});
                return fun.temp();
            },
        }
    }
};

const ScheduleCallback = struct {
    // for debugging
    name: []const u8,

    // Timers._callbacks key
    timer_id: u31,

    /// Navigation / realm ownership captured when this timer was scheduled.
    task_owner: RealmLifecycleKernel.TaskOwner,

    // delay, in ms, to repeat. When null, removed after first invocation.
    repeat_ms: ?u32,

    cb: js.Function.Temp,

    mode: Mode,
    exec: *js.Execution,
    timers: *Timers,
    arena: Allocator,
    removed: bool = false,
    params: []const js.Value.Temp,

    fn cancelled(ptr: *anyopaque) void {
        var self: *ScheduleCallback = @ptrCast(@alignCast(ptr));
        self.deinit();
    }

    fn deinit(self: *ScheduleCallback) void {
        self.cb.release();
        for (self.params) |param| {
            param.release();
        }
        self.exec.releaseArena(self.arena);
    }

    fn traceFrameId(self: *const ScheduleCallback) u32 {
        return switch (self.exec.context.global) {
            .frame => |f| f._frame_id,
            .worker => |w| w._frame_id,
        };
    }

    fn run(ptr: *anyopaque) !?u32 {
        const self: *ScheduleCallback = @ptrCast(@alignCast(ptr));
        if (self.removed) {
            self.deinit();
            return null;
        }

        const current_epoch = self.exec.realmEpoch();
        if (self.exec.isTaskOwnerStale(self.task_owner)) {
            RealmLifecycleKernel.trace(.task_drop_stale, self.traceFrameId(), current_epoch, self.timer_id);
            _ = self.timers._callbacks.fetchRemove(self.timer_id);
            self.deinit();
            return null;
        }

        self.exec.validateJsEntry(.allow_draining, .timer) catch {
            _ = self.timers._callbacks.fetchRemove(self.timer_id);
            self.deinit();
            return null;
        };

        if (self.exec.timer_nesting_level > 0) {
            self.exec.timer_nesting_level -= 1;
        }

        if (RealmLifecycleKernel.trace_enabled) {
            RealmLifecycleKernel.trace(.task_execute, self.traceFrameId(), current_epoch, self.timer_id);
        }

        var ls: js.Local.Scope = undefined;
        self.exec.context.localScope(&ls);
        defer ls.deinit();

        switch (self.mode) {
            .idle => {
                const IdleDeadline = @import("IdleDeadline.zig");
                invokeTimerCallback(&ls.local, self.exec, self.cb, .{IdleDeadline{}});
            },
            .animation_frame => {
                // requestAnimationFrame is window-only; if a worker ever
                // schedules with this mode it's a programming error.
                const window = switch (self.exec.context.global) {
                    .frame => |frame| frame.window,
                    .worker => unreachable,
                };
                invokeTimerCallback(&ls.local, self.exec, self.cb, .{window._performance.now()});
            },
            .normal => invokeTimerCallback(&ls.local, self.exec, self.cb, self.params),
        }
        ls.local.ctx.env.runMicrotasks(.timer_callback);

        if (self.repeat_ms) |ms| {
            return ms;
        }
        defer self.deinit();
        _ = self.timers._callbacks.remove(self.timer_id);
        return null;
    }
};

fn invokeTimerCallback(local: *js.Local, exec: *js.Execution, cb: anytype, args: anytype) void {
    var try_catch: js.TryCatch = undefined;
    try_catch.init(local);
    defer try_catch.deinit();

    var caught: js.TryCatch.Caught = undefined;
    local.toLocal(cb).tryCall(void, args, &caught) catch |err| {
        if (err != error.JsException) {
            log.warn(.js, "timer", .{ .err = err });
            return;
        }
        const ex = try_catch.exceptionValue() orelse return;
        const message = ex.toStringSlice() catch "Uncaught exception";
        const filename = exec.base();
        const line: u32 = caught.line orelse 0;
        switch (exec.context.global) {
            .frame => |frame| {
                frame.window.reportUncaughtException(ex, message, filename, line, 0, frame) catch |report_err| {
                    log.warn(.js, "timer uncaught", .{ .err = report_err });
                };
            },
            .worker => |wsg| {
                wsg.reportUncaughtException(ex, message, filename, line, 0) catch |report_err| {
                    log.warn(.js, "timer uncaught", .{ .err = report_err });
                };
            },
        }
    };
}
