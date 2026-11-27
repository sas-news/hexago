// ===== モーダル共通: 背景クリック / Esc / 閉じるボタンで閉じる =====
const MODAL_IDS = ['recordModal', 'setModal', 'undoModal', 'rulesModal', 'resModal', 'photoModal', 'shareModal'];
function modalEl(id) { return document.getElementById(id); }
function visibleModals() {
  return MODAL_IDS.map(modalEl).filter(el => el && !el.classList.contains('hidden'));
}
function closeModal(el) {
  if (!el || el.classList.contains('hidden')) return false;
  el.classList.add('hidden');
  // 設定を閉じたら「その場だけの表示」は捨てる(開き直すと対局中の状態に戻る)
  if (el.id === 'setModal' && typeof clearTransientSettings === 'function') clearTransientSettings();
  if (G && typeof autoPass === 'function' && autoPass()) autoPass().update();
  return true;
}
MODAL_IDS.forEach(id => {
  const el = modalEl(id);
  if (el) el.addEventListener('click', e => { if (e.target === el) closeModal(el); });
});
window.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  const open = visibleModals();
  if (open.length) { e.preventDefault(); closeModal(open[open.length - 1]); }
});

// 結果モーダルの中身を更新して表示する。
// 終局時はこれが開いたまま、背後でリプレイ画面へ切り替わる。
// リプレイ画面の「結果」ボタンからも開き直せる。
function showResult() {
  if (!G || !G.result) return;
  $('resTitle').textContent = G.result.title;
  $('resDet').innerHTML = G.result.details;
  $('resModal').classList.remove('hidden');
}

// 終局したらリプレイ画面へ切り替える(結果モーダルは開いたまま重ねる)。
let autoReplayTimer = null;
function autoOpenReplayOnEnd() {
  if (autoReplayTimer) clearTimeout(autoReplayTimer);
  autoReplayTimer = setTimeout(() => {
    autoReplayTimer = null;
    if (!G || !G.over) return;
    if (typeof window.HexagoReplayUI === 'undefined' || !window.HexagoReplayUI.open) return;
    if (typeof window.HexagoReplayView !== 'undefined' && window.HexagoReplayView.active()) return;
    window.HexagoReplayUI.open();
  }, 220);
}
$('btnShowResult').onclick = () => showResult();
$('btnAgain').onclick = () => { closeModal($('resModal')); reset(); };
$('btnPass').onclick = () => { if (!G.over && G.phase === 'playing' && mine()) { doPass(); after(); } };
let resignArmed = false, resignTimer = null;
function resetResignButton() {
  resignArmed = false;
  if (resignTimer) { clearTimeout(resignTimer); resignTimer = null; }
  const b = document.getElementById('btnResign');
  if (b) {
    b.textContent = '投了';
    b.classList.remove('bg-red-500', 'text-white', 'border-red-500');
    b.classList.add('border-red-500/50', 'text-red-600');
  }
}
$('btnResign').onclick = () => {
  if (G.over || G.phase !== 'playing' || !mine()) return;
  snd.click();
  if (!resignArmed) {
    resignArmed = true;
    const b = document.getElementById('btnResign');
    b.textContent = '本当に投了？';
    b.classList.remove('border-red-500/50', 'text-red-600');
    b.classList.add('bg-red-500', 'text-white', 'border-red-500');
    resignTimer = setTimeout(resetResignButton, 2500);
    return;
  }
  resetResignButton();
  resign();
  after();
};
$('btnUndo').onclick = () => { snd.click(); if (canUndo()) $('undoModal').classList.remove('hidden'); };
$('btnUndoNo').onclick = () => closeModal($('undoModal'));
$('btnUndoOk').onclick = () => { closeModal($('undoModal')); undo(); };
$('btnDeadCancel').onclick = () => { snd.click(); if (typeof ensureGameRecord === 'function') ensureGameRecord(); if (typeof clearAutoPass === 'function') clearAutoPass(); G.phase = 'playing'; G.passes = 0; G.dead = []; if (typeof recordGameEvent === 'function') recordGameEvent({ type: 'resume' }); after(); };
$('btnDeadOk').onclick = () => { snd.click(); finishScore(); after(); };
$('btnDeadRecheck').onclick = () => { snd.click(); G.dead = detectDeadStonesSmart(); updateUI(); save(); sync(); };
$('btnDeadClear').onclick = () => { snd.click(); G.dead = []; updateUI(); save(); sync(); };
