#!/usr/bin/env node
/**
 * js/ai/engine.js を dev/ai-engine.js から同期する。
 * エンジンのソースオブトゥルースは dev/ai-engine.js（Node自己テスト・ベンチが直接 require する）。
 * ページ / Worker が読み込む配信物は js/ai/engine.js で、こちらは生成コピー。
 *
 *   node dev/sync-engine.js          # dev/ai-engine.js -> js/ai/engine.js
 *   node dev/sync-engine.js --check  # 差分があれば exit 1
 */
'use strict';
const fs = require('fs');
const path = require('path');

const repo = path.resolve(__dirname, '..');
const srcPath = path.join(repo, 'dev', 'ai-engine.js');
const dstPath = path.join(repo, 'js', 'ai', 'engine.js');

const src = fs.readFileSync(srcPath, 'utf8');
if (!src.includes('HexagoAI')) {
  console.error('ERROR: dev/ai-engine.js does not expose HexagoAI');
  process.exit(2);
}
const next = src.trim() + '\n';
const prev = fs.existsSync(dstPath) ? fs.readFileSync(dstPath, 'utf8') : '';

if (process.argv.includes('--check')) {
  if (prev.trim() !== src.trim()) {
    console.error('STALE: js/ai/engine.js does not match dev/ai-engine.js (run: node dev/sync-engine.js)');
    process.exit(1);
  }
  console.log(`OK: js/ai/engine.js matches dev/ai-engine.js (${next.length} bytes)`);
  process.exit(0);
}

if (prev === next) {
  console.log('No change: js/ai/engine.js is already up to date.');
  process.exit(0);
}
fs.writeFileSync(dstPath, next);
console.log(`Synced engine: dev/ai-engine.js -> js/ai/engine.js (${next.length} bytes)`);
