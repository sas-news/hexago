'use strict';
/**
 * Old-AI extraction sandbox.
 *
 * Reads the OLD AI out of index.html at runtime and runs it inside a `vm`
 * context. The page AI (`aiChoose` + its helpers) is never copied by hand: the
 * source text is sliced out of the page, so the benchmark always measures the
 * AI that actually ships.
 *
 * Robustness: two extraction strategies are attempted,
 *   1. "marker-slices" -- spec strategy: slice from the `// ===== AI` marker to
 *      `const aiSeatOf`, plus the rules block (group/libCount/sim/territory/...)
 *      and any symbol still missing (e.g. `hash`, which lives outside both
 *      markers) located by name anywhere in the file.
 *   2. "named-symbols" -- locate every required function/const by name with a
 *      brace-matched extractor (survives marker/comment edits).
 * Each candidate is evaluated in a fresh vm context; the first one that yields
 * a callable `aiChoose` plus all required helpers wins.
 *
 * The sandbox provides exactly what the page AI expects:
 *   G, P, NB, M, SIDE, seenSet, playerCount, Math (seeded)
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const rules = require('./rules');

const { readPageSource } = require('../../dev/page-source');
// リファクタ後は実装が複数ファイルに分かれているため、既定では連結ソースを読む。
const DEFAULT_PAGE = path.join(__dirname, '..', '..', 'index.html');

/** Symbols the page AI needs to run. `hash` lives outside the marker blocks. */
const REQUIRED_SYMBOLS = [
  'group', 'libCount', 'hash', 'sim', 'territory', 'territoryForBoard',
  'countEyes', 'regionInfo', 'hexDist', 'territoryNowForAI', 'aiChoose',
];

/** Symbols exported from the sandbox for cross-checking / benchmarking. */
const PAGE_API_NAMES = [
  'aiChoose', 'sim', 'territory', 'territoryForBoard', 'group', 'libCount',
  'hash', 'countEyes', 'regionInfo', 'hexDist', 'territoryNowForAI',
  'detectDeadStones',
];

const API_SCRIPT = '[' + PAGE_API_NAMES.map(function (n) {
  return '[' + JSON.stringify(n) + ', typeof ' + n + ' === "function" ? ' + n + ' : null]';
}).join(',') + ']';

// ---------------------------------------------------------------------------
// tiny JS lexer helpers (strings / comments / brace matching)
// ---------------------------------------------------------------------------

function skipString(src, i) {
  const q = src[i];
  if (q === '`') {
    let j = i + 1;
    while (j < src.length) {
      const c = src[j];
      if (c === '\\') { j += 2; continue; }
      if (c === '`') return j + 1;
      if (c === '$' && src[j + 1] === '{') {
        let depth = 1;
        j += 2;
        while (j < src.length && depth > 0) {
          const cc = src[j];
          if (cc === '\\') { j += 2; continue; }
          if (cc === '"' || cc === "'" || cc === '`') { j = skipString(src, j); continue; }
          if (cc === '{') depth++;
          else if (cc === '}') depth--;
          j++;
        }
        continue;
      }
      j++;
    }
    return j;
  }
  let j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') { j += 2; continue; }
    if (c === q) return j + 1;
    if (c === '\n') return j + 1;
    j++;
  }
  return j;
}

function skipComment(src, i) {
  if (src[i] === '/' && src[i + 1] === '/') {
    const j = src.indexOf('\n', i);
    return j < 0 ? src.length : j + 1;
  }
  if (src[i] === '/' && src[i + 1] === '*') {
    const j = src.indexOf('*/', i + 2);
    return j < 0 ? src.length : j + 2;
  }
  return i;
}

function matchBrace(src, openIdx) {
  let depth = 0;
  let i = openIdx;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) { i = skipComment(src, i); continue; }
    if (c === '"' || c === "'" || c === '`') { i = skipString(src, i); continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i + 1; }
    i++;
  }
  return -1;
}

function matchExpressionEnd(src, eqIdx) {
  let i = eqIdx + 1, par = 0, brace = 0, sq = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) { i = skipComment(src, i); continue; }
    if (c === '"' || c === "'" || c === '`') { i = skipString(src, i); continue; }
    if (c === '(') par++;
    else if (c === ')') par--;
    else if (c === '{') brace++;
    else if (c === '}') brace--;
    else if (c === '[') sq++;
    else if (c === ']') sq--;
    else if (c === ';' && par === 0 && brace === 0 && sq === 0) return i + 1;
    i++;
  }
  return -1;
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function extractFunctionCode(src, name) {
  const re = new RegExp('(?:^|[^\\w$.])function\\s+' + escapeRe(name) + '\\s*\\(', 'g');
  const m = re.exec(src);
  if (!m) return null;
  const start = m.index + m[0].lastIndexOf('function');
  const brace = src.indexOf('{', start);
  if (brace < 0) return null;
  const end = matchBrace(src, brace);
  if (end < 0) return null;
  return src.slice(start, end);
}

