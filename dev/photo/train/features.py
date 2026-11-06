"""28-D hand-crafted patch features for HEXAGO stone classification.

CONTRACT v2 (Lead, photo AI). This module is the *reference* implementation;
js/photo/features.js must reproduce `extract()` within 1e-5. See parity.py.

Data flow (per canonical 1024x1024 RGB photo, 0..255):
  1. geometry.py warps the photo into the canonical frame (Lead/JS side, homography).
  2. baseline B = per-channel median of all canonical pixels inside the point
     hexagon (the 6 lattice corners). B is 0..255. (Lead/JS side computes it;
     gen_dataset.py computes it identically for synthetic boards.)
  3. patch: 0.9*cell square centred on a point, bilinearly resampled to 16x16,
     RGB kept in 0..255 float. Sample positions:
        u = cx - side/2 + (i+0.5)*side/16
        v = cy - side/2 + (j+0.5)*side/16      (i = column, j = row)
  4. extract(patch, baseline) -> Float32Array(28), patch values p = patch/255:

   0-14  per channel (R,G,B): mean, std(population), p10, p50, p90 (N=256,
         index = floor((N-1)*p), no interpolation)
   15-16 cos(2*pi*H), sin(2*pi*H) of the patch mean colour (H in [0,1))
   17-18 S, V of the patch mean colour
   19-21 ring mean (i<2 or i>=14 or j<2 or j>=14) - centre 8x8 mean, R,G,B
   22    population std of V at 8 points on a radius-6 circle around (7.5,7.5)
         (45 deg steps, bilinear sampling of the patch)
   23    fraction of pixels with V > 0.92 and S < 0.25
   24-26 patch mean R,G,B / (B_c/255) - 1   (ratio to the board baseline,
         B clamped to >= 1 to avoid division by zero)
   27    mean magnitude of the luminance centre-difference gradient
         L = 0.299r + 0.587g + 0.114b, gx = (L[j+1]-L[j-1])/2,
         gy = (L[i+1]-L[i-1])/2, over the interior i,j in 1..14

HSV: standard hexcone, V = max, S = (max-min)/max, H in turns normalised to
[0,1). Feature 17/18 use the *mean colour*; feature 23 uses per-pixel HSV.
"""
import numpy as np

PATCH = 16
SIDE_FRAC = 0.9


# --------------------------------------------------------------------------- #
# patch sampling
# --------------------------------------------------------------------------- #
def _bilinear_sample(flat, xs, ys):
    h, w = flat.shape[:2]
    xs = np.clip(xs, 0.0, w - 1.000001)
    ys = np.clip(ys, 0.0, h - 1.000001)
    x0 = np.floor(xs).astype(np.int64)
    y0 = np.floor(ys).astype(np.int64)
    x1 = np.minimum(x0 + 1, w - 1)
    y1 = np.minimum(y0 + 1, h - 1)
    fx = (xs - x0)[..., None]
    fy = (ys - y0)[..., None]
    f = np.asarray(flat, dtype=np.float64)
    top = f[y0, x0] * (1 - fx) + f[y0, x1] * fx
    bot = f[y1, x0] * (1 - fx) + f[y1, x1] * fx
    return top * (1 - fy) + bot * fy


def extract_patch(image, cx, cy, cell, p=PATCH, frac=SIDE_FRAC):
    """16x16x3 bilinear patch of a 0.9*cell square, RGB 0..255 float32."""
    side = frac * cell
    step = side / p
    off = (np.arange(p, dtype=np.float64) + 0.5) * step - side / 2.0
    xs = np.broadcast_to(cx + off[None, :], (p, p))   # columns
    ys = np.broadcast_to(cy + off[:, None], (p, p))   # rows
    patch = _bilinear_sample(image, xs, ys)
    return patch.astype(np.float32)


_HEX_CACHE = {}


