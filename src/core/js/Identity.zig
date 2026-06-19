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

// Identity manages the mapping between Zig instances and their v8::Object wrappers.
// This provides object identity semantics - the same Zig instance always maps to
// the same JS object within a given Identity scope.
//
// Main world contexts share a single Identity (on Session), ensuring that
// `window.top.document === top's document` works across same-origin frames.
//
// Isolated worlds (CDP inspector) have their own Identity, ensuring their
// v8::Global wrappers don't leak into the main world.

const std = @import("std");
const js = @import("js.zig");

const v8 = js.v8;
const TaggedOpaque = @import("TaggedOpaque.zig");

const Identity = @This();

// Maps Zig instance pointers to their v8::Global(Object) wrappers.
identity_map: std.AutoHashMapUnmanaged(usize, v8.Global) = .empty,

pub fn deinit(self: *Identity) void {
    var it = self.identity_map.valueIterator();
    while (it.next()) |global| {
        v8.v8__Global__Reset(global);
    }
}

/// Re-key an existing JS wrapper from `old_ptr` to `new_ptr`, updating the
/// TaggedOpaque to point at `new_value`. Used when iframe child frames
/// re-navigate in place: the Frame pointer is stable but the Window struct is
/// replaced, and contentWindow must keep object identity across navigations.
pub fn rekey(
    self: *Identity,
    allocator: std.mem.Allocator,
    isolate: *v8.Isolate,
    old_ptr: usize,
    new_ptr: usize,
    new_value: *anyopaque,
) bool {
    const kv = self.identity_map.fetchRemove(old_ptr) orelse return false;

    var hs: js.HandleScope = undefined;
    hs.initWithIsolateHandle(isolate);
    defer hs.deinit();

    if (v8.v8__Global__Get(&kv.value, isolate)) |obj| {
        if (v8.v8__Object__GetAlignedPointerFromInternalField(@ptrCast(obj), 0)) |tao_raw| {
            const tao: *TaggedOpaque = @ptrCast(@alignCast(tao_raw));
            tao.value = new_value;
        }
    }

    const gop = self.identity_map.getOrPut(allocator, new_ptr) catch {
        v8.v8__Global__Reset(@constCast(&kv.value));
        return false;
    };
    if (gop.found_existing) {
        v8.v8__Global__Reset(gop.value_ptr);
    }
    gop.value_ptr.* = kv.value;
    return true;
}
