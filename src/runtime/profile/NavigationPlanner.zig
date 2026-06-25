const std = @import("std");
const PolicyRegistry = @import("PolicyRegistry.zig");
const ProfileStore = @import("ProfileStore.zig");

const Allocator = std.mem.Allocator;

pub const Reason = enum {
    anchor,
    address_bar,
    form,
    script,
    history,
    navigation,
    initial_frame_navigation,
};

pub const NavigationContext = struct {
    prior_url: []const u8,
    request_url: [:0]const u8,
    reason: Reason,
    referer: ?[]const u8 = null,
    prior_origin: ?[]const u8 = null,
    external_transport_enabled: bool = false,
};

pub const NavigationPlan = struct {
    effective_url: [:0]const u8,
    referer: ?[:0]const u8 = null,
    prior_origin: ?[]const u8 = null,
    omit_cookies: bool = false,
    omit_sec_fetch_user: bool = false,
    curl_defaults_only: bool = false,
    use_external_transport: bool = false,
};

pub fn navigationPlan(
    allocator: Allocator,
    mode: ProfileStore.Mode,
    enabled_policies: []const []const u8,
    registry: *const PolicyRegistry.PolicyRegistry,
    ctx: NavigationContext,
) !NavigationPlan {
    const policy = registry.matchNavigation(mode, enabled_policies, ctx.request_url);
    if (policy == null) {
        return defaultPlan(allocator, ctx);
    }
    return applyPolicy(allocator, policy.?, ctx);
}

fn defaultPlan(allocator: Allocator, ctx: NavigationContext) !NavigationPlan {
    return .{
        .effective_url = try allocator.dupeZ(u8, ctx.request_url),
        .referer = try defaultReferer(allocator, ctx),
        .prior_origin = ctx.prior_origin,
    };
}

fn defaultReferer(allocator: Allocator, ctx: NavigationContext) !?[:0]const u8 {
    if (ctx.referer) |ref| return try allocator.dupeZ(u8, ref);
    if (std.mem.startsWith(u8, ctx.prior_url, "http") and
        !std.mem.eql(u8, ctx.prior_url, ctx.request_url))
    {
        return try allocator.dupeZ(u8, ctx.prior_url);
    }
    return null;
}

fn defaultRefererFromPlan(allocator: Allocator, prior_url: []const u8, effective_url: []const u8, referer: ?[]const u8) !?[:0]const u8 {
    if (referer) |ref| return try allocator.dupeZ(u8, ref);
    if (std.mem.startsWith(u8, prior_url, "http") and !std.mem.eql(u8, prior_url, effective_url)) {
        return try allocator.dupeZ(u8, prior_url);
    }
    return null;
}

fn applyPolicy(allocator: Allocator, policy: *const PolicyRegistry.SitePolicy, ctx: NavigationContext) !NavigationPlan {
    const rules = policy.navigation;
    const flow_prior_url = resolveFlowPriorUrl(ctx);
    const first_hop = isFirstHop(flow_prior_url, ctx.request_url, ctx.reason);
    const search_flow = isSearchFlow(flow_prior_url, ctx.request_url, ctx.reason);
    const in_session = search_flow and !first_hop;

    var effective_url: [:0]const u8 = ctx.request_url;
    var effective_url_owned = false;
    if (rules.inject_param) |param| {
        if (param.when == .address_bar_in_session and
            !first_hop and
            ctx.reason == .address_bar)
        {
            effective_url = try appendQueryParamIfMissing(allocator, ctx.request_url, param.name);
            effective_url_owned = true;
        }
    }
    if (!effective_url_owned) {
        effective_url = try allocator.dupeZ(u8, ctx.request_url);
    }

    var prior_origin = ctx.prior_origin;
    var referer = ctx.referer;
    if (in_session) {
        if (rules.prior_origin) |origin| {
            if (prior_origin == null) prior_origin = try allocator.dupe(u8, origin);
        }
        if (rules.referer == .search_q_only) {
            referer = try searchQOnlyReferer(allocator, effective_url);
        }
    }

    const nav_referer = try defaultRefererFromPlan(allocator, ctx.prior_url, effective_url, referer);

    const use_external_transport = blk: {
        const transport = rules.external_transport orelse break :blk false;
        if (!ctx.external_transport_enabled) break :blk false;
        if (!search_flow) break :blk false;
        break :blk switch (transport.when) {
            .first_hop_or_query_contains => first_hop or urlContainsAny(ctx.request_url, transport.query_contains),
            .query_contains => urlContainsAny(ctx.request_url, transport.query_contains),
            .first_hop => first_hop,
            else => false,
        };
    };

    return .{
        .effective_url = effective_url,
        .referer = nav_referer,
        .prior_origin = prior_origin,
        .omit_cookies = whenActive(rules.omit_cookies, in_session, first_hop),
        .omit_sec_fetch_user = whenActive(rules.omit_sec_fetch_user, in_session, first_hop),
        .curl_defaults_only = whenActive(rules.curl_defaults_only, in_session, first_hop),
        .use_external_transport = use_external_transport,
    };
}

