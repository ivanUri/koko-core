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

const js = @import("../js/js.zig");
const Frame = @import("../browser/Frame.zig");
const Console = @import("Console.zig");
const History = @import("History.zig");
const Navigation = @import("navigation/Navigation.zig");
const Crypto = @import("Crypto.zig");
const CSS = @import("CSS.zig");
const Navigator = @import("Navigator.zig");
const Screen = @import("Screen.zig");
const VisualViewport = @import("VisualViewport.zig");
const Performance = @import("Performance.zig");
const Document = @import("../dom/Document.zig");
const Location = @import("Location.zig");
const Fetch = @import("net/Fetch.zig");
const Event = @import("Event.zig");
const EventTarget = @import("EventTarget.zig");
const ErrorEvent = @import("event/ErrorEvent.zig");
const MessageEvent = @import("event/MessageEvent.zig");
const MessagePort = @import("MessagePort.zig");
const MediaQueryList = @import("css/MediaQueryList.zig");
const storage = @import("storage/storage.zig");
const Element = @import("../dom/Element.zig");
const CSSStyleDeclaration = @import("css/CSSStyleDeclaration.zig");
const CSSStyleProperties = @import("css/CSSStyleProperties.zig");
const CustomElementRegistry = @import("CustomElementRegistry.zig");
const Selection = @import("Selection.zig");
const Timers = @import("Timers.zig");
const Notification = @import("../../runtime/Notification.zig");
const IDBFactory = @import("idb.zig").IDBFactory;
const CacheStorage = @import("cache_storage.zig").CacheStorage;
const SpeechSynthesis = @import("speech/SpeechSynthesis.zig").SpeechSynthesis;
const TrustedTypePolicyFactory = @import("trusted_types.zig").TrustedTypePolicyFactory;
const Chrome = @import("Chrome.zig");
const GoogleCompat = @import("GoogleCompat.zig");

const log = @import("../../support/log.zig");
const IS_DEBUG = builtin.mode == .Debug;

const Allocator = std.mem.Allocator;

pub fn registerTypes() []const type {
    return &.{ Window, CrossOriginWindow };
}

const Window = @This();

_proto: *EventTarget,
_frame: *Frame,
_document: *Document,
_css: CSS = .init,
_crypto: Crypto = .init,
_console: Console = .init,
_navigator: Navigator = .init,
_screen: *Screen,
_visual_viewport: *VisualViewport,
_performance: Performance,
_storage_bucket: storage.Bucket = .{},
_on_load: ?js.Function.Global = null,
_on_pageshow: ?js.Function.Global = null,
_on_popstate: ?js.Function.Global = null,
_on_error: ?js.Function.Global = null,
_on_message: ?js.Function.Global = null,
_pending_post_messages: std.ArrayListUnmanaged(*PostMessageCallback) = .{},
_on_rejection_handled: ?js.Function.Global = null,
_on_unhandled_rejection: ?js.Function.Global = null,
_current_event: ?*Event = null,
_location: *Location,
_chrome: Chrome = .init,
_google: GoogleCompat = .init,
_timers: Timers = .{},
_custom_elements: CustomElementRegistry = .{},
_indexed_db: IDBFactory = .{},
_caches: CacheStorage = .{},
_speech_synthesis: SpeechSynthesis = .{},
_trusted_types: TrustedTypePolicyFactory = .{},
_scroll_pos: struct {
    x: u32,
    y: u32,
    state: enum {
        scroll,
        end,
        done,
    },
} = .{
    .x = 0,
    .y = 0,
    .state = .done,
},
// A cross origin wrapper for this window
_cross_origin_wrapper: CrossOriginWindow,

// The Window that called window.open to create this one. Null for the root
// window, for noopener popups, and cleared if the opener is torn down while
// we're still alive. Only valid if `!_opener.?._closed`.
_opener: ?*Window = null,

// True after our Frame has been deinit'd by window.close. Many things on the
// window become invalid once this is true.
_closed: bool = false,

// Popup name (owned by page.arena)
_name: []const u8 = "",

pub fn asEventTarget(self: *Window) *EventTarget {
    return self._proto;
}

pub fn getEvent(self: *const Window) ?*Event {
    return self._current_event;
}

pub fn getSelf(self: *Window) *Window {
    return self;
}

pub fn getWindow(self: *Window) *Window {
    return self;
}

pub fn getOpener(self: *Window, frame: *Frame) ?Access {
    const opener = self._opener orelse return null;
    if (opener._closed) return null;
    return Access.init(frame.window, opener);
}

pub fn getClosed(self: *const Window) bool {
    return self._closed;
}

pub fn getName(self: *const Window) []const u8 {
    return self._name;
}

pub fn setName(self: *Window, name: []const u8, frame: *Frame) !void {
    // Store in the Page's frame arena so the slice outlives any call_arena.
    self._name = try frame.arena.dupe(u8, name);
}

pub fn getTop(self: *Window, frame: *Frame) Access {
    var p = self._frame;
    while (p.parent) |parent| {
        p = parent;
    }
    return Access.init(frame.window, p.window);
}

pub fn getParent(self: *Window, frame: *Frame) Access {
    if (self._frame.parent) |p| {
        return Access.init(frame.window, p.window);
    }
    return .{ .window = self };
}

pub fn getDocument(self: *Window) *Document {
    return self._document;
}

pub fn getConsole(self: *Window) *Console {
    return &self._console;
}

pub fn getNavigator(self: *Window) *Navigator {
    return &self._navigator;
}

pub fn getScreen(self: *Window) *Screen {
    return self._screen;
}

pub fn getVisualViewport(self: *const Window) *VisualViewport {
    return self._visual_viewport;
}

