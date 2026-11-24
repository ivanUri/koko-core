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
const sync = @import("../../support/sync.zig");

const App = @import("../../runtime/App.zig");
const build_config = @import("build_config");
const CDP = @import("../../protocols/cdp/CDP.zig");
const Config = @import("../../runtime/Config.zig");
const CDPClient = @import("../../core/browser/HttpClient.zig").CDPClient;
const WsConnection = @import("../../runtime/network/WsConnection.zig");
const ResourceController = @import("../../runtime/ResourceController.zig");
const ResourceSampler = @import("../../runtime/ResourceSampler.zig");

const log = @import("../../support/log.zig");
const net = @import("../../support/net.zig");
const io = @import("../../support/io.zig");
const posix = @import("../../support/posix.zig");
const Allocator = std.mem.Allocator;
const nanoTimestamp = @import("../../support/datetime.zig").nanoTimestamp;

const Server = @This();

const HandshakeSnapshot = struct {
    cdp: *CDP,
    deadline_ns: i128,
};

app: *App,
json_version_response: []const u8,
resource_controller: *ResourceController,

// Thread and admission management
active_threads: std.atomic.Value(u32) = .init(0),
// Only upgraded WebSocket sessions consume the configured CDP connection
// quota. Pending sockets have a separate bounded admission counter below so
// slow handshakes cannot make the two options behave as the same limit.
active_connections: std.atomic.Value(u32) = .init(0),
// Accepted sockets spend their first phase in a multiplexed HTTP upgrade. Keep
// that phase bounded separately from upgraded CDP workers: a burst of clients
// that never sends an Upgrade request must not consume the V8/session quota;
// pending transport state remains bounded by this independent counter.
pending_handshakes: std.atomic.Value(u32) = .init(0),
pending: std.ArrayList(*CDP) = .empty,

// A single coordinator multiplexes all transport-only handshakes. It is
// deliberately separate from Network's HTTP/curl loop: CDP upgrade parsing
// can send a response, but must never block page/network progress.
coordinator_shutdown: std.atomic.Value(bool) = .init(false),
coordinator_wakeup_pipe: [2]posix.fd_t,
coordinator_pollfds: []posix.pollfd,
coordinator_snapshots: []HandshakeSnapshot,

conns: std.ArrayList(*CDP) = .empty,
conns_mutex: sync.Mutex = .{},
conns_pool: std.heap.MemoryPool(CDP),

pub fn init(app: *App, address: net.Address) !*Server {
    const json_version_response = try buildJSONVersionResponse(app);
    errdefer app.allocator.free(json_version_response);

    const self = try app.allocator.create(Server);
    errdefer app.allocator.destroy(self);

    const coordinator_wakeup_pipe = try posix.pipe2(.{ .NONBLOCK = true, .CLOEXEC = true });
    var coordinator_started = false;
    errdefer if (!coordinator_started) {
        posix.close(coordinator_wakeup_pipe[0]);
        posix.close(coordinator_wakeup_pipe[1]);
    };

    const coordinator_capacity: usize = @intCast(app.config.maxPendingConnections());
    const coordinator_pollfds = try app.allocator.alloc(posix.pollfd, coordinator_capacity + 1);
    errdefer if (!coordinator_started) app.allocator.free(coordinator_pollfds);
    const coordinator_snapshots = try app.allocator.alloc(HandshakeSnapshot, coordinator_capacity);
    errdefer if (!coordinator_started) app.allocator.free(coordinator_snapshots);

    self.* = .{
        .app = app,
        .resource_controller = &app.resource_controller,
        .conns_pool = .empty,
        .json_version_response = json_version_response,
        .coordinator_wakeup_pipe = coordinator_wakeup_pipe,
        .coordinator_pollfds = coordinator_pollfds,
        .coordinator_snapshots = coordinator_snapshots,
    };
    errdefer self.conns_pool.deinit(app.allocator);

    var bound_address = address;
    try self.app.network.bind(&bound_address, self, onAccept);

    _ = self.active_threads.fetchAdd(1, .monotonic);
    const coordinator = std.Thread.spawn(.{}, runHandshakeCoordinator, .{self}) catch |err| {
        _ = self.active_threads.fetchSub(1, .monotonic);
        // bind() installed this Server as the accept callback. If the
        // coordinator cannot start, stop accepting before the partially
        // initialized Server is released; otherwise Network may later call
        // through a dangling ctx pointer.
        self.app.network.unbind();
        return err;
    };
    coordinator.detach();
    coordinator_started = true;

    log.info(.app, "server running", .{ .address = bound_address });

    return self;
}

