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
const Frame = @import("Frame.zig");
const Node = @import("../dom/Node.zig");
const Slot = @import("../webapi/element/html/Slot.zig");
const IFrame = @import("../webapi/element/html/IFrame.zig");
const Style = @import("../webapi/element/html/Style.zig");
const CSSStyleRule = @import("../webapi/css/CSSStyleRule.zig");

const IS_DEBUG = @import("builtin").mode == .Debug;

pub const Opts = struct {
    with_base: bool = false,
    with_frames: bool = false,
    strip: Opts.Strip = .{},
    shadow: Opts.Shadow = .rendered,

    pub const Strip = packed struct(u3) {
        js: bool = false,
        ui: bool = false,
        css: bool = false,
    };

    pub const Shadow = enum {
        // Skip shadow DOM entirely (innerHTML/outerHTML)
        skip,

        // Dump everything (like "view source")
        complete,

        // Resolve slot elements (like what actually gets rendered)
        rendered,
    };
};

pub fn root(doc: *Node.Document, opts: Opts, writer: *std.Io.Writer, frame: *Frame) !void {
    if (doc.is(Node.Document.HTMLDocument)) |html_doc| {
        blk: {
            // Ideally we just render the doctype which is part of the document
            if (doc.asNode().firstChild()) |first| {
                if (first._type == .document_type) {
                    break :blk;
                }
            }
            // But if the doc has no child, or the first child isn't a doctype
            // well force it.
            try writer.writeAll("<!DOCTYPE html>");
        }

        if (opts.with_base) {
            const parent = if (html_doc.getHead()) |head| head.asNode() else doc.asNode();
            const base = try doc.createElement("base", null, frame);
            try base.setAttributeSafe(comptime .wrap("href"), .wrap(frame.base()), frame);
            _ = try parent.insertBefore(base.asNode(), parent.firstChild(), frame);
        }
    }

    return deep(doc.asNode(), opts, writer, frame);
}

pub fn deep(node: *Node, opts: Opts, writer: *std.Io.Writer, frame: *Frame) error{WriteFailed}!void {
    return _deep(node, opts, false, writer, frame);
}

fn _deep(node: *Node, opts: Opts, comptime force_slot: bool, writer: *std.Io.Writer, frame: *Frame) error{WriteFailed}!void {
    switch (node._type) {
        .cdata => |cd| {
            if (node.is(Node.CData.Comment)) |_| {
                try writer.writeAll("<!--");
                try writer.writeAll(cd.getData().str());
                try writer.writeAll("-->");
            } else if (node.is(Node.CData.ProcessingInstruction)) |pi| {
                try writer.writeAll("<?");
                try writer.writeAll(pi._target);
                try writer.writeAll(" ");
                try writer.writeAll(cd.getData().str());
                try writer.writeAll("?>");
            } else {
                if (shouldEscapeText(node._parent)) {
                    try writeEscapedText(cd.getData().str(), writer);
                } else {
                    try writer.writeAll(cd.getData().str());
                }
            }
        },
        .element => |el| {
            if (shouldStripElement(el, opts)) {
                return;
            }

            // When opts.shadow == .rendered, we normally skip any element with
            // a slot attribute. Only the "active" element will get rendered into
            // the <slot name="X">. However, the `deep` function is itself used
            // to render that "active" content, so when we're trying to render
            // it, we don't want to skip it.
            if ((comptime force_slot == false) and opts.shadow == .rendered) {
                if (el.getAttributeSafe(comptime .wrap("slot"))) |_| {
                    // Skip - will be rendered by the Slot if it's the active container
                    return;
                }
            }

            try el.format(writer);

            if (!opts.strip.css and std.mem.eql(u8, el.getTagNameDump(), "head")) {
                try dumpDocumentStylesheetSnapshot(writer, frame);
            }

            // CSS-in-JS libraries commonly create an empty <style> node and
            // populate its sheet through CSSStyleSheet.insertRule(). CSSOM
            // mutations do not create DOM text nodes, so a plain DOM
            // serialization would emit an empty style element and the saved
            // page would lose its rendered layout. Materialize the live CSSOM
            // only into the snapshot stream; never mutate the source DOM.
            if (el.is(Style)) |style| {
                if (try dumpCssomOnlyStyle(style, writer, frame)) {
                    return writer.writeAll("</style>");
                }
            }

            if (opts.shadow == .rendered) {
                if (el.is(Slot)) |slot| {
                    try dumpSlotContent(slot, opts, writer, frame);
                    return writer.writeAll("</slot>");
                }
            }
            if (opts.shadow != .skip) {
                if (frame._element_shadow_roots.get(el)) |shadow| {
                    try children(shadow.asNode(), opts, writer, frame);
                    // In rendered mode, light DOM is only shown through slots, not directly
                    if (opts.shadow == .rendered) {
                        // Skip rendering light DOM children
                        if (!isVoidElement(el)) {
                            try writer.writeAll("</");
                            try writer.writeAll(el.getTagNameDump());
                            try writer.writeByte('>');
                        }
                        return;
                    }
                }
            }

            if (opts.with_frames and el.is(IFrame) != null) {
                const iframe = el.as(IFrame);
                // Dump internals: bypass same-origin contentDocument gate.
                if (iframe._window) |win| {
                    const doc = win._document;
                    // A frame's document should always ahave a frame, but
                    // I'm not willing to crash a release build on that assertion.
                    if (comptime IS_DEBUG) {
                        std.debug.assert(doc._frame != null);
                    }
                    if (doc._frame) |f| {
                        try writer.writeByte('\n');
                        root(doc, opts, writer, f) catch return error.WriteFailed;
                        try writer.writeByte('\n');
                    }
                }
            } else {
                try children(node, opts, writer, frame);
            }

            if (!isVoidElement(el)) {
                try writer.writeAll("</");
                try writer.writeAll(el.getTagNameDump());
                try writer.writeByte('>');
            }
        },
        .document => try children(node, opts, writer, frame),
        .document_type => |dt| {
            try writer.writeAll("<!DOCTYPE ");
            try writer.writeAll(dt.getName());

            const public_id = dt.getPublicId();
            const system_id = dt.getSystemId();
            if (public_id.len != 0 and system_id.len != 0) {
                try writer.writeAll(" PUBLIC \"");
                try writeEscapedText(public_id, writer);
                try writer.writeAll("\" \"");
                try writeEscapedText(system_id, writer);
                try writer.writeByte('"');
            } else if (public_id.len != 0) {
                try writer.writeAll(" PUBLIC \"");
                try writeEscapedText(public_id, writer);
                try writer.writeByte('"');
            } else if (system_id.len != 0) {
                try writer.writeAll(" SYSTEM \"");
                try writeEscapedText(system_id, writer);
                try writer.writeByte('"');
            }
            try writer.writeAll(">\n");
        },
        .document_fragment => try children(node, opts, writer, frame),
        .attribute => {
            // Not called normally, but can be called via XMLSerializer.serializeToString
            // in which case it should return an empty string
            try writer.writeAll("");
        },
    }
}

