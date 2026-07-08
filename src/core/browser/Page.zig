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

const App = @import("../../runtime/App.zig");
const FingerprintProfile = @import("../profile/types.zig");
const ProfileStore = @import("../../runtime/profile/ProfileStore.zig");
const NavigatorState = @import("../webapi/NavigatorState.zig");

const js = @import("../js/js.zig");
const v8 = js.v8;

const Frame = @import("Frame.zig");
const Session = @import("Session.zig");
const Factory = @import("Factory.zig");
const BroadcastChannel = @import("../webapi/broadcast_channel.zig").BroadcastChannel;

const log = @import("../../support/log.zig");
const Allocator = std.mem.Allocator;
const IS_DEBUG = builtin.mode == .Debug;

// A Page is the container for a root Frame and all of its descendants
// (nested iframes). It owns the resources that share the lifetime of the root
// document: the DOM factory, the per-page arena, the JS identity map, shared
// origins, v8 global handles, and queued navigation buffers.
//
// In the future, a Session may hold multiple Pages at once (e.g. during a
// navigation, while the old Page is retiring and the new one is provisional).
// For now, Session still holds a single Page.
const Page = @This();

session: *Session,

// DOM object factory scoped to this Page's documents.
factory: Factory,

// The arena for this Page's lifetime. Document / Frame / Factory / DOM
// objects allocate out of this.
frame_arena: Allocator,

// Stable allocator for identity_map buckets and TaggedOpaque nodes. Kept
// separate from frame_arena so hash-table metadata is not perturbed by high-
// churn DOM/audio allocations and is only released on Page teardown.
identity_arena: Allocator,

// Origin map for same-origin context sharing. Entries live for the Page's
// lifetime.
origins: std.StringHashMapUnmanaged(*js.Origin) = .empty,

// Identity tracking for the main world. All main-world contexts in this Page
// share this, ensuring object identity works across same-origin frames.
identity: js.Identity = .{},

// Zig ptr ids queued by V8 weak callbacks. identity_map is not mutated inside
// weak callbacks (re-entrant GC during getOrPut would corrupt the table).
pending_identity_removals: std.ArrayList(usize) = .empty,

// Finalizer callbacks for Zig instances exposed to v8 in this Page. Keyed by
// Zig instance ptr. The backing FinalizerCallback.Identity structs come from
// Session.fc_identity_pool so they outlive the Page for v8 weak-callback
// safety.
finalizer_callbacks: std.AutoHashMapUnmanaged(usize, *Session.FinalizerCallback) = .empty,

// Tracked global v8 objects that need to be released when the Page tears down.
globals: std.ArrayList(v8.Global) = .empty,

// Temporary v8 globals that can be released early. Key is global.data_ptr.
temps: std.AutoHashMapUnmanaged(usize, v8.Global) = .empty,

// Double buffered so that, as we process one list of queued navigations, new
// entries are added to the separate buffer. Prevents endless navigation loops
// and invalidation of the list during iteration.
queued_navigation_1: std.ArrayList(*Frame) = .empty,
queued_navigation_2: std.ArrayList(*Frame) = .empty,
// pointer to either queued_navigation_1 or queued_navigation_2
queued_navigation: *std.ArrayList(*Frame) = undefined,

// Temporary buffer for about:blank navigations during processing.
// We process async navigations first (safe from re-entrance), then sync
// about:blank navigations (which may add to queued_navigation).
queued_queued_navigation: std.ArrayList(*Frame) = .empty,

// The root Frame of this Page. Non-optional — a Page always has a root frame.
frame: Frame,

// BroadcastChannel registry keyed by "{origin_key}\x1f{channel_name}".
broadcast_channels: std.StringHashMapUnmanaged(std.ArrayList(*BroadcastChannel)) = .{},

// Popup Frames opened by window.open. They are top-level browsing contexts
// (parent == null, no iframe element) but share this Page's factory, arena,
// and identity map.
// Their lifetime is bound to the Page: on Page.deinit they
// are torn down. TODO: this is far from correct. An new window shouldn't be tied
// to the original page like this.
popups: std.ArrayList(*Frame) = .empty,

// Popups that have called window.close() but whose teardown is deferred to
// Page.deinit. We can't deinit synchronously from window.close() because
// that's invoked from JS still running on top of the Frame's V8 context (or
// from a script eval whose parser still holds the Frame).
queued_close: std.ArrayList(*Frame) = .empty,

// Lifecycle state. A Page is `.pending` while we hold it as the in-flight
// destination of a root navigation — its V8 context exists but is not yet the
// session's active context. Flipped to `.active` by Session.commitPendingPage
// when response headers arrive. Frame.navigate / frameHeaderDoneCallback
// branch on this to: (a) stamp `is_pending_root` on the frame_navigate
// notification (so CDP doesn't reset its node registry yet) and
// (b) flag the HTTP request `protect_from_abort` (so the old page's deinit
// can't kill the transfer we're sitting inside).
_state: enum { active, pending } = .active,

// Initialize a Page and its root Frame.
pub fn identityProfile(self: *const Page) *const FingerprintProfile.IdentityProfile {
    return self.session.browser.app.config.profile.identityPtr();
}

