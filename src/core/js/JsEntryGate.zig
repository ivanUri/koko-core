// Host reentrancy policy for Velora (see knowledge/architecture/2026-07-19-host-event-loop.md).
//
// APIs must not invent their own copies of is_evaluating / call_depth / V8 stack /
// transfer-callback checks. Ask this module.

const Execution = @import("Execution.zig");

const JsEntryGate = @This();

/// True when a host event (timer, MessagePort message, load handler body, …)
/// may run **synchronously** on the current stack.
///
/// If false, the caller must `queueTask` / scheduler.add and return — the task
/// runner uses the async path and must not re-apply these gates as a permanent
/// park.
pub fn canDispatchHostEventSync(exec: *const Execution) bool {
    if (exec.context.call_depth > 0) return false;
    if (exec.context.env.anyContextOnV8Stack()) return false;
    if (scriptEvalActive(exec)) return false;
    if (inTransferCallback(exec)) return false;
    return true;
}

/// Inverse of `canDispatchHostEventSync` for readability at call sites.
pub fn mustQueueAsTask(exec: *const Execution) bool {
    return !canDispatchHostEventSync(exec);
}

/// ScriptManager classic/module evaluation window (frame only; workers use
/// their own load path and report false here until unified).
pub fn scriptEvalActive(exec: *const Execution) bool {
    return switch (exec.context.global) {
        .frame => |frame| frame._script_manager.base.is_evaluating,
        .worker => false,
    };
}

/// Curl multi user callback (header/data/done) on the stack — must not start
/// Script.eval or sync host event chains that re-enter multi_add.
pub fn inTransferCallback(exec: *const Execution) bool {
    const frame = switch (exec.context.global) {
        .frame => |f| f,
        .worker => |wgs| wgs._worker._frame,
    };
    return frame._session.browser.http_client.inTransferCallback();
}

/// May begin a new Script.eval (not nested under V8 / transfer / another eval).
pub fn canStartScriptEval(exec: *const Execution) bool {
    if (exec.context.env.anyContextOnV8Stack()) return false;
    if (inTransferCallback(exec)) return false;
    if (scriptEvalActive(exec)) return false;
    return exec.canEnterJs(.strict_active);
}

/// True when any realm is on the V8 central stack. Prefer this over open-coded
/// `env.anyContextOnV8Stack()` for host pumps that must not re-enter V8.
/// (CDP inbound service intentionally uses the Env check directly — it must
/// not also block on `is_evaluating` / transfer like `mustQueueAsTask`.)
pub fn anyV8StackActive(exec: *const Execution) bool {
    return exec.context.env.anyContextOnV8Stack();
}
