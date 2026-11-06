// ===== オンライン（PeerJS / WebRTC）：入室後はプール、着席は別操作 =====
const PFX = 'hexago-';
const BLOCKED_NICK_WORDS = ['くそ', 'しね', '死ね', '殺す', 'ばか', 'バカ', 'うんこ', 'ちんこ', 'まんこ', 'fuck', 'shit', 'bitch', 'asshole'];
function validateNickname(raw) {
  const value = String(raw || '').normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (!value) return { ok: false, message: 'ニックネームを入力してください。' };
  if ([...value].length > 5) return { ok: false, message: 'ニックネームは5字以内にしてください。' };
  if (!/^[\p{L}\p{N} _.-]+$/u.test(value)) return { ok: false, message: 'ニックネームには文字・数字・空白・._- だけ使えます。' };
  const normalized = value.toLowerCase().replace(/[\s._-]/g, '');
  if (BLOCKED_NICK_WORDS.some(word => normalized.includes(word.normalize('NFKC').toLowerCase().replace(/[\s._-]/g, ''))))
    return { ok: false, message: 'そのニックネームは使用できません。別の名前を入力してください。' };
  return { ok: true, value };
}
function validateRoomId(raw) {
  const value = String(raw || '').trim();
  if (!value) return { ok: false, message: 'ルームIDを入力してください。' };
  if (value.length > 32 || !/^[A-Za-z0-9_-]+$/.test(value)) return { ok: false, message: 'ルームIDは英数字・ハイフン・アンダースコアの1〜32文字で指定してください。' };
  return { ok: true, value: value.toUpperCase() };
}
function resetRoomData() {
  seatOwners = Array(7).fill(null); seatNicknames = ['', '', '', '', '', '', ''];
  roomPool = Object.create(null); disconnectedNicknames = Object.create(null);
}
function closePeer() {
  stopNetTimers();
  releaseWakeLock();
  clearOnlineSession();
  cancelAI();
  conns.forEach(c => { try { c.close(); } catch (e) { } }); conns = [];
  if (hostConn) { hostConn.__ignoreNet = true; try { hostConn.close(); } catch (e) { } hostConn = null; }
  if (peer) { peer.__ignoreNet = true; try { peer.destroy(); } catch (e) { } peer = null; }
  myRole = null; isHost = false; roomCode = null; myNickname = ''; netStatus = '';
  resetRoomData();
  if ($('roomSt')) $('roomSt').textContent = '';
  if ($('roomPool')) $('roomPool').innerHTML = '';
  if ($('roomSeatBtns')) $('roomSeatBtns').innerHTML = '';
}

// ===== 接続の安定化：自動再接続 / ハートビート / セッション復元 =====
// GitHub Pages（サーバーなし）で動かすため、PeerJS の公開シグナリングサーバーだけを使い、
// 切断時はクライアント側で同じルームIDへ自動再接続する。ホスト端末のスリープ復帰や
// タブのリロードでも、席と対局状態を復元できるようにする。
const ONLINE_SESSION_KEY = 'hexago-online-session-v1';
const NET_PING_MS = 4000;
const NET_TIMEOUT_MS = 15000;
let netStatus = '';
let netRetryTimer = null, netRetryAttempt = 0, netConnecting = false;
let hostPingTimer = null, guestPingTimer = null;
let lastHostMessageAt = 0;
let screenWakeLock = null;

function setNetStatus(msg) { netStatus = msg || ''; renderRoomUI(); }
function netDelay(attempt) { return Math.min(8000, 700 * Math.pow(1.6, Math.min(attempt, 6))) + Math.floor(Math.random() * 400); }
function stopNetTimers() {
  if (netRetryTimer) { clearTimeout(netRetryTimer); netRetryTimer = null; }
  if (hostPingTimer) { clearInterval(hostPingTimer); hostPingTimer = null; }
  if (guestPingTimer) { clearInterval(guestPingTimer); guestPingTimer = null; }
  netConnecting = false;
}
async function requestWakeLock() {
  if (mode !== 'online' || !navigator.wakeLock || screenWakeLock) return;
  try {
    screenWakeLock = await navigator.wakeLock.request('screen');
    screenWakeLock.addEventListener('release', () => { screenWakeLock = null; });
  } catch (e) { screenWakeLock = null; }
}
function releaseWakeLock() {
  if (screenWakeLock) { try { screenWakeLock.release(); } catch (e) { } screenWakeLock = null; }
}
function buildOnlineSession() {
  return {
    roomCode, isHost, myRole: Number.isInteger(myRole) ? myRole : null, myNickname, boardView,
    playerCount: G?.playerCount || playerCount, pendingSize,
    seatNicknames: seatNicknames.slice(0, 7),
    disconnectedNicknames: { ...disconnectedNicknames },
    seats: seats.slice(0, 7),
    when: Date.now(),
  };
}
function saveOnlineSession() {
  try {
    if (mode === 'online' && roomCode) sessionStorage.setItem(ONLINE_SESSION_KEY, JSON.stringify(buildOnlineSession()));
    else sessionStorage.removeItem(ONLINE_SESSION_KEY);
  } catch (e) { }
}
function clearOnlineSession() { try { sessionStorage.removeItem(ONLINE_SESSION_KEY); } catch (e) { } }
function readOnlineSession() {
  try {
    const raw = sessionStorage.getItem(ONLINE_SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || !s.roomCode) return null;
    if (Date.now() - (s.when || 0) > 10 * 60 * 1000) { sessionStorage.removeItem(ONLINE_SESSION_KEY); return null; }
    return s;
  } catch (e) { return null; }
}
function isConnAlive(peerId) { return conns.some(c => c.peer === peerId && c.open); }

