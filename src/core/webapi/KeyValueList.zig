//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

const std = @import("std");

const js = @import("../js/js.zig");
const h5e = @import("../parser/html5ever.zig");

const String = @import("../../support/string.zig").String;
const Execution = js.Execution;
const Allocator = std.mem.Allocator;

pub fn registerTypes() []const type {
    return &.{
        KeyIterator,
        ValueIterator,
        EntryIterator,
    };
}

const Normalizer = *const fn ([]const u8, []u8) []const u8;

pub const Entry = struct {
    name: String,
    value: String,

    pub fn format(self: Entry, writer: *std.Io.Writer) !void {
        return writer.print("{f}: {f}", .{ self.name, self.value });
    }
};

pub const KeyValueList = @This();

_entries: std.ArrayList(Entry) = .empty,

pub const empty: KeyValueList = .{
    ._entries = .empty,
};

pub fn copy(arena: Allocator, original: KeyValueList) !KeyValueList {
    var list = KeyValueList.init();
    try list.ensureTotalCapacity(arena, original.len());
    for (original._entries.items) |entry| {
        try list.appendAssumeCapacity(arena, entry.name.str(), entry.value.str());
    }
    return list;
}

pub fn fromJsObject(arena: Allocator, js_obj: js.Object, comptime normalizer: ?Normalizer, buf: []u8) !KeyValueList {
    if (js.v8.v8__Value__IsArray(@ptrCast(js_obj.handle))) return error.TypeError;
    if (isArrayLikeObject(js_obj)) return error.TypeError;

    const names = try js_obj.getOwnPropertyNames();
    var list = KeyValueList.init();
    try list.ensureTotalCapacity(arena, names.len());

    var i: u32 = 0;
    while (i < names.len()) : (i += 1) {
        const key_val = try names.get(i);
        const key_str = key_val.isString() orelse return error.InvalidArgument;

        const js_value = try js_obj.get(key_str.handle);
        const name_slice = try key_str.toSliceWithAlloc(arena);
        const normalized = if (comptime normalizer) |n| n(name_slice, buf) else name_slice;

        try list.upsert(arena, normalized, try (try js_value.toString()).toSliceWithAlloc(arena));
    }

    return list;
}

fn isArrayLikeObject(obj: js.Object) bool {
    if (!obj.has("0")) return false;
    if (!obj.has("length")) return false;
    const length_val = obj.get("length") catch return false;
    return length_val.isUint32() or length_val.isInt32();
}

pub fn fromArray(arena: Allocator, kvs: []const [2][]const u8, comptime normalizer: ?Normalizer, buf: []u8) !KeyValueList {
    var list = KeyValueList.init();
    try list.ensureTotalCapacity(arena, kvs.len);

    for (kvs) |pair| {
        const normalized = if (comptime normalizer) |n| n(pair[0], buf) else pair[0];

        list._entries.appendAssumeCapacity(.{
            .name = try String.init(arena, normalized, .{}),
            .value = try String.init(arena, pair[1], .{}),
        });
    }
    return list;
}

pub fn init() KeyValueList {
    return .{};
}

pub fn ensureTotalCapacity(self: *KeyValueList, allocator: Allocator, n: usize) !void {
    return self._entries.ensureTotalCapacity(allocator, n);
}

pub fn get(self: *const KeyValueList, name: []const u8) ?[]const u8 {
    for (self._entries.items) |*entry| {
        if (entry.name.eqlSlice(name)) {
            return entry.value.str();
        }
    }
    return null;
}

pub fn getAll(self: *const KeyValueList, allocator: Allocator, name: []const u8) ![]const []const u8 {
    var arr: std.ArrayList([]const u8) = .empty;
    for (self._entries.items) |*entry| {
        if (entry.name.eqlSlice(name)) {
            try arr.append(allocator, entry.value.str());
        }
    }
    return arr.items;
}

pub fn has(self: *const KeyValueList, name: []const u8) bool {
    for (self._entries.items) |*entry| {
        if (entry.name.eqlSlice(name)) {
            return true;
        }
    }
    return false;
}

