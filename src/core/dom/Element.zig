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
const StyleManager = @import("../browser/StyleManager.zig");
const reflect = @import("../browser/reflect.zig");

const Node = @import("Node.zig");
const CSS = @import("../webapi/CSS.zig");
const ShadowRoot = @import("../webapi/ShadowRoot.zig");
const IFrame = @import("../webapi/element/html/IFrame.zig");
const EventTarget = @import("../webapi/EventTarget.zig");
const collections = @import("../webapi/collections.zig");
const Selector = @import("../webapi/selector/Selector.zig");
const Animation = @import("../webapi/animation/Animation.zig");
const DOMStringMap = @import("../webapi/element/DOMStringMap.zig");
const CSSStyleProperties = @import("../webapi/css/CSSStyleProperties.zig");
const ClientRectsIntelligent = @import("../../runtime/profile/ClientRectsIntelligent.zig");
const TextMetrics = @import("../webapi/canvas/TextMetrics.zig");

pub const DOMRect = @import("DOMRect.zig");
pub const Svg = @import("../webapi/element/Svg.zig");
pub const Html = @import("../webapi/element/Html.zig");
pub const Attribute = @import("../webapi/element/Attribute.zig");
const AttrAssociatedElement = @import("AttrAssociatedElement.zig");

const log = @import("../../support/log.zig");
const String = @import("../../support/string.zig").String;

const Element = @This();

fn assert(ok: bool, comptime msg: []const u8, args: anytype) void {
    if (ok) return;
    log.err(.app, msg, args);
    std.debug.assert(ok);
}

pub const DatasetLookup = std.AutoHashMapUnmanaged(*Element, *DOMStringMap);
pub const StyleLookup = std.AutoHashMapUnmanaged(*Element, *CSSStyleProperties);
pub const ClassListLookup = std.AutoHashMapUnmanaged(*Element, *collections.DOMTokenList);
pub const RelListLookup = std.AutoHashMapUnmanaged(*Element, *collections.DOMTokenList);
pub const SandboxListLookup = std.AutoHashMapUnmanaged(*Element, *collections.DOMTokenList);
pub const HtmlForListLookup = std.AutoHashMapUnmanaged(*Element, *collections.DOMTokenList);
pub const SizesListLookup = std.AutoHashMapUnmanaged(*Element, *collections.DOMTokenList);
pub const ShadowRootLookup = std.AutoHashMapUnmanaged(*Element, *ShadowRoot);
pub const AssignedSlotLookup = std.AutoHashMapUnmanaged(*Element, *Html.Slot);
pub const NamespaceUriLookup = std.AutoHashMapUnmanaged(*Element, []const u8);

pub const ScrollPosition = struct {
    x: u32 = 0,
    y: u32 = 0,
};
pub const ScrollPositionLookup = std.AutoHashMapUnmanaged(*Element, ScrollPosition);

pub const Namespace = enum(u8) {
    html,
    svg,
    mathml,
    xml,
    // We should keep the original value, but don't.  If this becomes important
    // consider storing it in a frame lookup, like `_element_class_lists`, rather
    // that adding a slice directly here (directly in every element).
    unknown,
    null,

    pub fn toUri(self: Namespace) ?[]const u8 {
        return switch (self) {
            .html => "http://www.w3.org/1999/xhtml",
            .svg => "http://www.w3.org/2000/svg",
            .mathml => "http://www.w3.org/1998/Math/MathML",
            .xml => "http://www.w3.org/XML/1998/namespace",
            .unknown => "http://kokoio.com/unsupported/namespace",
            .null => null,
        };
    }

    pub fn parse(namespace_: ?[]const u8) Namespace {
        const namespace = namespace_ orelse return .null;
        if (namespace.len == "http://www.w3.org/1999/xhtml".len) {
            // Common case, avoid the string comparison. Recklessly
            @branchHint(.likely);
            return .html;
        }
        if (std.mem.eql(u8, namespace, "http://www.w3.org/XML/1998/namespace")) {
            return .xml;
        }
        if (std.mem.eql(u8, namespace, "http://www.w3.org/2000/svg")) {
            return .svg;
        }
        if (std.mem.eql(u8, namespace, "http://www.w3.org/1998/Math/MathML")) {
            return .mathml;
        }
        return .unknown;
    }
};

_type: Type,
_proto: *Node,
_namespace: Namespace = .html,
_attributes: ?*Attribute.List = null,

pub const Type = union(enum) {
    html: *Html,
    svg: *Svg,
};

pub fn is(self: *Element, comptime T: type) ?*T {
    const type_name = @typeName(T);
    switch (self._type) {
        .html => |el| {
            if (T == Html) {
                return el;
            }
            if (comptime std.mem.indexOf(u8, type_name, ".webapi.element.html.") != null) {
                return el.is(T);
            }
        },
        .svg => |svg| {
            if (T == Svg) {
                return svg;
            }
            if (comptime std.mem.indexOf(u8, type_name, ".webapi.element.svg.") != null) {
                return svg.is(T);
            }
        },
    }
    return null;
}

pub fn as(self: *Element, comptime T: type) *T {
    return self.is(T).?;
}

pub fn asNode(self: *Element) *Node {
    return self._proto;
}

pub fn asEventTarget(self: *Element) *EventTarget {
    return self._proto.asEventTarget();
}

pub fn asConstNode(self: *const Element) *const Node {
    return self._proto;
}

pub fn attributesEql(self: *const Element, other: *Element) bool {
    if (self._attributes) |attr_list| {
        const other_list = other._attributes orelse return false;
        return attr_list.eql(other_list);
    }
    // Make sure no attrs in both sides.
    return other._attributes == null;
}

/// TODO: localName and prefix comparison.
pub fn isEqualNode(self: *Element, other: *Element) bool {
    const self_tag = self.getTagNameDump();
    const other_tag = other.getTagNameDump();
    // Compare namespaces and tags.
    const dirty = self._namespace != other._namespace or !std.mem.eql(u8, self_tag, other_tag);
    if (dirty) {
        return false;
    }

    // Compare attributes.
    if (!self.attributesEql(other)) {
        return false;
    }

    // Compare children.
    var self_iter = self.asNode().childrenIterator();
    var other_iter = other.asNode().childrenIterator();
    var self_count: usize = 0;
    var other_count: usize = 0;
    while (self_iter.next()) |self_node| : (self_count += 1) {
        const other_node = other_iter.next() orelse return false;
        other_count += 1;
        if (self_node.isEqualNode(other_node)) {
            continue;
        }

        return false;
    }

    // Make sure both have equal number of children.
    return self_count == other_count;
}

pub fn getTagNameLower(self: *const Element) []const u8 {
    switch (self._type) {
        .html => |he| switch (he._type) {
            .custom => |ce| {
                @branchHint(.unlikely);
                return ce._tag_name.str();
            },
            else => return switch (he._type) {
                .anchor => "a",
                .area => "area",
                .base => "base",
                .body => "body",
                .br => "br",
                .button => "button",
                .canvas => "canvas",
                .custom => |e| e._tag_name.str(),
                .data => "data",
                .datalist => "datalist",
                .details => "details",
                .dialog => "dialog",
                .directory => "dir",
                .div => "div",
                .dl => "dl",
                .embed => "embed",
                .fieldset => "fieldset",
                .font => "font",
                .frameset => "frameset",
                .form => "form",
                .generic => |e| e._tag_name.str(),
                .heading => |e| e._tag_name.str(),
                .head => "head",
                .html => "html",
                .hr => "hr",
                .iframe => "iframe",
                .img => "img",
                .input => "input",
                .label => "label",
                .legend => "legend",
                .li => "li",
                .link => "link",
                .map => "map",
                .marquee => "marquee",
                .media => |m| switch (m._type) {
                    .audio => "audio",
                    .video => "video",
                    .generic => "media",
                },
                .meta => "meta",
                .meter => "meter",
                .mod => |e| e._tag_name.str(),
                .object => "object",
                .ol => "ol",
                .optgroup => "optgroup",
                .option => "option",
                .output => "output",
                .p => "p",
                .picture => "picture",
                .param => "param",
                .pre => "pre",
                .progress => "progress",
                .quote => |e| e._tag_name.str(),
                .script => "script",
                .select => "select",
                .slot => "slot",
                .source => "source",
                .span => "span",
                .style => "style",
                .table => "table",
                .table_caption => "caption",
                .table_cell => |e| e._tag_name.str(),
                .table_col => |e| e._tag_name.str(),
                .table_row => "tr",
                .table_section => |e| e._tag_name.str(),
                .template => "template",
                .textarea => "textarea",
                .time => "time",
                .title => "title",
                .track => "track",
                .ul => "ul",
                .unknown => |e| e._tag_name.str(),
            },
        },
        .svg => |svg| return svg._tag_name.str(),
    }
}

pub fn getTagNameSpec(self: *const Element, buf: []u8) []const u8 {
    return switch (self._type) {
        .html => |he| switch (he._type) {
            .anchor => "A",
            .area => "AREA",
            .base => "BASE",
            .body => "BODY",
            .br => "BR",
            .button => "BUTTON",
            .canvas => "CANVAS",
            .custom => |e| upperTagName(&e._tag_name, buf),
            .data => "DATA",
            .datalist => "DATALIST",
            .details => "DETAILS",
            .dialog => "DIALOG",
            .directory => "DIR",
            .div => "DIV",
            .dl => "DL",
            .embed => "EMBED",
            .fieldset => "FIELDSET",
            .font => "FONT",
            .frameset => "FRAMESET",
            .form => "FORM",
            .generic => |e| upperTagName(&e._tag_name, buf),
            .heading => |e| upperTagName(&e._tag_name, buf),
            .head => "HEAD",
            .html => "HTML",
            .hr => "HR",
            .iframe => "IFRAME",
            .img => "IMG",
            .input => "INPUT",
            .label => "LABEL",
            .legend => "LEGEND",
            .li => "LI",
            .link => "LINK",
            .map => "MAP",
            .marquee => "MARQUEE",
            .meta => "META",
            .media => |m| switch (m._type) {
                .audio => "AUDIO",
                .video => "VIDEO",
                .generic => "MEDIA",
            },
            .meter => "METER",
            .mod => |e| upperTagName(&e._tag_name, buf),
            .object => "OBJECT",
            .ol => "OL",
            .optgroup => "OPTGROUP",
            .option => "OPTION",
            .output => "OUTPUT",
            .p => "P",
            .picture => "PICTURE",
            .param => "PARAM",
            .pre => "PRE",
            .progress => "PROGRESS",
            .quote => |e| upperTagName(&e._tag_name, buf),
            .script => "SCRIPT",
            .select => "SELECT",
            .slot => "SLOT",
            .source => "SOURCE",
            .span => "SPAN",
            .style => "STYLE",
            .table => "TABLE",
            .table_caption => "CAPTION",
            .table_cell => |e| upperTagName(&e._tag_name, buf),
            .table_col => |e| upperTagName(&e._tag_name, buf),
            .table_row => "TR",
            .table_section => |e| upperTagName(&e._tag_name, buf),
            .template => "TEMPLATE",
            .textarea => "TEXTAREA",
            .time => "TIME",
            .title => "TITLE",
            .track => "TRACK",
            .ul => "UL",
            .unknown => |e| switch (self._namespace) {
                .html => upperTagName(&e._tag_name, buf),
                .svg, .xml, .mathml, .unknown, .null => e._tag_name.str(),
            },
        },
        .svg => |svg| svg._tag_name.str(),
    };
}

pub fn getTagNameDump(self: *const Element) []const u8 {
    switch (self._type) {
        .html => return self.getTagNameLower(),
        .svg => |svg| return svg._tag_name.str(),
    }
}

pub fn getNamespaceURI(self: *const Element) ?[]const u8 {
    return self._namespace.toUri();
}

pub fn getNamespaceUri(self: *Element, frame: *Frame) ?[]const u8 {
    if (self._namespace != .unknown) return self._namespace.toUri();
    return frame._element_namespace_uris.get(self);
}

pub fn lookupNamespaceURIForElement(self: *Element, prefix: ?[]const u8, frame: *Frame) ?[]const u8 {
    // Hardcoded reserved prefixes
    if (prefix) |p| {
        if (std.mem.eql(u8, p, "xml")) return "http://www.w3.org/XML/1998/namespace";
        if (std.mem.eql(u8, p, "xmlns")) return "http://www.w3.org/2000/xmlns/";
    }

    // Step 1: check element's own namespace/prefix
    if (self.getNamespaceUri(frame)) |ns_uri| {
        const el_prefix = self._prefix();
        const match = if (prefix == null and el_prefix == null)
            true
        else if (prefix != null and el_prefix != null)
            std.mem.eql(u8, prefix.?, el_prefix.?)
        else
            false;
        if (match) return ns_uri;
    }

    // Step 2: search xmlns attributes
    if (self._attributes) |attrs| {
        var iter = attrs.iterator();
        while (iter.next()) |entry| {
            if (prefix == null) {
                if (entry._name.eql(comptime .wrap("xmlns"))) {
                    const val = entry._value.str();
                    return if (val.len == 0) null else val;
                }
            } else {
                const name = entry._name.str();
                if (std.mem.startsWith(u8, name, "xmlns:")) {
                    if (std.mem.eql(u8, name["xmlns:".len..], prefix.?)) {
                        const val = entry._value.str();
                        return if (val.len == 0) null else val;
                    }
                }
            }
        }
    }

    // Step 3: recurse to parent element
    const parent = self.asNode().parentElement() orelse return null;
    return parent.lookupNamespaceURIForElement(prefix, frame);
}

fn _prefix(self: *const Element) ?[]const u8 {
    const name = self.getTagNameLower();
    if (std.mem.indexOfPos(u8, name, 0, ":")) |pos| {
        return name[0..pos];
    }
    return null;
}

pub fn getLocalName(self: *Element) []const u8 {
    const name = self.getTagNameLower();
    if (std.mem.indexOfPos(u8, name, 0, ":")) |pos| {
        return name[pos + 1 ..];
    }

    return name;
}

// Wrapper methods that delegate to Html implementations
pub fn getInnerText(self: *Element, writer: *std.Io.Writer, frame: *Frame) !void {
    const he = self.is(Html) orelse return error.NotHtmlElement;
    return he.getInnerText(writer, frame);
}

pub fn setInnerText(self: *Element, text: []const u8, frame: *Frame) !void {
    const he = self.is(Html) orelse return error.NotHtmlElement;
    return he.setInnerText(text, frame);
}

pub fn insertAdjacentHTML(
    self: *Element,
    position: []const u8,
    html_or_xml: []const u8,
    frame: *Frame,
) !void {
    const he = self.is(Html) orelse return error.NotHtmlElement;
    return he.insertAdjacentHTML(position, html_or_xml, frame);
}

pub fn getOuterHTML(self: *Element, writer: *std.Io.Writer, frame: *Frame) !void {
    const dump = @import("../browser/dump.zig");
    return dump.deep(self.asNode(), .{ .shadow = .skip }, writer, frame);
}

pub fn setOuterHTML(self: *Element, html: []const u8, frame: *Frame) !void {
    const node = self.asNode();
    const parent = node._parent orelse return;

    frame.domChanged();
    if (html.len > 0) {
        const fragment = (try Node.DocumentFragment.init(frame)).asNode();
        try frame.parseHtmlAsChildren(fragment, html);
        try frame.insertAllChildrenBefore(fragment, parent, node);
    }

    // A custom element callback fired during insertAllChildrenBefore may
    // have already detached `node`; only remove it if it's still here.
    if (node._parent == parent) {
        frame.removeNode(parent, node, .{ .will_be_reconnected = false });
    }
}

pub fn getInnerHTML(self: *Element, writer: *std.Io.Writer, frame: *Frame) !void {
    const dump = @import("../browser/dump.zig");
    return dump.children(self.asNode(), .{ .shadow = .skip }, writer, frame);
}