pub fn loadedProfile(self: *const Page) *const ProfileStore.LoadedProfile {
    return &self.session.browser.app.config.profile;
}

pub fn navigatorState(self: *const Page) NavigatorState {
    return .{ .profile = self.identityProfile() };
}

pub fn init(self: *Page, session: *Session, frame_id: u32) !void {
    const frame_arena = try session.arena_pool.acquire(.large, "Page.frame_arena");
    errdefer session.arena_pool.release(frame_arena);

    const identity_arena = try session.arena_pool.acquire(.medium, "Page.identity_arena");
    errdefer session.arena_pool.release(identity_arena);

    self.* = .{
        .session = session,
        .frame = undefined,
        .frame_arena = frame_arena,
        .identity_arena = identity_arena,
        .factory = Factory.init(frame_arena),
    };
    self.queued_navigation = &self.queued_navigation_1;

    try Frame.init(&self.frame, frame_id, self, null);
}

pub fn queueIdentityRemoval(self: *Page, resolved_ptr_id: usize) void {
    self.pending_identity_removals.append(self.identity_arena, resolved_ptr_id) catch {};
}

pub fn flushPendingIdentityRemovals(self: *Page) void {
    if (self.pending_identity_removals.items.len == 0) return;
    for (self.pending_identity_removals.items) |ptr_id| {
        // Global was already reset in the V8 weak callback; drop the stale entry.
        _ = self.identity.identity_map.remove(ptr_id);
    }
    self.pending_identity_removals.clearRetainingCapacity();
}

/// Tear down a secondary identity map (e.g. a dedicated worker realm). Globals
/// may still be live in V8 when the worker context is destroyed; mark finalizer
/// nodes done and drop the map. Weak callbacks reset handles on the next GC.
pub fn shutdownIdentity(self: *Page, identity: *js.Identity) void {
    {
        var fc_it = self.finalizer_callbacks.valueIterator();
        while (fc_it.next()) |fc_ptr| {
            var id: ?*Session.FinalizerCallback.Identity = fc_ptr.*.identities;
            while (id) |node| {
                if (node.identity == identity) {
                    node.done = true;
                }
                id = node.next;
            }
        }
    }
    identity.identity_map = .{};
}

// Tear down the Page and its root Frame. Equivalent to the old
// Session.removePage + Session.resetFrameResources.
pub fn deinit(self: *Page) void {
    self.cleanupClosedPopups();

    for (self.popups.items) |popup| {
        popup.deinit();
    }
    self.popups = .empty;

    self.frame.deinit();

    const session = self.session;
    defer session.browser.env.memoryPressureNotification(.moderate);

    // Invalidate outstanding V8 weak callbacks before releasing identity-map
    // storage in frame_arena.
    {
        var fc_it = self.finalizer_callbacks.valueIterator();
        while (fc_it.next()) |fc_ptr| {
            var id = fc_ptr.*.identities;
            while (id) |identity| {
                identity.done = true;
                id = identity.next;
            }
        }
    }

    self.flushPendingIdentityRemovals();
    self.identity.deinit();
    self.identity = .{};
    self.pending_identity_removals = .empty;

    // Force cleanup all remaining finalized objects. Remove each callback from
    // the map before releasing it, because release_ref can re-enter
    // detachFinalizer through RC.release.
    while (self.finalizer_callbacks.count() > 0) {
        var it = self.finalizer_callbacks.iterator();
        const entry = it.next() orelse break;
        const finalizer_ptr_id = entry.key_ptr.*;
        const fc = entry.value_ptr.*;
        _ = self.finalizer_callbacks.remove(finalizer_ptr_id);
        fc.deinit(self);
    }

    {
        for (self.globals.items) |*global| {
            v8.v8__Global__Reset(global);
        }
        self.globals = .empty;
    }

    {
        var it = self.temps.valueIterator();
        while (it.next()) |global| {
            v8.v8__Global__Reset(global);
        }
        self.temps = .empty;
    }

    if (comptime IS_DEBUG) {
        std.debug.assert(self.origins.count() == 0);
    }
    // Defensive cleanup in case origins leaked.
    {
        const app = session.browser.app;
        var it = self.origins.valueIterator();
        while (it.next()) |value| {
            value.*.deinit(app);
        }
        self.origins = .empty;
    }

    session.arena_pool.release(self.identity_arena);
    session.arena_pool.release(self.frame_arena);
}

pub fn cleanupClosedPopups(self: *Page) void {
    for (self.queued_close.items) |popup| {
        popup.deinit();
    }
    self.queued_close = .empty;
}

pub fn getArena(self: *Page, size_or_bucket: anytype, debug: []const u8) !Allocator {
    return self.session.getArena(size_or_bucket, debug);
}

pub fn releaseArena(self: *Page, allocator: Allocator) void {
    return self.session.releaseArena(allocator);
}

