/**
 * Shared probe budget for Velora CDP scripts.
 *
 * Rule: if a probe is not done within maxSec (default 20), treat it as a hang.
 * Kill velora with SIGKILL, exit 3, do NOT retry blindly.
 */

export const DEFAULT_MAX_SEC = 20;
export const HANG_EXIT_CODE = 3;

/** Fixtures known to hang Velora within 20s — use skeleton instead. */
export const BLOCKED_FIXTURES = {};

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export async function fetchWithTimeout(url, timeoutMs = 3000) {
    const res = await fetch(url, { signal: AbortSignal.timeout(Math.max(1, timeoutMs)) });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
    return res;
}

export function parseMaxSecArg(argv, fallback = DEFAULT_MAX_SEC) {
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === "--max-sec") return Number(argv[++i]);
    }
    return fallback;
}

export function parseAllowSlowFixture(argv) {
    return argv.includes("--allow-slow-fixture");
}

export function checkFixtureAllowed(htmlPath, { allowSlow = false } = {}) {
    if (allowSlow || !htmlPath) return null;
    const base = String(htmlPath).split("/").pop() ?? "";
    const reason = BLOCKED_FIXTURES[base];
    if (!reason) return null;
    return { file: base, reason };
}

export function deadlineFromMaxSec(maxSec) {
    return Date.now() + maxSec * 1000;
}

export function remainingMs(deadline) {
    return Math.max(0, deadline - Date.now());
}

export function killProcess(proc, signal = "SIGKILL") {
    if (!proc || proc.killed) return;
    try { proc.kill(signal); } catch {}
}

export function startHardLimit(maxSec, onExpire) {
    const timer = setTimeout(() => {
        onExpire("hard_limit");
    }, maxSec * 1000);
    return () => clearTimeout(timer);
}

export function failHang(phase, { detail = null, cleanup = null, clearHardLimit = null } = {}) {
    console.error(`\n[HANG] ${phase} — probe did not finish within budget (likely Velora engine hang).`);
    console.error("Do NOT retry the same command. Fix root cause or use a smaller fixture first.");
    if (detail) console.error(detail);
    cleanup?.({ reason: "hang", signal: "SIGKILL" });
    clearHardLimit?.();
    process.exit(HANG_EXIT_CODE);
}

export function createProbeBudget(maxSec, cleanup) {
    const deadline = deadlineFromMaxSec(maxSec);
    const clearHardLimit = startHardLimit(maxSec, () => {
        failHang("hard_limit", { cleanup, clearHardLimit: () => {} });
    });
    return {
        maxSec,
        deadline,
        remaining: () => remainingMs(deadline),
        clear: () => clearHardLimit(),
        failHang: (phase, detail = null) => failHang(phase, { detail, cleanup, clearHardLimit }),
    };
}

export async function waitCdp(endpoint, deadline) {
    const normalized = String(endpoint).replace(/\/$/, "");
    for (let i = 0; i < 50; i += 1) {
        if (remainingMs(deadline) <= 0) {
            throw new Error("CDP not ready before deadline");
        }
        try {
            if ((await fetchWithTimeout(`${normalized}/json/version`, Math.min(3000, remainingMs(deadline)))).ok) return;
        } catch {}
        await delay(100);
    }
    throw new Error(`CDP not ready: ${normalized}`);
}

export async function evaluateWithTimeout(client, sessionId, expression, timeoutMs) {
    const ms = Math.max(1, timeoutMs);
    const result = await Promise.race([
        client.send("Runtime.evaluate", {
            expression,
            returnByValue: true,
            awaitPromise: false,
        }, sessionId).catch((err) => ({ __transportError: String(err?.message || err) })),
        delay(ms).then(() => null),
    ]);
    if (!result) return { timedOut: true };
    if (result.__transportError) return { error: result.__transportError };
    if (result.exceptionDetails) {
        return { error: result.exceptionDetails.text || "evaluate failed" };
    }
    return { value: result.result?.value };
}

/** Race a CDP op against remaining budget; on timeout = hang. */
export async function withBudget(budget, phase, promiseFactory) {
    const ms = budget.remaining();
    if (ms <= 0) budget.failHang(phase, "budget already exhausted");
    const result = await Promise.race([
        promiseFactory(ms),
        delay(ms).then(() => ({ __hang: true })),
    ]);
    if (result?.__hang) budget.failHang(phase, `timed out after ${ms}ms`);
    return result;
}