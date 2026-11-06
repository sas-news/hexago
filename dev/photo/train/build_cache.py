"""Pre-generate the synthetic dataset in parallel and cache it as .npz.

Board rendering is CPU heavy (~0.35 s/board), so we fan out over worker processes
and cache the resulting feature matrices. The cache lives in dev/photo/train/cache/
(git-ignored) -- only the final model weights and a handful of test PNGs are
committed.

Usage:
  python build_cache.py --split train --boards 2400 [--workers 7]
  python build_cache.py --split val --boards 150
  python build_cache.py --split test --boards 250
"""
import argparse
import multiprocessing as mp
import os
import time

import numpy as np

import gen_dataset as GD

CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cache')

_WORKER_RNG = None
_WORKER_SPLIT = None
_WORKER_SEED = None


def _init_worker(split, seed):
    global _WORKER_RNG, _WORKER_SPLIT, _WORKER_SEED
    _WORKER_SPLIT = split
    _WORKER_SEED = seed
    _WORKER_RNG = np.random.default_rng(seed)


def _work(i):
    # deterministic per-board rng, independent of scheduling order
    rng = np.random.default_rng((_WORKER_SEED * 1000003 + i * 7919) % (2 ** 63))
    X, y, meta = GD.make_board_sample(_WORKER_SPLIT, rng)
    return X, y.astype(np.int8), meta


def build(split, n_boards, workers, seed):
    os.makedirs(CACHE_DIR, exist_ok=True)
    t0 = time.time()
    Xs, ys, nss, bids, metas = [], [], [], [], []
    with mp.Pool(processes=workers, initializer=_init_worker,
                 initargs=(split, seed)) as pool:
        for k, (X, y, meta) in enumerate(pool.imap_unordered(_work, range(n_boards), chunksize=2)):
            Xs.append(X)
            ys.append(y)
            nss.append(np.full(len(y), meta['n'], dtype=np.int16))
            bids.append(np.full(len(y), k, dtype=np.int32))
            metas.append((meta['theme'], meta['lighting'], meta['material'], meta['n']))
            if (k + 1) % 100 == 0 or k + 1 == n_boards:
                el = time.time() - t0
                print('  %s: %d/%d boards  %.1fs  (%.0f boards/s, %.1f ms/board)'
                      % (split, k + 1, n_boards, el, (k + 1) / el, 1000 * el / (k + 1)),
                      flush=True)
    X = np.concatenate(Xs).astype(np.float32)
    y = np.concatenate(ys).astype(np.int64)
    ns = np.concatenate(nss)
    bids = np.concatenate(bids)
    out = os.path.join(CACHE_DIR, split + '.npz')
    np.savez(out, X=X, y=y, n=ns, board=bids,
             meta=np.array([str(m) for m in metas]))
    print('saved %s: X=%s y=%s  (%.1fs)' % (out, X.shape, y.shape, time.time() - t0))
    print('  class counts:', np.bincount(y, minlength=8).tolist())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--split', default='train', choices=['train', 'val', 'test'])
    ap.add_argument('--boards', type=int, default=2400)
    ap.add_argument('--workers', type=int, default=7)
    ap.add_argument('--seed', type=int, default=20251106)
    args = ap.parse_args()
    seed = args.seed + {'train': 0, 'val': 100000, 'test': 200000}[args.split]
    build(args.split, args.boards, args.workers, seed)


if __name__ == '__main__':
    main()
