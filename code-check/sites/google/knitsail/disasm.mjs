/**
 * Static Knitsail bytecode scanner.
 * Full opcode semantics require runtime correlation; this pass extracts
 * slot indices, bit patterns, and entropy regions for reverse engineering.
 */
import { createBitstreamState, readBits } from "./bitstream.mjs";

const ENV_OPCODE_HINTS = {
    1: "read_u8",
    2: "read_u16",
    3: "read_u32",
    10: "push_const",
    20: "get_global",
    21: "call_host",
    30: "branch",
    40: "write_channel",
};

/**
 * Linear scan: decode slot indices until EOF or fuel exhausted.
 * @param {Uint8Array} bytecode
 * @param {number} key
 */
export function disassemble(bytecode, key, opts = {}) {
    const fuel = opts.fuel ?? 5000;
    const state = createBitstreamState(bytecode, key, opts.seeds ?? [0, 0]);
    const ops = [];
    const slotHist = new Map();

    for (let i = 0; i < fuel && state.pcBits < state.programEnd - 1; i++) {
        const startPos = state.pcBits;
        const slotRes = readBits(8, state, true);
        if (slotRes.eof) break;

        const slot = slotRes.value;
        slotHist.set(slot, (slotHist.get(slot) || 0) + 1);

        // Heuristic immediates after hot slots (varies by build)
        let imm = null;
        if ([20, 21, 40].includes(slot)) {
            const immRes = readBits(16, state, true);
            if (!immRes.eof) imm = immRes.value;
        }

        ops.push({
            i,
            pcBits: startPos,
            slot,
            hint: ENV_OPCODE_HINTS[slot] || null,
            imm,
        });

        if (state.pcBits <= startPos) break; // stuck
    }

    const topSlots = [...slotHist.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 24)
        .map(([slot, count]) => ({ slot, count, hint: ENV_OPCODE_HINTS[slot] || null }));

    return {
        opCount: ops.length,
        pcEnd: state.pcBits,
        programBits: state.programEnd,
        coveragePct: Math.round((state.pcBits / Math.max(state.programEnd, 1)) * 1000) / 10,
        topSlots,
        ops: opts.verbose ? ops : ops.slice(0, 200),
        truncated: !opts.verbose && ops.length > 200,
    };
}

/** Guess environment API reads from slot histogram + SerpBase known signals. */
export function inferSignals(disasm) {
    const known = [
        "performance.now",
        "performance.timing",
        "document.readyState",
        "window.trustedTypes",
        "navigator.userAgent",
        "navigator.platform",
        "navigator.languages",
        "navigator.hardwareConcurrency",
        "navigator.deviceMemory",
        "screen.width",
        "screen.height",
        "location.href",
        "Math.random",
    ];

    const hotCallSlots = disasm.topSlots.filter((s) => s.hint === "call_host" || s.slot >= 16);
    return {
        likelyHostCalls: hotCallSlots.length,
        candidateApis: known,
        note: "Correlate call_host slots with trace.mjs runtime log for stable formula mapping",
    };
}