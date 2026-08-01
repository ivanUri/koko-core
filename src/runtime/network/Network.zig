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
const assert = @import("../../support/assert.zig").assert;
const builtin = @import("builtin");

const log = @import("../../support/log.zig");
const net = std.net;
const posix = std.posix;
const Allocator = std.mem.Allocator;

const Config = @import("../Config.zig");
const libcurl = @import("../../support/sys/libcurl.zig");

const http = @import("http.zig");
const IpFilter = @import("IpFilter.zig");
const RobotStore = @import("Robots.zig").RobotStore;
const WebBotAuth = @import("WebBotAuth.zig");
const InternetJourneySink = @import("InternetJourneySink.zig");

fn transportTag(transport: http.Connection.Transport) @typeInfo(http.Connection.Transport).@"union".tag_type.? {
    return std.meta.activeTag(transport);
}

const Cache = @import("cache/Cache.zig");
const FsCache = @import("cache/FsCache.zig");

const App = @import("../App.zig");
const Network = @This();

const Listener = struct {
    socket: posix.socket_t,
    ctx: *anyopaque,
    onAccept: *const fn (ctx: *anyopaque, socket: posix.socket_t) void,
};

// Number of fixed pollfds entries (wakeup pipe + listener).
const PSEUDO_POLLFDS = 2;

const MAX_TICK_CALLBACKS = 16;

allocator: Allocator,

app: *App,
config: *const Config,
ca_blob: ?http.Blob,
robot_store: RobotStore,
web_bot_auth: ?WebBotAuth,
cache: ?Cache,
cache_disabled: bool = false,

connections: []http.Connection,
available: std.DoublyLinkedList = .{},
conn_mutex: std.Thread.Mutex = .{},

ws_pool: std.heap.MemoryPool(http.Connection),
ws_count: usize = 0,
ws_max: u8,
ws_mutex: std.Thread.Mutex = .{},

pollfds: []posix.pollfd,
listener: ?Listener = null,
accept: std.atomic.Value(bool) = .init(true),

// Wakeup pipe: workers write to [1], main thread polls [0]
wakeup_pipe: [2]posix.fd_t = .{ -1, -1 },

shutdown: std.atomic.Value(bool) = .init(false),

// Multi is a heavy structure that can consume up to 2MB of RAM.
// Currently, Network is used sparingly, and we only create it on demand.
// When Network becomes truly shared, it should become a regular field.
multi: ?*libcurl.CurlM = null,
submission_mutex: std.Thread.Mutex = .{},
submission_queue: std.DoublyLinkedList = .{},

callbacks: [MAX_TICK_CALLBACKS]TickCallback = undefined,
callbacks_len: usize = 0,
callbacks_mutex: std.Thread.Mutex = .{},
queued_count: usize = 0,
active_handles: usize = 0,

/// Optional IP filter for blocking requests to private/internal networks (--block-private-networks).
ip_filter: ?*IpFilter = null,
internet_journey_sink: ?InternetJourneySink = null,

const TickCallback = struct {
    ctx: *anyopaque,
    fun: *const fn (*anyopaque) void,
};

