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
    size: 13, margin: 0.577,
    result: null, labels: null, origLabels: null, activeSize: 13,
    drag: -1, hover: -1, turn: 1, modelTried: false,
    palette: null, playerCount: 2, allColors: false, pickPalette: null, outColors: {},
    viewMode: 'ring', manual: {}, calibrated: false
  };

  // ---------------- 画面切り替え ----------------
  function view(name) {
    var map = {
      step2: 'photoStep2', step3: 'photoStep3', library: 'photoLibraryView'
    };
    Object.keys(map).forEach(function (k) {
      var el = $(map[k]);
      if (el) el.classList.toggle('hidden', k !== name);
    });
    var titleEl = $('photoModalTitle');
    if (titleEl) titleEl.textContent = name === 'library' ? '保存した盤面' : '写真から盤面を復元';
  }
  function err(msg) {
    var el = $('photoErr');
    if (!el) { if (msg) toast(msg); return; }
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
    var embedded = document.getElementById('photo-model-json');
    if (embedded && embedded.textContent) {
      try {
        var embeddedJson = JSON.parse(embedded.textContent);
        if (embeddedJson && embeddedJson.trained === true && M.fromJSON) {
          M.fromJSON(embeddedJson);
          return;
        }
      } catch (e) { /* fall through to fetch */ }
    }
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
  function preparePhotoModal() {
    reset();
    st.libraryDirect = false;
    buildSizeButtons();
    syncButtons();
    renderTurnSelect();
    syncLibCountBadges();
    loadModel();
  }
  function loadImageFile(file) {
    if (!file) return;
    preparePhotoModal();
    st.fileName = file.name || 'photo';
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      URL.revokeObjectURL(url);
      if (typeof closeModal === 'function') closeModal($('recordModal'));
      $('photoModal').classList.remove('hidden');
      if (typeof autoPass === 'function' && autoPass()) autoPass().update();
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
    setTimeout(autoFitBoard, 60);
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
  function fitCanvas(cv, w, h, maxCss, heightFrac) {
    var dpr = global.devicePixelRatio || 1;
    var parentW = (cv.parentElement && cv.parentElement.clientWidth) || maxCss;
    var vhLimit = (global.innerHeight || 900) * (heightFrac || 0.42) * (w / h);
    var cssW = Math.min(maxCss, parentW, vhLimit);
    var cssH = cssW * h / w;
    cv.style.width = cssW + 'px';
    cv.style.height = cssH + 'px';
    cv.width = Math.round(cssW * dpr);
    cv.height = Math.round(cssH * dpr);
    return { cssW: cssW, cssH: cssH, dpr: dpr, scale: cssW / w };
  }

  function latticeImagePositions(corners, size, margin) {
    var L = Gg.layout(size);
    var latCorners = Gg.latticeCornersFromBorder(corners, size, margin);
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
    var fit = fitCanvas(cv, st.width, st.height, 640, 0.44);
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
    var pts = latticeImagePositions(st.corners, st.size, st.margin);
    if (pts) {
      // 全点を描く（間引くと格子ではなく斜め縞に見えてしまう）。点が多い盤は小さく描く。
      var dotR = Math.max(1.6 / fit.scale, pts.length > 200 ? 2.2 : 3.2);
      ctx.fillStyle = 'rgba(50, 220, 120, 0.95)';
      for (var i = 0; i < pts.length; i++) {
        ctx.beginPath();
        ctx.arc(pts[i][0], pts[i][1], dotR, 0, 7);
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
  function onAdjustUp() {
    if (st.drag >= 0) scheduleFitScore();
    st.drag = -1;
  }

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
        scheduleFitScore();
      };
      wrap.appendChild(b);
    });
    syncButtons();
  }
  function syncButtons() {
    [].forEach.call(document.querySelectorAll('#photoSizeBtns [data-size]'), function (b) {
      b.classList.toggle('on', Number(b.dataset.size) === st.size);
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
          margin: st.margin
        });
        st.result = res;
        st.labels = res.points.map(function (p) { return p.cls; });
        st.origLabels = st.labels.slice();
        st.manual = {};
        st.calibrated = false;
        st.viewMode = 'ring';
        st.activeSize = st.size;
        st.turn = 1;
        st.allColors = false;
        st.pickPalette = null;
        var allToggle = $('photoAllColors');
        if (allToggle) allToggle.checked = false;
        st.palette = suggestPalette(st.labels);
        st.playerCount = st.palette.length;
        st.outColors = {};
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

  function manualCount() {
    var n = 0;
    if (!st.manual) return 0;
    for (var k in st.manual) if (st.manual[k]) n++;
    return n;
  }

  function syncStep3Controls() {
    var btns = document.querySelectorAll('#photoViewBtns [data-photo-view]');
    [].forEach.call(btns, function (b) {
      var on = b.dataset.photoView === st.viewMode;
      b.classList.toggle('bg-neutral-900', on);
      b.classList.toggle('text-white', on);
      b.classList.toggle('bg-white', !on);
      b.classList.toggle('text-neutral-700', !on);
      b.setAttribute('aria-pressed', String(on));
    });
    var wrap = $('photoCanvasWrap');
    var bWrap = $('photoBoardWrap');
    if (wrap) {
      wrap.classList.toggle('grid-cols-2', st.viewMode === 'split');
      wrap.classList.toggle('grid-cols-1', st.viewMode !== 'split');
    }
    if (bWrap) {
      bWrap.classList.toggle('hidden', st.viewMode !== 'split');
      bWrap.classList.toggle('flex', st.viewMode === 'split');
    }
    var mc = manualCount();
    var calBtn = $('btnPhotoCalibrate');
    if (calBtn) {
      calBtn.disabled = mc === 0;
      calBtn.textContent = mc > 0 ? ('修正した石で自動調整 (' + mc + '点)') : '修正した石で自動調整';
    }
    var rstBtn = $('btnPhotoResetRead');
    if (rstBtn) rstBtn.classList.toggle('hidden', mc === 0 && !st.calibrated);
  }

  function renderBoardPreview() {
    var res = st.result;
    var cv = $('photoBoardPreview');
    if (!res || !cv || st.viewMode !== 'split') return;
    var W = res.layout.W;
    var fit = fitCanvas(cv, W, W, 320, 0.36);
    var ctx = cv.getContext('2d');
    ctx.setTransform(fit.dpr, 0, 0, fit.dpr, 0, 0);
    var scale = fit.cssW / W;
    // 盤面背景＋外枠＋格子線
    ctx.fillStyle = '#d9b382';
    ctx.fillRect(0, 0, fit.cssW, fit.cssH);
    var L = res.layout;
    ctx.beginPath();
    for (var c = 0; c < 6; c++) {
      var cc = L.corners[c];
      if (c === 0) ctx.moveTo(cc[0] * scale, cc[1] * scale);
      else ctx.lineTo(cc[0] * scale, cc[1] * scale);
    }
    ctx.closePath();
    ctx.strokeStyle = 'rgba(90,60,30,0.65)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // 格子線（近傍6方向）
    var qrMap = {};
    for (var i = 0; i < L.qr.length; i++) qrMap[L.qr[i][0] + ',' + L.qr[i][1]] = i;
    var dirs = [[1, 0], [0, 1], [-1, 1]];
    ctx.beginPath();
    for (i = 0; i < L.qr.length; i++) {
      var q = L.qr[i][0], r0 = L.qr[i][1];
      var p1 = res.points[i];
      for (var d = 0; d < 3; d++) {
        var ni = qrMap[(q + dirs[d][0]) + ',' + (r0 + dirs[d][1])];
        if (ni !== undefined) {
          var p2 = res.points[ni];
          ctx.moveTo(p1.x * scale, p1.y * scale);
          ctx.lineTo(p2.x * scale, p2.y * scale);
        }
      }
    }
    ctx.strokeStyle = 'rgba(90,60,30,0.42)';
    ctx.lineWidth = 1;
    ctx.stroke();

    var r = L.cell * 0.43 * scale;
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
        ctx.strokeStyle = cls === 1 ? 'rgba(255,255,255,0.28)' : 'rgba(0,0,0,0.45)';
        ctx.stroke();
      }
      var isLow = !st.manual[k] && ((p.margin != null ? p.margin : p.conf) < 0.10 || p.conf < 0.42);
      if (isLow) {
        ctx.beginPath();
        ctx.arc(x, y, r * 1.12, 0, 7);
        ctx.lineWidth = 2;
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
  }

  function renderResult(resetScroll) {
    var res = st.result;
    if (!res) return;
    syncStep3Controls();
    var cv = $('photoResult');
    var W = res.layout.W;
    var isSplit = st.viewMode === 'split';
    var fit = fitCanvas(cv, W, W, isSplit ? 320 : 560, isSplit ? 0.36 : 0.40);
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

    // オーバーレイ描画（写真上の実石を隠さないよう、デフォルトは中抜きのカラー枠）
    var scale = fit.cssW / W;
    var r = res.layout.cell * 0.44 * scale;
    for (var k = 0; k < res.points.length; k++) {
      var p = res.points[k];
      var cls = st.labels[k];
      var x = p.x * scale, y = p.y * scale;
      var isLow = !st.manual[k] && ((p.margin != null ? p.margin : p.conf) < 0.10 || p.conf < 0.42);
      if (st.viewMode === 'ring') {
        if (cls > 0) {
          var ringW = Math.max(2.6, r * 0.34);
          // 視認性用の薄い外側縁取り（黒石や白石でも盤面と混ざらないように）
          ctx.beginPath();
          ctx.arc(x, y, r * 0.96, 0, 7);
          ctx.lineWidth = ringW + 2;
          ctx.strokeStyle = cls === 1 ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.65)';
          ctx.stroke();
          // 色枠本体（中央は透明のままなので写真の石がそのまま見える）
          ctx.beginPath();
          ctx.arc(x, y, r * 0.96, 0, 7);
          ctx.lineWidth = ringW;
          ctx.strokeStyle = CLASS_COLORS[cls];
          ctx.stroke();
        } else {
          ctx.beginPath();
          ctx.arc(x, y, Math.max(1.8, r * 0.15), 0, 7);
          ctx.fillStyle = 'rgba(255,255,255,0.65)';
          ctx.fill();
          ctx.lineWidth = 0.8;
          ctx.strokeStyle = 'rgba(0,0,0,0.45)';
          ctx.stroke();
        }
        if (st.manual[k]) {
          ctx.beginPath();
          ctx.arc(x + r * 0.72, y - r * 0.72, Math.max(2.5, r * 0.22), 0, 7);
          ctx.fillStyle = '#10b981';
          ctx.fill();
          ctx.lineWidth = 1;
          ctx.strokeStyle = '#fff';
          ctx.stroke();
        }
      }
      if (st.viewMode !== 'photo' && isLow) {
        ctx.save();
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.arc(x, y, r * 1.18, 0, 7);
        ctx.lineWidth = 2.2;
        ctx.strokeStyle = '#ffb300';
        ctx.stroke();
        ctx.restore();
      }
      if (k === st.hover) {
        ctx.beginPath();
        ctx.arc(x, y, r * 1.25, 0, 7);
        ctx.lineWidth = 2;
        ctx.strokeStyle = 'rgba(80,200,255,0.95)';
        ctx.stroke();
      }
    }
    if (isSplit) renderBoardPreview();
    renderCounts();
    renderOutRow();
    renderTurnSelect();
    if (resetScroll) cv.scrollIntoView({ block: 'nearest' });
  }

  // 色の並び順（= 1P,2P,... の割り当て）を入れ替える。
  // チップをドラッグ&ドロップ（Pointer Events なので iPad のタッチでも動く）。
  // ドラッグせずに2回タップした場合は2色を入れ替える。
  function commitPaletteOrder(colors) {
    if (!colors || !colors.length) return;
    st.palette = colors.slice();
    st.playerCount = st.palette.length;
    st.pickPalette = null;
    renderCounts();
    renderTurnSelect();
  }
  function movePaletteColor(idx, dir) {
    if (!st.palette) return;
    var to = idx + dir;
    if (to < 0 || to >= st.palette.length) return;
    var arr = st.palette.slice();
    var tmp = arr[idx]; arr[idx] = arr[to]; arr[to] = tmp;
    commitPaletteOrder(arr);
  }
  function removePaletteColor(idx) {
    if (!st.palette || st.palette.length <= 2) return;
    var removed = st.palette[idx];
    var arr = st.palette.slice();
    arr.splice(idx, 1);
    if (st.outColors) delete st.outColors[removed];
    st.pickPalette = null;
    commitPaletteOrder(arr);
    toast(CLASS_JA[removed] + 'をプレイヤーから外しました（石は空点扱い・タップで修正できます）');
  }
  function swapPaletteColor(a, b) {
    if (!st.palette || a === b) return;
    var arr = st.palette.slice();
    var tmp = arr[a]; arr[a] = arr[b]; arr[b] = tmp;
    commitPaletteOrder(arr);
  }

  // ---- ドラッグ&ドロップ ----
  var chipDrag = null;
  function chipContainer() { return $('photoCounts'); }
  function paletteChips() {
    var box = chipContainer();
    if (!box) return [];
    return Array.prototype.slice.call(box.querySelectorAll('.photo-color-chip'));
  }
  function chipDragStart(e) {
    var chip = e.currentTarget;
    if (!chip || !chip.classList.contains('photo-color-chip')) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    var rect = chip.getBoundingClientRect();
    chipDrag = {
      chip: chip, startX: e.clientX, startY: e.clientY,
      pointerId: e.pointerId, moved: false, lastX: e.clientX,
      grabOffsetX: e.clientX - rect.left, tx: 0
    };
    try { chip.setPointerCapture(e.pointerId); } catch (err) { /* synthetic events */ }
    e.preventDefault();
  }
  function chipDragMove(e) {
    if (!chipDrag || !chipDrag.chip) return;
    var dx = e.clientX - chipDrag.startX;
    var dy = e.clientY - chipDrag.startY;
    if (!chipDrag.moved && Math.hypot(dx, dy) > 6) {
      chipDrag.moved = true;
      chipDrag.chip.style.zIndex = '20';
      chipDrag.chip.style.boxShadow = '0 6px 16px rgba(0,0,0,0.25)';
      chipDrag.chip.style.opacity = '0.95';
    }
    if (!chipDrag.moved) return;
    e.preventDefault();
    // 1) ポインタ位置に応じて DOM を並べ替える（他のチップの矩形は transform の影響を受けない）
    var box = chipContainer();
    var chips = paletteChips().filter(function (c) { return c !== chipDrag.chip; });
    var target = null;
    for (var i = 0; i < chips.length; i++) {
      var r = chips[i].getBoundingClientRect();
      if (e.clientX < r.left + r.width / 2) { target = chips[i]; break; }
    }
    if (target) box.insertBefore(chipDrag.chip, target);
    else box.appendChild(chipDrag.chip);
    // 2) 並べ替え後のレイアウト位置に対して、掴んだ点がポインタの下に来るよう変位を再計算する
    //    （再配置で矩形が変わるので、現在の変位を引いた「素の位置」を基準にする）
    var rect = chipDrag.chip.getBoundingClientRect();
    var baseLeft = rect.left - (chipDrag.tx || 0);
    chipDrag.tx = (e.clientX - chipDrag.grabOffsetX) - baseLeft;
    chipDrag.chip.style.transform = 'translateX(' + chipDrag.tx + 'px)';
  }
  function chipDragEnd() {
    if (!chipDrag) return;
    var chip = chipDrag.chip, moved = chipDrag.moved;
    if (chip) {
      chip.style.transform = '';
      chip.style.zIndex = '';
      chip.style.boxShadow = '';
      chip.style.opacity = '';
    }
    if (chipDrag && chipDrag.chip === chip) chipDrag.tx = 0;
    chipDrag = null;
    if (!moved) return;
    // DOM の並びをパレット順として確定
    var colors = paletteChips().map(function (c) { return Number(c.dataset.color); });
    if (colors.length) commitPaletteOrder(colors);
    // 直後の click を無効化（ドラッグ後のタップ扱いを防ぐ）
    st.suppressChipClick = Date.now();
  }
  document.addEventListener('pointermove', chipDragMove, { passive: false });
  document.addEventListener('pointerup', chipDragEnd);
  document.addEventListener('pointercancel', chipDragEnd);

  function renderCounts() {
    var el = $('photoCounts');
    if (!el) return;
    var counts = classCounts(st.labels);
    var low = 0;
    for (var i = 0; i < st.result.points.length; i++) {
      var pt = st.result.points[i];
      if ((pt.margin != null ? pt.margin : pt.conf) < 0.10 || pt.conf < 0.42) low++;
    }
    el.innerHTML = '';

    var empty = document.createElement('span');
    empty.className = 'opacity-60';
    empty.innerHTML = '空 <strong>' + counts[0] + '</strong>';
    el.appendChild(empty);

    // 参加プレイヤーの色 = 並び順がそのまま 1P,2P,...（ドラッグで入れ替え）
    (st.palette || []).forEach(function (c, idx) {
      var chip = document.createElement('span');
      chip.className = 'photo-color-chip inline-flex items-center gap-1 rounded-full border px-3 py-1.5 ' +
        'select-none touch-none cursor-grab active:cursor-grabbing ' +
        (st.pickPalette === idx ? 'border-neutral-900 bg-neutral-100' : 'border-neutral-300 bg-white');
      chip.dataset.color = String(c);
      chip.dataset.slot = String(idx + 1);
      var dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = CLASS_COLORS[c];
      dot.style.borderColor = '#333';
      chip.appendChild(dot);
      var label = document.createElement('span');
      label.innerHTML = CLASS_JA[c] + ' <strong>' + counts[c] + '</strong><span class="opacity-50"> ' + (idx + 1) + 'P</span>';
      chip.appendChild(label);
      // 色（プレイヤー）を外す。誤って追加した色を削除できる。
      var del = document.createElement('button');
      del.type = 'button';
      del.textContent = '×';
      del.setAttribute('aria-label', CLASS_JA[c] + 'をプレイヤーから外す');
      del.disabled = (st.palette || []).length <= 2;
      del.className = 'w-6 h-6 -my-1 -mr-1 flex items-center justify-center rounded-full text-[11px] font-bold ' +
        'text-neutral-400 hover:text-red-600 hover:bg-red-50 active:bg-red-100 disabled:opacity-20';
      del.onclick = function (ev) { ev.stopPropagation(); removePaletteColor(idx); };
      chip.appendChild(del);
      chip.addEventListener('pointerdown', chipDragStart);
      chip.onclick = function () {
        if (st.suppressChipClick && Date.now() - st.suppressChipClick < 400) return;
        if (st.pickPalette == null) { st.pickPalette = idx; renderCounts(); }
        else if (st.pickPalette === idx) { st.pickPalette = null; renderCounts(); }
        else { swapPaletteColor(st.pickPalette, idx); }
      };
      el.appendChild(chip);
    });

    var stray = [];
    for (var c = 1; c < 8; c++) {
      if (!counts[c]) continue;
      if ((st.palette || []).indexOf(c) >= 0) continue;
      stray.push(CLASS_JA[c] + ' ' + counts[c] + '点');
    }
    if (stray.length) {
      var stw = document.createElement('span');
      stw.className = 'text-amber-700 font-bold';
      stw.textContent = '未使用色: ' + stray.join(' / ') + '（空点扱い・タップで修正）';
      el.appendChild(stw);
    }
    if (low) {
      var lw = document.createElement('span');
      lw.className = 'text-amber-600 font-bold';
      lw.textContent = '要確認 ' + low + '点';
      el.appendChild(lw);
    }
    var hint = $('photoColorHint');
    if (hint) {
      var order = (st.palette || []).map(function (c, i) { return (i + 1) + 'P=' + CLASS_JA[c]; }).join(' ');
      hint.textContent = (st.allColors
        ? '全色モード: 未使用の色を選ぶとプレイヤーとして追加されます（最大6人）。'
        : 'タップで切り替わるのは「空」と参加中の色だけです（全色ボタンで拡張可）。')
        + ' 色チップはドラッグで並べ替え（2回タップでも入れ替え）。現在: ' + order;
    }
  }

  // 実戦ですでに投了しているプレイヤーを「投了済み」として記録する。
  function renderOutRow() {
    var el = $('photoOutRow');
    if (!el) return;
    el.innerHTML = '';
    if (!st.palette || !st.palette.length) return;
    var activeCount = 0;
    st.palette.forEach(function (c) { if (!st.outColors[c]) activeCount++; });
    var label = document.createElement('span');
    label.className = 'opacity-60';
    label.textContent = '投了済み:';
    el.appendChild(label);
    st.palette.forEach(function (c, idx) {
      var out = !!st.outColors[c];
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-bold ' +
        (out ? 'bg-red-600 text-white border-red-600' : 'bg-white text-neutral-600 border-neutral-300 active:bg-neutral-100') +
        ((!out && activeCount <= 1) ? ' opacity-40' : '');
      b.disabled = (!out && activeCount <= 1);
      b.innerHTML = '<span class="dot" style="background:' + CLASS_COLORS[c] + ';border-color:#333"></span>' + (idx + 1) + 'P ' + CLASS_JA[c];
      b.onclick = function () {
        if (!st.outColors[c]) {
          if (activeCount <= 1) return;
          st.outColors[c] = true;
        } else {
          delete st.outColors[c];
        }
        renderOutRow();
        renderTurnSelect();
      };
      el.appendChild(b);
    });
    if (activeCount <= 1) {
      var note = document.createElement('span');
      note.className = 'opacity-50';
      note.textContent = '（最後の1人は投了にできません）';
      el.appendChild(note);
    }
  }

  function renderTurnSelect() {
    var sel = $('photoTurn');
    if (!sel) return;
    var pc = Math.max(2, Math.min(6, st.playerCount || 2));
    var active = [];
    for (var i2 = 0; i2 < pc; i2++) {
      var c2 = st.palette ? st.palette[i2] : null;
      if (c2 == null || !st.outColors[c2]) active.push(i2 + 1);
    }
    if (active.length && active.indexOf(st.turn) < 0) st.turn = active[0];
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
    syncLibCountBadges();
  }
  function syncLibCountBadges() {
    var cnt = S.list().length;
    ['photoLibCount', 'photoLibCountStep1', 'recordLibCount'].forEach(function (id) {
      var el = $(id);
      if (el) el.textContent = String(cnt);
    });
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
    st.manual[idx] = true;
    renderResult();
  }

  function calibrateFromManual() {
    if (!st.result || !st.labels || !R.reclassifyWithAnchors) return;
    if (!manualCount()) { toast('先に間違っている石を1〜2個タップして直してください'); return; }
    var allowed = [0].concat(allowedColors());
    var out = R.reclassifyWithAnchors(st.result, st.labels, st.manual, allowed);
    if (!out) return;
    st.labels = out.labels;
    for (var i = 0; i < st.result.points.length; i++) {
      st.result.points[i].cls = out.points[i].cls;
      st.result.points[i].conf = out.points[i].conf;
      st.result.points[i].margin = out.points[i].margin;
    }
    st.calibrated = true;
    renderResult();
    toast(out.changedCount > 0 ? ('色合いを学習して ' + out.changedCount + ' 点を自動調整しました') : '色合いを再確認しました（変更なし）');
  }

  function resetToInitialRead() {
    if (!st.result || !st.origLabels) return;
    st.labels = st.origLabels.slice();
    for (var i = 0; i < st.result.points.length; i++) {
      var pt = st.result.points[i];
      if (pt.origCls != null) { pt.cls = pt.origCls; pt.conf = pt.origConf; pt.margin = pt.origMargin; }
    }
    st.manual = {};
    st.calibrated = false;
    renderResult();
    toast('初期判定に戻しました');
  }

  function pickResultPoint(cv, clientX, clientY) {
    var res = st.result;
    if (!res || !cv) return -1;
    var rect = cv.getBoundingClientRect();
    var W = res.layout.W;
    var x = (clientX - rect.left) / rect.width * W;
    var y = (clientY - rect.top) / rect.height * W;
    var best = -1, bd = res.layout.cell * 0.55;
    for (var i = 0; i < res.points.length; i++) {
      var d = Math.hypot(res.points[i].x - x, res.points[i].y - y);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  function onResultPointer(e) {
    var best = pickResultPoint(e.currentTarget, e.clientX, e.clientY);
    if (best < 0) return;
    if (e.type === 'click') {
      // タッチの pointerup で処理済みなら click では切り替えない(二重切替防止)
      if (Date.now() - lastTouchCycleAt < 700) return;
      cycleAt(best); snd && snd.click && snd.click();
    }
    return best;
  }

  // タッチ端末(iPad/iPhone)向けの色切り替え。
  // タッチでは click が発火しない/遅延する環境があり、また pointermove の
  // ホバー処理がタップを打ち消してしまうため、pointerdown〜pointerup の
  // 「動かなかったタップ」を自前で判定して色を切り替える。
  var tapState = null;
  function resultTapDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    tapState = { x: e.clientX, y: e.clientY, t: Date.now(), id: e.pointerId, handled: false };
    // タッチでは hover 表示を出さない(指の下の点がちらつくため)
    if (e.pointerType !== 'mouse') { e.preventDefault(); }
  }
  function resultTapUp(e) {
    var st0 = tapState; tapState = null;
    if (!st0 || st0.id !== e.pointerId || st0.handled) return;
    if (Math.hypot(e.clientX - st0.x, e.clientY - st0.y) > 12) return;  // スクロール/ドラッグ
    if (Date.now() - st0.t > 900) return;
    st0.handled = true;
    var best = pickResultPoint(e.currentTarget, e.clientX, e.clientY);
    if (best < 0) return;
    cycleAt(best);
    if (snd && snd.click) snd.click();
    // タッチでは直後の click も発火しうるので二重切替を防ぐ
    lastTouchCycleAt = Date.now();
  }
  var lastTouchCycleAt = 0;

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
    var outArr = [false];
    palette.forEach(function (c) { outArr.push(!!st.outColors[c]); });
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
      out: outArr,
      turn: turn,
      meta: {
        convention: res.convention,
        margin: res.margin,
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
      G.out = (entry.out && entry.out.length >= playerCount + 1)
        ? entry.out.slice(0, playerCount + 1)
        : Array(playerCount + 1).fill(false);
      G.out[0] = false;
      if (G.out[G.turn]) {
        for (var oi = 1; oi <= playerCount; oi++) { if (!G.out[oi]) { G.turn = oi; break; } }
      }
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
      toast((entry.meta && entry.meta.source === 'game') ? '保存した盤面を読み込みました' : '写真の局面を読み込みました');
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
      img.src = e.thumb || (typeof makeBoardThumb === 'function' ? makeBoardThumb(e) : '');
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
        if (typeof refreshRecordSummary === 'function') refreshRecordSummary();
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

  // ---------------- サイズ・余白の自動調整 ----------------
  // 撮影画像から、盤面サイズと「外枠と格子のすき間（余白）」を自動で合わせる。
  function autoFitBoard() {
    if (!st.imageData || !st.corners) return;
    var fit = null;
    try {
      fit = R.autoFit(st.imageData, st.corners, { margin: 0.577 });
    } catch (e) { fit = null; }
    var el = $('photoFitInfo');
    if (!fit) {
      if (el) { el.textContent = ''; }
      return;
    }
    st.size = fit.size;
    st.margin = fit.margin;
    var slider = $('photoMargin');
    if (slider) slider.value = String(fit.margin);
    var label = $('photoMarginLabel');
    if (label) label.textContent = fit.margin.toFixed(2) + ' cell';
    syncButtons();
    renderAdjust();
    if (el) {
      el.textContent = '石の位置に合わせて自動調整しました: ' + fit.size + '路 / 余白 ' + fit.margin.toFixed(2) + ' cell';
      el.className = 'text-[11px] text-neutral-500';
    }
    updateFitScore(fit.score);
    updateDetectInfo();
  }

  // 一致度（0〜100%）。サイズ・余白が盤にどれだけ合っているかの目安。
  var scoreTimer = null;
  function updateFitScore(knownScore) {
    var el = $('photoFitScore');
    if (!el) return;
    if (!st.imageData || !st.corners) { el.textContent = ''; return; }
    var sc = (typeof knownScore === 'number' && knownScore > 0) ? knownScore
      : R.quickScore(st.imageData, st.corners, st.size, st.margin);
    if (!(sc > 0)) { el.textContent = ''; return; }
    var pct = Math.round(sc * 100);
    el.textContent = '一致度 ' + pct + '%';
    el.className = 'text-xs font-mono ' + (sc >= 0.72 ? 'text-neutral-500' : 'text-amber-600 font-bold');
  }
  function scheduleFitScore() {
    if (scoreTimer) clearTimeout(scoreTimer);
    scoreTimer = setTimeout(function () { updateFitScore(); }, 90);
  }

  // ---------------- 起動・配線 ----------------
  function reset() {
    st.result = null; st.labels = null; st.origLabels = null; st.drag = -1; st.hover = -1;
    st.corners = null; st.imageData = null; st.img = null; st.fileName = '';
    st.palette = null; st.playerCount = 2; st.allColors = false; st.pickPalette = null; st.outColors = {};
    st.viewMode = 'ring'; st.manual = {}; st.calibrated = false;
    st.margin = 0.577;
    var ms = $('photoMargin'); if (ms) ms.value = '0.58';
    var ml = $('photoMarginLabel'); if (ml) ml.textContent = '0.58 cell';
    var fs = $('photoFitScore'); if (fs) fs.textContent = '';
    st.autoConf = 0; st.autoMethod = '';
    err('');
    var f = $('photoFile'); if (f) f.value = '';
    var cam = $('photoCamera'); if (cam) cam.value = '';
  }

  function open() {
    loadModel();
    var f = $('photoFile');
    if (f) f.click();
  }

  function openLibrary() {
    reset();
    st.libraryDirect = true;
    showLibrary();
    syncLibCountBadges();
    $('photoModal').classList.remove('hidden');
    if (typeof autoPass === 'function' && autoPass()) autoPass().update();
  }

  function init() {
    var btn = $('btnOpenPhoto');
    if (btn) btn.onclick = open;
    var close = $('btnClosePhoto');
    if (close) close.onclick = function () { closeModal($('photoModal')); };
    var file = $('photoFile');
    if (file) file.onchange = function () { var f0 = file.files && file.files[0]; file.value = ''; loadImageFile(f0); };
    var marginInput = $('photoMargin');
    if (marginInput) marginInput.oninput = function () {
      st.margin = Number(marginInput.value);
      var ml = $('photoMarginLabel');
      if (ml) ml.textContent = st.margin.toFixed(2) + ' cell';
      syncButtons();
      renderAdjust();
      scheduleFitScore();
    };

    var redetect = $('btnPhotoRedetect');
    if (redetect) redetect.onclick = function () { autoDetect(); renderAdjust(); updateDetectInfo(); autoFitBoard(); };
    var readBtn = $('btnPhotoRead');
    if (readBtn) readBtn.onclick = read;
    var cvA = $('photoAdjust');
    if (cvA) {
      cvA.addEventListener('pointerdown', onAdjustDown);
      cvA.addEventListener('pointermove', function (e) { onAdjustMove(e); });
      cvA.addEventListener('pointerup', onAdjustUp);
      cvA.addEventListener('pointercancel', onAdjustUp);
    }
    [$('photoResult'), $('photoBoardPreview')].forEach(function (cvR) {
      if (!cvR) return;
      cvR.style.touchAction = 'manipulation';   // ダブルタップ拡大によるタップ遅延/取りこぼしを防ぐ
      cvR.addEventListener('click', onResultPointer);
      // タッチ/ペン: 動かないタップで色を切り替える
      cvR.addEventListener('pointerdown', resultTapDown);
      cvR.addEventListener('pointerup', resultTapUp);
      cvR.addEventListener('pointercancel', function (e) { tapState = null; });
      // マウス: ホバー予覧(タッチでは発火させない)
      cvR.addEventListener('pointermove', function (e) {
        if (e.pointerType !== 'mouse') return;
        var best = pickResultPoint(cvR, e.clientX, e.clientY);
        if (best !== st.hover) { st.hover = best; renderResult(); }
      });
      cvR.addEventListener('pointerleave', function (e) {
        if (e.pointerType && e.pointerType !== 'mouse') return;
        st.hover = -1; renderResult();
      });
    });
    [].forEach.call(document.querySelectorAll('#photoViewBtns [data-photo-view]'), function (b) {
      b.onclick = function () {
        st.viewMode = b.dataset.photoView || 'ring';
        if (snd && snd.click) snd.click();
        renderResult();
      };
    });
    var calBtn = $('btnPhotoCalibrate');
    if (calBtn) calBtn.onclick = function () { if (snd && snd.click) snd.click(); calibrateFromManual(); };
    var rstBtn = $('btnPhotoResetRead');
    if (rstBtn) rstBtn.onclick = function () { if (snd && snd.click) snd.click(); resetToInitialRead(); };
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
          syncLibCountBadges();
          renderLibrary();
        } catch (e) { toast('読み込みに失敗しました'); }
      };
      rd.readAsText(f);
      libFile.value = '';
    };
    var libBack = $('btnPhotoLibBack');
    if (libBack) libBack.onclick = function () {
      if (st.libraryDirect || !st.result) { closeModal($('photoModal')); return; }
      view('step3');
      renderResult();
    };
  }

  // 画面サイズが変わったらキャンバスを合わせ直す（iPad/スマホの回転など）
  var resizeTimer = null;
  global.addEventListener('resize', function () {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      var modal = $('photoModal');
      if (!modal || modal.classList.contains('hidden')) return;
      if (st.imageData) renderAdjust();
      if (st.result) renderResult();
    }, 120);
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  global.HexagoPhotoUI = {
    open: open,
    openLibrary: openLibrary,
    applyToGame: applyToGame,
    close: function () { closeModal($('photoModal')); },
    state: function () {
      return {
        size: st.size, margin: st.margin, hasImage: !!st.imageData,
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
        size: st.size, margin: st.margin, hasImage: !!st.imageData,
        result: !!st.result, labels: st.labels ? st.labels.slice() : null,
        corners: st.corners, turn: st.turn,
        palette: st.palette ? st.palette.slice() : null,
        playerCount: st.playerCount, allColors: st.allColors,
        out: (st.palette || []).map(function (c) { return !!st.outColors[c]; }),
        allowed: allowedColors()
      };
    },
    cycle: function (i) { cycleAt(i); return this.state(); },
    calibrate: function () { calibrateFromManual(); return this.state(); },
    setViewMode: function (m) { st.viewMode = m || 'ring'; renderResult(); return this.state(); },
    moveColor: function (i, dir) { movePaletteColor(i, dir); return this.state(); },
    setPalette: function (arr) { commitPaletteOrder(arr); return this.state(); },
    swapColors: function (a, b) { swapPaletteColor(a, b); return this.state(); },
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
    preparePhotoModal();
    $('photoModal').classList.remove('hidden');
    st.width = imageData.width; st.height = imageData.height;
    st.imageData = imageData;
    st.img = null;
    st.fileName = 'testdata.jpg';
    autoDetect();
    view('step2');
    renderAdjust();
    updateDetectInfo();
    setTimeout(autoFitBoard, 60);
  }
})(typeof self !== 'undefined' ? self : this);