pub fn setInnerHTML(self: *Element, html: []const u8, frame: *Frame) !void {
    const parent = self.asNode();
    const owner_frame = parent.ownerFrame(frame);

    // Remove all existing children. Drain via firstChild(): removeNode
    // fires disconnectedCallback for custom elements, which can mutate
    // the child list and dangle any cached next-pointer the iterator
    // would otherwise hold.
    owner_frame.domChanged();
    while (parent.firstChild()) |child| {
        owner_frame.removeNode(parent, child, .{ .will_be_reconnected = false });
    }

    // Fast path: skip parsing if html is empty
    if (html.len == 0) {
        return;
    }

    // Parse and add new children
    try owner_frame.parseHtmlAsChildren(parent, html);
}

pub fn getId(self: *const Element) []const u8 {
    return self.getAttributeSafe(comptime .wrap("id")) orelse "";
}

pub fn setId(self: *Element, value: []const u8, frame: *Frame) !void {
    return self.setAttributeSafe(comptime .wrap("id"), .wrap(value), frame);
}

pub fn getSlot(self: *const Element) []const u8 {
    return self.getAttributeSafe(comptime .wrap("slot")) orelse "";
}

pub fn setSlot(self: *Element, value: []const u8, frame: *Frame) !void {
    return self.setAttributeSafe(comptime .wrap("slot"), .wrap(value), frame);
}

const dirEnumDef: ReflectedEnumDef = .{
    .attr_name = "dir",
    .keywords = &.{ "ltr", "rtl", "auto" },
    .invalid_val = "",
};

pub fn getDir(self: *const Element) []const u8 {
    return getReflectedEnumAttribute(self, dirEnumDef) orelse "";
}

pub fn setDir(self: *Element, value: []const u8, frame: *Frame) !void {
    return setReflectedEnumAttributeValue(self, dirEnumDef, value, frame);
}

// ARIAMixin - reflected content attributes. Keep the JS property/attribute
// mapping in one table-shaped section so spec updates are auditable.

fn getReflectedNullableAttribute(self: *const Element, comptime attr_name: []const u8) ?[]const u8 {
    return self.getAttributeSafe(String.wrap(attr_name));
}

fn setReflectedNullableAttribute(self: *Element, comptime attr_name: []const u8, value: ?[]const u8, frame: *Frame) !void {
    if (value) |v| {
        try self.setAttributeSafe(String.wrap(attr_name), .wrap(v), frame);
    } else {
        try self.removeAttribute(String.wrap(attr_name), frame);
    }
}

fn reflectedNullableAttribute(comptime attr_name: []const u8) type {
    return struct {
        fn get(self: *const Element) ?[]const u8 {
            return getReflectedNullableAttribute(self, attr_name);
        }

        fn set(self: *Element, value: ?[]const u8, frame: *Frame) !void {
            return setReflectedNullableAttribute(self, attr_name, value, frame);
        }
    };
}

const ReflectedEnumDef = struct {
    attr_name: []const u8,
    keywords: []const []const u8,
    invalid_val: ?[]const u8,
};

fn getReflectedEnumAttribute(self: *const Element, comptime def: ReflectedEnumDef) ?[]const u8 {
    const raw = self.getAttributeSafe(String.wrap(def.attr_name));
    if (raw == null) return null;

    var resolved: ?[]const u8 = def.invalid_val;
    for (def.keywords) |keyword| {
        if (std.ascii.eqlIgnoreCase(raw.?, keyword)) {
            resolved = keyword;
            break;
        }
    }
    return resolved;
}

fn setReflectedEnumAttribute(self: *Element, comptime def: ReflectedEnumDef, value: ?[]const u8, frame: *Frame) !void {
    const attr = String.wrap(def.attr_name);
    if (value) |v| {
        if (v.len == 0) {
            try self.setAttributeSafe(attr, .wrap(""), frame);
            return;
        }
        for (def.keywords) |keyword| {
            if (std.ascii.eqlIgnoreCase(v, keyword)) {
                try self.setAttributeSafe(attr, .wrap(v), frame);
                return;
            }
        }
        try self.setAttributeSafe(attr, .wrap(v), frame);
    } else {
        try self.removeAttribute(attr, frame);
    }
}

fn setReflectedEnumAttributeValue(self: *Element, comptime def: ReflectedEnumDef, value: []const u8, frame: *Frame) !void {
    try setReflectedEnumAttribute(self, def, value, frame);
}

fn reflectedEnumAttribute(comptime def: ReflectedEnumDef) type {
    return struct {
        fn get(self: *const Element) ?[]const u8 {
            return getReflectedEnumAttribute(self, def);
        }

        fn set(self: *Element, value: ?[]const u8, frame: *Frame) !void {
            return setReflectedEnumAttribute(self, def, value, frame);
        }
    };
}

pub const RoleReflection = reflectedNullableAttribute("role");
pub const AriaAtomicReflection = reflectedNullableAttribute("aria-atomic");
pub const AriaAutoCompleteReflection = reflectedNullableAttribute("aria-autocomplete");
pub const AriaBrailleLabelReflection = reflectedNullableAttribute("aria-braillelabel");
pub const AriaBrailleRoleDescriptionReflection = reflectedNullableAttribute("aria-brailleroledescription");
pub const AriaBusyReflection = reflectedNullableAttribute("aria-busy");
pub const AriaCheckedReflection = reflectedNullableAttribute("aria-checked");
pub const AriaColCountReflection = reflectedNullableAttribute("aria-colcount");
pub const AriaColIndexReflection = reflectedNullableAttribute("aria-colindex");
pub const AriaColIndexTextReflection = reflectedNullableAttribute("aria-colindextext");
pub const AriaColSpanReflection = reflectedNullableAttribute("aria-colspan");
pub const AriaCurrentReflection = reflectedNullableAttribute("aria-current");
pub const AriaDescriptionReflection = reflectedNullableAttribute("aria-description");
pub const AriaDisabledReflection = reflectedNullableAttribute("aria-disabled");
pub const AriaExpandedReflection = reflectedNullableAttribute("aria-expanded");
pub const AriaHasPopupReflection = reflectedNullableAttribute("aria-haspopup");
pub const AriaHiddenReflection = reflectedNullableAttribute("aria-hidden");
pub const AriaInvalidReflection = reflectedNullableAttribute("aria-invalid");
pub const AriaKeyShortcutsReflection = reflectedNullableAttribute("aria-keyshortcuts");
pub const AriaLabelReflection = reflectedNullableAttribute("aria-label");
pub const AriaLevelReflection = reflectedNullableAttribute("aria-level");
pub const AriaLiveReflection = reflectedNullableAttribute("aria-live");
pub const AriaModalReflection = reflectedNullableAttribute("aria-modal");
pub const AriaMultiLineReflection = reflectedNullableAttribute("aria-multiline");
pub const AriaMultiSelectableReflection = reflectedNullableAttribute("aria-multiselectable");
pub const AriaOrientationReflection = reflectedNullableAttribute("aria-orientation");
pub const AriaPlaceholderReflection = reflectedNullableAttribute("aria-placeholder");
pub const AriaPosInSetReflection = reflectedNullableAttribute("aria-posinset");
pub const AriaPressedReflection = reflectedNullableAttribute("aria-pressed");
pub const AriaReadOnlyReflection = reflectedNullableAttribute("aria-readonly");
pub const AriaRelevantReflection = reflectedNullableAttribute("aria-relevant");
pub const AriaRequiredReflection = reflectedNullableAttribute("aria-required");
pub const AriaRoleDescriptionReflection = reflectedNullableAttribute("aria-roledescription");
pub const AriaRowCountReflection = reflectedNullableAttribute("aria-rowcount");
pub const AriaRowIndexReflection = reflectedNullableAttribute("aria-rowindex");
pub const AriaRowIndexTextReflection = reflectedNullableAttribute("aria-rowindextext");
pub const AriaRowSpanReflection = reflectedNullableAttribute("aria-rowspan");
pub const AriaSelectedReflection = reflectedNullableAttribute("aria-selected");
pub const AriaSetSizeReflection = reflectedNullableAttribute("aria-setsize");
pub const AriaSortReflection = reflectedNullableAttribute("aria-sort");
pub const AriaValueMaxReflection = reflectedNullableAttribute("aria-valuemax");
pub const AriaValueMinReflection = reflectedNullableAttribute("aria-valuemin");
pub const AriaValueNowReflection = reflectedNullableAttribute("aria-valuenow");
pub const AriaValueTextReflection = reflectedNullableAttribute("aria-valuetext");

pub fn getClassName(self: *const Element) []const u8 {
    return self.getAttributeSafe(comptime .wrap("class")) orelse "";
}

pub fn setClassName(self: *Element, value: []const u8, frame: *Frame) !void {
    return self.setAttributeSafe(comptime .wrap("class"), .wrap(value), frame);
}

pub fn attributeIterator(self: *Element) Attribute.InnerIterator {
    const attributes = self._attributes orelse return .{};
    return attributes.iterator();
}

pub fn getAttribute(self: *const Element, name: String, frame: *Frame) !?String {
    const attributes = self._attributes orelse return null;
    return attributes.get(name, frame);
}

/// For simplicity, the namespace is currently ignored and only the local name is used.
pub fn getAttributeNS(
    self: *const Element,
    maybe_namespace: ?[]const u8,
    local_name: String,
    frame: *Frame,
) !?String {
    if (maybe_namespace) |namespace| {
        if (!std.mem.eql(u8, namespace, "http://www.w3.org/1999/xhtml")) {
            log.warn(.not_implemented, "Element.getAttributeNS", .{ .namespace = namespace });
        }
    }

    return self.getAttribute(local_name, frame);
}

pub fn getAttributeSafe(self: *const Element, name: String) ?[]const u8 {
    const attributes = self._attributes orelse return null;
    return attributes.getSafe(name);
}

pub fn hasAttribute(self: *const Element, name: String, frame: *Frame) !bool {
    const attributes = self._attributes orelse return false;
    const value = try attributes.get(name, frame);
    return value != null;
}

pub fn hasAttributeSafe(self: *const Element, name: String) bool {
    const attributes = self._attributes orelse return false;
    return attributes.hasSafe(name);
}

// Per HTML "concept-fe-disabled", only listed elements participate in the
// disabled concept. Anything else (e.g. <div disabled>) has no disabled
// state and never matches :disabled / :enabled.
pub fn hasDisabledConcept(self: *const Element) bool {
    return switch (self.getTag()) {
        .button, .input, .select, .textarea, .optgroup, .option, .fieldset => true,
        else => false,
    };
}

pub fn isDisabled(self: *Element) bool {
    if (!self.hasDisabledConcept()) {
        return false;
    }

    if (self.getAttributeSafe(comptime .wrap("disabled")) != null) {
        return true;
    }

    // <option> takes a different inheritance path: per HTML
    // "concept-option-disabled" an option is disabled when its parent is an
    // <optgroup disabled>. It does NOT inherit from <select disabled> or
    // an ancestor <fieldset disabled>.
    if (self.getTag() == .option) {
        if (self.asNode()._parent) |parent_node| {
            if (parent_node.is(Element)) |parent_el| {
                if (parent_el.getTag() == .optgroup and
                    parent_el.getAttributeSafe(comptime .wrap("disabled")) != null)
                {
                    return true;
                }
            }
        }
        return false;
    }

    const element_node = self.asNode();
    var current: ?*Node = element_node._parent;
    while (current) |node| {
        current = node._parent;
        const ancestor = node.is(Element) orelse continue;

        if (ancestor.getTag() == .fieldset and ancestor.getAttributeSafe(comptime .wrap("disabled")) != null) {
            var child = ancestor.firstElementChild();
            while (child) |c| {
                if (c.getTag() == .legend) {
                    if (c.asNode().contains(element_node)) return false;
                    break;
                }
                child = c.nextElementSibling();
            }
            return true;
        }
    }
    return false;
}

pub fn hasAttributes(self: *const Element) bool {
    const attributes = self._attributes orelse return false;
    return attributes.isEmpty() == false;
}

pub fn getAttributeNode(self: *Element, name: String, frame: *Frame) !?*Attribute {
    const attributes = self._attributes orelse return null;
    return attributes.getAttribute(name, self, frame);
}

pub fn setAttribute(self: *Element, name: String, value: String, frame: *Frame) !void {
    try Attribute.validateAttributeName(name);
    const attributes = try self.getOrCreateAttributeList(frame);
    _ = try attributes.put(name, value, self, frame);
}

pub fn setAttributeNS(
    self: *Element,
    maybe_namespace: ?[]const u8,
    qualified_name: []const u8,
    value: String,
    frame: *Frame,
) !void {
    const attr_name = if (maybe_namespace) |namespace| blk: {
        // For xmlns namespace, store the full qualified name (e.g. "xmlns:bar")
        // so lookupNamespaceURI can find namespace declarations.
        if (std.mem.eql(u8, namespace, "http://www.w3.org/2000/xmlns/")) {
            break :blk qualified_name;
        }
        if (!std.mem.eql(u8, namespace, "http://www.w3.org/1999/xhtml")) {
            log.warn(.not_implemented, "Element.setAttributeNS", .{ .namespace = namespace });
        }
        break :blk if (std.mem.indexOfScalarPos(u8, qualified_name, 0, ':')) |idx|
            qualified_name[idx + 1 ..]
        else
            qualified_name;
    } else blk: {
        break :blk if (std.mem.indexOfScalarPos(u8, qualified_name, 0, ':')) |idx|
            qualified_name[idx + 1 ..]
        else
            qualified_name;
    };
    return self.setAttribute(.wrap(attr_name), value, frame);
}

pub fn setAttributeSafe(self: *Element, name: String, value: String, frame: *Frame) !void {
    const attributes = try self.getOrCreateAttributeList(frame);
    _ = try attributes.putSafe(name, value, self, frame);
}

pub fn getOrCreateAttributeList(self: *Element, frame: *Frame) !*Attribute.List {
    return self._attributes orelse return self.createAttributeList(frame);
}

pub fn createAttributeList(self: *Element, frame: *Frame) !*Attribute.List {
    assert(self._attributes == null, "Element.createAttributeList non-null _attributes", .{});
    const a = try frame.arena.create(Attribute.List);
    a.* = .{ .normalize = self._namespace == .html };
    self._attributes = a;
    return a;
}

pub fn getShadowRoot(self: *Element, frame: *Frame) ?*ShadowRoot {
    const shadow_root = frame._element_shadow_roots.get(self) orelse return null;
    if (shadow_root._mode == .closed) return null;
    return shadow_root;
}

pub fn getAssignedSlot(self: *Element, frame: *Frame) ?*Html.Slot {
    return frame._element_assigned_slots.get(self);
}

pub fn attachShadow(self: *Element, mode_str: []const u8, frame: *Frame) !*ShadowRoot {
    const mode = try ShadowRoot.Mode.fromString(mode_str);
    if (frame._element_shadow_roots.get(self)) |existing| {
        // React Strict Mode / SDK re-init may call attachShadow twice on the same
        // element. Return the existing root when the mode matches (open roots are
        // retrievable via element.shadowRoot anyway).
        if (existing._mode == mode) return existing;
        return error.AlreadyHasShadowRoot;
    }
    const shadow_root = try ShadowRoot.init(self, mode, frame);
    try frame._element_shadow_roots.put(frame.arena, self, shadow_root);
    return shadow_root;
}

pub fn detachShadowRoot(self: *Element, frame: *Frame) void {
    _ = frame._element_shadow_roots.remove(self);
}

pub fn insertAdjacentElement(
    self: *Element,
    position: []const u8,
    element: *Element,
    frame: *Frame,
) !void {
    const target_node, const prev_node = try self.asNode().findAdjacentNodes(position);
    _ = try target_node.insertBefore(element.asNode(), prev_node, frame);
}

pub fn insertAdjacentText(
    self: *Element,
    where: []const u8,
    data: []const u8,
    frame: *Frame,
) !void {
    const text_node = try frame.createTextNode(data);
    const target_node, const prev_node = try self.asNode().findAdjacentNodes(where);
    _ = try target_node.insertBefore(text_node, prev_node, frame);
}

pub fn setAttributeNode(self: *Element, attr: *Attribute, frame: *Frame) !?*Attribute {
    if (attr._element) |el| {
        if (el == self) {
            return attr;
        }
        attr._element = null;
        _ = try el.removeAttributeNode(attr, frame);
    }

    const attributes = try self.getOrCreateAttributeList(frame);
    return attributes.putAttribute(attr, self, frame);
}

