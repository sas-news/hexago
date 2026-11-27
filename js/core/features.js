// ===== 棋譜保存 (hexago-kifu v1) & 連続パス制御 =====
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HexagoGameFeatures = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const copy = value => JSON.parse(JSON.stringify(value));
  const isMove = event => ['play', 'pass', 'resign'].includes(event.type);
  const signature = state => JSON.stringify([state.size, state.playerCount, state.board, state.turn, state.passes, state.out]);
  const position = state => ({ board: state.board.slice(), turn: state.turn, passes: state.passes || 0, out: (state.out || []).slice(), damage: (state.damage || []).slice(), seen: (state.seen || []).slice(), aiSeats: (state.aiSeats || []).slice() });

  function createRecord(state) {
    const complete = state.turn === 1 && !state.passes && !state.board.some(Boolean) && !(state.out || []).some(Boolean) && !(state.seen || []).length;
    return {
      version: 1,
      id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12),
      startedAt: complete ? new Date().toISOString() : null,
      complete,
      initial: position(state),
      events: [],
      endKey: signature(state)
    };
  }

  function infer(before, after, player, terminal) {
    if (!Number.isInteger(player) || player < 1) return null;
    const outBefore = before.out || [], outAfter = after.out || [];
    if (outAfter.some((v, i) => v !== !!outBefore[i])) {
      if (outAfter[player] && !outBefore[player] && before.board.every((v, i) => v === after.board[i]) && outAfter.every((v, i) => i === player || v === !!outBefore[i])) {
        return { type: 'resign', player };
      }
      return null;
    }
    const changed = before.board.flatMap((v, i) => v === after.board[i] ? [] : [i]);
    if (after.passes === (before.passes || 0) + 1 && after.last === -1 && (!changed.length || (terminal && changed.every(i => before.board[i] && !after.board[i])))) {
      return { type: 'pass', player };
    }
    const point = after.last;
    if (!Number.isInteger(point) || point < 0 || before.board[point] || after.board[point] !== player || after.passes !== 0) return null;
    if (!changed.includes(point) || changed.some(i => i !== point && (!before.board[i] || after.board[i]))) return null;
    return { type: 'play', player, point, captured: changed.filter(i => i !== point) };
  }

  function ensureRecord(state) {
    const old = state.record;
    if (old && old.version === 1 && typeof old.id === 'string' && Array.isArray(old.events) && old.initial?.board?.length === state.board.length && old.endKey === signature(state)) return old;
    const history = Array.isArray(state.hist) ? state.hist : [];
    const initial = history[0] ? { ...state, ...history[0], seen: (state.seen || []).slice(0, history[0].seen || 0) } : state;
    const record = createRecord(initial);
    record.startedAt = null;
    let valid = true;
    for (let i = 0; i < history.length; i++) {
      const before = history[i], after = history[i + 1] || state;
      const event = infer(before, after, before.by, !history[i + 1] && state.over);
      if (!event) { valid = false; break; }
      before.recordLength = record.events.length;
      record.events.push(event);
    }
    if (!valid) {
      state.record = createRecord(state);
      state.record.complete = false;
      state.record.note = '旧形式の履歴を完全には復元できないため、現在の局面から記録しています。';
      for (const item of history) item.recordLength = null;
    } else {
      state.record = record;
      if (state.over && state.phase === 'ended' && record.events.at(-1)?.type === 'pass') {
        const previous = history.at(-1).board;
        record.events.push({ type: 'score', removed: previous.flatMap((v, i) => v && !state.board[i] ? [i] : []), result: state.result?.title || '' });
      }
      if (!record.complete && !record.note) record.note = '途中局面から開始されたため、残っている履歴の最初の局面から記録しています。';
    }
    state.record.endKey = signature(state);
    return state.record;
  }

  function appendEvent(state, event) {
    if (!state.record || state.record.version !== 1) throw new Error('Record must be prepared before changing the position');
    state.record.events.push(copy(event));
    state.record.endKey = signature(state);
  }

  function rewindRecord(state, length) {
    if (Number.isInteger(length) && length >= 0 && length <= state.record.events.length) {
      state.record.events.length = length;
      state.record.endKey = signature(state);
    } else {
      delete state.record;
      ensureRecord(state);
    }
  }

  function coordinates(size) {
    const radius = (size - 1) / 2, points = [];
    for (let r = -radius; r <= radius; r++) {
      for (let q = -radius; q <= radius; q++) {
        if (Math.abs(q + r) <= radius) points.push([q, r]);
      }
    }
    return points;
  }

  function exportRecord(state, options = {}) {
    const record = ensureRecord(state), points = coordinates(state.size), names = options.names || [];
    let ply = 0;
    const events = record.events.map((event, index) => ({
      ...copy(event),
      sequence: index + 1,
      moveNumber: isMove(event) ? ++ply : null,
      ...(event.type === 'play' ? { coordinate: points[event.point], capturedCoordinates: (event.captured || []).map(i => points[i]) } : {})
    }));
    return {
      format: 'hexago-kifu',
      formatVersion: 1,
      exportedAt: options.exportedAt || new Date().toISOString(),
      game: {
        id: record.id,
        size: state.size,
        playerCount: state.playerCount,
        startedAt: record.startedAt,
        scoring: 'area',
        komi: 0,
        players: Array.from({ length: state.playerCount }, (_, i) => ({ number: i + 1, name: names[i + 1] || (i + 1) + 'P' }))
      },
      completeFromStart: record.complete,
      note: record.note || null,
      coordinateSystem: 'axial (q,r); point indices follow the points array',
      points,
      initialPosition: copy(record.initial),
      moveCount: ply,
      events,
      currentPosition: {
        ...position(state),
        phase: state.phase,
        over: !!state.over,
        selectedDead: (state.dead || []).slice(),
        result: state.result ? { title: state.result.title } : null
      }
    };
  }

  function toText(record) {
    const name = p => record.game.players.find(player => player.number === p)?.name || p + 'P';
    const lines = [
      'HEXAGO 棋譜',
      `${record.game.size}路盤 / ${record.game.playerCount}人 / ${record.moveCount}手`,
      `保存日時: ${record.exportedAt}`,
      record.completeFromStart ? '初期盤面からの完全な棋譜' : '途中局面からの棋譜',
      '座標: 六角盤の軸座標 (q,r)。中心は (0,0)。'
    ];
    if (record.note) lines.push(record.note);
    if (!record.completeFromStart) {
      lines.push('開始局面: ' + record.initialPosition.turn + 'Pの手番 / 連続パス ' + record.initialPosition.passes);
      lines.push('開始局面の石: ' + record.initialPosition.board.flatMap((p, i) => p ? [`${p}P(${record.points[i].join(',')})`] : []).join(' '));
    }
    lines.push('');
    for (const event of record.events) {
      const who = event.player ? `${event.player}P ${name(event.player)}` : '';
      if (event.type === 'play') lines.push(`${event.moveNumber}. ${who} (${event.coordinate.join(',')})${event.captured.length ? ' / 取石 ' + event.captured.length : ''}`);
      else if (event.type === 'pass') lines.push(`${event.moveNumber}. ${who} パス${event.automatic ? '（連続パス）' : ''}`);
      else if (event.type === 'resign') lines.push(`${event.moveNumber}. ${who} 投了`);
      else if (event.type === 'resume') lines.push('── 対局再開 ──');
      else if (event.type === 'score') lines.push('── 終局確定 / ' + (event.result || '') + ' ──');
    }
    lines.push(
      '',
      record.currentPosition.over
        ? '対局終了: ' + (record.currentPosition.result?.title || '')
        : record.currentPosition.phase === 'dead'
          ? '終局・死に石確認中'
          : record.currentPosition.phase === 'setup'
            ? '対局開始前'
            : '対局途中'
    );
    return lines.join('\n') + '\n';
  }

  function createAutoPassController(options) {
    const schedule = options.setTimeout || setTimeout, cancel = options.clearTimeout || clearTimeout;
    const enabled = new Set();
    let timer = null, pendingKey = null, sentKey = null, identity = null, owner = null, revision = -1;
    const stopTimer = () => { if (timer !== null) cancel(timer); timer = null; pendingKey = null; };
    function clear() { stopTimer(); enabled.clear(); sentKey = null; }
    const ready = c => c.playing && !c.over && !c.paused && !c.busy && c.connected !== false && c.canPass && enabled.has(c.turn) && c.eligible.includes(c.turn);
    function update() {
      const c = options.getContext();
      if (identity !== c.identity || owner !== c.owner || c.revision < revision || !c.playing || c.over) clear();
      identity = c.identity; owner = c.owner; revision = c.revision;
      for (const p of enabled) if (!c.eligible.includes(p)) enabled.delete(p);
      if (!ready(c) || c.key === sentKey) { stopTimer(); return; }
      if (timer !== null && pendingKey === c.key) return;
      stopTimer(); pendingKey = c.key;
      const key = c.key, expectedOwner = c.owner;
      timer = schedule(() => {
        timer = null; pendingKey = null;
        const latest = options.getContext();
        if (latest.key !== key || latest.owner !== expectedOwner || !ready(latest) || latest.key === sentKey) return;
        sentKey = key;
        options.onPass(latest.turn);
      }, options.delayMs ?? 650);
    }
    function toggle(p) {
      update();
      const c = options.getContext();
      if (!c.playing || !c.eligible.includes(p)) return;
      enabled.has(p) ? enabled.delete(p) : enabled.add(p);
      update();
    }
    function disable(p) { enabled.delete(p); stopTimer(); }
    return { update, toggle, disable, clear, isEnabled: p => enabled.has(p), enabledSeats: () => [...enabled] };
  }

  return { createRecord, ensureRecord, appendEvent, rewindRecord, exportRecord, toText, coordinates, signature, createAutoPassController };
});
