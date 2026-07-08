const std = @import("std");

const c = @cImport({
    @cInclude("zlib.h");
});

pub const Format = enum {
    gzip,
    deflate,
    @"deflate-raw",

    pub fn fromJs(name: []const u8) ?Format {
        if (std.mem.eql(u8, name, "gzip")) return .gzip;
        if (std.mem.eql(u8, name, "deflate")) return .deflate;
        if (std.mem.eql(u8, name, "deflate-raw")) return .@"deflate-raw";
        return null;
    }

    fn windowBits(self: Format) c_int {
        return switch (self) {
            .gzip => 15 + 16,
            .deflate => 15,
            .@"deflate-raw" => -15,
        };
    }
};

pub const Compressor = struct {
    strm: c.z_stream = undefined,
    active: bool = false,

    pub fn init(self: *Compressor, format: Format) !void {
        self.strm = std.mem.zeroes(c.z_stream);
        const rc = c.deflateInit2(
            &self.strm,
            c.Z_DEFAULT_COMPRESSION,
            c.Z_DEFLATED,
            format.windowBits(),
            8,
            c.Z_DEFAULT_STRATEGY,
        );
        if (rc != c.Z_OK) return error.ZlibError;
        self.active = true;
    }

    pub fn deinit(self: *Compressor) void {
        if (!self.active) return;
        _ = c.deflateEnd(&self.strm);
        self.active = false;
    }

    pub fn process(self: *Compressor, input: []const u8, output: []u8, flush: c_int) !struct {
        consumed: usize,
        produced: usize,
        done: bool,
    } {
        self.strm.next_in = @constCast(input.ptr);
        self.strm.avail_in = @intCast(input.len);
        self.strm.next_out = output.ptr;
        self.strm.avail_out = @intCast(output.len);

        const rc = c.deflate(&self.strm, flush);
        if (rc != c.Z_OK and rc != c.Z_STREAM_END and rc != c.Z_BUF_ERROR) return error.ZlibError;

        return .{
            .consumed = input.len - self.strm.avail_in,
            .produced = output.len - self.strm.avail_out,
            .done = rc == c.Z_STREAM_END,
        };
    }
};

pub const Decompressor = struct {
    strm: c.z_stream = undefined,
    active: bool = false,

    pub fn init(self: *Decompressor, format: Format) !void {
        self.strm = std.mem.zeroes(c.z_stream);
        const rc = c.inflateInit2(&self.strm, format.windowBits());
        if (rc != c.Z_OK) return error.ZlibError;
        self.active = true;
    }

    pub fn deinit(self: *Decompressor) void {
        if (!self.active) return;
        _ = c.inflateEnd(&self.strm);
        self.active = false;
    }

    pub fn process(self: *Decompressor, input: []const u8, output: []u8, flush: c_int) !struct {
        consumed: usize,
        produced: usize,
        done: bool,
    } {
        self.strm.next_in = @constCast(input.ptr);
        self.strm.avail_in = @intCast(input.len);
        self.strm.next_out = output.ptr;
        self.strm.avail_out = @intCast(output.len);

        const rc = c.inflate(&self.strm, flush);
        if (rc != c.Z_OK and rc != c.Z_STREAM_END and rc != c.Z_BUF_ERROR) return error.ZlibError;

        return .{
            .consumed = input.len - self.strm.avail_in,
            .produced = output.len - self.strm.avail_out,
            .done = rc == c.Z_STREAM_END,
        };
    }
};
