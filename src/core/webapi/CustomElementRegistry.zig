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
const Frame = @import("../browser/Frame.zig");
const log = @import("../../support/log.zig");
const RealmLifecycleKernel = @import("../../runtime/RealmLifecycleKernel.zig");

const Node = @import("../dom/Node.zig");
const Element = @import("../dom/Element.zig");
const Custom = @import("element/html/Custom.zig");
const CustomElementDefinition = @import("CustomElementDefinition.zig");

const CustomElementRegistry = @This();

_definitions: std.StringHashMapUnmanaged(*CustomElementDefinition) = .{},
_when_defined: std.StringHashMapUnmanaged(js.PromiseResolver.Global) = .{},
_upgrade_retry_scheduled: bool = false,
_upgrade_retry_token: u64 = 0,

// Only transient V8-stack deferrals use the retry path. Keep the existing
// bound, but preserve it on the same scheduled callback so it cannot reset.
const max_upgrade_retry_attempts: u8 = 16;

const DefineOptions = struct {
    extends: ?[]const u8 = null,
};

fn parseExtendsTag(extends_name: []const u8) ?Element.Tag {
    return Element.Tag.parseForMatch(extends_name);
}

pub fn define(self: *CustomElementRegistry, name: []const u8, constructor: js.Function, options_: ?DefineOptions, frame: *Frame) !void {
    const options = options_ orelse DefineOptions{};

    try validateName(name);

    if (self.findByConstructor(constructor) != null) {
        log.warn(.js, "customElements.define duplicate constructor", .{ .name = name });
        return error.NotSupported;
    }

    // Parse and validate extends option
    const extends_tag: ?Element.Tag = if (options.extends) |extends_name| blk: {
        const tag = parseExtendsTag(extends_name) orelse {
            log.warn(.js, "customElements.define unsupported extends", .{ .name = name, .extends = extends_name });
            return error.NotSupported;
        };

        // Can't extend custom elements
        if (tag == .custom) {
            log.warn(.js, "customElements.define extends custom", .{ .name = name, .extends = extends_name });
            return error.NotSupported;
        }

        break :blk tag;
    } else null;

    const gop = try self._definitions.getOrPut(frame.arena, name);
    if (gop.found_existing) {
        // Some module graphs can request the same registration more than once.
        // Keep the first successful definition and make later duplicates a no-op
        // to avoid cascading module-evaluation failures.
        log.warn(.js, "customElements.define duplicate name", .{ .name = name });
        return;
    }

    const owned_name = try frame.dupeString(name);

    const definition = try frame._factory.create(CustomElementDefinition{
        .name = owned_name,
        .constructor = try constructor.persist(),
        .extends = extends_tag,
    });

    // Read observedAttributes static property from constructor
    if (constructor.getPropertyValue("observedAttributes") catch null) |observed_attrs| {
        if (observed_attrs.isArray()) {
            var js_arr = observed_attrs.toArray();
            for (0..js_arr.len()) |i| {
                const attr_val = js_arr.get(@intCast(i)) catch continue;
                const attr_name = attr_val.toStringSliceWithAlloc(frame.arena) catch continue;
                definition.observed_attributes.put(frame.arena, attr_name, {}) catch continue;
            }
        }
    }

    gop.key_ptr.* = owned_name;
    gop.value_ptr.* = definition;

    // Customized built-ins are normal built-in elements until their definition
    // exists, so upgrade any existing `<tag is="name">` candidates now.
    if (extends_tag != null) {
        try upgradeNode(self, frame.document.asNode(), frame);
    }

    // Upgrade any undefined custom elements with this name
    var idx: usize = 0;
    while (idx < frame._undefined_custom_elements.items.len) {
        const custom = frame._undefined_custom_elements.items[idx];
        if (!custom._tag_name.eqlSlice(name)) {
            idx += 1;
            continue;
        }

        if (!custom.asElement().asNode().isConnected()) {
            idx += 1;
            continue;
        }

        upgradeCustomElement(custom, definition, frame) catch |err| switch (err) {
            error.CustomElementUpgradeDeferred => {
                // The constructor cannot be entered recursively while
                // customElements.define() is still executing on the V8 stack.
                // Keep the candidate and retry from a scheduler turn instead
                // of permanently losing the upgrade.
                custom._definition = null;
                self.scheduleUpgradeRetry(frame) catch {};
                idx += 1;
                continue;
            },
            // The element is marked as failed by upgradeCustomElement. Do not
            // schedule another constructor invocation.
            error.CustomElementConstructorFailed => {
                idx += 1;
                continue;
            },
        };

        _ = frame._undefined_custom_elements.swapRemove(idx);
    }

    if (self._when_defined.fetchRemove(name)) |entry| {
        frame.js.toLocal(entry.value).resolve("whenDefined", constructor);
    }
}

