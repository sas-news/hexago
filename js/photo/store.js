// ===== 写真復元: 局面ライブラリ（localStorage） =====
// 写真から復元した局面を保存・一覧・書き出しする。依存なし・classic script。
//   HexagoPhotoStore.list() / save(entry) / get(id) / remove(id) / exportAll() / importJSON()
// entry: { id, name, createdAt, size, playerCount, board:[0|1..6], colors:{p:{fill,stroke}},
//          names:{p:string}, turn, labels:[0..7], meta:{convention, confidence, source} , thumb }
(function (global) {
  'use strict';
  var KEY = 'hexago-photo-lib-v1';

  function read() {
    try {
      var raw = global.localStorage.getItem(KEY);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }
  function write(list) {
    try { global.localStorage.setItem(KEY, JSON.stringify(list)); return true; }
    catch (e) { return false; }
  }
  function newId() {
    return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }
  function list() {
    return read().slice().sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
  }
  function get(id) {
    var l = read();
    for (var i = 0; i < l.length; i++) if (l[i].id === id) return l[i];
    return null;
  }
  function save(entry) {
    if (!entry) throw new Error('entry required');
    var l = read();
    var e = JSON.parse(JSON.stringify(entry));
    if (!e.id) e.id = newId();
    if (!e.createdAt) e.createdAt = Date.now();
    var i = -1;
    for (var k = 0; k < l.length; k++) if (l[k].id === e.id) { i = k; break; }
    if (i >= 0) l[i] = e; else l.push(e);
    if (!write(l)) throw new Error('localStorage write failed');
    return e;
  }
  function remove(id) {
    write(read().filter(function (e) { return e.id !== id; }));
  }
  function exportAll() {
    return JSON.stringify(read(), null, 1);
  }
  function importJSON(text) {
    var arr = JSON.parse(text);
    if (!Array.isArray(arr)) throw new Error('array expected');
    var l = read();
    var ids = {};
    for (var i = 0; i < l.length; i++) ids[l[i].id] = true;
    var added = 0;
    for (var j = 0; j < arr.length; j++) {
      var e = arr[j];
      if (!e || !Array.isArray(e.board) || !e.size) continue;
      if (!e.id || ids[e.id]) e.id = newId();
      ids[e.id] = true;
      l.push(e);
      added++;
    }
    write(l);
    return added;
  }
  function available() {
    try {
      var k = '__hexago_photo_probe__';
      global.localStorage.setItem(k, '1');
      global.localStorage.removeItem(k);
      return true;
    } catch (e) { return false; }
  }

  var api = {
    KEY: KEY,
    list: list, save: save, get: get, remove: remove,
    exportAll: exportAll, importJSON: importJSON, available: available
  };
  global.HexagoPhotoStore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
