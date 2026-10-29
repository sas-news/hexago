/* ------------------------------------------------------------------ *
 * HEXAGO WASM prototype — freestanding C (no libc, no allocator)
 *
 * Implements the hot loop of the HEXAGO AI:
 *   - hex board geometry (axial coords, same index order as index.html build())
 *   - group / liberty flood fill
 *   - move simulation with captures, suicide and simple-ko legality
 *   - random / local-policy playouts to an area score
 *   - cyrb53 board hash (must match page hash())
 *
 * It is NOT the production engine: no MCTS tree, no tactical playout policy
 * (capture/save analysis).  It exists to measure the achievable speedup of
 * moving the per-playout hot loop from JS to wasm with the SAME algorithm.
 * js-baseline.mjs is a line-by-line JS twin of this file.
 *
 * Build: see dev/wasm/build.sh
 * ------------------------------------------------------------------ */

typedef signed char i8;
typedef short i16;
typedef int i32;
typedef unsigned int u32;

#define MAXN 1024
#define MAXNB (MAXN * 6)

/* geometry */
static int N = 0, SIDE = 0, RADIUS = 0;
static i8 qs[MAXN], rs[MAXN];
static i16 nbOff[MAXN + 1];
static i16 nbFlat[MAXNB];

/* board + playout scratch */
static i8 board[MAXN];
static i16 empList[MAXN];
static i16 empPos[MAXN];
static int empCount = 0;

static i16 grpBuf[MAXN];
static int lastGrpN = 0, lastLibs = 0, lastLibPt = -1;

static int scanStamp[MAXN], libStamp[MAXN];
static int scanId = 0, libId = 0;

static i16 capPos[MAXN];
static i8 capColor[MAXN];
static int capCount = 0;
static int capSeen[MAXN], capSeenId = 0;

static int lastOwnLibs = 0, lastKo = -1, lastCapN = 0;

/* territory scoring */
static int regStamp[MAXN], regId = 0;
static i16 regQueue[MAXN];
static i32 scores[8];
static i32 lastScores[8];

/* rng (mulberry32) */
static u32 rngState = 1;

/* stats */
static i32 lastMoves = 0;
static i32 lastPasses = 0;

/* ------------------------------------------------------------------ */
/* libc replacement (wasm-ld may lower builtins to these)              */
/* ------------------------------------------------------------------ */
void *memset(void *dst, int v, unsigned long n) {
  unsigned char *d = (unsigned char *)dst;
  unsigned long i;
  for (i = 0; i < n; i++) d[i] = (unsigned char)v;
  return dst;
}
void *memcpy(void *dst, const void *src, unsigned long n) {
  unsigned char *d = (unsigned char *)dst;
  const unsigned char *s = (const unsigned char *)src;
  unsigned long i;
  for (i = 0; i < n; i++) d[i] = s[i];
  return dst;
}

/* ------------------------------------------------------------------ */
/* math / rng helpers                                                  */
/* ------------------------------------------------------------------ */
static int iabs(int x) { return x < 0 ? -x : x; }

/* mulberry32, bit-identical to dev/ai-engine.js and js-baseline.mjs */
static double next_rand(void) {
  u32 t;
  rngState = rngState + 0x6D2B79F5u;
  t = rngState;
  t = (t ^ (t >> 15)) * (t | 1u);
  t = t ^ (t + (t ^ (t >> 7)) * (t | 61u));
  return (double)(t ^ (t >> 14)) / 4294967296.0;
}

/* ------------------------------------------------------------------ */
/* geometry: same point order as index.html build(n)                   */
/*   for (r = -(side-1); r < side; r++)                                */
/*     for (q = -(side-1); q < side; q++)                              */
/*       if (|q+r| <= side-1) { point }                                */
/* ------------------------------------------------------------------ */
static const int DIRQ[6] = {1, 0, -1, -1, 0, 1};
static const int DIRR[6] = {0, 1, 1, 0, -1, -1};

void hg_clear(void);