const ZigToCurlAllocator = struct {
    // C11 requires malloc to return memory aligned to max_align_t (16 bytes on x86_64).
    // We match this guarantee since libcurl expects malloc-compatible alignment.
    const alignment = 16;

    const Block = extern struct {
        size: usize = 0,
        _padding: [alignment - @sizeOf(usize)]u8 = .{0} ** (alignment - @sizeOf(usize)),

        inline fn fullsize(bytes: usize) usize {
            return alignment + bytes;
        }

        inline fn fromPtr(ptr: *anyopaque) *Block {
            const raw: [*]u8 = @ptrCast(ptr);
            return @ptrCast(@alignCast(raw - @sizeOf(Block)));
        }

        inline fn data(self: *Block) [*]u8 {
            const ptr: [*]u8 = @ptrCast(self);
            return ptr + @sizeOf(Block);
        }

        inline fn slice(self: *Block) []align(alignment) u8 {
            const base: [*]align(alignment) u8 = @ptrCast(@alignCast(self));
            return base[0 .. alignment + self.size];
        }
    };

    comptime {
        std.debug.assert(@sizeOf(Block) == alignment);
    }

    var instance: ?ZigToCurlAllocator = null;

    allocator: Allocator,

    pub fn init(allocator: Allocator) void {
        assert(instance == null, "Initialization of curl must happen only once", .{});
        instance = .{ .allocator = allocator };
    }

    pub fn interface() libcurl.CurlAllocator {
        return .{
            .free = free,
            .strdup = strdup,
            .malloc = malloc,
            .calloc = calloc,
            .realloc = realloc,
        };
    }

    fn _allocBlock(size: usize) ?*Block {
        const slice = instance.?.allocator.alignedAlloc(u8, .fromByteUnits(alignment), Block.fullsize(size)) catch return null;
        const block: *Block = @ptrCast(@alignCast(slice.ptr));
        block.size = size;
        return block;
    }

    fn _freeBlock(header: *Block) void {
        instance.?.allocator.free(header.slice());
    }

    fn malloc(size: usize) ?*anyopaque {
        const block = _allocBlock(size) orelse return null;
        return @ptrCast(block.data());
    }

    fn calloc(nmemb: usize, size: usize) ?*anyopaque {
        const total = nmemb * size;
        const block = _allocBlock(total) orelse return null;
        const ptr = block.data();
        @memset(ptr[0..total], 0); // for historical reasons, calloc zeroes memory, but malloc does not.
        return @ptrCast(ptr);
    }

    fn realloc(ptr: ?*anyopaque, size: usize) ?*anyopaque {
        const p = ptr orelse return malloc(size);
        const block = Block.fromPtr(p);

        const old_size = block.size;
        if (size == old_size) return ptr;

        if (instance.?.allocator.resize(block.slice(), alignment + size)) {
            block.size = size;
            return ptr;
        }

        const copy_size = @min(old_size, size);
        const new_block = _allocBlock(size) orelse return null;
        @memcpy(new_block.data()[0..copy_size], block.data()[0..copy_size]);
        _freeBlock(block);
        return @ptrCast(new_block.data());
    }

    fn free(ptr: ?*anyopaque) void {
        const p = ptr orelse return;
        _freeBlock(Block.fromPtr(p));
    }

    fn strdup(str: [*:0]const u8) ?[*:0]u8 {
        const len = std.mem.len(str);
        const header = _allocBlock(len + 1) orelse return null;
        const ptr = header.data();
        @memcpy(ptr[0..len], str[0..len]);
        ptr[len] = 0;
        return ptr[0..len :0];
    }
};

fn globalInit(allocator: Allocator) void {
    ZigToCurlAllocator.init(allocator);

    libcurl.curl_global_init(.{ .ssl = true }, ZigToCurlAllocator.interface()) catch |err| {
        assert(false, "curl global init", .{ .err = err });
    };
}

fn globalDeinit() void {
    libcurl.curl_global_cleanup();
}

