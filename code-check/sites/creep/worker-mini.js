// Minimal dedicated-worker payload for CreepJS-style probes.
const IS_WORKER_SCOPE = !self.document && self.WorkerGlobalScope;
if (IS_WORKER_SCOPE) {
    const queue = (delay = 0) => new Promise((resolve) => setTimeout(resolve, delay));
    (async () => {
        await queue(0);
        const { hardwareConcurrency, language, languages, platform, userAgent, deviceMemory } = navigator;
        let userAgentData;
        if (navigator.userAgentData) {
            userAgentData = await navigator.userAgentData.getHighEntropyValues([
                "platform",
                "platformVersion",
                "architecture",
                "bitness",
                "model",
                "uaFullVersion",
            ]);
        }
        await queue(0);
        const { href, pathname } = self.location || {};
        self.postMessage({
            lied: 0,
            lies: { proto: false },
            locale: "" + Intl.DateTimeFormat().resolvedOptions().timeZone,
            timezoneOffset: new Date().getTimezoneOffset(),
            timezoneLocation: Intl.DateTimeFormat().resolvedOptions().timeZone,
            deviceMemory,
            hardwareConcurrency,
            language,
            languages: "" + languages,
            platform,
            userAgent,
            userAgentData,
            href,
            pathname,
        });
    })();
}