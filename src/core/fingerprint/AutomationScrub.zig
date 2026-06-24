const Frame = @import("../browser/Frame.zig");

/// Remove common automation artifacts before page scripts run fingerprint probes.
pub const scrub_script: []const u8 =
    "(function(){const scrubKey=(k)=>{try{delete window[k]}catch(_){}try{delete document[k]}catch(_){}};" ++
    "for(const k of Object.getOwnPropertyNames(window)){if(/^cdc_|^\\$cdc_/.test(k))scrubKey(k);}" ++
    "for(const k of Object.getOwnPropertyNames(document)){if(/^cdc_|^\\$cdc_/.test(k))scrubKey(k);}})();";

pub fn applyOnce(frame: *Frame) void {
    if (frame._automation_scrubbed) return;
    frame._automation_scrubbed = true;
    const local = frame.js.local orelse return;
    local.eval(scrub_script, "velora-automation-scrub") catch {};
}
