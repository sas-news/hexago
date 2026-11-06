"""Canonical geometry for the HEXAGO photo pipeline (CONTRACT.md §0-2).

Pure numpy/opencv. Mirrors js/photo/geometry.js (Lead) for Python-side training
and evaluation.
"""
import numpy as np

W = 1024
PAD = 0.07 * W  # 71.68


def side_of(n):
    return (n + 1) // 2


def s_of(n):
    return side_of(n) - 1


def cell_of(n):
    """Canonical cell size for board size n."""
    s = s_of(n)
    return (W - 2.0 * PAD) / (2.0 * s)


def build(n):
    """Point list in app `build(n)` order: [(q, r), ...]."""
    s = s_of(n)
    out = []
    for r in range(-s, s + 1):
        for q in range(-s, s + 1):
            if abs(q + r) <= s:
                out.append((q, r))
    return out


def point_xy(q, r, n, w=W, pad=PAD):
    s = s_of(n)
    cell = (w - 2.0 * pad) / (2.0 * s)
    x = w / 2.0 + cell * (q + r / 2.0)
    y = w / 2.0 + cell * (r * 0.8660254037844386)
    return x, y


def canonical_corners(n, w=W, pad=PAD):
    """6 lattice corners in canonical coords (CONTRACT §1)."""
    s = s_of(n)
    corner_qr = [(s, 0), (0, s), (-s, s), (-s, 0), (0, -s), (s, -s)]
    return np.array([point_xy(q, r, n, w, pad) for q, r in corner_qr], np.float64)


def homography_dlt(src, dst):
    """Least-squares homography mapping src(px) -> dst(px) (12 eq / 8 unknowns)."""
    src = np.asarray(src, np.float64)
    dst = np.asarray(dst, np.float64)
    A = []
    for (x, y), (u, v) in zip(src, dst):
        A.append([x, y, 1, 0, 0, 0, -x * u, -y * u, -u])
        A.append([0, 0, 0, x, y, 1, -x * v, -y * v, -v])
    A = np.array(A, np.float64)
    _, _, Vt = np.linalg.svd(A)
    h = Vt[-1]
    return (h / h[8]).reshape(3, 3)


def apply_h(H, pts):
    pts = np.asarray(pts, np.float64).reshape(-1, 2)
    ones = np.ones((pts.shape[0], 1))
    p = np.hstack([pts, ones]) @ H.T
    return p[:, :2] / p[:, 2:3]


def canonicalize(img_rgb, lattice_corners_px, n, out_w=W):
    """Warp a photo (HxWx3 uint8/float) into the canonical 1024x1024 frame.

    Returns float32 canonical image (0..255).
    """
    import cv2
    src = np.asarray(lattice_corners_px, np.float64)
    dst = canonical_corners(n, out_w)
    Hm = homography_dlt(src, dst)
    img = np.asarray(img_rgb)
    if img.dtype != np.float32:
        img = img.astype(np.float32)
    out = cv2.warpPerspective(img, Hm, (out_w, out_w),
                              flags=cv2.INTER_LINEAR,
                              borderMode=cv2.BORDER_REPLICATE)
    return out.astype(np.float32), Hm
