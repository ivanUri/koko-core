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

const DecompressionStream = @This();

_transform: *TransformStream,
_decompressor: zlib_stream.Decompressor,
_scratch: [65536]u8 = undefined,

pub fn init(format: []const u8, exec: *const Execution) !*DecompressionStream {
    const fmt = zlib_stream.Format.fromJs(format) orelse return error.NotSupportedError;

    const self = try exec._factory.create(DecompressionStream{
        ._transform = undefined,
        ._decompressor = .{},
    });
    errdefer self._decompressor.deinit();

    try self._decompressor.init(fmt);

    const transform = try TransformStream.initWithZigTransform(
        decompressChunk,
        decompressFlush,
        exec,
    );
    transform._zig_user_data = self;
    self._transform = transform;

    return self;
}

fn selfFrom(controller: *TransformStream.DefaultController) *DecompressionStream {
    const transform = controller._stream;
    return @ptrCast(@alignCast(transform._zig_user_data.?));
}

fn decompressChunk(controller: *TransformStream.DefaultController, chunk: js.Value) !void {
    const self = selfFrom(controller);
    const typed = try chunk.toZig(js.TypedArray(u8));
    var remaining = typed.values;
    while (remaining.len > 0) {
        const result = try self._decompressor.process(remaining, &self._scratch, c.Z_NO_FLUSH);
        if (result.produced > 0) {
            try controller.enqueue(.{ .uint8array = .{ .values = self._scratch[0..result.produced] } });
        }
        remaining = remaining[result.consumed..];
        if (result.consumed == 0 and result.produced == 0) break;
    }
}

fn decompressFlush(controller: *TransformStream.DefaultController) !void {
    const self = selfFrom(controller);
    var done = false;
    while (!done) {
        const result = try self._decompressor.process(&.{}, &self._scratch, c.Z_FINISH);
        if (result.produced > 0) {
            try controller.enqueue(.{ .uint8array = .{ .values = self._scratch[0..result.produced] } });
        }
        done = result.done;
        if (result.produced == 0 and !done) break;
    }
    self._decompressor.deinit();
}

pub fn getReadable(self: *const DecompressionStream) *ReadableStream {
    return self._transform.getReadable();
}

pub fn getWritable(self: *const DecompressionStream) *WritableStream {
    return self._transform.getWritable();
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(DecompressionStream);

    pub const Meta = struct {
        pub const name = "DecompressionStream";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };

    pub const constructor = bridge.constructor(DecompressionStream.init, .{ .dom_exception = true });
    pub const readable = bridge.accessor(DecompressionStream.getReadable, null, .{});
    pub const writable = bridge.accessor(DecompressionStream.getWritable, null, .{});
};
