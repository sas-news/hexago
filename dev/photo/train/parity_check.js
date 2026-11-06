#!/usr/bin/env node
// Parity check: js/photo/features.js vs Python reference features in parity-fixtures.json.
// Also smoke-tests js/photo/model.js (fromJSON + predict) and measures 127-patch speed.
// Usage: node dev/photo/train/parity_check.js [fixtures.json]
'use strict';
const fs = require('fs');
const path = require('path');

const features = require(path.join(__dirname, '../../../js/photo/features.js'));
const model = require(path.join(__dirname, '../../../js/photo/model.js'));

const fxPath = process.argv[2] || path.join(__dirname, 'parity-fixtures.json');
const fx = JSON.parse(fs.readFileSync(fxPath, 'utf8'));
const baseline = fx.baseline;
const patches = fx.patches;
const expected = fx.features;

let maxDiff = 0, maxIdx = -1, maxFeat = -1;
const got = [];
for (let i = 0; i < patches.length; i++) {
  const patch = Float32Array.from(patches[i]);
  const f = features.extract(patch, baseline);
  got.push(f);
  for (let k = 0; k < 28; k++) {
    const d = Math.abs(f[k] - expected[i][k]);
    if (d > maxDiff) { maxDiff = d; maxIdx = i; maxFeat = k; }
  }
}
console.log('[parity] patches=' + patches.length + ' max|diff|=' + maxDiff.toExponential(3) +
            (maxIdx >= 0 ? ' (patch ' + maxIdx + ', feature ' + maxFeat + ')' : ''));
if (maxDiff > 1e-5) {
  console.error('[parity] FAIL: tolerance 1e-5');
  process.exitCode = 1;
} else {
  console.log('[parity] OK (tolerance 1e-5)');
}

// ---- model.js smoke test: load the real model.json (or dummy) ----
const modelPath = path.join(__dirname, '../../../js/photo/model.json');
const json = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
try {
  model.fromJSON(json);
  const probs = model.predict(got[0]);
  let s = 0;
  for (let i = 0; i < probs.length; i++) s += probs[i];
  console.log('[model] fromJSON OK, classes=' + model.classes.join(',') +
              ' p[0..3]=' + Array.from(probs.slice(0, 4)).map(v => v.toFixed(4)).join(',') +
              ' sum=' + s.toFixed(6));
  if (Math.abs(s - 1) > 1e-4) { console.error('[model] FAIL: softmax does not sum to 1'); process.exitCode = 1; }
} catch (e) {
  console.error('[model] FAIL: ' + e.message);
  process.exitCode = 1;
}

// ---- speed: 127 patches (features + predict) ----
let t0 = process.hrtime.bigint();
const nPts = 127;
const all = [];
for (let i = 0; i < nPts; i++) all.push(features.extract(Float32Array.from(patches[i % patches.length]), baseline));
let t1 = process.hrtime.bigint();
for (let i = 0; i < nPts; i++) model.predict(all[i]);
let t2 = process.hrtime.bigint();
console.log('[speed] features 127: ' + (Number(t1 - t0) / 1e6).toFixed(1) + ' ms (cached patch extraction not included)');
console.log('[speed] predict  127: ' + (Number(t2 - t1) / 1e6).toFixed(1) + ' ms');
if (Number(t2 - t1) / 1e6 > 30) { console.error('[speed] FAIL: 127 predicts > 30 ms'); process.exitCode = 1; }
