<div align="center">

# Koko Core

### A lightweight browser runtime built for AI agents

**Zig + V8 · Headless execution · CDP · MCP · Browser automation**

[![Sponsor](https://img.shields.io/badge/Sponsor-GitHub%20Sponsors-EA4AAA?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/ivanUri)
[![SDK](https://img.shields.io/badge/TypeScript-Koko%20SDK-3178C6)](https://github.com/ivanUri/koko-sdk)
[![Observatory](https://img.shields.io/badge/Explore-Koko%20Observatory-5B5BD6)](https://github.com/ivanUri/koko-observatory)

</div>

---

Koko is an **AI-first, programmable headless browser runtime** for agents, crawling, testing, and web automation. Instead of wrapping a full Chromium installation, Koko builds a focused execution stack around **Zig, V8, DOM/Web APIs, networking, and automation protocols**.

> **Project status:** Active development. Koko is not a drop-in replacement for Chromium; web compatibility and supported APIs vary by site. Check current behavior before production use.

## Why Koko?

AI-driven workflows often need to navigate pages, execute JavaScript, extract content, and inspect runtime behavior—not render a complete desktop browser. Koko explores a more focused foundation for those workloads:

- **Programmable execution:** CLI, server mode, CDP-compatible control, and MCP-oriented integrations.
- **Runtime ownership:** Explicit browser lifecycle, navigation ordering, execution realms, and teardown.
- **Agent-friendly extraction:** Structured page data and semantic interfaces through the companion SDK.
- **Observability:** Instrumentation and telemetry for understanding browser execution.
- **Performance research:** Reproducible local benchmarks against Chromium, without claiming universal speedups.

## Quick start

### Build from source

The repository currently documents **Zig 0.16.0**, V8, libcurl, and a Rust toolchain for required dependencies. See the build configuration for platform-specific prerequisites.

```bash
git clone https://github.com/ivanUri/koko-core.git
cd koko-core
zig build
```

### Start the CDP-compatible server

```bash
zig build run -- serve --host 127.0.0.1 --port 9222
```

### Fetch a page

```bash
./zig-out/bin/koko fetch https://example.com
```

### macOS / Homebrew

```bash
brew tap ivanUri/tap
brew install koko
koko serve --host 127.0.0.1 --port 9222
```

See [Homebrew notes](docs/homebrew.md) for distribution details.

## Automate with Koko SDK

The [Koko SDK](https://github.com/ivanUri/koko-sdk) provides a TypeScript client for Koko's CDP endpoint.

```ts
import { Browser } from "koko-sdk";

const browser = await Browser.connect("http://127.0.0.1:9222");
const page = await browser.newPage();

await page.goto("https://example.com", { waitUntil: "domcontentloaded" });
console.log(await page.title());
console.log(await page.content());

await browser.close();
```

See the SDK repository for installation, agent APIs, launch profiles, and compatibility caveats.

## Architecture

```text
          AI agents / automation clients
                       |
                 CDP / MCP / CLI
                       |
                 Koko runtime
          lifecycle · network · storage
                       |
             DOM · Web APIs · V8
                       |
                  Zig core
```

Repository structure:

```text
src/
  core/        DOM, parsing, JS bindings, Web APIs
  runtime/     Lifecycle, network, storage, telemetry
  protocols/   CDP and MCP implementations
  adapters/    CLI and server entry points
  public/      Public API surface
  support/     Shared utilities
  testing/     Test infrastructure
knowledge/     Architecture notes and investigations
```

## Performance and reproducibility

Koko includes a local benchmark harness comparing direct CDP runs with Chromium on deterministic fixtures. Workloads include startup-to-first-document, navigation to `DOMContentLoaded`, session lifecycle, and idle process-tree memory.

```bash
zig build benchmark -Doptimize=ReleaseFast -- --quick
zig build benchmark -Doptimize=ReleaseFast -- --suite navigation --iterations 30
zig build benchmark -Doptimize=ReleaseFast -- --baseline all
```

Read [benchmark methodology](bench/README.md) before interpreting results. Performance depends on workload, platform, compatibility requirements, and measurement conditions.

## Current development focus

- Browser lifecycle and navigation correctness
- Realm isolation and execution-context stability
- CDP consistency and MCP integration
- Multi-session execution architecture
- Web API compatibility and agent-oriented extraction
- Test coverage, reproducibility, and runtime observability

## Koko ecosystem

| Project | Role |
| --- | --- |
| [Koko Core](https://github.com/ivanUri/koko-core) | Zig + V8 browser runtime and automation infrastructure |
| [Koko SDK](https://github.com/ivanUri/koko-sdk) | TypeScript automation, extraction, and agent APIs |
| [Koko Observatory](https://github.com/ivanUri/koko-observatory) | Runtime telemetry, network inspection, and execution visualization |

## Contributing

Issues with **minimal reproductions**, compatibility reports, benchmark methodology feedback, and focused pull requests are welcome. Include your OS, Zig version, reproduction steps, and expected/actual behavior.

## License and acknowledgements

See [LICENSE](LICENSE) and [LICENSING.md](LICENSING.md). Koko builds on work from the broader open-source browser and JavaScript engine ecosystem.

---

<div align="center">

**Building browser infrastructure for the AI era.**

[Explore the SDK](https://github.com/ivanUri/koko-sdk) · [Explore Observatory](https://github.com/ivanUri/koko-observatory) · [Sponsor development](https://github.com/sponsors/ivanUri)

</div>
