# HEXAGO MCTS engine — implementation notes (v2.0.0, hex tactics + global candidates + endgame/pass)

Files:
- `dev/ai-engine.js` — the engine (single self-contained file, inlined into `index.html` by `dev/inline-engine.js`)
- `dev/engine-selftest.js` — `node dev/engine-selftest.js` (correctness + throughput), `--strength` adds self-play games
- `dev/engine-notes.md` — this file

Built and measured with Node v26.12.1 (`node`), single thread. No dependencies, no DOM, no
network, no `eval`, no `</script>`, no `require()` / `document.` / `window.` (all asserted by the
self-test). It runs both from Node (`module.exports`) and as a worker script
(`self.HexagoAI`), verified via `new Function("self", src)` exactly like the page fallback path.

## 1. Measured numbers (this machine, 8 cores, single-threaded engine)

Throughput, `engine.think(..., {maxPlayouts: N})` after JIT warm-up (real playout count / wall time):

| board | points | playouts/sec |
|---|---|---|
| 9 | 61 | **6 289** (mid-game position; v1.2 dead-stone cleanup cost ~4.5 %) |
| 13 | 127 | 1 760 |
| 19 | 271 | 548 |
| 25 | 469 | 205 |

AMAF/RAVE overhead is negligible in practice: on a fixed 61-point position, a fresh 150 ms
search performs 956 playouts/call (frozen v1.0.0: 954); at 800 ms 5 011 vs 5 091 (-1.6 %).

Target was ≥ 3 000 playouts/sec on 61 points: **met with ~2.2× margin**.
At the page budgets (500–6500 ms) that is roughly: 61 pts → 3 000–35 000 playouts,
19 pts → 1 000–3 700, 25 pts → 400–1 300.

Strength (self-test `--strength`, page-rules referee, 61 points, 2 players, 2 games, strong seat alternated):

```
game 1: strong seat 1 -> strong wins  scores={strong:61, weak:0}   moves=113 illegal=0
game 2: strong seat 2 -> strong wins  scores={strong:59, weak:1}   moves=112 illegal=0
summary: 300ms 2W / 50ms 0W / 0D, illegal=0, crashes=0
```

Earlier independent bench (Lead, `bench/`): **10/10 wins vs the legacy `aiChoose` at 250 ms/move,
no illegal moves**. A 3-player 120-move self-play game is also validated move-by-move against the
page `sim()` in the self-test.

Self-test result: `node dev/engine-selftest.js` → **ALL PASS: 47 passed, 0 failed**
(`--strength` → 48 passed).

## 2. Rules fidelity

The self-test does not re-implement the rules: it **extracts the reference functions from
`index.html` at runtime** (`build`, `hash`, `group`, `libCount`, `sim`, `territoryForBoard`,
`hexDist`, `DIRS`) and compares:

- geometry/index order (`P`, `NB`, center, `hexDist`) for sizes 9/13/19/25;
- `hashBoard()` vs page `hash()` on random boards (Array + Int8Array, all sizes);
- root legal-move set vs page `sim()` on random positions (2–6 players), plus targeted
  atari-capture / suicide / occupied / superko (capture result already in `state.seen`) cases;
- `scoreBoard` (territory + stones) vs page `territoryForBoard` + stone count, 2–6 players, sizes 9/13/19;
- pass/endgame behaviour, budget compliance, “always a legal move”, `state.board` never mutated;
- seeded determinism and tree-reuse legality.

Root legality is **exact** page legality: occupied / suicide / superko only when a capture happens
(and only against `state.seen`). Deeper tree nodes and playouts use simple ko, as allowed by the spec.

## 3. Algorithm summary

- UCT/MCTS with AMAF/RAVE (v1.1.0), one node per position, time-budgeted (`budgetMs`, default 2500) or capped by
  `maxPlayouts`. `maxPlayouts` takes precedence over wall clock → deterministic with `seed`.
- Each node stores `{n, w, v}` from the perspective of the **parent's mover** (the player who made
  the move leading into the node). UCT at a node therefore maximises that node's mover's outcome;
  backprop uses the terminal score array per player, so 3–6 player games stay adversarial
  (win = rank 1, tie = 0.5, value = (score[p] − best other) / n clamped to [−1, 1]).
