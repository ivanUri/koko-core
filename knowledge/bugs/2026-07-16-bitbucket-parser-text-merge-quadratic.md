# Bitbucket hang — O(n²) HTML parser text merge

> **Audience:** Koko engineers  
> **Date:** 2026-07-16

## Summary

Loading `https://bitbucket.org` (and offline fixtures of its ~1MB HTML) never reached DOMContentLoaded and could balloon to multi-gigabyte RSS. The document contains a ~591KB first `<style>` block. html5ever emits that RAWTEXT as many small `AppendText` chunks; `Frame.appendNew` merged each into the adjacent text node with `String.concat`, which re-allocates `existing + chunk` on the page arena every time. That is O(n²) time and O(n²) unreclaimed arena memory.

The fix keeps a growable heap buffer capacity map (`Frame._parser_text_cap`) during parse and extends text in place with geometric growth (`appendParserAdjacentText`).

## Problem

- **Symptom:** cold navigate to bitbucket.org → navigate OK, HTTP 200, no DCL within harness budgets; process memory spikes or dies.
- **Not the cause:** cookies (`InvalidDomain` for `.atl-paas.net`), network, or deferred-parse scheduling alone.
- **Affected:** any page with multi-hundred-KB inline style/script text tokenized into small chunks.

## Root Cause

```text
html5ever AppendText (small tendrils)
  → Frame.appendNew adjacent Text merge
  → String.concat(arena, existing, txt)   // full realloc every time
  → arena retains all intermediates → O(n²) RSS
```

Style-size series (pre-fix): DCL time scaled roughly with n² up to ~400KB; larger bodies hung or OOM (~10GB RSS on full fixture).

## Fix

- `Frame.appendParserAdjacentText`: SSO via concat for ≤12 bytes; otherwise own a heap buffer with tracked capacity and double on growth; never mutate interned/createTextNode strings on first merge.
- Clear `_parser_text_cap` after parse completes and on nav abort / epoch bump.

## Verification

| Case | After fix |
|------|-----------|
| offline `bb-style-591507.html` | DCL ~0.8s, RSS ~35MB |
| offline full `bb.html` (~1.04MB) | DCL, RSS ~110MB (was ~10GB / kill) |
| live `https://bitbucket.org` | DCL ~4s, RSS ~117MB |

## Related

- Deferred document parse threshold 256KB (`Frame.frameDoneCallback`)
- Mid-parse style/link/img deferral (does not prevent text node merge during html5ever walk)