pub fn init(allocator: Allocator, app: *App, config: *const Config) !Network {
    globalInit(allocator);
    errdefer globalDeinit();

    const pipe = try posix.pipe2(.{ .NONBLOCK = true, .CLOEXEC = true });

    // 0 is wakeup, 1 is listener, rest for curl fds
    const pollfds = try allocator.alloc(posix.pollfd, PSEUDO_POLLFDS + config.httpMaxConcurrent());
    errdefer allocator.free(pollfds);

    @memset(pollfds, .{ .fd = -1, .events = 0, .revents = 0 });
    pollfds[0] = .{ .fd = pipe[0], .events = posix.POLL.IN, .revents = 0 };

    var ca_blob: ?http.Blob = null;
    if (config.tlsVerifyHost()) {
        ca_blob = try loadCerts(allocator);
    }

    // IP filter for blocking requests to private/internal networks.
    const block_private = config.blockPrivateNetworks();
    const cidrs: ?IpFilter.Cidrs = blk: {
        const s = config.blockCidrs() orelse break :blk null;
        break :blk try IpFilter.parseCidrList(allocator, s);
    };
    const has_cidrs = if (cidrs) |c| c.v4.len > 0 or c.v6.len > 0 or c.allow_v4.len > 0 or c.allow_v6.len > 0 else false;
    const ip_filter: ?*IpFilter = blk: {
        if (!block_private and !has_cidrs) break :blk null;
        const f = try allocator.create(IpFilter);
        f.* = IpFilter.init(block_private, cidrs);
        break :blk f;
    };
    errdefer if (ip_filter) |f| {
        f.deinit(allocator);
        allocator.destroy(f);
    };

    const count: usize = config.httpMaxConcurrent();
    const connections = try allocator.alloc(http.Connection, count);
    errdefer allocator.free(connections);

    var available: std.DoublyLinkedList = .{};
    for (0..count) |i| {
        connections[i] = try http.Connection.init(ca_blob, config, ip_filter);
        available.append(&connections[i].node);
    }

    const web_bot_auth = if (config.webBotAuth()) |wba_cfg|
        try WebBotAuth.fromConfig(allocator, &wba_cfg)
    else
        null;

    const cache = if (config.httpCacheDir()) |cache_dir_path|
        Cache{
            .kind = .{
                .fs = FsCache.init(cache_dir_path) catch |e| {
                    log.err(.cache, "failed to init", .{
                        .kind = "FsCache",
                        .path = cache_dir_path,
                        .err = e,
                    });
                    return e;
                },
            },
        }
    else
        null;
    const internet_journey_sink = try InternetJourneySink.initFromEnvironment(allocator);

    return .{
        .allocator = allocator,
        .config = config,
        .ca_blob = ca_blob,

        .pollfds = pollfds,
        .wakeup_pipe = pipe,

        .available = available,
        .connections = connections,

        .app = app,

        .robot_store = RobotStore.init(allocator),
        .web_bot_auth = web_bot_auth,
        .cache = cache,

        .ws_pool = .init(allocator),
        .ws_max = config.wsMaxConcurrent(),

        .ip_filter = ip_filter,
        .internet_journey_sink = internet_journey_sink,
    };
}

pub fn deinit(self: *Network) void {
    if (self.multi) |multi| {
        libcurl.curl_multi_cleanup(multi) catch {};
    }

    for (&self.wakeup_pipe) |*fd| {
        if (fd.* >= 0) {
            posix.close(fd.*);
            fd.* = -1;
        }
    }

    self.allocator.free(self.pollfds);

    if (self.ca_blob) |ca_blob| {
        const data: [*]u8 = @ptrCast(ca_blob.data);
        self.allocator.free(data[0..ca_blob.len]);
    }

    for (self.connections) |*conn| {
        conn.deinit();
    }
    self.allocator.free(self.connections);

    self.ws_pool.deinit();

    self.robot_store.deinit();
    if (self.web_bot_auth) |wba| {
        wba.deinit(self.allocator);
    }

    if (self.cache) |*cache| cache.deinit();

    if (self.ip_filter) |f| {
        f.deinit(self.allocator);
        self.allocator.destroy(f);
    }
    if (self.internet_journey_sink) |*sink| sink.deinit();

    globalDeinit();
}

