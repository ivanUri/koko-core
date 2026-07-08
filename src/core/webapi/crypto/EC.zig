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

//! ECDSA / ECDH generateKey parameter validation. See AES.zig for
//! the rationale on validate-without-generate.

const std = @import("std");

const crypto = @import("../../../support/sys/libcrypto.zig");
const js = @import("../../js/js.zig");
const Execution = js.Execution;

const CryptoKey = @import("../CryptoKey.zig");
const algorithm = @import("algorithm.zig");

pub fn validate(params: algorithm.Init.EcKeyGen, key_usages: []const []const u8) !void {
    const allowed: []const []const u8 = blk: {
        if (eql(params.name, "ECDSA")) {
            break :blk &.{ "sign", "verify" };
        }
        if (eql(params.name, "ECDH")) {
            break :blk &.{ "deriveKey", "deriveBits" };
        }
        return error.NotSupported;
    };

    for (key_usages) |usage| {
        var ok = false;
        for (allowed) |a| {
            if (std.mem.eql(u8, a, usage)) {
                ok = true;
                break;
            }
        }
        if (!ok) {
            return error.SyntaxError;
        }
    }

    // Per spec, an unsupported `namedCurve` is NotSupportedError, not OperationError —
    // unlike AES length, where the algorithm registers the value as invalid.
    if (!eql(params.namedCurve, "P-256") and
        !eql(params.namedCurve, "P-384") and
        !eql(params.namedCurve, "P-521"))
    {
        return error.NotSupported;
    }

    if (key_usages.len == 0) {
        return error.SyntaxError;
    }
}

fn eql(a: []const u8, b: []const u8) bool {
    return std.ascii.eqlIgnoreCase(a, b);
}

fn usageMask(key_usages: []const []const u8) u8 {
    var mask: u8 = 0;
    for (key_usages) |usage| {
        if (std.mem.eql(u8, usage, "sign")) mask |= CryptoKey.Usages.sign else if (std.mem.eql(u8, usage, "verify")) mask |= CryptoKey.Usages.verify else if (std.mem.eql(u8, usage, "deriveKey")) mask |= CryptoKey.Usages.deriveKey else if (std.mem.eql(u8, usage, "deriveBits")) mask |= CryptoKey.Usages.deriveBits;
    }
    return mask;
}

/// Stub P-256 key pair for Google Accounts `generateKey({name: ECDSA})` probes.
/// Real ECDSA sign/verify is not implemented; this only avoids NotSupported jserror.
pub fn generateKey(
    params: algorithm.Init.EcKeyGen,
    extractable: bool,
    key_usages: []const []const u8,
    exec: *const Execution,
) !js.Promise {
    const local = exec.context.local orelse return error.JsEntryIllegal;
    try validate(params, key_usages);

    const mask = usageMask(key_usages);
    const is_ecdh = eql(params.name, "ECDH");

    const private_key = try exec.arena.alloc(u8, 32);
    const public_key = try exec.arena.alloc(u8, if (is_ecdh) 32 else 65);
    _ = crypto.RAND_bytes(private_key.ptr, private_key.len);
    _ = crypto.RAND_bytes(public_key.ptr, public_key.len);
    if (!is_ecdh) public_key[0] = 0x04;

    const private_usages = if (is_ecdh) mask else mask & (CryptoKey.Usages.sign | CryptoKey.Usages.deriveKey | CryptoKey.Usages.deriveBits);
    const public_usages = if (is_ecdh) mask & (CryptoKey.Usages.deriveKey | CryptoKey.Usages.deriveBits) else mask & CryptoKey.Usages.verify;

    const private = try exec._factory.create(CryptoKey{
        ._type = .rsa,
        ._extractable = extractable,
        ._usages = private_usages,
        ._key = private_key,
        ._vary = .{ .aes = {} },
    });

    const public = try exec._factory.create(CryptoKey{
        ._type = .rsa,
        ._extractable = true,
        ._usages = public_usages,
        ._key = public_key,
        ._vary = .{ .aes = {} },
    });

    return local.resolvePromise(CryptoKey.Pair{ .privateKey = private, .publicKey = public });
}