pub fn removeAttribute(self: *Element, name: String, frame: *Frame) !void {
    AttrAssociatedElement.onAttributeRemoved(self, name.str(), frame);
    const attributes = self._attributes orelse return;
    return attributes.delete(name, self, frame);
}

pub fn getAriaActiveDescendantElement(self: *const Element, frame: *Frame) !?*Element {
    return AttrAssociatedElement.getSingle(self, .aria_active_descendant, frame);
}

pub fn setAriaActiveDescendantElement(self: *Element, value: js.Value, frame: *Frame) !void {
    return AttrAssociatedElement.set(self, .aria_active_descendant, value, frame);
}

pub fn getAriaDescribedByElements(self: *const Element, frame: *Frame) !?js.Value {
    const local = frame.js.local orelse return error.NotHandled;
    const arr = try AttrAssociatedElement.getArray(self, .aria_describedby, frame);
    if (arr) |array| {
        return .{ .local = local, .handle = @ptrCast(array.handle) };
    }
    return .{ .local = local, .handle = local.isolate.initNull() };
}

pub fn setAriaDescribedByElements(self: *Element, value: js.Value, frame: *Frame) !void {
    return AttrAssociatedElement.set(self, .aria_describedby, value, frame);
}

pub fn toggleAttribute(self: *Element, name: String, force: ?bool, frame: *Frame) !bool {
    try Attribute.validateAttributeName(name);
    const has = try self.hasAttribute(name, frame);

    const should_add = force orelse !has;

    if (should_add and !has) {
        try self.setAttribute(name, String.empty, frame);
        return true;
    } else if (!should_add and has) {
        try self.removeAttribute(name, frame);
        return false;
    }

    return should_add;
}

pub fn removeAttributeNode(self: *Element, attr: *Attribute, frame: *Frame) !*Attribute {
    if (attr._element == null or attr._element.? != self) {
        return error.NotFound;
    }
    try self.removeAttribute(attr._name, frame);
    attr._element = null;
    return attr;
}

pub fn getAttributeNames(self: *const Element, frame: *Frame) ![][]const u8 {
    const attributes = self._attributes orelse return &.{};
    return attributes.getNames(frame);
}

pub fn getAttributeNamedNodeMap(self: *Element, frame: *Frame) !*Attribute.NamedNodeMap {
    const gop = try frame._attribute_named_node_map_lookup.getOrPut(frame.arena, @intFromPtr(self));
    if (!gop.found_existing) {
        const attributes = try self.getOrCreateAttributeList(frame);
        const named_node_map = try frame._factory.create(Attribute.NamedNodeMap{ ._list = attributes, ._element = self });
        gop.value_ptr.* = named_node_map;
    }
    return gop.value_ptr.*;
}

pub fn getOrCreateStyle(self: *Element, frame: *Frame) !*CSSStyleProperties {
    const gop = try frame._element_styles.getOrPut(frame.arena, self);
    if (!gop.found_existing) {
        gop.value_ptr.* = try CSSStyleProperties.init(self, false, frame);
    }
    return gop.value_ptr.*;
}

fn getStyle(self: *Element, frame: *Frame) ?*CSSStyleProperties {
    return frame._element_styles.get(self);
}

pub fn getClassList(self: *Element, frame: *Frame) !*collections.DOMTokenList {
    const gop = try frame._element_class_lists.getOrPut(frame.arena, self);
    if (!gop.found_existing) {
        gop.value_ptr.* = try frame._factory.create(collections.DOMTokenList{
            ._element = self,
            ._attribute_name = comptime .wrap("class"),
        });
    }
    return gop.value_ptr.*;
}

pub fn setClassList(self: *Element, value: String, frame: *Frame) !void {
    const class_list = try self.getClassList(frame);
    try class_list.setValue(value, frame);
}

pub fn getRelList(self: *Element, frame: *Frame) !*collections.DOMTokenList {
    const gop = try frame._element_rel_lists.getOrPut(frame.arena, self);
    if (!gop.found_existing) {
        gop.value_ptr.* = try frame._factory.create(collections.DOMTokenList{
            ._element = self,
            ._attribute_name = comptime .wrap("rel"),
        });
    }
    return gop.value_ptr.*;
}

pub fn getSandboxList(self: *Element, frame: *Frame) !*collections.DOMTokenList {
    const gop = try frame._element_sandbox_lists.getOrPut(frame.arena, self);
    if (!gop.found_existing) {
        gop.value_ptr.* = try frame._factory.create(collections.DOMTokenList{
            ._element = self,
            ._attribute_name = comptime .wrap("sandbox"),
        });
    }
    return gop.value_ptr.*;
}

pub fn getHtmlForList(self: *Element, frame: *Frame) !*collections.DOMTokenList {
    const gop = try frame._element_html_for_lists.getOrPut(frame.arena, self);
    if (!gop.found_existing) {
        gop.value_ptr.* = try frame._factory.create(collections.DOMTokenList{
            ._element = self,
            ._attribute_name = comptime .wrap("for"),
        });
    }
    return gop.value_ptr.*;
}

pub fn getSizesList(self: *Element, frame: *Frame) !*collections.DOMTokenList {
    const gop = try frame._element_sizes_lists.getOrPut(frame.arena, self);
    if (!gop.found_existing) {
        gop.value_ptr.* = try frame._factory.create(collections.DOMTokenList{
            ._element = self,
            ._attribute_name = comptime .wrap("sizes"),
        });
    }
    return gop.value_ptr.*;
}

pub fn getDataset(self: *Element, frame: *Frame) !*DOMStringMap {
    const gop = try frame._element_datasets.getOrPut(frame.arena, self);
    if (!gop.found_existing) {
        gop.value_ptr.* = try frame._factory.create(DOMStringMap{
            ._element = self,
        });
    }
    return gop.value_ptr.*;
}

pub fn replaceChildren(self: *Element, nodes: []const Node.NodeOrText, frame: *Frame) !void {
    return self.asNode().replaceChildren(nodes, frame);
}

pub fn replaceWith(self: *Element, nodes: []const Node.NodeOrText, frame: *Frame) !void {
    frame.domChanged();

    const ref_node = self.asNode();
    const parent = ref_node._parent orelse return;

    const parent_is_connected = parent.isConnected();

    // Detect if the ref_node must be removed (by default) or kept.
    // We kept it when ref_node is present into the nodes list.
    var rm_ref_node = true;

    for (nodes) |node_or_text| {
        const child = try node_or_text.toNode(frame);

        // If a child is the ref node. We keep it at its own current position.
        if (child == ref_node) {
            rm_ref_node = false;
            continue;
        }

        if (child._parent) |current_parent| {
            frame.removeNode(current_parent, child, .{ .will_be_reconnected = parent_is_connected });
        }

        try frame.insertNodeRelative(
            parent,
            child,
            .{ .before = ref_node },
            .{ .child_already_connected = child.isConnected() },
        );
    }

    // Re-check parent after insertNodeRelative since callbacks (e.g. connectedCallback)
    // could have already removed ref_node from parent.
    if (rm_ref_node and ref_node._parent == parent) {
        frame.removeNode(parent, ref_node, .{ .will_be_reconnected = false });
    }
}

pub fn remove(self: *Element, frame: *Frame) void {
    frame.domChanged();
    const node = self.asNode();
    const parent = node._parent orelse return;
    frame.removeNode(parent, node, .{ .will_be_reconnected = false });
}

pub fn focus(self: *Element, frame: *Frame) !void {
    if (self.asNode().isConnected() == false) {
        // a disconnected node cannot take focus
        return;
    }

    const FocusEvent = @import("../webapi/event/FocusEvent.zig");

    const new_target = self.asEventTarget();
    const old_active = frame.document._active_element;
    frame.document._active_element = self;

    if (old_active) |old| {
        if (old == self) {
            return;
        }

        const old_target = old.asEventTarget();

        // Dispatch blur on old element (no bubble, composed)
        const blur_event = try FocusEvent.initTrusted(comptime .wrap("blur"), .{ .composed = true, .relatedTarget = new_target }, frame);
        try frame._event_manager.dispatch(old_target, blur_event.asEvent());

        // Dispatch focusout on old element (bubbles, composed)
        const focusout_event = try FocusEvent.initTrusted(comptime .wrap("focusout"), .{ .bubbles = true, .composed = true, .relatedTarget = new_target }, frame);
        try frame._event_manager.dispatch(old_target, focusout_event.asEvent());
    }

    const old_related: ?*EventTarget = if (old_active) |old| old.asEventTarget() else null;

    // Dispatch focus on new element (no bubble, composed)
    const focus_event = try FocusEvent.initTrusted(comptime .wrap("focus"), .{ .composed = true, .relatedTarget = old_related }, frame);
    try frame._event_manager.dispatch(new_target, focus_event.asEvent());

    // Dispatch focusin on new element (bubbles, composed)
    const focusin_event = try FocusEvent.initTrusted(comptime .wrap("focusin"), .{ .bubbles = true, .composed = true, .relatedTarget = old_related }, frame);
    try frame._event_manager.dispatch(new_target, focusin_event.asEvent());
}

pub fn blur(self: *Element, frame: *Frame) !void {
    if (frame.document._active_element != self) return;

    frame.document._active_element = null;

    const FocusEvent = @import("../webapi/event/FocusEvent.zig");
    const old_target = self.asEventTarget();

    // Dispatch blur (no bubble, composed)
    const blur_event = try FocusEvent.initTrusted(comptime .wrap("blur"), .{ .composed = true }, frame);
    try frame._event_manager.dispatch(old_target, blur_event.asEvent());

    // Dispatch focusout (bubbles, composed)
    const focusout_event = try FocusEvent.initTrusted(comptime .wrap("focusout"), .{ .bubbles = true, .composed = true }, frame);
    try frame._event_manager.dispatch(old_target, focusout_event.asEvent());
}

pub fn getChildren(self: *Element, frame: *Frame) !collections.NodeLive(.child_elements) {
    return collections.NodeLive(.child_elements).init(self.asNode(), {}, frame);
}

pub fn append(self: *Element, nodes: []const Node.NodeOrText, frame: *Frame) !void {
    const parent = self.asNode();
    for (nodes) |node_or_text| {
        const child = try node_or_text.toNode(frame);
        _ = try parent.appendChild(child, frame);
    }
}

pub fn prepend(self: *Element, nodes: []const Node.NodeOrText, frame: *Frame) !void {
    const parent = self.asNode();
    var i = nodes.len;
    while (i > 0) {
        i -= 1;
        const child = try nodes[i].toNode(frame);
        _ = try parent.insertBefore(child, parent.firstChild(), frame);
    }
}

pub fn before(self: *Element, nodes: []const Node.NodeOrText, frame: *Frame) !void {
    const node = self.asNode();
    const parent = node.parentNode() orelse return;

    for (nodes) |node_or_text| {
        const child = try node_or_text.toNode(frame);
        _ = try parent.insertBefore(child, node, frame);
    }
}

pub fn after(self: *Element, nodes: []const Node.NodeOrText, frame: *Frame) !void {
    const node = self.asNode();
    const parent = node.parentNode() orelse return;
    const viable_next = Node.NodeOrText.viableNextSibling(node, nodes);

    for (nodes) |node_or_text| {
        const child = try node_or_text.toNode(frame);
        _ = try parent.insertBefore(child, viable_next, frame);
    }
}

pub fn firstElementChild(self: *Element) ?*Element {
    var maybe_child = self.asNode().firstChild();
    while (maybe_child) |child| {
        if (child.is(Element)) |el| return el;
        maybe_child = child.nextSibling();
    }
    return null;
}

pub fn lastElementChild(self: *Element) ?*Element {
    var maybe_child = self.asNode().lastChild();
    while (maybe_child) |child| {
        if (child.is(Element)) |el| return el;
        maybe_child = child.previousSibling();
    }
    return null;
}

pub fn nextElementSibling(self: *Element) ?*Element {
    var maybe_sibling = self.asNode().nextSibling();
    while (maybe_sibling) |sibling| {
        if (sibling.is(Element)) |el| return el;
        maybe_sibling = sibling.nextSibling();
    }
    return null;
}

pub fn previousElementSibling(self: *Element) ?*Element {
    var maybe_sibling = self.asNode().previousSibling();
    while (maybe_sibling) |sibling| {
        if (sibling.is(Element)) |el| return el;
        maybe_sibling = sibling.previousSibling();
    }
    return null;
}

pub fn getChildElementCount(self: *Element) usize {
    var count: usize = 0;
    var it = self.asNode().childrenIterator();
    while (it.next()) |node| {
        if (node.is(Element) != null) {
            count += 1;
        }
    }
    return count;
}

pub fn matches(self: *Element, selector: []const u8, frame: *Frame) !bool {
    return Selector.matches(self, selector, frame);
}

pub fn querySelector(self: *Element, selector: []const u8, frame: *Frame) !?*Element {
    return Selector.querySelector(self.asNode(), selector, frame);
}

pub fn querySelectorAll(self: *Element, input: []const u8, frame: *Frame) !*Selector.List {
    return Selector.querySelectorAll(self.asNode(), input, frame);
}

pub fn getAnimations(_: *const Element) []*Animation {
    return &.{};
}

pub fn animate(_: *Element, _: ?js.Object, _: ?js.Object, frame: *Frame) !*Animation {
    return Animation.init(frame);
}

pub fn closest(self: *Element, selector: []const u8, frame: *Frame) !?*Element {
    if (selector.len == 0) {
        return error.SyntaxError;
    }

    var current: ?*Element = self;
    while (current) |el| {
        if (try Selector.matchesWithScope(el, selector, self, frame)) {
            return el;
        }

        const parent = el._proto._parent orelse break;

        if (parent.is(ShadowRoot) != null) {
            break;
        }

        current = parent.is(Element);
    }
    return null;
}

pub fn parentElement(self: *Element) ?*Element {
    return self._proto.parentElement();
}

/// Cache for visibility checks - re-exported from StyleManager for convenience.
pub const VisibilityCache = StyleManager.VisibilityCache;

/// Cache for pointer-events checks - re-exported from StyleManager for convenience.
pub const PointerEventsCache = StyleManager.PointerEventsCache;

pub fn hasPointerEventsNone(self: *Element, cache: ?*PointerEventsCache, frame: *Frame) bool {
    return frame._style_manager.hasPointerEventsNone(self, cache);
}

pub fn checkVisibilityCached(self: *Element, cache: ?*VisibilityCache, frame: *Frame) bool {
    return !frame._style_manager.isHidden(self, cache, .{});
}

/// Layout geometry (getClientRects / getBoundingClientRect) must include
/// `visibility:hidden` boxes; only `display:none` (and similar) zero them out.
fn layoutVisibilityCache(frame: *Frame) *StyleManager.VisibilityCache {
    return &frame._layout_visibility_cache;
}

fn withLayoutResolveActive(frame: *Frame, comptime func: anytype, args: anytype) @TypeOf(@call(.auto, func, args)) {
    frame.finishTopLevelLayoutResolve();
    frame._style_manager.prepareForLayout();
    frame.beginLayoutResolve();
    defer frame.finishTopLevelLayoutResolve();
    return @call(.auto, func, args);
}

fn isHiddenForLayout(self: *Element, frame: *Frame) bool {
    // Skip the visibility HashMap cache: SERP scripts call getBoundingClientRect
    // from V8 DefaultWorker threads while the parser mutates the tree on the
    // network thread; cache get/put then races and segfaults.
    return frame._style_manager.isHidden(self, null, .{
        .check_display = true,
        .check_visibility = false,
        .check_opacity = false,
    });
}

const CheckVisibilityOpts = struct {
    checkOpacity: bool = false,
    opacityProperty: bool = false,
    checkVisibilityCSS: bool = false,
    visibilityProperty: bool = false,
};
pub fn checkVisibility(self: *Element, opts_: ?CheckVisibilityOpts, frame: *Frame) bool {
    const opts = opts_ orelse CheckVisibilityOpts{};
    return !frame._style_manager.isHidden(self, null, .{
        .check_opacity = opts.checkOpacity or opts.opacityProperty,
        .check_visibility = opts.visibilityProperty or opts.checkVisibilityCSS,
    });
}