pub fn bind(
    self: *Network,
    address: *net.Address,
    ctx: *anyopaque,
    on_accept: *const fn (ctx: *anyopaque, socket: posix.socket_t) void,
) !void {
    if (self.listener != null) return error.TooManyListeners;

    self.accept.store(true, .release);

    const flags = posix.SOCK.STREAM | posix.SOCK.CLOEXEC | posix.SOCK.NONBLOCK;
    const listener = try posix.socket(address.any.family, flags, posix.IPPROTO.TCP);
    errdefer posix.close(listener);

    try posix.setsockopt(listener, posix.SOL.SOCKET, posix.SO.REUSEADDR, &std.mem.toBytes(@as(c_int, 1)));
    if (@hasDecl(posix.TCP, "NODELAY")) {
        try posix.setsockopt(listener, posix.IPPROTO.TCP, posix.TCP.NODELAY, &std.mem.toBytes(@as(c_int, 1)));
    }

    try posix.bind(listener, &address.any, address.getOsSockLen());
    try posix.listen(listener, self.config.maxPendingConnections());

    // When the caller requests port 0, the OS assigns an ephemeral port; read
    // the actual bound address back so callers (e.g. logging) see the real port.
    var bound: posix.sockaddr.storage = undefined;
    var bound_len: posix.socklen_t = @sizeOf(posix.sockaddr.storage);
    try posix.getsockname(listener, @ptrCast(&bound), &bound_len);
    address.* = net.Address.initPosix(@ptrCast(@alignCast(&bound)));

    self.listener = .{
        .socket = listener,
        .ctx = ctx,
        .onAccept = on_accept,
    };
    self.pollfds[1] = .{
        .fd = listener,
        .events = posix.POLL.IN,
        .revents = 0,
    };
}

pub fn unbind(self: *Network) void {
    self.accept.store(false, .release);
    self.wakeupPoll();
}

pub fn onTick(self: *Network, ctx: *anyopaque, callback: *const fn (*anyopaque) void) void {
    self.callbacks_mutex.lock();
    defer self.callbacks_mutex.unlock();

    assert(self.callbacks_len < MAX_TICK_CALLBACKS, "too many ticks", .{});

    self.callbacks[self.callbacks_len] = .{
        .ctx = ctx,
        .fun = callback,
    };
    self.callbacks_len += 1;

    self.wakeupPoll();
}

pub fn fireTicks(self: *Network) void {
    self.callbacks_mutex.lock();
    defer self.callbacks_mutex.unlock();

    for (self.callbacks[0..self.callbacks_len]) |*callback| {
        callback.fun(callback.ctx);
    }
}

pub fn run(self: *Network) void {
    var drain_buf: [64]u8 = undefined;
    var running_handles: c_int = 0;

    const poll_fd = &self.pollfds[0];
    const listen_fd = &self.pollfds[1];

    // Please note that receiving a shutdown command does not terminate all connections.
    // When gracefully shutting down a server, we at least want to send the remaining
    // telemetry, but we stop accepting new connections. It is the responsibility
    // of external code to terminate its requests upon shutdown.
    while (true) {
        if (self.listener != null and !self.accept.load(.acquire)) {
            posix.close(self.listener.?.socket);
            self.listener = null;
            self.pollfds[1] = .{ .fd = -1, .events = 0, .revents = 0 };
        }

        self.drainQueue();

        if (self.multi) |multi| {
            // Kickstart newly added handles (DNS/connect) so that
            // curl registers its sockets before we poll.
            libcurl.curl_multi_perform(multi, &running_handles) catch |err| {
                @import("../../support/log.zig").err(.app, "curl perform", .{ .err = err });
            };

            self.preparePollFds(multi);
        }

        // for ontick to work, you need to wake up periodically
        const timeout = blk: {
            const min_timeout = 250; // 250ms
            if (self.multi == null) {
                break :blk min_timeout;
            }

            const curl_timeout = self.getCurlTimeout();
            if (curl_timeout == 0) {
                break :blk min_timeout;
            }

            break :blk @min(min_timeout, curl_timeout);
        };

        _ = posix.poll(self.pollfds, timeout) catch |err| {
            @import("../../support/log.zig").err(.app, "poll", .{ .err = err });
            continue;
        };

        // check wakeup pipe
        if (poll_fd.revents != 0) {
            poll_fd.revents = 0;
            while (true)
                _ = posix.read(self.wakeup_pipe[0], &drain_buf) catch break;
        }

        // accept new connections
        if (listen_fd.revents != 0) {
            listen_fd.revents = 0;
            self.acceptConnections();
        }

        if (self.multi) |multi| {
            // Drive transfers and process completions.
            libcurl.curl_multi_perform(multi, &running_handles) catch |err| {
                @import("../../support/log.zig").err(.app, "curl perform", .{ .err = err });
            };
            self.processCompletions(multi, running_handles);
        }

        self.fireTicks();

        if (self.shutdown.load(.acquire) and running_handles == 0) {
            // Check if fireTicks submitted new requests (e.g. telemetry flush).
            // If so, continue the loop to drain and send them before exiting.
            self.submission_mutex.lock();
            const has_pending = self.submission_queue.first != null;
            self.submission_mutex.unlock();
            if (!has_pending) break;
        }
    }

    if (self.listener) |listener| {
        posix.shutdown(listener.socket, .both) catch |err| blk: {
            if (err == error.SocketNotConnected and builtin.os.tag != .linux) {
                // This error is normal/expected on BSD/MacOS. We probably
                // shouldn't bother calling shutdown at all, but I guess this
                // is safer.
                break :blk;
            }
            @import("../../support/log.zig").warn(.app, "listener shutdown", .{ .err = err });
        };
        posix.close(listener.socket);
    }
}