pub fn hasPair(self: *const KeyValueList, name: []const u8, value: []const u8) bool {
    for (self._entries.items) |*entry| {
        if (entry.name.eqlSlice(name) and entry.value.eqlSlice(value)) {
            return true;
        }
    }
    return false;
}

pub fn append(self: *KeyValueList, allocator: Allocator, name: []const u8, value: []const u8) !void {
    try self._entries.append(allocator, .{
        .name = try String.init(allocator, name, .{}),
        .value = try String.init(allocator, value, .{}),
    });
}

pub fn appendAssumeCapacity(self: *KeyValueList, allocator: Allocator, name: []const u8, value: []const u8) !void {
    self._entries.appendAssumeCapacity(.{
        .name = try String.init(allocator, name, .{}),
        .value = try String.init(allocator, value, .{}),
    });
}

pub fn delete(self: *KeyValueList, name: []const u8, value: ?[]const u8) void {
    var i: usize = 0;
    while (i < self._entries.items.len) {
        const entry = self._entries.items[i];
        if (entry.name.eqlSlice(name)) {
            if (value == null or entry.value.eqlSlice(value.?)) {
                _ = self._entries.orderedRemove(i);
                continue;
            }
        }
        i += 1;
    }
}

pub fn set(self: *KeyValueList, allocator: Allocator, name: []const u8, value: []const u8) !void {
    var first_idx: ?usize = null;
    var i: usize = 0;
    while (i < self._entries.items.len) {
        if (self._entries.items[i].name.eqlSlice(name)) {
            if (first_idx == null) {
                first_idx = i;
                self._entries.items[i].value = try String.init(allocator, value, .{});
                i += 1;
            } else {
                _ = self._entries.orderedRemove(i);
            }
        } else {
            i += 1;
        }
    }
    if (first_idx == null) {
        try self.append(allocator, name, value);
    }
}

/// Record-style init: update an existing normalized name in place, preserving enumeration order.
pub fn upsert(self: *KeyValueList, allocator: Allocator, name: []const u8, value: []const u8) !void {
    for (self._entries.items) |*entry| {
        if (entry.name.eqlSlice(name)) {
            entry.value = try String.init(allocator, value, .{});
            return;
        }
    }
    try self.append(allocator, name, value);
}

pub fn len(self: *const KeyValueList) usize {
    return self._entries.items.len;
}

pub fn items(self: *const KeyValueList) []const Entry {
    return self._entries.items;
}

pub const UrlEncodedParseOpts = struct {
    strip_leading_question_mark: bool = false,
};

/// Parse an application/x-www-form-urlencoded byte sequence (percent-decode, UTF-8).
pub fn fromUrlEncodedString(
    arena: Allocator,
    input_: []const u8,
    buf: []u8,
    opts: UrlEncodedParseOpts,
) !KeyValueList {
    if (input_.len == 0) {
        return .empty;
    }

    var input = input_;
    if (opts.strip_leading_question_mark and input[0] == '?') {
        input = input[1..];
    }

    if (input.len == 0) {
        return .empty;
    }

    var params = KeyValueList.init();

    var it = std.mem.splitScalar(u8, input, '&');
    while (it.next()) |entry| {
        if (entry.len == 0) continue;

        const name, const value = if (std.mem.indexOfScalarPos(u8, entry, 0, '=')) |idx| .{
            try percentDecodeField(arena, entry[0..idx], buf),
            try percentDecodeField(arena, entry[idx + 1 ..], buf),
        } else .{
            try percentDecodeField(arena, entry, buf),
            comptime String.wrap(""),
        };

        try params._entries.append(arena, .{ .name = name, .value = value });
    }

    return params;
}

