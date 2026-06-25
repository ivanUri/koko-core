/**
 * Knitsail VM bitstream reader (SerpBase model).
 */
import { xjKeystream } from "./xj.mjs";

export function createBitstreamState(bytecode, key, seeds = [0, 0]) {
    const lf = bytecode instanceof Uint8Array ? bytecode : new Uint8Array(bytecode);
    const mask = lf.length > 0 ? (lf.length - 1) : 0;
    return {
        lf,
        K: key | 0,
        pcBits: 0,
        programEnd: lf.length * 8,
        currentBlock: -1,
        stream: null,
        seed1: seeds[0] | 0,
        seed2: seeds[1] | 0,
        mask,
    };
}

export function readBits(bitCount, state, encrypted = true) {
    let pos = state.pcBits;
    let out = 0;

    while (bitCount > 0) {
        const byteIndex = pos >> 3;
        if (byteIndex >= state.lf.length) {
            return { value: out, eof: true, pos };
        }

        const bitOffset = pos & 7;
        const available = 8 - bitOffset;
        const take = Math.min(available, bitCount);

        let byte = state.lf[byteIndex];
        if (encrypted) {
            if (state.currentBlock !== (pos >> 6)) {
                state.currentBlock = pos >> 6;
                state.stream = xjKeystream(14, state.K, state.currentBlock, 1104, [0, 0, state.seed1, state.seed2]);
            }
            byte ^= state.stream[byteIndex & state.mask];
        }

        const part = (byte >> (8 - bitOffset - take)) & ((1 << take) - 1);
        out |= part << (bitCount - take);
        bitCount -= take;
        pos += take;
    }

    state.pcBits = pos;
    return { value: out >>> 0, eof: false, pos };
}