pub fn submitRequest(self: *Network, conn: *http.Connection) void {
    var effective_url: [*c]u8 = null;
    libcurl.curl_easy_getinfo(conn._easy, .effective_url, &effective_url) catch {};

    log.debug(.http, "submit request", .{
        .conn_ptr = @intFromPtr(conn),
        .transport = transportTag(conn.transport),
        .origin = conn.origin,
        .url = if (effective_url != null) std.mem.span(effective_url) else "unknown",
    });

    self.submission_mutex.lock();
    self.submission_queue.append(&conn.node);
    self.queued_count += 1;
    const queue_len = self.queued_count;
    self.submission_mutex.unlock();

    log.debug(.http, "curl state", .{
        .running_handles = -1,
        .available = self.availableCount(),
        .queued = queue_len,
    });

    self.wakeupPoll();
}

/// Capture a completed browser HTTP transfer before HttpClient releases and
/// resets its pooled easy handle.
pub fn emitInternetJourney(
    self: *Network,
    conn: *const http.Connection,
    metadata: InternetJourneySink.ResponseMetadata,
    failed: bool,
) void {
    const sink = if (self.internet_journey_sink) |*value| value else return;
    log.debug(.http, "internet journey snapshot", .{ .origin = conn.origin, .failed = failed });
    if (conn.origin == .telemetry) return;
    const timing = conn.transferTiming() catch |err| {
        log.warn(.http, "internet journey timing snapshot", .{ .err = err });
        return;
    };
    sink.emit(conn, timing, metadata, failed) catch |err| {
        log.warn(.http, "internet journey telemetry write", .{ .err = err });
    };
}

pub fn emitBrowserStage(self: *Network, stage: []const u8, duration_us: u64, frame_id: u32, loader_id: u32, measurement_state: []const u8, process: []const u8, thread: []const u8) void {
    const sink = if (self.internet_journey_sink) |*value| value else return;
    sink.emitBrowserStage(stage, duration_us, frame_id, loader_id, measurement_state, process, thread) catch |err| {
        log.warn(.http, "browser journey telemetry", .{ .stage = stage, .err = err });
    };
}
pub fn emitBrowserScript(self: *Network, duration_us: u64, frame_id: u32, loader_id: u32, url: []const u8, script_kind: []const u8) void {
    const sink = if (self.internet_journey_sink) |*value| value else return;
    sink.emitBrowserScript(duration_us, frame_id, loader_id, url, script_kind) catch |err| log.warn(.http, "browser script telemetry", .{ .err = err });
}

fn wakeupPoll(self: *Network) void {
    _ = posix.write(self.wakeup_pipe[1], &.{1}) catch {};
}

