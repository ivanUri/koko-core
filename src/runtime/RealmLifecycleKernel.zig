//! Realm lifecycle + navigation epoch — foundation for deterministic teardown
//! and stale async cancellation (Koko).
//!
//! Phase 1: state enum, optional structured trace, navigation epoch bumps.
//! Phase 1.5: `TaskOwner`, centralized stale detection, extended trace hooks.
//!
//! ## Cancel-on-nav contract (document-bound work)
//!
//! When a browsing context navigates away, outgoing work must not touch freed
//! memory. The intended stack is:
//!
//! 1. **Realm** — `Frame.prepareForOutgoingAbort` → `.draining`, script shutdown,
//!    cancel streaming parser, `cancelOwnedSchedulerWork()`.
//! 2. **Network** — every document-bound HTTP transfer sets
//!    `RequestParams.attribution_frame` (see `Execution.attributionFrame`).
//!    `HttpClient.abortTransfersAttributedTo` kills those transfers; missing
//!    attribution is logged (and panics in Debug).
//! 3. **Scheduler** — run only via `Frame.runOwnedScheduler*` / Env macrotask
//!    pumps that gate on `canRunOwnedScheduler`; draining/dead flushes the queue.
//! 4. **Parser** — cooperative cancel: after any CDP poll, re-check
//!    `_realm_state == .active` before DOM mutations (`appendNew`, create).
//!
//! Keepalive/beacon may outlive the document only with `params.keepalive=true`
//! and must not hold page-arena pointers after destroy.

const std = @import("std");
const builtin = @import("builtin");

const log = @import("../support/log.zig");

pub const State = enum {
    /// Realm objects are being allocated and wired. No external observer may
    /// observe WindowProxy/execution context/injected scripts in this phase.
    initializing,
    /// JS, timers, and DOM mutations for this realm are allowed.
    active,
    /// Teardown: no new scheduled macrotasks (see `Timers.schedule`); in-flight
    /// work should finish or self-drop via epoch checks.
    draining,
    /// Realm V8 context disposed or disposing; must not schedule new work.
    dead,
};

pub const Epoch = u64;

pub const RealmId = u32;
pub const DocumentId = u32;

/// Captured ownership for async work (timers, microtasks, fetch, MO, CE).
pub const TaskOwner = struct {
    realm_id: RealmId,
    epoch: Epoch,
    /// When non-null, must match current loader/document attribution.
    document_id: ?DocumentId = null,
};

pub const TaskSource = enum {
    timer,
    microtask_checkpoint,
    mutation_delivery,
    intersection_check,
    intersection_delivery,
    slotchange_delivery,
    fetch_completion,
    promise_resolve,
    custom_element,
    unknown,
};

/// When true (Debug builds only), emit `realm.lifecycle` debug lines.
pub var trace_enabled: bool = false;

pub const TraceEvent = enum {
    realm_draining,
    realm_dead,
    nav_epoch_bump,
    task_drop_stale,
    task_execute,
    scheduler_suppressed,
};

pub fn trace(event: TraceEvent, frame_id: u32, epoch: ?Epoch, timer_id: ?u32) void {
    if (!trace_enabled) return;
    if (comptime builtin.mode != .Debug) return;
    log.debug(.frame, "realm.lifecycle", .{
        .event = @tagName(event),
        .frame_id = frame_id,
        .epoch = epoch,
        .timer_id = timer_id,
    });
}

pub fn taskOwnerIsStale(scheduled: TaskOwner, current: TaskOwner) bool {
    if (scheduled.realm_id != current.realm_id) return true;
    if (scheduled.epoch != current.epoch) return true;
    if (scheduled.document_id) |sd| {
        if (current.document_id) |cd| {
            if (sd != cd) return true;
        } else return true;
    }
    return false;
}

pub fn traceJsEntry(
    comptime accept: bool,
    frame_id: u32,
    scheduled_epoch: ?Epoch,
    current_epoch: Epoch,
    state: State,
    source: TaskSource,
) void {
    if (!trace_enabled) return;
    if (comptime builtin.mode != .Debug) return;
    log.debug(.frame, "realm.lifecycle", .{
        .event = if (accept) "js.entry.accept" else "js.entry.reject",
        .frame_id = frame_id,
        .scheduled_epoch = scheduled_epoch,
        .current_epoch = current_epoch,
        .realm_state = @tagName(state),
        .task_source = @tagName(source),
    });
}

