const std = @import("std");
const log = @import("log.zig");

pub fn RC(comptime T: type) type {
    return struct {
        const Self = @This();

        count: T = 1,

        pub fn init(count: T) Self {
            return .{ .count = count };
        }

        pub fn acquire(self: *Self) void {
            // Saturate at the maximum value of `T` rather than wrapping.
            // In practice the counter never legitimately exceeds 2 (see the
            // comment on `Event._rc`), but a defensive saturate is cheap and
            // guards against feedback loops where two systems incorrectly
            // re-acquire the same instance many times.
            if (self.count == std.math.maxInt(T)) {
                log.warn(.app, "RC.acquire saturated", .{
                    .owner_type = @typeName(T),
                });
                return;
            }
            self.count += 1;
        }

        // Decrement the reference count. When it reaches zero, hand off to the
        // owner's `deinit` so it can release any backing resources (typically
        // the per-instance arena).
        //
        // Historically this would underflow `count` in debug builds when the
        // same instance was released more often than acquired -- typically
        // because a V8 weak finalizer fires on an Event whose Zig-side
        // refcount already reached zero through the dispatch path. The crash
        // signature observed on JS-heavy SPAs (e.g., TikTok live) was:
        //
        //     reason: integer overflow
        //     src/support/rc.zig:16:24  release
        //     src/core/webapi/Event.zig:149:21  Event.releaseRef
        //     src/core/js/Local.zig:1271:38  finalizer release
        //     v8::internal::GlobalHandles::InvokeFirstPassWeakCallbacks
        //
        // We now treat extra releases as a no-op rather than a fatal
        // underflow. The browser keeps running and we log a single warning so
        // the underlying lifecycle issue can still be traced.
        pub fn release(self: *Self, owner: anytype, page: anytype) void {
            if (self.count == 0) {
                log.warn(.app, "RC.release on already-released instance", .{
                    .owner_type = @typeName(@TypeOf(owner)),
                });
                return;
            }
            self.count -= 1;
            if (self.count == 0) {
                // Detach the V8 FinalizerCallback for this instance (if any)
                // BEFORE handing off to deinit. The Zig instance pointer doubles
                // as `finalizer_ptr_id` in `js.Local.mapZigInstanceToJs` for
                // every type that has its own `acquireRef`, so this is the
                // correct key to look up. Without this, a stale FC entry would
                // survive the deinit and a later V8 weak-callback (or, after
                // arena reuse, a completely unrelated instance) would call
                // `releaseRef` on freed memory and underflow the refcount.
                if (@hasDecl(@typeInfo(@TypeOf(page)).pointer.child, "detachFinalizer")) {
                    page.detachFinalizer(@intFromPtr(owner));
                }
                owner.deinit(page);
            }
        }
    };
}
