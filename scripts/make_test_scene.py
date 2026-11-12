"""Renders a synthetic scene from five cameras on an arc, at six instants, into test/fixtures.

Files are named c<seat>_t<instant>.jpg, seat 1 being the leftmost camera. A green ball rises
over the six instants so time scrubbing has something to show.
"""
import os

import numpy as np
from PIL import Image

W, H = 960, 720
CAMERAS, INSTANTS = 5, 6
ARC_STEP_DEG = 18.0
RADIUS, CAM_HEIGHT = 4.6, 1.3
TARGET = np.array([0.0, 0.7, 0.0])
FOV_DEG = 60.0
LIGHT = np.array([0.5, 0.9, 0.45])
LIGHT = LIGHT / np.linalg.norm(LIGHT)
OUT = os.path.join(os.path.dirname(__file__), "..", "test", "fixtures")


def spheres(t):
    """(centre, radius, base colour) for instant t in 0..1."""
    return [
        (np.array([0.0, 0.7, 0.0]), 0.7, np.array([0.85, 0.22, 0.2])),
        (np.array([-1.7, 0.45, -1.3]), 0.45, np.array([0.2, 0.4, 0.85])),
        (np.array([1.5, 0.35, 1.0]), 0.35, np.array([0.95, 0.78, 0.2])),
        (np.array([0.95, 0.3 + 1.1 * t, -0.2]), 0.25, np.array([0.2, 0.75, 0.35])),
    ]


def hit_sphere(origin, dirs, centre, radius):
    oc = origin - centre
    b = dirs @ oc if oc.ndim == 1 else np.sum(dirs * oc, axis=-1)
    c = np.sum(oc * oc, axis=-1) - radius * radius
    disc = b * b - c
    t = -b - np.sqrt(np.maximum(disc, 0.0))
    return np.where((disc > 0) & (t > 1e-3), t, np.inf)


def render(cam_index, t):
    angle = np.radians((cam_index - (CAMERAS - 1) / 2) * ARC_STEP_DEG)
    eye = np.array([RADIUS * np.sin(angle), CAM_HEIGHT, RADIUS * np.cos(angle)])
    forward = TARGET - eye
    forward /= np.linalg.norm(forward)
    right = np.cross(forward, [0.0, 1.0, 0.0])
    right /= np.linalg.norm(right)
    up = np.cross(right, forward)

    half = np.tan(np.radians(FOV_DEG) / 2)
    xs = (np.arange(W) + 0.5) / W * 2 - 1
    ys = 1 - (np.arange(H) + 0.5) / H * 2
    px, py = np.meshgrid(xs * half, ys * half * H / W)
    dirs = forward + px[..., None] * right + py[..., None] * up
    dirs /= np.linalg.norm(dirs, axis=-1, keepdims=True)

    # Sky.
    colour = np.empty((H, W, 3))
    sky = np.clip(dirs[..., 1] * 1.5 + 0.3, 0, 1)[..., None]
    colour[:] = (1 - sky) * np.array([0.78, 0.84, 0.92]) + sky * np.array([0.35, 0.55, 0.85])
    nearest = np.full((H, W), np.inf)
    normal = np.zeros((H, W, 3))

    # Floor: a checkerboard.
    tf = np.where(dirs[..., 1] < -1e-4, -eye[1] / np.minimum(dirs[..., 1], -1e-4), np.inf)
    pf = eye + dirs * np.where(np.isfinite(tf), tf, 0)[..., None]
    checker = (np.floor(pf[..., 0] * 1.25) + np.floor(pf[..., 2] * 1.25)) % 2
    floor_col = np.where(checker[..., None] > 0, [0.82, 0.8, 0.76], [0.36, 0.38, 0.42])
    on_floor = tf < nearest
    colour[on_floor] = floor_col[on_floor]
    normal[on_floor] = [0, 1, 0]
    nearest = np.minimum(nearest, tf)

    # Back wall with vertical stripes.
    tw = np.where(dirs[..., 2] < -1e-4, (-6.0 - eye[2]) / np.minimum(dirs[..., 2], -1e-4), np.inf)
    pw = eye + dirs * np.where(np.isfinite(tw), tw, 0)[..., None]
    tw = np.where((pw[..., 1] > 0) & (pw[..., 1] < 3.2), tw, np.inf)
    stripe = np.floor(pw[..., 0] * 0.9) % 2
    wall_col = np.where(stripe[..., None] > 0, [0.74, 0.62, 0.5], [0.58, 0.44, 0.36])
    on_wall = tw < nearest
    colour[on_wall] = wall_col[on_wall]
    normal[on_wall] = [0, 0, 1]
    nearest = np.minimum(nearest, tw)

    balls = spheres(t)
    for centre, radius, base in balls:
        ts = hit_sphere(eye, dirs, centre, radius)
        on = ts < nearest
        p = eye + dirs * np.where(np.isfinite(ts), ts, 0)[..., None]
        n = (p - centre) / radius
        # Bands of longitude, fixed to the world, so each camera sees a different face.
        band = np.floor((np.arctan2(n[..., 0], n[..., 2]) / np.pi + 1) * 6) % 2
        col = base * np.where(band[..., None] > 0, 1.0, 0.62)
        colour[on] = col[on]
        normal[on] = n[on]
        nearest = np.minimum(nearest, ts)

    # Lambert shading with hard shadows from the spheres.
    hit = np.isfinite(nearest)
    point = eye + dirs * np.where(hit, nearest, 0)[..., None] + normal * 1e-3
    lit = np.ones((H, W), bool)
    for centre, radius, _ in balls:
        lit &= ~np.isfinite(hit_sphere(point, LIGHT, centre, radius))
    diffuse = np.clip(normal @ LIGHT, 0, 1) * np.where(lit, 1.0, 0.25)
    shade = 0.32 + 0.78 * diffuse
    colour = np.where(hit[..., None], colour * shade[..., None], colour)
    return (np.clip(colour, 0, 1) ** (1 / 2.2) * 255 + 0.5).astype(np.uint8)


def main():
    os.makedirs(OUT, exist_ok=True)
    for cam in range(CAMERAS):
        for k in range(INSTANTS):
            Image.fromarray(render(cam, k / (INSTANTS - 1))).save(
                os.path.join(OUT, f"c{cam + 1}_t{k}.jpg"), quality=90
            )
    print(f"wrote {CAMERAS * INSTANTS} images to {os.path.normpath(OUT)}")


if __name__ == "__main__":
    main()
