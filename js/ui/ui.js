// ===== UI =====
function canUndo() {
  if (G.over || G.phase !== 'playing' || !G.hist.length || aiBusy) return false;
  const top = G.hist[G.hist.length - 1];
  if (mode === 'online') { let k = G.hist.length - 1; while (k >= 0 && aiSeatOf(G.hist[k].by)) k--; return k >= 0 && G.hist[k].by === myRole; }
  return seats[G.turn] === 'human' || seats.slice(1, (G.playerCount || playerCount) + 1).includes('human');
}
function undo() {
  if (!canUndo()) return;
  ensureGameRecord(); clearAutoPass();
  let s = G.hist.pop();
  while (aiSeatOf(s.by) && G.hist.length) s = G.hist.pop();
  G.board = s.board; G.damage = s.damage; G.turn = s.turn; G.passes = s.passes; G.last = s.last; G.out = s.out; G.seen.length = s.seen; setSeen(); prev = -1;
  if (gameFeatures) gameFeatures.rewindRecord(G, s.recordLength);
  after();
}
function after() { updateUI(); save(); sync(); maybeAI(); }
function dotHtml(p) { return `<span class="dot" style="background:${playerFill(p)};border-color:${playerStroke(p)}"></span>`; }
function playerDisplayName(p) { const nick = mode === 'online' ? (seatNicknames[p] || '') : ''; return nick ? `${nick}（${playerName(p)}）` : playerName(p); }
function updateUI() {
  const t = G.turn;
  $('turnInd').innerHTML = `${dotHtml(t)}${playerDisplayName(t)} (${t}P)${aiSeatOf(t) ? ' AI' : ''}${mode === 'online' && t === myRole ? ' ★あなた' : ''}`;
  const countForGrid = G.playerCount || 3;
  $('dmg').style.gridTemplateColumns = `repeat(${Math.ceil(countForGrid / 2)}, minmax(0, 1fr))`;
  $('dmg').innerHTML = Array.from({length:countForGrid},(_,i)=>i+1).map(p => `<span class="min-w-0 whitespace-nowrap text-[11px] sm:text-xs">${dotHtml(p)}${playerDisplayName(p)} <strong>${G.board.filter(v => v === p).length}</strong>${G.out[p] ? '(投)' : ''}</span>`).join('');
  renderModeBadge();
  if (mode === 'online' && !isHost) $('aiOv').classList.toggle('hidden', !(aiSeatOf(G.turn) && !G.over && G.phase === 'playing'));
  $('btnUndo').disabled = !canUndo();
  resetResignButton();
  updateGameFeaturesUI();
  $('bnDead').classList.toggle('hidden', G.phase !== 'dead');
  const deadCountEl = document.getElementById('deadCount');
  if (deadCountEl) {
    if (G.phase === 'dead') {
      const groups = new Set();
      G.dead.forEach(i => { if (G.board[i]) groups.add(group(G.board, i)[0]); });
      deadCountEl.textContent = '自動判定: ' + groups.size + '連 / ' + G.dead.length + '石';
    } else deadCountEl.textContent = '';
  }
  $('bnResult').classList.toggle('hidden', !G.over);
  render();
}

// ===== モードバッジ(ローカル 人・AI の切り替え) =====
// 「ローカル 人・人・AI」の各項目を押すと、その席の人間/AIを切り替える。
// 席の順に並ぶので、どの項目が誰かは位置で分かる(色名は出さない)。
function seatToggleEnabled() {
  if (!G) return false;
  if (mode === 'online') return !!isHost;
  return true;
}
function renderModeBadge() {
  const el = $('modeBadge');
  if (!el) return;
  if (mode === 'online') {
    el.textContent = `オンライン ${myRole ? playerDisplayName(myRole) : 'プール / 観戦'}`;
    el.classList.remove('mode-seats');
    return;
  }
  const pc = G.playerCount || playerCount;
  const enabled = seatToggleEnabled();
  const parts = [];
  for (let p = 1; p <= pc; p++) {
    const isAi = seats[p] === 'ai';
    const turn = (p === G.turn && !G.over) ? ' is-turn' : '';
    parts.push(`<button type="button" class="seat-pill${isAi ? ' is-ai' : ''}${turn}" data-seat="${p}"`
      + ` aria-pressed="${isAi}"${enabled ? '' : ' disabled'}`
      + ` title="${p}P を ${isAi ? '人間' : 'AI'} に切り替え">${isAi ? 'AI' : '人'}</button>`);
  }
  el.classList.add('mode-seats');
  el.innerHTML = `<span class="mode-label">ローカル</span>` + parts.join('<span class="mode-sep">・</span>');
}
document.addEventListener('click', e => {
  const btn = e.target.closest && e.target.closest('#modeBadge .seat-pill');
  if (!btn || btn.disabled) return;
  const p = +btn.dataset.seat;
  if (!p || !seatToggleEnabled()) return;
  if (typeof setSeatMode === 'function') setSeatMode(p, seats[p] === 'ai' ? 'human' : 'ai');
});

