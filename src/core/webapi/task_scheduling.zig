// Prioritized Task Scheduling API — TaskController / TaskSignal for Google boq-identity.

const js = @import("../js/js.zig");
const AbortController = @import("AbortController.zig");
const AbortSignal = @import("AbortSignal.zig");

const Execution = js.Execution;

pub fn registerTypes() []const type {
    return &.{ TaskController, TaskSignal };
}

pub const TaskSignal = struct {
    _proto: *AbortSignal,
    _priority: []const u8 = "user-visible",
    _on_priority_change: ?js.Function.Global = null,

    pub fn init(exec: *const Execution) !*TaskSignal {
        return exec._factory.taskSignal(TaskSignal{
            ._proto = undefined,
        });
    }

    pub fn getPriority(self: *const TaskSignal) []const u8 {
        return self._priority;
    }

    pub fn getOnPriorityChange(self: *const TaskSignal) ?js.Function.Global {
        return self._on_priority_change;
    }

    pub fn setOnPriorityChange(self: *TaskSignal, cb: ?js.Function.Global) !void {
        self._on_priority_change = cb;
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(TaskSignal);
        pub const Meta = struct {
            pub const name = "TaskSignal";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
        };
        pub const Prototype = AbortSignal;
        pub const priority = bridge.accessor(TaskSignal.getPriority, null, .{});
        pub const onprioritychange = bridge.accessor(TaskSignal.getOnPriorityChange, TaskSignal.setOnPriorityChange, .{});
    };
};

pub const TaskController = struct {
    _signal: *TaskSignal,

    pub fn init(exec: *const Execution) !*TaskController {
        const signal = try TaskSignal.init(exec);
        return exec._factory.create(TaskController{
            ._signal = signal,
        });
    }

    pub fn getSignal(self: *const TaskController) *TaskSignal {
        return self._signal;
    }

    pub fn setPriority(self: *TaskController, priority: []const u8, exec: *const Execution) !void {
        self._signal._priority = try exec.dupeString(priority);
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(TaskController);
        pub const Meta = struct {
            pub const name = "TaskController";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
        };
        pub const Prototype = AbortController;
        pub const constructor = bridge.constructor(TaskController.init, .{});
        pub const signal = bridge.accessor(TaskController.getSignal, null, .{});
        pub const setPriority = bridge.function(TaskController.setPriority, .{});
    };
};