fn drainQueue(self: *Network) void {
    self.submission_mutex.lock();
    defer self.submission_mutex.unlock();

    if (self.submission_queue.first == null) return;

    log.debug(.http, "curl state", .{
        .running_handles = -1,
        .available = self.availableCount(),
        .queued = self.queued_count,
    });

    const multi = self.multi orelse blk: {
        const m = libcurl.curl_multi_init() orelse {
            assert(false, "curl multi init failed", .{});
            unreachable;
        };
        self.multi = m;
        break :blk m;
    };

    while (self.submission_queue.popFirst()) |node| {
        const conn: *http.Connection = @fieldParentPtr("node", node);
        self.queued_count -= 1;
        conn.setPrivate(conn) catch |err| {
            @import("../../support/log.zig").err(.app, "curl set private", .{ .err = err });
            self.releaseConnection(conn);
            continue;
        };
        libcurl.curl_multi_add_handle(multi, conn._easy) catch |err| {
            @import("../../support/log.zig").err(.app, "curl multi add", .{ .err = err });
            self.releaseConnection(conn);
            continue;
        };
        self.active_handles += 1;
    }
}

pub fn stop(self: *Network) void {
    self.shutdown.store(true, .release);
    self.wakeupPoll();
}

fn acceptConnections(self: *Network) void {
    if (self.shutdown.load(.acquire)) {
        return;
    }
    const listener = self.listener orelse return;

    while (true) {
        const socket = posix.accept(listener.socket, null, null, posix.SOCK.NONBLOCK) catch |err| {
            switch (err) {
                error.WouldBlock => break,
                error.SocketNotListening => {
                    self.pollfds[1] = .{ .fd = -1, .events = 0, .revents = 0 };
                    self.listener = null;
                    return;
                },
                error.ConnectionAborted => {
                    @import("../../support/log.zig").warn(.app, "accept connection aborted", .{});
                    continue;
                },
                else => {
                    @import("../../support/log.zig").err(.app, "accept error", .{ .err = err });
                    continue;
                },
            }
        };

        // Liveness is enforced at the TCP layer via keepalive probes sent by the
        // kernel. This is transparent to CDP clients — unlike a WebSocket ping, which
        // go-rod panics on and chromedp logs as "malformed". Tunables in Config.zig.
        posix.setsockopt(socket, posix.SOL.SOCKET, posix.SO.KEEPALIVE, &std.mem.toBytes(@as(c_int, 1))) catch |err| {
            log.warn(.app, "SO_KEEPALIVE", .{ .err = err });
            return;
        };

        const option = switch (@import("builtin").os.tag) {
            .macos, .ios => posix.TCP.KEEPALIVE,
            else => posix.TCP.KEEPIDLE,
        };
        posix.setsockopt(socket, posix.IPPROTO.TCP, option, &std.mem.toBytes(Config.CDP_KEEPALIVE_IDLE_S)) catch |err| {
            log.warn(.app, "TCP_KEEPIDLE", .{ .err = err });
        };
        posix.setsockopt(socket, posix.IPPROTO.TCP, posix.TCP.KEEPINTVL, &std.mem.toBytes(Config.CDP_KEEPALIVE_INTVL_S)) catch |err| {
            log.warn(.app, "TCP_KEEPINTVL", .{ .err = err });
        };
        posix.setsockopt(socket, posix.IPPROTO.TCP, posix.TCP.KEEPCNT, &std.mem.toBytes(Config.CDP_KEEPALIVE_CNT)) catch |err| {
            log.warn(.app, "TCP_KEEPCNT", .{ .err = err });
        };

        // Keepalive alone can stall while there are unacked writes; USER_TIMEOUT
        // forces the socket into an error state so a blocked send()/poll wakes.
        if (builtin.os.tag == .linux) {
            posix.setsockopt(socket, posix.IPPROTO.TCP, std.os.linux.TCP.USER_TIMEOUT, &std.mem.toBytes(Config.CDP_TCP_USER_TIMEOUT_MS)) catch |err| {
                log.warn(.app, "TCP_USER_TIMEOUT", .{ .err = err });
            };
        }

        listener.onAccept(listener.ctx, socket);
    }
}

