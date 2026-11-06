// ===== AI Worker =====
// js/ai/engine.js（dev/ai-engine.js のコピー）を読み込み、盤面探索の要求を処理する。
// メインスレッドの js/ai/pool.js から new Worker('js/ai/worker.js') で起動される。
importScripts('./engine.js');

var __hexEngines = Object.create(null);

self.onmessage = function (e) {
  var d = e.data || {};
  var id = d.id;
  try {
    var st = d.state || {};
    var key = String(st.size) + ':' + String(st.playerCount);
    var eng = __hexEngines[key];
    if (!eng) {
      eng = HexagoAI.createEngine({ size: st.size, playerCount: st.playerCount });
      __hexEngines[key] = eng;
    }
    var opts = d.options || {};
    var lastP = 0;
    opts.onProgress = function (p) {
      var t = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      if (t - lastP < 250) return;
      lastP = t;
      self.postMessage({ id: id, progress: { visits: p.visits, playouts: p.playouts } });
    };
    var result = eng.think(st, opts);
    self.postMessage({ id: id, ok: true, result: result });
  } catch (err) {
    self.postMessage({ id: id, ok: false, error: String((err && err.stack) || err) });
  }
};
