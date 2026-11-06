// ===== デバッグ用フック（E2E 検証・AI 性能確認用。UI には影響しない） =====
window.__hexagoDebug = {
  state: () => ({ board: G.board.slice(), turn: G.turn, over: G.over, phase: G.phase, playerCount: G.playerCount, size: G.size, seats: seats.slice(), mode, aiBusy, aiBudget: aiBudgetMs(), seen: G.seen.length, lastAI: lastAIStats }),
  think: (budget) => aiThink(aiStateSnapshot(), budget || aiBudgetMs()),
  engine: () => ({ worker: aiPool.length > 0, workers: aiPool.length, wantWorkers: aiPoolWant(), error: aiWorkerError, loaded: aiEngineLoaded(), workerUrl: AI_WORKER_URL }),
  setAIBudgetMs: (ms) => { aiTestBudgetMs = ms == null ? null : Math.max(1, ms | 0); return aiBudgetMs(); },
  legacy: () => aiChoose(),
  sim: (i) => sim(G.board, i, G.turn),
  mine: () => mine(),
  seats: () => seats.slice(),
  playMove: (i) => { const ok = play(i); if (ok) after(); return ok; },
  pass: () => { doPass(); after(); },
  setAllAI: () => setAllSeatModes('ai'),
  setAllHuman: () => setAllSeatModes('human'),
  newGame: (size) => { if (size) pendingSize = size; return reset(); },
  net: () => ({
    roomCode, isHost, myRole, myNickname,
    peerOpen: !!(peer && peer.open), peerDisconnected: !!(peer && peer.disconnected),
    conns: conns.length, hostConnOpen: !!(hostConn && hostConn.open),
    status: netStatus, session: !!readOnlineSession(),
  }),
  netDropGuestConn: () => {
    if (isHost) return false;
    if (hostConn) { try { hostConn.close(); } catch (e) { } hostConn = null; }
    scheduleGuestReconnect('テスト切断');
    return true;
  },
  netDropHostPeer: () => {
    if (!isHost) return false;
    if (peer) { peer.__ignoreNet = true; try { peer.destroy(); } catch (e) { } }
    peer = null;
    scheduleHostReconnect('テスト切断');
    return true;
  },
  setBoardForTest: (arr) => {
    G.board = arr.slice();
    G.dead = []; G.phase = 'playing'; G.over = false; G.result = null; G.hist = []; G.passes = 0; G.last = -1;
    setSeen(); render();
  },
  enterDeadPhase: () => { G.phase = 'dead'; G.dead = detectDeadStonesSmart(); updateUI(); save(); return G.dead.slice(); },
  deadInfo: () => ({ phase: G.phase, dead: G.dead.slice(), conservative: detectDeadStones(), smart: detectDeadStonesSmart() }),
  toggleDeadAt: (i) => {
    if (G.phase !== 'dead' || !G.board[i]) return G.dead.slice();
    const g = group(G.board, i);
    const isD = G.dead.includes(i);
    G.dead = isD ? G.dead.filter(x => !g.includes(x)) : [...new Set([...G.dead, ...g])];
    updateUI(); save();
    return G.dead.slice();
  },
  finishNow: () => { finishScore(); after(); return { over: G.over, result: G.result }; },
  scoreInfo: () => {
    const t = territory();
    const pc = G.playerCount || playerCount;
    const stones = Array.from({ length: pc + 1 }, (_, p) => p === 0 ? 0 : G.board.filter(v => v === p).length);
    return { territory: t, stones, total: t.map((v, i) => v + stones[i]) };
  },
};
