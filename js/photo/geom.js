// ===== 写真復元: 幾何（canonical レイアウト / 6点homography） =====
// アプリの盤ジオメトリ（core/geometry.js の build(n)）と同一の点順・座標系を使う。
// 依存なし・classic script。window.HexagoPhotoGeom として公開する。
(function (global) {
  'use strict';

  var SQ3 = Math.sqrt(3);
  var CANON_W = 1024;
  var CANON_PAD = 0.07 * CANON_W; // 71.68

  // size(9/13/19/25) -> canonical 画像上の点座標・格子6隅
  function layout(size) {
    var SIDE = (size + 1) / 2;
    var s = SIDE - 1;
    var cell = (CANON_W - 2 * CANON_PAD) / (2 * s);
    var cx = CANON_W / 2, cy = CANON_W / 2;
    var pts = [], qr = [];
    for (var r = -s; r <= s; r++) {
      for (var q = -s; q <= s; q++) {
        if (Math.abs(q + r) <= s) {
          pts.push([cx + cell * (q + r / 2), cy + cell * (r * 0.8660254037844386)]);
          qr.push([q, r]);
        }
      }
    }
    var cornerQR = [[s, 0], [0, s], [-s, s], [-s, 0], [0, -s], [s, -s]];
    var corners = cornerQR.map(function (c) {
      return [cx + cell * (c[0] + c[1] / 2), cy + cell * (c[1] * 0.8660254037844386)];
    });
    return {
      size: size, SIDE: SIDE, s: s, cell: cell, W: CANON_W, pad: CANON_PAD,
      center: [cx, cy], pts: pts, qr: qr, corners: corners
    };
  }

  // ---------- 3x3 行列ユーティリティ（行優先 length 9） ----------
  function mul3(A, B) {
    var C = new Array(9);
    for (var i = 0; i < 3; i++) {
      for (var j = 0; j < 3; j++) {
        C[i * 3 + j] = A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j];
      }
    }
    return C;
  }
  function inv3(m) {
    var a = m[0], b = m[1], c = m[2], d = m[3], e = m[4], f = m[5], g = m[6], h = m[7], i = m[8];
    var A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    var det = a * A + b * B + c * C;
    if (Math.abs(det) < 1e-12) return null;
    var id = 1 / det;
    return [
      A * id, -(b * i - c * h) * id, (b * f - c * e) * id,
      B * id, (a * i - c * g) * id, -(a * f - c * d) * id,
      C * id, -(a * h - b * g) * id, (a * e - b * d) * id
    ];
  }
  function apply3(m, x, y) {
    var w = m[6] * x + m[7] * y + m[8];
    if (Math.abs(w) < 1e-12) w = 1e-12;
    return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w];
  }

  // ---------- 6点対応の homography（正規化 DLT + 最小二乗） ----------
  function normalizePts(pts) {
    var n = pts.length, cx = 0, cy = 0, i;
    for (i = 0; i < n; i++) { cx += pts[i][0]; cy += pts[i][1]; }
    cx /= n; cy /= n;
    var mean = 0;
    for (i = 0; i < n; i++) mean += Math.hypot(pts[i][0] - cx, pts[i][1] - cy);
    mean /= n;
    var sc = mean > 1e-9 ? Math.SQRT2 / mean : 1;
    var T = [sc, 0, -sc * cx, 0, sc, -sc * cy, 0, 0, 1];
    var out = pts.map(function (p) { return [(p[0] - cx) * sc, (p[1] - cy) * sc]; });
    return { pts: out, T: T };
  }

  function solve8(A, b) {
    // 8x8 連立方程式（部分ピボット付きガウス消去）。A は 8x8 の行配列、b は 8。
    var n = 8, i, j, k;
    var M = [];
    for (i = 0; i < n; i++) { M.push(A[i].slice()); M[i].push(b[i]); }
    for (k = 0; k < n; k++) {
      var piv = k, best = Math.abs(M[k][k]);
      for (i = k + 1; i < n; i++) {
        if (Math.abs(M[i][k]) > best) { best = Math.abs(M[i][k]); piv = i; }
      }
      if (best < 1e-14) return null;
      if (piv !== k) { var tmp = M[k]; M[k] = M[piv]; M[piv] = tmp; }
      var d = M[k][k];
      for (j = k; j <= n; j++) M[k][j] /= d;
      for (i = 0; i < n; i++) {
        if (i === k) continue;
        var f = M[i][k];
        if (!f) continue;
        for (j = k; j <= n; j++) M[i][j] -= f * M[k][j];
      }
    }
    var x = new Array(n);
    for (i = 0; i < n; i++) x[i] = M[i][n];
    return x;
  }

  // srcPts -> dstPts の homography（3x3, 行優先）。点数は6点以上を想定。
  function homography(srcPts, dstPts) {
    if (!srcPts || !dstPts || srcPts.length !== dstPts.length || srcPts.length < 4) return null;
    var ns = normalizePts(srcPts), nd = normalizePts(dstPts);
    var AtA = [], Atb = [];
    for (var i = 0; i < 8; i++) { AtA.push(new Array(8).fill(0)); Atb.push(0); }
    function addRow(row, rhs) {
      for (var a = 0; a < 8; a++) {
        for (var b = 0; b < 8; b++) AtA[a][b] += row[a] * row[b];
        Atb[a] += row[a] * rhs;
      }
    }
    for (var k = 0; k < ns.pts.length; k++) {
      var x = ns.pts[k][0], y = ns.pts[k][1];
      var u = nd.pts[k][0], v = nd.pts[k][1];
      addRow([x, y, 1, 0, 0, 0, -u * x, -u * y], u);
      addRow([0, 0, 0, x, y, 1, -v * x, -v * y], v);
    }
    var h = solve8(AtA, Atb);
    if (!h) return null;
    var Hn = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
    // x_src = Ts^-1 * x_src_n, x_dst_n = Hn * x_src_n  =>  x_dst = Td^-1 * Hn * Ts * x_src
    var TdInv = inv3(nd.T);
    if (!TdInv) return null;
    var H = mul3(TdInv, mul3(Hn, ns.T));
    // 正規化（H[8]=1）
    if (Math.abs(H[8]) > 1e-12) {
      for (var m = 0; m < 9; m++) H[m] /= H[8];
    }
    return H;
  }

  // ---------- 盤外枠 -> 格子6隅 ----------
  // 実物の六角盤（ハニカム）は石=セル中心の格子が外枠より cell/√3 内側にある。
  // アプリから印刷した三角形格子の盤は外枠が格子の隅点を通る。
  var CONVENTIONS = {
    triangular: { k: function () { return 1; } },
    honeycomb: { k: function (s) { return s / (s + 1 / SQ3); } }
  };

  // margin: 数値なら「盤の外枠が格子六角形より何セル外側か」（実物=1/√3≈0.577, 印刷=0）。
  // 文字列なら従来の慣習名（honeycomb / triangular）。
  function latticeCornersFromBorder(borderCorners, size, margin) {
    var L = layout(size);
    var k;
    if (typeof margin === 'number' && isFinite(margin)) {
      k = L.s / (L.s + Math.max(0, margin));
    } else {
      var conv = CONVENTIONS[margin] || CONVENTIONS.honeycomb;
      k = conv.k(L.s);
    }
    var cx = 0, cy = 0, i;
    for (i = 0; i < 6; i++) { cx += borderCorners[i][0]; cy += borderCorners[i][1]; }
    cx /= 6; cy /= 6;
    if (k === 1) return borderCorners.map(function (p) { return [p[0], p[1]]; });
    return borderCorners.map(function (p) { return [cx + (p[0] - cx) * k, cy + (p[1] - cy) * k]; });
  }

  // 画像座標系で六角形の6隅（この順: 右, 右下, 左下, 左, 左上, 右上）
  function hexagonCornersFromCenter(cx, cy, R, rotDeg) {
    var rot = (rotDeg || 0) * Math.PI / 180;
    var out = [];
    for (var i = 0; i < 6; i++) {
      var a = rot + i * Math.PI / 3;
      out.push([cx + R * Math.cos(a), cy + R * Math.sin(a)]);
    }
    return out;
  }

  global.HexagoPhotoGeom = {
    CANON_W: CANON_W,
    CANON_PAD: CANON_PAD,
    SQ3: SQ3,
    layout: layout,
    homography: homography,
    apply: apply3,
    inv3: inv3,
    mul3: mul3,
    latticeCornersFromBorder: latticeCornersFromBorder,
    hexagonCornersFromCenter: hexagonCornersFromCenter,
    CONVENTIONS: CONVENTIONS
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.HexagoPhotoGeom;
})(typeof self !== 'undefined' ? self : this);
