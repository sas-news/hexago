# Design: `createEngine`-compatible WASM engine (contingency)

This document is the "if we ever do it" plan requested by the task.  It is
**not implemented**: the measured same-algorithm speedup is 1.39–1.53x
(< 2x target), so the recommendation is to stop at the prototype and take the
pure-JS optimisation in `patches/ai-engine-scan-opt.patch` instead.  Keep this
as the scoping document if priorities change.

## 1. Target API (must stay wire-compatible with `dev/ai-engine.js`)

```js
createEngine({ size, playerCount }) -> engine
engine.think(state, options) -> result   // spec in dev/ENGINE_SPEC.md §2
```

`state` is flat data (`board`, `turn`, `playerCount`, `out`, `passes`,
`seen`), `options` is `{ budgetMs, maxPlayouts, seed, resignThreshold }`,
`result` is `{ move, visits, playouts, winrate, value, bestMoves, elapsedMs,
engine }`.  The wasm engine should present exactly this JS facade so the Lead
integration and `bench/` keep working.

## 2. Port vs keep in JS

| layer | where | why |
|---|---|---|
| board, group/liberty scans, move simulation, captures, ko | **WASM** | 100 % hot, no strings/objects, already prototyped |
| playout policy (candidate build, tactical capture/save scan, self-atari, own-eye) | **WASM** | ~92 % of engine runtime |
| terminal scoring / territory BFS, scoreBoardInto | **WASM** | touched every playout |
| MCTS tree, UCT select/expand, AMAF, outcome mapping | **WASM** | object-free flat arrays; ~8 % of current JS runtime but avoids the JS object churn |
| root move generation, root ordering, pattern score / opening priors, no-useful/pass logic | **WASM** (single call per `think`) | called once per move, negligible either way |
| dead-stone cleanup, resign decision | keep in **JS** | cold path, rule-visible; easier to test against page code |
| worker protocol, time budget scheduling, progress messages | **JS** | no DOM/timers in freestanding wasm; JS owns wall clock |
| superko hash set (`state.seen`) | **JS-owned storage, passed to WASM** | `seen` is a JS array; copy into wasm memory per `think` and implement cyrb53 in wasm (already done, f64 return) for root legality |
| fallback engine | existing JS | if wasm fetch/instantiate fails |

Expected gain: the wasm playout/tree work is ~92 % of runtime and measures
1.4x faster for identical code, so plan for **1.4–1.6x overall** (~9–10k
playouts/s on 61 points vs 6.6k today), *not* 2x, unless combined with the
algorithmic work below.

## 3. Module layout and memory

```
hexago-engine.wasm         (expected 25–45 KB with tree+pattern code)
  memory                   linear memory, no imports except `env.now_ms`
  hg_geom(size)            build geometry once per engine instance
  hg_apply_state(ptr,len)  bulk copy: board, turn, out, passes, seen hashes, ko
  hg_think(budget_ms,poll) run UCT until budget/poll; fill result struct
  hg_result_ptr()          header + bestMoves array in wasm memory
```

- **Flat tree nodes** in one growable typed array (structure-of-arrays):
  `move u16, parent i32, firstChild i32, nextSibling i32, visits u32,
  winSum f32, raveN/u32, raveW/f32, depth u16, passes u8, ko i16`.
  Bound memory (e.g. 256k nodes) and fall back to "stop search" when full.
- **Board/scratch arrays** static, as in the prototype; no allocator needed
  for playouts.  A tiny bump allocator only for the tree / seen set.
- **RootMoves**: `options.rootMoves` (if the final API keeps it) is copied in
  as a constrained child list; otherwise root legal moves are generated in
  wasm (page-exact: capture-superko check needs `seen`, already available).
- **Time budget**: JS passes a `budget_ms`; wasm imports `env.now_ms()` (JS
  returns `performance.now()`), checks the clock every ~256 playouts (not every
  playout) and returns early.  `maxPlayouts` and `seed` are copied in, so
  `think` stays deterministic for tests.  JS verifies the returned
  `elapsedMs` and never trusts wasm for wall-clock decisions.
- **Tree reuse**: keep the Node arena alive in the engine instance; on each
  `think` verify the incoming position is reachable from the stored root
  (same board hash/ko/passes) before reusing, else reset.  This is the same
  contract the JS engine already offers.

## 4. Root-rules parity

- Legality at the root must be page-exact: occupied, suicide, simple ko, and
  **capture-superko** (`cap.length > 0 && seen.has(hash(resultingBoard))`).
  cyrb53 is already implemented in wasm and verified against
  `ai-engine.hashBoard`; `seen` hashes are copied in per `think`.
- Passing and multi-player handling are unchanged; terminal evaluation is the
  existing per-player `score - max(others)` mapping, done in wasm from the
  same score arrays.

## 5. Loading from `index.html` / GitHub Pages

- **Preferred: separate `hexago-engine.wasm`** next to `index.html`, fetched
  with `fetch(new URL('hexago-engine.wasm', location.href))` and instantiated
  with `WebAssembly.instantiateStreaming` (fallback `instantiate`).  GitHub
  Pages serves the correct `application/wasm` type and caches it.  The 7
  workers each fetch once (browser cache) and instantiate their own instance
  (0.01 ms for the 9 KB prototype).
- **Alternative: base64-inline** if the single-file property must be kept.
  Prototype wasm is 9,177 B → 12,236 B base64; a full engine at 30 KB becomes
  ~40 KB of base64, acceptable inside `index.html`.  Decode via `atob` +
  `Uint8Array`, or `fetch('data:application/wasm;base64,' + s)`.
- **No SharedArrayBuffer**: COOP/COEP headers are required for SAB, and GitHub
  Pages cannot set them.  Keep the existing 7 independent workers; a
  cross-worker transposition table is not possible on GH Pages.
- Fallback: if the fetch/instantiate/`WebAssembly` check fails, keep using
  the current JS engine (`dev/ai-engine.js` inlined), so nothing regresses.

## 6. Effort estimate

| step | effort |
|---|---|
| JS↔wasm bridge, state/result copy, clock import, worker wiring, fallback | 1 day |
| port geometry/scans/sim/playout policy from `src/hexago.c` + tactical scan | 1–2 days |
| flat MCTS tree (UCT/RAVE), root ordering, pattern priors, tree reuse | 2–3 days |
| parity tests vs `index.html`/`dev/ai-engine.js`, strength self-play tuning, perf tuning | 1–2 days |
| **total** | **5–8 days** |

Expected outcome: ~1.4–1.6x playout speed (≈9–10k pps on 61 pt).  To reach 2x+
this must be combined with algorithmic work (incremental group/liberty
tracking to remove flood fills, which is language-agnostic) — and that work
should be prototyped in JS first because the engine self-test already gives a
fast feedback loop.  Not recommended while the JS-only patch is unmerged and
untested in the page.
