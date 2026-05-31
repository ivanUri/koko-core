// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

const js = @import("../../js/js.zig");
const Frame = @import("../../browser/Frame.zig");

pub fn registerTypes() []const type {
    return &.{
        SpeechSynthesis,
        SpeechSynthesisVoice,
        SpeechSynthesisUtterance,
    };
}

pub const SpeechSynthesisVoice = struct {
    _name: []const u8,
    _lang: []const u8,
    _local_service: bool,
    _default: bool,

    pub fn getName(self: *const SpeechSynthesisVoice) []const u8 {
        return self._name;
    }

    pub fn getLang(self: *const SpeechSynthesisVoice) []const u8 {
        return self._lang;
    }

    pub fn getLocalService(self: *const SpeechSynthesisVoice) bool {
        return self._local_service;
    }

    pub fn getDefault(self: *const SpeechSynthesisVoice) bool {
        return self._default;
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(SpeechSynthesisVoice);
        pub const Meta = struct {
            pub const name = "SpeechSynthesisVoice";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
        };
        pub const name = bridge.accessor(SpeechSynthesisVoice.getName, null, .{});
        pub const lang = bridge.accessor(SpeechSynthesisVoice.getLang, null, .{});
        pub const localService = bridge.accessor(SpeechSynthesisVoice.getLocalService, null, .{});
        pub const default = bridge.accessor(SpeechSynthesisVoice.getDefault, null, .{});
    };
};

pub const SpeechSynthesisUtterance = struct {
    _text: []const u8 = "",
    _lang: []const u8 = "",
    _voice: ?*SpeechSynthesisVoice = null,

    pub fn constructor(text: ?[]const u8, frame: *Frame) !*SpeechSynthesisUtterance {
        return frame._factory.create(SpeechSynthesisUtterance{
            ._text = text orelse "",
        });
    }

    pub fn getText(self: *const SpeechSynthesisUtterance) []const u8 {
        return self._text;
    }

    pub fn setText(self: *SpeechSynthesisUtterance, text: []const u8) void {
        self._text = text;
    }

    pub fn getLang(self: *const SpeechSynthesisUtterance) []const u8 {
        return self._lang;
    }

    pub fn setLang(self: *SpeechSynthesisUtterance, lang: []const u8) void {
        self._lang = lang;
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(SpeechSynthesisUtterance);
        pub const Meta = struct {
            pub const name = "SpeechSynthesisUtterance";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
        };
        pub const constructor = bridge.constructor(SpeechSynthesisUtterance.constructor, .{});
        pub const text = bridge.accessor(SpeechSynthesisUtterance.getText, SpeechSynthesisUtterance.setText, .{});
        pub const lang = bridge.accessor(SpeechSynthesisUtterance.getLang, SpeechSynthesisUtterance.setLang, .{});
    };
};

pub const SpeechSynthesis = struct {
    _pad: bool = false,
    _pending: bool = false,
    _speaking: bool = false,
    _paused: bool = false,

    pub fn getPending(self: *const SpeechSynthesis) bool {
        return self._pending;
    }

    pub fn getSpeaking(self: *const SpeechSynthesis) bool {
        return self._speaking;
    }

    pub fn getPaused(self: *const SpeechSynthesis) bool {
        return self._paused;
    }

    pub fn getVoices(self: *const SpeechSynthesis, frame: *Frame) ![]*SpeechSynthesisVoice {
        _ = self;
        const v = try frame._factory.create(SpeechSynthesisVoice{
            ._name = "Default",
            ._lang = "en-US",
            ._local_service = true,
            ._default = true,
        });
        const list = try frame.call_arena.alloc(*SpeechSynthesisVoice, 1);
        list[0] = v;
        return list;
    }

    pub fn speak(self: *SpeechSynthesis, _: *SpeechSynthesisUtterance) void {
        self._speaking = false;
        self._pending = false;
    }

    pub fn cancel(self: *SpeechSynthesis) void {
        self._speaking = false;
        self._pending = false;
        self._paused = false;
    }

    pub fn pause(self: *SpeechSynthesis) void {
        self._paused = true;
    }

    pub fn resumeSpeaking(self: *SpeechSynthesis) void {
        self._paused = false;
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(SpeechSynthesis);
        pub const Meta = struct {
            pub const name = "SpeechSynthesis";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
            pub const empty_with_no_proto = true;
        };
        pub const pending = bridge.accessor(SpeechSynthesis.getPending, null, .{});
        pub const speaking = bridge.accessor(SpeechSynthesis.getSpeaking, null, .{});
        pub const paused = bridge.accessor(SpeechSynthesis.getPaused, null, .{});
        pub const voices = bridge.function(SpeechSynthesis.getVoices, .{});
        pub const speak = bridge.function(SpeechSynthesis.speak, .{});
        pub const cancel = bridge.function(SpeechSynthesis.cancel, .{});
        pub const pause = bridge.function(SpeechSynthesis.pause, .{});
        pub const @"resume" = bridge.function(SpeechSynthesis.resumeSpeaking, .{});
    };
};
