/* ------------------------------------------------------------------ *
 * JS twin of dev/wasm/src/hexago.c
 *
 * This is the benchmark baseline: the SAME algorithm, same data layout
 * (typed arrays, flat neighbour table, stamp-based flood fill, mulberry32)
 * implemented directly in JavaScript.  It is not a naive strawman: it is
 * roughly the shape of dev/ai-engine.js's playout hot loop without the
 * tactical capture/save scan.
 *
 * Parity tests (test.mjs) assert that for the same seed this class and the
 * wasm module produce identical boards, captures, scores and playout counts.
 * ------------------------------------------------------------------ */

const DIRQ = [1, 0, -1, -1, 0, 1];
const DIRR = [0, 1, 1, 0, -1, -1];

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class JSBaseline {
  constructor(size) {
    if (size < 3 || (size & 1) === 0) throw new Error('size must be odd >= 3');
    const side = (size + 1) / 2;
    const radius = side - 1;
    this.size = size;
    this.side = side;
    this.P = [];
    for (let r = -radius; r < side; r++) {
      for (let q = -radius; q < side; q++) {
        if (Math.abs(q + r) <= radius) this.P.push([q, r]);
      }
    }
    const n = (this.n = this.P.length);
    this.qs = new Int8Array(n);
    this.rs = new Int8Array(n);
    for (let i = 0; i < n; i++) { this.qs[i] = this.P[i][0]; this.rs[i] = this.P[i][1]; }
    this.nbOff = new Int16Array(n + 1);
    const flat = [];
    for (let i = 0; i < n; i++) {
      this.nbOff[i] = flat.length;
      for (let d = 0; d < 6; d++) {
        const tq = this.qs[i] + DIRQ[d], tr = this.rs[i] + DIRR[d];
        for (let k = 0; k < n; k++) {
          if (this.qs[k] === tq && this.rs[k] === tr) { flat.push(k); break; }
        }
      }
    }
    this.nbOff[n] = flat.length;
    this.nbFlat = new Int16Array(flat);

    this.board = new Int8Array(n);
    this.empList = new Int16Array(n);
    this.empPos = new Int16Array(n);
    this.grpBuf = new Int16Array(n);
    this.scanStamp = new Int32Array(n);
    this.libStamp = new Int32Array(n);
    this.capPos = new Int16Array(n);
    this.capColor = new Int8Array(n);
    this.capSeen = new Int32Array(n);
    this.regStamp = new Int32Array(n);
    this.regQueue = new Int16Array(n);
    this.candList = new Int16Array(n);
    this.scores = new Int16Array(8);
    this.lastScores = new Int16Array(8);
    this.scanId = 0; this.libId = 0; this.capSeenId = 0; this.regId = 0;
    this.capCount = 0;
    this.lastGrpN = 0; this.lastLibs = 0;
    this.lastOwnLibs = 0; this.lastKo = -1; this.lastCapN = 0;
    this.lastMoves = 0; this.lastPasses = 0;
    this.rng = mulberry32(1);
    this.clear();
  }

  clear() {
    const n = this.n;
    this.board.fill(0);
    for (let i = 0; i < n; i++) { this.empPos[i] = i; this.empList[i] = i; }
    this.empCount = n;
    this.capCount = 0;
    this.lastKo = -1;
    this.lastCapN = 0;
    this.lastOwnLibs = 0;
    this.lastMoves = 0;
    this.lastPasses = 0;
  }

  set(move, player) { this.board[move] = player; }
  setKo(ko) { this.lastKo = ko; }

  /* Flood fill a group, counting distinct liberties, but stop as soon as
     maxLibs liberties are found (callers only distinguish 0 / 1 / >=2).
     Exact: early exit only when the group provably has >= maxLibs liberties. */
  scanGroupLim(start, color, maxLibs) {
    const b = this.board, nbOff = this.nbOff, nbFlat = this.nbFlat;
    const grp = this.grpBuf, ss = this.scanStamp, ls = this.libStamp;
    const sid = ++this.scanId, lid = ++this.libId;
    let gn = 0, libs = 0;
    grp[gn++] = start;
    ss[start] = sid;
    for (let gi = 0; gi < gn; gi++) {
      const s = grp[gi];
      for (let j = nbOff[s], je = nbOff[s + 1]; j < je; j++) {
        const t = nbFlat[j], v = b[t];
        if (v === color) {
          if (ss[t] !== sid) { ss[t] = sid; grp[gn++] = t; }
        } else if (v === 0 && ls[t] !== lid) {
          ls[t] = lid; libs++;
          if (libs >= maxLibs) { this.lastGrpN = gn; return libs; }
        }
      }
    }
    this.lastGrpN = gn;
    return libs;
  }

  applyMove(move, p, ko) {
    const b = this.board, nbOff = this.nbOff, nbFlat = this.nbFlat;
    const capPos = this.capPos, capColor = this.capColor, capSeen = this.capSeen;
    if (move < 0 || move >= this.n) return 0;
    if (b[move] !== 0) return 0;
    if (move === ko) return 0;
    b[move] = p;
    const cs = this.capCount;
    const aid = ++this.capSeenId;
    let captured = 0;
    for (let j = nbOff[move], je = nbOff[move + 1]; j < je; j++) {
      const t = nbFlat[j], c = b[t];
      if (c === 0 || c === p || capSeen[t] === aid) continue;
      /* maxLibs=1: stop at first liberty; full scan == group captured */
      if (this.scanGroupLim(t, c, 1) !== 0) continue;
      const gn = this.lastGrpN, grp = this.grpBuf;
      for (let k = 0; k < gn; k++) {
        capSeen[grp[k]] = aid;
        capPos[this.capCount] = grp[k];
        capColor[this.capCount] = c;
        this.capCount++;
        captured++;
      }
    }
    if (captured > 0) {
      for (let k = cs; k < this.capCount; k++) b[capPos[k]] = 0;
      this.lastKo = captured === 1 ? capPos[cs] : -1;
      this.lastCapN = captured;
      this.lastOwnLibs = 2;
      return 1;
    }
    /* maxLibs=2: exact 0/1, or ">=2" which is all the self-atari test needs */
    this.lastOwnLibs = this.scanGroupLim(move, p, 2);
    if (this.lastOwnLibs === 0) {
      b[move] = 0;
      this.capCount = cs;
      this.lastCapN = 0; this.lastKo = -1;
      return 0;
    }
    this.lastCapN = 0; this.lastKo = -1;
    return 1;
  }

  undoApply(move, cs) {
    const b = this.board, capPos = this.capPos, capColor = this.capColor;
    b[move] = 0;
    for (let k = cs; k < this.capCount; k++) b[capPos[k]] = capColor[k];
    this.capCount = cs;
  }

  legal(move, turn, ko) {
    const cs = this.capCount;
    if (!this.applyMove(move, turn, ko)) { this.capCount = cs; return false; }
    this.undoApply(move, cs);
    return true;
  }

  play(move, turn, ko) {
    const cs = this.capCount;
    if (!this.applyMove(move, turn, ko)) { this.capCount = cs; return -1; }
    return this.lastCapN;
  }

  removeEmpty(e) {
    const pos = this.empPos[e];
    const last = this.empList[--this.empCount];
    this.empList[pos] = last;
    this.empPos[last] = pos;
  }

  isOwnEye(e, p) {
    const b = this.board, nbOff = this.nbOff, nbFlat = this.nbFlat;
    for (let j = nbOff[e], je = nbOff[e + 1]; j < je; j++) if (b[nbFlat[j]] !== p) return false;
    return true;
  }

  playoutTurn(p, policy) {
    const b = this.board, nbOff = this.nbOff, nbFlat = this.nbFlat;
    const cand = this.candList;
    let candCount = 0;
    if (policy === 0) {
      for (let i = 0; i < this.empCount; i++) cand[candCount++] = this.empList[i];
    } else {
      for (let i = 0; i < this.empCount; i++) {
        const e = this.empList[i];
        let local = false;
        for (let j = nbOff[e], je = nbOff[e + 1]; j < je; j++) if (b[nbFlat[j]] !== 0) { local = true; break; }
        if (local) cand[candCount++] = e;
      }
      if (candCount === 0) for (let i = 0; i < this.empCount; i++) cand[candCount++] = this.empList[i];
    }
    if (candCount === 0) return 0;
    const rng = this.rng;
    for (let a = 0; a < 8; a++) {
      const e = cand[(rng() * candCount) | 0];
      if (policy !== 0 && this.isOwnEye(e, p)) continue;
      const cs = this.capCount;
      if (!this.applyMove(e, p, this.lastKo)) continue;
      if (policy !== 0 && this.lastCapN === 0 && this.lastOwnLibs === 1 && rng() < 0.95) {
        this.undoApply(e, cs);
        continue;
      }
      this.removeEmpty(e);
      this.lastMoves++;
      return 1;
    }
    for (let a = 0; a < candCount; a++) {
      const e = cand[a];
      if (policy !== 0 && this.isOwnEye(e, p)) continue;
      const cs = this.capCount;
      if (!this.applyMove(e, p, this.lastKo)) continue;
      if (policy !== 0 && this.lastCapN === 0 && this.lastOwnLibs === 1 && rng() < 0.95) {
        this.undoApply(e, cs);
        continue;
      }
      this.removeEmpty(e);
      this.lastMoves++;
      return 1;
    }
    return 0;
  }

  runPlayout(policy) {
    const n = this.n, b = this.board;
    b.fill(0);
    for (let i = 0; i < n; i++) { this.empPos[i] = i; this.empList[i] = i; }
    this.empCount = n;
    this.capCount = 0;
    this.lastKo = -1;
    this.lastMoves = 0;
    this.lastPasses = 0;
    let passes = 0, mover = 1;
    for (let step = 0; step < 2 * n + 30; step++) {
      const moved = this.playoutTurn(mover, policy);
      if (!moved) { passes++; this.lastKo = -1; } else passes = 0;
      if (passes >= 2) break;
      mover = 3 - mover;
    }
    this.lastPasses = passes;
    this.scoreBoard(2);
  }

  scoreBoard(pc) {
    const n = this.n, b = this.board, nbOff = this.nbOff, nbFlat = this.nbFlat;
    const out = this.scores, rs = this.regStamp, rq = this.regQueue;
    for (let p = 0; p <= pc; p++) out[p] = 0;
    for (let i = 0; i < n; i++) { const t = b[i]; if (t !== 0 && t <= pc) out[t]++; }
    const rid = ++this.regId;
    for (let i = 0; i < n; i++) {
      if (b[i] !== 0 || rs[i] === rid) continue;
      let qn = 0, col = 0, mixed = false;
      rq[qn++] = i; rs[i] = rid;
      for (let qi = 0; qi < qn; qi++) {
        const s = rq[qi];
        for (let j = nbOff[s], je = nbOff[s + 1]; j < je; j++) {
          const t = nbFlat[j], v = b[t];
          if (v === 0) { if (rs[t] !== rid) { rs[t] = rid; rq[qn++] = t; } }
          else if (col === 0) col = v;
          else if (v !== col) mixed = true;
        }
      }
      if (!mixed && col !== 0 && col <= pc) out[col] += qn;
    }
    for (let p = 0; p <= pc; p++) this.lastScores[p] = out[p];
  }

  bench(playouts, seed, policy) {
    this.rng = mulberry32(seed);
    let checksum = 0;
    for (let k = 0; k < playouts; k++) {
      this.runPlayout(policy);
      checksum = (checksum + this.lastScores[1] * 1000 + this.lastScores[2] + this.lastMoves) & 0x7fffffff;
    }
    return checksum;
  }

  playoutOnce(seed, policy) {
    this.rng = mulberry32(seed);
    this.runPlayout(policy);
    return (this.lastScores[1] * 1000 + this.lastScores[2]) * 1000 + this.lastMoves;
  }

  /* cyrb53, identical to index.html hash() / ai-engine.js hashBoard() */
  hash() {
    const b = this.board;
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < this.n; i++) {
      h1 = Math.imul(h1 ^ b[i], 2654435761);
      h2 = Math.imul(h2 ^ b[i], 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
  }
}
