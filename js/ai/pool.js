// ===== AI 制御（MCTS エンジン / Web Worker プール） =====
// エンジン本体は js/ai/engine.js（dev/ai-engine.js の同期コピー）。
// 単一HTML配信（GASプロキシ等）時は index.html 内の <script id="ai-engine-src" type="text/plain">
// から Blob Worker を生成し、外部ファイル読み込みなしで並列探索（root parallel MCTS）を行う。
// 開発用の分割読み込み時は js/ai/worker.js を直接起動する。
// Worker が使えない環境（file:// や厳しいサンドボックス）ではメインスレッド MCTS にフォールバックし、
// それも失敗した場合だけ従来の1手読み AI (aiChoose) にフォールバックする。
// AI 設定: テンポ（'fast' 高速・盤サイズ別自動最適 / 'deep' 長考・盤サイズ別自動最適）と
// 棋風・重み（'solid' 堅実 / 'balanced' バランス / 'aggressive' 攻撃的）を独立に切替可能。
let aiTestBudgetMs = null, lastAIStats = null;
let aiGeneration = 0, aiWorkerError = '', aiMsgSeq = 0, aiWaiters = new Map();
let aiPool = [];   // [{ index, worker, url, failed }]
let aiMainAPI = null, aiMainEngines = Object.create(null);

const AI_WORKER_URL = (function () {
  try {
    const here = document.currentScript && document.currentScript.src;
    return here ? new URL('worker.js', here).href : './js/ai/worker.js';
  } catch (e) { return './js/ai/worker.js'; }
})();

const AI_WORKER_GLUE = [
  'var __hexEngines = Object.create(null);',
  'self.onmessage = function (e) {',
  '  var d = e.data || {};',
  '  var id = d.id;',
  '  try {',
  '    var st = d.state || {};',
  '    var opts = d.options || {};',
  '    var style = (opts.style === "solid" || opts.style === "aggressive") ? opts.style : "balanced";',
  '    var key = String(st.size) + ":" + String(st.playerCount) + ":" + style;',
  '    var eng = __hexEngines[key];',
  '    if (!eng) { eng = HexagoAI.createEngine({ size: st.size, playerCount: st.playerCount, style: style }); __hexEngines[key] = eng; }',
  '    var lastP = 0;',
  '    opts.onProgress = function (p) {',
  '      var t = (typeof performance !== "undefined" ? performance.now() : Date.now());',
  '      if (t - lastP < 250) return;',
  '      lastP = t;',
  '      self.postMessage({ id: id, progress: { visits: p.visits, playouts: p.playouts } });',
  '    };',
  '    var result = eng.think(st, opts);',
  '    self.postMessage({ id: id, ok: true, result: result });',
  '  } catch (err) {',
  '    self.postMessage({ id: id, ok: false, error: String((err && err.stack) || err) });',
  '  }',
  '};',
  ''
].join('\n');