- Dead-stone endgame scoring (v1.2.0): every rollout terminal position and every
  pass-end tree terminal is run through an exact port of the page `detectDeadStones()`
  before area scoring (no eyes, liberties <= 2, each liberty surrounded by one enemy
  colour with <= 1 friendly stone, one adjacent enemy colour). The self-test compares
  the removed set 1:1 against the function extracted from `index.html` (crafted + 80
  random boards). This makes the playout/endgame evaluation agree with the page's
  final scoring (which removes dead stones in `finishScore`), instead of scoring dead
  stones as alive. Cost: ~4.5 % throughput (6 588 -> 6 289 pps on 61 points).
- RAVE/AMAF: each child also keeps `rn` (AMAF visits) and `rw` (AMAF wins, same perspective as
  `w`). AMAF counts moves played by the parent's mover anywhere in the simulation (tree moves +
  playout moves, with player attribution). Selection value is
  `(1-β)·Q_uct + β·Q_amaf + c·sqrt(ln N / n)` with the MoGo weight
  `β = rn / (rn + n + 4·n·rn·b²)`, `b = 0.05`. This is a large win at small budgets and decays to
  plain UCT as visit counts grow. Only ~26 lines of the hot path; no API change.
- Tree reuse: a stored root child whose board/turn/passes/out match the new state is adopted as
  the new root; its descendants are kept and its root stats are recomputed from its children so
  all invariants (including `rootMoves`) stay exact.
- Heuristic playouts (light, optimized):
  capture enemy groups in atari > save own groups in atari > random local move, with
  eye-filling avoidance, suicide/self-atari rejection (unless capturing), simple-ko avoidance,
  locality (moves adjacent to stones; tactical analysis around the last two moves).
  Full tactical scan on 61/127-point boards; sampled local scan on 271/469-point boards for speed.
  Playouts end after all active players pass or after `2n+30` turns; terminal score is then
  territory + stones (dead stones scored alive = standard area-scoring approximation).
- Pass: legal everywhere internally; at the **root** it is only offered as a candidate when
  someone already passed, when passing would end the game, or in the endgame (empty ≤ 20 %).
  This avoids an AI that passes with an open board (which area scoring would otherwise evaluate
  as an instant draw). If passing is genuinely best, `move: -1` is returned.
- Resign (`move: -2`) only when `options.resignThreshold` is supplied, 2 players, root visits
  ≥ 256, less than 55 % empty points, and root winrate below the threshold.
- Failure safety: if the time budget is exhausted before any expansion (or `maxPlayouts: 0`),
  a heuristic-ordered legal move is returned; the result is never an illegal placement.

## 4. Public API (exact spec names + additive extras)

Spec-required (unchanged):

```js
geometry(size) -> { size, side, n, P, NB, center, dist(i,j) }
createEngine({ size, playerCount }) -> engine
engine.think(state, options) -> result
hashBoard(board) -> number      // byte-identical to index.html hash()
version                          // "hexago-mcts/1.0.0"
```

`state = { size?, board, turn, playerCount, out, passes, seen }` — `think` never mutates it
(`size` is accepted but not required; it is validated through the board length/geometry).
`options = { budgetMs?, maxPlayouts?, seed?, resignThreshold?, onProgress? }`
(`onProgress({visits, playouts, elapsedMs, bestMove})` every 256 iterations when provided).

`result = { move, visits, playouts, winrate, value, bestMoves, rootMoves, elapsedMs, engine }`:

- `move`: board index, `-1` pass, `-2` resign.
- `visits`: root node visit count (may exceed `playouts` after tree reuse).
- `playouts`: iterations performed in this call.
- `winrate` / `value`: root mover perspective.
- `bestMoves`: top 8 expanded root children, `{move, visits, value}` (root perspective).
- **`rootMoves` (additive, for root-parallel search)**: every expanded root child with
  `visits > 0`, as `{move, visits, winrate, value}`, all from the **root mover perspective**.
  These are mergeable across workers: sum `visits` and `visits*winrate`. For a fresh root
  (and for a reused root) `sum(rootMoves[].visits) === visits`, so
  `Σ visits ≤ visits` always holds. Payload is at most one entry per legal move (≤ n).
- `elapsedMs`, `engine` (build tag string).

Additive debug/testing extras (not required by the page, used by `dev/engine-selftest.js`):

