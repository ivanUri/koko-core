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

const Node = @import("../../dom/Node.zig");
const Frame = @import("../../browser/Frame.zig");

const Parser = @import("Parser.zig");
pub const List = @import("List.zig");

const String = @import("../../../support/string.zig").String;
const Allocator = std.mem.Allocator;

pub fn parseLeaky(arena: Allocator, input: []const u8) !Parsed {
    if (input.len == 0) {
        return error.SyntaxError;
    }
    return .{ .selectors = try Parser.parseList(arena, input) };
}

pub fn querySelector(root: *Node, input: []const u8, frame: *Frame) !?*Node.Element {
    const parsed = try parseLeaky(frame.call_arena, input);
    return parsed.query(root, frame);
}

pub fn querySelectorAll(root: *Node, input: []const u8, frame: *Frame) !*List {
    if (input.len == 0) {
        return error.SyntaxError;
    }

    // querySelectorAll results are exposed to JS as NodeList and may outlive
    // the immediate call; allocate from the page/frame arena so teardown owns
    // the memory even if GC does not run before process shutdown.
    const arena = frame.arena;

    var nodes: std.AutoArrayHashMapUnmanaged(*Node, void) = .empty;

    const selectors = try Parser.parseList(arena, input);
    for (selectors) |selector| {
        try List.collect(arena, root, selector, &nodes, frame);
    }

    const list = try arena.create(List);
    list.* = .{
        ._arena = arena,
        ._release_on_deinit = false,
        ._nodes = nodes.keys(),
    };
    return list;
}

pub fn matches(el: *Node.Element, input: []const u8, frame: *Frame) !bool {
    if (input.len == 0) {
        return error.SyntaxError;
    }

    const arena = frame.call_arena;
    const selectors = try Parser.parseList(arena, input);

    for (selectors) |selector| {
        if (List.matches(el.asNode(), selector, el.asNode(), frame)) {
            return true;
        }
    }
    return false;
}

// Like matches, but allows the caller to specify a scope node distinct from el.
// Used by closest() so that :scope always refers to the original context element.
pub fn matchesWithScope(el: *Node.Element, input: []const u8, scope: *Node.Element, frame: *Frame) !bool {
    if (input.len == 0) {
        return error.SyntaxError;
    }

    const arena = frame.call_arena;
    const selectors = try Parser.parseList(arena, input);

    for (selectors) |selector| {
        if (List.matches(el.asNode(), selector, scope.asNode(), frame)) {
            return true;
        }
    }
    return false;
}

pub fn classAttributeContains(class_attr: []const u8, class_name: []const u8) bool {
    if (class_name.len == 0 or class_name.len > class_attr.len) return false;

    var search = class_attr;
    while (std.mem.indexOf(u8, search, class_name)) |pos| {
        const is_start = pos == 0 or search[pos - 1] == ' ';
        const end = pos + class_name.len;
        const is_end = end == search.len or search[end] == ' ';

        if (is_start and is_end) return true;

        search = search[pos + 1 ..];
    }
    return false;
}

pub const Part = union(enum) {
    id: []const u8,
    class: []const u8,
    tag: Node.Element.Tag, // optimized, for known tags
    tag_name: []const u8, // fallback for custom/unknown tags
    universal, // '*' any element
    pseudo_class: PseudoClass,
    attribute: Attribute,
};

pub const Attribute = struct {
    name: String,
    matcher: AttributeMatcher,
    case_insensitive: bool,
};

pub const AttributeMatcher = union(enum) {
    presence,
    exact: []const u8,
    word: []const u8,
    prefix_dash: []const u8,
    starts_with: []const u8,
    ends_with: []const u8,
    substring: []const u8,
};

pub const PseudoClass = union(enum) {
    // State pseudo-classes
    modal,
    checked,
    disabled,
    enabled,
    indeterminate,

    // Form validation
    valid,
    invalid,
    required,
    optional,
    in_range,
    out_of_range,
    placeholder_shown,
    read_only,
    read_write,
    default,

    // User interaction
    hover,
    active,
    focus,
    focus_within,
    focus_visible,

    // Link states
    link,
    visited,
    any_link,
    target,

    // Tree structural
    root,
    scope,
    empty,
    first_child,
    last_child,
    only_child,
    first_of_type,
    last_of_type,
    only_of_type,
    nth_child: NthPattern,
    nth_last_child: NthPattern,
    nth_of_type: NthPattern,
    nth_last_of_type: NthPattern,

    // Custom elements
    defined,

    // Functional
    lang: []const u8,
    not: []const Selector, // :not() - CSS Level 4: supports full selectors and comma-separated lists
    is: []const Selector, // :is() - matches any of the selectors
    where: []const Selector, // :where() - like :is() but with zero specificity
    has: []const Selector, // :has() - element containing descendants matching selector
};