function extractConstCode(src, name) {
  const re = new RegExp('(?:^|[^\\w$.])(?:const|let|var)\\s+' + escapeRe(name) + '\\s*=', 'g');
  const m = re.exec(src);
  if (!m) return null;
  const start = m.index + m[0].length - m[0].trimStart().length + 0;
  const eq = m.index + m[0].length - 1;
  const end = matchExpressionEnd(src, eq);
  if (end < 0) return null;
  return src.slice(m.index + m[0].search(/(?:const|let|var)/), end);
}

function extractSymbol(src, name) {
  return extractFunctionCode(src, name) || extractConstCode(src, name);
}

function hasDeclaration(code, name) {
  const esc = escapeRe(name);
  try {
    return new RegExp('(?:^|[^\\w$.])function\\s+' + esc + '\\s*\\(').test(code) ||
      new RegExp('(?:^|[^\\w$.])(?:const|let|var)\\s+' + esc + '\\s*=').test(code);
  } catch (e) { return false; }
}

// ---------------------------------------------------------------------------
// source extraction
// ---------------------------------------------------------------------------

function findAiStart(src) {
  const m = /\/\/\s*=+\s*AI\b[^\n]*/.exec(src);
  return m ? m.index : -1;
}

function findRulesStart(src) {
  const m = /\/\/\s*=+\s*(?:ルール|Rules|RULE)/.exec(src);
  return m ? m.index : -1;
}

function findAiEnd(src) {
  const m = /(?:const|let|var)\s+aiSeatOf\b/.exec(src);
  return m ? m.index : -1;
}

/**
 * Produce the JS source for the old AI. Returns
 * { code, strategy, appended, markers, attempts } and throws when nothing usable
 * can be assembled (with a diagnostic message).
 */
function extractOldAISource(html) {
  const named = {};
  for (let k = 0; k < REQUIRED_SYMBOLS.length; k++) named[REQUIRED_SYMBOLS[k]] = extractSymbol(html, REQUIRED_SYMBOLS[k]);

  const aiStart = findAiStart(html);
  const aiEnd = aiStart >= 0 ? findAiEnd(html) : -1;
  const rulesStart = findRulesStart(html);
  const markers = { aiStart: aiStart, aiEnd: aiEnd, rulesStart: rulesStart };
  const attempts = [];

  if (aiStart >= 0 && aiEnd > aiStart) {
    const aiBlock = html.slice(aiStart, aiEnd);
    const rulesBlock = (rulesStart >= 0 && rulesStart < aiStart) ? html.slice(rulesStart, aiStart) : '';
    let code = (rulesBlock ? rulesBlock + '\n' : '') + aiBlock;
    const appended = [];
    for (let k = 0; k < REQUIRED_SYMBOLS.length; k++) {
      const name = REQUIRED_SYMBOLS[k];
      if (!hasDeclaration(code, name) && named[name]) { code += '\n' + named[name] + '\n'; appended.push(name); }
    }
    attempts.push({ strategy: 'marker-slices', code: code, appended: appended });
  }

  if (REQUIRED_SYMBOLS.every(function (n) { return !!named[n]; })) {
    attempts.push({
      strategy: 'named-symbols',
      code: REQUIRED_SYMBOLS.map(function (n) { return named[n]; }).join('\n'),
      appended: REQUIRED_SYMBOLS.slice(),
    });
  }

  if (!attempts.length) {
    const missing = REQUIRED_SYMBOLS.filter(function (n) { return !named[n]; });
    throw new Error('could not extract old AI from page source: markers=' + JSON.stringify(markers) +
      ', missing symbols=' + JSON.stringify(missing));
  }
  return { attempts: attempts, markers: markers };
}

// ---------------------------------------------------------------------------
// vm sandbox
// ---------------------------------------------------------------------------

function makeSandboxMath(rng) {
  const m = Object.create(Math);
  m.random = rng;
  return m;
}

