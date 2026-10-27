#!/usr/bin/env node
'use strict';
/**
 * Browser E2E verification for the inlined MCTS AI.
 *
 *   node dev/e2e.js [--headed] [--url http://...]
 *
 * Checks:
 *  1. page loads with no JS errors; engine source is embedded
 *  2. the AI worker path is actually used (not the legacy fallback)
 *  3. AI moves returned through the page are legal for the current position
 *  4. a self-play game makes progress (AI vs AI, several moves)
 *  5. the UI event loop stays responsive while the worker searches
 *  6. 13/19/25 board sizes return legal moves
 *  7. 3-player mode returns legal moves
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
function loadPlaywright() {
  const tries = [];
  if (process.env.PLAYWRIGHT_MODULE) tries.push(process.env.PLAYWRIGHT_MODULE);
  tries.push('playwright');
  for (const name of tries) {
    try { return require(name); } catch (e) { /* try next */ }
  }
  console.error('dev/e2e.js needs Playwright: npm i -D playwright && npx playwright install chromium');
  console.error('(or set PLAYWRIGHT_MODULE=/path/to/playwright)');
  process.exit(0);
}
const { chromium } = loadPlaywright();

const REPO = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const HEADED = args.includes('--headed');
const urlArg = args.indexOf('--url');
const EXTERNAL_URL = urlArg >= 0 ? args[urlArg + 1] : null;
const PORT = 8972;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.png': 'image/png' };

function serve() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      const file = path.join(REPO, urlPath === '/' ? 'index.html' : urlPath);
      if (!file.startsWith(REPO)) { res.writeHead(403); res.end(); return; }
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
        res.end(data);
      });
    });
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name + (detail ? '  (' + detail + ')' : '')); }
  else { fail++; failures.push(name); console.log('FAIL  ' + name + (detail ? '  (' + detail + ')' : '')); }
}