pub const NthPattern = struct {
    a: i32, // coefficient (e.g., 2 in "2n+1")
    b: i32, // offset (e.g., 1 in "2n+1")

    // Common patterns:
    // odd: a=2, b=1
    // even: a=2, b=0
    // 3n+1: a=3, b=1
    // 5: a=0, b=5

    /// CSS Syntax § Serializing <an+b>
    /// https://drafts.csswg.org/css-syntax/#serializing-anb
    pub fn serialize(self: NthPattern, writer: *std.Io.Writer) error{WriteFailed}!void {
        const a = self.a;
        const b = self.b;
        if (a == 0) {
            try writer.print("{d}", .{b});
            return;
        }
        if (a == 1) {
            try writer.writeByte('n');
        } else if (a == -1) {
            try writer.writeAll("-n");
        } else {
            try writer.print("{d}n", .{a});
        }
        if (b == 0) return;
        if (b > 0) {
            try writer.print("+{d}", .{b});
        } else {
            // Negative b already includes '-'.
            try writer.print("{d}", .{b});
        }
    }
};

// Combinator represents the relationship between two compound selectors
pub const Combinator = enum {
    descendant, // ' ' - any descendant
    child, // '>' - direct child
    next_sibling, // '+' - immediately following sibling
    subsequent_sibling, // '~' - any following sibling
};

// A compound selector is multiple parts that all match the same element
//   "div.class#id" -> [tag(div), class("class"), id("id")]
pub const Compound = struct {
    parts: []const Part,

    pub fn format(self: Compound, writer: *std.Io.Writer) !void {
        for (self.parts) |part| switch (part) {
            .id => |val| {
                try writer.writeByte('#');
                try writer.writeAll(val);
            },
            .class => |val| {
                try writer.writeByte('.');
                try writer.writeAll(val);
            },
            .tag => |val| try writer.writeAll(@tagName(val)),
            .tag_name => |val| try writer.writeAll(val),
            .universal => try writer.writeByte('*'),
            .pseudo_class => |pc| {
                try writer.writeByte(':');
                try formatPseudoClass(pc, writer);
            },
            .attribute => |attr| {
                try writer.writeByte('[');
                try writer.writeAll(attr.name.str());
                switch (attr.matcher) {
                    .presence => {},
                    .exact => |v| try writer.print("=\"{s}\"", .{v}),
                    .word => |v| try writer.print("~=\"{s}\"", .{v}),
                    .prefix_dash => |v| try writer.print("|=\"{s}\"", .{v}),
                    .starts_with => |v| try writer.print("^=\"{s}\"", .{v}),
                    .ends_with => |v| try writer.print("$=\"{s}\"", .{v}),
                    .substring => |v| try writer.print("*=\"{s}\"", .{v}),
                }
                if (attr.case_insensitive) try writer.writeAll(" i");
                try writer.writeByte(']');
            },
        };
    }
};

