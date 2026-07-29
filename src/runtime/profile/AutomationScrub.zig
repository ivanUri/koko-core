const Frame = @import("../../core/browser/Frame.zig");

/// Remove common automation artifacts before page scripts run fingerprint probes.
/// Marker lists align with Fingerprint BotD `distinctive_properties` sources
/// (Selenium, WebDriver, Phantom, HeadlessChrome, Nightmare, …).
pub const scrub_script: []const u8 =
    \\(function(){
    \\  const winKeys=[
    \\    'webdriver','__webdriverFunc','__lastWatirAlert','__lastWatirConfirm','__lastWatirPrompt',
    \\    '_WEBDRIVER_ELEM_CACHE','ChromeDriverw',
    \\    '_Selenium_IDE_Recorder','_selenium','calledSelenium',
    \\    '__nightmare','nightmare','callPhantom','_phantom','__phantomas',
    \\    'domAutomation','domAutomationController',
    \\    'awesomium','RunPerfTest','CefSharp','fmget_targets','geb','wdioElectron',
    \\    '__playwright','__pw_manual','__PW_inspect','__puppeteer_evaluation_script__',
    \\    // Non-Chrome globals that fingerprint / bot classifiers treat as automation.
    \\    '_BROWSERAUTOMATION','_BAS_','_BASBrowser',
    \\    '__fxdriver_unwrapped','__webdriver_script_fn'
    \\  ];
    \\  const docKeys=[
    \\    '__selenium_evaluate','selenium-evaluate','__selenium_unwrapped',
    \\    '__webdriver_script_fn','__driver_evaluate','__webdriver_evaluate','__fxdriver_evaluate',
    \\    '__driver_unwrapped','__webdriver_unwrapped','__fxdriver_unwrapped',
    \\    '__webdriver_script_func','__webdriver_script_function',
    \\    '$cdc_asdjflasutopfhvcZLmcf','$cdc_asdjflasutopfhvcZLmcfl_',
    \\    '$chrome_asyncScriptInfo','__$webdriverAsyncExecutor'
    \\  ];
    \\  const scrubKey=(obj,k)=>{try{delete obj[k]}catch(_){}};
    \\  const isCdc=k=>/^cdc_|^\$cdc_|^\$chrome_asyncScriptInfo/.test(k);
    \\  const isSeleniumPattern=k=>/^[a-z]{3}_.*_(Array|Promise|Symbol)$/.test(k);
    \\  try{
    \\    for(const k of winKeys)scrubKey(window,k);
    \\    for(const k of Object.getOwnPropertyNames(window)){
    \\      if(isCdc(k)||isSeleniumPattern(k))scrubKey(window,k);
    \\    }
    \\  }catch(_){}
    \\  try{
    \\    for(const k of docKeys)scrubKey(document,k);
    \\    for(const k of Object.getOwnPropertyNames(document)){
    \\      if(isCdc(k)||isSeleniumPattern(k))scrubKey(document,k);
    \\    }
    \\  }catch(_){}
    \\  try{
    \\    const el=document.documentElement;
    \\    if(el&&typeof el.getAttributeNames==='function'){
    \\      for(const a of el.getAttributeNames()){
    \\        if(/webdriver|selenium|driver|cdc_/i.test(a)){
    \\          try{el.removeAttribute(a)}catch(_){}
    \\        }
    \\      }
    \\    }
    \\  }catch(_){}
    \\})();
;

pub fn applyOnce(frame: *Frame) void {
    const local = frame.js.local orelse return;
    if (!frame.claimAutomationScrubForCurrentRealm()) return;
    local.eval(scrub_script, "velora-automation-scrub") catch {};
}
