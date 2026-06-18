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
const builtin = @import("builtin");

const Element = @import("../dom/Element.zig");
const IFrame = @import("../webapi/element/html/IFrame.zig");
const Frame = @import("Frame.zig");
const Node = @import("../dom/Node.zig");
const interactive = @import("interactive.zig");
const log = @import("../../support/log.zig");
const MouseEvent = @import("../webapi/event/MouseEvent.zig");
const PointerEvent = @import("../webapi/event/PointerEvent.zig");
const String = @import("../../support/string.zig").String;

const IS_DEBUG = builtin.mode == .Debug;

const primary_button_mask: u16 = 1;
const default_ready_timeout_ms: u32 = 15_000;
const nearest_activation_max_dist: f64 = 200.0;

/// Browser-style pointer activation at viewport coordinates in `root_frame`.
pub fn dispatchPointerClick(root_frame: *Frame, x: f64, y: f64) !void {
    const hit = (try waitForActivationHit(root_frame, x, y, default_ready_timeout_ms)) orelse return;
    try dispatchActivationOnTarget(hit);
}

/// Activate a known element (MCP/CDP node click) without re-hit-testing.
pub fn dispatchActivationOnElement(element: *Element, frame: *Frame) !void {
    const hit = makeHitForElement(element, frame);
    try dispatchActivationOnTarget(hit);
}

/// Press half of a primary-button activation (CDP `mousePressed`).
pub fn dispatchPointerDownAt(root_frame: *Frame, x: f64, y: f64) !void {
    const hit = (try waitForActivationHit(root_frame, x, y, default_ready_timeout_ms)) orelse return;
    root_frame._input_press_hit = hit;
    try dispatchPointerOver(hit);
    try dispatchPointerDown(hit);
}

/// Release half of a primary-button activation (CDP `mouseReleased`).
pub fn dispatchPointerUpAt(root_frame: *Frame, x: f64, y: f64) !void {
    const hit = root_frame._input_press_hit orelse (try waitForActivationHit(root_frame, x, y, default_ready_timeout_ms)) orelse return;
    root_frame._input_press_hit = null;
    try dispatchPointerUpAndClick(hit);
}

pub fn makeHitForElement(element: *Element, frame: *Frame) Frame.InputHit {
    return centerHitOnElement(.{
        .element = element,
        .frame = frame,
        .client_x = 0,
        .client_y = 0,
    });
}

fn dispatchActivationOnTarget(hit: Frame.InputHit) !void {
    try dispatchPointerOver(hit);
    try dispatchPointerDown(hit);
    try dispatchPointerUpAndClick(hit);
}

fn waitForActivationHit(root_frame: *Frame, x: f64, y: f64, timeout_ms: u32) !?Frame.InputHit {
    var timer = try std.time.Timer.start();
    var runner = try root_frame._session.runner(.{});

    while (true) {
        if (try resolveHitOnce(root_frame, x, y)) |hit| {
            if (isActionableHit(hit, root_frame)) {
                logActivation(hit);
                return hit;
            }
        }

        const elapsed: u32 = @intCast(timer.read() / std.time.ns_per_ms);
        if (elapsed >= timeout_ms) {
            if (try resolveHitOnce(root_frame, x, y)) |hit| {
                logActivation(hit);
                return hit;
            }
            return null;
        }

        _ = try runner.tick(.{ .ms = 50 });
        std.Thread.sleep(10 * std.time.ns_per_ms);
    }
}

fn resolveHitOnce(root_frame: *Frame, x: f64, y: f64) !?Frame.InputHit {
    const raw = (try root_frame.hitTestForInput(x, y)) orelse return null;
    const pierced_iframe = raw.element.getTag() == .iframe or raw.frame != root_frame;
    const refined = try refineInputHit(raw);
    if (pierced_iframe and refined.frame == root_frame and refined.element.getTag() != .iframe) {
        return null;
    }
    return refined;
}

fn isActionableHit(hit: Frame.InputHit, root_frame: *Frame) bool {
    _ = root_frame;
    if (isStructuralContainer(hit.element)) return false;
    return isActivationTarget(hit.element, hit.frame);
}

