#!/usr/bin/env node
/** Aggregate AB shard JSON lines: node dev/ab-agg.js dev/.ab150-*.json */
'use strict';
const fs = require('fs');
const files = process.argv.slice(2);
const agg = {
  games: 0, aWins: 0, bWins: 0, draws: 0, illegal: 0, crashes: 0,
  moves: 0, finalEmpty: 0, dead: 0, scoreDelta: 0,
  a: null, b: null
};
const zero = () => ({ placements: 0, passes: 0, adjacentOwn: 0, tenuki: 0, openingDistSum: 0, openingDistN: 0, openingFar: 0, openingSelfAdj: 0, openingIsolated: 0, openingOwnDistSum: 0, openingOwnDistN: 0, midN: 0, midSelfAdj: 0, ownEyeFills: 0, ownTerrFills: 0, safeNeutral: 0, passBefore40: 0, playouts: 0, visits: 0, thinkCalls: 0, ms: 0, passBuckets: {}, firstPassSum: 0, firstPassN: 0 });
agg.a = zero(); agg.b = zero();
for (const f of files) {
  const txt = fs.readFileSync(f, 'utf8');
  const line = txt.split('\n').find(l => l.startsWith('#SHARD_JSON '));
  if (!line) { console.error('no JSON in ' + f); continue; }
  const d = JSON.parse(line.slice('#SHARD_JSON '.length));
  const g = d.agg;
  agg.games += g.games; agg.aWins += g.aWins; agg.bWins += g.bWins; agg.draws += g.draws;
  agg.illegal += g.illegal; agg.crashes += g.crashes;
  agg.moves += g.moves; agg.finalEmpty += g.finalEmpty; agg.dead += g.dead; agg.scoreDelta += g.scoreDelta;
  for (const side of ['a', 'b']) {
    const src = g[side], dst = agg[side];
    for (const k of ['placements', 'passes', 'adjacentOwn', 'tenuki', 'openingDistSum', 'openingDistN', 'openingFar', 'openingSelfAdj', 'openingIsolated', 'openingOwnDistSum', 'openingOwnDistN', 'midN', 'midSelfAdj', 'ownEyeFills', 'ownTerrFills', 'safeNeutral', 'passBefore40', 'playouts', 'visits', 'thinkCalls', 'ms']) dst[k] += src[k];
    for (const b in src.passBuckets) dst.passBuckets[b] = (dst.passBuckets[b] || 0) + src.passBuckets[b];
    if (src.firstPassMove !== null) { dst.firstPassSum += src.firstPassMove; dst.firstPassN++; }
  }
}
const N = agg.games || 1;
const pct = (x, y) => y ? (100 * x / y).toFixed(1) + '%' : '-';
const sideLine = (name, s) => {
  const pl = s.placements || 1;
  return `${name}: placements ${s.placements}, adjacent-own ${pct(s.adjacentOwn, pl)}, tenuki ${pct(s.tenuki, pl)}, `
    + `opening avg dist(any) ${(s.openingDistSum / Math.max(1, s.openingDistN)).toFixed(2)}, far(>=3) ${pct(s.openingFar, s.openingDistN)}, `
    + `opening(<=12mv) self-adj ${pct(s.openingSelfAdj, s.openingOwnDistN)}, nearest-own ${(s.openingOwnDistSum / Math.max(1, s.openingOwnDistN)).toFixed(2)}, isolated ${pct(s.openingIsolated, s.openingOwnDistN)}, mid self-adj ${pct(s.midSelfAdj, s.midN)}, `
    + `own-eye fills ${s.ownEyeFills} (${pct(s.ownEyeFills, pl)}), own-territory fills ${s.ownTerrFills} (${pct(s.ownTerrFills, pl)}), `
    + `dame/neutral ${pct(s.safeNeutral, pl)}, passes ${s.passes}, first pass ~${(s.firstPassSum / Math.max(1, s.firstPassN)).toFixed(0)}, `
    + `passes>40%empty ${s.passBefore40}, playouts/call ${(s.playouts / Math.max(1, s.thinkCalls)).toFixed(0)}, visits/call ${(s.visits / Math.max(1, s.thinkCalls)).toFixed(0)}, pass-buckets ${JSON.stringify(s.passBuckets)}`;
};
console.log('');
console.log(`A/B games=${agg.games}  A=${agg.aWins}W B=${agg.bWins}W ${agg.draws}D  -> B winrate ${pct(agg.bWins, agg.games)}`);
console.log(`illegal=${agg.illegal} crashes=${agg.crashes}  avg moves=${(agg.moves / N).toFixed(1)} avg finalEmpty=${(agg.finalEmpty / N).toFixed(1)} gamesWithDead=${agg.dead} avg|raw-page|=${(agg.scoreDelta / N).toFixed(2)}`);
console.log(sideLine('A', agg.a));
console.log(sideLine('B', agg.b));