pub fn tracePromiseSchedule(frame_id: u32, epoch: Epoch, source: TaskSource) void {
    if (!trace_enabled) return;
    if (comptime builtin.mode != .Debug) return;
    log.debug(.frame, "realm.lifecycle", .{
        .event = "promise.schedule",
        .frame_id = frame_id,
        .current_epoch = epoch,
        .task_source = @tagName(source),
    });
}

pub fn tracePromiseDropStale(frame_id: u32, scheduled_epoch: Epoch, current_epoch: Epoch, source: TaskSource) void {
    if (!trace_enabled) return;
    if (comptime builtin.mode != .Debug) return;
    log.debug(.frame, "realm.lifecycle", .{
        .event = "promise.drop_stale",
        .frame_id = frame_id,
        .scheduled_epoch = scheduled_epoch,
        .current_epoch = current_epoch,
        .task_source = @tagName(source),
    });
}

pub fn traceMicrotaskCheckpoint(comptime begin: bool, frame_id: u32, epoch: Epoch, state: State) void {
    if (!trace_enabled) return;
    if (comptime builtin.mode != .Debug) return;
    log.debug(.frame, "realm.lifecycle", .{
        .event = if (begin) "microtask.checkpoint.begin" else "microtask.checkpoint.end",
        .frame_id = frame_id,
        .current_epoch = epoch,
        .realm_state = @tagName(state),
    });
}

pub fn traceMicrotaskDropStale(
    frame_id: u32,
    scheduled_epoch: Epoch,
    current_epoch: Epoch,
    state: State,
    source: TaskSource,
) void {
    if (!trace_enabled) return;
    if (comptime builtin.mode != .Debug) return;
    log.debug(.frame, "realm.lifecycle", .{
        .event = "microtask.drop_stale",
        .frame_id = frame_id,
        .scheduled_epoch = scheduled_epoch,
        .current_epoch = current_epoch,
        .realm_state = @tagName(state),
        .task_source = @tagName(source),
    });
}

pub fn traceMo(comptime tag: []const u8, frame_id: u32, scheduled_epoch: ?Epoch, current_epoch: Epoch, state: State) void {
    if (!trace_enabled) return;
    if (comptime builtin.mode != .Debug) return;
    log.debug(.frame, "realm.lifecycle", .{
        .event = tag,
        .frame_id = frame_id,
        .scheduled_epoch = scheduled_epoch,
        .current_epoch = current_epoch,
        .realm_state = @tagName(state),
    });
}

pub fn traceCeCallback(comptime tag: []const u8, frame_id: u32, epoch: Epoch, state: State) void {
    if (!trace_enabled) return;
    if (comptime builtin.mode != .Debug) return;
    log.debug(.frame, "realm.lifecycle", .{
        .event = tag,
        .frame_id = frame_id,
        .current_epoch = epoch,
        .realm_state = @tagName(state),
    });
}

/// Emitted when a microtask checkpoint iteration count exceeds the hard budget.
pub fn traceMicrotaskBudgetExceeded(frame_id: u32, epoch: Epoch, state: State, iteration_count: usize) void {
    log.err(.frame, "microtask.budget_exceeded", .{
        .frame_id = frame_id,
        .current_epoch = epoch,
        .realm_state = @tagName(state),
        .iteration_count = iteration_count,
    });
}

/// Emitted when runaway microtask recursion is detected and the circuit breaker fires.
pub fn traceMicrotaskRunawayDetected(frame_id: u32, epoch: Epoch, state: State, iteration_count: usize) void {
    log.err(.frame, "microtask.runaway_detected", .{
        .frame_id = frame_id,
        .current_epoch = epoch,
        .realm_state = @tagName(state),
        .iteration_count = iteration_count,
    });
}

