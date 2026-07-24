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
const Frame = @import("Frame.zig");
const Session = @import("Session.zig");
const HttpClient = @import("HttpClient.zig");
const HostIdle = @import("HostIdle.zig");

const Node = @import("../dom/Node.zig");
const Selector = @import("../webapi/selector/Selector.zig");

const log = @import("../../support/log.zig");
const IS_DEBUG = builtin.mode == .Debug;

const Runner = @This();

frame: *Frame,
session: *Session,
http_client: *HttpClient,

pub const Opts = struct {};

pub fn init(session: *Session, _: Opts) !Runner {
    const frame = session.currentFrame() orelse return error.NoPage;

    return .{
        .frame = frame,
        .session = session,
        .http_client = &session.browser.http_client,
    };
}

pub const WaitOpts = struct {
    ms: u32,
    until: @import("../../runtime/Config.zig").WaitUntil = .done,
};
pub fn wait(self: *Runner, opts: WaitOpts) !void {
    _ = try self._wait(false, opts);
}

pub const CDPWaitResult = enum {
    done,
    cdp_socket,
};
pub fn waitCDP(self: *Runner, opts: WaitOpts) !CDPWaitResult {
    return self._wait(true, opts);
}

fn _wait(self: *Runner, comptime is_cdp: bool, opts: WaitOpts) !CDPWaitResult {
    var timer = try std.time.Timer.start();
    var done_confirmations: u8 = 0;

    const tick_opts = TickOpts{
        .ms = 200,
        .until = opts.until,
    };

    // Periodic V8 GC hint during long waits. V8 is otherwise only nudged on
    // session/page teardown (Browser.zig, Page.zig), so a page that stays
    // alive for seconds while running heavy JS accumulates wrappers and
    // external-ref'd Zig allocations V8 has no reason to drop. `.moderate`
    // speeds up incremental GC without stalling the tick.
    // Every 1s put too much pressure on V8 (high CPU on complex pages); 5s is enough.
    const gc_hint_period_ns: u64 = std.time.ns_per_s * 5;
    var gc_hint_timer = std.time.Timer.start() catch unreachable;

    while (true) {
        if (gc_hint_timer.read() >= gc_hint_period_ns) {
            gc_hint_timer.reset();
            self.frame._page.cleanupClosedPopups();
            self.session.browser.env.memoryPressureNotification(.moderate);
        }

        // A previous _tick iteration may have parked a pending root navigation
        // commit because JS was on the V8 stack at the time HttpClient.perform
        // reentrantly drained the pending response (see
        // Session._deferred_commit_pending). By the top of this loop the script
        // has unwound, so it is safe to promote the pending page now. Without
        // this drain, the loop would block on http_client.tick for the full
        // wait window (up to ~1s) before the commit happens, adding per-
        // navigation latency for any page that issues fetch() from JS.
        self.session.drainDeferredCommit();

        const tick_result = self._tick(is_cdp, tick_opts) catch |err| {
            switch (err) {
                error.JsError => {}, // already logged (with hopefully more context)
                else => log.err(.browser, "session wait", .{
                    .err = err,
                    .url = self.frame.url,
                }),
            }
            return err;
        };

        const next_ms = switch (tick_result) {
            .ok => |next_ms| next_ms,
            .done => blk: {
                // A network callback may settle the last transfer and enqueue
                // its DOM event at the same idle edge. Require a short stable
                // quiescence window so load/error handlers and their immediate
                // microtasks are reflected in an HTML snapshot.
                if (!is_cdp and opts.until == .done and done_confirmations < 2) {
                    done_confirmations += 1;
                    const js_mod = @import("../js/js.zig");
                    js_mod.EventLoop.spin(&self.frame.js.execution, .{
                        .max_tasks = 48,
                        .stop_when_idle = true,
                    });
                    self.session.browser.env.runMicrotasks(.macrotask_loop);
                    break :blk 5;
                }
                return .done;
            },
            .cdp_socket => if (comptime is_cdp) return .cdp_socket else unreachable,
        };
        if (tick_result != .done) done_confirmations = 0;

        const ms_elapsed: u32 = @intCast(timer.read() / std.time.ns_per_ms);
        if (ms_elapsed >= opts.ms) {
            return .done;
        }
        if (next_ms > 0) {
            std.Thread.sleep(std.time.ns_per_ms * next_ms);
        }
    }
}

pub const TickOpts = struct {
    ms: u32,
    until: @import("../../runtime/Config.zig").WaitUntil = .done,
};

pub const TickResult = union(enum) {
    done,
    ok: u32,
};
pub fn tick(self: *Runner, opts: TickOpts) !TickResult {
    return switch (try self._tick(false, opts)) {
        .ok => |ms| .{ .ok = ms },
        .done => .done,
        .cdp_socket => unreachable,
    };
}

