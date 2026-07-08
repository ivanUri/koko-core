const std = @import("std");
const js = @import("../../js/js.zig");
const zlib_stream = @import("../../../support/sys/zlib_stream.zig");

const ReadableStream = @import("ReadableStream.zig");
const WritableStream = @import("WritableStream.zig");
const TransformStream = @import("TransformStream.zig");

const Execution = js.Execution;
const c = @cImport({
    @cInclude("zlib.h");
});

const CompressionStream = @This();

_transform: *TransformStream,
_compressor: zlib_stream.Compressor,
_scratch: [65536]u8 = undefined,

pub fn init(format: []const u8, exec: *const Execution) !*CompressionStream {
    const fmt = zlib_stream.Format.fromJs(format) orelse return error.NotSupportedError;

    const self = try exec._factory.create(CompressionStream{
        ._transform = undefined,
        ._compressor = .{},
    });
    errdefer self._compressor.deinit();

    try self._compressor.init(fmt);

    const transform = try TransformStream.initWithZigTransform(
        compressChunk,
        compressFlush,
        exec,
    );
    transform._zig_user_data = self;
    self._transform = transform;

    return self;
}

fn selfFrom(controller: *TransformStream.DefaultController) *CompressionStream {
    const transform = controller._stream;
    return @ptrCast(@alignCast(transform._zig_user_data.?));
}

fn compressChunk(controller: *TransformStream.DefaultController, chunk: js.Value) !void {
    const self = selfFrom(controller);
    const typed = try chunk.toZig(js.TypedArray(u8));
    var remaining = typed.values;
    while (remaining.len > 0) {
        const result = try self._compressor.process(remaining, &self._scratch, c.Z_NO_FLUSH);
        if (result.produced > 0) {
            try controller.enqueue(.{ .uint8array = .{ .values = self._scratch[0..result.produced] } });
        }
        remaining = remaining[result.consumed..];
        if (result.consumed == 0 and result.produced == 0) break;
    }
}

fn compressFlush(controller: *TransformStream.DefaultController) !void {
    const self = selfFrom(controller);
    var done = false;
    while (!done) {
        const result = try self._compressor.process(&.{}, &self._scratch, c.Z_FINISH);
        if (result.produced > 0) {
            try controller.enqueue(.{ .uint8array = .{ .values = self._scratch[0..result.produced] } });
        }
        done = result.done;
        if (result.produced == 0 and !done) break;
    }
    self._compressor.deinit();
}

pub fn getReadable(self: *const CompressionStream) *ReadableStream {
    return self._transform.getReadable();
}

pub fn getWritable(self: *const CompressionStream) *WritableStream {
    return self._transform.getWritable();
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(CompressionStream);

    pub const Meta = struct {
        pub const name = "CompressionStream";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };

    pub const constructor = bridge.constructor(CompressionStream.init, .{ .dom_exception = true });
    pub const readable = bridge.accessor(CompressionStream.getReadable, null, .{});
    pub const writable = bridge.accessor(CompressionStream.getWritable, null, .{});
};
