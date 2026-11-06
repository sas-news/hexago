// ===== 描画 =====
function resizeCanvas() {
  const rc = cv.getBoundingClientRect(), d = window.devicePixelRatio || 1;
  cv.width = rc.width * d; cv.height = rc.height * d; ctx.setTransform(d, 0, 0, d, 0, 0); render();
}
window.addEventListener('resize', resizeCanvas);
function stone(x, y, r, p, alpha) {
  ctx.save(); ctx.globalAlpha = alpha; ctx.beginPath(); ctx.arc(x, y, r, 0, 7);
  ctx.fillStyle = playerFill(p); ctx.fill(); ctx.strokeStyle = playerStroke(p); ctx.lineWidth = 2; ctx.stroke(); ctx.restore();
}
function render() {
  const { w, cell, pos } = metrics(), s = SIDE - 1, r0 = cell * 0.44;
  ctx.fillStyle = theme.board; ctx.fillRect(0, 0, w, w);
  ctx.strokeStyle = theme.line; ctx.lineWidth = 1; ctx.beginPath();
  for (let i = 0; i < P.length; i++) { const [x, y] = pos(i); for (const d of [0, 1, 2]) { const n = NB[i].find(k => P[k][0] === P[i][0] + DIRS[d][0] && P[k][1] === P[i][1] + DIRS[d][1]); if (n !== undefined) { const [x2, y2] = pos(n); ctx.moveTo(x, y); ctx.lineTo(x2, y2); } } }
  ctx.stroke();
  ctx.lineWidth = 2; ctx.beginPath();
  [[s, 0], [0, s], [-s, s], [-s, 0], [0, -s], [s, -s]].forEach(([q, r], k) => { const i = M[q + ',' + r], [x, y] = pos(i); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.closePath(); ctx.stroke();
  // 星
  ctx.fillStyle = theme.line; const d = Math.round(s * 2 / 3);
  [[0, 0], ...DIRS.map(([a, b]) => [a * d, b * d])].forEach(k => { const i = M[k[0] + ',' + k[1]]; if (i === undefined) return; const [x, y] = pos(i); ctx.beginPath(); ctx.arc(x, y, 3.2, 0, 7); ctx.fill(); });
  // 石
  G.board.forEach((p, i) => {
    if (!p) return; const [x, y] = pos(i), dead = G.dead.includes(i);
    stone(x, y, r0, p, dead ? 0.35 : 1);
    if (dead) { ctx.save(); ctx.beginPath(); const o = r0 * .5; ctx.moveTo(x - o, y - o); ctx.lineTo(x + o, y + o); ctx.moveTo(x + o, y - o); ctx.lineTo(x - o, y + o); ctx.lineCap = 'round'; ctx.strokeStyle = '#000'; ctx.lineWidth = 6; ctx.stroke(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.stroke(); ctx.restore(); }
  });
  if (G.last >= 0 && G.board[G.last]) { const [x, y] = pos(G.last); ctx.beginPath(); ctx.arc(x, y, r0, 0, 7); ctx.fillStyle = 'rgba(34,197,94,.38)'; ctx.fill(); ctx.strokeStyle = '#16a34a'; ctx.lineWidth = 3; ctx.stroke(); }
  if (!G.over && G.phase === 'playing' && prev >= 0 && mine()) {
    const [x, y] = pos(prev), ok = sim(G.board, prev, G.turn);
    if (ok) stone(x, y, r0, G.turn, 0.5); else { ctx.save(); const o = r0 * .5; ctx.lineCap = 'round'; ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.arc(x, y, r0, 0, 7); ctx.strokeStyle = theme.tx; ctx.globalAlpha = .75; ctx.lineWidth = 2; ctx.stroke(); ctx.setLineDash([]); ctx.beginPath(); ctx.moveTo(x - o, y - o); ctx.lineTo(x + o, y + o); ctx.moveTo(x + o, y - o); ctx.lineTo(x - o, y + o); ctx.lineWidth = 2.5; ctx.stroke(); ctx.restore(); }
  }
}