def _inside_hex_mask(h, w, n):
    key = (h, w, n)
    if key not in _HEX_CACHE:
        from geometry import canonical_corners
        ys, xs = np.mgrid[0:h, 0:w]
        corners = canonical_corners(n, w=w, pad=0.07 * w)
        inside = np.zeros((h, w), dtype=bool)
        j = len(corners) - 1
        for i in range(len(corners)):
            xi, yi = corners[i]
            xj, yj = corners[j]
            cond = ((yi > ys) != (yj > ys)) & (
                xs < (xj - xi) * (ys - yi) / (yj - yi + 1e-12) + xi
            )
            inside ^= cond
            j = i
        _HEX_CACHE[key] = inside
    return _HEX_CACHE[key]


def median_baseline(image, n):
    """Per-channel median of canonical pixels inside the point hexagon."""
    h, w = image.shape[:2]
    inside = _inside_hex_mask(h, w, n)
    pix = np.asarray(image)[inside].reshape(-1, 3)
    return np.median(pix, axis=0).astype(np.float64)


# --------------------------------------------------------------------------- #
# features
# --------------------------------------------------------------------------- #
def _std(a):
    a = np.asarray(a, dtype=np.float64)
    return float(np.sqrt(np.mean((a - a.mean()) ** 2)))


def _hsv(r, g, b):
    mx = max(r, g, b)
    mn = min(r, g, b)
    delta = mx - mn
    v = mx
    s = 0.0 if mx <= 0.0 else delta / mx
    if delta <= 0.0:
        hh = 0.0
    elif mx == r:
        hh = ((g - b) / delta) % 6.0
    elif mx == g:
        hh = (b - r) / delta + 2.0
    else:
        hh = (r - g) / delta + 4.0
    return ((hh / 6.0) % 1.0), s, v


def _bilinear_px(p, x, y):
    """Bilinear sample of a 16x16 patch at continuous pixel coords (x=col,y=row)."""
    x = min(max(x, 0.0), p.shape[1] - 1.000001)
    y = min(max(y, 0.0), p.shape[0] - 1.000001)
    x0 = int(np.floor(x))
    y0 = int(np.floor(y))
    x1 = min(x0 + 1, p.shape[1] - 1)
    y1 = min(y0 + 1, p.shape[0] - 1)
    fx = x - x0
    fy = y - y0
    top = p[y0, x0] * (1 - fx) + p[y0, x1] * fx
    bot = p[y1, x0] * (1 - fx) + p[y1, x1] * fx
    return top * (1 - fy) + bot * fy


def extract_features(patch, baseline):
    """28-D feature vector. patch: 16x16x3 (or flat 768) RGB 0..255; baseline: RGB 0..255."""
    p = np.asarray(patch, dtype=np.float64).reshape(PATCH, PATCH, 3) / 255.0
    B = np.asarray(baseline, dtype=np.float64).reshape(3)
    f = np.zeros(28, dtype=np.float64)
    flat_rgb = p.reshape(-1, 3)

    # 0-14: per-channel mean, std, p10, p50, p90
    for c in range(3):
        v = flat_rgb[:, c]
        vs = np.sort(v)
        b = c * 5
        f[b + 0] = v.mean()
        f[b + 1] = _std(v)
        f[b + 2] = vs[int(np.floor((len(vs) - 1) * 0.1))]
        f[b + 3] = vs[int(np.floor((len(vs) - 1) * 0.5))]
        f[b + 4] = vs[int(np.floor((len(vs) - 1) * 0.9))]

    # 15-18: HSV of the mean colour
    mr, mg, mb = flat_rgb.mean(axis=0)
    hh, s, v = _hsv(mr, mg, mb)
    f[15] = np.cos(2.0 * np.pi * hh)
    f[16] = np.sin(2.0 * np.pi * hh)
    f[17] = s
    f[18] = v

    # 19-21: ring mean - centre 8x8 mean
    ii, jj = np.mgrid[0:PATCH, 0:PATCH]
    ring_mask = (ii < 2) | (ii >= 14) | (jj < 2) | (jj >= 14)
    ring_mean = p[ring_mask].mean(axis=0)
    center_mean = p[4:12, 4:12].reshape(-1, 3).mean(axis=0)
    f[19:22] = ring_mean - center_mean

    # 22: std of V at 8 points on a radius-6 circle
    vals = np.zeros(8)
    for k in range(8):
        ang = k * np.pi / 4.0
        x = 7.5 + 6.0 * np.cos(ang)
        y = 7.5 + 6.0 * np.sin(ang)
        rgb = _bilinear_px(p, x, y)
        vals[k] = rgb.max()
    f[22] = _std(vals)

    # 23: highlight rate
    per_v = flat_rgb.max(axis=1)
    per_s = np.where(per_v > 0.0, (per_v - flat_rgb.min(axis=1)) / np.maximum(per_v, 1e-12), 0.0)
    f[23] = float(np.mean((per_v > 0.92) & (per_s < 0.25)))

    # 24-26: patch mean colour relative to the baseline colour
    Bc = np.maximum(B, 1.0)
    f[24:27] = flat_rgb.mean(axis=0) * 255.0 / Bc - 1.0

    # 27: mean luminance centre-difference gradient magnitude
    L = 0.299 * p[:, :, 0] + 0.587 * p[:, :, 1] + 0.114 * p[:, :, 2]
    gx = (L[1:15, 2:16] - L[1:15, 0:14]) / 2.0
    gy = (L[2:16, 1:15] - L[0:14, 1:15]) / 2.0
    f[27] = float(np.sqrt(gx * gx + gy * gy).mean())

    return f.astype(np.float32)


