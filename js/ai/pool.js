// ===== AI 制御（MCTS エンジン / Web Worker プール） =====
// エンジン本体は js/ai/engine.js（dev/ai-engine.js のコピー）。ページでは classic script として
// 読み込んで window.HexagoAI を提供し、Worker では js/ai/worker.js が importScripts で同じファイルを
// 読み込む。強さに応じて複数 Worker で同じ局面を並列探索し（root parallel MCTS）、
// ルート直下の訪問数を合算して着手を選ぶ。Worker が使えない環境ではメインスレッドで短い予算、
// それも失敗した場合だけ従来の1手読み AI (aiChoose) にフォールバックする。
// AIは常に最強設定の1本。強さの段階は持たない（テスト用に debug から予算だけ上書き可能）。
let aiTestBudgetMs = null, lastAIStats = null;
let aiGeneration = 0, aiWorkerError = '', aiMsgSeq = 0, aiWaiters = new Map();
let aiPool = [];   // [{ index, worker, url, failed }]
let aiMainAPI = null, aiMainEngines = Object.create(null);
// pool.js 自身のURLから worker.js を解決する（サブディレクトリ配信でも動く）。
const AI_WORKER_URL = (function () {
  try {
    const here = document.currentScript && document.currentScript.src;
    return here ? new URL('worker.js', here).href : './js/ai/worker.js';
  } catch (e) { return './js/ai/worker.js'; }
})();

