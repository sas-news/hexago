#!/usr/bin/env node
'use strict';
/**
 * probe-run.js — 写真パイプラインのプローブを headless Chrome で実行する小さなランナー。
 *
 *   node dev/photo/probe-run.js [page] [--full]
 *
 * - リポジトリを静的配信する HTTP サーバをこのプロセス内で立てる（/tmp が消える環境でも動く）
 * - chrome-headless-shell を --dump-dom で起動し、<pre id="out"> の中の JSON を取り出す
 * - 既定ではサマリだけ表示。--full で JSON 全体
 *
 * 依存ゼロ（Node標準のみ）。テストの本番ランナーは dev/cdp / dev/photo/test 側を使う。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const CHROME = process.env.CHROME_BIN ||
  '/home/sasnews/.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

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
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

(async () => {
  const args = process.argv.slice(2);
  const page = args.find(a => !a.startsWith('--')) || 'dev/photo/probe.html';
  const full = args.includes('--full');
  const server = await serve();
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/${page}`;
  const runtimeDir = path.join(__dirname, '.probe-chrome');
  fs.mkdirSync(runtimeDir, { recursive: true });
  const res = spawnSync(CHROME, [
    '--headless', '--no-sandbox', '--disable-gpu',
    '--disable-dev-shm-usage', '--hide-scrollbars',
    '--user-data-dir=' + runtimeDir,
    '--virtual-time-budget=45000',
    '--dump-dom', url,
  ], { encoding: 'utf8', timeout: 120000, maxBuffer: 128 * 1024 * 1024 });
  server.close();
  const out = res.stdout || '';
  if (!out) {
    console.error('chrome produced no output.\nstderr:', (res.stderr || '').slice(-2000));
    process.exit(1);
  }
  const m = /<pre id="out">([\s\S]*?)<\/pre>/.exec(out);
  if (!m) {
    console.error('no <pre id="out"> in dom (page did not finish boot?)');
    const err = /<title>([^<]*)<\/title>/.exec(out);
    console.error('title:', err && err[1]);
    process.exit(1);
  }
  let data;
  try { data = JSON.parse(m[1]); } catch (e) {
    console.error('JSON parse failed:', e.message);
    console.error(m[1].slice(0, 3000));
    process.exit(1);
  }
  if (full) {
    console.log(JSON.stringify(data, null, 1));
    return;
  }
  // 既定サマリ: probe.html 向け
  if (data.error) { console.error(data.error); process.exit(1); }
  console.log(JSON.stringify(data, null, 1));
})().catch(e => { console.error(e); process.exit(1); });
