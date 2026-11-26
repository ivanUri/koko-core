// Forward CDP domains implemented by V8's inspector to the active inspector
// session. Koko keeps browser and DOM lifecycle ownership in Zig while V8
// remains authoritative for debugger and profiler semantics.

const CDP = @import("../CDP.zig");

pub fn processMessage(cmd: *CDP.Command) !void {
    const bc = cmd.browser_context orelse return error.BrowserContextNotLoaded;
    // The inspector consumes the original id/method/params and emits the
    // response/events through Koko's existing inspector channel.
    bc.callInspector(cmd.input.json);
}
