# Frida — Google Search debug

Optional native hooks when CDP inject is not enough.

## Prerequisites

```bash
pip install frida-tools
# or: brew install frida
```

## Workflow

1. Start Chrome with CDP:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222
```

2. Open `https://www.google.com/search?q=test` in a tab.

3. Find renderer process:

```bash
ps aux | grep "Google Chrome Helper (Renderer)"
```

Or list tabs:

```bash
node google-search-debug/scripts/get-renderer-pid.mjs --url-contains google.com/search
```

4. Attach Frida (renderer — fingerprint APIs):

```bash
frida -p <RENDERER_PID> -l google-search-debug/frida/hook-renderer.js
```

5. Optional — network process (TLS):

```bash
ps aux | grep "Google Chrome Helper"
frida -p <NETWORK_PID> -l google-search-debug/frida/hook-network.js
```

Output is JSON lines on stdout. Redirect:

```bash
frida -p <PID> -l google-search-debug/frida/hook-renderer.js \
  2>/dev/null | tee google-search-debug/tmp/frida-$(date +%s).jsonl
```

## macOS notes

- Signed Chrome may restrict injection on some builds; use user-installed Chrome stable.
- Hooks use 5s cooldown per event type to reduce noise.
- Prefer CDP `inject-fingerprint.js` first; Frida confirms native paths CDP misses.