fn preparePollFds(self: *Network, multi: *libcurl.CurlM) void {
    const curl_fds = self.pollfds[PSEUDO_POLLFDS..];
    @memset(curl_fds, .{ .fd = -1, .events = 0, .revents = 0 });

    var fd_count: c_uint = 0;
    const wait_fds: []libcurl.CurlWaitFd = @ptrCast(curl_fds);
    libcurl.curl_multi_waitfds(multi, wait_fds, &fd_count) catch |err| {
        @import("../../support/log.zig").err(.app, "curl waitfds", .{ .err = err });
    };
}

fn getCurlTimeout(self: *Network) i32 {
    const multi = self.multi orelse return -1;
    var timeout_ms: c_long = -1;
    libcurl.curl_multi_timeout(multi, &timeout_ms) catch return -1;
    return @intCast(@min(timeout_ms, std.math.maxInt(i32)));
}

fn processCompletions(self: *Network, multi: *libcurl.CurlM, running_handles: c_int) void {
    var msgs_in_queue: c_int = 0;
    while (libcurl.curl_multi_info_read(multi, &msgs_in_queue)) |msg| {
        const easy: *libcurl.Curl = msg.easy_handle;
        var ptr: *anyopaque = undefined;
        libcurl.curl_easy_getinfo(easy, .private, &ptr) catch
            assert(false, "curl getinfo private", .{});
        const conn: *http.Connection = @ptrCast(@alignCast(ptr));

        switch (msg.data) {
            .done => |maybe_err| {
                if (maybe_err) |err| {
                    const url = conn.getEffectiveUrl() catch null;

                    @import("../../support/log.zig").warn(.app, "curl transfer error", .{
                        .err = err,
                        .url = if (url) |u| std.mem.span(u) else "unknown",
                        .transport = transportTag(conn.transport),
                        .origin = conn.origin,
                        .conn_ptr = @intFromPtr(conn),
                        .easy_ptr = @intFromPtr(easy),
                    });
                }
            },
            else => continue,
        }

        libcurl.curl_multi_remove_handle(multi, easy) catch {};
        self.active_handles -= 1;
        self.releaseConnection(conn);

        log.debug(.http, "curl state", .{
            .running_handles = running_handles,
            .active_handles = self.active_handles,
            .available = self.availableCount(),
            .queued = self.queued_count,
        });
    }
}

comptime {
    if (@sizeOf(posix.pollfd) != @sizeOf(libcurl.CurlWaitFd)) {
        @compileError("pollfd and CurlWaitFd size mismatch");
    }
    if (@offsetOf(posix.pollfd, "fd") != @offsetOf(libcurl.CurlWaitFd, "fd") or
        @offsetOf(posix.pollfd, "events") != @offsetOf(libcurl.CurlWaitFd, "events") or
        @offsetOf(posix.pollfd, "revents") != @offsetOf(libcurl.CurlWaitFd, "revents"))
    {
        @compileError("pollfd and CurlWaitFd layout mismatch");
    }
}

pub fn getConnection(self: *Network) ?*http.Connection {
    self.conn_mutex.lock();
    defer self.conn_mutex.unlock();

    const node = self.available.popFirst() orelse return null;
    return @fieldParentPtr("node", node);
}

fn availableCount(self: *Network) usize {
    self.conn_mutex.lock();
    defer self.conn_mutex.unlock();

    var count: usize = 0;
    var node = self.available.first;
    while (node) |n| {
        count += 1;
        node = n.next;
    }
    return count;
}

pub fn releaseConnection(self: *Network, conn: *http.Connection) void {
    const transport = transportTag(conn.transport);
    const origin = conn.origin;
    if (transport != .none or origin != .unknown) {
        log.debug(.http, "release connection", .{
            .conn_ptr = @intFromPtr(conn),
            .transport = transport,
            .origin = origin,
        });
    }

    switch (conn.transport) {
        .websocket => {
            conn.deinit();
            self.ws_mutex.lock();
            defer self.ws_mutex.unlock();
            self.ws_pool.destroy(conn);
            self.ws_count -= 1;
        },
        else => {
            conn.reset(self.config, self.ca_blob, self.ip_filter) catch |err| {
                assert(false, "couldn't reset curl easy", .{ .err = err });
            };
            self.conn_mutex.lock();
            defer self.conn_mutex.unlock();
            self.available.append(&conn.node);
        },
    }
}

