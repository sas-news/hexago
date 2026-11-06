// ===== 写真復元: 6点→canonical→パッチ→分類 のオーケストレーション =====
// 依存: geom.js, features.js, rectify.js（model.js があれば優先して使う）
//   HexagoPhotoRecognize.analyze({imageData, borderCorners, size, convention}) -> result
//   HexagoPhotoRecognize.autoPick({imageData, borderCorners, sizes}) -> {best, results}
(function (global) {
  'use strict';

  var Geom = global.HexagoPhotoGeom;
  var Rect = global.HexagoPhotoRectify;
  if (!Geom && typeof require === 'function') Geom = require('./geom.js');
  if (!Rect && typeof require === 'function') Rect = require('./rectify.js');

  var CLASSES = ['empty', 'black', 'white', 'red', 'blue', 'green', 'yellow', 'purple'];
  var CLASS_COLORS = ['#d9b382', '#1a1a1a', '#f6f3ea', '#e53935', '#1e88e5', '#43a047', '#f0a000', '#9b2fcb'];

  // ---------- ヒューリスティック分類（モデル未ロード時のフォールバック） ----------
  // 特徴量の平均色 + ベースライン比 + リング/中心コントラストから素直に判定する。
  // 実写真で「石の存在は確実に分かるが色の境界が曖昧」なケースを想定した安全側の実装。
  function hueOf(f) {
    var h = Math.atan2(f[16], f[15]) / (2 * Math.PI);
    if (h < 0) h += 1;
    return h;
  }
  function gauss(x, mu, sigma) {
    var z = (x - mu) / sigma;
    return Math.exp(-0.5 * z * z);
  }
  // 円環上の角度差（0..0.5）
  function hueDist(a, b) {
    var d = Math.abs(a - b) % 1;
    return d > 0.5 ? 1 - d : d;
  }

  function heuristicProbs(f, baseline) {
    var p = new Float32Array(8);
    var base = baseline || [128, 128, 128];
    var r = f[0], g = f[5], b = f[10];
    var bl = 0.299 * base[0] / 255 + 0.587 * base[1] / 255 + 0.114 * base[2] / 255;
    var lum = 0.299 * r + 0.587 * g + 0.114 * b;
    var lr = Math.log((lum + 1e-3) / (bl + 1e-3)); // 明るさの対数比
    var hue = hueOf(f);
    var sat = f[17], val = f[18];
    var baseSat = 0;
    var bmax = Math.max(base[0], base[1], base[2]), bmin = Math.min(base[0], base[1], base[2]);
    if (bmax > 1) baseSat = (bmax - bmin) / bmax;
    var ring = 0.299 * f[19] + 0.587 * f[20] + 0.114 * f[21]; // 外周-中央
    var grad = f[27];
    var highlight = f[23];
    var radial = f[22];

    // 盤と同色に近いほど empty らしい（照明ムラを許容して幅を広めに取る）
    var sEmpty = 2.6 * gauss(lr, 0, 0.16) * gauss(sat, baseSat, 0.16) * gauss(ring, 0, 0.055);
    sEmpty += 0.5 * gauss(lr, 0, 0.28) * gauss(ring, 0, 0.10);

    // 石の存在感: 中心と外周の差 / 勾配 / 鏡面ハイライト
    var presence = Math.min(1, Math.abs(ring) / 0.10 * 0.6 + Math.min(1, grad / 0.16) * 0.25 + Math.min(1, highlight / 0.05) * 0.25);

    var sBlack = 2.9 * gauss(lr, -0.85, 0.35) * (val < 0.35 ? 1 : 0.25);
    var sWhite = 2.7 * gauss(lr, 0.55, 0.30) * gauss(sat, 0.06, 0.14) * (val > 0.55 ? 1 : 0.3);
    // 有彩色は色相で判定（盤の茶色=色相0.05-0.10/sat~0.2 と区別するため sat を強く見る）
    var coloredWeight = Math.max(0, Math.min(1, (sat - 0.28) / 0.22));
    var sRed = 2.6 * gauss(hueDist(hue, 0.00), 0, 0.055) * coloredWeight;
    var sBlue = 2.6 * gauss(hueDist(hue, 0.575), 0, 0.070) * coloredWeight;
    var sGreen = 2.6 * gauss(hueDist(hue, 0.345), 0, 0.080) * coloredWeight;
    var sYellow = 2.4 * gauss(hueDist(hue, 0.145), 0, 0.055) * Math.max(0, Math.min(1, (sat - 0.42) / 0.2));
    var sPurple = 2.6 * gauss(hueDist(hue, 0.780), 0, 0.080) * coloredWeight;

    var scores = [sEmpty, sBlack * presence, sWhite * presence, sRed * presence, sBlue * presence, sGreen * presence, sYellow * presence, sPurple * presence];
    var mx = -Infinity;
    for (var i = 0; i < 8; i++) if (scores[i] > mx) mx = scores[i];
    var sum = 0;
    for (i = 0; i < 8; i++) { p[i] = Math.exp((scores[i] - mx) * 2.2); sum += p[i]; }
    for (i = 0; i < 8; i++) p[i] /= sum;
    return p;
  }

  function modelReady() {
    var M = global.HexagoPhotoModel;
    if (!M || typeof M.predict !== 'function') return false;
    if (typeof M.isLoaded === 'function') return !!M.isLoaded();
    if (typeof M.ready === 'function') return !!M.ready();
    return false;
  }

  // モデルとヒューリスティックのアンサンブル。
  // - 学習済みモデルは合成データ（未知シナリオでも99%）に強い
  // - ヒューリスティックは実写真の色かぶり・木目盤に対する絶対色の判断に強い
  // 両方の確率を平均して、片方が外したときにもう片方が救う。
  var MODEL_WEIGHT = 0.5;
  var STRATEGY = 'cascade'; // 'cascade' | 'ensemble' | 'model' | 'heuristic'
  function strategy() {
    if (typeof global !== 'undefined' && typeof global.__hexagoPhotoStrategy === 'string') return global.__hexagoPhotoStrategy;
    return STRATEGY;
  }
  function modelWeight() {
    if (typeof global !== 'undefined' && typeof global.__hexagoPhotoModelWeight === 'number') {
      return Math.max(0, Math.min(1, global.__hexagoPhotoModelWeight));
    }
    return MODEL_WEIGHT;
  }
  function mixProbs(m, heur, w) {
    var out = new Float32Array(8);
    var sum = 0;
    for (var i = 0; i < 8; i++) {
      out[i] = w * m[i] + (1 - w) * heur[i];
      sum += out[i];
    }
    if (sum > 0) for (i = 0; i < 8; i++) out[i] /= sum;
    return out;
  }
  function ensembleProbs(f, baseline) {
    var heur = heuristicProbs(f, baseline);
    if (!modelReady()) return heur;
    var strat = strategy();
    if (strat === 'heuristic') return heur;
    var m = global.HexagoPhotoModel.predict(f);
    if (strat === 'model') return m;
    if (strat === 'ensemble') return mixProbs(m, heur, modelWeight());
    // cascade: ヒューリスティックが自信を持てた点はヒューリスティック、
    // 迷った点だけモデルとのアンサンブルに回す（実写真の安定性と合成域の汎化の両立）
    var h1 = 0, h2 = 0, hi = -1;
    for (var k = 0; k < 8; k++) {
      if (heur[k] > h1) { h2 = h1; h1 = heur[k]; hi = k; }
      else if (heur[k] > h2) h2 = heur[k];
    }
    var cfg = (typeof global !== 'undefined' && global.__hexagoPhotoCascade) || {};
    var minConf = typeof cfg.minConf === 'number' ? cfg.minConf : 0.50;
    var minMargin = typeof cfg.minMargin === 'number' ? cfg.minMargin : 0.14;
    var mixW = typeof cfg.w === 'number' ? cfg.w : 0.125;
    if (h1 >= minConf && (h1 - h2) >= minMargin) return heur;
    return mixProbs(m, heur, mixW);
  }

  function classifyFeatures(featuresList, baseline) {
    var useModel = modelReady();
    var out = featuresList.map(function (f) {
      var probs = ensembleProbs(f, baseline);
      var best = 0, conf = -1;
      for (var i = 0; i < probs.length; i++) { if (probs[i] > conf) { conf = probs[i]; best = i; } }
      var second = 0;
      for (i = 0; i < probs.length; i++) { if (i !== best && probs[i] > second) second = probs[i]; }
      return { cls: best, conf: conf, margin: conf - second, probs: probs, source: useModel ? 'ensemble' : 'heuristic' };
    });
    return out;
  }

  // 六角格子は60度回転対称なので、外枠6点の開始位置に6通りの解釈がある。
  // 写真の「上」が盤の「上」に来るよう、canonical の +x が画像の +x に写る並びを選ぶ。
  function uprightOrder(borderCorners, size, convention) {
    var L = Geom.layout(size);
    var best = null;
    for (var sh = 0; sh < 6; sh++) {
      var rot = borderCorners.slice(sh).concat(borderCorners.slice(0, sh));
      var lat = Geom.latticeCornersFromBorder(rot, size, convention);
      var H = Geom.homography(lat, L.corners);
      if (!H) continue;
      var Hi = Geom.inv3(H);
      if (!Hi) continue;
      var c = L.center;
      var p0 = Geom.apply(Hi, c[0], c[1]);
      var p1 = Geom.apply(Hi, c[0] + 50, c[1]);
      var ang = Math.atan2(p1[1] - p0[1], p1[0] - p0[0]);
      var score = Math.abs(ang);
      if (!best || score < best.angleAbs) best = { shift: sh, corners: rot, H: H, angleAbs: score, angle: ang };
    }
    return best;
  }

  // ---------- 高速ジオメトリスコア（自動チューニング用） ----------
  // canonical に変換せず、元画像から直接パッチをサンプリングして
  // ヒューリスティック分類の平均確信度を返す。サイズ・余白の探索用。
  function sampleRGB(data, w, h, x, y, out) {
    if (x < 0) x = 0; else if (x > w - 1) x = w - 1;
    if (y < 0) y = 0; else if (y > h - 1) y = h - 1;
    var x0 = x | 0, y0 = y | 0;
    var x1 = x0 + 1 >= w ? w - 1 : x0 + 1;
    var y1 = y0 + 1 >= h ? h - 1 : y0 + 1;
    var fx = x - x0, fy = y - y0;
    var i00 = (y0 * w + x0) * 4, i10 = (y0 * w + x1) * 4;
    var i01 = (y1 * w + x0) * 4, i11 = (y1 * w + x1) * 4;
    for (var c = 0; c < 3; c++) {
      var a = data[i00 + c] * (1 - fx) + data[i10 + c] * fx;
      var b = data[i01 + c] * (1 - fx) + data[i11 + c] * fx;
      out[c] = a * (1 - fy) + b * fy;
    }
    return out;
  }

  function quickScore(imageData, borderCorners, size, margin) {
    var L = Geom.layout(size);
    var lat = Geom.latticeCornersFromBorder(borderCorners, size, margin);
    var H = Geom.homography(lat, L.corners);
    if (!H) return -1;
    var Hi = Geom.inv3(H);
    if (!Hi) return -1;
    var data = imageData.data, w = imageData.width, h = imageData.height;
    var N = L.pts.length;
    var stride = Math.max(1, Math.round(N / 44));
    var idxs = [], k;
    for (var i = 0; i < N; i += stride) idxs.push(i);
    var side = 0.9 * L.cell;
    var patches = [], rings = [];
    var tmp = [0, 0, 0];
    for (k = 0; k < idxs.length; k++) {
      var p = L.pts[idxs[k]];
      var a = Geom.apply(Hi, p[0], p[1]);
      var bx = Geom.apply(Hi, p[0] + side, p[1]);
      var by = Geom.apply(Hi, p[0], p[1] + side);
      var sx = Math.hypot(bx[0] - a[0], bx[1] - a[1]);
      var sy = Math.hypot(by[0] - a[0], by[1] - a[1]);
      if (!(sx > 1) || !(sy > 1)) return -1;
      var patch = new Float32Array(16 * 16 * 3);
      for (var j = 0; j < 16; j++) {
        for (var ii = 0; ii < 16; ii++) {
          var x = a[0] + (ii - 7.5) / 16 * sx;
          var y = a[1] + (j - 7.5) / 16 * sy;
          sampleRGB(data, w, h, x, y, tmp);
          var o = (j * 16 + ii) * 3;
          patch[o] = tmp[0]; patch[o + 1] = tmp[1]; patch[o + 2] = tmp[2];
        }
      }
      patches.push(patch);
      // 外周リング（盤色推定用）
      var rs = [0, 0, 0], rc = 0;
      for (j = 0; j < 16; j++) {
        for (ii = 0; ii < 16; ii++) {
          if (!(ii < 2 || ii >= 14 || j < 2 || j >= 14)) continue;
          var o2 = (j * 16 + ii) * 3;
          rs[0] += patch[o2]; rs[1] += patch[o2 + 1]; rs[2] += patch[o2 + 2]; rc++;
        }
      }
      rings.push([rs[0] / rc, rs[1] / rc, rs[2] / rc]);
    }
    // ベースライン = リング色の中央値
    var med = [0, 1, 2].map(function (c) {
      var arr = rings.map(function (r) { return r[c]; }).sort(function (x, y) { return x - y; });
      return arr[arr.length >> 1];
    });
    var sum = 0;
    for (k = 0; k < patches.length; k++) {
      var f = global.HexagoPhotoFeatures.extract(patches[k], med);
      var probs = heuristicProbs(f, med);
      var mx = 0;
      for (var q = 0; q < probs.length; q++) if (probs[q] > mx) mx = probs[q];
      sum += mx;
    }
    return sum / patches.length;
  }

  // 盤面サイズと余白を自動調整する（石の位置に合う組み合わせを探索）
  function autoFit(imageData, borderCorners, opts) {
    opts = opts || {};
    var baseMargin = typeof opts.margin === 'number' ? opts.margin : (1 / Math.sqrt(3));
    var sizes = opts.sizes || [9, 13, 19, 25];
    var best = null, k;
    for (k = 0; k < sizes.length; k++) {
      var sc = quickScore(imageData, borderCorners, sizes[k], baseMargin);
      if (sc > 0 && (!best || sc > best.score)) best = { size: sizes[k], margin: baseMargin, score: sc };
    }
    if (!best) return null;
    // 余白: 粗い探索 → 細かい探索
    var coarse = [];
    for (var m = 0; m <= 1.001; m += 0.1) coarse.push(Math.round(m * 100) / 100);
    var bestM = { margin: best.margin, score: best.score };
    for (k = 0; k < coarse.length; k++) {
      var s2 = quickScore(imageData, borderCorners, best.size, coarse[k]);
      if (s2 > bestM.score) bestM = { margin: coarse[k], score: s2 };
    }
    for (var d = -0.1; d <= 0.101; d += 0.02) {
      var mm = Math.round((bestM.margin + d) * 100) / 100;
      if (mm < 0 || mm > 1.2) continue;
      var s3 = quickScore(imageData, borderCorners, best.size, mm);
      if (s3 > bestM.score) bestM = { margin: mm, score: s3 };
    }
    // 決まった余白でサイズをもう一度確認
    var finalSize = best.size;
    for (k = 0; k < sizes.length; k++) {
      var s4 = quickScore(imageData, borderCorners, sizes[k], bestM.margin);
      if (s4 > bestM.score) { finalSize = sizes[k]; }
    }
    return { size: finalSize, margin: bestM.margin, score: bestM.score };
  }

  // ---------- 1条件での解析 ----------
  function analyze(opts) {
    var imageData = opts.imageData;
    var size = opts.size | 0;
    var marginOpt = (typeof opts.margin === 'number') ? opts.margin : (opts.convention || 'honeycomb');
    var borderCorners = opts.borderCorners;
    var L = Geom.layout(size);
    var up = uprightOrder(borderCorners, size, marginOpt);
    if (!up) throw new Error('homography estimation failed');
    var H = up.H;
    var prep = Rect.prepare(imageData, H, size);
    // 格子は外枠（6隅）から決めたものを使う。微調整はUIのハンドル操作で行う。
    var ref = { dx: 0, dy: 0, ds: 1, dth: 0 };
    var side = 0.9 * L.cell;
    var feats = [];
    var patches = [];
    var ca = Math.cos(ref.dth || 0), sa = Math.sin(ref.dth || 0);
    var points = L.pts.map(function (p, i) {
      var ox = (p[0] - L.center[0]) * ref.ds, oy = (p[1] - L.center[1]) * ref.ds;
      var x = L.center[0] + ox * ca - oy * sa + ref.dx;
      var y = L.center[1] + ox * sa + oy * ca + ref.dy;
      var patch = Rect.patchAt(prep.canon, prep.W, x, y, side);
      patches.push(patch);
      feats.push(global.HexagoPhotoFeatures.extract(patch, prep.baseline));
      return { q: L.qr[i][0], r: L.qr[i][1], x: x, y: y };
    });
    var cls = classifyFeatures(feats, prep.baseline);
    points.forEach(function (pt, i) {
      pt.cls = cls[i].cls; pt.conf = cls[i].conf; pt.margin = cls[i].margin; pt.probs = cls[i].probs;
    });
    var score = 0;
    for (var i = 0; i < points.length; i++) score += points[i].conf;
    score /= points.length;
    return {
      size: size,
      convention: (typeof opts.margin === 'number') ? 'custom' : (opts.convention || 'honeycomb'),
      margin: (typeof opts.margin === 'number') ? opts.margin : null,
      H: H,
      cornerShift: up.shift,
      rotationDeg: up.angle * 180 / Math.PI,
      layout: L,
      baseline: prep.baseline,
      canon: prep.canon,
      features: feats,
      patches: patches,
      refine: ref,
      points: points,
      score: score,
      classSource: cls.length ? cls[0].source : 'heuristic'
    };
  }

  // ---------- 慣習・サイズの自動選択 ----------
  function autoPick(opts) {
    var sizes = opts.sizes || [9, 13, 19, 25];
    var conventions = opts.conventions || ['honeycomb', 'triangular'];
    var results = [];
    var best = null;
    for (var ci = 0; ci < conventions.length; ci++) {
      for (var si = 0; si < sizes.length; si++) {
        try {
          var r = analyze({
            imageData: opts.imageData,
            borderCorners: opts.borderCorners,
            size: sizes[si],
            convention: conventions[ci]
          });
          results.push({ size: r.size, convention: r.convention, score: r.score, result: r });
          if (!best || r.score > best.score) best = r;
        } catch (e) { /* skip */ }
      }
    }
    return { best: best, results: results };
  }

  // ---------- 結果をゲームの盤面配列へ ----------
  // labels: クラス番号 0..7 -> board[p]（1..6）+ 使用色パレット
  function toGameBoard(result) {
    var used = {};
    var labels = result.points.map(function (p) { return p.cls; });
    var count = 0;
    for (var i = 0; i < labels.length; i++) if (labels[i] > 0) used[labels[i]] = true;
    var classIds = Object.keys(used).map(Number).sort(function (a, b) { return a - b; });
    var map = {}; // classId -> player index
    for (var k = 0; k < classIds.length; k++) map[classIds[k]] = k + 1;
    // 2色（黒/白）だけなら必ず 黒=1, 白=2
    var board = labels.map(function (c) { return map[c] || 0; });
    var colors = {};
    var names = {};
    for (var j = 0; j < classIds.length; j++) {
      var cid = classIds[j], pi = map[cid];
      colors[pi] = { fill: CLASS_COLORS[cid], stroke: '#333333' };
      names[pi] = ({ 1: '黒', 2: '白', 3: '赤', 4: '青', 5: '緑', 6: '黄', 7: '紫' })[cid] || ('色' + cid);
    }
    return { board: board, labels: labels, playerCount: Math.max(2, classIds.length), colors: colors, names: names };
  }

  var api = {
    CLASSES: CLASSES,
    CLASS_COLORS: CLASS_COLORS,
    analyze: analyze,
    autoFit: autoFit,
    quickScore: quickScore,
    autoPick: autoPick,
    classifyFeatures: classifyFeatures,
    heuristicProbs: heuristicProbs,
    modelReady: modelReady,
    toGameBoard: toGameBoard
  };
  global.HexagoPhotoRecognize = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