// Detach (and forget) any FinalizerCallback registered for the Zig
// instance whose finalizer pointer is `finalizer_ptr_id`. This is
// invoked from a Zig-side `deinit` once the underlying refcount hits
// zero. Without this, the FC stays in `finalizer_callbacks` and any
// later V8 weak-callback for an outstanding identity would attempt to
// `release_ref` against memory that has already been freed (or, worse,
// recycled by the arena pool for an unrelated instance), producing the
// "integer overflow" / "ArenaPool counter out of sync" crash chain
// observed on JS-heavy SPAs (TikTok Live).
pub fn detachFinalizer(self: *Page, finalizer_ptr_id: usize) void {
    const fc_entry = self.finalizer_callbacks.fetchRemove(finalizer_ptr_id) orelse return;
    const fc = fc_entry.value;
    // Mark every outstanding identity as `done` so any subsequent V8
    // weak-callback for those identities short-circuits before deref'ing
    // the (potentially recycled) FC or its target object.
    var id = fc.identities;
    while (id) |identity| {
        identity.done = true;
        id = identity.next;
    }
    self.releaseArena(fc.arena);
}

pub fn getOrCreateOrigin(self: *Page, key_: ?[]const u8) !*js.Origin {
    const session = self.session;
    const key = key_ orelse {
        var opaque_origin: [36]u8 = undefined;
        @import("../../support/id.zig").uuidv4(&opaque_origin);
        // Origin.init will dupe opaque_origin. It's fine that this doesn't
        // get added to self.origins. In fact, it further isolates it. When the
        // context is freed, it'll call Page.releaseOrigin which will free it.
        return js.Origin.init(session.browser.app, session.browser.env.isolate, &opaque_origin);
    };

    const gop = try self.origins.getOrPut(session.arena, key);
    if (gop.found_existing) {
        const origin = gop.value_ptr.*;
        origin.rc += 1;
        return origin;
    }

    errdefer _ = self.origins.remove(key);

    const origin = try js.Origin.init(session.browser.app, session.browser.env.isolate, key);
    gop.key_ptr.* = origin.key;
    gop.value_ptr.* = origin;
    return origin;
}

pub fn releaseOrigin(self: *Page, origin: *js.Origin) void {
    const rc = origin.rc;
    if (rc == 1) {
        _ = self.origins.remove(origin.key);
        origin.deinit(self.session.browser.app);
    } else {
        origin.rc = rc - 1;
    }
}

pub fn scheduleNavigation(self: *Page, frame: *Frame) !void {
    const list = self.queued_navigation;

    // Check if frame is already queued
    for (list.items) |existing| {
        if (existing == frame) {
            // Already queued
            return;
        }
    }

    return list.append(self.session.arena, frame);
}

pub fn findFrameByFrameId(self: *Page, frame_id: u32) ?*Frame {
    return findFrameBy(&self.frame, "_frame_id", frame_id);
}

/// Map a dedicated-worker's synthetic frame_id to its parent frame for CDP/network attribution.
pub fn findFrameForWorkerFrameId(self: *Page, frame_id: u32) ?*Frame {
    return findFrameForWorkerFrameIdInner(&self.frame, frame_id);
}

fn findFrameForWorkerFrameIdInner(frame: *Frame, frame_id: u32) ?*Frame {
    for (frame.workers.items) |worker| {
        if (worker._frame_id == frame_id) return frame;
    }
    for (frame.child_frames.items) |child| {
        if (findFrameForWorkerFrameIdInner(child, frame_id)) |found| return found;
    }
    return null;
}

// Returns the popup Frame registered under `name`, or null.
pub fn findPopupByName(self: *Page, name: []const u8) ?*Frame {
    for (self.popups.items) |popup| {
        if (std.mem.eql(u8, popup.window._name, name)) {
            return popup;
        }
    }
    return null;
}

pub fn findFrameByLoaderId(self: *Page, loader_id: u32) ?*Frame {
    return findFrameBy(&self.frame, "_loader_id", loader_id);
}

fn findFrameBy(frame: *Frame, comptime field: []const u8, id: u32) ?*Frame {
    if (@field(frame, field) == id) return frame;
    for (frame.child_frames.items) |f| {
        if (findFrameBy(f, field, id)) |found| {
            return found;
        }
    }
    return null;
}

pub fn broadcastChannelRegistryKey(self: *Page, origin_key: []const u8, name: []const u8) ![]const u8 {
    return try std.fmt.allocPrint(self.frame_arena, "{s}\x1f{s}", .{ origin_key, name });
}

pub fn registerBroadcastChannel(self: *Page, channel: *BroadcastChannel) !void {
    const gop = try self.broadcast_channels.getOrPut(self.frame_arena, channel.registryKey());
    if (!gop.found_existing) {
        gop.value_ptr.* = .{};
    }
    try gop.value_ptr.append(self.frame_arena, channel);
}

pub fn unregisterBroadcastChannel(self: *Page, channel: *BroadcastChannel) void {
    const list = self.broadcast_channels.getPtr(channel.registryKey()) orelse return;
    for (list.items, 0..) |existing, i| {
        if (existing == channel) {
            _ = list.swapRemove(i);
            break;
        }
    }
    if (list.items.len == 0) {
        _ = self.broadcast_channels.remove(channel.registryKey());
    }
}
