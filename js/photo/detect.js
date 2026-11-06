// ===== 写真復元: 盤の外枠（6隅）自動検出 =====
// 背景（テーブル等）との色差で盤領域を取り、その凸包に外接する六角形を
// 3方向のサポート関数でフィットする。失敗時は null を返し、UI の手動調整に委ねる。
//   HexagoPhotoDetect.detect(imageData) -> {corners:[[x,y]x6], confidence, method, hexAreaRatio}
(function (global) {
  'use strict';

  function downsample(imageData, maxDim) {
    var w = imageData.width, h = imageData.height;
    var sc = Math.min(1, maxDim / Math.max(w, h));
    var dw = Math.max(8, Math.round(w * sc)), dh = Math.max(8, Math.round(h * sc));
    var src = imageData.data;
    var out = new Uint8ClampedArray(dw * dh * 4);
    var bx = w / dw, by = h / dh;
    for (var y = 0; y < dh; y++) {
      var y0 = Math.floor(y * by), y1 = Math.min(h, Math.ceil((y + 1) * by));
      for (var x = 0; x < dw; x++) {
        var x0 = Math.floor(x * bx), x1 = Math.min(w, Math.ceil((x + 1) * bx));
        var sr = 0, sg = 0, sb = 0, n = 0;
        for (var yy = y0; yy < y1; yy++) {
          for (var xx = x0; xx < x1; xx++) {
            var o = (yy * w + xx) * 4;
            sr += src[o]; sg += src[o + 1]; sb += src[o + 2]; n++;
          }
        }
        if (!n) n = 1;
        var o2 = (y * dw + x) * 4;
        out[o2] = sr / n; out[o2 + 1] = sg / n; out[o2 + 2] = sb / n; out[o2 + 3] = 255;
      }
    }
    return { width: dw, height: dh, data: out, scale: dw / w };
  }

  function borderMedian(ds) {
    var w = ds.width, h = ds.height, d = ds.data;
    var rs = [], gs = [], bs = [];
    var band = Math.max(4, Math.round(Math.min(w, h) * 0.06));
    function push(x, y) {
      var o = (y * w + x) * 4;
      rs.push(d[o]); gs.push(d[o + 1]); bs.push(d[o + 2]);
    }
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        if (x < band || y < band || x >= w - band || y >= h - band) push(x, y);
      }
    }
    function med(a) { a.sort(function (p, q) { return p - q; }); return a[a.length >> 1]; }
    return [med(rs), med(gs), med(bs)];
  }

  function otsu(vals) {
    var hist = new Float64Array(256), i;
    for (i = 0; i < vals.length; i++) {
      var v = vals[i] | 0;
      if (v < 0) v = 0; else if (v > 255) v = 255;
      hist[v]++;
    }
    var total = vals.length, sum = 0;
    for (i = 0; i < 256; i++) sum += i * hist[i];
    var sumB = 0, wB = 0, best = 0, bestVar = -1;
    for (i = 0; i < 256; i++) {
      wB += hist[i];
      if (!wB) continue;
      var wF = total - wB;
      if (!wF) break;
      sumB += i * hist[i];
      var mB = sumB / wB, mF = (sum - sumB) / wF;
      var between = wB * wF * (mB - mF) * (mB - mF);
      if (between > bestVar) { bestVar = between; best = i; }
    }
    return best;
  }

  // 正方形カーネルの膨張・収縮は分離可能（横→縦）なので O(w*h*r) で済む
  function dilate(mask, w, h, r) {
    var tmp = new Uint8Array(w * h);
    for (var y = 0; y < h; y++) {
      var row = y * w;
      for (var x = 0; x < w; x++) {
        var on = 0;
        for (var dx = -r; dx <= r; dx++) {
          var xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          if (mask[row + xx]) { on = 1; break; }
        }
        tmp[row + x] = on;
      }
    }
    var out = new Uint8Array(w * h);
    for (var x2 = 0; x2 < w; x2++) {
      for (var y2 = 0; y2 < h; y2++) {
        var on2 = 0;
        for (var dy = -r; dy <= r; dy++) {
          var yy = y2 + dy;
          if (yy < 0 || yy >= h) continue;
          if (tmp[yy * w + x2]) { on2 = 1; break; }
        }
        out[y2 * w + x2] = on2;
      }
    }
    return out;
  }
  function erode(mask, w, h, r) {
    var tmp = new Uint8Array(w * h);
    for (var y = 0; y < h; y++) {
      var row = y * w;
      for (var x = 0; x < w; x++) {
        var off = 0;
        for (var dx = -r; dx <= r; dx++) {
          var xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          if (!mask[row + xx]) { off = 1; break; }
        }
        tmp[row + x] = off ? 0 : 1;
      }
    }
    var out = new Uint8Array(w * h);
    for (var x2 = 0; x2 < w; x2++) {
      for (var y2 = 0; y2 < h; y2++) {
        var off2 = 0;
        for (var dy = -r; dy <= r; dy++) {
          var yy = y2 + dy;
          if (yy < 0 || yy >= h) continue;
          if (!tmp[yy * w + x2]) { off2 = 1; break; }
        }
        out[y2 * w + x2] = off2 ? 0 : 1;
      }
    }
    return out;
  }

  // 4近傍の連結成分を1つ選ぶ（最大面積）
  function largestComponent(mask, w, h) {
    var label = new Int32Array(w * h).fill(-1);
    var best = { area: 0, label: -1 };
    var stack = new Int32Array(w * h);
    var cur = 0;
    for (var i = 0; i < w * h; i++) {
      if (!mask[i] || label[i] >= 0) continue;
      var sp = 0;
      stack[sp++] = i;
      label[i] = cur;
      var area = 0;
      while (sp) {
        var p = stack[--sp];
        area++;
        var px = p % w, py = (p / w) | 0;
        if (px > 0) { var q = p - 1; if (mask[q] && label[q] < 0) { label[q] = cur; stack[sp++] = q; } }
        if (px < w - 1) { q = p + 1; if (mask[q] && label[q] < 0) { label[q] = cur; stack[sp++] = q; } }
        if (py > 0) { q = p - w; if (mask[q] && label[q] < 0) { label[q] = cur; stack[sp++] = q; } }
        if (py < h - 1) { q = p + w; if (mask[q] && label[q] < 0) { label[q] = cur; stack[sp++] = q; } }
      }
      if (area > best.area) best = { area: area, label: cur };
      cur++;
    }
    if (best.label < 0) return { mask: new Uint8Array(w * h), area: 0 };
    var out = new Uint8Array(w * h);
    for (i = 0; i < w * h; i++) if (label[i] === best.label) out[i] = 1;
    return { mask: out, area: best.area };
  }

  function fillHoles(mask, w, h) {
    // 外周から背景を塗り、到達できない 0 を穴として埋める
    var reached = new Uint8Array(w * h);
    var stack = new Int32Array(w * h);
    var sp = 0;
    function seed(i) { if (!mask[i] && !reached[i]) { reached[i] = 1; stack[sp++] = i; } }
    for (var x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
    for (var y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
    while (sp) {
      var p = stack[--sp];
      var px = p % w, py = (p / w) | 0;
      if (px > 0 && !mask[p - 1] && !reached[p - 1]) { reached[p - 1] = 1; stack[sp++] = p - 1; }
      if (px < w - 1 && !mask[p + 1] && !reached[p + 1]) { reached[p + 1] = 1; stack[sp++] = p + 1; }
      if (py > 0 && !mask[p - w] && !reached[p - w]) { reached[p - w] = 1; stack[sp++] = p - w; }
      if (py < h - 1 && !mask[p + w] && !reached[p + w]) { reached[p + w] = 1; stack[sp++] = p + w; }
    }
    var out = new Uint8Array(w * h);
    for (var i = 0; i < w * h; i++) out[i] = mask[i] || !reached[i] ? 1 : 0;
    return out;
  }

  function boundaryPoints(mask, w, h) {
    var pts = [];
    for (var y = 1; y < h - 1; y++) {
      for (var x = 1; x < w - 1; x++) {
        var i = y * w + x;
        if (!mask[i]) continue;
        if (!mask[i - 1] || !mask[i + 1] || !mask[i - w] || !mask[i + w]) pts.push([x, y]);
      }
    }
    return pts;
  }

  function convexHull(pts) {
    var p = pts.slice().sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
    if (p.length < 3) return p;
    function cross(o, a, b) { return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]); }
    var lower = [], i;
    for (i = 0; i < p.length; i++) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p[i]) <= 0) lower.pop();
      lower.push(p[i]);
    }
    var upper = [];
    for (i = p.length - 1; i >= 0; i--) {
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p[i]) <= 0) upper.pop();
      upper.push(p[i]);
    }
    lower.pop(); upper.pop();
    return lower.concat(upper);
  }

  function polygonArea(pts) {
    var a = 0;
    for (var i = 0, n = pts.length; i < n; i++) {
      var p = pts[i], q = pts[(i + 1) % n];
      a += p[0] * q[1] - q[0] * p[1];
    }
    return Math.abs(a) / 2;
  }

  // 3方向（60度おき）のサポート関数で外接六角形を作る
  function hexagonFromSupport(hullPts, phi0) {
    var hs = [], angles = [];
    for (var k = 0; k < 6; k++) {
      var a = phi0 + k * Math.PI / 3;
      var nx = Math.cos(a), ny = Math.sin(a);
      var mx = -Infinity;
      for (var i = 0; i < hullPts.length; i++) {
        var v = hullPts[i][0] * nx + hullPts[i][1] * ny;
        if (v > mx) mx = v;
      }
      hs.push(mx); angles.push(a);
    }
    var corners = [];
    for (k = 0; k < 6; k++) {
      var a1 = angles[k], a2 = angles[(k + 1) % 6];
      var n1x = Math.cos(a1), n1y = Math.sin(a1);
      var n2x = Math.cos(a2), n2y = Math.sin(a2);
      var det = n1x * n2y - n1y * n2x;
      if (Math.abs(det) < 1e-9) return null;
      var x = (hs[k] * n2y - hs[(k + 1) % 6] * n1y) / det;
      var y = (n1x * hs[(k + 1) % 6] - n2x * hs[k]) / det;
      corners.push([x, y]);
    }
    return corners;
  }

  function detect(imageData) {
    var ds = downsample(imageData, 720);
    var w = ds.width, h = ds.height, d = ds.data;
    var bg = borderMedian(ds);
    var dist = new Float32Array(w * h);
    var sat = new Float32Array(w * h);
    for (var i = 0, o = 0; i < w * h; i++, o += 4) {
      var dr = d[o] - bg[0], dg = d[o + 1] - bg[1], db = d[o + 2] - bg[2];
      var col = Math.sqrt(0.299 * dr * dr + 0.587 * dg * dg + 0.114 * db * db);
      var mx = Math.max(d[o], d[o + 1], d[o + 2]), mn = Math.min(d[o], d[o + 1], d[o + 2]);
      var sv = mx > 1 ? (mx - mn) / mx : 0;
      sat[i] = sv;
      // 影（彩度が背景と同程度）は盤とみなしにくくする
      var bgmx = Math.max(bg[0], bg[1], bg[2]), bgmn = Math.min(bg[0], bg[1], bg[2]);
      var bgSat = bgmx > 1 ? (bgmx - bgmn) / bgmx : 0;
      var satBoost = Math.max(0, sv - bgSat) * 90;
      dist[i] = col + satBoost;
    }
    var thr = otsu(dist);
    if (thr < 12) thr = 12;
    var mask = new Uint8Array(w * h);
    for (i = 0; i < w * h; i++) mask[i] = dist[i] > thr ? 1 : 0;
    var r = Math.max(2, Math.round(Math.min(w, h) * 0.012));
    mask = dilate(erode(mask, w, h, r), w, h, r);
    var comp = largestComponent(mask, w, h);
    if (!comp.area || comp.area < w * h * 0.05) return { corners: null, confidence: 0, method: 'contour' };
    mask = fillHoles(comp.mask, w, h);
    var pts = boundaryPoints(mask, w, h);
    if (pts.length < 30) return { corners: null, confidence: 0, method: 'contour' };
    var hull = convexHull(pts);
    if (hull.length < 6) return { corners: null, confidence: 0, method: 'contour' };
    var best = null;
    function scorePhi(phi) {
      var hex = hexagonFromSupport(hull, phi);
      if (!hex) return null;
      return { hex: hex, area: polygonArea(hex) };
    }
    for (var deg = 0; deg < 60; deg += 1) {
      var s = scorePhi(deg * Math.PI / 180);
      if (s && (!best || s.area < best.area)) { best = s; best.deg = deg; }
    }
    if (!best) return { corners: null, confidence: 0, method: 'contour' };
    for (var dd = -1; dd <= 1; dd += 0.25) {
      var s2 = scorePhi((best.deg + dd) * Math.PI / 180);
      if (s2 && s2.area < best.area) { best = s2; best.deg = best.deg + dd; }
    }
    var hullArea = polygonArea(hull);
    var ratio = hullArea > 0 ? best.area / hullArea : 99;
    // 凸包が六角形に近いほど ratio は 1 に近い
    var confidence = Math.max(0, Math.min(1, (1.45 - ratio) / 0.32));
    // 面積の妥当性チェック（画像のほぼ全体/極端に小さい場合は検出を疑う）
    var imgArea = w * h;
    var areaFrac = best.area / imgArea;
    if (areaFrac > 0.85) confidence *= 0.45;
    else if (areaFrac < 0.08) confidence *= 0.4;
    // 凸包が画像の端に接している（盤が切れている）場合も信頼度を下げる
    var touches = 0;
    for (var k2 = 0; k2 < 6; k2++) {
      var p2 = best.hex[k2];
      if (p2[0] < 3 || p2[1] < 3 || p2[0] > w - 3 || p2[1] > h - 3) touches++;
    }
    if (touches) confidence *= Math.max(0.35, 1 - touches * 0.1);
    var scale = 1 / ds.scale;
    var corners = best.hex.map(function (p) { return [p[0] * scale, p[1] * scale]; });
    // 妥当性チェック: 画像外に大きくはみ出していない
    var ok = corners.every(function (p) {
      return p[0] > -0.15 * imageData.width && p[0] < 1.15 * imageData.width &&
        p[1] > -0.15 * imageData.height && p[1] < 1.15 * imageData.height;
    });
    if (!ok) confidence *= 0.3;
    return {
      corners: corners,
      confidence: confidence,
      method: 'contour',
      hexAreaRatio: ratio,
      hullPoints: hull.length
    };
  }

  // 画像が盤で埋まっている前提のフォールバック（手動調整の初期値）
  function fallbackCorners(imageData) {
    var cx = imageData.width / 2, cy = imageData.height / 2;
    var R = Math.min(imageData.width, imageData.height) * 0.42;
    var out = [];
    for (var k = 0; k < 6; k++) {
      var a = k * Math.PI / 3;
      out.push([cx + R * Math.cos(a), cy + R * Math.sin(a)]);
    }
    return out;
  }

  var api = {
    detect: detect,
    fallbackCorners: fallbackCorners,
    downsample: downsample,
    polygonArea: polygonArea,
    convexHull: convexHull
  };
  global.HexagoPhotoDetect = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
