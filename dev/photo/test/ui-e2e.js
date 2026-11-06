#!/usr/bin/env node
'use strict';
/**
 * dev/photo/test/ui-e2e.js — 写真復元UIのブラウザE2E（依存ゼロ / CDP）
 *
 *   node dev/photo/test/ui-e2e.js [--shots <dir>] [--keep]
 *
 * 検証:
 *   1. ヘッダの 📷 でモーダルが開き、step1 が表示される
 *   2. 実写真を読み込むと 6隅ハンドル付きの調整画面（step2）になる
 *   3. 読み取り（step3）で 127 点が復元され、クラス数が正しい
 *   4. 局面を保存でき、ライブラリに 1 件入る
 *   5. 「この局面から対局」でゲーム状態が写真の局面に置き換わる
 *   6. デスクトップ / モバイルのスクリーンショットを撮る
 *
 * 終了コード: 0 = 全PASS / 1 = FAIL
 */

const path = require('node:path');
const fs = require('node:fs');
const { Browser, sleep } = require('../../cdp/driver');
const { startStaticServer } = require('../../cdp/serve');

const REPO = path.resolve(__dirname, '..', '..', '..');
const args = process.argv.slice(2);
const shotsDir = (() => {
  const i = args.indexOf('--shots');
  return i >= 0 ? path.resolve(args[i + 1]) : path.join(__dirname, 'shots');
})();
fs.mkdirSync(shotsDir, { recursive: true });

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name + (detail ? '  (' + detail + ')' : '')); }
  else { fail++; failures.push(name); console.log('FAIL  ' + name + (detail ? '  [' + detail + ']' : '')); }
}