fn percentDecodeField(arena: Allocator, value: []const u8, buf: []u8) !String {
    if (value.len == 0) {
        return comptime String.wrap("");
    }

    var has_plus = false;
    var unescaped_len = value.len;

    var in_i: usize = 0;
    while (in_i < value.len) {
        const b = value[in_i];
        if (b == '%') {
            if (in_i + 2 < value.len and std.ascii.isHex(value[in_i + 1]) and std.ascii.isHex(value[in_i + 2])) {
                in_i += 3;
                unescaped_len -= 2;
            } else {
                in_i += 1;
            }
        } else if (b == '+') {
            has_plus = true;
            in_i += 1;
        } else {
            in_i += 1;
        }
    }

    if (unescaped_len == value.len and !has_plus) {
        return String.init(arena, value, .{});
    }

    var out = buf;
    var duped = false;
    if (buf.len < unescaped_len) {
        out = try arena.alloc(u8, unescaped_len);
        duped = true;
    }

    in_i = 0;
    for (0..unescaped_len) |i| {
        const b = value[in_i];
        if (b == '%') {
            if (in_i + 2 < value.len and std.ascii.isHex(value[in_i + 1]) and std.ascii.isHex(value[in_i + 2])) {
                out[i] = decodePercentHex(value[in_i + 1]) << 4 | decodePercentHex(value[in_i + 2]);
                in_i += 3;
            } else {
                out[i] = '%';
                in_i += 1;
            }
        } else if (b == '+') {
            out[i] = ' ';
            in_i += 1;
        } else {
            out[i] = b;
            in_i += 1;
        }
    }

    return String.init(arena, out[0..unescaped_len], .{ .dupe = !duped });
}

const PERCENT_HEX_DECODE_ARRAY = blk: {
    var all: ['f' - '0' + 1]u8 = undefined;
    for ('0'..('9' + 1)) |b| all[b - '0'] = b - '0';
    for ('A'..('F' + 1)) |b| all[b - '0'] = b - 'A' + 10;
    for ('a'..('f' + 1)) |b| all[b - '0'] = b - 'a' + 10;
    break :blk all;
};

inline fn decodePercentHex(char: u8) u8 {
    return @as([*]const u8, @ptrFromInt((@intFromPtr(&PERCENT_HEX_DECODE_ARRAY) - @as(usize, '0'))))[char];
}

const Utf16CodeUnitIter = struct {
    s: []const u8,
    pos: usize = 0,
    pending: ?u16 = null,

    fn next(self: *Utf16CodeUnitIter) ?u16 {
        if (self.pending) |unit| {
            self.pending = null;
            return unit;
        }
        if (self.pos >= self.s.len) return null;

        const seq_len = std.unicode.utf8ByteSequenceLength(self.s[self.pos]) catch {
            self.pos += 1;
            return 0xFFFD;
        };
        if (self.pos + seq_len > self.s.len) {
            self.pos += 1;
            return 0xFFFD;
        }

        const cp = std.unicode.utf8Decode(self.s[self.pos..][0..seq_len]) catch {
            self.pos += 1;
            return 0xFFFD;
        };
        self.pos += seq_len;

        if (cp > 0xFFFF) {
            const val = cp - 0x10000;
            self.pending = @truncate(0xDC00 + (val & 0x3FF));
            return @truncate(0xD800 + (val >> 10));
        }
        return @truncate(cp);
    }
};

pub fn cmpUtf16CodeUnits(a: []const u8, b: []const u8) std.math.Order {
    var ia: Utf16CodeUnitIter = .{ .s = a };
    var ib: Utf16CodeUnitIter = .{ .s = b };
    while (true) {
        const ca = ia.next();
        const cb = ib.next();
        if (ca == null and cb == null) return .eq;
        if (ca == null) return .lt;
        if (cb == null) return .gt;
        if (ca.? != cb.?) return std.math.order(ca.?, cb.?);
    }
}

const URLEncodeMode = enum {
    form,
    query,
};

// URL-encode the key-value pairs.
// For UTF-8 charset, does standard percent encoding.
// For legacy charsets, converts to that encoding with NCR fallback for unmappable chars.
pub fn urlEncode(self: *const KeyValueList, comptime mode: URLEncodeMode, allocator_: ?Allocator, charset: []const u8, writer: *std.Io.Writer) !void {
    const entries = self._entries.items;
    if (entries.len == 0) {
        return;
    }

    try urlEncodeEntry(entries[0], mode, allocator_, charset, writer);
    for (entries[1..]) |entry| {
        try writer.writeByte('&');
        try urlEncodeEntry(entry, mode, allocator_, charset, writer);
    }
}