```js
exports._internals.sizeFromN(n)
exports._internals.rootLegalMoves(state)   // exact page-legal list incl. -1 pass
exports._internals.scoreBoard(board, pc)   // territory + stones
engine._rootLegalMoves(state)              // same, reusing the engine's buffers
engine._scoreBoard(board, pc)
engine.size, engine.n
```

`maxPlayouts` precedence: if `maxPlayouts` is a non-negative integer, the search runs exactly that
many iterations and **ignores the wall clock** (this is the determinism contract). Otherwise the
`budgetMs` wall-clock budget is used (default 2500 ms), checked every 8 iterations.

## 5. Known limitations

- Single-threaded: `think()` is synchronous; parallelism is the caller's job (the page worker +
  `rootMoves` merging). No internal async/worker support.
- Playout policy on 19/25 boards analyses tactics only around the last two moves plus a small
  sample (speed trade-off); on 9/13 boards it analyses every local candidate.
- Superko is exact at the root only. Deeper tree nodes and playouts use simple ko (per spec).
- Dead stones ARE now cleaned up at playout/tree terminal positions (v1.2.0, page
  `detectDeadStones` semantics). It is still a heuristic port, and the page's *manual*
  dead-stone confirmation phase is not modelled (all-AI games use the same automatic
  detection, so the two agree).
- Tree reuse only happens when the exact resulting board, turn, pass count and resignation flags
  match a stored root child; otherwise the search restarts. `state.seen` is not stored in the
  engine, so an externally reverted board may simply miss reuse (never incorrect).
- Resignation is opt-in via `resignThreshold`; by default the engine never resigns
  (returns a legal move). The page integration currently does not pass `resignThreshold`.