def extract(image, cx, cy, cell, baseline):
    return extract_features(extract_patch(image, cx, cy, cell), baseline)


# --------------------------------------------------------------------------- #
# batched versions (training speed). Must agree with the single versions.
# --------------------------------------------------------------------------- #
def extract_patches(image, cxs, cys, cell, p=PATCH, frac=SIDE_FRAC):
    """(N,16,16,3) float32 patches for N centres (vectorised bilinear)."""
    cxs = np.asarray(cxs, dtype=np.float64).reshape(-1)
    cys = np.asarray(cys, dtype=np.float64).reshape(-1)
    n = cxs.shape[0]
    side = frac * cell
    step = side / p
    off = (np.arange(p, dtype=np.float64) + 0.5) * step - side / 2.0
    xs = cxs[:, None] + off[None, :]          # (N,p) columns
    ys = cys[:, None] + off[None, :]          # (N,p) rows
    xs = np.broadcast_to(xs[:, None, :], (n, p, p))   # (N,row,col)
    ys = np.broadcast_to(ys[:, :, None], (n, p, p))
    h, w = image.shape[:2]
    xs = np.clip(xs, 0.0, w - 1.000001)
    ys = np.clip(ys, 0.0, h - 1.000001)
    x0 = np.floor(xs).astype(np.int64)
    y0 = np.floor(ys).astype(np.int64)
    x1 = np.minimum(x0 + 1, w - 1)
    y1 = np.minimum(y0 + 1, h - 1)
    fx = (xs - x0)[..., None]
    fy = (ys - y0)[..., None]
    f = np.asarray(image, dtype=np.float64)
    top = f[y0, x0] * (1 - fx) + f[y0, x1] * fx
    bot = f[y1, x0] * (1 - fx) + f[y1, x1] * fx
    return (top * (1 - fy) + bot * fy).astype(np.float32)