pub fn getCrypto(self: *Window) *Crypto {
    return &self._crypto;
}

pub fn getCSS(self: *Window) *CSS {
    return &self._css;
}

pub fn getPerformance(self: *Window) *Performance {
    return &self._performance;
}

fn getOriginStorageBucket(self: *Window) *storage.Bucket {
    const frame = self._frame;
    const origin = frame.origin orelse "null";
    return frame._session.storage_shed.getOrPut(
        frame._session.browser.app.allocator,
        origin,
    ) catch {
        return &self._storage_bucket;
    };
}

pub fn getLocalStorage(self: *Window) *storage.Lookup {
    return &self.getOriginStorageBucket().local;
}

pub fn getSessionStorage(self: *Window) *storage.Lookup {
    return &self.getOriginStorageBucket().session;
}

pub fn getOrigin(self: *const Window) []const u8 {
    return self._frame.origin orelse "null";
}

pub fn getSelection(self: *const Window) *Selection {
    return &self._document._selection;
}

pub fn getLocation(self: *const Window) *Location {
    return self._location;
}

pub fn getChrome(self: *Window) ?*Chrome {
    if (self._frame.loadedProfile().isFirefox()) return null;
    return &self._chrome;
}

pub fn getGoogle(self: *Window) ?*GoogleCompat {
    const frame = self._frame;
    if (GoogleCompat.shouldExpose(frame) or GoogleCompat.shouldExposeBootstrap(frame)) {
        self._google.ensureBootstrapDefaults(frame);
        return &self._google;
    }
    return null;
}

pub fn setGoogle(self: *Window, value: js.Value) void {
    self._google.applyPlainObject(value, self._frame);
}

pub fn setLocation(self: *Window, url: [:0]const u8, frame: *Frame) !void {
    return frame.scheduleNavigation(url, .{ .reason = .script, .kind = .{ .push = null } }, .{ .script = self._frame });
}

pub fn getHistory(_: *Window, frame: *Frame) *History {
    return &frame._session.history;
}

pub fn getNavigation(_: *Window, frame: *Frame) *Navigation {
    return &frame._session.navigation;
}

pub fn getCustomElements(self: *Window) *CustomElementRegistry {
    return &self._custom_elements;
}

pub fn getIndexedDB(self: *Window) *IDBFactory {
    return &self._indexed_db;
}

pub fn getCaches(self: *Window) *CacheStorage {
    return &self._caches;
}

pub fn getSpeechSynthesis(self: *Window) *SpeechSynthesis {
    return &self._speech_synthesis;
}

pub fn getTrustedTypes(self: *Window) *TrustedTypePolicyFactory {
    return &self._trusted_types;
}

pub fn getOnLoad(self: *const Window) ?js.Function.Global {
    return self._on_load;
}

pub fn setOnLoad(self: *Window, setter: ?FunctionSetter) void {
    self._on_load = getFunctionFromSetter(setter);
}

pub fn getOnPageShow(self: *const Window) ?js.Function.Global {
    return self._on_pageshow;
}

pub fn setOnPageShow(self: *Window, setter: ?FunctionSetter) void {
    self._on_pageshow = getFunctionFromSetter(setter);
}

pub fn getOnPopState(self: *const Window) ?js.Function.Global {
    return self._on_popstate;
}

pub fn setOnPopState(self: *Window, setter: ?FunctionSetter) void {
    self._on_popstate = getFunctionFromSetter(setter);
}

pub fn getOnError(self: *const Window) ?js.Function.Global {
    return self._on_error;
}

pub fn setOnError(self: *Window, setter: ?FunctionSetter) void {
    self._on_error = getFunctionFromSetter(setter);
}

pub fn getOnMessage(self: *const Window) ?js.Function.Global {
    return self._on_message;
}

pub fn setOnMessage(self: *Window, setter: ?FunctionSetter) void {
    self._on_message = getFunctionFromSetter(setter);
    self.flushPendingPostMessages();
}

/// Deliver window.postMessage events that arrived before any message listener was registered.
pub fn flushPendingPostMessages(self: *Window) void {
    const frame = self._frame;
    const event_target = self.asEventTarget();

    while (self._pending_post_messages.items.len > 0) {
        if (!frame._event_manager.hasDirectListeners(event_target, "message", self._on_message)) {
            break;
        }

        const pending = self._pending_post_messages.orderedRemove(0);
        PostMessageCallback.dispatch(pending) catch |err| {
            log.warn(.browser, "pending postMessage dispatch", .{ .err = err });
            pending.message.release();
            pending.deinit();
            continue;
        };
        pending.deinit();
    }

    frame.scheduleDeferredMacrotaskPump() catch |err| {
        log.warn(.browser, "flush pending postMessage pump", .{ .err = err });
    };
}

fn queuePendingPostMessage(self: *Window, callback: *PostMessageCallback) !void {
    const frame = self._frame;
    const max_pending: usize = 64;
    while (self._pending_post_messages.items.len >= max_pending) {
        const dropped = self._pending_post_messages.orderedRemove(0);
        dropped.message.release();
        dropped.deinit();
    }
    try self._pending_post_messages.append(frame.arena, callback);
}

pub fn getOnRejectionHandled(self: *const Window) ?js.Function.Global {
    return self._on_rejection_handled;
}

pub fn setOnRejectionHandled(self: *Window, setter: ?FunctionSetter) void {
    self._on_rejection_handled = getFunctionFromSetter(setter);
}

pub fn getOnUnhandledRejection(self: *const Window) ?js.Function.Global {
    return self._on_unhandled_rejection;
}

pub fn setOnUnhandledRejection(self: *Window, setter: ?FunctionSetter) void {
    self._on_unhandled_rejection = getFunctionFromSetter(setter);
}

