/**
 * Google Knitsail Xj keystream (14-round ARX).
 * Reference: https://serpbase.dev/blog/google-knitsail-and-sg-ss-generation-logic-and-its-role-in-distinguishing-automa
 */

/** @returns {number[]} 8-byte keystream block */
export function xjKeystream(rounds, r, o, z, d) {
    let u = d[2] | 0;
    let y = d[3] | 0;
    r = r | 0;
    o = o | 0;
    z = z | 0;

    for (let i = 0; i < rounds; i++) {
        o = (o >>> 8) | (o << 24);
        o = (o + r) | 0;
        y = (y >>> 8) | (y << 24);
        o = o ^ ((u + z) | 0);

        r = (r << 3) | (r >>> 29);
        r = r ^ o;

        y = (y + u) | 0;
        y = y ^ ((i + z) | 0);

        u = (u << 3) | (u >>> 29);
        u = u ^ y;
    }

    return [
        (r >>> 24) & 255, (r >>> 16) & 255, (r >>> 8) & 255, r & 255,
        (o >>> 24) & 255, (o >>> 16) & 255, (o >>> 8) & 255, o & 255,
    ];
}

/** Decrypt Knitsail program bytes from param p/sp. */
export function decryptBytecode(encryptedBytes, key) {
    const out = new Uint8Array(encryptedBytes.length);
    const rounds = 14;
    const z = 1104;
    const d = [0, 0, 0, 0];

    for (let block = 0; block * 8 < encryptedBytes.length; block++) {
        const stream = xjKeystream(rounds, key, block, z, d);
        for (let i = 0; i < 8 && block * 8 + i < encryptedBytes.length; i++) {
            out[block * 8 + i] = encryptedBytes[block * 8 + i] ^ stream[i];
        }
    }
    return out;
}