// ===== 盤ジオメトリ (六角形・軸座標) =====
const DIRS = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]];
let SIDE = 5, P = [], M = {}, NB = [];
function build(n) {
  SIDE = (n + 1) / 2; P = []; M = {};
  for (let r = -(SIDE - 1); r < SIDE; r++) for (let q = -(SIDE - 1); q < SIDE; q++) if (Math.abs(q + r) <= SIDE - 1) { M[q + ',' + r] = P.length; P.push([q, r]); }
  NB = P.map(([q, r]) => DIRS.map(([a, b]) => M[(q + a) + ',' + (r + b)]).filter(v => v !== undefined));
}