fn urlEncodeEntry(entry: Entry, comptime mode: URLEncodeMode, allocator_: ?Allocator, charset: []const u8, writer: *std.Io.Writer) !void {
    try urlEncodeValue(entry.name.str(), mode, allocator_, charset, writer);
    // URL standard always emits "=" between name and value, even when either is empty.
    // https://url.spec.whatwg.org/#concept-urlencoded-serializer
    try writer.writeByte('=');
    if (entry.value.len == 0) return;
    try urlEncodeValue(entry.value.str(), mode, allocator_, charset, writer);
}

// Exposed so FormData (which keeps its own entry list) can reuse the charset/NCR-aware encoder.
pub fn urlEncodeFormValue(value: []const u8, allocator_: ?Allocator, charset: []const u8, writer: *std.Io.Writer) !void {
    return urlEncodeValue(value, .form, allocator_, charset, writer);
}

fn urlEncodeValue(value: []const u8, comptime mode: URLEncodeMode, allocator_: ?Allocator, charset: []const u8, writer: *std.Io.Writer) !void {
    // For UTF-8, do standard percent encoding
    if (std.mem.eql(u8, charset, "UTF-8")) {
        return urlEncodeValueUtf8(value, mode, writer);
    }

    const allocator = allocator_ orelse return urlEncodeValueUtf8(value, mode, writer);

    const enc_info = h5e.encoding_for_label(charset.ptr, charset.len);
    if (!enc_info.isValid()) {
        // Unknown encoding, fall back to UTF-8
        return urlEncodeValueUtf8(value, mode, writer);
    }

    // Calculate max buffer size for encoded output
    // encoding_max_encode_buffer_length doesn't account for NCR expansion,
    // so we need extra space. Each UTF-8 char (1-4 bytes) can become &#NNNNNNN; (10 bytes)
    const base_len = h5e.encoding_max_encode_buffer_length(enc_info.handle.?, value.len);
    if (base_len == 0) {
        return urlEncodeValueUtf8(value, mode, writer);
    }
    // For NCR encoding, each character could expand significantly
    // Use 4x the base buffer to be safe (NCRs are ~10 bytes for a 3-byte UTF-8 char)
    const max_encoded_len = base_len * 4;

    const encode_buf = try allocator.alloc(u8, max_encoded_len);
    defer allocator.free(encode_buf);

    // Encode UTF-8 to legacy encoding with NCR fallback
    const result = h5e.encoding_encode_with_ncr(
        enc_info.handle.?,
        value.ptr,
        value.len,
        encode_buf.ptr,
        encode_buf.len,
    );

    if (!result.isSuccess()) {
        // Encoding failed, fall back to UTF-8
        return urlEncodeValueUtf8(value, mode, writer);
    }

    // Percent-encode the result, preserving NCRs (& and ; must be encoded)
    const encoded_bytes = encode_buf[0..result.bytes_written];
    return urlEncodeValueLegacy(encoded_bytes, mode, writer);
}

/// Percent-encode a UTF-8 value - bytes >= 0x80 are percent-encoded directly.
fn urlEncodeValueUtf8(value: []const u8, comptime mode: URLEncodeMode, writer: *std.Io.Writer) !void {
    if (!urlEncodeShouldEscape(value, mode)) {
        return writer.writeAll(value);
    }

    var i: usize = 0;
    while (i < value.len) : (i += 1) {
        const b = value[i];
        if (comptime mode == .form) {
            if (try writeFormLineEnd(value, &i, b, writer)) continue;
        }
        if (urlEncodeUnreserved(b, mode)) {
            try writer.writeByte(b);
        } else if (b == ' ') {
            try writer.writeByte('+');
        } else {
            try writer.print("%{X:0>2}", .{b});
        }
    }
}

