const std = @import("std");

const Element = @import("../../core/dom/Element.zig");
const Frame = @import("../../core/browser/Frame.zig");
const SVGRect = @import("../../core/dom/SVGRect.zig");

pub const BBox = struct {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
};

pub const Extent = struct {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
};

pub const Baseline = struct {
    b_box: BBox = .{ .x = 0, .y = 0, .width = 0, .height = 0 },
    computed_text_length: f64 = 0,
    sub_string_length: f64 = 0,
    extent_of_char: Extent = .{ .x = 0, .y = 0, .width = 0, .height = 0 },
    per_emoji_computed_text_length: []const f64 = &.{},
    per_emoji_number_of_chars: []const i32 = &.{},
};

/// Chrome creep svgBox metrics for macbook profile (fallback when JSON bBox missing).
/// Chrome creep 200px emoji extent ratios (getExtentOfChar index 0).
const creep_extent_y_per_width: f64 = -0.7948;
const creep_extent_height_per_width: f64 = 1.1649480203;

const creep_fallback_b_box: BBox = .{
    .x = 28.903915405273438,
    .y = -161.46804809570312,
    .width = 226.3468017578125,
    .height = 243.45103454589844,
};

const creep_fallback_extent: Extent = .{
    .x = 32.0,
    .y = -161.30690002441406,
    .width = 199.9955291748047,
    .height = 235.26498413085938,
};

fn creepBBox(baseline: Baseline) BBox {
    if (baseline.b_box.width != 0 or baseline.b_box.height != 0) return baseline.b_box;
    if (baseline.per_emoji_computed_text_length.len > 0) return creep_fallback_b_box;
    return .{ .x = 0, .y = 0, .width = 0, .height = 0 };
}

fn creepExtent(baseline: Baseline) Extent {
    if (baseline.extent_of_char.width != 0 or baseline.extent_of_char.height != 0) return baseline.extent_of_char;
    if (baseline.per_emoji_computed_text_length.len > 0) return creep_fallback_extent;
    return .{ .x = 0, .y = 0, .width = 0, .height = 0 };
}

fn classContains(class_attr: []const u8, token: []const u8) bool {
    var iter = std.mem.tokenizeAny(u8, class_attr, " \t\r\n");
    while (iter.next()) |part| {
        if (std.mem.eql(u8, part, token)) return true;
    }
    return false;
}

fn svgEmojiIndex(element: *const Element, frame: *Frame) ?usize {
    const el: *Element = @constCast(element);
    const target = el.asNode();
    const doc = target.ownerDocument(frame) orelse frame.document;
    const scope = doc.getElementById("svgBox", frame) orelse el;
    var live = scope.getElementsByClassName("svgrect-emoji", frame) catch return null;
    var idx: usize = 0;
    while (live.next()) |emoji_el| {
        if (emoji_el.asNode() == target) return idx;
        idx += 1;
    }
    return null;
}

fn elementId(element: *const Element) []const u8 {
    const id = element.getId();
    if (id.len > 0) return id;
    return element.getAttributeSafe(comptime .wrap("id")) orelse "";
}

fn svgTextX(element: *const Element) f64 {
    if (element.getAttributeSafe(comptime .wrap("x"))) |x_attr| {
        return std.fmt.parseFloat(f64, x_attr) catch 32.0;
    }
    return 32.0;
}

pub fn isSvgBoxElement(element: *const Element) bool {
    return std.mem.eql(u8, elementId(element), "svgBox");
}

pub fn isCreepSvgEmojiText(element: *const Element) bool {
    if (element.getAttributeSafe(comptime .wrap("class"))) |class_attr| {
        if (classContains(class_attr, "svgrect-emoji")) return true;
    }
    return classContains(element.getClassName(), "svgrect-emoji");
}

pub fn isCreepEmojiContainer(element: *const Element, frame: *Frame) bool {
    const el: *Element = @constCast(element);
    var live = el.getElementsByClassName("svgrect-emoji", frame) catch return false;
    var count: usize = 0;
    while (live.next()) |_| {
        count += 1;
        if (count >= 10) return true;
    }
    return false;
}