// ホスト: 同じルームIDで Peer を作り直す。resume=true のときは部屋データを保持したまま復旧する。
function startHostPeer(code, nickname, opts) {
  opts = opts || {};
  stopNetTimers();
  if (peer) { peer.__ignoreNet = true; try { peer.destroy(); } catch (e) { } peer = null; }
  conns.forEach(c => { c.__ignoreNet = true; try { c.close(); } catch (e) { } });
  conns = []; hostConn = null;
  mode = 'online'; isHost = true; roomCode = String(code || '').toUpperCase(); myNickname = nickname || myNickname || '';
  setNetStatus(opts.resume ? 'ホスト接続を復旧しています…' : '部屋を準備しています…');
  const candidate = new Peer(PFX + roomCode.toLowerCase(), { debug: 0 });
  peer = candidate;
  candidate.on('connection', c => {
    if (peer !== candidate) { try { c.close(); } catch (e) { } return; }
    conns.push(c); c.lastPong = Date.now(); wire(c);
  });
  candidate.on('open', () => {
    if (peer !== candidate) return;
    netRetryAttempt = 0;
    if (!roomPool[LOCAL_HOST_ID]) roomPool[LOCAL_HOST_ID] = { nickname: myNickname, seat: null };
    else roomPool[LOCAL_HOST_ID].nickname = myNickname;
    if (Number.isInteger(myRole) && myRole > 0) {
      roomPool[LOCAL_HOST_ID].seat = myRole;
      seatOwners[myRole] = LOCAL_HOST_ID;
      seats[myRole] = 'human';
    }
    if (G) {
      G.aiSeats = Array.from({ length: (G.playerCount || playerCount) + 1 }, (_, p) => p > 0 && (seats[p] !== 'human' || !seatOwners[p]));
      G.aiSeat = G.aiSeats.findIndex((v, i) => i > 0 && v);
    }
    $('hostNickname').value = $('hostNickname').value || myNickname;
    $('hostRoomId').value = roomCode; $('roomIn').value = roomCode;
    $('btnCreate').disabled = false;
    setNetStatus('');
    syncSettings(); updateUI(); renderRoomUI(); saveOnlineSession(); maybeAI(); sendSnapshot();
    requestWakeLock(); startHostHeartbeat();
  });
  candidate.on('disconnected', () => {
    if (candidate.__ignoreNet || peer !== candidate) return;
    setNetStatus('サーバーと切断。再接続しています…');
    try { candidate.reconnect(); } catch (e) { }
    setTimeout(() => { if (peer === candidate && candidate.disconnected) scheduleHostReconnect(); }, 2500);
  });
  candidate.on('close', () => { if (candidate.__ignoreNet) return; if (peer === candidate) { peer = null; scheduleHostReconnect(); } });
  candidate.on('error', err => {
    if (candidate.__ignoreNet || peer !== candidate) return;
    const type = err && err.type;
    if (type === 'unavailable-id') setNetStatus('ルームIDを再取得しています…');
    else if (type === 'peer-unavailable') return;
    else setNetStatus('通信エラー。復旧しています…');
    try { candidate.destroy(); } catch (e) { }
    if (peer === candidate) peer = null;
    scheduleHostReconnect();
  });
  saveOnlineSession();
}

function scheduleHostReconnect(reason) {
  if (!isHost || !roomCode) return;
  if (reason) setNetStatus(reason);
  if (netRetryTimer) return;
  const delay = netDelay(netRetryAttempt++);
  netRetryTimer = setTimeout(() => {
    netRetryTimer = null;
    if (!isHost || !roomCode) return;
    startHostPeer(roomCode, myNickname, { resume: true });
  }, delay);
}