function evaluateCandidate(candidate, geo, rng) {
  const mathObj = makeSandboxMath(rng);
  const sandbox = {
    G: null,
    P: geo.P,
    NB: geo.NB,
    M: geo.M,
    SIDE: geo.side,
    playerCount: 2,
    seenSet: new Set(),
    Math: mathObj,
    console: { log: function () {}, warn: function () {}, error: function () {}, info: function () {} },
  };
  vm.createContext(sandbox, { name: 'hexago-old-ai' });
  vm.runInContext(candidate.code, sandbox, { filename: 'index.html#old-ai', timeout: 15000 });

  const raw = vm.runInContext(API_SCRIPT, sandbox);
  const api = {};
  for (let k = 0; k < raw.length; k++) api[raw[k][0]] = raw[k][1];

  if (typeof api.aiChoose !== 'function') throw new Error('aiChoose is not callable after evaluation');
  const missing = REQUIRED_SYMBOLS.filter(function (n) { return typeof api[n] !== 'function'; });
  if (missing.length) throw new Error('missing callable helpers: ' + missing.join(','));

  return {
    sandbox: sandbox,
    api: api,
    math: mathObj,
    setRandom: function (fn) { mathObj.random = fn; },
  };
}

/**
 * Extract + evaluate the old AI.
 * @param {object} opts {pagePath?, html?, seed?}
 */
function createOldAI(opts) {
  const o = opts || {};
  const pagePath = o.pagePath || null;
  const html = o.html || (pagePath ? fs.readFileSync(pagePath, 'utf8') : readPageSource(path.resolve(__dirname, '..', '..')));
  const geo = rules.geometry(o.size || 9);
  const rng = rules.makeRng(o.seed || 1);
  const extraction = extractOldAISource(html);
  const failures = [];
  for (let k = 0; k < extraction.attempts.length; k++) {
    const cand = extraction.attempts[k];
    try {
      const built = evaluateCandidate(cand, geo, rng);
      built.extraction = {
        strategy: cand.strategy,
        appended: cand.appended,
        markers: extraction.markers,
        attempts: extraction.attempts.map(function (a) { return a.strategy; }),
      };
      built.pagePath = pagePath;
      built.htmlBytes = html.length;
      return built;
    } catch (e) {
      failures.push({ strategy: cand.strategy, error: String(e && e.message || e) });
    }
  }
  const msg = 'failed to evaluate old AI: ' + failures.map(function (f) { return f.strategy + ' -> ' + f.error; }).join(' | ');
  const err = new Error(msg);
  err.failures = failures;
  throw err;
}

// ---------------------------------------------------------------------------
// calling / checking the old AI
// ---------------------------------------------------------------------------

/** Run aiChoose on a benchmark state. The page AI only reads G, so we point it at the live state. */
function callOldAI(oldAI, state) {
  const sb = oldAI.sandbox;
  sb.G = state;
  sb.seenSet = state.seenSet;
  sb.playerCount = state.playerCount;
  return oldAI.api.aiChoose();
}

/** Page-side territory for a board (needs the sandbox G). */
function pageTerritory(oldAI, state) {
  const sb = oldAI.sandbox;
  sb.G = state;
  sb.playerCount = state.playerCount;
  return oldAI.api.territory();
}

function randomBoard(R, players, rng) {
  const b = new Array(R.n).fill(0);
  const count = Math.floor(rng() * R.n * 0.55);
  for (let k = 0; k < count; k++) {
    b[Math.floor(rng() * R.n)] = 1 + Math.floor(rng() * players);
  }
  return b;
}

