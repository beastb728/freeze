"""Estimates how far apart the cameras were and how deep the scene is.

The viewer models the rig as cameras on an arc, all aimed at one pivot (the subject). Under
that model, camera i's depth mesh rotated by the gap angle should land on camera i+1's photo.
This searches for the gap per neighbouring pair, and a depth range per camera, that make
those re-projections agree best. The maths mirrors the vertex shader in public/viewer.js.

Run alone to inspect a capture:  python worker/calibrate.py data/<session>/<capture>
"""
import json
import math
import os
import sys

import numpy as np
from PIL import Image

LONG_SIDE_TAN = math.tan(math.radians(31))  # keep in step with viewer.js
SMALL = 144  # long side of the images compared
COARSE_GAPS_DEG = np.arange(3.0, 42.1, 3.0)
FINE_STEPS_DEG = (-2.0, -1.0, 0.0, 1.0, 2.0)
RANGES = (1.6, 2.2, 3.0, 4.0, 6.0, 9.0, 15.0, 30.0, 80.0)
# The cameras orbit a point inside the subject, a little behind the surface the depth map sees.
PIVOT_SCALES = (0.9, 1.0, 1.1, 1.2, 1.32, 1.45)
DEFAULT_GAP_DEG, DEFAULT_RANGE, DEFAULT_PIVOT_SCALE = 15.0, 5.0, 1.1
MIN_GAIN = 0.12  # the fit must beat "no rotation" by this fraction to be trusted


def _load(photo_path, depth_path):
    photo = Image.open(photo_path).convert("RGB")
    scale = SMALL / max(photo.size)
    size = (max(8, round(photo.size[0] * scale)), max(8, round(photo.size[1] * scale)))
    rgb = np.asarray(photo.resize(size, Image.BILINEAR), dtype=np.float32) / 255.0
    d = np.asarray(Image.open(depth_path).convert("L").resize(size, Image.BILINEAR), dtype=np.float32) / 255.0
    w, h = size
    tx, ty = (LONG_SIDE_TAN, LONG_SIDE_TAN * h / w) if w >= h else (LONG_SIDE_TAN * w / h, LONG_SIDE_TAN)
    u, v = np.meshgrid(np.linspace(-1, 1, w), np.linspace(1, -1, h))
    return {"rgb": rgb, "d": d, "tan": (tx, ty), "u": u, "v": v}


def _dist(d, rng):
    return 1.0 / (1.0 / rng + (1.0 - 1.0 / rng) * d)


def reprojection_error(src, pivot, dst, yaw, shape):
    """Mean colour difference after rotating src's mesh by yaw and viewing it as dst.

    shape is (depth range, pivot scale) for the source camera.
    """
    rng, pivot_scale = shape
    tx, ty = src["tan"]
    z = _dist(src["d"], rng)
    zp = _dist(pivot, rng) * pivot_scale
    x, y, zr = src["u"] * tx * z, src["v"] * ty * z, zp - z
    c, s = math.cos(yaw), math.sin(yaw)
    x2, z2 = c * x + s * zr, -s * x + c * zr
    w = np.maximum(zp - z2, 1e-3)
    dtx, dty = dst["tan"]
    u2, v2 = x2 / (w * dtx), y / (w * dty)
    valid = (np.abs(u2) < 1) & (np.abs(v2) < 1)
    cover = float(valid.mean())
    if cover < 0.45:
        return float("inf")
    hh, ww = dst["d"].shape
    px = np.clip(np.rint((u2 + 1) / 2 * (ww - 1)).astype(int), 0, ww - 1)
    py = np.clip(np.rint((1 - v2) / 2 * (hh - 1)).astype(int), 0, hh - 1)
    diff = np.abs(dst["rgb"][py, px] - src["rgb"]).mean(axis=-1)
    return float(diff[valid].mean()) + 0.05 * (1.0 - cover)


def calibrate(views, pivots):
    """views: output of _load per camera, left to right.

    Returns the gap angle per neighbouring pair (radians) and a depth range and pivot scale
    per camera.
    """
    n = len(views)
    default = {
        "gaps": [round(math.radians(DEFAULT_GAP_DEG), 4)] * max(0, n - 1),
        "ranges": [DEFAULT_RANGE] * n,
        "pivotScales": [DEFAULT_PIVOT_SCALE] * n,
        "trusted": False,
    }
    if n < 2:
        return default

    def pair_error(i, gap, left, right):
        # At the far end of the gap, camera i is drawn at -gap and camera i+1 at +gap.
        return reprojection_error(views[i], pivots[i], views[i + 1], -gap, left) + reprojection_error(
            views[i + 1], pivots[i + 1], views[i], gap, right
        )

    def best_gap(i, left, right, candidates):
        errs = [pair_error(i, math.radians(g), left, right) for g in candidates]
        j = int(np.argmin(errs))
        return float(candidates[j]), errs[j]

    shapes_all = [(r, k) for r in RANGES for k in PIVOT_SCALES]

    # 1. One shape shared by every camera, best coarse gap per pair.
    best = None
    for shape in shapes_all:
        fits = [best_gap(i, shape, shape, COARSE_GAPS_DEG) for i in range(n - 1)]
        total = sum(e for _, e in fits)
        if best is None or total < best[0]:
            best = (total, shape, [g for g, _ in fits])
    _, shared, gaps_deg = best
    shapes = [shared] * n

    # 2. Each camera's depth map has its own scale, so let each pick its own shape.
    for c in range(n):
        def cost(shape):
            e = 0.0
            if c < n - 1:
                e += reprojection_error(views[c], pivots[c], views[c + 1], -math.radians(gaps_deg[c]), shape)
            if c > 0:
                e += reprojection_error(views[c], pivots[c], views[c - 1], math.radians(gaps_deg[c - 1]), shape)
            return e
        shapes[c] = min(shapes_all, key=cost)

    # 3. Refine each gap around its coarse value.
    fitted = 0.0
    for i in range(n - 1):
        gaps_deg[i], err = best_gap(i, shapes[i], shapes[i + 1], [gaps_deg[i] + step for step in FINE_STEPS_DEG])
        fitted += err

    flat = sum(pair_error(i, 0.0, shapes[i], shapes[i + 1]) for i in range(n - 1))
    gain = 1.0 - fitted / max(flat, 1e-9)
    if not math.isfinite(fitted) or gain < MIN_GAIN:
        return {**default, "gain": round(gain, 3)}
    return {
        "gaps": [round(math.radians(g), 4) for g in gaps_deg],
        "ranges": [shape[0] for shape in shapes],
        "pivotScales": [shape[1] for shape in shapes],
        "trusted": True,
        "gain": round(gain, 3),
    }


def calibrate_files(folder, photos, depths, pivots):
    views = [_load(os.path.join(folder, p), os.path.join(folder, d)) for p, d in zip(photos, depths)]
    return calibrate(views, pivots)


if __name__ == "__main__":
    folder = sys.argv[1]
    manifest = json.load(open(os.path.join(folder, "manifest.json")))
    first = [cam["frames"][0] for cam in manifest["cameras"]]
    result = calibrate_files(folder, [f["img"] for f in first], [f["depth"] for f in first], [f["pivot"] for f in first])
    print(json.dumps({**result, "gaps_deg": [round(math.degrees(g), 1) for g in result["gaps"]]}))