fn writeCssRuleSnapshot(rule: *@import("../webapi/css/CSSRule.zig"), writer: *std.Io.Writer) error{WriteFailed}!bool {
    if (rule.is(CSSStyleRule)) |style_rule| {
        const props = style_rule._style orelse return false;
        writer.writeAll(style_rule._selector_text) catch return error.WriteFailed;
        writer.writeAll(" { ") catch return error.WriteFailed;
        props.asCSSStyleDeclaration().format(writer) catch return error.WriteFailed;
        writer.writeAll(" }\n") catch return error.WriteFailed;
        return true;
    }
    if (rule._raw_css_text) |raw| {
        writer.writeAll(raw) catch return error.WriteFailed;
        writer.writeByte('\n') catch return error.WriteFailed;
        return true;
    }
    return false;
}

fn dumpDocumentStylesheetSnapshot(writer: *std.Io.Writer, frame: *Frame) error{WriteFailed}!void {
    const sheets = frame.document._style_sheets orelse return;
    writer.writeAll("<style data-velora-cssom-snapshot=\"\">") catch return error.WriteFailed;
    for (sheets._sheets.items) |sheet| {
        if (sheet._disabled) continue;
        const rules = sheet._css_rules orelse continue;
        for (rules._rules.items) |rule| {
            _ = try writeCssRuleSnapshot(rule, writer);
        }
    }
    writer.writeAll("</style>") catch return error.WriteFailed;
}

fn dumpCssomOnlyStyle(style: *Style, writer: *std.Io.Writer, frame: *Frame) error{WriteFailed}!bool {
    if (style.asNode().firstChild() != null) return false;
    var sheet = style._sheet;
    if (frame.document._style_sheets) |sheets| {
        for (sheets._sheets.items) |candidate| {
            if (candidate._owner_node != style.asElement()) continue;
            if (candidate._css_rules) |candidate_rules| {
                if (candidate_rules._rules.items.len > 0) {
                    sheet = candidate;
                    break;
                }
            }
            if (sheet == null) sheet = candidate;
        }
    }
    const resolved_sheet = sheet orelse return false;
    const rules = resolved_sheet._css_rules orelse return false;
    if (rules._rules.items.len == 0) return false;

    var wrote_rule = false;
    for (rules._rules.items) |rule| {
        if (try writeCssRuleSnapshot(rule, writer)) wrote_rule = true;
    }
    return wrote_rule;
}

pub fn children(parent: *Node, opts: Opts, writer: *std.Io.Writer, frame: *Frame) !void {
    var it = parent.childrenIterator();
    while (it.next()) |child| {
        try deep(child, opts, writer, frame);
    }
}

