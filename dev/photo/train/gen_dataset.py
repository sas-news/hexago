"""Synthetic canonical HEXAGO board generator (CONTRACT v2).

Renders 1024x1024 canonical images of hexagonal boards with stones and heavy
photographic degradations, and extracts (patch -> 28 features -> class) samples
for the MLP. Also writes the canonical / photo-style test images in
dev/photo/testdata/synth/.

Pipeline per board:
  table texture + board texture (wood/paper/dark/cyber)
  + grid lines (triangular app print | honeycomb physical | tri + outer frame)
  + stones (glossy plastic / matte, 7 colours, drop shadows)
  -> photometric degradations (WB, illumination gradient, glare, shadows,
     vignette, defocus, sensor noise, JPEG)
  -> baseline B = per-channel median inside the point hexagon
  -> fill outside the point hexagon with B (as the browser pipeline does)
  -> patch sampling + 28-D features

Only numpy / PIL / opencv are used (no network, no external assets).

CLI:
  python gen_dataset.py --stats            # render a few boards, print timing/stats
  python gen_dataset.py --test-images      # write dev/photo/testdata/synth/*
"""
import argparse
import json
import math
import os

import cv2
import numpy as np

import features as F
import geometry as G

W = 1024
SQ3 = math.sqrt(3.0)

CLASSES = ['empty', 'black', 'white', 'red', 'blue', 'green', 'yellow', 'purple']
CLASS_INDEX = {c: i for i, c in enumerate(CLASSES)}

# stone base colours (RGB, 0..255) -- tuned to look like painted wooden/plastic stones
PALETTE = {
    'black': (28, 31, 36),
    'white': (228, 234, 244),
    'red': (205, 50, 48),
    'blue': (52, 148, 210),
    'green': (55, 148, 84),
    'yellow': (235, 200, 52),
    'purple': (142, 88, 178),
}
STONE_CLASSES = ['black', 'white', 'red', 'blue', 'green', 'yellow', 'purple']

# --------------------------------------------------------------------------- #
# themes: board colour, texture kind, line colour/alpha, outside (table) kind
# --------------------------------------------------------------------------- #
THEMES = {
    'wood_tan': dict(board=(152, 126, 96), tex='wood', line=(112, 84, 56), line_a=0.40,
                     outside='table_wood', border=0.95),
    'wood_brown': dict(board=(100, 75, 63), tex='wood', line=(158, 128, 96), line_a=0.34,
                       outside='table_wood', border=0.95),
    'wood_red': dict(board=(107, 60, 45), tex='wood', line=(164, 118, 84), line_a=0.34,
                     outside='table_wood', border=0.9),
    'paper_white': dict(board=(244, 241, 232), tex='paper', line=(150, 146, 138), line_a=0.55,
                        outside='table_white', border=0.12),
    'paper_gray': dict(board=(170, 172, 176), tex='paper', line=(108, 110, 116), line_a=0.5,
                       outside='table_white', border=0.12),
    'paper_dark': dict(board=(38, 40, 45), tex='dark', line=(120, 124, 132), line_a=0.55,
                       outside='table_dark', border=0.12),
    'cyber': dict(board=(18, 38, 50), tex='cyber', line=(70, 220, 240), line_a=0.65,
                  outside='table_dark', border=0.12),
}

# lighting / degradation profiles.  Ranges are sampled per board.
LIGHTING = {
    'ambient': dict(gain=(0.85, 1.15), wb=(0.94, 1.06), grad=0.12, radial=0.06,
                    glare=0.25, shadow=0.12, vignette=0.12, blur=(0.0, 0.7),
                    noise=(0.5, 3.5), jpeg=(72, 95)),
    'window_left': dict(gain=(0.72, 1.05), wb=(0.92, 1.10), grad=0.38, radial=0.12,
                        glare=0.7, shadow=0.25, vignette=0.18, blur=(0.2, 1.1),
                        noise=(1.0, 5.0), jpeg=(60, 90)),
    'window_right': dict(gain=(0.72, 1.05), wb=(0.92, 1.10), grad=0.38, radial=0.12,
                         glare=0.7, shadow=0.25, vignette=0.18, blur=(0.2, 1.1),
                         noise=(1.0, 5.0), jpeg=(60, 90)),
    'spot_strong': dict(gain=(0.65, 1.05), wb=(0.90, 1.12), grad=0.5, radial=0.2,
                        glare=1.4, shadow=0.35, vignette=0.3, blur=(0.2, 1.3),
                        noise=(1.5, 6.5), jpeg=(55, 88)),
    'low_warm': dict(gain=(0.55, 0.9), wb=(1.06, 1.22), grad=0.35, radial=0.18,
                     glare=0.5, shadow=0.45, vignette=0.42, blur=(0.4, 1.6),
                     noise=(2.0, 8.0), jpeg=(45, 80)),
    'cool_indoor': dict(gain=(0.6, 0.95), wb=(0.80, 0.94), grad=0.3, radial=0.15,
                        glare=0.6, shadow=0.3, vignette=0.32, blur=(0.2, 1.2),
                        noise=(1.5, 6.0), jpeg=(48, 82)),
    'harsh_shadow': dict(gain=(0.6, 1.0), wb=(0.88, 1.08), grad=0.45, radial=0.2,
                         glare=0.9, shadow=0.75, vignette=0.35, blur=(0.2, 1.2),
                         noise=(2.0, 7.0), jpeg=(45, 80)),
    'overexposed': dict(gain=(1.0, 1.35), wb=(0.94, 1.08), grad=0.25, radial=0.1,
                        glare=2.2, shadow=0.1, vignette=0.2, blur=(0.3, 1.4),
                        noise=(1.0, 5.0), jpeg=(50, 85)),
}