pub fn fetch(_: *const Window, input: Fetch.Input, options: ?Fetch.InitOpts, exec: *const js.Execution) !js.Promise {
    return Fetch.init(input, options, exec);
}

pub fn setTimeout(self: *Window, handler: Timers.LegacyHandler, delay_ms: ?u32, params: []js.Value.Temp, exec: *js.Execution) !u32 {
    const cb = try handler.resolve(exec);
    return self._timers.schedule(exec, cb, delay_ms orelse 0, .{
        .repeat = false,
        .params = params,
        .name = "window.setTimeout",
    });
}

pub fn setInterval(self: *Window, handler: Timers.LegacyHandler, delay_ms: ?u32, params: []js.Value.Temp, exec: *js.Execution) !u32 {
    const cb = try handler.resolve(exec);
    return self._timers.schedule(exec, cb, delay_ms orelse 0, .{
        .repeat = true,
        .params = params,
        .name = "window.setInterval",
    });
}

pub fn setImmediate(self: *Window, cb: js.Function.Temp, params: []js.Value.Temp, exec: *js.Execution) !u32 {
    return self._timers.schedule(exec, cb, 0, .{
        .repeat = false,
        .params = params,
        .name = "window.setImmediate",
    });
}

pub fn requestAnimationFrame(self: *Window, cb: js.Function.Temp, exec: *js.Execution) !u32 {
    return self._timers.schedule(exec, cb, 5, .{
        .repeat = false,
        .params = &.{},
        .mode = .animation_frame,
        .name = "window.requestAnimationFrame",
    });
}

pub fn queueMicrotask(_: *Window, cb: js.Function, frame: *Frame) void {
    frame.js.queueMicrotaskFunc(cb);
}

pub fn clearTimeout(self: *Window, id: u32) void {
    self._timers.clear(id);
}

pub fn clearInterval(self: *Window, id: u32) void {
    self._timers.clear(id);
}

pub fn clearImmediate(self: *Window, id: u32) void {
    self._timers.clear(id);
}

pub fn cancelAnimationFrame(self: *Window, id: u32) void {
    self._timers.clear(id);
}

const RequestIdleCallbackOpts = struct {
    timeout: ?u32 = null,
};
pub fn requestIdleCallback(self: *Window, cb: js.Function.Temp, opts_: ?RequestIdleCallbackOpts, exec: *js.Execution) !u32 {
    const opts = opts_ orelse RequestIdleCallbackOpts{};
    return self._timers.schedule(exec, cb, opts.timeout orelse 50, .{
        .mode = .idle,
        .repeat = false,
        .params = &.{},
        .low_priority = true,
        .name = "window.requestIdleCallback",
    });
}

pub fn cancelIdleCallback(self: *Window, id: u32) void {
    self._timers.clear(id);
}

pub fn reportError(self: *Window, err: js.Value, frame: *Frame) !void {
    const error_event = try ErrorEvent.initTrusted(comptime .wrap("error"), .{
        .@"error" = try err.temp(),
        .message = err.toStringSlice() catch "Unknown error",
        .bubbles = false,
        .cancelable = true,
    }, frame._page);

    // Invoke window.onerror callback if set (per WHATWG spec, this is called
    // with 5 arguments: message, source, lineno, colno, error)
    // If it returns true, the event is cancelled.
    var prevent_default = false;
    if (self._on_error) |on_error| {
        var ls: js.Local.Scope = undefined;
        frame.js.localScope(&ls);
        defer ls.deinit();

        const local_func = ls.toLocal(on_error);
        const result = local_func.call(js.Value, .{
            error_event._message,
            error_event._filename,
            error_event._line_number,
            error_event._column_number,
            err,
        }) catch null;

        // Per spec: returning true from onerror cancels the event
        if (result) |r| {
            prevent_default = r.isTrue();
        }
    }

    const event = error_event.asEvent();
    event._prevent_default = prevent_default;
    // Pass null as handler: onerror was already called above with 5 args.
    // We still dispatch so that addEventListener('error', ...) listeners fire.
    try frame._event_manager.dispatchDirect(self.asEventTarget(), event, null, .{
        .context = "window.reportError",
    });

    if (comptime builtin.is_test == false) {
        if (!event._prevent_default) {
            log.warn(.js, "window.reportError", .{
                .message = error_event._message,
                .filename = error_event._filename,
                .line_number = error_event._line_number,
                .column_number = error_event._column_number,
            });
        }
    }
}

pub fn matchMedia(_: *const Window, query: []const u8, frame: *Frame) !*MediaQueryList {
    return frame._factory.eventTarget(MediaQueryList{
        ._proto = undefined,
        ._media = try frame.dupeString(query),
    });
}

pub fn getComputedStyle(_: *const Window, element: *Element, pseudo_element: ?[]const u8, frame: *Frame) !*CSSStyleDeclaration {
    if (pseudo_element) |pe| {
        if (pe.len != 0) {
            log.warn(.not_implemented, "window.GetComputedStyle", .{ .pseudo_element = pe });
        }
    }
    return CSSStyleDeclaration.init(element, true, frame);
}

