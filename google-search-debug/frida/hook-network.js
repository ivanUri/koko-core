/**
 * Frida — TLS write hook in Chrome network process (ja3/debug only).
 *
 * Attach to "Google Chrome Helper" network service process, NOT renderer.
 *
 *   frida -n "Google Chrome Helper" -l google-search-debug/frida/hook-network.js
 */
"use strict";

const SSL_write = Module.findExportByName(null, "SSL_write")
    || Module.findExportByName("libboringssl.dylib", "SSL_write");

if (SSL_write) {
    let count = 0;
    Interceptor.attach(SSL_write, {
        onEnter(args) {
            count += 1;
            if (count <= 20 || count % 50 === 0) {
                const len = args[2].toInt32();
                console.log(JSON.stringify({
                    t: Date.now(),
                    type: "SSL_write",
                    detail: `n=${count} len=${len}`,
                }));
            }
        },
    });
    console.log(JSON.stringify({ t: Date.now(), type: "frida", detail: "hook-network SSL_write ready" }));
} else {
    console.log(JSON.stringify({ t: Date.now(), type: "frida", detail: "SSL_write not found" }));
}