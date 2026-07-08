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

const js = @import("../js/js.zig");
const WorkerGlobalScope = @import("WorkerGlobalScope.zig");

const DedicatedWorkerGlobalScope = @This();

/// Dedicated workers reuse the WorkerGlobalScope heap object; this type exists
/// only for the JS prototype chain (instanceof / global constructor exposure).
_proto: *WorkerGlobalScope,

pub const JsApi = struct {
    pub const bridge = js.Bridge(DedicatedWorkerGlobalScope);

    pub const Meta = struct {
        pub const name = "DedicatedWorkerGlobalScope";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };
};