// window.open(url?, target?, features?) — v1 scope:
//   * Always creates a new popup Frame on the Page (sibling to the root).
//   * Honors `noopener` / `noreferrer` tokens in `features` (opener=null,
//     return value=null). Geometry (width, height, ...) ignored.
//   * `target` values `_self` / `_parent` / `_top` navigate the current frame.
//     Any other value is treated as a popup name; reusing a live name
//     navigates the existing popup instead of spawning a new one.
//   * `url` empty or missing opens about:blank.
pub fn open(self: *Window, url_: ?[]const u8, target_: ?[]const u8, features_: ?[]const u8, frame: *Frame) !?Access {
    const raw_url = url_ orelse "";
    const target = target_ orelse "";
    const features = features_ orelse "";

    const no_opener = hasFeatureToken(features, "noopener") or hasFeatureToken(features, "noreferrer");

    // _self / _parent / _top navigate the current browsing context.
    if (std.ascii.eqlIgnoreCase(target, "_self") or
        std.ascii.eqlIgnoreCase(target, "_parent") or
        std.ascii.eqlIgnoreCase(target, "_top"))
    {
        const nav_target = frame.resolveTargetFrame(target) orelse frame;
        const nav_url = if (raw_url.len == 0) "about:blank" else raw_url;
        try frame.scheduleNavigation(nav_url, .{
            .reason = .script,
            .kind = .{ .push = null },
        }, .{ .script = nav_target });

        if (no_opener) {
            return null;
        }

        return Access.init(frame.window, nav_target.window);
    }

    const page = frame._page;

    // Name-based reuse: if a popup with this name already exists, reuse it.
    // `_blank` is reserved and never reuses.
    const is_named = target.len > 0 and !std.ascii.eqlIgnoreCase(target, "_blank");
    if (is_named) {
        if (page.findPopupByName(target)) |existing| {
            if (raw_url.len > 0) {
                try existing.scheduleNavigation(raw_url, .{
                    .reason = .script,
                    .kind = .{ .push = null },
                }, .{ .script = existing });
            }
            if (no_opener) {
                return null;
            }
            return Access.init(frame.window, existing.window);
        }
    }

    // Spawn a new popup Frame as a sibling of the root.
    const popup = try frame.openPopup(.{
        .url = raw_url,
        .name = target,
        .opener = if (no_opener) null else self,
    });

    if (no_opener) {
        return null;
    }
    return Access.init(frame.window, popup.window);
}

pub fn close(self: *Window) void {
    if (self._closed) {
        return;
    }

    // Per spec, close() is only honored on script-opened windows. That
    // maps exactly to membership in page.popups.
    const frame = self._frame;
    const page = frame._page;

    var popup_index: usize = 0;
    while (popup_index < page.popups.items.len) : (popup_index += 1) {
        if (page.popups.items[popup_index] == frame) {
            break;
        }
    } else return;

    self._closed = true;

    // Any live Window holding us as its opener must drop the reference —
    // our Frame is about to go away, and a stale _frame deref on their
    // side would crash.
    for (page.popups.items) |popup| {
        if (popup.window._opener == self) {
            popup.window._opener = null;
        }
    }
    if (page.frame.window._opener == self) {
        page.frame.window._opener = null;
    }

    _ = page.popups.swapRemove(popup_index);

    // Drop any pending queued navigation for this frame. Frame.deinit will
    // release the QueuedNavigation arena, but the entry in page.queued_navigation
    // would otherwise have processQueuedNavigation re-deinit the popup.
    if (frame._queued_navigation != null) {
        for (page.queued_navigation.items, 0..) |f, i| {
            if (f == frame) {
                _ = page.queued_navigation.swapRemove(i);
                break;
            }
        }
    }

    frame.js.scheduler.reset();

    // We can't tear the Frame down here — close() is invoked from JS still
    // running on top of this Frame's V8 context, often deep inside a script
    // eval whose parser is still holding the Frame. Destroying the context
    // now leaves dangling pointers in the unwinding script eval (load event
    // dispatch, runMacrotasks, etc.). Defer to Page.deinit instead.
    page.queued_close.append(page.frame_arena, frame) catch |err| {
        log.err(.frame, "queue popup close", .{ .err = err });
    };
}

pub fn postMessage(self: *Window, message: js.Value.Temp, target_origin: ?[]const u8, transfer: ?[]js.Value, frame: *Frame) !void {
    // For now, we ignore targetOrigin checking and just dispatch the message
    // In a full implementation, we would validate the origin
    _ = target_origin;

    const target_frame = self._frame;
    const source_window = frame.window;

    const arena = try target_frame.getArena(.medium, "Window.postMessage");
    errdefer target_frame.releaseArena(arena);

    const transferred_ports = if (transfer) |list|
        try MessagePort.processTransferList(list, &frame.js.execution, &target_frame.js.execution, arena)
    else
        &[_]*MessagePort{};

    // Clone from the sender realm into the target realm.
    const cloned_message = blk: {
        var source_owned: js.Local.Scope = undefined;
        const source_local: *const js.Local = blk2: {
            if (frame.js.local) |active| break :blk2 active;
            frame.js.localScope(&source_owned);
            break :blk2 &source_owned.local;
        };
        defer if (frame.js.local == null) source_owned.deinit();

        var target_owned: js.Local.Scope = undefined;
        target_frame.js.localScope(&target_owned);
        defer target_owned.deinit();

        const cloned = try message.local(source_local).structuredCloneTo(&target_owned.local);
        break :blk try cloned.temp();
    };

    // Origin should be the source window's origin (where the message came from)
    const origin = try source_window._location.getOrigin(&frame.js.execution);
    const callback = try arena.create(PostMessageCallback);
    callback.* = .{
        .arena = arena,
        .message = cloned_message,
        .ports = transferred_ports,
        .frame = target_frame,
        .source = source_window,
        .origin = try arena.dupe(u8, origin),
    };

    const cross_browsing_context = frame != target_frame;
    // Child → parent must dispatch synchronously so the sender can observe the
    // recipient's reaction before its stack unwinds (reCAPTCHA v3, Turnstile
    // token delivery). Parent → child (Turnstile iframe bootstrap) must wait
    // until the iframe document is complete so internal message routers exist.
    const child_to_parent = cross_browsing_context and frame.parent == target_frame;
    const parent_to_child = cross_browsing_context and target_frame.parent == frame;

    const event_target = target_frame.window.asEventTarget();
    const has_listeners = target_frame._event_manager.hasDirectListeners(
        event_target,
        "message",
        target_frame.window._on_message,
    );

    // Parent → child bootstrap may arrive while the iframe is still parsing. Queue
    // until message routers exist. Do not queue once listeners are registered:
    // Turnstile posts requestExtraParams and expects the extraParams reply on the
    // same synchronous turn even if the iframe document is not yet .complete.
    if (parent_to_child and target_frame._load_state != .complete and !has_listeners) {
        try target_frame.window.queuePendingPostMessage(callback);
        return;
    }

    // Parent → child must be synchronous once the iframe is ready, but not while
    // the target is still inside an outbound postMessage (reentrant delivery).
    // Turnstile posts requestExtraParams, the parent replies with extraParams, and
    // running that handler before the child's stack unwinds leaves bootstrap globals
    // (e.g. Wuby5) undefined → TypeError reading '.call'.
    const defer_parent_reply = parent_to_child and target_frame.js.call_depth > 0;
    const sync_dispatch = transferred_ports.len > 0 or child_to_parent or
        (parent_to_child and !defer_parent_reply);

    if (defer_parent_reply) {
        try schedulePostMessageDelivery(target_frame, callback);
        return;
    }

    if (sync_dispatch) {
        if (!has_listeners) {
            target_frame.window.queuePendingPostMessage(callback) catch |err| {
                log.warn(.browser, "queue pending postMessage", .{ .err = err });
                callback.message.release();
                callback.deinit();
            };
            return;
        }

        PostMessageCallback.dispatch(callback) catch |err| {
            log.warn(.browser, "postMessage dispatch", .{ .err = err });
            callback.message.release();
            callback.deinit();
            return;
        };
        callback.deinit();
        return;
    }

    try schedulePostMessageDelivery(target_frame, callback);
}