fn logActivation(hit: Frame.InputHit) void {
    log.info(.frame, "input activation", .{
        .frame_url = hit.frame.url,
        .tag = hit.element.getTag(),
        .role = hit.element.getAttributeSafe(comptime .wrap("role")),
        .id = hit.element.getAttributeSafe(comptime .wrap("id")),
        .x = hit.client_x,
        .y = hit.client_y,
    });
    if (comptime IS_DEBUG) {
        log.debug(.frame, "input hit resolved", .{
            .url = hit.frame.url,
            .node = hit.element,
            .x = hit.client_x,
            .y = hit.client_y,
        });
    }
}

fn refineInputHit(hit: Frame.InputHit) !Frame.InputHit {
    if (hit.element.getTag() == .iframe) {
        if (try refineIframeHit(hit)) |child_hit| return child_hit;
        return hit;
    }

    if (isActivationTarget(hit.element, hit.frame) and !isStructuralContainer(hit.element)) {
        return centerHitOnElement(hit);
    }

    if (try findBestActivationTarget(hit.frame, hit.client_x, hit.client_y)) |better| {
        return centerHitOnElement(.{
            .element = better,
            .frame = hit.frame,
            .client_x = hit.client_x,
            .client_y = hit.client_y,
        });
    }

    return hit;
}

fn refineIframeHit(hit: Frame.InputHit) !?Frame.InputHit {
    const iframe = hit.element.asNode().is(IFrame) orelse return null;
    const child_window = iframe._window orelse return null;
    const child_frame = child_window._frame;
    if (child_frame._load_state == .waiting or child_frame._load_state == .parsing) {
        return null;
    }

    const rect = hit.element.getBoundingClientRectForVisible(hit.frame);
    const child_x = hit.client_x - rect.getLeft();
    const child_y = hit.client_y - rect.getTop();

    const better = try findBestActivationTarget(child_frame, child_x, child_y) orelse return null;
    return centerHitOnElement(.{
        .element = better,
        .frame = child_frame,
        .client_x = child_x,
        .client_y = child_y,
    });
}

fn centerHitOnElement(hit: Frame.InputHit) Frame.InputHit {
    const rect = hit.element.getBoundingClientRectForVisible(hit.frame);
    if (rect.getWidth() <= 0 and rect.getHeight() <= 0) return hit;
    return .{
        .element = hit.element,
        .frame = hit.frame,
        .client_x = rect.getLeft() + @max(rect.getWidth(), 1) / 2,
        .client_y = rect.getTop() + @max(rect.getHeight(), 1) / 2,
    };
}

fn isStructuralContainer(element: *Element) bool {
    return switch (element.getTag()) {
        .html, .body, .iframe => true,
        else => false,
    };
}

fn isActivationTarget(element: *Element, frame: *Frame) bool {
    if (isStructuralContainer(element)) return false;

    const html_el = element.is(Element.Html) orelse return false;

    switch (element.getTag()) {
        .button, .summary, .details, .select, .textarea => return true,
        .anchor, .area => return element.getAttributeSafe(comptime .wrap("href")) != null,
        .input => {
            if (element.is(Element.Html.Input)) |input| {
                return input._input_type != .hidden;
            }
            return false;
        },
        else => {},
    }

    if (element.getAttributeSafe(comptime .wrap("role"))) |role| {
        if (interactive.isInteractiveRole(role)) return true;
    }

    // iframe tabindex defaults to 0 but activation must pierce into the child frame.
    if (html_el.getTabIndex() >= 0 and element.getTag() != .iframe) return true;

    _ = frame;
    return false;
}

fn findBestActivationTarget(frame: *Frame, x: f64, y: f64) !?*Element {
    if (findInteractiveElementAt(frame, x, y)) |el| return el;
    if (findNearestInteractiveElement(frame, x, y)) |el| return el;
    return findSmallestActivationTarget(frame);
}

fn walkElements(frame: *Frame, cb: *const fn (*Element, *Frame, *anyopaque) void, ctx: *anyopaque) void {
    const root = frame.document.asNode();
    var stack: std.ArrayList(*Node) = .empty;
    stack.append(frame.call_arena, root) catch return;

    while (stack.items.len > 0) {
        const node = stack.pop() orelse break;
        if (node.is(Element)) |element| {
            cb(element, frame, ctx);
        }

        var child = node.lastChild();
        while (child) |c| {
            stack.append(frame.call_arena, c) catch {};
            child = c.previousSibling();
        }
    }
}

const CollectInteractiveCtx = struct {
    x: f64,
    y: f64,
    best: ?*Element = null,
    best_area: f64 = std.math.inf(f64),
};

