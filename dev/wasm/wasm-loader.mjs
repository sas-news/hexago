/* Loader for the freestanding wasm prototype (see build.sh). */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

export async function loadWasm(file = join(HERE, 'hexago.wasm')) {
  const bytes = readFileSync(file);
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const ex = instance.exports;
  const mem = ex.memory;

  function view() {
    return {
      board: new Int8Array(mem.buffer, ex.hg_board_ptr(), ex.hg_n()),
      nbOff: new Int16Array(mem.buffer, ex.hg_nb_off_ptr(), ex.hg_n() + 1),
      nbFlat: new Int16Array(mem.buffer, ex.hg_nb_flat_ptr(), 6 * ex.hg_n()),
      scores: new Int32Array(mem.buffer, ex.hg_scores_ptr(), 8),
    };
  }

  return {
    bytes,
    exports: ex,
    view,
    init(size) { return ex.hg_init(size); },
    n() { return ex.hg_n(); },
    clear() { ex.hg_clear(); },
    set(move, player) { ex.hg_set(move, player); },
    setKo(ko) { ex.hg_set_ko(ko); },
    legal(move, turn, ko) { return ex.hg_legal(move, turn, ko) === 1; },
    play(move, turn, ko) { return ex.hg_play(move, turn, ko); },
    score(pc) { ex.hg_score(pc); return Array.from(view().scores.slice(0, pc + 1)); },
    hash() { return ex.hg_hash(); },
    playoutOnce(seed, policy) { return ex.hg_playout_once(seed, policy); },
    bench(playouts, seed, policy) { return ex.hg_bench(playouts, seed, policy); },
    lastMoves() { return ex.hg_last_moves(); },
    lastPasses() { return ex.hg_last_passes(); },
    lastKo() { return ex.hg_last_ko(); },
    lastScores() { return Array.from(view().scores.slice(0, 3)); },
  };
}