fn schedulePostMessageDelivery(target_frame: *Frame, callback: *PostMessageCallback) !void {
    try target_frame.js.scheduler.add(callback, PostMessageCallback.run, 0, .{
        .name = "postMessage",
        .low_priority = false,
        .finalizer = PostMessageCallback.cancelled,
    });

    target_frame.scheduleDeferredMacrotaskPump() catch |err| {
        log.warn(.browser, "postMessage pump", .{ .err = err });
    };
}

pub fn btoa(_: *const Window, input: js.String.OneByte, frame: *Frame) ![]const u8 {
    return @import("encoding/base64.zig").encode(frame.call_arena, input.bytes);
}

pub fn atob(_: *const Window, input: js.String.OneByte, frame: *Frame) !js.String.OneByte {
    const bytes = try @import("encoding/base64.zig").decode(frame.call_arena, input.bytes);
    return .{ .bytes = bytes };
}

pub fn structuredClone(_: *const Window, value: js.Value) !js.Value {
    return value.structuredClone();
}

pub fn getFrame(self: *Window, idx: usize) !?*Window {
    const frame = self._frame;
    const frames = frame.child_frames.items;
    if (idx >= frames.len) {
        return null;
    }

    if (frame.child_frames_sorted == false) {
        std.mem.sort(*Frame, frames, {}, struct {
            fn lessThan(_: void, a: *Frame, b: *Frame) bool {
                const iframe_a = a.iframe orelse return false;
                const iframe_b = b.iframe orelse return true;

                const pos = iframe_a.asNode().compareDocumentPosition(iframe_b.asNode());
                // Return true if a precedes b (a should come before b in sorted order)
                return (pos & 0x04) != 0; // FOLLOWING bit: b follows a
            }
        }.lessThan);
        frame.child_frames_sorted = true;
    }
    return frames[idx].window;
}

pub fn getFramesLength(self: *const Window) u32 {
    return @intCast(self._frame.child_frames.items.len);
}

pub fn getScrollX(self: *const Window) u32 {
    return self._scroll_pos.x;
}

pub fn getScrollY(self: *const Window) u32 {
    return self._scroll_pos.y;
}

const ScrollToOpts = union(enum) {
    x: i32,
    opts: Opts,

    const Opts = struct {
        top: i32,
        left: i32,
        behavior: []const u8 = "",
    };
};
pub fn scrollTo(self: *Window, opts: ScrollToOpts, y: ?i32, frame: *Frame) !void {
    switch (opts) {
        .x => |x| {
            self._scroll_pos.x = @intCast(@max(x, 0));
            self._scroll_pos.y = @intCast(@max(0, y orelse 0));
        },
        .opts => |o| {
            self._scroll_pos.x = @intCast(@max(0, o.left));
            self._scroll_pos.y = @intCast(@max(0, o.top));
        },
    }

    self._scroll_pos.state = .scroll;

    // We dispatch scroll event asynchronously after 10ms. So we can throttle
    // them.
    try frame.js.scheduler.add(
        frame,
        struct {
            fn dispatch(_frame: *anyopaque) anyerror!?u32 {
                const f: *Frame = @ptrCast(@alignCast(_frame));
                const pos = &f.window._scroll_pos;
                // If the state isn't scroll, we can ignore safely to throttle
                // the events.
                if (pos.state != .scroll) {
                    return null;
                }

                const event = try Event.initTrusted(comptime .wrap("scroll"), .{ .bubbles = true }, f._page);
                try f._event_manager.dispatch(f.document.asEventTarget(), event);
                pos.state = .end;

                return null;
            }
        }.dispatch,
        10,
        .{ .low_priority = true },
    );
    // We dispatch scrollend event asynchronously after 20ms.
    try frame.js.scheduler.add(
        frame,
        struct {
            fn dispatch(_frame: *anyopaque) anyerror!?u32 {
                const f: *Frame = @ptrCast(@alignCast(_frame));
                const pos = &f.window._scroll_pos;
                // Dispatch only if the state is .end.
                // If a scroll is pending, retry in 10ms.
                // If the state is .end, the event has been dispatched, so
                // ignore safely.
                switch (pos.state) {
                    .scroll => return 10,
                    .end => {},
                    .done => return null,
                }
                const event = try Event.initTrusted(comptime .wrap("scrollend"), .{ .bubbles = true }, f._page);
                try f._event_manager.dispatch(f.document.asEventTarget(), event);
                pos.state = .done;

                return null;
            }
        }.dispatch,
        20,
        .{ .low_priority = true },
    );
}