(async () => {
  const server = EXTERNAL_URL ? null : await serve();
  const browser = await chromium.launch({ headless: !HEADED });
  const page = await browser.newPage({ viewport: { width: 900, height: 1150 } });
  const errors = [], warnings = [];
  page.on('pageerror', e => errors.push(String(e && e.message || e)));
  page.on('console', m => { if (m.type() === 'error') errors.push('[console] ' + m.text()); if (m.type() === 'warning') warnings.push(m.text()); });

  const url = EXTERNAL_URL || `http://127.0.0.1:${PORT}/index.html`;
  await page.goto(url, { waitUntil: 'load', timeout: 45000 });
  await page.waitForFunction(() => !!window.__hexagoDebug, null, { timeout: 15000 });
  await page.evaluate(() => { const m = document.getElementById('setModal'); if (m) m.classList.add('hidden'); });
  await page.waitForTimeout(500);

  /* 1. engine source + worker */
  const eng = await page.evaluate(() => window.__hexagoDebug.engine());
  check('engine source embedded', eng.sourceLength > 20000, eng.sourceLength + ' bytes');
  check('initial engine error empty', !eng.error, JSON.stringify(eng.error));

  /* 2. page API sanity */
  const st0 = await page.evaluate(() => window.__hexagoDebug.state());
  check('page state sane', st0 && st0.size === 9 && Array.isArray(st0.board) && st0.board.length === 61, 'size=' + (st0 && st0.size));
  check('default AI level is strongest', st0 && st0.aiLevel === 'max', 'aiLevel=' + (st0 && st0.aiLevel));

  /* 2b. modal UX: backdrop click, Escape, result close button */
  const modalOpen = async id => page.evaluate(mid => !document.getElementById(mid).classList.contains('hidden'), id);
  await page.evaluate(() => document.getElementById('btnOpenSettings').click());
  const settingsOpened = await modalOpen('setModal');
  await page.mouse.click(10, 600);
  await page.waitForTimeout(120);
  const settingsAfterBackdrop = await modalOpen('setModal');
  check('settings modal closes on backdrop click', settingsOpened && !settingsAfterBackdrop, 'open=' + settingsOpened + ' after=' + settingsAfterBackdrop);
  await page.evaluate(() => document.getElementById('btnOpenSettings').click());
  await page.keyboard.press('Escape');
  await page.waitForTimeout(120);
  const settingsAfterEsc = await modalOpen('setModal');
  check('settings modal closes on Escape', !settingsAfterEsc);
  const resultClose = await page.evaluate(() => {
    document.getElementById('resModal').classList.remove('hidden');
    const btn = document.getElementById('btnCloseResult');
    if (btn) btn.click();
    return { hasButton: !!btn, hiddenAfter: document.getElementById('resModal').classList.contains('hidden') };
  });
  check('result modal has a working close button', resultClose.hasButton && resultClose.hiddenAfter, JSON.stringify(resultClose));

  /* 2c. resign requires a second tap (no accidental resignation) */
  const resignCheck = await page.evaluate(async () => {
    const d = window.__hexagoDebug;
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    d.setAllHuman();
    document.querySelector('#playerCountBtns [data-count="2"]')?.click();
    d.newGame(9);
    await sleep(80);
    const btn = document.getElementById('btnResign');
    btn.click();
    const armedText = btn.textContent;
    const overAfterFirst = d.state().over;
    btn.click();
    await sleep(120);
    const overAfterSecond = d.state().over;
    document.getElementById('resModal').classList.add('hidden');
    return { armedText: armedText.trim(), overAfterFirst, overAfterSecond };
  });
  check('resign needs a second confirmation tap', /本当に投了/.test(resignCheck.armedText) && resignCheck.overAfterFirst === false && resignCheck.overAfterSecond === true, JSON.stringify(resignCheck));

  /* 3. manual think through worker: legal moves, board untouched */
  await page.evaluate(() => {
    window.__hexagoDebug.setAllHuman();
    window.__hexagoDebug.newGame(9);
    document.querySelector('#playerCountBtns [data-count="2"]')?.click();
    window.__hexagoDebug.newGame(9);
  });
  await page.waitForTimeout(300);
  const manual = await page.evaluate(async () => {
    const d = window.__hexagoDebug;
    const results = [];
    for (let k = 0; k < 8; k++) {
      const before = d.state().board.slice();
      const res = await d.think(120);
      const st = d.state();
      const mutated = st.board.some((v, i) => v !== before[i]);
      const mv = res && res.move;
      const legal = mv === -1 ? true : !!d.sim(mv);
      results.push({ move: mv, legal, mutated, visits: res && res.visits, worker: d.engine().worker });
      if (mv >= 0 && legal) d.playMove(mv);
      await new Promise(r => setTimeout(r, 20));
    }
    return results;
  });
  const allLegal = manual.every(r => r.legal);
  check('8 worker think() results legal', allLegal, manual.map(r => r.move).join(','));
  check('think() does not mutate board', manual.every(r => !r.mutated));
  check('worker path active (not fallback)', manual.every(r => r.worker === true), 'worker=' + manual.map(r => r.worker).join(','));
  check('search produces visits', manual.every(r => r.visits > 0), manual.map(r => r.visits).join(','));
  const pool = await page.evaluate(() => window.__hexagoDebug.engine());
  check('parallel worker pool >= 2 on this 8-core host', pool.workers >= 2, 'workers=' + pool.workers + '/' + pool.wantWorkers);

  // max level: 4 workers x 5s, merged root statistics
  const maxLevel = await page.evaluate(async () => {
    const d = window.__hexagoDebug;
    d.setAllHuman();
    d.newGame(9);
    const res = await d.think(5000);
    return { visits: res.visits, ms: Math.round(res.elapsedMs), move: res.move, legal: res.move === -1 ? true : !!d.sim(res.move), workers: d.engine().workers };
  });
  check('max level: 5s search across 4 workers', maxLevel.visits >= 50000 && maxLevel.legal, JSON.stringify(maxLevel));

  /* 4. sizes 13/19/25 */
  for (const size of [13, 19, 25]) {
    const r = await page.evaluate(async s => {
      const d = window.__hexagoDebug;
      d.setAllHuman();
      d.newGame(s);
      await new Promise(r => setTimeout(r, 10));
      const res = await d.think(150);
      const legal = res.move === -1 ? true : !!d.sim(res.move);
      return { size: s, move: res.move, legal, visits: res.visits, worker: d.engine().worker, boardLen: d.state().board.length };
    }, size);
    check('size ' + size + ' legal move', r.legal && r.visits > 0, JSON.stringify(r));
  }

  /* 5. 3-player mode */
  const three = await page.evaluate(async () => {
    const d = window.__hexagoDebug;
    d.setAllHuman();
    document.querySelector('#playerCountBtns [data-count="3"]')?.click();
    d.newGame(9);
    const res = await d.think(150);
    return { move: res.move, legal: res.move === -1 ? true : !!d.sim(res.move), pc: d.state().playerCount, visits: res.visits };
  });
  check('3-player legal move', three.legal && three.pc === 3, JSON.stringify(three));

  /* 6. AI vs AI progress + event-loop responsiveness */
  await page.evaluate(() => {
    const d = window.__hexagoDebug;
    document.querySelector('#playerCountBtns [data-count="2"]')?.click();
    document.querySelector('#aiLevelBtns [data-ai="weak"]')?.click();
    d.setAllAI();
    d.newGame(9);
    // rAF lag probe while the worker searches
    window.__lag = { max: 0, n: 0, last: 0 };
    const tick = t => {
      if (window.__lag.last) {
        const d2 = t - window.__lag.last;
        if (d2 > window.__lag.max) window.__lag.max = d2;
        window.__lag.n++;
      }
      window.__lag.last = t;
      window.__lag.raf = requestAnimationFrame(tick);
    };
    window.__lag.raf = requestAnimationFrame(tick);
  });
  const t0 = Date.now();
  let st = null;
  while (Date.now() - t0 < 25000) {
    st = await page.evaluate(() => window.__hexagoDebug.state());
    const stones = st.board.filter(Boolean).length;
    if (stones >= 8 || st.over) break;
    await page.waitForTimeout(250);
  }
  const lag = await page.evaluate(() => ({ max: window.__lag.max, n: window.__lag.n }));
  const stones = st.board.filter(Boolean).length;
  check('AI vs AI game progresses', stones >= 4, 'stones=' + stones + ' turn=' + st.turn);
  check('UI stays responsive during search', lag.max < 250, 'max frame gap=' + Math.round(lag.max) + 'ms over ' + lag.n + ' frames');

  /* 7. mid-game human <-> AI switching (both directions) */
  const seatSwitch = await page.evaluate(async () => {
    const d = window.__hexagoDebug;
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const quickSeat = seat => document.querySelector('#quickSeats [data-seat-toggle="' + seat + '"]');
    const legalMove = () => { for (let i = 0; i < d.state().board.length; i++) if (!d.state().board[i] && d.sim(i)) return i; return -1; };
    d.setAllHuman();
    document.querySelector('#playerCountBtns [data-count="2"]')?.click();
    document.querySelector('#aiLevelBtns [data-ai="weak"]')?.click();
    d.newGame(9);
    await sleep(100);
    const out = {};
    // human p1 moves -> p2 turn
    out.p1 = d.playMove(30);
    await sleep(100);
    out.turnAfterP1 = d.state().turn;
    out.p2HumanBefore = d.mine();
    out.quickVisible = !document.getElementById('quickSeats').classList.contains('hidden');
    out.quickButtons = document.querySelectorAll('#quickSeats [data-seat-toggle]').length;
    // p2 human -> AI mid-game via the in-game quick toggle
    quickSeat(2).click();
    await sleep(50);
    out.aiSeat2 = d.seats()[2] === 'ai';
    out.p2AIMine = d.mine();
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && d.state().board.filter(Boolean).length < 2) await sleep(100);
    out.stonesAfterAI = d.state().board.filter(Boolean).length;
    out.turnAfterAI = d.state().turn;
    // AI -> human mid-game via the same quick toggle
    quickSeat(2).click();
    await sleep(100);
    out.humanSeat2Again = d.seats()[2] === 'human';
    out.turnNowMine = d.mine();
    // p1 human moves, then p2 human must be able to move
    const m1 = legalMove(); out.p1Second = m1 >= 0 ? d.playMove(m1) : false;
    await sleep(100);
    out.p2HumanMine = d.mine();
    const m2 = legalMove();
    out.p2HumanMove = m2 >= 0 ? d.playMove(m2) : false;
    out.stonesAfterHuman = d.state().board.filter(Boolean).length;
    return out;
  });
  check('quick seat toggles are visible in game', seatSwitch.quickVisible === true && seatSwitch.quickButtons === 2, 'buttons=' + seatSwitch.quickButtons);
  check('mid-game human -> AI switch makes AI play', seatSwitch.aiSeat2 && seatSwitch.p2AIMine === false && seatSwitch.stonesAfterAI >= 2 && seatSwitch.turnAfterAI === 1, JSON.stringify(seatSwitch));
  check('mid-game AI -> human switch gives control back', seatSwitch.humanSeat2Again && seatSwitch.turnNowMine === true && seatSwitch.p1Second && seatSwitch.p2HumanMine === true && seatSwitch.p2HumanMove === true, 'stones=' + seatSwitch.stonesAfterHuman);

  /* 8. AI -> human while the AI is still thinking: search must be discarded */
  const cancelSwitch = await page.evaluate(async () => {
    const d = window.__hexagoDebug;
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const quickSeat = seat => document.querySelector('#quickSeats [data-seat-toggle="' + seat + '"]');
    d.setAllHuman();
    d.newGame(9);
    await sleep(100);
    d.playMove(30);              // p2 turn, human
    await sleep(50);
    quickSeat(2).click();        // start AI search (weak = 0.5s + 120ms delay)
    await sleep(30);
    quickSeat(2).click();        // take the seat back mid-search
    await sleep(1500);
    const st = d.state();
    return { stones: st.board.filter(Boolean).length, turn: st.turn, seat2: st.seats[2], aiBusy: st.aiBusy, mine: d.mine() };
  });
  check('AI -> human during search discards the AI move', cancelSwitch.stones === 1 && cancelSwitch.turn === 2 && cancelSwitch.seat2 === 'human' && cancelSwitch.aiBusy === false && cancelSwitch.mine === true, JSON.stringify(cancelSwitch));

  /* 9. no page errors */
  const relevantErrors = errors.filter(e => !/tailwindcss\.com should not be used in production|ERR_|Failed to load resource/i.test(e));
  check('no page/console errors', relevantErrors.length === 0, relevantErrors.slice(0, 3).join(' | ') || 'none');

  await page.evaluate(() => { const b = document.getElementById('bnResult'); if (b) b.classList.add('hidden'); });
  await page.screenshot({ path: path.join(REPO, 'dev', 'e2e.png'), fullPage: false });

  console.log('\n----------------------------------------');
  console.log((fail === 0 ? 'E2E ALL PASS' : 'E2E FAILURES') + ': ' + pass + ' passed, ' + fail + ' failed');
  console.log('----------------------------------------');
  if (fail) console.log('failed: ' + failures.join('; '));

  await browser.close();
  if (server) server.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('E2E CRASHED:', e); process.exit(2); });
