(function () {
    try {
        function def(proto, key, desc) {
            if (key in proto) return;
            Object.defineProperty(proto, key, desc);
        }
        function fn(name) {
            var f = function () {};
            try {
                Object.defineProperty(f, "name", { value: name });
            } catch (e) {}
            return f;
        }

        var d = Object.getOwnPropertyDescriptor(JSON, "rawJSON");
        if (!d || typeof d.value !== "function")
            def(JSON, "rawJSON", { value: fn("rawJSON"), writable: true, configurable: true });
        d = Object.getOwnPropertyDescriptor(JSON, "isRawJSON");
        if (!d || typeof d.value !== "function")
            def(JSON, "isRawJSON", { value: fn("isRawJSON"), writable: true, configurable: true });

        if (!("waitAsync" in Atomics))
            def(Atomics, "waitAsync", { value: fn("waitAsync"), writable: true, configurable: true, enumerable: true });
        if (!("hasOwn" in Object))
            def(Object, "hasOwn", {
                value: function hasOwn(o, k) {
                    return Object.prototype.hasOwnProperty.call(o, k);
                },
                writable: true,
                configurable: true,
                enumerable: true,
            });

        var docEvt = [
            "onsecuritypolicyviolation", "onformdata", "onpointerrawupdate",
            "onanimationend", "onanimationiteration", "onanimationstart", "ontransitionend",
            "onwebkitanimationend", "onwebkitanimationiteration", "onwebkitanimationstart", "onwebkittransitionend",
            "onbeforexrselect", "onbeforematch", "ontransitioncancel", "ontransitionrun", "ontransitionstart",
            "onslotchange", "oncontextlost", "oncontextrestored", "onscrollend",
        ];
        for (var i = 0; i < docEvt.length; i++)
            def(Document.prototype, docEvt[i], { value: null, writable: true, configurable: true, enumerable: true });

        def(Document.prototype, "getAnimations", { value: fn("getAnimations"), writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "startViewTransition", { value: fn("startViewTransition"), writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "fragmentDirective", { value: {}, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "timeline", { get: function () { return {}; }, configurable: true, enumerable: true });
        def(Document.prototype, "replaceChildren", { value: fn("replaceChildren"), writable: true, configurable: true, enumerable: true });
        if (!("adoptedStyleSheets" in Document.prototype))
            def(Document.prototype, "adoptedStyleSheets", { value: [], writable: true, configurable: true, enumerable: true });

        def(Element.prototype, "elementTiming", { value: "", writable: true, configurable: true, enumerable: true });
        def(Element.prototype, "getAnimations", { value: fn("getAnimations"), writable: true, configurable: true, enumerable: true });
        def(Element.prototype, "replaceChildren", { value: fn("replaceChildren"), writable: true, configurable: true, enumerable: true });
        def(Element.prototype, "role", { value: null, writable: true, configurable: true, enumerable: true });
        if (!("part" in Element.prototype))
            def(Element.prototype, "part", { value: null, writable: true, configurable: true, enumerable: true });

        var aria = [
            "ariaAtomic", "ariaAutoComplete", "ariaBrailleLabel", "ariaBrailleRoleDescription", "ariaBusy",
            "ariaChecked", "ariaColCount", "ariaColIndex", "ariaColSpan", "ariaCurrent", "ariaDescription",
            "ariaDisabled", "ariaExpanded", "ariaHasPopup", "ariaHidden", "ariaInvalid", "ariaKeyShortcuts",
            "ariaLabel", "ariaLevel", "ariaLive", "ariaModal", "ariaMultiLine", "ariaMultiSelectable",
            "ariaOrientation", "ariaPlaceholder", "ariaPosInSet", "ariaPressed", "ariaReadOnly", "ariaRelevant",
            "ariaRequired", "ariaRoleDescription", "ariaRowCount", "ariaRowIndex", "ariaRowSpan", "ariaSelected",
            "ariaSetSize", "ariaSort", "ariaValueMax", "ariaValueMin", "ariaValueNow", "ariaValueText",
        ];
        for (i = 0; i < aria.length; i++)
            def(Element.prototype, aria[i], { value: null, writable: true, configurable: true, enumerable: true });

        if (typeof Intl !== "undefined") {
            if (!("DisplayNames" in Intl))
                def(Intl, "DisplayNames", { value: fn("DisplayNames"), writable: true, configurable: true, enumerable: false });
            if (!("Segmenter" in Intl))
                def(Intl, "Segmenter", { value: fn("Segmenter"), writable: true, configurable: true, enumerable: false });
            if (!("supportedValuesOf" in Intl))
                def(Intl, "supportedValuesOf", { value: fn("supportedValuesOf"), writable: true, configurable: true, enumerable: false });
        }

        // --- features: jsFeaturesKeys parity ---
        def(Math, "sumPrecise", { value: fn("sumPrecise"), writable: true, configurable: true, enumerable: true });
        def(Date.prototype, "toTemporalInstant", { value: fn("toTemporalInstant"), writable: true, configurable: true, enumerable: true });
        def(Map.prototype, "getOrInsert", { value: fn("getOrInsert"), writable: true, configurable: true, enumerable: true });
        def(Map.prototype, "getOrInsertComputed", { value: fn("getOrInsertComputed"), writable: true, configurable: true, enumerable: true });
        def(WeakMap.prototype, "getOrInsert", { value: fn("getOrInsert"), writable: true, configurable: true, enumerable: true });
        def(WeakMap.prototype, "getOrInsertComputed", { value: fn("getOrInsertComputed"), writable: true, configurable: true, enumerable: true });
        def(WebAssembly, "compileStreaming", { value: fn("compileStreaming"), writable: true, configurable: true, enumerable: true });
        def(WebAssembly, "instantiateStreaming", { value: fn("instantiateStreaming"), writable: true, configurable: true, enumerable: true });
        def(Document, "parseHTMLUnsafe", { value: fn("parseHTMLUnsafe"), writable: true, configurable: true, enumerable: true });
        def(Document, "parseHTML", { value: fn("parseHTML"), writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "xmlEncoding", { get: function () { return null; }, configurable: true, enumerable: true });
        def(Document.prototype, "xmlVersion", { get: function () { return null; }, configurable: true, enumerable: true });
        def(Document.prototype, "xmlStandalone", { get: function () { return null; }, configurable: true, enumerable: true });
        def(Document.prototype, "lastModified", { get: function () { return null; }, configurable: true, enumerable: true });
        def(Document.prototype, "dir", { get: function () { return null; }, configurable: true, enumerable: true });
        def(Document.prototype, "body", { get: function () { return null; }, configurable: true, enumerable: true });
        def(Document.prototype, "head", { get: function () { return null; }, configurable: true, enumerable: true });
        def(Document.prototype, "images", { get: function () { return null; }, configurable: true, enumerable: true });
        def(Document.prototype, "embeds", { get: function () { return null; }, configurable: true, enumerable: true });
        def(Document.prototype, "plugins", { get: function () { return null; }, configurable: true, enumerable: true });
        def(Document.prototype, "links", { get: function () { return null; }, configurable: true, enumerable: true });
        def(Document.prototype, "forms", { get: function () { return null; }, configurable: true, enumerable: true });
        def(Document.prototype, "scripts", { get: function () { return null; }, configurable: true, enumerable: true });
        def(Document.prototype, "currentScript", { get: function () { return null; }, configurable: true, enumerable: true });
        def(Document.prototype, "designMode", { get: function () { return null; }, configurable: true, enumerable: true });
        def(Document.prototype, "onreadystatechange", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "anchors", { get: function () { return null; }, configurable: true, enumerable: true });
        def(Document.prototype, "applets", { get: function () { return null; }, configurable: true, enumerable: true });
        def(Document.prototype, "fgColor", { get: function () { return null; }, configurable: true, enumerable: true });
        def(Document.prototype, "linkColor", { get: function () { return null; }, configurable: true, enumerable: true });
        def(Document.prototype, "vlinkColor", { get: function () { return null; }, configurable: true, enumerable: true });
        def(Document.prototype, "alinkColor", { get: function () { return null; }, configurable: true, enumerable: true });
        def(Document.prototype, "bgColor", { get: function () { return null; }, configurable: true, enumerable: true });
        def(Document.prototype, "all", { get: function () { return null; }, configurable: true, enumerable: true });
        def(Document.prototype, "onpointerlockchange", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "onpointerlockerror", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "wasDiscarded", { get: function () { return null; }, configurable: true, enumerable: true });
        def(Document.prototype, "featurePolicy", { get: function () { return null; }, configurable: true, enumerable: true });
        def(Document.prototype, "webkitVisibilityState", { get: function () { return null; }, configurable: true, enumerable: true });
        def(Document.prototype, "webkitHidden", { get: function () { return null; }, configurable: true, enumerable: true });
        def(Document.prototype, "onbeforecopy", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "onbeforecut", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "onbeforepaste", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "onfreeze", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "onprerenderingchange", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "onresume", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "onsearch", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "onvisibilitychange", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "fullscreenEnabled", { get: function () { return null; }, configurable: true, enumerable: true });
        def(Document.prototype, "fullscreen", { get: function () { return null; }, configurable: true, enumerable: true });
        def(Document.prototype, "onfullscreenchange", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "onfullscreenerror", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "webkitIsFullScreen", { value: fn("webkitIsFullScreen"), writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "webkitCurrentFullScreenElement", { value: fn("webkitCurrentFullScreenElement"), writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "webkitFullscreenEnabled", { value: fn("webkitFullscreenEnabled"), writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "webkitFullscreenElement", { value: fn("webkitFullscreenElement"), writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "onwebkitfullscreenchange", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "onwebkitfullscreenerror", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "rootElement", { get: function () { return null; }, configurable: true, enumerable: true });
        def(Document.prototype, "pictureInPictureEnabled", { get: function () { return null; }, configurable: true, enumerable: true });
        def(Document.prototype, "onabort", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "onbeforeinput", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "onbeforetoggle", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "onblur", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "oncancel", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "oncanplay", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "oncanplaythrough", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "onchange", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "onclick", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "onclose", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "oncommand", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "oncontentvisibilityautostatechange", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "oncontextmenu", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "oncuechange", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "ondblclick", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "ondrag", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "ondragend", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "ondragenter", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "ondragleave", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "ondragover", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "ondragstart", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "ondrop", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "ondurationchange", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "onemptied", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "onended", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "onerror", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "onfocus", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "oninput", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "oninvalid", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "onkeydown", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "onkeypress", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "onkeyup", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "onload", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "onloadeddata", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "onloadedmetadata", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "onloadstart", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "onmousedown", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "onmouseenter", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "onmouseleave", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "onmousemove", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "onmouseout", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "onmouseover", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "onmouseup", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "onmousewheel", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "onpause", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "onplay", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "onplaying", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "onprogress", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "onratechange", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "onreset", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "onresize", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "onscroll", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "onseeked", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "onseeking", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "onselect", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "onstalled", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "onsubmit", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "onsuspend", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "ontimeupdate", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "ontoggle", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "onvolumechange", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "onwaiting", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "onwheel", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "onauxclick", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "ongotpointercapture", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "onlostpointercapture", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "onpointerdown", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "onpointermove", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "onpointerup", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "onpointercancel", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "onpointerover", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "onpointerout", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "onpointerenter", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "onpointerleave", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "onselectstart", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "onanimationcancel", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "oncopy", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "oncut", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "onpaste", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "pointerLockElement", { get: function () { return null; }, configurable: true, enumerable: true });
        def(Document.prototype, "fullscreenElement", { get: function () { return null; }, configurable: true, enumerable: true });
        def(Document.prototype, "pictureInPictureElement", { get: function () { return null; }, configurable: true, enumerable: true });
        def(Document.prototype, "captureEvents", { value: fn("captureEvents"), writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "caretPositionFromPoint", { value: fn("caretPositionFromPoint"), writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "caretRangeFromPoint", { value: fn("caretRangeFromPoint"), writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "clear", { value: fn("clear"), writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "createExpression", { value: fn("createExpression"), writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "createNSResolver", { value: fn("createNSResolver"), writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "evaluate", { value: fn("evaluate"), writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "execCommand", { value: fn("execCommand"), writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "exitFullscreen", { value: fn("exitFullscreen"), writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "exitPictureInPicture", { value: fn("exitPictureInPicture"), writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "exitPointerLock", { value: fn("exitPointerLock"), writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "hasStorageAccess", { value: fn("hasStorageAccess"), writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "hasUnpartitionedCookieAccess", { value: fn("hasUnpartitionedCookieAccess"), writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "moveBefore", { value: fn("moveBefore"), writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "queryCommandEnabled", { value: fn("queryCommandEnabled"), writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "queryCommandIndeterm", { value: fn("queryCommandIndeterm"), writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "queryCommandState", { value: fn("queryCommandState"), writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "queryCommandSupported", { value: fn("queryCommandSupported"), writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "queryCommandValue", { value: fn("queryCommandValue"), writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "releaseEvents", { value: fn("releaseEvents"), writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "requestStorageAccess", { value: fn("requestStorageAccess"), writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "requestStorageAccessFor", { value: fn("requestStorageAccessFor"), writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "webkitCancelFullScreen", { value: fn("webkitCancelFullScreen"), writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "webkitExitFullscreen", { value: fn("webkitExitFullscreen"), writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "browsingTopics", { value: fn("browsingTopics"), writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "hasPrivateToken", { value: fn("hasPrivateToken"), writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "hasRedemptionRecord", { value: fn("hasRedemptionRecord"), writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "activeViewTransition", { get: function () { return null; }, configurable: true, enumerable: true });
        def(Document.prototype, "onscrollsnapchange", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "onscrollsnapchanging", { value: null, writable: true, configurable: true, enumerable: true });
        def(Document.prototype, "customElementRegistry", { get: function () { return null; }, configurable: true, enumerable: true });
        def(Document.prototype, "ariaNotify", { value: fn("ariaNotify"), writable: true, configurable: true, enumerable: true });
        def(Element.prototype, "onbeforecopy", { value: null, writable: true, configurable: true, enumerable: true });
        def(Element.prototype, "onbeforecut", { value: null, writable: true, configurable: true, enumerable: true });
        def(Element.prototype, "onbeforepaste", { value: null, writable: true, configurable: true, enumerable: true });
        def(Element.prototype, "onsearch", { value: null, writable: true, configurable: true, enumerable: true });
        def(Element.prototype, "onfullscreenchange", { value: null, writable: true, configurable: true, enumerable: true });
        def(Element.prototype, "onfullscreenerror", { value: null, writable: true, configurable: true, enumerable: true });
        def(Element.prototype, "onwebkitfullscreenchange", { value: null, writable: true, configurable: true, enumerable: true });
        def(Element.prototype, "onwebkitfullscreenerror", { value: null, writable: true, configurable: true, enumerable: true });
        def(Element.prototype, "computedStyleMap", { value: fn("computedStyleMap"), writable: true, configurable: true, enumerable: true });
        def(Element.prototype, "getAttributeNodeNS", { value: fn("getAttributeNodeNS"), writable: true, configurable: true, enumerable: true });
        def(Element.prototype, "getHTML", { value: fn("getHTML"), writable: true, configurable: true, enumerable: true });
        def(Element.prototype, "hasAttributeNS", { value: fn("hasAttributeNS"), writable: true, configurable: true, enumerable: true });
        def(Element.prototype, "hasPointerCapture", { value: fn("hasPointerCapture"), writable: true, configurable: true, enumerable: true });
        def(Element.prototype, "moveBefore", { value: fn("moveBefore"), writable: true, configurable: true, enumerable: true });
        def(Element.prototype, "releasePointerCapture", { value: fn("releasePointerCapture"), writable: true, configurable: true, enumerable: true });
        def(Element.prototype, "removeAttributeNS", { value: fn("removeAttributeNS"), writable: true, configurable: true, enumerable: true });
        def(Element.prototype, "requestFullscreen", { value: fn("requestFullscreen"), writable: true, configurable: true, enumerable: true });
        def(Element.prototype, "requestPointerLock", { value: fn("requestPointerLock"), writable: true, configurable: true, enumerable: true });
        def(Element.prototype, "scroll", { value: fn("scroll"), writable: true, configurable: true, enumerable: true });
        def(Element.prototype, "scrollBy", { value: fn("scrollBy"), writable: true, configurable: true, enumerable: true });
        def(Element.prototype, "scrollTo", { value: fn("scrollTo"), writable: true, configurable: true, enumerable: true });
        def(Element.prototype, "setAttributeNodeNS", { value: fn("setAttributeNodeNS"), writable: true, configurable: true, enumerable: true });
        def(Element.prototype, "setHTMLUnsafe", { value: fn("setHTMLUnsafe"), writable: true, configurable: true, enumerable: true });
        def(Element.prototype, "setPointerCapture", { value: fn("setPointerCapture"), writable: true, configurable: true, enumerable: true });
        def(Element.prototype, "webkitMatchesSelector", { value: fn("webkitMatchesSelector"), writable: true, configurable: true, enumerable: true });
        def(Element.prototype, "webkitRequestFullScreen", { value: fn("webkitRequestFullScreen"), writable: true, configurable: true, enumerable: true });
        def(Element.prototype, "webkitRequestFullscreen", { value: fn("webkitRequestFullscreen"), writable: true, configurable: true, enumerable: true });
        def(Element.prototype, "currentCSSZoom", { get: function () { return null; }, configurable: true, enumerable: true });
        def(Element.prototype, "customElementRegistry", { get: function () { return null; }, configurable: true, enumerable: true });
        def(Element.prototype, "activeViewTransition", { get: function () { return null; }, configurable: true, enumerable: true });
        def(Element.prototype, "ariaControlsElements", { get: function () { return null; }, configurable: true, enumerable: true });
        def(Element.prototype, "ariaDetailsElements", { get: function () { return null; }, configurable: true, enumerable: true });
        def(Element.prototype, "ariaErrorMessageElements", { get: function () { return null; }, configurable: true, enumerable: true });
        def(Element.prototype, "ariaFlowToElements", { get: function () { return null; }, configurable: true, enumerable: true });
        def(Element.prototype, "ariaLabelledByElements", { get: function () { return null; }, configurable: true, enumerable: true });
        def(Element.prototype, "ariaNotify", { value: fn("ariaNotify"), writable: true, configurable: true, enumerable: true });
        def(Element.prototype, "pseudo", { get: function () { return null; }, configurable: true, enumerable: true });
        def(Element.prototype, "setHTML", { value: fn("setHTML"), writable: true, configurable: true, enumerable: true });
        def(Element.prototype, "startViewTransition", { value: fn("startViewTransition"), writable: true, configurable: true, enumerable: true });
        (function () {
            var move = ["innerText","dir","dataset","style","offsetTop","offsetLeft","offsetWidth","offsetHeight","focus","blur"];
            for (var i = 0; i < move.length; i++) {
                var key = move[i];
                var desc = Object.getOwnPropertyDescriptor(Element.prototype, key);
                if (!desc) continue;
                if (!Object.prototype.hasOwnProperty.call(HTMLElement.prototype, key)) {
                    Object.defineProperty(HTMLElement.prototype, key, desc);
                }
                if (desc.configurable) delete Element.prototype[key];
            }
        })();
    } catch (e) {}
})();