/// Emitted when a nested checkpoint request is deferred until the active pass ends.
/// Hot path on heavy sites (ads/analytics) — only when lifecycle tracing is on.
pub fn traceMicrotaskCheckpointReentryDeferred(frame_id: u32, epoch: Epoch, state: State, queue_size: usize, checkpoint_active: bool, checkpoint_pending: bool) void {
    if (!trace_enabled) return;
    log.debug(.frame, "microtask.checkpoint.reentry_deferred", .{
        .frame_id = frame_id,
        .current_epoch = epoch,
        .realm_state = @tagName(state),
        .queue_size = queue_size,
        .checkpoint_active = checkpoint_active,
        .checkpoint_pending = checkpoint_pending,
    });
}

/// Emitted when checkpoint execution skips a dead realm.
pub fn traceMicrotaskCheckpointDeadRealm(frame_id: u32, epoch: Epoch, state: State) void {
    if (!trace_enabled) return;
    log.debug(.frame, "microtask.checkpoint.dead_realm", .{
        .frame_id = frame_id,
        .current_epoch = epoch,
        .realm_state = @tagName(state),
    });
}

/// Emitted when checkpoint execution skips a suppressed realm.
pub fn traceMicrotaskCheckpointSuppressed(frame_id: u32, epoch: Epoch, state: State) void {
    if (!trace_enabled) return;
    log.debug(.frame, "microtask.checkpoint.suppressed", .{
        .frame_id = frame_id,
        .current_epoch = epoch,
        .realm_state = @tagName(state),
    });
}

/// Emitted when checkpoint execution is intentionally aborted by scheduler
/// semantics rather than by asynchronous isolate termination.
pub fn traceMicrotaskCheckpointAborted(frame_id: u32, epoch: Epoch, state: State) void {
    if (!trace_enabled) return;
    log.debug(.frame, "microtask.checkpoint_aborted", .{
        .frame_id = frame_id,
        .current_epoch = epoch,
        .realm_state = @tagName(state),
    });
}

/// Emitted when worker checkpoint containment would be needed but is not implemented yet.
pub fn traceWorkerContainmentNotImplemented(frame_id: u32, epoch: Epoch, state: State) void {
    log.err(.frame, "worker.containment_not_implemented", .{
        .frame_id = frame_id,
        .current_epoch = epoch,
        .realm_state = @tagName(state),
    });
}

/// Emitted when a realm's scheduler is suppressed due to runaway microtask execution.
pub fn traceSchedulerSuppressed(frame_id: u32, epoch: Epoch, state: State) void {
    log.err(.frame, "realm.scheduler_suppressed", .{
        .frame_id = frame_id,
        .current_epoch = epoch,
        .realm_state = @tagName(state),
    });
}

test "RealmLifecycleKernel: trace is no-op when disabled" {
    trace_enabled = false;
    trace(.nav_epoch_bump, 1, 2, null);
    trace_enabled = false;
}

test "TaskOwner stale on epoch mismatch" {
    const a = TaskOwner{ .realm_id = 1, .epoch = 5, .document_id = 9 };
    const b = TaskOwner{ .realm_id = 1, .epoch = 6, .document_id = 9 };
    try std.testing.expect(taskOwnerIsStale(a, b));
    try std.testing.expect(!taskOwnerIsStale(b, b));
}

test "TaskOwner stale on realm_id mismatch" {
    const a = TaskOwner{ .realm_id = 1, .epoch = 5, .document_id = null };
    const b = TaskOwner{ .realm_id = 2, .epoch = 5, .document_id = null };
    try std.testing.expect(taskOwnerIsStale(a, b));
}

test "TaskOwner stale on document_id mismatch" {
    const a = TaskOwner{ .realm_id = 1, .epoch = 5, .document_id = 1 };
    const b = TaskOwner{ .realm_id = 1, .epoch = 5, .document_id = 2 };
    try std.testing.expect(taskOwnerIsStale(a, b));
}

// Scenario-style coverage (A–E) is exercised by the above primitives plus
// integration tests: navigation bumps `epoch`, microtasks capture `TaskOwner`
// on schedule, and `validateJsEntry` rejects `.dead` / non-`allow_draining`.
