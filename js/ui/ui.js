// ===== UI =====
function canUndo() {
  if (G.over || G.phase !== 'playing' || !G.hist.length || aiBusy) return false;
  const top = G.hist[G.hist.length - 1];
  if (mode === 'online') { let k = G.hist.length - 1; while (k >= 0 && aiSeatOf(G.hist[k].by)) k--; return k >= 0 && G.hist[k].by === myRole; }
  return seats[G.turn] === 'human' || seats.slice(1).includes('human');
}
function undo() {
  if (!canUndo()) return;
  let s = G.hist.pop();
  while (aiSeatOf(s.by) && G.hist.length) s = G.hist.pop();
  G.board = s.board; G.damage = s.damage; G.turn = s.turn; G.passes = s.passes; G.last = s.last; G.out = s.out; G.seen.length = s.seen; setSeen(); prev = -1;
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
  $('modeBadge').textContent = mode === 'online' ? `オンライン ${myRole ? playerDisplayName(myRole) : 'プール / 観戦'}` : 'ローカル ' + seats.slice(1,playerCount+1).map(s => s === 'ai' ? 'AI' : '人間').join('・');
  if (mode === 'online' && !isHost) $('aiOv').classList.toggle('hidden', !(aiSeatOf(G.turn) && !G.over && G.phase === 'playing'));
  $('btnUndo').disabled = !canUndo();
  resetResignButton();
  renderQuickSeats();
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
// 盤面下のワンタップ席切替（対局中に人間 <-> AI を相互に切替）
function renderQuickSeats() {
  const el = document.getElementById('quickSeats');
  if (!el) return;
  const show = !!G && !G.over && G.phase === 'playing' && canManageRoom();
  el.classList.toggle('hidden', !show);
  el.classList.toggle('flex', show);
  if (!show) { el.innerHTML = ''; return; }
  const count = G.playerCount || playerCount;
  let html = '<span class="opacity-60">席:</span>';
  for (let p = 1; p <= count; p++) {
    const isAI = seats[p] === 'ai';
    const out = !!(G.out && G.out[p]);
    html += '<button type="button" data-seat-toggle="' + p + '"' + (out ? ' disabled' : '') +
      ' aria-pressed="' + (isAI ? 'true' : 'false') + '" aria-label="' + p + 'P を' + (isAI ? '人間' : 'AI') + 'に切替"' +
      ' class="px-2.5 py-1 rounded-full border font-bold transition-all active:scale-95 ' +
      (isAI ? 'bg-neutral-900 text-white border-neutral-900' : 'bg-white text-neutral-700 border-neutral-300 hover:bg-neutral-100') +
      (out ? ' opacity-40' : '') + '">' + p + 'P ' + (isAI ? 'AI' : '人間') + '</button>';
  }
  el.innerHTML = html;
}
document.getElementById('quickSeats').addEventListener('click', e => {
  const btn = e.target.closest('[data-seat-toggle]');
  if (!btn || btn.disabled) return;
  const p = +btn.dataset.seatToggle;
  if (!Number.isInteger(p) || p < 1) return;
  setSeatMode(p, seats[p] === 'ai' ? 'human' : 'ai');
});
