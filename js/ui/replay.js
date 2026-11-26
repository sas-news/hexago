// ===== リプレイ UI =====
// js/core/replay.js の計算結果を受け持ち、再生バー付きのリプレイモーダルと
// 優勢度グラフを描く。結果モーダル・盤面/棋譜モーダル・終局バナーから開ける。
(function () {
  'use strict';
  if (!window.HexagoReplay) return;
  const R = window.HexagoReplay;

  let data = null, geo = null, cur = 0, timer = null, speed = 1, playing = false;
  const BASE_MS = 750;                 // ×1 で1手 750ms
  const SPEEDS = [0.5, 1, 2, 4];

  function stop() {
    if (timer) { clearTimeout(timer); timer = null; }
    playing = false;
    syncPlayButton();
  }

  function syncPlayButton() {
    const b = $('replayPlayBtn');
    if (b) b.textContent = playing ? '⏸ 一時停止' : '▶ 再生';
  }

  function dotHtml(p) { return `<span class="dot" style="background:${playerFill(p)};border-color:${playerStroke(p)}"></span>`; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])); }
  const fmt = v => (Math.round(v * 10) / 10).toFixed(1);

  function pointLabel(point) {
    if (!geo || !Number.isInteger(point) || point < 0 || !geo.points[point]) return '';
    const [q, r] = geo.points[point];
    return `(${q}, ${r})`;
  }

  function eventText(note) {
    if (!note) return '初期局面';
    const who = p => `${dotHtml(p)}<strong>${esc(playerDisplayName(p))}</strong>`;
    if (note.kind === 'play') return `${who(note.player)} が ${pointLabel(note.point)} に着手${note.captured ? `（取石 ${note.captured}）` : ''}`;
    if (note.kind === 'pass') return `${who(note.player)} がパス${note.automatic ? '（連続パス）' : ''}`;
    if (note.kind === 'resign') return `${who(note.player)} が投了`;
    if (note.kind === 'score') return `終局確定（死に石 ${note.removed} 個を除去）${note.result ? ' / ' + esc(note.result) : ''}`;
    return '初期局面';
  }

  function boardCssSize() {
    const card = $('replayCard');
    const w = card && card.clientWidth ? card.clientWidth : Math.min(440, window.innerWidth - 96);
    return Math.max(200, Math.min(360, w - 48));
  }

  // ===== 表示 =====
  function seek(index, options) {
    if (!data) return;
    const n = data.positions.length;
    cur = Math.max(0, Math.min(n - 1, Math.round(Number(index) || 0)));
    const pos = data.positions[cur], row = data.series.rows[cur];
    R.drawBoard($('replayBoard'), geo, pos, {
      cssSize: boardCssSize(),
      themeBoard: theme.board, themeLine: theme.line,
      fills: data.fills, strokes: data.strokes
    });
    drawGraph();
    const lastPly = data.series.rows[data.series.rows.length - 1].ply;
    $('replayPos').textContent = `${row.ply}手 / ${lastPly}手`;
    $('replayEvt').innerHTML = eventText(pos.note);
    $('replaySlider').setAttribute('aria-valuetext', `${row.ply}手`);
    if (!options || !options.fromSlider) $('replaySlider').value = String(cur);
    $('replayFirst').disabled = $('replayPrev').disabled = cur === 0;
    $('replayNext').disabled = $('replayLast').disabled = cur === n - 1;
    updateLegend();
  }

  function tick() {
    if (!playing) return;
    if ($('replayModal').classList.contains('hidden')) { stop(); return; }
    if (cur >= data.positions.length - 1) { stop(); return; }
    seek(cur + 1);
    timer = setTimeout(tick, BASE_MS / speed);
  }

  function togglePlay() {
    if (!data) return;
    if (playing) { stop(); return; }
    if (cur >= data.positions.length - 1) seek(0);
    playing = true; syncPlayButton();
    timer = setTimeout(tick, BASE_MS / speed);
  }

  function updateLegend() {
    const el = $('replayLegend'), row = data.series.rows[cur];
    if (!el || !row) return;
    const pc = data.playerCount;
    const parts = Array.from({ length: pc }, (_, i) => i + 1).map(p => {
      const v = row.lead[p];
      const leadTxt = v === undefined ? '投了' : (Math.abs(v) < 0.05 ? '互角' : `${v > 0 ? '+' : '−'}${fmt(Math.abs(v))} リード`);
      return `<span class="inline-flex items-center gap-1 whitespace-nowrap">${dotHtml(p)}<span>${esc((data.names && data.names[p]) || p + 'P')}</span><span class="font-normal opacity-70">${leadTxt}</span></span>`;
    });
    el.innerHTML = parts.join('<span class="opacity-40 mx-1">·</span>');
  }

  // ===== 優勢度グラフ =====
  function niceStep(maxAbs) {
    for (const s of [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500]) if (maxAbs / s <= 4) return s;
    return Math.ceil(maxAbs / 4);
  }

  function drawGraph() {
    const cv = $('replayGraph'), g = cv.getContext('2d');
    const rows = data.series.rows;
    const cssW = boardCssSize() + 48, cssH = Math.max(130, Math.min(180, Math.round(cssW * 0.42)));
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(cssW * dpr); cv.height = Math.round(cssH * dpr);
    cv.style.width = cssW + 'px'; cv.style.height = cssH + 'px';
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const padL = 34, padR = 10, padT = 10, padB = 18;
    const iw = cssW - padL - padR, ih = cssH - padT - padB;
    let maxAbs = 0;
    for (const row of rows) for (const k of Object.keys(row.lead)) maxAbs = Math.max(maxAbs, Math.abs(row.lead[k]));
    const step = niceStep(Math.max(1, maxAbs));
    maxAbs = Math.max(step, step * Math.ceil(maxAbs / step), 5);
    const y = v => padT + ih / 2 - (v / maxAbs) * (ih / 2);
    const x = i => padL + (rows.length <= 1 ? iw / 2 : (i / (rows.length - 1)) * iw);
    const dark = ['dark', 'cyber'].includes(theme.id);
    g.clearRect(0, 0, cssW, cssH);
    // ガイド線 + 目盛
    g.lineWidth = 1;
    g.fillStyle = dark ? 'rgba(255,255,255,.45)' : 'rgba(0,0,0,.45)';
    g.font = '10px system-ui, sans-serif'; g.textAlign = 'right'; g.textBaseline = 'middle';
    for (let v = -maxAbs; v <= maxAbs + 1e-9; v += step) {
      g.strokeStyle = Math.abs(v) < 1e-9 ? (dark ? 'rgba(255,255,255,.55)' : 'rgba(0,0,0,.5)') : (dark ? 'rgba(255,255,255,.12)' : 'rgba(0,0,0,.1)');
      g.setLineDash(Math.abs(v) < 1e-9 ? [4, 3] : []);
      g.beginPath(); g.moveTo(padL, y(v)); g.lineTo(padL + iw, y(v)); g.stroke();
      g.fillText(String(Math.round(v)), padL - 5, y(v));
    }
    g.setLineDash([]);
    // 各プレイヤーのリード線(2人戦は対称なので 1P の1本のみ)
    const pc = data.playerCount;
    const lines = pc === 2 ? [1] : Array.from({ length: pc }, (_, i) => i + 1);
    lines.forEach(p => {
      g.strokeStyle = playerFill(p); g.lineWidth = 2; g.lineJoin = 'round';
      g.beginPath();
      let started = false;
      for (let k = 0; k < rows.length; k++) {
        const v = rows[k].lead[p];
        if (v === undefined) { started = false; continue; } // 投了済みは線を切る
        if (!started) { g.moveTo(x(k), y(v)); started = true; } else g.lineTo(x(k), y(v));
      }
      g.stroke();
    });
    // 手数ラベル
    g.fillStyle = dark ? 'rgba(255,255,255,.45)' : 'rgba(0,0,0,.45)';
    g.textAlign = 'center'; g.textBaseline = 'top';
    const labelEvery = Math.max(1, Math.ceil(rows.length / 8));
    for (let k = 0; k < rows.length; k++) {
      if (k % labelEvery === 0 || k === rows.length - 1) g.fillText(String(rows[k].ply), Math.min(cssW - 8, Math.max(padL, x(k))), padT + ih + 5);
    }
    // 現在位置カーソル
    const cx = x(cur);
    g.strokeStyle = dark ? 'rgba(255,255,255,.75)' : 'rgba(0,0,0,.65)';
    g.lineWidth = 1.4;
    g.beginPath(); g.moveTo(cx, padT); g.lineTo(cx, padT + ih); g.stroke();
    for (const p of lines) {
      const v = rows[cur].lead[p];
      if (v === undefined) continue;
      g.beginPath(); g.arc(cx, y(v), 3.6, 0, 7);
      g.fillStyle = playerFill(p); g.fill();
      g.strokeStyle = dark ? '#fff' : '#000'; g.lineWidth = 1; g.stroke();
    }
    data.graphGeom = { x, y, padL, padR, cssW, rows };
  }

  // ===== モーダル配線 =====
  if (typeof MODAL_IDS !== 'undefined' && Array.isArray(MODAL_IDS) && !MODAL_IDS.includes('replayModal')) MODAL_IDS.push('replayModal');

  document.addEventListener('DOMContentLoaded', () => {
    const modal = $('replayModal'); if (!modal) return;
    modal.addEventListener('click', e => { if (e.target === modal) { stop(); closeModal(modal); } });
    $('replayClose').onclick = () => { snd.click(); stop(); closeModal($('replayModal')); };
    $('replayPlayBtn').onclick = () => { snd.click(); togglePlay(); };
    $('replayFirst').onclick = () => { snd.click(); stop(); seek(0); };
    $('replayPrev').onclick = () => { snd.click(); stop(); seek(cur - 1); };
    $('replayNext').onclick = () => { snd.click(); stop(); seek(cur + 1); };
    $('replayLast').onclick = () => { snd.click(); stop(); seek(data.positions.length - 1); };
    $('replaySpeed').onchange = e => { const v = parseFloat(e.target.value); if (SPEEDS.includes(v)) speed = v; };
    $('replaySlider').addEventListener('input', e => { stop(); seek(+e.target.value, { fromSlider: true }); });
    // 優勢グラフのタップ/ドラッグでその手へ移動
    const graph = $('replayGraph');
    const seekAt = e => {
      const geom = data && data.graphGeom; if (!geom) return;
      const rc = graph.getBoundingClientRect();
      const t = (e.clientX - rc.left - geom.padL) / Math.max(1, geom.cssW - geom.padL - geom.padR);
      stop(); seek(Math.round(t * (geom.rows.length - 1)));
    };
    graph.addEventListener('pointerdown', e => { graph.setPointerCapture(e.pointerId); seekAt(e); });
    graph.addEventListener('pointermove', e => { if (e.buttons & 1) seekAt(e); });
    // キーボード: ←/→ で1手移動、Space で再生/一時停止
    window.addEventListener('keydown', e => {
      if ($('replayModal').classList.contains('hidden')) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); stop(); seek(cur - 1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); stop(); seek(cur + 1); }
      else if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); togglePlay(); }
    });
    window.addEventListener('resize', () => {
      if ($('replayModal').classList.contains('hidden') || !data) return;
      seek(cur);
    });
    // 入口: 結果モーダル / 終局バナー / 盤面・棋譜モーダル
    $('btnReplayGame').onclick = () => { snd.click(); closeModal($('resModal')); openFromGame(); };
    $('btnShowReplay').onclick = () => { snd.click(); openFromGame(); };
    $('btnOpenReplay').onclick = () => { snd.click(); closeModal($('recordModal')); openFromGame(); };
  });

  // ===== 開く =====
  // record: hexago-kifu v1 互換 (initial/events)。省略時は現在の対局の棋譜。
  function openFromRecord(record, size, playerCount, names) {
    if (!record) return;
    stop();
    geo = R.buildGeometry(size);
    const positions = R.replayPositions(record, geo);
    data = { positions, playerCount, names: names || {}, fills: {}, strokes: {}, series: null, graphGeom: null };
    for (let p = 1; p <= playerCount; p++) {
      data.fills[p] = playerFill(p);
      data.strokes[p] = playerStroke(p);
    }
    data.series = R.advantageSeries(positions, geo, playerCount, names);
    $('replaySlider').max = String(positions.length - 1);
    $('replaySlider').value = '0';
    $('replaySpeed').value = String(speed);
    $('replayTitle').textContent = `対局リプレイ（${size}路盤・${playerCount}人戦）`;
    const sw = data.series.swing, swEl = $('replaySwing');
    if (sw && Math.abs(sw.delta) >= 1) {
      swEl.classList.remove('hidden');
      const who = names && names[sw.player] ? names[sw.player] : sw.player + 'P';
      swEl.innerHTML = `📊 最大の形勢変化: 手数 ${sw.ply} / ${dotHtml(sw.player)}<strong>${esc(who)}</strong> ${sw.delta > 0 ? '+' : '−'}${fmt(Math.abs(sw.delta))}`;
    } else swEl.classList.add('hidden');
    stop();
    $('replayModal').classList.remove('hidden');
    seek(positions.length - 1); // 開いた直後は最新(終局)局面。▶ で0手目から再生
  }

  function openFromGame() {
    if (typeof ensureGameRecord !== 'function') return;
    const record = ensureGameRecord();
    if (!record || !record.events.length) { $('recordExportStatus').textContent = 'まだ手がありません。着手後にリプレイできます。'; return; }
    const pc = G.playerCount || playerCount;
    const names = {};
    for (let p = 1; p <= pc; p++) names[p] = playerDisplayName(p);
    openFromRecord(record, G.size, pc, names);
  }

  window.HexagoReplayUI = { open: openFromGame, openFromRecord, close: () => { stop(); const m = $('replayModal'); if (m) closeModal(m); } };
})();
