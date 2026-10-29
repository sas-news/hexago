# HEXAGO WASM feasibility spike (`dev/wasm/`)

**Question:** can a WebAssembly port of the AI hot loop give 2–5x playout speed
vs the current JS engine (`dev/ai-engine.js`, ~6,500 playouts/s on 61 points)?

**Answer: no — the measured, same-algorithm speedup is 1.39–1.53x.**  That is
below the 2x bar, so the recommendation is **do not port** (see
[Recommendation](#recommendation)).  The spike did, however, find a **pure-JS,
exact-semantics optimisation worth 1.40x at 61 points and up to 2.3x at
469 points** on the current engine; an integration patch is included in
[`patches/ai-engine-scan-opt.patch`](patches/ai-engine-scan-opt.patch) and
passes the engine's own 67-test self-test.

Everything here is a self-contained spike: no change is made outside
`dev/wasm/`.

---

## 1. Toolchain (checked first)

| tool | status | notes |
|---|---|---|
| `clang` 23.1.3 | ✅ wasm32 codegen | `--target=wasm32` works |
| wasm sysroot / `wasm-ld` / wasi-sdk | ❌ not installed | no libc, no crt |
| `rustc` 1.95 | ⚠️ x86_64-only | `rustup target add wasm32-unknown-unknown` fails: sandboxed `~/.rustup` is read-only (`os error 30`) |
| `rust-lld` (shipped inside the rust toolchain) | ✅ | works as `wasm-ld` when invoked under that name |

So the prototype is **freestanding C**: `clang --target=wasm32 -nostdlib`, linked
with `rust-lld` symlinked as `wasm-ld`.  `build.sh` locates `wasm-ld` in
`PATH`, otherwise finds `rust-lld` under `~/.rustup` and creates the symlink in
`.build/bin/` (git-ignored).  `memset`/`memcpy` are provided in the C file; there
is no allocator (everything is static storage).

Result: a **9,177-byte** wasm module (12,236 bytes base64), instantiation
median **0.01 ms**.

## 2. What the prototype implements

`src/hexago.c` (freestanding C, no libc):

- hex board geometry, **identical point order to `index.html build()`**
  (axial coords, radius = side−1, 61/127/271/469 points for size 9/13/19/25);
- flat neighbour table (`nbOff`/`nbFlat`), same layout as the engine;
- group / liberty flood fill with epoch stamps;
- move simulation: occupied check, capture of adjacent 0-liberty enemy groups,
  suicide, simple ko;
- random playout to an area score (stones + single-colour-bordered empty
  regions, exactly `scoreBoardInto()` semantics), end after 2 consecutive
  passes, max 2·n+30 plies;
- **cyrb53 board hash byte-identical to `index.html hash()`**;
- an exact-semantics fast liberty scan: flood fill stops as soon as it can
  prove "≥1 liberty" (capture check) or "≥2 liberties" (suicide / self-atari
  check).  When a group really has 0 or 1 liberty the scan completes and the
  full stone list is available, so behaviour is unchanged.

Two playout policies are benchmarked, both implemented identically in C and JS:

| policy | description |
|---|---|
| 0 | uniform random over all empty points (the spec's "random playout") |
| 1 | engine-like local random: candidates adjacent to a stone, never fill own eyes, avoid self-atari unless it captures (no tactical capture/save pre-scan) |

`js-baseline.mjs` is a **line-by-line JS twin of the C code**: same typed-array
layout, same RNG (mulberry32), same scan order, same early-exit scan.  The
benchmark asserts both produce **bit-identical score/move-count checksums**
before timing anything, so the measured ratio is a language comparison, not an
algorithm comparison.

## 3. Build & run

```bash
cd dev/wasm
./build.sh                 # compile src/hexago.c -> hexago.wasm (needs clang)
node test.mjs              # rule-parity / legality / determinism tests
node bench.mjs             # benchmark (writes results.json)
node bench.mjs --size 13 --trials 5
node bench.mjs --json
```

`hexago.wasm` is committed so downstream work does not need a C toolchain;
`build.sh` reproduces it.

## 4. Tests (`node test.mjs` → **34 passed, 0 failed**)

Reference implementation: an independent JS port of `index.html`
`sim()`/`group()`/`libCount()`/`territory()`/`hash()` (per
`dev/ENGINE_SPEC.md` §1).  Geometry and hash are additionally cross-checked
against `dev/ai-engine.js`.

- geometry parity (`n`, `nbOff`, `nbFlat`) against `ai-engine.geometry()` for
  sizes 9/13/19/25;
- board-hash parity against `ai-engine.hashBoard()` on random boards;
- hand-built cases: occupied cell, simple capture (+ ko point), suicide,
  capture-that-looks-like-suicide, ko recapture rejection, scoring with eyes;
- scoring parity (territory + stones) on 30 random 61-point boards;
- **legality fuzz**: 80 random 61-point positions × all 61 moves = 4,880 move
  checks against the page's `sim()` — legality, capture count, resulting
  board and ko point all match;
- determinism: C and JS twin produce identical playout score/move-count/board
  for 6 seeds × 2 policies, and identical 50-playout batch checksums.

Known, intentional deviations (same as `ENGINE_SPEC.md` allows for playouts):
no superko inside playouts (simple ko only), dead stones scored alive, no
tactical capture/save pre-scan.

## 5. Benchmark results (Node v26.12.1, 8-core machine, 61-point default board)

Method: warm up, calibrate playout count for ~0.9 s per trial, 3–5 trials,
report best (median in brackets).  JS twin and wasm run the **same number of
playouts with the same seed** and the same algorithm.  `bench.mjs` aborts if
the checksums differ.

### 61 points (default board)

| work | JS twin | WASM | speedup |
|---|---:|---:|---:|
| policy 0 (uniform random) | 55,331/s | 79,230/s | **1.43x** |
| policy 1 (engine-like local) | 24,881/s | 34,593/s | **1.39x** |
| current `dev/ai-engine.js` (anchor, MCTS + heavier tactical policy) | — | — | 6,599/s |

### Other supported board sizes (speedup = WASM / identical JS twin)

| size | points | policy 0 | policy 1 |
|---|---:|---:|---:|
| 9 | 61 | 1.43x | 1.39x |
| 13 | 127 | 1.42x | 1.43x |
| 19 | 271 | 1.47x | 1.50x |
| 25 | 469 | 1.53x | 1.53x |

Raw numbers per size are in `results-size{9,13,19,25}.json`.
The wasm/JS ratio is stable at 1.4–1.5x across board sizes and across light vs
heavier playout policies — it does **not** approach 2x.

## 6. Why the ceiling is ~1.4x, and what an engine-level port would give

From a patched copy of `dev/ai-engine.js` (inside `.build/`, not shipped):

| component | measured |
|---|---:|
| full engine (`think`, 1200 playouts, 61 pt) | 6,766 playouts/s |
| tree/UCT bookkeeping only (playout stubbed out) | ~87,000 playouts/s ⇒ **7.8 % of runtime** |
| playout loop only (implied) | ~7,300 playouts/s ⇒ **~92 % of runtime** |
| dead-stone cleanup at end of playout | ~0 % |

So ~92 % of the engine is exactly the loop the prototype ports, and that loop
only gets ~1.4x faster in wasm.  A faithful full-engine port therefore lands at
**≈ 6.6k × 1.4 ≈ 9.2k playouts/s**, not 2x.  Porting the tree as well cannot
change this (it is <8 % of runtime).  A microbenchmark of a pure integer/array
loop on this machine gives 1.8x wasm/JS, so 1.4x here is close to the practical
scalar ceiling for this workload.

## 7. The more useful finding: the same win is available in JS

The early-exit liberty scan used by the prototype is semantics-preserving and
applies directly to the current engine (`applyMove`, `playApply`, `scanGroup`
in `tacticScan`/`countSavesAt` only ever need 0/1/`>=2` liberties and the
single liberty point).  Applying it to a copy of `dev/ai-engine.js`:

- **All 67 checks of `node dev/engine-selftest.js` pass** (including the ones
  that compare against functions extracted from `index.html`).
- `think()` output is **bit-identical** to the original on 32 cases
  (sizes 9/13 × playerCount 2/3 × random positions × 8 seeds, same
  `maxPlayouts` and seed: same move, visits, playouts, `bestMoves`, winrate).
- Throughput (same self-test):

| board | original | early-exit scan | speedup |
|---|---:|---:|---:|
| 61 pt | 6,509/s | 9,081/s | **1.40x** |
| 127 pt | 1,823/s | 2,595/s | **1.42x** |
| 271 pt | 573/s | 1,082/s | **1.89x** |
| 469 pt | 212/s | 488/s | **2.30x** |

Patch: [`patches/ai-engine-scan-opt.patch`](patches/ai-engine-scan-opt.patch)
(apply with `git apply` from the repo root).  Candidate file used for the
measurements: [`candidate/ai-engine-opt.js`](candidate/ai-engine-opt.js).
This is a ~40-line change, no API/rule/semantics change, and it is worth as
much as the entire wasm port at the default board size — and more on large
boards.

## 8. Loading strategy (if a port is ever done)

- **Size/instantiation are non-issues**: 9 KB wasm, 0.01 ms instantiate,
  1 MB initial memory.  Each of the 7 workers can instantiate its own module.
- **Separate `hexago-engine.wasm` file is preferable** to base64-inlining:
  GitHub Pages serves `.wasm` with caching and the page already loads
  `index.html` only; a relative fetch with a JS-engine fallback is simple.
  Base64 (+33 %, ~12 KB) is viable if the single-file page must stay
  single-file; decode with `fetch('data:application/wasm;base64,...')` or
  `atob` + `Uint8Array`.
- **Shared-memory threads are not usable**: `SharedArrayBuffer` needs
  COOP/COEP headers, which GitHub Pages cannot set.  The 7 existing Workers
  already saturate the cores; wasm threads would add nothing without SAB.
- Keep the current JS engine as fallback (feature-detect
  `WebAssembly.instantiate` + fetch failure).

## 9. Recommendation

1. **Do not build the WASM engine now.**  A faithful port buys ~1.4x
   (≈ 9.2k playouts/s vs 6.6k), well short of the 2x bar, for an estimated
   4–7 engineering days (bridge 1 d, tree/policy port 2–3 d, parity/strength
   tuning 1–2 d) plus a second implementation to maintain in the single-file
   page.
2. **Take the JS win instead**: apply
   `patches/ai-engine-scan-opt.patch` (1.40x at 61 pt, 2.3x at 469 pt, all
   self-tests pass, identical decisions for identical inputs).  This is the
   highest value-per-risk change found by this spike.
3. If 2x+ is still required, the remaining gains must come from
   **algorithm/data-structure work**, not from the language: incremental
   group/liberty tracking (avoid full flood fills), flat-array MCTS nodes,
   and cached pattern scores.  That work is possible in JS first and should be
   prototyped there; wasm could then multiply it by ~1.4x, but the 2x would
   be mostly algorithmic and should be measured in JS before committing to
   wasm.
4. Revisit wasm only if the JS route is exhausted and the measured JS baseline
   has moved close to the wasm-vs-JS ratio's break-even point.

## 10. Files

```
dev/wasm/
  src/hexago.c              freestanding C hot-loop prototype
  build.sh                  clang --target=wasm32 + rust-lld build
  hexago.wasm               committed build artifact (9,177 B)
  wasm-loader.mjs           Node loader / memory views
  js-baseline.mjs           line-by-line JS twin (fair benchmark baseline)
  bench.mjs                 playouts/s benchmark (JS vs wasm + engine anchor)
  test.mjs                  geometry/hash/legality/scoring/determinism tests
  results-size9.json        raw results (also 13/19/25)
  candidate/ai-engine-opt.js    engine + early-exit scan (measurement copy)
  patches/ai-engine-scan-opt.patch  integration patch for dev/ai-engine.js
  DESIGN-wasm-engine.md     createEngine-compatible WASM engine design (if ever)
  .gitignore                ignores .build/
```