# scenario combos, split into train / val / test.  test/val use theme+lighting
# combos (and a stone material) that never appear in train -> unknown-scenario eval.
SCENARIO_SPLITS = {
    # every lighting profile and every theme appears in train, but only in the
    # combinations listed here; val/test use theme+lighting combinations that
    # never occur in train (unknown scenario) and the unseen 'satin' material.
    'train': [
        ('wood_tan', 'ambient'), ('wood_tan', 'window_left'),
        ('wood_tan', 'overexposed'), ('wood_brown', 'ambient'),
        ('wood_brown', 'window_left'), ('wood_brown', 'spot_strong'),
        ('wood_brown', 'harsh_shadow'), ('wood_red', 'window_left'),
        ('wood_red', 'low_warm'), ('paper_white', 'ambient'),
        ('paper_white', 'window_right'), ('paper_white', 'cool_indoor'),
        ('paper_gray', 'ambient'), ('paper_gray', 'window_left'),
        ('paper_dark', 'ambient'), ('paper_dark', 'spot_strong'),
        ('cyber', 'ambient'), ('cyber', 'cool_indoor'),
    ],
    'val': [
        ('wood_brown', 'cool_indoor'), ('paper_white', 'low_warm'),
        ('paper_dark', 'harsh_shadow'), ('wood_tan', 'window_right'),
        ('paper_gray', 'spot_strong'), ('wood_red', 'overexposed'),
    ],
    'test': [
        ('wood_red', 'cool_indoor'), ('paper_gray', 'harsh_shadow'),
        ('wood_tan', 'low_warm'), ('paper_dark', 'cool_indoor'),
        ('paper_white', 'harsh_shadow'), ('wood_brown', 'overexposed'),
        ('paper_gray', 'window_right'), ('cyber', 'low_warm'),
    ],
}
MATERIALS_TRAIN = ['glossy', 'matte']
MATERIALS_EVAL = ['glossy', 'matte', 'satin']   # satin is unseen in train


# --------------------------------------------------------------------------- #
# procedural textures
# --------------------------------------------------------------------------- #
def _noise(rng, h, w, gh, gw, interp=cv2.INTER_CUBIC):
    g = rng.random((max(2, gh), max(2, gw))).astype(np.float32)
    return cv2.resize(g, (w, h), interpolation=interp)


def _fbm(rng, h, w, octaves=4, base=4, persistence=0.55):
    out = np.zeros((h, w), np.float32)
    amp = 1.0
    tot = 0.0
    gh, gw = base, base
    for _ in range(octaves):
        out += amp * _noise(rng, h, w, gh, gw)
        tot += amp
        amp *= persistence
        gh *= 2
        gw *= 2
    return out / tot


