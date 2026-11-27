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
    if (!moves.length) return;
    const ply = (G && G.hist) ? G.hist.length : 0;
    const key = ply + ':' + player;
    records.set(key, {
      player,
      ply,
      visits: result.visits || 0,
      winrate: result.winrate,
      moves,
      at: Date.now()
    });
  }

  function getRecord(ply, player) {
    return records.get(ply + ':' + player) || null;
  }

  function clear() { records.clear(); }

  // 盤面に評価値のヒートマップを描く(メイン盤面の上に重ねる)
  function drawOverlay(canvas, ctx, metrics, overlay) {
    if (!enabled || !showOverlay || !overlay) return;
    const { cell, pos } = metrics;
    const r0 = cell * 0.42;
    let maxV = 0, minV = Infinity, maxW = 0;
    for (const m of overlay.moves) {
      maxV = Math.max(maxV, m.visits);
      minV = Math.min(minV, m.visits);
      maxW = Math.max(maxW, m.value);
    }
    const useWinrate = overlayMode === 'winrate';
    overlay.moves.forEach(m => {
      const [x, y] = pos(m.move);
      let t;
      if (useWinrate) t = maxW > 0 ? Math.max(0, m.value) / maxW : 0;
      else t = maxV > minV ? (m.visits - minV) / (maxV - minV) : 1;
      // 赤(弱) → 黄 → 緑(強)
      const hue = 120 * t;
      ctx.save();
      ctx.globalAlpha = 0.35 + 0.4 * t;
      ctx.beginPath(); ctx.arc(x, y, r0, 0, 7);
      ctx.fillStyle = `hsl(${hue}, 85%, 50%)`;
      ctx.fill();
      ctx.globalAlpha = 0.95;
      ctx.strokeStyle = `hsl(${hue}, 70%, 35%)`;
      ctx.lineWidth = 2;
      ctx.stroke();
      // 数値
      ctx.globalAlpha = 1;
      ctx.fillStyle = t > 0.55 ? '#10301a' : '#2a1010';
      ctx.font = `bold ${Math.max(8, cell * 0.22)}px system-ui, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const label = useWinrate ? (m.value * 100).toFixed(0) : String(m.visits > 999 ? Math.round(m.visits / 100) / 10 + 'k' : m.visits);
      ctx.fillText(label, x, y);
      ctx.restore();
    });
  }

  function syncUi() {
    document.body.classList.toggle('debug-on', enabled);
    const t = document.getElementById('debugToggleState');
    if (t) t.textContent = enabled ? 'ON' : 'OFF';
    const panel = document.getElementById('debugPanel');
    if (panel) panel.classList.toggle('hidden', !enabled);
    const btn = document.getElementById('btnDebugMode');
    if (btn) btn.classList.toggle('text-emerald-600', enabled);
  }

  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('btnDebugMode');
    if (btn) btn.onclick = () => { setEnabled(!enabled); if (typeof render === 'function') render(); };
    const toggle = document.getElementById('debugOverlayToggle');
    if (toggle) toggle.onchange = () => { showOverlay = toggle.checked; if (typeof render === 'function') render(); };
    const modeSel = document.getElementById('debugOverlayMode');
    if (modeSel) modeSel.onchange = () => { overlayMode = modeSel.value; if (typeof render === 'function') render(); };
    syncUi();
  });

  window.HexagoDebug = {
    enabled: enabledNow,
    setEnabled,
    recordAI,
    getRecord,
    clear,
    drawOverlay,
    mode: () => overlayMode
  };
})();