function startHostHeartbeat() {
  if (hostPingTimer) clearInterval(hostPingTimer);
  hostPingTimer = setInterval(() => {
    if (mode !== 'online' || !isHost) return;
    const now = Date.now();
    conns.slice().forEach(c => {
      if (!c.open) { handleDisconnect(c); return; }
      if (now - (c.lastPong || now) > NET_TIMEOUT_MS) { try { c.close(); } catch (e) { } handleDisconnect(c); return; }
      try { c.send({ t: 'ping', ts: now }); } catch (e) { }
    });
  }, NET_PING_MS);
}

// ゲスト: シグナリング切断時は再接続し、ホスト接続が切れたら同じルームへ自動で入り直す。
function startGuestPeer(code, nickname) {
  stopNetTimers();
  if (hostConn) { hostConn.__ignoreNet = true; try { hostConn.close(); } catch (e) { } }
  if (peer) { peer.__ignoreNet = true; try { peer.destroy(); } catch (e) { } peer = null; }
  hostConn = null;
  mode = 'online'; isHost = false; roomCode = String(code || '').toUpperCase(); myNickname = nickname || myNickname || ''; boardView = 'participant';
  setNetStatus('接続しています…');
  const candidate = new Peer({ debug: 0 });
  peer = candidate;
  candidate.on('open', () => {
    if (peer !== candidate) return;
    netRetryAttempt = 0;
    setNetStatus('ホストに接続しています…');
    connectToHost();
    startGuestHeartbeat();
    requestWakeLock();
    syncSettings(); updateUI();
  });
  candidate.on('disconnected', () => {
    if (candidate.__ignoreNet || peer !== candidate) return;
    setNetStatus('サーバーと切断。再接続しています…');
    try { candidate.reconnect(); } catch (e) { }
    setTimeout(() => { if (peer === candidate && candidate.disconnected) { try { candidate.destroy(); } catch (e) { } if (peer === candidate) peer = null; scheduleGuestReconnect(); } }, 2500);
  });
  candidate.on('close', () => { if (peer === candidate) { peer = null; scheduleGuestReconnect(); } });
  candidate.on('error', err => {
    if (candidate.__ignoreNet || peer !== candidate) return;
    const type = err && err.type;
    if (type === 'peer-unavailable') { setNetStatus('ホストの復帰を待っています…'); scheduleGuestReconnect(); return; }
    try { candidate.destroy(); } catch (e) { }
    if (peer === candidate) peer = null;
    setNetStatus('通信エラー。再接続しています…');
    scheduleGuestReconnect();
  });
  saveOnlineSession();
}

function connectToHost() {
  if (mode !== 'online' || isHost || !roomCode) return;
  if (!peer || peer.destroyed) { startGuestPeer(roomCode, myNickname); return; }
  if (!peer.open) return;
  if (hostConn && hostConn.open) return;
  if (netConnecting) return;
  netConnecting = true;
  const c = peer.connect(PFX + roomCode.toLowerCase(), { reliable: true });
  hostConn = c;
  lastHostMessageAt = Date.now();
  const openTimer = setTimeout(() => {
    if (hostConn === c && !c.open) { try { c.close(); } catch (e) { } hostConn = null; netConnecting = false; scheduleGuestReconnect('ホストの応答がありません'); }
  }, 7000);
  c.on('open', () => {
    clearTimeout(openTimer);
    if (hostConn !== c) return;
    netConnecting = false; netRetryAttempt = 0; lastHostMessageAt = Date.now();
    setNetStatus('入室しています…');
    try { c.send({ t: 'hello', nickname: myNickname }); } catch (e) { }
    renderRoomUI();
  });
  c.on('data', d => onConnData(c, d));
  c.on('close', () => {
    clearTimeout(openTimer);
    if (hostConn === c) hostConn = null;
    netConnecting = false;
    if (c.__ignoreNet) return;
    if (mode === 'online' && !isHost) scheduleGuestReconnect('接続が切れました');
  });
  c.on('error', () => {
    clearTimeout(openTimer);
    if (hostConn === c) hostConn = null;
    netConnecting = false;
    if (c.__ignoreNet) return;
    if (mode === 'online' && !isHost) scheduleGuestReconnect('接続エラー');
  });
}

function scheduleGuestReconnect(reason) {
  if (mode !== 'online' || isHost) return;
  if (reason) setNetStatus(reason + '。再接続しています…');
  if (netRetryTimer) return;
  const delay = netDelay(netRetryAttempt++);
  netRetryTimer = setTimeout(() => {
    netRetryTimer = null;
    if (mode !== 'online' || isHost) return;
    if (!peer || peer.destroyed) startGuestPeer(roomCode, myNickname);
    else if (peer.disconnected) { try { peer.reconnect(); } catch (e) { } connectToHost(); }
    else connectToHost();
  }, delay);
}