pub fn shutdown(self: *Server) void {
    self.coordinator_shutdown.store(true, .release);

    self.conns_mutex.lock();

    self.app.network.unbind();

    for (self.conns.items) |cdp| {
        cdp.browser.env.terminate();
        // Do not send through WsConnection from the shutdown thread: the
        // active worker may concurrently use send_arena and socket flags.
        // A full shutdown wakes that worker and lets its own defer path clean
        // up the connection safely.
        cdp.ws.shutdownPeer();
    }

    for (self.pending.items) |conn| {
        conn.ws.shutdown();
    }

    self.conns_mutex.unlock();
    self.wakeupHandshakeCoordinator();
}

pub fn deinit(self: *Server) void {
    self.shutdown();

    while (self.active_threads.load(.monotonic) > 0) {
        std.Io.sleep(io.get(), .fromMilliseconds(10), .awake) catch {};
    }

    // The coordinator exits as soon as shutdown is signalled, so pending
    // sockets are not guaranteed to pass through finishPendingHandshake.
    // Reclaim them after all server threads have stopped; otherwise their
    // transport arenas, pool entries, and file descriptors would survive
    // until process exit (and repeated in-process server tests would leak).
    while (true) {
        self.conns_mutex.lock();
        const pending = self.pending.pop();
        self.conns_mutex.unlock();
        const conn = pending orelse break;
        self.resource_controller.release(.pending_handshake) catch |err| {
            log.err(.app, "CDP pending resource drain", .{ .err = err });
        };
        self.destroyTransport(conn);
    }

    self.conns.deinit(self.app.allocator);
    self.pending.deinit(self.app.allocator);
    self.app.allocator.free(self.coordinator_pollfds);
    self.app.allocator.free(self.coordinator_snapshots);
    posix.close(self.coordinator_wakeup_pipe[0]);
    posix.close(self.coordinator_wakeup_pipe[1]);
    self.conns_pool.deinit(self.app.allocator);
    self.app.allocator.free(self.json_version_response);
    self.app.allocator.destroy(self);
}

fn onAccept(ctx: *anyopaque, socket: posix.socket_t) void {
    const self: *Server = @ptrCast(@alignCast(ctx));
    self.spawnWorker(socket) catch |err| {
        switch (err) {
            // These are normal admission outcomes under load, not runtime
            // faults. Keep them observable without turning a handshake flood
            // into an error-log storm.
            error.MaxPendingConnectionsReached => log.info(.app, "CDP pending limit reached", .{}),
            error.ShuttingDown => {},
            else => log.err(.app, "CDP spawn", .{ .err = err }),
        }
        posix.close(socket);
    };
}

fn spawnWorker(self: *Server, socket: posix.socket_t) !void {
    if (self.app.shutdown() or self.coordinator_shutdown.load(.acquire)) {
        return error.ShuttingDown;
    }

    // Reserve the handshake slot before reserving a worker. This rejects a
    // handshake flood without needlessly consuming the bounded CDP worker
    // quota. The slot is released as soon as the upgrade attempt completes.
    self.resource_controller.reserve(.pending_handshake, ResourceSampler.sample(io.get())) catch |err| {
        return switch (err) {
            error.MaxPendingHandshakes => error.MaxPendingConnectionsReached,
            else => err,
        };
    };
    var resource_pending_reserved = true;
    errdefer if (resource_pending_reserved) {
        self.resource_controller.release(.pending_handshake) catch {};
    };

    const max_pending = self.app.config.maxPendingConnections();
    var pending = self.pending_handshakes.load(.monotonic);
    while (pending < max_pending) {
        pending = self.pending_handshakes.cmpxchgWeak(pending, pending + 1, .monotonic, .monotonic) orelse break;
    } else {
        return error.MaxPendingConnectionsReached;
    }
    errdefer _ = self.pending_handshakes.fetchSub(1, .monotonic);

    // Allocate and initialize transport state on the network/acceptor thread.
    // The coordinator must not touch the general allocator during setup: on Linux the
    // allocator can create a large per-thread arena, which would turn a
    // handshake flood into gigabytes of virtual address reservations.
    const cdp = self.allocConn() catch |err| {
        log.err(.app, "CDP alloc", .{ .err = err });
        return err;
    };
    var cdp_owned = true;
    var transport_initialized = false;
    defer if (cdp_owned) {
        // initTransport owns cleanup of partially initialized arena state.
        // Calling CDP.deinit after it fails would access an uninitialized
        // WsConnection when fcntl/reader allocation failed.
        if (transport_initialized) cdp.deinit();
        self.releaseConn(cdp);
    };

    cdp.initTransport(self.app, socket, self.json_version_response) catch |err| {
        log.err(.app, "CDP init", .{ .err = err });
        return err;
    };
    transport_initialized = true;
    cdp.handshake_deadline_ns = nanoTimestamp(.monotonic) +
        @as(i128, Config.CDP_HANDSHAKE_TIMEOUT_MS) * std.time.ns_per_ms;
    self.registerHandshake(cdp) catch |err| {
        log.err(.app, "CDP pending registration", .{ .err = err });
        return err;
    };
    resource_pending_reserved = false;
    cdp_owned = false;
    self.wakeupHandshakeCoordinator();
}

