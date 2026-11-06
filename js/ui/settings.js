// ===== プレイヤー設定 =====
const SEAT_MODES = ['human', 'ai'];
const SEAT_LABELS = { human: '人間', ai: 'AI' };
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
  seats[p] = nextMode;
  setSeatAIFlag(p);
  if (!quiet) {
    snd.click(); syncSettings();
    if (mode === 'online' && isHost) sync();
    after();
  }
}
function setAllSeatModes(value) {
  if (!canManageRoom()) return;
  for (let p = 1; p <= playerCount; p++) setSeatMode(p, value, true);
  snd.click(); syncSettings();
  if (mode === 'online' && isHost) sync();
  after();
}
function syncSettings() {
  document.querySelectorAll('#playerCountBtns .opt').forEach(b => {
    b.classList.toggle('on', +b.dataset.count === playerCount);
    b.disabled = mode === 'online' && !!roomCode && !isHost;
  });
  document.querySelectorAll('#sizeBtns .opt').forEach(b => {
    b.classList.toggle('on', +b.dataset.v === pendingSize);
    b.disabled = mode === 'online' && !!roomCode && !isHost;
  });
  document.querySelectorAll('#modeBtns .opt').forEach(b => b.classList.toggle('on', b.dataset.v === mode));
  $('onlineBox').classList.toggle('hidden', mode !== 'online');
  const participantView = mode === 'online' && boardView === 'participant';
  $('onlineRoleConfig').classList.toggle('hidden', mode !== 'online');
  $('seatBox').classList.toggle('hidden', participantView);
  ['boardSizeConfig', 'playerCountConfig', 'soundConfig'].forEach(id => $(id).classList.toggle('hidden', participantView));
  $('btnNew').classList.toggle('hidden', participantView);
  $('hostRoomSection').classList.toggle('hidden', participantView);
  $('joinRoomSection').classList.toggle('hidden', !participantView);
  $('btnHostBoard').classList.toggle('on', !participantView);
  $('btnParticipantBoard').classList.toggle('on', participantView);
  $('seatBtns').innerHTML = '';
  for (let p = 1; p <= playerCount; p++) {
    const row = document.createElement('div'); row.className = 'flex items-center gap-1.5';
    const label = document.createElement('span'); label.className = 'w-16 shrink-0 text-xs font-bold text-neutral-700';
    label.textContent = `${p}P ${playerName(p)}`; row.appendChild(label);
    for (const value of SEAT_MODES) {
      const b = document.createElement('button'); b.type = 'button';
      b.className = 'opt flex-1' + (seats[p] === value ? ' on' : '');
      b.textContent = SEAT_LABELS[value];
      b.disabled = !canManageRoom();
      if (seats[p] === value) b.setAttribute('aria-pressed', 'true');
      b.onclick = () => setSeatMode(p, value);
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
  snd.click(); const old = playerCount; playerCount = +b.dataset.count;
  for (let p = old + 1; p <= playerCount; p++) if (!seats[p]) seats[p] = 'human';
  for (let p = playerCount + 1; p <= 6; p++) if (seatOwners[p]) releaseSeat(p);
  syncSettings(); save(); if (mode === 'online' && isHost) sync();
});
document.querySelectorAll('#sizeBtns .opt').forEach(b => b.onclick = () => {
  if (mode === 'online' && roomCode && !isHost) return;
  snd.click(); pendingSize = +b.dataset.v; syncSettings(); save(); if (mode === 'online' && isHost) sync();
});
document.querySelectorAll('#modeBtns .opt').forEach(b => b.onclick = () => {
  snd.click();
  if (mode === b.dataset.v) return;
  if (aiBusy) cancelAI();
  if (mode === 'online') closePeer();
  mode = b.dataset.v; syncSettings(); updateUI();
});
document.querySelectorAll('[data-bulk]').forEach(b => b.onclick = () => setAllSeatModes(b.dataset.bulk));
$('btnHostBoard').onclick = () => { boardView = 'host'; syncSettings(); };
$('btnParticipantBoard').onclick = () => { boardView = 'participant'; syncSettings(); };
$('btnSound').onclick = () => { snd.on = !snd.on; syncSettings(); snd.click(); save(); };
$('btnOpenSettings').onclick = () => { snd.click(); syncSettings(); $('setModal').classList.remove('hidden'); };
$('btnOpenRules').onclick = () => { snd.click(); $('rulesModal').classList.remove('hidden'); };
$('btnCloseRules').onclick = () => closeModal($('rulesModal'));
$('btnRulesDone').onclick = () => closeModal($('rulesModal'));
$('btnCloseSettings').onclick = () => closeModal($('setModal'));
$('btnCloseResult').onclick = () => closeModal($('resModal'));
$('btnNew').onclick = () => { snd.click(); if (reset()) $('setModal').classList.add('hidden'); };

function applyTheme(th) {
  theme = th; const s = document.body.style;
  s.setProperty('--bg', th.bg); s.setProperty('--tx', th.tx); s.setProperty('--card', th.card); s.setProperty('--bd', th.bd);
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
  build(pendingSize); G = newG(pendingSize);
  // 未着席の人間席は対局中だけAIが代打し、席は後から着席可能なまま維持する。
  if (mode === 'online') {
    G.aiSeats = Array.from({length: playerCount + 1}, (_, p) => p > 0 && (seats[p] === 'ai' || !seatOwners[p]));
    G.aiSeat = G.aiSeats.findIndex((v, p) => p > 0 && v);
  }
  cancelAI(); G.phase = 'playing'; setSeen(); prev = -1; $('aiOv').classList.add('hidden');
  $('resModal').classList.add('hidden'); after(); return true;
}