// ===== 盤面・棋譜の保存/読み込み と 連続パス =====
function ensureGameRecord() { return gameFeatures ? gameFeatures.ensureRecord(G) : null; }
function recordGameEvent(event) { if (gameFeatures) gameFeatures.appendEvent(G, event); }
function exportCurrentRecord() {
  if (!gameFeatures) return null;
  return gameFeatures.exportRecord(G, { names: Array.from({ length: G.playerCount + 1 }, (_, p) => p ? playerDisplayName(p) : '') });
}
function refreshRecordSummary() {
  if (!G || !gameFeatures) return;
  const record = ensureGameRecord();
  const moves = record.events.filter(e => ['play', 'pass', 'resign'].includes(e.type)).length;
  $('recordSummary').textContent = G.size + '路盤・' + G.playerCount + '人戦・' + moves + '手' + (G.over ? '（対局終了）' : G.phase === 'dead' ? '（終局確認中）' : G.phase === 'setup' ? '（対局開始前）' : '（対局途中）');
  $('recordNotice').textContent = record.note || '';
  $('recordNotice').classList.toggle('hidden', !record.note);
  const libBadge = $('recordLibCount');
  if (libBadge && window.HexagoPhotoStore) libBadge.textContent = String(window.HexagoPhotoStore.list().length);
  const replayBtn = $('btnOpenReplay');
  if (replayBtn) replayBtn.disabled = moves === 0;
}
function downloadRecord(kind) {
  if (!gameFeatures) return;
  const record = exportCurrentRecord(), json = kind === 'json';
  const content = json ? JSON.stringify(record, null, 2) + '\n' : '\uFEFF' + gameFeatures.toText(record);
  const blob = new Blob([content], { type: json ? 'application/json;charset=utf-8' : 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url;
  link.download = 'hexago-' + G.size + '-' + G.playerCount + 'p-' + record.exportedAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z') + (json ? '.json' : '.txt');
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  $('recordExportStatus').textContent = (json ? 'JSON' : 'テキスト') + 'のダウンロードを開始しました。';
}
function saveCurrentBoardToLibrary() {
  if (!G || !window.HexagoPhotoStore) return;
  try {
    const pc = G.playerCount || playerCount;
    const colors = {}, names = {};
    for (let p = 1; p <= pc; p++) {
      colors[p] = { fill: playerFill(p), stroke: playerStroke(p) };
      names[p] = playerName(p);
    }
    const record = ensureGameRecord();
    const moves = (record?.events || []).filter(e => ['play', 'pass', 'resign'].includes(e.type)).length;
    // 盤面だけでなく手順も保存する。これがあると開いたときにリプレイできる。
    // 終局済みなら終局状態(結果・死に石)も一緒に残す。
    const kifu = gameFeatures ? gameFeatures.exportRecord(G, { names: Array.from({ length: pc + 1 }, (_, p) => p ? playerName(p) : '') }) : null;
    const ended = !!(G.over && G.result);
    const finished = ended || G.phase === 'dead';
    const entry = {
      name: `${G.size}路・${pc}人戦（${moves}手）${ended ? '・対局終了' : ''}`,
      size: G.size,
      playerCount: pc,
      board: G.board.slice(),
      turn: G.turn,
      out: G.out.slice(),
      colors,
      names,
      kifu,                       // 手順つき(hexago-kifu と同じ形)
      finished,                   // 終局として保存されたか
      result: ended ? { title: G.result.title } : null,
      dead: (G.dead || []).slice(),
      phase: G.phase,
      meta: { source: 'game', history: !!kifu, ended },
      thumb: typeof makeBoardThumb === 'function' ? makeBoardThumb({ size: G.size, board: G.board, colors }) : ''
    };
    window.HexagoPhotoStore.save(entry);
    refreshRecordSummary();
    if (ended) $('recordExportStatus').textContent = '対局終了として保存しました。開くとリプレイできます。';
    else $('recordExportStatus').textContent = '現在の盤面と手順を端末ライブラリに保存しました。';
  } catch (e) {
    $('recordExportStatus').textContent = 'ライブラリへの保存に失敗しました。';
  }
}
// 盤面・棋譜・ライブラリ・写真から局面を読み込むときは、必ずリプレイ表示を解除する。
// 解除しないと body.replaying が残り、盤面が古いリプレイ局面を描き続けて
// 「読み込んだのに画面が切り替わらない」状態になる。
function exitReplayForLoad() {
  if (typeof window.HexagoReplayUI !== 'undefined' && window.HexagoReplayUI && window.HexagoReplayUI.reset) {
    window.HexagoReplayUI.reset();
  }
  document.body.classList.remove('replaying');
  const bar = $('replayBar');
  if (bar) bar.classList.add('hidden');
  const side = $('replaySide');
  if (side) side.classList.add('hidden');
  const area = $('playArea');
  if (bar && area && bar.parentElement !== area) area.appendChild(bar);
}
function applyImportedKifu(data) {
  const size = Number(data && data.game && data.game.size);
  const pc = Number(data && data.game && data.game.playerCount);
  if (![9, 13, 19, 25].includes(size)) throw new Error('未対応の盤サイズです');
  if (!Number.isInteger(pc) || pc < 2 || pc > 6) throw new Error('未対応の参加人数です');
  const cur = data.currentPosition || data.initialPosition;
  if (!cur || !Array.isArray(cur.board)) throw new Error('盤面データがありません');
  const expectedPts = 3 * ((size + 1) / 2) * ((size - 1) / 2) + 1;
  if (cur.board.length !== expectedPts) throw new Error('盤面サイズと石配列の長さが一致しません');

  if (aiBusy) cancelAI();
  if (mode === 'online') closePeer();
  clearAutoPass();
  exitReplayForLoad();
  mode = 'local'; onlineAI = false; boardView = 'host';
  playerCount = pc; pendingSize = size;
  seats = [0, 'human', 'human', 'human', 'human', 'human', 'human'];
  build(size);
  G = newG(size);
  G.board = cur.board.map(v => (Number.isInteger(v) && v >= 0 && v <= pc) ? v : 0);
  G.turn = (Number.isInteger(cur.turn) && cur.turn >= 1 && cur.turn <= pc) ? cur.turn : 1;
  G.passes = Number.isInteger(cur.passes) && cur.passes >= 0 ? cur.passes : 0;
  G.out = Array.from({ length: pc + 1 }, (_, i) => i > 0 && !!(cur.out && cur.out[i]));
  G.damage = Array.from({ length: pc + 1 }, (_, i) => (cur.damage && Number(cur.damage[i])) || 0);
  G.seen = Array.isArray(cur.seen) && cur.seen.length ? cur.seen.slice() : [hash(G.board)];
  G.dead = Array.isArray(cur.selectedDead) ? cur.selectedDead.filter(i => Number.isInteger(i) && i >= 0 && i < expectedPts) : [];
  G.over = !!cur.over;
  G.phase = cur.phase === 'dead' ? 'dead' : (G.over ? 'ended' : 'playing');
  const events = Array.isArray(data.events) ? data.events : [];
  const lastPlay = [...events].reverse().find(e => e && e.type === 'play' && Number.isInteger(e.point));
  G.last = lastPlay && G.board[lastPlay.point] ? lastPlay.point : -1;
  if (G.over && cur.result && cur.result.title) {
    G.result = { title: String(cur.result.title), details: '読み込んだ棋譜の終局結果です。' };
  }
  if (gameFeatures) {
    const initPos = data.initialPosition && Array.isArray(data.initialPosition.board) && data.initialPosition.board.length === expectedPts
      ? data.initialPosition : cur;
    G.record = {
      version: 1,
      id: (data.game && data.game.id) || (Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)),
      startedAt: (data.game && data.game.startedAt) || null,
      complete: !!data.completeFromStart,
      note: data.note || null,
      initial: JSON.parse(JSON.stringify(initPos)),
      events: events.map(e => {
        const clean = { type: e.type };
        if (e.player != null) clean.player = e.player;
        if (e.point != null) clean.point = e.point;
        if (Array.isArray(e.captured)) clean.captured = e.captured.slice();
        if (e.automatic) clean.automatic = true;
        if (Array.isArray(e.removed)) clean.removed = e.removed.slice();
        if (Array.isArray(e.scores)) clean.scores = e.scores.slice();
        if (e.result != null) clean.result = e.result;
        return clean;
      }),
      endKey: ''
    };
    G.record.endKey = gameFeatures.signature(G);
  }
  G.hist = [];
  setSeen(); prev = -1;
  closeModal($('recordModal'));
  $('setModal').classList.add('hidden');
  $('resModal').classList.add('hidden');
  syncSettings(); resizeCanvas(); updateUI(); save();
  return { kind: 'kifu', size, pc, moves: data.moveCount || events.filter(e => ['play', 'pass', 'resign'].includes(e.type)).length };
}
function importBoardOrKifuJSON(text) {
  const data = JSON.parse(text);
  // 1. hexago-kifu JSON
  if (data && data.format === 'hexago-kifu') {
    return applyImportedKifu(data);
  }
  // 2. ライブラリ配列 JSON（複数局面）
  if (Array.isArray(data)) {
    if (!window.HexagoPhotoStore) throw new Error('ライブラリ機能が利用できません');
    const added = window.HexagoPhotoStore.importJSON(text);
    exitReplayForLoad();
    closeModal($('recordModal'));
    if (window.HexagoPhotoUI && window.HexagoPhotoUI.openLibrary) window.HexagoPhotoUI.openLibrary();
    return { kind: 'library', added };
  }
  // 3. 単一局面 JSON（写真保存・ライブラリエントリ形式）
  if (data && Array.isArray(data.board) && [9, 13, 19, 25].includes(Number(data.size))) {
    if (window.HexagoPhotoUI && window.HexagoPhotoUI.applyToGame) {
      exitReplayForLoad();
      closeModal($('recordModal'));
      window.HexagoPhotoUI.applyToGame(data);
      return { kind: 'position', size: Number(data.size), pc: Number(data.playerCount) || 2 };
    }
  }
  throw new Error('HEXAGO の棋譜または盤面 JSON ではありません');
}
function autoPassContext() {
  const record = ensureGameRecord(), owner = mode === 'online' ? 'online:' + (myRole || 0) : 'local';
  const eligible = Array.from({ length: G.playerCount }, (_, i) => i + 1).filter(p => !G.out[p] && !aiSeatOf(p) && (mode === 'local' || p === myRole));
  return {
    identity: record ? record.id : 'no-record',
    owner,
    revision: record ? record.events.length : 0,
    key: (record ? record.id : '0') + ':' + owner + ':' + (record ? record.events.length : 0) + ':' + G.turn + ':' + G.passes,
    turn: G.turn,
    eligible,
    playing: G.phase === 'playing',
    over: G.over,
    canPass: mine() && !G.out[G.turn],
    busy: aiBusy,
    paused: visibleModals().length > 0,
    connected: mode === 'local' || isHost || !!(hostConn && hostConn.open)
  };
}
function autoPass() {
  if (!autoPassController && gameFeatures) {
    autoPassController = gameFeatures.createAutoPassController({
      getContext: autoPassContext,
      onPass: () => { doPass(true); after(); }
    });
  }
  return autoPassController;
}
function clearAutoPass() { autoPassOfferSeat = 0; if (autoPassController) autoPassController.clear(); }
function escAutoPassHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
function renderAutoPassControls() {
  const el = $('bnAutoPass');
  if (!el || !gameFeatures || !G) return;
  const c = autoPassContext();
  const active = c.playing && !c.over;
  if (!active) autoPassOfferSeat = 0;
  const enabled = active ? autoPass().enabledSeats().filter(p => c.eligible.includes(p)) : [];
  const offer = (active && autoPassOfferSeat && c.eligible.includes(autoPassOfferSeat) && !autoPass().isEnabled(autoPassOfferSeat)) ? autoPassOfferSeat : 0;
  const show = enabled.length > 0 || offer > 0;
  el.classList.toggle('hidden', !show);
  if (!show) { el.replaceChildren(); return; }
  const parts = [];
  if (offer) {
    const label = escAutoPassHtml(playerDisplayName(offer));
    parts.push(
      '<div class="flex items-center justify-between gap-2">' +
        '<span class="min-w-0 truncate">' + dotHtml(offer) + '<strong>' + label + ' (' + offer + 'P)</strong> がパスしました</span>' +
        '<div class="flex items-center gap-1.5 shrink-0">' +
          '<button type="button" data-auto-pass-enable="' + offer + '" class="px-2.5 py-1 rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-bold active:scale-95 transition-all">このまま連続パス</button>' +
          '<button type="button" data-auto-pass-dismiss="1" aria-label="閉じる" title="閉じる" class="w-6 h-6 flex items-center justify-center rounded-full opacity-50 hover:opacity-90 hover:bg-black/5 text-sm font-bold"><svg aria-hidden="true" class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>' +
        '</div>' +
      '</div>'
    );
  }
  if (enabled.length) {
    const chips = enabled.map(p => {
      const label = escAutoPassHtml(playerDisplayName(p));
      return '<button type="button" data-auto-pass-disable="' + p + '" title="タップして連続パスを解除" class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-emerald-700/15 border border-emerald-700/35 text-xs font-bold hover:bg-emerald-700/25 active:scale-95 transition-all">' +
        dotHtml(p) + '<span>' + label + ' (' + p + 'P)</span><span aria-hidden="true" class="opacity-70 ml-0.5"><svg aria-hidden="true" class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></span>' +
      '</button>';
    }).join('');
    parts.push(
      '<div class="flex items-center flex-wrap gap-1.5">' +
        '<span class="text-xs font-bold opacity-75 shrink-0">連続パス中:</span>' + chips +
      '</div>'
    );
  }
  el.innerHTML = parts.join('');
}
function updateGameFeaturesUI() {
  if (!gameFeatures || !G) return;
  autoPass().update();
  renderAutoPassControls();
  if ($('recordModal') && !$('recordModal').classList.contains('hidden')) refreshRecordSummary();
}
if ($('bnAutoPass')) {
  $('bnAutoPass').addEventListener('click', e => {
    const enBtn = e.target.closest('[data-auto-pass-enable]');
    if (enBtn && autoPass()) {
      const p = +enBtn.dataset.autoPassEnable;
      snd.click();
      if (!autoPass().isEnabled(p)) autoPass().toggle(p);
      if (autoPassOfferSeat === p) autoPassOfferSeat = 0;
      renderAutoPassControls();
      return;
    }
    const disBtn = e.target.closest('[data-auto-pass-disable]');
    if (disBtn && autoPass()) {
      const p = +disBtn.dataset.autoPassDisable;
      snd.click();
      autoPass().disable(p);
      renderAutoPassControls();
      return;
    }
    if (e.target.closest('[data-auto-pass-dismiss]')) {
      snd.click();
      autoPassOfferSeat = 0;
      renderAutoPassControls();
    }
  });
}
if ($('btnOpenRecord')) $('btnOpenRecord').onclick = () => { snd.click(); refreshRecordSummary(); $('recordExportStatus').textContent = ''; $('recordModal').classList.remove('hidden'); if (autoPass()) autoPass().update(); };
if ($('btnCloseRecord')) $('btnCloseRecord').onclick = () => closeModal($('recordModal'));
if ($('btnExportJson')) $('btnExportJson').onclick = () => downloadRecord('json');
if ($('btnExportText')) $('btnExportText').onclick = () => downloadRecord('text');
if ($('btnSaveToLibrary')) $('btnSaveToLibrary').onclick = () => { snd.click(); saveCurrentBoardToLibrary(); };
if ($('btnOpenSavedLib')) $('btnOpenSavedLib').onclick = () => {
  snd.click();
  closeModal($('recordModal'));
  if (window.HexagoPhotoUI && window.HexagoPhotoUI.openLibrary) window.HexagoPhotoUI.openLibrary();
};
if ($('btnImportRecord')) $('btnImportRecord').onclick = () => { snd.click(); if ($('recordFile')) $('recordFile').click(); };
if ($('recordFile')) $('recordFile').onchange = () => {
  const f = $('recordFile').files && $('recordFile').files[0];
  $('recordFile').value = '';
  if (!f) return;
  const rd = new FileReader();
  rd.onload = () => {
    try {
      const res = importBoardOrKifuJSON(String(rd.result));
      if (res.kind === 'kifu') $('recordExportStatus').textContent = `棋譜（${res.size}路・${res.pc}人・${res.moves}手）を読み込みました。`;
      else if (res.kind === 'library') $('recordExportStatus').textContent = `${res.added}件の局面をライブラリへ読み込みました。`;
      else $('recordExportStatus').textContent = '盤面を読み込みました。';
    } catch (e) {
      $('recordExportStatus').textContent = '読み込み失敗: ' + (e && e.message ? e.message : '形式を確認してください');
    }
  };
  rd.readAsText(f);
};