function startGuestHeartbeat() {
  if (guestPingTimer) clearInterval(guestPingTimer);
  guestPingTimer = setInterval(() => {
    if (mode !== 'online' || isHost) return;
    const now = Date.now();
    if (hostConn && hostConn.open) {
      if (now - lastHostMessageAt > NET_TIMEOUT_MS) {
        setNetStatus('ホストの応答がありません。再接続しています…');
        try { hostConn.close(); } catch (e) { }
        hostConn = null;
        scheduleGuestReconnect();
        return;
      }
      try { hostConn.send({ t: 'ping', ts: now }); } catch (e) { }
    } else if (!netConnecting) {
      scheduleGuestReconnect('ホストと切断されました');
    }
  }, NET_PING_MS);
}

// ホスト/ゲスト共通: 受信データの振り分け（ping/pong は接続監視用）
function onConnData(c, d) {
  if (!d) return;
  if (d.t === 'ping') {
    try { c.send({ t: 'pong', ts: d.ts }); } catch (e) { }
    if (!isHost) lastHostMessageAt = Date.now();
    return;
  }
  if (d.t === 'pong') {
    c.lastPong = Date.now();
    if (!isHost) lastHostMessageAt = Date.now();
    return;
  }
  if (isHost) handleHostMessage(d, c);
  else if (d.t === 'snapshot') applySnapshot(d);
  else if (d.t === 'notice') $('roomSt').textContent = d.message || '部屋からの通知があります。';
}

function hostHealthCheck() {
  if (mode !== 'online' || !isHost) return;
  if (!peer || peer.destroyed) { scheduleHostReconnect('接続を復旧しています…'); return; }
  if (peer.disconnected) { try { peer.reconnect(); } catch (e) { } setNetStatus('サーバーへ再接続しています…'); return; }
  if (!peer.open) { scheduleHostReconnect('接続を復旧しています…'); return; }
  const now = Date.now();
  conns.slice().forEach(c => {
    if (!c.open || now - (c.lastPong || now) > NET_TIMEOUT_MS) { try { c.close(); } catch (e) { } handleDisconnect(c); }
  });
  const msg = roomSnapshot();
  conns.forEach(c => { if (c.open) { try { c.send(msg); } catch (e) { } } });
  saveOnlineSession();
}

function guestHealthCheck() {
  if (mode !== 'online' || isHost || !roomCode) return;
  if (!peer || peer.destroyed) { scheduleGuestReconnect('接続を復旧しています…'); return; }
  if (!peer.open) { if (peer.disconnected) { try { peer.reconnect(); } catch (e) { } } scheduleGuestReconnect('接続を復旧しています…'); return; }
  if (!hostConn || !hostConn.open) { connectToHost(); return; }
  if (Date.now() - lastHostMessageAt > NET_TIMEOUT_MS) {
    try { hostConn.close(); } catch (e) { }
    hostConn = null;
    scheduleGuestReconnect('ホストの応答がありません');
  }
}

function networkWake() {
  if (mode !== 'online' || !roomCode) return;
  netRetryAttempt = 0;
  clearTimeout(netRetryTimer); netRetryTimer = null;
  requestWakeLock();
  if (isHost) hostHealthCheck(); else guestHealthCheck();
}

// 保存済みのオンラインセッションから復帰（リロード / スリープ復帰後の再読込）
function resumeOnlineSession(sessionOverride) {
  const s = sessionOverride || readOnlineSession();
  if (!s || !s.roomCode || !G) return false;
  mode = 'online'; isHost = !!s.isHost; roomCode = String(s.roomCode).toUpperCase();
  myNickname = s.myNickname || ''; boardView = s.boardView || (isHost ? 'host' : 'participant');
  playerCount = Math.max(2, Math.min(6, s.playerCount || G.playerCount || 3));
  G.playerCount = playerCount;
  seats = Array.from({ length: 7 }, (_, i) => i === 0 ? 0 : (s.seats && s.seats[i] === 'ai' ? 'ai' : 'human'));
  seatNicknames = Array.isArray(s.seatNicknames) ? s.seatNicknames.slice(0, 7) : ['', '', '', '', '', '', ''];
  while (seatNicknames.length < 7) seatNicknames.push('');
  disconnectedNicknames = Object.assign(Object.create(null), s.disconnectedNicknames || {});
  seatOwners = Array(7).fill(null); roomPool = Object.create(null);
  myRole = Number.isInteger(s.myRole) && s.myRole > 0 ? s.myRole : null;
  if (isHost) {
    roomPool[LOCAL_HOST_ID] = { nickname: myNickname, seat: null };
    if (myRole) { seatOwners[myRole] = LOCAL_HOST_ID; seats[myRole] = 'human'; roomPool[LOCAL_HOST_ID].seat = myRole; }
    for (let p = 1; p <= playerCount; p++) {
      if (p === myRole) continue;
      if (seatNicknames[p]) { seats[p] = 'ai'; disconnectedNicknames[p] = seatNicknames[p]; }
    }
  } else { myRole = null; }
  G.aiSeats = Array.from({ length: playerCount + 1 }, (_, p) => p > 0 && (seats[p] !== 'human' || (isHost && !seatOwners[p])));
  G.aiSeat = G.aiSeats.findIndex((v, i) => i > 0 && v);
  setSeen(); syncSettings(); updateUI();
  setNetStatus('前回のルームに再接続しています…');
  if (isHost) startHostPeer(roomCode, myNickname, { resume: true });
  else startGuestPeer(roomCode, myNickname);
  return true;
}

