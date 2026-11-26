#!/usr/bin/env node
'use strict';
/**
 * アイコン PNG / ICO を再生成する。
 *   1) favicon.svg      … ブラウザタブ用(角丸・透過あり)
 *   2) favicon-ios.svg  … iOS ホーム画面用(透過なし・角丸なし。iOS が角丸を付ける)
 * から各サイズの PNG を作り、小サイズから favicon.ico を作る。
 *
 *   事前準備: npm i -D playwright && npx playwright install chromium
 *   node dev/make-icon-png.js
 */
const fs = require('fs');
const path = require('path');
const repo = path.resolve(__dirname, '..');

let chromium;
try { ({ chromium } = require('playwright')); }
catch (e) { console.error('playwright が必要です: npm i -D playwright'); process.exit(1); }

const stdSvg = fs.readFileSync(path.join(repo, 'favicon.svg'), 'utf8');
const iosSvg = fs.readFileSync(path.join(repo, 'favicon-ios.svg'), 'utf8');

async function render(browser, svg, size, outFile, opaque) {
  const ctx = await browser.newContext({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const bg = opaque ? '#d9b382' : 'transparent';
  const scaled = svg.replace('width="200" height="200"', `width="${size}" height="${size}"`);
  await page.setContent(`<html><body style="margin:0;background:${bg}">${scaled}</body></html>`);
  await page.waitForTimeout(100);
  const png = await page.screenshot({ omitBackground: !opaque, clip: { x: 0, y: 0, width: size, height: size } });
  fs.writeFileSync(path.join(repo, outFile), png);
  console.log('  ' + outFile, png.length + ' bytes');
  await ctx.close();
}

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    console.log('ブラウザタブ用(透過あり):');
    await render(browser, stdSvg, 192, 'favicon-192.png', false);
    await render(browser, stdSvg, 512, 'favicon-512.png', false);
    for (const s of [16, 32, 48]) await render(browser, stdSvg, s, `.ico-${s}.png`, false);
    console.log('iOS ホーム画面用(透過なし・角丸なし):');
    await render(browser, iosSvg, 180, 'favicon-180.png', true);
  } finally {
    await browser.close();
  }
  console.log('favicon.ico を生成中...');
  require('child_process').execFileSync(process.execPath, [path.join(__dirname, 'make-ico.js')], { stdio: 'inherit' });
})();
