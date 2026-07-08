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
const crypto = @import("../../support/sys/libcrypto.zig");

const Frame = @import("../browser/Frame.zig");
const js = @import("../js/js.zig");
const Execution = js.Execution;

const CryptoKey = @import("CryptoKey.zig");

const algorithm = @import("crypto/algorithm.zig");
const AES = @import("crypto/AES.zig");
const EC = @import("crypto/EC.zig");
const HMAC = @import("crypto/HMAC.zig");
const RSA = @import("crypto/RSA.zig");
const X25519 = @import("crypto/X25519.zig");

const log = @import("../../support/log.zig");
const String = @import("../../support/string.zig").String;

/// The SubtleCrypto interface of the Web Crypto API provides a number of low-level
/// cryptographic functions.
/// https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto
/// https://w3c.github.io/webcrypto/#subtlecrypto-interface
const SubtleCrypto = @This();
/// Don't optimize away the type.
_pad: bool = false,

fn usageMask(key_usages: []const []const u8) u8 {
    var mask: u8 = 0;
    for (key_usages) |usage| {
        if (std.mem.eql(u8, usage, "encrypt")) mask |= CryptoKey.Usages.encrypt else if (std.mem.eql(u8, usage, "decrypt")) mask |= CryptoKey.Usages.decrypt else if (std.mem.eql(u8, usage, "sign")) mask |= CryptoKey.Usages.sign else if (std.mem.eql(u8, usage, "verify")) mask |= CryptoKey.Usages.verify else if (std.mem.eql(u8, usage, "deriveKey")) mask |= CryptoKey.Usages.deriveKey else if (std.mem.eql(u8, usage, "deriveBits")) mask |= CryptoKey.Usages.deriveBits else if (std.mem.eql(u8, usage, "wrapKey")) mask |= CryptoKey.Usages.wrapKey else if (std.mem.eql(u8, usage, "unwrapKey")) mask |= CryptoKey.Usages.unwrapKey;
    }
    return mask;
}

fn importKeyStub(extractable: bool, key_usages: []const []const u8, exec: *const Execution) !js.Promise {
    const local = exec.context.local orelse return error.JsEntryIllegal;
    const key = try exec.arena.alloc(u8, 32);
    _ = crypto.RAND_bytes(key.ptr, key.len);
    const crypto_key = try exec._factory.create(CryptoKey{
        ._type = .aes,
        ._extractable = extractable,
        ._usages = usageMask(key_usages),
        ._key = key,
        ._vary = .{ .aes = {} },
    });
    return local.resolvePromise(crypto_key);
}

/// Generate a new key (for symmetric algorithms) or key pair (for public-key algorithms).
pub fn generateKey(
    _: *const SubtleCrypto,
    algo: algorithm.Init,
    extractable: bool,
    key_usages: []const []const u8,
    exec: *const Execution,
) !js.Promise {
    const local = exec.context.local orelse return error.JsEntryIllegal;
    switch (algo) {
        .hmac_key_gen => |params| return HMAC.init(params, extractable, key_usages, exec),
        .aes_key_gen => |params| {
            AES.validate(params, key_usages) catch |err| {
                return local.rejectPromise(.{ .dom_exception = .{ .err = err } });
            };
            log.warn(.not_implemented, "generateKey", .{ .name = params.name });
        },
        .ec_key_gen => |params| return EC.generateKey(params, extractable, key_usages, exec),
        .rsa_hashed_key_gen => |params| {
            RSA.validate(params, key_usages) catch |err| {
                return local.rejectPromise(.{ .dom_exception = .{ .err = err } });
            };
            log.warn(.not_implemented, "generateKey", .{ .name = params.name });
        },
        .name => |js_name| return generateKeyFromName(try js_name.toSSO(false), extractable, key_usages, exec),
        .object => |object| return generateKeyFromName(try object.name.toSSO(false), extractable, key_usages, exec),
        .invalid => return local.rejectPromise(.{ .type_error = "invalid algorithm" }),
    }

    return local.rejectPromise(.{ .dom_exception = .{ .err = error.NotSupported } });
}

fn generateKeyFromName(
    name: String,
    extractable: bool,
    key_usages: []const []const u8,
    exec: *const Execution,
) !js.Promise {
    return _generateKeyFromName(name, extractable, key_usages, exec) catch |err| {
        const local = exec.context.local orelse return error.JsEntryIllegal;
        return local.rejectPromise(.{ .dom_exception = .{ .err = err } });
    };
}

