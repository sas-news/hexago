// ===== AI (囲碁風の局面評価・戦術判断) =====
// 3人制なので「自分の地を増やす」だけでなく、両者の勢力・弱い石・終盤の空点を評価する。
function regionInfo(b) {
  const id = Array(P.length).fill(-1), regs = [];
  for (let i = 0; i < P.length; i++) if (!b[i] && id[i] < 0) {
    const reg = [i], cols = new Set(), borders = new Set(); id[i] = regs.length;
    for (let k = 0; k < reg.length; k++) for (const n of NB[reg[k]]) {
      if (!b[n]) { if (id[n] < 0) { id[n] = regs.length; reg.push(n); } }
      else { cols.add(b[n]); borders.add(n); }
    }
    regs.push({ points: reg, size: reg.length, cols, b: borders.size });
  }
  return { id, regs };
}
function hexDist(i, j) {
  const dq = P[i][0] - P[j][0], dr = P[i][1] - P[j][1];
  return Math.max(Math.abs(dq), Math.abs(dr), Math.abs(dq + dr));
}
// 連の眼を数える（六方向の隣接点がすべて自石で囲まれた空点を眼とみなす）。
function countEyes(b, g, color) {
  const own = new Set(g), eyes = new Set();
  for (const stone of g) for (const n of NB[stone]) {
    if (b[n] || eyes.has(n)) continue;
    const around = NB[n];
    if (around.length >= 3 && around.every(x => b[x] === color || own.has(x))) eyes.add(n);
  }
  return eyes.size;
}
function territoryNowForAI(b, p, regs) {
  // 「新しく確保できる地」の候補。すでに自分の確定地になっている空間は含めず、
  // 無所属の大きな空間、または複数色が接している争い中の大きな空間だけを見る。
  return regs.some(r => r.size >= 6 && (r.cols.size === 0 || r.cols.size > 1));
}
function aiChoose() {
  const b = G.board, p = G.turn, radius = SIDE - 1;
  const occupied = b.reduce((n, v) => n + (v ? 1 : 0), 0);
  const fill = occupied / b.length;
  // 10手目以降は盤面の占有率にかかわらず中盤の展開評価へ移る。
  const moveNumber = Math.max((G.seen || []).length, occupied) + 1;
  const opening = moveNumber < 10 && fill < 0.30;
  const midgame = moveNumber >= 10;
  const endgame = fill > 0.62;
  // プレイヤーごとに性格を固定。1=堅実、2=大模様、3=攻撃型。
  const style = p % 3 === 1 ? 'territory' : p % 3 === 2 ? 'framework' : 'fighter';
  const { id, regs } = regionInfo(b);
  const stones = Array.from({length:(G.playerCount||3)+1},()=>[]);
  b.forEach((v, i) => { if (v) stones[v].push(i); });

  // 序盤の展開方向を6辺から選ぶ。自石が比較的多く、敵石が少ない辺を1〜2辺選び、
  // その辺側の半分〜約70%を主な展開範囲にする。盤面の反対側へ散りすぎる手を抑える。
  const edgeDefs = [
    {name:'+q', coord:([q,r])=>q}, {name:'+r', coord:([q,r])=>r},
    {name:'q+r+', coord:([q,r])=>q+r}, {name:'-q', coord:([q,r])=>-q},
    {name:'-r', coord:([q,r])=>-r}, {name:'q+r-', coord:([q,r])=>-(q+r)}
  ];
  const edgeStats = edgeDefs.map((edge, ei) => {
    let own=0, enemy=0, ownNear=0, enemyNear=0;
    for (let j=0;j<P.length;j++) {
      const v=b[j]; if(!v) continue;
      const d=radius-edge.coord(P[j]);
      if(d<=2) { if(v===p) { own+=1; ownNear += d===0?1.5:d===1?1.2:1; } else { enemy+=1; enemyNear += d===0?1.5:d===1?1.2:1; } }
    }
    // 自石の足場を優先しつつ、敵石の少ない辺を選ぶ。まだ自石がない場合は敵の薄い辺へ。
    const score = ownNear*2.2 - enemyNear*1.45 + (own===0 && enemy===0 ? 0.15 : 0);
    return {ei, score, own, enemy};
  });
  edgeStats.sort((a,b)=>b.score-a.score);
  // 序盤は1〜2辺だけに偏らず、上位4辺を候補にして盤面の複数方向へ布石を広げる。
  // 上位辺の評価差は後段のソフトな加点で扱い、展開先を固定しすぎない。
  const preferredEdges = edgeStats.slice(0, 4).map(e => e.ei);
  const preferredCoords = preferredEdges.map(ei=>edgeDefs[ei].coord);
  // 六つの頂点から3線ずつ内側に入った「三三」候補。盤サイズに合わせて自動計算する。
  const sanOffset = Math.max(0, radius - 3);
  const sanSanTargets = [...new Set([
    [ sanOffset, 0], [ sanOffset,-sanOffset], [0,-sanOffset],
    [-sanOffset, 0], [-sanOffset, sanOffset], [0, sanOffset]
  ].map(([q,r]) => M[q + ',' + r]).filter(i => i !== undefined))];
  const sanClaimRadius = Math.min(2, Math.max(0, Math.floor(sanOffset / 3)));
  const unclaimedSanTargets = sanSanTargets.filter(t =>
    !b.some((v,j) => v && hexDist(t,j) <= sanClaimRadius)
  );
  const openingSanTargets = unclaimedSanTargets.length ? unclaimedSanTargets : sanSanTargets;
  // 各三三周辺の混み具合を数え、石が少ない方向ほど次の布石候補として優先する。
  const sanTargetLoads = sanSanTargets.map(t => ({
    target: t,
    load: b.reduce((n, v, j) => n + (v && hexDist(t, j) <= 2 ? 1 : 0), 0)
  }));
  const minSanLoad = sanTargetLoads.length ? Math.min(...sanTargetLoads.map(x => x.load)) : 0;
  const balancedSanTargets = sanTargetLoads
    .filter(x => x.load <= minSanLoad + 1)
    .map(x => x.target);
  // 初手は空いている三三周辺から選び、同程度ならランダムにして定型化を避ける。
  const openingSanFocusPool = balancedSanTargets.length ? balancedSanTargets : openingSanTargets;
  const openingSanFocus = openingSanFocusPool.length
    ? openingSanFocusPool[Math.floor(Math.random() * openingSanFocusPool.length)] : null;
  const groups = new Map();
  for (let i = 0; i < b.length; i++) if (b[i] && !groups.has(i)) {
    const g = group(b, i), libs = libCount(b, g), eyes = countEyes(b, g, b[i]);
    for (const x of g) groups.set(x, { stones: g, libs, eyes, color: b[i] });
  }
  const uniqueGroups = [...new Map([...groups.values()].map(g => [g.stones[0], g])).values()];
  const distanceToStones = (i, list) => {
    let d = 99;
    for (const j of list) d = Math.min(d, hexDist(i, j));
    return d;
  };
  // 二眼のある連を持たず、二眼を作る見込みも価値ある領域も尽きた場合は投了候補にする。
  const ownGroups = new Map();
  for (let i = 0; i < b.length; i++) if (b[i] === p && !ownGroups.has(i)) {
    const g = group(b, i);
    const eyes = countEyes(b, g, p);
    for (const x of g) ownGroups.set(x, { stones: g, eyes });
  }
  const uniqueOwnGroups = [...new Map([...ownGroups.values()].map(g => [g.stones[0], g])).values()];
  const hasOwnTwoEyeGroup = uniqueOwnGroups.some(g => g.eyes >= 2);
  let canCreateEye = false, canCreateTwoEyeGroup = false, canMakeNewSixLand = false;
  const currentTerr = territoryForBoard(b);
  if (!hasOwnTwoEyeGroup && fill > 0.50) {
    // 眼を1つ作れるだけでは生きているとはみなさず、二眼を作れる候補を探す。
    for (let i = 0; i < P.length && !canCreateTwoEyeGroup; i++) {
      if (b[i]) continue;
      const test = sim(b, i, p);
      if (!test) continue;
      const g = group(test.a, i), afterEyes = countEyes(test.a, g, p);
      const adjacentOwn = NB[i].filter(n => b[n] === p).length;
      if (afterEyes > 0 || (adjacentOwn >= Math.max(2, NB[i].length - 1) && NB[i].every(n => !b[n] || b[n] === p))) canCreateEye = true;
      if (afterEyes >= 2) canCreateTwoEyeGroup = true;
    }
    // 6目以上の新しい地：合法手の結果、現在より自分の地が6目以上増える場合。
    for (let i = 0; i < P.length && !canMakeNewSixLand; i++) {
      if (b[i]) continue;
      const test = sim(b, i, p);
      if (!test) continue;
      const afterTerr = territoryForBoard(test.a);
      if ((afterTerr[p] || 0) - (currentTerr[p] || 0) >= 6) canMakeNewSixLand = true;
    }
  }
  const hasLargeUnclaimedLand = territoryNowForAI(b, p, regs);
  const hasValuableEnemyArea = regs.some(r => r.size >= 9 && r.cols.size === 1 && !r.cols.has(p));
  const hasValuableArea = hasLargeUnclaimedLand || hasValuableEnemyArea;
  const resignationEligible = midgame && !hasOwnTwoEyeGroup && !canCreateTwoEyeGroup &&
    !canMakeNewSixLand && !hasValuableArea;

  let best = -1, bestScore = -Infinity;
  const distTo = (i, list) => {
    let d = 99;
    for (const j of list) { const x = hexDist(i, j); if (x < d) d = x; }
    return d;
  };
  // 現在の厳密な地。終盤は地を埋める手より、境界・ダメ・侵入を優先する。
  const territoryNow = territory();
  for (let i = 0; i < P.length; i++) {
    if (b[i]) continue;
    const move = sim(b, i, p);
    if (!move) continue;
    // reg は中盤の展開評価でも参照するため、すべての使用箇所より前に初期化する。
    const reg = regs[id[i]];
    const ownGroup = group(move.a, i), libsAfter = libCount(move.a, ownGroup);
    let score = 0;
    // 捕獲は最優先。アタリの救出と相手の弱い石への圧力。
    // 取れる石は取るが、確定捕獲を過剰に優先して他の大場を逃さない。
    score += move.cap.length * (endgame ? 100 : 125);
    const adjacentGroups = new Set();
    for (const n of NB[i]) if (b[n]) {
      const info = groups.get(n);
      if (!info || adjacentGroups.has(info.stones[0])) continue;
      adjacentGroups.add(info.stones[0]);
      if (info.color === p) {
        if (info.libs === 1 && libsAfter > 1) score += 195;
        else if (info.libs === 2 && libsAfter > 2) score += 65;
        // 切断や捕獲を防ぐ接続を大きく評価する。
        if (info.libs <= 2) score += 35;
      } else {
        if (info.libs === 1) score += 78;
        else if (info.libs === 2) score += 31;
        else if (info.libs === 3) score += 9;
      }
    }
    if (libsAfter === 1) score -= 145 + ownGroup.length * 30;
    else if (libsAfter === 2) score -= 28 + ownGroup.length * 6;
    else if (libsAfter === 3) score -= 4 + ownGroup.length * 1.5;

    // 眼づくり：自分の石に囲まれた空点を眼候補として評価。
    // とくに呼吸点の少ない大きな連を守る眼は、単なる地の拡張より優先する。
    const adjacentOwn = NB[i].filter(n => b[n] === p).length;
    const adjacentEnemy = NB[i].filter(n => b[n] && b[n] !== p).length;
    const degree = NB[i].length;
    const eyeLike = adjacentOwn >= Math.max(2, degree - 1) && adjacentEnemy === 0;
    // この手で隣接する空点が眼として完成する数を数える。
    let eyesCreated = 0;
    for (const n of NB[i]) if (!b[n]) {
      const around = NB[n];
      if (around.every(x => x === i || b[x] === p)) eyesCreated++;
    }
    const threatenedOwn = new Set();
    for (const n of NB[i]) if (b[n] === p) {
      const info = groups.get(n);
      if (info && info.libs <= 4) threatenedOwn.add(info.stones[0]);
    }
    if (eyeLike) score += 3; // 眼候補点への無意味な着手自体は強く優遇しない
    if (eyesCreated) score += eyesCreated * (threatenedOwn.size ? 42 : 28);
    if (threatenedOwn.size && eyesCreated) score += 22 + threatenedOwn.size * 8;

    // 着手後の自連に実際にいくつ眼ができるかを確認。二眼を作れる手は最優先級にする。
    const postEyes = countEyes(move.a, ownGroup, p);
    const beforeEyes = countEyes(b, ownGroup.filter(x => b[x] === p), p);
    if (postEyes >= 2 && beforeEyes < 2) score += 260 + (postEyes - 2) * 35;
    else if (postEyes === 1 && beforeEyes === 0) score += 95;
    if (postEyes < 2 && ownGroup.length >= 3 && libsAfter <= 3) score -= 18;

    // 多人数戦の1手先読み：次に動く相手だけでなく、全相手の合法応手を検査する。
    // 眼の中で色を変えながら取り返されるような「取っても維持できない捕獲」を強く避ける。
    if (libsAfter <= 4 && move.cap.length === 0) {
      const libs = new Set();
      for (const stone of ownGroup) for (const n of NB[stone]) if (!move.a[n]) libs.add(n);
      let immediateCapture = false;
      for (const lib of libs) {
        for (let enemy = 1; enemy <= (G.playerCount || 3); enemy++) {
          if (enemy === p || G.out[enemy]) continue;
          const reply = sim(move.a, lib, enemy);
          if (reply && ownGroup.some(st => reply.cap.includes(st))) { immediateCapture = true; break; }
        }
        if (immediateCapture) break;
      }
      if (immediateCapture) score -= 1050 + ownGroup.length * 90;
      else if (libsAfter === 2) score -= ownGroup.length >= 4 ? 85 : 38;
    }
    // 捕獲直後に自分の石が取り返される形も検査する。取った石の解放点に
    // すぐ相手が打てて、捕獲した自連が落ちるなら「捕獲点数」を評価しない。
    if (move.cap.length > 0 && libsAfter <= 5) {
      const libs = new Set();
      for (const stone of ownGroup) for (const n of NB[stone]) if (!move.a[n]) libs.add(n);
      let recaptured = false;
      for (const lib of libs) for (let enemy = 1; enemy <= (G.playerCount || 3); enemy++) {
        if (enemy === p || G.out[enemy]) continue;
        const reply = sim(move.a, lib, enemy);
        if (reply && ownGroup.some(st => reply.cap.includes(st))) { recaptured = true; break; }
      }
      if (recaptured) score -= 1100 + ownGroup.length * 95;
    }
    // 1線（最外周）は、眼の完成・捕獲/救出・終盤のヨセ以外では大きく抑制。

    const nearestAll = distTo(i, stones.slice(1).flat());
    const nearestOwn = distTo(i, stones[p]);
    const [q, r] = P[i], radial = Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)) / Math.max(1, radius);
    const starDist = Math.max(1, Math.round(radius * 2 / 3));
    const star = (Math.abs(q) === starDist && Math.abs(r) === starDist) ||
      (Math.abs(q) === starDist && r === 0) || (Math.abs(r) === starDist && q === 0) ||
      (q === starDist && r === -starDist) || (q === -starDist && r === starDist) ||
      (q === 0 && r === 0);

    // 各プレイヤーの初手は、他の石でまだ使われていない三三周辺へ展開する。
    // 三三点そのものだけでなく、周囲1〜数マスも候補にし、相手石の隣への反射的な着手を防ぐ。
    if (opening && stones[p].length === 0 && openingSanFocus !== null) {
      const sanDist = hexDist(i, openingSanFocus);
      if (sanDist <= 1) {
        // 三三の中心と隣接1マスを同程度に高くし、毎局同じ点へ固定されないよう揺らす。
        score += 135 + Math.random() * 45 + (sanDist === 0 ? 5 : 0);
      } else {
        score -= Math.min(190, 55 + Math.max(0, sanDist - 2) * 28);
      }
    }

    if (opening) {
      // 序盤は塊の隣を埋めず、盤面全体へ展開。辺に寄りすぎず、星付近を評価する。
      const target = style === 'territory' ? (radius <= 4 ? 2.3 : 3.0)
        : style === 'framework' ? (radius <= 4 ? 3.0 : 4.2) : (radius <= 4 ? 2.5 : 3.5);
      score += 18 - Math.abs(nearestAll - target) * (style === 'framework' ? 5 : 7);
      score += Math.min(nearestOwn, radius + 1) * (style === 'framework' ? 2.0 : 1.2);
      const idealRadial = style === 'territory' ? 0.68 : style === 'framework' ? 0.48 : 0.58;
      score += (0.70 - Math.abs(radial - idealRadial)) * (style === 'framework' ? 24 : 20);
      if (star) score += style === 'framework' ? 10 : 5;

      // 選んだ1〜2辺を足場にする。辺から盤面中央を越えて反対側へ行くほど減点し、
      // 辺から少し内側（約30〜70%）に散らばる手を優先する。
      const edgeDepths = preferredCoords.map(coord => radius - coord(P[i]));
      const bestDepth = Math.min(...edgeDepths);
      const sideCoord = Math.max(...preferredCoords.map(coord => coord(P[i])));
      if (sideCoord >= 0) {
        // 複数方向へ展開できるよう、選好辺の内側は緩やかに加点し、中心越えも過度には罰しない。
        const depthRatio = bestDepth / Math.max(1, 2*radius);
        if (depthRatio <= 0.70) score += 10 - depthRatio*6;
        else score -= 5 + (depthRatio-0.70)*22;
        if (sideCoord >= radius*0.35 && bestDepth >= 1) score += 4;
      } else {
        score -= 6 + Math.abs(sideCoord)*1.2;
      }

      // 三三の各方向の混雑差を評価。空いている方向への布石に最大18点を加点する。
      if (sanTargetLoads.length) {
        const nearestTarget = sanTargetLoads.reduce((best, x) =>
          hexDist(i, x.target) < hexDist(i, best.target) ? x : best, sanTargetLoads[0]);
        const loadAdvantage = Math.max(0, minSanLoad + 2 - nearestTarget.load);
        score += Math.min(18, loadAdvantage * 7);
      }

      // 序盤の「点」ではなく「境界線」を作る評価。
      // 自石から2〜4間ほど離れ、敵の勢力にも近すぎず遠すぎない場所を、
      // 囲いの輪郭を描く候補として評価する。
      const ownD = nearestOwn;
      let nearestEnemy = 99;
      for (const enemy of Array.from({length:G.playerCount||3},(_,i)=>i+1)) if (enemy !== p) {
        nearestEnemy = Math.min(nearestEnemy, distTo(i, stones[enemy]));
      }
      if (stones[p].length) {
        const markerDistance = style === 'framework' ? 4 : style === 'territory' ? 2.5 : 3;
        score += 12 - Math.abs(ownD - markerDistance) * (style === 'framework' ? 3 : 4);
      }
      // 相手の石がある側へも目を配るが、無防備な接触や相手の地の中には突っ込まない。
      if (nearestEnemy <= 5) {
        score += Math.max(0, 6 - nearestEnemy) * (style === 'fighter' ? 2.5 : 1.8);
        if (nearestEnemy === 1) score -= style === 'fighter' ? 0 : 8;
      }
      // 自石と敵石の間に位置し、境界を押さえる着手を加点。
      if (ownD < 99 && nearestEnemy < 99) {
        const balancedFrontier = Math.abs(ownD - nearestEnemy);
        if (ownD >= 2 && ownD <= 5 && nearestEnemy >= 2 && nearestEnemy <= 5)
          score += Math.max(0, 8 - balancedFrontier * 2);
      }
      if (NB[i].some(n => b[n] === p)) score -= style === 'territory' ? 3 : 11;
      // 直接接触より、相手との境界を一間〜数間あけて先に形作る。
      if (NB[i].some(n => b[n] && b[n] !== p)) score -= style === 'fighter' ? 0 : 9;

      // 3線相当の地点から境界を組み、後で囲い切れる形を優先する。
      if (style === 'territory') score += (0.70 - Math.abs(radial - 0.70)) * 18;
      if (style === 'framework') score += (0.48 - Math.abs(radial - 0.48)) * 15;

      // すでに相手が伸びている側を完全に無視して遠方へ散らばるのを防ぐ。
      // 近くに敵の勢力がある場合、自石との連携が取れる境界候補を少し優先。
      if (nearestEnemy <= 4 && ownD <= 5 && ownD >= 2) score += 5;
      if (nearestEnemy > 6 && ownD > 5) score -= 8;
    } else {
      // 中盤も「隣に置くほど良い」評価にしない。石の密集を抑え、地の輪郭を広げる。
      score += Math.min(nearestOwn, 5) * (endgame ? 0.8 : style === 'framework' ? 3.5 : 2.8);
      if (!endgame && nearestOwn === 1) score -= style === 'fighter' ? 4 : 13;
      if (!endgame && nearestOwn === 2) score += style === 'framework' ? 5 : 3;
      if (midgame && stones[p].length > 0) {
        // 10手目以降は自石から2〜4間の「ヒラキ」を使い、空いた地の輪郭を作る。
        if (nearestOwn >= 2 && nearestOwn <= 4) score += 30 + (nearestOwn === 2 ? 9 : nearestOwn === 3 ? 20 : 5);
        else if (nearestOwn === 5) score += 4;
        // 自石から遠く、敵の戦術にも関わらない孤立点は大幅に抑える。
        if (nearestOwn > 5 && move.cap.length === 0) score -= 58 + Math.min(28, (nearestOwn - 5) * 7);

        // 周囲が空いている方向へ二間程度の間隔で進み、新しい地の輪郭を作る手を強く評価。
        // 近くに敵がいないこと、盤端に追い込まれすぎないこと、空点が十分残っていることを確認。
        const nearbyEmpty = NB[i].filter(n => !b[n]).length;
        let openSecondRing = 0;
        for (let j = 0; j < b.length; j++) {
          if (b[j] || j === i || hexDist(i, j) !== 2) continue;
          openSecondRing++;
        }
        let openEnemyDist = 99;
        for (let enemy = 1; enemy <= (G.playerCount || 3); enemy++) if (enemy !== p)
          openEnemyDist = Math.min(openEnemyDist, distTo(i, stones[enemy]));
        if (nearestOwn >= 2 && nearestOwn <= 4 && openEnemyDist > 4 &&
            nearbyEmpty >= Math.min(4, degree - 1) && openSecondRing >= 4 &&
            (!reg || reg.cols.size === 0 || reg.cols.has(p))) {
          score += 58 + Math.min(18, openSecondRing * 2) + (nearestOwn === 2 ? 8 : 0);
        }
      }
      const midIdeal = style === 'territory' ? 0.70 : style === 'framework' ? 0.48 : 0.60;
      score += (0.70 - Math.abs(radial - midIdeal)) * (endgame ? 4 : style === 'framework' ? 13 : 10);
      // 攻撃型は相手の石の切断点や薄い連の近くを狙う。
      if (style === 'fighter') {
        for (const n of NB[i]) if (b[n] && b[n] !== p) {
          const info = groups.get(n);
          if (info && info.libs <= 3) score += info.libs === 1 ? 45 : info.libs === 2 ? 18 : 8;
        }
      }
      // 境界をつなぐ展開：堅実型は短いノビ・ハネ、大模様型は広いヒラキを評価。
      if (style === 'territory' && nearestOwn >= 2 && nearestOwn <= 3) score += 7;
      if (style === 'framework' && nearestOwn >= 3 && nearestOwn <= 5) score += 7;
      // 相手の勢力が近いのに自分の石から遠すぎる場所へ打つのは控え、
      // 自石と相手の間で境界を支える着手を選びやすくする。
      let frontierEnemyDist = 99;
      for (const enemy of Array.from({length:G.playerCount||3},(_,i)=>i+1)) if (enemy !== p) {
        frontierEnemyDist = Math.min(frontierEnemyDist, distTo(i, stones[enemy]));
      }
      if (nearestOwn >= 2 && nearestOwn <= 5 && frontierEnemyDist >= 2 && frontierEnemyDist <= 5)
        score += 8;
      if (nearestOwn === 1 && move.cap.length === 0) score -= 5;
      if (nearestOwn > 5 && frontierEnemyDist > 5 && !endgame) score -= 7;
      for (const enemy of Array.from({length:G.playerCount||3},(_,i)=>i+1)) if (enemy !== p) {
        let nearestWeak = 99;
        for (const j of stones[enemy]) {
          const info = groups.get(j);
          if (info && info.libs <= 3) nearestWeak = Math.min(nearestWeak, hexDist(i, j));
        }
        if (nearestWeak <= 3) {
          // 近づくだけの接触戦を避け、攻撃型でも安全な距離から圧力をかける。
          score += (4 - nearestWeak) * (endgame ? 2 : style === 'fighter' ? 4 : 1.5);
        }
      }
    }

    if (reg) {
      // 1〜2目の相手の確定地は、捕獲や二眼形成などの明確な利益がない限り埋めない。
      // 小さな眼の中で多人数が順番に取り返す無意味な連鎖を防ぐ。
      if (reg.cols.size === 1 && !reg.cols.has(p) && reg.size <= 2 && move.cap.length === 0 && postEyes < 2) {
        score -= 210 + (libsAfter <= 2 ? 100 : 0);
      }
      if (reg.cols.size === 1) {
        const owner = [...reg.cols][0];
        if (owner === p) {
          // 自分の確定地を埋めるのは原則損。生き石の眼を埋める手も避ける。
          score -= reg.size <= 2 ? 75 : 22;
        } else {
          // 相手の地への侵入は、小さな領域への自殺的な手を避けて選別する。
          if (reg.size <= 2) score -= 90;
          else if (reg.size <= 5) score -= endgame ? 8 : 16;
          else score += endgame ? 2 : style === 'fighter' ? -3 : -12;
          // 相手の地への侵入は「生き残れる見込み」がある場合だけ選ぶ。
          // 味方から遠く、眼がなく、呼吸点も少ない単独侵入は双方の損なので大幅減点。
          const isolatedInvasion = adjacentEnemy === 0 && nearestOwn > 3 && move.cap.length === 0;
          if (isolatedInvasion) score -= reg.size >= 3 ? (endgame ? 35 : 42) : 24;
          if (isolatedInvasion && postEyes < 2 && libsAfter <= 5)
            score -= 145 + Math.max(0, 5 - libsAfter) * 24 + ownGroup.length * 12;
          if (isolatedInvasion && postEyes === 0 && libsAfter <= 3) score -= 100;
          if (libsAfter <= 2 && move.cap.length === 0) score -= 35;
          if (style === 'fighter' && reg.size >= 6 && libsAfter >= 4 && nearestOwn <= 3) score += 10;
        }
      } else if (reg.cols.size >= 2) {
        // 中立地・境界の空点。終盤に残ったダメを埋める。
        score += endgame ? 10 : 3;
        if (reg.size === 1) score += endgame ? 9 : 2;
      } else {
        // まだ誰の地でもない大きな空間は、序中盤の布石候補。
        score += opening ? 0 : Math.min(reg.size, 12) * (endgame ? 0.15 : 0.45);
      }
    }

    // 味方へつながらず、二眼を作る余地もない敵領域への単独侵入は強く減点する。
    // 大きな領域や、捕獲・連絡・二眼形成が見込める手はこの条件から除外する。
    if (reg && reg.cols.size >= 1 && !reg.cols.has(p) && reg.size < 9 &&
        adjacentOwn === 0 && nearestOwn > 3 && postEyes < 2 && move.cap.length === 0) {
      score -= 230 + (reg.size <= 5 ? 90 : 0) + Math.max(0, 4 - libsAfter) * 24;
      if (libsAfter <= 3) score -= 100;
    }
    // 相手の確定地・勢力内で、味方につながらず二眼を作る空間もない侵入は致命的に減点。
    // この手を選ぶくらいなら、後段の中立点（ダメ）を詰める方がよい。
    if (reg && reg.cols.size === 1 && !reg.cols.has(p) && reg.size < 12 &&
        adjacentOwn === 0 && nearestOwn > 2 && postEyes < 2 && move.cap.length === 0) {
      score -= 520 + (reg.size <= 6 ? 180 : 0) + (libsAfter <= 3 ? 130 : 0);
    }

    // 他色同士が戦っている場所への、味方とつながらない割り込みを抑制する。
    // 捕獲・救出・眼づくりの明確な狙いがないなら、戦場から離れて自分の地を広げる。
    let fightDistance = 99;
    for (let enemy = 1; enemy <= (G.playerCount || 3); enemy++) if (enemy !== p)
      fightDistance = Math.min(fightDistance, distTo(i, stones[enemy]));
    const fightingNearby = fightDistance <= 2 || adjacentEnemy > 0;
    const hasOwnConnection = adjacentOwn > 0;
    const clearTacticalPurpose = move.cap.length > 0 || eyesCreated > 0 || postEyes >= 2 ||
      threatenedOwn.size > 0 || [...adjacentGroups].some(key => { const g = groups.get(key); return g && g.color === p && g.libs <= 2; });
    if (fightingNearby && !hasOwnConnection && nearestOwn > 2 && !clearTacticalPurpose) {
      score -= fightDistance <= 1 ? 245 : 170;
    }
    // 相手石に接するだけで、自分の石とはつながらない着手は特に避ける。
    if (adjacentEnemy > 0 && adjacentOwn === 0 && move.cap.length === 0 &&
        postEyes < 2 && !threatenedOwn.size) score -= 210;

    // ===== 接続・切断・眼・境界の急所 =====
    const ownAdjacentInfos = [...adjacentGroups].map(k => groups.get(k)).filter(g => g && g.color === p);
    const enemyAdjacentInfos = [...adjacentGroups].map(k => groups.get(k)).filter(g => g && g.color !== p);
    const edgeDistance = radius - Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r));
    const nearestEnemyStrategic = Math.min(...Array.from({length:G.playerCount||3},(_,j)=>j+1)
      .filter(c => c !== p).map(c => distanceToStones(i, stones[c])), 99);

    // 序盤の最初の4手程度は、自石から7マス以内を探索範囲にし、
    // その中で最も敵石から離れた「到達不能極」的な空点へ展開する。
    // 敵石が複数色ある場合は、最も近い敵石までの距離を使って安全度を測る。
    if (occupied <= 4 && stones[p].length > 0 && nearestOwn <= 7 && !endgame) {
      const safeDistance = Math.min(8, nearestEnemyStrategic);
      score += safeDistance * 13;
      if (nearestEnemyStrategic >= 5) score += 16;
      if (nearestEnemyStrategic <= 2) score -= 18;
    }

    // 大きい連を壁へつなぐ：壁に近づき、かつ大きな自連からも遠くない着手を加点。
    if (edgeDistance <= 2) {
      for (const g of uniqueGroups) if (g.color === p && g.stones.length >= 3) {
        const toGroup = distanceToStones(i, g.stones);
        const groupEdgeDistance = Math.min(...g.stones.map(x => {
          const [gq,gr] = P[x];
          return radius - Math.max(Math.abs(gq), Math.abs(gr), Math.abs(gq + gr));
        }));
        if (toGroup <= 2 && edgeDistance < groupEdgeDistance) {
          score += 72 + Math.min(g.stones.length, 10) * 7 + (g.eyes < 2 ? 30 : 0);
        }
      }
    }

    // 自分の弱い連（まだ二眼がなく、呼吸点が少ない）を強い自連へつなぐ。
    // 1手で合流する点は大きく、そこへ向かう中継点も距離が縮むほど評価する。
    for (const weak of uniqueGroups) {
      if (weak.color !== p || weak.eyes >= 2 || weak.libs > 5) continue;
      const weakD = distanceToStones(i, weak.stones);
      // 中盤以降、二眼のない自連が二眼を作れる形へ進む手を最優先級にする。
      if (midgame && weakD <= 2 && postEyes > weak.eyes) {
        score += (postEyes >= 2 ? 310 : 155) + (weak.libs <= 3 ? 95 : 35)
          + Math.min(weak.stones.length, 8) * 8;
      }
      for (const strong of uniqueGroups) {
        if (strong.color !== p || strong.stones[0] === weak.stones[0]) continue;
        const isStrong = strong.eyes >= 2 || strong.libs >= 4 || strong.stones.length >= 5;
        if (!isStrong) continue;
        const strongD = distanceToStones(i, strong.stones);
        if (weakD > 2 || strongD > 3) continue;
        const oldGap = Math.min(...weak.stones.map(a => distanceToStones(a, strong.stones)));
        if (weakD + strongD <= oldGap) {
          score += (midgame ? 190 : 88) + (weakD === 1 ? (midgame ? 75 : 34) : 0)
            + (strongD === 1 ? (midgame ? 65 : 28) : 0)
            + Math.min(weak.stones.length, 8) * (midgame ? 9 : 4);
        }
      }
    }

    // 接続急所：ここを相手に占められると自分の連同士が分断されやすい点を急いで押さえる。
    if (ownAdjacentInfos.length >= 2) {
      const weakAmong = ownAdjacentInfos.some(g => g.eyes < 2 && g.libs <= 4);
      const cutThreat = ownAdjacentInfos.some(g => g.libs <= 2);
      score += 105 + Math.min(ownAdjacentInfos.reduce((n,g)=>n+g.stones.length,0), 12) * 4;
      if (weakAmong) score += 75;
      if (cutThreat) score += 65;
      if (nearestEnemyStrategic <= 2) score += 28;
    }

    // 相手の同色の別々の連がこの点を使ってつながれる場合は、先回りして接続点を占める。
    const enemyBridgeColors = new Map();
    for (const g of enemyAdjacentInfos) {
      const arr = enemyBridgeColors.get(g.color) || [];
      if (!arr.some(x => x.stones[0] === g.stones[0])) arr.push(g);
      enemyBridgeColors.set(g.color, arr);
    }
    for (const [enemyColor, arr] of enemyBridgeColors) if (arr.length >= 2) {
      score += 48 + Math.min(arr.reduce((n,g)=>n+g.stones.length,0), 10) * 2;
      if (arr.some(g => g.eyes < 2 && g.libs <= 4)) score += 14;
    }

    // 相手の弱い連が二眼を作るのに使える候補点・周辺点を押さえる。
    // 既に二眼がある連や、確定した小さな眼を無意味に埋める手は対象外。
    for (const enemyGroup of uniqueGroups) {
      if (enemyGroup.color === p || enemyGroup.eyes >= 2 || enemyGroup.libs > 5) continue;
      const d = distanceToStones(i, enemyGroup.stones);
      if (d <= 2 && enemyGroup.eyes === 1) score += d === 1 ? 30 : 15;
      else if (d <= 2 && enemyGroup.eyes === 0 && enemyGroup.libs <= 3) score += d === 1 ? 16 : 8;
    }

    // 自分の地と相手の地が接する境界・中立地を埋める。境界の急所は特に優先。
    if (reg && reg.cols.has(p) && [...reg.cols].some(c => c !== p)) {
      if (nearestOwn <= 3 && nearestEnemyStrategic <= 3) score += endgame ? 32 : 25;
      else score += endgame ? 20 : 12;
      // 中立点は、眼の作れない敵地への侵入より安全で実利のある候補。
      if (midgame && libsAfter >= 2 && !eyeLike) score += 18;
      if (endgame && libsAfter >= 2 && !eyeLike) score += 24;
    }

    // 周囲（六角距離5以内）に敵石がない開けた地点を評価する。
    if (nearestEnemyStrategic > 5) score += opening ? 20 : endgame ? 4 : 12;

    // 自石から画面上の直線距離√3となる斜め位置（軸座標差の二乗和 q²+qr+r²=3）。
    // 一間の隣接ではないが、次の連絡・展開につながる斜めの形を評価する。
    const diagonalSqrt3 = stones[p].some(j => {
      const dq = q - P[j][0], dr = r - P[j][1];
      return dq*dq + dq*dr + dr*dr === 3;
    });
    if (diagonalSqrt3) score += opening ? 18 : endgame ? 5 : 14;

    // 終盤は現在の地を直接埋めるより、相手の地を減らす/中立点を取る手を優先。
    if (endgame) {
      if (reg && reg.cols.size === 1 && reg.cols.has(p)) score -= 18;
      if (reg && reg.cols.size === 1 && !reg.cols.has(p) && reg.size >= 3) score += 5;
      if (G.passes > 0) score += 2;
    }
    // 終盤は、自分の確定地の外に残った「眼がなく、まだ殺せる相手の連」を
    // 放置せず、呼吸点を詰めて捕獲する。自分の地を埋める手は対象外。
    // 取り返し合いを防ぐため、着手後の相手連の呼吸点と自連の安全性も確認する。
    if (endgame && !(reg && reg.cols.size === 1 && reg.cols.has(p))) {
      const checkedEnemyGroups = new Set();
      for (const n of NB[i]) {
        const enemy = b[n];
        if (!enemy || enemy === p || G.out[enemy]) continue;
        const enemyGroup = group(b, n), enemyKey = enemyGroup[0];
        if (checkedEnemyGroups.has(enemyKey)) continue;
        checkedEnemyGroups.add(enemyKey);
        const enemyEyes = countEyes(b, enemyGroup, enemy);
        const enemyLibsBefore = libCount(b, enemyGroup);
        if (enemyEyes >= 2) continue; // 二眼がある相手は死に石扱いしない
        const afterEnemyGroup = enemyGroup.filter(x => move.a[x] === enemy);
        if (!afterEnemyGroup.length) continue;
        const enemyLibsAfter = libCount(move.a, afterEnemyGroup);
        if (enemyLibsAfter < enemyLibsBefore) {
          // 眼のない弱い連を実際に追い詰める手を高く評価。
          score += (enemyEyes === 0 ? 34 : 12) + Math.max(0, enemyLibsBefore - enemyLibsAfter) * 12;
          if (enemyLibsAfter === 1) score += 72 + Math.min(enemyGroup.length, 8) * 9;
          else if (enemyLibsAfter === 2) score += 30;
          // 大きな死に石候補を殺す価値を反映。ただし自分も取られる手は除外。
          if (enemyEyes === 0 && enemyLibsBefore <= 5) score += Math.max(0, 6 - enemyLibsAfter) * 14;
        }
      }
      if (move.cap.length) score += move.cap.length * 80;
      // ダメ埋め：中立の空点に安全に石を残せるなら、石1個分の得点を見込んで優先。
      if (reg && reg.cols.size >= 2 && libsAfter >= 2) score += 16 + (reg.size === 1 ? 8 : 0);
      // 呼吸点が少なく眼のない敵連への安全な詰めを、終盤はさらに優先する。
      for (const n of NB[i]) {
        const enemy = b[n];
        if (!enemy || enemy === p || G.out[enemy]) continue;
        const eg = group(b, n);
        if (eg[0] !== n && eg[0] < n) continue;
        if (countEyes(b, eg, enemy) === 0) {
          const el = libCount(b, eg);
          if (el <= 3 && libsAfter >= 2) score += el === 1 ? 115 : el === 2 ? 70 : 35;
        }
      }
    }

    // 自石から横方向（画面上で同じ段）に空地が伸びている場合、
    // 内側へ寄せるだけの手より、横へ展開して地の輪郭を広げる手を少し優先する。
    // 同じ r 座標にある自石との距離が 2〜4 で、その間に石がなく、
    // 着手点のさらに横方向にも空点が続く場合だけ加点する。
    if (!endgame && stones[p].length > 0) {
      let horizontalExpansion = false;
      for (const j of stones[p]) {
        const [jq, jr] = P[j];
        if (jr !== r) continue;
        const dx = q - jq;
        const adx = Math.abs(dx);
        if (adx < 2 || adx > 4) continue;
        const step = Math.sign(dx);
        let clearLane = true;
        for (let k = 1; k < adx; k++) {
          const x = j + 0; // board indices are not linear neighbors; locate by coordinates below
          const targetQ = jq + step * k;
          const between = P.findIndex(([bq, br]) => bq === targetQ && br === jr);
          if (between < 0 || b[between]) { clearLane = false; break; }
        }
        if (!clearLane) continue;
        let openBeyond = 0;
        for (let k = 1; k <= 2; k++) {
          const targetQ = q + step * k;
          const beyond = P.findIndex(([bq, br]) => bq === targetQ && br === r);
          if (beyond >= 0 && !b[beyond]) openBeyond++;
        }
        if (openBeyond > 0) { horizontalExpansion = true; break; }
      }
      if (horizontalExpansion && adjacentEnemy === 0 && move.cap.length === 0) score += 12;
    }

    // 局所密集ペナルティ：近傍に石が多すぎる点は、眼/戦術手以外では避ける。
    // これにより相手の隣へ反射的に打ち続ける「ギュウギュウ」を抑える。
    const nearOwn2 = stones[p].filter(j => hexDist(i, j) <= 2).length;
    const nearEnemy2 = Array.from({length:G.playerCount||3},(_,i)=>i+1).filter(c => c !== p)
      .reduce((n, c) => n + stones[c].filter(j => hexDist(i, j) <= 2).length, 0);
    const localTactic = move.cap.length > 0 || threatenedOwn.size > 0 ||
      [...adjacentGroups].some(key => { const info = groups.get(key); return info && info.libs <= 2; });
    if (!endgame && !localTactic && !eyeLike) {
      score -= Math.max(0, nearOwn2 - 2) * (style === 'framework' ? 3 : 4);
      score -= Math.max(0, nearEnemy2 - 3) * (style === 'fighter' ? 1.5 : 3);
    }

    // 盤面端の石は囲える地が小さくなりやすい。最外周（1線）は原則避ける。
    // 例外：眼候補、捕獲/アタリ救出、終盤の実利あるヨセ。
    const tactical = move.cap.length > 0 || [...adjacentGroups].some(key => {
      const info = groups.get(key);
      return info && info.libs <= 2;
    });
    if (radial >= 0.96 && !eyeLike && !tactical && !endgame) score -= 28;
    else score -= Math.max(0, radial - 0.82) * (endgame ? 3 : 9);
    // 相手の地の中で即座に取られる手は、捕獲などの明確な狙いがなければ避ける。
    if (libsAfter <= 1 && move.cap.length === 0 && !eyeLike) score -= 65;
    score += Math.random() * (style === 'fighter' ? 2.0 : 0.9);
    if (score > bestScore) { bestScore = score; best = i; }
  }

  // 投了条件を満たす場合でも、まずは合法手を評価する。明確な得点手・延命手があれば打つ。
  if (resignationEligible && (best < 0 || bestScore < 18)) return -2;
  // 終盤は中立点（ダメ）を埋め、弱い相手連を攻める手を優先。
  // エリア得点では、中立点に安全に石を置くことは石1点の獲得になる。
  if (best < 0) return -1;
  if (endgame && bestScore < 12) return -1;
  if (G.passes > 0 && bestScore < (endgame ? 16 : -4)) return -1;
  return best;
}
const aiSeatOf = p => mode === 'online' ? !!(G.aiSeats ? G.aiSeats[p] : G.aiSeat === p) : seats[p] !== 'human';
