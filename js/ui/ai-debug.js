// ===== デバッグモード =====
// AI が各手をどう評価したか(訪問数・勝率)を記録し、盤面にヒートマップで重ねる。
// 記録はこのモードが ON のときだけ。共有URLや棋譜JSONには含めない。
(function () {
  'use strict';
  const KEY = 'hexago-debug';
  let enabled = false;
  // 手数(ply) → { player, moves: [{move, visits, value}], visits, winrate }
  const records = new Map();
  let overlayMode = 'visits';   // 'visits' | 'winrate'
  let overlayStyle = 'heat';    // 'heat' | 'number' | 'both'
  let showOverlay = true;

  try { enabled = localStorage.getItem(KEY) === '1'; } catch (e) { }

  function enabledNow() { return enabled; }

  function setEnabled(on) {
    enabled = !!on;
    try { localStorage.setItem(KEY, enabled ? '1' : '0'); } catch (e) { }
    if (!enabled) records.clear();
    syncUi();
  }

  // AI の手番で選んだ結果を記録する。ply は「その手を打つ前」の手数。
  function recordAI(player, result) {
    if (!enabled || !result) return;
    const list = Array.isArray(result.rootMoves) ? result.rootMoves
      : (Array.isArray(result.bestMoves) ? result.bestMoves : []);
    const moves = list
      .filter(m => m && Number.isInteger(m.move) && m.move >= 0)
      .map(m => ({ move: m.move, visits: Math.max(1, m.visits | 0), value: Number(m.value) || 0 }));
    // AI が探索しなかった空点も、ヒューリスティック評価で埋めて盤全体を塗れるようにする
    const all = buildFullBoardValues(player, moves, window.HexagoReplay ? window.HexagoReplay.buildGeometry((typeof G !== 'undefined' && G) ? G.size : 9) : null);
    if (!moves.length && !all.length) return;
    // 手数は棋譜のイベント数から求める(G.hist は40手で打ち切られるため使えない)
    const ply = (G && G.record && Array.isArray(G.record.events))
      ? G.record.events.filter(e => e.type === 'play' || e.type === 'pass' || e.type === 'resign').length
      : 0;
    const key = ply + ':' + player;
    records.set(key, {
      player,
      ply,
      visits: result.visits || 0,
      winrate: result.winrate,
      moves,
      all,
      best: Number.isInteger(result.move) ? result.move : -1,
      at: Date.now()
    });
  }

  // 探索済み候補に加えて、未探索の空点を軽量な近似評価で補い、盤面全体の値を返す。
  // (エンジンは Worker 内にあるため直接呼べない。ここでは簡易な手厚み評価を使う)
  const DIRS = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]];
  function neighbors(geo, i) {
    const out = [];
    for (const [dq, dr] of DIRS) {
      const k = geo.map[(geo.points[i][0] + dq) + ',' + (geo.points[i][1] + dr)];
      if (k !== undefined) out.push(k);
    }
    return out;
  }
  // その点に打ったときの簡易評価: 自分の石の隣接数 - 相手の石の隣接数 に距離減衰を掛ける
  function quickScore(board, geo, nbCache, i, player) {
    let own = 0, enemy = 0;
    const n1 = nbCache[i] || (nbCache[i] = neighbors(geo, i));
    for (const n of n1) {
      if (!board[n]) continue;
      if (board[n] === player) own++; else enemy++;
    }
    // 2ホップ先も弱く見る(模様)
    let own2 = 0, enemy2 = 0;
    const seen = new Set(n1);
    for (const n of n1) {
      const n2 = nbCache[n] || (nbCache[n] = neighbors(geo, n));
      for (const m of n2) {
        if (seen.has(m) || m === i) continue;
        seen.add(m);
        if (!board[m]) continue;
        if (board[m] === player) own2++; else enemy2++;
      }
    }
    return own * 2 + own2 * 0.5 - enemy * 1.6 - enemy2 * 0.4;
  }

  function buildFullBoardValues(player, explored, geo) {
    const board = (typeof G !== 'undefined' && G && G.board) ? G.board : null;
    if (!board || !geo) return explored.map(m => ({ move: m.move, value: m.value, weight: m.visits, explored: true }));
    const byMove = new Map(explored.map(m => [m.move, m]));
    const nbCache = {};
    const scored = [];
    let minV = Infinity, maxV = -Infinity;
    const quick = [];
    for (let i = 0; i < board.length; i++) {
      if (board[i]) continue;
      if (byMove.has(i)) continue;            // 探索済みは後で上書き
      const v = quickScore(board, geo, nbCache, i, player);
      quick.push([i, v]);
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const span = Math.max(1e-6, maxV - minV);
    for (const [i, v] of quick) {
      scored.push({ move: i, value: (v - minV) / span, weight: 0, explored: false });
    }
    // 探索済みの手は探索データを優先(勝率ベース)
    let wMin = Infinity, wMax = -Infinity;
    for (const m of explored) { wMin = Math.min(wMin, m.value); wMax = Math.max(wMax, m.value); }
    const wSpan = Math.max(1e-6, wMax - wMin);
    for (const m of explored) {
      scored.push({ move: m.move, value: (m.value - wMin) / wSpan, weight: m.visits, explored: true });
    }
    return scored;
  }

  function getRecord(ply, player) {
    return records.get(ply + ':' + player) || null;
  }

  function clear() { records.clear(); }

  // 盤面に評価値を重ねる。
  //   mode: 'heat'   … 盤全体を色むらで塗る(直感的)
  //         'number' … 各点に数値を書く(探索した手のみ)
  //         'both'   … 色むら + 数値
  // 実際に打たれた手は白いリングで強調する。
  function drawOverlay(canvas, ctx, metrics, overlay) {
    if (!enabled || !showOverlay || !overlay) return;
    const { cell, pos } = metrics;
    const r0 = cell * 0.46;
    const useWinrate = overlayMode === 'winrate';
    const style = overlayStyle;  // 'heat' | 'number' | 'both'

    // --- 色むら ---
    if (style !== 'number') {
      const pts = overlay.all || [];
      let maxV = 0;
      for (const m of pts) maxV = Math.max(maxV, m.value);
      ctx.save();
      for (const m of pts) {
        const [x, y] = pos(m.move);
        const t = maxV > 0 ? Math.max(0, m.value) / maxV : 0;
        // 探索された手は濃く、未探索は薄く
        const alpha = (m.explored ? 0.55 : 0.22) * (0.35 + 0.65 * t);
        ctx.globalAlpha = alpha;
        ctx.beginPath(); ctx.arc(x, y, r0, 0, 7);
        ctx.fillStyle = heatColor(t);
        ctx.fill();
      }
      ctx.restore();
    }

    // --- 数値(探索した手のみ) ---
    if (style !== 'heat') {
      const list = overlay.moves || [];
      let maxW = 0, minW = Infinity;
      for (const m of list) { maxW = Math.max(maxW, m.visits); minW = Math.min(minW, m.visits); }
      ctx.save();
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (const m of list) {
        const [x, y] = pos(m.move);
        const t = maxW > minW ? (m.visits - minW) / (maxW - minW) : 1;
        ctx.globalAlpha = 0.85;
        ctx.beginPath(); ctx.arc(x, y, r0 * 0.95, 0, 7);
        ctx.fillStyle = heatColor(t);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.fillStyle = t > 0.55 ? '#0b2a15' : '#3a0d0d';
        ctx.font = `bold ${Math.max(7, cell * 0.19)}px system-ui, sans-serif`;
        const label = useWinrate ? (m.value * 100).toFixed(0) : shortNum(m.visits);
        ctx.fillText(label, x, y);
      }
      ctx.restore();
    }

    // --- 実際に打たれた手を強調 ---
    if (Number.isInteger(overlay.best) && overlay.best >= 0) {
      const [x, y] = pos(overlay.best);
      ctx.save();
      ctx.beginPath(); ctx.arc(x, y, cell * 0.5, 0, 7);
      ctx.lineWidth = Math.max(2.5, cell * 0.09);
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
      ctx.lineWidth = Math.max(1.2, cell * 0.04);
      ctx.strokeStyle = '#111111';
      ctx.stroke();
      ctx.restore();
    }
  }

  function shortNum(n) {
    if (n >= 100000) return Math.round(n / 1000) + 'k';
    if (n >= 10000) return (n / 1000).toFixed(1) + 'k';
    if (n >= 1000) return (n / 1000).toFixed(2).replace(/\.?0+$/, '') + 'k';
    return String(n);
  }
  // 0(悪い)→赤, 0.5→黄, 1(良い)→緑
  function heatColor(t) {
    t = Math.max(0, Math.min(1, t));
    const hue = 120 * t;
    return `hsl(${hue}, 88%, 52%)`;
  }

  function syncUi() {
    document.body.classList.toggle('debug-on', enabled);
    const btn = document.getElementById('btnDebugMode');
    if (btn) {
      btn.textContent = enabled ? 'ON' : 'OFF';
      btn.classList.toggle('bg-emerald-600', enabled);
      btn.classList.toggle('border-emerald-600', enabled);
      btn.classList.toggle('bg-neutral-900', enabled);
      btn.classList.toggle('text-white', enabled);
      btn.classList.toggle('bg-neutral-100', !enabled);
    }
    // パネルはリプレイ中だけ出す(対戦中に表示しても意味がない)
    syncPanel();
  }

  // デバッグパネルの表示を現在の状況に合わせる
  function syncPanel() {
    const panel = document.getElementById('debugPanel');
    if (!panel) return;
    const replaying = typeof window.HexagoReplayView !== 'undefined' && window.HexagoReplayView.active();
    panel.classList.toggle('hidden', !(enabled && replaying));
  }

  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('btnDebugMode');
    if (btn) btn.onclick = () => { setEnabled(!enabled); if (typeof render === 'function') render(); };
    const toggle = document.getElementById('debugOverlayToggle');
    if (toggle) toggle.onchange = () => { showOverlay = toggle.checked; if (typeof render === 'function') render(); };
    const modeSel = document.getElementById('debugOverlayMode');
    if (modeSel) modeSel.onchange = () => { overlayMode = modeSel.value; if (typeof render === 'function') render(); };
    const styleSel = document.getElementById('debugOverlayStyle');
    if (styleSel) styleSel.onchange = () => { overlayStyle = styleSel.value; if (typeof render === 'function') render(); };
    syncUi();
  });

  window.HexagoDebug = {
    enabled: enabledNow,
    setEnabled,
    recordAI,
    getRecord,
    clear,
    drawOverlay,
    syncPanel,
    mode: () => overlayMode,
    style: () => overlayStyle,
    setStyle: (v) => { overlayStyle = v; if (typeof render === 'function') render(); }
  };
})();
