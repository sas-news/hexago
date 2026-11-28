#!/usr/bin/env node
/**
 * 単一ファイル配信用 index.html を dev/index.template.html と各ソースから生成する。
 *
 * 学校などの GAS プロキシ環境（HTML 1ファイルのみを転送し、相対パスの CSS/JS/Worker/JSON を
 * 解決できない環境）でも全機能（MCTS AI Worker・写真認識モデル含む）が動作するよう、
 * すべてのローカル資産を index.html にインライン化する。
 *
 *   node dev/build-html.js          # index.html を再生成
 *   node dev/build-html.js --check  # 差分または相対ローカル参照があれば exit 1
 */
'use strict';
const fs = require('fs');
const path = require('path');

const repo = path.resolve(__dirname, '..');
const templatePath = path.join(repo, 'dev', 'index.template.html');
const outPath = path.join(repo, 'index.html');

function readRel(relPath) {
  const full = path.resolve(repo, relPath);
  if (!full.startsWith(repo + path.sep)) {
    throw new Error('Refusing to read outside repo: ' + relPath);
  }
  return fs.readFileSync(full, 'utf8');
}

function assertSafeForScriptTag(content, label) {
  if (/<\/script/i.test(content)) {
    throw new Error('Unsafe </script sequence found in ' + label);
  }
}

function buildHtml() {
  let html = fs.readFileSync(templatePath, 'utf8');

  // 1. Inline local stylesheets: <link rel="stylesheet" href="./...">
  html = html.replace(/<link\s+rel="stylesheet"\s+href="(\.\/[^"]+)"\s*>/g, (_, rel) => {
    const css = readRel(rel).trim();
    if (/<\/style/i.test(css)) throw new Error('Unsafe </style sequence found in ' + rel);
    return '<style>\n' + css + '\n</style>';
  });

  // 1.5. Inline favicon / manifest links as data URIs (single-file delivery).
  //      <link rel="icon" href="./x.svg" type="image/svg+xml"> などは
  //      相対パス先を data: URI に置き換えて index.html 単体で動くようにする。
  const MIME = { '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
  const toDataUri = (mime, buf) => 'data:' + mime + ';base64,' + buf.toString('base64');
  html = html.replace(/<link\s+([^>]*?)href="(\.\/[^"]+)"([^>]*)>/g, (match, pre, rel, post) => {
    const ext = path.extname(rel).toLowerCase();
    const mime = MIME[ext];
    if (!mime) return match; // CSS などはこの後で別処理
    const full = path.resolve(repo, rel);
    if (!full.startsWith(repo + path.sep)) throw new Error('Refusing to read outside repo: ' + rel);
    if (!fs.existsSync(full)) throw new Error('Missing asset referenced from template: ' + rel);
    return '<link ' + pre + 'href="' + toDataUri(mime, fs.readFileSync(full)) + '"' + post + '>';
  });

  // 2. Inline JSON data blocks: <!-- INLINE_JSON:id:./path.json -->
  html = html.replace(/<!--\s*INLINE_JSON:([A-Za-z0-9_-]+):(\.\/[^\s]+)\s*-->/g, (_, id, rel) => {
    const raw = readRel(rel);
    const parsed = JSON.parse(raw);
    const compact = JSON.stringify(parsed).replace(/</g, '\\u003c');
    assertSafeForScriptTag(compact, rel);
    return '<script id="' + id + '" type="application/json">\n' + compact + '\n</script>';
  });

  // 3. Inline text/plain script blocks (e.g. Blob Worker AI engine): <!-- INLINE_TEXT:id:./path.js -->
  html = html.replace(/<!--\s*INLINE_TEXT:([A-Za-z0-9_-]+):(\.\/[^\s]+)\s*-->/g, (_, id, rel) => {
    const text = readRel(rel).trim();
    assertSafeForScriptTag(text, rel);
    return '<script id="' + id + '" type="text/plain">\n' + text + '\n</script>';
  });

  // 4. Inline local classic scripts in exact dependency order: <script src="./..."></script>
  const appChunks = [];
  html = html.replace(/<script\s+src="(\.\/[^"]+)"><\/script>\s*/g, (_, rel) => {
    const code = readRel(rel).trim();
    assertSafeForScriptTag(code, rel);
    appChunks.push('// --- ' + rel + ' ---\n' + code);
    return '';
  });

  if (!appChunks.length) {
    throw new Error('No local scripts found in dev/index.template.html');
  }
  const combinedScript = '<script>\n' + appChunks.join('\n\n') + '\n</script>\n';
  html = html.replace('</body>', combinedScript + '</body>');

  // Verify no relative local <script src="./..."> or <link href="./..."> remain.
  // ただしエージェント向けの別ファイル(agent.json / llms.txt / agent.html)は
  // 単一ファイルに同梱せず、サイト上に別途置くため例外とする。
  const EXTERNAL_OK = /^<\.\/(?:agent\.json|agent\.html|llms\.txt)$/;
  const leftover = (html.match(/<(?:script[^>]+src|link[^>]+href)="(\.\/[^"]+)"/g) || [])
    .filter(ref => {
      const m = /="(\.\/[^"]+)"/.exec(ref);
      return !(m && EXTERNAL_OK.test('<' + m[1]));
    });
  if (leftover.length) {
    throw new Error('Unresolved relative local references remain: ' + leftover.join(', '));
  }

  return html;
}

const next = buildHtml();
const prev = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : '';

if (process.argv.includes('--check')) {
  if (prev !== next) {
    console.error('STALE: index.html does not match dev/index.template.html + source files (run: node dev/build-html.js)');
    process.exit(1);
  }
  console.log(`OK: index.html is up-to-date and self-contained (${next.length} bytes)`);
  process.exit(0);
}

if (prev === next) {
  console.log(`No change: index.html is already up to date (${next.length} bytes).`);
  process.exit(0);
}

fs.writeFileSync(outPath, next);
console.log(`Built single-file index.html (${next.length} bytes)`);
