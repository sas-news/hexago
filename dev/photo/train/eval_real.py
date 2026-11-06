"""Evaluate the trained model on the real photo IMG_0252 via our own
canonicalisation (GT lattice corners), for development / REPORT analysis.

The official number is measured by the Lead in the browser (canonical image and
patch extraction from the real pipeline); this script is the training-side proxy.

Usage:
  python eval_real.py [--model cache/model.npz] [--fill board|point|both]
"""
import argparse
import json
import os
import sys

import numpy as np
from PIL import Image

import features as F
import gen_dataset as GD
import geometry as G
import mlp

HERE = os.path.dirname(os.path.abspath(__file__))
GT_JSON = os.path.normpath(os.path.join(HERE, '../testdata/IMG_0252.gt.json'))
GT_JPG = os.path.normpath(os.path.join(HERE, '../testdata/IMG_0252.jpg'))
CLASS_MAP = {'K': 'black', 'W': 'white', 'B': 'blue', '.': 'empty'}


def load_real(n=13):
    gt = json.load(open(GT_JSON))
    img = np.asarray(Image.open(GT_JPG)).astype(np.float32)
    can, H = G.canonicalize(img, gt['lattice_corners_px'], n)
    paper_can = G.apply_h(H, np.array(gt['paper_corners_px'], np.float64))
    labels = [CLASS_MAP[l] for l in gt['labels']]
    return can, paper_can, labels, gt


def evaluate(params, X, y):
    probs = mlp.predict_proba(params, X)
    pred = probs.argmax(axis=1)
    return pred, probs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--model', default=os.path.join(HERE, 'cache', 'model.npz'))
    ap.add_argument('--fill', default='margin', choices=['margin', 'paper', 'point', 'all'])
    ap.add_argument('--json-out', default=None)
    args = ap.parse_args()

    params = []
    if os.path.exists(args.model):
        d = np.load(args.model)
        i = 0
        while ('W%d' % i) in d:
            params.append({'W': d['W%d' % i].astype(np.float32),
                           'b': d['b%d' % i].astype(np.float32)})
            i += 1
    else:
        print('no trained model yet (%s); features only' % args.model)

    can, paper_can, labels, gt = load_real(13)
    y = np.array([mlp.CLASSES.index(l) for l in labels], dtype=np.int64)
    out = {}
    modes = ['margin', 'paper', 'point'] if args.fill == 'all' else [args.fill]
    for mode in modes:
        if mode == 'margin':
            img, B = GD.finalize_canonical(can, 13)  # (s+0.6)*cell, browser pipeline
        elif mode == 'paper':
            img, B = GD.finalize_canonical(can, 13, board_poly=paper_can)
        else:
            img, B = GD.finalize_canonical(can, 13, margin=0.0)
        X, _, _ = GD.extract_samples(img, 13, labels, baseline=B)
        if not params:
            print('[%s] baseline=%s features saved only' % (mode, np.round(B, 1)))
            continue
        pred, probs = evaluate(params, X, y)
        acc = float((pred == y).mean())
        cm = mlp.confusion(y, pred)
        out[mode] = dict(accuracy=acc, n_errors=int((pred != y).sum()), baseline=B.tolist(),
                         per_class={mlp.CLASSES[c]: (round(100.0 * cm[c, c] / cm[c].sum(), 1)
                                                    if cm[c].sum() else None)
                                    for c in range(8)})
        print('\n== fill=%s : accuracy %.4f  errors %d/%d =='
              % (mode, acc, int((pred != y).sum()), len(y)))
        for c in range(8):
            if cm[c].sum():
                print('   %-7s %5.1f%%  n=%d' % (mlp.CLASSES[c], 100.0 * cm[c, c] / cm[c].sum(),
                                                 cm[c].sum()))
        bad = np.where(pred != y)[0]
        for i in bad:
            q, r = G.build(13)[i]
            print('   point %3d (q=%2d,r=%2d) true %-6s pred %-6s conf %.3f  f24-26 %s'
                  % (i, q, r, mlp.CLASSES[y[i]], mlp.CLASSES[pred[i]], probs[i].max(),
                     np.round(X[i, 24:27], 2)))
    if args.json_out:
        json.dump(out, open(args.json_out, 'w'), indent=1)
        print('\nwrote %s' % args.json_out)


if __name__ == '__main__':
    main()
