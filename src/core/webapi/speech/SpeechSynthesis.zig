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

const VoiceSpec = struct {
    name: []const u8,
    lang: []const u8,
    default_voice: bool = false,
};

/// macOS Chrome voice subset (async-loaded like real Chrome).
const macos_chrome_voices = [_]VoiceSpec{
    .{ .name = "Samantha", .lang = "en-US", .default_voice = true },
    .{ .name = "Aaron", .lang = "en-US" },
    .{ .name = "Albert", .lang = "en-US" },
    .{ .name = "Alice", .lang = "it-IT" },
    .{ .name = "Alva", .lang = "sv-SE" },
    .{ .name = "Amélie", .lang = "fr-CA" },
    .{ .name = "Amira", .lang = "ms-MY" },
    .{ .name = "Anna", .lang = "de-DE" },
    .{ .name = "Arthur", .lang = "en-GB" },
    .{ .name = "Carmit", .lang = "he-IL" },
    .{ .name = "Catherine", .lang = "en-AU" },
    .{ .name = "Damayanti", .lang = "id-ID" },
    .{ .name = "Daniel", .lang = "en-GB" },
    .{ .name = "Diego", .lang = "es-AR" },
    .{ .name = "Ellen", .lang = "nl-BE" },
    .{ .name = "Flo", .lang = "en-US" },
    .{ .name = "Fred", .lang = "en-US" },
    .{ .name = "Ioana", .lang = "ro-RO" },
    .{ .name = "Jacques", .lang = "fr-FR" },
    .{ .name = "Joana", .lang = "pt-PT" },
    .{ .name = "Jorge", .lang = "es-ES" },
    .{ .name = "Juan", .lang = "es-MX" },
    .{ .name = "Kanya", .lang = "th-TH" },
    .{ .name = "Karen", .lang = "en-AU" },
    .{ .name = "Kyoko", .lang = "ja-JP" },
    .{ .name = "Laura", .lang = "sk-SK" },
    .{ .name = "Lekha", .lang = "hi-IN" },
    .{ .name = "Luciana", .lang = "pt-BR" },
    .{ .name = "Maged", .lang = "ar-SA" },
    .{ .name = "Mariska", .lang = "hu-HU" },
    .{ .name = "Melina", .lang = "el-GR" },
    .{ .name = "Milena", .lang = "ru-RU" },
    .{ .name = "Moira", .lang = "en-IE" },
    .{ .name = "Monica", .lang = "es-ES" },
    .{ .name = "Nora", .lang = "nb-NO" },
    .{ .name = "Paulina", .lang = "es-MX" },
    .{ .name = "Rishi", .lang = "en-IN" },
    .{ .name = "Sara", .lang = "da-DK" },
    .{ .name = "Satu", .lang = "fi-FI" },
    .{ .name = "Sinji", .lang = "zh-HK" },
    .{ .name = "Tessa", .lang = "en-ZA" },
    .{ .name = "Thomas", .lang = "fr-FR" },
    .{ .name = "Tingting", .lang = "zh-CN" },
    .{ .name = "Veena", .lang = "en-IN" },
    .{ .name = "Victoria", .lang = "en-US" },
    .{ .name = "Xander", .lang = "nl-NL" },
    .{ .name = "Yelda", .lang = "tr-TR" },
    .{ .name = "Yuna", .lang = "ko-KR" },
    .{ .name = "Zosia", .lang = "pl-PL" },
    .{ .name = "Zuzana", .lang = "cs-CZ" },
};