fn runHandshakeCoordinator(self: *Server) void {
    defer _ = self.active_threads.fetchSub(1, .monotonic);

    var drain_buf: [64]u8 = undefined;
    while (!self.coordinator_shutdown.load(.acquire)) {
        var count: usize = 1;
        self.coordinator_pollfds[0] = .{
            .fd = self.coordinator_wakeup_pipe[0],
            .events = posix.POLL.IN,
            .revents = 0,
        };

        var timeout_ms: i32 = 1000;
        const now = nanoTimestamp(.monotonic);
        self.conns_mutex.lock();
        for (self.pending.items) |cdp| {
            if (count > self.coordinator_snapshots.len) break;
            self.coordinator_snapshots[count - 1] = .{ .cdp = cdp, .deadline_ns = cdp.handshake_deadline_ns };
            self.coordinator_pollfds[count] = .{
                .fd = cdp.ws.socket,
                .events = posix.POLL.IN,
                .revents = 0,
            };
            count += 1;
            const remaining_ns = cdp.handshake_deadline_ns - now;
            const remaining_ms: i32 = if (remaining_ns <= 0)
                0
            else
                @intCast(@min(
                    @as(u64, @intCast(@divTrunc(remaining_ns, std.time.ns_per_ms))),
                    @as(u64, std.math.maxInt(i32)),
                ));
            timeout_ms = @min(timeout_ms, remaining_ms);
        }
        self.conns_mutex.unlock();

        _ = posix.poll(self.coordinator_pollfds[0..count], timeout_ms) catch |err| {
            if (!self.coordinator_shutdown.load(.acquire)) {
                log.err(.app, "CDP handshake poll", .{ .err = err });
            }
            continue;
        };

        if (self.coordinator_pollfds[0].revents != 0) {
            while (true) _ = posix.read(self.coordinator_wakeup_pipe[0], &drain_buf) catch break;
        }

        const now_after_poll = nanoTimestamp(.monotonic);
        for (self.coordinator_snapshots[0 .. count - 1], 1..) |snapshot, index| {
            const ready = self.coordinator_pollfds[index].revents != 0;
            const expired = now_after_poll >= snapshot.deadline_ns;
            if (!ready and !expired) continue;

            var upgraded = false;
            if (ready and !expired) {
                const step = snapshot.cdp.ws.handshakeStep() catch |err| {
                    log.warn(.app, "CDP handshake", .{ .err = err });
                    snapshot.cdp.ws.shutdownPeer();
                    self.finishPendingHandshake(snapshot.cdp, false);
                    continue;
                };
                switch (step) {
                    .pending => continue,
                    .upgraded => upgraded = true,
                    .close => {},
                }
            } else {
                log.info(.app, "CDP handshake timeout", .{ .timeout_ms = Config.CDP_HANDSHAKE_TIMEOUT_MS });
                snapshot.cdp.ws.shutdownPeer();
            }
            self.finishPendingHandshake(snapshot.cdp, upgraded);
        }
    }
}

