/* ------------------------------------------------------------------ *
 * Benchmark: WASM prototype vs JS twin (same algorithm, same inputs).
 *
 *   node dev/wasm/bench.mjs [--json] [--size 9] [--trials 3]
 *
 * Reports playouts/sec for:
 *   - policy 0: uniform random legal moves over all empty points
 *   - policy 1: engine-like local policy (local candidates, no own eyes,
 *               avoid self-atari unless capture) — closest to the real
 *               dev/ai-engine.js playout without its tactical scan
 * plus the current dev/ai-engine.js throughput (MCTS think() with a fixed
 * playout cap) as an anchor.
 * ------------------------------------------------------------------ */
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { loadWasm } from './wasm-loader.mjs';
import { JSBaseline } from './js-baseline.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const AI = require(join(HERE, '..', 'ai-engine.js'));

const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');
const sizeArg = argv.indexOf('--size');
const SIZE = sizeArg >= 0 ? Number(argv[sizeArg + 1]) : 9;
const trialsArg = argv.indexOf('--trials');
const TRIALS = trialsArg >= 0 ? Number(argv[trialsArg + 1]) : 3;

function timeOnce(fn) {
  const t0 = performance.now();
  const r = fn();
  const t1 = performance.now();
  return { ms: t1 - t0, r };
}
function bestOf(trials) {
  return trials.reduce((a, b) => (b.ms < a.ms ? b : a));
}
function median(trials) {
  const xs = trials.map((t) => t.ms).sort((a, b) => a - b);
  const m = xs.length >> 1;
  return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2;
}
function fmt(n, d = 0) { return n.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d }); }

const wasm = await loadWasm();
const n = wasm.init(SIZE);
const js = new JSBaseline(SIZE);
const results = { size: SIZE, n, wasmBytes: wasm.bytes.length, node: process.version, policies: {} };

if (!JSON_OUT) {
  console.log(`HEXAGO WASM benchmark — board size ${SIZE} (${n} points), node ${process.version}`);
  console.log(`wasm binary: ${wasm.bytes.length} bytes\n`);
}

/* ---- honesty check: same algorithm must give identical checksum ---- */
for (const policy of [0, 1]) {
  wasm.init(SIZE);
  const a = wasm.bench(30, 424242, policy);
  const b = js.bench(30, 424242, policy);
  if (a !== b) {
    throw new Error(`algorithm mismatch JS twin vs wasm (policy ${policy}): ${a} !== ${b}`);
  }
}

/* ---- calibrate: how many playouts for ~1s? ---- */
function calibrate(policy) {
  wasm.init(SIZE);
  const wPilot = timeOnce(() => wasm.bench(300, 1, policy));
  const jsPilot = timeOnce(() => js.bench(300, 1, policy));
  const targetMs = 900;
  const wCount = Math.max(300, Math.round((300 * targetMs) / Math.max(wPilot.ms, 0.001)));
  const jCount = Math.max(300, Math.round((300 * targetMs) / Math.max(jsPilot.ms, 0.001)));
  return { wCount, jCount };
}

