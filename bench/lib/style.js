'use strict';
/**
 * Behaviour / "style" metrics for self-played HEXAGO engines.
 *
 * Used by `node bench/bench.js --style ...`. Measures the behaviours that were
 * reported as unnatural for the old MCTS build, so engine versions can be
 * compared objectively:
 *
 *   - self-adjacency rate of board moves (mover places next to own stones),
 *     split into opening / middlegame / endgame
 *   - opening distances: for the first `openingMoves` moves, distance from the
 *     played point to the mover's nearest own stone and to the board centre
 *   - own-eye fills and own-settled-territory fills, using local
 *     page-equivalent implementations of `countEyes` / `territory`
 *   - passes, first-pass empty-point fraction, resignations, game lengths
 *   - opening diversity (distinct first moves / first-12 sequences over games)
 *   - per-engine W/L/D (two-engine mode) and timing/visits/playouts
 *
 * Phases: opening = game move 1..openingMoves (default 12);
 *         endgame   = after the opening AND (empty points <= 25% of the board
 *                     OR at least one pass has happened);
 *         middlegame = everything else.
 */

function countEmpty(board) {
  let n = 0;
  for (let i = 0; i < board.length; i++) if (!board[i]) n++;
  return n;
}

/** Distance to the nearest stone of `color`, or null when the mover has none. */
function nearestOwnDistance(R, board, point, color) {
  const P = R.geo.P;
  const q0 = P[point][0], r0 = P[point][1];
  let best = null;
  for (let i = 0; i < board.length; i++) {
    if (board[i] !== color) continue;
    const dq = P[i][0] - q0, dr = P[i][1] - r0;
    const d = Math.max(Math.abs(dq), Math.abs(dr), Math.abs(dq + dr));
    if (best === null || d < best) best = d;
  }
  return best;
}

/**
 * All empty points that are eyes of `color`'s groups, page-countEyes-equivalent:
 * an empty point all of whose neighbours are stones of `color`.
 * (The page requires >=3 neighbours, true for every hex point we use.)
 */
function eyePointSet(R, board, color) {
  const NB = R.geo.NB;
  const eyes = new Set();
  for (let i = 0; i < board.length; i++) {
    if (board[i] !== color) continue;
    const nbs = NB[i];
    for (let k = 0; k < nbs.length; k++) {
      const p = nbs[k];
      if (board[p] || eyes.has(p)) continue;
      const pn = NB[p];
      if (pn.length < 3) continue;
      let allOwn = true;
      for (let j = 0; j < pn.length; j++) if (board[pn[j]] !== color) { allOwn = false; break; }
      if (allOwn) eyes.add(p);
    }
  }
  return eyes;
}

/**
 * Page-`territory`-equivalent: is `point`'s empty region bordered only by
 * stones of `color`? (That is the mover's own settled territory.)
 */
function ownSoleRegion(R, board, point, color) {
  const NB = R.geo.NB;
  const vis = new Set([point]);
  const queue = [point];
  const cols = new Set();
  for (let k = 0; k < queue.length; k++) {
    const nbs = NB[queue[k]];
    for (let j = 0; j < nbs.length; j++) {
      const nb = nbs[j];
      if (!board[nb]) {
        if (!vis.has(nb)) { vis.add(nb); queue.push(nb); }
      } else cols.add(board[nb]);
    }
  }
  return cols.size === 1 && cols.has(color);
}

/** Phase for a move/pass about to be played (state is the position *before* it). */
function classifyPhase(R, state, moveIdx, openingMoves) {
  if (moveIdx <= openingMoves) return 'opening';
  const emptyFrac = countEmpty(state.board) / R.n;
  if (state.passes > 0 || emptyFrac <= 0.25) return 'endgame';
  return 'middlegame';
}

const PHASES = ['opening', 'middlegame', 'endgame'];

