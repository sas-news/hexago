'use strict';
/**
 * ページ実装の連結ソース（旧ツール用）。
 *
 * リファクタ後、ページの実装は index.html + js/*.js に分散している。
 * 旧ツール（dev/engine-selftest.js, bench/lib/old-ai.js）は「ページのテキスト」から
 * 関数を切り出して独自実装と突き合わせるため、読み込み順に連結した1つのテキストを返す。
 * 新しいページ用ファイルを追加したら FILES に追記すること。
 */
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');

const FILES = [
  'index.html',
  'js/core/theme.js',
  'js/core/sound.js',
  'js/core/geometry.js',
  'js/core/state.js',
  'js/core/rules.js',
  'js/ai/heuristic.js',
  'js/ui/input.js',
  'js/ui/render.js',
  'js/ui/ui.js',
  'js/ui/modals.js',
  'js/ui/settings.js',
  'js/ui/online.js',
  'js/ui/debug.js',
  'js/main.js',
];

function readPageSource(repo) {
  const root = repo || REPO;
  return FILES.map(f => fs.readFileSync(path.join(root, f), 'utf8')).join('\n');
}

module.exports = { readPageSource, FILES, REPO };
