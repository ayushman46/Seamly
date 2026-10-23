"""SAM 3D Body (Meta, 2026) as the 3D pose source.

A single-image full-body mesh recovery model (ViT-H backbone, MHR body rig) run on the bowler's crop in every
analysed frame. It sees the image itself, so its depth comes from appearance rather than from a 2D-to-3D lifter
trained on lab motion; on athletic movement that is far more accurate. Used automatically when its checkpoint is
installed in models/sam3d/ (gated on Hugging Face: see README); MotionBERT is the fallback.

Output: H36M-ordered 3D joints (T, 17, 3) in camera axes (x right, y down, z away), metres, plus the per-frame
MHR mesh vertices for frames where the model ran.
"""
from __future__ import annotations

import contextlib
import io
import logging
import os
import sys
import threading
import warnings
from pathlib import Path
from typing import Callable, Iterable

import numpy as np

from .. import config

log = logging.getLogger("bowlnet.sam3d")
THIRD_PARTY = Path(__file__).resolve().parents[2] / "third_party"
SAM3D_DIR = config.MODELS_DIR / "sam3d"
CKPT, CFG, MHR = SAM3D_DIR / "model.ckpt", SAM3D_DIR / "model_config.yaml", SAM3D_DIR / "mhr_model.pt"

# MHR-70 keypoint indices (sam_3d_body/metadata/mhr70.py)
_K = {"nose": 0, "l_ear": 3, "r_ear": 4, "l_sh": 5, "r_sh": 6, "l_el": 7, "r_el": 8, "l_wr": 62, "r_wr": 41,
      "l_hip": 9, "r_hip": 10, "l_kn": 11, "r_kn": 12, "l_an": 13, "r_an": 14, "neck": 69}

_lock = threading.Lock()
_est = None


MIN_RAM_GB = 12.0   # the model peaks at ~7.7 GB (weights + activations + MHR); below this it would swap


def total_ram_gb() -> float:
    try:
        return os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") / 1e9
    except (ValueError, OSError, AttributeError):
        return 0.0


def available() -> bool:
    """Installed, and either forced (BOWLNET_POSE3D=sam3d) or enough memory to run it comfortably."""
    mode = os.environ.get("BOWLNET_POSE3D", "auto").lower()
    if mode == "motionbert" or not (CKPT.exists() and CFG.exists() and MHR.exists()):
        return False
    if mode == "sam3d":
        return True
    ram = total_ram_gb()
    if ram and ram < MIN_RAM_GB:
        log.info("SAM 3D Body installed but only %.0f GB RAM: using MotionBERT (set BOWLNET_POSE3D=sam3d to force)", ram)
        return False
    return True


def _estimator():
    global _est
    with _lock:
        if _est is None:
            if str(THIRD_PARTY) not in sys.path:
                sys.path.insert(0, str(THIRD_PARTY))
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                from sam_3d_body.build_models import load_sam_3d_body
                from sam_3d_body.sam_3d_body_estimator import SAM3DBodyEstimator
                model, cfg = load_sam_3d_body(str(CKPT), device=config.torch_device(), mhr_path=str(MHR))
            model.eval()
            _est = SAM3DBodyEstimator(sam_3d_body_model=model, model_cfg=cfg, human_detector=None,
                                      human_segmentor=None, fov_estimator=None)
        return _est


def mhr_to_h36m(k: np.ndarray) -> np.ndarray:
    """(70, 3) MHR keypoints -> (17, 3) H36M joints (pelvis = mid-hips, thorax = neck base, head extrapolated)."""
    g = lambda n: k[_K[n]]
    pelvis = (g("l_hip") + g("r_hip")) / 2
    thorax = g("neck")
    ears = (g("l_ear") + g("r_ear")) / 2
    head = ears + 0.5 * (ears - thorax)
    return np.stack([pelvis, g("r_hip"), g("r_kn"), g("r_an"), g("l_hip"), g("l_kn"), g("l_an"),
                     (pelvis + thorax) / 2, thorax, g("nose"), head,
                     g("l_sh"), g("l_el"), g("l_wr"), g("r_sh"), g("r_el"), g("r_wr")])


def lift_frames(frames: Iterable[tuple[int, np.ndarray]], boxes: dict[int, np.ndarray], f0: int, T: int,
                progress: Callable[[float], None] | None = None, stride: int = 1) -> tuple[np.ndarray, np.ndarray]:
    """Run SAM 3D Body on the bowler box of each frame. frames: (index, BGR image) iterator over the window
    (consumed lazily, so memory stays flat).
    Frames without a box (or skipped by the stride) are filled by linear interpolation.
    Returns (X (T,17,3) camera-axis metres, ran (T,) bool)."""
    import cv2
    import torch

    est = _estimator()
    X = np.full((T, 17, 3), np.nan)
    wanted = [fr for fr in range(f0, f0 + T) if fr in boxes and (fr - f0) % stride == 0]
    want = set(wanted)
    n = 0
    for fr, img in frames:
        if fr not in want:
            continue
        b = np.asarray(boxes[fr], np.float32).reshape(1, 4)
        rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
        with torch.inference_mode(), contextlib.redirect_stdout(io.StringIO()):
            out = est.process_one_image(rgb, bboxes=b, inference_type="body")
        if out:
            o = out[0]
            X[fr - f0] = mhr_to_h36m(np.asarray(o["pred_keypoints_3d"], np.float64) + np.asarray(o["pred_cam_t"], np.float64))
        n += 1
        if progress:
            progress(n / max(1, len(wanted)))
    ran = np.isfinite(X[:, 0, 0])
    if ran.sum() < 2:
        raise RuntimeError("SAM 3D Body produced no poses for this clip")
    t = np.arange(T)
    for j in range(17):
        for c in range(3):
            X[:, j, c] = np.interp(t, t[ran], X[ran, j, c])
    return X, ran