fn finishPendingHandshake(self: *Server, cdp: *CDP, upgraded: bool) void {
    self.unregisterHandshake(cdp);
    _ = self.pending_handshakes.fetchSub(1, .monotonic);
    if (!upgraded) {
        self.resource_controller.release(.pending_handshake) catch |err| {
            log.err(.app, "CDP pending resource release", .{ .err = err });
        };
        self.destroyTransport(cdp);
        return;
    }

    // Reserve the real CDP session slot only after the WebSocket upgrade. A
    // pending socket is cheap transport state; an upgraded session owns V8,
    // browser state, and the long-lived CDP worker quota.
    self.resource_controller.promotePendingToActive(ResourceSampler.sample(io.get())) catch |err| {
        log.info(.app, "CDP connection limit reached after handshake", .{
            .err = err,
        });
        self.resource_controller.release(.pending_handshake) catch {};
        cdp.ws.shutdown();
        self.destroyTransport(cdp);
        return;
    };
    _ = self.active_connections.fetchAdd(1, .monotonic);

    if (self.app.shutdown() or self.coordinator_shutdown.load(.acquire)) {
        self.resource_controller.release(.active_worker) catch {};
        _ = self.active_connections.fetchSub(1, .monotonic);
        self.destroyTransport(cdp);
        return;
    }

    // Enter V8/CDP dispatch only on a full-stack worker. Pending sockets never
    // reserve this worker or its native stack.
    _ = self.active_threads.fetchAdd(1, .monotonic);
    const thread = std.Thread.spawn(.{
        .stack_size = self.app.config.cdpThreadStackBytes(),
    }, handleUpgradedConnection, .{ self, cdp }) catch |err| {
        log.err(.app, "CDP worker handoff", .{ .err = err });
        _ = self.active_threads.fetchSub(1, .monotonic);
        self.resource_controller.release(.active_worker) catch {};
        _ = self.active_connections.fetchSub(1, .monotonic);
        self.destroyTransport(cdp);
        return;
    };
    thread.detach();
}

fn destroyTransport(self: *Server, cdp: *CDP) void {
    const socket = cdp.ws.socket;
    cdp.deinit();
    self.releaseConn(cdp);
    posix.close(socket);
}

fn handleUpgradedConnection(self: *Server, cdp: *CDP) void {
    defer _ = self.active_threads.fetchSub(1, .monotonic);
    defer _ = self.active_connections.fetchSub(1, .monotonic);
    defer self.resource_controller.release(.active_worker) catch |err| {
        log.err(.app, "CDP active resource release", .{ .err = err });
    };
    const socket = cdp.ws.socket;
    defer posix.close(socket);
    defer self.releaseConn(cdp);
    defer cdp.deinit();

    // Do not create the V8/browser worker until the WebSocket upgrade has
    // proved that this is a real CDP client. The coordinator handles only
    // transport parsing; this worker owns all expensive V8/browser state.
    cdp.initBrowser() catch |err| {
        log.err(.app, "CDP browser init", .{ .err = err });
        return;
    };
    self.resource_controller.updateSample(ResourceSampler.sample(io.get()));
    defer self.resource_controller.updateSample(ResourceSampler.sample(io.get()));

    self.registerConn(cdp) catch |err| {
        // An unregistered active worker is invisible to shutdown() and can
        // make deinit wait forever. Fail the handoff instead of silently
        // continuing when the connection registry cannot grow.
        log.err(.app, "CDP connection registration", .{ .err = err });
        return;
    };
    defer self.unregisterConn(cdp);

    // Check shutdown after registering to avoid missing the stop signal.
    // If shutdown() already iterated over conns, this conn won't be terminated
    // and would block deinit() indefinitely.
    if (self.app.shutdown()) {
        return;
    }

    while (true) {
        const next = cdp.tick() catch |err| {
            log.err(.app, "cdp tick", .{ .err = err });
            return;
        };
        if (!next) break;
    }
}

fn registerHandshake(self: *Server, conn: *CDP) !void {
    self.conns_mutex.lock();
    defer self.conns_mutex.unlock();

    try self.pending.append(self.app.allocator, conn);
}

fn unregisterHandshake(self: *Server, conn: *CDP) void {
    self.conns_mutex.lock();
    defer self.conns_mutex.unlock();

    for (self.pending.items, 0..) |w, i| {
        if (w == conn) {
            _ = self.pending.swapRemove(i);
            break;
        }
    }
}

fn wakeupHandshakeCoordinator(self: *Server) void {
    _ = posix.write(self.coordinator_wakeup_pipe[1], &.{1}) catch {};
}

fn allocConn(self: *Server) !*CDP {
    self.conns_mutex.lock();
    defer self.conns_mutex.unlock();
    return self.conns_pool.create(self.app.allocator);
}

fn releaseConn(self: *Server, conn: *CDP) void {
    self.conns_mutex.lock();
    defer self.conns_mutex.unlock();
    self.conns_pool.destroy(conn);
}

fn registerConn(self: *Server, conn: *CDP) !void {
    self.conns_mutex.lock();
    defer self.conns_mutex.unlock();
    try self.conns.append(self.app.allocator, conn);
}