pub fn scrollBy(self: *Window, opts: ScrollToOpts, y: ?i32, frame: *Frame) !void {
    // The scroll is relative to the current position. So compute to new
    // absolute position.
    var absx: i32 = undefined;
    var absy: i32 = undefined;
    switch (opts) {
        .x => |x| {
            absx = @as(i32, @intCast(self._scroll_pos.x)) + x;
            absy = @as(i32, @intCast(self._scroll_pos.y)) + (y orelse 0);
        },
        .opts => |o| {
            absx = @as(i32, @intCast(self._scroll_pos.x)) + o.left;
            absy = @as(i32, @intCast(self._scroll_pos.y)) + o.top;
        },
    }
    return self.scrollTo(.{ .x = absx }, absy, frame);
}

// only exposed when the binary is built with the -Dwpt_extensions flag
pub fn getWebDriver(_: *const Window) @import("WebDriver.zig") {
    return .{};
}

pub fn unhandledPromiseRejection(self: *Window, no_handler: bool, rejection: js.PromiseRejection, frame: *Frame) !void {
    if (comptime IS_DEBUG) {
        log.debug(.js, "unhandled rejection", .{
            .target = "window",
            .value = rejection.reason(),
            .stack = rejection.local.stackTrace() catch |err| @errorName(err) orelse "???",
        });
    } else {
        log.warn(.js, "unhandled rejection", .{
            .target = "window",
            .value = rejection.reason(),
        });
    }

    const event_name, const attribute_callback = blk: {
        if (no_handler) {
            break :blk .{ "unhandledrejection", self._on_unhandled_rejection };
        }
        break :blk .{ "rejectionhandled", self._on_rejection_handled };
    };

    const target = self.asEventTarget();
    if (frame._event_manager.hasDirectListeners(target, event_name, attribute_callback)) {
        const event = (try @import("event/PromiseRejectionEvent.zig").init(event_name, .{
            .reason = if (rejection.reason()) |r| try r.temp() else null,
            .promise = try rejection.promise().temp(),
        }, frame._page)).asEvent();
        // Ignore any errors from dispatching the event to avoid crashing
        frame._event_manager.dispatchDirect(target, event, attribute_callback, .{ .context = "window.unhandledrejection" }) catch |err| {
            log.warn(.js, "failed to dispatch unhandledrejection event", .{ .err = err });
        };
    }
}

pub const Access = union(enum) {
    window: *Window,
    cross_origin: *CrossOriginWindow,

    pub fn init(callee: *Window, accessing: *Window) Access {
        if (callee == accessing) {
            // common enough that it's worth the check
            return .{ .window = accessing };
        }

        if (callee._frame.js.origin == accessing._frame.js.origin) {
            // two different windows, but same origin, return the full window
            return .{ .window = accessing };
        }

        return .{ .cross_origin = &accessing._cross_origin_wrapper };
    }
};

const PostMessageCallback = struct {
    frame: *Frame,
    source: *Window,
    arena: Allocator,
    origin: []const u8,
    message: js.Value.Temp,
    ports: []const *MessagePort,

    fn deinit(self: *PostMessageCallback) void {
        self.frame.releaseArena(self.arena);
    }

    fn cancelled(ctx: *anyopaque) void {
        const self: *PostMessageCallback = @ptrCast(@alignCast(ctx));
        self.message.release();
        self.deinit();
    }

    fn dispatch(self: *PostMessageCallback) !void {
        const frame = self.frame;
        const window = frame.window;
        const event_target = window.asEventTarget();

        const event = (try MessageEvent.initTrusted(comptime .wrap("message"), .{
            .data = .{ .value = self.message },
            .origin = self.origin,
            .source = self.source,
            .ports = self.ports,
            .bubbles = false,
            .cancelable = false,
        }, frame._page)).asEvent();
        try frame._event_manager.dispatchDirect(event_target, event, window._on_message, .{ .context = "window.postMessage" });
        try frame.scheduleDeferredMacrotaskPump();
    }

    fn run(ctx: *anyopaque) !?u32 {
        const self: *PostMessageCallback = @ptrCast(@alignCast(ctx));

        const frame = self.frame;
        const window = frame.window;
        const event_target = window.asEventTarget();
        const has_listeners = frame._event_manager.hasDirectListeners(event_target, "message", window._on_message);

        if (!has_listeners) {
            window.queuePendingPostMessage(self) catch |err| {
                log.warn(.browser, "queue pending postMessage", .{ .err = err });
                self.message.release();
                self.deinit();
            };
            return null;
        }

        defer self.deinit();
        self.dispatch() catch |err| {
            log.warn(.browser, "postMessage dispatch", .{ .err = err });
            self.message.release();
        };

        return null;
    }
};

const FunctionSetter = union(enum) {
    func: js.Function.Global,
    anything: js.Value,
};

