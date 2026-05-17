pub fn RC(comptime T: type) type {
    return struct {
        const Self = @This();

        count: T = 1,

        pub fn init(count: T) Self {
            return .{ .count = count };
        }

        pub fn acquire(self: *Self) void {
            self.count += 1;
        }

        pub fn release(self: *Self, owner: anytype, page: anytype) void {
            self.count -= 1;
            if (self.count == 0) {
                owner.deinit(page);
            }
        }
    };
}
