"""Temporal 2D -> 3D lifting with MotionBERT (DSTformer, H36M fine-tuned 'lite' checkpoint).

Input : COCO-17 keypoints in pixels + confidences for every frame of the delivery.
Output: H36M-17 3D joints (T, 17, 3) in the network's normalised camera space (x right, y down, z depth),
        x/y aligned with the (normalised) input 2D, unit = the normalisation scale.
"""
from __future__ import annotations

import threading
from functools import partial

import numpy as np
import torch
import torch.nn as nn

from .. import config
from .dstformer import DSTformer

H36M_NAMES = [
    "pelvis", "right_hip", "right_knee", "right_ankle", "left_hip", "left_knee", "left_ankle",
    "spine", "thorax", "nose", "head", "left_shoulder", "left_elbow", "left_wrist",
    "right_shoulder", "right_elbow", "right_wrist",
]
H36M_PARENTS = [-1, 0, 1, 2, 0, 4, 5, 0, 7, 8, 9, 8, 11, 12, 8, 14, 15]
H36M_LEFT = [4, 5, 6, 11, 12, 13]
H36M_RIGHT = [1, 2, 3, 14, 15, 16]
CLIP_LEN = 243

_lock = threading.Lock()
_model: nn.Module | None = None
_device: str | None = None


def coco_to_h36m(kp: np.ndarray, kc: np.ndarray) -> np.ndarray:
    """(T,17,2)+(T,17) COCO -> (T,17,3) H36M [x, y, conf]. Head-top is extrapolated from the face."""
    T = kp.shape[0]
    out = np.zeros((T, 17, 3), np.float32)

    def put(i, xy, c):
        out[:, i, :2] = xy
        out[:, i, 2] = c

    lhip, rhip, lsh, rsh = kp[:, 11], kp[:, 12], kp[:, 5], kp[:, 6]
    pelvis = (lhip + rhip) / 2
    thorax = (lsh + rsh) / 2
    c_pelvis = np.minimum(kc[:, 11], kc[:, 12])
    c_thorax = np.minimum(kc[:, 5], kc[:, 6])
    put(0, pelvis, c_pelvis)
    put(1, rhip, kc[:, 12]); put(2, kp[:, 14], kc[:, 14]); put(3, kp[:, 16], kc[:, 16])
    put(4, lhip, kc[:, 11]); put(5, kp[:, 13], kc[:, 13]); put(6, kp[:, 15], kc[:, 15])
    put(7, (pelvis + thorax) / 2, np.minimum(c_pelvis, c_thorax))
    put(8, thorax, c_thorax)
    put(9, kp[:, 0], kc[:, 0])
    # head top: above the eyes along the neck->face direction (H36M 'head' is the top of the head)
    eyes = (kp[:, 1] + kp[:, 2]) / 2
    c_eyes = np.minimum(kc[:, 1], kc[:, 2])
    ears = (kp[:, 3] + kp[:, 4]) / 2
    c_ears = np.minimum(kc[:, 3], kc[:, 4])
    face = np.where((c_eyes >= c_ears)[:, None], eyes, ears)
    c_face = np.maximum(c_eyes, c_ears)
    up = face - thorax
    head = face + 0.45 * up
    put(10, head, np.minimum(c_face, c_thorax))
    put(11, lsh, kc[:, 5]); put(12, kp[:, 7], kc[:, 7]); put(13, kp[:, 9], kc[:, 9])
    put(14, rsh, kc[:, 6]); put(15, kp[:, 8], kc[:, 8]); put(16, kp[:, 10], kc[:, 10])
    return out


def _load() -> tuple[nn.Module, str]:
    global _model, _device
    with _lock:
        if _model is None:
            w = config.MOTIONBERT_WEIGHTS
            if not w.exists():
                raise FileNotFoundError(f"Missing MotionBERT checkpoint {w}. Run `python -m tools.download_models`.")
            model = DSTformer(dim_in=3, dim_out=3, dim_feat=256, dim_rep=512, depth=5, num_heads=8, mlp_ratio=4,
                              norm_layer=partial(nn.LayerNorm, eps=1e-6), maxlen=CLIP_LEN, num_joints=17)
            ckpt = torch.load(str(w), map_location="cpu", weights_only=True)
            state = {k.replace("module.", "", 1): v for k, v in ckpt["model_pos"].items()}
            model.load_state_dict(state, strict=True)
            model.eval()
            dev = config.torch_device()
            try:
                model.to(dev)
                with torch.no_grad():
                    model(torch.zeros(1, 8, 17, 3, device=dev))
            except Exception:
                dev = "cpu"
                model.to(dev)
            _model, _device = model, dev
        return _model, _device