function aiEngineSourceText() {
  const el = typeof document !== 'undefined' && document.getElementById('ai-engine-src');
  return el ? el.textContent.trim() : '';
}
function currentAIMode() {
  return (typeof aiMode === 'string' && (aiMode === 'deep' || aiMode === 'beta')) ? 'deep' : 'fast';
}
function currentAIStyle() {
  return (typeof aiStyle === 'string' && (aiStyle === 'solid' || aiStyle === 'aggressive')) ? aiStyle : 'balanced';
}
function seatStyleOverride(p) {
  if (typeof seatStyles !== 'undefined' && Array.isArray(seatStyles) && p >= 1 && p <= 6) {
    const v = seatStyles[p];
    if (v === 'solid' || v === 'balanced' || v === 'aggressive') return v;
  }
  return null;
}
function aiStyleForSeat(p) {
  return seatStyleOverride(p) || currentAIStyle();
}
function setAIMode(nextMode) {
  const m = (nextMode === 'deep' || nextMode === 'beta') ? 'deep' : 'fast';
  const changed = typeof aiMode !== 'undefined' && aiMode !== m;
  aiMode = m;
  try { localStorage.setItem('hexago-ai-mode', m); } catch (e) { }
  if (changed && !aiBusy && aiPool.length) {
    aiPool.forEach(slot => { try { slot.worker.terminate(); } catch (e) { } });
    aiPool = [];
  }
  return m;
}
function setAIStyle(nextStyle) {
  const s = (nextStyle === 'solid' || nextStyle === 'aggressive') ? nextStyle : 'balanced';
  aiStyle = s;
  if (typeof seatStyles !== 'undefined' && Array.isArray(seatStyles)) {
    for (let p = 1; p <= 6; p++) seatStyles[p] = null;
  }
  return s;
}
function setSeatAIStyle(p, nextStyle) {
  const s = (nextStyle === 'solid' || nextStyle === 'balanced' || nextStyle === 'aggressive') ? nextStyle : null;
  if (typeof seatStyles !== 'undefined' && Array.isArray(seatStyles) && p >= 1 && p <= 6) {
    seatStyles[p] = s;
  }
  return s;
}
// 強さ曲線の実測に基づき、盤サイズごとに最適な思考時間を自動設定する（プレイヤーに秒数を意識させない）。
function aiBudgetMs() {
  if (aiTestBudgetMs != null) return aiTestBudgetMs;
  const pts = (typeof P !== 'undefined' && P.length) || 61;
  if (currentAIMode() === 'deep') {
    if (pts >= 450) return 12000;
    if (pts >= 250) return 10000;
    if (pts >= 120) return 6000;
    return 3000;
  }
  if (pts >= 450) return 2500;
  if (pts >= 250) return 2000;
  if (pts >= 120) return 1200;
  return 800;
}
function aiPoolWant() {
  const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
  let want = currentAIMode() === 'deep'
    ? Math.min(8, Math.max(1, cores))
    : Math.min(4, Math.max(1, cores - 1));
  const mem = (typeof navigator !== 'undefined' && navigator.deviceMemory) || 8;
  if (mem <= 4) want = Math.min(want, 2);
  return Math.max(1, want);
}
function aiEngineLoaded() {
  if (typeof self !== 'undefined' && self.HexagoAI && typeof self.HexagoAI.createEngine === 'function') return true;
  const src = aiEngineSourceText();
  return !!(src && src.indexOf('HexagoAI') >= 0);
}
function makeAIWorkerSlot(index) {
  const src = aiEngineSourceText();
  let url = AI_WORKER_URL;
  let isBlob = false;
  if (src && src.indexOf('HexagoAI') >= 0) {
    url = URL.createObjectURL(new Blob([src + '\n' + AI_WORKER_GLUE], { type: 'application/javascript' }));
    isBlob = true;
  }
  const slot = { index: index, worker: null, url: url, isBlob: isBlob, failed: false };
  const w = new Worker(url);
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
  if (isBlob) setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) { } }, 60000);
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
  if (typeof self !== 'undefined' && self.HexagoAI && typeof self.HexagoAI.createEngine === 'function') {
    aiMainAPI = self.HexagoAI;
    return aiMainAPI;
  }
  const src = aiEngineSourceText();
  if (!src || src.indexOf('HexagoAI') < 0) throw new Error('AI engine is not loaded');
  const sandbox = {};
  const factory = new Function('self', '"use strict";\n' + src + '\nreturn self.HexagoAI;');
  const api = factory(sandbox);
  if (!api || typeof api.createEngine !== 'function') throw new Error('AI engine API is missing');
  aiMainAPI = api;
  return aiMainAPI;
}
function mainAIEngine(state) {
  const style = aiStyleForSeat(state && state.turn);
  const key = state.size + ':' + state.playerCount + ':' + style;
  if (!aiMainEngines[key]) aiMainEngines[key] = ensureMainAI().createEngine({ size: state.size, playerCount: state.playerCount, style: style });
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
    const timer = setTimeout(() => {
      aiWaiters.delete(id);
      slot.failed = true;
      aiWorkerError = 'AI timeout';
      try { slot.worker.terminate(); } catch (e) { }
      reject(new Error('AI timeout'));
    }, budgetMs + 4000);
    aiWaiters.set(id, {
      slot: slot,
      resolve: r => { clearTimeout(timer); resolve(r); },
      reject: e => { clearTimeout(timer); reject(e); },
    });
    slot.worker.postMessage({ id: id, state: state, options: { budgetMs: budgetMs, style: aiStyleForSeat(state && state.turn), returnAllMoves: true, resignThreshold: 0.02 } });
  });
}
// root parallel MCTS: 各 Worker のルート直下の訪問数を合算して着手を選ぶ。
function mergeAIResults(results, state) {
  // 全 Worker が即パス／投了を返した場合はそのまま尊重する
  if (results.every(r => r && r.move === -2)) return Object.assign({}, results[0], { workers: results.length });
  if (results.every(r => r && r.move === -1)) return Object.assign({}, results[0], { workers: results.length });
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
  // 複数 Worker の訪問数合算で、全員一致でないのに不用意なパスが選ばれないよう保護する
  if (best && best.move === -1 && state && !state.passes && !results.every(r => r && r.move === -1)) {
    let placement = null;
    for (const c of acc.values()) {
      if (c.move < 0) continue;
      if (!placement || c.visits > placement.visits || (c.visits === placement.visits && c.wsum / c.wn > placement.wsum / placement.wn)) placement = c;
    }
    const empty = state.board.reduce((count, value) => count + (value === 0 ? 1 : 0), 0);
    if (placement && !(empty <= state.board.length * 0.5 && best.wsum / best.wn >= placement.wsum / placement.wn + 0.02)) best = placement;
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
function runMainThreadAI(state, budgetMs) {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      try { resolve(mainAIEngine(state).think(state, { budgetMs: Math.min(budgetMs, 1500), returnAllMoves: true, resignThreshold: 0.02 })); }
      catch (err) { reject(err); }
    }, 30);
  });
}
function aiThink(state, budgetMs) {
  const pool = ensureAIPool();
  if (pool.length) {
    return Promise.allSettled(pool.map(slot => aiThinkOnSlot(slot, state, budgetMs))).then(settled => {
      const ok = [];
      for (const r of settled) if (r.status === 'fulfilled' && r.value) ok.push(r.value);
      if (!ok.length) return runMainThreadAI(state, budgetMs);
      return ok.length === 1 ? ok[0] : mergeAIResults(ok, state);
    });
  }
  // フォールバック: Worker が使えない（file:// や厳格なサンドボックス等）ときはメインスレッドで。
  return runMainThreadAI(state, budgetMs);
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
  if (G.phase === 'dead') return;
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
    // エンジンのパス判定(-1)は最終決定として尊重する（旧統合ではレガシーAIの
    // 着手で上書きされ、終盤に際限なく石を置き続ける原因だった）。
    if (move === -1) { doPass(); after(); return; }
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
