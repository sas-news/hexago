#!/usr/bin/env node
'use strict';
/**
 * dev/cdp/regress.js — HEXAGO アプリ回帰テスト（依存ゼロ / 自前 HTTP サーバ + CDP）
 *
 * 使い方:
 *   node dev/cdp/regress.js                          # 自前サーバで実行、dev/cdp/current.json に保存
 *   node dev/cdp/regress.js --out dev/cdp/baseline.json
 *   node dev/cdp/regress.js --url http://127.0.0.1:8123/index.html
 *   node dev/cdp/regress.js --compare dev/cdp/baseline.json   # リファクタ前後でスナップショット比較
 *
 * 検証内容（最低限）:
 *   a. 起動して JS 例外 / console error が無い
 *   b. window.__hexagoDebug が存在し state() が返る
 *   c. AI が合法手を打つ（think(ms) → sim() で合法、数手で盤面が進む）
 *   d. undo / pass / 投了 が壊れていない
 *   e. 盤サイズ 9/13/19 で開始でき、AI が合法手を返す
 *   f. sessionStorage['hexago-save-v1'] に保存され、リロードで復元される
 *   g. 設定/ルール/結果モーダルの開閉、テーマ切替
 *   h. 390x844 / 1280x800 のスクリーンショットとレイアウト（canvas サイズ・横はみ出し）
 *
 * 出力:
 *   --out の JSON は「検証結果」＋「決定的な状態スナップショット」。
 *   snapshot 部分だけを取り出せば、リファクタ前後で diff できる（--compare はこれを自動化）。
 *   AI の着手・訪問数など実行ごとに揺れる値は observations 側に分離してある。
 *
 * 終了コード: 0 = 全 PASS / 1 = FAIL（原因は標準出力と JSON に残る）
 */

const path = require('node:path');
const fs = require('node:fs');
const fsp = fs.promises;
const crypto = require('node:crypto');

const { Browser, sleep } = require('./driver');
const { startStaticServer } = require('./serve');

const REPO = path.resolve(__dirname, '..', '..');
const SAVE_KEY = 'hexago-save-v1';
const DEFAULT_OUT = path.join(__dirname, 'current.json');
const DEFAULT_SHOTS = path.join(__dirname, 'shots');

/* ========================================================================== */
/* CLI                                                                        */
/* ========================================================================== */

function parseArgs(argv) {
  const opts = {
    url: null,
    out: DEFAULT_OUT,
    shots: DEFAULT_SHOTS,
    compare: null,
    timeout: 30000,
    totalTimeout: 180000,
    verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) {
        console.error(`ERROR: ${a} には値が必要です`);
        process.exit(2);
      }
      return v;
    };
    switch (a) {
      case '--url':
        opts.url = next();
        break;
      case '--out':
        opts.out = next();
        break;
      case '--shots':
        opts.shots = next();
        break;
      case '--compare':
        opts.compare = next();
        break;
      case '--timeout':
        opts.timeout = Math.max(1000, parseInt(next(), 10) || 30000);
        break;
      case '--total-timeout':
        opts.totalTimeout = Math.max(10000, parseInt(next(), 10) || 180000);
        break;
      case '--verbose':
        opts.verbose = true;
        break;
      case '--help':
      case '-h':
        console.log(
          [
            'node dev/cdp/regress.js [options]',
            '',
            '  --url <url>          既存の URL を使う（省略時は自前 HTTP サーバ）',
            '  --out <file>        結果 JSON の保存先 (default: dev/cdp/current.json)',
            '  --shots <dir>       スクリーンショット保存先 (default: dev/cdp/shots)',
            '  --compare <file>    このスナップショットと比較し、差分があれば exit 1',
            '  --timeout <ms>      CDP コマンドのタイムアウト (default: 30000)',
            '  --total-timeout <ms> 全体のタイムアウト (default: 180000)',
            '  --verbose           進捗ログを stderr に出す',
            '  -h, --help          このヘルプ',
          ].join('\n')
        );
        process.exit(0);
        break;
      default:
        console.error(`ERROR: 不明な引数: ${a}`);
        process.exit(2);
    }
  }
  opts.out = path.resolve(REPO, opts.out);
  opts.shots = path.resolve(REPO, opts.shots);
  if (opts.compare) opts.compare = path.resolve(REPO, opts.compare);
  return opts;
}

/* ========================================================================== */
/* チェック / スナップショット ヘルパ                                         */
/* ========================================================================== */