pub fn scheduleUpgradeRetry(self: *CustomElementRegistry, frame: *Frame) !void {
    if (self._upgrade_retry_scheduled) return;

    self._upgrade_retry_token +%= 1;
    const callback = try frame.arena.create(UpgradeRetry);
    callback.* = .{
        .registry = self,
        .frame = frame,
        .owner = frame.js.execution.captureTaskOwner(),
        .attempts = 0,
        .token = self._upgrade_retry_token,
    };
    self._upgrade_retry_scheduled = true;
    frame.js.scheduler.add(callback, UpgradeRetry.run, 0, .{
        .name = "CustomElementRegistry.upgrade",
        .low_priority = false,
        .finalizer = UpgradeRetry.finalize,
    }) catch |err| {
        self._upgrade_retry_scheduled = false;
        return err;
    };
}

const UpgradeRetry = struct {
    registry: *CustomElementRegistry,
    frame: *Frame,
    owner: RealmLifecycleKernel.TaskOwner,
    attempts: u8,
    token: u64,

    fn clearScheduled(self: *const UpgradeRetry) void {
        if (self.registry._upgrade_retry_token == self.token) {
            self.registry._upgrade_retry_scheduled = false;
        }
    }

    fn finalize(ctx: *anyopaque) void {
        const self: *UpgradeRetry = @ptrCast(@alignCast(ctx));
        self.clearScheduled();
    }

    fn isStale(self: *const UpgradeRetry) bool {
        return self.frame._deinit_done or
            self.frame._detach_pending or
            self.frame.isGoingAway() or
            self.frame.realmState() == .draining or
            self.frame.realmState() == .dead or
            self.frame.js.execution.isTaskOwnerStale(self.owner);
    }

    fn run(ctx: *anyopaque) !?u32 {
        const self: *UpgradeRetry = @ptrCast(@alignCast(ctx));

        // Navigation can replace the document while retaining this Frame.
        // Never inspect candidates or definitions from a stale realm.
        if (self.isStale()) {
            self.clearScheduled();
            return null;
        }

        var deferred = false;
        var idx: usize = 0;
        while (idx < self.frame._undefined_custom_elements.items.len) {
            if (self.isStale()) {
                self.clearScheduled();
                return null;
            }
            const custom = self.frame._undefined_custom_elements.items[idx];
            if (!custom.asNode().isConnected()) {
                idx += 1;
                continue;
            }
            if (custom._definition != null or custom._upgrade_failed) {
                idx += 1;
                continue;
            }
            const definition = self.registry._definitions.get(custom._tag_name.str()) orelse {
                idx += 1;
                continue;
            };
            upgradeCustomElementFromScheduler(custom, definition, self.frame) catch |err| switch (err) {
                error.CustomElementUpgradeDeferred => {
                    custom._definition = null;
                    deferred = true;
                    idx += 1;
                    continue;
                },
                error.CustomElementConstructorFailed => {
                    idx += 1;
                    continue;
                },
            };
            if (self.isStale()) {
                self.clearScheduled();
                return null;
            }
            _ = self.frame._undefined_custom_elements.swapRemove(idx);
        }

        if (deferred and self.attempts < max_upgrade_retry_attempts) {
            self.attempts += 1;
            // Re-arm this same task so attempts and the owner remain intact.
            return 0;
        }
        if (deferred) {
            log.warn(.js, "custom element upgrade retry exhausted", .{
                .attempts = self.attempts,
            });
        }
        self.clearScheduled();
        return null;
    }
};

pub fn get(self: *CustomElementRegistry, name: []const u8) ?js.Function.Global {
    const definition = self._definitions.get(name) orelse return null;
    return definition.constructor;
}

fn findByConstructor(self: *CustomElementRegistry, constructor: js.Function) ?*CustomElementDefinition {
    var it = self._definitions.iterator();
    while (it.next()) |entry| {
        if (entry.value_ptr.*.constructor.isEqual(constructor)) {
            return entry.value_ptr.*;
        }
    }
    return null;
}

pub fn upgrade(self: *CustomElementRegistry, root: *Node, frame: *Frame) !void {
    try upgradeNode(self, root, frame);
}

pub fn whenDefined(self: *CustomElementRegistry, name: []const u8, frame: *Frame) !js.Promise {
    const local = frame.js.local.?;
    if (self._definitions.get(name)) |definition| {
        return local.resolvePromise(definition.constructor);
    }

    validateName(name) catch |err| switch (err) {
        error.SyntaxError => return local.rejectPromise(.{ .dom_exception = .{ .err = error.SyntaxError } }),
    };

    const gop = try self._when_defined.getOrPut(frame.arena, name);
    if (gop.found_existing) {
        return local.toLocal(gop.value_ptr.*).promise();
    }
    errdefer _ = self._when_defined.remove(name);
    const owned_name = try frame.dupeString(name);

    const resolver = local.createPromiseResolver();
    gop.key_ptr.* = owned_name;
    gop.value_ptr.* = try resolver.persist();

    return resolver.promise();
}

fn upgradeNode(self: *CustomElementRegistry, node: *Node, frame: *Frame) !void {
    if (node.is(Element)) |element| {
        try upgradeElement(self, element, frame);
    }

    var it = node.childrenIterator();
    while (it.next()) |child| {
        try upgradeNode(self, child, frame);
    }
}

