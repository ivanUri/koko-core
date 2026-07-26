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

//! AES importKey / encrypt for Web Crypto (AES-GCM).

const std = @import("std");
const assert = @import("../../../support/assert.zig").assert;
const crypto = @import("../../../support/sys/libcrypto.zig");

const js = @import("../../js/js.zig");
const Execution = js.Execution;
const algorithm = @import("algorithm.zig");

const CryptoKey = @import("../CryptoKey.zig");

/// Per WebCrypto: "Generate Key" operation for AES-CBC/CTR/GCM/KW.
/// Validation order matches the spec: usages → length → empty usages.
pub fn validate(params: algorithm.Init.AesKeyGen, key_usages: []const []const u8) !void {
    const allowed: []const []const u8 = blk: {
        if (eql(params.name, "AES-CBC") or
            eql(params.name, "AES-CTR") or
            eql(params.name, "AES-GCM"))
        {
            break :blk &.{ "encrypt", "decrypt", "wrapKey", "unwrapKey" };
        }
        if (eql(params.name, "AES-KW")) {
            break :blk &.{ "wrapKey", "unwrapKey" };
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

    if (params.length != 128 and params.length != 192 and params.length != 256) {
        return error.OperationError;
    }

    if (key_usages.len == 0) {
        return error.SyntaxError;
    }
}

pub fn importKey(
    params: algorithm.Init.AesKeyGen,
    key_data: []const u8,
    extractable: bool,
    key_usages: []const []const u8,
    exec: *const Execution,
) !js.Promise {
    const local = exec.context.local orelse return error.JsEntryIllegal;

    if (!eql(params.name, "AES-GCM")) {
        return local.rejectPromise(.{ .dom_exception = .{ .err = error.NotSupported } });
    }

    const import_params: algorithm.Init.AesKeyGen = .{
        .name = params.name,
        .length = params.length,
    };
    validate(import_params, key_usages) catch |err| {
        return local.rejectPromise(.{ .dom_exception = .{ .err = err } });
    };

    const expected_len = params.length / 8;
    if (key_data.len != expected_len) {
        return local.rejectPromise(.{ .dom_exception = .{ .err = error.OperationError } });
    }

    var mask: u8 = 0;
    for (key_usages) |usage| {
        if (std.mem.eql(u8, usage, "encrypt")) {
            mask |= CryptoKey.Usages.encrypt;
        } else if (std.mem.eql(u8, usage, "decrypt")) {
            mask |= CryptoKey.Usages.decrypt;
        } else if (std.mem.eql(u8, usage, "wrapKey")) {
            mask |= CryptoKey.Usages.wrapKey;
        } else if (std.mem.eql(u8, usage, "unwrapKey")) {
            mask |= CryptoKey.Usages.unwrapKey;
        } else {
            return local.rejectPromise(.{ .dom_exception = .{ .err = error.SyntaxError } });
        }
    }

    const key = try exec.arena.dupe(u8, key_data);

    const crypto_key = try exec._factory.create(CryptoKey{
        ._type = .aes,
        ._extractable = extractable,
        ._usages = mask,
        ._key = key,
        ._vary = .{ .aes = {} },
    });

    return local.resolvePromise(crypto_key);
}

pub fn encrypt(
    algo: algorithm.Encrypt,
    crypto_key: *const CryptoKey,
    data: []const u8,
    exec: *const Execution,
) !js.Promise {
    const local = exec.context.local orelse return error.JsEntryIllegal;
    var resolver = local.createPromiseResolver();

    if (crypto_key._type != .aes or !crypto_key.canEncrypt() or !algo.isAesGcm()) {
        resolver.rejectError("AES.encrypt", .{ .dom_exception = .{ .err = error.InvalidAccessError } });
        return resolver.promise();
    }

    const params = switch (algo) {
        .aes_gcm => |p| p,
        else => {
            resolver.rejectError("AES.encrypt", .{ .dom_exception = .{ .err = error.NotSupported } });
            return resolver.promise();
        },
    };

    const iv = params.iv.values;
    if (iv.len == 0 or iv.len > std.math.maxInt(c_int)) {
        resolver.rejectError("AES.encrypt", .{ .dom_exception = .{ .err = error.OperationError } });
        return resolver.promise();
    }

    const tag_bits: u32 = params.tagLength orelse 128;
    if (tag_bits % 8 != 0 or tag_bits < 32 or tag_bits > 128) {
        resolver.rejectError("AES.encrypt", .{ .dom_exception = .{ .err = error.OperationError } });
        return resolver.promise();
    }
    const tag_len: usize = tag_bits / 8;

    const cipher = cipherForKey(crypto_key._key.len) orelse {
        resolver.rejectError("AES.encrypt", .{ .dom_exception = .{ .err = error.OperationError } });
        return resolver.promise();
    };

    const ctx = crypto.EVP_CIPHER_CTX_new() orelse {
        resolver.rejectError("AES.encrypt", .{ .dom_exception = .{ .err = error.OperationError } });
        return resolver.promise();
    };
    defer crypto.EVP_CIPHER_CTX_free(ctx);

    if (crypto.EVP_EncryptInit_ex(ctx, cipher, null, crypto_key._key.ptr, null) != 1) {
        resolver.rejectError("AES.encrypt", .{ .dom_exception = .{ .err = error.OperationError } });
        return resolver.promise();
    }

    if (crypto.EVP_CIPHER_CTX_ctrl(ctx, crypto.EVP_CTRL_AEAD_SET_IVLEN, @intCast(iv.len), null) != 1) {
        resolver.rejectError("AES.encrypt", .{ .dom_exception = .{ .err = error.OperationError } });
        return resolver.promise();
    }

    if (crypto.EVP_EncryptInit_ex(ctx, null, null, null, iv.ptr) != 1) {
        resolver.rejectError("AES.encrypt", .{ .dom_exception = .{ .err = error.OperationError } });
        return resolver.promise();
    }

    if (params.additionalData) |aad| {
        const aad_bytes = aad.values;
        if (aad_bytes.len > 0) {
            var aad_out_len: c_int = 0;
            if (crypto.EVP_EncryptUpdate(ctx, null, &aad_out_len, aad_bytes.ptr, @intCast(aad_bytes.len)) != 1) {
                resolver.rejectError("AES.encrypt", .{ .dom_exception = .{ .err = error.OperationError } });
                return resolver.promise();
            }
        }
    }

    const out = try exec.call_arena.alloc(u8, data.len + tag_len);
    var out_len: c_int = 0;

    if (data.len > 0) {
        if (crypto.EVP_EncryptUpdate(ctx, out.ptr, &out_len, data.ptr, @intCast(data.len)) != 1) {
            exec.call_arena.free(out);
            resolver.rejectError("AES.encrypt", .{ .dom_exception = .{ .err = error.OperationError } });
            return resolver.promise();
        }
    }

    var final_len: c_int = 0;
    if (crypto.EVP_EncryptFinal_ex(ctx, out.ptr + @as(usize, @intCast(out_len)), &final_len) != 1) {
        exec.call_arena.free(out);
        resolver.rejectError("AES.encrypt", .{ .dom_exception = .{ .err = error.OperationError } });
        return resolver.promise();
    }
    out_len += final_len;

    if (crypto.EVP_CIPHER_CTX_ctrl(
        ctx,
        crypto.EVP_CTRL_AEAD_GET_TAG,
        @intCast(tag_len),
        out.ptr + @as(usize, @intCast(out_len)),
    ) != 1) {
        exec.call_arena.free(out);
        resolver.rejectError("AES.encrypt", .{ .dom_exception = .{ .err = error.OperationError } });
        return resolver.promise();
    }

    const total: usize = @as(usize, @intCast(out_len)) + tag_len;
    assert(total == out.len, "AES.encrypt", .{ .out_len = out_len, .tag_len = tag_len });

    resolver.resolve("AES.encrypt", js.ArrayBuffer{ .values = out[0..total] });
    return resolver.promise();
}

fn cipherForKey(key_len: usize) ?*const crypto.EVP_CIPHER {
    return switch (key_len) {
        16 => crypto.EVP_aes_128_gcm(),
        24 => crypto.EVP_aes_192_gcm(),
        32 => crypto.EVP_aes_256_gcm(),
        else => null,
    };
}

fn eql(a: []const u8, b: []const u8) bool {
    return std.ascii.eqlIgnoreCase(a, b);
}
