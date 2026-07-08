//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

const js = @import("../js/js.zig");
const WorkerGlobalScope = @import("WorkerGlobalScope.zig");

const SharedWorkerGlobalScope = @This();

/// Shared workers reuse WorkerGlobalScope; this type exists for instanceof / global name.
_proto: *WorkerGlobalScope,

pub const JsApi = struct {
    pub const bridge = js.Bridge(SharedWorkerGlobalScope);

    pub const Meta = struct {
        pub const name = "SharedWorkerGlobalScope";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };

    // Global object TAO is *WorkerGlobalScope; accessors must use that receiver type.
    pub const self = WorkerGlobalScope.JsApi.bridge.accessor(WorkerGlobalScope.getSelf, null, .{});
    pub const globalThis = WorkerGlobalScope.JsApi.bridge.accessor(WorkerGlobalScope.getSelf, null, .{});
    pub const name = WorkerGlobalScope.JsApi.bridge.accessor(WorkerGlobalScope.getName, WorkerGlobalScope.setName, .{});
    pub const onconnect = WorkerGlobalScope.JsApi.bridge.accessor(WorkerGlobalScope.getOnConnect, WorkerGlobalScope.setOnConnect, .{});
    pub const onerror = WorkerGlobalScope.JsApi.bridge.accessor(WorkerGlobalScope.getOnError, WorkerGlobalScope.setOnError, .{});
};
