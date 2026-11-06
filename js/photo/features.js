// ===== 写真復元: パッチ特徴量（28次元） =====
// CONTRACT v2 準拠。依存なし・classic script。
// Python リファレンス実装 dev/photo/train/features.py と 1e-5 以内で一致する。
//
// API:
//   window.HexagoPhotoFeatures.extract(patch, baseline) -> Float32Array(28)
//     patch    : 16x16x3, RGB 0..255 (Float32Array / Uint8ClampedArray / 通常の配列)
//                並びは row-major: index = (y*16 + x)*3 + c  (x=列, y=行)
//     baseline : [r,g,b] 0..255 （canonical 画像の点六角形内部のチャネル毎中央値）
//   補助（Lead 側の実装と一致させたい場合に使用）:
//   window.HexagoPhotoFeatures.samplePatch(image, width, height, cx, cy, cell)
//     -> Float32Array(768)   0.9*cell 四方をバイリニアで 16x16 に間引き
//   window.HexagoPhotoFeatures.medianBaseline(image, width, height, corners)
//     -> [r,g,b]   corners = 6つの [x,y]（canonical 座標の格子6隅）
//
// 特徴量の定義（Python と同一）:
//   0-14  R,G,B 各: mean, std(母集団), p10, p50, p90 (index = floor(255*p))
//   15-16 平均色の H の cos(2πH), sin(2πH) / 17 S / 18 V
//   19-21 リング平均(i<2 or i>=14 or j<2 or j>=14) - 中央8x8平均  (R,G,B)
//   22    中心(7.5,7.5)から半径6の円周8方向の V の母集団標準偏差
//   23    V>0.92 かつ S<0.25 の画素割合
//   24-26 パッチ平均色 / (baseline/255) - 1  (R,G,B)
//   27    輝度 L=0.299r+0.587g+0.114b の中心差分勾配の大きさの平均
//         gx=(L[x+1]-L[x-1])/2, gy=(L[y+1]-L[y-1])/2, 内側 1..14
(function (global) {
  'use strict';

  var N = 16;
  var NP = N * N;

  function stdOf(a) {
    var n = a.length, s = 0, i, d, acc = 0;
    for (i = 0; i < n; i++) s += a[i];
    var m = s / n;
    for (i = 0; i < n; i++) { d = a[i] - m; acc += d * d; }
    return Math.sqrt(acc / n);
  }

  function hsvOf(r, g, b) {
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    var d = mx - mn, v = mx;
    var s = mx <= 0 ? 0 : d / mx;
    var h = 0;
    if (d > 0) {
      if (mx === r) h = ((g - b) / d) % 6;
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h = (h / 6) % 1;
      if (h < 0) h += 1;
    }
    return [h, s, v];
  }

  // p: Float64Array(768) 0..1。x,y は画素座標（画素中心が整数, 0..15）
  function bilinearPx(p, x, y) {
    var xmax = N - 1.000001, ymax = N - 1.000001;
    x = x < 0 ? 0 : (x > xmax ? xmax : x);
    y = y < 0 ? 0 : (y > ymax ? ymax : y);
    var x0 = Math.floor(x), y0 = Math.floor(y);
    var x1 = Math.min(x0 + 1, N - 1), y1 = Math.min(y0 + 1, N - 1);
    var fx = x - x0, fy = y - y0;
    var i00 = (y0 * N + x0) * 3, i01 = (y0 * N + x1) * 3;
    var i10 = (y1 * N + x0) * 3, i11 = (y1 * N + x1) * 3;
    var out = [0, 0, 0];
    for (var c = 0; c < 3; c++) {
      var top = p[i00 + c] * (1 - fx) + p[i01 + c] * fx;
      var bot = p[i10 + c] * (1 - fx) + p[i11 + c] * fx;
      out[c] = top * (1 - fy) + bot * fy;
    }
    return out;
  }

  function extract(patch, baseline) {
    var f = new Float32Array(28);
    var p = new Float64Array(NP * 3);
    var i, j, c, idx;
    for (idx = 0; idx < NP * 3; idx++) p[idx] = patch[idx] / 255;

    // 0-14: per-channel mean, std, p10, p50, p90
    var vals = new Float64Array(NP);
    for (c = 0; c < 3; c++) {
      var sum = 0, acc = 0, d, v;
      for (idx = 0; idx < NP; idx++) { v = p[idx * 3 + c]; vals[idx] = v; sum += v; }
      var mean = sum / NP;
      for (idx = 0; idx < NP; idx++) { d = vals[idx] - mean; acc += d * d; }
      var sd = Math.sqrt(acc / NP);
      vals.sort();
      var b = c * 5;
      f[b] = mean;
      f[b + 1] = sd;
      f[b + 2] = vals[Math.floor((NP - 1) * 0.1)];
      f[b + 3] = vals[Math.floor((NP - 1) * 0.5)];
      f[b + 4] = vals[Math.floor((NP - 1) * 0.9)];
    }

    // 15-18: HSV of the mean colour
    var mr = 0, mg = 0, mb = 0;
    for (idx = 0; idx < NP; idx++) { mr += p[idx * 3]; mg += p[idx * 3 + 1]; mb += p[idx * 3 + 2]; }
    mr /= NP; mg /= NP; mb /= NP;
    var hsv = hsvOf(mr, mg, mb);
    f[15] = Math.cos(2 * Math.PI * hsv[0]);
    f[16] = Math.sin(2 * Math.PI * hsv[0]);
    f[17] = hsv[1];
    f[18] = hsv[2];

    // 19-21: ring mean - centre 8x8 mean
    var ringSum = [0, 0, 0], ringN = 0, ctrSum = [0, 0, 0], ctrN = 0;
    for (j = 0; j < N; j++) {
      for (i = 0; i < N; i++) {
        var base = (j * N + i) * 3;
        if (i < 2 || i >= 14 || j < 2 || j >= 14) {
          ringSum[0] += p[base]; ringSum[1] += p[base + 1]; ringSum[2] += p[base + 2]; ringN++;
        }
        if (i >= 4 && i <= 11 && j >= 4 && j <= 11) {
          ctrSum[0] += p[base]; ctrSum[1] += p[base + 1]; ctrSum[2] += p[base + 2]; ctrN++;
        }
      }
    }
    for (c = 0; c < 3; c++) f[19 + c] = ringSum[c] / ringN - ctrSum[c] / ctrN;

    // 22: std of V at 8 points on a radius-6 circle around (7.5, 7.5)
    var vv = new Float64Array(8);
    for (i = 0; i < 8; i++) {
      var ang = i * Math.PI / 4;
      var rgb = bilinearPx(p, 7.5 + 6 * Math.cos(ang), 7.5 + 6 * Math.sin(ang));
      vv[i] = Math.max(rgb[0], rgb[1], rgb[2]);
    }
    f[22] = stdOf(vv);

    // 23: highlight rate (V > 0.92 && S < 0.25)
    var hi = 0;
    for (idx = 0; idx < NP; idx++) {
      var r0 = p[idx * 3], g0 = p[idx * 3 + 1], b0 = p[idx * 3 + 2];
      var vmax = Math.max(r0, g0, b0), vmin = Math.min(r0, g0, b0);
      var sat = vmax > 0 ? (vmax - vmin) / vmax : 0;
      if (vmax > 0.92 && sat < 0.25) hi++;
    }
    f[23] = hi / NP;

    // 24-26: patch mean colour relative to baseline colour
    var means = [mr, mg, mb];
    var B = baseline || [255, 255, 255];
    for (c = 0; c < 3; c++) {
      var bc = B[c];
      if (bc === undefined || bc === null) bc = 255;
      if (bc < 1) bc = 1;
      f[24 + c] = means[c] * 255 / bc - 1;
    }

    // 27: mean luminance centre-difference gradient magnitude
    var L = new Float64Array(NP);
    for (idx = 0; idx < NP; idx++) {
      L[idx] = 0.299 * p[idx * 3] + 0.587 * p[idx * 3 + 1] + 0.114 * p[idx * 3 + 2];
    }
    var gsum = 0, gn = 0;
    for (j = 1; j <= 14; j++) {
      for (i = 1; i <= 14; i++) {
        var gx = (L[j * N + i + 1] - L[j * N + i - 1]) / 2;
        var gy = (L[(j + 1) * N + i] - L[(j - 1) * N + i]) / 2;
        gsum += Math.sqrt(gx * gx + gy * gy);
        gn++;
      }
    }
    f[27] = gsum / gn;

    return f;
  }

  // image: width x height RGB 0..255 (Float32Array / Uint8ClampedArray ...)
  function samplePatch(image, width, height, cx, cy, cell) {
    var side = 0.9 * cell;
    var step = side / N;
    var out = new Float32Array(NP * 3);
    var xmax = width - 1.000001, ymax = height - 1.000001;
    for (var j = 0; j < N; j++) {
      var y = cy - side / 2 + (j + 0.5) * step;
      if (y < 0) y = 0; else if (y > ymax) y = ymax;
      var y0 = Math.floor(y), y1 = Math.min(y0 + 1, height - 1), fy = y - y0;
      for (var i = 0; i < N; i++) {
        var x = cx - side / 2 + (i + 0.5) * step;
        if (x < 0) x = 0; else if (x > xmax) x = xmax;
        var x0 = Math.floor(x), x1 = Math.min(x0 + 1, width - 1), fx = x - x0;
        var i00 = (y0 * width + x0) * 3, i01 = (y0 * width + x1) * 3;
        var i10 = (y1 * width + x0) * 3, i11 = (y1 * width + x1) * 3;
        var o = (j * N + i) * 3;
        for (var c = 0; c < 3; c++) {
          var top = image[i00 + c] * (1 - fx) + image[i01 + c] * fx;
          var bot = image[i10 + c] * (1 - fx) + image[i11 + c] * fx;
          out[o + c] = top * (1 - fy) + bot * fy;
        }
      }
    }
    return out;
  }

  // 六角形（corners: [[x,y] x6]、ピクセル番号座標）内部の画素のチャネル毎中央値
  function medianBaseline(image, width, height, corners) {
    var inside = [];
    var nc = corners.length, k, x, y;
    for (y = 0; y < height; y++) {
      for (x = 0; x < width; x++) {
        var inPoly = false, jj = nc - 1;
        for (k = 0; k < nc; k++) {
          var xi = corners[k][0], yi = corners[k][1];
          var xj = corners[jj][0], yj = corners[jj][1];
          if (((yi > y) !== (yj > y)) &&
              (x < (xj - xi) * (y - yi) / (yj - yi + 1e-12) + xi)) {
            inPoly = !inPoly;
          }
          jj = k;
        }
        if (inPoly) inside.push((y * width + x) * 3);
      }
    }
    var n = inside.length;
    var out = [0, 0, 0];
    for (var c = 0; c < 3; c++) {
      var arr = new Float64Array(n);
      for (k = 0; k < n; k++) arr[k] = image[inside[k] + c];
      arr.sort();
      out[c] = (n % 2) ? arr[(n - 1) / 2] : (arr[n / 2 - 1] + arr[n / 2]) / 2;
    }
    return out;
  }

  var api = {
    extract: extract,
    samplePatch: samplePatch,
    medianBaseline: medianBaseline,
    hsvOf: hsvOf,
    N: N,
    SIDE_FRAC: 0.9
  };
  global.HexagoPhotoFeatures = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