pub const CDPTickResult = union(enum) {
    done,
    cdp_socket,
    ok: u32,
};
pub fn tickCDP(self: *Runner, opts: TickOpts) !CDPTickResult {
    return self._tick(true, opts);
}

fn drainDeferredDocumentParse(self: *Runner, comptime is_cdp: bool) void {
    _ = is_cdp;
    const frame = self.frame;
    const http_client = self.http_client;
    if (!frame.hasDeferredDocumentParsePending()) return;
    // Do not gate on http_active: the document transfer is already done when
    // frameDoneCallback schedules parse. Waiting for all subresource fetches
    // (x.com module bundles, fonts) left HTML unparseable and DCL never fired.
    // Departing realm: cancelOwnedSchedulerWork instead of running parse on dead DOM.
    if (!frame.canRunOwnedScheduler()) {
        frame.cancelOwnedSchedulerWork();
        return;
    }

    const env = &self.session.browser.env;
    var slices: u8 = 0;
    while (slices < 48) : (slices += 1) {
        if (!frame.canRunOwnedScheduler()) {
            frame.cancelOwnedSchedulerWork();
            break;
        }
        env.runMicrotasks(.macrotask_loop);
        if (!frame.js.scheduler.hasReadyTasks()) break;
        var hs: js.HandleScope = undefined;
        const entered = frame.js.enter(&hs) orelse break;
        const ran = frame.runOwnedSchedulerOne() catch false;
        entered.exit();
        if (!ran) break;
        env.runMicrotasks(.macrotask_loop);
        // CDP may start re-nav; next loop iteration cancels if realm left active.
        http_client.serviceInboundCdpIfReadable();
        if (!frame.hasDeferredDocumentParsePending() and !frame._document_parse_active) break;
    }
}