const results = [];
let passCount = 0;
let failCount = 0;

function check(name, ok, detail) {
  const passed = !!ok;
  results.push({ name, ok: passed, detail: detail === undefined || detail === null ? null : String(detail) });
  if (passed) {
    passCount++;
    console.log(`PASS  ${name}${detail !== undefined && detail !== null ? '  (' + detail + ')' : ''}`);
  } else {
    failCount++;
    console.log(`FAIL  ${name}${detail !== undefined && detail !== null ? '  (' + detail + ')' : ''}`);
  }
  return passed;
}

function log(msg) {
  if (opts && opts.verbose) process.stderr.write(`[regress] ${msg}\n`);
}

function boardHash(board) {
  // FNV-1a (32bit) + 盤長を混ぜた決定的ハッシュ
  let h = 0x811c9dc5;
  for (let i = 0; i < board.length; i++) {
    h ^= (board[i] + 17) & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
    h ^= board[i] << 5;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= board.length & 0xffff;
  h = Math.imul(h, 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0');
}

function sha256Short(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 16);
}

function stoneCounts(board, playerCount) {
  const counts = [];
  for (let p = 1; p <= playerCount; p++) counts.push(board.filter((v) => v === p).length);
  return counts;
}

function stateSummary(st) {
  const pc = st.playerCount || 3;
  return {
    size: st.size,
    phase: st.phase,
    turn: st.turn,
    playerCount: pc,
    over: !!st.over,
    boardLength: st.board.length,
    boardHash: boardHash(st.board),
    stones: stoneCounts(st.board, pc),
    totalStones: st.board.filter(Boolean).length,
  };
}

function expectedBoardLength(size) {
  const side = (size + 1) / 2;
  return 3 * side * (side - 1) + 1;
}

/** オブジェクトのキー順に依存しない比較用の正規化。 */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = canonicalize(value[k]);
    return out;
  }
  return value;
}

/** 最初に現れた差分を最大 limit 件返す。 */
function firstDiffs(base, cur, prefix = '', out = [], limit = 20) {
  if (out.length >= limit) return out;
  const isObj = (v) => v && typeof v === 'object';
  if (isObj(base) && isObj(cur)) {
    const keys = new Set([...Object.keys(base), ...Object.keys(cur)]);
    for (const k of keys) {
      firstDiffs(base[k], cur[k], prefix ? `${prefix}.${k}` : k, out, limit);
      if (out.length >= limit) return out;
    }
    return out;
  }
  if (JSON.stringify(base) !== JSON.stringify(cur)) {
    out.push({ path: prefix || '(root)', baseline: base === undefined ? '<missing>' : base, current: cur === undefined ? '<missing>' : cur });
  }
  return out;
}

/* ========================================================================== */
/* メイン                                                                     */
/* ========================================================================== */

let opts = null;
let server = null;
let browser = null;
let page = null;
let cleaningUp = false;