/// Percent-encode a legacy-encoded value - must also encode & and ; to preserve NCRs.
fn urlEncodeValueLegacy(value: []const u8, comptime mode: URLEncodeMode, writer: *std.Io.Writer) !void {
    var i: usize = 0;
    while (i < value.len) : (i += 1) {
        const b = value[i];
        if (comptime mode == .form) {
            if (try writeFormLineEnd(value, &i, b, writer)) continue;
        }
        if (urlEncodeUnreserved(b, mode)) {
            try writer.writeByte(b);
        } else if (b == ' ') {
            try writer.writeByte('+');
        } else if (b == '&' or b == ';') {
            // Must encode & and ; to preserve NCRs like &#12345;
            try writer.print("%{X:0>2}", .{b});
        } else {
            try writer.print("%{X:0>2}", .{b});
        }
    }
}

// HTML form-data set encoding algorithm: every U+000D (CR) not followed by
// U+000A (LF), and every U+000A (LF) not preceded by U+000D (CR), is replaced
// with the two-byte sequence CR+LF before percent-encoding. Returns true (and
// emits "%0D%0A") when `b` is CR or LF; on CR, advances the caller's index
// past a following LF so existing CRLF pairs aren't doubled.
// https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#url-encoded-form-data
fn writeFormLineEnd(value: []const u8, i: *usize, b: u8, writer: *std.Io.Writer) !bool {
    if (b == '\r') {
        try writer.writeAll("%0D%0A");
        if (i.* + 1 < value.len and value[i.* + 1] == '\n') i.* += 1;
        return true;
    }
    if (b == '\n') {
        try writer.writeAll("%0D%0A");
        return true;
    }
    return false;
}

fn urlEncodeShouldEscape(value: []const u8, comptime mode: URLEncodeMode) bool {
    for (value) |b| {
        if (!urlEncodeUnreserved(b, mode)) {
            return true;
        }
    }
    return false;
}

fn urlEncodeUnreserved(b: u8, comptime mode: URLEncodeMode) bool {
    return switch (b) {
        'A'...'Z', 'a'...'z', '0'...'9', '-', '.', '_', '*' => true,
        '~' => comptime mode == .form,
        else => false,
    };
}

pub const Iterator = struct {
    index: u32 = 0,
    kv: *KeyValueList,

    // Why? Because whenever an Iterator is created, we need to increment the
    // RC of what it's iterating. And when the iterator is destroyed, we need
    // to decrement it. The generic iterator which will wrap this handles that
    // by using this "list" field. Most things that use the GenericIterator can
    // just set `list: *ZigCollection`, and everything will work. But KeyValueList
    // is being composed by various types, so it can't reference those types.
    // Using *anyopaque here is "dangerous", in that it requires the composer
    // to pass the right value, which normally would be itself (`*Self`), but
    // only because (as of now) everything that uses KeyValueList has no prototype
    list: *anyopaque,

    pub const Entry = struct { []const u8, []const u8 };

    pub fn next(self: *Iterator, _: *const Execution) ?Iterator.Entry {
        const index = self.index;
        const entries = self.kv._entries.items;
        if (index >= entries.len) {
            return null;
        }
        self.index = index + 1;

        const e = &entries[index];
        return .{ e.name.str(), e.value.str() };
    }
};

pub fn iterator(self: *const KeyValueList) Iterator {
    return .{ .list = self };
}

const GenericIterator = @import("collections/iterator.zig").Entry;
pub const KeyIterator = GenericIterator(Iterator, "0");
pub const ValueIterator = GenericIterator(Iterator, "1");
pub const EntryIterator = GenericIterator(Iterator, null);

const testing = @import("../../testing/testing.zig");

