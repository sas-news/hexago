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

// ===== 棋譜と連続パス =====
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
  $('recordExportStatus').textContent = 'ダウンロードを開始しました。';
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
  if (!el || !gameFeatures) return;
  const c = autoPassContext();
  const show = c.playing && !c.over && c.eligible.length > 0;
  el.classList.toggle('hidden', !show);
  if (!show) { el.replaceChildren(); return; }
  el.style.setProperty('--seat-count', G.playerCount);
  el.innerHTML = '<span class="seat-control-label">連続パス:</span>' + Array.from({ length: G.playerCount }, (_, i) => i + 1).map(p => {
    const allowed = c.eligible.includes(p), on = allowed && autoPass().isEnabled(p);
    const hint = allowed ? p + 'P の手番で自動的にパスし続けます' : G.out[p] ? '投了した席です' : aiSeatOf(p) ? '人間の席で利用できます' : '自分の席で利用できます';
    return '<button type="button" role="switch" data-auto-pass="' + p + '" aria-label="' + p + 'Pの連続パス" aria-checked="' + on + '" title="' + hint + '"' + (allowed ? '' : ' disabled') + ' class="pass-switch"><span class="pass-thumb" aria-hidden="true"></span><span class="sr-only">' + (on ? 'ON' : 'OFF') + '</span></button>';
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