fn unregisterConn(self: *Server, conn: *CDP) void {
    self.conns_mutex.lock();
    defer self.conns_mutex.unlock();
    for (self.conns.items, 0..) |c, i| {
        if (c == conn) {
            _ = self.conns.swapRemove(i);
            break;
        }
    }
}

// Utils
// --------

fn buildJSONVersionResponse(
    app: *const App,
) ![]const u8 {
    const port = app.config.port();
    const host = app.config.advertiseHost();
    if (std.mem.eql(u8, host, "0.0.0.0")) {
        log.info(.cdp, "unreachable advertised host", .{
            .message = "when --host is set to 0.0.0.0 consider setting --advertise-host to a reachable address",
        });
    }
    const body_format =
        "{{" ++
        "\"Browser\": \"Koko/1.0\", " ++
        "\"Protocol-Version\": \"1.3\", " ++
        "\"User-Agent\": \"Koko/1.0\", " ++
        "\"webSocketDebuggerUrl\": \"ws://{s}:{d}/\", " ++
        "\"kokoBuild\": {{\"v8PointerCompression\": {}, \"v8MissingShims\": {}}}, " ++
        "\"kokoStartup\": {{" ++
        "\"totalUs\": {d}, " ++
        "\"platformUs\": {d}, " ++
        "\"snapshotUs\": {d}, " ++
        "\"storageUs\": {d}, " ++
        "\"networkUs\": {d}, " ++
        "\"appDirUs\": {d}, " ++
        "\"telemetryUs\": {d}, " ++
        "\"arenaPoolUs\": {d}" ++
        "}}" ++
        "}}";
    const startup = app.startupMetrics();
    const body_len = std.fmt.count(body_format, .{
        host,
        port,
        build_config.v8_enable_pointer_compression,
        build_config.v8_missing_shims,
        startup.total_us,
        startup.platform_us,
        startup.snapshot_us,
        startup.storage_us,
        startup.network_us,
        startup.app_dir_us,
        startup.telemetry_us,
        startup.arena_pool_us,
    });

    // We send a Connection: Close (and actually close the connection)
    // because chromedp (Go driver) sends a request to /json/version and then
    // does an upgrade request, on a different connection. Since we only allow
    // 1 connection at a time, the upgrade connection doesn't proceed until we
    // timeout the /json/version. So, instead of waiting for that, we just
    // always close HTTP requests.
    const response_format =
        "HTTP/1.1 200 OK\r\n" ++
        "Content-Length: {d}\r\n" ++
        "Connection: Close\r\n" ++
        "Content-Type: application/json; charset=UTF-8\r\n\r\n" ++
        body_format;
    return try std.fmt.allocPrint(app.allocator, response_format, .{
        body_len,
        host,
        port,
        build_config.v8_enable_pointer_compression,
        build_config.v8_missing_shims,
        startup.total_us,
        startup.platform_us,
        startup.snapshot_us,
        startup.storage_us,
        startup.network_us,
        startup.app_dir_us,
        startup.telemetry_us,
        startup.arena_pool_us,
    });
}

pub const timestamp = @import("../../support/datetime.zig").timestamp;
pub const milliTimestamp = @import("../../support/datetime.zig").milliTimestamp;

const testing = @import("../../testing/testing.zig");
test "server: buildJSONVersionResponse" {
    const res = try buildJSONVersionResponse(testing.test_app);
    defer testing.test_app.allocator.free(res);

    // The response includes the build version, so check structure rather than exact bytes.
    try testing.expect(std.mem.startsWith(u8, res, "HTTP/1.1 200 OK\r\n"));
    try testing.expect(std.mem.indexOf(u8, res, "Content-Type: application/json") != null);
    try testing.expect(std.mem.indexOf(u8, res, "Connection: Close") != null);

    // Verify all required JSON fields are present in the body
    try testing.expect(std.mem.indexOf(u8, res, "\"Browser\": \"Koko/") != null);
    try testing.expect(std.mem.indexOf(u8, res, "\"Protocol-Version\": \"1.3\"") != null);
    try testing.expect(std.mem.indexOf(u8, res, "\"User-Agent\": \"Koko/") != null);
    try testing.expect(std.mem.indexOf(u8, res, "\"webSocketDebuggerUrl\": \"ws://127.0.0.1:9222/\"") != null);
    try testing.expect(std.mem.indexOf(u8, res, "\"kokoStartup\": {") != null);
}