pub fn toJSON(node: *Node, writer: *std.json.Stringify) !void {
    try writer.beginObject();

    try writer.objectField("type");
    switch (node.type) {
        .cdata => {
            try writer.write("cdata");
        },
        .document => {
            try writer.write("document");
        },
        .document_type => {
            try writer.write("document_type");
        },
        .element => |*el| {
            try writer.write("element");
            try writer.objectField("tag");
            try writer.write(el.tagName());

            try writer.objectField("attributes");
            try writer.beginObject();
            var it = el.attributeIterator();
            while (it.next()) |attr| {
                try writer.objectField(attr.name);
                try writer.write(attr.value);
            }
            try writer.endObject();
        },
    }

    try writer.objectField("children");
    try writer.beginArray();
    var it = node.childrenIterator();
    while (it.next()) |child| {
        try toJSON(child, writer);
    }
    try writer.endArray();
    try writer.endObject();
}

fn dumpSlotContent(slot: *Slot, opts: Opts, writer: *std.Io.Writer, frame: *Frame) !void {
    const assigned = slot.assignedNodes(null, frame) catch return;

    if (assigned.len > 0) {
        for (assigned) |assigned_node| {
            try _deep(assigned_node, opts, true, writer, frame);
        }
    } else {
        try children(slot.asNode(), opts, writer, frame);
    }
}

fn isVoidElement(el: *const Node.Element) bool {
    return switch (el._type) {
        .html => |html| switch (html._type) {
            .br, .hr, .img, .input, .link, .meta => true,
            else => false,
        },
        .svg => false,
    };
}

fn shouldStripElement(el: *const Node.Element, opts: Opts) bool {
    const tag_name = el.getTagNameDump();

    if (opts.strip.js) {
        if (std.mem.eql(u8, tag_name, "script")) return true;
        if (std.mem.eql(u8, tag_name, "noscript")) return true;

        if (std.mem.eql(u8, tag_name, "link")) {
            if (el.getAttributeSafe(comptime .wrap("as"))) |as| {
                if (std.mem.eql(u8, as, "script")) return true;
            }
            if (el.getAttributeSafe(comptime .wrap("rel"))) |rel| {
                if (std.mem.eql(u8, rel, "modulepreload") or std.mem.eql(u8, rel, "preload")) {
                    if (el.getAttributeSafe(comptime .wrap("as"))) |as| {
                        if (std.mem.eql(u8, as, "script")) return true;
                    }
                }
            }
        }
    }

    if (opts.strip.css or opts.strip.ui) {
        if (std.mem.eql(u8, tag_name, "style")) return true;

        if (std.mem.eql(u8, tag_name, "link")) {
            if (el.getAttributeSafe(comptime .wrap("rel"))) |rel| {
                if (std.mem.eql(u8, rel, "stylesheet")) return true;
            }
        }
    }

    if (opts.strip.ui) {
        if (std.mem.eql(u8, tag_name, "img")) return true;
        if (std.mem.eql(u8, tag_name, "picture")) return true;
        if (std.mem.eql(u8, tag_name, "video")) return true;
        if (std.mem.eql(u8, tag_name, "audio")) return true;
        if (std.mem.eql(u8, tag_name, "svg")) return true;
        if (std.mem.eql(u8, tag_name, "canvas")) return true;
        if (std.mem.eql(u8, tag_name, "iframe")) return true;
    }

    return false;
}

fn shouldEscapeText(node_: ?*Node) bool {
    const node = node_ orelse return true;
    if (node.is(Node.Element.Html.Script) != null) {
        return false;
    }
    // When scripting is enabled, <noscript> is a raw text element per the HTML spec
    // (https://html.spec.whatwg.org/multipage/parsing.html#serialising-html-fragments).
    // Its text content must not be HTML-escaped during serialization.
    if (node.is(Node.Element.Html.Generic)) |generic| {
        if (generic._tag == .noscript) return false;
    }
    return true;
}
fn writeEscapedText(text: []const u8, writer: *std.Io.Writer) !void {
    // Fast path: if no special characters, write directly
    const first_special = std.mem.indexOfAnyPos(u8, text, 0, &.{ '&', '<', '>', 194 }) orelse {
        return writer.writeAll(text);
    };

    try writer.writeAll(text[0..first_special]);
    var remaining = try writeEscapedByte(text, first_special, writer);

    while (std.mem.indexOfAnyPos(u8, remaining, 0, &.{ '&', '<', '>', 194 })) |offset| {
        try writer.writeAll(remaining[0..offset]);
        remaining = try writeEscapedByte(remaining, offset, writer);
    }

    if (remaining.len > 0) {
        try writer.writeAll(remaining);
    }
}

fn writeEscapedByte(input: []const u8, index: usize, writer: *std.Io.Writer) ![]const u8 {
    switch (input[index]) {
        '&' => try writer.writeAll("&amp;"),
        '<' => try writer.writeAll("&lt;"),
        '>' => try writer.writeAll("&gt;"),
        194 => {
            // non breaking space
            if (input.len > index + 1 and input[index + 1] == 160) {
                try writer.writeAll("&nbsp;");
                return input[index + 2 ..];
            }
            try writer.writeByte(194);
        },
        else => unreachable,
    }
    return input[index + 1 ..];
}
