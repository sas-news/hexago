"""Generate parity fixtures: raw patches + baseline + Python reference features.

js/photo/features.js must reproduce `features` from `patches` + `baseline`
within 1e-5 (see parity_check.js). Feature order matches CONTRACT v2.

Run:  python parity.py [out.json]
"""
import json
import sys

import numpy as np

import features as F


def _smooth_patch(rng, lo, hi):
    """Low-frequency random patch (bilinear upsampled coarse grid) + slight noise."""
    coarse = rng.random((5, 5, 3)) * (hi - lo) + lo
    ys = np.linspace(0, 3.999, 16)
    xs = np.linspace(0, 3.999, 16)
    y0 = np.floor(ys).astype(int)
    x0 = np.floor(xs).astype(int)
    y1 = np.minimum(y0 + 1, 3)
    x1 = np.minimum(x0 + 1, 3)
    fy = (ys - y0)[:, None, None]
    fx = (xs - x0)[None, :, None]
    top = coarse[y0][:, x0] * (1 - fx) + coarse[y0][:, x1] * fx
    bot = coarse[y1][:, x0] * (1 - fx) + coarse[y1][:, x1] * fx
    p = top * (1 - fy) + bot * fy
    return p + rng.normal(0, 3.0, p.shape)


def _stone_like(rng):
    """A glossy disc on a board-like background, roughly like a real patch."""
    yy, xx = np.mgrid[0:16, 0:16]
    cx, cy = 7.5 + rng.uniform(-1.5, 1.5), 7.5 + rng.uniform(-1.5, 1.5)
    r = rng.uniform(5.0, 7.5)
    d = np.hypot(xx - cx, yy - cy)
    inside = (d <= r).astype(np.float64)
    board = np.array([115, 87, 75]) + rng.normal(0, 6, 3)
    colour = rng.integers(0, 256, 3).astype(np.float64)
    shade = 0.72 + 0.28 * np.clip(1.0 - d / (r + 1e-6), 0, 1) ** 1.5
    p = board[None, None, :] * (1 - inside[..., None]) + \
        colour[None, None, :] * (inside * shade)[..., None]
    hx, hy = cx - 0.35 * r, cy - 0.35 * r
    spec = np.exp(-((xx - hx) ** 2 + (yy - hy) ** 2) / (2 * 1.3 ** 2))
    p = p + spec[..., None] * 235.0
    return p


def make_patches(seed=20251106):
    rng = np.random.default_rng(seed)
    patches = []
    labels = ['empty', 'black', 'white', 'red', 'blue', 'yellow', 'empty', 'purple']
    # 1) uniform noise
    patches.append(rng.random((16, 16, 3)) * 255.0)
    # 2) dark smooth board-like patch
    patches.append(_smooth_patch(rng, 40, 120))
    # 3) bright smooth patch with highlight
    p = _smooth_patch(rng, 180, 250)
    p[3:6, 3:6, :] = 255.0
    patches.append(p)
    # 4) saturated flat colours (tests HSV / percentiles)
    p = np.zeros((16, 16, 3))
    p[:, :8] = [220.0, 30.0, 40.0]
    p[:, 8:] = [40.0, 200.0, 60.0]
    patches.append(p)
    # 5-7) stone-like patches on a wood board
    for _ in range(3):
        patches.append(np.clip(_stone_like(rng), 0, 255))
    # 8) strong checker edge (tests Sobel)
    p = np.zeros((16, 16, 3))
    m = ((np.arange(16)[:, None] // 2 + np.arange(16)[None, :] // 2) % 2).astype(np.float64)
    p[..., 0] = m * 240
    p[..., 1] = (1 - m) * 240
    patches.append(p)

    patches = [np.clip(p, 0, 255).astype(np.float32) for p in patches]
    baseline = np.array([117.0, 88.0, 74.0])  # wood-board like
    feats = [F.extract_features(p, baseline) for p in patches]
    return patches, labels, baseline, np.stack(feats)


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else 'parity-fixtures.json'
    patches, labels, baseline, feats = make_patches()
    obj = {
        'meta': {
            'contract': 'v2',
            'patch': '16x16x3 row-major, index=(y*16+x)*3+c, RGB 0..255 float',
            'baseline': 'per-channel median RGB 0..255',
            'features': '28 dims, dev/photo/train/features.py definition',
            'tolerance': 1e-5,
        },
        'baseline': [float(v) for v in baseline],
        'patches': [p.reshape(-1).tolist() for p in patches],
        'labels': labels,
        'features': [[float(v) for v in row] for row in feats],
    }
    with open(out, 'w') as f:
        json.dump(obj, f)
    print('wrote %s: %d patches, %d features each' % (out, len(patches), feats.shape[1]))


if __name__ == '__main__':
    main()
