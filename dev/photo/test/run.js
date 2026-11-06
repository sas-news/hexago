#!/usr/bin/env node
'use strict';
/**
 * dev/photo/test/run.js — 写真→盤面 復元パイプライン用テストランナー（汎用・依存ゼロ）
 *
 * 任意のページを開き、ページ内の `window.__photoTest.run(caseName)` を await して
 * 返ってきた JSON をそのまま stdout に出す。写真パイプラインのテストページ
 * （dev/photo/test/index.html）は Lead が用意する想定で、このランナーは
 * ページの実装に依存しない。
 *
 * 使い方:
 *   node dev/photo/test/run.js                       # 自前サーバで /dev/photo/test/index.html を開く
 *   node dev/photo/test/run.js --case basic
 *   node dev/photo/test/run.js --url http://127.0.0.1:8000/dev/photo/test/index.html --case label
 *   node dev/photo/test/run.js --json | jq .
 *
 * 終了コード: 0 = JSON を取得できた / 1 = ページ・API・実行の失敗
 * stdout は常に純粋な JSON（ログは stderr）。--json は人間向け stderr 出力を抑制する。
 */

const path = require('node:path');
const fs = require('node:fs');

const { Browser } = require('../../cdp/driver');
const { startStaticServer } = require('../../cdp/serve');

const REPO = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_PAGE = 'dev/photo/test/index.html';

function parseArgs(argv) {
  const opts = { url: null, caseName: null, json: false, timeout: 30000, waitApiMs: 15000 };
  const args = argv.slice();
  while (args.length) {
    const a = args.shift();
    switch (a) {
      case '--url': {
        const v = args.shift();
        if (!v) usageError('--url には値が必要です');
        opts.url = v;
        break;
      }
      case '--case': {
        const v = args.shift();
        if (!v) usageError('--case には値が必要です');
        opts.caseName = v;
        break;
      }
      case '--json':
        opts.json = true;
        break;
      case '--timeout': {
        const v = args.shift();
        opts.timeout = Math.max(1000, parseInt(v, 10) || 30000);
        break;
      }
      case '--wait-api': {
        const v = args.shift();
        opts.waitApiMs = Math.max(1000, parseInt(v, 10) || 15000);
        break;
      }
      case '--help':
      case '-h':
        console.log(
          [
            'node dev/photo/test/run.js [options]',
            '',
            '  --url <url>       対象ページ（省略時は自前サーバの /dev/photo/test/index.html）',
            '  --case <name>     window.__photoTest.run(name) に渡すケース名（省略時は引数なし）',
            '  --json            stderr の人間向け出力を抑制（stdout は常に JSON）',
            '  --timeout <ms>    CDP コマンドのタイムアウト (default: 30000)',
            '  --wait-api <ms>   __photoTest の出現待ち (default: 15000)',
            '  -h, --help        このヘルプ',
            '',
            'ページ側の契約:',
            '  window.__photoTest = {',
            '    run: async (caseName) => ({ ... })   // JSON 化できる値を返す',
            '  }',
          ].join('\n')
        );
        process.exit(0);
        break;
      default:
        usageError(`不明な引数: ${a}`);
    }
  }
  return opts;
}

function usageError(message) {
  console.error(`ERROR: ${message}`);
  console.error('使い方は --help を参照してください。');
  process.exit(2);
}

let server = null;
let browser = null;
let page = null;

async function cleanup() {
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

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  let pageUrl = opts.url;

  if (!pageUrl) {
    const pageFile = path.join(REPO, DEFAULT_PAGE);
    if (!fs.existsSync(pageFile)) {
      console.error('ERROR: テストページが見つかりません: ' + path.relative(REPO, pageFile));
      console.error('  dev/photo/test/index.html は Lead（写真パイプライン担当）が用意します。');
      console.error('  今すぐ任意のページで試すには: node dev/photo/test/run.js --url http://...');
      process.exitCode = 1;
      return;
    }
    server = await startStaticServer(REPO);
    pageUrl = server.urlFor('/' + DEFAULT_PAGE);
    if (!opts.json) process.stderr.write(`[photo-test] serving ${REPO} -> ${pageUrl}\n`);
  }

  browser = await Browser.launch({ timeoutMs: opts.timeout });
  page = await browser.newPage({
    viewport: { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false },
    timeoutMs: opts.timeout,
  });

  if (!opts.json) process.stderr.write(`[photo-test] open ${pageUrl}\n`);
  await page.goto(pageUrl, { timeoutMs: opts.timeout });

  try {
    await page.waitForFunction('window.__photoTest && typeof window.__photoTest.run === "function"', {
      timeoutMs: opts.waitApiMs,
      label: 'window.__photoTest.run',
    });
  } catch (err) {
    const info = await page
      .evaluate(() => ({
        title: document.title,
        readyState: document.readyState,
        hasPhotoTest: !!window.__photoTest,
        keys: Object.keys(window.__photoTest || {}),
        bodyText: (document.body ? document.body.innerText : '').replace(/\s+/g, ' ').slice(0, 180),
      }))
      .catch(() => ({}));
    console.error('ERROR: window.__photoTest.run(caseName) が見つかりません。');
    console.error(`  ページ       : ${pageUrl}`);
    console.error(`  タイトル     : ${info.title || ''} (readyState=${info.readyState || '?'})`);
    if (info.hasPhotoTest) console.error(`  __photoTest  : キー=[${(info.keys || []).join(', ')}] (run がない)`);
    else console.error('  __photoTest  : 未定義');
    if (info.bodyText) console.error(`  本文先頭     : ${info.bodyText}`);
    console.error('  ※ 写真テストページは dev/photo/test/index.html として Lead が用意します。');
    console.error('  ※ 任意のページを対象にする場合は --url を指定してください。');
    process.exitCode = 1;
    return;
  }

  const started = Date.now();
  let result;
  try {
    result = await page.evaluate((caseName) => window.__photoTest.run(caseName), opts.caseName === null ? undefined : opts.caseName);
  } catch (err) {
    console.error('ERROR: __photoTest.run() の実行に失敗しました。');
    console.error('  ' + (err && err.message ? err.message : String(err)));
    const pageExceptions = (page.logs.exceptions || []).slice(-3).map((e) => e.text);
    if (pageExceptions.length) console.error('  page exceptions: ' + pageExceptions.join(' | '));
    process.exitCode = 1;
    return;
  }
  const elapsedMs = Date.now() - started;

  if (result === undefined) {
    console.error('ERROR: __photoTest.run() が undefined を返しました（JSON 化できる値を返してください）。');
    process.exitCode = 1;
    return;
  }

  // stdout は常に「返ってきた JSON そのまま」
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (!opts.json) {
    process.stderr.write(`[photo-test] case=${opts.caseName === null ? '(none)' : opts.caseName} ok (${elapsedMs}ms)\n`);
  }
  process.exitCode = 0;
}

process.on('exit', () => {
  try {
    if (browser && browser.proc && browser.proc.exitCode === null) browser.proc.kill('SIGKILL');
  } catch (e) {}
});

main()
  .catch((err) => {
    console.error('ERROR: テストランナーが失敗しました。');
    console.error(err && err.stack ? err.stack : String(err));
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
  });