fn upgradeElement(self: *CustomElementRegistry, element: *Element, frame: *Frame) !void {
    const custom = element.is(Custom) orelse {
        return Custom.checkAndAttachBuiltIn(element, frame);
    };

    if (custom._definition != null or custom._upgrade_failed) return;

    const name = custom._tag_name.str();
    const definition = self._definitions.get(name) orelse return;

    try upgradeCustomElement(custom, definition, frame);
}

pub fn upgradeCustomElement(custom: *Custom, definition: *CustomElementDefinition, frame: *Frame) !void {
    return upgradeCustomElementInternal(custom, definition, frame, false);
}

fn upgradeCustomElementFromScheduler(custom: *Custom, definition: *CustomElementDefinition, frame: *Frame) !void {
    return upgradeCustomElementInternal(custom, definition, frame, true);
}

fn upgradeCustomElementInternal(
    custom: *Custom,
    definition: *CustomElementDefinition,
    frame: *Frame,
    from_scheduler: bool,
) !void {
    if (custom._upgrade_failed) return error.CustomElementConstructorFailed;

    // Do not attach the definition until the transient V8-stack guard passes.
    // This lets callers distinguish a deferred upgrade from a failed element.
    if (!from_scheduler and frame.js.env.anyContextOnV8Stack()) {
        log.warn(.js, "custom element upgrade deferred: V8 on stack", .{ .name = definition.name });
        return error.CustomElementUpgradeDeferred;
    }

    custom._definition = definition;
    custom._upgrade_failed = false;

    // Reset callback flags since this is a fresh upgrade
    custom._connected_callback_invoked = false;
    custom._disconnected_callback_invoked = false;

    const node = custom.asNode();
    const prev_upgrading = frame._upgrading_element;
    frame._upgrading_element = node;
    defer frame._upgrading_element = prev_upgrading;

    var ls: js.Local.Scope = undefined;
    frame.js.localScope(&ls);
    defer ls.deinit();

    var caught: js.TryCatch.Caught = undefined;

    _ = ls.toLocal(definition.constructor).newInstance(&caught) catch |err| {
        log.warn(.js, "custom element upgrade", .{ .name = definition.name, .err = err, .caught = caught });
        custom._upgrade_failed = true;
        return error.CustomElementConstructorFailed;
    };

    // Invoke attributeChangedCallback for existing observed attributes
    var attr_it = custom.asElement().attributeIterator();
    while (attr_it.next()) |attr| {
        const name = attr._name;
        if (definition.isAttributeObserved(name)) {
            custom.invokeAttributeChangedCallback(name, null, attr._value, null, frame);
        }
    }

    if (node.isConnected()) {
        custom.invokeConnectedCallback(frame);
    }
}

fn validateName(name: []const u8) !void {
    if (name.len == 0) {
        return error.SyntaxError;
    }

    if (std.mem.indexOf(u8, name, "-") == null) {
        return error.SyntaxError;
    }

    if (name[0] < 'a' or name[0] > 'z') {
        return error.SyntaxError;
    }

    const reserved_names = [_][]const u8{
        "annotation-xml",
        "color-profile",
        "font-face",
        "font-face-src",
        "font-face-uri",
        "font-face-format",
        "font-face-name",
        "missing-glyph",
    };

    for (reserved_names) |reserved| {
        if (std.mem.eql(u8, name, reserved)) {
            return error.SyntaxError;
        }
    }

    for (name) |c| {
        if (c >= 'A' and c <= 'Z') {
            return error.SyntaxError;
        }

        // Reject control characters and specific invalid characters
        // per elementLocalNameRegex: [^\0\t\n\f\r\u0020/>]*
        switch (c) {
            0, '\t', '\n', '\r', 0x0C, ' ', '/', '>' => return error.SyntaxError,
            else => {},
        }
    }
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(CustomElementRegistry);

    pub const Meta = struct {
        pub const name = "CustomElementRegistry";
        pub var class_id: bridge.ClassId = undefined;
        pub const prototype_chain = bridge.prototypeChain();
    };

    pub const define = bridge.function(CustomElementRegistry.define, .{ .dom_exception = true });
    pub const get = bridge.function(CustomElementRegistry.get, .{ .null_as_undefined = true });
    pub const upgrade = bridge.function(CustomElementRegistry.upgrade, .{});
    pub const whenDefined = bridge.function(CustomElementRegistry.whenDefined, .{ .dom_exception = true });
};

const testing = @import("../../testing/testing.zig");

test "CustomElementRegistry: parse extends tag aliases" {
    try std.testing.expectEqual(Element.Tag.button, parseExtendsTag("button").?);
    try std.testing.expectEqual(Element.Tag.anchor, parseExtendsTag("a").?);
    try std.testing.expectEqual(Element.Tag.quote, parseExtendsTag("q").?);
    try std.testing.expectEqual(Element.Tag.directory, parseExtendsTag("dir").?);
    try std.testing.expect(parseExtendsTag("anchor") == null);
    try std.testing.expect(parseExtendsTag("quote") == null);
    try std.testing.expect(parseExtendsTag("directory") == null);
    try std.testing.expect(parseExtendsTag("does-not-exist") == null);
}

test "WebApi: CustomElementRegistry" {
    try testing.htmlRunner("custom_elements", .{});
}
