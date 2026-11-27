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
  // 読み込み時は必ず対局画面から始める(リプレイ表示が残らないように)
  if (window.HexagoReplayUI && window.HexagoReplayUI.reset) window.HexagoReplayUI.reset();
  if (!resumedOnline) maybeAI();
};
