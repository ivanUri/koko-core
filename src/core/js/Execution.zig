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

//! Execution context for worker-compatible APIs.
//!
//! This provides a common interface for APIs that work in both Window and Worker
//! contexts. Instead of taking `*Frame` (which is DOM-specific), these APIs take
//! `*Execution` which abstracts the common infrastructure.
//!
//! The bridge constructs an Execution on-the-fly from the current context,
//! whether it's a Page context or a Worker context.

const std = @import("std");

const Context = @import("Context.zig");
const Scheduler = @import("Scheduler.zig");
const Factory = @import("../browser/Factory.zig");
const Frame = @import("../browser/Frame.zig");
const HttpClient = @import("../browser/HttpClient.zig");
const FingerprintProfile = @import("../profile/types.zig");
const ProfileStore = @import("../../runtime/profile/ProfileStore.zig");
const EventManagerBase = @import("../browser/EventManagerBase.zig");

const Blob = @import("../webapi/Blob.zig");
const Event = @import("../webapi/Event.zig");
const EventTarget = @import("../webapi/EventTarget.zig");

const String = @import("../../support/string.zig").String;
const RealmLifecycleKernel = @import("../../runtime/RealmLifecycleKernel.zig");
const Allocator = std.mem.Allocator;

const Execution = @This();

pub const JsEntryIllegal = error{JsEntryIllegal};

/// Gate policy for `validateJsEntry` / `canEnterJs`.
pub const JsEntryMode = enum {
    /// Only `.active` — new macrotasks, strict async starts.
    strict_active,
    /// `.active` or `.draining` — bounded delivery (microtasks, MO, CE during teardown).
    allow_draining,
};

context: *Context,

// Fields named to match Page for generic code (executor._factory works for both)
buf: []u8,
arena: Allocator,
call_arena: Allocator,
_factory: *Factory,
_scheduler: *Scheduler,

// Pointer to the url field (Page or WorkerGlobalScope) - allows access to current url even after navigation
url: *[:0]const u8,

// Pointer to the charset field of the global (Page or WorkerGlobalScope).
charset: *[]const u8,

// Returns the current base URL of the global scope.
pub fn base(self: *const Execution) [:0]const u8 {
    return self.context.global.base();
}

pub fn dupeString(self: *const Execution, value: []const u8) ![]const u8 {
    if (String.intern(value)) |v| {
        return v;
    }
    return self.arena.dupe(u8, value);
}

pub fn getArena(self: *const Execution, size_or_bucket: anytype, debug: []const u8) !Allocator {
    return self.context.page.getArena(size_or_bucket, debug);
}

pub fn releaseArena(self: *const Execution, allocator: Allocator) void {
    self.context.page.releaseArena(allocator);
}

pub fn identityProfile(self: *const Execution) *const FingerprintProfile.IdentityProfile {
    return self.context.page.session.browser.app.config.profile.identityPtr();
}

pub fn loadedProfile(self: *const Execution) *const ProfileStore.LoadedProfile {
    return &self.context.page.session.browser.app.config.profile;
}

pub fn headersForRequest(self: *const Execution, headers: *HttpClient.Headers, opts: Frame.HeadersForRequestOpts) !void {
    return switch (self.context.global) {
        inline else => |g| g.headersForRequest(headers, opts),
    };
}

pub fn isSameOrigin(self: *const Execution, url: [:0]const u8) bool {
    return switch (self.context.global) {
        inline else => |g| g.isSameOrigin(url),
    };
}

pub fn lookupBlobUrl(self: *const Execution, url: []const u8) ?*Blob {
    return switch (self.context.global) {
        inline else => |g| g.lookupBlobUrl(url),
    };
}

pub fn dispatch(
    self: *const Execution,
    target: *EventTarget,
    event: *Event,
    handler: anytype,
    comptime opts: EventManagerBase.DispatchDirectOptions,
) !void {
    return switch (self.context.global) {
        inline else => |g| g.dispatch(target, event, handler, opts),
    };
}