fn whenActive(rule: PolicyRegistry.When, in_session: bool, first_hop: bool) bool {
    return switch (rule) {
        .never => false,
        .in_session => in_session,
        .first_hop => first_hop,
        else => false,
    };
}

fn resolveFlowPriorUrl(ctx: NavigationContext) []const u8 {
    if (isSearchUrl(ctx.prior_url)) return ctx.prior_url;
    if (ctx.referer) |ref| {
        if (isSearchUrl(ref)) return ref;
        if (isSiteUrl(ref)) return ref;
    }
    return ctx.prior_url;
}

fn isFirstHop(flow_prior_url: []const u8, request_url: []const u8, reason: Reason) bool {
    return isSearchUrl(request_url) and
        !isSearchUrl(flow_prior_url) and
        (reason == .address_bar or reason == .form);
}

fn isSearchFlow(flow_prior_url: []const u8, request_url: []const u8, reason: Reason) bool {
    if (!isSearchUrl(request_url)) return false;
    if (reason == .address_bar) return true;
    if (reason == .form and isSiteUrl(flow_prior_url)) return true;
    return isSearchUrl(flow_prior_url);
}

fn isSearchUrl(url: []const u8) bool {
    return std.mem.indexOf(u8, url, "google.com/search") != null;
}

fn isSiteUrl(url: []const u8) bool {
    return std.mem.indexOf(u8, url, "google.com") != null;
}

fn urlContainsAny(url: []const u8, needles: []const []const u8) bool {
    for (needles) |needle| {
        if (std.mem.indexOf(u8, url, needle) != null) return true;
    }
    return false;
}

fn appendQueryParamIfMissing(allocator: Allocator, url: []const u8, name: []const u8) ![:0]const u8 {
    const marker = try std.fmt.allocPrint(allocator, "{s}=", .{name});
    defer allocator.free(marker);
    if (std.mem.indexOf(u8, url, marker) != null) return try allocator.dupeZ(u8, url);

    var rand: [16]u8 = undefined;
    std.crypto.random.bytes(&rand);
    const enc = std.base64.url_safe_no_pad.Encoder;
    var value_buf: [32]u8 = undefined;
    const value = value_buf[0..enc.calcSize(rand.len)];
    _ = enc.encode(value, &rand);

    const sep: []const u8 = if (std.mem.indexOf(u8, url, "?") != null) "&" else "?";
    return try std.fmt.allocPrintSentinel(allocator, "{s}{s}{s}={s}", .{ url, sep, name, value }, 0);
}

fn searchQOnlyReferer(allocator: Allocator, url: []const u8) ![:0]const u8 {
    const q_pos = std.mem.indexOf(u8, url, "q=") orelse return try allocator.dupeZ(u8, url);
    const q_start = q_pos + 2;
    const q_end = std.mem.indexOfPos(u8, url, q_start, "&") orelse url.len;
    return try std.fmt.allocPrintSentinel(
        allocator,
        "https://www.google.com/search?q={s}",
        .{url[q_start..q_end]},
        0,
    );
}