function newBucket() {
  const phases = {};
  for (let k = 0; k < PHASES.length; k++) phases[PHASES[k]] = { moves: 0, selfAdjacent: 0, eyeFills: 0, territoryFills: 0, passes: 0 };
  return {
    moves: 0,
    selfAdjacent: 0,
    adjacentEnemy: 0,
    captures: 0,
    eyeFills: 0,
    territoryFills: 0,
    passes: 0,
    resignations: 0,
    phases: phases,
    opening: {
      moves: 0,
      nearestOwnSum: 0,
      nearestOwnN: 0,
      nearestOwnMissing: 0,
      centerSum: 0,
      nearestOwnHist: [],
      centerHist: [],
    },
    timing: { msSum: 0, timedMoves: 0, visitsSum: 0, visitsN: 0, playoutsSum: 0, playoutsN: 0 },
    firstMoves: [],
    record: { seats: 0, W: 0, L: 0, D: 0 },
  };
}

function bumpBucket(b, feat, stats) {
  b.moves++;
  if (feat.selfAdjacent) b.selfAdjacent++;
  if (feat.adjacentEnemy) b.adjacentEnemy++;
  if (feat.isEye) b.eyeFills++;
  if (feat.isTerritory) b.territoryFills++;
  const ph = b.phases[feat.phase];
  ph.moves++;
  if (feat.selfAdjacent) ph.selfAdjacent++;
  if (feat.isEye) ph.eyeFills++;
  if (feat.isTerritory) ph.territoryFills++;
  if (feat.phase === 'opening') {
    b.opening.moves++;
    if (feat.ownDistance == null) b.opening.nearestOwnMissing++;
    else { b.opening.nearestOwnSum += feat.ownDistance; b.opening.nearestOwnN++; b.opening.nearestOwnHist.push(feat.ownDistance); }
    b.opening.centerSum += feat.centerDistance;
    b.opening.centerHist.push(feat.centerDistance);
  }
  if (stats) {
    if (Number.isFinite(stats.ms)) { b.timing.msSum += stats.ms; b.timing.timedMoves++; }
    if (Number.isFinite(stats.visits)) { b.timing.visitsSum += stats.visits; b.timing.visitsN++; }
    if (Number.isFinite(stats.playouts)) { b.timing.playoutsSum += stats.playouts; b.timing.playoutsN++; }
  }
}

function makeHist(values, maxBin) {
  const hist = [];
  for (let k = 0; k <= maxBin; k++) hist.push(0);
  hist.push(0); // overflow bucket (maxBin+1)
  for (let k = 0; k < values.length; k++) {
    const v = values[k];
    hist[v > maxBin ? maxBin + 1 : v]++;
  }
  return hist;
}

function mean(values) {
  if (!values.length) return null;
  let s = 0;
  for (let k = 0; k < values.length; k++) s += values[k];
  return s / values.length;
}