pub fn hasDirectListeners(self: *const Execution, target: *EventTarget, typ: []const u8, handler: anytype) bool {
    return switch (self.context.global) {
        inline else => |g| g.hasDirectListeners(target, typ, handler),
    };
}

pub fn frameId(self: *const Execution) u32 {
    return switch (self.context.global) {
        inline else => |g| g._frame_id,
    };
}

pub fn loaderId(self: *const Execution) u32 {
    return switch (self.context.global) {
        inline else => |g| g._loader_id,
    };
}

pub fn realmEpoch(self: *const Execution) RealmLifecycleKernel.Epoch {
    return switch (self.context.global) {
        .frame => |f| f.realmEpoch(),
        .worker => |w| w.realmEpoch(),
    };
}

pub fn realmSchedulingActive(self: *const Execution) bool {
    return switch (self.context.global) {
        .frame => |f| f.realmSchedulingActive(),
        .worker => |w| w.realmSchedulingActive(),
    };
}

pub fn realmState(self: *const Execution) RealmLifecycleKernel.State {
    return switch (self.context.global) {
        .frame => |f| f.realmState(),
        .worker => |w| w.realmState(),
    };
}

pub fn schedulerSuppressed(self: *const Execution) bool {
    return switch (self.context.global) {
        .frame => |f| f.schedulerSuppressed(),
        // TODO(lifecycle): workers do not currently have a scheduler_suppressed
        // flag. Keep this asymmetry explicit until worker teardown gets the
        // same legality-driven circuit breaker as frame realms.
        .worker => false,
    };
}

/// Child browsing contexts (iframe / subframe). Root pages stay gated until
/// `markRealmReadyForPublication`; subframes may run microtasks while
/// `.initializing` so cross-origin widget iframes (e.g. Cloudflare Turnstile)
/// are not starved between `navigate()` and response headers.
pub fn isChildFrame(self: *const Execution) bool {
    return switch (self.context.global) {
        .frame => |f| f.parent != null,
        .worker => false,
    };
}

pub fn canEnterJs(self: *const Execution, mode: JsEntryMode) bool {
    // Circuit breaker: if the scheduler was suppressed due to runaway
    // microtask execution, no JS entry is legal regardless of realm state.
    if (self.schedulerSuppressed()) return false;
    const st = self.realmState();
    return switch (mode) {
        .strict_active => st == .active,
        .allow_draining => blk: {
            if (st == .active or st == .draining) break :blk true;
            // Subframe navigations bump to `.initializing` until headers land.
            // Allow microtask enqueue/checkpoint so promise reactions and
            // widget bootstrap are not dropped (Turnstile / reCAPTCHA iframes).
            if (st == .initializing and self.isChildFrame()) break :blk true;
            break :blk false;
        },
    };
}

/// Central gate: all async / deferred JS entry should validate here first.
pub fn validateJsEntry(self: *const Execution, mode: JsEntryMode, source: RealmLifecycleKernel.TaskSource) JsEntryIllegal!void {
    const cur_epoch = self.realmEpoch();
    const fid = self.frameId();
    const st = self.realmState();
    if (!self.canEnterJs(mode)) {
        RealmLifecycleKernel.traceJsEntry(false, fid, null, cur_epoch, st, source);
        return error.JsEntryIllegal;
    }
}

pub fn captureTaskOwner(self: *const Execution) RealmLifecycleKernel.TaskOwner {
    return switch (self.context.global) {
        .frame => |f| .{
            .realm_id = f._frame_id,
            .epoch = f.realmEpoch(),
            .document_id = f._loader_id,
        },
        .worker => |w| .{
            .realm_id = w._frame_id,
            .epoch = w.realmEpoch(),
            .document_id = w._loader_id,
        },
    };
}

pub fn isTaskOwnerStale(self: *const Execution, owner: RealmLifecycleKernel.TaskOwner) bool {
    return RealmLifecycleKernel.taskOwnerIsStale(owner, self.captureTaskOwner());
}
