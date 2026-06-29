# Velora Engineering Knowledge Base

Internal engineering notebook for Velora. This is **not** user documentation or guides.

Every bug fixed, browser behavior understood, GitHub issue investigated, WPT analyzed, or architecture decision made should eventually become a knowledge note here. The long-term goal is a searchable engineering memory for the project.

**Agent rule:** after every important verified fix, create a note here in English. See `.grok/rules/knowledge-on-fix.md`.

## Principles

- Record **why**, not just **what**.
- Explain browser concepts, reasoning, and lessons learned — not only implementation details.
- Notes should remain useful even if the implementation changes later.
- Each article is self-contained. A reader years later should understand the problem without reading the original commit.

## Start here (Google Search)

If you are debugging Velora + Google Search, read **one file first**:

- [`captcha/detection/google-search-investigation-journey.md`](captcha/detection/google-search-investigation-journey.md) — thought → test → realize narrative; **warmup cookie jar** is the primary fix.

Older Google notes (`bootstrap-divergence`, `signal-inventory`, `flow-architecture`) describe long-path symptoms and wire diffs; they are **superseded as root-cause stories** but kept for reference.

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
| Bugs | `bugs/` | Significant bug post-mortems |
| Blog drafts | `blog/` | Polished notes that may become public articles |

## Writing a Note

Copy `_template.md` into the appropriate directory. Name files descriptively:

- Bugs: `YYYY-MM-DD-short-description.md` (e.g. `2026-06-28-recursive-hit-testing.md`)
- Research: `source-topic.md` (e.g. `research/github/ladybird-hit-testing.md`)
- General topics: `topic-name.md`

## Workflow

```
Bug / discovery
      ↓
Knowledge note (this directory)
      ↓
Engineering summary
      ↓
Public blog (`blog/`)
```

Knowledge is written first. Blog posts are generated from knowledge notes later.

## Style

- Concise engineering language.
- Prefer diagrams and explanations over code dumps.
- Record reasoning, trade-offs, and failed ideas.
- Document discoveries, not opinions.

## Questions This Should Answer

- How does hit testing work?
- How are nested iframes handled?
- Why does pointer capture behave this way?
- How is fingerprint consistency maintained?
- Why was a certain architecture chosen?
- Which browser projects inspired this implementation?