fn _tick(self: *Runner, comptime is_cdp: bool, opts: TickOpts) !CDPTickResult {
    // Refresh self.frame from session. In case of pending page, we want to
    // take its state while loading. If we use only the current frame, we will
    // return a .done result immediately.
    self.frame = self.session.pendingOrCurrentFrame() orelse return .done;
    const frame = self.frame;
    const http_client = self.http_client;

    switch (frame._parse_state) {
        .pre, .raw, .text, .image, .html => {
            // The main frame hasn't started/finished navigating.
            // There's no JS to run, and no reason to run the scheduler.
            // Include queue/ready_queue: SPA inject mid-callback parks transfers

            // HostIdle queues (not raw http_active alone).
            if (HostIdle.isNetworkIdle(http_client) and (comptime is_cdp) == false) {
                // Deferred HTML parse is scheduled from the HTTP callback; without
                // draining it here MCP runner.wait() returned .done while the URL
                // was set but the document was still empty (github.com).
                self.drainDeferredDocumentParse(is_cdp);
                if (frame._parse_state == .pre and !frame.hasDeferredDocumentParsePending() and !frame._document_parse_active) {
                    return .done;
                }
            }

            if (comptime is_cdp) {
                self.drainDeferredDocumentParse(is_cdp);
                const early = try http_client.tick(0);
                if (early == .cdp_socket) return .cdp_socket;
                // scheduleDeferredFrameNavigated queues the CDP Page.navigate ack at
                // header time. Waiting for http_active==0 delayed the response by
                // the full document body transfer (ebay.com ~400KB).
                var slices: u8 = 0;
                while (slices < 8) : (slices += 1) {
                    if (!try self.session.browser.runMacrotasksCdpSlice()) break;
                }
                frame._script_manager.base.pumpDocumentLifecycle(frame);
            }

            // Either we have active http connections, or we're in CDP
            // mode with an extra socket. Either way, we're waiting
            // for http traffic
            const http_result = try http_client.tick(@intCast(opts.ms));
            self.drainDeferredDocumentParse(is_cdp);
            if ((comptime is_cdp) and http_result == .cdp_socket) {
                return .cdp_socket;
            }
            return .{ .ok = 0 };
        },
        .complete => {
            // Service inbound CDP commands before macrotasks / background-task pumps.
            // ebay.com document load otherwise starves Runtime.evaluate for tens of seconds.
            if (comptime is_cdp) {
                const early = try http_client.tick(0);
                if (early == .cdp_socket) return .cdp_socket;
            }

            const session = self.session;
            if (session.currentPage()) |page| {
                if (page.queued_navigation.items.len != 0) {
                    try session.processQueuedNavigation();
                    // Root navigations (e.g. Google sg_ss via location.replace) may
                    // promote a pending Page; follow it so the next state machine
                    // pass ticks the in-flight document transfer.
                    self.frame = session.pendingOrCurrentFrame() orelse session.currentFrame().?;
                    // Queued navigations are often scheduled from frameDoneCallback
                    // while curl_multi_perform is active; kick curl immediately
                    // instead of waiting for the next CDP poll window.
                    _ = http_client.tick(0) catch {};
                    return .{ .ok = 0 };
                }
            }
            const browser = session.browser;

            // The HTML page was parsed. We now either have JS scripts to
            // download, or scheduled tasks to execute, or both.

            // scheduler.run could trigger new http transfers, so do not
            // store http_client.http_active BEFORE this call and then use
            // it AFTER.
            if (comptime is_cdp) {
                var slices: u8 = 0;
                while (slices < 64) : (slices += 1) {
                    const early = try http_client.tick(0);
                    if (early == .cdp_socket) return .cdp_socket;
                    if (!try browser.runMacrotasksCdpSlice()) break;
                }
            } else {
                try browser.runMacrotasks();
            }
            // commitPendingPage may have swapped active/pending during tick/macrotasks;
            // do not drain RTC (or read load/idle state) through a stale Frame ptr.
            self.frame = session.pendingOrCurrentFrame() orelse return .done;
            const live_frame = self.frame;
            // Single wait-edge spin (architecture v0.2): MessageChannel / delay-0
            // chains. Do not also spin inside Browser.runMacrotasks.
            const js_mod = @import("../js/js.zig");
            js_mod.EventLoop.spin(&live_frame.js.execution, .{
                .max_tasks = 48,
                .stop_when_idle = true,
            });
            live_frame._script_manager.base.pumpDocumentLifecycle(live_frame);
            live_frame.drainRtcEvents();

            // HostIdle: one formula for wait_until=done / networkIdle (queues included).
            const total_http_activity = HostIdle.totalHttpActivity(http_client);
            const network_idle = HostIdle.isNetworkIdle(http_client);
            const ms_to_next_macrotask = browser.msToNextMacrotask();
            const script_pending = live_frame._script_manager.base.hasPendingJsWork();
            const is_done = HostIdle.isFullyIdle(http_client, live_frame, browser);
            const immediate_host_work =
                js_mod.EventLoop.hasReadyWork(&live_frame.js.execution) or
                (ms_to_next_macrotask != null and ms_to_next_macrotask.? == 0);

            live_frame.checkIdleNotifications(total_http_activity);

            // `_we_` have nothing to run, but v8 is working on background tasks.
            // Wait for them (non-CDP only — CDP messages can arrive any time).
            if ((comptime is_cdp) == false and network_idle and browser.hasBackgroundTasks()) {
                browser.waitForBackgroundTasks();
                return .{ .ok = 0 };
            }

            const met = switch (opts.until) {
                .done => is_done,
                .domcontentloaded => live_frame._load_state == .load or live_frame._load_state == .complete,
                .load => live_frame._load_state == .complete,
                .networkidle => live_frame._notified_network_idle == .done,
            };

            // `met` resolves the wait goal. Otherwise, if the page is fully
            // idle (`is_done`) there is nothing left to wait on — resolve rather
            if ((met and !immediate_host_work) or is_done) {
                if (comptime is_cdp) {
                    // CDP event loop keeps ticking for commands; only leave when
                    // the explicit wait condition is met (not is_done alone for
                    // long-lived pages with ads that never go fully quiet).
                    if (met) return .done;
                } else {
                    return .done;
                }
            }

            // Keep ticking: network, scripts, or macrotasks still in flight (or CDP).
            var ms_to_wait = @min(opts.ms, ms_to_next_macrotask orelse 200);
            if (comptime is_cdp) {
                ms_to_wait = @min(ms_to_wait, 5);
            } else if (script_pending) {
                // Unevaluated SPA chunks: re-enter pumpDocumentLifecycle ASAP.
                ms_to_wait = 0;
            } else if (ms_to_wait > 10 and browser.hasBackgroundTasks()) {
                // if we have background tasks, we don't want to wait too
                // long for a message from the client. We want to go back
                // to the top of the loop and run macrotasks.
                ms_to_wait = 10;
            } else if (!network_idle and ms_to_wait > 50) {
                // Queued/active HTTP: poll more often so ready_queue promotes
                // and SPA post-load fetches make progress before wait timeout.
                ms_to_wait = 50;
            }
            const http_result = try http_client.tick(@intCast(@min(opts.ms, ms_to_wait)));
            if ((comptime is_cdp) and http_result == .cdp_socket) {
                return .cdp_socket;
            }
            // HttpClient.tick may no-op when there is nothing to poll (I/O idle,
            // only macrotasks pending). Returning .ok=0 would spin the wait loop;
            // instead sleep until the next scheduled task (LP #2999).
            if ((comptime is_cdp) == false and http_result == .idle) {
                return .{ .ok = @intCast(ms_to_wait) };
            }
            return .{ .ok = 0 };
        },
        .err => |err| {
            frame._parse_state = .{ .raw_done = @errorName(err) };
            return err;
        },
        .raw_done => {
            if (comptime is_cdp) {
                const http_result = try http_client.tick(@intCast(opts.ms));
                if (http_result == .cdp_socket) {
                    return .cdp_socket;
                }
                return .{ .ok = 0 };
            }
            return .done;
        },
    }
}