test "Client: http invalid request" {
    var c = try createTestClient();
    defer c.deinit();

    const res = try c.httpRequest("GET /over/9000 HTTP/1.1\r\n" ++ "Header: " ++ ("a" ** 4100) ++ "\r\n\r\n");
    try testing.expectEqual("HTTP/1.1 413 \r\n" ++
        "Connection: Close\r\n" ++
        "Content-Length: 17\r\n\r\n" ++
        "Request too large", res);
}

test "Client: http invalid handshake" {
    try assertHTTPError(
        400,
        "Invalid request",
        "\r\n\r\n",
    );

    try assertHTTPError(
        404,
        "Not found",
        "GET /over/9000 HTTP/1.1\r\n\r\n",
    );

    try assertHTTPError(
        404,
        "Not found",
        "POST / HTTP/1.1\r\n\r\n",
    );

    try assertHTTPError(
        400,
        "Invalid HTTP protocol",
        "GET / HTTP/1.0\r\n\r\n",
    );

    try assertHTTPError(
        400,
        "Missing required header",
        "GET / HTTP/1.1\r\n\r\n",
    );

    try assertHTTPError(
        400,
        "Missing required header",
        "GET / HTTP/1.1\r\nConnection:  upgrade\r\n\r\n",
    );

    try assertHTTPError(
        400,
        "Missing required header",
        "GET / HTTP/1.1\r\nConnection: upgrade\r\nUpgrade: websocket\r\n\r\n",
    );

    try assertHTTPError(
        400,
        "Missing required header",
        "GET / HTTP/1.1\r\nConnection: upgrade\r\nUpgrade: websocket\r\nsec-websocket-version:13\r\n\r\n",
    );
}

test "Client: http valid handshake" {
    var c = try createTestClient();
    defer c.deinit();

    const request =
        "GET /   HTTP/1.1\r\n" ++
        "Connection: upgrade\r\n" ++
        "Upgrade: websocket\r\n" ++
        "sec-websocket-version:13\r\n" ++
        "sec-websocket-key: this is my key\r\n" ++
        "Custom:  Header-Value\r\n\r\n";

    const res = try c.httpRequest(request);
    try testing.expectEqual("HTTP/1.1 101 Switching Protocols\r\n" ++
        "Upgrade: websocket\r\n" ++
        "Connection: upgrade\r\n" ++
        "Sec-Websocket-Accept: flzHu2DevQ2dSCSVqKSii5e9C2o=\r\n\r\n", res);
}

test "Client: read invalid websocket message" {
    // 131 = 128 (fin) | 3  where 3 isn't a valid type
    try assertWebSocketError(
        1002,
        &.{ 131, 128, 'm', 'a', 's', 'k' },
    );

    for ([_]u8{ 16, 32, 64 }) |rsv| {
        // none of the reserve flags should be set
        try assertWebSocketError(
            1002,
            &.{ rsv, 128, 'm', 'a', 's', 'k' },
        );

        // as a bitmask
        try assertWebSocketError(
            1002,
            &.{ rsv + 4, 128, 'm', 'a', 's', 'k' },
        );
    }

    // client->server messages must be masked
    try assertWebSocketError(
        1002,
        &.{ 129, 1, 'a' },
    );

    // control types (ping/ping/close) can't be > 125 bytes
    for ([_]u8{ 136, 137, 138 }) |op| {
        try assertWebSocketError(
            1002,
            &.{ op, 254, 1, 1 },
        );
    }

    // length of message is 0000 0810, i.e: 1024 * 512 + 265
    try assertWebSocketError(1009, &.{ 129, 255, 0, 0, 0, 0, 0, 8, 1, 0, 'm', 'a', 's', 'k' });

    // continuation type message must come after a normal message
    // even when not a fin frame
    try assertWebSocketError(
        1002,
        &.{ 0, 129, 'm', 'a', 's', 'k', 'd' },
    );

    // continuation type message must come after a normal message
    // even as a fin frame
    try assertWebSocketError(
        1002,
        &.{ 128, 129, 'm', 'a', 's', 'k', 'd' },
    );

    // text (non-fin) - text (non-fin)
    try assertWebSocketError(
        1002,
        &.{ 1, 129, 'm', 'a', 's', 'k', 'd', 1, 128, 'k', 's', 'a', 'm' },
    );

    // text (non-fin) - text (fin) should always been continuation after non-fin
    try assertWebSocketError(
        1002,
        &.{ 1, 129, 'm', 'a', 's', 'k', 'd', 129, 128, 'k', 's', 'a', 'm' },
    );

    // close must be fin
    try assertWebSocketError(
        1002,
        &.{
            8, 129, 'm', 'a', 's', 'k', 'd',
        },
    );

    // ping must be fin
    try assertWebSocketError(
        1002,
        &.{
            9, 129, 'm', 'a', 's', 'k', 'd',
        },
    );

    // pong must be fin
    try assertWebSocketError(
        1002,
        &.{
            10, 129, 'm', 'a', 's', 'k', 'd',
        },
    );
}