(async () => {
  let server = null, browser = null;
  try {
    server = await startStaticServer(REPO);
    browser = await Browser.launch({ timeoutMs: 30000 });
    const page = await browser.newPage({
      viewport: { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false },
      timeoutMs: 30000,
    });
    const errors = [];
    page.on('pageerror', e => errors.push(String((e && e.message) || e)));
    page.on('console', m => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });

    await page.goto(server.urlFor('/index.html'), { timeoutMs: 30000 });
    await page.waitForFunction('window.__hexagoPhoto && typeof window.__hexagoPhoto.open === "function"', {
      timeoutMs: 20000, label: '__hexagoPhoto'
    });
    await sleep(300);

    // 1. モーダルを開く
    await page.evaluate(() => document.getElementById('btnOpenPhoto').click());
    await sleep(200);
    const step1 = await page.evaluate(() => ({
      open: !document.getElementById('photoModal').classList.contains('hidden'),
      step1: !document.getElementById('photoStep1').classList.contains('hidden'),
      hasFile: !!document.getElementById('photoFile'),
    }));
    check('📷ボタンでモーダルが開く', step1.open && step1.step1, JSON.stringify(step1));

    // 2. 実写真を読み込む（テストフック経由。UIの file input と同じ経路）
    const loaded = await page.evaluate(async () => {
      const resp = await fetch('/dev/photo/testdata/IMG_0252.jpg');
      const blob = await resp.blob();
      const bmp = await createImageBitmap(blob);
      const cv = document.createElement('canvas');
      cv.width = bmp.width; cv.height = bmp.height;
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0);
      const id = ctx.getImageData(0, 0, cv.width, cv.height);
      window.__hexagoPhoto.loadImageData(id);
      return { w: cv.width, h: cv.height };
    });
    await sleep(400);
    const step2 = await page.evaluate(() => {
      const s = window.__hexagoPhoto.state();
      return {
        hasImage: s.hasImage,
        step2: !document.getElementById('photoStep2').classList.contains('hidden'),
        corners: s.corners,
        sizeBtns: document.querySelectorAll('#photoSizeBtns [data-size]').length,
        detectInfo: document.getElementById('photoDetectInfo').textContent,
      };
    });
    check('写真読み込みで調整画面(step2)になる', step2.hasImage && step2.step2 && step2.sizeBtns === 4,
      'corners=' + (step2.corners ? step2.corners.length : 0) + ' sizeBtns=' + step2.sizeBtns);
    check('6隅ハンドルが検出されている', Array.isArray(step2.corners) && step2.corners.length === 6,
      JSON.stringify(step2.corners && step2.corners.map(p => [Math.round(p[0]), Math.round(p[1])])));

    // 余白スライダーとサイズ自動判定
    const adjustState = await page.evaluate(async () => {
      await new Promise(r => setTimeout(r, 700));
      const s = window.__hexagoPhoto.state();
      const slider = document.getElementById('photoMargin');
      const label = document.getElementById('photoMarginLabel');
      const fit = document.getElementById('photoFitInfo');
      return {
        margin: s.margin, size: s.size,
        hasSlider: !!slider, sliderValue: slider && slider.value,
        label: label && label.textContent,
        fit: fit && fit.textContent,
        detectInfo: document.getElementById('photoDetectInfo').textContent,
      };
    });
    check('余白スライダーがあり、石に合わせて自動調整される',
      adjustState.hasSlider && adjustState.margin > 0.35 && adjustState.margin <= 1.2 &&
      /自動調整/.test(adjustState.fit || ''),
      JSON.stringify(adjustState));
    check('撮影画像から盤面サイズを自動判定する（13路）', adjustState.size === 13, 'size=' + adjustState.size + ' ' + adjustState.detectInfo);
    // スライダーを動かすと余白が変わる
    const scoreInfo = await page.evaluate(() => {
      const el = document.getElementById('photoFitScore');
      return { text: el && el.textContent, value: el ? parseInt((el.textContent.match(/(\d+)/) || [])[1], 10) : null };
    });
    check('一致度が表示される（自動調整後の値）',
      scoreInfo.value >= 60 && scoreInfo.value <= 100,
      JSON.stringify(scoreInfo));

    const sliderMove = await page.evaluate(async () => {
      const before = document.getElementById('photoFitScore').textContent;
      const slider = document.getElementById('photoMargin');
      slider.value = '0.2';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 400));
      const s = window.__hexagoPhoto.state();
      return {
        margin: s.margin,
        label: document.getElementById('photoMarginLabel').textContent,
        before,
        after: document.getElementById('photoFitScore').textContent,
      };
    });
    check('スライダーで余白を変更でき、一致度も更新される', Math.abs(sliderMove.margin - 0.2) < 1e-6 &&
      sliderMove.after && sliderMove.after !== sliderMove.before,
      JSON.stringify(sliderMove));
    // 自動調整値に戻す（スライダー操作の影響を消す）
    await page.evaluate((m) => {
      const slider = document.getElementById('photoMargin');
      slider.value = String(m);
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    }, adjustState.margin);

    // 3. 読み取り
    const readMs = await page.evaluate(async () => {
      const t0 = performance.now();
      window.__hexagoPhoto.read();
      for (let i = 0; i < 200; i++) {
        await new Promise(r => setTimeout(r, 50));
        if (window.__hexagoPhoto.state().result) return performance.now() - t0;
      }
      throw new Error('read timeout');
    });
    const step3 = await page.evaluate(() => {
      const s = window.__hexagoPhoto.state();
      const labels = s.labels || [];
      const counts = [0, 0, 0, 0, 0, 0, 0, 0];
      labels.forEach(c => counts[c]++);
      return {
        result: s.result,
        step3: !document.getElementById('photoStep3').classList.contains('hidden'),
        labels: labels.length,
        counts,
        countText: document.getElementById('photoCounts').textContent.trim(),
      };
    });
    check('読み取りで 127 点が復元される', step3.result && step3.labels === 127 && step3.step3,
      'labels=' + step3.labels + ' ' + Math.round(readMs) + 'ms');
    // 自動検出の幾何誤差で境界の数点が揺れるため、完全一致ではなく ±3 点以内を要求する
    check('石数が写真とほぼ一致する（空44/黒28/白28/青27 ±3）',
      Math.abs(step3.counts[0] - 44) <= 3 && Math.abs(step3.counts[1] - 28) <= 3 &&
      Math.abs(step3.counts[2] - 28) <= 3 && Math.abs(step3.counts[4] - 27) <= 3,
      JSON.stringify(step3.counts));
    await page.screenshot(path.join(shotsDir, 'photo-step3-desktop.png'));

    // 3b. 人数の推定と色の制限
    const paletteInfo = await page.evaluate(() => {
      const s = window.__hexagoPhoto.state();
      return { palette: s.palette, playerCount: s.playerCount, allowed: s.allowed, allColors: s.allColors };
    });
    check('検出した色数から人数を推定する（黒・白・青の3人）',
      Array.isArray(paletteInfo.palette) && paletteInfo.palette.length === 3 && paletteInfo.playerCount === 3,
      JSON.stringify(paletteInfo));

    // 存在し得ない色は巡回に出ない（全色モードOFF）
    const cycleLimited = await page.evaluate(() => {
      const before = window.__hexagoPhoto.state();
      const idx = before.labels.findIndex(c => c === 0);
      const seen = [];
      for (let k = 0; k < 6; k++) {
        const st = window.__hexagoPhoto.cycle(idx);
        seen.push(st.labels[idx]);
      }
      return { seen, allowed: before.allowed };
    });
    const allowedSet = new Set([0, ...paletteInfo.allowed]);
    check('タップ巡回は参加中の色だけ（存在し得ない色が出ない）',
      cycleLimited.seen.every(c => allowedSet.has(c)),
      JSON.stringify(cycleLimited));

    // 全色モードONで未使用色も巡回に現れる
    const cycleAll = await page.evaluate(() => {
      window.__hexagoPhoto.setAllColors(true);
      const before = window.__hexagoPhoto.state();
      const idx = before.labels.findIndex(c => c === 0);
      const seen = [];
      for (let k = 0; k < 10; k++) {
        const st = window.__hexagoPhoto.cycle(idx);
        seen.push(st.labels[idx]);
      }
      const after = window.__hexagoPhoto.state();
      window.__hexagoPhoto.setAllColors(false);
      return { seen, allowed: before.allowed, paletteAfter: after.palette };
    });
    check('全色モードでは未使用色も選べる（選ぶとプレイヤーに追加）',
      cycleAll.seen.some(c => c >= 3) && cycleAll.paletteAfter.length >= 3,
      JSON.stringify(cycleAll));

    // 人数を4人に変更すると色が補充される
    const fourPlayers = await page.evaluate(() => {
      const st = window.__hexagoPhoto.setPlayerCount(4);
      const back = window.__hexagoPhoto.setPlayerCount(3);
      return { four: { palette: st.palette, count: st.playerCount, allowed: st.allowed }, back: { palette: back.palette, count: back.playerCount } };
    });
    check('人数を増やすと色が補充され、減らすと戻る',
      fourPlayers.four.count === 4 && fourPlayers.four.palette.length === 4 &&
      fourPlayers.back.count === 3,
      JSON.stringify(fourPlayers));

    // 4. 保存
    const saved = await page.evaluate(() => {
      window.__hexagoPhoto.save();
      const list = window.__hexagoPhoto.list();
      return { n: list.length, size: list[0] && list[0].size, pc: list[0] && list[0].playerCount, board: list[0] && list[0].board.length, palette: list[0] && list[0].meta && list[0].meta.palette };
    });
    check('局面を保存できる', saved.n === 1 && saved.size === 13 && saved.board === 127 && saved.pc === 3, JSON.stringify(saved));

    // 5. この局面から対局
    const applied = await page.evaluate(async () => {
      window.__hexagoPhoto.play();
      await new Promise(r => setTimeout(r, 200));
      const st = window.__hexagoDebug.state();
      const counts = [0, 0, 0, 0, 0, 0, 0];
      st.board.forEach(v => { if (v) counts[v]++; });
      return {
        size: st.size,
        boardLen: st.board.length,
        stones: counts.slice(1),
        turn: st.turn,
        modalClosed: document.getElementById('photoModal').classList.contains('hidden'),
        playerFill1: window.playerFill ? window.playerFill(1) : null,
        pc: st.playerCount,
      };
    });
    const totalStones = applied.stones.reduce((a, b) => a + b, 0);
    check('「この局面から対局」でゲームに反映される',
      applied.size === 13 && applied.boardLen === 127 && applied.modalClosed &&
      Math.abs(totalStones - 83) <= 4 && applied.stones[0] >= 25 && applied.stones[1] >= 25,
      JSON.stringify(applied) + ' totalStones=' + totalStones);
    check('写真の石色がプレイヤー色として使われる', applied.playerFill1 === '#1a1a1a' || applied.playerFill1 === '#111111',
      'playerFill(1)=' + applied.playerFill1);
    await page.screenshot(path.join(shotsDir, 'photo-game-desktop.png'));

    // 見た目が大きく崩れていない（横スクロールなし）
    const layout = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      boardCanvas: (() => { const c = document.getElementById('cv'); const r = c.getBoundingClientRect(); return { w: r.width, h: r.height }; })(),
    }));
    check('対局画面のレイアウトが破綻しない', layout.scrollWidth <= layout.innerWidth + 1 && layout.boardCanvas.w > 100,
      JSON.stringify(layout));

    // 6. モバイルでモーダル
    const mobile = await browser.newPage({
      viewport: { width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
      timeoutMs: 30000,
    });
    await mobile.goto(server.urlFor('/index.html'), { timeoutMs: 30000 });
    await mobile.waitForFunction('window.__hexagoPhoto && typeof window.__hexagoPhoto.open === "function"', { timeoutMs: 20000 });
    await sleep(300);
    await mobile.evaluate(() => document.getElementById('btnOpenPhoto').click());
    await sleep(300);
    const mobileState = await mobile.evaluate(() => {
      const m = document.getElementById('photoModal');
      const inner = m && m.firstElementChild;
      return {
        open: m ? !m.classList.contains('hidden') : false,
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        modalWidth: inner ? inner.getBoundingClientRect().width : 0,
      };
    });
    check('モバイル(390px)でモーダルが画面内に収まる',
      mobileState.open && mobileState.scrollWidth <= mobileState.innerWidth + 1 && mobileState.modalWidth <= 390,
      JSON.stringify(mobileState));
    await mobile.screenshot(path.join(shotsDir, 'photo-step1-mobile.png'));

    // 7. iPad サイズ（縦・横）でモーダル全体が見える
    for (const vp of [
      { name: 'iPad縦 768x1024', width: 768, height: 1024 },
      { name: 'iPad横 1024x768', width: 1024, height: 768 },
    ]) {
      const ipad = await browser.newPage({
        viewport: { width: vp.width, height: vp.height, deviceScaleFactor: 2, mobile: true },
        timeoutMs: 30000,
      });
      await ipad.goto(server.urlFor('/index.html'), { timeoutMs: 30000 });
      await ipad.waitForFunction('window.__hexagoPhoto && typeof window.__hexagoPhoto.open === "function"', { timeoutMs: 20000 });
      await sleep(250);
      const res = await ipad.evaluate(async (size) => {
        document.getElementById('btnOpenPhoto').click();
        const resp = await fetch('/dev/photo/testdata/IMG_0252.jpg');
        const bmp = await createImageBitmap(await resp.blob());
        const cv = document.createElement('canvas'); cv.width = bmp.width; cv.height = bmp.height;
        const ctx = cv.getContext('2d', { willReadFrequently: true }); ctx.drawImage(bmp, 0, 0);
        window.__hexagoPhoto.loadImageData(ctx.getImageData(0, 0, cv.width, cv.height));
        await new Promise(r => setTimeout(r, 900));
        // step2 のレイアウト検査
        const card = document.getElementById('photoCard');
        const btn = document.getElementById('btnPhotoRead');
        const r = btn.getBoundingClientRect();
        const canvas = document.getElementById('photoAdjust');
        const cr = canvas.getBoundingClientRect();
        return {
          step2: !document.getElementById('photoStep2').classList.contains('hidden'),
          cardFits: card.scrollHeight <= card.clientHeight + 2,
          buttonVisible: r.bottom <= window.innerHeight + 1 && r.top >= -1,
          canvasHeight: +cr.height.toFixed(0),
          viewport: { w: window.innerWidth, h: window.innerHeight },
          size: window.__hexagoPhoto.state().size,
          margin: window.__hexagoPhoto.state().margin,
        };
      }, vp);
      check(vp.name + ' で調整画面が画面内に収まる',
        res.step2 && res.buttonVisible && res.canvasHeight <= res.viewport.h * 0.55,
        JSON.stringify(res));
      await ipad.screenshot(path.join(shotsDir, 'photo-step2-' + vp.width + 'x' + vp.height + '.png'));
      // 読み取り → step3 も確認
      const res3 = await ipad.evaluate(async () => {
        window.__hexagoPhoto.read();
        for (let i = 0; i < 100; i++) {
          await new Promise(r => setTimeout(r, 50));
          if (window.__hexagoPhoto.state().result) break;
        }
        await new Promise(r => setTimeout(r, 200));
        const card = document.getElementById('photoCard');
        const btn = document.getElementById('btnPhotoPlay');
        const r = btn.getBoundingClientRect();
        return {
          result: window.__hexagoPhoto.state().result,
          cardFits: card.scrollHeight <= card.clientHeight + 2,
          buttonVisible: r.bottom <= window.innerHeight + 1,
          labels: (window.__hexagoPhoto.state().labels || []).length,
        };
      });
      check(vp.name + ' で読み取り結果と操作ボタンが画面内に収まる',
        res3.result && res3.buttonVisible,
        JSON.stringify(res3));
      await ipad.screenshot(path.join(shotsDir, 'photo-step3-' + vp.width + 'x' + vp.height + '.png'));
      await ipad.close();
    }

    // JS 例外
    check('JS 例外が発生していない', errors.length === 0, errors.slice(0, 3).join(' | '));

    console.log('\nRESULT  ' + pass + ' passed, ' + fail + ' failed');
    console.log('SHOTS   ' + shotsDir);
    process.exitCode = fail ? 1 : 0;
  } catch (e) {
    console.error('ERROR  ' + ((e && e.stack) || e));
    process.exitCode = 1;
  } finally {
    try { if (browser) await browser.close(); } catch (e) { /* ignore */ }
    try { if (server) await server.close(); } catch (e) { /* ignore */ }
  }
})();
