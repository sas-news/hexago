"""Fine-tune the synthetic-trained model on the real photo patches + report LOO.

The real photo (IMG_0252) gives 127 labelled patches. We augment them in patch
space (exposure / white-balance gain / sensor noise -> recompute features) to
avoid memorising individual patches, mix in a subsample of synthetic data so the
other classes stay calibrated, and estimate generalisation with 5-fold
leave-one-fold-out cross validation.

Usage:
  python finetune_real.py [--base cache/model.npz] [--folds 5] [--copies 32]
                          [--out cache/model_real.npz]
"""
import argparse
import json
import os
import time

import numpy as np

import features as F
import mlp

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, 'cache')
REAL_PATCHES = os.path.normpath(os.path.join(HERE, '../testdata/IMG_0252.patches.json'))
CLASS_INDEX = {c: i for i, c in enumerate(mlp.CLASSES)}


def load_params(path):
    d = np.load(path)
    params = []
    i = 0
    while ('W%d' % i) in d:
        params.append({'W': d['W%d' % i].astype(np.float32),
                       'b': d['b%d' % i].astype(np.float32)})
        i += 1
    return params


def save_params(params, path):
    np.savez(path, **{'W%d' % i: p['W'] for i, p in enumerate(params)},
             **{'b%d' % i: p['b'] for i, p in enumerate(params)})


def augment_patches(patches, baseline, rng, copies):
    """Exposure / WB / noise augmentation in patch space -> (N*copies, 28) features."""
    feats = []
    for p in patches:
        for _ in range(copies):
            gain = rng.uniform(0.82, 1.18)
            wb = rng.uniform(0.92, 1.08, 3)
            p2 = p * (gain * wb)[None, None, :]
            p2 = p2 + rng.normal(0, rng.uniform(0.0, 2.5), p2.shape)
            p2 = np.clip(p2, 0, 255)
            feats.append(F.extract_features(p2, baseline))
    return np.stack(feats)


def train_raw(params, X, y, Xv=None, yv=None, epochs=25, batch=256, lr=2e-4,
              seed=0, class_weights=None):
    rng = np.random.default_rng(seed)
    params = [{'W': p['W'].astype(np.float32).copy(), 'b': p['b'].astype(np.float32).copy()}
              for p in params]
    m, v = [], []
    for p in params:
        m.extend([np.zeros_like(p['W']), np.zeros_like(p['b'])])
        v.extend([np.zeros_like(p['W']), np.zeros_like(p['b'])])
    B1, B2, eps = 0.9, 0.999, 1e-8
    step = 0
    n = len(X)
    best = (-1.0, None, 0)
    w = None
    if class_weights is not None:
        w = np.asarray(class_weights, np.float64)
    for ep in range(epochs):
        idx = rng.permutation(n)
        for i in range(0, n, batch):
            bi = idx[i:i + batch]
            xb = X[bi].astype(np.float64)
            yb = y[bi]
            acts = [xb]
            zs = []
            a = xb
            for li, p in enumerate(params):
                z = a @ p['W'].astype(np.float64).T + p['b'].astype(np.float64)
                zs.append(z)
                a = np.maximum(z, 0.0) if li < len(params) - 1 else z
                acts.append(a)
            logits = acts[-1] - acts[-1].max(axis=1, keepdims=True)
            e = np.exp(logits)
            probs = e / e.sum(axis=1, keepdims=True)
            g = probs.copy()
            g[np.arange(len(bi)), yb] -= 1.0
            if w is not None:
                g *= w[yb][:, None]
            g /= len(bi)
            grads = [None] * len(params)
            for li in range(len(params) - 1, -1, -1):
                W = params[li]['W'].astype(np.float64)
                grads[li] = {'W': g.T @ acts[li], 'b': g.sum(axis=0)}
                if li > 0:
                    g = (g @ W) * (zs[li - 1] > 0)
            step += 1
            for li in range(len(params)):
                for key in ('W', 'b'):
                    gr = grads[li][key]
                    im = li * 2 + (0 if key == 'W' else 1)
                    m[im] = B1 * m[im] + (1 - B1) * gr
                    v[im] = B2 * v[im] + (1 - B2) * (gr * gr)
                    mh = m[im] / (1 - B1 ** step)
                    vh = v[im] / (1 - B2 ** step)
                    params[li][key] = (params[li][key] - lr * mh / (np.sqrt(vh) + eps)).astype(np.float32)
        if Xv is not None and yv is not None:
            acc = float((mlp.predict(params, Xv) == yv).mean())
            if acc > best[0]:
                best = (acc, [{'W': p['W'].copy(), 'b': p['b'].copy()} for p in params], ep + 1)
    if best[1] is not None:
        return best[1], best[0]
    return params, None


