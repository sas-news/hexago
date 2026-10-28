#!/usr/bin/env node
'use strict';
/**
 * HEXAGO benchmark harness (Node only, no dependencies).
 *
 *   node bench/bench.js --old-vs-random --games 40 --size 9 --players 2 --seed 1
 *   node bench/bench.js --old-vs-new    --games 10 --size 9 --players 2 --time 200
 *   node bench/bench.js --new-vs-new    --games 10 --size 9 --time 100 --time2 800
 *   node bench/bench.js --probe         --size 9 --time 300
 *
 * - Game rules are re-implemented independently in bench/lib/rules.js and
 *   cross-checked against the page's own sim()/territory() at startup.
 * - The OLD AI is sliced out of index.html at runtime (bench/lib/old-ai.js).
 * - The NEW engine is loaded from dev/ai-engine.js via require() (per
 *   dev/ENGINE_SPEC.md). When the file is absent the new-engine modes exit 2
 *   with a clear message; --old-vs-random still works.
 *
 * Options: --games N --size 9|13|19|25 --players 2..6 --time ms --time2 ms
 *          --json --seed N --playouts N --playouts2 N --page PATH --verbose
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const rules = require('./lib/rules');
const oldAiLib = require('./lib/old-ai');
const styleLib = require('./lib/style');

const VERSION = '1.0.0';
const ENGINE_PATH = path.join(__dirname, '..', 'dev', 'ai-engine.js');
const RANDOM_PASS_PROB = 0.08; // random legal player also passes 8% of the time
const DEFAULT_MAX_MOVES_FACTOR = 8;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const MODE_FLAGS = {
  '--old-vs-random': 'old-vs-random',
  '--old-vs-new': 'old-vs-new',
  '--new-vs-new': 'new-vs-new',
  '--probe': 'probe',
  '--style': 'style',
};

const USAGE = [
  'HEXAGO benchmark harness v' + VERSION,
  '',
  'Usage:',
  '  node bench/bench.js --old-vs-random [options]',
  '  node bench/bench.js --old-vs-new    [options]',
  '  node bench/bench.js --new-vs-new    [options]',
  '  node bench/bench.js --probe         [options]',
  '  node bench/bench.js --style         [options]',
  '',
  'Modes:',
  '  --old-vs-random   page AI (extracted from index.html) vs uniform random legal player',
  '  --old-vs-new      page AI vs dev/ai-engine.js engine (budget --time)',
  '  --new-vs-new      dev/ai-engine.js with budget --time vs the same engine with --time2',
  '  --probe           run the new engine on hand-built positions; assert legality, print bestMoves',
  '  --style           self-play the engine (optionally two engines with --engine2) and report',
  '                    behaviour metrics: own-stone adjacency by phase, opening distances,',
  '                    own-eye / own-territory fills, passes, openings, game length',
  '',
  'Options:',
  '  --games N        number of games            (default 10; 4 for --new-vs-new/--style)',
  '  --size N         9 | 13 | 19 | 25          (default 9)',
  '  --players N      2..6                      (default 2)',
  '  --time ms        new-engine budget, engine A / old-vs-new (default 300)',
  '  --time2 ms       new-engine budget, engine B (new-vs-new default 800; --style B, default = --time)',
  '  --playouts N     optional engine maxPlayouts cap (engine A / old-vs-new)',
  '  --playouts2 N    optional engine maxPlayouts cap (engine B)',
  '  --seed N         deterministic seed        (default 1)',
  '  --json           machine-readable JSON on stdout (diagnostics included)',
  '  --page PATH      alternative index.html ({repo}/index.html by default)',
  '  --engine PATH    alternative engine file ({repo}/dev/ai-engine.js by default)',
  '  --engine2 PATH   optional second engine for --style (A/B head-to-head style comparison)',
  '  --opening N      opening window in moves for --style (default 12)',
  '  --verbose        progress dots on stderr',
  '  --help           show this help',
  '',
  'Exit codes: 0 ok, 1 usage error, 2 new engine missing/broken, 3 rules cross-check failed.',
].join('\n');

function parseArgs(argv) {
  const cfg = {
    mode: null,
    games: null,
    size: 9,
    players: 2,
    time: 300,
    time2: 800,
    seed: 1,
    playouts: null,
    playouts2: null,
    json: false,
    verbose: false,
    help: false,
    page: null,
    engine: null,
    engine2: null,
    opening: 12,
    timeExplicit: false,
    time2Explicit: false,
  };
  const VALUE_KEYS = ['games', 'size', 'players', 'time', 'time2', 'seed', 'playouts', 'playouts2', 'page', 'engine', 'engine2', 'opening'];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (MODE_FLAGS[arg]) {
      if (cfg.mode) throw new Error('multiple modes given: --' + cfg.mode + ' and ' + arg);
      cfg.mode = MODE_FLAGS[arg];
      continue;
    }
    if (arg === '--json') { cfg.json = true; continue; }
    if (arg === '--verbose') { cfg.verbose = true; continue; }
    if (arg === '--help' || arg === '-h') { cfg.help = true; continue; }
    if (arg.slice(0, 2) === '--') {
      let key = arg.slice(2);
      let val;
      const eq = key.indexOf('=');
      if (eq >= 0) { val = key.slice(eq + 1); key = key.slice(0, eq); }
      else {
        if (VALUE_KEYS.indexOf(key) < 0) throw new Error('unknown option: ' + arg);
        if (i + 1 >= argv.length) throw new Error('option ' + arg + ' requires a value');
        val = argv[++i];
      }
      if (VALUE_KEYS.indexOf(key) < 0) throw new Error('unknown option: --' + key);
      if (key === 'page') { cfg.page = val; continue; }
      if (key === 'engine') { cfg.engine = val; continue; }
      if (key === 'engine2') { cfg.engine2 = val; continue; }
      const num = Number(val);
      if (!Number.isFinite(num) || !Number.isInteger(num)) throw new Error('option --' + key + ' expects an integer, got ' + JSON.stringify(val));
      cfg[key] = num;
      if (key === 'time') cfg.timeExplicit = true;
      if (key === 'time2') cfg.time2Explicit = true;
      continue;
    }
    throw new Error('unexpected argument: ' + arg);
  }
  if (cfg.help || !cfg.mode) return cfg;
  if (cfg.games == null) cfg.games = (cfg.mode === 'new-vs-new' || cfg.mode === 'style') ? 4 : 10;
  if (rules.VALID_SIZES.indexOf(cfg.size) < 0) throw new Error('--size must be one of 9, 13, 19, 25');
  if (cfg.players < 2 || cfg.players > 6) throw new Error('--players must be 2..6');
  if (cfg.games < 1) throw new Error('--games must be >= 1');
  if (cfg.time < 1) throw new Error('--time must be >= 1 ms');
  if (cfg.time2 < 1) throw new Error('--time2 must be >= 1 ms');
  if (cfg.seed < 0) throw new Error('--seed must be >= 0');
  if (cfg.playouts != null && cfg.playouts < 1) throw new Error('--playouts must be >= 1');
  if (cfg.playouts2 != null && cfg.playouts2 < 1) throw new Error('--playouts2 must be >= 1');
  if (cfg.opening < 1 || cfg.opening > 60) throw new Error('--opening must be 1..60');
  // --style: if a second engine is given without an explicit --time2, use the same budget (fair A/B).
  if (cfg.mode === 'style' && cfg.engine2 && !cfg.time2Explicit) cfg.time2 = cfg.time;
  return cfg;
}

// ---------------------------------------------------------------------------
// small utils
// ---------------------------------------------------------------------------

function hrtimeMs() { return Number(process.hrtime.bigint()) / 1e6; }
function round(v, digits) { const f = Math.pow(10, digits == null ? 1 : digits); return Math.round(v * f) / f; }
function pct(w, total) { return total ? round((100 * w) / total, 1) : null; }
function truncate(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…' : s; }
function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }
function padLeft(s, n) { s = String(s); return s.length >= n ? s : ' '.repeat(n - s.length) + s; }
function signNum(v) { return (v >= 0 ? '+' : '') + round(v, 1); }

function coordOf(R, i) { return i >= 0 && i < R.n ? '(' + R.geo.P[i][0] + ',' + R.geo.P[i][1] + ')' : '-'; }

// ---------------------------------------------------------------------------
// new engine loading / verification
// ---------------------------------------------------------------------------

function enginePathOf(cfg) {
  if (!cfg || !cfg.engine) return ENGINE_PATH;
  return path.resolve(process.cwd(), cfg.engine);
}

function loadNewEngine(enginePath) {
  const ep = enginePath || ENGINE_PATH;
  if (!fs.existsSync(ep)) {
    return { ok: false, reason: path.basename(ep) + ' not found (engine development pending)', path: ep, sha256: null };
  }
  let sha256 = null;
  try { sha256 = crypto.createHash('sha256').update(fs.readFileSync(ep)).digest('hex'); } catch (e) { /* best effort */ }
  let mod;
  try {
    mod = require(ep);
  } catch (e) {
    return { ok: false, reason: 'require(' + ep + ') failed: ' + truncate(e && e.message, 400), path: ep, sha256: sha256, stack: truncate(e && e.stack, 1200) };
  }
  let api = null;
  if (mod && typeof mod.createEngine === 'function') api = mod;
  else if (mod && mod.HexagoAI && typeof mod.HexagoAI.createEngine === 'function') api = mod.HexagoAI;
  else if (mod && mod.default && typeof mod.default.createEngine === 'function') api = mod.default;
  if (!api) {
    return {
      ok: false,
      reason: 'module exports no createEngine() (spec: module.exports = {geometry, createEngine, hashBoard, version})',
      path: ep,
      sha256: sha256,
      exports: mod && typeof mod === 'object' ? Object.keys(mod) : typeof mod,
    };
  }
  return { ok: true, api: api, path: ep, sha256: sha256, version: typeof api.version === 'string' ? api.version : null };
}

