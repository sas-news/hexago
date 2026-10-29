/* ------------------------------------------------------------------ *
 * Rule-parity / legality / scoring unit tests for the WASM prototype.
 *
 * Reference implementation is a direct port of index.html play()/sim()/
 * territory()/hash() semantics (see dev/ENGINE_SPEC.md §1), independent of
 * both the C code and js-baseline.mjs.  We also cross-check geometry and
 * hash against dev/ai-engine.js.
 *
 * Run: node dev/wasm/test.mjs
 * ------------------------------------------------------------------ */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadWasm } from './wasm-loader.mjs';
import { JSBaseline } from './js-baseline.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const AI = require(join(HERE, '..', 'ai-engine.js'));

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) { pass++; return true; }
  fail++; failures.push(name + (detail ? ' :: ' + detail : ''));
  return false;
}
function eq(a, b, name, detail) { return ok(a === b, name, `${JSON.stringify(a)} !== ${JSON.stringify(b)}${detail ? ' ' + detail : ''}`); }

/* ---------------- reference rules (port of index.html) ---------------- */
const GEO = new Map();
function geo(size) {
  if (!GEO.has(size)) GEO.set(size, AI.geometry(size));
  return GEO.get(size);
}
function group(b, i, NB) {
  const c = b[i], seen = new Set([i]), q = [i];
  while (q.length) {
    const x = q.pop();
    for (const n of NB[x]) if (b[n] === c && !seen.has(n)) { seen.add(n); q.push(n); }
  }
  return [...seen];
}
function libCount(b, g, NB) {
  const s = new Set();
  for (const x of g) for (const n of NB[x]) if (!b[n]) s.add(n);
  return s.size;
}
function cyrb53(a) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < a.length; i++) {
    h1 = Math.imul(h1 ^ a[i], 2654435761);
    h2 = Math.imul(h2 ^ a[i], 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}
/* page sim() with the superko membership set supplied by the caller */
function refSim(board, i, p, size, seenHashes = new Set()) {
  const NB = geo(size).NB;
  if (board[i]) return null;
  const a = Int8Array.from(board);
  a[i] = p;
  const cap = [], done = new Set();
  for (const n of NB[i]) {
    if (!a[n] || a[n] === p || done.has(n)) continue;
    const g = group(a, n, NB);
    g.forEach((x) => done.add(x));
    if (!libCount(a, g, NB)) cap.push(...g);
  }
  for (const x of cap) a[x] = 0;
  if (!libCount(a, group(a, i, NB), NB)) return null; // suicide
  if (cap.length && seenHashes.has(cyrb53(a))) return null; // superko
  return { board: a, captures: cap };
}
function refScore(board, pc, size) {
  const NB = geo(size).NB;
  const out = new Array(pc + 1).fill(0);
  for (const v of board) if (v > 0 && v <= pc) out[v]++;
  const vis = new Set();
  for (let i = 0; i < board.length; i++) {
    if (board[i] || vis.has(i)) continue;
    const reg = [i], cols = new Set();
    vis.add(i);
    for (let k = 0; k < reg.length; k++) {
      for (const n of NB[reg[k]]) {
        if (!board[n]) { if (!vis.has(n)) { vis.add(n); reg.push(n); } }
        else cols.add(board[n]);
      }
    }
    if (cols.size === 1) out[[...cols][0]] += reg.length;
  }
  return out;
}
let geoSize_ = 0;
function geoSize(board) { return geoSize_; }

/* ---------------- helpers ---------------- */
function resetWasm(w, size, board) {
  w.init(size);
  w.clear();
  for (let i = 0; i < board.length; i++) if (board[i]) w.set(i, board[i]);
}
function readWasmBoard(w) { return Array.from(w.view().board); }

function neighborsOf(size, i) { return geo(size).NB[i]; }

function makeRandomBoard(size, rng, fill = 0.5) {
  const n = geo(size).n, b = new Int8Array(n);
  for (let i = 0; i < n; i++) b[i] = rng() < fill ? (rng() < 0.5 ? 1 : 2) : 0;
  return b;
}

const w = await loadWasm();

/* ================= 1. geometry / hash parity with ai-engine.js ================= */
for (const size of [9, 13, 19, 25]) {
  geoSize_ = size;
  const g = AI.geometry(size);
  const n = w.init(size);
  eq(n, g.n, `geometry n size ${size}`);
  const v = w.view();
  let nbOk = true, offOk = true;
  for (let i = 0; i <= n; i++) if (v.nbOff[i] !== g.nbOff[i]) { offOk = false; break; }
  for (let j = 0; j < g.nbFlat.length; j++) if (v.nbFlat[j] !== g.nbFlat[j]) { nbOk = false; break; }
  ok(offOk, `nbOff parity size ${size}`);
  ok(nbOk, `nbFlat parity size ${size}`);
}
{
  /* hash parity on random boards, all sizes */
  const rng = (() => { let a = 12345; return () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; }; })();
  let allOk = true;
  for (const size of [9, 13, 19, 25]) {
    geoSize_ = size;
    const n = geo(size).n;
    w.init(size);
    for (let t = 0; t < 5; t++) {
      const b = makeRandomBoard(size, rng, 0.4);
      w.clear();
      for (let i = 0; i < n; i++) if (b[i]) w.set(i, b[i]);
      const ref = AI.hashBoard(b);
      const got = w.hash();
      if (ref !== got) { allOk = false; failures.push(`hash size ${size}: ${ref} !== ${got}`); break; }
    }
  }
  ok(allOk, 'hash parity with ai-engine.hashBoard (random boards, sizes 9/13/19/25)');
}

