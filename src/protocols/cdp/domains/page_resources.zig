//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

const std = @import("std");

const id = @import("../id.zig");
const CDP = @import("../CDP.zig");
const Frame = @import("../../../core/browser/Frame.zig");
const dump = @import("../../../core/browser/dump.zig");

const ResourceFrame = struct {
    id: []const u8,
    loaderId: []const u8,
    url: []const u8,
    domainAndRegistry: []const u8 = "",
    securityOrigin: []const u8,
    mimeType: []const u8 = "text/html",
};

const Resource = struct {
    url: []const u8,
    type: []const u8 = "Document",
    mimeType: []const u8 = "text/html",
    failed: bool = false,
    canceled: bool = false,
};

const ResourceTree = struct {
    frame: ResourceFrame,
    childFrames: []const ResourceTree = &.{},
    resources: []const Resource = &.{},
};

const SearchMatch = struct {
    lineNumber: u32,
    lineContent: []const u8,
};

pub fn processMessage(cmd: *CDP.Command) !void {
    const action = std.meta.stringToEnum(enum {
        getResourceTree,
        searchInResource,
    }, cmd.input.action) orelse return error.UnknownMethod;

    switch (action) {
        .getResourceTree => return getResourceTree(cmd),
        .searchInResource => return searchInResource(cmd),
    }
}

fn getResourceTree(cmd: *CDP.Command) !void {
    _ = (try cmd.params(struct {})) orelse .{};
    const bc = cmd.browser_context orelse return error.BrowserContextNotLoaded;
    const frame = bc.session.currentFrame() orelse return error.FrameNotLoaded;
    return cmd.sendResult(.{ .frameTree = try buildTree(cmd.arena, frame, bc) }, .{});
}

fn buildTree(arena: std.mem.Allocator, frame: *Frame, bc: *CDP.BrowserContext) !ResourceTree {
    const frame_id = try arena.dupe(u8, &id.toFrameId(frame._frame_id));
    const loader_id = try arena.dupe(u8, &id.toLoaderId(frame._loader_id));
    const url = try arena.dupe(u8, if (frame.url.len > 0) frame.url else "about:blank");
    const origin = try arena.dupe(u8, frame.origin orelse bc.security_origin);
    const children = try arena.alloc(ResourceTree, frame.child_frames.items.len);
    for (frame.child_frames.items, 0..) |child, index| {
        children[index] = try buildTree(arena, child, bc);
    }

    const resources = if (frame.url.len == 0) &[_]Resource{} else try arena.dupe(Resource, &.{.{ .url = url }});
    return .{
        .frame = .{
            .id = frame_id,
            .loaderId = loader_id,
            .url = url,
            .securityOrigin = origin,
        },
        .childFrames = children,
        .resources = resources,
    };
}

fn searchInResource(cmd: *CDP.Command) !void {
    const params = (try cmd.params(struct {
        frameId: []const u8,
        url: []const u8,
        query: []const u8,
        caseSensitive: bool = false,
        isRegex: bool = false,
    })) orelse return error.InvalidParams;
    if (params.query.len == 0 or params.isRegex) return error.NotImplemented;

    const bc = cmd.browser_context orelse return error.BrowserContextNotLoaded;
    const frame_id = try id.parseFrameId(params.frameId);
    const frame = bc.session.findFrameByFrameId(frame_id) orelse return error.FrameNotFound;
    if (params.url.len > 0 and !std.mem.eql(u8, params.url, frame.url)) return error.NotImplemented;

    var output = std.Io.Writer.Allocating.init(cmd.arena);
    try dump.root(frame.document, .{ .shadow = .skip }, &output.writer, frame);
    const source = output.written();

    var matches: std.ArrayListUnmanaged(SearchMatch) = .empty;
    var lines = std.mem.splitScalar(u8, source, '\n');
    var line_number: u32 = 0;
    while (lines.next()) |line| : (line_number += 1) {
        const found = if (params.caseSensitive)
            std.mem.indexOf(u8, line, params.query) != null
        else
            std.ascii.indexOfIgnoreCase(line, params.query) != null;
        if (found) try matches.append(cmd.arena, .{
            .lineNumber = line_number,
            .lineContent = line,
        });
    }

    return cmd.sendResult(.{ .result = matches.items }, .{});
}