function arraysEqual(a, b, from) {
  if (a.length !== b.length) return false;
  for (let i = from || 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Sanity: the extracted AI is callable and returns -1 / -2 / a legal board index.
 * Also records wall time per call.
 */
function sanityCheckAI(oldAI, R, opts) {
  const o = opts || {};
  const rng = rules.makeRng(o.seed || 7);
  const out = { ok: true, calls: 0, invalid: [], samples: [], totalMs: 0, firstLegalIndex: false };
  const states = [R.newState(2), R.newState(2), R.newState(3)];

  // fill two states with plausible early-game stones
  for (let si = 1; si < states.length; si++) {
    const st = states[si];
    const moves = 3 + Math.floor(rng() * 6);
    const lm = R.legalMoves(st);
    for (let k = 0; k < moves && k < lm.length; k++) {
      const idx = lm[Math.floor(rng() * lm.length)];
      R.applyMove(st, idx);
    }
  }
  for (let s = 0; s < states.length; s++) {
    const st = states[s];
    const t0 = process.hrtime.bigint();
    let move;
    try {
      move = callOldAI(oldAI, st);
    } catch (e) {
      out.ok = false;
      out.invalid.push({ state: s, error: String(e && e.stack || e) });
      continue;
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    out.calls++;
    out.totalMs += ms;
    const isInt = Number.isInteger(move);
    const legal = move === -1 || move === -2 ||
      (isInt && move >= 0 && move < R.n && !!R.tryMove(st, move));
    if (move >= 0) out.firstLegalIndex = out.firstLegalIndex || (isInt && legal);
    if (!legal) { out.ok = false; out.invalid.push({ state: s, move: move, ms: ms }); }
    out.samples.push({ state: s, move: move, legal: legal, ms: Number(ms.toFixed(3)) });
  }
  return out;
}

/**
 * Cross-check the independent rules implementation against the page's own
 * sim/territory/countEyes/detectDeadStones on random game positions.
 * This is what makes the benchmark numbers trustworthy.
 */
function crossCheckRules(oldAI, R, opts) {
  const o = opts || {};
  const rng = rules.makeRng(o.seed || 12345);
  const out = {
    ok: true,
    positions: 0,
    movesChecked: 0,
    territoryChecked: 0,
    deadChecked: 0,
    hashChecked: 0,
    hashOk: true,
    mismatches: [],
  };

  function fail(kind, detail) {
    out.ok = false;
    if (out.mismatches.length < 8) out.mismatches.push({ kind: kind, detail: detail });
  }

  // 1) hash() must equal page hash()
  if (typeof oldAI.api.hash === 'function') {
    const boards = [R.newState(2).board];
    for (let t = 0; t < 6; t++) boards.push(randomBoard(R, 2 + (t % 3), rng));
    for (let k = 0; k < boards.length; k++) {
      out.hashChecked++;
      if (oldAI.api.hash(boards[k]) !== rules.hash(boards[k])) {
        out.hashOk = false;
        fail('hash', { sample: k, page: oldAI.api.hash(boards[k]), ours: rules.hash(boards[k]) });
      }
    }
  } else {
    out.hashOk = false;
    fail('hash', 'page hash() not available');
  }
  if (!out.hashOk) return out;

  // 2) simulate random games with our rules, then compare legality + scoring
  const positions = o.positions || 6;
  for (let pi = 0; pi < positions; pi++) {
    const st = R.newState(2 + (pi % 3));
    const plies = 6 + Math.floor(rng() * 28);
    for (let k = 0; k < plies && !st.over; k++) {
      const lm = R.legalMoves(st);
      if (!lm.length) break;
      R.applyMove(st, lm[Math.floor(rng() * lm.length)]);
      if (st.passes >= 0 && st.phase !== 'playing') break;
    }
    testPosition(oldAI, R, st, out, fail);
    out.positions++;
  }
  return out;
}

function testPosition(oldAI, R, st, out, fail) {
  const sb = oldAI.sandbox;
  sb.G = st;
  sb.seenSet = st.seenSet;
  sb.playerCount = st.playerCount;

  // move legality
  for (let i = 0; i < R.n; i++) {
    if (st.board[i]) continue;
    let ours = false, theirs = false;
    try { ours = !!R.simMove(st.board, i, st.turn, st.seenSet); } catch (e) { fail('sim-throw-ours', { i: i, error: String(e.message) }); }
    try { theirs = !!oldAI.api.sim(st.board, i, st.turn); } catch (e) { fail('sim-throw-page', { i: i, error: String(e.message) }); }
    out.movesChecked++;
    if (ours !== theirs) fail('sim', { turn: st.turn, point: i, ours: ours, page: theirs, stones: st.board.filter(Boolean).length });
  }

  // territory
  try {
    const tPage = oldAI.api.territory();
    const tOurs = R.territoryOf(st.board, st.playerCount);
    out.territoryChecked++;
    if (!arraysEqual(tPage, tOurs, 0)) fail('territory', { turn: st.turn, page: tPage, ours: tOurs });
  } catch (e) {
    fail('territory-throw', { error: String(e.message) });
  }

  // dead-stone detection (page helper, present when the rules block was sliced)
  if (typeof oldAI.api.detectDeadStones === 'function') {
    try {
      const dPage = Array.from(oldAI.api.detectDeadStones()).sort(function (a, b) { return a - b; });
      const dOurs = R.detectDeadStones(st).sort(function (a, b) { return a - b; });
      out.deadChecked++;
      if (dPage.length !== dOurs.length || dPage.some(function (v, i) { return v !== dOurs[i]; })) {
        fail('dead', { page: dPage, ours: dOurs });
      }
    } catch (e) {
      fail('dead-throw', { error: String(e.message) });
    }
  }
}

module.exports = {
  DEFAULT_PAGE: DEFAULT_PAGE,
  REQUIRED_SYMBOLS: REQUIRED_SYMBOLS,
  extractOldAISource: extractOldAISource,
  createOldAI: createOldAI,
  callOldAI: callOldAI,
  pageTerritory: pageTerritory,
  sanityCheckAI: sanityCheckAI,
  crossCheckRules: crossCheckRules,
};
