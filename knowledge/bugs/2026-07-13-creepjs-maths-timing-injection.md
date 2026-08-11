# CreepJS maths section: V8 native callback at context creation

## Summary

CreepJS reported `maths.lied` and nine `chrome: false` math probes on Koko even with a correct Chrome maths baseline. V8/libm returns different IEEE-754 bits than Chrome on nine edge-case inputs. A temporary JS injection into `creep.js` source fixed timing but failed lie detection architecture. The durable fix installs V8 native `Math.*` callbacks when each JS context is created, before any page script runs.

## Root cause

1. CreepJS `getMaths()` compares probe results with `==` (bit-exact) against the Chrome column.
2. Koko's V8/libm stack mismatches Chrome on nine inputs (e.g. `cos(13*Math.E)`, `pow(Math.PI,-100)`).
3. A JS hook installed after `lieProps` capture worked for values but was architecturally wrong (script-source patching, non-native `toString`).
4. Installing at `Env.createContext` is early enough for `getMaths()` and uses `[native code]` callbacks that pass CreepJS `lieProps` for `Math.*`.

## Fix

- `MathsNative.installOnContext`: for antidetect profiles with a non-empty `maths_baseline`, replace each baseline `Math[method]` with a V8 native callback.
- Baseline args stored as `[]const f64` at profile load (no `args_json` roundtrip — `{d}` formatting broke large-magnitude cases and prevented whole-method install).
- Lookup match with `1e-12` tolerance and `-0`/`NaN` semantics; fall back to the persisted original native implementation.
- Functions created via `v8__FunctionTemplate__New__Config` + `GetFunction` with `kConstructorBehavior_Throw`, correct `length`, and `ReadOnlyPrototype` so CreepJS `lieProps` sees only `length,name` and `[native code]` (plain `Function::New` exposed `prototype` and failed `maths.lied`).
- Wired in `Env._createContext` for frame and worker contexts (workers use the owning frame's profile).
- Baseline: `browser/templates/assets/chrome-local-huys-macbook-pro-maths-baseline.json` (102 Chrome column values).

## Verify

```bash
cd /Users/huydev/Desktop/koko
zig build
# CDP probe against https://abrahamjuliot.github.io/creepjs/
# Expect: maths.lied=false, badCount=0, totalLies=0
```

## Files

- `src/runtime/profile/MathsNative.zig` — native callback install
- `src/core/js/Env.zig` — `installOnContext` at context creation
- `src/runtime/profile/ProfileStore.zig` — `maths_baseline` entry type

## Reverted

- `MathsIntelligent.patchCreepJsSource` / creep.js source injection
- `ScriptManagerBase.isCreepJsScript` pre-eval patch
- `ScriptManager.tailHook` JS eval install