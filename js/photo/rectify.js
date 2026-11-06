// ===== 写真復元: canonical 画像への変換・ベースライン・パッチ抽出 =====
// dev/photo/CONTRACT.md §1-4。依存なし・classic script。
//   HexagoPhotoRectify.prepare(imageData, H, size) -> {canon, baseline, layout, patches}
//   HexagoPhotoRectify.featuresOf(patches, baseline) -> [Float32Array(28)]
(function (global) {
  'use strict';

  var G = global.HexagoPhotoGeom;
  if (!G && typeof require === 'function') G = require('./geom.js');
  var F = global.HexagoPhotoFeatures;
  if (!F && typeof require === 'function') F = require('./features.js');

  function toFloatRGB(imageData) {
    var d = imageData.data, n = d.length / 4;
    var out = new Float32Array(n * 3);
    for (var i = 0, j = 0; i < n; i++, j += 4) {
      out[i * 3] = d[j];
      out[i * 3 + 1] = d[j + 1];
      out[i * 3 + 2] = d[j + 2];
    }
    return out;
  }

  function bilinear3(data, w, h, x, y, out) {
    if (x < 0) x = 0; else if (x > w - 1) x = w - 1;
    if (y < 0) y = 0; else if (y > h - 1) y = h - 1;
    var x0 = x | 0, y0 = y | 0;
    var x1 = x0 + 1 >= w ? w - 1 : x0 + 1;
    var y1 = y0 + 1 >= h ? h - 1 : y0 + 1;
    var fx = x - x0, fy = y - y0;
    var i00 = (y0 * w + x0) * 3, i10 = (y0 * w + x1) * 3, i01 = (y1 * w + x0) * 3, i11 = (y1 * w + x1) * 3;
    for (var c = 0; c < 3; c++) {
      var a = data[i00 + c] * (1 - fx) + data[i10 + c] * fx;
      var b = data[i01 + c] * (1 - fx) + data[i11 + c] * fx;
      out[c] = a * (1 - fy) + b * fy;
    }
    return out;
  }

  // H: 画像座標 -> canonical 座標
  function warp(imgData, H, W) {
    var srcW = imgData.width, srcH = imgData.height;
    var src = toFloatRGB(imgData);
    var inv = G.inv3(H);
    if (!inv) throw new Error('homography is not invertible');
    var out = new Float32Array(W * W * 3);
    var px = [0, 0, 0];
    for (var y = 0; y < W; y++) {
      for (var x = 0; x < W; x++) {
        var wpt = inv[6] * x + inv[7] * y + inv[8];
        if (Math.abs(wpt) < 1e-12) wpt = 1e-12;
        var sx = (inv[0] * x + inv[1] * y + inv[2]) / wpt;
        var sy = (inv[3] * x + inv[4] * y + inv[5]) / wpt;
        bilinear3(src, srcW, srcH, sx, sy, px);
        var o = (y * W + x) * 3;
        out[o] = px[0]; out[o + 1] = px[1]; out[o + 2] = px[2];
      }
    }
    return out;
  }

  // canonical 上の六角形内部判定（アプリの盤と同じ flat-top 六角形）
  function hexNorm(dx, dy) {
    var a = Math.abs(dx);
    var b = Math.abs(dx / 2 + dy * 0.8660254037844386);
    var c = Math.abs(dx / 2 - dy * 0.8660254037844386);
    return Math.max(a, b, c);
  }
  // 盤として扱う半径: 格子の六角形 + 石のはみ出しを覆うマージン。
  // 格子の辺上の点の石（半径0.44cell）が欠けないよう、外側0.6cellまでは盤面として残す。
  var FILL_MARGIN = 0.6;
  function boardRadius(L) { return (L.s + FILL_MARGIN) * L.cell; }
  function insideHex(L, x, y) {
    var dx = x - L.center[0], dy = y - L.center[1];
    return hexNorm(dx, dy) <= boardRadius(L) + 1e-6;
  }

  // 六角形内部のチャネル毎中央値（0..255）
  function baselineOf(canon, W, L) {
    var hist = [new Int32Array(256), new Int32Array(256), new Int32Array(256)];
    var inside = 0;
    var R = L.s * L.cell + 1e-6;
    for (var y = 0; y < W; y++) {
      for (var x = 0; x < W; x++) {
        var ddx = x - L.center[0], ddy = y - L.center[1];
        if (hexNorm(ddx, ddy) > R) continue;
        var o = (y * W + x) * 3;
        hist[0][Math.min(255, Math.max(0, canon[o] | 0))]++;
        hist[1][Math.min(255, Math.max(0, canon[o + 1] | 0))]++;
        hist[2][Math.min(255, Math.max(0, canon[o + 2] | 0))]++;
        inside++;
      }
    }
    var out = [0, 0, 0];
    if (!inside) return out;
    for (var c = 0; c < 3; c++) {
      var half = inside / 2, acc = 0, m = 0;
      for (; m < 256; m++) {
        acc += hist[c][m];
        if (acc >= half) break;
      }
      out[c] = m;
    }
    return out;
  }

  // 六角形の外側を盤色で埋める（縁の点のパッチが背景色に引っ張られないように）
  function fillOutside(canon, W, L, baseline) {
    for (var y = 0; y < W; y++) {
      for (var x = 0; x < W; x++) {
        if (insideHex(L, x, y)) continue;
        var o = (y * W + x) * 3;
        canon[o] = baseline[0];
        canon[o + 1] = baseline[1];
        canon[o + 2] = baseline[2];
      }
    }
  }

  // 1点分のパッチ（16x16 RGB 0..255）を canonical から抽出
  function patchAt(canon, W, x, y, side) {
    var patch = new Float32Array(16 * 16 * 3);
    var half = side / 2;
    var step = side / 16;
    var px = [0, 0, 0];
    for (var j = 0; j < 16; j++) {
      var sy = y - half + (j + 0.5) * step;
      for (var i = 0; i < 16; i++) {
        var sx = x - half + (i + 0.5) * step;
        bilinear3(canon, W, W, sx, sy, px);
        var o = (j * 16 + i) * 3;
        patch[o] = px[0]; patch[o + 1] = px[1]; patch[o + 2] = px[2];
      }
    }
    return patch;
  }

  function prepare(imageData, H, size) {
    var L = G.layout(size);
    var W = L.W;
    var canon = warp(imageData, H, W);
    var baseline = baselineOf(canon, W, L);
    fillOutside(canon, W, L, baseline);
    var side = 0.9 * L.cell;
    var patches = L.pts.map(function (p) { return patchAt(canon, W, p[0], p[1], side); });
    return { canon: canon, W: W, baseline: baseline, layout: L, patches: patches };
  }

  function featuresOf(patches, baseline) {
    return patches.map(function (p) { return F.extract(p, baseline); });
  }

  // デバッグ/検証用: features の生配列を通常配列で返す
  function featuresArrays(patches, baseline) {
    return featuresOf(patches, baseline).map(function (f) { return Array.prototype.slice.call(f); });
  }

  var api = {
    warp: warp,
    prepare: prepare,
    featuresOf: featuresOf,
    featuresArrays: featuresArrays,
    insideHex: insideHex,
    boardRadius: boardRadius,
    FILL_MARGIN: FILL_MARGIN,
    hexNorm: hexNorm,
    baselineOf: baselineOf,
    fillOutside: fillOutside,
    patchAt: patchAt,
    toFloatRGB: toFloatRGB
  };
  global.HexagoPhotoRectify = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