int hg_init(int size) {
  int r, q, i, d, j;
  if (size < 3 || (size & 1) == 0 || size > 63) return -1;
  SIDE = (size + 1) / 2;
  RADIUS = SIDE - 1;
  N = 0;
  for (r = -RADIUS; r < SIDE; r++) {
    for (q = -RADIUS; q < SIDE; q++) {
      if (iabs(q + r) <= RADIUS) {
        if (N >= MAXN) return -1;
        qs[N] = (i8)q;
        rs[N] = (i8)r;
        N++;
      }
    }
  }
  /* neighbour table, O(N^2) at init (max 469 points -> fine) */
  j = 0;
  for (i = 0; i < N; i++) {
    nbOff[i] = (i16)j;
    for (d = 0; d < 6; d++) {
      int tq = qs[i] + DIRQ[d], tr = rs[i] + DIRR[d], k;
      for (k = 0; k < N; k++) {
        if (qs[k] == tq && rs[k] == tr) {
          if (j < MAXNB) nbFlat[j++] = (i16)k;
          break;
        }
      }
    }
  }
  nbOff[N] = (i16)j;
  hg_clear();
  return N;
}

int hg_n(void) { return N; }
int hg_board_ptr(void) { return (int)(unsigned long)board; }
int hg_nb_off_ptr(void) { return (int)(unsigned long)nbOff; }
int hg_nb_flat_ptr(void) { return (int)(unsigned long)nbFlat; }
int hg_scores_ptr(void) { return (int)(unsigned long)lastScores; }

void hg_clear(void) {
  int i;
  for (i = 0; i < N; i++) board[i] = 0;
  for (i = 0; i < N; i++) { empPos[i] = (i16)i; empList[i] = (i16)i; }
  empCount = N;
  capCount = 0;
  lastKo = -1;
  lastCapN = 0;
  lastOwnLibs = 0;
  lastMoves = 0;
  lastPasses = 0;
}

void hg_set(int move, int player) {
  if (move >= 0 && move < N) board[move] = (i8)player;
}

void hg_set_ko(int ko) { lastKo = ko; }
int hg_last_ko(void) { return lastKo; }
int hg_last_moves(void) { return lastMoves; }
int hg_last_passes(void) { return lastPasses; }
int hg_captured_last(void) { return lastCapN; }

/* ------------------------------------------------------------------ */
/* group / liberty scan                                                */
/* ------------------------------------------------------------------ */
/* Flood fill a group, counting distinct liberties, but STOP as soon as
   `maxLibs` liberties are found (the caller only cares "0", "1", ">=2").
   When it stops early, grpBuf/lastGrpN do NOT contain the whole group; when
   it completes (libs < maxLibs), grpBuf holds every stone.  This is exact:
   early exit only happens when the group provably has >= maxLibs liberties. */
static int scan_group_lim(int start, int color, int maxLibs) {
  int sid = ++scanId, lid = ++libId;
  int gn = 0, libs = 0, gi, j, je;
  grpBuf[gn++] = (i16)start;
  scanStamp[start] = sid;
  for (gi = 0; gi < gn; gi++) {
    int s = grpBuf[gi];
    for (j = nbOff[s], je = nbOff[s + 1]; j < je; j++) {
      int t = nbFlat[j], v = board[t];
      if (v == color) {
        if (scanStamp[t] != sid) { scanStamp[t] = sid; grpBuf[gn++] = (i16)t; }
      } else if (v == 0 && libStamp[t] != lid) {
        libStamp[t] = lid;
        libs++;
        if (libs >= maxLibs) { lastGrpN = gn; return libs; }
      }
    }
  }
  lastGrpN = gn;
  return libs;
}

