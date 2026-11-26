// ===== リプレイ UI =====
// js/core/replay.js の計算結果を使い、メイン画面の盤面(cv)そのもので再生する。
// ポップアップは出さず、対局中の情報バーと操作ボタンをリプレイバーへ差し替える。
(function () {
  'use strict';
  if (!window.HexagoReplay) return;
  const R = window.HexagoReplay;

  let data = null, geo = null, cur = 0, timer = null, speed = 1, playing = false;
  const BASE_MS = 750;                 // ×1 で1手 750ms
  const SPEEDS = [0.5, 1, 2, 4];

  // リプレイ中に隠しておく要素(対局用のUI)
  const GAME_ONLY_IDS = ['dmg', 'turnInd', 'modeBadge', 'bnAutoPass', 'bnDead', 'bnResult'];

  // ===== 状態 =====
  function active() { return !!data; }

  function stop() {
    if (timer) { clearTimeout(timer); timer = null; }
    playing = false;
    syncPlayButton();
  }

  function syncPlayButton() {
    const icon = $('replayPlayIcon'), label = $('replayPlayLabel');
    if (label) label.textContent = playing ? '一時停止' : '再生';
    if (icon) icon.innerHTML = playing
      ? '<svg aria-hidden="true" class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>'
      : '<svg aria-hidden="true" class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
  }

  function dotHtml(p) { return `<span class="dot" style="background:${playerFill(p)};border-color:${playerStroke(p)}"></span>`; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])); }
  const fmt = v => (Math.round(v * 10) / 10).toFixed(1);

  // 表示名: ニックネームや色名に加えて席番号(nP)を併記して区別しやすくする
  function seatName(p) {
    const base = (data && data.names && data.names[p]) || playerDisplayName(p) || '';
    return base ? `${base} ${p}P` : `${p}P`;
  }

  function pointLabel(point) {
    if (!geo || !Number.isInteger(point) || point < 0 || !geo.points[point]) return '';
    const [q, r] = geo.points[point];
    return `(${q}, ${r})`;
  }

  function eventText(note) {
    if (!note) return '初期局面';
    const who = p => `${dotHtml(p)}<strong>${esc(seatName(p))}</strong>`;
    if (note.kind === 'play') return `${who(note.player)} が ${pointLabel(note.point)} に着手${note.captured ? `（取石 ${note.captured}）` : ''}`;
    if (note.kind === 'pass') return `${who(note.player)} がパス${note.automatic ? '（連続パス）' : ''}`;
    if (note.kind === 'resign') return `${who(note.player)} が投了`;
    if (note.kind === 'score') return `終局確定（死に石 ${note.removed} 個を除去）${note.result ? ' / ' + esc(note.result) : ''}`;
    return '初期局面';
  }

  // ===== 表示 =====
  function seek(index, options) {
    if (!data) return;
    const n = data.positions.length;
    cur = Math.max(0, Math.min(n - 1, Math.round(Number(index) || 0)));
    const pos = data.positions[cur], row = data.series.rows[cur];
    // メイン盤面(cv)をリプレイ局面で描き直す
    if (typeof render === 'function') render();
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
    if (!active()) { stop(); return; }
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
      const v = row.leadPct[p];
      const leadTxt = v === undefined ? '投了' : (Math.abs(v) < 0.1 ? '互角' : `${v > 0 ? '+' : '−'}${fmt(Math.abs(v))}% リード`);
      return `<span class="inline-flex items-center gap-1 whitespace-nowrap">${dotHtml(p)}<span>${esc(seatName(p))}</span><span class="font-normal opacity-70">${leadTxt}</span></span>`;
    });
    el.innerHTML = parts.join('<span class="opacity-40 mx-1">·</span>');
  }

  // ===== 優勢グラフ =====
  function niceStep(maxAbs) {
    for (const s of [1, 2, 5, 10, 20, 25, 50, 100]) if (maxAbs / s <= 4) return s;
    return Math.ceil(maxAbs / 4);
  }

  function graphSize() {
    const cvEl = $('cv');
    const w = cvEl ? cvEl.getBoundingClientRect().width : Math.min(520, window.innerWidth - 64);
    return { cssW: Math.max(240, w), cssH: Math.max(140, Math.min(200, Math.round(w * 0.4))) };
  }

  // グラフの値。終局(score)の公式確定スコアは点スケールが桁違いなので
  // リード%の系列としては使わず、最終局面は直前の形勢を引き継ぐ。
  function graphValue(row, p) {
    const v = row.leadPct[p];
    return typeof v === 'number' && isFinite(v) ? v : null;
  }

  function drawGraph() {
    const cvEl = $('replayGraph');
    if (!cvEl) return;
    const g = cvEl.getContext('2d');
    const rows = data.series.rows;
    const { cssW, cssH } = graphSize();
    const dpr = window.devicePixelRatio || 1;
    cvEl.width = Math.round(cssW * dpr); cvEl.height = Math.round(cssH * dpr);
    cvEl.style.width = cssW + 'px'; cvEl.style.height = cssH + 'px';
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const padL = 38, padR = 10, padT = 10, padB = 18;
    const iw = cssW - padL - padR, ih = cssH - padT - padB;
    let maxAbs = 0;
    for (const row of rows) for (const k of Object.keys(row.leadPct)) {
      const v = graphValue(row, +k);
      if (v !== null) maxAbs = Math.max(maxAbs, Math.abs(v));
    }
    // 序盤は小さい値でも潰れないよう、最低スケールを確保しつつ数値に合わせる
    const step = niceStep(Math.max(1, maxAbs || 1));
    const range = Math.max(step, step * Math.ceil((maxAbs || 1) / step), 5);
    const y = v => padT + ih / 2 - (v / range) * (ih / 2);
    const x = i => padL + (rows.length <= 1 ? iw / 2 : (i / (rows.length - 1)) * iw);
    const dark = ['dark', 'cyber'].includes(theme.id);
    g.clearRect(0, 0, cssW, cssH);
    // ガイド線 + 目盛(%)
    g.lineWidth = 1;
    g.fillStyle = dark ? 'rgba(255,255,255,.45)' : 'rgba(0,0,0,.45)';
    g.font = '10px system-ui, sans-serif'; g.textAlign = 'right'; g.textBaseline = 'middle';
    for (let v = -range; v <= range + 1e-9; v += step) {
      g.strokeStyle = Math.abs(v) < 1e-9 ? (dark ? 'rgba(255,255,255,.55)' : 'rgba(0,0,0,.5)') : (dark ? 'rgba(255,255,255,.12)' : 'rgba(0,0,0,.1)');
      g.setLineDash(Math.abs(v) < 1e-9 ? [4, 3] : []);
      g.beginPath(); g.moveTo(padL, y(v)); g.lineTo(padL + iw, y(v)); g.stroke();
      g.fillText(Math.round(v) + '%', padL - 5, y(v));
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
        const v = graphValue(rows[k], p);
        if (v === null) { started = false; continue; } // 投了・終局確定は線を切る
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
      const v = graphValue(rows[cur], p);
      if (v === null) continue;
      g.beginPath(); g.arc(cx, y(v), 3.6, 0, 7);
      g.fillStyle = playerFill(p); g.fill();
      g.strokeStyle = dark ? '#fff' : '#000'; g.lineWidth = 1; g.stroke();
    }
    data.graphGeom = { x, y, padL, padR, cssW, rows };
  }

  // ===== 画面の切り替え =====
  const HIDDEN_BEFORE = new Map();
  function setGameUiHidden(hidden) {
    // 隠す前の表示状態を覚えておき、終了時にそのまま戻す
    const targets = [...GAME_ONLY_IDS];
    if (hidden) {
      targets.forEach(id => {
        const el = $(id);
        if (el) { HIDDEN_BEFORE.set(id, el.classList.contains('hidden')); el.classList.add('hidden'); }
      });
      // 操作ボタンは親の行ごと隠す
      const row = $('btnUndo') && $('btnUndo').parentElement;
      if (row) { HIDDEN_BEFORE.set('__actionRow', row.classList.contains('hidden')); row.classList.add('hidden'); }
      const hint = document.querySelector('p.text-xs.opacity-60.text-center');
      if (hint) { HIDDEN_BEFORE.set('__hint', hint.classList.contains('hidden')); hint.classList.add('hidden'); }
    } else {
      targets.forEach(id => {
        const el = $(id);
        if (el && HIDDEN_BEFORE.has(id)) el.classList.toggle('hidden', HIDDEN_BEFORE.get(id));
      });
      const row = $('btnUndo') && $('btnUndo').parentElement;
      if (row && HIDDEN_BEFORE.has('__actionRow')) row.classList.toggle('hidden', HIDDEN_BEFORE.get('__actionRow'));
      const hint = document.querySelector('p.text-xs.opacity-60.text-center');
      if (hint && HIDDEN_BEFORE.has('__hint')) hint.classList.toggle('hidden', HIDDEN_BEFORE.get('__hint'));
      HIDDEN_BEFORE.clear();
    }
    const bar = $('replayBar');
    if (bar) bar.classList.toggle('hidden', !hidden);
  }

  // ===== 開く / 閉じる =====
  function openFromRecord(record, size, playerCount, names) {
    if (!record) return;
    geo = R.buildGeometry(size);
    const positions = R.replayPositions(record, geo);
    data = { positions, playerCount, names: names || {}, series: null, graphGeom: null };
    data.series = R.advantageSeries(positions, geo, playerCount, names);
    stop();
    $('replaySlider').max = String(positions.length - 1);
    $('replaySlider').value = '0';
    $('replaySpeed').value = String(speed);
    $('replayTitle').textContent = `${size}路盤・${playerCount}人戦`;
    const sw = data.series.swing, swEl = $('replaySwing');
    if (sw && Math.abs(sw.delta) >= 1) {
      swEl.classList.remove('hidden');
      swEl.innerHTML = `最大の形勢変化: ${sw.ply}手目 ${dotHtml(sw.player)}<strong>${esc(seatName(sw.player))}</strong> ${sw.delta > 0 ? '+' : '−'}${fmt(Math.abs(sw.delta))}%`;
    } else swEl.classList.add('hidden');
    setGameUiHidden(true);
    seek(positions.length - 1); // まず終局(最新)局面。再生ボタンで0手目から
  }

  function openFromGame() {
    if (typeof ensureGameRecord !== 'function') return;
    const record = ensureGameRecord();
    if (!record || !record.events.length) {
      const st = $('recordExportStatus');
      if (st) st.textContent = 'まだ手がありません。着手後にリプレイできます。';
      return;
    }
    const pc = G.playerCount || playerCount;
    const names = {};
    for (let p = 1; p <= pc; p++) names[p] = playerDisplayName(p);
    openFromRecord(record, G.size, pc, names);
  }

  function close() {
    if (!data) return;
    stop();
    data = null;
    setGameUiHidden(false);
    if (typeof updateUI === 'function') updateUI(); // 盤面を現在の対局局面に戻す
  }

  // ===== 配線 =====
  document.addEventListener('DOMContentLoaded', () => {
    const bar = $('replayBar'); if (!bar) return;
    $('replayExit').onclick = () => { snd.click(); close(); };
    $('replayPlayBtn').onclick = () => { snd.click(); togglePlay(); };
    $('replayFirst').onclick = () => { snd.click(); stop(); seek(0); };
    $('replayPrev').onclick = () => { snd.click(); stop(); seek(cur - 1); };
    $('replayNext').onclick = () => { snd.click(); stop(); seek(cur + 1); };
    $('replayLast').onclick = () => { snd.click(); stop(); seek(data.positions.length - 1); };
    $('replaySpeed').onchange = e => { const v = parseFloat(e.target.value); if (SPEEDS.includes(v)) speed = v; };
    $('replaySlider').addEventListener('input', e => { stop(); seek(+e.target.value, { fromSlider: true }); });
    // 優勢グラフのタップ/ドラッグでその手へ移動
    const graph = $('replayGraph');
    let dragging = false;
    const seekAt = e => {
      const geom = data && data.graphGeom; if (!geom) return;
      const rc = graph.getBoundingClientRect();
      const t = (e.clientX - rc.left - geom.padL) / Math.max(1, geom.cssW - geom.padL - geom.padR);
      stop(); seek(Math.round(t * (geom.rows.length - 1)));
    };
    graph.addEventListener('pointerdown', e => { stop(); dragging = true; try { graph.setPointerCapture(e.pointerId); } catch (_) { } seekAt(e); });
    graph.addEventListener('pointermove', e => { if (dragging) seekAt(e); });
    graph.addEventListener('pointerup', () => { dragging = false; });
    graph.addEventListener('pointercancel', () => { dragging = false; });
    // キーボード: ←/→ で1手移動、Space で再生/一時停止
    window.addEventListener('keydown', e => {
      if (!active()) return;
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement && document.activeElement.tagName)) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); stop(); seek(cur - 1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); stop(); seek(cur + 1); }
      else if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); togglePlay(); }
      else if (e.key === 'Escape') { close(); }
    });
    window.addEventListener('resize', () => { if (active()) seek(cur); });
    // 入口: 結果モーダル / 終局バナー / 盤面・棋譜モーダル
    $('btnReplayGame').onclick = () => { snd.click(); closeModal($('resModal')); openFromGame(); };
    $('btnShowReplay').onclick = () => { snd.click(); openFromGame(); };
    $('btnOpenReplay').onclick = () => { snd.click(); closeModal($('recordModal')); openFromGame(); };
  });

  // render() から参照される公開 API
  window.HexagoReplayView = {
    active,
    position: () => (data ? data.positions[cur] : null),
    boardSize: () => (data ? geo.size : null),
    graphGeom: () => (data ? data.graphGeom : null)
  };
  window.HexagoReplayUI = { open: openFromGame, openFromRecord, close };
})();
