"""Classify exported patches with the trained MLP (contract v2).

Input JSON (written by the browser / Lead):
    {"baseline": [r,g,b],                  # canonical image baseline, 0..255
     "patches": [[16*16*3 floats]...],     # RGB 0..255, index=(y*16+x)*3+c
     "labels": ["empty", ...]}             # optional, class names or indices

Output JSON:
    {"model": "...", "classes": [...], "count": N, "accuracy": 0.99|null,
     "confusion": [[...8x8...]], "predictions": [
        {"index":0, "label":"blue", "pred":"blue", "conf":0.99, "probs":[...] }, ...]}

Usage:
    python eval_patches.py patches.json [--model ../../../js/photo/model.json] [--out result.json]
"""
import argparse
import json
import sys

import numpy as np

import features as F
import mlp


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('patches')
    ap.add_argument('--model', default='../../../js/photo/model.json')
    ap.add_argument('--out', default=None)
    args = ap.parse_args()

    with open(args.patches) as f:
        data = json.load(f)
    patches = np.asarray(data['patches'], dtype=np.float64).reshape(-1, 16, 16, 3)
    baseline = np.asarray(data.get('baseline') or [255, 255, 255], dtype=np.float64)
    labels = data.get('labels')

    feats = np.stack([F.extract_features(p, baseline) for p in patches])
    params, classes = mlp.load_model(args.model)
    probs = mlp.predict_proba(params, feats)
    pred = probs.argmax(axis=1)
    conf = probs.max(axis=1)

    y = None
    if labels is not None:
        y = np.array([mlp.CLASSES.index(l) if isinstance(l, str) else int(l) for l in labels])

    result = {
        'model': args.model,
        'count': int(len(patches)),
        'classes': classes,
        'accuracy': mlp.accuracy(y, pred) if y is not None else None,
        'predictions': [{
            'index': i,
            'label': (mlp.CLASSES[int(y[i])] if y is not None else None),
            'pred': mlp.CLASSES[int(pred[i])],
            'conf': round(float(conf[i]), 6),
            'probs': [round(float(v), 6) for v in probs[i]],
        } for i in range(len(patches))],
    }
    if y is not None:
        cm = mlp.confusion(y, pred)
        result['confusion'] = cm.tolist()
        result['per_class'] = mlp.per_class_accuracy(cm)

    txt = json.dumps(result, ensure_ascii=False, indent=1)
    if args.out:
        with open(args.out, 'w') as f:
            f.write(txt)
        print('wrote %s' % args.out)
    else:
        print(txt)

    if y is not None:
        print('\naccuracy: %.4f  (%d/%d)' % (result['accuracy'],
                                             int(pred == y), len(y)), file=sys.stderr)
        for name, acc in result['per_class'].items():
            tot = int((y == mlp.CLASSES.index(name)).sum())
            if tot:
                print('  %-7s %5.1f%%  n=%d' % (name, 100 * acc, tot), file=sys.stderr)


if __name__ == '__main__':
    main()