// window.onload = {}; doesn't fail, but it doesn't do anything.
// seems like setting to null is ok (though, at least on Firefix, it preserves
// the original value, which we could do, but why?)
fn getFunctionFromSetter(setter_: ?FunctionSetter) ?js.Function.Global {
    const setter = setter_ orelse return null;
    return switch (setter) {
        .func => |func| func, // Already a Global from bridge auto-conversion
        .anything => null,
    };
}

// Checks whether a window.open features string contains a token, matched
// case-insensitively on whole-token boundaries (comma or whitespace separated).
// The features syntax is legacy and loose; the only tokens we interpret are
// noopener and noreferrer.
fn hasFeatureToken(features: []const u8, token: []const u8) bool {
    var it = std.mem.tokenizeAny(u8, features, " \t\r\n,");
    while (it.next()) |raw| {
        // Trim a trailing =value if present — we only need the key.
        const key = if (std.mem.indexOfScalarPos(u8, raw, 0, '=')) |eq| raw[0..eq] else raw;
        if (std.ascii.eqlIgnoreCase(key, token)) return true;
    }
    return false;
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(Window);

    pub const Meta = struct {
        pub const name = "Window";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };

    pub const document = bridge.accessor(Window.getDocument, null, .{ .cache = .{ .internal = 1 }, .deletable = false });
    pub const console = bridge.accessor(Window.getConsole, null, .{ .cache = .{ .internal = 2 } });

    pub const top = bridge.accessor(Window.getTop, null, .{});
    pub const self = bridge.accessor(Window.getWindow, null, .{});
    pub const window = bridge.accessor(Window.getWindow, null, .{});
    pub const parent = bridge.accessor(Window.getParent, null, .{});
    pub const navigator = bridge.accessor(Window.getNavigator, null, .{});
    pub const screen = bridge.accessor(Window.getScreen, null, .{});
    pub const visualViewport = bridge.accessor(Window.getVisualViewport, null, .{});
    pub const performance = bridge.accessor(Window.getPerformance, null, .{});
    pub const localStorage = bridge.accessor(Window.getLocalStorage, null, .{});
    pub const sessionStorage = bridge.accessor(Window.getSessionStorage, null, .{});
    pub const origin = bridge.accessor(Window.getOrigin, null, .{});
    pub const location = bridge.accessor(Window.getLocation, Window.setLocation, .{ .deletable = false });
    pub const chrome = bridge.accessor(Window.getChrome, null, .{ .null_as_undefined = true });
    pub const google = bridge.accessor(Window.getGoogle, Window.setGoogle, .{ .null_as_undefined = true });
    pub const history = bridge.accessor(Window.getHistory, null, .{});
    pub const navigation = bridge.accessor(Window.getNavigation, null, .{});
    pub const crypto = bridge.accessor(Window.getCrypto, null, .{});
    pub const CSS = bridge.accessor(Window.getCSS, null, .{});
    pub const customElements = bridge.accessor(Window.getCustomElements, null, .{});
    pub const indexedDB = bridge.accessor(Window.getIndexedDB, null, .{});
    pub const caches = bridge.accessor(Window.getCaches, null, .{});
    pub const speechSynthesis = bridge.accessor(Window.getSpeechSynthesis, null, .{});
    pub const trustedTypes = bridge.accessor(Window.getTrustedTypes, null, .{});
    pub const onload = bridge.accessor(Window.getOnLoad, Window.setOnLoad, .{});
    pub const onpageshow = bridge.accessor(Window.getOnPageShow, Window.setOnPageShow, .{});
    pub const onpopstate = bridge.accessor(Window.getOnPopState, Window.setOnPopState, .{});
    pub const onerror = bridge.accessor(Window.getOnError, Window.setOnError, .{});
    pub const onmessage = bridge.accessor(Window.getOnMessage, Window.setOnMessage, .{});
    pub const onrejectionhandled = bridge.accessor(Window.getOnRejectionHandled, Window.setOnRejectionHandled, .{});
    pub const onunhandledrejection = bridge.accessor(Window.getOnUnhandledRejection, Window.setOnUnhandledRejection, .{});
    pub const event = bridge.accessor(Window.getEvent, null, .{ .null_as_undefined = true });
    pub const fetch = bridge.function(Window.fetch, .{});
    pub const queueMicrotask = bridge.function(Window.queueMicrotask, .{});
    pub const setTimeout = bridge.function(Window.setTimeout, .{});
    pub const clearTimeout = bridge.function(Window.clearTimeout, .{});
    pub const setInterval = bridge.function(Window.setInterval, .{});
    pub const clearInterval = bridge.function(Window.clearInterval, .{});
    pub const setImmediate = bridge.function(Window.setImmediate, .{});
    pub const clearImmediate = bridge.function(Window.clearImmediate, .{});
    pub const requestAnimationFrame = bridge.function(Window.requestAnimationFrame, .{});
    pub const cancelAnimationFrame = bridge.function(Window.cancelAnimationFrame, .{});
    pub const requestIdleCallback = bridge.function(Window.requestIdleCallback, .{});
    pub const cancelIdleCallback = bridge.function(Window.cancelIdleCallback, .{});
    pub const matchMedia = bridge.function(Window.matchMedia, .{});
    pub const postMessage = bridge.function(Window.postMessage, .{});
    pub const btoa = bridge.function(Window.btoa, .{ .dom_exception = true });
    pub const atob = bridge.function(Window.atob, .{ .dom_exception = true });
    pub const reportError = bridge.function(Window.reportError, .{});
    pub const structuredClone = bridge.function(Window.structuredClone, .{});
    pub const getComputedStyle = bridge.function(Window.getComputedStyle, .{});
    pub const getSelection = bridge.function(Window.getSelection, .{});

    pub const frames = bridge.accessor(Window.getWindow, null, .{});
    pub const index = bridge.indexed(Window.getFrame, null, .{ .null_as_undefined = true });
    pub const length = bridge.accessor(Window.getFramesLength, null, .{});
    pub const scrollX = bridge.accessor(Window.getScrollX, null, .{});
    pub const scrollY = bridge.accessor(Window.getScrollY, null, .{});
    pub const pageXOffset = bridge.accessor(Window.getScrollX, null, .{});
    pub const pageYOffset = bridge.accessor(Window.getScrollY, null, .{});
    pub const scrollTo = bridge.function(Window.scrollTo, .{});
    pub const scroll = bridge.function(Window.scrollTo, .{});
    pub const scrollBy = bridge.function(Window.scrollBy, .{});

    // Return false since we don't have secure-context-only APIs implemented
    // (webcam, geolocation, clipboard, etc.)
    // This is safer and could help avoid processing errors by hinting at
    // sites not to try to access those features
    pub const isSecureContext = bridge.attribute(false, .{});

    pub fn getInnerWidth(_: *const Window, frame: *Frame) u32 {
        return frame.windowProfile().inner_width;
    }

    pub fn getInnerHeight(_: *const Window, frame: *Frame) u32 {
        return frame.windowProfile().inner_height;
    }

    pub fn getOuterWidth(_: *const Window, frame: *Frame) u32 {
        return frame.windowProfile().outer_width;
    }

    pub fn getOuterHeight(_: *const Window, frame: *Frame) u32 {
        return frame.windowProfile().outer_height;
    }

    pub fn getDevicePixelRatio(_: *const Window, frame: *Frame) f64 {
        return frame.devicePixelRatio();
    }

    pub const innerWidth = bridge.accessor(getInnerWidth, null, .{});
    pub const innerHeight = bridge.accessor(getInnerHeight, null, .{});
    pub const outerWidth = bridge.accessor(getOuterWidth, null, .{});
    pub const outerHeight = bridge.accessor(getOuterHeight, null, .{});
    pub const devicePixelRatio = bridge.accessor(getDevicePixelRatio, null, .{});

    pub const opener = bridge.accessor(Window.getOpener, null, .{});
    pub const closed = bridge.accessor(Window.getClosed, null, .{});
    pub const name = bridge.accessor(Window.getName, Window.setName, .{});
    pub const open = bridge.function(Window.open, .{});
    pub const close = bridge.function(Window.close, .{});

    pub const alert = bridge.function(struct {
        fn alert(_: *const Window, message: ?[]const u8, frame: *Frame) void {
            var response: Notification.DialogResponse = .{};
            frame._session.notification.dispatch(.javascript_dialog_opening, &.{
                .url = frame.url,
                .message = message orelse "",
                .dialog_type = "alert",
                .response = &response,
            });
            // Return value is void; we still pop a pre-armed response so the
            // CDP client's pre-arm doesn't leak across to the next dialog.
        }
    }.alert, .{});
    pub const confirm = bridge.function(struct {
        fn confirm(_: *const Window, message: ?[]const u8, frame: *Frame) bool {
            var response: Notification.DialogResponse = .{};
            frame._session.notification.dispatch(.javascript_dialog_opening, &.{
                .url = frame.url,
                .message = message orelse "",
                .dialog_type = "confirm",
                .response = &response,
            });
            return response.accept;
        }
    }.confirm, .{});
    pub const prompt = bridge.function(struct {
        fn prompt(_: *const Window, message: ?[]const u8, default_text: ?[]const u8, frame: *Frame) ?[]const u8 {
            var response: Notification.DialogResponse = .{};
            frame._session.notification.dispatch(.javascript_dialog_opening, &.{
                .url = frame.url,
                .message = message orelse "",
                .dialog_type = "prompt",
                .response = &response,
            });
            if (!response.accept) return null;
            // Pre-armed promptText wins when present. Otherwise fall back to
            // the dialog's defaultText (second arg to window.prompt) — Chrome's
            // accept-without-typing behavior. If both are absent, return ""
            // per CDP spec
            // (https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-handleJavaScriptDialog).
            return response.prompt_text orelse default_text orelse "";
        }
    }.prompt, .{});

    pub const webdriver = bridge.accessor(Window.getWebDriver, null, .{ .wpt_only = true });
};

