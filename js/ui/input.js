// ===== 入力 =====
const $ = id => document.getElementById(id);
const cv = $('cv'), ctx = cv.getContext('2d');
function mine() { return mode === 'online' ? Number.isInteger(myRole) && G.turn === myRole && !aiSeatOf(myRole) : seats[G.turn] === 'human'; }
function metrics() {
  const w = cv.getBoundingClientRect().width, pad = w * 0.07, cell = (w - pad * 2) / (2 * (SIDE - 1));
  return { w, cell, pos: i => [w / 2 + cell * (P[i][0] + P[i][1] / 2), w / 2 + cell * P[i][1] * 0.866] };
}
function hit(e) {
  const { w, cell, pos } = metrics(), rc = cv.getBoundingClientRect();
  const x = e.clientX - rc.left, y = e.clientY - rc.top; let bi = -1, bd = cell * 0.65;
  for (let i = 0; i < P.length; i++) { const [px, py] = pos(i), d = Math.hypot(px - x, py - y); if (d < bd) { bd = d; bi = i; } }
  return bi;
}
cv.addEventListener('pointerdown', e => ptype = e.pointerType || 'mouse');
cv.addEventListener('pointermove', e => ptype = e.pointerType || 'mouse');
cv.addEventListener('mousemove', e => {
  if (ptype === 'touch' || G.over || G.phase !== 'playing' || !mine()) return;
  const i = hit(e); if (i !== prev) { prev = i; render(); }
});
cv.addEventListener('mouseleave', () => { if (ptype === 'touch') return; prev = -1; render(); });
cv.addEventListener('click', e => {
  snd.init(); if (G.over) return;
  const i = hit(e); if (i < 0) return;
  if (G.phase === 'dead') {
    if (G.board[i]) { const g = group(G.board, i), isD = G.dead.includes(i); G.dead = isD ? G.dead.filter(x => !g.includes(x)) : [...new Set([...G.dead, ...g])]; snd.click(); updateUI(); save(); sync(); }
    return;
  }
  if (!mine() || G.phase !== 'playing') return;
  if (ptype !== 'touch' || prev === i) { if (play(i)) { prev = -1; after(); } else if (ptype === 'touch') render(); }
  else { prev = i; render(); }
});
