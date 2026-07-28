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
const milliTimestamp = @import("../../support/datetime.zig").milliTimestamp;
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
    /// Author-supplied requestIdleCallback deadline. This does not delay the
    /// idle task; it only controls IdleDeadline.didTimeout.
    idle_timeout_ms: ?u32 = null,
};

/// Timer nesting rules belong to the HTML timers algorithm. Rendering and idle
/// callbacks are separate task sources: re-registering requestAnimationFrame
/// from inside its callback must target a future rendering opportunity, never
/// be collapsed into the current scheduler turn.
fn effectiveScheduleDelay(delay_ms: u32, mode: Mode, timer_nesting_level: u16, call_depth: usize) u32 {
    if (mode != .normal) return delay_ms;

    var effective_delay = delay_ms;
    if (timer_nesting_level >= 5 and effective_delay < 4) {
        effective_delay = 4;
    }
    // Nested Zig DOM / host API (call_depth): coerce short HTML timers to 0 so
    // the deferred macrotask pump / wait-edge spin can run them soon.
    if (call_depth > 0 and effective_delay > 0 and effective_delay <= 10) {
        effective_delay = 0;
    }
    return effective_delay;
}

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

    const effective_delay = effectiveScheduleDelay(
        delay_ms,
        opts.mode,
        exec.timer_nesting_level,
        exec.context.call_depth,
    );
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
        .scheduled_at_ms = milliTimestamp(.monotonic),
        .idle_timeout_ms = opts.idle_timeout_ms,
        .repeat_ms = if (opts.repeat) if (delay_ms == 0) 1 else delay_ms else null,
    };
    gop.value_ptr.* = callback;

    try exec.context.scheduler.add(callback, ScheduleCallback.run, effective_delay, .{
        .name = opts.name,
        .low_priority = opts.low_priority,
        .source = .timer,
        .finalizer = ScheduleCallback.cancelled,
    });

    // Nested host stack: never pumpDueTimersNow (IsOnCentralStack / iframe race).
    // JsEntryGate owns “must queue”; EventLoop.spin on wait edges runs due timers.
    if (opts.mode == .normal and effective_delay <= 10 and js.JsEntryGate.mustQueueAsTask(exec)) {
        switch (exec.context.global) {
            .frame => |frame| {
                js.EventLoop.drainMicrotasksNested(exec);
                frame.scheduleDeferredMacrotaskPump(0) catch |err| {
                    log.warn(.js, "timer defer pump", .{ .err = err, .delay = effective_delay });
                };
            },
            .worker => |wgs| {
                // Nested worker setTimeout(≤10ms): defer pump so clearTimeout in
                // the same handler runs first.
                js.EventLoop.drainMicrotasksNested(exec);
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

test "Timers: nested HTML timers do not collapse rendering callbacks" {
    try std.testing.expectEqual(@as(u32, 0), effectiveScheduleDelay(5, .normal, 0, 1));
    try std.testing.expectEqual(@as(u32, 4), effectiveScheduleDelay(0, .normal, 5, 0));
    try std.testing.expectEqual(@as(u32, 5), effectiveScheduleDelay(5, .animation_frame, 8, 1));
    try std.testing.expectEqual(@as(u32, 5), effectiveScheduleDelay(5, .idle, 8, 1));
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
    scheduled_at_ms: u64,
    idle_timeout_ms: ?u32,

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
            // Temporary JS gate (realm initializing / mid-teardown of a sibling
            // frame). Do NOT destroy setInterval — Fingerprint Fw/hl use
            // setInterval(1) as a job queue; killing on a transient gate left
            // identify done on the wire while get() hung until Client timeout.
            if (self.repeat_ms) |ms| {
                // Keep the interval alive; retry soon (Debug forbids repeat 0).
                return if (ms == 0) 1 else ms;
            }
            // One-shot: retry once rather than drop the callback forever.
            return 1;
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
                const did_timeout = if (self.idle_timeout_ms) |timeout|
                    milliTimestamp(.monotonic) -% self.scheduled_at_ms >= timeout
                else
                    false;
                invokeTimerCallback(&ls.local, self.exec, self.cb, .{IdleDeadline.init(did_timeout)});
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
        // Fingerprint agent routes identify POST through a setInterval(1) work
        // queue (Fw/hl). When the async job fulfills, the poll path does
        // `resultPromise.then(resolve)`. That pure-JS reaction must run on this
        // turn — nested `runMicrotasks` only marks `checkpoint_pending`, which
        // is easy to miss if no outer loop is live. Always PerformCheckpoint the
        // local realm (and all realms) before the global drain.
        const env = ls.local.ctx.env;
        env.drainAllRealmMicrotasks();
        env.performMicrotaskCheckpointFp(ls.local.ctx);
        env.runMicrotasks(.timer_callback);

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