def make_texture(kind, rng, size=512):
    """Return a float32 (size,size) shade field, mean ~1.0."""
    h = w = size
    if kind == 'wood':
        # streaky grain: high frequency across y, low across x
        streaks = _noise(rng, h, w, h // 6, 6, cv2.INTER_LINEAR)
        streaks = cv2.resize(streaks, (w, h), interpolation=cv2.INTER_CUBIC)
        fine = _noise(rng, h, w, h // 3, 96, cv2.INTER_LINEAR)
        low = _fbm(rng, h, w, octaves=3, base=4)
        yy, xx = np.mgrid[0:h, 0:w].astype(np.float32) / h
        warp = 1.3 * low
        rings = 0.5 + 0.5 * np.sin((xx * 7.0 + yy * 1.2 + warp) * 2.0 * np.pi)
        tex = 0.80 + 0.14 * streaks + 0.06 * fine + 0.10 * (rings - 0.5)
        tex = cv2.GaussianBlur(tex.astype(np.float32), (0, 0), 0.8)
    elif kind == 'paper':
        low = _fbm(rng, h, w, octaves=4, base=6)
        fiber = _noise(rng, h, w, h // 2, w // 2, cv2.INTER_LINEAR)
        fiber2 = _noise(rng, h, w, 8, w // 2, cv2.INTER_LINEAR)
        tex = 0.96 + 0.045 * (low - 0.5) + 0.035 * (fiber - 0.5) + 0.02 * (fiber2 - 0.5)
        tex = cv2.GaussianBlur(tex.astype(np.float32), (0, 0), 0.6)
    elif kind == 'dark':
        low = _fbm(rng, h, w, octaves=4, base=5)
        speck = _noise(rng, h, w, h // 2, w // 2, cv2.INTER_LINEAR)
        tex = 0.92 + 0.12 * (low - 0.5) + 0.10 * (speck - 0.5)
        tex = cv2.GaussianBlur(tex.astype(np.float32), (0, 0), 0.7)
    elif kind == 'cyber':
        low = _fbm(rng, h, w, octaves=3, base=6)
        fine = _noise(rng, h, w, h // 4, w // 4, cv2.INTER_LINEAR)
        tex = 0.9 + 0.2 * (low - 0.5) + 0.08 * (fine - 0.5)
        tex = cv2.GaussianBlur(tex.astype(np.float32), (0, 0), 0.9)
    elif kind.startswith('table'):
        low = _fbm(rng, h, w, octaves=4, base=5)
        if 'wood' in kind:
            st = _noise(rng, h, w, h // 5, 8, cv2.INTER_LINEAR)
            tex = 0.85 + 0.18 * (st - 0.5) + 0.16 * (low - 0.5)
        else:
            tex = 0.92 + 0.16 * (low - 0.5)
        tex = cv2.GaussianBlur(tex.astype(np.float32), (0, 0), 1.0)
    else:
        tex = np.ones((h, w), np.float32)
    return np.clip(tex, 0.4, 1.6).astype(np.float32)


_TEX_CACHE = {}


def get_texture(kind, rng, n_var=6):
    cache = _TEX_CACHE.setdefault(kind, [])
    while len(cache) < n_var:
        cache.append(make_texture(kind, rng))
    t = cache[int(rng.integers(len(cache)))]
    return cv2.resize(t, (W, W), interpolation=cv2.INTER_LINEAR)


# --------------------------------------------------------------------------- #
# grid line masks (cached per n + style)
# --------------------------------------------------------------------------- #
_LINE_CACHE = {}


def _hexagon_polygon(n, radius_cell):
    """6 corners of a regular hexagon centred at the canonical centre."""
    cx = cy = W / 2.0
    pts = []
    for k in range(6):
        ang = k * math.pi / 3.0
        pts.append([cx + radius_cell * math.cos(ang), cy + radius_cell * math.sin(ang)])
    return np.array(pts, np.float32)


def line_mask(n, style):
    key = (n, style)
    if key in _LINE_CACHE:
        return _LINE_CACHE[key]
    mask = np.zeros((W, W), np.uint8)
    s = G.s_of(n)
    cell = G.cell_of(n)
    th = max(1, int(round(2.0 * cell / 73.4)))
    pts = G.build(n)
    pset = set(pts)
    if style in ('tri', 'tri_border'):
        # triangular lattice: connect each point to 3 "forward" neighbours
        dirs = [(1, 0), (0, 1), (-1, 1)]
        for q, r in pts:
            x1, y1 = G.point_xy(q, r, n)
            for dq, dr in dirs:
                if (q + dq, r + dr) in pset:
                    x2, y2 = G.point_xy(q + dq, r + dr, n)
                    cv2.line(mask, (int(round(x1)), int(round(y1))),
                             (int(round(x2)), int(round(y2))), 255, th, cv2.LINE_8)
        # outer frame hexagon through the lattice corners
        hexpoly = _hexagon_polygon(n, cell * s)
        cv2.polylines(mask, [np.round(hexpoly).astype(np.int32)], True, 255, th, cv2.LINE_8)
    if style == 'honey':
        # hexagonal cells around every point (circumradius cell/sqrt(3))
        rad = cell / SQ3
        for q, r in pts:
            x, y = G.point_xy(q, r, n)
            poly = []
            for k in range(6):
                ang = math.pi / 6.0 + k * math.pi / 3.0
                poly.append([x + rad * math.cos(ang), y + rad * math.sin(ang)])
            cv2.polylines(mask, [np.round(np.array(poly)).astype(np.int32)], True, 255,
                          max(1, th - 1), cv2.LINE_8)
        # outer border hexagon at cell centres hexagon + cell/sqrt(3)
        hexpoly = _hexagon_polygon(n, cell * (s + 1.0 / SQ3))
        cv2.polylines(mask, [np.round(hexpoly).astype(np.int32)], True, 255, th, cv2.LINE_8)
    if style == 'tri_border':
        # real-board look: triangular grid + outer border ~1 cell outside the corners
        hexpoly = _hexagon_polygon(n, cell * (s + 0.95))
        cv2.polylines(mask, [np.round(hexpoly).astype(np.int32)], True, 255, th, cv2.LINE_8)
    mask = cv2.GaussianBlur(mask.astype(np.float32), (0, 0), 0.65)
    _LINE_CACHE[key] = mask
    return mask


def _line_style_for_theme(theme, rng):
    if theme.startswith('wood'):
        return 'tri' if rng.random() < 0.55 else 'honey'
    if theme == 'cyber':
        return 'tri'
    return 'tri'


# --------------------------------------------------------------------------- #
# stones
# --------------------------------------------------------------------------- #
_STONE_CACHE = {}


def _make_stone_sprite(color, material, r):
    S = 2 * r + 4
    cy = cx = (S - 1) / 2.0
    yy, xx = np.mgrid[0:S, 0:S].astype(np.float32)
    dx = xx - cx
    dy = yy - cy
    d = np.sqrt(dx * dx + dy * dy)
    alpha = np.clip(r + 0.5 - d, 0.0, 1.0)
    zn = np.sqrt(np.clip(1.0 - (d / r) ** 2, 0.0, 1.0))
    col = np.asarray(color, np.float32)[None, None, :].repeat(S, 0).repeat(S, 1)

    # directional diffuse shading: light from upper-left
    lx, ly = -0.45, -0.55
    nz = zn
    ndotl = np.clip((-dx / max(r, 1e-5)) * lx + (-dy / max(r, 1e-5)) * ly + nz * 0.8, 0, 1.6)

    if material == 'glossy':
        shade = 0.40 + 0.62 * ndotl
        col = col * shade[..., None]
        # tight specular streak (elongated vertically, like the real plastic stones)
        for (hx, hy, sx, sy, amp) in [(-0.26, -0.44, 0.14, 0.24, 1.60),
                                      (-0.04, -0.26, 0.24, 0.32, 0.22)]:
            g = np.exp(-(((dx / r - hx) ** 2) / (2 * sx * sx) +
                         ((dy / r - hy) ** 2) / (2 * sy * sy)))
            col = col + (255.0 - col) * (amp * g * alpha)[..., None]
        # rim light / edge darkening
        rim = np.clip((d / r - 0.72) / 0.28, 0, 1)[..., None]
        col = col * (1.0 - 0.30 * rim)
    elif material == 'satin':
        shade = 0.62 + 0.42 * ndotl
        col = col * shade[..., None]
        g = np.exp(-(((dx / r + 0.18) ** 2) / (2 * 0.5 * 0.5) +
                     ((dy / r + 0.30) ** 2) / (2 * 0.35 * 0.35)))
        col = col + (255.0 - col) * (0.28 * g * alpha)[..., None]
        rim = np.clip((d / r - 0.75) / 0.25, 0, 1)[..., None]
        col = col * (1.0 - 0.16 * rim)
    else:  # matte (paper / wood / unpolished)
        shade = 0.72 + 0.30 * ndotl
        col = col * shade[..., None]
        noise = np.random.default_rng(int(r * 1000) % 100000).normal(0, 4.0, (S, S, 1))
        col = col + noise
        rim = np.clip((d / r - 0.78) / 0.22, 0, 1)[..., None]
        col = col * (1.0 - 0.12 * rim)
    return np.clip(col, 0, 255).astype(np.float32), alpha.astype(np.float32)


def stone_sprite(cls, material, r):
    key = (cls, material, int(r))
    if key not in _STONE_CACHE:
        _STONE_CACHE[key] = _make_stone_sprite(PALETTE[cls], material, int(r))
    return _STONE_CACHE[key]


_SHADOW_CACHE = {}


def shadow_sprite(r):
    key = int(r)
    if key not in _SHADOW_CACHE:
        sigma = max(0.8, 0.22 * r)
        R = 1.15 * r
        S = int(2 * (R + 3 * sigma) + 6)
        yy, xx = np.mgrid[0:S, 0:S].astype(np.float32)
        c = (S - 1) / 2.0
        d = np.sqrt((xx - c - 0.08 * r) ** 2 + (yy - c - 0.20 * r) ** 2)
        a = np.clip(R - d, 0, 1.0) ** 0.7
        a = cv2.GaussianBlur(a.astype(np.float32), (0, 0), sigma)
        _SHADOW_CACHE[key] = np.clip(a * 0.5, 0, 1)
    return _SHADOW_CACHE[key]


def composite(img, rgb, alpha, cx, cy):
    """Alpha-composite a sprite centred at (cx,cy) onto img (in place)."""
    sh, sw = alpha.shape
    x0 = int(round(cx - (sw - 1) / 2.0))
    y0 = int(round(cy - (sh - 1) / 2.0))
    x1, y1 = x0 + sw, y0 + sh
    ix0, iy0 = max(0, x0), max(0, y0)
    ix1, iy1 = min(W, x1), min(W, y1)
    if ix1 <= ix0 or iy1 <= iy0:
        return
    sx0, sy0 = ix0 - x0, iy0 - y0
    a = alpha[sy0:sy0 + (iy1 - iy0), sx0:sx0 + (ix1 - ix0)][..., None]
    rgb_c = rgb[sy0:sy0 + (iy1 - iy0), sx0:sx0 + (ix1 - ix0)]
    region = img[iy0:iy1, ix0:ix1]
    region *= (1.0 - a)
    region += rgb_c * a


# --------------------------------------------------------------------------- #
# board rendering
# --------------------------------------------------------------------------- #
_COORD_CACHE = {}


def _norm_coords():
    if 'xx' not in _COORD_CACHE:
        yy, xx = np.mgrid[0:W, 0:W].astype(np.float32)
        _COORD_CACHE['xx'] = xx / (W - 1)
        _COORD_CACHE['yy'] = yy / (W - 1)
        _COORD_CACHE['r2'] = ((xx / (W - 1)) - 0.5) ** 2 + ((yy / (W - 1)) - 0.5) ** 2
    return _COORD_CACHE['xx'], _COORD_CACHE['yy'], _COORD_CACHE['r2']


_SM = 192  # resolution used for smooth multiplicative/additive light fields


def _smooth_grid():
    if 'gx' not in _COORD_CACHE:
        yy, xx = np.mgrid[0:_SM, 0:_SM].astype(np.float32)
        _COORD_CACHE['gx'] = xx / (_SM - 1)
        _COORD_CACHE['gy'] = yy / (_SM - 1)
        _COORD_CACHE['gr2'] = ((xx / (_SM - 1)) - 0.5) ** 2 + ((yy / (_SM - 1)) - 0.5) ** 2
        _COORD_CACHE['gflat'] = np.ones((_SM, _SM), np.float32)
    return _COORD_CACHE['gx'], _COORD_CACHE['gy'], _COORD_CACHE['gr2']


def _up(field):
    """Upsample a smooth (_SM,_SM[,3]) field to 1024x1024."""
    return cv2.resize(field, (W, W), interpolation=cv2.INTER_LINEAR)


def _hexagon_mask(n, radius_cell):
    poly = _hexagon_polygon(n, radius_cell)
    mask = np.zeros((W, W), np.uint8)
    cv2.fillPoly(mask, [np.round(poly).astype(np.int32)], 255, cv2.LINE_AA)
    return mask.astype(np.float32) / 255.0


def _board_polygon(n, border_cells, jitter, rng):
    """Board (paper/wood) hexagon, slightly irregular, offset outside lattice corners."""
    s = G.s_of(n)
    cell = G.cell_of(n)
    pts = []
    for k in range(6):
        ang = k * math.pi / 3.0 + rng.normal(0, 0.004)
        rad = (s + border_cells) * cell * (1.0 + rng.normal(0, 0.006))
        pts.append([W / 2.0 + rad * math.cos(ang), W / 2.0 + rad * math.sin(ang)])
    return np.array(pts, np.float32)


def render_board(n, labels, cfg, rng, ret_meta=False):
    """Render one canonical scene (board + stones + degradations), 1024x1024 float32."""
    theme = THEMES[cfg['theme']]
    style = cfg['style']
    ox, oy, r2 = _norm_coords()

    # ---------------- table / surrounding ----------------
    table_kind = theme['outside']
    table_col = (196, 176, 150)
    if table_kind == 'table_dark':
        table_col = (52, 50, 48)
    elif table_kind == 'table_white':
        table_col = (222, 218, 208)
    table_col = np.asarray(table_col, np.float32) * rng.uniform(0.85, 1.12)
    tex = get_texture(table_kind, rng)
    img = np.clip(table_col[None, None, :] * tex[..., None], 0, 255).astype(np.float32)

    # ---------------- board surface ----------------
    border_cells = theme['border'] * rng.uniform(0.92, 1.08)
    poly = _board_polygon(n, border_cells, 0.0, rng)
    bmask = np.zeros((W, W), np.uint8)
    cv2.fillPoly(bmask, [np.round(poly).astype(np.int32)], 255, cv2.LINE_AA)
    bmask = cv2.GaussianBlur(bmask.astype(np.float32) / 255.0, (0, 0), 0.7)
    bmask = np.clip(bmask, 0, 1)[..., None]

    board_col = np.asarray(theme['board'], np.float32) * rng.uniform(0.88, 1.10)
    board_col = board_col * rng.uniform(0.96, 1.04, 3)
    btex = get_texture(theme['tex'], rng)
    board = np.clip(board_col[None, None, :] * btex[..., None], 0, 255)

    # grid lines
    lmask = line_mask(n, style)
    lmask = lmask * rng.uniform(0.75, 1.25)
    lcol = np.asarray(theme['line'], np.float32) * rng.uniform(0.85, 1.15, 3)
    la = np.clip(lmask * theme['line_a'] * rng.uniform(0.8, 1.25), 0, 1)[..., None]
    board = board * (1.0 - la) + lcol[None, None, :] * la

    # optional app-style star dots on some points
    if style.startswith('tri') and rng.random() < 0.6:
        pass
    # board edge slightly darker (cut wood / printed border)
    img = img * (1.0 - bmask) + board * bmask

    # ---------------- stones ----------------
    cell = G.cell_of(n)
    r = int(round(cell * rng.uniform(0.415, 0.445)))
    material = cfg['material']
    for i, lab in enumerate(labels):
        if lab == 'empty':
            continue
        q, r_ = G.build(n)[i]
        x, y = G.point_xy(q, r_, n)
        x += rng.normal(0, 0.006 * cell)
        y += rng.normal(0, 0.006 * cell)
        # colour jitter
        base = np.asarray(PALETTE[lab], np.float32) * rng.uniform(0.94, 1.06, 3)
        rgb, alpha = stone_sprite(lab, material, r)
        tint = np.clip(base / np.maximum(np.asarray(PALETTE[lab], np.float32), 1.0), 0.75, 1.3)
        rgb = np.clip(rgb * tint[None, None, :], 0, 255)
        sh = shadow_sprite(r)
        composite(img, np.full((sh.shape[0], sh.shape[1], 3), 12.0, np.float32), sh * 0.9,
                  x - 0.02 * r, y - 0.06 * r)
        composite(img, rgb, alpha, x, y)

    # ---------------- photometric degradations ----------------
    img = _degrade(img, cfg['lighting'], rng)
    if ret_meta:
        return img, {'board_poly': poly, 'border_cells': border_cells,
                     'line_style': style, 'stone_r': r}
    return img


def _sample_lighting(profile, rng):
    p = LIGHTING[profile]
    out = dict(profile=profile)
    out['gain'] = rng.uniform(*p['gain'])
    out['wb'] = rng.uniform(*p['wb'], 3)
    out['grad'] = rng.uniform(0.0, p['grad'])
    out['radial'] = rng.uniform(-p['radial'] * 0.5, p['radial'])
    out['glare'] = rng.uniform(0.0, p['glare'])
    out['shadow'] = rng.uniform(0.0, p['shadow'])
    out['vignette'] = rng.uniform(0.0, p['vignette'])
    out['blur'] = rng.uniform(*p['blur'])
    out['noise'] = rng.uniform(*p['noise'])
    out['jpeg'] = int(rng.uniform(*p['jpeg']))
    return out


def _degrade(img, light_profile, rng):
    p = _sample_lighting(light_profile, rng)
    gx, gy, gr2 = _smooth_grid()
    xx, yy, r2 = _norm_coords()
    out = img.copy()

    # --- smooth multiplicative light field (gradient * radial * shadow * vignette) ---
    ang = rng.uniform(0, 2 * math.pi)
    plane = 1.0 + p['grad'] * ((gx - 0.5) * math.cos(ang) + (gy - 0.5) * math.sin(ang)) * 2.0
    radial = 1.0 + p['radial'] * np.exp(-(gr2 / 0.18))
    field = plane * radial
    if p['shadow'] > 0.02:
        sx, sy = rng.uniform(0.1, 0.9), rng.uniform(-0.1, 1.1)
        ang2 = rng.uniform(0, 2 * math.pi)
        proj = (gx - sx) * math.cos(ang2) + (gy - sy) * math.sin(ang2)
        soft = 1.0 / (1.0 + np.exp(-proj / rng.uniform(0.06, 0.18)))
        field = field * (1.0 - p['shadow'] * soft * rng.uniform(0.6, 1.2))
    if p['vignette'] > 0.01:
        k = p['vignette']
        field = field * (1.0 - k * np.clip(gr2 / 0.42, 0, 1.4) ** 1.2)
    out = out * _up(np.clip(field, 0.25, 1.8).astype(np.float32))[..., None]

    # --- additive specular glare / window reflection ---
    n_glare = int(rng.integers(1, 4)) if p['glare'] > 0.05 else 0
    if n_glare:
        add = np.zeros((_SM, _SM, 3), np.float32)
        for _ in range(n_glare):
            gx0, gy0 = rng.uniform(0.05, 0.95), rng.uniform(0.05, 0.95)
            gs = rng.uniform(0.05, 0.22) / 1.0
            amp = p['glare'] * rng.uniform(40.0, 150.0)
            g = np.exp(-((gx - gx0) ** 2 + (gy - gy0) ** 2) / (2 * gs * gs))
            tint = np.array([1.0, rng.uniform(0.95, 1.02), rng.uniform(0.96, 1.08)], np.float32)
            add += (amp * g)[..., None] * tint[None, None, :]
        out = out + _up(add.astype(np.float32))

    # --- white balance / colour temperature + gain ---
    out = out * (np.asarray(p['wb'], np.float32)[None, None, :] * p['gain'])

    out = np.clip(out, 0, 255, out=out).astype(np.float32)

    # --- defocus ---
    if p['blur'] > 0.05:
        out = cv2.GaussianBlur(out, (0, 0), p['blur'])

    # --- sensor noise (gaussian, signal dependent) ---
    if p['noise'] > 0.1:
        n = rng.standard_normal((W, W, 3), dtype=np.float32)
        gain = np.sqrt(np.clip(out, 0, 255) / 42.0 + 0.35)
        out = out + n * (p['noise'] * gain)
    out = np.clip(out, 0, 255, out=out).astype(np.float32)

    # --- JPEG quantisation ---
    if p['jpeg'] < 98:
        ok, enc = cv2.imencode('.jpg', out.astype(np.uint8),
                               [cv2.IMWRITE_JPEG_QUALITY, int(p['jpeg'])])
        if ok:
            out = cv2.imdecode(enc, cv2.IMREAD_COLOR).astype(np.float32)
    return out

# --------------------------------------------------------------------------- #
# canonical finalisation: baseline + fill outside point hexagon
# --------------------------------------------------------------------------- #
_OUTSIDE_CACHE = {}


def outside_mask(n, poly=None):
    """True outside the given board polygon (default: point hexagon)."""
    key = (n, None if poly is None else tuple(np.round(np.asarray(poly).ravel(), 1)))
    if key not in _OUTSIDE_CACHE:
        p = G.canonical_corners(n) if poly is None else np.asarray(poly, np.float32)
        mask = np.zeros((W, W), np.uint8)
        cv2.fillPoly(mask, [np.round(p).astype(np.int32)], 255, cv2.LINE_AA)
        _OUTSIDE_CACHE[key] = mask < 128
    return _OUTSIDE_CACHE[key]


FILL_MARGIN = 0.6  # cell; matches the browser pipeline (Lead, CONTRACT v2)


def fill_polygon(n, margin=FILL_MARGIN):
    """Hexagon at radius (s+margin)*cell; everything outside it is filled with B."""
    return _hexagon_polygon(n, (G.s_of(n) + margin) * G.cell_of(n))


def finalize_canonical(img, n, board_poly=None, margin=FILL_MARGIN):
    """Compute baseline B (median inside the point hexagon) and fill everything
    outside the radius (s+margin)*cell hexagon with B, as the browser does.
    `board_poly` is accepted for backward compatibility and takes precedence."""
    B = F.median_baseline(img, n)
    out = img.copy()
    poly = board_poly if board_poly is not None else fill_polygon(n, margin)
    out[outside_mask(n, poly)] = B[None, :].astype(np.float32)
    return out, B


def extract_samples(img, n, labels, rng=None, jitter=0.0, baseline=None):
    """(patches->features, y) for one canonical image."""
    cell = G.cell_of(n)
    pts = G.build(n)
    cxs = np.array([G.point_xy(q, r, n)[0] for q, r in pts])
    cys = np.array([G.point_xy(q, r, n)[1] for q, r in pts])
    if rng is not None and jitter > 0:
        cxs = cxs + rng.normal(0, jitter * cell, len(cxs))
        cys = cys + rng.normal(0, jitter * cell, len(cys))
        sc = 1.0 + rng.normal(0, 0.01)
        cell_s = cell * sc
    else:
        cell_s = cell
    B = F.median_baseline(img, n) if baseline is None else np.asarray(baseline, np.float64)
    patches = F.extract_patches(img, cxs, cys, cell_s)
    X = F.extract_features_batch(patches, B)
    y = np.array([CLASS_INDEX[l] for l in labels], dtype=np.int64)
    return X, y, dict(baseline=B, cell=cell_s)


# --------------------------------------------------------------------------- #
# board layout sampling
# --------------------------------------------------------------------------- #
COLOR_WEIGHTS = {'black': 3.0, 'white': 3.0, 'blue': 3.0, 'red': 1.2,
                 'green': 1.2, 'yellow': 1.2, 'purple': 1.2}


def _neighbors(q, r):
    return [(q + 1, r), (q - 1, r), (q, r + 1), (q, r - 1),
            (q + 1, r - 1), (q - 1, r + 1)]


def sample_labels(n, rng, occupy=None, seed_colors=None):
    """Random but realistic board: 1-3 stone colours per board (a game uses a
    couple of player colours), random occupancy with some clustered stones."""
    pts = G.build(n)
    pset = set(pts)
    # Two regimes:
    #  * "game photo" boards (45%): 2-3 of the common player colours b/w/blue at
    #    high occupancy -- this reproduces the colour mix of real photos, where
    #    dark stones pull the red-channel median of the board down and empty
    #    patches consequently read warm/reddish after baseline normalisation.
    #  * all-colour boards: every class occurs, mixed occupancy.
    if rng.random() < 0.45:
        pool = ['black', 'white', 'blue']
        ncol = 2 if rng.random() < 0.6 else 3
        cols = list(rng.choice(pool, size=ncol, replace=False))
        occ = rng.uniform(0.58, 0.80) if occupy is None else occupy
    else:
        ncol = 1 if rng.random() < 0.08 else (2 if rng.random() < 0.72 else 3)
        keys = list(COLOR_WEIGHTS)
        w = np.array([COLOR_WEIGHTS[k] for k in keys], np.float64)
        w /= w.sum()
        cols = list(rng.choice(keys, size=ncol, replace=False, p=w))
        occ = rng.uniform(0.35, 0.72) if occupy is None else occupy
    col_w = rng.dirichlet(np.ones(ncol) * 2.5)

    # clustered placement: a few seeds whose neighbourhoods get stones
    occ_map = {}
    if rng.random() < 0.65:
        for _ in range(int(rng.integers(1, 4))):
            sq, sr = pts[int(rng.integers(len(pts)))]
            occ_map[(sq, sr)] = rng.uniform(0.85, 1.0)
            for nb in _neighbors(sq, sr):
                if nb in pset:
                    occ_map[nb] = max(occ_map.get(nb, 0.0), rng.uniform(0.6, 0.95))
    labels = []
    for q, r in pts:
        p_occ = occ_map.get((q, r), occ)
        if rng.random() < p_occ:
            labels.append(cols[int(rng.choice(ncol, p=col_w))])
        else:
            labels.append('empty')
    return labels


def sample_config(split, rng, n=None):
    combos = SCENARIO_SPLITS[split]
    theme, lighting = combos[int(rng.integers(len(combos)))]
    mats = MATERIALS_TRAIN if split == 'train' else MATERIALS_EVAL
    material = mats[int(rng.integers(len(mats)))]
    if n is None:
        n = int(rng.choice([9, 13, 19], p=[0.2, 0.55, 0.25]))
    style = _line_style_for_theme(theme, rng)
    return dict(theme=theme, lighting=lighting, material=material, n=n, style=style)


def make_board_sample(split, rng, jitter=0.03):
    cfg = sample_config(split, rng)
    n = cfg['n']
    labels = sample_labels(n, rng)
    img, rmeta = render_board(n, labels, cfg, rng, ret_meta=True)
    img, B = finalize_canonical(img, n)
    X, y, meta = extract_samples(img, n, labels, rng, jitter=jitter, baseline=B)
    meta.update(cfg)
    return X, y, meta


# --------------------------------------------------------------------------- #
# test-image generation
# --------------------------------------------------------------------------- #
def _photo_scene(img_can, n, labels, rng, cfg, board_poly=None):
    """Warp a canonical scene into a simulated photo (perspective, scene, camera fx)."""
    canvas_h, canvas_w = 1040, 1268
    table_kind = THEMES[cfg['theme']]['outside']
    tcol = np.asarray((196, 176, 150) if table_kind == 'table_wood' else
                      ((222, 218, 208) if table_kind == 'table_white' else (52, 50, 48)),
                      np.float32) * rng.uniform(0.85, 1.1)
    tex = cv2.resize(get_texture(table_kind, rng), (canvas_w, canvas_h),
                     interpolation=cv2.INTER_LINEAR)
    canvas = np.clip(tcol[None, None, :] * tex[..., None], 0, 255).astype(np.float32)

    # random projective transform: similarity + mild perspective
    sc = rng.uniform(0.80, 0.95)
    rot = math.radians(rng.uniform(-10, 10))
    tx = canvas_w / 2 + rng.uniform(-40, 40)
    ty = canvas_h / 2 + rng.uniform(-40, 40)
    persp = rng.uniform(-0.12, 0.12, 2)
    c, s_ = math.cos(rot) * sc, math.sin(rot) * sc
    H = np.array([
        [c, -s_, tx - c * W / 2 + s_ * W / 2],
        [s_, c, ty - s_ * W / 2 - c * W / 2],
        [persp[0] / W, persp[1] / W, 1.0],
    ], np.float64)
    warped = cv2.warpPerspective(img_can, H, (canvas_w, canvas_h),
                                 flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    # board-only alpha so the canvas table shows around the board (no square seam)
    if board_poly is None:
        board_poly = _hexagon_polygon(n, G.cell_of(n) * (THEMES[cfg['theme']]['border'] + G.s_of(n)))
    ones = np.zeros((W, W), np.float32)
    cv2.fillPoly(ones, [np.round(board_poly).astype(np.int32)], 1.0, cv2.LINE_AA)
    alpha = cv2.warpPerspective(ones, H, (canvas_w, canvas_h), flags=cv2.INTER_LINEAR,
                                borderMode=cv2.BORDER_CONSTANT, borderValue=0)
    alpha = np.clip(alpha, 0, 1)
    # soft drop shadow of the board on the table
    sh = cv2.GaussianBlur(np.roll(np.roll(alpha, 10, axis=0), 12, axis=1), (0, 0), 18)
    canvas = canvas * (1.0 - 0.55 * sh[..., None])
    canvas = canvas * (1 - alpha[..., None]) + warped * alpha[..., None]

    # camera-level degradations
    yy, xx = np.mgrid[0:canvas_h, 0:canvas_w].astype(np.float32)
    r2 = ((xx / canvas_w - 0.5) ** 2 + (yy / canvas_h - 0.5) ** 2)
    vig = 1.0 - rng.uniform(0.05, 0.30) * np.clip(r2 / 0.42, 0, 1.4)
    canvas = canvas * vig[..., None]
    for _ in range(int(rng.integers(1, 3))):
        gx, gy = rng.uniform(0.1, 0.9) * canvas_w, rng.uniform(0.1, 0.9) * canvas_h
        gs = rng.uniform(60, 220)
        amp = rng.uniform(30, 120)
        g = np.exp(-((xx - gx) ** 2 + (yy - gy) ** 2) / (2 * gs * gs))
        canvas = canvas + amp * g[..., None]
    canvas = np.clip(canvas, 0, 255)
    canvas = cv2.GaussianBlur(canvas, (0, 0), rng.uniform(0.5, 1.6))
    canvas = canvas + rng.normal(0, rng.uniform(1.5, 5.0), canvas.shape).astype(np.float32)
    canvas = np.clip(canvas, 0, 255)
    q = int(rng.uniform(58, 92))
    ok, enc = cv2.imencode('.jpg', canvas.astype(np.uint8), [cv2.IMWRITE_JPEG_QUALITY, q])
    canvas = cv2.imdecode(enc, cv2.IMREAD_COLOR).astype(np.float32) if ok else canvas

    corners = G.canonical_corners(n)
    corners_px = G.apply_h(H, corners)
    s_ = G.s_of(n)
    paper_cells = THEMES[cfg['theme']]['border'] + s_
    cell = G.cell_of(n)
    paper_pts = _hexagon_polygon(n, cell * paper_cells)
    paper_corners_px = G.apply_h(H, paper_pts)
    return canvas.astype(np.uint8), corners_px, paper_corners_px, q


def write_test_images(outdir, seed=12345):
    """Write the repository-sized test set: <=10 images, 512px JPEG q85, <2MB total.

    Files:
      photo_XX.jpg    simulated photo (perspective + camera degradation), GT JSON
                      with corners_px (lattice 6 corners in 512px coords)
      canon_XX.jpg    already-canonical 1024 image downscaled to 512, GT JSON with
                      labels in app point order
      manifest.json   {"images":[{file, kind, size, labels, ...}]}
    """
    os.makedirs(outdir, exist_ok=True)
    for f in os.listdir(outdir):
        if f.startswith(('canonical_', 'photo_')):
            os.remove(os.path.join(outdir, f))
    rng = np.random.default_rng(seed)
    images = []

    # ---- 4 canonical images (downscaled from 1024) ----
    canon_specs = [(9, 'paper_white', 'ambient'), (13, 'wood_brown', 'ambient'),
                   (13, 'paper_dark', 'spot_strong'), (19, 'wood_tan', 'window_left')]
    for i, (n, theme, light) in enumerate(canon_specs):
        cfg = dict(n=n, theme=theme, lighting=light,
                   material=['glossy', 'matte', 'satin'][i % 3],
                   style='tri' if theme != 'wood_tan' else 'honey')
        labels = sample_labels(n, rng)
        img, _rm = render_board(n, labels, cfg, rng, ret_meta=True)
        img, B = finalize_canonical(img, n)
        small = cv2.resize(np.clip(img, 0, 255).astype(np.uint8), (512, 512),
                           interpolation=cv2.INTER_AREA)
        name = 'canon_%02d_n%d.jpg' % (i, n)
        cv2.imwrite(os.path.join(outdir, name), cv2.cvtColor(small, cv2.COLOR_RGB2BGR),
                    [cv2.IMWRITE_JPEG_QUALITY, 85])
        entry = dict(file=name, kind='canonical', size=n,
                     labels=labels, labels_int=[CLASS_INDEX[l] for l in labels],
                     class_names=CLASSES, scale=512.0 / W,
                     baseline=[round(float(v), 1) for v in B],
                     scenario=dict(theme=theme, lighting=light, material=cfg['material'],
                                   style=cfg['style']))
        with open(os.path.join(outdir, name.replace('.jpg', '.json')), 'w') as f:
            json.dump(entry, f, indent=1)
        images.append(entry)

    # ---- 6 simulated photos (perspective) ----
    photo_specs = [('wood_brown', 'window_left', 'glossy'),
                   ('wood_tan', 'ambient', 'matte'),
                   ('paper_white', 'ambient', 'glossy'),
                   ('paper_dark', 'spot_strong', 'satin'),
                   ('wood_brown', 'low_warm', 'glossy'),
                   ('paper_gray', 'harsh_shadow', 'matte')]
    for i, (theme, light, material) in enumerate(photo_specs):
        n = 13
        cfg = dict(n=n, theme=theme, lighting=light, material=material, style='tri')
        labels = sample_labels(n, rng)
        img, _rm = render_board(n, labels, cfg, rng, ret_meta=True)
        photo, corners_px, paper_px, q = _photo_scene(img, n, labels, rng, cfg)
        h0, w0 = photo.shape[:2]
        scale = 512.0 / max(h0, w0)
        small = cv2.resize(photo, (int(round(w0 * scale)), int(round(h0 * scale))),
                           interpolation=cv2.INTER_AREA)
        name = 'photo_%02d.jpg' % i
        cv2.imwrite(os.path.join(outdir, name), cv2.cvtColor(small, cv2.COLOR_RGB2BGR),
                    [cv2.IMWRITE_JPEG_QUALITY, 85])
        entry = dict(file=name, kind='photo', size=n, labels=labels,
                     labels_int=[CLASS_INDEX[l] for l in labels], class_names=CLASSES,
                     scale=round(scale, 6),
                     corners_px=[[round(float(a) * scale, 2), round(float(b) * scale, 2)]
                                 for a, b in corners_px],
                     paper_corners_px=[[round(float(a) * scale, 2), round(float(b) * scale, 2)]
                                       for a, b in paper_px],
                     image_size=[int(small.shape[1]), int(small.shape[0])],
                     jpeg_quality=q,
                     scenario=dict(theme=theme, lighting=light, material=material, style='tri'))
        with open(os.path.join(outdir, name.replace('.jpg', '.json')), 'w') as f:
            json.dump(entry, f, indent=1)
        images.append(entry)

    manifest = dict(images=images, seed=seed, note='canonical: app point order; '
                    'photo: corners_px = lattice 6 corners in this image; '
                    'scale = canonical(1024 or photo) -> saved image factor')
    with open(os.path.join(outdir, 'manifest.json'), 'w') as f:
        json.dump(manifest, f, indent=1)
    total = sum(os.path.getsize(os.path.join(outdir, e['file'])) for e in images)
    print('wrote %d test images (%d KB total) to %s' % (len(images), total // 1024, outdir))


# --------------------------------------------------------------------------- #
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--stats', action='store_true')
    ap.add_argument('--test-images', action='store_true')
    ap.add_argument('--outdir', default=os.path.join(os.path.dirname(__file__),
                                                     '..', 'testdata', 'synth'))
    args = ap.parse_args()
    if args.stats:
        rng = np.random.default_rng(7)
        t0 = __import__('time').time()
        import time
        Xs, ys = [], []
        for i in range(20):
            t = time.time()
            X, y, meta = make_board_sample('train', rng)
            Xs.append(X)
            ys.append(y)
            if i < 5:
                print('board %d n=%d %s/%s/%s  %.0f ms  %d pts' %
                      (i, meta['n'], meta['theme'], meta['lighting'], meta['material'],
                       1000 * (time.time() - t), len(y)))
        X = np.concatenate(Xs)
        y = np.concatenate(ys)
        print('total %.1fs, %.1f ms/board, %d samples' %
              (time.time() - t0, 1000 * (time.time() - t0) / 20, len(y)))
        print('feature ranges: mean', np.round(X.mean(0), 2).tolist())
        print('class counts', np.bincount(y, minlength=8).tolist())
    if args.test_images:
        write_test_images(args.outdir)


if __name__ == '__main__':
    main()
