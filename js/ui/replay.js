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
  const GAME_ONLY_IDS = ['dmg', 'turnInd', 'modeBadge', 'bnAutoPass', 'bnDead', 'bnResult', 'statusCard'];

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
      const leadTxt = v === undefined ? '投了' : `${v >= 0 ? '+' : '−'}${fmt(Math.abs(v))}%`;
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
    // グラフはリプレイバー内にあるので、バー(パネル)の実幅に合わせる。
    // 横画面ではパネルが細いので、そちらに追従して幅・高さを決める。
    const bar = $('replayBar');
    const w = bar && bar.clientWidth ? bar.clientWidth : Math.min(520, window.innerWidth - 48);
    const cssW = Math.max(200, Math.min(560, w));
    const h = Math.max(120, Math.min(190, Math.round(cssW * 0.38)));
    return { cssW, cssH: h };
  }

  // グラフ線の縁取り色。盤面の石と同じストローク色を使いつつ、
  // 白背景テーマの「白い石」でも必ず視認できるよう最低限のコントラストを確保する。
  function luminanceOf(c) {
    const m = /^#?([0-9a-f]{6})$/i.exec(c || '');
    if (!m) return 0.5;
    const n = parseInt(m[1], 16);
    return (0.299 * (n >> 16 & 255) + 0.587 * (n >> 8 & 255) + 0.114 * (n & 255)) / 255;
  }
  // グラフの線色。白い石(白背景テーマ)は盤上では縁取りで見えるが、
  // 線上では「白い線」自体が見えないため、線専用の可視色に置き換える。
  // 色見はテーマの石色に寄せたまま、背景とのコントラストを最低限確保する。
  const GRAPH_WHITE_LINE = { light: '#8a8a8a', dark: '#f2f2f2' };
  function graphLineColor(p, dark) {
    const fill = playerFill(p);
    const lum = luminanceOf(fill);
    // 明るすぎる(白系)線は、淡いグレー(明テーマ)/ほぼ白(暗テーマ)へ
    if (lum > 0.78) return dark ? GRAPH_WHITE_LINE.dark : GRAPH_WHITE_LINE.light;
    // 背景と同化する極端に明るい/暗い線も補正
    if (!dark && lum > 0.86) return '#7a7a7a';
    // ダーク背景では黒い石の線が沈むので、明るいグレーへ持ち上げる
    if (dark && lum < 0.22) return '#b9bec4';
    return fill;
  }
  function edgeColorFor(p, dark) {
    const fill = playerFill(p), stroke = playerStroke(p);
    if (luminanceOf(fill) > 0.72) return dark ? '#1a1a1a' : '#2b2b2b';
    if (luminanceOf(fill) < 0.22) return dark ? '#f0f0f0' : '#111111';
    return stroke || (dark ? '#ffffff' : '#000000');
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
    // 各プレイヤーのリード線。白い石の色は白背景と同化して見えないので、
    // 盤面と同じく「縁取り(ストローク色) + 本体(フィル色)」の二重線で描く。
    const pc = data.playerCount;
    const lines = Array.from({ length: pc }, (_, i) => i + 1);
    const trace = (p) => {
      g.beginPath();
      let started = false;
      for (let k = 0; k < rows.length; k++) {
        const v = graphValue(rows[k], p);
        if (v === null) { started = false; continue; } // 投了・終局確定は線を切る
        if (!started) { g.moveTo(x(k), y(v)); started = true; } else g.lineTo(x(k), y(v));
      }
      g.stroke();
    };
    lines.forEach(p => {
      g.lineJoin = 'round'; g.lineCap = 'round';
      g.strokeStyle = graphLineColor(p, dark); g.lineWidth = 2.5;
      trace(p);
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
      g.beginPath(); g.arc(cx, y(v), 4.2, 0, 7);
      g.fillStyle = graphLineColor(p, dark); g.fill();
      g.strokeStyle = dark ? '#111111' : '#ffffff'; g.lineWidth = 1.5; g.stroke();
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
    document.body.classList.toggle('replaying', hidden);
    layoutReplayBar(hidden);
  }

  // 横画面では盤面の右側パネルへ、縦画面では盤面の下へバーを置く
  function layoutReplayBar(on) {
    const bar = $('replayBar'), side = $('replaySide'), area = $('playArea');
    if (!bar || !side || !area) return;
    if (on) {
      const wide = window.innerWidth >= 900 && window.matchMedia('(orientation: landscape)').matches;
      if (wide) { side.appendChild(bar); side.classList.remove('hidden'); }
      else { area.appendChild(bar); side.classList.add('hidden'); }
    } else {
      side.classList.add('hidden');
      // 元の位置(playArea の最後)へ戻す
      if (bar.parentElement !== area) area.appendChild(bar);
    }
  }

  // ===== 開く / 閉じる =====
  function openFromRecord(record, size, playerCount, names) {
    if (!record) return;
    geo = R.buildGeometry(size);
    const positions = R.replayPositions(record, geo);
    data = { positions, playerCount, names: names || {}, fills: {}, strokes: {}, series: null, graphGeom: null, shareRecord: record };
    for (let p = 1; p <= playerCount; p++) {
      data.fills[p] = playerFill(p);
      data.strokes[p] = playerStroke(p);
    }
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
    // CSS のレイアウト確定後にグラフ/盤面を測り直す
    requestAnimationFrame(() => { layoutReplayBar(true); seek(cur); });
    return { size, playerCount, moves: positions.length - 1 };
  }

  // ===== 共有 (URL / 結果カード画像) =====
  function shareBaseUrl() {
    // 既存の #g=... を落として、現在のページURLを返す
    const u = new URL(location.href);
    u.hash = '';
    return u.toString();
  }

  function buildShareUrl(record, size, playerCount, names) {
    const code = R.encodeShare(record, size, playerCount, names);
    return shareBaseUrl() + '#g=' + code;
  }

  function currentShareSource() {
    if (data) {
      return { record: data.shareRecord || null, size: geo.size, playerCount: data.playerCount, names: data.names };
    }
    if (typeof ensureGameRecord !== 'function') return null;
    const record = ensureGameRecord();
    if (!record) return null;
    const pc = G.playerCount || playerCount;
    const names = {};
    for (let p = 1; p <= pc; p++) names[p] = playerDisplayName(p);
    return { record, size: G.size, playerCount: pc, names };
  }

  // 短縮URL (spoo.me)。CORS 許可されているのでブラウザから直接呼べる。
  // 共有URLの断片が長い場合は、見た目をすっきりさせるため短縮を使う。
  // spoo.me の v1 API(CORS 許可・レート制限が緩いレガシーAPIより緩い)を使う
  const SHORTENER = 'https://spoo.me/api/v1/shorten';
  let shareCardCache = null;

  async function shortenUrl(url) {
    const res = await fetch(SHORTENER, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ url })
    });
    if (!res.ok) throw new Error('短縮できませんでした (' + res.status + ')');
    const data = await res.json();
    if (!data || !data.short_url) throw new Error('短縮URLを取得できませんでした');
    return String(data.short_url).replace(/^http:/, 'https:');
  }

  function setShareUrlField(value, kind) {
    const field = $('shareUrl');
    if (field) field.value = value;
    const len = $('shareLen');
    if (len) len.textContent = value.length + ' 文字';
    const info = $('shareLenInfo');
    if (info) {
      info.textContent = kind === 'short'
        ? '開くとこのサイト上で読み込まれ、そのままリプレイが始まります。'
        : '開くとこのサイト上で読み込まれ、そのままリプレイが始まります。';
    }
  }

  // 共有URL: 自前ドメインの ?s=短縮コード 形式に変換する。
  //   https://sas-news.github.io/hexago/?s=Ab3xYz
  //   開くと spoo.me に一度リダイレクトされ、元の対局URLへ戻ってくる。
  //   自前ドメインのまま見せつつ、外部サービスは裏で使う。
  function shortCodeFromUrl(shortUrl) {
    const m = /spoo\.me\/([A-Za-z0-9_-]+)/.exec(shortUrl);
    return m ? m[1] : '';
  }

  // サイトのURL(共有用のディレクトリ)
  function shareSiteUrl() {
    const u = new URL(location.href);
    u.hash = ''; u.search = '';
    return u.toString();
  }

  function selfShareUrl(code) {
    // 現在のページのディレクトリ + ?s=コード (既存のクエリ・ハッシュは落とす)
    const u = new URL(location.href);
    u.hash = '';
    u.search = '?s=' + code;
    return u.toString();
  }

  function showShareModal(fullUrl, source) {
    const sm = $('shareModal');
    if (!sm) return openShareFallback(fullUrl);
    const pc = source.playerCount;
    const moves = source.record.events.filter(e => ['play', 'pass', 'resign'].includes(e.type)).length;
    $('shareSummary').textContent = `${source.size}路盤・${pc}人戦・${moves}手`;
    $('shareStatus').textContent = '';
    setShareUrlField(fullUrl, 'full');
    sm.dataset.fullUrl = fullUrl;
    sm.dataset.shortUrl = '';
    const nativeBtn = $('btnShareNative');
    if (nativeBtn) {
      nativeBtn.classList.toggle('hidden', !navigator.share);
      nativeBtn.classList.toggle('flex', !!navigator.share);
    }
    sm.classList.remove('hidden');
    sm.dataset.sourceJson = JSON.stringify({ size: source.size, playerCount: source.playerCount, names: source.names });
    renderShareCard();
    // 短縮URLを裏で取得し、完了後にカードのサイトURL部分も描き直す
    syncShareUrl().then(() => renderShareCard());
  }

  // カード画像を生成してモーダル内に表示する(モーダルを開いた瞬間に実行)
  function renderShareCard() {
    const sm = $('shareModal');
    if (!sm || sm.classList.contains('hidden')) return;
    const src = currentShareSource();
    if (!src || !src.record) return;
    try {
      shareCardCache = drawShareCard(src.record, src.size, src.playerCount, src.names);
      const host = $('shareCardPreview');
      if (!host) return;
      host.innerHTML = '';
      const img = document.createElement('img');
      img.src = shareCardCache.toDataURL('image/png');
      img.alt = '結果カード';
      img.className = 'w-full rounded-lg border border-neutral-200';
      host.appendChild(img);
    } catch (e) { /* 生成失敗時はプレビュー無しで続行 */ }
  }

  // 短縮URLを取得し、自前ドメインの ?s=形式にする(失敗時は元URLのまま)
  async function syncShareUrl() {
    const sm = $('shareModal');
    if (!sm) return;
    const full = sm.dataset.fullUrl || '';
    const info = $('shareLenInfo');
    if (info) info.textContent = '短縮URLを取得中...';
    try {
      const short = await shortenUrl(full);
      sm.dataset.shortUrl = short;
      const code = shortCodeFromUrl(short) || short.split('/').pop();
      setShareUrlField(selfShareUrl(code), 'short');
    } catch (e) {
      setShareUrlField(full, 'full');
      if (info) info.textContent = '短縮できませんでした。元のURLを使用します（そのまま共有できます）。';
    }
  }

  function openShareFallback(url) {
    try { window.prompt('このURLをコピーしてください', url); } catch (e) { }
  }

  // クリップボードへコピー。iOS Safari はクリップボードAPIが制限されるため
  // 選択状態を作って execCommand にフォールバックする。
  async function copyText(text) {
    // 1) 非同期クリップボードAPI
    try {
      if (navigator.clipboard && window.isSecureContext && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) { /* fallthrough */ }
    // 2) 選択 + execCommand(ユーザー操作内で同期実行する必要がある)
    const field = $('shareUrl');
    if (field) {
      try {
        field.removeAttribute('readonly');
        const prevType = field.type;
        field.focus();
        field.select();
        field.setSelectionRange(0, text.length);
        const ok = document.execCommand('copy');
        field.setAttribute('readonly', 'readonly');
        field.blur();
        if (ok) return true;
      } catch (e) { /* fallthrough */ }
    }
    // 3) 一時 textarea
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) { return false; }
  }

  function currentShareUrl() {
    const sm = $('shareModal');
    if (sm && !sm.classList.contains('hidden')) {
      const field = $('shareUrl');
      if (field && field.value) return field.value;
    }
    const src = currentShareSource();
    return src && src.record ? buildShareUrl(src.record, src.size, src.playerCount, src.names) : '';
  }

  function shareGame() {
    const src = currentShareSource();
    if (!src || !src.record) return;
    const moves = src.record.events.filter(e => ['play', 'pass', 'resign'].includes(e.type)).length;
    if (!moves) { alert('まだ手がありません。着手後に共有できます。'); return; }
    showShareModal(buildShareUrl(src.record, src.size, src.playerCount, src.names), src);
  }

  // ===== 結果カード画像 =====
  // 現在のテーマ色に合わせて描く(盤・背景・文字)。グラフも同じテーマで。
  function cardTheme() {
    const id = theme.id || 'default';
    const isDark = ['dark', 'cyber'].includes(id);
    return {
      dark: isDark,
      bg1: theme.bg, bg2: theme.card,
      board: theme.board, line: theme.line,
      text: theme.tx, sub: isDark ? 'rgba(255,255,255,0.62)' : 'rgba(0,0,0,0.58)',
      panel: theme.card, panelBorder: theme.bd
    };
  }

  function drawShareCard(record, size, playerCount, names) {
    const geo2 = R.buildGeometry(size);
    const positions = R.replayPositions(record, geo2);
    const series = R.advantageSeries(positions, geo2, playerCount, names);
    const t = cardTheme();
    const W = 720, H = 1180;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const g = cv.getContext('2d');

    // 背景(テーマ)
    if (t.dark) { g.fillStyle = t.bg1; g.fillRect(0, 0, W, H); }
    else {
      const grad = g.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, t.bg1); grad.addColorStop(1, t.bg2);
      g.fillStyle = grad; g.fillRect(0, 0, W, H);
    }

    // タイトル
    g.fillStyle = t.text;
    g.font = 'bold 44px system-ui, -apple-system, "Hiragino Sans", sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'top';
    g.fillText('HEXAGO', W / 2, 46);
    g.font = '20px system-ui, sans-serif';
    g.fillStyle = t.sub;
    g.fillText(`${size}路盤・${playerCount}人戦・${series.rows[series.rows.length - 1].ply}手`, W / 2, 102);

    // 盤面(dpr=1 で生成 → そのまま貼れる。はみ出さない)
    const boardSize = 500;
    const board = document.createElement('canvas');
    const fills = {}, strokes = {};
    for (let p = 1; p <= playerCount; p++) { fills[p] = playerFill(p); strokes[p] = playerStroke(p); }
    R.drawBoard(board, geo2, positions[positions.length - 1], {
      cssSize: boardSize, dpr: 1,
      themeBoard: t.board, themeLine: t.line, fills, strokes
    });
    g.drawImage(board, (W - boardSize) / 2, 150, boardSize, boardSize);

    // 優勢グラフ
    const gx = 80, gy = 700, gw = W - 160, gh = 190;
    g.beginPath();
    if (g.roundRect) g.roundRect(gx - 14, gy - 40, gw + 28, gh + 60, 16); else g.rect(gx - 14, gy - 40, gw + 28, gh + 60);
    g.fillStyle = t.panel; g.fill();
    g.strokeStyle = t.panelBorder; g.lineWidth = 2; g.stroke();

    g.fillStyle = t.sub; g.font = 'bold 17px system-ui, sans-serif';
    g.textAlign = 'left'; g.textBaseline = 'top';
    g.fillText('優勢グラフ', gx, gy - 28);

    let maxAbs = 1;
    for (const row of series.rows) for (const k of Object.keys(row.leadPct)) maxAbs = Math.max(maxAbs, Math.abs(row.leadPct[k]));
    const rows = series.rows;
    const yy = v => gy + gh / 2 - (v / maxAbs) * (gh / 2);
    const xx = i => gx + (rows.length <= 1 ? gw / 2 : (i / (rows.length - 1)) * gw);
    g.strokeStyle = t.dark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.16)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(gx, yy(0)); g.lineTo(gx + gw, yy(0)); g.stroke();
    const lines = playerCount === 2 ? [1] : Array.from({ length: playerCount }, (_, i) => i + 1);
    lines.forEach(p => {
      g.strokeStyle = graphLineColor(p, t.dark); g.lineWidth = 2.5; g.lineJoin = 'round';
      g.beginPath();
      let started = false;
      for (let k = 0; k < rows.length; k++) {
        const v = rows[k].leadPct[p];
        if (typeof v !== 'number' || !isFinite(v)) { started = false; continue; }
        if (!started) { g.moveTo(xx(k), yy(v)); started = true; } else g.lineTo(xx(k), yy(v));
      }
      g.stroke();
    });

    // 順位(数値のみ。ラベル文字は付けない)
    const last = series.rows[series.rows.length - 1];
    const order = Array.from({ length: playerCount }, (_, i) => i + 1)
      .sort((a, b) => (last.leadPct[b] ?? -999) - (last.leadPct[a] ?? -999));
    g.textBaseline = 'middle';
    order.forEach((p, idx) => {
      const y = 950 + idx * 34;
      g.fillStyle = playerFill(p);
      g.beginPath(); g.arc(110, y, 10, 0, 7); g.fill();
      g.strokeStyle = t.sub; g.lineWidth = 1.6; g.stroke();
      g.fillStyle = t.text; g.font = 'bold 18px system-ui, sans-serif';
      const nm = (names && names[p]) || `${p}P`;
      g.textAlign = 'left'; g.fillText(`${nm} (${p}P)`, 132, y);
      const lead = last.leadPct[p];
      const leadTxt = (typeof lead === 'number') ? `${lead >= 0 ? '+' : '−'}${Math.abs(lead).toFixed(1)}%` : '投了';
      g.textAlign = 'right'; g.fillText(leadTxt, W - 110, y);
    });

    // 結果
    const scoreEvt = [...record.events].reverse().find(e => e.type === 'score');
    if (scoreEvt && scoreEvt.result) {
      g.textAlign = 'center'; g.textBaseline = 'top';
      g.fillStyle = t.text; g.font = 'bold 22px system-ui, sans-serif';
      g.fillText(scoreEvt.result, W / 2, H - 74);
    }
    // サイトURL(共有用)。共有URLが取得できていればそれを、無ければページのURLを出す。
    g.textAlign = 'center'; g.textBaseline = 'top';
    g.fillStyle = t.sub; g.font = '15px system-ui, sans-serif';
    const siteUrl = (function () {
      const sm = $('shareModal');
      const short = sm && sm.dataset && sm.dataset.shortUrl;
      if (short) return shareSiteUrl();
      const u = new URL(location.href);
      u.hash = ''; u.search = '';
      return u.toString();
    })();
    g.fillText(siteUrl, W / 2, H - 34);
    return cv;
  }

  function downloadShareCard(cv) {
    if (!cv) return;
    cv.toBlob(blob => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const src = currentShareSource();
      a.download = `hexago-${src ? src.size : 9}-${src ? src.playerCount : 2}p.png`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      const st = $('shareStatus'); if (st) st.textContent = '結果カード画像を保存しました。';
    }, 'image/png');
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
    window.addEventListener('resize', () => {
      if (!active()) return;
      layoutReplayBar(true);
      seek(cur);
    });
    window.addEventListener('orientationchange', () => { if (active()) { setTimeout(() => { layoutReplayBar(true); seek(cur); }, 120); } });
    // 共有
    if ($('replayShare')) $('replayShare').onclick = () => { snd.click(); shareGame(); };
    if ($('btnShareGame')) $('btnShareGame').onclick = () => { snd.click(); closeModal($('resModal')); shareGame(); };
    if ($('btnCloseShare')) $('btnCloseShare').onclick = () => closeModal($('shareModal'));
    if ($('btnShareCopy')) $('btnShareCopy').onclick = async () => {
      const url = currentShareUrl();
      if (snd.click) snd.click();
      const ok = await copyText(url);
      const btn = $('btnShareCopy');
      if (ok) {
        $('shareStatus').textContent = 'URLをコピーしました。';
        if (btn) { btn.classList.add('bg-emerald-700'); setTimeout(() => btn.classList.remove('bg-emerald-700'), 1200); }
      } else {
        $('shareStatus').textContent = 'コピーできませんでした。URL欄を選択してコピーしてください。';
        const f = $('shareUrl'); if (f) { f.focus(); f.select(); }
      }
    };
    if ($('btnShareNative')) $('btnShareNative').onclick = async () => {
      const url = currentShareUrl();
      try {
        await navigator.share({ title: 'HEXAGO の対局', url });
        $('shareStatus').textContent = '共有しました。';
      } catch (e) {
        if (e && e.name === 'AbortError') return;
        const ok = await copyText(url);
        $('shareStatus').textContent = ok ? '共有できないため、URLをコピーしました。' : 'URLをコピーしてください。';
      }
    };
    if ($('btnShareSavePng')) $('btnShareSavePng').onclick = () => {
      const src = currentShareSource();
      if (!src || !src.record) return;
      if (snd.click) snd.click();
      // 開いた時点で生成済み。無ければここで生成する。
      if (!shareCardCache) shareCardCache = drawShareCard(src.record, src.size, src.playerCount, src.names);
      downloadShareCard(shareCardCache);
    };

    // 入口: 結果モーダル / 終局バナー / 盤面・棋譜モーダル
    $('btnReplayGame').onclick = () => { snd.click(); closeModal($('resModal')); openFromGame(); };
    $('btnShowReplay').onclick = () => { snd.click(); openFromGame(); };
    $('btnOpenReplay').onclick = () => { snd.click(); closeModal($('recordModal')); openFromGame(); };
  });

  // ===== 共有URLからの起動 =====
  //   #g=<データ>     : データ直接埋め込み(フォールバック用)
  //   ?s=<短縮コード> : 自前ドメインの共有URL → spoo.me へ一度リダイレクトして戻る
  function openFromShareCode(code) {
    const decoded = R.decodeShare(code);
    return openFromRecord(decoded.record, decoded.size, decoded.playerCount, decoded.names || {});
  }

  // ?s=CODE を受けたら、spoo.me に遷移してリダイレクトで元URLへ戻す。
  // ループ防止のため、一度リダイレクトしたことを sessionStorage に記録する。
  function followShortCode(code) {
    const key = 'hexago-short-followed';
    if (sessionStorage.getItem(key) === code) {
      // 戻ってきた(またはループ)のでこれ以上追わない
      sessionStorage.removeItem(key);
      return false;
    }
    sessionStorage.setItem(key, code);
    const target = 'https://spoo.me/' + encodeURIComponent(code);
    location.replace(target);
    return true;
  }

  function tryOpenFromLocation() {
    const hash = location.hash || '';
    const m = /[#&]g=([A-Za-z0-9_-]+)/.exec(hash);
    if (m) {
      try { openFromShareCode(m[1]); return true; }
      catch (e) {
        const msg = e && e.message ? e.message : '共有URLを読み込めませんでした';
        setTimeout(() => alert('共有された対局を開けませんでした: ' + msg), 300);
        return false;
      }
    }
    const q = new URLSearchParams(location.search || '');
    const code = q.get('s');
    if (code && /^[A-Za-z0-9_-]+$/.test(code)) return followShortCode(code);
    return false;
  }

  // render() から参照される公開 API
  window.HexagoReplayView = {
    active,
    position: () => (data ? data.positions[cur] : null),
    boardSize: () => (data ? geo.size : null),
    graphGeom: () => (data ? data.graphGeom : null)
  };
  window.HexagoReplayUI = {
    open: openFromGame,
    openFromRecord,
    close,
    share: shareGame,
    shareUrl: () => { const src = currentShareSource(); return src && src.record ? buildShareUrl(src.record, src.size, src.playerCount, src.names) : ''; },
    openFromShareCode,
    tryOpenFromLocation
  };
  window.addEventListener('load', () => { setTimeout(tryOpenFromLocation, 80); });
})();
