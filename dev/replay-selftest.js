#!/usr/bin/env node
'use strict';
// リプレイ & 優勢度モジュールの自己テスト: node dev/replay-selftest.js
const path = require('path');
const Features = require(path.join(__dirname, '..', 'js', 'core', 'features.js'));
const R = require(path.join(__dirname, '..', 'js', 'core', 'replay.js'));

let failed = 0;
const ok = (cond, label) => { if (cond) console.log('  ok -', label); else { console.error('  NG -', label); failed++; } };
const round = v => Math.round(v * 10) / 10;

// --- 9路盤・2人戦: 序盤互角 → 1Pが2Pの中央石を取る → 逆転 → 終局確定 ---
function buildScenario(record) {
  const geo = R.buildGeometry(9);
  const st = {
    playerCount: 2, size: 9, board: new Array(geo.points.length).fill(0),
    turn: 1, passes: 0, over: false, phase: 'playing',
    dead: [], seen: [], out: [false, false, false], damage: [0, 0, 0]
  };
  st.record = Features.createRecord(st);
  const play = (i, p) => {
    const r = R.simulateOnBoard(st.board, geo, i, p);
    if (!r) throw new Error('illegal ' + i + ' by ' + p);
    st.board = r.a;
    st.record.events.push({ type: 'play', player: p, point: i, captured: r.cap });
  };
  // 中心(index 0)を2Pが打つ → 1Pが (1,6,5) で囲む → 取れる
  play(0, 2); play(1, 1); play(6, 1); play(5, 1);
  play(2, 2); play(7, 1);
  st.record.events.push({ type: 'score', removed: [2], scores: [0, 40, 21], result: '1Pの勝ち (40点)' });
  return { st, geo };
}

