(function () {
    try {
        function def(obj, key, desc) {
            if (key in obj) return;
            Object.defineProperty(obj, key, desc);
        }
        function fn(name) {
            var f = function () {};
            try {
                Object.defineProperty(f, "name", { value: name });
            } catch (e) {}
            return f;
        }
        if (typeof Intl !== "undefined") {
            if (!("DisplayNames" in Intl))
                def(Intl, "DisplayNames", { value: fn("DisplayNames"), writable: true, configurable: true, enumerable: false });
            if (!("Segmenter" in Intl))
                def(Intl, "Segmenter", { value: fn("Segmenter"), writable: true, configurable: true, enumerable: false });
            if (!("ListFormat" in Intl))
                def(Intl, "ListFormat", { value: fn("ListFormat"), writable: true, configurable: true, enumerable: false });
            if (!("PluralRules" in Intl))
                def(Intl, "PluralRules", { value: fn("PluralRules"), writable: true, configurable: true, enumerable: false });
            if (!("RelativeTimeFormat" in Intl))
                def(Intl, "RelativeTimeFormat", { value: fn("RelativeTimeFormat"), writable: true, configurable: true, enumerable: false });
            if (!("supportedValuesOf" in Intl))
                def(Intl, "supportedValuesOf", { value: fn("supportedValuesOf"), writable: true, configurable: true, enumerable: false });
        }
    } catch (e) {}
})();