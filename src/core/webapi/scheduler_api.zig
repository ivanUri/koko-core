// Prioritized Task Scheduling API — window.scheduler for Google boq-identity.

const std = @import("std");
const js = @import("../js/js.zig");
const Frame = @import("../browser/Frame.zig");

const Allocator = std.mem.Allocator;

pub fn registerTypes() []const type {
    return &.{ Scheduler, Scheduling };
}

pub const Scheduling = struct {
    _pad: bool = false,

    pub fn isInputPending(_: *const Scheduling, _: *Frame) bool {
        return false;
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(Scheduling);
        pub const Meta = struct {
            pub const name = "Scheduling";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
            pub const empty_with_no_proto = true;
        };
        pub const isInputPending = bridge.function(Scheduling.isInputPending, .{});
    };
};

const PostTaskCallback = struct {
    cb: js.Function.Temp,
    exec: *js.Execution,
    arena: Allocator,

    fn deinit(self: *PostTaskCallback) void {
        self.cb.release();
        self.exec.releaseArena(self.arena);
    }

    fn run(ptr: *anyopaque) !?u32 {
        const self: *PostTaskCallback = @ptrCast(@alignCast(ptr));
        defer self.deinit();

        var ls: js.Local.Scope = undefined;
        self.exec.context.localScope(&ls);
        defer ls.deinit();

        ls.toLocal(self.cb).call(void, &.{}) catch {};
        ls.local.ctx.env.runMicrotasks(.timer_callback);
        return null;
    }
};

pub const Scheduler = struct {
    _pad: bool = false,

    pub fn postTask(self: *const Scheduler, callback: js.Function.Temp, frame: *Frame) !js.Promise {
        _ = self;
        const exec = &frame.js.execution;
        const local = frame.js.local orelse return error.NotHandled;

        const arena = try exec.getArena(.tiny, "Scheduler.postTask");
        errdefer exec.releaseArena(arena);

        const task = try arena.create(PostTaskCallback);
        task.* = .{
            .cb = callback,
            .exec = exec,
            .arena = arena,
        };

        try exec.context.scheduler.add(task, PostTaskCallback.run, 0, .{
            .name = "Scheduler.postTask",
        });

        const obj = local.newObject();
        return local.resolvePromise(obj);
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(Scheduler);
        pub const Meta = struct {
            pub const name = "Scheduler";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
            pub const empty_with_no_proto = true;
        };
        pub const postTask = bridge.function(Scheduler.postTask, .{});
    };
};