function roomSnapshot() {
  return { t: 'snapshot', G, pendingSize, playerCount, seats: seats.slice(), seatOwners: seatOwners.slice(), seatNicknames: seatNicknames.slice(), roomPool: JSON.parse(JSON.stringify(roomPool)), disconnectedNicknames: { ...disconnectedNicknames }, roomCode };
}
function sendSnapshot(to=null) {
  if (!isHost) return;
  const msg = roomSnapshot();
  if (to && to.open) to.send(msg);
  else conns.forEach(c => { if (c.open) c.send(msg); });
  renderRoomUI();
}
function sync(except) {
  if (mode !== 'online') return;
  if (isHost) {
    const msg = roomSnapshot();
    conns.forEach(c => { if (c !== except && c.open) c.send(msg); });
    renderRoomUI();
  } else if (hostConn && hostConn.open) hostConn.send({ t: 'state', G });
}
function setRemoteRoleFromSnapshot() {
  if (!peer || isHost) return;
  myRole = null;
  for (let p = 1; p <= Math.min(6, G?.playerCount || playerCount); p++) if (seatOwners[p] === peer.id) { myRole = p; break; }
}
function applySnapshot(data) {
  const wasOver = !!G?.over;
  if (data.G) G = data.G;
  if (data.playerCount) playerCount = Math.max(2, Math.min(6, data.playerCount));
  if (data.pendingSize) pendingSize = data.pendingSize;
  if (Array.isArray(data.seats)) seats = data.seats.slice(0, 7);
  while (seats.length < 7) seats.push('human');
  seats = Array.from({length:7}, (_, i) => i === 0 ? 0 : (seats[i] === 'ai' ? 'ai' : 'human'));
  if (Array.isArray(data.seatOwners)) seatOwners = data.seatOwners.slice(0, 7);
  if (Array.isArray(data.seatNicknames)) seatNicknames = data.seatNicknames.slice(0, 7);
  roomPool = Object.assign(Object.create(null), data.roomPool || {});
  disconnectedNicknames = Object.assign(Object.create(null), data.disconnectedNicknames || {});
  roomCode = data.roomCode || roomCode;
  if (G && G.size !== SIDE * 2 - 1) { build(G.size); resizeCanvas(); }
  if (G && !G.aiSeats) G.aiSeats = Array.from({length: (G.playerCount || 3) + 1}, (_, p) => p > 0 && seats[p] !== 'human');
  if (G) G.aiSeat = G.aiSeats.findIndex((v, i) => i > 0 && v);
  setRemoteRoleFromSnapshot(); setSeen(); prev = -1;
  if (G?.over && !wasOver && G.result) showResult();
  if (!G?.over) $('resModal').classList.add('hidden');
  if (!isHost) setNetStatus('');
  syncSettings(); updateUI(); save();
}
function assignSeat(ownerId, p, nickname) {
  if (!roomPool[ownerId] || p < 1 || p > playerCount || seatOwners[p]) return false;
  if (roomPool[ownerId].seat && roomPool[ownerId].seat !== p) return false;
  if (seats[p] === 'ai' && (disconnectedNicknames[p] || '').toLowerCase() !== String(nickname || '').toLowerCase()) return false;
  seatOwners[p] = ownerId; seatNicknames[p] = nickname; seats[p] = 'human';
  roomPool[ownerId].seat = p; delete disconnectedNicknames[p];
  if (G && p <= G.playerCount && G.aiSeats) { G.aiSeats[p] = false; G.aiSeat = G.aiSeats.findIndex((v, i) => i > 0 && v); }
  return true;
}
function handleHostMessage(data, c) {
  if (!isHost || !data || !c) return;
  if (data.t === 'hello') {
    const rawName = String(data.nickname || '').trim();
    const checked = rawName ? validateNickname(rawName) : { ok: true, value: '__AUTO_NICK__' };
    if (!checked.ok) { c.send({ t: 'notice', message: checked.message }); c.close(); return; }
    const nickname = checked.value === '__AUTO_NICK__' ? `${Object.keys(roomPool).length + 1}p` : checked.value;
    // 同じニックネームの古い接続・プール項目を掃除する（リロード/スリープ復帰の重複対策）
    Object.keys(roomPool).forEach(id => {
      if (id === LOCAL_HOST_ID || id === c.peer) return;
      if (String(roomPool[id]?.nickname || '').toLowerCase() !== nickname.toLowerCase()) return;
      const oldSeat = seatOwners.indexOf(id);
      if (oldSeat > 0) {
        seatOwners[oldSeat] = null;
        disconnectedNicknames[oldSeat] = nickname;
        seatNicknames[oldSeat] = nickname;
        seats[oldSeat] = 'ai';
      }
      const oldConn = conns.find(x => x.peer === id);
      if (oldConn) { conns = conns.filter(x => x !== oldConn); try { oldConn.close(); } catch (e) { } }
      delete roomPool[id];
    });
    roomPool[c.peer] = { nickname, seat: null };
    // 1) 切断時に予約された席  2) 名前が一致し、所有者の接続が死んでいる席（取り残し対策）
    let reconnectSeat = Array.from({ length: Math.min(6, playerCount) }, (_, i) => i + 1)
      .find(p => !seatOwners[p] && disconnectedNicknames[p] && disconnectedNicknames[p].toLowerCase() === nickname.toLowerCase());
    if (!reconnectSeat) {
      reconnectSeat = Array.from({ length: Math.min(6, playerCount) }, (_, i) => i + 1)
        .find(p => seatOwners[p] && seatOwners[p] !== c.peer && seatNicknames[p] && seatNicknames[p].toLowerCase() === nickname.toLowerCase() && !isConnAlive(seatOwners[p]));
      if (reconnectSeat) {
        const oldOwner = seatOwners[reconnectSeat];
        seatOwners[reconnectSeat] = null;
        if (roomPool[oldOwner]) delete roomPool[oldOwner];
      }
    }
    if (reconnectSeat) {
      const hadSeatOwner = !!seatOwners[reconnectSeat];
      assignSeat(c.peer, reconnectSeat, nickname);
      if (!hadSeatOwner) delete disconnectedNicknames[reconnectSeat];
    }
    setNetStatus('');
    if (G) {
      G.aiSeats = Array.from({ length: (G.playerCount || playerCount) + 1 }, (_, p) => p > 0 && (seats[p] !== 'human' || !seatOwners[p]));
      G.aiSeat = G.aiSeats.findIndex((v, i) => i > 0 && v);
    }
    sendSnapshot();
    if (G && G.phase === 'playing' && aiSeatOf(G.turn) === false) { syncSettings(); updateUI(); after(); }
    else { syncSettings(); updateUI(); }
    return;
  }
  if (data.t === 'claim') {
    const p = Number(data.seat), item = roomPool[c.peer];
    if (!item || item.seat || seatOwners.indexOf(c.peer) > 0 || !Number.isInteger(p) || p < 1 || p > playerCount || seatOwners[p]) return;
    if (seats[p] === 'ai' && (disconnectedNicknames[p] || '').toLowerCase() !== item.nickname.toLowerCase()) return;
    if (assignSeat(c.peer, p, item.nickname)) { sendSnapshot(); after(); }
    return;
  }
  if (data.t === 'release') {
    const p = Number(data.seat), item = roomPool[c.peer];
    if (!item || !Number.isInteger(p) || p < 1 || p > playerCount || seatOwners[p] !== c.peer || item.seat !== p) return;
    vacateSeat(p, c.peer, true);
    sendSnapshot(); after();
    return;
  }
  if (data.t === 'state' && data.G && Number.isInteger(seatOwners.indexOf(c.peer))) {
    const role = seatOwners.indexOf(c.peer);
    if (role < 1 || role > (G.playerCount || 0)) return;
    const candidate = data.G;
    const last = candidate.hist && candidate.hist[candidate.hist.length - 1];
    const deadReview = G.phase === 'dead' && ['dead', 'playing', 'ended'].includes(candidate.phase) && candidate.size === G.size && candidate.playerCount === G.playerCount;
    if (G.turn !== role && !deadReview) return;
    const validMove = G.turn === role && !!last && last.by === role && candidate.playerCount === G.playerCount && candidate.size === G.size;
    const validResign = G.turn === role && !!candidate.out?.[role] && !G.out?.[role];
    if (!validMove && !validResign && !deadReview) return;
    G = candidate; setSeen(); prev = -1;
    if (G.size !== SIDE * 2 - 1) { build(G.size); resizeCanvas(); }
    if (G.over && G.result) showResult();
    updateUI(); save(); sendSnapshot(); maybeAI();
  }
}
function handleDisconnect(c) {
  conns = conns.filter(x => x !== c);
  if (!isHost || !c?.peer) return;
  const nickname = roomPool[c.peer]?.nickname || '';
  const role = seatOwners.indexOf(c.peer);
  if (role > 0) {
    seatOwners[role] = null;
    disconnectedNicknames[role] = nickname;
    seatNicknames[role] = nickname;
    seats[role] = 'ai';
    if (G && role <= G.playerCount && G.aiSeats) { G.aiSeats[role] = true; G.aiSeat = G.aiSeats.findIndex((v, i) => i > 0 && v); }
  }
  delete roomPool[c.peer];
  // すでに再接続してプールで待っている同一ニックネームがいれば、その場で席を戻す
  if (role > 0 && nickname) {
    const waitingId = Object.keys(roomPool).find(id => roomPool[id] && !roomPool[id].seat &&
      String(roomPool[id].nickname || '').toLowerCase() === nickname.toLowerCase());
    if (waitingId) {
      const oldOwner = seatOwners[role];
      seatOwners[role] = null;
      if (assignSeat(waitingId, role, nickname)) { setNetStatus(''); sendSnapshot(); }
      else if (oldOwner) { seatOwners[role] = null; }
    }
  }
  if (nickname) setNetStatus(role > 0 ? `${nickname} が切断されました。再接続を待っています（AIが代行）` : '参加者が切断されました');
  if (G && G.phase === 'playing' && G.aiSeats?.[G.turn]) { after(); }
  else { syncSettings(); updateUI(); sync(); }
}
function wire(c) {
  c.on('data', d => onConnData(c, d));
  c.on('close', () => { if (isHost) handleDisconnect(c); });
  c.on('error', () => { if (isHost) handleDisconnect(c); });
}
function claimLocalHostSeat(p) {
  const item = roomPool[LOCAL_HOST_ID];
  if (!isHost || !item || myRole || seatOwners[p]) return;
  if (seats[p] === 'ai' && (disconnectedNicknames[p] || '').toLowerCase() !== item.nickname.toLowerCase()) return;
  if (assignSeat(LOCAL_HOST_ID, p, item.nickname)) { myRole = p; syncSettings(); updateUI(); sync(); }
}
function vacateSeat(p, ownerId, voluntary=true) {
  const item = roomPool[ownerId];
  const nickname = seatNicknames[p] || item?.nickname || disconnectedNicknames[p] || '';
  if (item) item.seat = null;
  seatOwners[p] = null;
  if (ownerId === LOCAL_HOST_ID) myRole = null;
  // 自発的な退席では席を再募集し、切断時はAI席として保護する。
  seats[p] = voluntary ? 'human' : 'ai';
  if (voluntary) { delete disconnectedNicknames[p]; seatNicknames[p] = ''; }
  else { if (nickname) disconnectedNicknames[p] = nickname; seatNicknames[p] = nickname; }
  if (G && p <= G.playerCount && G.aiSeats) {
    G.aiSeats[p] = true;
    G.aiSeat = G.aiSeats.findIndex((v, i) => i > 0 && v);
  }
}
function leaveMySeat(p) {
  if (!myRole || myRole !== p) return;
  snd.click();
  if (isHost) {
    if (seatOwners[p] !== LOCAL_HOST_ID) return;
    vacateSeat(p, LOCAL_HOST_ID, true);
    syncSettings(); updateUI(); after();
  } else if (hostConn && hostConn.open) {
    hostConn.send({ t: 'release', seat: p });
    $('roomSt').textContent = '退席しています…';
  }
}
function renderRoomUI() {
  const poolEl = $('roomPool'), seatEl = $('roomSeatBtns'), statusEl = $('roomSt');
  if (!poolEl || !seatEl || !statusEl) return;
  poolEl.innerHTML = ''; seatEl.innerHTML = '';
  const hostMember = roomPool[LOCAL_HOST_ID];
  if (roomCode) statusEl.textContent = `ルームID：${roomCode}｜ホスト：${hostMember?.nickname || (isHost ? myNickname : '接続中')}` + (netStatus ? `｜${netStatus}` : '');
  else if (mode === 'online' && netStatus) statusEl.textContent = netStatus;
  else if (mode === 'online' && (hostConn || peer)) statusEl.textContent = '接続中…';
  else if (mode === 'online' && !peer) statusEl.textContent = 'ホストボードで部屋を作成するか、参加者ボードでIDを入力してください。';
  const entries = Object.entries(roomPool);
  if (!entries.length) {
    const empty = document.createElement('div'); empty.className = 'text-neutral-500'; empty.textContent = 'まだ参加者はいません。'; poolEl.appendChild(empty);
  }
  for (const [id, member] of entries) {
    const row = document.createElement('div'); row.className = 'flex items-center justify-between gap-2 rounded-lg bg-white border border-neutral-200 px-2.5 py-2';
    const name = document.createElement('span'); name.className = 'font-semibold break-words';
    name.textContent = `${member.nickname || '参加者'}${id === LOCAL_HOST_ID ? '（ホスト）' : ''}`;
    const state = document.createElement('span'); state.className = 'text-neutral-500 shrink-0'; state.textContent = member.seat ? `${member.seat}Pとして参加中` : 'プール';
    row.append(name, state); poolEl.appendChild(row);
  }
  const activeCount = isMatchRunning() ? Math.min(playerCount, G.playerCount || playerCount) : playerCount;
  const ownId = isHost ? LOCAL_HOST_ID : peer?.id;
  for (let p = 1; p <= activeCount; p++) {
    const row = document.createElement('div'); row.className = 'flex items-center justify-between gap-2 rounded-lg bg-white border border-neutral-200 px-2.5 py-2';
    const label = document.createElement('span'); label.className = 'font-semibold min-w-0';
    const ownerId = seatOwners[p];
    const seatName = seatNicknames[p] ? `${playerName(p)}・${seatNicknames[p]}` : playerName(p);
    label.textContent = `${p}P ${seatName}：${ownerId ? '参加中' : (disconnectedNicknames[p] ? '切断・AI代行中' : SEAT_LABELS[seats[p]] || '人間')}`;
    row.appendChild(label);
    if (ownerId === ownId && myRole === p) {
      const leave = document.createElement('button'); leave.type = 'button'; leave.className = 'opt shrink-0'; leave.textContent = '退席する';
      leave.onclick = () => leaveMySeat(p); row.appendChild(leave);
    } else if (!ownerId && (seats[p] !== 'ai' || disconnectedNicknames[p]) && (mode !== 'online' || !!peer || !!hostConn)) {
      const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'opt shrink-0'; btn.textContent = 'この席で参加';
      const alreadySeated = Number.isInteger(myRole) && myRole > 0;
      btn.disabled = alreadySeated;
      if (alreadySeated) btn.title = 'すでに席に参加しています。先に退席してください。';
      else if (isHost) btn.onclick = () => claimLocalHostSeat(p);
      else if (hostConn && hostConn.open) btn.onclick = () => hostConn.send({ t: 'claim', seat: p });
      else btn.disabled = true;
      row.appendChild(btn);
    }
    seatEl.appendChild(row);
  }
}
$('btnCreate').onclick = () => {
  snd.click();
  const rawHostName = $('hostNickname').value.trim();
  const checkedName = rawHostName ? validateNickname(rawHostName) : { ok: true, value: 'host' };
  if (!checkedName.ok) { $('roomSt').textContent = checkedName.message; return; }
  const checkedId = validateRoomId($('hostRoomId').value);
  if (!checkedId.ok) { $('roomSt').textContent = checkedId.message; return; }
  const code = checkedId.value;
  if (isHost && roomCode && roomCode.toUpperCase() === code) {
    $('roomSt').textContent = 'このIDは現在の部屋で使用中です。別のIDを指定してください。'; return;
  }
  closePeer();
  mode = 'online'; boardView = 'host'; isHost = true; roomCode = code; myNickname = checkedName.value;
  if (!G) { build(pendingSize); G = newG(pendingSize); G.phase = 'setup'; setSeen(); }
  if (G.phase !== 'setup') { playerCount = G.playerCount; pendingSize = G.size; }
  roomPool[LOCAL_HOST_ID] = { nickname: myNickname, seat: null };
  $('hostNickname').value = myNickname; $('hostRoomId').value = code; $('roomIn').value = code;
  $('btnCreate').disabled = true;
  syncSettings(); updateUI();
  startHostPeer(code, myNickname, { resume: false });
};
$('btnJoin').onclick = () => {
  snd.click();
  const checkedId = validateRoomId($('roomIn').value);
  const rawNick = $('nickIn').value.trim();
  const checked = rawNick ? validateNickname(rawNick) : { ok: true, value: '' };
  if (!checkedId.ok) { $('roomSt').textContent = checkedId.message; return; }
  if (!checked.ok) { $('roomSt').textContent = checked.message; return; }
  const code = checkedId.value;
  closePeer();
  mode = 'online'; boardView = 'participant'; myNickname = checked.value; roomCode = code;
  $('roomSt').textContent = '接続中…';
  syncSettings(); updateUI();
  startGuestPeer(code, myNickname);
};
// スリープ / タブ移動では Peer を破棄しない（復帰時にそのまま再接続できる）。
// 明示的にモードを変えたときは closePeer() が後始末する。
window.addEventListener('pagehide', () => {
  save();
  saveOnlineSession();
  aiPool.forEach(slot => { try { slot.worker.terminate(); } catch (e) { } });
  aiPool = [];
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { saveOnlineSession(); return; }
  if (mode === 'online') networkWake();
});
window.addEventListener('pageshow', () => { if (mode === 'online') networkWake(); });
window.addEventListener('online', () => {
  if (mode === 'online') { setNetStatus('ネットワーク復帰。再接続しています…'); networkWake(); }
});
window.addEventListener('offline', () => {
  if (mode === 'online') setNetStatus('オフラインです。ネットワーク復帰を待っています…');
});
