"""Depth worker: reads one JSON job per line on stdin, writes progress lines on stdout.

Job:    {"id": 1, "dir": "/abs/capture", "cameras": [["c1_t0.jpg", ...], ...]}
Output: {"id": 1, "type": "frame", "cam": 0, "k": 0, "depth": "d_c1_t0.png", "pivot": 0.62}
        {"id": 1, "type": "done"}   or   {"id": 1, "type": "error", "message": "..."}

Each depth map is an 8-bit PNG of normalised inverse depth: 255 is nearest, 0 is farthest.
"""
import json
import os
import sys

MODEL = os.environ.get("FREEZE_DEPTH_MODEL", "depth-anything/Depth-Anything-V2-Small-hf")
DEPTH_LONG_SIDE = 512

PATCH = 14  # the model's ViT patch size; input sides must be multiples of it
SHORT_SIDE = 518
MEAN, STD = (0.485, 0.456, 0.406), (0.229, 0.224, 0.225)

_model = None


def emit(**msg):
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def load():
    global _model
    if _model is None:
        from transformers import AutoModelForDepthEstimation

        _model = AutoModelForDepthEstimation.from_pretrained(MODEL).eval()
    return _model


def infer(path):
    """Returns relative inverse depth as a float array at the photo's aspect ratio."""
    import numpy as np
    import torch
    from PIL import Image

    model = load()
    image = Image.open(path).convert("RGB")
    w, h = image.size
    # Preprocess by hand (resize, ImageNet normalise) so torchvision is not required.
    fit = SHORT_SIDE / min(w, h)
    tw, th = (max(PATCH, round(v * fit / PATCH) * PATCH) for v in (w, h))
    pixels = np.asarray(image.resize((tw, th), Image.BICUBIC), dtype=np.float32) / 255.0
    pixels = (pixels - np.array(MEAN, np.float32)) / np.array(STD, np.float32)
    batch = torch.from_numpy(pixels.transpose(2, 0, 1))[None]
    with torch.inference_mode():
        pred = model(pixel_values=batch).predicted_depth  # (1, th, tw)
    scale = DEPTH_LONG_SIDE / max(w, h)
    size = (max(1, round(h * scale)), max(1, round(w * scale)))
    pred = torch.nn.functional.interpolate(pred[None], size=size, mode="bicubic", align_corners=False)
    return pred[0, 0].numpy()


def run(job):
    import numpy as np
    from PIL import Image

    first = []  # (photo, depth, pivot) of each camera's first instant, for calibration
    for cam, files in enumerate(job["cameras"]):
        maps = [infer(os.path.join(job["dir"], f)) for f in files]
        # One range per camera, shared across its instants, so depth does not pulse over time.
        stacked = np.stack(maps)
        lo, hi = np.percentile(stacked, 0.5), np.percentile(stacked, 99.5)
        span = max(float(hi - lo), 1e-6)
        for k, (name, raw) in enumerate(zip(files, maps)):
            d = np.clip((raw - lo) / span, 0.0, 1.0)
            h, w = d.shape
            # The subject is whatever the crosshair was on: the middle of the frame.
            centre = d[int(h * 0.4):int(h * 0.6) + 1, int(w * 0.4):int(w * 0.6) + 1]
            out = "d_" + os.path.splitext(name)[0] + ".png"
            Image.fromarray((d * 255.0 + 0.5).astype(np.uint8)).save(os.path.join(job["dir"], out))
            pivot = round(float(np.median(centre)), 4)
            if k == 0:
                first.append((name, out, pivot))
            emit(id=job["id"], type="frame", cam=cam, k=k, depth=out, pivot=pivot)

    from calibrate import calibrate_files

    calib = calibrate_files(job["dir"], *zip(*first))
    emit(id=job["id"], type="calib", calib=calib)
    emit(id=job["id"], type="done")


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        job = json.loads(line)
        try:
            run(job)
        except Exception as exc:  # report and stay alive for the next job
            emit(id=job.get("id"), type="error", message=f"{type(exc).__name__}: {exc}")


if __name__ == "__main__":
    main()
