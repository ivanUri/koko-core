const std = @import("std");
const RC = @import("../../support/rc.zig").RC;

const js = @import("../js/js.zig");
const EventTarget = @import("../webapi/EventTarget.zig");
const Frame = @import("../browser/Frame.zig");
const Page = @import("../browser/Page.zig");

const ViewTransition = @This();

const State = enum {
    updating,
    skipped,
    completed,
    failed,
};

const UpdateTask = struct {
    transition: *ViewTransition,
    callback: ?js.Function.Temp,
    frame: *Frame,
    arena: std.mem.Allocator,

    fn releaseResources(self: *UpdateTask) void {
        if (self.callback) |callback| callback.release();
        self.transition.releaseRef(self.frame._page);
        self.frame.releaseArena(self.arena);
    }

    fn finalize(ctx: *anyopaque) void {
        const self: *UpdateTask = @ptrCast(@alignCast(ctx));
        self.releaseResources();
    }

    fn run(ctx: *anyopaque) !?u32 {
        const self: *UpdateTask = @ptrCast(@alignCast(ctx));
        defer self.releaseResources();

        var scope: js.Local.Scope = undefined;
        self.frame.js.localScope(&scope);
        defer scope.deinit();

        const local = &scope.local;
        if (self.callback) |callback| {
            const result = local.toLocal(callback).call(js.Value, .{}) catch {
                self.transition.fail(local);
                return null;
            };

            if (result.isPromise()) {
                self.transition.acquireRef();
                const fulfilled = local.newCallback(ViewTransition.updateFulfilled, self.transition);
                const rejected = local.newCallback(ViewTransition.updateRejected, self.transition);
                _ = result.toPromise().thenAndCatch(fulfilled, rejected) catch {
                    self.transition.fail(local);
                    self.transition.releaseRef(self.frame._page);
                };
                return null;
            }
        }

        self.transition.complete(local);
        return null;
    }
};

_rc: RC(u32) = .{},
_frame: *Frame,
_arena: std.mem.Allocator,
_proto: *EventTarget,
_update_callback_done: js.PromiseResolver.Global,
_ready: js.PromiseResolver.Global,
_finished: js.PromiseResolver.Global,
_state: State = .updating,

/// This models the update-callback lifecycle only. It deliberately does not
/// claim to capture pixels, create pseudo-elements, or run a visual animation.
pub fn init(callback: ?js.Function.Temp, frame: *Frame) !*ViewTransition {
    const local = frame.js.local orelse return error.NotHandled;
    const arena = try frame.getArena(.tiny, "ViewTransition");
    errdefer frame.releaseArena(arena);

    const proto = try frame._factory.create(EventTarget{ ._type = .generic });

    var update_resolver = local.createPromiseResolver();
    var ready_resolver = local.createPromiseResolver();
    var finished_resolver = local.createPromiseResolver();

    const self = try arena.create(ViewTransition);
    self.* = .{
        ._frame = frame,
        ._arena = arena,
        ._proto = proto,
        ._update_callback_done = try update_resolver.persist(),
        ._ready = try ready_resolver.persist(),
        ._finished = try finished_resolver.persist(),
    };

    const task_arena = try frame.getArena(.tiny, "ViewTransition.update");
    const task = task_arena.create(UpdateTask) catch |err| {
        frame.releaseArena(task_arena);
        return err;
    };
    task.* = .{
        .transition = self,
        .callback = callback,
        .frame = frame,
        .arena = task_arena,
    };

    // The task owns one reference until it runs or is cancelled by realm
    // teardown. The JS identity owns the initial reference.
    self.acquireRef();
    frame.js.scheduler.add(task, UpdateTask.run, 0, .{
        .name = "ViewTransition.update",
        .finalizer = UpdateTask.finalize,
    }) catch |err| {
        task.releaseResources();
        return err;
    };

    return self;
}

pub fn deinit(self: *ViewTransition, page: *Page) void {
    page.releaseArena(self._arena);
}

pub fn releaseRef(self: *ViewTransition, page: *Page) void {
    self._rc.release(self, page);
}