function compareGeometry(eg, ref, label, errors, warnings) {
  if (!eg || typeof eg !== 'object') { errors.push(label + ': geometry() did not return an object'); return; }
  if (eg.n !== ref.n) errors.push(label + ': geometry().n=' + eg.n + ' expected ' + ref.n);
  if (eg.size !== ref.size) errors.push(label + ': geometry().size=' + eg.size + ' expected ' + ref.size);
  if (eg.side !== ref.side) warnings.push(label + ': geometry().side=' + eg.side + ' expected ' + ref.side);
  if (eg.center !== ref.center) warnings.push(label + ': geometry().center=' + eg.center + ' expected ' + ref.center);
  if (Array.isArray(eg.P)) {
    if (eg.P.length !== ref.P.length) errors.push(label + ': geometry().P.length=' + eg.P.length + ' expected ' + ref.P.length);
    else {
      for (let i = 0; i < ref.P.length; i++) {
        const a = eg.P[i];
        if (!a || a[0] !== ref.P[i][0] || a[1] !== ref.P[i][1]) { errors.push(label + ': geometry().P[' + i + '] mismatch'); break; }
      }
    }
  } else errors.push(label + ': geometry().P missing/not an array');
  if (Array.isArray(eg.NB)) {
    if (eg.NB.length !== ref.NB.length) errors.push(label + ': geometry().NB.length=' + eg.NB.length + ' expected ' + ref.NB.length);
    else {
      for (let i = 0; i < ref.NB.length; i++) {
        const a = eg.NB[i], b = ref.NB[i];
        if (!Array.isArray(a) || a.length !== b.length || a.some(function (v, k) { return v !== b[k]; })) { errors.push(label + ': geometry().NB[' + i + '] mismatch'); break; }
      }
    }
  } else errors.push(label + ': geometry().NB missing/not an array');
  if (typeof eg.dist === 'function') {
    for (let i = 0; i < ref.n; i += Math.max(1, Math.floor(ref.n / 7))) {
      for (let j = 0; j < ref.n; j += Math.max(1, Math.floor(ref.n / 5))) {
        if (eg.dist(i, j) !== ref.dist(i, j)) { errors.push(label + ': geometry().dist(' + i + ',' + j + ')=' + eg.dist(i, j) + ' expected ' + ref.dist(i, j)); i = ref.n; break; }
      }
    }
  } else errors.push(label + ': geometry().dist missing');
}

function verifyEngine(engineApi, R, opts) {
  const o = opts || {};
  const out = { ok: true, errors: [], warnings: [], version: typeof engineApi.version === 'string' ? engineApi.version : null, hash: null, geometry: null, createEngine: null };
  function err(m) { out.ok = false; out.errors.push(m); }
  function warn(m) { out.warnings.push(m); }

  // geometry for every supported size
  out.geometry = { ok: true, sizes: [] };
  if (typeof engineApi.geometry === 'function') {
    for (let s = 0; s < rules.VALID_SIZES.length; s++) {
      const size = rules.VALID_SIZES[s];
      try {
        const ref = rules.geometry(size);
        const eg = engineApi.geometry(size);
        const e = [], w = [];
        compareGeometry(eg, ref, 'size' + size, e, w);
        if (e.length) { out.geometry.ok = false; for (let k = 0; k < e.length; k++) err(e[k]); }
        for (let k = 0; k < w.length; k++) warn(w[k]);
        out.geometry.sizes.push({ size: size, n: ref.n, ok: e.length === 0 });
      } catch (e) {
        out.geometry.ok = false;
        err('geometry(' + size + ') threw: ' + truncate(e && e.message, 200));
      }
    }
  } else {
    out.geometry.ok = false;
    warn('module exports no geometry(); cannot verify board geometry');
  }

  // hashBoard must equal the page cyrb53 hash
  const refHash = typeof o.pageHash === 'function' ? o.pageHash : rules.hash;
  out.hash = { checked: 0, ok: true, reference: typeof o.pageHash === 'function' ? 'page hash()' : 'bench rules hash()' };
  if (typeof engineApi.hashBoard === 'function') {
    const rng = rules.makeRng((o.seed || 1) + 77);
    const boards = [];
    const empty = new Array(R.n).fill(0);
    boards.push(empty);
    for (let t = 0; t < 6; t++) {
      const b = empty.slice();
      const count = Math.floor(rng() * R.n);
      for (let k = 0; k < count; k++) b[Math.floor(rng() * R.n)] = 1 + Math.floor(rng() * 6);
      boards.push(b);
    }
    for (let k = 0; k < boards.length; k++) {
      let got;
      try { got = engineApi.hashBoard(boards[k]); } catch (e) { out.hash.ok = false; err('hashBoard() threw: ' + truncate(e && e.message, 200)); break; }
      const want = refHash(boards[k]);
      out.hash.checked++;
      if (got !== want) { out.hash.ok = false; err('hashBoard() mismatch: got ' + got + ' expected ' + want + ' (board sample ' + k + ')'); break; }
    }
  } else {
    out.hash.ok = false;
    warn('module exports no hashBoard(); superko hash compatibility could not be verified');
  }

  // createEngine contract
  try {
    const engine = engineApi.createEngine({ size: R.size, playerCount: o.players || 2 });
    out.createEngine = { ok: !!engine && typeof engine.think === 'function' };
    if (!out.createEngine.ok) err('createEngine() did not return an object with think(state, options)');
  } catch (e) {
    out.createEngine = { ok: false, error: truncate(e && e.message, 300) };
    err('createEngine() threw: ' + truncate(e && e.message, 300));
  }
  return out;
}

function engineUnavailableResult(cfg, diagnostics, reason) {
  return {
    ok: false,
    code: 'ENGINE_UNAVAILABLE',
    mode: cfg.mode,
    size: cfg.size,
    players: cfg.players,
    games: cfg.games,
    seed: cfg.seed,
    error: reason,
    engineFile: { path: cfg.engine ? path.resolve(process.cwd(), cfg.engine) : ENGINE_PATH, exists: fs.existsSync(cfg.engine ? path.resolve(process.cwd(), cfg.engine) : ENGINE_PATH) },
    diagnostics: diagnostics || {},
  };
}

// ---------------------------------------------------------------------------
// agents
// ---------------------------------------------------------------------------

function makeRandomAgent(ctx) {
  return {
    kind: 'random',
    label: 'random',
    resignMode: 'never',
    choose: function (state) {
      const lm = ctx.R.legalMoves(state);
      if (!lm.length) return { move: -1 };
      if (ctx.gameRng() < RANDOM_PASS_PROB) return { move: -1 };
      return { move: lm[Math.floor(ctx.gameRng() * lm.length)] };
    },
  };
}

function makeOldAgent(ctx) {
  if (!ctx.oldAI) throw new Error('old AI requested but index.html extraction is unavailable');
  ctx.oldAI.setRandom(ctx.aiRng);
  return {
    kind: 'old',
    label: 'old',
    resignMode: 'any',
    choose: function (state) {
      return { move: oldAiLib.callOldAI(ctx.oldAI, state) };
    },
  };
}

function makeNewAgent(kind, label, budgetMs, maxPlayouts, ctx) {
  const engine = ctx.engineApi.createEngine({ size: ctx.R.size, playerCount: ctx.cfg.players });
  if (!engine || typeof engine.think !== 'function') throw new Error('createEngine() did not return a usable engine for ' + label);
  return {
    kind: kind,
    label: label,
    resignMode: '2p',
    choose: function (state) {
      const view = {
        board: state.board.slice(),
        turn: state.turn,
        playerCount: state.playerCount,
        out: state.out.slice(),
        passes: state.passes,
        seen: state.seen.slice(),
      };
      const snapBoard = view.board.slice();
      const snapSeen = view.seen.slice();
      const options = {
        budgetMs: budgetMs,
        seed: rules.mixSeed(ctx.cfg.seed, ctx.gameIndex, state.moves, state.turn),
      };
      if (maxPlayouts) options.maxPlayouts = maxPlayouts;
      const t0 = process.hrtime.bigint();
      const res = engine.think(view, options);
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      if (!res || typeof res !== 'object') throw new Error('think() returned ' + String(res));
      if (!Number.isInteger(res.move)) throw new Error('think() result.move is not an integer: ' + JSON.stringify(res.move));
      let mutated = view.seen.length !== snapSeen.length;
      if (!mutated) for (let i = 0; i < snapBoard.length; i++) if (view.board[i] !== snapBoard[i]) { mutated = true; break; }
      return {
        move: res.move,
        stats: {
          ms: ms,
          visits: Number.isFinite(res.visits) ? res.visits : null,
          playouts: Number.isFinite(res.playouts) ? res.playouts : null,
          reportedMs: Number.isFinite(res.elapsedMs) ? res.elapsedMs : null,
          winrate: Number.isFinite(res.winrate) ? res.winrate : null,
          engine: typeof res.engine === 'string' ? res.engine : null,
          mutatedInput: mutated,
        },
      };
    },
  };
}