pub const SpeechSynthesis = struct {
    _pad: bool = false,
    _pending: bool = false,
    _speaking: bool = false,
    _paused: bool = false,
    _on_voices_changed: ?js.Function.Temp = null,

    pub fn getPending(self: *const SpeechSynthesis) bool {
        return self._pending;
    }

    pub fn getSpeaking(self: *const SpeechSynthesis) bool {
        return self._speaking;
    }

    pub fn getPaused(self: *const SpeechSynthesis) bool {
        return self._paused;
    }

    pub fn getOnVoicesChanged(self: *const SpeechSynthesis) ?js.Function.Temp {
        return self._on_voices_changed;
    }

    pub fn setOnVoicesChanged(self: *SpeechSynthesis, cb: ?js.Function.Temp) void {
        self._on_voices_changed = cb;
    }

    pub fn getVoices(self: *const SpeechSynthesis, frame: *Frame) ![]*SpeechSynthesisVoice {
        if (!frame._speech_voices_ready) {
            try scheduleVoiceLoad(self, frame);
            return &.{};
        }

        var count: usize = 0;
        for (frame._speech_voices) |v| {
            if (v != null) count += 1;
        }
        const list = try frame.call_arena.alloc(*SpeechSynthesisVoice, count);
        var i: usize = 0;
        for (frame._speech_voices) |v| {
            if (v) |voice| {
                list[i] = voice;
                i += 1;
            }
        }
        return list;
    }

    fn scheduleVoiceLoad(self: *const SpeechSynthesis, frame: *Frame) !void {
        if (frame._speech_voices_load_scheduled) return;
        frame._speech_voices_load_scheduled = true;

        const TaskData = struct {
            synth: *const SpeechSynthesis,
            frame: *Frame,
        };
        const data = try frame.arena.create(TaskData);
        data.* = .{ .synth = self, .frame = frame };

        try frame.js.scheduler.add(data, struct {
            fn run(ctx: *anyopaque) !?u32 {
                const d: *TaskData = @ptrCast(@alignCast(ctx));
                loadVoices(d.frame) catch return null;
                fireVoicesChanged(d.synth, d.frame) catch {};
                return null;
            }
        }.run, 0, .{ .name = "SpeechSynthesis.loadVoices" });
    }

    fn loadVoices(frame: *Frame) !void {
        if (frame._speech_voices_ready) return;

        const profile_voices = frame.loadedProfile().speech_voices;
        const slots = if (profile_voices.len > 0) blk: {
            const s = try frame._page.frame_arena.alloc(?*SpeechSynthesisVoice, profile_voices.len);
            for (profile_voices, 0..) |spec, i| {
                s[i] = try frame._factory.create(SpeechSynthesisVoice{
                    ._name = spec.name,
                    ._lang = spec.lang,
                    ._local_service = spec.local_service,
                    ._default = spec.default_voice,
                });
            }
            break :blk s;
        } else blk: {
            const specs = &macos_chrome_voices;
            const s = try frame._page.frame_arena.alloc(?*SpeechSynthesisVoice, specs.len);
            for (specs, 0..) |spec, i| {
                s[i] = try frame._factory.create(SpeechSynthesisVoice{
                    ._name = spec.name,
                    ._lang = spec.lang,
                    ._local_service = true,
                    ._default = spec.default_voice,
                });
            }
            break :blk s;
        };
        frame._speech_voices = slots;
        frame._speech_voices_ready = true;
    }

    fn fireVoicesChanged(self: *const SpeechSynthesis, frame: *Frame) !void {
        const handler = self._on_voices_changed orelse return;
        var ls: js.Local.Scope = undefined;
        frame.js.localScope(&ls);
        ls.toLocal(handler).call(void, .{}) catch {};
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
        };
        pub const pending = bridge.accessor(SpeechSynthesis.getPending, null, .{});
        pub const speaking = bridge.accessor(SpeechSynthesis.getSpeaking, null, .{});
        pub const paused = bridge.accessor(SpeechSynthesis.getPaused, null, .{});
        pub const onvoiceschanged = bridge.accessor(SpeechSynthesis.getOnVoicesChanged, SpeechSynthesis.setOnVoicesChanged, .{});
        pub const getVoices = bridge.function(SpeechSynthesis.getVoices, .{});
        pub const speak = bridge.function(SpeechSynthesis.speak, .{});
        pub const cancel = bridge.function(SpeechSynthesis.cancel, .{});
        pub const pause = bridge.function(SpeechSynthesis.pause, .{});
        pub const @"resume" = bridge.function(SpeechSynthesis.resumeSpeaking, .{});
    };
};
