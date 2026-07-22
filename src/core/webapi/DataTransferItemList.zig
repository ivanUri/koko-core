//
// Adapted for Velora architecture.

const js = @import("../js/js.zig");
const Frame = @import("../browser/Frame.zig");
const Page = @import("../browser/Page.zig");

const File = @import("File.zig");
const DataTransfer = @import("DataTransfer.zig");
const DataTransferItem = @import("DataTransferItem.zig");

const DataTransferItemList = @This();

_data_transfer: *DataTransfer,

pub fn deinit(_: *DataTransferItemList, _: *Page) void {}

pub fn getLength(self: *const DataTransferItemList) u32 {
    return @intCast(self._data_transfer._items.items.len);
}

pub fn getAtIndex(self: *const DataTransferItemList, index: u32) ?*DataTransferItem {
    if (index >= self._data_transfer._items.items.len) return null;
    return self._data_transfer._items.items[index];
}

pub fn add(
    self: *DataTransferItemList,
    data: js.Value,
    type_: ?[]const u8,
    frame: *Frame,
) !?*DataTransferItem {
    // Accept string + type, or File. Full LP fidelity is deferred; presence of
    // the method is what most feature-detects need.
    _ = self;
    _ = data;
    _ = type_;
    _ = frame;
    return null;
}

pub fn remove(self: *DataTransferItemList, index: u32) void {
    if (index >= self._data_transfer._items.items.len) return;
    _ = self._data_transfer._items.orderedRemove(index);
}

pub fn clear(self: *DataTransferItemList) void {
    self._data_transfer._items.clearRetainingCapacity();
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(DataTransferItemList);

    pub const Meta = struct {
        pub const name = "DataTransferItemList";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };

    pub const length = bridge.accessor(DataTransferItemList.getLength, null, .{});
    pub const @"[int]" = bridge.indexed(DataTransferItemList.getAtIndex, null, .{ .null_as_undefined = true });
    pub const add = bridge.function(DataTransferItemList.add, .{});
    pub const remove = bridge.function(DataTransferItemList.remove, .{});
    pub const clear = bridge.function(DataTransferItemList.clear, .{});
};