function agentSpecs(cfg) {
  const t = cfg.time, t2 = cfg.time2;
  switch (cfg.mode) {
    case 'old-vs-random':
      return [{ kind: 'old', label: 'old' }, { kind: 'random', label: 'random' }];
    case 'old-vs-new':
      return [{ kind: 'old', label: 'old' }, { kind: 'newA', label: 'new(' + t + 'ms)' }];
    case 'new-vs-new':
      return [{ kind: 'newA', label: 'newA(' + t + 'ms)' }, { kind: 'newB', label: 'newB(' + t2 + 'ms)' }];
    default:
      throw new Error('unknown mode ' + cfg.mode);
  }
}

function createAgent(spec, cfg, ctx) {
  switch (spec.kind) {
    case 'random': return makeRandomAgent(ctx);
    case 'old': return makeOldAgent(ctx);
    case 'newA': return makeNewAgent(spec.kind, spec.label, cfg.time, cfg.playouts, ctx);
    case 'newB': return makeNewAgent(spec.kind, spec.label, cfg.time2, cfg.playouts2, ctx);
    default: throw new Error('unknown agent kind ' + spec.kind);
  }
}

// ---------------------------------------------------------------------------
// one game
// ---------------------------------------------------------------------------

function playOneGame(cfg, ctx, gameIndex) {
  const R = ctx.R;
  const state = R.newState(cfg.players);
  const gameRng = rules.makeRng(rules.mixSeed(cfg.seed, gameIndex, 0x11, 0x2f));
  const aiRng = rules.makeRng(rules.mixSeed(cfg.seed, gameIndex, 0x22, 0x53));
  const specs = ctx.specs;
  const maxMoves = Math.max(200, R.n * DEFAULT_MAX_MOVES_FACTOR);

  const seats = [null];
  const startT = Date.now();
  for (let p = 1; p <= cfg.players; p++) {
    const oddSeat = (p % 2 === 1);
    const spec = ((gameIndex % 2 === 0) === oddSeat) ? specs[0] : specs[1];
    seats[p] = {
      seat: p,
      kind: spec.kind,
      label: spec.label,
      moves: 0,
      ms: 0,
      visits: 0,
      visitsN: 0,
      playouts: 0,
      playoutsN: 0,
      reportedMs: 0,
      resigns: 0,
      passes: 0,
      mutatedInput: 0,
      engine: null,
      crash: null,
      illegal: null,
      outcome: 'L',
      score: null,
      diff: null,
    };
    seats[p].agent = createAgent(spec, cfg, {
      R: R,
      cfg: cfg,
      gameRng: gameRng,
      aiRng: aiRng,
      gameIndex: gameIndex,
      oldAI: ctx.oldAI,
      engineApi: ctx.engineApi,
    });
    seats[p].resignMode = seats[p].agent.resignMode || '2p';
  }

  let endReason = null;
  let forfeitSeat = -1;
  let forfeitKind = null;
  let errorText = null;

  while (!state.over) {
    if (state.moves > maxMoves) { endReason = 'max-moves'; break; }
    const p = state.turn;
    const rec = seats[p];
    const t0 = process.hrtime.bigint();
    let result = null;
    let threw = null;
    try { result = rec.agent.choose(state); } catch (e) { threw = e; }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    rec.moves++;
    rec.ms += ms;

    if (threw) {
      rec.crash = truncate(String(threw && threw.stack || threw), 600);
      endReason = 'crash';
      forfeitSeat = p;
      forfeitKind = rec.kind;
      errorText = rec.crash;
      break;
    }

    const stats = result && result.stats;
    if (stats) {
      if (stats.visits != null) { rec.visits += stats.visits; rec.visitsN++; }
      if (stats.playouts != null) { rec.playouts += stats.playouts; rec.playoutsN++; }
      if (stats.reportedMs != null) rec.reportedMs += stats.reportedMs;
      if (stats.engine && !rec.engine) rec.engine = stats.engine;
      if (stats.mutatedInput) rec.mutatedInput++;
    }

    const move = result && result.move;
    let invalid = null;
    if (!Number.isInteger(move)) {
      invalid = 'non-integer move (' + String(move) + ')';
    } else if (move === -1) {
      rec.passes++;
      if (R.doPass(state)) { endReason = 'pass'; break; }
    } else if (move === -2) {
      const resignAllowed = rec.resignMode === 'any' || (rec.resignMode === '2p' && cfg.players === 2);
      if (!resignAllowed) invalid = 'resign (-2) returned in ' + cfg.players + '-player game';
      else {
        rec.resigns++;
        R.resign(state);
        if (state.over) endReason = 'resign';
      }
    } else if (move < 0 || move >= R.n) {
      invalid = 'move out of range (' + move + ')';
    } else {
      const r = R.applyMove(state, move);
      if (!r) invalid = 'illegal move (' + move + ' ' + coordOf(R, move) + ')';
    }
    if (invalid) {
      rec.illegal = invalid;
      endReason = 'illegal';
      forfeitSeat = p;
      forfeitKind = rec.kind;
      errorText = invalid;
      break;
    }
  }

  const durationMs = Date.now() - startT;

  let summary = null;
  if (endReason === 'pass') summary = R.finishByPass(state);
  else if (endReason === 'resign' || endReason === 'max-moves') summary = R.scoreState(state);
  else if (!endReason) summary = R.scoreState(state);

  const outcomes = new Array(cfg.players + 1).fill('L');
  let winners = [];
  if (!summary) {
    for (let p = 1; p <= cfg.players; p++) {
      const out = state.out[p] || p === forfeitSeat;
      outcomes[p] = out ? 'L' : 'W';
      if (outcomes[p] === 'W') winners.push(p);
    }
  } else {
    winners = summary.top.slice();
    for (let p = 1; p <= cfg.players; p++) {
      if (state.out[p]) outcomes[p] = 'L';
      else if (summary.top.indexOf(p) >= 0) outcomes[p] = summary.top.length === 1 ? 'W' : 'D';
      else outcomes[p] = 'L';
    }
  }

  for (let p = 1; p <= cfg.players; p++) {
    const rec = seats[p];
    rec.outcome = outcomes[p];
    if (summary) {
      rec.score = summary.scores[p];
      let maxOther = -Infinity;
      for (let q = 1; q <= cfg.players; q++) if (q !== p) maxOther = Math.max(maxOther, summary.scores[q]);
      rec.diff = maxOther === -Infinity ? null : summary.scores[p] - maxOther;
    }
    delete rec.agent;
  }

  return {
    game: gameIndex,
    endReason: endReason,
    moves: state.moves,
    durationMs: durationMs,
    forfeitSeat: forfeitSeat > 0 ? forfeitSeat : null,
    forfeitKind: forfeitKind,
    error: errorText,
    winners: winners,
    scores: summary ? summary.scores.slice(1) : null,
    margin: summary ? summary.margin : null,
    resignations: seats.slice(1).reduce(function (n, r) { return n + r.resigns; }, 0),
    seats: seats.slice(1),
  };
}

// ---------------------------------------------------------------------------
// match runner + aggregation
// ---------------------------------------------------------------------------

function newAgentAgg(spec) {
  return {
    kind: spec.kind,
    label: spec.label,
    seats: 0,
    games: 0,
    W: 0, L: 0, D: 0,
    diffSum: 0,
    diffN: 0,
    moves: 0,
    ms: 0,
    visits: 0,
    visitsN: 0,
    playouts: 0,
    playoutsN: 0,
    reportedMs: 0,
    resigns: 0,
    passes: 0,
    mutatedInput: 0,
    illegal: 0,
    crashes: 0,
    engine: null,
  };
}

function runGames(cfg, ctx) {
  const agg = {
    perSeat: [],
    perAgent: {},
    marginSum: 0,
    marginN: 0,
    totalMoves: 0,
    truncated: 0,
    illegal: 0,
    crashes: 0,
    mutatedInput: 0,
    resignations: 0,
  };
  for (let p = 1; p <= cfg.players; p++) agg.perSeat.push({ seat: p, games: 0, W: 0, L: 0, D: 0 });
  for (let k = 0; k < ctx.specs.length; k++) agg.perAgent[ctx.specs[k].kind] = newAgentAgg(ctx.specs[k]);

  const games = [];
  const t0 = Date.now();
  for (let gi = 0; gi < cfg.games; gi++) {
    const game = playOneGame(cfg, ctx, gi);
    games.push(game);
    aggregateGame(agg, game, cfg);
    if (cfg.verbose && !cfg.json) process.stderr.write('.');
  }
  if (cfg.verbose && !cfg.json) process.stderr.write('\n');
  return { games: games, agg: agg, elapsedMs: Date.now() - t0 };
}

