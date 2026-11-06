// ===== モーダル共通: 背景クリック / Esc / ✕ で閉じる =====
const MODAL_IDS = ['setModal', 'undoModal', 'rulesModal', 'resModal', 'photoModal'];
function modalEl(id) { return document.getElementById(id); }
function visibleModals() {
  return MODAL_IDS.map(modalEl).filter(el => el && !el.classList.contains('hidden'));
}
function closeModal(el) {
  if (!el || el.classList.contains('hidden')) return false;
  el.classList.add('hidden');
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

function showResult() { $('resTitle').textContent = G.result.title; $('resDet').innerHTML = G.result.details; $('resModal').classList.remove('hidden'); }
$('btnViewBoard').onclick = () => closeModal($('resModal'));
$('btnShowResult').onclick = showResult;
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
$('btnDeadCancel').onclick = () => { snd.click(); G.phase = 'playing'; G.passes = 0; G.dead = []; after(); };
$('btnDeadOk').onclick = () => { snd.click(); finishScore(); after(); };
$('btnDeadRecheck').onclick = () => { snd.click(); G.dead = detectDeadStonesSmart(); updateUI(); save(); sync(); };
$('btnDeadClear').onclick = () => { snd.click(); G.dead = []; updateUI(); save(); sync(); };
