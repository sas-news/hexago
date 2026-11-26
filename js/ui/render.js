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
  // リプレイ中はメイン盤面に「その手の局面」を描く(ポップアップしない)
  const rp = (typeof HexagoReplayView !== 'undefined' && HexagoReplayView.active()) ? HexagoReplayView.position() : null;
  if (rp) return renderReplay(rp);
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
function makeBoardThumb(entry) {
  if (!entry || !Array.isArray(entry.board)) return '';
  const size = Number(entry.size) || 9;
  const side = (size + 1) / 2, s = side - 1;
  if (!Number.isInteger(side) || s < 1) return '';
  const pts = [], map = Object.create(null);
  for (let r = -s; r < side; r++) {
    for (let q = -s; q < side; q++) {
      if (Math.abs(q + r) <= s) { map[q + ',' + r] = pts.length; pts.push([q, r]); }
    }
  }
  const w = 160, pad = w * 0.08, cell = (w - pad * 2) / (2 * s);
  const pos = (q, r) => [w / 2 + cell * (q + r / 2), w / 2 + cell * r * 0.866];
  const c = document.createElement('canvas');
  c.width = w; c.height = w;
  const g = c.getContext('2d');
  if (!g) return '';
  g.fillStyle = (typeof theme !== 'undefined' && theme && theme.board) ? theme.board : '#d9b382';
  g.fillRect(0, 0, w, w);
  g.strokeStyle = (typeof theme !== 'undefined' && theme && theme.line) ? theme.line : 'rgba(90,70,50,0.45)';
  g.lineWidth = size >= 19 ? 0.5 : 0.8;
  g.beginPath();
  for (let i = 0; i < pts.length; i++) {
    const [q, r] = pts[i], [x, y] = pos(q, r);
    for (let d = 0; d < 3; d++) {
      const k = map[(q + DIRS[d][0]) + ',' + (r + DIRS[d][1])];
      if (k !== undefined) {
        const [x2, y2] = pos(pts[k][0], pts[k][1]);
        g.moveTo(x, y); g.lineTo(x2, y2);
      }
    }
  }
  g.stroke();
  g.lineWidth = 1.4;
  g.beginPath();
  [[s, 0], [0, s], [-s, s], [-s, 0], [0, -s], [s, -s]].forEach(([q, r], idx) => {
    const [x, y] = pos(q, r);
    if (idx) g.lineTo(x, y); else g.moveTo(x, y);
  });
  g.closePath();
  g.stroke();
  const r0 = Math.max(1.8, cell * 0.44);
  const colors = entry.colors || {};
  for (let i = 0; i < pts.length && i < entry.board.length; i++) {
    const p = entry.board[i];
    if (!p) continue;
    const [x, y] = pos(pts[i][0], pts[i][1]);
    const col = colors[p] || colors[String(p)];
    const fill = (col && col.fill) || (typeof playerFill === 'function' ? playerFill(p) : '#111');
    const stroke = (col && col.stroke) || (typeof playerStroke === 'function' ? playerStroke(p) : '#000');
    g.beginPath();
    g.arc(x, y, r0, 0, 7);
    g.fillStyle = fill;
    g.fill();
    g.strokeStyle = stroke;
    g.lineWidth = size >= 19 ? 0.7 : 1.1;
    g.stroke();
  }
  try { return c.toDataURL('image/png'); } catch (e) { return ''; }
}

// リプレイ局面のメイン盤面描画。render() と同じ座標系で盤線はそのまま、
// 石と最終手マーカーだけを再生中の局面で置き換える。
function renderReplay(pos) {
  const { w, cell, pos: point } = metrics(), s = SIDE - 1, r0 = cell * 0.44;
  ctx.fillStyle = theme.board; ctx.fillRect(0, 0, w, w);
  ctx.strokeStyle = theme.line; ctx.lineWidth = 1; ctx.beginPath();
  for (let i = 0; i < P.length; i++) { const [x, y] = point(i); for (const d of [0, 1, 2]) { const n = NB[i].find(k => P[k][0] === P[i][0] + DIRS[d][0] && P[k][1] === P[i][1] + DIRS[d][1]); if (n !== undefined) { const [x2, y2] = point(n); ctx.moveTo(x, y); ctx.lineTo(x2, y2); } } }
  ctx.stroke();
  ctx.lineWidth = 2; ctx.beginPath();
  [[s, 0], [0, s], [-s, s], [-s, 0], [0, -s], [s, -s]].forEach(([q, r], k) => { const i = M[q + ',' + r], [x, y] = point(i); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.closePath(); ctx.stroke();
  ctx.fillStyle = theme.line; const d = Math.round(s * 2 / 3);
  [[0, 0], ...DIRS.map(([a, b]) => [a * d, b * d])].forEach(k => { const i = M[k[0] + ',' + k[1]]; if (i === undefined) return; const [x, y] = point(i); ctx.beginPath(); ctx.arc(x, y, 3.2, 0, 7); ctx.fill(); });
  for (let i = 0; i < P.length; i++) {
    const p = pos.board[i];
    if (!p) continue;
    const [x, y] = point(i);
    stone(x, y, r0, p, 1);
  }
  if (Number.isInteger(pos.last) && pos.last >= 0 && pos.board[pos.last]) {
    const [x, y] = point(pos.last);
    ctx.beginPath(); ctx.arc(x, y, r0, 0, 7);
    ctx.fillStyle = 'rgba(34,197,94,.38)'; ctx.fill();
    ctx.strokeStyle = '#16a34a'; ctx.lineWidth = 3; ctx.stroke();
  }
}
