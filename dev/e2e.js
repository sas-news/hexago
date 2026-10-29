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
  const aiUi = await page.evaluate(() => ({ selector: !!document.querySelector('#aiLevelBtns'), budget: window.__hexagoDebug.state().aiBudget }));
  check('single fixed AI strength (no difficulty selector)', !aiUi.selector, 'aiBudget=' + aiUi.budget);

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
  check('5s search across the worker pool', maxLevel.visits >= 50000 && maxLevel.legal, JSON.stringify(maxLevel));

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

  /* 5b. 4/5/6-player page + engine legality */
  const multi = await page.evaluate(async () => {
    const d = window.__hexagoDebug;
    const out = [];
    for (const pc of [4, 5, 6]) {
      d.setAllHuman();
      document.querySelector('#playerCountBtns [data-count="' + pc + '"]')?.click();
      d.newGame(9);
      const res = await d.think(150);
      const st = d.state();
      out.push({ pc, move: res.move, legal: res.move === -1 ? true : !!d.sim(res.move), pcState: st.playerCount, visits: res.visits });
    }
    return out;
  });
  check('4-6 player page/engine legal moves', multi.every(r => r.legal && r.pcState === r.pc && r.visits > 0), JSON.stringify(multi));

  /* 6. AI vs AI progress + event-loop responsiveness */
  await page.evaluate(() => {
    const d = window.__hexagoDebug;
    document.querySelector('#playerCountBtns [data-count="2"]')?.click();
    d.setAIBudgetMs(150);
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

  /* 7. no page errors */
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