/* ------------------------------------------------------------------ */
/* move simulation.  Returns 1 legal / 0 illegal; captures land in capPos. */
/* Mirrors page sim(): occupied, capture enemy 0-lib groups, suicide,   */
/* simple ko.  (Superko is checked at the root by the JS side.)         */
/* ------------------------------------------------------------------ */
static int apply_move(int move, int p, int ko) {
  int cs, aid, captured = 0, j, je, k, n;
  if (move < 0 || move >= N) return 0;
  if (board[move] != 0) return 0;
  if (move == ko) return 0;
  board[move] = (i8)p;
  cs = capCount;
  aid = ++capSeenId;
  for (j = nbOff[move], je = nbOff[move + 1]; j < je; j++) {
    int t = nbFlat[j], c = board[t];
    if (c == 0 || c == p || capSeen[t] == aid) continue;
    /* maxLibs=1: stop on the first liberty; a full scan means the group is
       captured (and grpBuf then holds all of its stones). */
    n = scan_group_lim(t, c, 1);
    if (n != 0) continue; /* has at least one liberty -> not captured */
    n = lastGrpN;
    for (k = 0; k < n; k++) {
      capSeen[grpBuf[k]] = aid;
      capPos[capCount] = grpBuf[k];
      capColor[capCount] = (i8)c;
      capCount++;
      captured++;
    }
  }
  if (captured > 0) {
    for (k = cs; k < capCount; k++) board[capPos[k]] = 0;
    lastKo = captured == 1 ? capPos[cs] : -1;
    lastCapN = captured;
    lastOwnLibs = 2;
    return 1;
  }
  /* maxLibs=2: exact 0/1, or ">=2" (which is all the self-atari test needs) */
  lastOwnLibs = scan_group_lim(move, p, 2);
  if (lastOwnLibs == 0) {
    board[move] = 0;
    capCount = cs;
    lastCapN = 0;
    lastKo = -1;
    return 0;
  }
  lastCapN = 0;
  lastKo = -1;
  return 1;
}

static void undo_apply(int move, int cs) {
  int k;
  board[move] = 0;
  for (k = cs; k < capCount; k++) board[capPos[k]] = capColor[k];
  capCount = cs;
}

/* Exposed for unit tests: legality check without mutating the board. */
int hg_legal(int move, int turn, int ko) {
  int cs = capCount;
  if (!apply_move(move, turn, ko)) { capCount = cs; return 0; }
  undo_apply(move, cs);
  return 1;
}

/* Exposed for unit tests: apply one move, keep board mutated.
   Returns captured count, or -1 if illegal. */
int hg_play(int move, int turn, int ko) {
  int cs = capCount, cap = 0;
  if (!apply_move(move, turn, ko)) { capCount = cs; return -1; }
  cap = lastCapN;
  return cap;
}

/* ------------------------------------------------------------------ */
/* scoring: territory + stones (page scoreBoardInto semantics)         */
/* ------------------------------------------------------------------ */
static void score_board(int pc) {
  int i, j, je, t, p, qn, s, qi, v, col, mixed, rid;
  for (p = 0; p <= pc; p++) scores[p] = 0;
  for (i = 0; i < N; i++) {
    t = board[i];
    if (t != 0 && t <= pc) scores[t]++;
  }
  rid = ++regId;
  for (i = 0; i < N; i++) {
    if (board[i] != 0 || regStamp[i] == rid) continue;
    qn = 0;
    regQueue[qn++] = (i16)i;
    regStamp[i] = rid;
    col = 0;
    mixed = 0;
    for (qi = 0; qi < qn; qi++) {
      s = regQueue[qi];
      for (j = nbOff[s], je = nbOff[s + 1]; j < je; j++) {
        t = nbFlat[j];
        v = board[t];
        if (v == 0) {
          if (regStamp[t] != rid) { regStamp[t] = rid; regQueue[qn++] = (i16)t; }
        } else if (col == 0) {
          col = v;
        } else if (v != col) {
          mixed = 1;
        }
      }
    }
    if (!mixed && col != 0 && col <= pc) scores[col] += qn;
  }
  for (p = 1; p <= pc; p++) lastScores[p] = scores[p];
  lastScores[0] = 0;
}

/* ------------------------------------------------------------------ */
/* playout helpers                                                     */
/* ------------------------------------------------------------------ */
static void remove_empty(int e) {
  int pos = empPos[e];
  int last = empList[--empCount];
  empList[pos] = (i16)last;
  empPos[last] = (i16)pos;
}

static int is_own_eye(int e, int p) {
  int j, je;
  for (j = nbOff[e], je = nbOff[e + 1]; j < je; j++) {
    if (board[nbFlat[j]] != p) return 0;
  }
  return 1;
}

/* Play one turn.
   policy 0 = uniform random over all empty points
   policy 1 = engine-like: local candidates only (adjacent to a stone; all
              empties when the board is empty), never fill own eyes, avoid
              self-atari unless it captured.  No tactical capture/save scan. */
