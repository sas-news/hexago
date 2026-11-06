"""Export the trained MLP to js/photo/model.json (format hexago-photo-mlp-v1).

Usage:
  python export.py [--model cache/model.npz] [--out ../../js/photo/model.json]
  python export.py --check          # round-trip check + speed benchmark in Node
"""
import argparse
import json
import os
import subprocess
import sys

import numpy as np

import mlp

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_MODEL = os.path.join(HERE, 'cache', 'model.npz')
DEFAULT_OUT = os.path.normpath(os.path.join(HERE, '../../../js/photo/model.json'))


def load_npz(path):
    d = np.load(path)
    params = []
    i = 0
    while ('W%d' % i) in d:
        params.append({'W': d['W%d' % i].astype(np.float32),
                       'b': d['b%d' % i].astype(np.float32)})
        i += 1
    if not params:
        raise SystemExit('no layers in %s' % path)
    return params


def export(path, out):
    params = load_npz(path)
    obj = mlp.save_model(params, out)
    size = os.path.getsize(out)
    print('wrote %s (%d bytes, %d layers, %d params)'
          % (out, size, len(params), sum(p['W'].size + p['b'].size for p in params)))
    # quick self-check
    back, classes = mlp.load_model(out)
    for a, b in zip(params, back):
        assert np.allclose(a['W'], b['W'], atol=0, rtol=0)
        assert np.allclose(a['b'], b['b'], atol=0, rtol=0)
    print('round-trip OK, classes=%s' % ','.join(classes))
    return out


def check():
    # JS parity + speed (uses the parity fixtures and model.json)
    here = HERE
    env = dict(os.environ)
    r = subprocess.run(['node', os.path.join(here, 'parity_check.js')],
                       cwd=here, env=env)
    return r.returncode


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--model', default=DEFAULT_MODEL)
    ap.add_argument('--out', default=DEFAULT_OUT)
    ap.add_argument('--check', action='store_true')
    args = ap.parse_args()
    if not os.path.exists(args.model):
        raise SystemExit('missing trained model %s (run train.py first)' % args.model)
    export(args.model, args.out)
    if args.check:
        sys.exit(check())


if __name__ == '__main__':
    main()