fn collectInteractiveAt(element: *Element, frame: *Frame, ctx_ptr: *anyopaque) void {
    const ctx: *CollectInteractiveCtx = @ptrCast(@alignCast(ctx_ptr));
    if (!element.checkVisibilityCached(null, frame)) return;
    if (!isActivationTarget(element, frame)) return;

    const rect = element.getBoundingClientRectForVisible(frame);
    const w = @max(rect.getWidth(), 0);
    const h = @max(rect.getHeight(), 0);
    if (w <= 0 or h <= 0) return;

    if (ctx.x < rect.getLeft() or ctx.x > rect.getRight() or
        ctx.y < rect.getTop() or ctx.y > rect.getBottom())
    {
        return;
    }

    const area = w * h;
    if (area < ctx.best_area) {
        ctx.best = element;
        ctx.best_area = area;
    }
}

fn findInteractiveElementAt(frame: *Frame, x: f64, y: f64) ?*Element {
    var ctx = CollectInteractiveCtx{ .x = x, .y = y };
    walkElements(frame, collectInteractiveAt, &ctx);
    return ctx.best;
}

const NearestInteractiveCtx = struct {
    x: f64,
    y: f64,
    best: ?*Element = null,
    best_dist: f64 = std.math.inf(f64),
};

fn collectNearestInteractive(element: *Element, frame: *Frame, ctx_ptr: *anyopaque) void {
    const ctx: *NearestInteractiveCtx = @ptrCast(@alignCast(ctx_ptr));
    if (!element.checkVisibilityCached(null, frame)) return;
    if (!isActivationTarget(element, frame)) return;

    const rect = element.getBoundingClientRectForVisible(frame);
    const w = @max(rect.getWidth(), 1);
    const h = @max(rect.getHeight(), 1);
    const cx = rect.getLeft() + w / 2;
    const cy = rect.getTop() + h / 2;
    const dx = ctx.x - cx;
    const dy = ctx.y - cy;
    const dist = @sqrt(dx * dx + dy * dy);
    if (dist > nearest_activation_max_dist) return;

    if (dist < ctx.best_dist) {
        ctx.best = element;
        ctx.best_dist = dist;
    }
}

fn findNearestInteractiveElement(frame: *Frame, x: f64, y: f64) ?*Element {
    var ctx = NearestInteractiveCtx{ .x = x, .y = y };
    walkElements(frame, collectNearestInteractive, &ctx);
    return ctx.best;
}

const SmallestActivationCtx = struct {
    best: ?*Element = null,
    best_area: f64 = std.math.inf(f64),
};

fn collectSmallestActivation(element: *Element, frame: *Frame, ctx_ptr: *anyopaque) void {
    const ctx: *SmallestActivationCtx = @ptrCast(@alignCast(ctx_ptr));
    if (!element.checkVisibilityCached(null, frame)) return;
    if (!isActivationTarget(element, frame)) return;

    const rect = element.getBoundingClientRectForVisible(frame);
    const area = @max(rect.getWidth(), 1) * @max(rect.getHeight(), 1);
    if (area < ctx.best_area) {
        ctx.best = element;
        ctx.best_area = area;
    }
}

fn findSmallestActivationTarget(frame: *Frame) ?*Element {
    var ctx = SmallestActivationCtx{};
    walkElements(frame, collectSmallestActivation, &ctx);
    return ctx.best;
}

fn dispatchPointerOver(hit: Frame.InputHit) !void {
    const base = baseEventOpts(hit);

    try dispatchPointerEvent(hit, comptime .wrap("pointerover"), base, 0.0);
    try dispatchPointerEvent(hit, comptime .wrap("pointerenter"), .{
        .bubbles = false,
        .cancelable = false,
        .composed = false,
        .clientX = base.clientX,
        .clientY = base.clientY,
        .button = base.button,
        .buttons = 0,
    }, 0.0);
    try dispatchMouseEvent(hit, comptime .wrap("mouseover"), base);
    try dispatchMouseEvent(hit, comptime .wrap("mouseenter"), .{
        .bubbles = false,
        .cancelable = false,
        .composed = false,
        .clientX = base.clientX,
        .clientY = base.clientY,
        .button = base.button,
        .buttons = 0,
    });
}

