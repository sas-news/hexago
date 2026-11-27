// ===== 状態 =====
const gameFeatures = (typeof window !== 'undefined' && window.HexagoGameFeatures) || null;
let autoPassController = null, autoPassOfferSeat = 0;
let G, seenSet = new Set();
let onlineAI = false, pendingSize = 9, mode = 'local', playerCount = 3, seats = [0, 'human', 'human', 'human', 'human', 'human', 'human'];
// 設定画面で「選択中」のモード。モードボタンを押しただけでは mode を変えず、
// 新規対局を始めるときに確定する(選んだだけで盤面が消えないように)。
let selectedMode = 'local';
let aiMode = 'fast'; // 'fast'(高速・盤サイズ別自動最適) / 'deep'(長考・盤サイズ別自動最適)
try {
  const savedMode = localStorage.getItem('hexago-ai-mode');
  if (savedMode === 'deep' || savedMode === 'fast') aiMode = savedMode;
} catch (e) { }
let seatAIModes = [0, null, null, null, null, null, null]; // null = 一括設定に従う, 'fast' | 'deep' = 席ごとの個別テンポ
let boardView = 'host';
let prev = -1, ptype = 'mouse', aiBusy = false;
let peer = null, conns = [], hostConn = null, myRole = null, isHost = false, roomCode = null;
let seatOwners = Array(7).fill(null), seatNicknames = ['', '', '', '', '', '', ''];
let roomPool = Object.create(null), disconnectedNicknames = Object.create(null), myNickname = '';
const LOCAL_HOST_ID = '__local_host__';

function newG(n) {
  const count = playerCount, aiSeats = Array(count + 1).fill(false);
  for (let p = 1; p <= count; p++) aiSeats[p] = seats[p] !== 'human' || (mode === 'online' && !seatOwners[p]);
  const state = { playerCount: count, aiSeats, aiSeat: aiSeats.findIndex((v, i) => i > 0 && v), size: n, board: Array(P.length).fill(0), turn: 1, damage: Array(count+1).fill(0), passes: 0, over: false, result: null, phase: 'playing', dead: [], last: -1, out: Array(count+1).fill(false), seen: [], hist: [] };
  if (gameFeatures) state.record = gameFeatures.createRecord(state);
  return state;
}
function setSeen() { seenSet = new Set(G.seen); }
function hash(a) { // cyrb53
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < a.length; i++) { h1 = Math.imul(h1 ^ a[i], 2654435761); h2 = Math.imul(h2 ^ a[i], 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}
const KEY = 'hexago-save-v1';
function save() {
  try { sessionStorage.setItem(KEY, JSON.stringify({ G, onlineAI, pendingSize, mode, seats, aiMode, seatAIModes, theme: theme.id, sound: snd.on })); } catch (e) { }
  try { if (typeof saveOnlineSession === 'function') saveOnlineSession(); } catch (e) { }
}
function load() {
  try {
    const s = JSON.parse(sessionStorage.getItem(KEY) || 'null');
    if (!s || !s.G || ![9, 13, 19, 25].includes(s.G.size)) return false;
    build(s.G.size); if (s.G.board.length !== P.length) return false;
    G = s.G; onlineAI = !!s.onlineAI; pendingSize = s.pendingSize || G.size;
    aiMode = (s.aiMode === 'deep' || s.aiMode === 'beta') ? 'deep' : 'fast';
    const sm = Array.isArray(s.seatAIModes) ? s.seatAIModes : null;
    const allSameAsBulk = sm && sm.slice(1, 7).every(v => v === aiMode);
    seatAIModes = Array.from({length:7}, (_, i) => i === 0 ? 0 : (!allSameAsBulk && sm && (sm[i] === 'fast' || sm[i] === 'deep') ? sm[i] : null));
    seats = s.seats || seats; seats = Array.from({length:7}, (_, i) => i === 0 ? 0 : (seats[i] === 'ai' ? 'ai' : 'human'));
    playerCount = Math.max(2, Math.min(6, G.playerCount || 3)); G.playerCount=playerCount; G.damage=Array.from({length:playerCount+1},(_,i)=>(G.damage||[])[i]||0); G.out=Array.from({length:playerCount+1},(_,i)=>!!((G.out||[])[i])); seats.length = 7; seatOwners = Array(7).fill(null); seatNicknames = ['', '', '', '', '', '', '']; roomPool = Object.create(null); disconnectedNicknames = Object.create(null); G.aiSeats = Array.from({length:playerCount+1},(_,i)=>i===0?false:(seats[i] !== 'human')); G.aiSeat = G.aiSeats.findIndex((v,i)=>i>0&&v); mode = 'local'; selectedMode = 'local';
    if (THEMES[s.theme]) theme = THEMES[s.theme]; if (s.sound === false) snd.on = false;
    setSeen(); return true;
  } catch (e) { return false; }
}