def _flip(x: np.ndarray) -> np.ndarray:
    y = x.copy()
    y[..., 0] *= -1
    y[..., H36M_LEFT + H36M_RIGHT, :] = y[..., H36M_RIGHT + H36M_LEFT, :]
    return y


def normalise(seq: np.ndarray, mode: str = "track") -> tuple[np.ndarray, dict]:
    """Normalise H36M 2D (T,17,3) for the network.

    mode="clip":  official in-the-wild MotionBERT crop_scale over the whole clip.
    mode="track": follow the athlete: per-frame pelvis-centred (smoothed), constant scale such that the
                  median body height is ~1 unit. Robust to camera pans/zooms and long run-ups.
    """
    x = seq.copy()
    valid = x[..., 2] > 0.05
    if mode == "clip":
        pts = x[..., :2][valid]
        xmin, ymin = pts.min(0)
        xmax, ymax = pts.max(0)
        scale = max(xmax - xmin, ymax - ymin)
        xs, ys = (xmin + xmax - scale) / 2, (ymin + ymax - scale) / 2
        x[..., :2] = ((x[..., :2] - [xs, ys]) / scale - 0.5) * 2
        return np.clip(x, -1, 1), {"mode": mode, "scale": float(scale) / 2, "offset": [float(xs + scale / 2), float(ys + scale / 2)]}
    # track mode
    T = len(x)
    centre = x[:, 0, :2].copy()
    from scipy.ndimage import uniform_filter1d
    centre = uniform_filter1d(centre, size=min(T, 5), axis=0, mode="nearest")
    # body height proxy: head-top to mean ankle, robust median over the sequence
    h = np.linalg.norm(x[:, 10, :2] - (x[:, 3, :2] + x[:, 6, :2]) / 2, axis=1)
    hv = h[(x[:, 10, 2] > 0.2) & (x[:, 3, 2] > 0.2) & (x[:, 6, 2] > 0.2)]
    body = float(np.median(hv)) if len(hv) else float(np.median(h) + 1e-3)
    # allow slow scale changes (camera zoom / running towards or away from camera)
    hs = np.where(np.isfinite(h) & (h > 0.3 * body), h, body)
    hs = uniform_filter1d(hs, size=min(T, int(0.6 * T) + 1 if T < 30 else 31), axis=0, mode="nearest")
    hs = np.clip(hs, 0.6 * body, 1.6 * body)
    scale = hs / 1.0  # 1 unit = body height
    x[..., :2] = (x[..., :2] - centre[:, None, :]) / scale[:, None, None]
    return x, {"mode": mode, "centre": centre, "scale": scale}


def lift(seq_h36m: np.ndarray, mode: str = "track", flip_tta: bool = True) -> np.ndarray:
    """(T,17,3) H36M pixels+conf -> (T,17,3) 3D in normalised units (y down)."""
    model, dev = _load()
    x, _ = normalise(seq_h36m, mode)
    T = len(x)
    if T == 0:
        return np.zeros((0, 17, 3), np.float32)
    # sliding windows with overlap, blended with triangular weights
    if T <= CLIP_LEN:
        windows = [(0, T)]
    else:
        stride = CLIP_LEN - 81
        starts = list(range(0, T - CLIP_LEN + 1, stride))
        if starts[-1] != T - CLIP_LEN:
            starts.append(T - CLIP_LEN)
        windows = [(s, s + CLIP_LEN) for s in starts]
    acc = np.zeros((T, 17, 3), np.float64)
    wsum = np.zeros((T, 1, 1), np.float64)
    with torch.no_grad():
        for s, e in windows:
            inp = x[s:e]
            batch = [inp, _flip(inp)] if flip_tta else [inp]
            t = torch.from_numpy(np.stack(batch).astype(np.float32)).to(dev)
            pred = model(t).cpu().numpy()
            out = pred[0]
            if flip_tta:
                out = (out + _flip(pred[1])) / 2
            n = e - s
            ramp = np.minimum(np.arange(1, n + 1), np.arange(n, 0, -1)).astype(np.float64)
            ramp = np.minimum(ramp, 40.0)[:, None, None]
            acc[s:e] += out * ramp
            wsum[s:e] += ramp
    return (acc / np.maximum(wsum, 1e-9)).astype(np.float32)
