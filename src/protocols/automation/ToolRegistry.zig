const std = @import("std");

/// Canonical automation operations. Public aliases such as `navigate` and
/// `eval` resolve to one of these tags instead of creating a second semantic
/// operation.
pub const Action = enum {
    goto,
    markdown,
    links,
    extract,
    evaluate,
    semantic_tree,
    node_details,
    interactive_elements,
    structured_data,
    detect_forms,
    click,
    fill,
    scroll,
    wait_for_selector,
    hover,
    press,
    select_option,
    set_checked,
    find_element,
    recording_start,
    recording_stop,
    workflow_export,
    workflow_replay,

    pub fn policy(self: Action) Policy {
        return switch (self) {
            .goto => .{
                .effect = .navigation,
                .recordable = true,
                .replayable = true,
                .invalidates_node_refs = true,
            },
            .markdown,
            .links,
            .extract,
            .semantic_tree,
            .node_details,
            .interactive_elements,
            .structured_data,
            .detect_forms,
            .find_element,
            => .{
                .effect = .observation,
                .produces_data = true,
                .recordable = self == .extract,
                .replayable = self == .extract,
            },
            .evaluate => .{
                .effect = .external_side_effect,
                .produces_data = true,
                .recordable = false,
                .replayable = false,
                .secret_fields = &.{"script"},
            },
            .click => .{
                .effect = .external_side_effect,
                .locator = .ephemeral_node,
                .recordable = false,
                .replayable = false,
                .invalidates_node_refs = true,
            },
            .fill => .{
                .effect = .dom_mutation,
                .locator = .ephemeral_node,
                .recordable = false,
                .replayable = false,
                .secret_fields = &.{"text"},
            },
            .scroll => .{
                .effect = .dom_mutation,
                .locator = .optional_ephemeral_node,
                .recordable = false,
                .replayable = false,
            },
            .wait_for_selector => .{
                .effect = .observation,
                .locator = .css_selector,
                .produces_data = true,
                .recordable = true,
                .replayable = true,
            },
            .hover => .{
                .effect = .dom_mutation,
                .locator = .ephemeral_node,
                .recordable = false,
                .replayable = false,
            },
            .press => .{
                .effect = .external_side_effect,
                .locator = .optional_ephemeral_node,
                .recordable = false,
                .replayable = false,
                .invalidates_node_refs = true,
            },
            .select_option, .set_checked => .{
                .effect = .dom_mutation,
                .locator = .ephemeral_node,
                .recordable = false,
                .replayable = false,
            },
            .recording_start, .recording_stop, .workflow_export, .workflow_replay => .{
                .effect = .observation,
                .produces_data = true,
            },
        };
    }
};

pub const Effect = enum {
    observation,
    dom_mutation,
    navigation,
    external_side_effect,
};

pub const LocatorRequirement = enum {
    none,
    css_selector,
    ephemeral_node,
    optional_ephemeral_node,
};

pub const Policy = struct {
    effect: Effect,
    locator: LocatorRequirement = .none,
    produces_data: bool = false,
    recordable: bool = false,
    replayable: bool = false,
    invalidates_node_refs: bool = false,
    secret_fields: []const []const u8 = &.{},
};

pub const Definition = struct {
    action: Action,
    name: []const u8,
    description: ?[]const u8 = null,
    input_schema: []const u8,

    pub fn policy(self: Definition) Policy {
        return self.action.policy();
    }
};

pub fn find(definitions: []const Definition, name: []const u8) ?*const Definition {
    for (definitions) |*definition| {
        if (std.mem.eql(u8, definition.name, name)) return definition;
    }
    return null;
}

/// Validates the registry's two structural invariants:
/// - public names are unique;
/// - every canonical action is exposed by at least one public definition.
pub fn validate(comptime definitions: []const Definition) void {
    @setEvalBranchQuota(4_000);
    inline for (definitions, 0..) |definition, i| {
        if (definition.name.len == 0) {
            @compileError("automation tool names must not be empty");
        }
        inline for (definitions[i + 1 ..]) |other| {
            if (std.mem.eql(u8, definition.name, other.name)) {
                @compileError("duplicate automation tool name: " ++ definition.name);
            }
        }
    }

    inline for (std.meta.fields(Action)) |field| {
        const action: Action = @enumFromInt(field.value);
        var found = false;
        inline for (definitions) |definition| {
            if (definition.action == action) found = true;
        }
        if (!found) @compileError("canonical automation action is not exposed: " ++ field.name);
    }
}

test "ToolRegistry policies classify replay and ephemeral locators" {
    const testing = std.testing;
    try testing.expect(Action.goto.policy().replayable);
    try testing.expect(Action.wait_for_selector.policy().recordable);
    try testing.expect(!Action.click.policy().replayable);
    try testing.expectEqual(LocatorRequirement.ephemeral_node, Action.click.policy().locator);
    try testing.expectEqual(Effect.observation, Action.semantic_tree.policy().effect);
}