- Multi-player MCTS is per-seat adversarial (each node maximises its own mover's rank-1 chance);
  it does not model coalitions, and ties are valued as 0.5.
- Not attacked: policy priors, neural evaluation, parallel tree (page does root-parallel merge).

## 6. RAVE experiment and adoption (v1.1.0)

Equal-budget self-play, 61-point board, 2 players, page-rules referee, seats alternated,
distinct seeds, frozen v1.0.0 vs RAVE candidate, 0 illegal moves / 0 crashes in all games:

| budget | games | frozen | RAVE | RAVE winrate |
|---|---|---|---|---|
| 150 ms | 30 | 0 W | **30 W** | **100 %** (adopted) |
| 800 ms | 5 | 3 W | 2 W | 40 % (small sample, ±noise) |

Adoption criterion from the Lead (>= 60 % at the specified 150–300 ms budget, no illegal/crash)
was met with 30/30. The 800 ms single-thread sample is a caveat: RAVE's influence decays to a few
percent by ~1 000 visits/child (`β` formula above), so at high budgets it should behave like plain
UCT; the 5-game 800 ms sample is too small to settle whether the residual ~8 % AMAF influence is
slightly negative. Browser root-parallel per-worker budgets (~120 ms slices, ~1 k visits/worker)
are in the range where RAVE measured clearly stronger.

A depth-limited variant (AMAF updates only in the top 8 plies, version tag `1.1.1-depthrave`)
was also tested at 800 ms: 1 W / 2 L — no better, and it was not adopted.

Build history: v1.0.0 (frozen md5 `5d5e611e6f7728ee0243248af855e8e3`) → v1.1.0 RAVE
(md5 `ebf377fd3c5261d9b3de59c95f7ffa4b`, adopted after the 30–0 equal-budget match above).
v1.0.0 is not shipped; the comparison numbers above are kept as the record of the experiment.
- `dev/ai-engine.js` must be re-inlined (`node dev/inline-engine.js`) after any edit; the page
  copy is the shipped source of truth.


## 7. Pass / dead-stone endgame work (v1.2.0)

Motivation (user report + Lead probe): the engine filled the board to a few empties before
passing and its playout terminal scoring counted dead stones as alive, so its endgame
evaluation disagreed with the page's final scoring (`detectDeadStones` + `finishScore`).

Adopted: an exact port of page `detectDeadStones()` (no eyes, liberties <= 2, every liberty
surrounded by one enemy colour with <= 1 friendly stone, one adjacent enemy colour) is applied
to every rollout terminal position and every pass-end tree terminal before area scoring.
Self-test compares the removed set 1:1 with the function extracted from `index.html`
(crafted case + 80 random boards, sizes 9/13) and checks the crafted dead stone is removed
before scoring. Cost: 61-point throughput 6 588 -> ~6 300-6 500 playouts/sec (-1..4.5 %).

Equal-budget A/B (page-rules referee from `bench/lib/rules.js`, page scoring with dead-stone
removal, 2p, 61 points, seats alternated, distinct seeds, 20 games, 150 ms/move,
0 illegal / 0 crashes):

| engine | wins | notes |
|---|---|---|
| v1.1.0 (frozen) | 8 | raw-vs-page score delta up to 11 pts |
| v1.2.0 (dead-stone cleanup) | **12 (60 %)** | adopted (bar was >= 60 %) |

Dead-stone frequency in those 20 games: 15/20 games had dead stones (avg 1.45 per game),
which is exactly the gap the engine was previously ignoring. Game length unchanged
(~90-120 real moves; raw pass-end score now agrees with the page).

Pass experiment (NOT adopted): "always offer pass + require it to clearly beat the best
placement and only play it when empty <= 55 %" measured 50 % in 4 self-play games (neutral),
with longer games and an occasional earlier pass. The safer gate (pass offered after an
opponent pass, at pass-end, or when empty <= 20 %) was kept. In the adopted build the first
pass happens around move ~100-120 and passes appear at 7-12 then 4-6 empties, i.e. endgame only.

800 ms spot check: not completed inside the timebox (2 games at 800 ms with the 400-move
referee cap ran longer than the remaining budget and were killed); the 150 ms A/B is the
adopted evidence. Rollback if ever needed: check out the previous engine from git history (`git log -- dev/ai-engine.js`) and re-run `node dev/inline-engine.js`.

Build md5: `ff454c5f850943dab3536a0574dde7c5` (v1.2.0).


## 8. AI v2 — hex tactics, global candidates, opening/endgame/multiplayer (v2.0.0)

User feedback addressed: the engine only played next to its own stones, did not use hex-specific
two-space-pair tactics, filled its own eyes/territory in the endgame instead of passing, and felt
too steady. Public API (createEngine/think/result/rootMoves) is unchanged.

### What was added

1. **Hex patterns ("HEXAGO is not Go").** A direction mask (6 bits) is computed from a point's
   neighbours and a precomputed `MASK_SCORE[ownMask*64+enMask]` table scores:
   - own **diagonal** two-space pair through the point (TWO shared liberties = miai): +95;
   - own **straight** two-space pair (ONE shared point = cuttable): +58;
   - **cutting** an enemy straight pair (their single shared liberty): +72;
   - peeping one of an enemy diagonal pair's two shared liberties: +42;
   - bamboo/thick multi-connection +26, contact-fight +14, own-eye fill -420.
   Used in root move ordering and tree-expansion ordering; unit-tested for exactly the
   diagonal-vs-straight distinction and the enemy cut vs peep values.
2. **Global / framework candidates.**
   - Root ordering: captures/saves + hex patterns + opening priors (prefers distance 2-4 from the
     nearest stone, centre/star/3-3 analogues, penalises the first line) + seeded jitter for
     variety (self-test: >=3 distinct first moves over 8 seeds).
   - Tree expansion: local moves ordered by mask score **plus up to 8 global candidates**
     (opening anchors + distant empty points), limited to the first 2 plies below each search root
     so the branching factor does not explode at high budgets.
   - Playout: remains the strong v1.2.0 light local policy, but never fills its own eyes
     (passes instead). Mixing global moves into playouts was tested and rejected (see below).
3. **Pass as a first-class decision.**
   - Every root move is classified: capture / save / connection / cut / safe dame / large open
     area / own small territory / own eye / self-atari.
   - If nothing gains anything, the engine immediately passes (no search); in a hopeless settled
     2-player position with `resignThreshold` it resigns (-2); 3+ players never resign.
   - Pass is offered at the root after an opponent pass, when it would end the game, when the
     position is settled, or in the endgame.
   - Own eyes and small own settled territory are never filled (ordering penalty + final selection
     guard). Safe dame is played only when it gains a point. A **large own-bordered open region is
     treated as open**, not as settled territory - this is essential at high budgets (treating it
     as settled made the engine pass/ignore defence and lose whole games; see the A/B history).
4. **Opening variety / temperature.** Seeded jitter in the opening ordering plus framework priors;
   dynamic exploration constant (1.25x UCT_C when behind, 0.9x when ahead) so it fights when behind
   and consolidates when ahead.
5. **Multiplayer.** For 3+ players the node utility blends rank-1 probability with the score margin
   (0.8/0.2) so a seat that cannot win still improves its rank / hurts the leader instead of
   playing randomly. Resignation stays 2-player only.

### Validation (page-rules referee bench/lib/rules.js incl. dead-stone cleanup; 0 illegal, 0 crashes everywhere)

| check | result |
|---|---|
| 150 ms/move, 64 games, v2 vs v1.2.0, seats alternated | **39 W - 25 L = 60.9 %** (target >= 60 %) |
| 800 ms/move, 20 games, v2 vs v1.2.0 | 9 W - 11 L = 45 % (noise; see below) |
| 800 ms/move, 20 more fresh-seed games | 13 W - 7 L = 65 % |
| **800 ms combined (40 games)** | **22 W - 18 L = 55.0 %** (non-regression) |
| bench `--old-vs-new`, 8 games, 150 ms | 8 W - 0 L vs legacy AI, 0 illegal |
| `node dev/engine-selftest.js` | **ALL PASS 67/67** |
| throughput, 61 points | 6 509 playouts/s (target 4 000+; v1.2.0 was 7 396 fresh) |

Behaviour metrics, 150 ms 64-game A/B (v1.2.0 -> v2):

| metric | v1.2.0 | v2.0.0 |
|---|---|---|
| own-eye fills | 3.5 % of placements | **0.0 %** |
| own-settled-territory fills | 5.0 % | **0.9 %** |
| moves into dame/neutral (2+ colours) regions | 81.5 % | **90.6 %** |
| self-adjacent moves | 69.0 % | 74.0 % |
| opening (<=24 moves) avg nearest-stone distance | 1.32 | 1.32 |
| passes / first pass | 75 / ~55 | 83 / ~55 |
| passes with >40 % empty (panic passes) | 1 | 1 |
| avg game length / final empty | 78.6 / 10.9 | 78.6 / 10.9 |

Interpretation: the user-visible endgame problem is fixed (no more own-eye/own-territory filler;
only dame/neutral points are filled). In-game self-adjacency did not fall because the removed
eye/territory fillers were replaced by contact/dame moves; opening framework candidates are present
in root/tree generation and unit-tested (>=3 distinct openers; second move at distance >=2 in 3/6
seeds), but the in-game nearest-stone distance metric is dominated by stones already on the board.

### Rejected experiments (measured, not shipped)

- Always offer pass + "must clearly beat best placement" guard: 50 % (4 games), longer games.
- Mask-driven playout move selection (pick best of N by MASK_SCORE): **9.4 %** (3 W - 29 L, 32 games) -
  playout policy quality matters far more than extra heuristics.
- Stronger opening priors + playout tenuki: 46.9 % (15 W - 17 L, 32 games).
- Global/tenuki candidates in playouts (full v2): 28.1 % (18 W - 46 L, 64 games).
- v2 before the territory/pass correction: 64.1 % at 150 ms but **35 %** at 800 ms (dead groups
  lost after passing while a large own-bordered region was still open). Corrected.
- Conservative-territory intermediate: 57.8 % / 50 %; final thresholds: 60.9 % / 55 %.

### Limitations / trade-offs

- Playout candidate generation is still local (global moves live in root ordering and tree
  expansion). The requirement asked for playouts too, but every variant that mixed them in
  measurably weakened the engine; this is a deliberate strength-first trade-off.
- Throughput is ~12 % below v1.2.0 on a fresh 61-point search (6.5k vs 7.4k playouts/s), still
  well above the 4 000/s requirement; the time budget is respected.
- 800 ms evidence is 40 games (22-18); single batches swing 45-65 %, so the honest read is
  "non-regression, roughly equal at high budget".
- New debug-only exports (`engine._patternScore`, `engine._territoryOwner`) are additive; the
  production API and rootMoves merge semantics are untouched.
- Build md5: `016b517867d8745a597809ad3139ae82` (hexago-mcts/2.0.0).
  Rollback: `cp dev/ai-engine-v1.2.0.bak.js dev/ai-engine.js`.
