// ===== 起動 =====
window.onload = () => {
  buildThemes();
  const restored = load();
  if (!restored) { build(9); G = newG(9); G.phase = 'setup'; setSeen(); }
  // applyTheme()/save() can clear the stored online session, so read it before them.
  const pendingOnline = restored ? readOnlineSession() : null;
  applyTheme(theme); syncSettings();
  const resumedOnline = !!(pendingOnline && resumeOnlineSession(pendingOnline));
  if (!restored) $('setModal').classList.remove('hidden');
  if (G.over && G.result) $('bnResult').classList.remove('hidden');
  resizeCanvas(); updateUI();
  // 読み込み時はいったんリプレイ表示を解除したうえで、
  // 終局済みならリプレイ画面から始める(終局=リプレイ状態)。
  if (window.HexagoReplayUI && window.HexagoReplayUI.reset) window.HexagoReplayUI.reset();
  if (G.over && G.result && window.HexagoReplayUI && window.HexagoReplayUI.open) {
    setTimeout(() => { if (G.over) window.HexagoReplayUI.open({ keepResultModal: true }); }, 0);
  }
  if (!resumedOnline) maybeAI();
};
