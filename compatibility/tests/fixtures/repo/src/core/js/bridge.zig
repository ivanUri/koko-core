pub const PageJsApis = flattenTypes(&.{
    @import("../webapi/Example.zig"),
});

pub const WorkerJsApis = flattenTypes(&.{
    @import("../webapi/Example.zig"),
});

pub const SharedWorkerJsApis = flattenTypes(&.{
    @import("../webapi/Example.zig"),
});
