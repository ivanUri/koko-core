# WPT SPA workflow (scientific runner)

Tooling lives in the WPT tree (not Koko `scripts/`):

**`/Users/huydev/Desktop/wpt-spa-tests/koko-probe/`**

See `koko-probe/README.md` for skip rules, cause taxonomy, and commands.

```bash
cd /Users/huydev/Desktop/wpt-spa-tests
./koko-probe/preflight.sh
python3 koko-probe/inventory.py --all
python3 koko-probe/run.py --suite url --batch-size 25
# triage:
open results/runs/*/FAILURES.md
```

Design goals: no wasted re-runs (state keyed by test+koko_sha), JSONL truth, every failure has `cause_class`.
