// Shared host event-loop spin helpers (see knowledge/architecture/2026-07-19-host-event-loop.md).
//
// Reuses Context.scheduler — does not introduce a second priority queue.
//
// ## Nested vs top-level drains (WS3)
//
// | API | When | Timers / runOne | Microtasks |
// |-----|------|-----------------|------------|
// | `drainMicrotasksNested` | call_depth>0, is_evaluating, checkpoint_active, V8 stack | **never** pumpDueTimers; only schedule deferred | checkpoint only |
// | `afterDomMutation` | after appendChild / iframe sync load | nested→same as above; top→spin + short timers | full |
// | `afterTask` / `spin` | task runner, Runner wait edge | yes (runOne) | after each task |
// | `drainClassicScriptMicrotasks` (Frame) | mid classic Script.eval | never | checkpoint only |
//
// Rule: nested path MUST NOT call `pumpDueTimersNow` (iframe onload-before-poll / UAF).

const std = @import("std");
const builtin = @import("builtin");
const Execution = @import("Execution.zig");
const JsEntryGate = @import("JsEntryGate.zig");

const EventLoop = @This();
const IS_DEBUG = builtin.mode == .Debug;

pub const SpinBudget = struct {
    /// Max scheduler.runOne iterations per spin() call.
    max_tasks: u32 = 64,
    /// Stop early when no ready tasks remain (default).
    stop_when_idle: bool = true,
};

pub const SpinUntilBudget = struct {
    /// Wall-clock budget for the whole spinUntil call.
    wall_ms: u32 = 50,
    /// Max runOne per inner spin batch.
    max_tasks_per_batch: u32 = 32,
    /// Max batches (each batch up to max_tasks_per_batch).
    max_batches: u32 = 64,
};

pub const SpinUntilResult = enum {
    /// Predicate returned true.
    satisfied,
    /// Wall or batch budget exhausted (or nested on V8 stack).
    budget,
};

/// True when host drains must not run timers / full scheduler (unsafe reentry).
pub fn isHostNested(exec: *const Execution) bool {
    const env = exec.context.env;
    if (env.checkpoint_active) return true;
    if (exec.context.call_depth > 0) return true;
    if (env.anyContextOnV8Stack()) return true;
    if (JsEntryGate.scriptEvalActive(exec)) return true;
    return false;
}

/// After a host task body (MessagePort, timer, …): drain ready delay-0 work.
/// No-op when nested on V8 central stack.
pub fn afterTask(exec: *const Execution) void {
    if (isHostNested(exec)) {
        drainMicrotasksNested(exec);
        return;
    }
    spin(exec, .{ .max_tasks = 64, .stop_when_idle = true });
}

/// One ready macrotask (if any) + microtask checkpoint.
pub fn spinOnce(exec: *const Execution) bool {
    const env = exec.context.env;
    if (isHostNested(exec)) return false;

    const scheduler = exec._scheduler;
    if (!scheduler.hasReadyTasks()) {
        env.runMicrotasks(.macrotask_loop);
        return false;
    }
    const ran = scheduler.runOne() catch return false;
    env.runMicrotasks(.macrotask_loop);
    return ran;
}

/// Run ready tasks up to budget. Top-level only.
pub fn spin(exec: *const Execution, budget: SpinBudget) void {
    const env = exec.context.env;
    if (isHostNested(exec)) return;

    var n: u32 = 0;
    while (n < budget.max_tasks) : (n += 1) {
        if (budget.stop_when_idle and !exec._scheduler.hasReadyTasks()) break;
        const ran = exec._scheduler.runOne() catch break;
        if (!ran) break;
        env.runMicrotasks(.macrotask_loop);
    }
}

/// Spin host tasks until `predicate(ctx)` is true or budget is exhausted.
pub fn spinUntil(
    exec: *const Execution,
    budget: SpinUntilBudget,
    ctx: *anyopaque,
    predicate: *const fn (ctx: *anyopaque) bool,
) SpinUntilResult {
    if (predicate(ctx)) return .satisfied;

    var timer = std.time.Timer.start() catch return .budget;
    var batch: u32 = 0;
    while (batch < budget.max_batches) : (batch += 1) {
        if (isHostNested(exec)) return .budget;

        spin(exec, .{
            .max_tasks = budget.max_tasks_per_batch,
            .stop_when_idle = true,
        });

        if (predicate(ctx)) return .satisfied;

        const elapsed_ms: u32 = @intCast(timer.read() / std.time.ns_per_ms);
        if (elapsed_ms >= budget.wall_ms) return .budget;

        if (!exec._scheduler.hasReadyTasks()) {
            exec.context.env.runMicrotasks(.macrotask_loop);
            if (predicate(ctx)) return .satisfied;
            return .budget;
        }
    }
    return .budget;
}

pub fn hasReadyWork(exec: *const Execution) bool {
    return exec._scheduler.hasReadyTasks();
}

/// Nested-safe microtask-only drain: checkpoints + schedule deferred pumps.
/// **Never** calls `pumpDueTimersNow` / `scheduler.runOne`.
pub fn drainMicrotasksNested(exec: *const Execution) void {
    const env = exec.context.env;
    const ctx = exec.context;

    if (comptime IS_DEBUG) {
        // Nested API may still be called when only slightly nested; assert we
        // never grow a timer pump from this function (grep / review).
    }

    var pass: u8 = 0;
    while (pass < 12) : (pass += 1) {
        env.drainAllRealmMicrotasks();
        env.performMicrotaskCheckpointFp(ctx);
    }
    env.checkpoint_pending = true;

    switch (ctx.global) {
        .frame => |frame| {
            frame.scheduleDeferredMacrotaskPump(0) catch {};
            frame.scheduleDeferredMacrotaskPump(10) catch {};
        },
        .worker => |wgs| {
            wgs._worker._frame.scheduleDeferredMacrotaskPump(0) catch {};
        },
    }
}

/// After DOM insertion / sync iframe load / similar host mutations.
///
/// - **Nested:** `drainMicrotasksNested` only (no timers).
/// - **Top-level:** nested drain + short timer pump + `spin` + optional `runMicrotasks`.
pub fn afterDomMutation(exec: *const Execution) void {
    const env = exec.context.env;
    const ctx = exec.context;
    const nested = isHostNested(exec);

    switch (ctx.global) {
        .frame => |frame| frame.clearSchedulerSuppression(),
        .worker => {},
    }

    // Always: microtask progress + deferred pumps (safe nested or not).
    drainMicrotasksNested(exec);

    if (nested) {
        env.checkpoint_pending = true;
        return;
    }

    // Top-level denser path (was Env.drainNestedHostMicrotasks when !nested).
    switch (ctx.global) {
        .frame => |frame| {
            if (comptime IS_DEBUG) {
                std.debug.assert(!isHostNested(exec));
            }
            frame.pumpDueTimersNow(20);
            var pass: u8 = 0;
            while (pass < 12) : (pass += 1) {
                env.drainAllRealmMicrotasks();
                env.performMicrotaskCheckpointFp(ctx);
            }
            spin(exec, .{ .max_tasks = 32, .stop_when_idle = true });
        },
        .worker => {},
    }

    env.checkpoint_pending = true;
    if (!env.checkpoint_active) {
        var outer: u8 = 0;
        while (outer < 4) : (outer += 1) {
            env.checkpoint_pending = false;
            env.runMicrotasks(.event_handler);
            if (!env.checkpoint_pending) break;
        }
    }
}