/* ================= 2. hand-built legality / scoring cases ================= */
const S9 = 9, N9 = geo(S9).n;
geoSize_ = S9;

/* 2a. every empty point is legal on an empty board */
{
  const empty = new Int8Array(N9);
  resetWasm(w, S9, empty);
  let bad = [];
  for (let i = 0; i < N9; i++) if (!w.legal(i, 1, -1)) bad.push(i);
  ok(bad.length === 0, 'empty-board: all 61 moves legal for black', bad.join(','));
  resetWasm(w, S9, empty);
  bad = [];
  for (let i = 0; i < N9; i++) if (!w.legal(i, 2, -1)) bad.push(i);
  ok(bad.length === 0, 'empty-board: all 61 moves legal for white', bad.join(','));
}

/* 2b. occupied point is illegal */
{
  const b = new Int8Array(N9);
  const i = aiCenter(S9);
  b[i] = 1;
  resetWasm(w, S9, b);
  eq(w.legal(i, 2, -1), false, 'occupied point is illegal');
  eq(w.play(i, 2, -1), -1, 'hg_play on occupied point returns -1');
}
function aiCenter(size) { return geo(size).center; }

/* 2c. simple capture (white stone surrounded by black except one liberty) */
{
  const i = aiCenter(S9);
  const nb = neighborsOf(S9, i);
  const b = new Int8Array(N9);
  b[i] = 2; // white
  for (let k = 1; k < nb.length; k++) b[nb[k]] = 1; // black on 5 of 6 neighbours
  const lib = nb[0];
  const ref = refSim(b, lib, 1, S9);
  resetWasm(w, S9, b);
  const cap = w.play(lib, 1, -1);
  ok(ref !== null, 'capture case reference is legal');
  eq(cap, 1, 'simple capture: 1 stone captured');
  const expected = Array.from(ref.board);
  ok(JSON.stringify(readWasmBoard(w)) === JSON.stringify(expected), 'simple capture: board matches page rules');
  eq(w.lastKo(), i, 'simple capture: ko point is the captured stone');
}
/* 2d. suicide (isolated point fully surrounded by enemy) */
{
  const i = aiCenter(S9);
  const nb = neighborsOf(S9, i);
  const b = new Int8Array(N9);
  for (const k of nb) b[k] = 1; // all neighbours black
  resetWasm(w, S9, b);
  eq(refSim(b, i, 2, S9), null, 'suicide: reference says illegal');
  eq(w.legal(i, 2, -1), false, 'suicide: wasm says illegal');
}
/* 2e. capture that would otherwise be suicide is legal (snapback-ish) */
{
  const i = aiCenter(S9);
  const nb = neighborsOf(S9, i);
  const b = new Int8Array(N9);
  for (const k of nb) b[k] = 2; // all neighbours white
  /* make one white neighbour group have only `i` as liberty: surround nb[0] with black except i */
  const target = nb[0];
  for (const t of neighborsOf(S9, target)) if (t !== i) b[t] = 1;
  resetWasm(w, S9, b);
  const ref = refSim(b, i, 1, S9);
  ok(ref !== null, 'capture-vs-suicide: reference legal');
  if (ref) {
    const cap = w.play(i, 1, -1);
    eq(cap, ref.captures.length, 'capture-vs-suicide: capture count matches');
    eq(JSON.stringify(readWasmBoard(w)), JSON.stringify(Array.from(ref.board)),
      'capture-vs-suicide: board matches page rules');
  }
}
/* 2f. simple ko: immediate recapture is rejected when ko point is set */
{
  const i = aiCenter(S9);
  const nb = neighborsOf(S9, i);
  const b = new Int8Array(N9);
  b[i] = 2;
  for (let k = 1; k < nb.length; k++) b[nb[k]] = 1;
  const lib = nb[0];
  resetWasm(w, S9, b);
  eq(w.legal(lib, 2, -1), true, 'ko: recapture legal when no ko restriction');
  resetWasm(w, S9, b);
  eq(w.legal(lib, 2, lib), false, 'ko: immediate recapture at ko point is rejected');
}
/* 2g. scoring parity on hand-built positions */
{
  /* ring around centre -> 1 point of territory for player 1 */
  const i = aiCenter(S9);
  const b = new Int8Array(N9);
  for (const k of neighborsOf(S9, i)) b[k] = 1;
  resetWasm(w, S9, b);
  const got = w.score(2);
  const ref = refScore(b, 2, S9);
  eq(JSON.stringify(got), JSON.stringify(ref), 'score: single eye territory matches page territory()');

  /* random boards: territory + stones parity */
  const rng = (() => { let a = 999; return () => { a = (a * 1103515245 + 12345) >>> 0; return a / 4294967296; }; })();
  let allOk = true;
  for (let t = 0; t < 30; t++) {
    const rb = makeRandomBoard(S9, rng, 0.55);
    resetWasm(w, S9, rb);
    const gSc = w.score(2);
    const rSc = refScore(rb, 2, S9);
    if (JSON.stringify(gSc) !== JSON.stringify(rSc)) {
      allOk = false;
      failures.push(`score random board ${t}: wasm=${gSc} ref=${rSc}`);
      break;
    }
  }
  ok(allOk, 'score: territory+stones parity on 30 random 61-point boards');
}