fn dispatchPointerDown(hit: Frame.InputHit) !void {
    if (shouldFocusOnActivation(hit.element, hit.frame)) {
        hit.element.focus(hit.frame) catch {};
    }

    const base = baseEventOpts(hit);
    var down_opts = base;
    down_opts.buttons = primary_button_mask;

    try dispatchPointerEvent(hit, comptime .wrap("pointerdown"), down_opts, 0.5);
    try dispatchMouseEvent(hit, comptime .wrap("mousedown"), down_opts);
}

fn dispatchPointerUpAndClick(hit: Frame.InputHit) !void {
    const base = baseEventOpts(hit);
    var up_opts = base;
    up_opts.buttons = 0;

    try dispatchPointerEvent(hit, comptime .wrap("pointerup"), up_opts, 0.0);
    try dispatchMouseEvent(hit, comptime .wrap("mouseup"), up_opts);

    var click_opts = base;
    click_opts.detail = 1;
    try dispatchMouseEvent(hit, comptime .wrap("click"), click_opts);
}

fn baseEventOpts(hit: Frame.InputHit) MouseEvent.Options {
    return .{
        .bubbles = true,
        .cancelable = true,
        .composed = true,
        .clientX = hit.client_x,
        .clientY = hit.client_y,
        .screenX = hit.client_x,
        .screenY = hit.client_y,
        .button = 0,
        .buttons = 0,
    };
}

fn shouldFocusOnActivation(element: *Element, frame: *Frame) bool {
    if (element.getAttributeSafe(comptime .wrap("disabled")) != null) return false;
    const html_el = element.is(Element.Html) orelse return false;
    if (html_el.getTabIndex() >= 0) return true;
    if (element.getAttributeSafe(comptime .wrap("role"))) |role| {
        if (interactive.isInteractiveRole(role)) return true;
    }
    _ = frame;
    return false;
}

fn dispatchMouseEvent(hit: Frame.InputHit, typ: String, opts: MouseEvent.Options) !void {
    const mouse_event = try MouseEvent.initTrusted(typ, opts, hit.frame);
    try hit.frame._event_manager.dispatch(hit.element.asEventTarget(), mouse_event.asEvent());
}

fn dispatchPointerEvent(
    hit: Frame.InputHit,
    typ: String,
    base: MouseEvent.Options,
    pressure: f64,
) !void {
    const opts = PointerEvent.Options{
        .bubbles = base.bubbles,
        .cancelable = base.cancelable,
        .composed = base.composed,
        .clientX = base.clientX,
        .clientY = base.clientY,
        .screenX = base.screenX,
        .screenY = base.screenY,
        .button = base.button,
        .buttons = base.buttons,
        .pointerId = 1,
        .pointerType = "mouse",
        .isPrimary = true,
        .pressure = pressure,
    };
    const pointer_event = try PointerEvent.initTrusted(typ, opts, hit.frame);
    try hit.frame._event_manager.dispatch(hit.element.asEventTarget(), pointer_event.asEvent());
}

const testing = @import("../../testing/testing.zig");
const Document = @import("../dom/Document.zig");

test "InputController: checkbox activation focuses target" {
    const frame = try testing.test_session.createPage();
    defer testing.test_session.removePage();

    const doc = frame.document;
    const html_doc = doc.is(Document.HTMLDocument).?;
    const body = html_doc.getBody().?;
    try frame.parseHtmlAsChildren(body.asNode(),
        \\<div id="cb" role="checkbox" tabindex="0" style="width:28px;height:28px;position:absolute;left:10px;top:10px"></div>
    );

    const cb = doc.getElementById("cb", frame).?;
    try dispatchActivationOnElement(cb, frame);

    try testing.expect(frame.document._active_element != null);
    try testing.expect(frame.document._active_element.? == cb);
}

test "InputController: refines html container to checkbox child" {
    const frame = try testing.test_session.createPage();
    defer testing.test_session.removePage();

    const doc = frame.document;
    const html_doc = doc.is(Document.HTMLDocument).?;
    const body = html_doc.getBody().?;
    try frame.parseHtmlAsChildren(body.asNode(),
        \\<div id="cb" role="checkbox" tabindex="0" style="width:28px;height:28px;position:absolute;left:10px;top:10px"></div>
    );

    const html_el = doc.getDocumentElement().?;
    const hit = try refineInputHit(.{
        .element = html_el,
        .frame = frame,
        .client_x = 24,
        .client_y = 24,
    });

    try testing.expectEqualStrings("cb", hit.element.getAttributeSafe(comptime .wrap("id")).?);
    try testing.expect(isActivationTarget(hit.element, frame));
}