fn getLayoutPropertyValue(self: *Element, property_name: []const u8, frame: *Frame) ?[]const u8 {
    if (self.getStyle(frame)) |style| {
        const decl = style.asCSSStyleDeclaration();
        const value = decl.getPropertyValue(property_name, frame);
        if (value.len > 0) return value;
    }
    return frame._style_manager.getLayoutProperty(self, property_name);
}

fn parseRotateDegrees(transform: []const u8) ?f64 {
    const needle = "rotate(";
    const start = std.ascii.indexOfIgnoreCase(transform, needle) orelse return null;
    const rotate_args = transform[start + needle.len ..];
    var end: usize = 0;
    while (end < rotate_args.len and rotate_args[end] != ')') : (end += 1) {}
    if (end == 0) return null;
    const token = std.mem.trim(u8, rotate_args[0..end], &std.ascii.whitespace);
    if (std.mem.endsWith(u8, token, "deg")) {
        const num = std.mem.trim(u8, token[0 .. token.len - 3], &std.ascii.whitespace);
        return std.fmt.parseFloat(f64, num) catch null;
    }
    if (std.mem.endsWith(u8, token, "rad")) {
        const num = std.mem.trim(u8, token[0 .. token.len - 3], &std.ascii.whitespace);
        const rad = std.fmt.parseFloat(f64, num) catch return null;
        return rad * 180.0 / std.math.pi;
    }
    return std.fmt.parseFloat(f64, token) catch null;
}

fn dimensionsAfterTransform(width: f64, height: f64, transform: ?[]const u8) struct { width: f64, height: f64 } {
    const transform_text = transform orelse return .{ .width = width, .height = height };
    const degrees = parseRotateDegrees(transform_text) orelse return .{ .width = width, .height = height };
    if (degrees == 0.0) return .{ .width = width, .height = height };
    const rad = degrees * std.math.pi / 180.0;
    const cos_v = @abs(@cos(rad));
    const sin_v = @abs(@sin(rad));
    return .{
        .width = width * cos_v + height * sin_v,
        .height = width * sin_v + height * cos_v,
    };
}

fn parseTransformOrigin(self: *Element, frame: *Frame, width: f64, height: f64) struct { x: f64, y: f64 } {
    const raw = getLayoutPropertyValue(self, "transform-origin", frame) orelse return .{ .x = width * 0.5, .y = height * 0.5 };
    var parts: [2][]const u8 = .{ "50%", "50%" };
    var count: usize = 0;
    var iter = std.mem.splitScalar(u8, raw, ' ');
    while (iter.next()) |part| : (count += 1) {
        if (count < 2) parts[count] = std.mem.trim(u8, part, &std.ascii.whitespace);
    }
    const ox = parseLayoutDimension(parts[0], width) orelse width * 0.5;
    const oy = parseLayoutDimension(parts[1], height) orelse height * 0.5;
    return .{ .x = ox, .y = oy };
}

fn readBorderDimensions(self: *Element, frame: *Frame) struct { width: f64, height: f64 } {
    var width: f64 = layout_default_size;
    var height: f64 = layout_default_size;
    if (layoutDimensionFromProperty(self, frame, "width", .width)) |w| width = w;
    if (layoutDimensionFromProperty(self, frame, "height", .height)) |h| height = h;
    if (width == layout_default_size or height == layout_default_size) {
        const shallow = elementLayoutSizeShallow(self, frame);
        if (width == layout_default_size) width = shallow.width;
        if (height == layout_default_size) height = shallow.height;
    }
    return .{ .width = @max(width, 0), .height = @max(height, 0) };
}

fn applyRotateClientRect(
    rect: DOMRect,
    border_width: f64,
    border_height: f64,
    degrees: f64,
    origin_x: f64,
    origin_y: f64,
) DOMRect {
    const rad = degrees * std.math.pi / 180.0;
    const cos_v = @cos(rad);
    const sin_v = @sin(rad);
    const corners = [_]struct { x: f64, y: f64 }{
        .{ .x = 0, .y = 0 },
        .{ .x = border_width, .y = 0 },
        .{ .x = border_width, .y = border_height },
        .{ .x = 0, .y = border_height },
    };
    var min_x: f64 = std.math.inf(f64);
    var min_y: f64 = std.math.inf(f64);
    var max_x: f64 = -std.math.inf(f64);
    var max_y: f64 = -std.math.inf(f64);
    for (corners) |c| {
        const dx = c.x - origin_x;
        const dy = c.y - origin_y;
        const rx = origin_x + dx * cos_v - dy * sin_v;
        const ry = origin_y + dx * sin_v + dy * cos_v;
        min_x = @min(min_x, rx);
        min_y = @min(min_y, ry);
        max_x = @max(max_x, rx);
        max_y = @max(max_y, ry);
    }
    return .{
        ._x = rect._x + min_x,
        ._y = rect._y + min_y,
        ._width = max_x - min_x,
        ._height = max_y - min_y,
    };
}

/// Padding-edge origin of the offset parent (O(depth), no getBoundingClientRect recursion).
fn offsetParentClientOrigin(self: *Element, frame: *Frame, depth: usize) struct { x: f64, y: f64 } {
    if (depth > 32) return .{ .x = 0, .y = 0 };
    const parent = offsetParentElement(self, frame) orelse return .{ .x = 0, .y = 0 };

    const tag = parent.getTag();
    if (tag == .html or tag == .body) return .{ .x = 0, .y = 0 };

    const pos_kind = layoutPositionKind(parent, frame);
    if (pos_kind == .absolute or pos_kind == .fixed) {
        const grand = offsetParentClientOrigin(parent, frame, depth + 1);
        const pos = getPositionOffset(parent, frame);
        return .{ .x = grand.x + pos.left, .y = grand.y + pos.top };
    }

    const scroll_x = @as(f64, @floatFromInt(frame.window.getScrollX()));
    const scroll_y = @as(f64, @floatFromInt(frame.window.getScrollY()));
    const off = getLayoutOffset(parent, frame);
    const y = calculateDocumentPosition(parent.asNode(), frame) + off.top;
    return .{ .x = off.left - scroll_x, .y = y - scroll_y };
}

fn finalizeClientRect(self: *Element, frame: *Frame, rect: DOMRect) DOMRect {
    const snapped = rect.snap();
    const transform = getLayoutPropertyValue(self, "transform", frame);
    const degrees = parseRotateDegrees(transform orelse "") orelse return snapped;
    if (degrees == 0.0) return snapped;
    const border = readBorderDimensions(self, frame);
    const origin = parseTransformOrigin(self, frame, border.width, border.height);
    return applyRotateClientRect(snapped, border.width, border.height, degrees, origin.x, origin.y).snap();
}

const LayoutSize = struct { width: f64, height: f64 };
const LayoutOrigin = struct { top: f64, left: f64 };

/// Size `html`/`body` in child browsing contexts to the hosting `<iframe>`.
/// Uses attribute/stylesheet dimensions only — never `getBoundingClientRect`,
/// which would re-enter layout while child root size is still resolving.
fn hostingIframeClientSize(frame: *Frame) ?LayoutSize {
    if (frame._hosting_iframe_layout_size) |cached| {
        return .{ .width = cached.width, .height = cached.height };
    }

    const parent = frame.parent orelse return null;
    const root = parent.document.asNode();
    var stack: std.ArrayList(*Node) = .empty;
    stack.append(frame.call_arena, root) catch return null;

    while (stack.items.len > 0) {
        const node = stack.pop() orelse break;
        if (node.is(IFrame)) |iframe| {
            if (iframe._window) |window| {
                if (window._frame == frame) {
                    const dims = iframe.asElement().getElementDimensions(parent);
                    if (dims.width > 0 and dims.height > 0) {
                        frame._hosting_iframe_layout_size = .{
                            .width = dims.width,
                            .height = dims.height,
                        };
                        return .{ .width = dims.width, .height = dims.height };
                    }
                }
            }
        }

        if (node.is(Element)) |element| {
            if (frame._element_shadow_roots.get(element)) |shadow_root| {
                var shadow_child = shadow_root.asNode().lastChild();
                while (shadow_child) |c| {
                    stack.append(frame.call_arena, c) catch {};
                    shadow_child = c.previousSibling();
                }
            }
        }

        var child = node.lastChild();
        while (child) |c| {
            stack.append(frame.call_arena, c) catch {};
            child = c.previousSibling();
        }
    }
    return null;
}

const LayoutPositionKind = enum { static, relative, absolute, fixed };

fn layoutPositionKind(self: *Element, frame: *Frame) LayoutPositionKind {
    if (readLayoutPropertyRaw(self, frame, "position")) |pos| {
        if (std.ascii.eqlIgnoreCase(pos, "absolute")) return .absolute;
        if (std.ascii.eqlIgnoreCase(pos, "fixed")) return .fixed;
        if (std.ascii.eqlIgnoreCase(pos, "relative")) return .relative;
    }
    return .static;
}

fn isPositionedAncestor(self: *Element, frame: *Frame) bool {
    return layoutPositionKind(self, frame) != .static;
}

fn offsetParentElement(self: *Element, frame: *Frame) ?*Element {
    var current = self.asNode().parentElement();
    while (current) |el| {
        if (isPositionedAncestor(el, frame)) return el;
        if (el.getTag() == .body) return el;
        current = el.asNode().parentElement();
    }
    return null;
}

fn rootLayoutSize(frame: *Frame) LayoutSize {
    const profile = frame.identityProfile();
    return .{
        .width = @floatFromInt(profile.window.inner_width),
        .height = @floatFromInt(profile.window.inner_height),
    };
}

const layout_default_size: f64 = 5.0;
const layout_leaf_block_height: f64 = 20.0;
// CSS 2.1 / CSS Images default object size for replaced elements (img, iframe,
// object, embed, video, …) when no concrete CSS, attribute, or intrinsic size
// is available: 300×150. Using the internal 5px layout sentinel left unsized
// images and challenge iframes collapsed (getBoundingClientRect 5×5), so SPA
// image loaders (IntersectionObserver / container queries / responsive src
// pickers) never committed real `src` URLs.
const replaced_default_width: f64 = 300.0;
const replaced_default_height: f64 = 150.0;
// Back-compat aliases (iframe fixtures / comments).
const iframe_default_width: f64 = replaced_default_width;
const iframe_default_height: f64 = replaced_default_height;

fn isInlineLevelDisplay(display: []const u8) bool {
    if (std.ascii.eqlIgnoreCase(display, "inline")) return true;
    if (std.mem.indexOf(u8, display, "inline-") != null) return true;
    return false;
}

fn isBlockLevel(self: *Element, frame: *Frame) bool {
    if (readLayoutPropertyRaw(self, frame, "display")) |display| {
        if (std.ascii.eqlIgnoreCase(display, "none")) return false;
        if (std.ascii.eqlIgnoreCase(display, "contents")) return false;
        if (isInlineLevelDisplay(display)) return false;
        return true;
    }
    const tag = self.getTag();
    if (tag == .body or tag == .html or tag == .form or tag == .li or tag == .dd or tag == .dt or tag == .dialog) {
        return true;
    }
    return tag.isBlock();
}

fn childrenBlockFlowHeight(self: *Element, frame: *Frame, depth: usize) f64 {
    if (depth > 64) return layout_leaf_block_height;
    const parent = self.asNode();
    const limit: u32 = if (parent._children) |children| children.len() else 0;
    var total: f64 = 0;
    var has_child = false;
    var child = parent.firstChild();
    var visited: u32 = 0;
    while (child) |c| {
        visited += 1;
        if (visited > limit) break;
        if (c.is(Element)) |el| {
            if (el.getTag().isMetadata()) continue;
            if (el.isHiddenForLayout(frame)) continue;
            has_child = true;
            const dims = resolveElementDimensions(el, frame, depth + 1);
            total += dims.height;
        }
        child = c.nextSibling();
    }
    if (!has_child) return layout_leaf_block_height;
    return @max(total, layout_leaf_block_height);
}

fn layoutCacheKey(self: *const Element) usize {
    return @intFromPtr(self);
}

fn readLayoutCache(self: *Element, frame: *Frame) ?LayoutSize {
    if (frame._layout_cache_dom_version != frame.version) return null;
    const cached = frame._element_layout_cache.get(layoutCacheKey(self)) orelse return null;
    if (cached.version != frame.version) return null;
    return .{ .width = cached.width, .height = cached.height };
}

fn writeLayoutCache(self: *Element, frame: *Frame, size: LayoutSize) void {
    if (frame._layout_cache_dom_version != frame.version) {
        frame._layout_cache_dom_version = frame.version;
    }
    const gop = frame._element_layout_cache.getOrPut(frame.arena, layoutCacheKey(self)) catch return;
    gop.value_ptr.* = .{
        .width = size.width,
        .height = size.height,
        .version = frame.version,
    };
}

fn estimateHeightFromFontSize(self: *Element, frame: *Frame) ?f64 {
    if (readLayoutPropertyRaw(self, frame, "font-size")) |raw| {
        const parent_size = parentLayoutSize(self, frame);
        if (parseLayoutDimension(raw, parent_size.height)) |parsed| return parsed;
    }
    return null;
}

/// Estimate intrinsic size of an inline element from its text content + font.
/// Used by FingerprintJS `fonts` (offsetWidth) and `fontPreferences` (getBoundingClientRect).
fn estimateInlineTextSize(self: *Element, frame: *Frame) ?LayoutSize {
    const text = self.asNode().getTextContentAlloc(frame.call_arena) catch return null;
    if (text.len == 0) return null;

    const font_size = blk: {
        if (estimateHeightFromFontSize(self, frame)) |fs| break :blk fs;
        // CSS `font` shorthand may set size without separate font-size longhand.
        if (readLayoutPropertyRaw(self, frame, "font")) |font_sh| {
            if (parseFontSizeFromShorthand(font_sh)) |fs| break :blk fs;
        }
        break :blk 16.0;
    };
    const family = resolveLayoutFontFamily(self, frame);
    const width = TextMetrics.estimateLayoutTextWidth(text, family, font_size, frame.identityProfile());
    // Line-box height ~ 1.2× font-size for typical UA metrics.
    const height = @max(font_size * 1.2, layout_default_size);
    return .{ .width = @max(width, 1.0), .height = height };
}

/// font-family longhand, else last token of `font` shorthand (e.g. `-apple-system-body`).
fn resolveLayoutFontFamily(self: *Element, frame: *Frame) []const u8 {
    if (readLayoutPropertyRaw(self, frame, "font-family")) |fam| {
        if (fam.len > 0) return fam;
    }
    if (readLayoutPropertyRaw(self, frame, "font")) |font_sh| {
        // Take last comma-separated family token from shorthand.
        if (std.mem.lastIndexOfScalar(u8, font_sh, ',')) |comma| {
            return std.mem.trim(u8, font_sh[comma + 1 ..], &std.ascii.whitespace);
        }
        // Single-token special fonts: `-apple-system-body`, `caption`, …
        var last_space: ?usize = null;
        for (font_sh, 0..) |c, i| {
            if (c == ' ') last_space = i;
        }
        if (last_space) |sp| {
            const tail = std.mem.trim(u8, font_sh[sp + 1 ..], &std.ascii.whitespace);
            if (tail.len > 0 and (tail[0] < '0' or tail[0] > '9')) return tail;
        }
        return std.mem.trim(u8, font_sh, &std.ascii.whitespace);
    }
    return "sans-serif";
}

fn parseFontSizeFromShorthand(font: []const u8) ?f64 {
    var i: usize = 0;
    while (i < font.len) : (i += 1) {
        if (font[i] >= '0' and font[i] <= '9') {
            var end = i + 1;
            var has_dot = false;
            while (end < font.len) : (end += 1) {
                if (font[end] >= '0' and font[end] <= '9') continue;
                if (font[end] == '.' and !has_dot) {
                    has_dot = true;
                    continue;
                }
                break;
            }
            const num = std.fmt.parseFloat(f64, font[i..end]) catch return null;
            if (end < font.len and (font[end] == 'p' or font[end] == 'P')) return num;
            // unitless in shorthand is still treated as px by layout heuristics
            return num;
        }
    }
    return null;
}

