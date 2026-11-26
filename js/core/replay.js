// ===== リプレイ & 優勢度グラフ (hexago-replay v1) =====
// 棋譜(hexago-kifu v1)から局面を復元し、「その時点でどのプレイヤーが優勢か」を
// 単純な得点計算ではなく局面的な評価で系列化する。UI (js/ui/replay.js) から利用し、
// Node の自己テスト (dev/replay-selftest.js) からも require できる。
//
// 優勢度の考え方(単純な得点計算との差別化):
//   1. 一色に囲まれた空点は「確定地」として加算
//   2. 複数色に囲まれた「争点」は接する石の数で按分(模様・勢力の取り合いを表現)
//   3. 呼吸点1以下の連(アタリ)は取られる可能性として評価から減ずる
//   4. 終局の score イベントでは確定スコアに接続し、終局時の激変を見える化する
//   5. lead = 評価値 - 出場プレイヤーの平均値(2人戦なら常に +x / -x の対称線)
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HexagoReplay = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DIRS = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]];
  const MOVE_TYPES = ['play', 'pass', 'resign'];

  function buildGeometry(size) {
    const side = (size + 1) / 2, radius = side - 1, points = [], map = Object.create(null);
    for (let r = -radius; r <= radius; r++) for (let q = -radius; q <= radius; q++) {
      if (Math.abs(q + r) <= radius) { map[q + ',' + r] = points.length; points.push([q, r]); }
    }
    const NB = points.map(([q, r]) => DIRS.map(([a, b]) => map[(q + a) + ',' + (r + b)]).filter(v => v !== undefined));
    return { size, points, map, NB, radius };
  }

  function isMoveEvent(event) { return !!event && MOVE_TYPES.includes(event.type); }

  function groupOn(board, geo, i) {
    const color = board[i], seen = new Set([i]), stack = [i], list = [];
    while (stack.length) {
      const x = stack.pop(); list.push(x);
      for (const n of geo.NB[x]) if (board[n] === color && !seen.has(n)) { seen.add(n); stack.push(n); }
    }
    return list;
  }

  function libertiesOfGroup(board, geo, list) {
    const libs = new Set();
    for (const x of list) for (const n of geo.NB[x]) if (!board[n]) libs.add(n);
    return libs;
  }

  // 着手シミュレーション(石を置いてから取られる判定)。コウ参照なし: 記録済み棋譜の再現用。
  function simulateOnBoard(board, geo, i, p) {
    if (!Number.isInteger(i) || i < 0 || i >= board.length || board[i]) return null;
    if (!Number.isInteger(p) || p < 1) return null;
    const a = board.slice(); a[i] = p;
    const cap = [], done = new Set();
    for (const n of geo.NB[i]) if (a[n] && a[n] !== p && !done.has(n)) {
      const g = groupOn(a, geo, n); g.forEach(x => done.add(x));
      if (!libertiesOfGroup(a, geo, g).size) cap.push(...g);
    }
    cap.forEach(x => a[x] = 0);
    if (!libertiesOfGroup(a, geo, groupOn(a, geo, i)).size) return null; // 自殺手
    return { a, cap };
  }

  // 空点領域の分類。cols = 接する石の色、points = 属する空点のインデックス。
  function emptyRegions(board, geo) {
    const regions = [], id = new Array(board.length).fill(-1);
    for (let i = 0; i < board.length; i++) {
      if (board[i] || id[i] >= 0) continue;
      const points = [], cols = new Set(); id[i] = regions.length;
      const stack = [i];
      while (stack.length) {
        const x = stack.pop(); points.push(x);
        for (const n of geo.NB[x]) {
          if (!board[n]) { if (id[n] < 0) { id[n] = regions.length; stack.push(n); } }
          else cols.add(board[n]);
        }
      }
      regions.push({ points, size: points.length, cols: [...cols] });
    }
    return regions;
  }

  // その時点の「地+石」の絶対値。争点は接する石の数で按分して将来の取り込みを見積もる。
  // (グラフの目盛り・ツールチップ用。優劣の判定には下の shareScores を使う)
  function areaScores(board, geo, playerCount) {
    const scores = Array(playerCount + 1).fill(0);
    board.forEach(v => { if (v) scores[v]++; });
    for (const reg of emptyRegions(board, geo)) {
      if (reg.cols.length === 1) {
        // 一色に囲まれた空点はその色の地。ただし序盤の広い空間は
        // まだ「囲まれた」とは言い切れないので、advantageOf と同じ信頼度で按分する
        const c = reg.cols[0];
        const filled = board.reduce((n, v) => n + (v ? 1 : 0), 0) / Math.max(1, board.length);
        const evidence = Math.min(1, reg.points.reduce((n, i) => n + geo.NB[i].filter(x => board[x] === c).length, 0) / 4);
        const trust = Math.min(1, (1 / (1 + Math.max(0, reg.size - 5) / 3)) * evidence * (0.35 + 0.65 * Math.min(1, filled * 3)));
        scores[c] += reg.size * trust;
        const rest = reg.size * (1 - trust) / Math.max(1, playerCount);
        for (let p = 1; p <= playerCount; p++) scores[p] += rest;
      } else if (reg.cols.length > 1) {
        // 争点: 接する石の多い色が将来取り込むとみて按分する(模様・勢力の取り合い)
        const touch = reg.cols.map(() => 0);
        for (const i of reg.points) for (const n of geo.NB[i]) if (board[n]) touch[reg.cols.indexOf(board[n])]++;
        const sum = touch.reduce((a, b) => a + b, 0);
        if (sum > 0) reg.cols.forEach((c, k) => { scores[c] += reg.size * touch[k] / sum; });
      }
    }
    return scores;
  }

  // 安全でない石: 呼吸点1以下の連は取られる可能性として評価から減ずる。
  function weakStoneLoss(board, geo) {
    const loss = new Map(), seen = new Set();
    for (let i = 0; i < board.length; i++) {
      if (!board[i] || seen.has(i)) continue;
      const g = groupOn(board, geo, i); g.forEach(x => seen.add(x));
      if (libertiesOfGroup(board, geo, g).size <= 1) loss.set(board[i], (loss.get(board[i]) || 0) + g.length);
    }
    return loss;
  }

  // 序盤なほど疑わしい「争点」の見積もりを鈍らせる重み。
  //   1手目 ≒ 0.12 … 盤が埋まるほど 1.0 に近づく(終盤はほぼ確定地で見る)。
  function contestedWeight(board, geo) {
    const filled = board.reduce((n, v) => n + (v ? 1 : 0), 0) / Math.max(1, board.length);
    return 0.12 + 0.88 * Math.pow(Math.min(1, Math.max(0, filled)), 0.75);
  }

  const EPS = 1e-9;
  // 局面の「優劣」。0 = 互角、±1 = 完全に支配。
  //
  // 分母は「盤面の総点数」で固定する(試合の総取り=試合の総量は変わらない)。
  //   未確定の空点(序盤の広い空間)は、まだ誰のものでもないので
  //   「出場者の均等な持ち分」として扱う = 序盤は互角付近を淡々と動く。
  //
  //   持ち点(p) = 石 + 確定地(囲いが強く証拠もある領域) - 弱石(アタリ)
  //             + 未確定領域 × (その記録の取り分)
  //
  // これにより、石を1つ置いても「総面積に対する1点」の重みしか動かない。
  // 単純な得点計算との違い:
  //   - 序盤の広い空点を「まだ誰のものでもない」として中立に扱う
  //   - 争点(複数色が接する空間)は接する石の数で按分 = 模様・勢力の取り合い
  //   - アタリの連は取られる可能性として減点
  //   - 盤が埋まるほど、未確定分が減って確定分の差が効いてくる
  function advantageOf(board, geo, playerCount, out) {
    const active = Array.from({ length: playerCount }, (_, i) => i + 1).filter(p => !(out && out[p]));
    const raw = Array(playerCount + 1).fill(0);
    if (active.length <= 1) return { values: active.map(() => 1), raw, active };

    const total = Math.max(1, board.length);
    const w = contestedWeight(board, geo);
    board.forEach(v => { if (v) raw[v]++; });

    // 未確定の空点は出場者で等分した「持ち分」
    const base = 1 / active.length;
    active.forEach(p => { raw[p] += 0; });

    for (const reg of emptyRegions(board, geo)) {
      if (reg.cols.length === 1) {
        const c = reg.cols[0];
        const enclosed = 1 / (1 + Math.max(0, reg.size - 5) / 3);
        // 囲いの証拠: 空点に接するその色の石が多いほど「囲っている」確度が高い
        const borders = new Set();
        for (const i of reg.points) for (const n of geo.NB[i]) if (board[n] === c) borders.add(n);
        const evidence = Math.min(1, borders.size / 4);
        const trust = Math.max(0, Math.min(1, enclosed * evidence * (0.35 + 0.65 * w)));
        raw[c] += reg.size * trust;
        const unclaimed = reg.size * (1 - trust);
        active.forEach(p => { raw[p] += unclaimed * base; });
      } else if (reg.cols.length > 1) {
        const touch = reg.cols.map(() => 0);
        for (const i of reg.points) for (const n of geo.NB[i]) if (board[n]) touch[reg.cols.indexOf(board[n])]++;
        const sum = touch.reduce((a, b) => a + b, 0);
        // 争点のうち「有利な側が将来取る」分だけ実勢力として加点し、
        // 残りはまだ誰のものでもないので等分
        const claimed = Math.min(1, w);
        if (sum > 0) reg.cols.forEach((c, k) => { raw[c] += reg.size * claimed * (touch[k] / sum); });
        active.forEach(p => { raw[p] += reg.size * (1 - claimed) * base; });
      }
    }

    const weak = weakStoneLoss(board, geo);
    const held = active.map(p => Math.max(0, raw[p] - (weak.get(p) || 0)));
    // 総面積で正規化(0..1)。合計はおおよそ 1 になる
    return { values: held.map(v => v / total), raw, active };
  }

  // 優勢度(2人戦は +x / -x の対称線、多人数は平均との差)。
  // シェアの平均との差 = 0 を互角とした対称値。序盤は総面積に比べて小さい。
  function leadValues(adv) {
    const vals = adv.values;
    if (vals.length <= 1) return { lead: vals.map(() => 0), leadPct: vals.map(() => 0) };
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const lead = vals.map(v => v - avg);
    return { lead, leadPct: lead.map(v => v * 100) };
  }

  // 棋譜レコード → 手数ごとの局面リスト(先頭 = 初期局面)。
  // 手数(ply) は play/pass/resign を数える。score イベントは死に石の除去を適用する。
  function replayPositions(record, geo) {
    const initial = record && record.initial && record.initial.board ? record.initial.board : new Array(geo.points.length).fill(0);
    if (initial.length !== geo.points.length) throw new Error('盤面サイズと初期局面の石配列が一致しません');
    const events = (record && Array.isArray(record.events) ? record.events : []).filter(e => e && (isMoveEvent(e) || e.type === 'score'));
    const positions = [{ board: initial.slice(), last: -1, passes: 0, out: (record && record.initial && record.initial.out) ? record.initial.out.slice() : [], note: null, ply: 0 }];
    let ply = 0;
    for (const event of events) {
      const prev = positions[positions.length - 1];
      const board = prev.board.slice(), out = prev.out.slice();
      let next = null;
      if (event.type === 'play') {
        const r = simulateOnBoard(board, geo, event.point, event.player);
        if (!r) continue; // 復元不能なイベント(旧形式)は読み飛ばして継続
        ply++;
        next = { board: r.a, last: event.point, passes: 0, out, note: { kind: 'play', player: event.player, point: event.point, captured: r.cap.length }, ply };
      } else if (event.type === 'pass') {
        ply++;
        next = { board, last: -1, passes: prev.passes + 1, out, note: { kind: 'pass', player: event.player, automatic: !!event.automatic }, ply };
      } else if (event.type === 'resign') {
        ply++;
        if (Number.isInteger(event.player) && event.player >= 1 && event.player < out.length) out[event.player] = true;
        next = { board, last: prev.last, passes: 0, out, note: { kind: 'resign', player: event.player }, ply };
      } else if (event.type === 'score') {
        (event.removed || []).forEach(i => { if (board[i]) board[i] = 0; });
        next = { board, last: prev.last, passes: 0, out, note: { kind: 'score', removed: (event.removed || []).length, scores: event.scores ? event.scores.slice() : null, result: event.result || null }, ply };
      }
      if (next) positions.push(next);
    }
    return positions;
  }

  // 優勢度系列(手ごと)。
  //   lead     = 各プレイヤーの持ち点シェア - 出場者の平均(2人戦は対称、単位は「盤面比」)
  //   leadPct  = 上記を百分率に(グラフの主役。序盤は数%で振り切れない)
  //   evals    = 参考値(地+石の絶対数。終局の score イベントで公式確定スコアに接続)
  function advantageSeries(positions, geo, playerCount, names) {
    const rows = [];
    for (const pos of positions) {
      const finalScores = pos.note && pos.note.kind === 'score' && pos.note.scores ? pos.note.scores : null;
      const active = Array.from({ length: playerCount }, (_, i) => i + 1).filter(p => !pos.out[p]);
      const adv = advantageOf(pos.board, geo, playerCount, pos.out);
      const evals = Array(playerCount + 1).fill(0);
      let lead = {}, leadPct = {};
      if (finalScores) {
        // 終局は公式確定スコアのシェアで引き直す(死に石による入れ替わりを反映)
        let total = 0;
        for (let p = 1; p <= playerCount; p++) { evals[p] = Math.max(0, Number(finalScores[p]) || 0); if (!pos.out[p]) total += evals[p]; }
        const shares = active.map(p => total > 0 ? evals[p] / total : 1 / active.length);
        const avg = shares.reduce((a, b) => a + b, 0) / Math.max(1, shares.length);
        active.forEach((p, k) => { lead[p] = shares[k] - avg; leadPct[p] = (shares[k] - avg) * 100; });
      } else {
        const area = areaScores(pos.board, geo, playerCount);
        for (let p = 1; p <= playerCount; p++) if (!pos.out[p]) evals[p] = Math.round(area[p] * 10) / 10;
        const lv = leadValues(adv);
        active.forEach((p, k) => { lead[p] = lv.lead[k]; leadPct[p] = lv.leadPct[k]; });
      }
      rows.push({ ply: pos.ply, kind: pos.note ? pos.note.kind : 'start', event: pos.note, evals, lead, leadPct, out: pos.out.slice() });
    }
    let swing = null;
    for (let k = 1; k < rows.length; k++) {
      for (const key of Object.keys(rows[k].leadPct)) {
        const p = +key;
        const delta = (rows[k].leadPct[p] ?? 0) - (rows[k - 1].leadPct[p] ?? 0);
        if (!swing || Math.abs(delta) > Math.abs(swing.delta)) swing = { ply: rows[k].ply, player: p, delta };
      }
    }
    return { rows, swing, names: names || null };
  }

  // 盤面の描画(リプレイ画面用)。devicePixelRatio を考慮する。
  function drawBoard(canvas, geo, pos, options) {
    const g = canvas.getContext && canvas.getContext('2d');
    if (!g) return;
    const cssW = Math.max(200, (options && options.cssSize) || Math.min(480, canvas.clientWidth || 480));
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssW * dpr);
    canvas.style.width = cssW + 'px'; canvas.style.height = cssW + 'px';
    const size = geo.size, side = (size + 1) / 2, s = side - 1;
    const w = cssW, pad = w * 0.08, cell = (w - pad * 2) / (2 * s);
    const px = (q, r) => [w / 2 + cell * (q + r / 2), w / 2 + cell * r * 0.866];
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = (options && options.themeBoard) || '#d9b382';
    g.fillRect(0, 0, w, w);
    g.strokeStyle = (options && options.themeLine) || 'rgba(90,70,50,0.45)';
    g.lineWidth = size >= 19 ? 0.5 : 0.8;
    g.beginPath();
    for (let i = 0; i < geo.points.length; i++) {
      const [q, r] = geo.points[i], [x, y] = px(q, r);
      for (let d = 0; d < 3; d++) {
        const k = geo.map[(q + DIRS[d][0]) + ',' + (r + DIRS[d][1])];
        if (k !== undefined) { const [x2, y2] = px(geo.points[k][0], geo.points[k][1]); g.moveTo(x, y); g.lineTo(x2, y2); }
      }
    }
    g.stroke();
    g.lineWidth = size >= 19 ? 1 : 1.4;
    g.beginPath();
    [[s, 0], [0, s], [-s, s], [-s, 0], [0, -s], [s, -s]].forEach(([q, r], k) => {
      const i = geo.map[q + ',' + r]; if (i === undefined) return;
      const [x, y] = px(geo.points[i][0], geo.points[i][1]);
      if (k) g.lineTo(x, y); else g.moveTo(x, y);
    });
    g.closePath();
    g.stroke();
    // 星
    g.fillStyle = (options && options.themeLine) || 'rgba(90,70,50,0.45)';
    const star = Math.round(s * 2 / 3);
    [[0, 0], [1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]].forEach(([q, r]) => {
      const i = geo.map[q * star + ',' + r * star]; if (i === undefined) return;
      const [x, y] = px(geo.points[i][0], geo.points[i][1]);
      g.beginPath(); g.arc(x, y, Math.max(2, cell * 0.14), 0, 7); g.fill();
    });
    const rad = Math.max(2.4, cell * 0.44);
    const fills = (options && options.fills) || {}, strokes = (options && options.strokes) || {};
    pos.board.forEach((v, i) => {
      if (!v) return;
      const [q, r] = geo.points[i], [x, y] = px(q, r);
      g.beginPath(); g.arc(x, y, rad, 0, 7);
      g.fillStyle = fills[v] || '#111'; g.fill();
      g.strokeStyle = strokes[v] || '#000'; g.lineWidth = 1.6; g.stroke();
    });
    if (Number.isInteger(pos.last) && pos.last >= 0 && pos.board[pos.last]) {
      const [q, r] = geo.points[pos.last], [x, y] = px(q, r);
      g.beginPath(); g.arc(x, y, rad, 0, 7);
      g.fillStyle = 'rgba(34,197,94,.38)'; g.fill();
      g.strokeStyle = '#16a34a'; g.lineWidth = 2.4; g.stroke();
    }
  }

  return { version: 1, buildGeometry, isMoveEvent, replayPositions, simulateOnBoard, emptyRegions, areaScores, contestedWeight, advantageOf, leadValues, weakStoneLoss, advantageSeries, drawBoard };
});
