# Google Search document header order parity (Chrome 150)

## Summary

Koko Google Search document navigations now emit **Chrome 150 Accept-first** request header order on both cold hop-1 and in-session `sei=` hops. Wire capture (`KOKO_WIRE_HEADERS`) matches live Chrome CDP `requestWillBeSentExtraInfo` name order (LCS 24/24 hop-1, 29/29 sei).

## Before

- Hop-1 used curl-impersonate **chrome146 Sec-CH-first** defaults + cold supplements (`Cache-Control`/`Pragma`/`Downlink`/`RTT`, `Sec-Fetch-Site: same-origin` via synthetic `priorOrigin`).
- In-session hops **omitted all** `Sec-Fetch-*` and **omitted cookies**; RTT was 100; Accept-Encoding included `dcb,dcz`.

## After

| Hop | Order / values |
|-----|----------------|
| hop-1 | Accept → AE (`gzip, deflate, br, zstd`) → AL → Priority → color-scheme → Sec-CH (cold: no Form-Factors/Full-Version) → Sec-Fetch Dest/Mode/Site:**none**/User → UIR → UA → X-Browser |
| sei | Accept → AE → AL → **Cookie** → Downlink 1.7 → Priority → Referer → RTT **50** → full CH → Sec-Fetch Dest/Mode/Site:**same-origin** (**no User**) → UIR → UA → X-Browser |

## Policy (`browser/policies/google-search.json`)

- `curlDefaultsOnly: never` — full manual document headers
- `omitCookies: never` — Chrome sends cookies on sei
- `omitSecFetchUser: in_session` — only User omitted; Dest/Mode/Site kept
- `priorOrigin` applied **only in-session** (hop-1 stays Site:none)

## Code

- `HttpProfile.zig` — Chrome 150 document list; cold vs in-session CH sets
- `Frame.zig` — document nav always `appendChromeHeaders`
- `HttpClient.zig` — curl default_headers off for documents; Cookie insert after Accept-Language
- `NavigationPlanner.zig` — priorOrigin only when `in_session`

## Remaining (intentional / out of scope)

- `X-Client-Data` — Chrome variation cookie; not spoofed
- Brand strings / UA major may still be profile 149 vs host Chrome 150
- `/sorry` tier still driven by cookies/IP (Layer 0/1), not header order alone

## Verify

```bash
KOKO_WIRE_HEADERS=1 KOKO_WIRE_HEADERS_FILE=/tmp/wire.ndjson \
  # serve + navigate google.com/search, inspect headerOrder per hop
```