fn resolveElementDimensions(self: *Element, frame: *Frame, depth: usize) LayoutSize {
    if (depth > 64) return .{ .width = layout_default_size, .height = layout_default_size };

    if (readLayoutCache(self, frame)) |cached| return cached;

    frame.beginLayoutResolve();
    defer frame.endLayoutResolve();

    const parent_size = parentLayoutSize(self, frame);
    var width: f64 = layout_default_size;
    var height: f64 = layout_default_size;

    if (layoutDimensionFromProperty(self, frame, "width", .width)) |w| width = w;
    if (layoutDimensionFromProperty(self, frame, "height", .height)) |h| height = h;
    if (width == layout_default_size) {
        if (autoFlexItemWidth(self, frame, parent_size)) |item_width| width = item_width;
    }

    const tag = self.getTag();
    if (tag == .html or tag == .body) {
        const root = rootLayoutSize(frame);
        if (width == layout_default_size) width = root.width;
        if (height == layout_default_size) {
            height = if (tag == .body) @max(root.height * 8.0, 800.0) else root.height;
        }
    } else if (tag == .img or tag == .iframe or tag == .video or tag == .embed or tag == .object) {
        if (width == layout_default_size) {
            if (self.getAttributeSafe(comptime .wrap("width"))) |w| {
                width = std.fmt.parseFloat(f64, w) catch width;
            }
        }
        if (height == layout_default_size) {
            if (self.getAttributeSafe(comptime .wrap("height"))) |h| {
                height = std.fmt.parseFloat(f64, h) catch height;
            }
        }
        // Loaded intrinsic (or 300×150 post-load fallback) before CSS default object size.
        if (tag == .img) {
            if (self.is(Element.Html.Image)) |image| {
                if (width == layout_default_size and image._natural_width > 0) {
                    width = @floatFromInt(image._natural_width);
                }
                if (height == layout_default_size and image._natural_height > 0) {
                    height = @floatFromInt(image._natural_height);
                }
            }
        }
        // Cover the media containing block for hero/card layers:
        // Nike-style trees are media[--padding-top] > wrapper > div[100%] > img,
        // so the immediate parent is often only 100%-of-empty (height ~20). Walk
        // ancestors for an aspect-ratio / --padding-top box before giving up.
        // Do not blindly fill any wide parent — that made every thumb viewport-sized.
        if (tag == .img) {
            if (mediaContainingBlockSize(self, frame)) |box| {
                width = box.width;
                height = box.height;
            } else {
                const pos_kind = layoutPositionKind(self, frame);
                const pct_fill = widthLooksLikePercentFill(self, frame) or heightLooksLikePercentFill(self, frame);
                if (pos_kind == .absolute or pos_kind == .fixed or pct_fill) {
                    if (parent_size.width > layout_default_size) width = parent_size.width;
                    if (parent_size.height > replaced_default_height) {
                        height = parent_size.height;
                    } else if (width > replaced_default_width) {
                        height = @max(width * 0.5, replaced_default_height);
                    }
                }
            }
        }
        // Default object size when still unresolved (attr/CSS/intrinsic missing).
        if (width == layout_default_size) width = replaced_default_width;
        if (height == layout_default_size) height = replaced_default_height;
        // Honor max-width / max-height so percentage widths and defaults do not
        // blow past the containing block (common with width:100% + max-width:100%).
        if (layoutDimensionFromProperty(self, frame, "max-width", .width)) |mw| {
            if (mw > 0 and width > mw) {
                if (height > 0 and width > 0) height = height * (mw / width);
                width = mw;
            }
        }
        if (layoutDimensionFromProperty(self, frame, "max-height", .height)) |mh| {
            if (mh > 0 and height > mh) {
                if (width > 0 and height > 0) width = width * (mh / height);
                height = mh;
            }
        }
    } else if (tag == .svg) {
        if (width == layout_default_size) {
            if (self.getAttributeSafe(comptime .wrap("width"))) |w| {
                if (parseLayoutDimension(w, parent_size.width)) |parsed| width = parsed;
            }
        }
        if (height == layout_default_size) {
            if (self.getAttributeSafe(comptime .wrap("height"))) |h| {
                if (parseLayoutDimension(h, parent_size.height)) |parsed| height = parsed;
            }
        }
    } else if (isBlockLevel(self, frame)) {
        if (width == layout_default_size) width = parent_size.width;
        // Aspect-ratio / padding-top media boxes (heroes, cards): height comes
        // from width × ratio, not empty children (which would stay ~20px).
        if (height == layout_default_size) {
            if (aspectRatioBoxHeight(self, frame, width)) |ah| {
                height = ah;
            } else {
                const child_height = childrenBlockFlowHeight(self, frame, depth);
                height = if (child_height > layout_leaf_block_height)
                    child_height
                else
                    estimateHeightFromFontSize(self, frame) orelse child_height;
            }
        }
    } else if (tag == .input or tag == .button or tag == .select or tag == .textarea) {
        // Replaced form controls: without CSS, layout_default_size (5px) collapses
        // Fluent/signup controls so pointer hit-tests land on footer/siblings.
        // UA-ish defaults; explicit width/height CSS still win above.
        if (width == layout_default_size) {
            width = switch (tag) {
                .textarea => 300.0,
                .button => if (estimateInlineTextSize(self, frame)) |ts| @max(ts.width + 24.0, 64.0) else 80.0,
                else => 200.0, // input / select
            };
        }
        if (height == layout_default_size) {
            height = switch (tag) {
                .textarea => 60.0,
                else => 32.0,
            };
        }
    } else if (width == layout_default_size or height == layout_default_size) {
        // Inline / span text sizing — Fingerprint Pro / BotD font probes compare
        // offsetWidth across font-family fallbacks. A constant 5px width makes
        // every font look identical → fonts:[] + font_hash empty + high tamper.
        if (estimateInlineTextSize(self, frame)) |text_size| {
            if (width == layout_default_size) width = text_size.width;
            if (height == layout_default_size) height = text_size.height;
        }
    }

    const transform = getLayoutPropertyValue(self, "transform", frame);
    const transformed = dimensionsAfterTransform(width, height, transform);
    const result: LayoutSize = .{
        .width = @min(@max(transformed.width, 0), max_layout_dimension),
        .height = @min(@max(transformed.height, 0), max_layout_dimension),
    };
    writeLayoutCache(self, frame, result);
    return result;
}

fn rootLayoutSizeForHitTest(frame: *Frame) LayoutSize {
    if (hostingIframeClientSize(frame)) |iframe_size| return iframe_size;
    return rootLayoutSize(frame);
}

fn parentLayoutSizeForHitTest(self: *Element, frame: *Frame) LayoutSize {
    const parent = self.asNode().parentElement() orelse return rootLayoutSizeForHitTest(frame);
    return elementLayoutSizeShallowForHitTest(parent, frame);
}

fn elementLayoutSizeShallowForHitTest(self: *Element, frame: *Frame) LayoutSize {
    const parent_size = parentLayoutSizeForHitTest(self, frame);
    var width: f64 = layout_default_size;
    var height: f64 = layout_default_size;

    if (readLayoutPropertyRaw(self, frame, "width")) |raw| {
        if (parseLayoutDimension(raw, parent_size.width)) |w| width = w;
    }
    if (readLayoutPropertyRaw(self, frame, "height")) |raw| {
        if (parseLayoutDimension(raw, parent_size.height)) |h| height = h;
    }

    const tag = self.getTag();
    if (tag == .html or tag == .body) {
        const root = rootLayoutSizeForHitTest(frame);
        if (width == layout_default_size) width = root.width;
        if (height == layout_default_size) {
            height = if (tag == .body) @max(root.height * 8.0, 800.0) else root.height;
        }
    } else if (tag == .img or tag == .iframe or tag == .video or tag == .embed or tag == .object) {
        if (width == layout_default_size) {
            if (self.getAttributeSafe(comptime .wrap("width"))) |w| {
                width = std.fmt.parseFloat(f64, w) catch width;
            }
        }
        if (height == layout_default_size) {
            if (self.getAttributeSafe(comptime .wrap("height"))) |h| {
                height = std.fmt.parseFloat(f64, h) catch height;
            }
        }
        if (width == layout_default_size) width = replaced_default_width;
        if (height == layout_default_size) height = replaced_default_height;
    } else if (isBlockLevel(self, frame)) {
        if (width == layout_default_size) width = parent_size.width;
        if (height == layout_default_size) {
            if (aspectRatioBoxHeight(self, frame, width)) |ah| {
                height = ah;
            } else {
                height = layout_leaf_block_height;
            }
        }
    }

    return .{ .width = @max(width, 0), .height = @max(height, 0) };
}

fn getElementDimensionsForHitTest(self: *Element, frame: *Frame) struct { width: f64, height: f64 } {
    const dims = resolveElementDimensions(self, frame, 0);
    return .{ .width = dims.width, .height = dims.height };
}

fn getMarginInsetForHitTest(self: *Element, frame: *Frame) struct { top: f64, left: f64 } {
    var top: f64 = 0;
    var left: f64 = 0;
    const parent_size = parentLayoutSizeForHitTest(self, frame);
    if (getLayoutPropertyValue(self, "margin-top", frame)) |v| {
        if (parseLayoutDimension(v, parent_size.height)) |parsed| top = parsed;
    }
    if (getLayoutPropertyValue(self, "margin-left", frame)) |v| {
        if (parseLayoutDimension(v, parent_size.width)) |parsed| left = parsed;
    }
    return .{ .top = top, .left = left };
}

fn getPositionOffsetForHitTest(self: *Element, frame: *Frame) struct { top: f64, left: f64 } {
    var top: f64 = 0;
    var left: f64 = 0;
    const parent_size = parentLayoutSizeForHitTest(self, frame);
    if (getLayoutPropertyValue(self, "top", frame)) |v| {
        if (parseLayoutDimension(v, parent_size.height)) |parsed| top = parsed;
    }
    if (getLayoutPropertyValue(self, "left", frame)) |v| {
        if (parseLayoutDimension(v, parent_size.width)) |parsed| left = parsed;
    }
    return .{ .top = top, .left = left };
}

fn flowOffsetAmongSiblingsForHitTest(self: *Element, frame: *Frame) struct { top: f64, left: f64 } {
    const parent_node = self.asNode().parentNode() orelse return .{ .top = 0, .left = 0 };
    const parent_el = parent_node.is(Element) orelse return .{ .top = 0, .left = 0 };
    const horizontal = parentUsesHorizontalFlow(parent_el, frame);

    var top: f64 = 0;
    var left: f64 = 0;

    // Cap sibling walk: Fluent trees can have hundreds of prior siblings; each
    // visibility + dimension resolve was O(n) and blocked CDP activation.
    var walked: usize = 0;
    const max_siblings: usize = 48;

    var sibling = parent_node.firstChild();
    while (sibling) |s| {
        if (s == self.asNode()) break;
        if (s.is(Element)) |sib| {
            walked += 1;
            if (walked > max_siblings) break;
            // Cheap display:none skip — avoid full StyleManager HashMap walks.
            if (sib.isHiddenForLayout(frame)) {
                sibling = s.nextSibling();
                continue;
            }
            const dims = sib.getElementDimensionsForHitTest(frame);
            const margin = getMarginInsetForHitTest(sib, frame);
            if (horizontal) {
                left += dims.width + margin.left;
            } else {
                top += dims.height + margin.top;
            }
        }
        sibling = s.nextSibling();
    }

    return .{ .top = top, .left = left };
}

fn computeLayoutOriginForHitTest(self: *Element, frame: *Frame) LayoutOrigin {
    return computeLayoutOriginForHitTestDepth(self, frame, 0);
}

fn computeLayoutOriginForHitTestDepth(self: *Element, frame: *Frame, depth: usize) LayoutOrigin {
    if (depth > 64) return .{ .top = 0, .left = 0 };
    if (self.getTag() == .html) return .{ .top = 0, .left = 0 };

    const pos_kind = layoutPositionKind(self, frame);
    if (pos_kind == .absolute or pos_kind == .fixed) {
        const container = offsetParentElement(self, frame) orelse self.asNode().parentElement() orelse {
            const margin = getMarginInsetForHitTest(self, frame);
            const pos = getPositionOffsetForHitTest(self, frame);
            return .{ .top = margin.top + pos.top, .left = margin.left + pos.left };
        };
        const base = computeLayoutOriginForHitTestDepth(container, frame, depth + 1);
        const pos = getPositionOffsetForHitTest(self, frame);
        return .{ .top = base.top + pos.top, .left = base.left + pos.left };
    }

    const parent = self.asNode().parentElement() orelse {
        if (shadowTreeHost(self.asNode()) != null) return .{ .top = 0, .left = 0 };
        const margin = getMarginInsetForHitTest(self, frame);
        return .{ .top = margin.top, .left = margin.left };
    };

    const base = computeLayoutOriginForHitTestDepth(parent, frame, depth + 1);
    const flow = flowOffsetAmongSiblingsForHitTest(self, frame);
    const margin = getMarginInsetForHitTest(self, frame);
    return .{
        .top = base.top + flow.top + margin.top,
        .left = base.left + flow.left + margin.left,
    };
}

/// Absolute/fixed geometry: offset-parent origin + top/left (O(depth), no sibling walk).
fn getPositionedBoundingClientRect(self: *Element, frame: *Frame) DOMRect {
    if (self.isHiddenForLayout(frame)) {
        return .{ ._x = 0, ._y = 0, ._width = 0, ._height = 0 };
    }

    const dims = self.getElementDimensions(frame);
    if (dims.width == 0.0 and dims.height == 0.0) {
        return .{ ._x = 0, ._y = 0, ._width = 0, ._height = 0 };
    }

    const pos = getPositionOffset(self, frame);
    const origin = offsetParentClientOrigin(self, frame, 0);

    if (shadowTreeHost(self.asNode())) |host| {
        const host_rect = host.getBoundingClientRectForVisible(frame);
        return finalizeClientRect(self, frame, .{
            ._x = host_rect._x + pos.left,
            ._y = host_rect._y + pos.top,
            ._width = dims.width,
            ._height = dims.height,
        });
    }

    return finalizeClientRect(self, frame, .{
        ._x = origin.x + pos.left,
        ._y = origin.y + pos.top,
        ._width = dims.width,
        ._height = dims.height,
    });
}

/// Flow-based geometry for synthetic pointer activation only. Page script keeps
/// the legacy tree-position `getBoundingClientRect` (Turnstile / reCAPTCHA).
pub fn getActivationBoundingClientRect(self: *Element, frame: *Frame) DOMRect {
    if (!self.checkVisibilityCached(null, frame)) {
        return .{ ._x = 0, ._y = 0, ._width = 0, ._height = 0 };
    }

    const dims = self.getElementDimensionsForHitTest(frame);
    if (dims.width == 0.0 and dims.height == 0.0) {
        return .{ ._x = 0, ._y = 0, ._width = 0, ._height = 0 };
    }

    const scroll_x = @as(f64, @floatFromInt(frame.window.getScrollX()));
    const scroll_y = @as(f64, @floatFromInt(frame.window.getScrollY()));
    const local = computeLayoutOriginForHitTest(self, frame);

    if (shadowTreeHost(self.asNode())) |host| {
        const host_rect = host.getActivationBoundingClientRect(frame);
        return .{
            ._x = host_rect._x + local.left,
            ._y = host_rect._y + local.top,
            ._width = dims.width,
            ._height = dims.height,
        };
    }

    return .{
        ._x = local.left - scroll_x,
        ._y = local.top - scroll_y,
        ._width = dims.width,
        ._height = dims.height,
    };
}

fn parentLayoutSize(self: *Element, frame: *Frame) LayoutSize {
    const parent = self.asNode().parentElement() orelse return rootLayoutSize(frame);
    return elementLayoutSizeShallow(parent, frame);
}

fn autoFlexItemWidth(self: *Element, frame: *Frame, parent_size: LayoutSize) ?f64 {
    if (readLayoutPropertyRaw(self, frame, "width") != null) return null;
    const parent = self.asNode().parentElement() orelse return null;
    if (!parentUsesHorizontalFlow(parent, frame)) return null;

    const parent_node = parent.asNode();
    const limit: u32 = if (parent_node._children) |children| children.len() else 0;
    var count: usize = 0;
    var visited: u32 = 0;
    var child = parent_node.firstChild();
    while (child) |node| {
        visited += 1;
        if (visited > limit) break;
        if (node.is(Element) != null) count += 1;
        child = node.nextSibling();
    }
    if (count <= 1 or parent_size.width <= layout_default_size) return null;
    return parent_size.width / @as(f64, @floatFromInt(count));
}

