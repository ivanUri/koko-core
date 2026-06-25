const PolicyRegistry = @import("PolicyRegistry.zig");
const ProfileStore = @import("ProfileStore.zig");

pub const HeaderPlan = struct {
    header_plugin: ?[]const u8 = null,
};

pub fn headerPlan(
    registry: *const PolicyRegistry.PolicyRegistry,
    mode: ProfileStore.Mode,
    enabled_policies: []const []const u8,
    request_url: []const u8,
) HeaderPlan {
    return .{
        .header_plugin = registry.matchHttpPlugin(mode, enabled_policies, request_url),
    };
}

const testing = @import("../../testing/testing.zig");

const google_search_policy = [_][]const u8{"google-search"};

test "HeaderPlanner: velora mode skips x-browser" {
    const registry = try PolicyRegistry.PolicyRegistry.init(testing.allocator);
    defer registry.deinit();
    const plan = headerPlan(&registry, .velora, &google_search_policy, "https://www.google.com/search?q=test");
    try testing.expect(plan.header_plugin == null);
}

test "HeaderPlanner: antidetect enables x-browser on google.com" {
    const registry = try PolicyRegistry.PolicyRegistry.init(testing.allocator);
    defer registry.deinit();
    const plan = headerPlan(&registry, .antidetect, &google_search_policy, "https://www.google.com/gen_204?xyz");
    try testing.expect(plan.header_plugin != null);
    try testing.expectEqualStrings("x-browser", plan.header_plugin.?);
}

test "HeaderPlanner: antidetect without profile opt-in skips x-browser" {
    const registry = try PolicyRegistry.PolicyRegistry.init(testing.allocator);
    defer registry.deinit();
    const plan = headerPlan(&registry, .antidetect, &.{}, "https://www.google.com/gen_204?xyz");
    try testing.expect(plan.header_plugin == null);
}
