//
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
const Parser = @import("../parser/Parser.zig");

const HTMLDocument = @import("../webapi/HTMLDocument.zig");
const XMLDocument = @import("../webapi/XMLDocument.zig");
const Document = @import("Document.zig");

const DOMParser = @This();

// Padding to avoid zero-size struct, which causes identity_map pointer collisions.
_pad: bool = false,

pub fn init() DOMParser {
    return .{};
}

fn isXmlNameChar(c: u8) bool {
    return std.ascii.isAlphanumeric(c) or c == '_' or c == ':' or c == '-' or c == '.';
}

/// xml5ever builds the XML tree and reports callback failures, but malformed
/// markup is not exposed as a parser error through the current C ABI.  Keep
/// the DOMParser boundary strict with a small well-formedness pass; this is
/// only validation, while xml5ever remains the actual XML parser.
fn isWellFormedXml(xml: []const u8) bool {
    var stack: [128][]const u8 = undefined;
    var depth: usize = 0;
    var i: usize = 0;
    while (i < xml.len) {
        if (xml[i] != '<') {
            i += 1;
            continue;
        }
        if (std.mem.startsWith(u8, xml[i..], "<!--")) {
            const end = std.mem.indexOfPos(u8, xml, i + 4, "-->") orelse return false;
            i = end + 3;
            continue;
        }
        if (std.mem.startsWith(u8, xml[i..], "<![CDATA[")) {
            const end = std.mem.indexOfPos(u8, xml, i + 9, "]]>") orelse return false;
            i = end + 3;
            continue;
        }
        if (std.mem.startsWith(u8, xml[i..], "<?")) {
            const end = std.mem.indexOfPos(u8, xml, i + 2, "?>") orelse return false;
            i = end + 2;
            continue;
        }
        if (std.mem.startsWith(u8, xml[i..], "<!")) {
            var quote: u8 = 0;
            i += 2;
            while (i < xml.len) : (i += 1) {
                if (quote != 0) {
                    if (xml[i] == quote) quote = 0;
                } else if (xml[i] == '\'' or xml[i] == '"') {
                    quote = xml[i];
                } else if (xml[i] == '>') {
                    i += 1;
                    break;
                }
            }
            if (quote != 0) return false;
            continue;
        }

        const closing = i + 1 < xml.len and xml[i + 1] == '/';
        var name_start = i + @as(usize, if (closing) 2 else 1);
        if (name_start >= xml.len or !isXmlNameChar(xml[name_start])) return false;
        const tag_start = name_start;
        while (name_start < xml.len and isXmlNameChar(xml[name_start])) : (name_start += 1) {}
        const name = xml[tag_start..name_start];

        var quote: u8 = 0;
        var j = name_start;
        var self_closing = false;
        while (j < xml.len) : (j += 1) {
            if (quote != 0) {
                if (xml[j] == quote) quote = 0;
            } else if (xml[j] == '\'' or xml[j] == '"') {
                quote = xml[j];
            } else if (xml[j] == '>') {
                var k = j;
                while (k > name_start and std.ascii.isWhitespace(xml[k - 1])) : (k -= 1) {}
                self_closing = !closing and k > name_start and xml[k - 1] == '/';
                break;
            }
        }
        if (j >= xml.len or quote != 0) return false;
        i = j + 1;
        if (closing) {
            if (self_closing or depth == 0 or !std.mem.eql(u8, stack[depth - 1], name)) return false;
            depth -= 1;
        } else if (!self_closing) {
            if (depth == stack.len) return false;
            stack[depth] = name;
            depth += 1;
        }
    }
    return depth == 0;
}

pub fn parseFromString(
    _: *const DOMParser,
    html: []const u8,
    mime_type: []const u8,
    frame: *Frame,
) !*Document {
    const target_mime = std.meta.stringToEnum(enum {
        @"text/html",
        @"text/xml",
        @"application/xml",
        @"application/xhtml+xml",
        @"image/svg+xml",
    }, mime_type) orelse return error.NotSupported;

    const arena = try frame.getArena(.medium, "DOMParser.parseFromString");
    defer frame.releaseArena(arena);

    return switch (target_mime) {
        .@"text/html" => {
            // Create a new HTMLDocument
            const doc = try frame._factory.document(HTMLDocument{
                ._proto = undefined,
            });

            var normalized = std.mem.trim(u8, html, &std.ascii.whitespace);
            if (normalized.len == 0) {
                normalized = "<html></html>";
            }

            // Parse HTML into the document
            var parser = Parser.init(arena, doc.asNode(), frame);
            parser.parse(normalized);

            if (parser.err) |pe| {
                return pe.err;
            }

            return doc.asDocument();
        },
        else => {
            // Create a new XMLDocument.
            const doc = try frame._factory.document(XMLDocument{
                ._proto = undefined,
            });

            if (!isWellFormedXml(html)) {
                const err_doc = try frame._factory.document(XMLDocument{ ._proto = undefined });
                var err_parser = Parser.init(arena, err_doc.asNode(), frame);
                err_parser.parseXML("<parsererror xmlns=\"http://www.mozilla.org/newlayout/xml/parsererror.xml\">error</parsererror>");
                return err_doc.asDocument();
            }

            // Parse XML into XMLDocument.
            const doc_node = doc.asNode();
            var parser = Parser.init(arena, doc_node, frame);
            parser.parseXML(html);

            if (parser.err != null or doc_node.firstChild() == null) {
                // Return a document with a <parsererror> element per spec.
                const err_doc = try frame._factory.document(XMLDocument{ ._proto = undefined });
                var err_parser = Parser.init(arena, err_doc.asNode(), frame);
                err_parser.parseXML("<parsererror xmlns=\"http://www.mozilla.org/newlayout/xml/parsererror.xml\">error</parsererror>");
                return err_doc.asDocument();
            }

            const first_child = doc_node.firstChild().?;

            // If first node is a `ProcessingInstruction`, skip it.
            if (first_child.getNodeType() == 7) {
                // We're sure that firstChild exist, this cannot fail.
                _ = try doc_node.removeChild(first_child, frame);
            }

            return doc.asDocument();
        },
    };
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(DOMParser);

    pub const Meta = struct {
        pub const name = "DOMParser";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
        pub const empty_with_no_proto = true;
    };

    pub const constructor = bridge.constructor(DOMParser.init, .{});
    pub const parseFromString = bridge.function(DOMParser.parseFromString, .{});
};

const testing = @import("../../testing/testing.zig");
test "WebApi: DOMParser" {
    try testing.htmlRunner("domparser.html", .{});
}
