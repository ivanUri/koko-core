// Unified stale-load cancellation for HTTP terminal callbacks (done/error/shutdown).
// Checks run only on completion paths — not on per-chunk data_callback.

const RealmLifecycleKernel = @import("../../runtime/RealmLifecycleKernel.zig");
const Execution = @import("../js/Execution.zig");

pub const TaskOwner = RealmLifecycleKernel.TaskOwner;

pub const Guard = struct {
    task_owner: TaskOwner,
    finished: bool = false,

    pub fn init(exec: *const Execution) Guard {
        return .{ .task_owner = exec.captureTaskOwner() };
    }

    pub fn isFinished(self: *const Guard) bool {
        return self.finished;
    }

    /// Returns false when the load was torn down, the realm epoch advanced, or
    /// the frame is navigating away. Call at the top of terminal callbacks only.
    pub fn isDeliverable(
        self: *const Guard,
        exec: *const Execution,
        opts: struct {
            manager_shutdown: bool = false,
            frame_going_away: bool = false,
        },
    ) bool {
        if (self.finished) return false;
        if (opts.manager_shutdown or opts.frame_going_away) return false;
        return !exec.isTaskOwnerStale(self.task_owner);
    }

    /// Realm-scoped variant: avoids dereferencing `Execution` / V8 context when
    /// the frame may already be in `.draining` / `.dead` during HTTP teardown.
    pub fn isDeliverableForRealm(
        self: *const Guard,
        current: TaskOwner,
        opts: struct {
            manager_shutdown: bool = false,
            realm_dead_or_draining: bool = false,
            going_away: bool = false,
        },
    ) bool {
        if (self.finished) return false;
        if (opts.manager_shutdown or opts.going_away or opts.realm_dead_or_draining) return false;
        return !RealmLifecycleKernel.taskOwnerIsStale(self.task_owner, current);
    }

    /// Idempotent arena release. Safe to call from shutdown, error, and done paths.
    pub fn finish(self: *Guard, release_arena: *const fn () void) void {
        if (self.finished) return;
        self.finished = true;
        release_arena();
    }
};
