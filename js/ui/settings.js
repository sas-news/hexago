// ===== プレイヤー設定 =====
const SEAT_MODES = ['human', 'ai'];
const SEAT_LABELS = { human: '人間', ai: 'AI' };
const AI_MODE_LABELS = { fast: '高速', deep: '長考' };
function canManageRoom() { return mode === 'local' || !roomCode || isHost; }
function isMatchRunning() { return !!(G && G.phase !== 'setup' && !G.over); }
function setSeatAIFlag(p) {
  if (!G || p < 1 || p > (G.playerCount || 0) || !G.aiSeats) return;
  if (mode === 'online') G.aiSeats[p] = seats[p] !== 'human' || !seatOwners[p];
  else G.aiSeats[p] = seats[p] !== 'human';
  G.aiSeat = G.aiSeats.findIndex((v, i) => i > 0 && v);
}
function releaseSeat(p) {
  const owner = seatOwners[p];
  if (owner && roomPool[owner]) roomPool[owner].seat = null;
  if (owner === LOCAL_HOST_ID && myRole === p) myRole = null;
  seatOwners[p] = null;
  seatNicknames[p] = '';
}
function setSeatMode(p, nextMode, quiet=false) {
  if (!canManageRoom() || p < 1 || p > 6 || !SEAT_MODES.includes(nextMode)) return;
  if (seats[p] === nextMode) return;
  if (nextMode === 'ai') releaseSeat(p);
  if (typeof setSeatAIMode === 'function') setSeatAIMode(p, null);
  seats[p] = nextMode;
  setSeatAIFlag(p);
  // AI → 人間に切り替えたら、その席の思考は残り秒数に関係なく即座に打ち切る。
  // 思考中は Worker を terminate し、結果は捨てる(盤面を汚さない)。
  if (nextMode === 'human' && typeof aiBusy !== 'undefined' && aiBusy) {
    const thinkingSeat = (typeof G !== 'undefined' && G && Number.isInteger(G.turn)) ? G.turn : 0;
    if (!thinkingSeat || thinkingSeat === p) {
      if (typeof cancelAI === 'function') cancelAI();
      const ov = document.getElementById('aiOv'); if (ov) ov.classList.add('hidden');
    }
  }
  // 途中で人間⇔AIを切り替えたことを棋譜に残す(リプレイで表示する)
  if (typeof recordGameEvent === 'function' && typeof ensureGameRecord === 'function' && G && G.record) {
    try { recordGameEvent({ type: 'seat', player: p, ai: seats[p] !== 'human' }); } catch (e) { }
  }
  if (!quiet) {
    snd.click(); syncSettings();
    if (mode === 'online' && isHost) sync();
    after();
  }
}
function setAllSeatModes(value) {
  if (!canManageRoom()) return;
  for (let p = 1; p <= 6; p++) setSeatMode(p, value, true);
  snd.click(); syncSettings();
  if (mode === 'online' && isHost) sync();
  after();
}
// 設定画面に出す「人数・盤面サイズ」。
// 対局中は今の対局の設定を出し、変えた値は次局の予約として持っておく。
// そうしないと、開き直したときに現在の盤面と食い違う値が選択されて見える。
function shownPlayerCount() { return isMatchRunning() ? (G.playerCount || playerCount) : playerCount; }
function shownSize() { return isMatchRunning() ? G.size : pendingSize; }
// 対局中に選んだ「その場だけの表示」。保存せず、設定を開き直すと捨てる。
// (対局中の盤面と食い違う値を残さないため)
let transientPc = null, transientSize = null, transientMode = null;
function clearTransientSettings() { transientPc = null; transientSize = null; transientMode = null; }

