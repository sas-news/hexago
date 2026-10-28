/*!
 * HEXAGO AI engine — self-contained MCTS/UCT player for hexagonal Go.
 * Version: 1.0.0
 *
 * Runs in Node (module.exports) and inside a Web Worker (`self.HexagoAI`).
 * No dependencies, no DOM, no network, no eval.  ES2017-compatible.
 *
 * Public API:
 *   geometry(size) -> { size, side, n, P, NB, center, dist(i,j) }
 *   createEngine({ size, playerCount }) -> engine
 *   engine.think(state, options) -> result
 *   hashBoard(board) -> number   (identical to index.html cyrb53 board hash)
 *   version
 *
 * Rules are a 1:1 port of index.html build()/sim()/territory()/finishScore():
 * hex board of odd size 9/13/19/25 (61/127/271/469 points), capture Go,
 * suicide illegal, superko checked only on captures, pass ends the game when
 * all active players pass, score = territory + stones.
 *
 * This file is the single source of truth for the page build: dev/inline-engine.js
 * copies it verbatim into index.html inside the #ai-engine-src script tag.
 */
(function (globalScope) {
  'use strict';

  var VERSION = 'hexago-mcts/1.2.0';

  /* ------------------------------------------------------------------ *
   *  Utilities
   * ------------------------------------------------------------------ */

  function nowMs() {
    if (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') return performance.now();
    return Date.now();
  }

  // mulberry32 — small, fast, deterministic PRNG.
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // cyrb53 board hash — MUST stay byte-identical to index.html hash(a).
  function hashBoard(a) {
    var h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (var i = 0; i < a.length; i++) {
      h1 = Math.imul(h1 ^ a[i], 2654435761);
      h2 = Math.imul(h2 ^ a[i], 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
  }

  function sizeFromN(n) {
    // points = 3*side*(side-1)+1, side = (size+1)/2
    for (var size = 3; size <= 99; size += 2) {
      var side = (size + 1) / 2;
      if (3 * side * (side - 1) + 1 === n) return size;
    }
    return -1;
  }

  /* ------------------------------------------------------------------ *
   *  Geometry (identical index order to index.html build(n))
   * ------------------------------------------------------------------ */

  var GEO_CACHE = Object.create(null);
  var DIRS = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]];

  function geometry(size) {
    size = size | 0;
    var cached = GEO_CACHE[size];
    if (cached) return cached;
    if (size < 3 || (size & 1) !== 1) throw new Error('HEXAGO geometry: size must be odd and >= 3');
    var side = (size + 1) / 2, radius = side - 1;
    var map = Object.create(null), P = [], q, r, i, d;
    for (r = -radius; r < side; r++) {
      for (q = -radius; q < side; q++) {
        if (Math.abs(q + r) <= radius) { map[q + ',' + r] = P.length; P.push([q, r]); }
      }
    }
    var n = P.length;
    var NB = new Array(n);
    var nbOff = new Int32Array(n + 1);
    var flat = [];
    for (i = 0; i < n; i++) {
      var adj = [];
      for (d = 0; d < 6; d++) {
        var j = map[(P[i][0] + DIRS[d][0]) + ',' + (P[i][1] + DIRS[d][1])];
        if (j !== undefined) adj.push(j);
      }
      NB[i] = adj;
      nbOff[i] = flat.length;
      for (var k = 0; k < adj.length; k++) flat.push(adj[k]);
    }
    nbOff[n] = flat.length;
    var g = {
      size: size,
      side: side,
      n: n,
      P: P,
      NB: NB,
      center: map['0,0'],
      nbOff: nbOff,
      nbFlat: new Int32Array(flat),
      dist: function (a, b) {
        var dq = P[a][0] - P[b][0], dr = P[a][1] - P[b][1];
        return Math.max(Math.abs(dq), Math.abs(dr), Math.abs(dq + dr));
      }
    };
    GEO_CACHE[size] = g;
    return g;
  }

  /* ------------------------------------------------------------------ *
   *  Engine
   * ------------------------------------------------------------------ */

  var DEFAULT_BUDGET_MS = 2500;

  function createEngine(opts) {
    opts = opts || {};
    var geo = geometry(opts.size | 0);
    var n = geo.n;
    var nbOff = geo.nbOff;
    var nbFlat = geo.nbFlat;
    var engPC = opts.playerCount | 0;
    if (engPC < 2) engPC = 2;
    if (engPC > 6) engPC = 6;

    var UCT_C = opts.uctC != null ? +opts.uctC : 1.1;
    var RAVE_K = opts.raveK != null ? +opts.raveK : 1000;
    var MAX_DEPTH = Math.max(40, 2 * n + 40);
    var MAX_PLAYOUT_STEPS = 2 * n + 30;

    /* ---------------- shared group-scan scratch ---------------- */
    var scanStamp = new Int32Array(n), scanId = 0;
    var libStamp = new Int32Array(n), libId = 0;
    var grpBuf = new Int16Array(n), grpN = 0, lastLibs = 0, lastLibPt = -1;
    var applyStamp = new Int32Array(n), applyId = 0;
    var saveStamp = new Int32Array(n), saveId = 0;

    var capCap = 4 * n + 64;
    var capPos = new Int16Array(capCap), capColor = new Int8Array(capCap), capCount = 0;
    var lastCapStart = 0, lastCapEnd = 0, lastKo = -1, lastOwnLibs = 0;

    var srcBoard = new Int8Array(n);    // root position copy
    var simBoard = new Int8Array(n);    // root legality simulation
    var treeBoard = new Int8Array(n);   // traversal position
    var cmpBoard = new Int8Array(n);    // tree-reuse comparison
    var rootCap = new Int16Array(n);    // captures per root legal move (ordering)

    var geomDistCenter = new Int16Array(n);
    for (var gd = 0; gd < n; gd++) geomDistCenter[gd] = geo.dist(gd, geo.center);

    var outFlags = new Uint8Array(8);
    var winArr = new Float64Array(8), valArr = new Float64Array(8);
    var outSc = new Int16Array(8);

    var pcCur = engPC;      // players in current think()
    var activeCount = pcCur;
    var rootMover = 1;
    var seenSet = null;

    /* ---------------- group helpers ---------------- */

    function scanGroup(board, start, color) {
      var sid = ++scanId;
      var lid = ++libId;
      grpN = 0;
      grpBuf[grpN++] = start;
      scanStamp[start] = sid;
      var libs = 0, libPt = -1;
      for (var gi = 0; gi < grpN; gi++) {
        var s = grpBuf[gi];
        for (var j = nbOff[s], je = nbOff[s + 1]; j < je; j++) {
          var t = nbFlat[j], v = board[t];
          if (v === color) {
            if (scanStamp[t] !== sid) { scanStamp[t] = sid; grpBuf[grpN++] = t; }
          } else if (v === 0 && libStamp[t] !== lid) {
            libStamp[t] = lid; libs++; libPt = t;
          }
        }
      }
      lastLibs = libs; lastLibPt = libPt;
    }

    // Apply (assumed-empty) move for the tree / root simulation.
    // Returns 1 if legal, 0 if suicide. Captured stones are pushed on the shared
    // capture stack so the caller can undo with undoMove().
    function applyMove(board, move, p) {
      board[move] = p;
      var capStart = capCount;
      var aid = ++applyId;
      var j, je, t, c, gi, k, captured = 0;
      for (j = nbOff[move], je = nbOff[move + 1]; j < je; j++) {
        t = nbFlat[j]; c = board[t];
        if (c === 0 || c === p || applyStamp[t] === aid) continue;
        scanGroup(board, t, c);
        gi = grpN;
        for (k = 0; k < gi; k++) applyStamp[grpBuf[k]] = aid;
        if (lastLibs === 0) {
          for (k = 0; k < gi; k++) { capPos[capCount] = grpBuf[k]; capColor[capCount] = c; capCount++; captured++; }
        }
      }
      if (captured > 0) {
        for (k = capStart; k < capCount; k++) board[capPos[k]] = 0;
        lastCapStart = capStart; lastCapEnd = capCount;
        lastKo = captured === 1 ? capPos[capStart] : -1;
        lastOwnLibs = 2;
        return 1;
      }
      scanGroup(board, move, p);
      if (lastLibs === 0) {
        board[move] = 0;
        lastCapStart = capStart; lastCapEnd = capCount; lastKo = -1; lastOwnLibs = 0;
        return 0;
      }
      lastCapStart = capStart; lastCapEnd = capCount; lastKo = -1; lastOwnLibs = lastLibs;
      return 1;
    }

    function undoMove(board, move, capStart, capEnd) {
      board[move] = 0;
      for (var k = capStart; k < capEnd; k++) board[capPos[k]] = capColor[k];
      capCount = capStart;
    }

    /* ---------------- scoring (territory + stones) ---------------- */

    var regStamp = new Int32Array(n), regId = 0, regQueue = new Int16Array(n);
    var scoreScratch = new Int16Array(9);

    function scoreBoardInto(board, out, pc) {
      var i, j, je, t, p, qn, s, qi, v, col, mixed, rid;
      for (p = 1; p <= pc; p++) out[p] = 0;
      for (i = 0; i < n; i++) { t = board[i]; if (t !== 0 && t <= pc) out[t]++; }
      rid = ++regId;
      for (i = 0; i < n; i++) {
        if (board[i] !== 0 || regStamp[i] === rid) continue;
        qn = 0; regQueue[qn++] = i; regStamp[i] = rid;
        col = 0; mixed = false;
        for (qi = 0; qi < qn; qi++) {
          s = regQueue[qi];
          for (j = nbOff[s], je = nbOff[s + 1]; j < je; j++) {
            t = nbFlat[j]; v = board[t];
            if (v === 0) {
              if (regStamp[t] !== rid) { regStamp[t] = rid; regQueue[qn++] = t; }
            } else if (col === 0) { col = v; } else if (v !== col) { mixed = true; }
          }
        }
        if (!mixed && col !== 0 && col <= pc) out[col] += qn;
      }
      out[0] = 0;
      return out;
    }

    /* ---------------- end-of-game dead-stone cleanup (page detectDeadStones) ---------------- */
    var dsBoard = new Int8Array(n);
    var dsSeen = new Int32Array(n), dsSeenId = 0;
    var dsGMark = new Int32Array(n), dsGroupId = 0;
    var dsLibs = new Int16Array(n);
    var dsDead = new Int16Array(n), dsDeadN = 0;
    var dsEyeStamp = new Int32Array(n), dsEyeId = 0;

    // Group + full liberty list (page group()+libCount with the actual points).
    function scanGroupFull(board, start, color) {
      var sid = ++scanId, lid = ++libId;
      grpN = 0; grpBuf[grpN++] = start; scanStamp[start] = sid;
      var libN = 0;
      for (var gi = 0; gi < grpN; gi++) {
        var st = grpBuf[gi];
        for (var j = nbOff[st], je = nbOff[st + 1]; j < je; j++) {
          var t = nbFlat[j], v = board[t];
          if (v === color) { if (scanStamp[t] !== sid) { scanStamp[t] = sid; grpBuf[grpN++] = t; } }
          else if (v === 0 && libStamp[t] !== lid) { libStamp[t] = lid; dsLibs[libN++] = t; }
        }
      }
      lastLibs = libN;
      return libN;
    }

    // Page countEyes(b, g, color): empty neighbours of the group whose own
    // neighbours are all the group's colour (or the group itself).
    function groupEyeCount(board, color, gid) {
      var eid = ++dsEyeId, eyes = 0;
      for (var k = 0; k < grpN; k++) {
        var st = grpBuf[k];
        for (var j = nbOff[st], je = nbOff[st + 1]; j < je; j++) {
          var l = nbFlat[j];
          if (board[l] !== 0 || dsEyeStamp[l] === eid) continue;
          if (nbOff[l + 1] - nbOff[l] < 3) continue;
          var ok = true;
          for (var j2 = nbOff[l], je2 = nbOff[l + 1]; j2 < je2; j2++) {
            var x = nbFlat[j2], v = board[x];
            if (v !== color && dsGMark[x] !== gid) { ok = false; break; }
          }
          if (ok) { dsEyeStamp[l] = eid; eyes++; }
        }
      }
      return eyes;
    }

    // Conservative dead-stone removal, byte-for-byte page detectDeadStones()
    // semantics: no eyes, liberties <= 2, every liberty surrounded by exactly
    // one enemy colour with <= 1 friendly stone, and one enemy colour adjacent.
    function removeDeadStones(board) {
      dsSeenId++; dsDeadN = 0;
      var i, k, j, je, s, v, gN, libN, ok, enemyCol, mixed;
      for (i = 0; i < n; i++) {
        var color = board[i];
        if (color === 0 || dsSeen[i] === dsSeenId) continue;
        libN = scanGroupFull(board, i, color);
        gN = grpN;
        dsGroupId++;
        var gid = dsGroupId;
        for (k = 0; k < gN; k++) { dsSeen[grpBuf[k]] = dsSeenId; dsGMark[grpBuf[k]] = gid; }
        if (libN === 0 || libN > 2) continue;
        if (groupEyeCount(board, color, gid) > 0) continue;
        ok = true;
        for (k = 0; k < libN && ok; k++) {
          var l = dsLibs[k], around = 0, friendly = 0;
          var nlen = nbOff[l + 1] - nbOff[l];
          for (j = nbOff[l], je = nbOff[l + 1]; j < je; j++) {
            v = board[nbFlat[j]];
            if (v === 0) continue;
            if (v === color) friendly++; else around++;
          }
          if (!(around >= Math.max(2, nlen - 2) && friendly <= 1)) ok = false;
        }
        if (!ok) continue;
        enemyCol = 0; mixed = false;
        for (k = 0; k < gN && !mixed; k++) {
          s = grpBuf[k];
          for (j = nbOff[s], je = nbOff[s + 1]; j < je; j++) {
            v = board[nbFlat[j]];
            if (v === 0 || v === color) continue;
            if (enemyCol === 0) enemyCol = v; else if (v !== enemyCol) { mixed = true; break; }
          }
        }
        if (mixed || enemyCol === 0) continue;
        for (k = 0; k < gN; k++) dsDead[dsDeadN++] = grpBuf[k];
      }
      for (k = 0; k < dsDeadN; k++) board[dsDead[k]] = 0;
      return dsDeadN;
    }

    function deadStonesImpl(board) {
      dsBoard.set(board);
      removeDeadStones(dsBoard);
      var out = [];
      for (var i = 0; i < n; i++) if (board[i] !== 0 && dsBoard[i] === 0) out.push(i);
      return out;
    }

    // Exact page legality for one move on a scratch board (superko included).
    function simExactLegal(move, turn) {
      simBoard.set(srcBoard);
      capCount = 0;
      if (!applyMove(simBoard, move, turn)) return 0;
      var cc = lastCapEnd - lastCapStart;
      if (cc > 0 && seenSet !== null && seenSet.has(hashBoard(simBoard))) return 0;
      return 1;
    }

    function genRootLegal(turn) {
      var list = [], i;
      for (i = 0; i < n; i++) {
        if (srcBoard[i] !== 0) continue;
        if (simExactLegal(i, turn)) { list.push(i); rootCap[i] = lastCapEnd - lastCapStart; }
        else rootCap[i] = 0;
      }
      capCount = 0;
      list.push(-1); // pass is always legal
      return list;
    }

    function countSavesAt(board, move, p) {
      var sid = ++saveId, cnt = 0;
      for (var j = nbOff[move], je = nbOff[move + 1]; j < je; j++) {
        var s = nbFlat[j];
        if (board[s] !== p || saveStamp[s] === sid) continue;
        scanGroup(board, s, p);
        var gi = grpN;
        for (var k = 0; k < gi; k++) saveStamp[grpBuf[k]] = sid;
        if (lastLibs === 1 && lastLibPt === move) cnt++;
      }
      return cnt;
    }

    // Ascending heuristic order; untried.pop() therefore tries the best move first.
    function orderRootMoves(moves, turn, allowPass, passEnds) {
      var scored = [], mi, mv, sc, own, opp, empty, j, je, v;
      for (mi = 0; mi < moves.length; mi++) {
        mv = moves[mi];
        if (mv === -1) {
          if (!allowPass) continue;
          sc = passEnds ? 1e6 : -1e9; // passing can end the game
        }
        else {
          sc = rootCap[mv] * 1000;
          sc += countSavesAt(srcBoard, mv, turn) * 140;
          own = 0; opp = 0; empty = 0;
          for (j = nbOff[mv], je = nbOff[mv + 1]; j < je; j++) {
            v = srcBoard[nbFlat[j]];
            if (v === turn) own++; else if (v !== 0) opp++; else empty++;
          }
          sc += own * 6 + opp * 5 + (6 - empty) * 0.5 + (n - geomDistCenter[mv]) * 0.12 + rng() * 0.4;
        }
        scored.push([sc, mv]);
      }
      // Deterministic: jitter comes from the seeded rng, ties break on move index.
      scored.sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
      var out = new Array(scored.length);
      for (mi = 0; mi < scored.length; mi++) out[mi] = scored[mi][1];
      if (out.length === 0) out.push(-1);
      return out;
    }

    /* ================================================================== *
     *  Rollout ("playout") policy
     * ================================================================== */

    var pboard = new Int8Array(n);
    var empList = new Int16Array(n), empPos = new Int16Array(n), empCount = 0;
    var candList = new Int16Array(n), candCount = 0;
    var gStamp = new Int32Array(n);
    var gLibs = new Int16Array(n), gLibPt = new Int16Array(n), gSize = new Int16Array(n);
    var turnId = 0;
    var pcapCap = 4 * n + 64;
    var pcapPos = new Int16Array(pcapCap), pcapColor = new Int8Array(pcapCap), pcapCount = 0;
    var stoneCnt = new Int16Array(8);
    var plyKo = -1, plyPasses = 0, plyMover = 0;
    var plyLastMove = -1, plyPrevMove = -1;
    var anaList = new Int16Array(24), anaCount = 0;
    var anaMark = new Int32Array(n), anaId = 0;
    var pLastCap = 0, pLastKo = -1, pLastOwnLibs = 0;
    var tBestCap = -1, tBestCapSize = 0, tBestSave = -1, tBestSaveSize = 0;
    var rng = mulberry32(1);
    var amafMark = new Int32Array(n), amafWho = new Int8Array(n), amafStamp = 0;

    function playApply(move, p) {
      pboard[move] = p;
      var cs = pcapCount;
      var aid = ++applyId;
      var j, je, t, c, gi, k, captured = 0;
      for (j = nbOff[move], je = nbOff[move + 1]; j < je; j++) {
        t = nbFlat[j]; c = pboard[t];
        if (c === 0 || c === p || applyStamp[t] === aid) continue;
        scanGroup(pboard, t, c);
        gi = grpN;
        for (k = 0; k < gi; k++) applyStamp[grpBuf[k]] = aid;
        if (lastLibs === 0) {
          for (k = 0; k < gi; k++) { pcapPos[pcapCount] = grpBuf[k]; pcapColor[pcapCount] = c; pcapCount++; captured++; }
        }
      }
      if (captured > 0) {
        for (k = cs; k < pcapCount; k++) pboard[pcapPos[k]] = 0;
        pLastCap = captured;
        pLastKo = captured === 1 ? pcapPos[cs] : -1;
        pLastOwnLibs = 2;
        return 1;
      }
      scanGroup(pboard, move, p);
      if (lastLibs === 0) {
        pboard[move] = 0; pcapCount = cs;
        pLastCap = 0; pLastKo = -1; pLastOwnLibs = 0;
        return 0;
      }
      pLastCap = 0; pLastKo = -1; pLastOwnLibs = lastLibs;
      return 1;
    }

    function playUndo(move, cs) {
      pboard[move] = 0;
      for (var k = cs; k < pcapCount; k++) pboard[pcapPos[k]] = pcapColor[k];
      pcapCount = cs;
    }

    function removeEmpty(e) {
      var pos = empPos[e];
      var last = empList[--empCount];
      empList[pos] = last;
      empPos[last] = pos;
    }

    function isOwnEye(e, p) {
      for (var j = nbOff[e], je = nbOff[e + 1]; j < je; j++) if (pboard[nbFlat[j]] !== p) return 0;
      return 1;
    }

    // Tactical scan of ONE candidate point: does playing it capture an enemy
    // group in atari, or save an own group in atari?  Group liberty info is
    // cached per turn, keyed by stone index.
    function tacticScan(p, e, tid) {
      var j, je, k, s, c, x, gi, libs, lp;
      for (j = nbOff[e], je = nbOff[e + 1]; j < je; j++) {
        s = nbFlat[j]; c = pboard[s];
        if (c === 0) continue;
        if (gStamp[s] !== tid) {
          scanGroup(pboard, s, c);
          gi = grpN; libs = lastLibs; lp = lastLibPt;
          for (k = 0; k < gi; k++) { x = grpBuf[k]; gStamp[x] = tid; gLibs[x] = libs; gLibPt[x] = lp; gSize[x] = gi; }
        } else { gi = gSize[s]; libs = gLibs[s]; lp = gLibPt[s]; }
        if (libs === 1 && lp === e) {
          if (c === p) { if (gi > tBestSaveSize) { tBestSave = e; tBestSaveSize = gi; } }
          else { if (gi > tBestCapSize) { tBestCap = e; tBestCapSize = gi; } }
        }
      }
    }

    // Build the local candidate list for this turn and pick a small set of
    // candidates for tactical analysis.
    //   n <= 127 (9x9/13x13): analyse every local candidate (strongest, still fast)
    //   larger boards: analyse only moves around the last two moves plus a few
    //   random candidates (keeps light playouts cheap on 19x19/25x25)
    var FULL_ANALYSIS_LIMIT = 127;
    function analyzeTurn(p) {
      var tid = ++turnId;
      candCount = 0; tBestCap = -1; tBestCapSize = 0; tBestSave = -1; tBestSaveSize = 0;
      var ei, e, j, je, local;
      for (ei = 0; ei < empCount; ei++) {
        e = empList[ei];
        local = 0;
        for (j = nbOff[e], je = nbOff[e + 1]; j < je; j++) if (pboard[nbFlat[j]] !== 0) { local = 1; break; }
        if (local) candList[candCount++] = e;
      }
      if (candCount === 0 && empCount > 0) {
        for (ei = 0; ei < empCount; ei++) candList[candCount++] = empList[ei];
      }
      // --- choose tactical candidates ---
      if (n <= FULL_ANALYSIS_LIMIT) {
        for (ei = 0; ei < candCount; ei++) tacticScan(p, candList[ei], tid);
        return;
      }
      anaId++;
      anaCount = 0;
      var lm = plyLastMove, pm = plyPrevMove, k2;
      if (lm >= 0) {
        for (j = nbOff[lm], je = nbOff[lm + 1]; j < je; j++) {
          var t = nbFlat[j];
          if (pboard[t] === 0 && anaMark[t] !== anaId) { anaMark[t] = anaId; if (anaCount < 24) anaList[anaCount++] = t; }
        }
      }
      if (pm >= 0) {
        for (j = nbOff[pm], je = nbOff[pm + 1]; j < je; j++) {
          var t2 = nbFlat[j];
          if (pboard[t2] === 0 && anaMark[t2] !== anaId) { anaMark[t2] = anaId; if (anaCount < 24) anaList[anaCount++] = t2; }
        }
      }
      // top up with a random sample of candidates
      var want = 12, tries = 0;
      while (anaCount < want && candCount > 0 && tries < 24) {
        var e2 = candList[(rng() * candCount) | 0];
        tries++;
        if (anaMark[e2] === anaId) continue;
        anaMark[e2] = anaId;
        anaList[anaCount++] = e2;
      }
      for (k2 = 0; k2 < anaCount; k2++) tacticScan(p, anaList[k2], tid);
    }

    function tryAccept(p, e) {
      if (pboard[e] !== 0) return 0;
      if (e === plyKo) return 0;
      var cs = pcapCount;
      if (!playApply(e, p)) { pcapCount = cs; return 0; }
      // Reject self-atari (own group left with a single liberty) unless it captured.
      if (pLastCap === 0 && pLastOwnLibs === 1 && rng() < 0.95) { playUndo(e, cs); return 0; }
      stoneCnt[p]++;
      for (var k = cs; k < pcapCount; k++) stoneCnt[pcapColor[k]]--;
      removeEmpty(e);
      amafMark[e] = amafStamp; amafWho[e] = p;
      plyKo = pLastKo;
      plyPrevMove = plyLastMove;
      plyLastMove = e;
      return 1;
    }

    // One rollout turn. Returns 1 if a stone was placed, 0 if passing.
    function playoutTurn(p) {
      analyzeTurn(p);
      if (tBestCap >= 0 && rng() < 0.9) { if (tryAccept(p, tBestCap)) return 1; }
      if (tBestSave >= 0 && rng() < 0.85) { if (tryAccept(p, tBestSave)) return 1; }
      if (candCount > 0) {
        var a, e;
        for (a = 0; a < 8; a++) {
          e = candList[(rng() * candCount) | 0];
          if (isOwnEye(e, p)) continue;
          if (tryAccept(p, e)) return 1;
        }
        for (a = 0; a < candCount; a++) { e = candList[a]; if (tryAccept(p, e)) return 1; }
      }
      return 0;
    }

    function runPlayout(startMover, startKo, startPasses) {
      var i, j, je, t, v;
      pboard.set(treeBoard);
      empCount = 0;
      for (i = 0; i < n; i++) if (pboard[i] === 0) { empPos[i] = empCount; empList[empCount++] = i; }
      pcapCount = 0;
      for (i = 1; i <= pcCur; i++) stoneCnt[i] = 0;
      for (i = 0; i < n; i++) { v = pboard[i]; if (v !== 0) stoneCnt[v]++; }
      plyKo = startKo; plyPasses = startPasses; plyMover = startMover;
      plyLastMove = -1; plyPrevMove = -1;
      var maxSteps = MAX_PLAYOUT_STEPS;
      for (var step = 0; step < maxSteps; step++) {
        var played = playoutTurn(plyMover);
        if (played === 0) { plyPasses++; plyKo = -1; plyLastMove = -1; plyPrevMove = -1; }
        if (plyPasses >= activeCount) break;
        var t2 = plyMover;
        do { t2 = (t2 % pcCur) + 1; } while (outFlags[t2]);
        plyMover = t2;
      }
      removeDeadStones(pboard);
      scoreBoardInto(pboard, outSc, pcCur);
    }

    function computeOutcome() {
      var p, o, best, s, v;
      for (p = 1; p <= pcCur; p++) {
        if (outFlags[p]) { winArr[p] = 0; valArr[p] = 0; continue; }
        best = -32768;
        for (o = 1; o <= pcCur; o++) {
          if (o === p || outFlags[o]) continue;
          s = outSc[o];
          if (s > best) best = s;
        }
        if (best === -32768) best = outSc[p];
        s = outSc[p];
        winArr[p] = s > best ? 1 : (s === best ? 0.5 : 0);
        v = (s - best) / n;
        valArr[p] = v > 1 ? 1 : (v < -1 ? -1 : v);
      }
    }

    /* ================================================================== *
     *  MCTS
     * ================================================================== */

    function makeNode(mover, move, parent, depth, passes, ko) {
      return {
        mover: mover, move: move, parent: parent, depth: depth,
        passes: passes, ko: ko,
        n: 0, w: 0, v: 0, rn: 0, rw: 0,
        children: null, untried: null,
        terminal: false, termScores: null
      };
    }

    var histMove = new Int16Array(MAX_DEPTH + 8);
    var histCapStart = new Int32Array(MAX_DEPTH + 8);
    var histCapEnd = new Int32Array(MAX_DEPTH + 8);
    var histLen = 0;

    function buildUntried() {
      // treeBoard is the position of the node being expanded.
      var arr = [], i, j, je, any;
      for (i = 0; i < n; i++) {
        if (treeBoard[i] !== 0) continue;
        any = 0;
        for (j = nbOff[i], je = nbOff[i + 1]; j < je; j++) if (treeBoard[nbFlat[j]] !== 0) { any = 1; break; }
        if (any) arr.push(i);
      }
      if (arr.length === 0) for (i = 0; i < n; i++) if (treeBoard[i] === 0) arr.push(i);
      // Fisher-Yates
      for (i = arr.length - 1; i > 0; i--) {
        var k = (rng() * (i + 1)) | 0;
        var tv = arr[i]; arr[i] = arr[k]; arr[k] = tv;
      }
      arr.push(-1); // pass; then placed at a random position so it is not always last
      if (arr.length > 1) {
        var pi = (rng() * arr.length) | 0;
        var tmp = arr[pi]; arr[pi] = arr[arr.length - 1]; arr[arr.length - 1] = tmp;
      }
      return arr;
    }

    function selectUCT(node) {
      var kids = node.children, ln = Math.log(node.n + 1);
      var best = kids[0], bestV = -1e18;
      for (var i = 0; i < kids.length; i++) {
        var ch = kids[i];
        if (ch.n <= 0) { return ch; }
        // ch.w / ch.rw are accumulated for the mover of `node` (the parent).
        var q = ch.w / ch.n;
        if (ch.rn > 0) {
          // MoGo-style RAVE weight: conservative early, decaying with visits.
          var b = 0.05, rn = ch.rn, nv = ch.n;
          var beta = rn / (rn + nv + 4 * nv * rn * b * b);
          q = (1 - beta) * q + beta * (ch.rw / rn);
        }
        var v = q + UCT_C * Math.sqrt(ln / ch.n);
        if (v > bestV) { bestV = v; best = ch; }
      }
      return best;
    }

    function terminalScores(board) {
      dsBoard.set(board);
      removeDeadStones(dsBoard);
      scoreBoardInto(dsBoard, scoreScratch, pcCur);
      var t = new Int16Array(pcCur + 1);
      t.set(scoreScratch.subarray(0, pcCur + 1));
      return t;
    }

    function resetStampsIfNeeded() {
      if (scanId > 1000000000) { scanStamp.fill(0); scanId = 0; }
      if (libId > 1000000000) { libStamp.fill(0); libId = 0; }
      if (applyId > 1000000000) { applyStamp.fill(0); applyId = 0; }
      if (saveId > 1000000000) { saveStamp.fill(0); saveId = 0; }
      if (turnId > 1000000000) { gStamp.fill(0); turnId = 0; }
      if (regId > 1000000000) { regStamp.fill(0); regId = 0; }
    }

    /* ------------------------------------------------------------------ *
     *  Public: root legal moves / scoring (used by tests and by think)
     * ------------------------------------------------------------------ */

    function prepareState(state) {
      var boardIn = state && state.board;
      if (!boardIn || boardIn.length !== n) throw new Error('HEXAGO engine: board length mismatch (expected ' + n + ')');
      var pc = state.playerCount | 0;
      if (pc < 2) pc = engPC;
      if (pc > 6) pc = 6;
      pcCur = pc;
      var p;
      for (p = 1; p <= pc; p++) outFlags[p] = state.out && state.out[p] ? 1 : 0;
      for (p = pc + 1; p <= 7; p++) outFlags[p] = 0;
      activeCount = 0;
      for (p = 1; p <= pc; p++) if (!outFlags[p]) activeCount++;
      var seenSrc = state.seen;
      if (seenSrc && seenSrc.length) {
        if (seenSrc instanceof Set) seenSet = seenSrc;
        else { seenSet = new Set(); for (var si = 0; si < seenSrc.length; si++) seenSet.add(seenSrc[si]); }
      } else seenSet = null;
      var i;
      for (i = 0; i < n; i++) srcBoard[i] = boardIn[i] !== undefined ? boardIn[i] : 0;
      rootMover = state.turn | 0;
      if (rootMover < 1 || rootMover > pc) rootMover = 1;
      return pc;
    }

    function rootLegalMovesImpl(state) {
      resetStampsIfNeeded();
      prepareState(state);
      capCount = 0;
      return genRootLegal(rootMover);
    }

    function scoreBoardImpl(board, pc) {
      var out = new Array((pc | 0) + 1);
      scoreBoardInto(board, out, pc | 0);
      return out;
    }

    /* ------------------------------------------------------------------ *
     *  think()
     * ------------------------------------------------------------------ */

    function think(state, options) {
      resetStampsIfNeeded();
      options = options || {};
      var start = nowMs();
      var pc = prepareState(state);
      var turn = rootMover;
      var passes = state.passes | 0;
      var budgetMs = options.budgetMs == null ? DEFAULT_BUDGET_MS : Math.max(1, +options.budgetMs || 1);
      var maxPlayouts = (options.maxPlayouts == null || options.maxPlayouts < 0) ? -1 : (options.maxPlayouts | 0);
      var timeLimited = maxPlayouts < 0;
      var seed = options.seed == null ? ((Math.random() * 4294967296) | 0) : (options.seed | 0);
      rng = mulberry32(seed);

      // Terminal / single-active situations: nothing to search.
      if (activeCount <= 1 || passes >= activeCount) {
        return {
          move: -1, visits: 0, playouts: 0, winrate: 0, value: 0,
          bestMoves: [], elapsedMs: nowMs() - start, engine: VERSION
        };
      }

      capCount = 0;
      var emptyRoot = 0, i;
      for (i = 0; i < n; i++) if (srcBoard[i] === 0) emptyRoot++;

      // Fresh exact root legality (page rules: occupied / suicide / superko-on-capture).
      var legal = genRootLegal(turn);
      var legalMark = new Uint8Array(n);
      for (i = 0; i < legal.length; i++) if (legal[i] >= 0) legalMark[legal[i]] = 1;

      // Do not offer "pass" while the board is still open: passing with lots of
      // useful points left is almost never genuinely best (and looks broken).
      // Pass is offered after an opponent pass, or in the endgame.
      var allowPass = passes > 0 || emptyRoot <= Math.floor(n * 0.2) || legal.length <= 1;
      var passEnds = passes + 1 >= activeCount;

      var root = null;
      var oldRoot = engine._root;
      var outSig = 0;
      for (i = 1; i <= pc; i++) if (outFlags[i]) outSig |= (1 << i);

      // ---- Tree reuse: adopt a stored child whose position == current position.
      if (oldRoot && oldRoot.children && oldRoot.children.length && oldRoot.pc === pc && oldRoot.outSig === outSig && oldRoot.boardCopy) {
        var chs = oldRoot.children, ci, ch, okR, eq;
        for (ci = 0; ci < chs.length; ci++) {
          ch = chs[ci];
          if (ch.mover !== turn || ch.passes !== passes) continue;
          if (ch.move !== -1 && !legalMark[ch.move]) continue;
          if (ch.move === -1) {
            if (ch.passes !== passes) continue;
            for (eq = 1, i = 0; i < n; i++) { if (oldRoot.boardCopy[i] !== srcBoard[i]) { eq = 0; break; } }
          } else {
            cmpBoard.set(oldRoot.boardCopy);
            capCount = 0;
            okR = applyMove(cmpBoard, ch.move, oldRoot.mover);
            capCount = 0;
            if (!okR) continue;
            eq = 1;
            for (i = 0; i < n; i++) if (cmpBoard[i] !== srcBoard[i]) { eq = 0; break; }
          }
          if (!eq) continue;
          // Validate that the adopted subtree's root children are still root-legal moves.
          var kids = ch.children;
          if (kids) {
            for (var ki = 0; ki < kids.length; ki++) {
              var km = kids[ki].move;
              if (km !== -1 && !legalMark[km]) { eq = 0; break; }
            }
          }
          if (eq) { root = ch; break; }
        }
      }

      if (root) {
        root.parent = null;
        root.depth = 0;
        root.ko = -1; // root legality is exact (superko), not simple ko
        root.passes = passes;
        root.boardCopy = new Int8Array(n); root.boardCopy.set(srcBoard);
        root.pc = pc; root.outSig = outSig;
        // The adopted node's own w/n were accumulated for its OLD parent's
        // perspective; recompute root stats from its children, whose stats are
        // already from the new root mover's perspective and stay valid.
        root.n = 0; root.w = 0; root.v = 0;
        if (root.children) {
          for (var rc = 0; rc < root.children.length; rc++) {
            root.n += root.children[rc].n;
            root.w += root.children[rc].w;
            root.v += root.children[rc].v;
          }
        }
        // Rebuild the untried list: legal moves not already expanded.
        var childMark = new Uint8Array(n);
        var kidsNow = root.children || [];
        for (i = 0; i < kidsNow.length; i++) if (kidsNow[i].move >= 0) childMark[kidsNow[i].move] = 1;
        var ordered = orderRootMoves(legal, turn, allowPass, passEnds);
        var untried = [];
        for (i = 0; i < ordered.length; i++) { if (ordered[i] === -1 || !childMark[ordered[i]]) untried.push(ordered[i]); }
        root.untried = untried;
        if (!root.children) root.children = [];
      } else {
        root = makeNode(turn, -1, null, 0, passes, -1);
        root.boardCopy = new Int8Array(n); root.boardCopy.set(srcBoard);
        root.pc = pc; root.outSig = outSig;
        root.untried = orderRootMoves(legal, turn, allowPass, passEnds);
        root.children = [];
      }
      var rootDepth = root.depth;

      var deadline = start + budgetMs;
      var it = 0;
      var bestSoFar = -1;

      while (true) {
        if (timeLimited) {
          if (it !== 0 && (it & 7) === 0 && nowMs() >= deadline) break;
        } else if (it >= maxPlayouts) break;
        amafStamp++;

        // -------- selection / expansion --------
        treeBoard.set(srcBoard);
        capCount = 0;
        histLen = 0;
        var node = root, leaf = null;
        while (true) {
          if (node.terminal) { leaf = node; break; }
          if (node.untried === null) {
            node.untried = node.depth === rootDepth ? orderRootMoves(legal, turn, allowPass, passEnds) : buildUntried();
          }
          if (node.untried.length > 0) {
            var expanded = false;
            while (node.untried.length > 0) {
              var mv = node.untried.pop();
              var child;
              if (mv === -1) {
                child = makeNode(nextActivePlayer(node.mover), -1, node, node.depth + 1, node.passes + 1, -1);
                if (!node.children) node.children = [];
                node.children.push(child);
                histMove[histLen] = -1; histCapStart[histLen] = capCount; histCapEnd[histLen] = capCount; histLen++;
                node = child;
                if (child.passes >= activeCount) { child.terminal = true; child.termScores = terminalScores(treeBoard); }
                else if (child.depth - rootDepth >= MAX_DEPTH) { child.terminal = true; child.termScores = terminalScores(treeBoard); }
                leaf = child; expanded = true;
                break;
              }
              if (treeBoard[mv] !== 0 || mv === node.ko) continue;
              var hs = capCount;
              if (!applyMove(treeBoard, mv, node.mover)) { capCount = hs; continue; }
              amafMark[mv] = amafStamp; amafWho[mv] = node.mover;
              child = makeNode(nextActivePlayer(node.mover), mv, node, node.depth + 1, 0, lastKo);
              if (!node.children) node.children = [];
              node.children.push(child);
              histMove[histLen] = mv; histCapStart[histLen] = hs; histCapEnd[histLen] = capCount; histLen++;
              node = child;
              if (child.depth - rootDepth >= MAX_DEPTH) { child.terminal = true; child.termScores = terminalScores(treeBoard); }
              leaf = child; expanded = true;
              break;
            }
            if (expanded) break;
            // All untried moves were illegal at this node; score it as terminal.
            node.terminal = true;
            node.termScores = terminalScores(treeBoard);
            leaf = node;
            break;
          }
          // -------- all moves tried: UCT selection --------
          if (node.children && node.children.length > 0) {
            var sel = selectUCT(node);
            if (sel.move === -1) {
              histMove[histLen] = -1; histCapStart[histLen] = capCount; histCapEnd[histLen] = capCount; histLen++;
              node = sel;
            } else {
              var hs2 = capCount;
              var okS = applyMove(treeBoard, sel.move, node.mover);
              amafMark[sel.move] = amafStamp; amafWho[sel.move] = node.mover;
              histMove[histLen] = sel.move; histCapStart[histLen] = hs2; histCapEnd[capCount]; histLen++;
              node = sel;
              if (!okS) { /* should never happen: legality checked at creation */ }
            }
            if (node.terminal) { leaf = node; break; }
            continue;
          }
          // No children and no untried: cannot happen (pass is always available) — score.
          node.terminal = true;
          node.termScores = terminalScores(treeBoard);
          leaf = node;
          break;
        }

        // -------- rollout from leaf position --------
        if (leaf.terminal) {
          var ts = leaf.termScores;
          for (i = 0; i <= pc; i++) outSc[i] = ts[i];
        } else {
          runPlayout(leaf.mover, leaf.ko, leaf.passes);
        }

        // -------- backpropagation --------
        // Each node stores the outcome from the perspective of the mover of its
        // PARENT (the player who chose the move into it).  This makes UCT at any
        // node maximize its own mover's outcome, also in 3..6 player games.
        computeOutcome();
        var nd = leaf, par;
        while (nd.parent !== null) {
          par = nd.parent;
          nd.n++;
          nd.w += winArr[par.mover];
          nd.v += valArr[par.mover];
          nd = par;
        }
        // Root has no parent: keep its own mover's perspective only.
        root.n++;
        root.w += winArr[rootMover];
        root.v += valArr[rootMover];
        // AMAF/RAVE: for every node on the path, credit child moves that were
        // played later in this simulation by that node's mover.
        var na = leaf;
        while (na !== null) {
          var ak = na.children;
          if (ak !== null && ak.length > 0) {
            var aw = winArr[na.mover];
            for (var ai = 0; ai < ak.length; ai++) {
              var acd = ak[ai], amv = acd.move;
              if (amv >= 0 && amafMark[amv] === amafStamp && amafWho[amv] === na.mover) { acd.rn++; acd.rw += aw; }
            }
          }
          na = na.parent;
        }

        // -------- undo traversal --------
        for (var hi = histLen - 1; hi >= 0; hi--) {
          var hm = histMove[hi];
          if (hm >= 0) undoMove(treeBoard, hm, histCapStart[hi], histCapEnd[hi]);
          else capCount = histCapStart[hi];
        }
        histLen = 0;

        it++;
        if (options.onProgress && (it & 255) === 0) {
          var bm = pickBestChild(root);
          if (bm >= 0) bestSoFar = bm.move;
          try { options.onProgress({ visits: root.n, playouts: it, elapsedMs: nowMs() - start, bestMove: bestSoFar }); } catch (err) { /* ignore */ }
        }
      }

      // -------- choose the move --------
      var best = pickBestChild(root);
      var move = -1;
      if (best) move = best.move;
      else {
        // Fallback: best-ordered legal move (center preference when board is empty).
        for (i = legal.length - 1; i >= 0; i--) {
          if (legal[i] === -1) continue;
          move = legal[i]; break;
        }
        if (emptyRoot > 0 && legalMark[geo.center]) move = geo.center;
        if (move === -1) move = -1;
      }
      // Safety: never return an illegal placement.
      if (move >= 0 && !legalMark[move]) move = -1;

      var resignThreshold = options.resignThreshold;
      if (move >= 0 && resignThreshold != null && pc === 2 && root.n >= 256 && emptyRoot < n * 0.55) {
        var wr = root.n > 0 ? root.w / root.n : 1;
        if (wr < +resignThreshold) move = -2;
      }

      // -------- assemble result --------
      // Full root statistics (for root-parallel search: K workers can be merged
      // by summing visits / winrate*visits per move).
      var rootMoves = [];
      if (root.children) {
        for (i = 0; i < root.children.length; i++) {
          var rmc = root.children[i];
          if (rmc.n <= 0) continue;
          rootMoves.push({
            move: rmc.move,
            visits: rmc.n,
            winrate: rmc.w / rmc.n,
            value: rmc.v / rmc.n
          });
        }
      }
      var bestMoves = [];
      if (root.children) {
        var sorted = root.children.slice().sort(function (a, b) { return b.n - a.n || (b.n ? b.w / b.n : 0) - (a.n ? a.w / a.n : 0) || a.move - b.move; });
        for (i = 0; i < sorted.length && i < 8; i++) {
          var cm = sorted[i];
          bestMoves.push({ move: cm.move, visits: cm.n, value: cm.n > 0 ? cm.w / cm.n : 0 });
        }
      }

      engine._root = root;

      return {
        move: move,
        visits: root.n,
        playouts: it,
        winrate: root.n > 0 ? root.w / root.n : 0,
        value: root.n > 0 ? root.v / root.n : 0,
        bestMoves: bestMoves,
        rootMoves: rootMoves,
        elapsedMs: nowMs() - start,
        engine: VERSION
      };
    }

    function nextActivePlayer(p) {
      var t = p;
      do { t = (t % pcCur) + 1; } while (outFlags[t]);
      return t;
    }

    function pickBestChild(root) {
      var kids = root.children;
      if (!kids || kids.length === 0) return null;
      var best = null, bestN = -1, bestRw = -2;
      for (var i = 0; i < kids.length; i++) {
        var ch = kids[i];
        var rw = ch.n > 0 ? ch.w / ch.n : -1;
        if (ch.n > bestN || (ch.n === bestN && rw > bestRw)) { bestN = ch.n; bestRw = rw; best = ch; }
      }
      return best;
    }

    /* ------------------------------------------------------------------ *
     *  Engine object
     * ------------------------------------------------------------------ */

    var engine = {
      size: geo.size,
      n: n,
      think: think,
      _rootLegalMoves: rootLegalMovesImpl,
      _scoreBoard: scoreBoardImpl,
      _deadStones: deadStonesImpl,
      _root: null
    };
    return engine;
  }

  /* ------------------------------------------------------------------ *
   *  Module / worker export
   * ------------------------------------------------------------------ */

  var API = {
    version: VERSION,
    geometry: geometry,
    createEngine: createEngine,
    hashBoard: hashBoard,
    _internals: {
      sizeFromN: sizeFromN,
      rootLegalMoves: function (state) {
        var board = state && state.board;
        if (!board) throw new Error('rootLegalMoves: state.board required');
        var size = state.size | 0;
        if (!size) size = sizeFromN(board.length);
        if (size < 3) throw new Error('rootLegalMoves: unknown board length ' + board.length);
        return createEngine({ size: size, playerCount: (state.playerCount | 0) || 2 })._rootLegalMoves(state);
      },
      scoreBoard: function (board, pc) {
        var size = sizeFromN(board.length);
        if (size < 3) throw new Error('scoreBoard: unknown board length ' + board.length);
        return createEngine({ size: size, playerCount: (pc | 0) || 2 })._scoreBoard(board, pc | 0 || 2);
      }
    }
  };

  if (typeof module !== 'undefined' && module && module.exports) module.exports = API;
  if (globalScope) {
    try { globalScope.HexagoAI = API; } catch (err) { /* ignore */ }
  }
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
