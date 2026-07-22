# Velora Engineering Knowledge Base

Internal engineering notebook for Velora. This is **not** user documentation or guides.

Every bug fixed, browser behavior understood, GitHub issue investigated, WPT analyzed, or architecture decision made should eventually become a knowledge note here. The long-term goal is a searchable engineering memory for the project.

**Agent rule:** after every important verified fix, create a note here in English. See `.grok/rules/knowledge-on-fix.md`.

## Principles

- Record **why**, not just **what**.
- Explain browser concepts, reasoning, and lessons learned — not only implementation details.
- Notes should remain useful even if the implementation changes later.
- Each article is self-contained. A reader years later should understand the problem without reading the original commit.

## Start here

| Topic | Read first |
|-------|------------|
| Google Search antibot | [`captcha/detection/google-search-investigation-journey.md`](captcha/detection/google-search-investigation-journey.md) |
| WPT cookies | [`bugs/2026-07-08-wpt-cookie-suite.md`](bugs/2026-07-08-wpt-cookie-suite.md) |
| WPT DOM | [`bugs/2026-07-08-wpt-dom-suite.md`](bugs/2026-07-08-wpt-dom-suite.md) |
| WPT fetch | [`bugs/2026-07-fetch-wpt-suite.md`](bugs/2026-07-fetch-wpt-suite.md) |
| WPT workers | [`bugs/2026-07-workers-wpt-suite.md`](bugs/2026-07-workers-wpt-suite.md) |
| WPT URL | [`bugs/2026-07-04-url-wpt-suite.md`](bugs/2026-07-04-url-wpt-suite.md) |
| WPT WebSocket | [`bugs/2026-07-websocket-wpt-suite.md`](bugs/2026-07-websocket-wpt-suite.md) |
| WPT CSS syntax | [`bugs/2026-07-22-wpt-css-syntax-suite.md`](bugs/2026-07-22-wpt-css-syntax-suite.md) |
| Google Sign-In | [`bugs/2026-07-google-signin-suite.md`](bugs/2026-07-google-signin-suite.md) |
| Benchmarks | [`performance/benchmarks/2026-06-benchmark-harness.md`](performance/benchmarks/2026-06-benchmark-harness.md) |

---

## Directory Map

| Area | Path | Topics |
|------|------|--------|
| Browser engine | `browser/` | DOM, CSS, layout, paint, compositing, hit-testing, iframes, navigation, events, scheduler, JS, workers, storage, networking, security |
| Fingerprinting | `fingerprint/` | Canvas, audio, fonts, navigator, screen, WebGL, timing, permissions, cookies, TLS, HTTP |
| Captcha / bot detection | `captcha/` | reCAPTCHA, hCaptcha, Turnstile, Arkose, detection patterns |
| Automation | `automation/` | Input, mouse, keyboard, touch, scrolling, screenshots, CDP, AI agents |
| Performance | `performance/` | Rendering, memory, profiling, benchmarks |
| Research | `research/` | GitHub repos, papers, browser notes, experiments |
| Bugs | `bugs/` | Significant bug post-mortems and WPT suite articles |
| Blog drafts | `blog/` | Polished notes that may become public articles |

## WPT suite articles (`bugs/`)

Consolidated blog-length post-mortems — one file per WPT area. Short per-file stubs were merged into these:

- `2026-07-08-wpt-cookie-suite.md`
- `2026-07-08-wpt-dom-suite.md`
- `2026-07-fetch-wpt-suite.md`
- `2026-07-workers-wpt-suite.md`
- `2026-07-04-url-wpt-suite.md`
- `2026-07-websocket-wpt-suite.md`
- `2026-07-22-wpt-css-syntax-suite.md`
- `2026-07-google-signin-suite.md`

Standalone (not merged): `2026-07-05-wpt-async-error-handling-batch.md`, `2026-07-07-iframe-unload-visibilitychange-lifecycle.md`.

## Writing a Note

Copy `_template.md` into the appropriate directory. Name files descriptively:

- Bugs: `YYYY-MM-DD-short-description.md` (e.g. `2026-06-28-recursive-hit-testing.md`)
- WPT area suites: `YYYY-MM-topic-wpt-suite.md` when many small fixes share one harness
- Research: `source-topic.md` (e.g. `research/github/ladybird-hit-testing.md`)
- General topics: `topic-name.md`

## Workflow

```
Bug / discovery
      ↓
Knowledge note (this directory) — write at blog length immediately
      ↓
Edit / polish for `blog/` if needed (usually light trim only)
      ↓
Public blog post
```

Knowledge is the **canonical draft**. Do not write a short note and expand later — write the full post here first using `_template.md`.

## Style (blog-post length)

Each knowledge article is written to become **one public blog page** later. Stubs are not acceptable.

| Article type | Target words | Sections |
|--------------|-------------:|----------|
| Bug post-mortem | 900–1,500 | Full `_template.md` |
| WPT suite | 900–1,500 | Summary, problem, root cause, solution table, lessons |
| Fingerprint / parity | 900–1,200 | Full template + probe commands |
| Investigation / architecture | 1,800–2,500 | Phases OK if Summary + Lessons are strong |
| Benchmark / ops | 1,200–1,800 | Full template + reproduction |

- Prefer **diagrams** (mermaid), **tables**, and **command blocks** over code dumps.
- Record reasoning, trade-offs, and **failed hypotheses** — not only the winning fix.
- English only (per agent rule).
- Every article ends with **Related Knowledge** links to peers in this tree.

## Probing discipline

- CDP probes: `node scripts/cdp-profile-probe.mjs --profile <id> --max-sec 20`
- WPT: one stable velora + `scripts/wpt-run.sh` per file
- Google Search: warmed profile cookie jar — see investigation journey

## Questions This Should Answer

- How does hit testing work?
- How are nested iframes handled?
- Why does pointer capture behave this way?
- How is fingerprint consistency maintained?
- Why was a certain architecture chosen?
- Which browser projects inspired this implementation?