pub fn newConnection(self: *Network) ?*http.Connection {
    const conn = blk: {
        self.ws_mutex.lock();
        defer self.ws_mutex.unlock();

        if (self.ws_count >= self.ws_max) {
            return null;
        }

        const c = self.ws_pool.create() catch return null;
        self.ws_count += 1;
        break :blk c;
    };

    // don't do this under lock
    conn.* = http.Connection.init(self.ca_blob, self.config, self.ip_filter) catch {
        self.ws_mutex.lock();
        defer self.ws_mutex.unlock();
        self.ws_pool.destroy(conn);
        self.ws_count -= 1;

        return null;
    };

    return conn;
}

// Wraps lines @ 64 columns. A PEM is basically a base64 encoded DER (which is
// what Zig has), with lines wrapped at 64 characters and with a basic header
// and footer
const LineWriter = struct {
    col: usize = 0,
    inner: std.ArrayList(u8).Writer,

    pub fn writeAll(self: *LineWriter, data: []const u8) !void {
        var writer = self.inner;

        var col = self.col;
        const len = 64 - col;

        var remain = data;
        if (remain.len > len) {
            col = 0;
            try writer.writeAll(data[0..len]);
            try writer.writeByte('\n');
            remain = data[len..];
        }

        while (remain.len > 64) {
            try writer.writeAll(remain[0..64]);
            try writer.writeByte('\n');
            remain = remain[64..];
        }
        try writer.writeAll(remain);
        self.col = col + remain.len;
    }
};

// TODO: on BSD / Linux, we could just read the PEM file directly.
// This whole rescan + decode is really just needed for MacOS. On Linux
// bundle.rescan does find the .pem file(s) which could be in a few different
// places, so it's still useful, just not efficient.
fn loadCerts(allocator: Allocator) !libcurl.CurlBlob {
    var bundle: std.crypto.Certificate.Bundle = .{};
    try bundle.rescan(allocator);
    defer bundle.deinit(allocator);

    const bytes = bundle.bytes.items;
    if (bytes.len == 0) {
        @import("../../support/log.zig").warn(.app, "No system certificates", .{});
        return .{
            .len = 0,
            .flags = 0,
            .data = bytes.ptr,
        };
    }

    const encoder = std.base64.standard.Encoder;
    var arr: std.ArrayList(u8) = .empty;

    const encoded_size = encoder.calcSize(bytes.len);
    const buffer_size = encoded_size +
        (bundle.map.count() * 75) + // start / end per certificate + extra, just in case
        (encoded_size / 64) // newline per 64 characters
    ;
    try arr.ensureTotalCapacity(allocator, buffer_size);
    errdefer arr.deinit(allocator);
    var writer = arr.writer(allocator);

    var it = bundle.map.valueIterator();
    while (it.next()) |index| {
        const cert = try std.crypto.Certificate.der.Element.parse(bytes, index.*);

        try writer.writeAll("-----BEGIN CERTIFICATE-----\n");
        var line_writer = LineWriter{ .inner = writer };
        try encoder.encodeWriter(&line_writer, bytes[index.*..cert.slice.end]);
        try writer.writeAll("\n-----END CERTIFICATE-----\n");
    }

    // Final encoding should not be larger than our initial size estimate
    assert(buffer_size > arr.items.len, "Http loadCerts", .{ .estimate = buffer_size, .len = arr.items.len });

    // Allocate exactly the size needed and copy the data
    const result = try allocator.dupe(u8, arr.items);
    // Free the original oversized allocation
    arr.deinit(allocator);

    return .{
        .len = result.len,
        .data = result.ptr,
        .flags = 0,
    };
}
