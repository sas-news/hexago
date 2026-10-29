#!/usr/bin/env node
/**
 * A/B match + behaviour metrics: engine A (path) vs engine B (path), equal budget.
 * Page-mirroring rules via bench/lib/rules.js (pass end + dead-stone cleanup scoring).
 *
 *   node dev/ab-match.js --a dev/ai-engine-v1.2.0.bak.js --b dev/ai-engine.js \
 *        --budget 150 --games 60 --shard 0 --shards 1
 *
 * Prints one JSON line starting with "#SHARD_JSON " for aggregation.
 */
'use strict';
const path = require('path');
const rules = require('../bench/lib/rules.js');

const args = process.argv.slice(2);
function opt(name, def) { const i = args.indexOf('--' + name); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def; }
function optn(name, def) { return +opt(name, def); }

const APATH = path.resolve(__dirname, '..', opt('a', 'dev/ai-engine.js'));
const BPATH = path.resolve(__dirname, '..', opt('b', 'dev/ai-engine.js'));
const A = require(APATH);
const EOPTS = process.env.ENGINE_OPTS_B ? JSON.parse(process.env.ENGINE_OPTS_B) : {};
const B = require(BPATH);
const BUDGET = optn('budget', 150);
const BUDGET_A = optn('budget-a', BUDGET);
const BUDGET_B = optn('budget-b', BUDGET);
const GAMES = optn('games', 60);
const SIZE = optn('size', 9);
const SHARD = optn('shard', 0);
const SHARDS = optn('shards', 1);
const PC = optn('players', 2);
const TAG = opt('tag', 'ab');
const MAXMOVES = optn('maxmoves', 400);
const SEEDBASE = optn('seedbase', 9000001);
const MAXPLAYOUTS = optn('maxplayouts', -1); // >0: equal-compute mode (playouts instead of wall clock)

const R = rules.createRules(SIZE);
const n = R.n;
const geo = R.geo;

function nearestStoneDist(board, i) {
  let best = 99;
  for (let j = 0; j < n; j++) {
    if (board[j]) { const d = geo.dist(i, j); if (d < best) { best = d; if (best === 1) break; } }
  }
  return best === 99 ? -1 : best;
}
function ownEyeBefore(board, i, p) {
  const nb = geo.NB[i];
  if (!nb.length) return false;
  for (let k = 0; k < nb.length; k++) if (board[nb[k]] !== p) return false;
  return true;
}
function regionBorder(board, i) {
  // border colour mask of the empty region containing i (before the move)
  const seen = new Set([i]), q = [i], colors = new Set();
  for (let k = 0; k < q.length; k++) {
    const s = q[k];
    for (const nb of geo.NB[s]) {
      if (board[nb] === 0) { if (!seen.has(nb)) { seen.add(nb); q.push(nb); } }
      else colors.add(board[nb]);
    }
  }
  return { size: q.length, colors: colors };
}
function emptyCount(board) { let c = 0; for (let i = 0; i < n; i++) if (!board[i]) c++; return c; }

function newSideStats() {
  return {
    placements: 0, passes: 0, adjacentOwn: 0, tenuki: 0,
    openingDistSum: 0, openingDistN: 0, openingFar: 0,
    openingSelfAdj: 0, openingIsolated: 0, openingOwnDistSum: 0, openingOwnDistN: 0,
    midN: 0, midSelfAdj: 0,
    ownEyeFills: 0, ownTerrFills: 0, safeNeutral: 0,
    passBuckets: {}, firstPassMove: null, passBefore40: 0,
    playouts: 0, visits: 0, thinkCalls: 0, ms: 0
  };
}