test "Client: ping reply" {
    try assertWebSocketMessage(
        // fin | pong, len
        &.{ 138, 0 },

        // fin | ping, masked | len, 4-byte mask
        &.{ 137, 128, 0, 0, 0, 0 },
    );

    try assertWebSocketMessage(
        // fin | pong, len, payload
        &.{ 138, 5, 100, 96, 97, 109, 104 },

        // fin | ping, masked | len, 4-byte mask, 5 byte payload
        &.{ 137, 133, 0, 5, 7, 10, 100, 101, 102, 103, 104 },
    );
}

test "Client: close message" {
    try assertWebSocketMessage(
        // fin | close, len, close code (normal)
        &.{ 136, 2, 3, 232 },

        // fin | close, masked | len, 4-byte mask
        &.{ 136, 128, 0, 0, 0, 0 },
    );
}

test "server: 404" {
    var c = try createTestClient();
    defer c.deinit();

    const res = try c.httpRequest("GET /unknown HTTP/1.1\r\n\r\n");
    try testing.expectEqual("HTTP/1.1 404 \r\n" ++
        "Connection: Close\r\n" ++
        "Content-Length: 9\r\n\r\n" ++
        "Not found", res);
}

test "server: get /json/version" {
    {
        // twice on the same connection
        var c = try createTestClient();
        defer c.deinit();

        const res1 = try c.httpRequest("GET /json/version HTTP/1.1\r\n\r\n");
        try testing.expect(std.mem.startsWith(u8, res1, "HTTP/1.1 200 OK\r\n"));
        try testing.expect(std.mem.indexOf(u8, res1, "\"Browser\": \"Koko/") != null);
        try testing.expect(std.mem.indexOf(u8, res1, "\"Protocol-Version\": \"1.3\"") != null);
        try testing.expect(std.mem.indexOf(u8, res1, "\"webSocketDebuggerUrl\": \"ws://127.0.0.1:9222/\"") != null);
        try testing.expect(std.mem.indexOf(u8, res1, "\"kokoBuild\": {") != null);
    }

    {
        // again on a new connection
        var c = try createTestClient();
        defer c.deinit();

        const res1 = try c.httpRequest("GET /json/version HTTP/1.1\r\n\r\n");
        try testing.expect(std.mem.startsWith(u8, res1, "HTTP/1.1 200 OK\r\n"));
        try testing.expect(std.mem.indexOf(u8, res1, "\"Browser\": \"Koko/") != null);
    }
}

fn assertHTTPError(
    comptime expected_status: u16,
    comptime expected_body: []const u8,
    input: []const u8,
) !void {
    var c = try createTestClient();
    defer c.deinit();

    const res = try c.httpRequest(input);
    const expected_response = std.fmt.comptimePrint(
        "HTTP/1.1 {d} \r\nConnection: Close\r\nContent-Length: {d}\r\n\r\n{s}",
        .{ expected_status, expected_body.len, expected_body },
    );

    try testing.expectEqual(expected_response, res);
}

fn assertWebSocketError(close_code: u16, input: []const u8) !void {
    var c = try createTestClient();
    defer c.deinit();

    try c.handshake();
    try writeAll(c.stream, input);

    const msg = try c.readWebsocketMessage() orelse return error.NoMessage;
    defer if (msg.cleanup_fragment) {
        c.reader.cleanup();
    };

    try testing.expectEqual(.close, msg.type);
    try testing.expectEqual(2, msg.data.len);
    try testing.expectEqual(close_code, std.mem.readInt(u16, msg.data[0..2], .big));
}

fn assertWebSocketMessage(expected: []const u8, input: []const u8) !void {
    var c = try createTestClient();
    defer c.deinit();

    try c.handshake();
    try writeAll(c.stream, input);

    const msg = try c.readWebsocketMessage() orelse return error.NoMessage;
    defer if (msg.cleanup_fragment) {
        c.reader.cleanup();
    };

    const actual = c.reader.buf[0 .. msg.data.len + 2];
    try testing.expectEqualSlices(u8, expected, actual);
}

