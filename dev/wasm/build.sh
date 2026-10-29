#!/usr/bin/env bash
# Build the HEXAGO WASM prototype.
#
# We use freestanding C (no libc, no wasi sysroot) because this machine has
# clang + rust-lld but no wasm-ld / wasi-sdk and ~/.rustup is not writable
# (sandbox), so `rustup target add wasm32-unknown-unknown` is unavailable.
# rust-lld is a full multi-flavour LLD and works fine when invoked as
# `wasm-ld` (it detects the flavour from argv[0]).
set -euo pipefail
cd "$(dirname "$0")"

BUILD=.build
mkdir -p "$BUILD/bin"

# 1. find a wasm-capable linker
if ! command -v wasm-ld >/dev/null 2>&1; then
  RUST_LLD="$(find "${RUSTUP_HOME:-$HOME/.rustup}/toolchains" -name rust-lld 2>/dev/null | head -1 || true)"
  if [ -z "${RUST_LLD:-}" ]; then
    echo "ERROR: no wasm-ld and no rust-lld found. Install lld or rustup target wasm32." >&2
    exit 1
  fi
  ln -sf "$RUST_LLD" "$BUILD/bin/wasm-ld"
  export PATH="$PWD/$BUILD/bin:$PATH"
fi
echo "linker: $(command -v wasm-ld)"

# 2. compile + link (freestanding: no crt, no libc)
clang --target=wasm32 -O3 -fno-builtin \
  -nostdlib -Wl,--no-entry \
  -Wl,-z,stack-size=131072 \
  -Wl,--initial-memory=1048576 \
  -Wl,--max-memory=134217728 \
  -Wl,--export-memory \
  -Wl,--export=hg_init -Wl,--export=hg_n \
  -Wl,--export=hg_board_ptr -Wl,--export=hg_nb_off_ptr -Wl,--export=hg_nb_flat_ptr \
  -Wl,--export=hg_scores_ptr -Wl,--export=hg_clear -Wl,--export=hg_set \
  -Wl,--export=hg_set_ko -Wl,--export=hg_last_ko -Wl,--export=hg_last_moves \
  -Wl,--export=hg_last_passes -Wl,--export=hg_captured_last \
  -Wl,--export=hg_legal -Wl,--export=hg_play -Wl,--export=hg_bench \
  -Wl,--export=hg_playout_once -Wl,--export=hg_score -Wl,--export=hg_hash \
  -o hexago.wasm src/hexago.c

ls -l hexago.wasm
echo "exports:"
node -e '
const fs=require("fs");
WebAssembly.instantiate(fs.readFileSync(process.argv[1]),{}).then(({instance})=>{
  console.log(Object.keys(instance.exports).sort().join(" "));
  console.log("n(size 9) =", instance.exports.hg_init(9));
});' "$PWD/hexago.wasm"