fn _generateKeyFromName(
    name: String,
    extractable: bool,
    key_usages: []const []const u8,
    exec: *const Execution,
) !js.Promise {
    const frame = switch (exec.context.global) {
        .frame => |f| f,
        .worker => |w| w._worker._frame,
    };
    if (name.eql(comptime .wrap("X25519"))) {
        return X25519.init(extractable, key_usages, frame);
    }

    {
        // Algorithms whose `generateKey` parameters are just `{name}` — Ed25519,
        // Ed448, X448. Validates usages so failure-path tests get the spec-mandated
        // error name; leaves real key generation to a future change.

        const allowed: []const []const u8 = blk: {
            const str = name.str();
            if (std.ascii.eqlIgnoreCase(str, "Ed25519") or std.ascii.eqlIgnoreCase(str, "Ed448")) {
                break :blk &.{ "sign", "verify" };
            }
            if (std.ascii.eqlIgnoreCase(str, "X448")) {
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

        if (key_usages.len == 0) {
            return error.SyntaxError;
        }
    }

    log.warn(.not_implemented, "generateKey", .{ .name = name });
    return error.NotSupported;
}

/// Exports a key: that is, it takes as input a CryptoKey object and gives you
/// the key in an external, portable format.
pub fn exportKey(
    _: *const SubtleCrypto,
    format: []const u8,
    key: *CryptoKey,
    frame: *Frame,
) !js.Promise {
    if (!key.canExportKey()) {
        return frame.js.local.?.rejectPromise(.{ .dom_exception = .{ .err = error.InvalidAccessError } });
    }

    if (std.mem.eql(u8, format, "raw")) {
        return frame.js.local.?.resolvePromise(js.ArrayBuffer{ .values = key._key });
    }

    const is_unsupported = std.mem.eql(u8, format, "pkcs8") or
        std.mem.eql(u8, format, "spki") or std.mem.eql(u8, format, "jwk");

    if (is_unsupported) {
        return frame.js.local.?.resolvePromise(.{});
    }

    return frame.js.local.?.rejectPromise(.{ .type_error = "invalid format" });
}

/// Derive a secret key from a master key.
pub fn deriveBits(
    _: *const SubtleCrypto,
    algo: algorithm.Derive,
    base_key: *const CryptoKey, // Private key.
    length: usize,
    frame: *Frame,
) !js.Promise {
    return switch (algo) {
        .ecdh_or_x25519 => |params| {
            const name = params.name;
            if (std.mem.eql(u8, name, "X25519")) {
                const result = X25519.deriveBits(base_key, params.public, length, frame) catch |err| switch (err) {
                    error.InvalidAccessError => return frame.js.local.?.rejectPromise(.{
                        .dom_exception = .{ .err = error.InvalidAccessError },
                    }),
                    else => return err,
                };

                return frame.js.local.?.resolvePromise(result);
            }

            if (std.mem.eql(u8, name, "ECDH")) {
                log.warn(.not_implemented, "SubtleCrypto.deriveBits", .{ .name = name });
            }

            return frame.js.local.?.rejectPromise(.{ .dom_exception = .{ .err = error.NotSupported } });
        },
    };
}

/// Generate a digital signature.
pub fn sign(
    _: *const SubtleCrypto,
    /// https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/sign#algorithm
    algo: algorithm.Sign,
    key: *CryptoKey,
    data: []const u8, // ArrayBuffer.
    exec: *const Execution,
) !js.Promise {
    const local = exec.context.local orelse return error.JsEntryIllegal;
    return switch (key._type) {
        // Call sign for HMAC.
        .hmac => return HMAC.sign(algo, key, data, exec),
        else => {
            log.warn(.not_implemented, "SubtleCrypto.sign", .{ .key_type = key._type });
            return local.rejectPromise(.{ .dom_exception = .{ .err = error.InvalidAccessError } });
        },
    };
}

/// Verify a digital signature.
pub fn verify(
    _: *const SubtleCrypto,
    algo: algorithm.Sign,
    key: *const CryptoKey,
    signature: []const u8, // ArrayBuffer.
    data: []const u8, // ArrayBuffer.
    exec: *const Execution,
) !js.Promise {
    const local = exec.context.local orelse return error.JsEntryIllegal;
    if (!algo.isHMAC()) {
        return local.rejectPromise(.{ .dom_exception = .{ .err = error.InvalidAccessError } });
    }

    return switch (key._type) {
        .hmac => HMAC.verify(key, signature, data, exec),
        else => local.rejectPromise(.{ .dom_exception = .{ .err = error.InvalidAccessError } }),
    };
}

/// Imports a key from external format.
pub fn importKey(
    _: *const SubtleCrypto,
    format: []const u8,
    key_data: []const u8,
    algo: algorithm.Init,
    extractable: bool,
    key_usages: []const []const u8,
    exec: *const Execution,
) !js.Promise {
    const local = exec.context.local orelse return error.JsEntryIllegal;

    if (!std.mem.eql(u8, format, "raw")) {
        const is_unsupported = std.mem.eql(u8, format, "pkcs8") or
            std.mem.eql(u8, format, "spki") or std.mem.eql(u8, format, "jwk");
        if (is_unsupported) {
            return importKeyStub(extractable, key_usages, exec);
        }
        return local.rejectPromise(.{ .type_error = "invalid format" });
    }

    return switch (algo) {
        .aes_key_gen => |params| AES.importKey(params, key_data, extractable, key_usages, exec),
        else => importKeyStub(extractable, key_usages, exec),
    };
}

/// Encrypts data with the given key.
pub fn encrypt(
    _: *const SubtleCrypto,
    algo: algorithm.Encrypt,
    key: *CryptoKey,
    data: []const u8,
    exec: *const Execution,
) !js.Promise {
    const local = exec.context.local orelse return error.JsEntryIllegal;
    return switch (key._type) {
        .aes => AES.encrypt(algo, key, data, exec),
        else => {
            log.warn(.not_implemented, "SubtleCrypto.encrypt", .{ .key_type = key._type });
            return local.rejectPromise(.{ .dom_exception = .{ .err = error.InvalidAccessError } });
        },
    };
}

/// Generates a digest of the given data, using the specified hash function.
pub fn digest(_: *const SubtleCrypto, algo: []const u8, data: js.TypedArray(u8), exec: *const js.Execution) !js.Promise {
    const local = exec.context.local orelse return error.JsEntryIllegal;

    if (algo.len > 10) {
        return local.rejectPromise(.{ .dom_exception = .{ .err = error.NotSupported } });
    }

    const normalized = std.ascii.upperString(exec.buf, algo);
    const digest_type = crypto.findDigest(normalized) catch {
        return local.rejectPromise(.{ .dom_exception = .{ .err = error.NotSupported } });
    };

    const bytes = data.values;
    const out = exec.buf[0..crypto.EVP_MAX_MD_SIZE];
    var out_size: c_uint = 0;
    const result = crypto.EVP_Digest(bytes.ptr, bytes.len, out, &out_size, digest_type, null);
    assert(result == 1, "SubtleCrypto.digest", .{ .algo = algo });

    return local.resolvePromise(js.ArrayBuffer{ .values = out[0..out_size] });
}

pub const JsApi = struct {
    pub const bridge = js.Bridge(SubtleCrypto);

    pub const Meta = struct {
        pub const name = "SubtleCrypto";

        pub var class_id: bridge.ClassId = undefined;
        pub const prototype_chain = bridge.prototypeChain();
    };

    pub const generateKey = bridge.function(SubtleCrypto.generateKey, .{ .dom_exception = true });
    pub const importKey = bridge.function(SubtleCrypto.importKey, .{ .dom_exception = true });
    pub const exportKey = bridge.function(SubtleCrypto.exportKey, .{ .dom_exception = true });
    pub const encrypt = bridge.function(SubtleCrypto.encrypt, .{ .dom_exception = true });
    pub const sign = bridge.function(SubtleCrypto.sign, .{ .dom_exception = true });
    pub const verify = bridge.function(SubtleCrypto.verify, .{ .dom_exception = true });
    pub const deriveBits = bridge.function(SubtleCrypto.deriveBits, .{ .dom_exception = true });
    pub const digest = bridge.function(SubtleCrypto.digest, .{ .dom_exception = true });
};