(function () {
  console.log('dev/replay-selftest');
  const { st, geo } = buildScenario();

  const positions = R.replayPositions(st.record, geo);
  ok(positions.length === 8, '局面数: 初期 + 6手 + score = 8');
  ok(positions[0].board.every(v => !v), '最初の局面は空盤');
  ok(positions[positions.length - 1].board[2] === 0, 'score イベントで死に石除去');
  ok(positions.findIndex(pos => pos.note && pos.note.captured > 0) > 0, '捕獲の局面が含まれる');

  // 手番: 各局面の turn は「次に打つ席」。打った本人が手番になってはいけない
  // (リプレイの途中から再開したとき、同じ人が2連続で打ててしまうバグの再発防止)
  let turnBad = null;
  for (let i = 1; i < positions.length; i++) {
    const pos = positions[i], note = pos.note;
    if (!note || (note.kind !== 'play' && note.kind !== 'pass')) continue;
    const pc = 2, expected = (note.player % pc) + 1;
    if (pos.turn !== expected) turnBad = { ply: pos.ply, player: note.player, turn: pos.turn, expected };
  }
  ok(!turnBad, '局面の turn は「次に打つ席」(打った人の次)' + (turnBad ? ' ' + JSON.stringify(turnBad) : ''));


  const series = R.advantageSeries(positions, geo, 2);
  ok(series.rows.length === positions.length, '優勢度の行数 = 局面数');
  const leadsOk = series.rows.every(r => Math.abs((r.lead[1] ?? 0) + (r.lead[2] ?? 0)) < 1e-9);
  ok(leadsOk, '2人戦: 1P と 2P のリードは対称(+x / -x)');
  ok(nextToZero(series.rows[0]), '序盤(手数1)は互角付近');
  // 取る前(2Pが中央)は 2P リード、取った後は 1P リードに反転
  ok(series.rows[1].lead[2] > 0, '2P が中央に打った直後は 2P リード');
  // 序盤は「盤面比 %」の小さな揺れに収まる(石1つで振り切れない)
  const early = series.rows.slice(0, 3);
  const earlyMax = Math.max(...early.map(r => Math.max(...Object.values(r.leadPct).map(Math.abs))));
  ok(earlyMax < 10, '序盤3手の最大リードは 10% 未満（カンストしない）');
  const rAfterCapture = series.rows.find(r => r.event && r.event.kind === 'play' && r.event.captured > 0);
  ok(rAfterCapture.lead[1] > 0, '1P が取った直後は 1P リードに反転');
  const lastRow = series.rows[series.rows.length - 1];
  ok(lastRow.evals[1] === 40 && lastRow.evals[2] === 21, '最終行は確定スコア(40 / 21)に接続');
  ok(series.swing && series.swing.player === 1 && Math.abs(series.swing.delta) > 1, '最大の形勢変化は 1P 側に検出');

  // 3人戦: lead は出場プレイヤーの平均との差
  const geo3 = R.buildGeometry(9);
  const empty3 = new Array(geo3.points.length).fill(0);
  const st3 = { playerCount: 3, size: 9, board: empty3.slice(), turn: 1, passes: 0, over: false, phase: 'setup', dead: [], seen: [], out: [false, false, false, false], damage: [0, 0, 0, 0] };
  st3.record = Features.createRecord(st3);
  // 3人戦で実際に打った手を入れて、手番が「次の人」になっているか検証する
  // (2人戦だけ通る実装を防ぐ)
  {
    const b = empty3.slice(); let turn = 1;
    for (let k = 0; k < 6; k++) {
      const mv = b.findIndex((v, i) => !v && R.simulateOnBoard(b, geo3, i, turn));
      if (mv < 0) break;
      const r = R.simulateOnBoard(b, geo3, mv, turn);
      b.splice(0, b.length, ...r.a);
      st3.record.events.push({ type: 'play', player: turn, point: mv, captured: r.cap });
      turn = (turn % 3) + 1;
    }
  }
  const pos3 = R.replayPositions(st3.record, geo3, 3);
  const s3 = R.advantageSeries(pos3, geo3, 3);
  ok(s3.rows.length === pos3.length && Object.keys(s3.rows[0].lead).length === 3, '3人戦: 各席のリードが計算される');
  ok(s3.rows.every(r => Object.keys(r.lead).length === 3), '3人戦: 全行で3席ぶんのリード');
  {
    let bad3 = null;
    for (let i = 1; i < pos3.length; i++) {
      const pos = pos3[i], note = pos.note;
      if (!note || (note.kind !== 'play' && note.kind !== 'pass')) continue;
      const expected = (note.player % 3) + 1;
      if (pos.turn !== expected) bad3 = { ply: pos.ply, player: note.player, turn: pos.turn, expected };
    }
    ok(!bad3, '3人戦でも turn は次の人' + (bad3 ? ' ' + JSON.stringify(bad3) : ''));
  }

  // アタリ(呼吸点1)の連は弱石として評価から減じる
  const b4 = new Array(geo3.points.length).fill(0);
  b4[0] = 2; b4[1] = 1; b4[6] = 1; b4[5] = 1;   // 2P の石がアタリ
  const cut = R.weakStoneLoss(b4, geo3);
  ok(cut.get(2) === 1, '呼吸点1の連(1石)は弱石としてカウント');

  // 盤面比ベースの検証: 石を置き進めると形勢差は徐々に開く(カンストしない)
  {
    const g = R.buildGeometry(9);
    const b = new Array(g.points.length).fill(0);
    const leadOf = () => Math.abs(R.leadValues(R.advantageOf(b, g, 2, null)).leadPct[0]);
    let prev = 0;
    b[0] = 1; const l1 = leadOf();
    for (let i = 1; i < 20; i++) b[i] = (i % 2) + 1; const l2 = leadOf();
    b[0] = 2; b[1] = 2; const l3 = leadOf();
    ok(l1 < 5, '石1つでは形勢差は5%未満(カンストしない)');
    ok(l2 >= l1, '石が増えると形勢差は開いていく');
    ok(isFinite(l3), '偏った局面でも有限値');
  }

  // ---- URL 共有エンコード/デコードの往復 ----
  {
    const g = R.buildGeometry(9);
    const s2 = { playerCount: 2, size: 9, board: new Array(g.points.length).fill(0), turn: 1, passes: 0, over: false, phase: 'playing', dead: [], seen: [], out: [false, false, false], damage: [0, 0, 0] };
    s2.record = Features.createRecord(s2);
    let n = 0;
    for (let i = 0; i < g.points.length && n < 24; i++) {
      const p = (n % 2) + 1;
      const r = R.simulateOnBoard(s2.board, g, i, p);
      if (!r) continue;
      s2.board = r.a;
      s2.record.events.push({ type: 'play', player: p, point: i, captured: r.cap });
      n++;
    }
    s2.record.events.push({ type: 'resign', player: 2 });
    s2.record.events.push({ type: 'score', removed: [], scores: [0, 33, 18], result: '1Pの勝ち' });
    const code = R.encodeShare(s2.record, 9, 2, { 1: '先手', 2: '後手' });
    ok(/^[A-Za-z0-9_-]+$/.test(code), '共有コードは URL セーフ文字のみ');
    ok(code.length < 2000, '共有コードが実用サイズ (' + code.length + ' 文字)');
    const dec = R.decodeShare(code);
    ok(dec.size === 9 && dec.playerCount === 2, '盤サイズと人数が復元される');
    ok(dec.names[1] === '先手' && dec.names[2] === '後手', 'プレイヤー名が復元される');
    const p1 = R.replayPositions(s2.record, g), p2 = R.replayPositions(dec.record, g);
    ok(p1.length === p2.length, '手数が一致 (' + p1.length + ')');
    ok(JSON.stringify(p1.at(-1).board) === JSON.stringify(p2.at(-1).board), '終局盤面が完全一致');
    ok(dec.record.events.some(e => e.type === 'resign'), '投了イベントが復元される');
    const sc = dec.record.events.find(e => e.type === 'score');
    ok(sc && sc.scores[1] === 33, '確定スコアが復元される');
    // 壊れた入力は例外になる
    let threw = false;
    try { R.decodeShare('!!!invalid!!!'); } catch (e) { threw = true; }
    ok(threw, '不正な共有コードは例外になる');
  }

  // ---- AI / 人間の席情報 ----
  {
    const g = R.buildGeometry(9);
    const rec = {
      initial: { board: new Array(g.points.length).fill(0), out: [false, false, false, false], aiSeats: [false, false, true, false] },
      events: [
        { type: 'play', player: 1, point: 30 },
        { type: 'seat', player: 1, ai: true },
        { type: 'play', player: 2, point: 31 }
      ]
    };
    const pos = R.replayPositions(rec, g);
    ok(pos[0].aiSeats[2] === true, '初期の AI 席が復元される');
    ok(pos[1].aiSeats[1] === false, '切替前は人間');
    ok(pos[2].aiSeats[1] === true, '切替後は AI');
    ok(pos[2].ply === 1 && pos[3].ply === 2, '切替イベントは手数を増やさない');
    const ser = R.advantageSeries(pos, g, 3);
    ok(!!ser.rows[2].aiSeats && ser.rows[2].aiSeats[1] === true, '優勢度系列にも AI 状態が乗る');
    // 共有の往復
    const enc = R.encodeShare(rec, 9, 3, {});
    const dec = R.decodeShare(enc);
    ok(dec.record.initial.aiSeats[2] === true, '共有で AI 席が保たれる(make)');
    ok(dec.record.events.filter(e => e.type === 'seat').length === 1, '共有で切替イベントが保たれる');
  }

  function nextToZero(row) { return Math.abs(row.lead[1] ?? 0) < 1e-9 && Math.abs(row.lead[2] ?? 0) < 1e-9; }

  process.exit(failed ? 1 : 0);
})();