fn readLayoutPropertyRaw(self: *Element, frame: *Frame, property_name: []const u8) ?[]const u8 {
    if (self.getStyle(frame)) |style| {
        const value = style.asCSSStyleDeclaration().getPropertyValue(property_name, frame);
        if (value.len > 0) return value;
    }
    return frame._style_manager.getLayoutProperty(self, property_name);
}

fn parseLayoutDimension(value: []const u8, parent_size: f64) ?f64 {
    const trimmed = std.mem.trim(u8, value, &std.ascii.whitespace);
    if (trimmed.len == 0) return null;
    if (std.mem.endsWith(u8, trimmed, "%")) {
        const num = std.fmt.parseFloat(f64, trimmed[0 .. trimmed.len - 1]) catch return null;
        return parent_size * num / 100.0;
    }
    return CSS.parseDimension(trimmed);
}

fn widthLooksLikePercentFill(self: *Element, frame: *Frame) bool {
    const raw = readLayoutPropertyRaw(self, frame, "width") orelse return false;
    const trimmed = std.mem.trim(u8, raw, &std.ascii.whitespace);
    if (std.mem.eql(u8, trimmed, "100%")) return true;
    if (std.mem.endsWith(u8, trimmed, "%")) {
        const num = std.fmt.parseFloat(f64, trimmed[0 .. trimmed.len - 1]) catch return false;
        return num >= 95.0;
    }
    return false;
}

fn heightLooksLikePercentFill(self: *Element, frame: *Frame) bool {
    const raw = readLayoutPropertyRaw(self, frame, "height") orelse return false;
    const trimmed = std.mem.trim(u8, raw, &std.ascii.whitespace);
    if (std.mem.eql(u8, trimmed, "100%")) return true;
    if (std.mem.endsWith(u8, trimmed, "%")) {
        const num = std.fmt.parseFloat(f64, trimmed[0 .. trimmed.len - 1]) catch return false;
        return num >= 95.0;
    }
    return false;
}

/// Parse a CSS custom property value from an element's style attribute, e.g.
/// `--padding-top: 105.1%` or `--aspect-ratio: 0.95`.
fn inlineCssVar(self: *const Element, name: []const u8) ?[]const u8 {
    const style = self.getAttributeSafe(comptime .wrap("style")) orelse return null;
    var search_buf: [64]u8 = undefined;
    if (name.len + 1 > search_buf.len) return null;
    @memcpy(search_buf[0..name.len], name);
    // Match `name:` after optional whitespace.
    var i: usize = 0;
    while (i + name.len < style.len) : (i += 1) {
        if (!std.mem.startsWith(u8, style[i..], name)) continue;
        var j = i + name.len;
        while (j < style.len and std.ascii.isWhitespace(style[j])) : (j += 1) {}
        if (j >= style.len or style[j] != ':') continue;
        j += 1;
        while (j < style.len and std.ascii.isWhitespace(style[j])) : (j += 1) {}
        const start = j;
        while (j < style.len and style[j] != ';' and style[j] != '!') : (j += 1) {}
        const val = std.mem.trim(u8, style[start..j], &std.ascii.whitespace);
        if (val.len > 0) return val;
    }
    return null;
}

/// Cap aspect-box height so a bad % (or page-tall ancestor) cannot produce
/// multi-thousand-px images that push the rest of the page off-screen.
const media_box_max_height_factor: f64 = 2.5;

fn finitePositive(n: f64) bool {
    return n > 0 and !std.math.isNan(n) and !std.math.isInf(n);
}

/// Height of a classic aspect-ratio media box:
/// padding-top %, CSS aspect-ratio, or inline `--padding-top` / `--aspect-ratio`.
fn aspectRatioBoxHeight(self: *Element, frame: *Frame, width: f64) ?f64 {
    if (!finitePositive(width)) return null;

    if (readLayoutPropertyRaw(self, frame, "padding-top")) |pt| {
        if (percentPaddingHeight(pt, width)) |h| return h;
    }
    if (inlineCssVar(self, "--padding-top")) |pt| {
        if (percentPaddingHeight(pt, width)) |h| return h;
    }
    if (readLayoutPropertyRaw(self, frame, "aspect-ratio")) |ar| {
        if (parseAspectRatio(ar)) |ratio| {
            if (finitePositive(ratio)) {
                const h = width / ratio;
                if (finitePositive(h)) return @min(h, width * media_box_max_height_factor);
            }
        }
    }
    if (inlineCssVar(self, "--aspect-ratio")) |ar| {
        if (parseAspectRatio(ar)) |ratio| {
            if (finitePositive(ratio)) {
                const h = width / ratio;
                if (finitePositive(h)) return @min(h, width * media_box_max_height_factor);
            }
        }
    }
    return null;
}

fn percentPaddingHeight(raw: []const u8, width: f64) ?f64 {
    const trimmed = std.mem.trim(u8, raw, &std.ascii.whitespace);
    if (!std.mem.endsWith(u8, trimmed, "%")) return null;
    const num = std.fmt.parseFloat(f64, trimmed[0 .. trimmed.len - 1]) catch return null;
    // Reject NaN%/0%/absurd ratios (SPA sometimes writes --padding-top: NaN%).
    if (!finitePositive(num) or num < 5.0 or num > 250.0) return null;
    const h = width * num / 100.0;
    if (!finitePositive(h)) return null;
    return @min(h, width * media_box_max_height_factor);
}

fn parseAspectRatio(raw: []const u8) ?f64 {
    const trimmed = std.mem.trim(u8, raw, &std.ascii.whitespace);
    if (trimmed.len == 0) return null;
    // SPA bugs write "NaN" into custom props — never treat as a ratio.
    if (std.ascii.eqlIgnoreCase(trimmed, "nan")) return null;
    if (std.mem.indexOfScalar(u8, trimmed, '/')) |slash| {
        const a = std.fmt.parseFloat(f64, std.mem.trim(u8, trimmed[0..slash], &std.ascii.whitespace)) catch return null;
        const b = std.fmt.parseFloat(f64, std.mem.trim(u8, trimmed[slash + 1 ..], &std.ascii.whitespace)) catch return null;
        if (!finitePositive(a) or !finitePositive(b)) return null;
        return a / b;
    }
    const n = std.fmt.parseFloat(f64, trimmed) catch return null;
    if (!finitePositive(n)) return null;
    return n;
}

/// Walk ancestors for a *real* padding-top / aspect-ratio media frame only.
/// Nested 100%-height wrappers sit under these boxes; we must NOT accept a
/// merely large ancestor (e.g. full page column) or thumbs become 1280×5000+.
fn mediaContainingBlockSize(self: *Element, frame: *Frame) ?LayoutSize {
    var current: ?*Element = self.asNode().parentElement();
    var guard: u8 = 0;
    while (current) |el| : (guard += 1) {
        if (guard > 12) break;
        // Only nodes that declare an aspect/padding ratio qualify.
        const has_ratio_hint = inlineCssVar(el, "--padding-top") != null or
            inlineCssVar(el, "--aspect-ratio") != null or
            readLayoutPropertyRaw(el, frame, "aspect-ratio") != null or
            blk: {
                if (readLayoutPropertyRaw(el, frame, "padding-top")) |pt| {
                    break :blk std.mem.endsWith(u8, std.mem.trim(u8, pt, &std.ascii.whitespace), "%");
                }
                break :blk false;
            };
        if (!has_ratio_hint) {
            current = el.asNode().parentElement();
            continue;
        }

        var size = elementLayoutSizeShallow(el, frame);
        if (size.width <= layout_default_size and isBlockLevel(el, frame)) {
            size.width = parentLayoutSize(el, frame).width;
        }
        if (size.width <= replaced_default_width) {
            current = el.asNode().parentElement();
            continue;
        }
        if (aspectRatioBoxHeight(el, frame, size.width)) |ah| {
            return .{ .width = size.width, .height = ah };
        }
        current = el.asNode().parentElement();
    }
    return null;
}

fn getMarginInset(self: *Element, frame: *Frame) struct { top: f64, left: f64 } {
    var top: f64 = 0;
    var left: f64 = 0;
    const parent_size = parentLayoutSize(self, frame);
    if (getLayoutPropertyValue(self, "margin-top", frame)) |v| {
        if (parseLayoutDimension(v, parent_size.height)) |parsed| top = parsed;
    }
    if (getLayoutPropertyValue(self, "margin-left", frame)) |v| {
        if (parseLayoutDimension(v, parent_size.width)) |parsed| left = parsed;
    }
    return .{ .top = top, .left = left };
}

fn getPositionOffset(self: *Element, frame: *Frame) struct { top: f64, left: f64 } {
    var top: f64 = 0;
    var left: f64 = 0;
    const parent_size = parentLayoutSize(self, frame);
    if (getLayoutPropertyValue(self, "top", frame)) |v| {
        if (parseLayoutDimension(v, parent_size.height)) |parsed| top = parsed;
    }
    if (getLayoutPropertyValue(self, "left", frame)) |v| {
        if (parseLayoutDimension(v, parent_size.width)) |parsed| left = parsed;
    }
    return .{ .top = top, .left = left };
}

fn getLayoutOffset(self: *Element, frame: *Frame) struct { top: f64, left: f64 } {
    const margin = getMarginInset(self, frame);
    const pos = getPositionOffset(self, frame);
    return .{ .top = margin.top + pos.top, .left = margin.left + pos.left };
}

fn parentUsesHorizontalFlow(parent: *Element, frame: *Frame) bool {
    if (readLayoutPropertyRaw(parent, frame, "display")) |display| {
        if (std.mem.indexOf(u8, display, "flex") != null) {
            if (readLayoutPropertyRaw(parent, frame, "flex-direction")) |dir| {
                return std.mem.startsWith(u8, dir, "row");
            }
            return true;
        }
        if (std.ascii.eqlIgnoreCase(display, "inline") or
            std.ascii.eqlIgnoreCase(display, "inline-block"))
        {
            return true;
        }
    }
    return false;
}

/// Resolve width/height for one element without recursing through
/// `getElementDimensions` (prevents parent/child layout cycles).
fn elementLayoutSizeShallow(self: *Element, frame: *Frame) LayoutSize {
    const parent_size = parentLayoutSize(self, frame);
    var width: f64 = layout_default_size;
    var height: f64 = layout_default_size;

    if (readLayoutPropertyRaw(self, frame, "width")) |raw| {
        if (parseLayoutDimension(raw, parent_size.width)) |w| width = w;
    }
    if (readLayoutPropertyRaw(self, frame, "height")) |raw| {
        if (parseLayoutDimension(raw, parent_size.height)) |h| height = h;
    }
    if (width == layout_default_size) {
        if (autoFlexItemWidth(self, frame, parent_size)) |item_width| width = item_width;
    }

    const tag = self.getTag();
    if (tag == .html or tag == .body) {
        const root = rootLayoutSize(frame);
        if (width == layout_default_size) width = root.width;
        if (height == layout_default_size) {
            height = if (tag == .body) @max(root.height * 8.0, 800.0) else root.height;
        }
    } else if (tag == .img or tag == .iframe or tag == .video or tag == .embed or tag == .object) {
        if (width == layout_default_size) {
            if (self.getAttributeSafe(comptime .wrap("width"))) |w| {
                width = std.fmt.parseFloat(f64, w) catch width;
            }
        }
        if (height == layout_default_size) {
            if (self.getAttributeSafe(comptime .wrap("height"))) |h| {
                height = std.fmt.parseFloat(f64, h) catch height;
            }
        }
        if (width == layout_default_size) width = replaced_default_width;
        if (height == layout_default_size) height = replaced_default_height;
    } else if (isBlockLevel(self, frame)) {
        if (width == layout_default_size) width = parent_size.width;
        if (height == layout_default_size) {
            if (aspectRatioBoxHeight(self, frame, width)) |ah| {
                height = ah;
            } else {
                height = layout_leaf_block_height;
            }
        }
    }

    return .{ .width = @max(width, 0), .height = @max(height, 0) };
}

fn layoutDimensionFromProperty(self: *Element, frame: *Frame, property_name: []const u8, axis: enum { width, height }) ?f64 {
    const parent_size = parentLayoutSize(self, frame);
    const basis = switch (axis) {
        .width => parent_size.width,
        .height => parent_size.height,
    };

    if (readLayoutPropertyRaw(self, frame, property_name)) |value| {
        return parseLayoutDimension(value, basis);
    }
    return null;
}

/// Shadow-tree nodes are not linked under the host in the light DOM, so
/// offset them by the host's rect (Turnstile closed shadow + iframe).
fn shadowTreeHost(node: *Node) ?*Element {
    var current: ?*Node = node;
    while (current) |n| {
        const parent = n._parent orelse break;
        if (parent.is(ShadowRoot)) |shadow_root| return shadow_root._host;
        current = parent;
    }
    return null;
}

fn getElementDimensions(self: *Element, frame: *Frame) struct { width: f64, height: f64 } {
    const dims = resolveElementDimensions(self, frame, 0);
    return .{ .width = dims.width, .height = dims.height };
}

pub fn getClientWidth(self: *Element, frame: *Frame) f64 {
    return withLayoutResolveActive(frame, getClientWidthInner, .{ self, frame });
}

fn getClientWidthInner(self: *Element, frame: *Frame) f64 {
    if (self.isHiddenForLayout(frame)) return 0.0;
    const dims = self.getElementDimensions(frame);
    return dims.width;
}

pub fn getClientHeight(self: *Element, frame: *Frame) f64 {
    return withLayoutResolveActive(frame, getClientHeightInner, .{ self, frame });
}

fn getClientHeightInner(self: *Element, frame: *Frame) f64 {
    if (self.isHiddenForLayout(frame)) return 0.0;
    const dims = self.getElementDimensions(frame);
    return dims.height;
}

pub fn getBoundingClientRect(self: *Element, frame: *Frame) DOMRect {
    if (self.isHiddenForLayout(frame)) {
        return .{
            ._x = 0.0,
            ._y = 0.0,
            ._width = 0.0,
            ._height = 0.0,
        };
    }

    return self.getBoundingClientRectForVisible(frame);
}

// The internal layout API returns a value for inexpensive geometry arithmetic.
// The Web API, however, must return a branded DOMRect object so its prototype
// methods (notably toJSON()) are available to JavaScript callers.
fn getBoundingClientRectForJs(self: *Element, frame: *Frame) !*DOMRect {
    return frame._factory.create(self.getBoundingClientRect(frame));
}

// Some cases need a the BoundingClientRect but have already done the
// visibility check.
pub fn getBoundingClientRectForVisible(self: *Element, frame: *Frame) DOMRect {
    if (ClientRectsIntelligent.lookup(self, frame)) |golden| {
        return golden;
    }

    const pos_kind = layoutPositionKind(self, frame);
    if (pos_kind == .absolute or pos_kind == .fixed) {
        return self.getPositionedBoundingClientRect(frame);
    }

    const dims = self.getElementDimensions(frame);

    if (dims.width == 0.0 and dims.height == 0.0) {
        return .{
            ._x = 0.0,
            ._y = 0.0,
            ._width = 0.0,
            ._height = 0.0,
        };
    }

    const scroll_x = @as(f64, @floatFromInt(frame.window.getScrollX()));
    const scroll_y = @as(f64, @floatFromInt(frame.window.getScrollY()));
    const offset = getLayoutOffset(self, frame);
    const y = calculateDocumentPosition(self.asNode(), frame) + offset.top;

    if (shadowTreeHost(self.asNode())) |host| {
        const host_rect = host.getBoundingClientRectForVisible(frame);
        const local_x = calculateSiblingPosition(self.asNode(), frame) + offset.left;
        const local_y = calculateDocumentPosition(self.asNode(), frame) + offset.top;
        return finalizeClientRect(self, frame, .{
            ._x = host_rect._x + local_x,
            ._y = host_rect._y + local_y,
            ._width = dims.width,
            ._height = dims.height,
        });
    }

    return finalizeClientRect(self, frame, .{
        ._x = offset.left - scroll_x,
        ._y = y - scroll_y,
        ._width = dims.width,
        ._height = dims.height,
    });
}