fn formatPseudoClass(pc: PseudoClass, writer: *std.Io.Writer) error{WriteFailed}!void {
    switch (pc) {
        .modal => try writer.writeAll("modal"),
        .checked => try writer.writeAll("checked"),
        .disabled => try writer.writeAll("disabled"),
        .enabled => try writer.writeAll("enabled"),
        .indeterminate => try writer.writeAll("indeterminate"),
        .valid => try writer.writeAll("valid"),
        .invalid => try writer.writeAll("invalid"),
        .required => try writer.writeAll("required"),
        .optional => try writer.writeAll("optional"),
        .in_range => try writer.writeAll("in-range"),
        .out_of_range => try writer.writeAll("out-of-range"),
        .placeholder_shown => try writer.writeAll("placeholder-shown"),
        .read_only => try writer.writeAll("read-only"),
        .read_write => try writer.writeAll("read-write"),
        .default => try writer.writeAll("default"),
        .hover => try writer.writeAll("hover"),
        .active => try writer.writeAll("active"),
        .focus => try writer.writeAll("focus"),
        .focus_within => try writer.writeAll("focus-within"),
        .focus_visible => try writer.writeAll("focus-visible"),
        .link => try writer.writeAll("link"),
        .visited => try writer.writeAll("visited"),
        .any_link => try writer.writeAll("any-link"),
        .target => try writer.writeAll("target"),
        .root => try writer.writeAll("root"),
        .scope => try writer.writeAll("scope"),
        .empty => try writer.writeAll("empty"),
        .first_child => try writer.writeAll("first-child"),
        .last_child => try writer.writeAll("last-child"),
        .only_child => try writer.writeAll("only-child"),
        .first_of_type => try writer.writeAll("first-of-type"),
        .last_of_type => try writer.writeAll("last-of-type"),
        .only_of_type => try writer.writeAll("only-of-type"),
        .defined => try writer.writeAll("defined"),
        .nth_child => |p| {
            try writer.writeAll("nth-child(");
            try p.serialize(writer);
            try writer.writeByte(')');
        },
        .nth_last_child => |p| {
            try writer.writeAll("nth-last-child(");
            try p.serialize(writer);
            try writer.writeByte(')');
        },
        .nth_of_type => |p| {
            try writer.writeAll("nth-of-type(");
            try p.serialize(writer);
            try writer.writeByte(')');
        },
        .nth_last_of_type => |p| {
            try writer.writeAll("nth-last-of-type(");
            try p.serialize(writer);
            try writer.writeByte(')');
        },
        .lang => |l| try writer.print("lang({s})", .{l}),
        .not => |sels| {
            try writer.writeAll("not(");
            try formatSelectorList(sels, writer);
            try writer.writeByte(')');
        },
        .is => |sels| {
            try writer.writeAll("is(");
            try formatSelectorList(sels, writer);
            try writer.writeByte(')');
        },
        .where => |sels| {
            try writer.writeAll("where(");
            try formatSelectorList(sels, writer);
            try writer.writeByte(')');
        },
        .has => |sels| {
            try writer.writeAll("has(");
            try formatSelectorList(sels, writer);
            try writer.writeByte(')');
        },
    }
}

fn formatSelectorList(sels: []const Selector, writer: *std.Io.Writer) error{WriteFailed}!void {
    for (sels, 0..) |sel, i| {
        if (i > 0) try writer.writeAll(", ");
        try sel.format(writer);
    }
}

// A segment represents a compound selector with the combinator that precedes it
pub const Segment = struct {
    compound: Compound,
    combinator: Combinator,

    pub fn format(self: Segment, writer: *std.Io.Writer) !void {
        switch (self.combinator) {
            .descendant => try writer.writeByte(' '),
            .child => try writer.writeAll(" > "),
            .next_sibling => try writer.writeAll(" + "),
            .subsequent_sibling => try writer.writeAll(" ~ "),
        }
        return self.compound.format(writer);
    }
};

// A full selector is the first compound plus subsequent segments
//   "div > p + span" -> { first: [tag(div)], segments: [{child, [tag(p)]}, {next_sibling, [tag(span)]}] }
pub const Selector = struct {
    first: Compound,
    segments: []const Segment,

    pub fn format(self: Selector, writer: *std.Io.Writer) !void {
        try self.first.format(writer);
        for (self.segments) |segment| {
            try segment.format(writer);
        }
    }
};

pub const Parsed = struct {
    selectors: []const Selector,

    pub fn query(self: Parsed, root: *Node, frame: *Frame) !?*Node.Element {
        for (self.selectors) |selector| {
            // Fast path: single compound with only an ID selector
            if (selector.segments.len == 0 and selector.first.parts.len == 1) {
                const first = selector.first.parts[0];
                if (first == .id) {
                    const el = frame.getElementByIdFromNode(root, first.id) orelse continue;
                    // Check if the element is within the root subtree
                    const node = el.asNode();
                    if (node != root and root.contains(node)) {
                        return el;
                    }
                    continue;
                }
            }

            if (List.initOne(root, selector, frame)) |node| {
                if (node.is(Node.Element)) |el| {
                    return el;
                }
            }
        }
        return null;
    }
};
