//! Thread-safe, process-wide resource admission bookkeeping.
//!
//! The controller deliberately does not know how RSS/VMS are sampled. Callers
//! provide a `ResourceSample`, normally from a platform-specific sampler. A
//! zero limit disables that limit. `max_rss_bytes` applies to current RSS;
//! RSS high-water is retained for observability and is never used as a
//! substitute for current RSS admission.

const std = @import("std");

/// The controller's critical sections only touch a fixed set of counters and
/// never perform I/O, allocation, or callbacks. Keeping this tiny lock local
/// makes the controller usable as a standalone module (including focused
/// `zig test`) without importing process/runtime-specific synchronization.
const SpinLock = struct {
    held: std.atomic.Value(bool) = .init(false),

    fn lock(self: *SpinLock) void {
        while (self.held.cmpxchgWeak(false, true, .acquire, .monotonic) != null) {
            std.atomic.spinLoopHint();
        }
    }

    fn unlock(self: *SpinLock) void {
        self.held.store(false, .release);
    }
};

pub const ResourceSample = struct {
    /// Current resident set size of the process, in bytes.
    rss_current_bytes: u64 = 0,
    /// Optional externally sampled RSS high-water mark, in bytes.
    /// `rss_current_bytes` is folded into the controller high-water mark too.
    rss_high_water_bytes: u64 = 0,
    /// Current virtual memory size of the process, in bytes.
    vms_current_bytes: u64 = 0,
};

pub const Limits = struct {
    /// Zero disables the active-worker limit.
    max_active_workers: u64 = 0,
    /// Zero disables the pending-handshake limit.
    max_pending_handshakes: u64 = 0,
    /// Zero disables the current-RSS limit.
    max_rss_bytes: u64 = 0,
    /// Zero disables the current-VMS limit.
    max_vms_bytes: u64 = 0,
};

pub const Admission = enum {
    active_worker,
    pending_handshake,
};

pub const Error = error{
    MaxActiveWorkers,
    MaxPendingHandshakes,
    RssBudgetExceeded,
    VmsBudgetExceeded,
    NoActiveWorkers,
    NoPendingHandshakes,
};

pub const Snapshot = struct {
    active_workers: u64,
    pending_handshakes: u64,
    rss_current_bytes: u64,
    rss_high_water_bytes: u64,
    vms_current_bytes: u64,
    accepted_admissions: u64,
    rejected_admissions: u64,
    releases: u64,
    promotions: u64,
};

const ResourceController = @This();

limits: Limits,
mutex: SpinLock = .{},
active_workers: u64 = 0,
pending_handshakes: u64 = 0,
rss_current_bytes: u64 = 0,
rss_high_water_bytes: u64 = 0,
vms_current_bytes: u64 = 0,
accepted_admissions: u64 = 0,
rejected_admissions: u64 = 0,
releases: u64 = 0,
promotions: u64 = 0,

pub fn init(limits: Limits) ResourceController {
    return .{ .limits = limits };
}

/// Record a platform sample without changing admission counters.
pub fn updateSample(self: *ResourceController, sample: ResourceSample) void {
    self.mutex.lock();
    defer self.mutex.unlock();
    self.updateSampleLocked(sample);
}

/// Reserve one active worker or pending handshake against the latest sample.
/// The supplied sample is recorded before the limit checks, including on
/// rejection, so snapshots explain why an admission was refused.
pub fn reserve(self: *ResourceController, admission: Admission, sample: ResourceSample) Error!void {
    self.mutex.lock();
    defer self.mutex.unlock();

    self.updateSampleLocked(sample);
    self.checkMemoryLocked() catch |err| {
        self.rejected_admissions +|= 1;
        return err;
    };

    switch (admission) {
        .active_worker => {
            if (self.limits.max_active_workers != 0 and
                self.active_workers >= self.limits.max_active_workers)
            {
                self.rejected_admissions +|= 1;
                return error.MaxActiveWorkers;
            }
            self.active_workers +|= 1;
        },
        .pending_handshake => {
            if (self.limits.max_pending_handshakes != 0 and
                self.pending_handshakes >= self.limits.max_pending_handshakes)
            {
                self.rejected_admissions +|= 1;
                return error.MaxPendingHandshakes;
            }
            self.pending_handshakes +|= 1;
        },
    }
    self.accepted_admissions +|= 1;
}

/// Atomically turn a pending handshake reservation into an active worker.
/// On failure, the pending reservation remains held.
pub fn promotePendingToActive(self: *ResourceController, sample: ResourceSample) Error!void {
    self.mutex.lock();
    defer self.mutex.unlock();

    if (self.pending_handshakes == 0) return error.NoPendingHandshakes;
    self.updateSampleLocked(sample);
    self.checkMemoryLocked() catch |err| {
        self.rejected_admissions +|= 1;
        return err;
    };
    if (self.limits.max_active_workers != 0 and
        self.active_workers >= self.limits.max_active_workers)
    {
        self.rejected_admissions +|= 1;
        return error.MaxActiveWorkers;
    }

    self.pending_handshakes -= 1;
    self.active_workers +|= 1;
    self.promotions +|= 1;
}

/// Release a reservation previously acquired with `reserve` or promotion.
pub fn release(self: *ResourceController, admission: Admission) Error!void {
    self.mutex.lock();
    defer self.mutex.unlock();

    switch (admission) {
        .active_worker => {
            if (self.active_workers == 0) return error.NoActiveWorkers;
            self.active_workers -= 1;
        },
        .pending_handshake => {
            if (self.pending_handshakes == 0) return error.NoPendingHandshakes;
            self.pending_handshakes -= 1;
        },
    }
    self.releases +|= 1;
}