function aiBudgetMs() {
  if (aiTestBudgetMs != null) return aiTestBudgetMs;
  // 最強固定。大盤は1手の影響が大きいので少し長く考える（上限あり）。
  return P.length >= 250 ? 15000 : 12000;
}
function aiPoolWant() {
  const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
  // メインスレッドを空けるため cores-1 を上限に。低メモリ端末では控えめに。
  let want = Math.min(8, Math.max(1, cores));
  const mem = (typeof navigator !== 'undefined' && navigator.deviceMemory) || 8;
  if (mem <= 4) want = Math.min(want, 2);
  return Math.max(1, want);
}
function aiEngineLoaded() {
  return typeof self !== 'undefined' && self.HexagoAI && typeof self.HexagoAI.createEngine === 'function';
}
function makeAIWorkerSlot(index) {
  const slot = { index: index, worker: null, url: AI_WORKER_URL, failed: false };
  const w = new Worker(AI_WORKER_URL);
  slot.worker = w;
  w.onmessage = ev => {
    const d = ev.data || {};
    const waiter = aiWaiters.get(d.id);
    if (!waiter) return;
    if (d.progress) {
      waiter.progress = d.progress;
      let total = 0;
      aiWaiters.forEach(w2 => { if (w2.progress) total += w2.progress.visits || 0; });
      const el = document.getElementById('aiOvText');
      if (el) el.textContent = 'AI 思考中… ' + Math.max(total, d.progress.visits || 0).toLocaleString() + ' 局面を読んでいます';
      return;
    }
    aiWaiters.delete(d.id);
    if (d.ok) waiter.resolve(d.result);
    else waiter.reject(new Error(d.error || 'AI engine error'));
  };
  w.onerror = ev => {
    const msg = (ev && ev.message) || 'AI worker error';
    slot.failed = true;
    aiWorkerError = msg;
    aiWaiters.forEach((waiter, id) => {
      if (waiter.slot === slot) { aiWaiters.delete(id); waiter.reject(new Error(msg)); }
    });
  };
  return slot;
}
function ensureAIPool() {
  aiPool = aiPool.filter(slot => !slot.failed);
  const want = aiPoolWant();
  if (!aiEngineLoaded()) { aiWorkerError = 'AI engine is not loaded'; return []; }
  try {
    while (aiPool.length < want) aiPool.push(makeAIWorkerSlot(aiPool.length));
  } catch (err) {
    aiWorkerError = String((err && err.message) || err);
    aiPool.forEach(slot => { try { slot.worker.terminate(); } catch (e) { } });
    aiPool = [];
  }
  return aiPool;
}
function ensureMainAI() {
  if (aiMainAPI) return aiMainAPI;
  if (!aiEngineLoaded()) throw new Error('AI engine is not loaded');
  aiMainAPI = self.HexagoAI;
  return aiMainAPI;
}
function mainAIEngine(state) {
  const key = state.size + ':' + state.playerCount;
  if (!aiMainEngines[key]) aiMainEngines[key] = ensureMainAI().createEngine({ size: state.size, playerCount: state.playerCount });
  return aiMainEngines[key];
}
function aiStateSnapshot() {
  return {
    size: G.size,
    playerCount: G.playerCount || playerCount,
    turn: G.turn,
    board: G.board.slice(),
    out: G.out.slice(),
    passes: G.passes,
    seen: G.seen.slice(),
  };
}
function aiThinkOnSlot(slot, state, budgetMs) {
  return new Promise((resolve, reject) => {
    const id = ++aiMsgSeq;
    const timer = setTimeout(() => { aiWaiters.delete(id); reject(new Error('AI timeout')); }, budgetMs + 15000);
    aiWaiters.set(id, {
      slot: slot,
      resolve: r => { clearTimeout(timer); resolve(r); },
      reject: e => { clearTimeout(timer); reject(e); },
    });
    slot.worker.postMessage({ id: id, state: state, options: { budgetMs: budgetMs, returnAllMoves: true, resignThreshold: 0.02 } });
  });
}
// root parallel MCTS: 各 Worker のルート直下の訪問数を合算して着手を選ぶ。
function mergeAIResults(results) {
  const acc = new Map();
  for (const r of results) {
    const list = (Array.isArray(r.rootMoves) && r.rootMoves.length) ? r.rootMoves : (r.bestMoves || []);
    for (const e of list) {
      if (!e || !Number.isInteger(e.move)) continue;
      const v = Number.isFinite(e.winrate) ? e.winrate : (Number.isFinite(e.value) ? e.value : 0.5);
      const n = Math.max(1, e.visits | 0);
      const cur = acc.get(e.move) || { move: e.move, visits: 0, wsum: 0, wn: 0 };
      cur.visits += n;
      cur.wsum += v * n;
      cur.wn += n;
      acc.set(e.move, cur);
    }
  }
  let best = null, bestVal = -Infinity;
  for (const c of acc.values()) {
    const v = c.wn ? c.wsum / c.wn : 0;
    if (!best || c.visits > best.visits || (c.visits === best.visits && v > bestVal)) { best = c; bestVal = v; }
  }
  const totalVisits = results.reduce((n, r) => n + (r.visits || 0), 0);
  const totalPlayouts = results.reduce((n, r) => n + (r.playouts || 0), 0);
  const totalW = results.reduce((n, r) => n + (r.winrate || 0) * (r.visits || 0), 0);
  const mergedMoves = [...acc.values()]
    .map(c => ({ move: c.move, visits: c.visits, value: c.wn ? c.wsum / c.wn : 0 }))
    .sort((a, b) => b.visits - a.visits)
    .slice(0, 8);
  return {
    move: best ? best.move : -1,
    visits: totalVisits,
    playouts: totalPlayouts,
    winrate: totalVisits ? totalW / totalVisits : 0,
    value: 0,
    bestMoves: mergedMoves,
    rootMoves: mergedMoves,
    elapsedMs: results.reduce((m, r) => Math.max(m, r.elapsedMs || 0), 0),
    workers: results.length,
    engine: results[0] && results[0].engine,
  };
}
function aiThink(state, budgetMs) {
  const pool = ensureAIPool();
  if (pool.length) {
    return Promise.allSettled(pool.map(slot => aiThinkOnSlot(slot, state, budgetMs))).then(settled => {
      const ok = [];
      for (const r of settled) if (r.status === 'fulfilled' && r.value) ok.push(r.value);
      if (!ok.length) throw new Error('AI worker pool failed');
      return ok.length === 1 ? ok[0] : mergeAIResults(ok);
    });
  }
  // フォールバック: Worker が使えない（file:// 等）ときはメインスレッドで。UI を守るため予算を短縮。
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      try { resolve(mainAIEngine(state).think(state, { budgetMs: Math.min(budgetMs, 1500), returnAllMoves: true, resignThreshold: 0.02 })); }
      catch (err) { reject(err); }
    }, 30);
  });
}
function cancelAI() {
  aiGeneration++;
  aiBusy = false;
  const ov = document.getElementById('aiOv');
  if (ov) ov.classList.add('hidden');
  const ovText = document.getElementById('aiOvText');
  if (ovText) ovText.textContent = 'AI 思考中...';
  aiPool.forEach(slot => { try { slot.worker.terminate(); } catch (e) { } });
  aiPool = [];
  aiWaiters.forEach(waiter => waiter.reject(new Error('AI cancelled')));
  aiWaiters.clear();
}
function aiFallbackMove() {
  try { return aiChoose(); } catch (e) { return -1; }
}
function maybeAI() {
  if (G.over || aiBusy || (mode === 'online' && !isHost)) return;
  if (G.phase === 'setup') return;
  if (G.phase === 'dead') {
    const allAI = Array.from({length: G.playerCount || playerCount}, (_, i) => i + 1).every(p => aiSeatOf(p));
    if ((mode === 'local' || (mode === 'online' && isHost)) && allAI) { finishScore(); after(); }
    return;
  }
  if (G.phase !== 'playing' || !aiSeatOf(G.turn)) return;
  const gen = ++aiGeneration, turn = G.turn;
  const state = aiStateSnapshot(), budget = aiBudgetMs();
  aiBusy = true;
  const ovText = document.getElementById('aiOvText');
  if (ovText) ovText.textContent = 'AI 思考中...';
  document.getElementById('aiOv').classList.remove('hidden');
  const finish = result => {
    if (gen !== aiGeneration) return;
    aiBusy = false;
    document.getElementById('aiOv').classList.add('hidden');
    if (G.over || G.phase !== 'playing' || G.turn !== turn || !aiSeatOf(turn)) return;
    lastAIStats = result || null;
    let move = result && Number.isInteger(result.move) ? result.move : -3;
    if (move === -2) { resign(); after(); return; }
    if (move < 0 || !play(move)) {
      const fb = aiFallbackMove();
      if (fb === -2) resign(); else if (fb < 0 || !play(fb)) doPass();
    }
    after();
  };
  setTimeout(() => {
    if (gen !== aiGeneration || !aiBusy) return;
    aiThink(state, budget).then(finish).catch(err => {
      if (gen !== aiGeneration) return;
      console.warn('[HEXAGO] AI engine failed; falling back to legacy AI:', err);
      finish({ move: aiFallbackMove() });
    });
  }, 120);
}