const testing = @import("../../testing/testing.zig");

const google_search_policy = [_][]const u8{"google-search"};

test "NavigationPlanner: velora mode is no-op" {
    const registry = try PolicyRegistry.PolicyRegistry.init(testing.allocator);
    defer registry.deinit();

    const plan = try navigationPlan(testing.allocator, .velora, &google_search_policy, &registry, .{
        .prior_url = "about:blank",
        .request_url = "https://www.google.com/search?q=test",
        .reason = .address_bar,
    });
    defer testing.allocator.free(plan.effective_url);
    if (plan.referer) |ref| testing.allocator.free(ref);

    try testing.expectString("https://www.google.com/search?q=test", plan.effective_url);
    try testing.expect(!plan.omit_cookies);
    try testing.expect(!plan.curl_defaults_only);
}

test "NavigationPlanner: antidetect first hop uses curl defaults" {
    const registry = try PolicyRegistry.PolicyRegistry.init(testing.allocator);
    defer registry.deinit();

    const plan = try navigationPlan(testing.allocator, .antidetect, &google_search_policy, &registry, .{
        .prior_url = "about:blank",
        .request_url = "https://www.google.com/search?q=test",
        .reason = .address_bar,
    });
    defer testing.allocator.free(plan.effective_url);
    if (plan.referer) |ref| testing.allocator.free(ref);

    try testing.expect(plan.curl_defaults_only);
    try testing.expect(!plan.omit_cookies);
    try testing.expect(!plan.omit_sec_fetch_user);
}

test "NavigationPlanner: in-session redirect hop uses navigation reason" {
    const registry = try PolicyRegistry.PolicyRegistry.init(testing.allocator);
    defer registry.deinit();

    const plan = try navigationPlan(testing.allocator, .antidetect, &google_search_policy, &registry, .{
        .prior_url = "https://www.google.com/search?q=test&hl=vi",
        .request_url = "https://www.google.com/search?q=test&hl=vi&sei=abc",
        .reason = .navigation,
    });
    defer testing.allocator.free(plan.effective_url);
    if (plan.referer) |ref| testing.allocator.free(ref);

    try testing.expect(plan.omit_cookies);
    try testing.expect(plan.omit_sec_fetch_user);
    try testing.expect(!plan.curl_defaults_only);
}

test "NavigationPlanner: antidetect in-session omits cookies and sec-fetch-user" {
    const registry = try PolicyRegistry.PolicyRegistry.init(testing.allocator);
    defer registry.deinit();

    const plan = try navigationPlan(testing.allocator, .antidetect, &google_search_policy, &registry, .{
        .prior_url = "https://www.google.com/search?q=prev",
        .request_url = "https://www.google.com/search?q=test&sg_ss=1",
        .reason = .address_bar,
    });
    defer testing.allocator.free(plan.effective_url);
    if (plan.referer) |ref| testing.allocator.free(ref);

    try testing.expect(plan.omit_cookies);
    try testing.expect(plan.omit_sec_fetch_user);
    try testing.expect(!plan.curl_defaults_only);
    try testing.expect(plan.referer != null);
    try testing.expectString("https://www.google.com/search?q=test", plan.referer.?);
}

test "NavigationPlanner: antidetect without profile opt-in is no-op" {
    const registry = try PolicyRegistry.PolicyRegistry.init(testing.allocator);
    defer registry.deinit();

    const plan = try navigationPlan(testing.allocator, .antidetect, &.{}, &registry, .{
        .prior_url = "about:blank",
        .request_url = "https://www.google.com/search?q=test",
        .reason = .address_bar,
    });
    defer testing.allocator.free(plan.effective_url);
    if (plan.referer) |ref| testing.allocator.free(ref);

    try testing.expect(!plan.curl_defaults_only);
    try testing.expect(!plan.omit_cookies);
}
