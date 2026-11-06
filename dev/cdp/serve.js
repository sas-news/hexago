#!/usr/bin/env node
'use strict';
/**
 * dev/cdp/serve.js — 依存ゼロの静的配信ヘルパ（regress.js / photo/test/run.js 共用）
 *
 * python3 -m http.server の代わり。Node の http + fs だけで動く。
 *  - MIME を正しく返す（.js を text/plain で返すと module/worker が動かないため重要）
 *  - Cache-Control: no-store（リファクタ中のリロードで古いファイルを掴まない）
 *  - ディレクトリは index.html を返す
 *  - パストラバーサル防止
 *  - /favicon.ico は 204（コンソールの 404 ノイズを避ける）
 */

const http = require('node:http');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.bin': 'application/octet-stream',
};

function mimeFor(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

/**
 * @param {string} root 配信ルート（リポジトリ直下を想定）
 * @param {object} [opts]
 * @param {number} [opts.port=0] 0 で空きポート自動割当
 * @param {string} [opts.host='127.0.0.1']
 * @param {boolean} [opts.log=false] リクエストログを stderr に出す
 * @returns {Promise<{server:http.Server, port:number, host:string, origin:string, urlFor:(p?:string)=>string, close:()=>Promise<void>}>}
 */
async function startStaticServer(root, opts = {}) {
  const { port = 0, host = '127.0.0.1', log = false } = opts;
  const rootAbs = path.resolve(root);

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const method = req.method || 'GET';
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0].split('#')[0]);

    const finish = (status, headers, body) => {
      if (res.writableEnded) return;
      res.writeHead(status, headers);
      if (method === 'HEAD' || body === undefined) res.end();
      else res.end(body);
      if (log) process.stderr.write(`[serve] ${method} ${urlPath} -> ${status} ${Date.now() - started}ms\n`);
    };

    try {
      if (method !== 'GET' && method !== 'HEAD') {
        finish(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' }, 'method not allowed\n');
        return;
      }
      if (urlPath === '/favicon.ico') {
        finish(204, { 'Cache-Control': 'no-store' });
        return;
      }

      let file = path.resolve(rootAbs, '.' + path.posix.normalize(urlPath));
      if (file !== rootAbs && !file.startsWith(rootAbs + path.sep)) {
        finish(403, { 'Content-Type': 'text/plain; charset=utf-8' }, 'forbidden\n');
        return;
      }

      let stat = null;
      try {
        stat = await fsp.stat(file);
      } catch (e) {
        stat = null;
      }
      if (stat && stat.isDirectory()) {
        file = path.join(file, 'index.html');
        try {
          stat = await fsp.stat(file);
        } catch (e) {
          stat = null;
        }
      }

      if (!stat || !stat.isFile()) {
        finish(
          404,
          { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
          `not found: ${urlPath}\n`
        );
        return;
      }

      const data = await fsp.readFile(file);
      finish(
        200,
        {
          'Content-Type': mimeFor(file),
          'Content-Length': data.length,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        },
        data
      );
    } catch (err) {
      finish(500, { 'Content-Type': 'text/plain; charset=utf-8' }, `server error: ${err.message}\n`);
    }
  });

  server.keepAliveTimeout = 5000;

  await new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });

  const actualPort = server.address().port;
  const origin = `http://${host}:${actualPort}`;
  return {
    server,
    port: actualPort,
    host,
    origin,
    urlFor(p = '/index.html') {
      return origin + (p.startsWith('/') ? p : '/' + p);
    },
    async close() {
      if (!server.listening) return;
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

module.exports = { startStaticServer, mimeFor, MIME };