pub fn acquireRef(self: *ViewTransition) void {
    self._rc.acquire();
}

fn complete(self: *ViewTransition, local: *const js.Local) void {
    switch (self._state) {
        .updating => {
            local.toLocal(self._update_callback_done).resolve("ViewTransition.updateCallbackDone", js.Undefined{});
            local.toLocal(self._ready).resolve("ViewTransition.ready", js.Undefined{});
            local.toLocal(self._finished).resolve("ViewTransition.finished", js.Undefined{});
            self._state = .completed;
        },
        .skipped => {
            local.toLocal(self._update_callback_done).resolve("ViewTransition.updateCallbackDone", js.Undefined{});
            self._state = .completed;
        },
        .completed, .failed => {},
    }
}

fn fail(self: *ViewTransition, local: *const js.Local) void {
    switch (self._state) {
        .updating => {
            const reason = js.PromiseResolver.RejectError{ .generic_error = "View transition update callback failed" };
            local.toLocal(self._update_callback_done).rejectError("ViewTransition.updateCallbackDone", reason);
            local.toLocal(self._ready).rejectError("ViewTransition.ready", reason);
            local.toLocal(self._finished).rejectError("ViewTransition.finished", reason);
            self._state = .failed;
        },
        .skipped => {
            const reason = js.PromiseResolver.RejectError{ .generic_error = "View transition update callback failed" };
            local.toLocal(self._update_callback_done).rejectError("ViewTransition.updateCallbackDone", reason);
            self._state = .failed;
        },
        .completed, .failed => {},
    }
}

fn failWithReason(self: *ViewTransition, local: *const js.Local, reason: js.Value) void {
    switch (self._state) {
        .updating => {
            local.toLocal(self._update_callback_done).reject("ViewTransition.updateCallbackDone", reason);
            local.toLocal(self._ready).reject("ViewTransition.ready", reason);
            local.toLocal(self._finished).reject("ViewTransition.finished", reason);
            self._state = .failed;
        },
        .skipped => {
            local.toLocal(self._update_callback_done).reject("ViewTransition.updateCallbackDone", reason);
            self._state = .failed;
        },
        .completed, .failed => {},
    }
}

fn updateFulfilled(self: *ViewTransition) void {
    const local = self._frame.js.local orelse {
        self.releaseRef(self._frame._page);
        return;
    };
    self.complete(local);
    self.releaseRef(self._frame._page);
}

fn updateRejected(self: *ViewTransition, reason: js.Value) void {
    const local = self._frame.js.local orelse {
        self.releaseRef(self._frame._page);
        return;
    };
    self.failWithReason(local, reason);
    self.releaseRef(self._frame._page);
}

pub fn getUpdateCallbackDone(self: *const ViewTransition, frame: *Frame) !js.Promise {
    return frame.js.toLocal(self._update_callback_done).promise();
}

pub fn getReady(self: *const ViewTransition, frame: *Frame) !js.Promise {
    return frame.js.toLocal(self._ready).promise();
}

pub fn getFinished(self: *const ViewTransition, frame: *Frame) !js.Promise {
    return frame.js.toLocal(self._finished).promise();
}

pub fn skipTransition(self: *ViewTransition) void {
    const local = self._frame.js.local orelse return;
    if (self._state != .updating) return;

    self._state = .skipped;
    // There is no renderer-backed animation to skip. Readiness and completion
    // settle now; the update callback promise still waits for its task.
    local.toLocal(self._ready).resolve("ViewTransition.skipTransition", js.Undefined{});
    local.toLocal(self._finished).resolve("ViewTransition.skipTransition", js.Undefined{});
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(ViewTransition);

    pub const Meta = struct {
        pub const name = "ViewTransition";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };

    pub const updateCallbackDone = bridge.accessor(ViewTransition.getUpdateCallbackDone, null, .{});
    pub const ready = bridge.accessor(ViewTransition.getReady, null, .{});
    pub const finished = bridge.accessor(ViewTransition.getFinished, null, .{});
    pub const skipTransition = bridge.function(ViewTransition.skipTransition, .{});
};
