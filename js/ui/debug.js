// ===== デバッグ用フック（E2E 検証・AI 性能確認用。UI には影響しない） =====
window.__hexagoDebug = {
  state: () => ({ board: G.board.slice(), turn: G.turn, over: G.over, phase: G.phase, playerCount: G.playerCount, size: G.size, seats: seats.slice(), mode, aiMode: currentAIMode(), seatAIModes: seatAIModes.slice(), aiBusy, aiBudget: aiBudgetMs(G.turn), seen: G.seen.length, lastAI: lastAIStats, out: G.out.slice() }),
  think: (budget) => aiThink(aiStateSnapshot(), budget || aiBudgetMs(G.turn)),
  engine: () => ({ worker: aiPool.length > 0, workers: aiPool.length, wantWorkers: aiPoolWant(G.turn), aiMode: currentAIMode(), error: aiWorkerError, loaded: aiEngineLoaded(), workerUrl: aiPool[0] ? aiPool[0].url : AI_WORKER_URL, inlineEngine: !!aiEngineSourceText() }),
  setAIMode: (m) => { const r = setAIMode(m); syncSettings(); save(); return r; },
  setSeatAIMode: (p, m) => { const r = setSeatAIMode(p, m); syncSettings(); save(); return r; },
  setAIBudgetMs: (ms) => { aiTestBudgetMs = ms == null ? null : Math.max(1, ms | 0); return aiBudgetMs(G.turn); },
  exportRecord: () => (typeof exportCurrentRecord === 'function' ? exportCurrentRecord() : null),
  exportRecordText: () => (typeof exportCurrentRecord === 'function' && gameFeatures ? gameFeatures.toText(exportCurrentRecord()) : ''),
  importJSON: (text) => (typeof importBoardOrKifuJSON === 'function' ? importBoardOrKifuJSON(text) : null),
  autoPassEnabled: () => (typeof autoPass === 'function' && autoPass() ? autoPass().enabledSeats() : []),
  toggleAutoPass: (p) => { if (typeof autoPass === 'function' && autoPass()) { autoPass().toggle(p); renderAutoPassControls(); return autoPass().enabledSeats(); } return []; },
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

// ===== エージェント向けAPI =====
// AIエージェントが画像認識やマウス操作をせず、関数呼び出しだけで対局するための入口。
// 既存の __hexagoDebug に加えて、着手・合法手・待機・設定変更・リプレイ等を公開する。
// 仕様は help() が JSON で返し、dev/agent-spec.js がそこから
// agent.json / agent.html / llms.txt を生成する(単一の真実)。
(function () {
  const D = window.__hexagoDebug;
  if (!D) return;

  // AIの手番が終わるのを待つための監視
  function isBusy() { return typeof aiBusy !== 'undefined' ? !!aiBusy : false; }
  function aiSeatTurn() {
    try { return typeof aiSeatOf === 'function' && G && aiSeatOf(G.turn); } catch (e) { return false; }
  }

  const Agent = {
    // --- 状態 ---
    state: () => D.state(),
    legalMoves: () => {
      const out = [];
      for (let i = 0; i < G.board.length; i++) {
        if (G.board[i]) continue;
        const r = sim(G.board, i, G.turn);
        if (!r) continue;
        out.push({ point: i, captures: (r.cap || []).length });
      }
      return out;
    },
    // --- 着手 ---
    move: (point) => {
      if (!Number.isInteger(point) || point < 0 || point >= G.board.length) return false;
      const ok = play(point);
      if (ok) after();
      return ok;
    },
    pass: () => { D.pass(); return true; },
    resign: () => {
      if (!G || G.over) return false;
      resign(); after();
      return true;
    },
    // --- 待機 ---
    // AIの思考が終わるまで待ち、そのあとの状態を返す。
    // AIの手番でなければ即座に返る。タイムアウトで reject する。
    awaitAI: (timeoutMs) => {
      const limit = Number.isFinite(timeoutMs) ? Math.max(100, timeoutMs) : 30000;
      return new Promise((resolve, reject) => {
        const started = Date.now();
        const tick = () => {
          if (!isBusy()) { resolve(D.state()); return; }
          if (Date.now() - started > limit) {
            reject(new Error('awaitAI: timeout after ' + limit + 'ms'));
            return;
          }
          setTimeout(tick, 25);
        };
        // まだ思考が始まっていない場合(AI手番なら開始を待つ)を考慮し、少しだけ猶予を見る
        setTimeout(tick, isBusy() ? 0 : 30);
      });
    },
    // --- 設定 ---
    setBoardSize: (n) => {
      if (![9, 13, 19, 25].includes(Number(n))) return false;
      pendingSize = Number(n);
      if (!G.over && G.phase !== 'setup') { return true; } // 対局中は次局から(即時リセットしない)
      return reset();
    },
    setPlayerCount: (n) => {
      const v = Number(n);
      if (!Number.isInteger(v) || v < 2 || v > 6) return false;
      playerCount = v;
      for (let p = 1; p <= 6; p++) if (!seats[p]) seats[p] = 'human';
      if (typeof syncSettings === 'function') syncSettings();
      save();
      return true;
    },
    setSeats: (arr) => {
      if (!Array.isArray(arr)) return false;
      for (let p = 1; p <= (G.playerCount || playerCount); p++) {
        const want = arr[p - 1] === 'ai' || arr[p - 1] === true;
        if (typeof setSeatMode === 'function') setSeatMode(p, want ? 'ai' : 'human', true);
      }
      if (typeof syncSettings === 'function') syncSettings();
      updateUI(); save();
      return true;
    },
    setTheme: (id) => {
      const th = THEMES[id];
      if (!th) return false;
      applyTheme(th); if (typeof updateUI === 'function') updateUI(); save();
      return true;
    },
    setSound: (on) => {
      if (typeof snd === 'undefined') return false;
      snd.on = !!on;
      if (typeof syncSettings === 'function') syncSettings();
      save();
      return true;
    },
    // 新しい対局を開始する(設定変更を確定させたいときに使う)
    newGame: () => { return reset(); },
    // --- AI ---
    think: (budgetMs) => D.think(budgetMs),
    // --- 共有 ---
    shareUrl: () => (window.HexagoReplayUI && window.HexagoReplayUI.shareUrl ? window.HexagoReplayUI.shareUrl() : ''),
    // --- 棋譜 ---
    exportRecord: () => D.exportRecord(),
    importRecord: (json) => D.importJSON(typeof json === 'string' ? json : JSON.stringify(json)),
    // --- リプレイ ---
    replay: {
      open: () => { if (window.HexagoReplayUI) window.HexagoReplayUI.open(); return !!(window.HexagoReplayView && window.HexagoReplayView.active()); },
      seek: (n) => {
        const el = document.getElementById('replaySlider');
        if (!el) return false;
        el.value = String(n);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      },
      close: () => { if (window.HexagoReplayUI) window.HexagoReplayUI.close(); return true; },
      resume: () => {
        const btn = document.getElementById('replayResume');
        if (!btn) return false;
        btn.click();
        return true;
      },
      info: () => {
        if (!window.HexagoReplayView || !window.HexagoReplayView.active()) return null;
        const pos = window.HexagoReplayView.position();
        const el = document.getElementById('replaySlider');
        return { ply: pos ? pos.ply : 0, last: el ? Number(el.max) : 0, turn: pos ? pos.turn : null };
      }
    }
  };

  // 仕様(単一の真実)。dev/agent-spec.js はこれを読み取って各種ファイルを生成する。
  Agent.help = () => ({
    name: 'HEXAGO',
    description: '六角形の盤で打つ囲碁風ゲーム。このページの window.__hexagoAgent から全操作を関数呼び出しで行えます。スクリーンショットやマウス操作は不要です。',
    usage: [
      '1手の流れ: state() → legalMoves() → move(point) → awaitAI()',
      'AIの手番でなければ awaitAI() は即座に返ります',
      '設定は setBoardSize / setPlayerCount で変更し、newGame() で新しい対局として確定します'
    ],
    apis: [
      { name: 'state', args: [], returns: 'object', desc: '盤面(board)、手番(turn)、人数(playerCount)、盤サイズ(size)、終局(over)、席の人間/AI(seats)、AI思考中(aiBusy) を返す' },
      { name: 'legalMoves', args: [], returns: 'array', desc: '置ける交点の一覧 [{point, captures}]。captures はその手で取れる石の数' },
      { name: 'move', args: ['point:number'], returns: 'boolean', desc: '交点番号を指定して石を置く。置けたら true' },
      { name: 'pass', args: [], returns: 'boolean', desc: 'パスする' },
      { name: 'resign', args: [], returns: 'boolean', desc: '投了する' },
      { name: 'awaitAI', args: ['timeoutMs?:number'], returns: 'Promise<object>', desc: 'AIの思考が終わるまで待ち、そのあとの state() を返す。既定30秒でタイムアウト' },
      { name: 'setBoardSize', args: ['n:9|13|19|25'], returns: 'boolean', desc: '盤サイズを指定する(次局から反映)' },
      { name: 'setPlayerCount', args: ['n:2-6'], returns: 'boolean', desc: '人数を指定する' },
      { name: 'setSeats', args: ['arr:Array'], returns: 'boolean', desc: '各席を人間("human")かAI("ai")にする。例: ["human","ai","ai"]' },
      { name: 'newGame', args: [], returns: 'boolean', desc: '設定を確定して新しい対局を開始する' },
      { name: 'setTheme', args: ['id:string'], returns: 'boolean', desc: 'テーマを変更する(default / dark / go / cyber / fancy)' },
      { name: 'setSound', args: ['on:boolean'], returns: 'boolean', desc: '効果音のオン・オフ' },
      { name: 'think', args: ['budgetMs?:number'], returns: 'object', desc: 'AIに思考させて評価結果を得る(盤面は変えない)' },
      { name: 'shareUrl', args: [], returns: 'string', desc: 'この対局の共有URLを返す' },
      { name: 'exportRecord', args: [], returns: 'object', desc: '現在の対局の棋譜(JSON)を返す' },
      { name: 'importRecord', args: ['json:object|string'], returns: 'object', desc: '棋譜を読み込む' },
      { name: 'replay.open', args: [], returns: 'boolean', desc: 'リプレイ画面を開く' },
      { name: 'replay.seek', args: ['n:number'], returns: 'boolean', desc: 'リプレイを指定の手数へ移動する' },
      { name: 'replay.info', args: [], returns: 'object|null', desc: '現在のリプレイ位置(ply, 総手数, 手番)を返す' },
      { name: 'replay.resume', args: [], returns: 'boolean', desc: '現在位置から対局を再開する' },
      { name: 'replay.close', args: [], returns: 'boolean', desc: 'リプレイ画面を閉じる' }
    ],
    notes: [
      '認証はありません。スコアは自己申告として扱ってください。',
      'ブラウザ上で動作するため、エージェント側にブラウザ自動化(Playwright等)が必要です。',
      '1つのページを同時に複数のエージェントで操作すると状態が干渉します。'
    ]
  });

  window.__hexagoAgent = Agent;
  // 既存フックも同じ入口から使えるようにする(過去のE2E資産との互換)
  for (const k of Object.keys(D)) if (!(k in Agent)) Agent[k] = D[k];
})();
