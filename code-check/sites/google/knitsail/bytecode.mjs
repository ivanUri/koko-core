/**
 * Parse Knitsail program param (sp / p) → decrypted bytecode.
 */
import { decryptBytecode } from "./xj.mjs";

function b64DecodeFlexible(s) {
    let t = String(s || "").trim();
    if (t.startsWith("*")) t = t.slice(1);
    // url-safe → standard
    t = t.replace(/-/g, "+").replace(/_/g, "/");
    while (t.length % 4) t += "=";
    return Buffer.from(t, "base64");
}

/** @param {string} p  Program string (often AAA... prefix per SerpBase) */
export function parseProgram(p) {
    const raw = String(p || "");
    if (!raw || raw.length < 8) {
        return { error: "program_too_short", rawLen: raw.length };
    }

    // SerpBase: decoded = base64Decode(p.slice(3)); key = u32be(decoded,0); enc = decoded.slice(4)
    // Live Google uses 3-char prefix then base64 body (e.g. xOsanKN0..., AAA...).
    const body = raw.length > 8 ? raw.slice(3) : raw;
    let decoded;
    try {
        decoded = b64DecodeFlexible(body);
    } catch (e) {
        return { error: "base64_decode_failed", message: String(e), rawLen: raw.length, prefix: raw.slice(0, 24) };
    }
    if (decoded.length < 5) {
        return { error: "decoded_too_short", decodedLen: decoded.length };
    }

    const key = decoded.readUInt32BE(0);
    const encrypted = new Uint8Array(decoded.subarray(4));
    const bytecode = decryptBytecode(encrypted, key);

    return {
        rawLen: raw.length,
        prefix: raw.slice(0, 12),
        key,
        encryptedLen: encrypted.length,
        bytecode,
        bytecodeLen: bytecode.length,
        bytecodeHexPreview: Buffer.from(bytecode.slice(0, 64)).toString("hex"),
    };
}

export function parseProgramFromDump(dump) {
    const candidates = [];
    for (const field of ["p", "sp", "spLive", "spValue"]) {
        const v = dump?.globals?.[field] ?? dump?.[field];
        if (typeof v === "string" && v.length > 20) candidates.push({ field, value: v });
    }
    const out = [];
    for (const c of candidates) {
        out.push({ ...c, parsed: parseProgram(c.value) });
    }
    return out;
}