// overridePc / overrideSize / overrideMode は「その場だけの表示」。
// 対局中に選んでも確定させないため、保存せず見た目だけ切り替える。
function syncSettings(overridePc, overrideSize, overrideMode) {
  if (overridePc != null) transientPc = overridePc;
  if (overrideSize != null) transientSize = overrideSize;
  if (overrideMode != null) transientMode = overrideMode;
  const showPc = transientPc != null ? transientPc : shownPlayerCount();
  const showSize = transientSize != null ? transientSize : shownSize();
  document.querySelectorAll('#playerCountBtns .opt').forEach(b => {
    b.classList.toggle('on', +b.dataset.count === showPc);
    b.disabled = mode === 'online' && !!roomCode && !isHost;
  });
  document.querySelectorAll('#sizeBtns .opt').forEach(b => {
    b.classList.toggle('on', +b.dataset.v === showSize);
    b.disabled = mode === 'online' && !!roomCode && !isHost;
  });
  // 対局中は「いま対局中のモード」を出す。選んだだけの予約は次局で反映される。
  const showMode = transientMode || (isMatchRunning() ? mode : selectedMode);
  document.querySelectorAll('#modeBtns .opt').forEach(b => b.classList.toggle('on', b.dataset.v === showMode));
  $('onlineBox').classList.toggle('hidden', showMode !== 'online');
  const participantView = mode === 'online' && boardView === 'participant';
  $('onlineRoleConfig').classList.toggle('hidden', showMode !== 'online');
  $('seatBox').classList.toggle('hidden', participantView);
  ['boardSizeConfig', 'playerCountConfig', 'aiModeConfig', 'soundConfig'].forEach(id => $(id).classList.toggle('hidden', participantView));
  const bulkMode = typeof currentAIMode === 'function' ? currentAIMode() : 'fast';
  document.querySelectorAll('#aiModeBtns .opt').forEach(b => {
    const active = b.dataset.aiMode === bulkMode;
    b.classList.toggle('on', active);
    b.setAttribute('aria-pressed', String(active));
    b.disabled = !canManageRoom();
  });
  $('btnNew').classList.toggle('hidden', participantView);
  $('hostRoomSection').classList.toggle('hidden', participantView);
  $('joinRoomSection').classList.toggle('hidden', !participantView);
  $('btnHostBoard').classList.toggle('on', !participantView);
  $('btnParticipantBoard').classList.toggle('on', participantView);
  $('seatBtns').innerHTML = '';
  for (let p = 1; p <= showPc; p++) {
    const row = document.createElement('div'); row.className = 'flex items-center gap-1.5';
    const label = document.createElement('span'); label.className = 'w-16 shrink-0 text-xs font-bold text-neutral-700';
    label.textContent = `${p}P ${playerName(p)}`; row.appendChild(label);
    const ovMode = typeof seatAIModeOverride === 'function' ? seatAIModeOverride(p) : null;
    for (const value of SEAT_MODES) {
      const b = document.createElement('button'); b.type = 'button';
      b.className = 'opt flex-1' + (seats[p] === value ? ' on' : '');
      if (value === 'ai') {
        b.dataset.seatAi = String(p);
        b.textContent = (seats[p] === 'ai' && ovMode) ? `AI（${AI_MODE_LABELS[ovMode]}）` : SEAT_LABELS.ai;
        b.title = 'AIを繰り返しタップで席ごとのテンポを切替';
      } else {
        b.textContent = SEAT_LABELS[value];
      }
      b.disabled = !canManageRoom();
      if (seats[p] === value) b.setAttribute('aria-pressed', 'true');
      b.onclick = () => {
        if (value === 'ai' && seats[p] === 'ai') {
          if (!canManageRoom()) return;
          snd.click();
          const nextM = ovMode ? null : (bulkMode === 'fast' ? 'deep' : 'fast');
          if (typeof setSeatAIMode === 'function') setSeatAIMode(p, nextM);
          syncSettings(); save();
          return;
        }
        setSeatMode(p, value);
      };
      row.appendChild(b);
    }
    $('seatBtns').appendChild(row);
  }
  document.querySelectorAll('[data-bulk]').forEach(b => b.disabled = !canManageRoom());
  $('btnSound').textContent = snd.on ? 'ON' : 'OFF'; $('btnSound').classList.toggle('on', snd.on);
  $('btnCreate').disabled = !!(mode === 'online' && roomCode && !isHost);
  $('btnJoin').disabled = !!(mode === 'online' && isHost);
  document.querySelectorAll('[data-board-view]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.boardView === boardView)));
  renderRoomUI();
}
document.querySelectorAll('#playerCountBtns .opt').forEach(b => b.onclick = () => {
  if (mode === 'online' && roomCode && !isHost) return;
  snd.click();
  const next = +b.dataset.count;
  if (isMatchRunning()) {
    // 対局中は確定させない。その場で表示だけ切り替え、開き直すと対局中の値に戻る。
    syncSettings(next);
    return;
  }
  const old = playerCount; playerCount = next;
  for (let p = old + 1; p <= playerCount; p++) if (!seats[p]) seats[p] = 'human';
  for (let p = playerCount + 1; p <= 6; p++) if (seatOwners[p]) releaseSeat(p);
  syncSettings(); save(); if (mode === 'online' && isHost) sync();
});
document.querySelectorAll('#sizeBtns .opt').forEach(b => b.onclick = () => {
  if (mode === 'online' && roomCode && !isHost) return;
  snd.click();
  const next = +b.dataset.v;
  if (isMatchRunning()) { syncSettings(null, next); return; } // 対局中は表示だけ
  pendingSize = next; syncSettings(); save(); if (mode === 'online' && isHost) sync();
});
// モードの選択は「予約」に留める。ここで対局や接続に手を出すと、
// まだ何も決めていないのに盤面が消えたり切断されたりする。
// 実際の切り替えは「ニューゲームスタート」(reset) のときに確定する。
document.querySelectorAll('#modeBtns .opt').forEach(b => b.onclick = () => {
  snd.click();
  if (isMatchRunning()) { syncSettings(null, null, b.dataset.v); return; } // 対局中は表示だけ
  if (selectedMode === b.dataset.v) return;
  selectedMode = b.dataset.v;
  if (selectedMode !== 'online') boardView = 'host';
  syncSettings();
});
document.querySelectorAll('[data-bulk]').forEach(b => b.onclick = () => setAllSeatModes(b.dataset.bulk));
document.querySelectorAll('#aiModeBtns .opt').forEach(b => b.onclick = () => {
  if (!canManageRoom()) return;
  snd.click();
  if (typeof setAIMode === 'function') setAIMode(b.dataset.aiMode);
  syncSettings(); save();
});
$('btnHostBoard').onclick = () => { boardView = 'host'; syncSettings(); };
$('btnParticipantBoard').onclick = () => { boardView = 'participant'; syncSettings(); };
$('btnSound').onclick = () => { snd.on = !snd.on; syncSettings(); snd.click(); save(); };
$('btnOpenSettings').onclick = () => { snd.click(); clearTransientSettings(); syncSettings(); $('setModal').classList.remove('hidden'); if (typeof autoPass === 'function' && autoPass()) autoPass().update(); };
$('btnOpenRules').onclick = () => { snd.click(); $('rulesModal').classList.remove('hidden'); if (typeof autoPass === 'function' && autoPass()) autoPass().update(); };
$('btnCloseRules').onclick = () => closeModal($('rulesModal'));
$('btnRulesDone').onclick = () => closeModal($('rulesModal'));
$('btnCloseSettings').onclick = () => { clearTransientSettings(); closeModal($('setModal')); };
$('btnCloseResult').onclick = () => closeModal($('resModal'));
$('btnNew').onclick = () => { snd.click(); if (reset()) closeModal($('setModal')); };

// リプレイUIの強調色。テーマの文字色を基調に、背景との差を確保する。
// hover は文字色を薄く重ねる(黒固定だとダーク系で見えなくなるため)。
function themeAccent(th) {
  return {
    accent: th.id === 'default' ? '#15803d' : th.tx,
    accentTx: th.id === 'default' ? '#ffffff' : th.bg,
    hover: th.tx + '1a',
  };
}
function applyTheme(th) {
  theme = th; const s = document.body.style;
  s.setProperty('--bg', th.bg); s.setProperty('--tx', th.tx); s.setProperty('--card', th.card); s.setProperty('--bd', th.bd);
  const a = themeAccent(th);
  s.setProperty('--accent', a.accent); s.setProperty('--accent-tx', a.accentTx); s.setProperty('--hover', a.hover);
  if (G) { updateUI(); save(); }
}
function buildThemes() {
  Object.values(THEMES).forEach(th => {
    const b = document.createElement('button');
    b.className = 'w-full p-2.5 rounded-lg border flex items-center justify-between text-xs font-bold';
    b.style.cssText = `background:${th.bg};color:${th.tx};border-color:${th.bd}`;
    b.innerHTML = `<span>${th.name}</span><div class="flex gap-1">${[1, 2, 3, 4, 5, 6].map(p => `<div class="w-3 h-3 rounded-full" style="background:${th.fill[p]};border:1px solid ${th.stroke[p]}"></div>`).join('')}</div>`;
    b.onclick = () => { snd.click(); applyTheme(th); };
    $('themeList').appendChild(b);
  });
}
function reset() {
  if (mode === 'online' && !isHost) { $('roomSt').textContent = '新規対局はホストが開始します'; return false; }
  // 対局中に選んだ「その場だけの表示」をここで確定する。
  // 表示だけ変えて新規対局を押した場合は、その選択で始めたいのが自然なため。
  if (transientPc != null) { playerCount = transientPc; for (let p = 1; p <= playerCount; p++) if (!seats[p]) seats[p] = 'human'; }
  if (transientSize != null) pendingSize = transientSize;
  if (transientMode != null) selectedMode = transientMode;
  clearTransientSettings();
  // 選択中のモードをここで確定する(モードを選んだだけでは対局に影響しない)
  if (selectedMode !== mode) {
    if (aiBusy) cancelAI();
    if (mode === 'online') closePeer();
    mode = (isHost || !roomCode) ? selectedMode : mode;
    if (mode === 'local' && roomCode) { roomCode = null; isHost = false; }
  }
  // リプレイ表示中なら先に解除する(盤面がリプレイのまま裏で対局が始まるのを防ぐ)
  if (typeof window.HexagoReplayUI !== 'undefined' && window.HexagoReplayUI.reset) window.HexagoReplayUI.reset();
  if (typeof clearAutoPass === 'function') clearAutoPass();
  build(pendingSize); G = newG(pendingSize);
  // 未着席の人間席は対局中だけAIが代打し、席は後から着席可能なまま維持する。
  if (mode === 'online') {
    G.aiSeats = Array.from({length: playerCount + 1}, (_, p) => p > 0 && (seats[p] === 'ai' || !seatOwners[p]));
    G.aiSeat = G.aiSeats.findIndex((v, p) => p > 0 && v);
  }
  cancelAI(); G.phase = 'playing'; setSeen(); prev = -1; $('aiOv').classList.add('hidden');
  $('resModal').classList.add('hidden'); after(); return true;
}
