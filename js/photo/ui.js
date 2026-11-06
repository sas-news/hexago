// ===== 写真復元: UI（撮影→6隅調整→読み取り→訂正→保存/対局） =====
// 依存: geom.js / features.js / rectify.js / recognize.js / detect.js / store.js（すべて classic script）
// 起動: ヘッダの 📷 ボタン（#btnOpenPhoto）
(function (global) {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var R = global.HexagoPhotoRecognize;
  var Gg = global.HexagoPhotoGeom;
  var D = global.HexagoPhotoDetect;
  var S = global.HexagoPhotoStore;

  var CLASS_COLORS = R.CLASS_COLORS;
  var CLASS_JA = ['空', '黒', '白', '赤', '青', '緑', '黄', '紫'];
  var SIZE_LIST = [9, 13, 19, 25];

  var st = {
    img: null, width: 0, height: 0, imageData: null, fileName: '',
    corners: null, autoConf: 0, autoMethod: '',
    size: 13, convention: 'honeycomb',
    result: null, labels: null, activeSize: 13,
    drag: -1, hover: -1, turn: 1, modelTried: false,
    palette: null, playerCount: 2, allColors: false
  };

  // ---------------- 画面切り替え ----------------
  function view(name) {
    var map = {
      step1: 'photoStep1', step2: 'photoStep2', step3: 'photoStep3', library: 'photoLibraryView'
    };
    Object.keys(map).forEach(function (k) {
      var el = $(map[k]);
      if (el) el.classList.toggle('hidden', k !== name);
    });
  }
  function err(msg) {
    var el = $('photoErr');
    if (!el) return;
    if (!msg) { el.classList.add('hidden'); el.textContent = ''; return; }
    el.textContent = msg;
    el.classList.remove('hidden');
  }
  var toastTimer = null;
  function toast(msg) {
    var el = $('photoToast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'photoToast';
      el.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#171717;color:#fff;padding:8px 16px;border-radius:999px;font-size:13px;z-index:100;transition:opacity .3s;pointer-events:none';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.opacity = '1';
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.style.opacity = '0'; }, 1800);
  }

  // ---------------- モデル（任意） ----------------
  function loadModel() {
    if (st.modelTried || !global.HexagoPhotoModel) return;
    st.modelTried = true;
    var M = global.HexagoPhotoModel;
    var url = './js/photo/model.json';
    fetch(url, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('model not found');
      return r.json();
    }).then(function (json) {
      // 学習済みフラグが無いもの（ダミー重み）は読み込まない
      if (!json || json.trained !== true) return null;
      return M.fromJSON ? M.fromJSON(json) : M.load(url);
    }).catch(function () { /* モデル無しでもヒューリスティックで動く */ });
  }

  // ---------------- 画像読み込み ----------------
  function loadImageFile(file) {
    err('');
    if (!file) return;
    st.fileName = file.name || 'photo';
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      URL.revokeObjectURL(url);
      setupImage(img);
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      err('画像を読み込めませんでした（対応していない形式かもしれません）。');
    };
    img.src = url;
  }

  function setupImage(img) {
    // 長辺 1600px に正規化（メモリと速度のため）
    var maxSide = 1600;
    var sc = Math.min(1, maxSide / Math.max(img.width, img.height));
    var w = Math.max(1, Math.round(img.width * sc));
    var h = Math.max(1, Math.round(img.height * sc));
    var cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    var ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    st.img = img;
    st.width = w; st.height = h;
    st.imageData = ctx.getImageData(0, 0, w, h);
    err('');
    autoDetect();
    view('step2');
    renderAdjust();
    updateDetectInfo();
  }

  function autoDetect() {
    var res = null;
    try { res = D.detect(st.imageData); } catch (e) { res = null; }
    if (res && res.corners) {
      st.corners = res.corners.map(function (p) { return [p[0], p[1]]; });
      st.autoConf = res.confidence;
      st.autoMethod = 'auto';
    } else {
      st.corners = D.fallbackCorners(st.imageData);
      st.autoConf = 0;
      st.autoMethod = 'fallback';
    }
  }

  function updateDetectInfo() {
    var el = $('photoDetectInfo');
    if (!el) return;
    var pct = Math.round((st.autoConf || 0) * 100);
    if (st.autoMethod === 'auto' && st.autoConf >= 0.5) {
      el.textContent = '自動検出: 信頼度 ' + pct + '%（違う場合は6つの丸をドラッグして合わせてください）';
      el.className = 'text-[11px] text-neutral-500';
    } else if (st.autoMethod === 'auto') {
      el.textContent = '自動検出が不確かです。6つの丸を盤の6隅にドラッグして合わせてください。';
      el.className = 'text-[11px] text-amber-600 font-bold';
    } else {
      el.textContent = '自動検出できませんでした。6つの丸をドラッグして盤の6隅に合わせてください。';
      el.className = 'text-[11px] text-amber-600 font-bold';
    }
  }

  // ---------------- 6隅調整キャンバス ----------------
  function fitCanvas(cv, w, h, maxCss) {
    var dpr = global.devicePixelRatio || 1;
    var cssW = Math.min(maxCss, cv.parentElement.clientWidth || maxCss);
    var cssH = cssW * h / w;
    cv.style.width = cssW + 'px';
    cv.style.height = cssH + 'px';
    cv.width = Math.round(cssW * dpr);
    cv.height = Math.round(cssH * dpr);
    return { cssW: cssW, cssH: cssH, dpr: dpr, scale: cssW / w };
  }

  function latticeImagePositions(corners, size, convention) {
    var L = Gg.layout(size);
    var latCorners = Gg.latticeCornersFromBorder(corners, size, convention);
    var H = Gg.homography(latCorners, L.corners); // image -> canonical
    if (!H) return null;
    var Hi = Gg.inv3(H); // canonical -> image
    var out = [];
    for (var i = 0; i < L.pts.length; i++) out.push(Gg.apply(Hi, L.pts[i][0], L.pts[i][1]));
    return out;
  }

  function renderAdjust() {
    if (!st.imageData) return;
    var cv = $('photoAdjust');
    var fit = fitCanvas(cv, st.width, st.height, 640);
    var ctx = cv.getContext('2d');
    ctx.setTransform(fit.dpr, 0, 0, fit.dpr, 0, 0);
    ctx.clearRect(0, 0, fit.cssW, fit.cssH);
    // 画像
    var tmp = document.createElement('canvas');
    tmp.width = st.width; tmp.height = st.height;
    tmp.getContext('2d').putImageData(st.imageData, 0, 0);
    ctx.drawImage(tmp, 0, 0, fit.cssW, fit.cssH);
    ctx.save();
    ctx.scale(fit.scale, fit.scale);
    // 格子プレビュー
    var pts = latticeImagePositions(st.corners, st.size, st.convention);
    if (pts) {
      var step = Math.max(1, Math.round(pts.length / 130));
      ctx.fillStyle = 'rgba(50, 220, 120, 0.95)';
      for (var i = 0; i < pts.length; i += step) {
        ctx.beginPath();
        ctx.arc(pts[i][0], pts[i][1], Math.max(2 / fit.scale, 3.5), 0, 7);
        ctx.fill();
      }
    }
    // 6隅ハンドル
    for (var k = 0; k < 6; k++) {
      var p = st.corners[k];
      ctx.beginPath();
      ctx.arc(p[0], p[1], Math.max(9 / fit.scale, 13), 0, 7);
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fill();
      ctx.lineWidth = 3 / fit.scale;
      ctx.strokeStyle = '#111';
      ctx.stroke();
      ctx.fillStyle = '#111';
      ctx.font = 'bold ' + Math.max(11 / fit.scale, 13) + 'px sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(k + 1), p[0], p[1]);
    }
    ctx.restore();
  }

  function canvasToImage(cv, clientX, clientY) {
    var rect = cv.getBoundingClientRect();
    var x = (clientX - rect.left) / rect.width * st.width;
    var y = (clientY - rect.top) / rect.height * st.height;
    return [x, y];
  }

  function onAdjustDown(e) {
    var cv = $('photoAdjust');
    var p = canvasToImage(cv, e.clientX, e.clientY);
    var rect = cv.getBoundingClientRect();
    var tol = Math.max(18, rect.width * 0.045) / rect.width * st.width;
    var best = -1, bd = tol;
    for (var k = 0; k < 6; k++) {
      var d = Math.hypot(st.corners[k][0] - p[0], st.corners[k][1] - p[1]);
      if (d < bd) { bd = d; best = k; }
    }
    st.drag = best;
    if (best >= 0) {
      e.preventDefault();
      if (cv.setPointerCapture) cv.setPointerCapture(e.pointerId);
    }
  }
  function onAdjustMove(e) {
    if (st.drag < 0) return;
    e.preventDefault();
    var cv = $('photoAdjust');
    var p = canvasToImage(cv, e.clientX, e.clientY);
    st.corners[st.drag] = [Math.max(-50, Math.min(st.width + 50, p[0])), Math.max(-50, Math.min(st.height + 50, p[1]))];
    renderAdjust();
  }
  function onAdjustUp() { st.drag = -1; }

  // ---------------- サイズ・慣習の選択 ----------------
  function buildSizeButtons() {
    var wrap = $('photoSizeBtns');
    if (!wrap || wrap.childElementCount) return;
    SIZE_LIST.forEach(function (size) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'opt';
      b.dataset.size = size;
      b.textContent = size + '路盤';
      b.onclick = function () {
        st.size = size;
        syncButtons();
        renderAdjust();
      };
      wrap.appendChild(b);
    });
    syncButtons();
  }
  function syncButtons() {
    [].forEach.call(document.querySelectorAll('#photoSizeBtns [data-size]'), function (b) {
      b.classList.toggle('on', Number(b.dataset.size) === st.size);
    });
    [].forEach.call(document.querySelectorAll('[data-photo-conv]'), function (b) {
      b.classList.toggle('on', b.dataset.photoConv === st.convention);
    });
  }

  // ---------------- 読み取り ----------------
  function read() {
    if (!st.imageData) return;
    var btn = $('btnPhotoRead');
    var prev = btn.textContent;
    btn.disabled = true;
    btn.textContent = '読み取り中…';
    setTimeout(function () {
      try {
        var res = R.analyze({
          imageData: st.imageData,
          borderCorners: st.corners,
          size: st.size,
          convention: st.convention
        });
        st.result = res;
        st.labels = res.points.map(function (p) { return p.cls; });
        st.activeSize = st.size;
        st.turn = 1;
        st.allColors = false;
        var allToggle = $('photoAllColors');
        if (allToggle) allToggle.checked = false;
        st.palette = suggestPalette(st.labels);
        st.playerCount = st.palette.length;
        view('step3');
        renderResult(true);
      } catch (e) {
        err('読み取りに失敗しました: ' + (e && e.message ? e.message : e));
        toast('読み取りに失敗しました');
      } finally {
        btn.disabled = false;
        btn.textContent = prev;
      }
    }, 30);
  }

  // ---------------- 結果キャンバス ----------------
  function usedClasses(labels) {
    var s = {};
    for (var i = 0; i < labels.length; i++) if (labels[i] > 0) s[labels[i]] = true;
    return Object.keys(s).map(Number).sort(function (a, b) { return a - b; });
  }

  // アプリの色順（黒,白,赤,青,緑,黄,紫）。人数の決定とパレット補充に使う。
  var STANDARD_ORDER = [1, 2, 3, 4, 5, 6, 7];

  function classCounts(labels) {
    var counts = [0, 0, 0, 0, 0, 0, 0, 0];
    for (var i = 0; i < labels.length; i++) counts[labels[i]]++;
    return counts;
  }

  // 検出した色からパレット（= 対局に参加する色）を推定する。
  // 1点だけ出た色は誤検出の可能性が高いので、2点以上ある色を優先する。
  function suggestPalette(labels) {
    var counts = classCounts(labels);
    var present = [];
    for (var c = 1; c < 8; c++) if (counts[c] >= 2) present.push(c);
    if (!present.length) {
      for (c = 1; c < 8; c++) if (counts[c] >= 1) present.push(c);
    }
    if (!present.length) return [1, 2];
    var n = Math.max(2, Math.min(6, present.length));
    var palette = present.slice(0, n);
    for (var k = 0; k < STANDARD_ORDER.length && palette.length < n; k++) {
      if (palette.indexOf(STANDARD_ORDER[k]) < 0) palette.push(STANDARD_ORDER[k]);
    }
    return palette.sort(function (a, b) { return a - b; });
  }

  // 人数の変更（増やすと色を補充、減らすと出現数の少ない色から外す）
  function setPlayerCount(n) {
    n = Math.max(2, Math.min(6, n | 0));
    var palette = (st.palette || [1, 2]).slice();
    if (n > palette.length) {
      for (var k = 0; k < STANDARD_ORDER.length && palette.length < n; k++) {
        if (palette.indexOf(STANDARD_ORDER[k]) < 0) palette.push(STANDARD_ORDER[k]);
      }
    } else if (n < palette.length) {
      var counts = st.labels ? classCounts(st.labels) : [0, 0, 0, 0, 0, 0, 0, 0];
      while (palette.length > n) {
        var worst = 0;
        for (var i = 1; i < palette.length; i++) {
          var ci = palette[i], cw = palette[worst];
          if (counts[ci] < counts[cw] || (counts[ci] === counts[cw] && ci > cw)) worst = i;
        }
        palette.splice(worst, 1);
      }
    }
    st.palette = palette;
    st.playerCount = palette.length;
  }

  // タップ時に選べる色。通常はパレットのみ、「全色から選ぶ」ONなら残りの色も
  // （最大6人なので、6色を超えない範囲で）選べる。
  function allowedColors() {
    var out = (st.palette || [1, 2]).slice();
    if (!st.allColors) return out;
    for (var k = 0; k < STANDARD_ORDER.length && out.length < 6; k++) {
      if (out.indexOf(STANDARD_ORDER[k]) < 0) out.push(STANDARD_ORDER[k]);
    }
    return out;
  }

  function outOfPaletteCount() {
    if (!st.palette || !st.labels) return 0;
    var n = 0;
    for (var i = 0; i < st.labels.length; i++) {
      if (st.labels[i] > 0 && st.palette.indexOf(st.labels[i]) < 0) n++;
    }
    return n;
  }

  function resultGeometry() {
    var res = st.result;
    var L = res.layout;
    return { L: L, cell: L.cell, W: L.W };
  }

  function renderResult(resetScroll) {
    var res = st.result;
    if (!res) return;
    var cv = $('photoResult');
    var W = res.layout.W;
    var fit = fitCanvas(cv, W, W, 560);
    var ctx = cv.getContext('2d');
    ctx.setTransform(fit.dpr, 0, 0, fit.dpr, 0, 0);
    // canonical 画像
    var id = ctx.createImageData(W, W);
    var canon = res.canon;
    for (var i = 0, j = 0; i < W * W; i++, j += 4) {
      id.data[j] = canon[i * 3];
      id.data[j + 1] = canon[i * 3 + 1];
      id.data[j + 2] = canon[i * 3 + 2];
      id.data[j + 3] = 255;
    }
    var tmp = document.createElement('canvas');
    tmp.width = W; tmp.height = W;
    tmp.getContext('2d').putImageData(id, 0, 0);
    ctx.drawImage(tmp, 0, 0, fit.cssW, fit.cssH);
    // 石
    var scale = fit.cssW / W;
    var r = res.layout.cell * 0.44 * scale;
    for (var k = 0; k < res.points.length; k++) {
      var p = res.points[k];
      var cls = st.labels[k];
      var x = p.x * scale, y = p.y * scale;
      if (cls > 0) {
        ctx.beginPath();
        ctx.arc(x, y, r, 0, 7);
        ctx.fillStyle = CLASS_COLORS[cls];
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(0,0,0,0.45)';
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.arc(x, y, 2, 0, 7);
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        ctx.fill();
      }
      // 自信が低い点を強調（クラス間の差が小さい点）
      if ((p.margin != null ? p.margin : p.conf) < 0.10 || p.conf < 0.42) {
        ctx.beginPath();
        ctx.arc(x, y, r * 1.12, 0, 7);
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = '#ffb300';
        ctx.stroke();
      }
      if (k === st.hover) {
        ctx.beginPath();
        ctx.arc(x, y, r * 1.25, 0, 7);
        ctx.lineWidth = 2;
        ctx.strokeStyle = 'rgba(80,200,255,0.95)';
        ctx.stroke();
      }
    }
    renderCounts();
    renderTurnSelect();
    if (resetScroll) cv.scrollIntoView({ block: 'nearest' });
  }

  function renderCounts() {
    var el = $('photoCounts');
    if (!el) return;
    var counts = classCounts(st.labels);
    var low = 0;
    for (var i = 0; i < st.result.points.length; i++) {
      var pt = st.result.points[i];
      if ((pt.margin != null ? pt.margin : pt.conf) < 0.10 || pt.conf < 0.42) low++;
    }
    var html = ['<span class="opacity-60">空 <strong>' + counts[0] + '</strong></span>'];
    // 参加プレイヤーの色（パレット）を先に、1P..NP の順で表示
    (st.palette || []).forEach(function (c, idx) {
      html.push('<span class="inline-flex items-center gap-1"><span class="dot" style="background:' + CLASS_COLORS[c] + ';border-color:#333"></span>' + CLASS_JA[c] + ' <strong>' + counts[c] + '</strong><span class="opacity-50">' + (idx + 1) + 'P</span></span>');
    });
    // パレット外の色（人数に入っていない色）は注意表示
    var stray = [];
    for (var c = 1; c < 8; c++) {
      if (!counts[c]) continue;
      if ((st.palette || []).indexOf(c) >= 0) continue;
      stray.push(CLASS_JA[c] + ' ' + counts[c] + '点');
    }
    if (stray.length) {
      html.push('<span class="text-amber-700 font-bold">未使用色: ' + stray.join(' / ') + '（空点扱い・タップで修正）</span>');
    }
    el.innerHTML = html.join('');
    if (low) el.innerHTML += '<span class="text-amber-600 font-bold">要確認 ' + low + '点</span>';
    var hint = $('photoColorHint');
    if (hint) {
      hint.textContent = st.allColors
        ? '全色モード: 未使用の色を選ぶとプレイヤーとして追加されます（最大6人）'
        : 'タップで切り替わるのは「空」と参加中の色だけです（全色ボタンで拡張可）';
    }
  }

  function renderTurnSelect() {
    var sel = $('photoTurn');
    if (!sel) return;
    var pc = Math.max(2, Math.min(6, st.playerCount || 2));
    var opts = '';
    for (var p = 1; p <= pc; p++) {
      opts += '<option value="' + p + '"' + (p === st.turn ? ' selected' : '') + '>' + p + 'P</option>';
    }
    sel.innerHTML = opts;
    var pcSel = $('photoPlayerCount');
    if (pcSel) {
      if (!pcSel.childElementCount) {
        for (var n = 2; n <= 6; n++) {
          var o = document.createElement('option');
          o.value = n;
          o.textContent = n + '人';
          pcSel.appendChild(o);
        }
      }
      pcSel.value = String(pc);
    }
    var lib = $('photoLibCount');
    if (lib) lib.textContent = S.list().length;
  }

  // タップでクラスを巡回（空 → 参加中の色 → …）。全色モードでは残りの色も選べる。
  function cycleAt(idx) {
    var colors = allowedColors();
    var order = [0].concat(colors);
    var cur = order.indexOf(st.labels[idx]);
    // 現在の色が候補に無い場合は空から始める
    var next = order[(cur + 1) % order.length];
    if (next > 0 && st.palette.indexOf(next) < 0) {
      // 全色モードで未使用の色を選んだ → プレイヤーとして追加
      if (st.palette.length < 6) {
        st.palette.push(next);
        st.playerCount = st.palette.length;
        toast(CLASS_JA[next] + 'をプレイヤーに追加しました（' + st.palette.length + '人）');
      }
    }
    st.labels[idx] = next;
    renderResult();
  }

  function onResultPointer(e) {
    var res = st.result;
    if (!res) return;
    var cv = $('photoResult');
    var rect = cv.getBoundingClientRect();
    var W = res.layout.W;
    var x = (e.clientX - rect.left) / rect.width * W;
    var y = (e.clientY - rect.top) / rect.height * W;
    var best = -1, bd = res.layout.cell * 0.55;
    for (var i = 0; i < res.points.length; i++) {
      var d = Math.hypot(res.points[i].x - x, res.points[i].y - y);
      if (d < bd) { bd = d; best = i; }
    }
    if (best < 0) return;
    if (e.type === 'click') { cycleAt(best); snd && snd.click && snd.click(); }
    else { st.hover = best; renderResult(); }
  }

  // ---------------- 保存・対局・ライブラリ ----------------
  function buildEntry() {
    var res = st.result;
    var labels = st.labels.slice();
    var palette = (st.palette && st.palette.length) ? st.palette.slice() : suggestPalette(labels);
    var pc = Math.max(2, Math.min(6, palette.length));
    // パレットの色 → プレイヤー番号（パレットの並び順がそのまま 1P,2P,...）
    var slot = {};
    palette.forEach(function (c, i) { slot[c] = i + 1; });
    var board = labels.map(function (c) { return (c > 0 && slot[c]) ? slot[c] : 0; });
    var colors = {}, names = {};
    palette.forEach(function (c, i) {
      colors[i + 1] = { fill: CLASS_COLORS[c], stroke: '#333333' };
      names[i + 1] = CLASS_JA[c];
    });
    var dropped = 0;
    for (var i = 0; i < labels.length; i++) if (labels[i] > 0 && !slot[labels[i]]) dropped++;
    // 手番を有効なプレイヤーに丸める
    var turn = Math.min(pc, Math.max(1, st.turn || 1));
    var name = (st.fileName || '写真').replace(/\.[^.]+$/, '');
    return {
      name: name + '（' + res.size + '路）',
      size: res.size,
      playerCount: pc,
      board: board,
      colors: colors,
      names: names,
      labels: labels,
      turn: turn,
      meta: {
        convention: res.convention,
        confidence: +res.score.toFixed(4),
        lowConf: res.points.filter(function (p) { return p.conf < 0.55; }).length,
        source: st.fileName,
        cellPx: res.layout.cell,
        rotationDeg: res.rotationDeg || 0,
        palette: palette.slice(),
        droppedPoints: dropped
      },
      thumb: makeThumb(res, labels)
    };
  }

  function makeThumb(res, labels) {
    var size = 160, W = res.layout.W;
    var cv = document.createElement('canvas');
    cv.width = size; cv.height = size;
    var ctx = cv.getContext('2d');
    ctx.fillStyle = '#d9b382';
    ctx.beginPath();
    var L = res.layout;
    var s = size / W;
    ctx.fillRect(0, 0, size, size);
    // 罫線
    ctx.strokeStyle = 'rgba(90,70,50,0.55)';
    ctx.lineWidth = 1;
    for (var i = 0; i < res.points.length; i++) {
      var p = res.points[i];
    }
    ctx.beginPath();
    var qr = L.qr;
    for (var k = 0; k < qr.length; k++) {
      var x = L.pts[k][0], y = L.pts[k][1];
    }
    // 六角形の枠
    ctx.beginPath();
    for (var c = 0; c < 6; c++) {
      var cc = L.corners[c];
      if (c === 0) ctx.moveTo(cc[0] * s, cc[1] * s); else ctx.lineTo(cc[0] * s, cc[1] * s);
    }
    ctx.closePath();
    ctx.stroke();
    var r = L.cell * 0.42 * s;
    for (var j = 0; j < res.points.length; j++) {
      var cls = labels[j];
      if (!cls) continue;
      ctx.beginPath();
      ctx.arc(res.points[j].x * s, res.points[j].y * s, r, 0, 7);
      ctx.fillStyle = CLASS_COLORS[cls];
      ctx.fill();
    }
    return cv.toDataURL('image/png');
  }

  function doSave() {
    try {
      var e = buildEntry();
      var saved = S.save(e);
      toast('保存しました（' + saved.size + '路 / ' + saved.playerCount + '人）');
      renderTurnSelect();
    } catch (e2) {
      toast('保存できませんでした');
    }
  }

  function applyToGame(entry) {
    if (!entry || !entry.board) return;
    try {
      // 既存の対局状態を置き換える
      playerCount = Math.max(2, Math.min(6, entry.playerCount || 2));
      seats = [0, 'human', 'human', 'human', 'human', 'human', 'human'];
      for (var p = 1; p <= playerCount; p++) seats[p] = 'human';
      pendingSize = entry.size;
      mode = 'local';
      onlineAI = false;
      boardView = 'host';
      build(entry.size);
      G = newG(entry.size);
      G.board = entry.board.slice();
      G.turn = Math.min(playerCount, Math.max(1, entry.turn || 1));
      G.photoColors = entry.colors || null;
      G.photoNames = entry.names || null;
      G.phase = 'playing';
      G.over = false;
      G.result = null;
      G.last = -1;
      G.passes = 0;
      G.dead = [];
      G.damage = Array(playerCount + 1).fill(0);
      G.out = Array(playerCount + 1).fill(false);
      G.hist = [];
      G.seen = [hash(G.board)];
      setSeen();
      closeModal($('photoModal'));
      $('setModal').classList.add('hidden');
      $('resModal').classList.add('hidden');
      syncSettings();
      resizeCanvas();
      updateUI();
      save();
      toast('写真の局面を読み込みました');
    } catch (e) {
      toast('局面の読み込みに失敗しました');
    }
  }

  // ---------------- ライブラリ ----------------
  function showLibrary() {
    view('library');
    renderLibrary();
  }
  function renderLibrary() {
    var list = S.list();
    var wrap = $('photoLibList');
    if (!wrap) return;
    wrap.innerHTML = '';
    if (!list.length) {
      wrap.innerHTML = '<p class="text-sm text-neutral-500 text-center py-6">保存した局面はまだありません。</p>';
      return;
    }
    list.forEach(function (e) {
      var row = document.createElement('div');
      row.className = 'flex items-center gap-3 p-2 border border-neutral-200 rounded-xl';
      var img = document.createElement('img');
      img.src = e.thumb || '';
      img.alt = '';
      img.className = 'w-14 h-14 rounded-lg bg-neutral-100 object-cover shrink-0';
      var info = document.createElement('div');
      info.className = 'flex-1 min-w-0 flex flex-col';
      var date = new Date(e.createdAt || Date.now());
      info.innerHTML = '<span class="text-sm font-bold truncate">' + escapeHtml(e.name || '局面') + '</span>' +
        '<span class="text-[11px] text-neutral-500">' + e.size + '路 / ' + (e.playerCount || 2) + '人 / ' + date.toLocaleString('ja-JP') + '</span>';
      var btns = document.createElement('div');
      btns.className = 'flex flex-col gap-1 shrink-0';
      var b1 = document.createElement('button');
      b1.className = 'px-2 py-1 text-[11px] font-bold bg-neutral-900 text-white rounded-lg';
      b1.textContent = '対局';
      b1.onclick = function () { applyToGame(e); };
      var b2 = document.createElement('button');
      b2.className = 'px-2 py-1 text-[11px] border border-neutral-300 rounded-lg';
      b2.textContent = '削除';
      b2.onclick = function () {
        if (!global.confirm('この局面を削除しますか？')) return;
        S.remove(e.id);
        renderLibrary();
      };
      btns.appendChild(b1); btns.appendChild(b2);
      row.appendChild(img); row.appendChild(info); row.appendChild(btns);
      wrap.appendChild(row);
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  function doExport() {
    try {
      var txt = S.exportAll();
      var blob = new Blob([txt], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'hexago-photo-positions.json';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      toast('JSONを書き出しました');
    } catch (e) { toast('書き出しに失敗しました'); }
  }

  // ---------------- 起動・配線 ----------------
  function reset() {
    st.result = null; st.labels = null; st.drag = -1; st.hover = -1;
    st.corners = null; st.imageData = null; st.img = null; st.fileName = '';
    st.palette = null; st.playerCount = 2; st.allColors = false;
    st.autoConf = 0; st.autoMethod = '';
    err('');
    var f = $('photoFile'); if (f) f.value = '';
  }

  function open() {
    reset();
    view('step1');
    buildSizeButtons();
    syncButtons();
    renderTurnSelect();
    $('photoModal').classList.remove('hidden');
    loadModel();
  }

  function init() {
    var btn = $('btnOpenPhoto');
    if (btn) btn.onclick = open;
    var close = $('btnClosePhoto');
    if (close) close.onclick = function () { closeModal($('photoModal')); };
    var file = $('photoFile');
    if (file) file.onchange = function () { loadImageFile(file.files && file.files[0]); };
    var sample = $('btnPhotoSample');
    if (sample) sample.onclick = function () {
      fetch('./dev/photo/testdata/IMG_0252.jpg').then(function (r) { return r.blob(); }).then(function (b) {
        var f = new File([b], 'sample.jpg', { type: b.type || 'image/jpeg' });
        loadImageFile(f);
      }).catch(function () { err('サンプル画像を読み込めませんでした。'); });
    };
    [].forEach.call(document.querySelectorAll('[data-photo-conv]'), function (b) {
      b.onclick = function () {
        st.convention = b.dataset.photoConv;
        syncButtons();
        renderAdjust();
      };
    });
    var redetect = $('btnPhotoRedetect');
    if (redetect) redetect.onclick = function () { autoDetect(); renderAdjust(); updateDetectInfo(); };
    var readBtn = $('btnPhotoRead');
    if (readBtn) readBtn.onclick = read;
    var cvA = $('photoAdjust');
    if (cvA) {
      cvA.addEventListener('pointerdown', onAdjustDown);
      cvA.addEventListener('pointermove', function (e) { onAdjustMove(e); });
      cvA.addEventListener('pointerup', onAdjustUp);
      cvA.addEventListener('pointercancel', onAdjustUp);
    }
    var cvR = $('photoResult');
    if (cvR) {
      cvR.addEventListener('click', onResultPointer);
      cvR.addEventListener('pointermove', function (e) {
        var res = st.result; if (!res) return;
        var rect = cvR.getBoundingClientRect();
        var W = res.layout.W;
        var x = (e.clientX - rect.left) / rect.width * W;
        var y = (e.clientY - rect.top) / rect.height * W;
        var best = -1, bd = res.layout.cell * 0.55;
        for (var i = 0; i < res.points.length; i++) {
          var d = Math.hypot(res.points[i].x - x, res.points[i].y - y);
          if (d < bd) { bd = d; best = i; }
        }
        if (best !== st.hover) { st.hover = best; renderResult(); }
      });
      cvR.addEventListener('pointerleave', function () { st.hover = -1; renderResult(); });
    }
    var pcSel = $('photoPlayerCount');
    if (pcSel) pcSel.onchange = function () {
      setPlayerCount(Number(pcSel.value));
      if (st.turn > st.playerCount) st.turn = st.playerCount;
      renderResult();
    };
    var allToggle = $('photoAllColors');
    if (allToggle) allToggle.onchange = function () {
      st.allColors = !!allToggle.checked;
      renderResult();
    };
    var back = $('btnPhotoBack');
    if (back) back.onclick = function () { view('step2'); renderAdjust(); };
    var saveBtn = $('btnPhotoSave');
    if (saveBtn) saveBtn.onclick = doSave;
    var play = $('btnPhotoPlay');
    if (play) play.onclick = function () { applyToGame(buildEntry()); };
    var lib = $('btnPhotoLibrary');
    if (lib) lib.onclick = showLibrary;
    var exp = $('btnPhotoExport');
    if (exp) exp.onclick = doExport;
    var imp = $('btnPhotoLibImport');
    if (imp) imp.onclick = function () { $('photoLibFile').click(); };
    var libFile = $('photoLibFile');
    if (libFile) libFile.onchange = function () {
      var f = libFile.files && libFile.files[0];
      if (!f) return;
      var rd = new FileReader();
      rd.onload = function () {
        try {
          var n = S.importJSON(String(rd.result));
          toast(n + '件を読み込みました');
          renderLibrary();
        } catch (e) { toast('読み込みに失敗しました'); }
      };
      rd.readAsText(f);
      libFile.value = '';
    };
    var libBack = $('btnPhotoLibBack');
    if (libBack) libBack.onclick = function () { view(st.result ? 'step3' : 'step1'); if (st.result) renderResult(); };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  global.HexagoPhotoUI = {
    open: open,
    close: function () { closeModal($('photoModal')); },
    state: function () {
      return {
        size: st.size, convention: st.convention, hasImage: !!st.imageData,
        result: !!st.result, labels: st.labels ? st.labels.slice() : null,
        corners: st.corners, turn: st.turn
      };
    }
  };
  // テストフック
  global.__hexagoPhoto = {
    open: open,
    state: function () {
      return {
        size: st.size, convention: st.convention, hasImage: !!st.imageData,
        result: !!st.result, labels: st.labels ? st.labels.slice() : null,
        corners: st.corners, turn: st.turn,
        palette: st.palette ? st.palette.slice() : null,
        playerCount: st.playerCount, allColors: st.allColors,
        allowed: allowedColors()
      };
    },
    cycle: function (i) { cycleAt(i); return this.state(); },
    setPlayerCount: function (n) { setPlayerCount(n); renderResult(); return this.state(); },
    setAllColors: function (on) { st.allColors = !!on; var cb = $('photoAllColors'); if (cb) cb.checked = !!on; renderResult(); return this.state(); },
    loadImageData: function (imageData) { setupImageFromData(imageData); },
    read: function () { read(); },
    save: doSave,
    play: function () { applyToGame(buildEntry()); },
    entry: function () { return buildEntry(); },
    list: function () { return S.list(); }
  };

  function setupImageFromData(imageData) {
    st.width = imageData.width; st.height = imageData.height;
    st.imageData = imageData;
    st.img = null;
    st.fileName = 'testdata.jpg';
    autoDetect();
    view('step2');
    renderAdjust();
    updateDetectInfo();
  }
})(typeof self !== 'undefined' ? self : this);