function finalizeBucket(b, R) {
  b = b || newBucket();
  const phases = {};
  for (let k = 0; k < PHASES.length; k++) {
    const p = PHASES[k];
    const src = b.phases[p];
    phases[p] = {
      moves: src.moves,
      selfAdjacent: src.selfAdjacent,
      selfAdjacentRatePct: src.moves ? Math.round((1000 * src.selfAdjacent) / src.moves) / 10 : null,
      eyeFills: src.eyeFills,
      eyeFillRatePct: src.moves ? Math.round((1000 * src.eyeFills) / src.moves) / 10 : null,
      territoryFills: src.territoryFills,
      territoryFillRatePct: src.moves ? Math.round((1000 * src.territoryFills) / src.moves) / 10 : null,
      passes: src.passes,
    };
  }
  const radius = R.geo.side - 1;
  const histMax = Math.min(6, radius);
  return {
    moves: b.moves,
    selfAdjacent: b.selfAdjacent,
    selfAdjacentRatePct: b.moves ? Math.round((1000 * b.selfAdjacent) / b.moves) / 10 : null,
    adjacentEnemyRatePct: b.moves ? Math.round((1000 * b.adjacentEnemy) / b.moves) / 10 : null,
    captures: b.captures,
    eyeFills: b.eyeFills,
    eyeFillRatePct: b.moves ? Math.round((1000 * b.eyeFills) / b.moves) / 10 : null,
    territoryFills: b.territoryFills,
    territoryFillRatePct: b.moves ? Math.round((1000 * b.territoryFills) / b.moves) / 10 : null,
    passes: b.passes,
    resignations: b.resignations,
    phases: phases,
    openingDistances: {
      moves: b.opening.moves,
      nearestOwn: {
        mean: b.opening.nearestOwnN ? Math.round((10 * b.opening.nearestOwnSum) / b.opening.nearestOwnN) / 10 : null,
        n: b.opening.nearestOwnN,
        missing: b.opening.nearestOwnMissing,
        hist: makeHist(b.opening.nearestOwnHist, histMax),
        histMax: histMax,
      },
      centre: {
        mean: b.opening.moves ? Math.round((10 * b.opening.centerSum) / b.opening.moves) / 10 : null,
        n: b.opening.moves,
        hist: makeHist(b.opening.centerHist, radius),
        histMax: radius,
      },
    },
    timing: {
      msPerMove: b.timing.timedMoves ? Math.round((10 * b.timing.msSum) / b.timing.timedMoves) / 10 : null,
      avgVisits: b.timing.visitsN ? Math.round((10 * b.timing.visitsSum) / b.timing.visitsN) / 10 : null,
      avgPlayouts: b.timing.playoutsN ? Math.round((10 * b.timing.playoutsSum) / b.timing.playoutsN) / 10 : null,
    },
    firstMoves: b.firstMoves.slice(),
    record: b.record.seats ? {
      seats: b.record.seats,
      W: b.record.W,
      L: b.record.L,
      D: b.record.D,
      winratePct: Math.round((1000 * b.record.W) / b.record.seats) / 10,
    } : null,
  };
}

/**
 * Create a tracker.
 * @param R rules facade (bench/lib/rules.js)
 * @param opts {openingMoves, engineKeys, twoEngine}
 */
