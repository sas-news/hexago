// ===== デバッグモード =====
// AI が各手をどう評価したか(訪問数・勝率)を記録し、盤面にヒートマップで重ねる。
// 記録はこのモードが ON のときだけ。共有URLや棋譜JSONには含めない。
(function () {
  'use strict';
  const KEY = 'hexago-debug';
  let enabled = false;
  // 手数(ply) → { player, moves: [{move, visits, value}], visits, winrate }
  const records = new Map();
  // 訪問数のみを使う(勝率は探索済みの手でしか意味がない)
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
      scored.push({ move: i, value: (v - minV) / span, visits: 0, weight: 0, explored: false });
    }
    // 探索済みの手は探索データを優先(勝率ベース)
    let wMin = Infinity, wMax = -Infinity;
    for (const m of explored) { wMin = Math.min(wMin, m.value); wMax = Math.max(wMax, m.value); }
    const wSpan = Math.max(1e-6, wMax - wMin);
    for (const m of explored) {
      scored.push({ move: m.move, value: (m.value - wMin) / wSpan, visits: m.visits, weight: m.visits, explored: true });
    }
    return scored;
  }

  function getRecord(ply, player) {
    return records.get(ply + ':' + player) || null;
  }

  function clear() { records.clear(); }

  // 盤面に評価値を重ねる。
  //   訪問数のみを使う(勝率は探索した手でしか意味がなく、実質同じ情報だった)。
  //   色は連続グラデーションではなく 4 段階の帯にして「どこが強いか」を読みやすくする。
  //   style: 'heat' … 全点を段階色で塗る
  //          'number' … 探索した手だけ数値を出す
  //          'both' … 段階色 + 探索した手の数値(塗りは共通で二重に濃くしない)
  //   実際に打たれた手は白リングで強調する。
  // 訪問数は 1 桁以上ばらつく(数百 vs 数万)ので、対数スケールで 0..1 に落として
  // 4 段階に分ける。線形だと突出した 1 点以外が全部最下段に潰れてしまう。
  // 実際の分布は「ほぼ 0(未探索)」と「数百〜数万(探索済み)」の2峰になり、
  // 探索済みの中でも差がある。0.70 付近が「探索されたかどうか」の境目。
  // AI は上位手にほぼ均等に探索を配分するため、値は狭い範囲に固まる。
  // そこで「探索したか」を主軸にし、探索量の差は色味で段階化する。
  // 一色(赤)の濃淡で表す。多色より「どこが強いか」が一目で分かる。
  // 未探索はほぼ無色、探索が多いほど濃い赤。
  function heatFill(t) {
    t = Math.max(0, Math.min(1, t));
    // 0.0 → ごく薄い赤 / 1.0 → 濃い赤
    const alpha = 0.14 + 0.58 * Math.pow(t, 0.85);
    const light = 58 - 14 * t;   // 明るさ 58% → 44%
    return `hsla(355, 78%, ${light}%, ${alpha.toFixed(3)})`;
  }
  // 訪問数 → 0..1(対数スケール)。0 は 0 のまま。
  function logRatio(v, max) {
    if (!(v > 0) || !(max > 0)) return 0;
    if (max <= 1) return 1;
    return Math.log(1 + v) / Math.log(1 + max);
  }

  function drawOverlay(canvas, ctx, metrics, overlay) {
    if (!enabled || !showOverlay || !overlay) return;
    const { cell, pos } = metrics;
    const r0 = cell * 0.28;   // 碁石より小さくして紛らわしさを避ける
    const style = overlayStyle;  // 'heat' | 'number' | 'both'
    const all = overlay.all || [];
    const list = (overlay.moves || []).filter(m => m.visits > 0);
    // 相対的な強弱で段階を決める。
    // 「合計に対するシェア」だと全点がほぼ均等になり段階が潰れるため、
    // 一番探索された点を 1.0 とした比率を使う。
    let maxVisits = 0;
    for (const m of all) maxVisits = Math.max(maxVisits, m.visits || 0);
    // 未探索の点は簡易評価の順位で 0..1 に(記録に無ければ 0)
    const unexplored = all.filter(m => !((m.visits || 0) > 0));
    const sortedU = unexplored.slice().sort((a, b) => (a.value || 0) - (b.value || 0));
    const rankOfUnexplored = new Map();
    sortedU.forEach((m, i) => {
      rankOfUnexplored.set(m.move, sortedU.length <= 1 ? 0.5 : i / (sortedU.length - 1));
    });

    // --- 色むら(全点・単一の塗り) ---
    if (style !== 'number') {
      ctx.save();
      for (const m of all) {
        const [x, y] = pos(m.move);
        const explored = (m.visits || 0) > 0;
        const rel = explored ? logRatio(m.visits, maxVisits) : (rankOfUnexplored.get(m.move) || 0) * 0.45;
        ctx.beginPath(); ctx.arc(x, y, r0, 0, 7);
        ctx.fillStyle = heatFill(rel);
        ctx.fill();
      }
      ctx.restore();
    }

    // --- 数値(探索した手のみ / 塗りは heat と共通) ---
    if (style !== 'heat') {
      ctx.save();
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (const m of list) {
        const [x, y] = pos(m.move);
        ctx.fillStyle = 'rgba(255,255,255,0.92)';
        ctx.font = `bold ${Math.max(7, cell * 0.20)}px system-ui, sans-serif`;
        ctx.strokeStyle = 'rgba(0,0,0,0.55)';
        ctx.lineWidth = 2.5;
        ctx.strokeText(shortNum(m.visits), x, y);
        ctx.fillText(shortNum(m.visits), x, y);
      }
      ctx.restore();
    }

  }

  function shortNum(n) {
    if (n >= 100000) return Math.round(n / 1000) + 'k';
    if (n >= 10000) return (n / 1000).toFixed(1) + 'k';
    if (n >= 1000) return (n / 1000).toFixed(2).replace(/\.?0+$/, '') + 'k';
    return String(n);
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
    style: () => overlayStyle,
    setStyle: (v) => { overlayStyle = v; if (typeof render === 'function') render(); }
  };
})();
