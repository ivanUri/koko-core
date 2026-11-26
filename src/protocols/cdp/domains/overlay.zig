// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

const std = @import("std");
const CDP = @import("../CDP.zig");

/// Overlay is deliberately kept separate from DOM geometry. Koko is
/// headless and has no compositor surface, so this domain validates control
/// messages without emitting synthetic paint/highlight events.
pub fn processMessage(cmd: *CDP.Command) !void {
    const action = std.meta.stringToEnum(enum {
        enable,
        disable,
        setInspectMode,
        setShowAdHighlights,
        setShowDebugBorders,
        setShowFPSCounter,
        setShowGridOverlays,
        setShowPaintRects,
        setShowScrollBottleneckRects,
        setShowWebVitals,
        setShowViewportSizeOnResize,
        setShowHinge,
    }, cmd.input.action) orelse return error.UnknownMethod;

    switch (action) {
        .enable, .disable => return cmd.sendResult(null, .{}),
        .setInspectMode => {
            _ = (try cmd.params(struct {
                mode: []const u8,
                highlightConfig: ?struct {} = null,
            })) orelse return error.InvalidParams;
            return cmd.sendResult(null, .{});
        },
        .setShowAdHighlights => return boolParam(cmd, "showAdHighlights"),
        .setShowDebugBorders => return boolParam(cmd, "showDebugBorders"),
        .setShowFPSCounter => return boolParam(cmd, "showFPSCounter"),
        .setShowGridOverlays => return cmd.sendResult(null, .{}),
        .setShowPaintRects => return boolParam(cmd, "result"),
        .setShowScrollBottleneckRects => return boolParam(cmd, "show"),
        .setShowWebVitals => return boolParam(cmd, "show"),
        .setShowViewportSizeOnResize => return boolParam(cmd, "show"),
        .setShowHinge => return cmd.sendResult(null, .{}),
    }
}

fn boolParam(cmd: *CDP.Command, comptime field_name: []const u8) !void {
    const Params = struct {
        value: bool = false,
    };
    _ = field_name;
    _ = (try cmd.params(Params)) orelse return error.InvalidParams;
    return cmd.sendResult(null, .{});
}