pub fn snapshot(self: *ResourceController) Snapshot {
    self.mutex.lock();
    defer self.mutex.unlock();
    return .{
        .active_workers = self.active_workers,
        .pending_handshakes = self.pending_handshakes,
        .rss_current_bytes = self.rss_current_bytes,
        .rss_high_water_bytes = self.rss_high_water_bytes,
        .vms_current_bytes = self.vms_current_bytes,
        .accepted_admissions = self.accepted_admissions,
        .rejected_admissions = self.rejected_admissions,
        .releases = self.releases,
        .promotions = self.promotions,
    };
}

fn updateSampleLocked(self: *ResourceController, sample: ResourceSample) void {
    self.rss_current_bytes = sample.rss_current_bytes;
    self.vms_current_bytes = sample.vms_current_bytes;
    self.rss_high_water_bytes = @max(
        self.rss_high_water_bytes,
        sample.rss_high_water_bytes,
        sample.rss_current_bytes,
    );
}

fn checkMemoryLocked(self: *ResourceController) Error!void {
    if (self.limits.max_rss_bytes != 0 and
        self.rss_current_bytes > self.limits.max_rss_bytes)
    {
        return error.RssBudgetExceeded;
    }
    if (self.limits.max_vms_bytes != 0 and
        self.vms_current_bytes > self.limits.max_vms_bytes)
    {
        return error.VmsBudgetExceeded;
    }
}

test "resource controller admits, snapshots, promotes, and releases" {
    var controller = ResourceController.init(.{
        .max_active_workers = 2,
        .max_pending_handshakes = 2,
        .max_rss_bytes = 100,
        .max_vms_bytes = 200,
    });
    const sample = ResourceSample{ .rss_current_bytes = 40, .vms_current_bytes = 80 };

    try controller.reserve(.pending_handshake, sample);
    try controller.promotePendingToActive(sample);
    try controller.reserve(.active_worker, sample);

    var state = controller.snapshot();
    try std.testing.expectEqual(@as(u64, 2), state.active_workers);
    try std.testing.expectEqual(@as(u64, 0), state.pending_handshakes);
    try std.testing.expectEqual(@as(u64, 2), state.accepted_admissions);
    try std.testing.expectEqual(@as(u64, 1), state.promotions);

    try controller.release(.active_worker);
    try controller.release(.active_worker);
    state = controller.snapshot();
    try std.testing.expectEqual(@as(u64, 0), state.active_workers);
    try std.testing.expectEqual(@as(u64, 2), state.releases);
    try std.testing.expectError(error.NoActiveWorkers, controller.release(.active_worker));
}

test "resource controller rejects active and pending overflow" {
    var controller = ResourceController.init(.{
        .max_active_workers = 1,
        .max_pending_handshakes = 1,
    });
    const sample = ResourceSample{};

    try controller.reserve(.active_worker, sample);
    try std.testing.expectError(error.MaxActiveWorkers, controller.reserve(.active_worker, sample));
    try controller.reserve(.pending_handshake, sample);
    try std.testing.expectError(error.MaxPendingHandshakes, controller.reserve(.pending_handshake, sample));

    const state = controller.snapshot();
    try std.testing.expectEqual(@as(u64, 2), state.accepted_admissions);
    try std.testing.expectEqual(@as(u64, 2), state.rejected_admissions);
}

test "resource controller rejects current RSS and VMS independently of high-water" {
    var controller = ResourceController.init(.{
        .max_rss_bytes = 100,
        .max_vms_bytes = 200,
    });

    try controller.reserve(.active_worker, .{
        .rss_current_bytes = 100,
        .rss_high_water_bytes = 300,
        .vms_current_bytes = 200,
    });
    try std.testing.expectError(error.RssBudgetExceeded, controller.reserve(.active_worker, .{
        .rss_current_bytes = 101,
        .rss_high_water_bytes = 301,
        .vms_current_bytes = 100,
    }));
    try std.testing.expectError(error.VmsBudgetExceeded, controller.reserve(.active_worker, .{
        .rss_current_bytes = 50,
        .vms_current_bytes = 201,
    }));

    const state = controller.snapshot();
    try std.testing.expectEqual(@as(u64, 50), state.rss_current_bytes);
    try std.testing.expectEqual(@as(u64, 301), state.rss_high_water_bytes);
    try std.testing.expectEqual(@as(u64, 201), state.vms_current_bytes);
}

test "resource controller disabled limits allow reservations and preserve samples" {
    var controller = ResourceController.init(.{});
    const sample = ResourceSample{
        .rss_current_bytes = std.math.maxInt(u64),
        .rss_high_water_bytes = 7,
        .vms_current_bytes = std.math.maxInt(u64),
    };

    try controller.reserve(.active_worker, sample);
    try controller.reserve(.pending_handshake, sample);
    const state = controller.snapshot();
    try std.testing.expectEqual(@as(u64, 1), state.active_workers);
    try std.testing.expectEqual(@as(u64, 1), state.pending_handshakes);
    try std.testing.expectEqual(std.math.maxInt(u64), state.rss_current_bytes);
    try std.testing.expectEqual(std.math.maxInt(u64), state.rss_high_water_bytes);
    try std.testing.expectEqual(std.math.maxInt(u64), state.vms_current_bytes);
}
