// ===== UI =====
function canUndo() {
  if (G.over || G.phase !== 'playing' || !G.hist.length || aiBusy) return false;
  const top = G.hist[G.hist.length - 1];
  if (mode === 'online') { let k = G.hist.length - 1; while (k >= 0 && aiSeatOf(G.hist[k].by)) k--; return k >= 0 && G.hist[k].by === myRole; }
  return seats[G.turn] === 'human' || seats.slice(1).includes('human');
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
  $('modeBadge').textContent = mode === 'online' ? `オンライン ${myRole ? playerDisplayName(myRole) : 'プール / 観戦'}` : 'ローカル ' + seats.slice(1,playerCount+1).map(s => s === 'ai' ? 'AI' : '人').join('・');
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
    const moves = (ensureGameRecord()?.events || []).filter(e => ['play', 'pass', 'resign'].includes(e.type)).length;
    const entry = {
      name: `${G.size}路・${pc}人戦（${moves}手）`,
      size: G.size,
      playerCount: pc,
      board: G.board.slice(),
      turn: G.turn,
      out: G.out.slice(),
      colors,
      names,
      meta: { source: 'game' }
    };
    window.HexagoPhotoStore.save(entry);
    refreshRecordSummary();
    $('recordExportStatus').textContent = '現在の盤面を端末ライブラリに保存しました。';
  } catch (e) {
    $('recordExportStatus').textContent = 'ライブラリへの保存に失敗しました。';
  }
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
    closeModal($('recordModal'));
    if (window.HexagoPhotoUI && window.HexagoPhotoUI.openLibrary) window.HexagoPhotoUI.openLibrary();
    return { kind: 'library', added };
  }
  // 3. 単一局面 JSON（写真保存・ライブラリエントリ形式）
  if (data && Array.isArray(data.board) && [9, 13, 19, 25].includes(Number(data.size))) {
    if (window.HexagoPhotoUI && window.HexagoPhotoUI.applyToGame) {
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
function clearAutoPass() { if (autoPassController) autoPassController.clear(); }
function renderAutoPassControls() {
  const el = $('autoPassControls');
  const wrap = $('autoPassConfig');
  if (!el || !gameFeatures) return;
  const c = autoPassContext();
  const show = c.playing && !c.over && c.eligible.length > 0;
  if (wrap) wrap.classList.toggle('hidden', !show);
  el.classList.toggle('hidden', !show);
  if (!show) { el.replaceChildren(); return; }
  el.style.setProperty('--seat-count', G.playerCount);
  el.innerHTML = '<span class="seat-control-label">席:</span>' + Array.from({ length: G.playerCount }, (_, i) => i + 1).map(p => {
    const allowed = c.eligible.includes(p), on = allowed && autoPass().isEnabled(p);
    const hint = allowed ? p + 'P の手番で自動的にパスし続けます' : G.out[p] ? '投了した席です' : aiSeatOf(p) ? '人間の席で利用できます' : '自分の席で利用できます';
    return '<div class="flex flex-col items-center gap-1"><span class="text-[11px] font-bold opacity-75">' + p + 'P</span><button type="button" role="switch" data-auto-pass="' + p + '" aria-label="' + p + 'Pの連続パス" aria-checked="' + on + '" title="' + hint + '"' + (allowed ? '' : ' disabled') + ' class="pass-switch"><span class="pass-thumb" aria-hidden="true"></span><span class="sr-only">' + (on ? 'ON' : 'OFF') + '</span></button></div>';
  }).join('');
}
function updateGameFeaturesUI() {
  if (!gameFeatures || !G) return;
  autoPass().update();
  renderAutoPassControls();
  if ($('recordModal') && !$('recordModal').classList.contains('hidden')) refreshRecordSummary();
}
if ($('autoPassControls')) {
  $('autoPassControls').addEventListener('click', e => {
    const button = e.target.closest('[data-auto-pass]');
    if (button && !button.disabled && autoPass()) {
      snd.click();
      autoPass().toggle(+button.dataset.autoPass);
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