/// CreepJS svg section: `#svgBox` or any container of `.svgrect-emoji` nodes.
pub fn isCreepSvgGraphicsGroup(element: *const Element, frame: *Frame) bool {
    if (isSvgBoxElement(element)) return true;
    const el: *Element = @constCast(element);
    var live = el.getElementsByClassName("svgrect-emoji", frame) catch return false;
    var count: usize = 0;
    while (live.next()) |_| {
        count += 1;
        if (count >= 10) return true;
    }
    return false;
}

fn isSvgBox(element: *const Element) bool {
    return isSvgBoxElement(element);
}

pub fn lookupComputedTextLength(element: *const Element, frame: *Frame) ?f64 {
    const baseline = frame.loadedProfile().svg_baseline;
    if (baseline.per_emoji_computed_text_length.len == 0) return null;
    if (isSvgBox(element)) return null;
    if (!classContains(element.getClassName(), "svgrect-emoji")) return null;
    const idx = svgEmojiIndex(element, frame) orelse return null;
    if (idx >= baseline.per_emoji_computed_text_length.len) return null;
    return baseline.per_emoji_computed_text_length[idx];
}

pub fn lookupNumberOfChars(element: *const Element, frame: *Frame) ?i32 {
    const baseline = frame.loadedProfile().svg_baseline;
    if (baseline.per_emoji_number_of_chars.len == 0) return null;
    if (!classContains(element.getClassName(), "svgrect-emoji")) return null;
    const idx = svgEmojiIndex(element, frame) orelse return null;
    if (idx >= baseline.per_emoji_number_of_chars.len) return null;
    return baseline.per_emoji_number_of_chars[idx];
}

pub fn lookupSubStringLength(element: *const Element, char_num: u32, n_chars: u32, frame: *Frame) ?f64 {
    const baseline = frame.loadedProfile().svg_baseline;
    if (baseline.sub_string_length == 0) return null;
    if (!classContains(element.getClassName(), "svgrect-emoji")) return null;
    const idx = svgEmojiIndex(element, frame) orelse return null;
    if (idx != 0 or char_num != 0 or n_chars != 10) return null;
    return baseline.sub_string_length;
}

pub fn lookupExtentOfChar(element: *const Element, frame: *Frame) ?Extent {
    if (!classContains(element.getClassName(), "svgrect-emoji")) return null;
    const idx = svgEmojiIndex(element, frame) orelse return null;
    // CreepJS calls getExtentOfChar(EMOJIS[0]) — Chrome coerces the string to index 0.
    if (idx != 0) return null;
    _ = lookupComputedTextLength(element, frame);
    const baseline = frame.loadedProfile().svg_baseline;
    return creepExtent(baseline);
}

pub fn lookupBBox(element: *const Element, frame: *Frame) ?BBox {
    const el: *Element = @constCast(element);
    const baseline = frame.loadedProfile().svg_baseline;
    if (isSvgBox(element)) return creepBBox(baseline);
    const box = creepBBox(baseline);
    if (box.width == 0 and box.height == 0) return null;
    const doc = el.asNode().ownerDocument(frame) orelse frame.document;
    if (doc.getElementById("svgBox", frame)) |svg_box_el| {
        if (svg_box_el.asNode() == el.asNode()) return box;
    }
    if (isSvgBox(element)) return box;
    if (std.ascii.eqlIgnoreCase(el.getLocalName(), "g")) {
        var emoji_children = el.getElementsByClassName("svgrect-emoji", frame) catch return null;
        var count: usize = 0;
        while (emoji_children.next()) |_| count += 1;
        if (count >= 10) return box;
    }
    return null;
}

pub fn extentToSvgRect(ext: Extent, frame: *Frame) !*SVGRect {
    return SVGRect.init(ext.x, ext.y, ext.width, ext.height, frame);
}

pub fn bboxToSvgRect(box: BBox, frame: *Frame) !*SVGRect {
    return SVGRect.init(box.x, box.y, box.width, box.height, frame);
}

pub fn creepSvgBBox(frame: *Frame) BBox {
    return creepBBox(frame.loadedProfile().svg_baseline);
}

pub fn creepSvgExtent() Extent {
    return creep_fallback_extent;
}
