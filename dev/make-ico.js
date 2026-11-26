#!/usr/bin/env node
'use strict';
// favicon.ico を生成する: 複数サイズの PNG を ICO(PNG 埋め込み)にまとめる。
//   事前に dev/make-icon-png.js で .ico-16.png 等を用意しておくこと。
const fs = require('fs');
const path = require('path');
const repo = path.resolve(__dirname, '..');

function pngSize(buf) {
  if (buf.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('not a PNG');
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

function makeIco(entries) {
  const count = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);   // reserved
  header.writeUInt16LE(1, 2);   // 1 = icon
  header.writeUInt16LE(count, 4);
  const dir = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  const blobs = [];
  entries.forEach((e, i) => {
    const b = i * 16;
    dir[b] = e.w >= 256 ? 0 : e.w;
    dir[b + 1] = e.h >= 256 ? 0 : e.h;
    dir[b + 2] = 0;                       // palette count
    dir[b + 3] = 0;                       // reserved
    dir.writeUInt16LE(1, b + 4);          // color planes
    dir.writeUInt16LE(32, b + 6);         // bits per pixel
    dir.writeUInt32LE(e.png.length, b + 8);
    dir.writeUInt32LE(offset, b + 12);
    offset += e.png.length;
    blobs.push(e.png);
  });
  return Buffer.concat([header, dir, ...blobs]);
}

const sizes = [16, 32, 48];
const entries = sizes.map(s => {
  const file = path.join(repo, `.ico-${s}.png`);
  if (!fs.existsSync(file)) throw new Error('missing ' + path.basename(file) + ' (run dev/make-icon-png.js first)');
  const png = fs.readFileSync(file);
  const { w, h } = pngSize(png);
  if (w !== s || h !== s) throw new Error(`size mismatch for ${s}: ${w}x${h}`);
  return { png, w, h };
});
const out = path.join(repo, 'favicon.ico');
fs.writeFileSync(out, makeIco(entries));
console.log(`favicon.ico written (${sizes.join('/')} px, ${fs.statSync(out).size} bytes)`);