pub fn getClientRects(self: *Element, frame: *Frame) ![]DOMRect {
    if (self.isHiddenForLayout(frame)) {
        return &.{};
    }
    const rects = try frame.call_arena.alloc(DOMRect, 1);
    rects[0] = self.getBoundingClientRectForVisible(frame);
    return rects;
}

pub fn getScrollTop(self: *Element, frame: *Frame) u32 {
    if (frame.document.getDocumentElement() == self) {
        return frame.window.getScrollY();
    }
    const pos = frame._element_scroll_positions.get(self) orelse return 0;
    return pos.y;
}

pub fn setScrollTop(self: *Element, value: i32, frame: *Frame) !void {
    // document.scrollingElement is the documentElement in this engine; its
    // offsets are the Window viewport offsets, not element-local state.
    if (frame.document.getDocumentElement() == self) {
        try frame.window.scrollTo(.{ .x = @intCast(frame.window.getScrollX()) }, value, frame);
        return;
    }
    const gop = try frame._element_scroll_positions.getOrPut(frame.arena, self);
    if (!gop.found_existing) {
        gop.value_ptr.* = .{};
    }
    gop.value_ptr.y = @intCast(@max(0, value));
}

pub fn getScrollLeft(self: *Element, frame: *Frame) u32 {
    const pos = frame._element_scroll_positions.get(self) orelse return 0;
    return pos.x;
}

pub fn setScrollLeft(self: *Element, value: i32, frame: *Frame) !void {
    const gop = try frame._element_scroll_positions.getOrPut(frame.arena, self);
    if (!gop.found_existing) {
        gop.value_ptr.* = .{};
    }
    gop.value_ptr.x = @intCast(@max(0, value));
}

pub fn getScrollHeight(self: *Element, frame: *Frame) f64 {
    // In our dummy layout engine, content doesn't overflow
    return self.getClientHeight(frame);
}

pub fn getScrollWidth(self: *Element, frame: *Frame) f64 {
    // In our dummy layout engine, content doesn't overflow
    return self.getClientWidth(frame);
}

pub fn getOffsetHeight(self: *Element, frame: *Frame) f64 {
    return withLayoutResolveActive(frame, getOffsetHeightInner, .{ self, frame });
}

fn getOffsetHeightInner(self: *Element, frame: *Frame) f64 {
    if (self.isHiddenForLayout(frame)) return 0.0;
    const dims = self.getElementDimensions(frame);
    return dims.height;
}

pub fn getOffsetWidth(self: *Element, frame: *Frame) f64 {
    return withLayoutResolveActive(frame, getOffsetWidthInner, .{ self, frame });
}

fn getOffsetWidthInner(self: *Element, frame: *Frame) f64 {
    if (readLayoutCache(self, frame)) |cached| return cached.width;
    if (self.isHiddenForLayout(frame)) return 0.0;
    const dims = self.getElementDimensions(frame);
    return dims.width;
}

pub fn getOffsetTop(self: *Element, frame: *Frame) f64 {
    if (!self.checkVisibilityCached(null, frame)) {
        return 0.0;
    }
    return calculateDocumentPosition(self.asNode(), frame);
}

pub fn getOffsetLeft(self: *Element, frame: *Frame) f64 {
    if (!self.checkVisibilityCached(null, frame)) {
        return 0.0;
    }
    return calculateSiblingPosition(self.asNode(), frame);
}

pub fn getClientTop(_: *Element) f64 {
    // Border width - in our dummy layout, we don't apply borders to layout
    return 0.0;
}

pub fn getClientLeft(_: *Element) f64 {
    // Border width - in our dummy layout, we don't apply borders to layout
    return 0.0;
}

// Calculates document position by counting all nodes that appear before this one
// in tree order, but only traversing the "left side" of the tree.
//
// This walks up from the target node to the root, and at each level counts:
// 1. All previous siblings and their descendants
// 2. The parent itself
//
// Example:
//   <body>              → y=0
//     <h1>Text</h1>     → y=1    (body=1)
//     <h2>              → y=2    (body=1 + h1=1)
//       <a>Link1</a>    → y=3    (body=1 + h1=1 + h2=1)
//     </h2>
//     <p>Text</p>       → y=5    (body=1 + h1=1 + h2=2)
//     <h2>              → y=6    (body=1 + h1=1 + h2=2 + p=1)
//       <a>Link2</a>    → y=7    (body=1 + h1=1 + h2=2 + p=1 + h2=1)
//     </h2>
//   </body>
//
// Trade-offs:
// O(depth × preceding_siblings) — avoids recursive subtree walks that made
// CreepJS getClientRects (100+ layout reads on a large injected DOM) hang.
fn precedingSiblingDocumentWeight(node: *Node) f64 {
    if (node.is(Element)) |el| {
        if (el.asNode().firstChild()) |_| return 1.0;
    }
    return 1.0;
}

fn calculateDocumentPosition(node: *Node, frame: *Frame) f64 {
    const cache_key = @intFromPtr(node);
    if (frame._layout_cache_dom_version == frame.version) {
        if (frame._layout_doc_position_cache.get(cache_key)) |cached| return cached;
    }

    var position: f64 = 0.0;
    var current = node;

    while (current.parentNode()) |parent| {
        const limit: u32 = if (parent._children) |children| children.len() else 0;
        var sibling = parent.firstChild();
        var visited: u32 = 0;
        while (sibling) |s| {
            visited += 1;
            if (visited > limit) break;
            if (s == current) break;
            position += precedingSiblingDocumentWeight(s);
            sibling = s.nextSibling();
        }
        position += 1.0;
        current = parent;
    }

    const result = position * 5.0;
    frame._layout_doc_position_cache.put(frame.arena, cache_key, result) catch {};
    return result;
}

fn calculateSiblingPosition(node: *Node, frame: *Frame) f64 {
    return calculateDocumentPosition(node, frame);
}

const max_layout_dimension: f64 = 16384.0;

pub fn getElementsByTagName(self: *Element, tag_name: []const u8, frame: *Frame) !Node.GetElementsByTagNameResult {
    return self.asNode().getElementsByTagName(tag_name, frame);
}

pub fn getElementsByTagNameNS(self: *Element, namespace: ?[]const u8, local_name: []const u8, frame: *Frame) !collections.NodeLive(.tag_name_ns) {
    return self.asNode().getElementsByTagNameNS(namespace, local_name, frame);
}

pub fn getElementsByClassName(self: *Element, class_name: []const u8, frame: *Frame) !collections.NodeLive(.class_name) {
    return self.asNode().getElementsByClassName(class_name, frame);
}

pub fn clone(self: *Element, deep: bool, frame: *Frame) !*Node {
    const tag_name = self.getTagNameDump();
    const node = try frame.createElementNS(self._namespace, tag_name, self._attributes);

    // Allow element-specific types to copy their runtime state
    _ = Element.Build.call(node.as(Element), "cloned", .{ self, node.as(Element), frame }) catch |err| {
        log.err(.dom, "element.clone.failed", .{ .err = err });
    };

    if (deep) {
        var child_it = self.asNode().childrenIterator();
        while (child_it.next()) |child| {
            if (try child.cloneNodeForAppending(true, frame)) |cloned_child| {
                // We pass `true` to `child_already_connected` as a hacky optimization
                // We _know_ this child isn't connected (Because the parent isn't connected)
                // setting this to `true` skips all connection checks.
                try frame.appendNode(node, cloned_child, .{ .child_already_connected = true });
            }
        }
    }

    return node;
}

const ScrollBlockAlign = enum { start, center, end, nearest };

fn scrollBlockFromOpts(opts: ?ScrollIntoViewOpts) ScrollBlockAlign {
    if (opts) |o| switch (o) {
        .align_to_top => |top| return if (top) .start else .end,
        .obj => return .center,
    };
    return .start;
}

pub fn scrollIntoViewIfNeeded(self: *Element, center_if_needed: ?bool, frame: *Frame) !void {
    const rect = self.getBoundingClientRect(frame);
    const vp_h = @as(f64, @floatFromInt(frame.identityProfile().screen.height));
    const vp_w = @as(f64, @floatFromInt(frame.identityProfile().screen.width));
    if (rect.getTop() >= 0 and rect.getBottom() <= vp_h and
        rect.getLeft() >= 0 and rect.getRight() <= vp_w)
    {
        return;
    }
    const block: ScrollBlockAlign = if (center_if_needed orelse false) .center else .nearest;
    try scrollIntoViewWithBlock(self, block, frame);
}

const ScrollIntoViewOpts = union(enum) {
    align_to_top: bool,
    obj: js.Object,
};

pub fn scrollIntoView(self: *Element, opts: ?ScrollIntoViewOpts, frame: *Frame) !void {
    try scrollIntoViewWithBlock(self, scrollBlockFromOpts(opts), frame);
}

fn scrollIntoViewWithBlock(self: *Element, block: ScrollBlockAlign, frame: *Frame) !void {
    const rect = self.getBoundingClientRect(frame);
    const scroll_x = @as(f64, @floatFromInt(frame.window.getScrollX()));
    const scroll_y = @as(f64, @floatFromInt(frame.window.getScrollY()));
    const vp_h = @as(f64, @floatFromInt(frame.identityProfile().screen.height));
    const vp_w = @as(f64, @floatFromInt(frame.identityProfile().screen.width));

    var target_y: f64 = scroll_y;
    var target_x: f64 = scroll_x;

    switch (block) {
        .start => {
            target_y = rect.getTop() + scroll_y;
            target_x = rect.getLeft() + scroll_x;
        },
        .center => {
            target_y = rect.getTop() + scroll_y + rect.getHeight() / 2 - vp_h / 2;
            target_x = rect.getLeft() + scroll_x + rect.getWidth() / 2 - vp_w / 2;
        },
        .end => {
            target_y = rect.getTop() + scroll_y + rect.getHeight() - vp_h;
            target_x = rect.getLeft() + scroll_x + rect.getWidth() - vp_w;
        },
        .nearest => {
            if (rect.getTop() < 0) {
                target_y = rect.getTop() + scroll_y;
            } else if (rect.getBottom() > vp_h) {
                target_y = rect.getTop() + scroll_y + rect.getHeight() - vp_h;
            }
            if (rect.getLeft() < 0) {
                target_x = rect.getLeft() + scroll_x;
            } else if (rect.getRight() > vp_w) {
                target_x = rect.getLeft() + scroll_x + rect.getWidth() - vp_w;
            }
        },
    }

    try frame.window.scrollTo(.{ .opts = .{
        .top = @intCast(@max(@as(i32, @intFromFloat(target_y)), 0)),
        .left = @intCast(@max(@as(i32, @intFromFloat(target_x)), 0)),
    } }, null, frame);
}

pub fn format(self: *Element, writer: *std.Io.Writer) !void {
    try writer.writeByte('<');
    try writer.writeAll(self.getTagNameDump());

    if (self._attributes) |attributes| {
        var it = attributes.iterator();
        while (it.next()) |attr| {
            try writer.print(" {f}", .{attr});
        }
    }
    try writer.writeByte('>');
}

fn upperTagName(tag_name: *String, buf: []u8) []const u8 {
    if (tag_name.len > buf.len) {
        log.info(.dom, "tag.long.name", .{ .name = tag_name.str() });
        return tag_name.str();
    }
    const tag = tag_name.str();
    return std.ascii.upperString(buf, tag);
}

pub fn getTag(self: *const Element) Tag {
    return switch (self._type) {
        .html => |he| switch (he._type) {
            .anchor => .anchor,
            .area => .area,
            .base => .base,
            .div => .div,
            .dl => .dl,
            .embed => .embed,
            .form => .form,
            .p => .p,
            .custom => .custom,
            .data => .data,
            .datalist => .datalist,
            .details => .details,
            .dialog => .dialog,
            .directory => .directory,
            .iframe => .iframe,
            .img => .img,
            .br => .br,
            .button => .button,
            .canvas => .canvas,
            .fieldset => .fieldset,
            .font => .font,
            .frameset => .frameset,
            .heading => |h| h._tag,
            .label => .label,
            .legend => .legend,
            .li => .li,
            .map => .map,
            .marquee => .marquee,
            .ul => .ul,
            .ol => .ol,
            .object => .object,
            .optgroup => .optgroup,
            .output => .output,
            .picture => .picture,
            .param => .param,
            .pre => .pre,
            .generic => |g| g._tag,
            .media => |m| switch (m._type) {
                .audio => .audio,
                .video => .video,
                .generic => .media,
            },
            .meter => .meter,
            .mod => |m| m._tag,
            .progress => .progress,
            .quote => |q| q._tag,
            .script => .script,
            .select => .select,
            .slot => .slot,
            .source => .source,
            .span => .span,
            .option => .option,
            .table => .table,
            .table_caption => .caption,
            .table_cell => |tc| tc._tag,
            .table_col => |tc| tc._tag,
            .table_row => .tr,
            .table_section => |ts| ts._tag,
            .template => .template,
            .textarea => .textarea,
            .time => .time,
            .track => .track,
            .input => .input,
            .link => .link,
            .meta => .meta,
            .hr => .hr,
            .style => .style,
            .title => .title,
            .body => .body,
            .html => .html,
            .head => .head,
            .unknown => .unknown,
        },
        .svg => |se| switch (se._type) {
            .svg => .svg,
            .generic => |g| g._tag,
        },
    };
}

pub const Tag = enum {
    address,
    anchor,
    audio,
    area,
    aside,
    article,
    b,
    blockquote,
    body,
    br,
    button,
    base,
    canvas,
    caption,
    circle,
    code,
    col,
    colgroup,
    custom,
    data,
    datalist,
    dd,
    details,
    del,
    dfn,
    dialog,
    div,
    directory,
    dl,
    dt,
    embed,
    ellipse,
    em,
    fieldset,
    figure,
    frameset,
    form,
    font,
    footer,
    g,
    h1,
    h2,
    h3,
    h4,
    h5,
    h6,
    head,
    header,
    heading,
    hgroup,
    hr,
    html,
    i,
    iframe,
    img,
    input,
    ins,
    label,
    legend,
    li,
    line,
    link,
    main,
    map,
    marquee,
    media,
    menu,
    meta,
    meter,
    nav,
    noscript,
    object,
    ol,
    optgroup,
    option,
    output,
    p,
    path,
    param,
    picture,
    polygon,
    polyline,
    pre,
    progress,
    quote,
    rect,
    s,
    script,
    section,
    select,
    slot,
    source,
    span,
    strong,
    style,
    sub,
    summary,
    sup,
    svg,
    table,
    time,
    tbody,
    td,
    text,
    template,
    textarea,
    tfoot,
    th,
    thead,
    title,
    tr,
    track,
    ul,
    video,
    unknown,

    // If the tag is "unknown", we can't use the optimized tag matching, but
    // need to fallback to the actual tag name
    pub fn parseForMatch(lower: []const u8) ?Tag {
        const tag = std.meta.stringToEnum(Tag, lower) orelse return null;
        return switch (tag) {
            .unknown, .custom => null,
            else => tag,
        };
    }

    pub fn isBlock(self: Tag) bool {
        // zig fmt: off
        return switch (self) {
            // Semantic Layout
            .article, .aside, .footer, .header, .main, .nav, .section,
            // Grouping / Containers
            .address, .div, .fieldset, .figure, .p,
            // Headings
            .h1, .h2, .h3, .h4, .h5, .h6,
            // Lists
            .dl, .ol, .ul,
            // Preformatted / Quotes
            .blockquote, .pre,
            // Tables
            .table,
            // Other
            .hr,
            => true,
            else => false,
        };
        // zig fmt: on
    }

    pub fn isMetadata(self: Tag) bool {
        return switch (self) {
            .base, .head, .link, .meta, .noscript, .script, .style, .template, .title => true,
            else => false,
        };
    }

    // UA stylesheet display:none defaults per HTML Rendering §15.3.1
    // "Hidden elements" (https://html.spec.whatwg.org/multipage/rendering.html#hidden-elements).
    // The spec also lists basefont, noembed, noframes, rp; those tags are
    // obsolete and not represented in this enum, so they fall through to
    // `.unknown`/`.custom` and aren't matched here.
    pub fn isHiddenByUaStylesheet(self: Tag) bool {
        return switch (self) {
            .area,
            .base,
            .datalist,
            .head,
            .link,
            .meta,
            .noscript,
            .param,
            .script,
            .source,
            .style,
            .template,
            .title,
            .track,
            => true,
            else => false,
        };
    }
};