test "KeyValueList: urlEncode UTF-8" {
    // Test that UTF-8 characters are properly percent-encoded (not double-encoded)
    const allocator = testing.arena_allocator;
    var list = KeyValueList.init();
    try list.append(allocator, "cafe", "café"); // é = C3 A9 in UTF-8

    var buf = std.Io.Writer.Allocating.init(allocator);
    try list.urlEncode(.form, null, "UTF-8", &buf.writer);

    // é (U+00E9) in UTF-8 is C3 A9, percent-encoded as %C3%A9
    try testing.expectString("cafe=caf%C3%A9", buf.written());
}

test "KeyValueList: urlEncode UTF-8 CJK" {
    // Test 3-byte UTF-8 characters (Chinese/Japanese)
    const allocator = testing.arena_allocator;
    var list = KeyValueList.init();
    try list.append(allocator, "text", "中文"); // 中 = E4 B8 AD, 文 = E6 96 87

    var buf = std.Io.Writer.Allocating.init(allocator);
    try list.urlEncode(.form, null, "UTF-8", &buf.writer);

    try testing.expectString("text=%E4%B8%AD%E6%96%87", buf.written());
}

test "KeyValueList: urlEncode GBK with NCR fallback" {
    // Test legacy encoding with NCR fallback for unmappable characters
    // U+3D34 (㴴) is NOT in GBK, should become &#15668;
    const allocator = testing.arena_allocator;
    var list = KeyValueList.init();
    try list.append(allocator, "q", "\u{3D34}");

    var buf = std.Io.Writer.Allocating.init(allocator);
    try list.urlEncode(.form, allocator, "GBK", &buf.writer);

    // &#15668; percent-encoded is %26%2315668%3B
    try testing.expectString("q=%26%2315668%3B", buf.written());
}

test "KeyValueList: urlEncode GBK mappable character" {
    // Test legacy encoding with a character that IS in GBK
    // U+4E2D (中) IS in GBK, should encode to GBK bytes D6 D0
    const allocator = testing.arena_allocator;
    var list = KeyValueList.init();
    try list.append(allocator, "q", "中");

    var buf = std.Io.Writer.Allocating.init(allocator);
    try list.urlEncode(.form, allocator, "GBK", &buf.writer);

    // GBK encoding of 中 is D6 D0, percent-encoded as %D6%D0
    try testing.expectString("q=%D6%D0", buf.written());
}

test "KeyValueList: urlEncode Big5 unmappable character" {
    // U+70A3 (炣) is NOT in Big5, should become &#28835;
    const allocator = testing.arena_allocator;
    var list = KeyValueList.init();
    try list.append(allocator, "q", "\u{70A3}");

    var buf = std.Io.Writer.Allocating.init(allocator);
    try list.urlEncode(.form, allocator, "Big5", &buf.writer);

    // &#28835; percent-encoded is %26%2328835%3B
    try testing.expectString("q=%26%2328835%3B", buf.written());
}

// HTML form-data set encoding algorithm: line endings in entry names and values
// are normalized to CRLF — every stray LF (not preceded by CR) and every stray
// CR (not followed by LF) is replaced with CR+LF before percent-encoding. The
// normalization applies only to .form mode; URLSearchParams (.query) follows
// the URL standard's serializer, which doesn't normalize.
// https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#url-encoded-form-data
test "KeyValueList: urlEncode .form normalizes stray LF to CRLF" {
    const allocator = testing.arena_allocator;
    var list = KeyValueList.init();
    try list.append(allocator, "msg", "line1\nline2\nline3");

    var buf = std.Io.Writer.Allocating.init(allocator);
    try list.urlEncode(.form, null, "UTF-8", &buf.writer);

    try testing.expectString("msg=line1%0D%0Aline2%0D%0Aline3", buf.written());
}

test "KeyValueList: urlEncode .form normalizes stray CR to CRLF" {
    const allocator = testing.arena_allocator;
    var list = KeyValueList.init();
    try list.append(allocator, "msg", "line1\rline2");

    var buf = std.Io.Writer.Allocating.init(allocator);
    try list.urlEncode(.form, null, "UTF-8", &buf.writer);

    try testing.expectString("msg=line1%0D%0Aline2", buf.written());
}

