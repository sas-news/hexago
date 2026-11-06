// ===== ルール =====
function group(b, i) {
  const c = b[i], seen = new Set([i]), q = [i];
  while (q.length) { const x = q.pop(); for (const n of NB[x]) if (b[n] === c && !seen.has(n)) { seen.add(n); q.push(n); } }
  return [...seen];
}
const libCount = (b, g) => { const s = new Set(); g.forEach(x => NB[x].forEach(n => { if (!b[n]) s.add(n); })); return s.size; };
// 着手シミュレーション: 違法なら null
function sim(b, i, p) {
  if (b[i]) return null;
  const a = b.slice(); a[i] = p; const cap = [], done = new Set();
  for (const n of NB[i]) if (a[n] && a[n] !== p && !done.has(n)) {
    const g = group(a, n); g.forEach(x => done.add(x));
    if (!libCount(a, g)) cap.push(...g);
  }
  cap.forEach(x => a[x] = 0);
  if (!libCount(a, group(a, i))) return null; // 自殺手
  if (cap.length && seenSet.has(hash(a))) return null; // コウ(同一局面の再現)
  return { a, cap };
}
function activeCount() { return Array.from({length:G.playerCount||3},(_,i)=>i+1).filter(p => !G.out[p]).length; }
function nextTurn() { let t = G.turn, count=G.playerCount||3, guard=0; do { t = t % count + 1; guard++; } while (G.out[t] && guard<=count); G.turn = t; }
function snap(by) {
  G.hist.push({ by, board: G.board.slice(), damage: G.damage.slice(), turn: G.turn, passes: G.passes, last: G.last, out: G.out.slice(), seen: G.seen.length });
  if (G.hist.length > 40) G.hist.shift();
}
function play(i) {
  const p = G.turn, r = sim(G.board, i, p); if (!r) return false;
  snap(p); r.cap.forEach(x => G.damage[G.board[x]]++);
  G.board = r.a; G.last = i; G.passes = 0;
  const h = hash(G.board); G.seen.push(h); seenSet.add(h);
  r.cap.length ? snd.cap() : snd.place(); nextTurn(); return true;
}
function doPass() {
  snd.click(); snap(G.turn); G.passes++; G.last = -1;
  if (G.passes >= activeCount()) { G.phase = 'dead'; G.dead = detectDeadStonesSmart(); prev = -1; } else nextTurn();
}
function territory() {
  const t = Array((G?.playerCount || playerCount || 3) + 1).fill(0), vis = new Set();
  for (let i = 0; i < P.length; i++) if (!G.board[i] && !vis.has(i)) {
    const reg = [i], cols = new Set(); vis.add(i);
    for (let k = 0; k < reg.length; k++) for (const n of NB[reg[k]]) { if (!G.board[n]) { if (!vis.has(n)) { vis.add(n); reg.push(n); } } else cols.add(G.board[n]); }
    if (cols.size === 1) t[[...cols][0]] += reg.length;
  }
  return t;
}
// 任意の盤面の地を計算。AIの仮想着手評価にも使う。
function territoryForBoard(board) {
  const t = Array((G?.playerCount || playerCount || 3) + 1).fill(0), vis = new Set();
  for (let i = 0; i < P.length; i++) if (!board[i] && !vis.has(i)) {
    const reg = [i], cols = new Set(); vis.add(i);
    for (let k = 0; k < reg.length; k++) for (const n of NB[reg[k]]) {
      if (!board[n]) { if (!vis.has(n)) { vis.add(n); reg.push(n); } }
      else cols.add(board[n]);
    }
    if (cols.size === 1) t[[...cols][0]] += reg.length;
  }
  return t;
}
// 終局時の死に石を保守的に自動推定。明らかな弱い包囲連のみ初期選択し、確認画面で修正可能。
function detectDeadStones() {
  const b = G.board, seen = new Set(), dead = [];
  for (let i = 0; i < b.length; i++) {
    if (!b[i] || seen.has(i)) continue;
    const color = b[i], g = group(b, i); g.forEach(x => seen.add(x));
    const libs = new Set();
    for (const x of g) for (const n of NB[x]) if (!b[n]) libs.add(n);
    const eyes = countEyes(b, g, color);
    if (eyes > 0 || libs.size > 2 || libs.size === 0) continue;
    const surrounded = [...libs].every(lib => {
      const around = NB[lib].filter(n => b[n] && b[n] !== color);
      const friendly = NB[lib].filter(n => b[n] === color);
      return around.length >= Math.max(2, NB[lib].length - 2) && friendly.length <= 1;
    });
    const enemyColors = new Set();
    for (const x of g) for (const n of NB[x]) if (b[n] && b[n] !== color) enemyColors.add(b[n]);
    if (surrounded && enemyColors.size === 1) dead.push(...g);
  }
  return [...new Set(dead)];
}
// 終局時の死に石を自動推定する（強化版・画面用）。
// 盤面の各連について、相手がその呼吸点を順に埋めて実際に取れるか（ローカル捕獲探索）を調べる。
// 2眼がある連は埋められないので生き、セキのように埋めると自滅する連も生きとして残る。
// 自動判定はあくまで候補。終局確認画面で人間がタップして修正できる。
function playStoneOnBoard(board, i, p) {
  if (board[i]) return null;
  const a = board.slice();
  a[i] = p;
  const cap = [], done = new Set();
  for (const n of NB[i]) if (a[n] && a[n] !== p && !done.has(n)) {
    const g = group(a, n);
    g.forEach(x => done.add(x));
    if (!libCount(a, g)) cap.push(...g);
  }
  cap.forEach(x => a[x] = 0);
  if (!libCount(a, group(a, i))) return null; // 自殺手
  return { a, cap };
}
function canEnemyCaptureGroup(board, group0, color, pc) {
  let b = board.slice();
  let grp = group0.slice();
  if (!grp.length || !b[grp[0]]) return false;
  for (let step = 0; step < 64; step++) {
    const libs = new Set();
    for (const s of grp) for (const n of NB[s]) if (!b[n]) libs.add(n);
    if (libs.size === 0) return true; // 取れた
    let moved = false;
    const enemyColors = new Set();
    for (let c = 1; c <= pc; c++) if (c !== color) enemyColors.add(c);
    for (const l of [...libs]) {
      // その点の周囲にいる敵色を優先し、いなければ他の敵色も試す
      const colors = [];
      for (const n of NB[l]) if (b[n] && b[n] !== color) colors.push(b[n]);
      for (const c of enemyColors) if (!colors.includes(c)) colors.push(c);
      for (const enemy of colors) {
        const res = playStoneOnBoard(b, l, enemy);
        if (!res) continue;
        b = res.a;
        if (!b[grp[0]]) return true;
        grp = group(b, grp[0]);
        moved = true;
        break;
      }
      if (moved) break;
    }
    if (!moved) return false; // どの敵も埋められない = 生き（セキ含む）
  }
  return false;
}
function detectDeadStonesSmart() {
  const b = G.board;
  const pc = G.playerCount || playerCount || 2;
  const seen = new Set(), dead = [];
  // 空点の連結領域。敵に囲まれた小さな領域の中の連だけを死の候補にする
  // （開けた中央の石や、自分の地に囲まれた石を誤って死にしないため）。
  const { id, regs } = regionInfo(b);
  for (let i = 0; i < b.length; i++) {
    if (!b[i] || seen.has(i)) continue;
    const color = b[i];
    const g = group(b, i);
    g.forEach(x => seen.add(x));
    if (!libCount(b, g)) continue;
    if (countEyes(b, g, color) >= 2) continue;      // 二眼は無条件で生き
    const libs = new Set();
    for (const x of g) for (const n of NB[x]) if (!b[n]) libs.add(n);
    let enclosed = libs.size > 0;
    const regionIds = new Set();
    for (const l of libs) regionIds.add(id[l]);
    for (const rid of regionIds) {
      const reg = regs[rid];
      if (!reg) { enclosed = false; break; }
      const hasEnemy = [...reg.cols].some(c => c !== color);
      if (!hasEnemy) { enclosed = false; break; }                    // 自分の色だけに囲まれた空間は生き
      if (reg.size > Math.max(6, g.length * 2 + 2)) { enclosed = false; break; } // 広すぎる所は判定しない
    }
    if (!enclosed) continue;
    if (canEnemyCaptureGroup(b, g, color, pc)) dead.push(...g);
  }
  return [...new Set(dead)];
}
function finishScore() {
  // 選択された死に石を盤上から除去する（捕獲数による減点はしない）。
  G.dead.forEach(i => { if (G.board[i]) G.board[i] = 0; });
  G.dead = []; G.phase = 'ended'; G.over = true;
  const t = territory();
  const stones = Array.from({length:(G.playerCount||3)+1},(_,p)=>p===0?0:G.board.filter(v=>v===p).length);
  const sc = Array.from({length:(G.playerCount||3)+1},(_,p)=>p===0?0:t[p] + stones[p]);
  const rank = Array.from({length:G.playerCount||3},(_,i)=>i+1).filter(p => !G.out[p]).sort((a, b) => sc[b] - sc[a]);
  const top = rank.filter(p => sc[p] === sc[rank[0]]);
  const title = top.length > 1 ? `引き分け (${top.map(p => playerName(p)).join('・')} ${sc[rank[0]]}点)` : `${playerName(rank[0])}の勝ち (${sc[rank[0]]}点)`;
  const row = p => `<div class="flex justify-between items-center gap-3"><span class="whitespace-nowrap"><span class="dot" style="background:${playerFill(p)};border-color:${playerStroke(p)}"></span>${playerName(p)}${G.out[p] ? ' (投了)' : ''}</span><span class="text-right">地 ${t[p]} ＋ 石 ${stones[p]} ＝ <strong>${sc[p]}点</strong></span></div>`;
  G.result = { title, details: Array.from({length:G.playerCount||3},(_,i)=>i+1).map(row).join('') };
  snd.win(); showResult();
}
function resign() {
  const p = G.turn; G.out[p] = true; snd.click();
  if (activeCount() <= 1) {
    const w = Array.from({length:G.playerCount||3},(_,i)=>i+1).find(x => !G.out[x]); G.over = true;
    G.result = { title: `${playerName(w)}の勝ち`, details: `${playerName(p)} が投了し、残りは ${playerName(w)} のみとなりました。` };
    snd.win(); showResult();
  } else { G.passes = 0; nextTurn(); }
}