const outRows = [];
for (const policy of [0, 1]) {
  const { wCount, jCount } = calibrate(policy);
  /* warmup */
  wasm.init(SIZE);
  wasm.bench(Math.min(200, wCount), 7, policy);
  js.bench(Math.min(200, jCount), 7, policy);

  const wTrials = [], jTrials = [];
  for (let t = 0; t < TRIALS; t++) {
    wasm.init(SIZE);
    wTrials.push({ ...timeOnce(() => wasm.bench(wCount, 1000 + t, policy)), count: wCount });
    jTrials.push({ ...timeOnce(() => js.bench(jCount, 1000 + t, policy)), count: jCount });
  }
  const wBest = bestOf(wTrials), jBest = bestOf(jTrials);
  const wMed = median(wTrials), jMed = median(jTrials);
  const wRate = (wCount / wBest.ms) * 1000;
  const jRate = (jCount / jBest.ms) * 1000;
  const wRateMed = (wCount / wMed) * 1000;
  const jRateMed = (jCount / jMed) * 1000;
  const row = {
    policy,
    wasmPlayouts: wCount,
    jsPlayouts: jCount,
    wasmBestMs: wBest.ms,
    jsBestMs: jBest.ms,
    wasmPlayoutsPerSec: wRate,
    jsPlayoutsPerSec: jRate,
    wasmPlayoutsPerSecMedian: wRateMed,
    jsPlayoutsPerSecMedian: jRateMed,
    speedupBest: wRate / jRate,
    speedupMedian: wRateMed / jRateMed,
    trials: TRIALS,
  };
  results.policies[policy] = row;
  outRows.push(row);
  if (!JSON_OUT) {
    console.log(`policy ${policy}` + (policy === 1 ? ' (engine-like local random)' : ' (uniform random)'));
    console.log(`  JS twin : ${fmt(jRate)} playouts/s  (median ${fmt(jRateMed)})  [${jCount} playouts x ${TRIALS}]`);
    console.log(`  WASM    : ${fmt(wRate)} playouts/s  (median ${fmt(wRateMed)})  [${wCount} playouts x ${TRIALS}]`);
    console.log(`  speedup : ${(wRate / jRate).toFixed(2)}x (best) / ${(wRateMed / jRateMed).toFixed(2)}x (median)\n`);
  }
}

/* ---- anchor: current dev/ai-engine.js MCTS throughput ---- */
const engineAnchor = {};
{
  const maxPlayouts = 1200;
  const runs = [];
  for (let t = 0; t < Math.min(3, TRIALS); t++) {
    const eng = AI.createEngine({ size: SIZE, playerCount: 2, seed: 5 + t });
    const state = {
      board: new Int8Array(n), turn: 1, playerCount: 2,
      out: [false, false, false], passes: 0, seen: [],
    };
    const tr = timeOnce(() => eng.think(state, { maxPlayouts, budgetMs: 60000, seed: 5 + t }));
    runs.push({ ms: tr.ms, playouts: tr.r.playouts, visits: tr.r.visits });
  }
  const best = bestOf(runs);
  const rate = best.playouts / best.ms * 1000;
  engineAnchor.total = { playoutsPerSec: rate, ms: best.ms, playouts: best.playouts, visits: best.visits, maxPlayouts };
  results.engineAnchor = engineAnchor;
  if (!JSON_OUT) {
    console.log(`current dev/ai-engine.js reference (MCTS think(), maxPlayouts=${maxPlayouts}):`);
    console.log(`  ${fmt(rate)} playouts/s (${fmt(best.ms)} ms for ${best.playouts} playouts, ${best.visits} root visits)`);
  }
}
results.timestamp = new Date().toISOString();

if (!JSON_OUT) {
  const p0 = results.policies[0], p1 = results.policies[1];
  console.log(`\n=== SUMMARY (size ${SIZE}, ${n} points) ===`);
  console.log(`  JS twin uniform random      : ${fmt(p0.jsPlayoutsPerSec)} playouts/s`);
  console.log(`  WASM uniform random         : ${fmt(p0.wasmPlayoutsPerSec)} playouts/s  -> ${p0.speedupBest.toFixed(2)}x`);
  console.log(`  JS twin engine-like local   : ${fmt(p1.jsPlayoutsPerSec)} playouts/s`);
  console.log(`  WASM engine-like local      : ${fmt(p1.wasmPlayoutsPerSec)} playouts/s  -> ${p1.speedupBest.toFixed(2)}x`);
  console.log(`  current ai-engine.js MCTS   : ${fmt(engineAnchor.total.playoutsPerSec)} playouts/s (anchor, heavier policy + tree)`);
}

writeFileSync(join(HERE, 'results.json'), JSON.stringify(results, null, 2) + '\n');
if (JSON_OUT) console.log(JSON.stringify(results, null, 2));