function createStyleTracker(R, opts) {
  const o = opts || {};
  const openingMoves = o.openingMoves || 12;
  const twoEngine = !!o.twoEngine;
  const engineKeys = o.engineKeys || ['A'];
  const overall = newBucket();
  const byEngine = {};
  for (let k = 0; k < engineKeys.length; k++) byEngine[engineKeys[k]] = newBucket();
  const firstMoveCounts = [];
  const firstMoveByKey = {};
  for (let k = 0; k < engineKeys.length; k++) firstMoveByKey[engineKeys[k]] = [];
  const sequences = [];       // first 12 move indices per game
  const sequencesCoords = []; // same, as coordinates (for the human report/haiku)
  const firstPasses = [];
  const distByMoveIdx = {};   // moveIdx -> {n, ownSum, ownN, centreSum}
  const gameLog = [];
  let game = null;

  function beginGame(gameIndex, seatKeys) {
    game = {
      game: gameIndex,
      seatKeys: seatKeys.slice(),
      startTs: Date.now(),
      boardMoves: 0,
      boardMovesTotal: 0,
      totalMoves: 0,
      passes: 0,
      resignations: 0,
      firstPass: null,
      eyeFills: 0,
      territoryFills: 0,
      selfAdjacent: 0,
      moveSeq: [],
      firstMoveByKey: {},
      durationMs: 0,
      endReason: null,
      scores: null,
      winners: null,
    };
  }

  function recordMove(state, move, key, stats) {
    const board = state.board;
    const mover = state.turn;
    const moveIdx = state.moves + 1;
    const phase = classifyPhase(R, state, moveIdx, openingMoves);
    const nbs = R.geo.NB[move];
    let selfAdjacent = false, adjacentEnemy = false;
    for (let k = 0; k < nbs.length; k++) {
      const v = board[nbs[k]];
      if (v === mover) selfAdjacent = true;
      else if (v) adjacentEnemy = true;
    }
    const ownDistance = nearestOwnDistance(R, board, move, mover);
    const feat = {
      phase: phase,
      moveIdx: moveIdx,
      selfAdjacent: selfAdjacent,
      adjacentEnemy: adjacentEnemy,
      isEye: eyePointSet(R, board, mover).has(move),
      isTerritory: ownSoleRegion(R, board, move, mover),
      ownDistance: ownDistance,
      centerDistance: R.geo.dist(move, R.geo.center),
    };
    bumpBucket(overall, feat, stats);
    if (byEngine[key]) bumpBucket(byEngine[key], feat, stats);

    game.boardMovesTotal++;
    game.totalMoves++;
    game.moveSeq.push(move);
    if (!(key in game.firstMoveByKey)) game.firstMoveByKey[key] = move;
    game.eyeFills += feat.isEye ? 1 : 0;
    game.territoryFills += feat.isTerritory ? 1 : 0;
    game.selfAdjacent += selfAdjacent ? 1 : 0;

    if (moveIdx <= openingMoves) {
      const slot = distByMoveIdx[moveIdx] || (distByMoveIdx[moveIdx] = { n: 0, ownSum: 0, ownN: 0, centreSum: 0 });
      slot.n++;
      slot.centreSum += feat.centerDistance;
      if (ownDistance != null) { slot.ownSum += ownDistance; slot.ownN++; }
    }
  }

  function recordCapture(key, count) {
    if (!count) return;
    overall.captures += count;
    if (byEngine[key]) byEngine[key].captures += count;
  }

  function recordPass(state, key) {
    const moveIdx = state.moves + 1;
    const phase = classifyPhase(R, state, moveIdx, openingMoves);
    const emptyFrac = countEmpty(state.board) / R.n;
    overall.passes++;
    overall.phases[phase].passes++;
    if (byEngine[key]) { byEngine[key].passes++; byEngine[key].phases[phase].passes++; }
    game.passes++;
    game.totalMoves++;
    if (!game.firstPass) {
      game.firstPass = { moveIdx: moveIdx, emptyFrac: Math.round(emptyFrac * 1000) / 1000 };
      firstPasses.push({ game: game.game, moveIdx: moveIdx, emptyFrac: emptyFrac });
    }
  }

  function recordResign(key) {
    overall.resignations++;
    if (byEngine[key]) byEngine[key].resignations++;
    game.resignations++;
    game.totalMoves++;
  }

  function endGame(info) {
    game.endReason = info.endReason;
    game.durationMs = Date.now() - game.startTs;
    game.scores = info.scores || null;
    game.winners = info.winners || null;
    if (twoEngine && info.outcomes) {
      for (let p = 1; p < info.outcomes.length; p++) {
        const key = game.seatKeys[p];
        const b = byEngine[key];
        if (!b) continue;
        b.record.seats++;
        if (info.outcomes[p] === 'W') b.record.W++;
        else if (info.outcomes[p] === 'D') b.record.D++;
        else b.record.L++;
      }
    }
    if (game.moveSeq.length) {
      const first = game.moveSeq[0];
      overall.firstMoves.push(first);
      firstMoveCounts.push({ move: first, game: game.game });
      const seq = game.moveSeq.slice(0, openingMoves);
      sequences.push(seq.join(','));
      sequencesCoords.push(seq.map(function (m) { return R.geo.P[m][0] + ',' + R.geo.P[m][1]; }));
      for (let k = 0; k < engineKeys.length; k++) {
        const key = engineKeys[k];
        const fm = game.firstMoveByKey[key];
        if (fm !== undefined) firstMoveByKey[key].push(fm);
      }
    }
    gameLog.push(game);
  }

  function countMap(list) {
    const m = new Map();
    for (let k = 0; k < list.length; k++) m.set(list[k], (m.get(list[k]) || 0) + 1);
    return Array.from(m.entries()).sort(function (a, b) { return b[1] - a[1]; });
  }

  function summary() {
    const gameLengths = gameLog.map(function (g) { return g.totalMoves; });
    const boardLengths = gameLog.map(function (g) { return g.boardMovesTotal; });
    const endReasons = {};
    for (let k = 0; k < gameLog.length; k++) {
      const r = gameLog[k].endReason || 'unknown';
      endReasons[r] = (endReasons[r] || 0) + 1;
    }
    const firstMoveEntries = countMap(overall.firstMoves).map(function (e) {
      return { move: e[0], coord: '(' + R.geo.P[e[0]][0] + ',' + R.geo.P[e[0]][1] + ')', count: e[1] };
    });
    const perEngineOut = {};
    for (let k = 0; k < engineKeys.length; k++) {
      const key = engineKeys[k];
      const fin = finalizeBucket(byEngine[key], R);
      fin.firstMoves = countMap(firstMoveByKey[key]).map(function (e) {
        return { move: e[0], coord: '(' + R.geo.P[e[0]][0] + ',' + R.geo.P[e[0]][1] + ')', count: e[1] };
      });
      perEngineOut[key] = fin;
    }
    const distByMove = [];
    for (let idx = 1; idx <= openingMoves; idx++) {
      const s = distByMoveIdx[idx];
      if (!s) continue;
      distByMove.push({
        moveIdx: idx,
        n: s.n,
        nearestOwnMean: s.ownN ? Math.round((10 * s.ownSum) / s.ownN) / 10 : null,
        centreMean: s.n ? Math.round((10 * s.centreSum) / s.n) / 10 : null,
      });
    }
    return {
      games: gameLog.length,
      openingMoves: openingMoves,
      phaseRule: 'opening = first ' + openingMoves + ' moves; endgame = empty<=25% or after a pass; else middlegame',
      overall: finalizeBucket(overall, R),
      perEngine: perEngineOut,
      gameLength: {
        mean: gameLengths.length ? Math.round(10 * mean(gameLengths)) / 10 : null,
        min: gameLengths.length ? Math.min.apply(null, gameLengths) : null,
        max: gameLengths.length ? Math.max.apply(null, gameLengths) : null,
        boardMovesMean: boardLengths.length ? Math.round(10 * mean(boardLengths)) / 10 : null,
        totalMoves: gameLengths.reduce(function (a, b) { return a + b; }, 0),
      },
      endReasons: endReasons,
      passes: {
        total: overall.passes,
        perGame: gameLog.length ? Math.round((100 * overall.passes) / gameLog.length) / 100 : null,
        firstPass: {
          count: firstPasses.length,
          meanMoveIdx: firstPasses.length ? Math.round(10 * mean(firstPasses.map(function (p) { return p.moveIdx; }))) / 10 : null,
          meanEmptyFracPct: firstPasses.length ? Math.round(1000 * mean(firstPasses.map(function (p) { return p.emptyFrac; }))) / 10 : null,
          minEmptyFracPct: firstPasses.length ? Math.round(1000 * Math.min.apply(null, firstPasses.map(function (p) { return p.emptyFrac; }))) / 10 : null,
          maxEmptyFracPct: firstPasses.length ? Math.round(1000 * Math.max.apply(null, firstPasses.map(function (p) { return p.emptyFrac; }))) / 10 : null,
        },
      },
      resignations: {
        total: overall.resignations,
        perGame: gameLog.length ? Math.round((100 * overall.resignations) / gameLog.length) / 100 : null,
      },
      openingDiversity: {
        games: gameLog.length,
        distinctFirstMoves: new Set(overall.firstMoves).size,
        firstMoves: firstMoveEntries,
        distinctOpeningSequences: new Set(sequences).size,
        openingSequenceLength: openingMoves,
        sampleSequences: sequencesCoords.slice(0, 3),
      },
      openingDistByMove: distByMove,
    };
  }

  return {
    R: R,
    openingMoves: openingMoves,
    beginGame: beginGame,
    recordMove: recordMove,
    recordCapture: recordCapture,
    recordPass: recordPass,
    recordResign: recordResign,
    endGame: endGame,
    summary: summary,
    gameLog: gameLog,
  };
}

module.exports = {
  PHASES: PHASES,
  countEmpty: countEmpty,
  classifyPhase: classifyPhase,
  eyePointSet: eyePointSet,
  ownSoleRegion: ownSoleRegion,
  nearestOwnDistance: nearestOwnDistance,
  createStyleTracker: createStyleTracker,
};