const MockCDP = struct {
    messages: std.ArrayList([]const u8) = .empty,

    allocator: Allocator = testing.allocator,

    fn init(_: Allocator, client: anytype) MockCDP {
        _ = client;
        return .{};
    }

    fn deinit(self: *MockCDP) void {
        const allocator = self.allocator;
        for (self.messages.items) |msg| {
            allocator.free(msg);
        }
        self.messages.deinit(allocator);
    }

    fn handleMessage(self: *MockCDP, message: []const u8) bool {
        const owned = self.allocator.dupe(u8, message) catch unreachable;
        self.messages.append(self.allocator, owned) catch unreachable;
        return true;
    }
};

fn createTestClient() !TestClient {
    const address = net.Address.initIp4([_]u8{ 127, 0, 0, 1 }, 9583);
    const stream = try posix.socket(posix.AF.INET, posix.SOCK.STREAM, 0);
    errdefer posix.close(stream);
    try posix.connect(stream, &address.any, address.getOsSockLen());

    const timeout = std.mem.toBytes(posix.timeval{
        .sec = 2,
        .usec = 0,
    });
    try posix.setsockopt(stream, posix.SOL.SOCKET, posix.SO.RCVTIMEO, &timeout);
    try posix.setsockopt(stream, posix.SOL.SOCKET, posix.SO.SNDTIMEO, &timeout);
    return .{
        .stream = stream,
        .reader = .{
            .allocator = testing.allocator,
            .buf = try testing.allocator.alloc(u8, 1024 * 16),
        },
    };
}

const TestClient = struct {
    stream: posix.socket_t,
    buf: [1024]u8 = undefined,
    reader: WsConnection.Reader(false),

    fn deinit(self: *TestClient) void {
        posix.close(self.stream);
        self.reader.deinit();
    }

    fn httpRequest(self: *TestClient, req: []const u8) ![]const u8 {
        try writeAll(self.stream, req);

        var pos: usize = 0;
        var total_length: ?usize = null;
        while (true) {
            pos += try posix.read(self.stream, self.buf[pos..]);
            if (pos == 0) {
                return error.NoMoreData;
            }
            const response = self.buf[0..pos];
            if (total_length == null) {
                const header_end = std.mem.indexOf(u8, response, "\r\n\r\n") orelse continue;
                const header = response[0 .. header_end + 4];

                const cl = blk: {
                    const cl_header = "Content-Length: ";
                    const start = (std.mem.indexOf(u8, header, cl_header) orelse {
                        break :blk 0;
                    }) + cl_header.len;

                    const end = std.mem.indexOfScalarPos(u8, header, start, '\r') orelse {
                        return error.InvalidContentLength;
                    };

                    break :blk std.fmt.parseInt(usize, header[start..end], 10) catch {
                        return error.InvalidContentLength;
                    };
                };

                total_length = cl + header.len;
            }

            if (total_length) |tl| {
                if (pos == tl) {
                    return response;
                }
                if (pos > tl) {
                    return error.DataExceedsContentLength;
                }
            }
        }
    }

    fn handshake(self: *TestClient) !void {
        const request =
            "GET /   HTTP/1.1\r\n" ++
            "Connection: upgrade\r\n" ++
            "Upgrade: websocket\r\n" ++
            "sec-websocket-version:13\r\n" ++
            "sec-websocket-key: this is my key\r\n" ++
            "Custom:  Header-Value\r\n\r\n";

        const res = try self.httpRequest(request);
        try testing.expectEqual("HTTP/1.1 101 Switching Protocols\r\n" ++
            "Upgrade: websocket\r\n" ++
            "Connection: upgrade\r\n" ++
            "Sec-Websocket-Accept: flzHu2DevQ2dSCSVqKSii5e9C2o=\r\n\r\n", res);
    }

    fn readWebsocketMessage(self: *TestClient) !?WsConnection.Message {
        while (true) {
            const n = try posix.read(self.stream, self.reader.readBuf());
            if (n == 0) {
                return error.Closed;
            }
            self.reader.len += n;
            if (try self.reader.next()) |msg| {
                return msg;
            }
        }
    }
};

fn writeAll(socket: posix.socket_t, bytes: []const u8) !void {
    var written: usize = 0;
    while (written < bytes.len) {
        written += try posix.write(socket, bytes[written..]);
    }
}
