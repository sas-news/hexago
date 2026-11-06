// ===== 写真復元: 小型MLP（28 -> 64 -> 32 -> 8, ReLU, softmax）=====
// CONTRACT v2 §6。依存なし・classic script。
//   window.HexagoPhotoModel.load(url)   -> Promise（model.json を fetch。二重ロード安全、失敗時 reject）
//   window.HexagoPhotoModel.fromJSON(o) -> 同期ロード（テスト用）
//   window.HexagoPhotoModel.predict(features) -> Float32Array(8) softmax 確率
//   window.HexagoPhotoModel.forward(features) -> predict の別名（CONTRACT §6）
//   window.HexagoPhotoModel.isLoaded() / classes
//
// model.json 形式: { format:"hexago-photo-mlp-v1", features:28,
//                    classes:["empty","black",...], layers:[{W:[[...]], b:[...]}, ...] }
(function (global) {
  'use strict';

  var FORMAT = 'hexago-photo-mlp-v1';
  var DEFAULT_CLASSES = ['empty', 'black', 'white', 'red', 'blue', 'green', 'yellow', 'purple'];

  var state = null;      // {weights, biases, classes, features}
  var loading = null;    // 進行中の Promise

  function parseModel(json) {
    if (!json || json.format !== FORMAT) {
      throw new Error('HexagoPhotoModel: unsupported model format ' + (json && json.format));
    }
    if (!Array.isArray(json.layers) || json.layers.length < 2) {
      throw new Error('HexagoPhotoModel: model.json has no layers');
    }
    var nIn = json.features || (json.layers[0].W.length && json.layers[0].W[0].length);
    var layers = json.layers.map(function (layer, li) {
      var W = layer.W, b = layer.b;
      var nOut = W.length, nInL = W[0].length;
      if (b.length !== nOut) throw new Error('HexagoPhotoModel: bias size mismatch at layer ' + li);
      var flat = new Float32Array(nOut * nInL);
      for (var o = 0; o < nOut; o++) {
        if (W[o].length !== nInL) throw new Error('HexagoPhotoModel: weight row mismatch at layer ' + li);
        for (var k = 0; k < nInL; k++) flat[o * nInL + k] = W[o][k];
      }
      return { W: flat, b: Float32Array.from(b), nIn: nInL, nOut: nOut };
    });
    if (layers[0].nIn !== nIn) throw new Error('HexagoPhotoModel: feature count mismatch');
    return {
      layers: layers,
      features: nIn,
      classes: (json.classes || DEFAULT_CLASSES).slice()
    };
  }

  function load(url) {
    if (state) return Promise.resolve(api);
    if (loading) return loading;
    if (typeof fetch !== 'function') {
      return Promise.reject(new Error('HexagoPhotoModel: fetch is not available'));
    }
    loading = fetch(url)
      .then(function (res) {
        if (!res.ok) throw new Error('HexagoPhotoModel: HTTP ' + res.status + ' loading ' + url);
        return res.json();
      })
      .then(function (json) {
        state = parseModel(json);
        return api;
      })
      .finally(function () { loading = null; });
    return loading;
  }

  function fromJSON(json) {
    state = parseModel(json);
    return api;
  }

  function isLoaded() { return !!state; }

  function predict(features) {
    if (!state) throw new Error('HexagoPhotoModel: model is not loaded');
    var x = features;
    if (!x || x.length !== state.features) {
      throw new Error('HexagoPhotoModel: expected ' + state.features + ' features, got ' + (x && x.length));
    }
    var li, o, k, nOut, nIn, sum, W, b;
    var cur = new Float64Array(state.features);
    for (k = 0; k < state.features; k++) cur[k] = x[k];
    for (li = 0; li < state.layers.length; li++) {
      var layer = state.layers[li];
      nOut = layer.nOut; nIn = layer.nIn; W = layer.W; b = layer.b;
      var out = new Float64Array(nOut);
      for (o = 0; o < nOut; o++) {
        sum = b[o];
        var off = o * nIn;
        for (k = 0; k < nIn; k++) sum += W[off + k] * cur[k];
        out[o] = sum;
      }
      if (li < state.layers.length - 1) {
        for (o = 0; o < nOut; o++) if (out[o] < 0) out[o] = 0;   // ReLU
      } else {
        // softmax
        var mx = -Infinity;
        for (o = 0; o < nOut; o++) if (out[o] > mx) mx = out[o];
        var esum = 0;
        for (o = 0; o < nOut; o++) { out[o] = Math.exp(out[o] - mx); esum += out[o]; }
        for (o = 0; o < nOut; o++) out[o] /= esum;
      }
      cur = out;
    }
    return Float32Array.from(cur);
  }

  var api = {
    load: load,
    fromJSON: fromJSON,
    predict: predict,
    forward: predict,
    isLoaded: isLoaded,
    get classes() { return state ? state.classes : DEFAULT_CLASSES.slice(); },
    FORMAT: FORMAT
  };
  global.HexagoPhotoModel = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
