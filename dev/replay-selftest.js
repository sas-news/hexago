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
  const pos3 = R.replayPositions(st3.record, geo3);
  const s3 = R.advantageSeries(pos3, geo3, 3);
  ok(s3.rows.length === 1 && Object.keys(s3.rows[0].lead).length === 3, '3人戦: 各席のリードが計算される');
  ok(s3.rows[0].evals.every(v => !v), '空盤は全員 0');

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

  function nextToZero(row) { return Math.abs(row.lead[1] ?? 0) < 1e-9 && Math.abs(row.lead[2] ?? 0) < 1e-9; }

  process.exit(failed ? 1 : 0);
})();