pub const JsApi = struct {
    pub const bridge = js.Bridge(Element);

    pub const Meta = struct {
        pub const name = "Element";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
        pub const enumerable = false;
    };

    pub const tagName = bridge.accessor(_tagName, null, .{});
    fn _tagName(self: *Element, frame: *Frame) []const u8 {
        return self.getTagNameSpec(&frame.buf);
    }
    pub const namespaceURI = bridge.accessor(Element.getNamespaceURI, null, .{});

    pub const innerText = bridge.accessor(_innerText, Element.setInnerText, .{});
    fn _innerText(self: *Element, frame: *Frame) ![]const u8 {
        var buf = std.Io.Writer.Allocating.init(frame.call_arena);
        try self.getInnerText(&buf.writer, frame);
        return buf.written();
    }

    pub const outerHTML = bridge.accessor(_outerHTML, Element.setOuterHTML, .{});
    fn _outerHTML(self: *Element, frame: *Frame) ![]const u8 {
        var buf = std.Io.Writer.Allocating.init(frame.call_arena);
        try self.getOuterHTML(&buf.writer, frame);
        return buf.written();
    }

    pub const innerHTML = bridge.accessor(_innerHTML, Element.setInnerHTML, .{});
    fn _innerHTML(self: *Element, frame: *Frame) ![]const u8 {
        var buf = std.Io.Writer.Allocating.init(frame.call_arena);
        try self.getInnerHTML(&buf.writer, frame);
        return buf.written();
    }

    pub const prefix = bridge.accessor(Element._prefix, null, .{});

    pub const setAttribute = bridge.function(_setAttribute, .{ .dom_exception = true });
    fn _setAttribute(self: *Element, name: String, value: js.Value, frame: *Frame) !void {
        return self.setAttribute(name, .wrap(try value.toStringSlice()), frame);
    }

    pub const setAttributeNS = bridge.function(_setAttributeNS, .{ .dom_exception = true });
    fn _setAttributeNS(self: *Element, maybe_ns: ?[]const u8, qn: []const u8, value: js.Value, frame: *Frame) !void {
        return self.setAttributeNS(maybe_ns, qn, .wrap(try value.toStringSlice()), frame);
    }

    pub const localName = bridge.accessor(Element.getLocalName, null, .{});
    pub const id = bridge.accessor(Element.getId, Element.setId, .{});
    pub const slot = bridge.accessor(Element.getSlot, Element.setSlot, .{});
    pub const role = bridge.accessor(Element.RoleReflection.get, Element.RoleReflection.set, .{});
    pub const ariaAtomic = bridge.accessor(Element.AriaAtomicReflection.get, Element.AriaAtomicReflection.set, .{});
    pub const ariaAutoComplete = bridge.accessor(Element.AriaAutoCompleteReflection.get, Element.AriaAutoCompleteReflection.set, .{});
    pub const ariaBrailleLabel = bridge.accessor(Element.AriaBrailleLabelReflection.get, Element.AriaBrailleLabelReflection.set, .{});
    pub const ariaBrailleRoleDescription = bridge.accessor(Element.AriaBrailleRoleDescriptionReflection.get, Element.AriaBrailleRoleDescriptionReflection.set, .{});
    pub const ariaBusy = bridge.accessor(Element.AriaBusyReflection.get, Element.AriaBusyReflection.set, .{});
    pub const ariaChecked = bridge.accessor(Element.AriaCheckedReflection.get, Element.AriaCheckedReflection.set, .{});
    pub const ariaColCount = bridge.accessor(Element.AriaColCountReflection.get, Element.AriaColCountReflection.set, .{});
    pub const ariaColIndex = bridge.accessor(Element.AriaColIndexReflection.get, Element.AriaColIndexReflection.set, .{});
    pub const ariaColIndexText = bridge.accessor(Element.AriaColIndexTextReflection.get, Element.AriaColIndexTextReflection.set, .{});
    pub const ariaColSpan = bridge.accessor(Element.AriaColSpanReflection.get, Element.AriaColSpanReflection.set, .{});
    pub const ariaCurrent = bridge.accessor(Element.AriaCurrentReflection.get, Element.AriaCurrentReflection.set, .{});
    pub const ariaDescription = bridge.accessor(Element.AriaDescriptionReflection.get, Element.AriaDescriptionReflection.set, .{});
    pub const ariaDisabled = bridge.accessor(Element.AriaDisabledReflection.get, Element.AriaDisabledReflection.set, .{});
    pub const ariaExpanded = bridge.accessor(Element.AriaExpandedReflection.get, Element.AriaExpandedReflection.set, .{});
    pub const ariaHasPopup = bridge.accessor(Element.AriaHasPopupReflection.get, Element.AriaHasPopupReflection.set, .{});
    pub const ariaHidden = bridge.accessor(Element.AriaHiddenReflection.get, Element.AriaHiddenReflection.set, .{});
    pub const ariaInvalid = bridge.accessor(Element.AriaInvalidReflection.get, Element.AriaInvalidReflection.set, .{});
    pub const ariaKeyShortcuts = bridge.accessor(Element.AriaKeyShortcutsReflection.get, Element.AriaKeyShortcutsReflection.set, .{});
    pub const ariaLabel = bridge.accessor(Element.AriaLabelReflection.get, Element.AriaLabelReflection.set, .{});
    pub const ariaLevel = bridge.accessor(Element.AriaLevelReflection.get, Element.AriaLevelReflection.set, .{});
    pub const ariaLive = bridge.accessor(Element.AriaLiveReflection.get, Element.AriaLiveReflection.set, .{});
    pub const ariaModal = bridge.accessor(Element.AriaModalReflection.get, Element.AriaModalReflection.set, .{});
    pub const ariaMultiLine = bridge.accessor(Element.AriaMultiLineReflection.get, Element.AriaMultiLineReflection.set, .{});
    pub const ariaMultiSelectable = bridge.accessor(Element.AriaMultiSelectableReflection.get, Element.AriaMultiSelectableReflection.set, .{});
    pub const ariaOrientation = bridge.accessor(Element.AriaOrientationReflection.get, Element.AriaOrientationReflection.set, .{});
    pub const ariaPlaceholder = bridge.accessor(Element.AriaPlaceholderReflection.get, Element.AriaPlaceholderReflection.set, .{});
    pub const ariaPosInSet = bridge.accessor(Element.AriaPosInSetReflection.get, Element.AriaPosInSetReflection.set, .{});
    pub const ariaPressed = bridge.accessor(Element.AriaPressedReflection.get, Element.AriaPressedReflection.set, .{});
    pub const ariaReadOnly = bridge.accessor(Element.AriaReadOnlyReflection.get, Element.AriaReadOnlyReflection.set, .{});
    pub const ariaRelevant = bridge.accessor(Element.AriaRelevantReflection.get, Element.AriaRelevantReflection.set, .{});
    pub const ariaRequired = bridge.accessor(Element.AriaRequiredReflection.get, Element.AriaRequiredReflection.set, .{});
    pub const ariaRoleDescription = bridge.accessor(Element.AriaRoleDescriptionReflection.get, Element.AriaRoleDescriptionReflection.set, .{});
    pub const ariaRowCount = bridge.accessor(Element.AriaRowCountReflection.get, Element.AriaRowCountReflection.set, .{});
    pub const ariaRowIndex = bridge.accessor(Element.AriaRowIndexReflection.get, Element.AriaRowIndexReflection.set, .{});
    pub const ariaRowIndexText = bridge.accessor(Element.AriaRowIndexTextReflection.get, Element.AriaRowIndexTextReflection.set, .{});
    pub const ariaRowSpan = bridge.accessor(Element.AriaRowSpanReflection.get, Element.AriaRowSpanReflection.set, .{});
    pub const ariaSelected = bridge.accessor(Element.AriaSelectedReflection.get, Element.AriaSelectedReflection.set, .{});
    pub const ariaSetSize = bridge.accessor(Element.AriaSetSizeReflection.get, Element.AriaSetSizeReflection.set, .{});
    pub const ariaSort = bridge.accessor(Element.AriaSortReflection.get, Element.AriaSortReflection.set, .{});
    pub const ariaValueMax = bridge.accessor(Element.AriaValueMaxReflection.get, Element.AriaValueMaxReflection.set, .{});
    pub const ariaValueMin = bridge.accessor(Element.AriaValueMinReflection.get, Element.AriaValueMinReflection.set, .{});
    pub const ariaValueNow = bridge.accessor(Element.AriaValueNowReflection.get, Element.AriaValueNowReflection.set, .{});
    pub const ariaValueText = bridge.accessor(Element.AriaValueTextReflection.get, Element.AriaValueTextReflection.set, .{});
    pub const ariaActiveDescendantElement = bridge.accessor(Element.getAriaActiveDescendantElement, Element.setAriaActiveDescendantElement, .{});
    pub const ariaDescribedByElements = bridge.accessor(Element.getAriaDescribedByElements, Element.setAriaDescribedByElements, .{});
    pub const dir = bridge.accessor(Element.getDir, Element.setDir, .{});
    pub const className = bridge.accessor(Element.getClassName, Element.setClassName, .{});
    pub const classList = bridge.accessor(Element.getClassList, Element.setClassList, .{});
    pub const dataset = bridge.accessor(Element.getDataset, null, .{});
    pub const style = bridge.accessor(Element.getOrCreateStyle, null, .{});
    pub const attributes = bridge.accessor(Element.getAttributeNamedNodeMap, null, .{});
    pub const hasAttribute = bridge.function(Element.hasAttribute, .{});
    pub const hasAttributes = bridge.function(Element.hasAttributes, .{});
    pub const getAttribute = bridge.function(Element.getAttribute, .{});
    pub const getAttributeNS = bridge.function(Element.getAttributeNS, .{});
    pub const getAttributeNode = bridge.function(Element.getAttributeNode, .{});
    pub const setAttributeNode = bridge.function(Element.setAttributeNode, .{});
    pub const removeAttribute = bridge.function(Element.removeAttribute, .{});
    pub const toggleAttribute = bridge.function(Element.toggleAttribute, .{ .dom_exception = true });
    pub const getAttributeNames = bridge.function(Element.getAttributeNames, .{});
    pub const removeAttributeNode = bridge.function(Element.removeAttributeNode, .{ .dom_exception = true });
    pub const shadowRoot = bridge.accessor(Element.getShadowRoot, null, .{});
    pub const assignedSlot = bridge.accessor(Element.getAssignedSlot, null, .{});
    pub const attachShadow = bridge.function(_attachShadow, .{ .dom_exception = true });
    pub const insertAdjacentHTML = bridge.function(Element.insertAdjacentHTML, .{ .dom_exception = true });
    pub const insertAdjacentElement = bridge.function(Element.insertAdjacentElement, .{ .dom_exception = true });
    pub const insertAdjacentText = bridge.function(Element.insertAdjacentText, .{ .dom_exception = true });

    const ShadowRootInit = struct {
        mode: []const u8,
    };
    fn _attachShadow(self: *Element, init: ShadowRootInit, frame: *Frame) !*ShadowRoot {
        return self.attachShadow(init.mode, frame);
    }
    pub const replaceChildren = bridge.function(Element.replaceChildren, .{ .dom_exception = true });
    pub const replaceWith = bridge.function(Element.replaceWith, .{ .dom_exception = true });
    pub const remove = bridge.function(Element.remove, .{});
    pub const append = bridge.function(Element.append, .{ .dom_exception = true });
    pub const prepend = bridge.function(Element.prepend, .{ .dom_exception = true });
    pub const before = bridge.function(Element.before, .{ .dom_exception = true });
    pub const after = bridge.function(Element.after, .{ .dom_exception = true });
    pub const firstElementChild = bridge.accessor(Element.firstElementChild, null, .{});
    pub const lastElementChild = bridge.accessor(Element.lastElementChild, null, .{});
    pub const nextElementSibling = bridge.accessor(Element.nextElementSibling, null, .{});
    pub const previousElementSibling = bridge.accessor(Element.previousElementSibling, null, .{});
    pub const childElementCount = bridge.accessor(Element.getChildElementCount, null, .{});
    pub const matches = bridge.function(Element.matches, .{ .dom_exception = true });
    pub const querySelector = bridge.function(Element.querySelector, .{ .dom_exception = true });
    pub const querySelectorAll = bridge.function(Element.querySelectorAll, .{ .dom_exception = true });
    pub const closest = bridge.function(Element.closest, .{ .dom_exception = true });
    pub const getAnimations = bridge.function(Element.getAnimations, .{});
    pub const animate = bridge.function(Element.animate, .{});
    pub const checkVisibility = bridge.function(Element.checkVisibility, .{});
    pub const clientWidth = bridge.accessor(Element.getClientWidth, null, .{});
    pub const clientHeight = bridge.accessor(Element.getClientHeight, null, .{});
    pub const clientTop = bridge.accessor(Element.getClientTop, null, .{});
    pub const clientLeft = bridge.accessor(Element.getClientLeft, null, .{});
    pub const scrollTop = bridge.accessor(Element.getScrollTop, Element.setScrollTop, .{});
    pub const scrollLeft = bridge.accessor(Element.getScrollLeft, Element.setScrollLeft, .{});
    pub const scrollHeight = bridge.accessor(Element.getScrollHeight, null, .{});
    pub const scrollWidth = bridge.accessor(Element.getScrollWidth, null, .{});
    pub const offsetTop = bridge.accessor(Element.getOffsetTop, null, .{});
    pub const offsetLeft = bridge.accessor(Element.getOffsetLeft, null, .{});
    pub const offsetWidth = bridge.accessor(Element.getOffsetWidth, null, .{});
    pub const offsetHeight = bridge.accessor(Element.getOffsetHeight, null, .{});
    pub const getClientRects = bridge.function(Element.getClientRects, .{});
    pub const getBoundingClientRect = bridge.function(Element.getBoundingClientRectForJs, .{});
    pub const getElementsByTagName = bridge.function(Element.getElementsByTagName, .{});
    pub const getElementsByTagNameNS = bridge.function(Element.getElementsByTagNameNS, .{});
    pub const getElementsByClassName = bridge.function(Element.getElementsByClassName, .{});
    // ParentNode.children is [SameObject]: the collection stays live while
    // repeated reads return the same JS wrapper for this element.
    pub const children = bridge.accessor(Element.getChildren, null, .{ .cache = .{ .private = "children" } });
    pub const focus = bridge.function(Element.focus, .{});
    pub const blur = bridge.function(Element.blur, .{});
    pub const scrollIntoView = bridge.function(Element.scrollIntoView, .{});
    pub const scrollIntoViewIfNeeded = bridge.function(Element.scrollIntoViewIfNeeded, .{});
};

pub const Build = struct {
    // Calls `func_name` with `args` on the most specific type where it is
    // implement. This could be on the Element itself.
    pub fn call(self: *const Element, comptime func_name: []const u8, args: anytype) !bool {
        inline for (@typeInfo(Element.Type).@"union".fields) |f| {
            if (@field(Element.Type, f.name) == self._type) {
                // The inner type implements this function. Call it and we're done.
                const S = reflect.Struct(f.type);
                if (@hasDecl(S, "Build")) {
                    if (@hasDecl(S.Build, "call")) {
                        const sub = @field(self._type, f.name);
                        return S.Build.call(sub, func_name, args);
                    }

                    // The inner type implements this function. Call it and we're done.
                    if (@hasDecl(f.type, func_name)) {
                        return @call(.auto, @field(f.type, func_name), args);
                    }
                }
            }
        }

        if (@hasDecl(Element.Build, func_name)) {
            // Our last resort - the element implements this function.
            try @call(.auto, @field(Element.Build, func_name), args);
            return true;
        }

        // inform our caller (the Node) that we didn't find anything that implemented
        // func_name and it should keep searching for a match.
        return false;
    }
};
