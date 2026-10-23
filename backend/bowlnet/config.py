"""Paths and tunables. Everything can be overridden with BOWLNET_* environment variables."""
from __future__ import annotations

import os
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
MODELS_DIR = Path(os.environ.get("BOWLNET_MODELS_DIR", BACKEND_ROOT / "models"))
DATA_DIR = Path(os.environ.get("BOWLNET_DATA_DIR", BACKEND_ROOT / "data"))
ANALYSES_DIR = DATA_DIR / "analyses"

YOLO_TRACK_WEIGHTS = MODELS_DIR / "yolo" / os.environ.get("BOWLNET_YOLO_TRACK", "yolo11m-pose.pt")
YOLO_REFINE_WEIGHTS = MODELS_DIR / "yolo" / os.environ.get("BOWLNET_YOLO_REFINE", "yolo11x-pose.pt")
MOTIONBERT_WEIGHTS = MODELS_DIR / "motionbert" / "FT_MB_lite_MB_ft_h36m_global_lite.bin"
BODY_MODEL = MODELS_DIR / "body" / "anny_body.npz"

# Detection / tracking
TRACK_IMGSZ = int(os.environ.get("BOWLNET_TRACK_IMGSZ", 960))
REFINE_IMGSZ = int(os.environ.get("BOWLNET_REFINE_IMGSZ", 384))
DET_CONF = 0.25

# Storage limits
MAX_UPLOAD_MB = int(os.environ.get("BOWLNET_MAX_UPLOAD_MB", 500))
MAX_VIDEO_SECONDS = float(os.environ.get("BOWLNET_MAX_VIDEO_SECONDS", 120))
FRAME_JPEG_MAX_SIDE = 1280
FRAME_JPEG_QUALITY = 85


def torch_device() -> str:
    forced = os.environ.get("BOWLNET_DEVICE")
    if forced:
        return forced
    import torch

    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"