function playGame(gameNo) {
  const st = R.newState(PC);
  const seatForB = PC === 2 ? (gameNo % 2) + 1 : (gameNo % PC) + 1;
  const engines = {}, api = {};
  for (let p = 1; p <= PC; p++) {
    api[p] = (p === seatForB) ? B : A;
    engines[p] = api[p].createEngine(Object.assign({ size: SIZE, playerCount: PC }, p === seatForB ? EOPTS : {}));
  }
  const stA = newSideStats(), stB = newSideStats();
  const side = p => (p === seatForB) ? stB : stA;
  let illegal = 0, crash = null, guard = 0, truncated = false;
  const start = Date.now();
  while (!st.over && guard++ < MAXMOVES) {
    const empty = emptyCount(st.board);
    const seat = st.turn;
    const state = { size: SIZE, playerCount: PC, turn: seat, board: st.board, out: st.out, passes: st.passes, seen: st.seen };
    const t0 = process.hrtime.bigint();
    let res;
    try {
      res = engines[seat].think(state, MAXPLAYOUTS > 0 ? { maxPlayouts: MAXPLAYOUTS, seed: (SEEDBASE + gameNo * 7919 + st.moves * 104729 + seat * 31337) | 0 } : { budgetMs: BUDGET, seed: (SEEDBASE + gameNo * 7919 + st.moves * 104729 + seat * 31337) | 0 });
    } catch (err) { crash = String(err && err.stack || err); break; }
    const t1 = process.hrtime.bigint();
    const ss = side(seat);
    ss.thinkCalls++; ss.ms += Number(t1 - t0) / 1e6;
    if (res && res.playouts) ss.playouts += res.playouts;
    if (res && res.visits) ss.visits += res.visits;
    if (!res || !Number.isInteger(res.move)) { illegal++; if (R.doPass(st)) break; continue; }
    if (res.move === -1) {
      ss.passes++;
      const b = empty <= 3 ? '00-03' : empty <= 6 ? '04-06' : empty <= 12 ? '07-12' : empty <= 24 ? '13-24' : empty <= 36 ? '25-36' : '37+';
      ss.passBuckets[b] = (ss.passBuckets[b] || 0) + 1;
      if (ss.firstPassMove === null) ss.firstPassMove = st.moves;
      if (empty > n * 0.4) ss.passBefore40++;
      if (R.doPass(st)) break;
      continue;
    }
    // behaviour metrics on the placement (before applying)
    const ownColor = seat;
    const ownEye = ownEyeBefore(st.board, res.move, ownColor);
    const reg = regionBorder(st.board, res.move);
    const adj = geo.NB[res.move].some(x => st.board[x] === ownColor);
    const dist = nearestStoneDist(st.board, res.move);
    ss.placements++;
    if (adj) ss.adjacentOwn++; else ss.tenuki++;
    if (ownEye) ss.ownEyeFills++;
    if (reg.colors.size === 1 && reg.colors.has(ownColor)) ss.ownTerrFills++;
    if (reg.colors.size >= 2) ss.safeNeutral++;
    if (st.moves < 20) { ss.openingDistSum += (dist < 0 ? 0 : dist); ss.openingDistN++; if (dist >= 3) ss.openingFar++; }
    let ownDist = 99;
    for (let q = 0; q < n; q++) if (st.board[q] === ownColor) { const d = geo.dist(res.move, q); if (d < ownDist) ownDist = d; }
    if (st.moves < 12) {
      if (adj) ss.openingSelfAdj++;
      const anyAdj = geo.NB[res.move].some(x => st.board[x] !== 0);
      if (!anyAdj) ss.openingIsolated++;
      ss.openingOwnDistSum += ownDist === 99 ? 3 : ownDist;
      ss.openingOwnDistN++;
    } else if (st.moves < 50) {
      ss.midN++;
      if (adj) ss.midSelfAdj++;
    }
    if (!R.applyMove(st, res.move)) { illegal++; if (R.doPass(st)) break; continue; }
  }
  if (!st.over) { st.over = true; truncated = true; }
  const dead = R.detectDeadStones(st);
  const raw = R.scoreState(st, { removeDead: false });
  const st2 = { ...st, board: st.board.slice(), dead: dead.slice() };
  const clean = R.finishByPass(st2);
  if (process.env.AB_VERBOSE) console.error('game ' + gameNo + ' done moves=' + st.moves + ' s=' + Math.round((Date.now() - start) / 1000) + ' trunc=' + truncated);
  return {
    gameNo, seatForB, illegal, crash, truncated, ms: Date.now() - start,
    moves: st.moves, finalEmpty: emptyCount(st.board), dead: dead.length,
    scoreDelta: Math.abs(Math.abs(raw.scores[1] - raw.scores[2]) - Math.abs(clean.scores[1] - clean.scores[2])),
    top: clean.top.slice(), cleanScores: clean.scores.slice(),
    A: stA, B: stB
  };
}

function addStats(acc, s) {
  for (const k of ['placements', 'passes', 'adjacentOwn', 'tenuki', 'openingDistSum', 'openingDistN', 'openingFar', 'openingSelfAdj', 'openingIsolated', 'openingOwnDistSum', 'openingOwnDistN', 'midN', 'midSelfAdj', 'ownEyeFills', 'ownTerrFills', 'safeNeutral', 'passBefore40', 'playouts', 'visits', 'thinkCalls', 'ms']) acc[k] += s[k];
  if (s.firstPassMove !== null) { if (acc.firstPassMove === null || s.firstPassMove < acc.firstPassMove) acc.firstPassMove = s.firstPassMove; }
  for (const b in s.passBuckets) acc.passBuckets[b] = (acc.passBuckets[b] || 0) + s.passBuckets[b];
}

const AGG = { games: 0, aWins: 0, bWins: 0, draws: 0, illegal: 0, crashes: 0, moves: 0, finalEmpty: 0, dead: 0, scoreDelta: 0, a: newSideStats(), b: newSideStats(), seats: {} };
let list = [];
for (let g = SHARD; g < GAMES; g += SHARDS) {
  const r = playGame(g);
  AGG.games++;
  list.push({ gameNo: g, verdict: r.crash ? 'CRASH' : (r.top.includes(r.seatForB) ? (r.top.includes(3 - r.seatForB) ? 'draw' : 'B') : 'A'), ...r });
  if (r.crash) AGG.crashes++;
  AGG.illegal += r.illegal;
  AGG.moves += r.moves; AGG.finalEmpty += r.finalEmpty; AGG.dead += r.dead; AGG.scoreDelta += r.scoreDelta;
  addStats(AGG.a, r.A); addStats(AGG.b, r.B);
  if (!r.crash) {
    const other = PC - r.seatForB + 1;
    const bTop = r.top.includes(r.seatForB), oTop = r.top.includes(r.seatForB === 1 ? 2 : 1);
    if (bTop && !oTop) AGG.bWins++; else if (oTop && !bTop) AGG.aWins++; else AGG.draws++;
  }
}
console.log('#SHARD_JSON ' + JSON.stringify({ tag: TAG, shard: SHARD, shards: SHARDS, games: AGG.games, agg: AGG, list: list }));