pub fn waitForSelector(self: *Runner, selector: [:0]const u8, timeout_ms: u32) !*Node.Element {
    const arena = try self.session.getArena(.small, "Runner.waitForSelector");
    defer self.session.releaseArena(arena);

    var timer = try std.time.Timer.start();
    const parsed_selector = try Selector.parseLeaky(arena, selector);

    while (true) {
        // self.frame can change between ticks
        const frame = self.frame;
        if (try parsed_selector.query(frame.document.asNode(), frame)) |el| {
            return el;
        }

        const elapsed: u32 = @intCast(timer.read() / std.time.ns_per_ms);
        if (elapsed >= timeout_ms) {
            return error.Timeout;
        }
        // Page may be idle (.done) while wait condition not yet true — keep
        // spinning until wall timeout (architecture D1).
        switch (try self.tick(.{ .ms = timeout_ms - elapsed })) {
            .done => {
                // Still pump host tasks; only fail on wall clock.
                const js_mod = @import("../js/js.zig");
                js_mod.EventLoop.spin(&self.frame.js.execution, .{ .max_tasks = 16, .stop_when_idle = true });
                std.Thread.sleep(std.time.ns_per_ms * 5);
            },
            .ok => |recommended_sleep_ms| {
                if (recommended_sleep_ms > 0) {
                    std.Thread.sleep(std.time.ns_per_ms * recommended_sleep_ms);
                }
            },
        }
    }
}

pub fn waitForScript(runner: *Runner, script: [:0]const u8, timeout_ms: u32) !void {
    var timer = try std.time.Timer.start();

    while (true) {
        const frame = runner.frame;

        // Execute the script and check if it returns truthy
        var ls: js.Local.Scope = undefined;
        frame.js.localScope(&ls);
        defer ls.deinit();

        var try_catch: js.TryCatch = undefined;
        try_catch.init(&ls.local);
        defer try_catch.deinit();

        const value = ls.local.exec(script, "wait_script") catch |err| {
            const caught = try_catch.caughtOrError(frame.call_arena, err);
            log.err(.app, "wait script error", .{ .err = caught });
            return error.ScriptError;
        };

        if (value.toBool()) {
            return;
        }

        const elapsed: u32 = @intCast(timer.read() / std.time.ns_per_ms);
        if (elapsed >= timeout_ms) {
            return error.Timeout;
        }
        // Idle page (.done) is not wait_script timeout — keep EventLoop spinning.
        switch (try runner.tick(.{ .ms = timeout_ms - elapsed })) {
            .done => {
                const js_mod = @import("../js/js.zig");
                js_mod.EventLoop.spin(&runner.frame.js.execution, .{ .max_tasks = 16, .stop_when_idle = true });
                std.Thread.sleep(std.time.ns_per_ms * 5);
            },
            .ok => |recommended_sleep_ms| {
                if (recommended_sleep_ms > 0) {
                    std.Thread.sleep(std.time.ns_per_ms * recommended_sleep_ms);
                }
            },
        }
    }
}

const testing = @import("../../testing/testing.zig");
test "Runner: no page" {
    try testing.expectError(error.NoPage, Runner.init(testing.test_session, .{}));
}

test "Runner: waitForSelector timeout" {
    const frame = try testing.pageTest("runner/runner1.html", .{});
    defer frame._session.removePage();

    var runner = try frame._session.runner(.{});
    try testing.expectError(error.Timeout, runner.waitForSelector("#nope", 10));
}

test "Runner: waitForSelector" {
    defer testing.reset();
    const frame = try testing.pageTest("runner/runner1.html", .{});
    defer frame._session.removePage();

    var runner = try frame._session.runner(.{});
    const el = try runner.waitForSelector("#sel1", 10);
    try testing.expectEqual("selector-1-content", try el.asNode().getTextContentAlloc(testing.arena_allocator));
}

test "Runner: waitForScript timeout" {
    const frame = try testing.pageTest("runner/runner1.html", .{});
    defer frame._session.removePage();

    var runner = try frame._session.runner(.{});
    try testing.expectError(error.Timeout, runner.waitForScript("document.querySelector('#nope')", 10));
}

test "Runner: waitForScript" {
    const frame = try testing.pageTest("runner/runner1.html", .{});
    defer frame._session.removePage();

    var runner = try frame._session.runner(.{});
    try runner.waitForScript("document.querySelector('#sel1')", 10);
}
