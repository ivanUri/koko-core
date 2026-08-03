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

const Page = @import("../browser/Page.zig");
const Frame = @import("../browser/Frame.zig");
const Node = @import("../dom/Node.zig");
const EventManager = @import("../browser/EventManager.zig");

const Event = @import("Event.zig");

const RegisterOptions = EventManager.RegisterOptions;

const EventTarget = @This();

pub const _prototype_root = true;
_type: Type,

pub const Type = union(enum) {
    generic: void,
    node: *@import("../dom/Node.zig"),
    window: *@import("Window.zig"),
    worker: *@import("Worker.zig"),
    worker_global_scope: *@import("WorkerGlobalScope.zig"),
    xhr: *@import("net/XMLHttpRequestEventTarget.zig"),
    abort_signal: *@import("AbortSignal.zig"),
    media_query_list: *@import("css/MediaQueryList.zig"),
    message_port: *@import("MessagePort.zig"),
    text_track_cue: *@import("media/TextTrackCue.zig"),
    navigation: *@import("navigation/Navigation.zig"),
    screen: *@import("Screen.zig"),
    screen_orientation: *@import("Screen.zig").Orientation,
    visual_viewport: *@import("VisualViewport.zig"),
    file_reader: *@import("FileReader.zig"),
    font_face_set: *@import("css/FontFaceSet.zig"),
    websocket: *@import("net/WebSocket.zig"),
    event_source: *@import("net/EventSource.zig"),
    battery_manager: *@import("BatteryManager.zig"),
    audio_context: *@import("audio/audio.zig").AudioContext,
    broadcast_channel: *@import("broadcast_channel.zig").BroadcastChannel,
    dom_notification: *@import("dom_notification.zig").DomNotification,
    offline_audio_context: *@import("audio/audio.zig").OfflineAudioContext,
    rtc_peer_connection: *@import("rtc_bindings.zig").RTCPeerConnectionJs,
    rtc_data_channel: *@import("rtc_bindings.zig").RTCDataChannelJs,
    shared_worker: *@import("shared_worker.zig").SharedWorker,
    media_source: *@import("media/MediaSource.zig"),
    source_buffer: *@import("media/SourceBuffer.zig"),
    idb_request: *@import("idb.zig").IDBRequest,
    idb_open_db_request: *@import("idb.zig").IDBOpenDBRequest,
    idb_transaction: *@import("idb.zig").IDBTransaction,
    cookie_store: *@import("cookie_store.zig").CookieStore,
};

pub fn init(page: *Page) !*EventTarget {
    return page.factory.create(EventTarget{
        ._type = .generic,
    });
}

fn ownerFrameForTarget(target: *EventTarget, entry: *Frame) *Frame {
    return switch (target._type) {
        .node => |n| n.ownerFrame(entry),
        .window => |w| w._frame,
        .idb_request => |request| request._frame,
        .idb_open_db_request => |request| request._frame,
        .idb_transaction => |transaction| transaction._frame,
        else => entry,
    };
}

pub fn dispatchEvent(self: *EventTarget, event: *Event, exec: *js.Execution) !bool {
    if (event.isBeingDispatched()) {
        return error.InvalidStateError;
    }
    event._is_trusted = false;

    switch (exec.context.global) {
        .frame => |entry| {
            const frame = ownerFrameForTarget(self, entry);
            event.acquireRef();
            defer _ = event.releaseRef(frame._page);
            try frame._event_manager.dispatch(self, event);
        },
        .worker => |wgs| try wgs.dispatch(self, event, null, .{}),
    }
    return !event._cancelable or !event._prevent_default;
}

const AddEventListenerOptions = union(enum) {
    capture: bool,
    options: RegisterOptions,
};

pub const EventListenerCallback = union(enum) {
    function: js.Function,
    object: js.Object,
};
pub fn addEventListener(self: *EventTarget, typ: []const u8, callback_: ?EventListenerCallback, opts_: ?AddEventListenerOptions, exec: *js.Execution) !void {
    const callback = callback_ orelse return;

    const em_callback: EventManager.Callback = switch (callback) {
        .object => |obj| .{ .object = obj },
        .function => |func| .{ .function = func },
    };

    const options = blk: {
        const o = opts_ orelse break :blk RegisterOptions{};
        break :blk switch (o) {
            .options => |opts| opts,
            .capture => |capture| RegisterOptions{ .capture = capture },
        };
    };

    switch (exec.context.global) {
        .frame => |entry| {
            const frame = ownerFrameForTarget(self, entry);
            try frame._event_manager.register(self, typ, em_callback, options);
        },
        .worker => |wgs| {
            _ = try wgs._event_manager.registerIgnoringNoops(self, typ, em_callback, options);
        },
    }

    if (std.mem.eql(u8, typ, "message")) {
        switch (self._type) {
            .message_port => |port| {
                port.start() catch {};
                port.flushPendingDeliveries() catch {};
            },
            .worker_global_scope => |wgs| wgs.scheduleDeferredFlushUndelivered() catch {},
            .worker => |w| w.scheduleDeferredFlushUndelivered() catch {},
            else => {},
        }
    }

    if (std.mem.eql(u8, typ, "connect")) {
        switch (self._type) {
            .worker_global_scope => |wgs| wgs.flushPendingConnects() catch {},
            else => {},
        }
    }
}