def extract_features_batch(patches, baseline):
    """(N,16,16,3) or (N,768) RGB 0..255 -> (N,28) float32."""
    p = np.asarray(patches, dtype=np.float64).reshape(-1, PATCH, PATCH, 3) / 255.0
    nb = p.shape[0]
    f = np.zeros((nb, 28), dtype=np.float64)
    flat_rgb = p.reshape(nb, PATCH * PATCH, 3)

    # 0-14
    srt = np.sort(flat_rgb, axis=1)  # (N,256,3)
    mean = flat_rgb.mean(axis=1)
    std = flat_rgb.std(axis=1)
    for c in range(3):
        b = c * 5
        f[:, b + 0] = mean[:, c]
        f[:, b + 1] = std[:, c]
        f[:, b + 2] = srt[:, int(np.floor(255 * 0.1)), c]
        f[:, b + 3] = srt[:, int(np.floor(255 * 0.5)), c]
        f[:, b + 4] = srt[:, int(np.floor(255 * 0.9)), c]

    # 15-18: HSV of the mean colour (vectorised, same branch logic as _hsv)
    mr, mg, mb = mean[:, 0], mean[:, 1], mean[:, 2]
    mx = np.max(mean, axis=1)
    mn = np.min(mean, axis=1)
    delta = mx - mn
    v = mx
    s = np.where(mx > 0.0, delta / np.maximum(mx, 1e-300), 0.0)
    hh = np.zeros(nb)
    dr = mx == mr
    dg = (mx == mg) & ~dr
    db = ~(dr | dg)
    hh = np.where(dr, ((mg - mb) / np.maximum(delta, 1e-300)) % 6.0, hh)
    hh = np.where(dg, (mb - mr) / np.maximum(delta, 1e-300) + 2.0, hh)
    hh = np.where(db, (mr - mg) / np.maximum(delta, 1e-300) + 4.0, hh)
    hh = np.where(delta <= 0.0, 0.0, hh)
    hh = (hh / 6.0) % 1.0
    f[:, 15] = np.cos(2.0 * np.pi * hh)
    f[:, 16] = np.sin(2.0 * np.pi * hh)
    f[:, 17] = s
    f[:, 18] = v

    # 19-21
    ii, jj = np.mgrid[0:PATCH, 0:PATCH]
    ring_mask = ((ii < 2) | (ii >= 14) | (jj < 2) | (jj >= 14)).reshape(-1)
    center_mask = np.zeros((PATCH, PATCH), dtype=bool)
    center_mask[4:12, 4:12] = True
    center_mask = center_mask.reshape(-1)
    ring_mean = flat_rgb[:, ring_mask, :].mean(axis=1)
    center_mean = flat_rgb[:, center_mask, :].mean(axis=1)
    f[:, 19:22] = ring_mean - center_mean

    # 22: std of V at 8 points on a radius-6 circle
    dists = np.array([7.5 + 6.0 * np.cos(k * np.pi / 4.0) for k in range(8)])
    dists_y = np.array([7.5 + 6.0 * np.sin(k * np.pi / 4.0) for k in range(8)])
    smp = np.zeros((nb, 8, 3))
    for k in range(8):
        smp[:, k, :] = _bilinear_patch_batch(p, dists[k], dists_y[k])
    vv = smp.max(axis=2)
    f[:, 22] = vv.std(axis=1)

    # 23
    per_v = flat_rgb.max(axis=2)
    per_s = np.where(per_v > 0.0,
                     (per_v - flat_rgb.min(axis=2)) / np.maximum(per_v, 1e-300), 0.0)
    f[:, 23] = np.mean((per_v > 0.92) & (per_s < 0.25), axis=1)

    # 24-26
    Bc = np.maximum(np.asarray(baseline, dtype=np.float64).reshape(3), 1.0)
    f[:, 24:27] = mean * 255.0 / Bc[None, :] - 1.0

    # 27
    L = 0.299 * p[:, :, :, 0] + 0.587 * p[:, :, :, 1] + 0.114 * p[:, :, :, 2]
    gx = (L[:, 1:15, 2:16] - L[:, 1:15, 0:14]) / 2.0
    gy = (L[:, 2:16, 1:15] - L[:, 0:14, 1:15]) / 2.0
    f[:, 27] = np.sqrt(gx * gx + gy * gy).mean(axis=(1, 2))
    return f.astype(np.float32)


def _bilinear_patch_batch(p, x, y):
    """p (N,16,16,3), x/y scalars -> (N,3) bilinear samples."""
    n = p.shape[0]
    x = min(max(float(x), 0.0), PATCH - 1.000001)
    y = min(max(float(y), 0.0), PATCH - 1.000001)
    x0 = int(np.floor(x))
    y0 = int(np.floor(y))
    x1 = min(x0 + 1, PATCH - 1)
    y1 = min(y0 + 1, PATCH - 1)
    fx = x - x0
    fy = y - y0
    top = p[:, y0, x0] * (1 - fx) + p[:, y0, x1] * fx
    bot = p[:, y1, x0] * (1 - fx) + p[:, y1, x1] * fx
    return top * (1 - fy) + bot * fy