async function main() {
  opts = parseArgs(process.argv.slice(2));
  const startedAt = Date.now();

  const snapshot = {};
  const observations = {};
  const shotsDir = opts.shots;
  await fsp.mkdir(shotsDir, { recursive: true });

  let shuttingDown = false;
  const shutdown = async (reason, code) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[regress] ${reason}`);
    await cleanup();
    process.exit(code);
  };
  const watchdog = setTimeout(() => {
    shutdown(`全体タイムアウト (${opts.totalTimeout}ms) を超過しました`, 1);
  }, opts.totalTimeout);
  process.once('SIGINT', () => shutdown('SIGINT で中断しました', 1));
  process.once('SIGTERM', () => shutdown('SIGTERM で中断しました', 1));

  const targetUrlForReport = () => {
    if (server && opts.url === null) return targetUrl.replace(server.origin, 'http://<server>');
    return targetUrl;
  };

  let targetUrl = null;

  try {
    /* ---- サーバ / ブラウザ起動 ----------------------------------------- */
    if (!opts.url) {
      server = await startStaticServer(REPO);
      targetUrl = server.urlFor('/index.html');
      log(`静的サーバ: ${server.origin} (${REPO})`);
    } else {
      targetUrl = opts.url;
      log(`外部 URL: ${targetUrl}`);
    }

    browser = await Browser.launch({ timeoutMs: opts.timeout });
    log(`chrome: ${browser.version} / ws: ${browser.wsUrl}`);

    page = await browser.newPage({
      viewport: { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false },
      timeoutMs: opts.timeout,
    });

    log(`goto ${targetUrl}`);
    await page.goto(targetUrl, { timeoutMs: opts.timeout });
    await page.waitForFunction('window.__hexagoDebug && typeof window.__hexagoDebug.state === "function"', {
      timeoutMs: 15000,
      label: 'window.__hexagoDebug',
    });
    await sleep(400); // 起動直後の非同期処理（Worker 準備など）を待つ

    /* ---- a/b. 起動・デバッグ API・初期状態 ----------------------------- */
    const boot = await page.evaluate(() => {
      const cv = document.getElementById('cv');
      const r = cv.getBoundingClientRect();
      return {
        title: document.title,
        readyState: document.readyState,
        hasDebug: typeof window.__hexagoDebug === 'object' && window.__hexagoDebug !== null,
        debugKeys: Object.keys(window.__hexagoDebug || {}).sort(),
        state: window.__hexagoDebug.state(),
        engine: window.__hexagoDebug.engine(),
        setModalOpen: !document.getElementById('setModal').classList.contains('hidden'),
        canvas: { cssW: r.width, cssH: r.height, pxW: cv.width, pxH: cv.height },
      };
    });

    const initial = stateSummary(boot.state);
    snapshot.initial = initial;
    observations.engine = boot.engine;

    check('ページが起動し window.__hexagoDebug が存在する', boot.hasDebug && boot.readyState === 'complete', `${boot.title} / keys=${boot.debugKeys.length}`);
    check('state() が盤面・手番を返す', Array.isArray(boot.state.board) && Number.isInteger(boot.state.turn), JSON.stringify({ size: boot.state.size, turn: boot.state.turn, board: boot.state.board.length }));
    check('初期状態が盤サイズ 9・空盤', boot.state.size === 9 && boot.state.board.length === 61 && boot.state.board.every((v) => v === 0), JSON.stringify(initial));
    check('AI エンジンがエラー無くロードされる', !boot.engine.error && boot.engine.loaded !== false, JSON.stringify({ worker: boot.engine.worker, loaded: boot.engine.loaded, error: boot.engine.error || '' }));
    check('canvas が初期描画されている', boot.canvas.cssW > 100 && boot.canvas.cssH > 100 && boot.canvas.pxW > 0 && boot.canvas.pxH > 0, JSON.stringify(boot.canvas));
    check('初回起動で設定モーダルが開く', boot.setModalOpen === true);

    // スクリーンショット用にモーダルを閉じる（UI の✕ボタン経由）
    const closedAtBoot = await page.evaluate(() => {
      document.getElementById('btnCloseSettings').click();
      return document.getElementById('setModal').classList.contains('hidden');
    });
    check('設定モーダルの✕で閉じる', closedAtBoot === true);

    /* ---- c. AI が合法手を打つ ------------------------------------------ */
    const ai = await page.evaluate(async () => {
      const d = window.__hexagoDebug;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      d.setAllHuman();
      d.newGame(9);
      await sleep(60);
      const moves = [];
      for (let k = 0; k < 4 && moves.filter((m) => m.played).length < 3; k++) {
        const before = d.state().board.slice();
        const res = await d.think(300);
        const mv = res && res.move;
        const legal = mv === -1 ? true : !!d.sim(mv);
        const mutated = d.state().board.some((v, i) => v !== before[i]);
        const played = legal && mv >= 0 ? d.playMove(mv) : false;
        moves.push({ move: mv, legal, mutated, played, visits: (res && res.visits) || 0 });
        await sleep(20);
      }
      const st = d.state();
      return {
        moves,
        engine: d.engine(),
        summary: {
          size: st.size,
          phase: st.phase,
          turn: st.turn,
          playerCount: st.playerCount,
          over: !!st.over,
          boardLength: st.board.length,
          totalStones: st.board.filter(Boolean).length,
        },
      };
    });

    const aiLegal = ai.moves.every((m) => m.legal);
    const aiPlayed = ai.moves.filter((m) => m.played).length;
    observations.ai = { moves: ai.moves, engineAfter: ai.engine };
    check('AI が think() で合法手を返す', aiLegal, ai.moves.map((m) => m.move).join(','));
    check('think() が盤面を書き換えない', ai.moves.every((m) => !m.mutated));
    check('AI の着手で対局が進む（3手）', aiPlayed >= 3 && ai.summary.totalStones >= 2, JSON.stringify(ai.summary));
    check('AI の Worker 経路が有効', ai.engine.worker === true, JSON.stringify({ worker: ai.engine.worker, workers: ai.engine.workers, error: ai.engine.error || '' }));
    check('AI 実行後もエンジンエラーが無い', !ai.engine.error, ai.engine.error || '');

    /* ---- d. undo / pass / 投了 ----------------------------------------- */
    await page.evaluate(() => {
      window.__hexagoDebug.setAllHuman();
      window.__hexagoDebug.newGame(9);
    });
    await sleep(60);

    const firstLegal = () =>
      page.evaluate(`(() => {
        const d = window.__hexagoDebug;
        const b = d.state().board;
        for (let i = 0; i < b.length; i++) if (!b[i] && d.sim(i)) return i;
        return -1;
      })()`);

    const m1 = await firstLegal();
    const played1 = await page.evaluate((m) => window.__hexagoDebug.playMove(m), m1);
    const stateAfter1 = stateSummary(await page.evaluate(() => window.__hexagoDebug.state()));
    const m2 = await firstLegal();
    const played2 = await page.evaluate((m) => window.__hexagoDebug.playMove(m), m2);
    const beforeUndo = stateSummary(await page.evaluate(() => window.__hexagoDebug.state()));

    check('手動の着手が通る（undo 前準備）', played1 === true && played2 === true && beforeUndo.totalStones === 2, JSON.stringify({ m1, m2, beforeUndo }));

    const undoModalOpened = await page.evaluate(() => {
      document.getElementById('btnUndo').click();
      return !document.getElementById('undoModal').classList.contains('hidden');
    });
    check('1手戻るで確認モーダルが開く', undoModalOpened === true);

    const afterUndo = await page.evaluate(async () => {
      document.getElementById('btnUndoOk').click();
      await new Promise((r) => setTimeout(r, 60));
      return window.__hexagoDebug.state();
    });
    const undoSummary = stateSummary(afterUndo);
    snapshot.undo = {
      afterFirstMove: stateAfter1,
      beforeUndo,
      afterUndo: undoSummary,
      modalOpened: undoModalOpened,
    };
    check('undo で石数と盤面が 1 手前に戻る', undoSummary.totalStones === stateAfter1.totalStones && undoSummary.boardHash === stateAfter1.boardHash && undoSummary.turn === stateAfter1.turn, JSON.stringify({ before: beforeUndo.totalStones, after: undoSummary.totalStones }));

    // pass: 手番が進み、保存データに passes が入る
    const passRes = await page.evaluate(async () => {
      const d = window.__hexagoDebug;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      d.setAllHuman();
      d.newGame(9);
      await sleep(60);
      const before = d.state();
      document.getElementById('btnPass').click();
      await sleep(60);
      const after = d.state();
      const saved = JSON.parse(sessionStorage.getItem('hexago-save-v1') || 'null');
      return { before: { turn: before.turn, totalStones: before.board.filter(Boolean).length }, after: { turn: after.turn, totalStones: after.board.filter(Boolean).length, phase: after.phase }, passes: saved && saved.G ? saved.G.passes : null };
    });
    snapshot.pass = passRes;
    check('パスで手番が進み保存される', passRes.after.turn !== passRes.before.turn && passRes.passes === 1, JSON.stringify(passRes));

    // 投了: 2回タップで確定し out が保存される
    const resignRes = await page.evaluate(async () => {
      const d = window.__hexagoDebug;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      d.setAllHuman();
      d.newGame(9);
      await sleep(60);
      const before = d.state();
      const btn = document.getElementById('btnResign');
      btn.click();
      const armed = btn.textContent.trim();
      const overAfterFirst = d.state().over;
      btn.click();
      await sleep(60);
      const after = d.state();
      const saved = JSON.parse(sessionStorage.getItem('hexago-save-v1') || 'null');
      const out = saved && saved.G ? saved.G.out : null;
      return {
        armed,
        overAfterFirst,
        before: { turn: before.turn, over: before.over },
        after: { turn: after.turn, over: after.over },
        out,
      };
    });
    const outCount = resignRes.out ? resignRes.out.filter(Boolean).length : 0;
    snapshot.resign = { ...resignRes, outCount };
    check('投了は2回タップで確定する', /本当に投了/.test(resignRes.armed) && resignRes.overAfterFirst === false, resignRes.armed);
    check('投了で OUT が記録され手番が進む', outCount === 1 && resignRes.after.turn !== resignRes.before.turn, JSON.stringify(resignRes));

    /* ---- e. 盤サイズ 9/13/19 ------------------------------------------- */
    snapshot.sizes = [];
    for (const size of [9, 13, 19]) {
      const r = await page.evaluate(async (s) => {
        const d = window.__hexagoDebug;
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        d.setAllHuman();
        d.newGame(s);
        await sleep(40);
        const st0 = d.state();
        const res = await d.think(250);
        const mv = res && res.move;
        const legal = mv === -1 ? true : !!d.sim(mv);
        return {
          size: st0.size,
          boardLength: st0.board.length,
          move: mv,
          legal,
          visits: (res && res.visits) || 0,
          engineError: d.engine().error || '',
        };
      }, size);
      const want = expectedBoardLength(size);
      snapshot.sizes.push({ size, boardLength: r.boardLength, legal: r.legal });
      check(`盤サイズ ${size} で開始でき AI が合法手を返す`, r.size === size && r.boardLength === want && r.legal && !r.engineError, JSON.stringify({ move: r.move, visits: r.visits, boardLength: r.boardLength }));
    }

    /* ---- f. 保存 → リロード復元 ---------------------------------------- */
    await page.evaluate(async () => {
      const d = window.__hexagoDebug;
      d.setAllHuman();
      d.newGame(9);
      await new Promise((r) => setTimeout(r, 60));
      for (let k = 0; k < 3; k++) {
        const b = d.state().board;
        let mv = -1;
        for (let i = 0; i < b.length; i++) if (!b[i] && d.sim(i)) { mv = i; break; }
        if (mv >= 0) d.playMove(mv);
      }
    });
    await sleep(80);

    const beforeReload = await page.evaluate(() => {
      const d = window.__hexagoDebug;
      const raw = sessionStorage.getItem('hexago-save-v1');
      let parsed = null;
      try { parsed = JSON.parse(raw || 'null'); } catch (e) { parsed = null; }
      return {
        state: d.state(),
        raw,
        save: parsed
          ? {
              size: parsed.G.size,
              turn: parsed.G.turn,
              phase: parsed.G.phase,
              passes: parsed.G.passes,
              playerCount: parsed.G.playerCount,
              theme: parsed.theme,
              sound: parsed.sound,
              seats: parsed.seats,
              board: parsed.G.board,
              gKeys: Object.keys(parsed.G).sort(),
              keyCount: Object.keys(parsed).sort(),
            }
          : null,
        setModalOpen: !document.getElementById('setModal').classList.contains('hidden'),
      };
    });
    const preSummary = stateSummary(beforeReload.state);
    const saveRawHash = beforeReload.raw ? sha256Short(beforeReload.raw) : null;

    await page.reload({ timeoutMs: opts.timeout });
    await page.waitForFunction('window.__hexagoDebug && typeof window.__hexagoDebug.state === "function"', {
      timeoutMs: 15000,
      label: 'reload 後の __hexagoDebug',
    });
    await sleep(400);

    const afterReload = await page.evaluate(() => {
      const d = window.__hexagoDebug;
      const raw = sessionStorage.getItem('hexago-save-v1');
      return {
        state: d.state(),
        rawPresent: !!raw,
        raw,
        setModalOpen: !document.getElementById('setModal').classList.contains('hidden'),
        resModalOpen: !document.getElementById('resModal').classList.contains('hidden'),
      };
    });
    const postSummary = stateSummary(afterReload.state);
    snapshot.save = beforeReload.save
      ? {
          present: true,
          key: SAVE_KEY,
          rawHash: saveRawHash,
          fields: {
            size: beforeReload.save.size,
            turn: beforeReload.save.turn,
            phase: beforeReload.save.phase,
            passes: beforeReload.save.passes,
            playerCount: beforeReload.save.playerCount,
            theme: beforeReload.save.theme,
            sound: beforeReload.save.sound,
            seats: beforeReload.save.seats,
            gKeys: beforeReload.save.gKeys,
            topKeys: beforeReload.save.keyCount,
          },
          boardHash: boardHash(beforeReload.save.board),
          summary: preSummary,
        }
      : { present: false };
    snapshot.restore = {
      summary: postSummary,
      matches: postSummary.boardHash === preSummary.boardHash && postSummary.turn === preSummary.turn && postSummary.size === preSummary.size,
      rawHashAfterReload: afterReload.rawPresent ? sha256Short(afterReload.raw) : null,
      setModalOpen: afterReload.setModalOpen,
    };
    check('sessionStorage に hexago-save-v1 が保存される', !!beforeReload.save && !!beforeReload.raw && beforeReload.save.size === 9, saveRawHash || 'none');
    check('リロードで盤面・手番・サイズが復元される', snapshot.restore.matches === true && afterReload.rawPresent, JSON.stringify({ before: preSummary, after: postSummary }));
    check('復元時は設定モーダルが自動で開かない', afterReload.setModalOpen === false);

    /* ---- g. モーダル開閉 / テーマ --------------------------------------- */
    const modalRes = await page.evaluate(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const vis = (id) => !document.getElementById(id).classList.contains('hidden');
      const d = window.__hexagoDebug;
      d.setAllHuman();
      d.newGame(9);
      await sleep(40);

      document.getElementById('btnOpenSettings').click();
      await sleep(20);
      const settingsOpen = vis('setModal');
      document.getElementById('btnCloseSettings').click();
      await sleep(20);
      const settingsClosed = !vis('setModal');

      document.getElementById('btnOpenRules').click();
      await sleep(20);
      const rulesOpen = vis('rulesModal');
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      await sleep(20);
      const rulesClosedByEsc = !vis('rulesModal');

      document.getElementById('btnOpenSettings').click();
      await sleep(20);
      document.getElementById('setModal').click(); // 背景クリック（target === modal）
      await sleep(20);
      const settingsClosedByBackdrop = !vis('setModal');

      const d2 = d.finishNow();
      const resultOpened = vis('resModal');
      const resultTitle = document.getElementById('resTitle').textContent.trim();
      document.getElementById('btnCloseResult').click();
      await sleep(20);
      const resultClosed = !vis('resModal');

      return {
        settingsOpen,
        settingsClosed,
        rulesOpen,
        rulesClosedByEsc,
        settingsClosedByBackdrop,
        resultOpened,
        resultTitle,
        resultClosed,
        over: d.state().over,
      };
    });
    snapshot.modals = modalRes;
    check('設定モーダルが開閉する（✕ / 背景クリック）', modalRes.settingsOpen && modalRes.settingsClosed && modalRes.settingsClosedByBackdrop, JSON.stringify({ open: modalRes.settingsOpen, close: modalRes.settingsClosed, backdrop: modalRes.settingsClosedByBackdrop }));
    check('ルールモーダルが開閉する（Esc）', modalRes.rulesOpen && modalRes.rulesClosedByEsc);
    check('結果モーダルが開閉する', modalRes.resultOpened && modalRes.resultClosed && modalRes.resultTitle.length > 0, JSON.stringify({ title: modalRes.resultTitle, over: modalRes.over }));

    const themeRes = await page.evaluate(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const saveTheme = () => {
        try { return JSON.parse(sessionStorage.getItem('hexago-save-v1') || 'null')?.theme || null; } catch (e) { return null; }
      };
      const bg = () => getComputedStyle(document.body).getPropertyValue('--bg').trim();
      const btns = document.querySelectorAll('#themeList button');
      const before = { bg: bg(), saveTheme: saveTheme() };
      if (btns.length > 1) { btns[1].click(); await sleep(50); }
      const dark = { bg: bg(), saveTheme: saveTheme() };
      if (btns.length > 0) { btns[0].click(); await sleep(50); }
      const restored = { bg: bg(), saveTheme: saveTheme() };
      return { count: btns.length, before, dark, restored };
    });
    snapshot.theme = themeRes;
    check('テーマ切替が反映され保存される', themeRes.count >= 2 && themeRes.dark.bg !== themeRes.before.bg && themeRes.dark.saveTheme === 'dark' && themeRes.restored.bg === themeRes.before.bg, JSON.stringify({ count: themeRes.count, before: themeRes.before, dark: themeRes.dark }));

    /* ---- h. レイアウト + スクリーンショット ------------------------------ */
    // 見た目確認用に決定的な手順で石を置く（最初の合法手を順に）
    await page.evaluate(async () => {
      const d = window.__hexagoDebug;
      d.setAllHuman();
      d.newGame(9);
      await new Promise((r) => setTimeout(r, 60));
      for (let k = 0; k < 9; k++) {
        const b = d.state().board;
        let mv = -1;
        for (let i = 0; i < b.length; i++) if (!b[i] && d.sim(i)) { mv = i; break; }
        if (mv >= 0) d.playMove(mv);
      }
    });
    await sleep(80);

    snapshot.layout = {};
    const viewports = [
      { name: 'mobile', width: 390, height: 844, deviceScaleFactor: 2, mobile: true, shot: 'mobile-390x844.png' },
      { name: 'desktop', width: 1280, height: 800, deviceScaleFactor: 1, mobile: false, shot: 'desktop-1280x800.png' },
    ];
    const shotFiles = [];
    for (const vp of viewports) {
      await page.setViewport({
        width: vp.width,
        height: vp.height,
        deviceScaleFactor: vp.deviceScaleFactor,
        mobile: vp.mobile,
      });
      const layout = await page.evaluate(() => {
        const cv = document.getElementById('cv');
        const r = cv.getBoundingClientRect();
        const doc = document.documentElement;
        const openModals = ['setModal', 'undoModal', 'rulesModal', 'resModal'].filter((id) => {
          const el = document.getElementById(id);
          return el && !el.classList.contains('hidden');
        });
        return {
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          dpr: window.devicePixelRatio,
          canvas: {
            cssW: Math.round(r.width * 100) / 100,
            cssH: Math.round(r.height * 100) / 100,
            pxW: cv.width,
            pxH: cv.height,
            left: Math.round(r.left * 100) / 100,
            top: Math.round(r.top * 100) / 100,
          },
          scrollWidth: doc.scrollWidth,
          bodyScrollWidth: document.body.scrollWidth,
          horizontalOverflow: doc.scrollWidth > window.innerWidth + 1,
          openModals,
          turnText: document.getElementById('turnInd').textContent.trim(),
        };
      });
      const shotPath = path.join(shotsDir, vp.shot);
      await page.screenshot(shotPath);
      const shotBytes = fs.statSync(shotPath).size;
      shotFiles.push(vp.shot);
      snapshot.layout[vp.name] = {
        viewport: { width: vp.width, height: vp.height, dpr: vp.deviceScaleFactor, mobile: vp.mobile },
        innerWidth: layout.innerWidth,
        innerHeight: layout.innerHeight,
        dpr: layout.dpr,
        canvas: layout.canvas,
        scrollWidth: layout.scrollWidth,
        horizontalOverflow: layout.horizontalOverflow,
        shot: vp.shot,
      };
      const aspectOk = Math.abs(layout.canvas.cssW - layout.canvas.cssH) <= 2;
      check(
        `${vp.name} ${vp.width}x${vp.height} でレイアウトが破綻しない`,
        layout.canvas.cssW > 100 && layout.canvas.cssH > 100 && layout.canvas.pxW > 0 && layout.canvas.pxH > 0 && aspectOk && !layout.horizontalOverflow && layout.openModals.length === 0,
        JSON.stringify({ canvas: layout.canvas, scrollWidth: layout.scrollWidth, overflow: layout.horizontalOverflow, modals: layout.openModals })
      );
      check(`${vp.name} のスクリーンショットを保存`, shotBytes > 1000, `${vp.shot} (${shotBytes} bytes)`);
    }
    observations.screenshots = shotFiles;

    /* ---- 最終: console error / 例外 ------------------------------------- */
    const logs = {
      consoleErrors: page.logs.consoleErrors,
      consoleWarnings: page.logs.consoleWarnings,
      exceptions: page.logs.exceptions,
      resourceErrors: page.logs.resourceErrors,
    };
    // Runtime.consoleAPICalled のうち type=error を集計（driver 側で振り分け）
    logs.consoleErrors = page.logs.console.filter((e) => e.type === 'error').map((e) => e.text);
    logs.consoleWarnings = page.logs.console.filter((e) => e.type === 'warning').map((e) => e.text);
    const exceptionTexts = page.logs.exceptions.map((e) => e.text);
    const resourceTexts = page.logs.resourceErrors.map((e) => e.text);

    snapshot.errors = {
      consoleErrors: logs.consoleErrors,
      exceptions: exceptionTexts,
      resourceWarnings: resourceTexts,
    };
    check('JS 例外が発生していない', exceptionTexts.length === 0, exceptionTexts.slice(0, 3).join(' | '));
    check('console.error が発生していない', logs.consoleErrors.length === 0, logs.consoleErrors.slice(0, 3).join(' | '));
    if (resourceTexts.length) {
      // 外部 CDN (tailwind / peerjs) が遮断された環境では取得失敗が resource error として出る。
      // これは JS エラーではないので FAIL にはせず、スナップショットに残して可視化する。
      console.log(`NOTE  network resource error ${resourceTexts.length} 件（外部 CDN 遮断の可能性。失敗扱いにはしない）: ${resourceTexts.slice(0, 2).join(' | ')}`);
    }

    /* ---- 出力 ------------------------------------------------------------ */
    clearTimeout(watchdog);

    const report = {
      tool: 'hexago-cdp-regress',
      schema: 1,
      generatedAt: new Date().toISOString(),
      page: targetUrlForReport(),
      durationMs: Date.now() - startedAt,
      ok: failCount === 0,
      summary: { pass: passCount, fail: failCount, total: passCount + failCount },
      checks: results,
      snapshot,
      observations,
      logs,
      meta: {
        node: process.version,
        chrome: browser.version,
        chromePath: browser.chromePath,
        url: targetUrlForReport(),
      },
    };

    await fsp.mkdir(path.dirname(opts.out), { recursive: true });
    await fsp.writeFile(opts.out, JSON.stringify(report, null, 2) + '\n');

    /* ---- --compare ------------------------------------------------------- */
    if (opts.compare) {
      let baseline = null;
      try {
        baseline = JSON.parse(await fsp.readFile(opts.compare, 'utf8'));
      } catch (err) {
        check(`ベースラインを読める (${opts.compare})`, false, err.message);
      }
      if (baseline) {
        const baseSnap = baseline.snapshot !== undefined ? baseline.snapshot : baseline;
        const diffs = firstDiffs(canonicalize(baseSnap), canonicalize(snapshot));
        if (diffs.length === 0) {
          check(`スナップショットがベースラインと一致 (${path.basename(opts.compare)})`, true, 'identical');
        } else {
          check(`スナップショットがベースラインと一致 (${path.basename(opts.compare)})`, false, diffs.length + ' 件の差分');
          for (const d of diffs) {
            console.log(`DIFF  ${d.path}`);
            console.log(`      baseline: ${JSON.stringify(d.baseline)}`);
            console.log(`      current : ${JSON.stringify(d.current)}`);
          }
        }
        // 比較結果も JSON に残す
        report.compare = {
          baseline: path.relative(REPO, opts.compare),
          identical: diffs.length === 0,
          diffs,
        };
        await fsp.writeFile(opts.out, JSON.stringify(report, null, 2) + '\n');
      }
    }

    console.log('');
    console.log(`SNAPSHOT  ${opts.out}`);
    console.log(`SHOTS     ${shotsDir}`);
    console.log(`RESULT    ${failCount === 0 ? 'PASS' : 'FAIL'}  ${passCount} passed, ${failCount} failed  (${report.durationMs}ms)`);

    await cleanup();
    process.exit(failCount === 0 ? 0 : 1);
  } catch (err) {
    clearTimeout(watchdog);
    failCount++;
    results.push({ name: 'ハーネス実行', ok: false, detail: err && err.message ? err.message : String(err) });
    console.error('');
    console.error('FAIL  ハーネス実行中にエラーが発生しました');
    console.error(err && err.stack ? err.stack : String(err));
    if (page) {
      try {
        const tail = page.logs.exceptions.slice(-3).map((e) => e.text);
        if (tail.length) console.error('  page exceptions: ' + tail.join(' | '));
      } catch (e) {}
    }
    try {
      await fsp.mkdir(path.dirname(opts.out), { recursive: true });
      await fsp.writeFile(
        opts.out,
        JSON.stringify(
          {
            tool: 'hexago-cdp-regress',
            schema: 1,
            generatedAt: new Date().toISOString(),
            page: targetUrlForReport(),
            ok: false,
            error: err && err.message ? err.message : String(err),
            summary: { pass: passCount, fail: failCount, total: passCount + failCount },
            checks: results,
            snapshot,
            observations,
            meta: browser ? { node: process.version, chrome: browser.version } : { node: process.version },
          },
          null,
          2
        ) + '\n'
      );
      console.error(`SNAPSHOT  ${opts.out}`);
    } catch (e) {}
    await cleanup();
    process.exit(1);
  }
}

/* ========================================================================== */
/* 後始末                                                                     */
/* ========================================================================== */

async function cleanup() {
  if (cleaningUp) return;
  cleaningUp = true;
  try {
    if (page) await page.close();
  } catch (e) {}
  try {
    if (browser) await browser.close();
  } catch (e) {}
  try {
    if (server) await server.close();
  } catch (e) {}
}

process.on('exit', () => {
  // 強制終了時も chrome を残さない（非同期の後始末は間に合わないため同期的に kill）
  try {
    if (browser && browser.proc && browser.proc.exitCode === null) browser.proc.kill('SIGKILL');
  } catch (e) {}
});

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