def load_real():
    d = json.load(open(REAL_PATCHES))
    P = np.asarray(d['patches'], np.float64).reshape(-1, 16, 16, 3)
    y = np.array([CLASS_INDEX[l] for l in d['labels']], dtype=np.int64)
    baseline = np.asarray(d['baseline'], np.float64)
    return P, y, baseline


def load_syn_subset(limit=40000, seed=0):
    path = os.path.join(CACHE, 'train.npz')
    if not os.path.exists(path):
        return None, None
    d = np.load(path)
    X, y = d['X'], d['y']
    if len(X) > limit:
        rng = np.random.default_rng(seed)
        idx = rng.choice(len(X), limit, replace=False)
        X, y = X[idx], y[idx]
    return X.astype(np.float32), y.astype(np.int64)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--base', default=os.path.join(CACHE, 'model.npz'))
    ap.add_argument('--out', default=os.path.join(CACHE, 'model_real.npz'))
    ap.add_argument('--folds', type=int, default=5)
    ap.add_argument('--copies', type=int, default=32)
    ap.add_argument('--epochs', type=int, default=25)
    ap.add_argument('--lr', type=float, default=2e-4)
    ap.add_argument('--syn', type=int, default=40000, help='synthetic samples mixed in')
    args = ap.parse_args()

    base = load_params(args.base)
    P, y, baseline = load_real()
    print('real patches: %d  (counts %s)' % (len(y), np.bincount(y, minlength=8).tolist()))

    # base model accuracy on real patches
    Xreal = np.stack([F.extract_features(p, baseline) for p in P])
    pred0 = mlp.predict(base, Xreal)
    print('base model on real: %.4f (%d errors)'
          % ((pred0 == y).mean(), int((pred0 != y).sum())))

    synX, syny = load_syn_subset(args.syn) if args.syn > 0 else (None, None)

    # ---- 5-fold LOO estimate of the fine-tuned model ----
    rng = np.random.default_rng(7)
    order = rng.permutation(len(y))
    folds = np.array_split(order, args.folds)
    loo_ok = 0
    for fi, hold in enumerate(folds):
        mask = np.ones(len(y), bool)
        mask[hold] = False
        rng2 = np.random.default_rng(100 + fi)
        Xa = augment_patches(P[mask], baseline, rng2, args.copies)
        ya = np.tile(y[mask], args.copies)
        if synX is not None:
            Xa = np.concatenate([Xa, synX])
            ya = np.concatenate([ya, syny])
        params, _ = train_raw(base, Xa, ya, epochs=args.epochs, lr=args.lr,
                              seed=fi, class_weights=np.ones(8))
        pred = mlp.predict(params, Xreal[hold])
        loo_ok += int((pred == y[hold]).sum())
        print('  fold %d: held-out acc %.4f (%d/%d)'
              % (fi, (pred == y[hold]).mean(), int((pred == y[hold]).sum()), len(hold)),
              flush=True)
    loo_acc = loo_ok / len(y)
    print('LOO (5-fold) accuracy: %.4f (%d/%d)' % (loo_acc, loo_ok, len(y)))

    # ---- final model: fine-tune on all real patches ----
    rng2 = np.random.default_rng(555)
    Xa = augment_patches(P, baseline, rng2, args.copies)
    ya = np.tile(y, args.copies)
    if synX is not None:
        Xa = np.concatenate([Xa, synX])
        ya = np.concatenate([ya, syny])
    params, _ = train_raw(base, Xa, ya, epochs=args.epochs, lr=args.lr, seed=999)
    pred = mlp.predict(params, Xreal)
    print('final model on real (train, expected near 100%%): %.4f (%d errors)'
          % ((pred == y).mean(), int((pred != y).sum())))
    for i in np.where(pred != y)[0]:
        print('   miss pt %3d true %-6s pred %-6s' % (i, mlp.CLASSES[y[i]], mlp.CLASSES[pred[i]]))

    # synthetic held-out checks (forgetting / generalisation)
    syn_report = {}
    for split in ('val', 'test'):
        p = os.path.join(CACHE, split + '.npz')
        if not os.path.exists(p):
            continue
        d = np.load(p)
        Xs, ys = d['X'].astype(np.float32), d['y'].astype(np.int64)
        for name, mdl in (('base', base), ('finetuned', params)):
            pr = mlp.predict(mdl, Xs)
            syn_report['%s_%s' % (name, split)] = float((pr == ys).mean())
            print('%s on synthetic %s: %.4f' % (name, split, (pr == ys).mean()))

    save_params(params, args.out)
    print('saved %s' % args.out)
    json.dump({'loo_accuracy': loo_acc, 'real_train_accuracy': float((pred == y).mean()),
               'base_real_accuracy': float((pred0 == y).mean()),
               'synthetic': syn_report},
              open(os.path.join(CACHE, 'finetune_report.json'), 'w'), indent=1)


if __name__ == '__main__':
    main()