static int playout_turn(int p, int policy) {
  int candList[MAXN];
  int candCount = 0, i, a, e, cs, defined;

  if (policy == 0) {
    for (i = 0; i < empCount; i++) candList[candCount++] = empList[i];
  } else {
    for (i = 0; i < empCount; i++) {
      int local = 0, j, je;
      e = empList[i];
      for (j = nbOff[e], je = nbOff[e + 1]; j < je; j++) {
        if (board[nbFlat[j]] != 0) { local = 1; break; }
      }
      if (local) candList[candCount++] = e;
    }
    if (candCount == 0) {
      for (i = 0; i < empCount; i++) candList[candCount++] = empList[i];
    }
  }
  if (candCount == 0) return 0;

  for (a = 0; a < 8; a++) {
    int mean = (int)(next_rand() * (double)candCount);
    if (mean >= candCount) mean = candCount - 1;
    e = candList[mean];
    if (policy != 0 && is_own_eye(e, p)) continue;
    cs = capCount;
    defined = apply_move(e, p, lastKo);
    if (!defined) continue;
    if (policy != 0 && lastCapN == 0 && lastOwnLibs == 1 && next_rand() < 0.95) {
      undo_apply(e, cs);
      continue;
    }
    remove_empty(e);
    lastMoves++;
    return 1;
  }
  for (a = 0; a < candCount; a++) {
    e = candList[a];
    if (policy != 0 && is_own_eye(e, p)) continue;
    cs = capCount;
    defined = apply_move(e, p, lastKo);
    if (!defined) continue;
    if (policy != 0 && lastCapN == 0 && lastOwnLibs == 1 && next_rand() < 0.95) {
      undo_apply(e, cs);
      continue;
    }
    remove_empty(e);
    lastMoves++;
    return 1;
  }
  return 0;
}

/* one full playout from an empty board, 2 players, up to 2 consecutive passes */
static void run_playout(int policy) {
  int i, step, passes = 0, mover = 1;
  for (i = 0; i < N; i++) board[i] = 0;
  for (i = 0; i < N; i++) { empPos[i] = (i16)i; empList[i] = (i16)i; }
  empCount = N;
  capCount = 0;
  lastKo = -1;
  lastMoves = 0;
  lastPasses = 0;

  for (step = 0; step < 2 * N + 30; step++) {
    int moved = playout_turn(mover, policy);
    if (!moved) {
      passes++;
      lastKo = -1;
    } else {
      passes = 0;
    }
    if (passes >= 2) break;
    mover = 3 - mover;
  }
  lastPasses = passes;
  score_board(2);
}

/* Run `playouts` playouts from a clean board with the given seed.
   Returns a checksum of the final scores so nothing can be optimised away.
   Per-playout scores of the LAST playout are at hg_scores_ptr(). */
int hg_bench(int playouts, int seed, int policy) {
  int k, checksum = 0;
  rngState = (u32)seed;
  for (k = 0; k < playouts; k++) {
    run_playout(policy);
    checksum = (checksum + lastScores[1] * 1000 + lastScores[2] + lastMoves) & 0x7fffffff;
  }
  return checksum;
}

/* Score the current board (territory + stones) into lastScores. */
void hg_score(int pc) { score_board(pc); }

/* Run exactly one playout; returns score checksum (for parity tests). */
int hg_playout_once(int seed, int policy) {
  rngState = (u32)seed;
  run_playout(policy);
  return (lastScores[1] * 1000 + lastScores[2]) * 1000 + lastMoves;
}

/* ------------------------------------------------------------------ */
/* cyrb53 board hash — must equal page hash(board)                     */
/* ------------------------------------------------------------------ */
double hg_hash(void) {
  u32 h1 = 0xdeadbeefu, h2 = 0x41c6ce57u;
  int i;
  for (i = 0; i < N; i++) {
    u32 v = (u32)board[i];
    h1 = (h1 ^ v) * 2654435761u;
    h2 = (h2 ^ v) * 1597334677u;
  }
  h1 = ((h1 ^ (h1 >> 16)) * 2246822507u) ^ ((h2 ^ (h2 >> 13)) * 3266489909u);
  h2 = ((h2 ^ (h2 >> 16)) * 2246822507u) ^ ((h1 ^ (h1 >> 13)) * 3266489909u);
  return (double)(2097151u & h2) * 4294967296.0 + (double)h1;
}