const RemoveEventListenerOptions = union(enum) {
    capture: bool,
    options: Options,

    const Options = struct {
        capture: bool = false,
    };
};
pub fn removeEventListener(self: *EventTarget, typ: []const u8, callback_: ?EventListenerCallback, opts_: ?RemoveEventListenerOptions, exec: *js.Execution) !void {
    const callback = callback_ orelse return;

    // For object callbacks, check if handleEvent exists
    if (callback == .object) {
        if (try callback.object.getFunction("handleEvent") == null) {
            return;
        }
    }

    const em_callback: EventManager.Callback = switch (callback) {
        .function => |func| .{ .function = func },
        .object => |obj| .{ .object = obj },
    };

    const use_capture = blk: {
        const o = opts_ orelse break :blk false;
        break :blk switch (o) {
            .capture => |capture| capture,
            .options => |opts| opts.capture,
        };
    };

    switch (exec.context.global) {
        .frame => |entry| {
            const frame = ownerFrameForTarget(self, entry);
            frame._event_manager.remove(self, typ, em_callback, use_capture);
        },
        .worker => |wgs| {
            wgs._event_manager.remove(self, typ, em_callback, use_capture);
        },
    }
}

pub fn format(self: *EventTarget, writer: *std.Io.Writer) !void {
    return switch (self._type) {
        .node => |n| n.format(writer),
        .generic => writer.writeAll("<EventTarget>"),
        .window => writer.writeAll("<Window>"),
        .worker => writer.writeAll("<Worker>"),
        .worker_global_scope => writer.writeAll("<WorkerGlobalScope>"),
        .xhr => writer.writeAll("<XMLHttpRequestEventTarget>"),
        .abort_signal => writer.writeAll("<AbortSignal>"),
        .media_query_list => writer.writeAll("<MediaQueryList>"),
        .message_port => writer.writeAll("<MessagePort>"),
        .text_track_cue => writer.writeAll("<TextTrackCue>"),
        .navigation => writer.writeAll("<Navigation>"),
        .screen => writer.writeAll("<Screen>"),
        .screen_orientation => writer.writeAll("<ScreenOrientation>"),
        .visual_viewport => writer.writeAll("<VisualViewport>"),
        .file_reader => writer.writeAll("<FileReader>"),
        .font_face_set => writer.writeAll("<FontFaceSet>"),
        .websocket => writer.writeAll("<WebSocket>"),
        .event_source => writer.writeAll("<EventSource>"),
        .battery_manager => writer.writeAll("<BatteryManager>"),
        .audio_context => writer.writeAll("<AudioContext>"),
        .broadcast_channel => writer.writeAll("<BroadcastChannel>"),
        .dom_notification => writer.writeAll("<Notification>"),
        .offline_audio_context => writer.writeAll("<OfflineAudioContext>"),
        .rtc_peer_connection => writer.writeAll("<RTCPeerConnection>"),
        .rtc_data_channel => writer.writeAll("<RTCDataChannel>"),
        .shared_worker => writer.writeAll("<SharedWorker>"),
        .media_source => writer.writeAll("<MediaSource>"),
        .source_buffer => writer.writeAll("<SourceBuffer>"),
        .idb_request => writer.writeAll("<IDBRequest>"),
        .idb_open_db_request => writer.writeAll("<IDBOpenDBRequest>"),
        .idb_transaction => writer.writeAll("<IDBTransaction>"),
    };
}

pub fn toString(self: *EventTarget) []const u8 {
    return switch (self._type) {
        .node => return "[object Node]",
        .generic => return "[object EventTarget]",
        .window => return "[object Window]",
        .worker => return "[object Worker]",
        .worker_global_scope => return "[object WorkerGlobalScope]",
        .xhr => return "[object XMLHttpRequestEventTarget]",
        .abort_signal => return "[object AbortSignal]",
        .media_query_list => return "[object MediaQueryList]",
        .message_port => return "[object MessagePort]",
        .text_track_cue => return "[object TextTrackCue]",
        .navigation => return "[object Navigation]",
        .screen => return "[object Screen]",
        .screen_orientation => return "[object ScreenOrientation]",
        .visual_viewport => return "[object VisualViewport]",
        .file_reader => return "[object FileReader]",
        .font_face_set => return "[object FontFaceSet]",
        .websocket => return "[object WebSocket]",
        .event_source => return "[object EventSource]",
        .battery_manager => return "[object BatteryManager]",
        .audio_context => return "[object AudioContext]",
        .broadcast_channel => return "[object BroadcastChannel]",
        .dom_notification => return "[object Notification]",
        .offline_audio_context => return "[object OfflineAudioContext]",
        .rtc_peer_connection => return "[object RTCPeerConnection]",
        .rtc_data_channel => return "[object RTCDataChannel]",
        .shared_worker => return "[object SharedWorker]",
        .media_source => return "[object MediaSource]",
        .source_buffer => return "[object SourceBuffer]",
        .idb_request => return "[object IDBRequest]",
        .idb_open_db_request => return "[object IDBOpenDBRequest]",
        .idb_transaction => return "[object IDBTransaction]",
        .cookie_store => return "[object CookieStore]",
    };
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(EventTarget);

    pub const Meta = struct {
        pub const name = "EventTarget";

        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
        pub const enumerable = false;
    };

    pub const constructor = bridge.constructor(EventTarget.init, .{});
    pub const dispatchEvent = bridge.function(EventTarget.dispatchEvent, .{ .dom_exception = true });
    pub const addEventListener = bridge.function(EventTarget.addEventListener, .{});
    pub const removeEventListener = bridge.function(EventTarget.removeEventListener, .{});
};

const testing = @import("../../testing/testing.zig");
test "WebApi: EventTarget" {
    // we create thousands of these per frame. Nothing should bloat it.
    try testing.expectEqual(16, @sizeOf(EventTarget));
    try testing.htmlRunner("events.html", .{});
}
