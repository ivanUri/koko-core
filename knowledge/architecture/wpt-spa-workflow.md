# WPT SPA workflow (scientific runner)

Tooling lives in the WPT tree (not Velora `scripts/`):

**`/Users/huydev/Desktop/wpt-spa-tests/velora-probe/`**

See `velora-probe/README.md` for skip rules, cause taxonomy, and commands.

```bash
cd /Users/huydev/Desktop/wpt-spa-tests
./velora-probe/preflight.sh
python3 velora-probe/inventory.py --all
python3 velora-probe/run.py --suite url --batch-size 25
# triage:
open results/runs/*/FAILURES.md
```

Design goals: no wasted re-runs (state keyed by test+velora_sha), JSONL truth, every failure has `cause_class`.