function aggregateGame(agg, game, cfg) {
  const agentKindsInGame = new Set();
  for (let k = 0; k < game.seats.length; k++) {
    const rec = game.seats[k];
    agentKindsInGame.add(rec.kind);
    const seatAgg = agg.perSeat[rec.seat - 1];
    seatAgg.games++;
    seatAgg[rec.outcome]++;
    const a = agg.perAgent[rec.kind];
    a.seats++;
    a[rec.outcome]++;
    if (rec.diff != null) { a.diffSum += rec.diff; a.diffN++; }
    a.moves += rec.moves;
    a.ms += rec.ms;
    a.visits += rec.visits;
    a.visitsN += rec.visitsN;
    a.playouts += rec.playouts;
    a.playoutsN += rec.playoutsN;
    a.reportedMs += rec.reportedMs;
    a.resigns += rec.resigns;
    a.passes += rec.passes;
    a.mutatedInput += rec.mutatedInput;
    if (rec.engine && !a.engine) a.engine = rec.engine;
  }
  agentKindsInGame.forEach(function (kind) { agg.perAgent[kind].games++; });

  if (game.endReason === 'illegal' && game.forfeitKind) agg.perAgent[game.forfeitKind].illegal++;
  if (game.endReason === 'crash' && game.forfeitKind) agg.perAgent[game.forfeitKind].crashes++;
  if (game.endReason === 'max-moves') agg.truncated++;
  agg.totalMoves += game.moves;
  agg.resignations += game.resignations;
  if (game.margin != null) { agg.marginSum += game.margin; agg.marginN++; }
  for (let k = 0; k < game.seats.length; k++) agg.mutatedInput += game.seats[k].mutatedInput;
}

function finalizedAgents(agg) {
  const out = [];
  Object.keys(agg.perAgent).forEach(function (kind) {
    const a = agg.perAgent[kind];
    out.push({
      kind: a.kind,
      label: a.label,
      games: a.games,
      seats: a.seats,
      W: a.W,
      L: a.L,
      D: a.D,
      winratePct: pct(a.W, a.seats),
      avgDiff: a.diffN ? round(a.diffSum / a.diffN, 2) : null,
      moves: a.moves,
      msPerMove: a.moves ? round(a.ms / a.moves, 2) : null,
      totalSeconds: round(a.ms / 1000, 2),
      avgVisits: a.visitsN ? round(a.visits / a.visitsN, 1) : null,
      avgPlayouts: a.playoutsN ? round(a.playouts / a.playoutsN, 1) : null,
      reportedMsPerMove: a.moves ? round(a.reportedMs / a.moves, 2) : null,
      resignations: a.resigns,
      passes: a.passes,
      illegal: a.illegal,
      crashes: a.crashes,
      mutatedInput: a.mutatedInput,
      engine: a.engine,
    });
  });
  return out;
}

function runMatch(cfg) {
  const R = rules.createRules(cfg.size);
  const specs = agentSpecs(cfg);
  const needsEngine = cfg.mode !== 'old-vs-random';
  const needsOld = cfg.mode === 'old-vs-random' || cfg.mode === 'old-vs-new';
  const diagnostics = {
    node: process.version,
    page: cfg.page || oldAiLib.DEFAULT_PAGE,
    engineFile: null,
    extraction: null,
    oldSanity: null,
    crossCheck: null,
    engineVerify: null,
  };
  const warnings = [];

  // --- old AI (extracted from index.html) ---
  let oldAI = null;
  try {
    oldAI = oldAiLib.createOldAI({ size: cfg.size, seed: cfg.seed, pagePath: cfg.page || undefined });
    diagnostics.extraction = oldAI.extraction;
  } catch (e) {
    if (needsOld) {
      return {
        ok: false,
        code: 'OLD_AI_EXTRACTION_FAILED',
        mode: cfg.mode, size: cfg.size, players: cfg.players, games: cfg.games, seed: cfg.seed,
        error: truncate(e && e.message, 800),
        diagnostics: diagnostics,
      };
    }
    warnings.push('old-AI extraction failed (not needed for this mode): ' + truncate(e && e.message, 200));
  }

  if (oldAI) {
    diagnostics.crossCheck = oldAiLib.crossCheckRules(oldAI, R, { seed: rules.mixSeed(cfg.seed, 0x33, 0x44, 0), positions: 6 });
    diagnostics.oldSanity = oldAiLib.sanityCheckAI(oldAI, R, { seed: rules.mixSeed(cfg.seed, 0x55, 0x66, 0) });
    if (!diagnostics.oldSanity.ok) {
      return {
        ok: false,
        code: 'OLD_AI_SANITY_FAILED',
        mode: cfg.mode, size: cfg.size, players: cfg.players, games: cfg.games, seed: cfg.seed,
        error: 'extracted old AI failed sanity check: ' + truncate(JSON.stringify(diagnostics.oldSanity.invalid.slice(0, 3)), 700),
        diagnostics: diagnostics,
      };
    }
    if (!diagnostics.crossCheck.ok) {
      warnings.push('rules cross-check against the page FAILED (' + diagnostics.crossCheck.mismatches.length + ' mismatches)');
    }
  }

  // --- new engine ---
  let engineApi = null;
  if (needsEngine) {
    const ep = enginePathOf(cfg);
    const loaded = loadNewEngine(ep);
    diagnostics.engineFile = { path: ep, exists: fs.existsSync(ep), version: loaded.version || null, sha256: loaded.sha256 || null, reason: loaded.reason || null };
    if (!loaded.ok) {
      const res = engineUnavailableResult(cfg, diagnostics, loaded.reason);
      return res;
    }
    engineApi = loaded.api;
    const pageHash = oldAI && typeof oldAI.api.hash === 'function' ? oldAI.api.hash : null;
    diagnostics.engineVerify = verifyEngine(engineApi, R, { players: cfg.players, pageHash: pageHash });
    if (!diagnostics.engineVerify.ok) {
      return {
        ok: false,
        code: 'ENGINE_BROKEN',
        mode: cfg.mode, size: cfg.size, players: cfg.players, games: cfg.games, seed: cfg.seed,
        error: 'new engine failed contract checks: ' + diagnostics.engineVerify.errors.join(' | '),
        diagnostics: diagnostics,
      };
    }
    for (let k = 0; k < diagnostics.engineVerify.warnings.length; k++) warnings.push(diagnostics.engineVerify.warnings[k]);
  }

  const ctx = { R: R, specs: specs, oldAI: oldAI, engineApi: engineApi };
  let run;
  try {
    run = runGames(cfg, ctx);
  } catch (e) {
    if (e && /createEngine|think\(\)/.test(String(e.message))) {
      return { ok: false, code: 'ENGINE_BROKEN', mode: cfg.mode, size: cfg.size, players: cfg.players, games: cfg.games, seed: cfg.seed, error: truncate(e.message, 800), diagnostics: diagnostics };
    }
    throw e;
  }

  const agents = finalizedAgents(run.agg);
  const crossCheckOk = oldAI ? diagnostics.crossCheck.ok : null;
  const ok = crossCheckOk === false ? false : true;
  if (crossCheckOk === false) warnings.push('results are based on rules that differ from the page (see diagnostics.crossCheck)');

  const result = {
    ok: ok,
    code: crossCheckOk === false ? 'RULES_CROSSCHECK_FAILED' : 'OK',
    bench: 'hexago-bench',
    version: VERSION,
    mode: cfg.mode,
    size: cfg.size,
    points: R.n,
    players: cfg.players,
    games: cfg.games,
    seed: cfg.seed,
    engineTimesMs: needsEngine ? (cfg.mode === 'new-vs-new' ? { A: cfg.time, B: cfg.time2 } : { A: cfg.time }) : null,
    playoutCaps: needsEngine ? (cfg.mode === 'new-vs-new' ? { A: cfg.playouts, B: cfg.playouts2 } : { A: cfg.playouts }) : null,
    elapsedMs: run.elapsedMs,
    perSeat: run.agg.perSeat.map(function (s) {
      return { seat: s.seat, games: s.games, W: s.W, L: s.L, D: s.D, winratePct: pct(s.W, s.games) };
    }),
    perAgent: agents,
    totals: {
      illegal: agents.reduce(function (n, a) { return n + a.illegal; }, 0),
      crashes: agents.reduce(function (n, a) { return n + a.crashes; }, 0),
      resignations: run.agg.resignations,
      truncated: run.agg.truncated,
      mutatedInput: run.agg.mutatedInput,
      totalMoves: run.agg.totalMoves,
    },
    avgMargin: run.agg.marginN ? round(run.agg.marginSum / run.agg.marginN, 2) : null,
    avgMarginGames: run.agg.marginN,
    avgMovesPerGame: round(run.agg.totalMoves / cfg.games, 1),
    warnings: warnings,
    diagnostics: diagnostics,
    gameLog: run.games,
  };
  return result;
}

// ---------------------------------------------------------------------------
// reporting
// ---------------------------------------------------------------------------