/* ================= 3. legality fuzz vs page sim() ================= */
{
  const rng = (() => { let a = 20260101; return () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; }; })();
  let checked = 0, bad = 0;
  for (let t = 0; t < 80; t++) {
    const board = makeRandomBoard(S9, rng, 0.45);
    const turn = 1 + ((rng() * 2) | 0);
    for (let mv = 0; mv < N9; mv++) {
      const ref = refSim(board, mv, turn, S9);
      resetWasm(w, S9, board);
      const legal = w.legal(mv, turn, -1);
      const cap = legal ? w.play(mv, turn, -1) : -1;
      checked++;
      if ((ref !== null) !== legal) {
        bad++;
        if (bad <= 5) failures.push(`legality fuzz pos ${t} move ${mv}: wasm=${legal} ref=${ref !== null}`);
        continue;
      }
      if (ref) {
        if (cap !== ref.captures.length) {
          bad++;
          if (bad <= 5) failures.push(`capture-count fuzz pos ${t} move ${mv}: wasm=${cap} ref=${ref.captures.length}`);
        }
        const gotBoard = readWasmBoard(w);
        for (let k = 0; k < N9; k++) {
          if (gotBoard[k] !== ref.board[k]) {
            bad++;
            if (bad <= 5) failures.push(`board fuzz pos ${t} move ${mv}: differs at ${k}`);
            break;
          }
        }
        if (w.lastKo() !== (ref.captures.length === 1 ? ref.captures[0] : -1)) {
          bad++;
          if (bad <= 5) failures.push(`ko fuzz pos ${t} move ${mv}: wasm=${w.lastKo()}`);
        }
      }
    }
  }
  ok(bad === 0, `legality/capture/board fuzz vs page sim(): ${checked} move checks`, failures.slice(-5).join(' | '));
}

/* ================= 4. deterministic playout parity C vs JS twin ================= */
{
  const js = new JSBaseline(S9);
  let allOk = true;
  for (const policy of [0, 1]) {
    for (const seed of [1, 2, 3, 7, 42, 123456]) {
      w.init(S9);
      const wc = w.playoutOnce(seed, policy);
      const wMoves = w.lastMoves();
      const wScore = w.lastScores().join(',');
      const jc = js.playoutOnce(seed, policy);
      const jMoves = js.lastMoves;
      const jScore = js.lastScores.slice(0, 3).join(',');
      if (wc !== jc || wMoves !== jMoves || wScore !== jScore) {
        allOk = false;
        failures.push(`playout parity policy ${policy} seed ${seed}: C=${wc}/${wMoves}/${wScore} JS=${jc}/${jMoves}/${jScore}`);
        break;
      }
    }
    if (!allOk) break;
  }
  ok(allOk, 'playout determinism: C and JS twin produce identical scores/move counts (policy 0/1, 6 seeds)');

  /* batch checksum parity */
  w.init(S9);
  const wBatch = w.bench(50, 777, 1);
  const jBatch = js.bench(50, 777, 1);
  eq(wBatch, jBatch, 'batch checksum parity: C vs JS twin (50 playouts, policy 1, seed 777)');
}

/* ================= 5. wasm sanity ================= */
{
  const bytes = w.bytes.length;
  ok(bytes < 64 * 1024, `wasm binary size ${bytes} bytes (<64KB, inlineable)`);
}

/* ---------------- report ---------------- */
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('ALL TESTS PASSED');
