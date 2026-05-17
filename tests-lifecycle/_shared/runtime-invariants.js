(function () {
    function ensureGlobals() {
        window.TEST_LOGS = window.TEST_LOGS || [];
        window.TEST_EVENTS = window.TEST_EVENTS || [];
        window.TEST_RESULT = window.TEST_RESULT || { done: false };
    }

    function log(value) {
        ensureGlobals();
        window.TEST_LOGS.push(value);
    }

    function event(type, data) {
        ensureGlobals();
        window.TEST_EVENTS.push({ index: window.TEST_EVENTS.length, type, data: data || null });
        log("event:" + type);
    }

    function fail(label, reason) {
        log(label + ":FAIL:" + reason);
        return false;
    }

    function checkRealm(label, win) {
        if (!win) return fail(label, "window-null");
        try {
            const doc = win.document;
            const checks = [
                ["Object", typeof win.Object === "function"],
                ["Function", typeof win.Function === "function"],
                ["Array", typeof win.Array === "function"],
                ["Promise", typeof win.Promise === "function"],
                ["Reflect", !!win.Reflect],
                ["Object.prototype", !!(win.Object && win.Object.prototype)],
                ["Function.prototype", !!(win.Function && win.Function.prototype)],
                ["Array.prototype", !!(win.Array && win.Array.prototype)],
                ["Promise.prototype", !!(win.Promise && win.Promise.prototype)],
                ["Object.prototype.toString", typeof win.Object.prototype.toString === "function"],
                ["Function.prototype.toString", typeof win.Function.prototype.toString === "function"],
                ["navigator", !!win.navigator],
                ["document", !!doc],
                ["documentElement", !!(doc && doc.documentElement)],
            ];
            let ok = true;
            for (const check of checks) {
                if (check[1]) log(label + ":" + check[0]);
                else { log(label + ":missing:" + check[0]); ok = false; }
            }
            const fnText = win.Function.prototype.toString.call(win.Function);
            if (typeof fnText === "string" && fnText.length > 0) log(label + ":function-toString-ok");
            else ok = fail(label, "function-toString-empty");
            const objText = win.Object.prototype.toString.call(win.navigator);
            if (typeof objText === "string" && objText.indexOf("object") >= 0) log(label + ":object-toString-ok");
            else ok = fail(label, "object-toString-bad");
            const arr = new win.Array(1, 2, 3);
            if (arr instanceof win.Array) log(label + ":array-instanceof-own-realm");
            else ok = fail(label, "array-instanceof-own-realm");
            return ok;
        } catch (err) {
            return fail(label, err.name + ":" + String(err.message || ""));
        }
    }

    function done(extra) {
        ensureGlobals();
        window.TEST_RESULT = Object.assign({ done: true, logs: window.TEST_LOGS.slice(), events: window.TEST_EVENTS.slice() }, extra || {});
    }

    window.RuntimeInvariant = { log, event, fail, checkRealm, done };
})();