function formatMatchReport(res) {
  const L = [];
  L.push('=== HEXAGO bench v' + res.version + ' | ' + res.mode + ' ===');
  L.push('node ' + res.diagnostics.node + ' | size ' + res.size + ' (' + res.points + ' pts) | players ' + res.players +
    ' | games ' + res.games + ' | seed ' + res.seed +
    (res.engineTimesMs ? ' | engine budgets ' + JSON.stringify(res.engineTimesMs) : ''));
  L.push('');

  const d = res.diagnostics;
  if (d.extraction) {
    const ex = d.extraction;
    L.push('old-AI extraction : ' + ex.strategy + ' from index.html' + (ex.appended.length ? ' (+' + ex.appended.join(',') + ' located by name)' : ''));
  } else {
    L.push('old-AI extraction : skipped for this mode');
  }
  if (d.oldSanity) {
    L.push('old-AI sanity     : ' + d.oldSanity.calls + '/' + d.oldSanity.calls + ' calls legal (' + round(d.oldSanity.totalMs / Math.max(1, d.oldSanity.calls), 2) + ' ms avg)');
  }
  if (d.crossCheck) {
    const c = d.crossCheck;
    L.push('rules cross-check : ' + (c.ok ? 'OK' : 'FAIL') + ' vs page sim/territory -- ' +
      c.positions + ' positions, ' + c.movesChecked + ' move legality, ' + c.territoryChecked + ' territory, ' +
      c.deadChecked + ' dead-stone, ' + c.hashChecked + ' hash vectors');
    if (!c.ok) for (let k = 0; k < Math.min(3, c.mismatches.length); k++) L.push('  ! ' + JSON.stringify(c.mismatches[k]));
  }
  if (d.engineVerify) {
    const v = d.engineVerify;
    L.push('new engine        : ' + (v.version || '(no version tag)') + (d.engineFile && d.engineFile.sha256 ? ' [' + d.engineFile.sha256.slice(0, 12) + ']' : '') + ' | geometry ' + (v.geometry.ok ? 'OK' : 'FAIL') +
      ' | hashBoard ' + (v.hash.ok ? 'OK (' + v.hash.checked + ' vectors)' : 'FAIL') +
      ' | createEngine ' + (v.createEngine && v.createEngine.ok ? 'OK' : 'FAIL'));
    for (let k = 0; k < v.warnings.length; k++) L.push('  ~ ' + v.warnings[k]);
  }
  if (res.warnings && res.warnings.length) {
    for (let k = 0; k < res.warnings.length; k++) L.push('warning           : ' + res.warnings[k]);
  }
  L.push('');

  L.push('per seat');
  for (let k = 0; k < res.perSeat.length; k++) {
    const s = res.perSeat[k];
    L.push('  seat ' + s.seat + ' :  W ' + padLeft(s.W, 3) + '  L ' + padLeft(s.L, 3) + '  D ' + padLeft(s.D, 3) +
      '   (' + padLeft(s.winratePct == null ? '-' : s.winratePct, 5) + '%)');
  }
  L.push('');

  L.push('per agent');
  for (let k = 0; k < res.perAgent.length; k++) {
    const a = res.perAgent[k];
    let line = '  ' + pad(a.label, 20) +
      ' seats ' + padLeft(a.seats, 3) +
      '  W ' + padLeft(a.W, 3) + '  L ' + padLeft(a.L, 3) + '  D ' + padLeft(a.D, 3) +
      '  winrate ' + padLeft(a.winratePct == null ? '-' : a.winratePct, 5) + '%' +
      '  avgDiff ' + padLeft(a.avgDiff == null ? '-' : signNum(a.avgDiff), 7) +
      '  ' + padLeft(a.msPerMove == null ? '-' : a.msPerMove, 7) + ' ms/move';
    if (a.avgVisits != null) line += '  visits ' + a.avgVisits + '/mv';
    if (a.avgPlayouts != null) line += '  playouts ' + a.avgPlayouts + '/mv';
    if (a.resignations) line += '  resign ' + a.resignations;
    if (a.passes) line += '  pass ' + a.passes;
    L.push(line);
  }
  L.push('');

  L.push('totals');
  const t = res.totals;
  const perKind = res.perAgent.map(function (a) { return a.kind + ' illegal ' + a.illegal + '/crash ' + a.crashes; }).join(', ');
  L.push('  illegal moves : ' + t.illegal + '   crashes : ' + t.crashes + '   max-move truncations : ' + t.truncated);
  L.push('  ' + perKind);
  if (res.avgMargin != null) L.push('  avg score margin (winner - runner-up) : ' + res.avgMargin + '  (n=' + res.avgMarginGames + ' scored games)');
  L.push('  resignations : ' + t.resignations + (t.mutatedInput ? '   engine input mutations : ' + t.mutatedInput : ''));
  L.push('  avg moves/game : ' + res.avgMovesPerGame);
  L.push('  elapsed : ' + round(res.elapsedMs / 1000, 2) + ' s (' + round(res.elapsedMs / 1000 / res.games, 2) + ' s/game)');
  if (!res.ok) L.push('');
  if (!res.ok) L.push('RESULT: FAILED (' + res.code + ') - see warnings above');
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// style mode: behaviour metrics of self-played engines
// ---------------------------------------------------------------------------

function styleEngineLine(label, meta) {
  return label + ' : ' + (meta.version || '(no version tag)') + (meta.sha256 ? ' [' + meta.sha256.slice(0, 12) + ']' : '') +
    ' | budget ' + meta.budgetMs + ' ms/move' + (meta.maxPlayouts ? ' | maxPlayouts ' + meta.maxPlayouts : '') +
    ' | ' + meta.path;
}

function fmtHist(hist, histMax) {
  const parts = [];
  for (let k = 0; k < hist.length; k++) {
    if (!hist[k]) continue;
    parts.push((k > histMax ? (histMax + 1) + '+' : String(k)) + ':' + hist[k]);
  }
  return parts.length ? parts.join(' ') : '-';
}

function runStyle(cfg) {
  const R = rules.createRules(cfg.size);
  const diagnostics = { node: process.version, engineA: null, engineB: null, engineVerifyA: null, engineVerifyB: null };
  const warnings = [];

  const pathA = enginePathOf(cfg);
  const loadedA = loadNewEngine(pathA);
  diagnostics.engineA = { path: pathA, exists: fs.existsSync(pathA), version: loadedA.version || null, sha256: loadedA.sha256 || null, reason: loadedA.reason || null };
  if (!loadedA.ok) return engineUnavailableResult(cfg, diagnostics, loadedA.reason);
  diagnostics.engineVerifyA = verifyEngine(loadedA.api, R, { players: cfg.players, seed: cfg.seed });
  if (!diagnostics.engineVerifyA.ok) {
    return {
      ok: false, code: 'ENGINE_BROKEN', mode: cfg.mode, size: cfg.size, players: cfg.players, games: cfg.games, seed: cfg.seed,
      error: 'engine A contract checks failed: ' + diagnostics.engineVerifyA.errors.join(' | '), diagnostics: diagnostics,
    };
  }
  for (let k = 0; k < diagnostics.engineVerifyA.warnings.length; k++) warnings.push('engine A: ' + diagnostics.engineVerifyA.warnings[k]);

  let loadedB = null;
  if (cfg.engine2) {
    const pathB = path.resolve(process.cwd(), cfg.engine2);
    loadedB = loadNewEngine(pathB);
    diagnostics.engineB = { path: pathB, exists: fs.existsSync(pathB), version: loadedB.version || null, sha256: loadedB.sha256 || null, reason: loadedB.reason || null };
    if (!loadedB.ok) {
      return {
        ok: false, code: 'ENGINE_UNAVAILABLE', mode: cfg.mode, size: cfg.size, players: cfg.players, games: cfg.games, seed: cfg.seed,
        error: 'engine B (--engine2): ' + loadedB.reason, diagnostics: diagnostics,
      };
    }
    diagnostics.engineVerifyB = verifyEngine(loadedB.api, R, { players: cfg.players, seed: cfg.seed });
    if (!diagnostics.engineVerifyB.ok) {
      return {
        ok: false, code: 'ENGINE_BROKEN', mode: cfg.mode, size: cfg.size, players: cfg.players, games: cfg.games, seed: cfg.seed,
        error: 'engine B contract checks failed: ' + diagnostics.engineVerifyB.errors.join(' | '), diagnostics: diagnostics,
      };
    }
    for (let k = 0; k < diagnostics.engineVerifyB.warnings.length; k++) warnings.push('engine B: ' + diagnostics.engineVerifyB.warnings[k]);
  }

  const twoEngine = !!loadedB;
  const tracker = styleLib.createStyleTracker(R, {
    openingMoves: cfg.opening,
    engineKeys: twoEngine ? ['A', 'B'] : ['A'],
    twoEngine: twoEngine,
  });
  const ctx = {
    R: R, cfg: cfg, tracker: tracker,
    engineA: loadedA.api, engineB: loadedB ? loadedB.api : null,
    timeA: cfg.time, timeB: cfg.time2,
    playA: cfg.playouts, playB: cfg.playouts2,
    twoEngine: twoEngine,
    illegal: 0, crashes: 0, mutatedInput: 0,
  };
  const t0 = Date.now();
  try {
    for (let gi = 0; gi < cfg.games; gi++) playStyleGame(ctx, gi);
  } catch (e) {
    if (e && /createEngine|think\(\)/.test(String(e.message))) {
      return { ok: false, code: 'ENGINE_BROKEN', mode: cfg.mode, size: cfg.size, players: cfg.players, games: cfg.games, seed: cfg.seed, error: truncate(e.message, 800), diagnostics: diagnostics };
    }
    throw e;
  }
  const elapsedMs = Date.now() - t0;
  const summary = tracker.summary();

  return {
    ok: true,
    code: 'OK',
    bench: 'hexago-bench',
    version: VERSION,
    mode: 'style',
    size: cfg.size,
    points: R.n,
    players: cfg.players,
    games: cfg.games,
    seed: cfg.seed,
    openingMoves: cfg.opening,
    engines: {
      A: { path: pathA, version: loadedA.version || null, sha256: loadedA.sha256 || null, budgetMs: cfg.time, maxPlayouts: cfg.playouts || null },
      B: loadedB ? { path: path.resolve(process.cwd(), cfg.engine2), version: loadedB.version || null, sha256: loadedB.sha256 || null, budgetMs: cfg.time2, maxPlayouts: cfg.playouts2 || null } : null,
    },
    elapsedMs: elapsedMs,
    totals: {
      illegal: ctx.illegal,
      crashes: ctx.crashes,
      mutatedInput: ctx.mutatedInput,
      moves: summary.gameLength.totalMoves,
      avgGameLength: summary.gameLength.mean,
      passes: summary.passes.total,
      resignations: summary.resignations.total,
    },
    style: summary,
    warnings: warnings,
    diagnostics: diagnostics,
    gameLog: tracker.gameLog.map(function (g) {
      return {
        game: g.game, seats: g.seatKeys.slice(1), endReason: g.endReason, moves: g.totalMoves, boardMoves: g.boardMovesTotal,
        passes: g.passes, resignations: g.resignations, firstPass: g.firstPass,
        eyeFills: g.eyeFills, territoryFills: g.territoryFills, selfAdjacent: g.selfAdjacent,
        scores: g.scores, winners: g.winners, durationMs: g.durationMs,
      };
    }),
  };
}

function playStyleGame(ctx, gi) {
  const R = ctx.R, cfg = ctx.cfg, tracker = ctx.tracker;
  const state = R.newState(cfg.players);
  const seatKeys = [null];
  const agents = [null];
  for (let p = 1; p <= cfg.players; p++) {
    let key = 'A';
    if (ctx.twoEngine) {
      const oddSeat = (p % 2 === 1);
      key = ((gi % 2 === 0) === oddSeat) ? 'A' : 'B';
    }
    seatKeys[p] = key;
    const api = key === 'A' ? ctx.engineA : ctx.engineB;
    const engine = api.createEngine({ size: cfg.size, playerCount: cfg.players });
    if (!engine || typeof engine.think !== 'function') throw new Error('createEngine() did not return a usable engine (' + key + ')');
    agents[p] = {
      key: key,
      engine: engine,
      budget: key === 'A' ? ctx.timeA : ctx.timeB,
      cap: key === 'A' ? ctx.playA : ctx.playB,
      moves: 0,
      ms: 0,
      visitsSum: 0,
      visitsN: 0,
      playoutsSum: 0,
      playoutsN: 0,
    };
  }
  tracker.beginGame(gi, seatKeys);

  let endReason = null;
  let forfeitSeat = -1;
  const maxMoves = Math.max(200, R.n * 8);
  while (!state.over) {
    if (state.moves > maxMoves) { endReason = 'max-moves'; break; }
    const p = state.turn;
    const rec = agents[p];
    const key = rec.key;
    const view = {
      board: state.board.slice(),
      turn: state.turn,
      playerCount: state.playerCount,
      out: state.out.slice(),
      passes: state.passes,
      seen: state.seen.slice(),
    };
    const snapBoard = view.board.slice();
    const snapSeen = view.seen.slice();
    const options = { budgetMs: rec.budget, seed: rules.mixSeed(cfg.seed, gi, state.moves, state.turn) };
    if (rec.cap) options.maxPlayouts = rec.cap;
    const t0 = process.hrtime.bigint();
    let res = null;
    let threw = null;
    try { res = rec.engine.think(view, options); } catch (e) { threw = e; }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    rec.moves++;
    rec.ms += ms;
    if (threw) { ctx.crashes++; endReason = 'crash'; forfeitSeat = p; break; }
    if (!res || !Number.isInteger(res.move)) { ctx.illegal++; endReason = 'illegal'; forfeitSeat = p; break; }
    let mutated = view.seen.length !== snapSeen.length;
    if (!mutated) for (let i = 0; i < snapBoard.length; i++) if (view.board[i] !== snapBoard[i]) { mutated = true; break; }
    if (mutated) ctx.mutatedInput++;
    const stats = {
      ms: ms,
      visits: Number.isFinite(res.visits) ? res.visits : null,
      playouts: Number.isFinite(res.playouts) ? res.playouts : null,
    };
    if (stats.visits != null) { rec.visitsSum += stats.visits; rec.visitsN++; }
    if (stats.playouts != null) { rec.playoutsSum += stats.playouts; rec.playoutsN++; }

    const move = res.move;
    if (move === -1) {
      tracker.recordPass(state, key);
      if (R.doPass(state)) { endReason = 'pass'; break; }
    } else if (move === -2) {
      if (cfg.players !== 2) { ctx.illegal++; endReason = 'illegal'; forfeitSeat = p; break; }
      tracker.recordResign(key);
      R.resign(state);
      if (state.over) endReason = 'resign';
    } else if (move < 0 || move >= R.n) {
      ctx.illegal++;
      endReason = 'illegal';
      forfeitSeat = p;
      break;
    } else {
      const sim = R.simMove(state.board, move, state.turn, state.seenSet);
      if (!sim) { ctx.illegal++; endReason = 'illegal'; forfeitSeat = p; break; }
      tracker.recordMove(state, move, key, stats);
      const applied = R.applyMove(state, move);
      tracker.recordCapture(key, applied.cap.length);
    }
  }

  let summary = null;
  if (endReason === 'pass') summary = R.finishByPass(state);
  else if (endReason === 'resign' || endReason === 'max-moves' || !endReason) summary = R.scoreState(state);

  const outcomes = new Array(cfg.players + 1).fill('L');
  if (!summary) {
    for (let q = 1; q <= cfg.players; q++) outcomes[q] = (state.out[q] || q === forfeitSeat) ? 'L' : 'W';
  } else {
    for (let q = 1; q <= cfg.players; q++) {
      if (state.out[q]) outcomes[q] = 'L';
      else if (summary.top.indexOf(q) >= 0) outcomes[q] = summary.top.length === 1 ? 'W' : 'D';
    }
  }
  tracker.endGame({
    endReason: endReason || 'pass',
    outcomes: outcomes,
    scores: summary ? summary.scores.slice(1) : null,
    winners: summary ? summary.top.slice() : null,
  });
}

function formatStyleReport(res) {
  const L = [];
  const st = res.style;
  L.push('=== HEXAGO bench v' + res.version + ' | style ===');
  L.push('node ' + res.diagnostics.node + ' | size ' + res.size + ' (' + res.points + ' pts) | players ' + res.players +
    ' | games ' + res.games + ' | seed ' + res.seed + ' | opening window ' + res.openingMoves + ' moves');
  L.push(styleEngineLine('engine A', res.engines.A));
  if (res.engines.B) L.push(styleEngineLine('engine B', res.engines.B));
  for (let k = 0; k < res.warnings.length; k++) L.push('warning: ' + res.warnings[k]);
  L.push('');

  const gl = st.gameLength;
  const reasons = Object.keys(st.endReasons).map(function (k) { return k + ' ' + st.endReasons[k]; }).join(', ');
  L.push('games ' + st.games + ' | avg length ' + gl.mean + ' moves incl. passes (min ' + gl.min + ', max ' + gl.max + '; board moves ' + gl.boardMovesMean + ')' + (reasons ? ' | end: ' + reasons : ''));
  L.push('illegal ' + res.totals.illegal + ' | crashes ' + res.totals.crashes + ' | input mutations ' + res.totals.mutatedInput);
  L.push('');

  const ov = st.overall;
  L.push("self-adjacency (move touches mover's own stones)");
  L.push('  phase        moves  adjacent    rate');
  const phases = ['opening', 'middlegame', 'endgame'];
  for (let k = 0; k < phases.length; k++) {
    const ph = ov.phases[phases[k]];
    L.push('  ' + pad(phases[k], 11) + padLeft(ph.moves, 6) + padLeft(ph.selfAdjacent, 8) + padLeft(ph.selfAdjacentRatePct == null ? '-' : ph.selfAdjacentRatePct, 8) + '%');
  }
  L.push('  ' + pad('overall', 11) + padLeft(ov.moves, 6) + padLeft(ov.selfAdjacent, 8) + padLeft(ov.selfAdjacentRatePct, 8) + '%');
  L.push('');

  const od = ov.openingDistances;
  L.push('opening distances (first ' + res.openingMoves + ' moves; n=' + od.moves + ', nearest-own n=' + od.nearestOwn.n + ', no own stones ' + od.nearestOwn.missing + ')');
  L.push('  nearest own : mean ' + od.nearestOwn.mean + '   hist ' + fmtHist(od.nearestOwn.hist, od.nearestOwn.histMax));
  L.push('  centre      : mean ' + od.centre.mean + '   hist ' + fmtHist(od.centre.hist, od.centre.histMax));
  const byMove = st.openingDistByMove.map(function (m) {
    return m.moveIdx + ': own ' + (m.nearestOwnMean == null ? '-' : m.nearestOwnMean) + '/c' + m.centreMean;
  });
  L.push('  by move     : ' + byMove.join(' | '));
  L.push('');

  L.push('own-area fills');
  L.push('  own eye fills              : ' + ov.eyeFills + ' (' + ov.eyeFillRatePct + '% of moves)  opening ' + ov.phases.opening.eyeFills + ' / middle ' + ov.phases.middlegame.eyeFills + ' / endgame ' + ov.phases.endgame.eyeFills);
  L.push('  own settled-territory fills: ' + ov.territoryFills + ' (' + ov.territoryFillRatePct + '%)  opening ' + ov.phases.opening.territoryFills + ' / middle ' + ov.phases.middlegame.territoryFills + ' / endgame ' + ov.phases.endgame.territoryFills);
  L.push('  captures                   : ' + ov.captures + ' (' + (ov.moves ? Math.round((1000 * ov.captures) / ov.moves) / 1000 : 0) + '/move)');
  L.push('');

  const fp = st.passes.firstPass;
  L.push('passes       : ' + st.passes.total + ' total (' + st.passes.perGame + '/game) | first pass avg move ' + fp.meanMoveIdx + ', empty points ' + fp.meanEmptyFracPct + '% (min ' + fp.minEmptyFracPct + '%, max ' + fp.maxEmptyFracPct + '%)');
  L.push('resignations : ' + st.resignations.total + ' (' + st.resignations.perGame + '/game)');
  const div = st.openingDiversity;
  L.push('opening diversity: ' + div.games + ' games -> ' + div.distinctFirstMoves + ' distinct first moves, ' + div.distinctOpeningSequences + ' distinct first-' + div.openingSequenceLength + ' sequences');
  L.push('  first moves: ' + div.firstMoves.map(function (e) { return e.move + e.coord + 'x' + e.count; }).join(', '));
  L.push('  sample openings: ' + div.sampleSequences.map(function (seq) { return '[' + seq.join(' ') + ']'; }).join(' '));
  L.push('');

  L.push('timing (engine-reported visits/playouts; wall clock)');
  L.push('  A: ' + ov.timing.msPerMove + ' ms/move, visits ' + ov.timing.avgVisits + '/mv, playouts ' + ov.timing.avgPlayouts + '/mv');
  if (st.perEngine.B) {
    const b = st.perEngine.B;
    L.push('  B: ' + b.timing.msPerMove + ' ms/move, visits ' + b.timing.avgVisits + '/mv, playouts ' + b.timing.avgPlayouts + '/mv');
    L.push('');
    L.push('per-engine style');
    L.push('  eng   moves  selfAdj  eyeFill  terrFill  eyeFills  terrFills  passes  record');
    const keys = ['A', 'B'];
    for (let k = 0; k < keys.length; k++) {
      const e = st.perEngine[keys[k]];
      L.push('  ' + pad(keys[k], 4) + padLeft(e.moves, 6) + padLeft(e.selfAdjacentRatePct, 8) + '%' + padLeft(e.eyeFillRatePct, 8) + '%' + padLeft(e.territoryFillRatePct, 9) + '%' +
        padLeft(e.eyeFills, 10) + padLeft(e.territoryFills, 11) + padLeft(e.passes, 8) + '  ' +
        (e.record ? e.record.W + '-' + e.record.L + '-' + e.record.D + ' (' + e.record.winratePct + '%)' : '-'));
    }
  }
  L.push('');
  L.push('elapsed ' + round(res.elapsedMs / 1000, 2) + ' s (' + round(res.elapsedMs / 1000 / res.games, 2) + ' s/game)');
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// failure report (no game numbers available)
// ---------------------------------------------------------------------------

function formatFailureReport(res) {
  const L = [];
  L.push('=== HEXAGO bench v' + VERSION + ' | ' + (res.mode || '?') + ' ===');
  L.push('FAILED: ' + (res.code || 'ERROR'));
  if (res.error) L.push('error : ' + res.error);
  const d = res.diagnostics || {};
  if (d.engineFile) L.push('engine: ' + d.engineFile.path + (d.engineFile.exists ? '' : ' (missing)') + (d.engineFile.reason ? ' -- ' + d.engineFile.reason : ''));
  if (d.engineVerify) {
    for (let k = 0; k < d.engineVerify.errors.length; k++) L.push('  ! ' + d.engineVerify.errors[k]);
    for (let k = 0; k < d.engineVerify.warnings.length; k++) L.push('  ~ ' + d.engineVerify.warnings[k]);
  }
  if (d.extraction) L.push('old-AI extraction: ' + d.extraction.strategy);
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// probe mode
// ---------------------------------------------------------------------------

function randomLegalState(R, players, targetStones, rng) {
  const st = R.newState(players);
  let guard = 0;
  while (st.moves < targetStones && guard++ < targetStones * 40) {
    const lm = R.legalMoves(st);
    if (!lm.length) break;
    R.applyMove(st, lm[Math.floor(rng() * lm.length)]);
  }
  return st;
}

function stonesOn(st) {
  let n = 0;
  for (let i = 0; i < st.board.length; i++) if (st.board[i]) n++;
  return n;
}

function buildProbePositions(R, cfg, rng) {
  const geo = R.geo;
  const idx = function (q, r) { return geo.M[q + ',' + r]; };
  const positions = [];

  positions.push({ name: 'empty board (opening)', playerCount: 2, state: R.newState(2) });

  const off = geo.side - 3;
  if (off >= 1) {
    const coords = [[off, 0], [off, -off], [-off, 0], [-off, off], [0, -off], [0, off]];
    const ids = coords.map(function (c) { return idx(c[0], c[1]); }).filter(function (v) { return v !== undefined; });
    if (ids.length >= 4) {
      const st = R.newState(2);
      for (let k = 0; k < ids.length; k++) st.board[ids[k]] = (k % 2) + 1;
      positions.push({ name: 'san-san opening (6 stones)', playerCount: 2, state: st });
    }
  }

  // one-move capture available: white stone at a corner, two black stones leave its last liberty
  const r0 = -(geo.side - 1);
  const corner = idx(0, r0);
  const b1 = idx(1, r0);
  const b2 = idx(0, r0 + 1);
  const capPoint = idx(-1, r0 + 1);
  if (corner !== undefined && b1 !== undefined && b2 !== undefined && capPoint !== undefined) {
    const st = R.newState(2);
    st.board[corner] = 2;
    st.board[b1] = 1;
    st.board[b2] = 1;
    positions.push({ name: 'capture available (atari)', playerCount: 2, state: st, expectCapturePoint: capPoint });
  }

  positions.push({ name: '3-player midgame (~25 stones)', playerCount: 3, state: randomLegalState(R, 3, Math.floor(R.n * 0.22), rng) });
  positions.push({ name: '2-player late game (~60% stones)', playerCount: 2, state: randomLegalState(R, 2, Math.floor(R.n * 0.6), rng) });
  return positions;
}

function runProbe(cfg) {
  const R = rules.createRules(cfg.size);
  const diagnostics = { node: process.version, engineFile: null, engineVerify: null, oldAI: null };
  const ep = enginePathOf(cfg);
  const loaded = loadNewEngine(ep);
  diagnostics.engineFile = { path: ep, exists: fs.existsSync(ep), version: loaded.version || null, sha256: loaded.sha256 || null, reason: loaded.reason || null };
  if (!loaded.ok) return { ok: false, code: 'ENGINE_UNAVAILABLE', mode: 'probe', size: cfg.size, timeMs: cfg.time, error: loaded.reason, diagnostics: diagnostics };

  let pageHash = null;
  try { pageHash = oldAiLib.createOldAI({ size: cfg.size, seed: cfg.seed, pagePath: cfg.page || undefined }).api.hash; diagnostics.oldAI = 'extracted for hash cross-check'; }
  catch (e) { diagnostics.oldAI = 'unavailable: ' + truncate(e.message, 200); }

  const verify = verifyEngine(loaded.api, R, { players: 2, pageHash: pageHash, seed: cfg.seed });
  diagnostics.engineVerify = verify;
  if (!verify.ok) return { ok: false, code: 'ENGINE_BROKEN', mode: 'probe', size: cfg.size, timeMs: cfg.time, error: 'engine contract checks failed: ' + verify.errors.join(' | '), diagnostics: diagnostics };

  const rng = rules.makeRng(rules.mixSeed(cfg.seed, 0x77, 0x88, 0));
  const positions = buildProbePositions(R, cfg, rng);
  const results = [];
  let ok = true;

  for (let pi = 0; pi < positions.length; pi++) {
    const pos = positions[pi];
    const st = pos.state;
    let engine = null;
    let entry = {
      index: pi + 1,
      name: pos.name,
      playerCount: pos.playerCount,
      turn: st.turn,
      stones: stonesOn(st),
      move: null,
      coord: null,
      legal: false,
      pass: false,
      resign: false,
      reason: null,
      captures: 0,
      visits: null,
      playouts: null,
      winrate: null,
      elapsedMs: null,
      engine: null,
      bestMoves: [],
      mutatedInput: false,
    };
    try {
      engine = loaded.api.createEngine({ size: cfg.size, playerCount: pos.playerCount });
      if (!engine || typeof engine.think !== 'function') throw new Error('createEngine() returned no think()');
      const view = {
        board: st.board.slice(),
        turn: st.turn,
        playerCount: st.playerCount,
        out: st.out.slice(),
        passes: st.passes,
        seen: st.seen.slice(),
      };
      const snapBoard = view.board.slice();
      const snapSeen = view.seen.slice();
      const t0 = process.hrtime.bigint();
      const res = engine.think(view, { budgetMs: cfg.time, seed: rules.mixSeed(cfg.seed, pi + 1, 0x99, 0) });
      entry.elapsedMs = round(Number(process.hrtime.bigint() - t0) / 1e6, 1);
      if (!res || typeof res !== 'object') throw new Error('think() returned ' + String(res));
      entry.move = res.move;
      entry.visits = Number.isFinite(res.visits) ? res.visits : null;
      entry.playouts = Number.isFinite(res.playouts) ? res.playouts : null;
      entry.winrate = Number.isFinite(res.winrate) ? round(res.winrate, 4) : null;
      entry.engine = typeof res.engine === 'string' ? res.engine : null;
      entry.mutatedInput = view.seen.length !== snapSeen.length || snapBoard.some(function (v, i) { return view.board[i] !== v; });
      if (Array.isArray(res.bestMoves)) {
        entry.bestMoves = res.bestMoves.slice(0, 5).map(function (bm) {
          const mv = bm && bm.move;
          return {
            move: mv,
            coord: Number.isInteger(mv) && mv >= 0 && mv < R.n ? coordOf(R, mv) : (mv === -1 ? 'pass' : mv === -2 ? 'resign' : null),
            visits: bm && Number.isFinite(bm.visits) ? bm.visits : null,
            value: bm && Number.isFinite(bm.value) ? round(bm.value, 3) : null,
          };
        });
      }
      const move = res.move;
      if (move === -1) {
        entry.pass = true; entry.legal = true;
      } else if (move === -2) {
        entry.resign = true;
        entry.legal = pos.playerCount === 2;
        if (!entry.legal) entry.reason = 'resign (-2) in a ' + pos.playerCount + '-player game';
      } else if (!Number.isInteger(move) || move < 0 || move >= R.n) {
        entry.reason = 'move out of range / non-integer: ' + String(move);
      } else {
        entry.coord = coordOf(R, move);
        const r = R.tryMove(st, move);
        entry.legal = !!r;
        if (r) entry.captures = r.cap.length;
        else {
          const why = st.board[move] ? 'point already occupied' : (R.simMove(st.board, move, st.turn, new Set()) ? 'superko' : 'suicide/illegal');
          entry.reason = 'illegal move (' + why + ')';
        }
      }
      if (pos.expectCapturePoint != null) entry.expectedCapturePoint = pos.expectCapturePoint === move;
    } catch (e) {
      entry.reason = 'threw: ' + truncate(e && e.message, 300);
      entry.legal = false;
    }
    if (!entry.legal) ok = false;
    if (entry.mutatedInput) { ok = false; entry.reason = (entry.reason ? entry.reason + '; ' : '') + 'engine mutated input state'; }
    results.push(entry);
  }

  return {
    ok: ok,
    code: ok ? 'OK' : 'PROBE_FAILED',
    mode: 'probe',
    size: cfg.size,
    points: R.n,
    seed: cfg.seed,
    timeMs: cfg.time,
    engineVersion: verify.version,
    diagnostics: diagnostics,
    positions: results,
  };
}

function formatProbeReport(res) {
  const L = [];
  L.push('=== HEXAGO bench v' + VERSION + ' | probe ===');
  L.push('size ' + res.size + ' (' + res.points + ' pts) | budget ' + res.timeMs + ' ms | seed ' + res.seed);
  const v = res.diagnostics.engineVerify || { geometry: {}, hash: {}, createEngine: {}, errors: [], warnings: [] };
  L.push('new engine : ' + (res.engineVersion || '(no version tag)') + (res.diagnostics.engineFile && res.diagnostics.engineFile.sha256 ? ' [' + res.diagnostics.engineFile.sha256.slice(0, 12) + ']' : '') + ' | geometry ' + (v.geometry.ok ? 'OK' : 'FAIL') +
    ' | hashBoard ' + (v.hash.ok ? 'OK (' + v.hash.checked + ' vectors, ref ' + v.hash.reference + ')' : 'FAIL') +
    ' | createEngine ' + (v.createEngine && v.createEngine.ok ? 'OK' : 'FAIL'));
  for (let k = 0; k < v.errors.length; k++) L.push('  ! ' + v.errors[k]);
  for (let k = 0; k < v.warnings.length; k++) L.push('  ~ ' + v.warnings[k]);
  L.push('');
  for (let k = 0; k < res.positions.length; k++) {
    const p = res.positions[k];
    const verdict = p.legal ? 'legal=OK' : 'legal=FAIL';
    L.push('[' + p.index + '] ' + p.name + '  (' + p.playerCount + 'P, turn ' + p.turn + ', ' + p.stones + ' stones)');
    L.push('    move ' + (p.pass ? 'pass' : p.resign ? 'resign' : String(p.move) + (p.coord || '')) +
      '  ' + verdict + (p.reason ? '  (' + p.reason + ')' : '') +
      '  pass=' + (p.pass ? 'yes' : 'no') + ' resign=' + (p.resign ? 'yes' : 'no') +
      (p.captures ? '  captures=' + p.captures : '') +
      '  visits=' + p.visits + ' playouts=' + p.playouts + '  ' + p.elapsedMs + 'ms');
    if (p.bestMoves && p.bestMoves.length) {
      L.push('    bestMoves: ' + p.bestMoves.map(function (b) {
        return (b.move === -1 ? 'pass' : b.move === -2 ? 'resign' : b.move + (b.coord || '')) +
          ' v=' + (b.visits == null ? '?' : b.visits);
      }).join('  '));
    }
    if (p.mutatedInput) L.push('    ! engine mutated the input state');
    if (p.expectedCapturePoint != null) L.push('    capture-in-one: chosen=' + (p.expectedCapturePoint ? 'yes' : 'NO'));
  }
  L.push('');
  const legal = res.positions.filter(function (p) { return p.legal; }).length;
  const mutations = res.positions.filter(function (p) { return p.mutatedInput; }).length;
  L.push('probe: ' + legal + '/' + res.positions.length + ' legal, ' + mutations + ' input mutations => ' + (res.ok ? 'PASS' : 'FAIL'));
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main() {
  let cfg;
  try {
    cfg = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error('error: ' + e.message);
    console.error('');
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  if (cfg.help || !cfg.mode) {
    console.log(USAGE);
    process.exitCode = cfg.help ? 0 : 1;
    return;
  }

  const isProbe = cfg.mode === 'probe';
  const isStyle = cfg.mode === 'style';
  let res;
  try {
    res = isProbe ? runProbe(cfg) : (isStyle ? runStyle(cfg) : runMatch(cfg));
  } catch (e) {
    const payload = { ok: false, code: 'FATAL', mode: cfg.mode, error: truncate(e && e.stack || e, 2000) };
    if (cfg.json) process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    else console.error('FATAL: ' + truncate(e && e.stack || e, 2000));
    process.exitCode = 2;
    return;
  }

  if (cfg.json) {
    process.stdout.write(JSON.stringify(res, null, 2) + '\n');
  } else if (res.code === 'ENGINE_UNAVAILABLE') {
    process.stdout.write('new engine not available: ' + res.error + '\n');
    const ud = res.diagnostics || {};
    if (ud.engineA && ud.engineA.path) process.stdout.write('  engine A : ' + ud.engineA.path + (ud.engineA.exists ? '' : ' (missing)') + '\n');
    if (ud.engineB && ud.engineB.path) process.stdout.write('  engine B : ' + ud.engineB.path + (ud.engineB.exists ? '' : ' (missing)') + '\n');
    if (!ud.engineA && !ud.engineB) process.stdout.write('  expected: ' + enginePathOf(cfg) + '\n');
    process.stdout.write('  (--old-vs-random works without the new engine; --engine/--engine2 PATH overrides)\n');
  } else if (res.code === 'PROBE_FAILED' || (isProbe && res.positions)) {
    process.stdout.write(formatProbeReport(res) + '\n');
    if (!res.ok) process.stdout.write('detail: ' + JSON.stringify(res.positions.filter(function (p) { return !p.legal; }).map(function (p) { return { name: p.name, move: p.move, reason: p.reason }; })) + '\n');
  } else if (!res.ok && res.code !== 'RULES_CROSSCHECK_FAILED') {
    process.stdout.write(formatFailureReport(res) + '\n');
  } else if (isStyle) {
    process.stdout.write(formatStyleReport(res) + '\n');
  } else {
    process.stdout.write(formatMatchReport(res) + '\n');
  }

  if (res.code === 'ENGINE_UNAVAILABLE') process.exitCode = 2;
  else if (res.code === 'ENGINE_BROKEN' || res.code === 'OLD_AI_EXTRACTION_FAILED' || res.code === 'OLD_AI_SANITY_FAILED') process.exitCode = 2;
  else if (res.code === 'RULES_CROSSCHECK_FAILED' || res.code === 'PROBE_FAILED') process.exitCode = 3;
  else process.exitCode = res.ok ? 0 : 2;
}

main();