const CrossOriginWindow = struct {
    window: *Window,

    pub fn postMessage(self: *CrossOriginWindow, message: js.Value.Temp, target_origin: ?[]const u8, transfer: ?[]js.Value, frame: *Frame) !void {
        return self.window.postMessage(message, target_origin, transfer, frame);
    }

    pub fn getTop(self: *CrossOriginWindow, frame: *Frame) Access {
        return self.window.getTop(frame);
    }

    pub fn getParent(self: *CrossOriginWindow, frame: *Frame) Access {
        return self.window.getParent(frame);
    }

    pub fn getFramesLength(self: *const CrossOriginWindow) u32 {
        return self.window.getFramesLength();
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(CrossOriginWindow);

        pub const Meta = struct {
            pub const name = "CrossOriginWindow";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
        };

        pub const postMessage = bridge.function(CrossOriginWindow.postMessage, .{});
        pub const top = bridge.accessor(CrossOriginWindow.getTop, null, .{});
        pub const parent = bridge.accessor(CrossOriginWindow.getParent, null, .{});
        pub const length = bridge.accessor(CrossOriginWindow.getFramesLength, null, .{});
    };
};

const testing = @import("../../testing/testing.zig");
test "WebApi: Window" {
    try testing.htmlRunner("window", .{});
}

test "WebApi: Window scroll" {
    try testing.htmlRunner("window_scroll.html", .{});
}

test "WebApi: Window.onerror" {
    try testing.htmlRunner("event/report_error.html", .{});
}