test "KeyValueList: urlEncode .form preserves existing CRLF" {
    const allocator = testing.arena_allocator;
    var list = KeyValueList.init();
    try list.append(allocator, "msg", "line1\r\nline2");

    var buf = std.Io.Writer.Allocating.init(allocator);
    try list.urlEncode(.form, null, "UTF-8", &buf.writer);

    try testing.expectString("msg=line1%0D%0Aline2", buf.written());
}

test "KeyValueList: urlEncode .form handles mixed line endings" {
    const allocator = testing.arena_allocator;
    var list = KeyValueList.init();
    // CR LF, then bare LF, then bare CR -> three CRLF sequences.
    try list.append(allocator, "msg", "a\r\nb\nc\rd");

    var buf = std.Io.Writer.Allocating.init(allocator);
    try list.urlEncode(.form, null, "UTF-8", &buf.writer);

    try testing.expectString("msg=a%0D%0Ab%0D%0Ac%0D%0Ad", buf.written());
}

test "KeyValueList: urlEncode .form normalizes line endings in entry names" {
    const allocator = testing.arena_allocator;
    var list = KeyValueList.init();
    try list.append(allocator, "n\nm", "v");

    var buf = std.Io.Writer.Allocating.init(allocator);
    try list.urlEncode(.form, null, "UTF-8", &buf.writer);

    try testing.expectString("n%0D%0Am=v", buf.written());
}

test "KeyValueList: urlEncode .form normalizes legacy charsets too" {
    const allocator = testing.arena_allocator;
    var list = KeyValueList.init();
    try list.append(allocator, "msg", "a\nb");

    var buf = std.Io.Writer.Allocating.init(allocator);
    try list.urlEncode(.form, allocator, "GBK", &buf.writer);

    try testing.expectString("msg=a%0D%0Ab", buf.written());
}

test "KeyValueList: cmpUtf16CodeUnits surrogate vs BMP" {
    // 🌈 sorts before ﬃ by UTF-16 code units (D83C < FB03).
    try testing.expect(std.math.Order.lt == cmpUtf16CodeUnits("🌈", "ﬃ"));
    try testing.expect(std.math.Order.gt == cmpUtf16CodeUnits("ﬃ", "🌈"));
}

test "KeyValueList: set updates first match and preserves order" {
    const allocator = testing.arena_allocator;
    var list = KeyValueList.init();
    try list.append(allocator, "a", "b");
    try list.append(allocator, "c", "d");
    try list.set(allocator, "a", "B");
    try testing.expectEqual(@as(usize, 2), list.len());
    try testing.expectString("b", list.get("a").?);
    try testing.expectString("a", list.items()[0].name.str());
    try testing.expectString("B", list.items()[0].value.str());
    try testing.expectString("c", list.items()[1].name.str());

    try list.append(allocator, "a", "e");
    try list.set(allocator, "a", "B");
    try testing.expectEqual(@as(usize, 2), list.len());
    try testing.expectString("B", list.get("a").?);
}

test "KeyValueList: urlEncode .query empty name and value" {
    const allocator = testing.arena_allocator;
    var list = KeyValueList.init();
    try list.append(allocator, "", "");
    try list.append(allocator, "", "");

    var buf = std.Io.Writer.Allocating.init(allocator);
    try list.urlEncode(.query, null, "UTF-8", &buf.writer);

    try testing.expectString("=&=", buf.written());
}

test "KeyValueList: urlEncode .query does NOT normalize line endings" {
    // URL standard's application/x-www-form-urlencoded serializer (used by
    // URLSearchParams) does not perform CRLF normalization — only the HTML
    // form-data set encoding wrapper does. https://url.spec.whatwg.org/#concept-urlencoded-serializer
    const allocator = testing.arena_allocator;
    var list = KeyValueList.init();
    try list.append(allocator, "msg", "a\nb\rc");

    var buf = std.Io.Writer.Allocating.init(allocator);
    try list.urlEncode(.query, null, "UTF-8", &buf.writer);

    try testing.expectString("msg=a%0Ab%0Dc", buf.written());
}
