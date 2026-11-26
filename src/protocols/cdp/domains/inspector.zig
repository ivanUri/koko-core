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
const CDP = @import("../CDP.zig");

pub fn processMessage(cmd: *CDP.Command) !void {
    _ = std.meta.stringToEnum(enum {
        enable,
        disable,
    }, cmd.input.action) orelse return error.UnknownMethod;

    // Inspector state is owned by V8's inspector session. Do not acknowledge
    // these commands locally: a local success would make this domain diverge
    // from the Debugger/Profiler domains, which are forwarded to V8 as well.
    const bc = cmd.browser_context orelse return error.BrowserContextNotLoaded;
    bc.callInspector(cmd.input.json);
}
