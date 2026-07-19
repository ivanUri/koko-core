const std = @import("std");
const PolicyRegistry = @import("PolicyRegistry.zig");
const NavigationPlanner = @import("NavigationPlanner.zig");
const HeaderPlanner = @import("HeaderPlanner.zig");
const HeaderPlugins = @import("HeaderPlugins.zig");
const ProfileStore = @import("ProfileStore.zig");
const HttpClient = @import("../../core/browser/HttpClient.zig");

const Allocator = std.mem.Allocator;

pub const NavigationPlan = NavigationPlanner.NavigationPlan;
pub const NavigationContext = NavigationPlanner.NavigationContext;
pub const Reason = NavigationPlanner.Reason;
pub const HeaderPlan = HeaderPlanner.HeaderPlan;

pub const ProfileRuntime = struct {
    profile: *const ProfileStore.LoadedProfile,
    registry: PolicyRegistry.PolicyRegistry,
    plugins: HeaderPlugins.Registry,

    pub fn init(allocator: Allocator, profile: *const ProfileStore.LoadedProfile) !ProfileRuntime {
        return .{
            .profile = profile,
            .registry = try PolicyRegistry.PolicyRegistry.init(allocator),
            .plugins = try HeaderPlugins.Registry.init(allocator),
        };
    }

    pub fn deinit(self: *ProfileRuntime, allocator: Allocator) void {
        self.plugins.deinit(allocator);
        self.registry.deinit();
        self.* = undefined;
    }

    pub fn navigationPlan(
        self: *const ProfileRuntime,
        allocator: Allocator,
        ctx: NavigationContext,
    ) !NavigationPlan {
        return NavigationPlanner.navigationPlan(
            allocator,
            self.profile.mode,
            self.profile.policies,
            &self.registry,
            ctx,
        );
    }

    pub fn headerPlan(self: *const ProfileRuntime, request_url: []const u8) HeaderPlan {
        return HeaderPlanner.headerPlan(
            &self.registry,
            self.profile.mode,
            self.profile.policies,
            request_url,
        );
    }

    pub fn appendHeaderPlugins(
        self: *const ProfileRuntime,
        plan: HeaderPlan,
        headers: *HttpClient.Headers,
        allocator: Allocator,
        user_agent: []const u8,
        fingerprint_seed: u64,
    ) !void {
        const plugin_id = plan.header_plugin orelse return;
        try self.plugins.append(plugin_id, headers, allocator, user_agent, fingerprint_seed);
    }
};
