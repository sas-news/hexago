#!/usr/bin/env node
/**
 * エージェント向けの仕様ファイルを生成する。
 *
 *   node dev/agent-spec.js          # agent.json / agent.html / llms.txt を生成
 *   node dev/agent-spec.js --check  # 生成物が最新でなければ exit 1
 *
 * 仕様の単一の真実は js/ui/debug.js の window.__hexagoAgent.help()。
 * ここではその定義(オブジェクトリテラル)を静的に読み取って展開する。
 * (ブラウザを起動せずに生成できるよう、help() の戻り値を eval しない)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const repo = path.resolve(__dirname, '..');
const debugPath = path.join(repo, 'js', 'ui', 'debug.js');

// debug.js から help() の戻り値を取り出す。
// 依存の無い純粋なオブジェクトリテラルなので、サンドボックス内で評価して取得する。
function loadSpec() {
  const src = fs.readFileSync(debugPath, 'utf8');
  // help() の中身は「{ ... }」のオブジェクトリテラル。波括弧の対応を数えて切り出す。
  const start = src.indexOf('Agent.help = () => (');
  if (start < 0) throw new Error('js/ui/debug.js から Agent.help の定義を見つけられませんでした');
  const openAt = src.indexOf('{', start);
  let depth = 0, endAt = -1;
  for (let i = openAt; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { endAt = i; break; } }
  }
  if (endAt < 0) throw new Error('Agent.help のオブジェクトリテラルが閉じていません');
  const sandbox = { window: {}, document: {}, console };
  vm.createContext(sandbox);
  const value = vm.runInContext('(' + src.slice(openAt, endAt + 1) + ')', sandbox);
  value.generatedAt = null; // ビルド時刻は入れない(差分を安定させる)
  return value;
}

function buildJson(spec) {
  return JSON.stringify(spec, null, 2) + '\n';
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildHtml(spec) {
  const rows = spec.apis.map(a => {
    const args = (a.args || []).length ? a.args.map(x => '`' + x + '`').join(', ') : '—';
    return `      <tr><td><code>${esc(a.name)}</code></td><td>${args}</td><td><code>${esc(a.returns)}</code></td><td>${esc(a.desc)}</td></tr>`;
  }).join('\n');
  const usage = spec.usage.map(u => `      <li>${esc(u)}</li>`).join('\n');
  const notes = spec.notes.map(n => `      <li>${esc(n)}</li>`).join('\n');
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(spec.name)} — エージェント向けAPI</title>
<style>
body{font-family:system-ui,-apple-system,"Hiragino Sans",sans-serif;max-width:900px;margin:0 auto;padding:24px 16px 64px;line-height:1.7;color:#171717;background:#fff}
h1{font-size:26px;margin:0 0 4px}
h2{font-size:18px;margin:28px 0 8px;padding-bottom:4px;border-bottom:1px solid #e5e5e5}
p.lead{color:#555;margin:0 0 20px}
table{border-collapse:collapse;width:100%;font-size:13px;margin:8px 0 4px}
th,td{border:1px solid #e5e5e5;padding:6px 8px;text-align:left;vertical-align:top}
th{background:#fafafa;font-weight:700;white-space:nowrap}
td:first-child{white-space:nowrap}
code{background:#f4f4f4;padding:1px 5px;border-radius:4px;font-size:12px}
pre{background:#171717;color:#f5f5f5;padding:14px 16px;border-radius:10px;overflow-x:auto;font-size:12px;line-height:1.6}
ul{padding-left:1.3em;margin:8px 0}
a{color:#15803d}
.badge{display:inline-block;background:#15803d;color:#fff;border-radius:999px;padding:1px 10px;font-size:12px;font-weight:700;vertical-align:2px}
</style>
</head>
<body>
<h1>${esc(spec.name)} <span class="badge">agent API</span></h1>
<p class="lead">${esc(spec.description)}</p>

<h2>使い方の流れ</h2>
<ul>
${usage}
</ul>

<h2>API一覧</h2>
<table>
  <thead><tr><th>API</th><th>引数</th><th>戻り値</th><th>説明</th></tr></thead>
  <tbody>
${rows}
  </tbody>
</table>

<h2>サンプル（Playwright / Node）</h2>
<pre>const { chromium } = require('playwright');

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('https://sas-news.github.io/hexago/');
await page.waitForFunction(() => !!window.__hexagoAgent);

// AIと対戦する（1P=人間, 2P=AI）
await page.evaluate(() => {
  const a = window.__hexagoAgent;
  a.setPlayerCount(2);
  a.setSeats(['human', 'ai']);
  a.newGame();
});

// 自分の手番がくるまで繰り返す
for (let turn = 0; turn < 100; turn++) {
  const state = await page.evaluate(() => window.__hexagoAgent.state());
  if (state.over) break;
  if (state.aiBusy) { await page.evaluate(() => window.__hexagoAgent.awaitAI(30000)); continue; }

  const moves = await page.evaluate(() => window.__hexagoAgent.legalMoves());
  if (!moves.length) { await page.evaluate(() => window.__hexagoAgent.pass()); continue; }

  // 取れる石が多い手を選ぶ（お好みで戦略を変えてください）
  const best = moves.reduce((x, y) => (y.captures > x.captures ? y : x), moves[0]);
  await page.evaluate(pt => window.__hexagoAgent.move(pt), best.point);
}

// 棋譜を取得して評価に使う
const record = await page.evaluate(() => window.__hexagoAgent.exportRecord());
console.log(record);

await browser.close();</pre>

<h2>注意</h2>
<ul>
${notes}
</ul>

<p><a href="./">← HEXAGO に戻る</a></p>
</body>
</html>
`;
}

function buildLlmsTxt(spec) {
  const apiNames = spec.apis.map(a => a.name).join(', ');
  return `# ${spec.name}

> ${spec.description}

## エージェント向けAPI

このサイトはブラウザ上で動作します。エージェントは \`window.__hexagoAgent\` から
関数呼び出しだけで対局できます（スクリーンショットやマウス操作は不要）。

- 仕様(機械可読): ./agent.json
- 仕様(人間向け): ./agent.html
- ゲーム本体: ./
- 仕様の取得: \`window.__hexagoAgent.help()\`

## 主要API

${apiNames}

## 1手の流れ

1. \`state()\` — 盤面と手番を取得
2. \`legalMoves()\` — 置ける交点の一覧
3. \`move(point)\` — 着手
4. \`awaitAI()\` — AIの応答を待つ

## 注意

${spec.notes.map(n => '- ' + n).join('\n')}
`;
}

function main() {
  const check = process.argv.includes('--check');
  const spec = loadSpec();
  const outputs = [
    { file: 'agent.json', content: buildJson(spec) },
    { file: 'agent.html', content: buildHtml(spec) },
    { file: 'llms.txt', content: buildLlmsTxt(spec) }
  ];
  let stale = 0;
  for (const out of outputs) {
    const full = path.join(repo, out.file);
    const prev = fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;
    if (check) {
      if (prev !== out.content) { console.error('stale: ' + out.file); stale++; }
      continue;
    }
    if (prev === out.content) { console.log('unchanged: ' + out.file); continue; }
    fs.writeFileSync(full, out.content);
    console.log('wrote: ' + out.file + ' (' + out.content.length + ' bytes)');
  }
  if (check && stale) {
    console.error('\nagent 仕様ファイルが古いです。node dev/agent-spec.js を実行してください。');
    process.exit(1);
  }
  if (check) console.log('OK: agent 仕様ファイルは最新です');
}

main();
