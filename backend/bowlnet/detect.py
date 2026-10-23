"""YOLO11 pose detection + multi-object tracking, and top-down keypoint refinement on crops."""
from __future__ import annotations

import os
import threading
from dataclasses import dataclass
from typing import Callable, Iterable

import cv2
import numpy as np

from . import config
from .video import iter_frames

COCO_NAMES = [
    "nose", "left_eye", "right_eye", "left_ear", "right_ear",
    "left_shoulder", "right_shoulder", "left_elbow", "right_elbow",
    "left_wrist", "right_wrist", "left_hip", "right_hip",
    "left_knee", "right_knee", "left_ankle", "right_ankle",
]
COCO_FLIP = [0, 2, 1, 4, 3, 6, 5, 8, 7, 10, 9, 12, 11, 14, 13, 16, 15]

_lock = threading.Lock()
_models: dict[str, object] = {}


def _configure_ultralytics() -> None:
    """Two process-wide ultralytics defaults that hurt this pipeline:
    * NMS gives up after ~2.4 s per batch and silently returns *no detections* for the rest of the batch. On a
      busy machine (or while MPS kernels compile) that drops the bowler from frames, so the limit is lifted.
    * Importing ultralytics disables OpenCV threading (it guards ultralytics' DataLoader, which is unused here),
      making the per-frame camera-motion alignment ~4x slower; restore it."""
    from ultralytics.utils import nms

    if not getattr(nms.non_max_suppression, "_bowlnet", False):
        orig = nms.non_max_suppression

        def non_max_suppression(*args, **kwargs):
            kwargs["max_time_img"] = 1e4
            return orig(*args, **kwargs)

        non_max_suppression._bowlnet = True
        nms.non_max_suppression = non_max_suppression
    cv2.setNumThreads(min(8, os.cpu_count() or 4))


def _yolo(kind: str):
    """Lazily load and cache YOLO models ('track' = fast full-frame, 'refine' = accurate crops)."""
    with _lock:
        if kind not in _models:
            from ultralytics import YOLO

            _configure_ultralytics()

            weights = config.YOLO_TRACK_WEIGHTS if kind == "track" else config.YOLO_REFINE_WEIGHTS
            if not weights.exists():
                raise FileNotFoundError(f"Missing YOLO weights: {weights}. Run `python -m tools.download_models`.")
            _models[kind] = YOLO(str(weights))
        return _models[kind]


@dataclass
class Detection:
    frame: int
    track: int
    box: np.ndarray   # (4,) x1, y1, x2, y2 in source pixels
    conf: float
    kp: np.ndarray    # (17, 2) source pixels
    kc: np.ndarray    # (17,) confidence


def track_people(
    path: str,
    start: int,
    end: int,
    stride: int = 1,
    progress: Callable[[float], None] | None = None,
) -> list[Detection]:
    """Run YOLO11-pose + BoT-SORT/ByteTrack over [start, end) of the video (fresh tracker state)."""
    model = _yolo("track")
    device = config.torch_device()
    out: list[Detection] = []
    first = True
    total = max(1, (end - start + stride - 1) // stride)
    done = 0
    for idx, frame in iter_frames(path, start, end):
        if (idx - start) % stride:
            continue
        res = model.track(
            frame, persist=not first, tracker="bytetrack.yaml", imgsz=config.TRACK_IMGSZ,
            device=device, verbose=False, conf=config.DET_CONF, classes=[0],
        )[0]
        first = False
        done += 1
        if progress and done % 5 == 0:
            progress(done / total)
        if res.boxes is None or len(res.boxes) == 0 or res.boxes.id is None:
            continue
        boxes = res.boxes.xyxy.cpu().numpy()
        ids = res.boxes.id.int().cpu().numpy()
        confs = res.boxes.conf.cpu().numpy()
        kps = res.keypoints.xy.cpu().numpy()
        kcs = res.keypoints.conf.cpu().numpy() if res.keypoints.conf is not None else np.ones(kps.shape[:2])
        for b, t, c, k, kc in zip(boxes, ids, confs, kps, kcs):
            out.append(Detection(idx, int(t), b.astype(np.float32), float(c), k.astype(np.float32), kc.astype(np.float32)))
    if progress:
        progress(1.0)
    return out


def square_crop(frame: np.ndarray, box: np.ndarray, out_size: int, pad: float = 1.3) -> tuple[np.ndarray, np.ndarray]:
    """Crop a square around `box` (scaled by `pad`), resized to out_size. Returns crop and 2x3 affine crop->src."""
    x1, y1, x2, y2 = [float(v) for v in box]
    cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
    side = max(x2 - x1, y2 - y1) * pad
    side = max(side, 32.0)
    s = out_size / side
    # src -> crop affine
    M = np.array([[s, 0, out_size / 2 - s * cx], [0, s, out_size / 2 - s * cy]], dtype=np.float32)
    crop = cv2.warpAffine(frame, M, (out_size, out_size), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT,
                          borderValue=(114, 114, 114))
    inv = cv2.invertAffineTransform(M)
    return crop, inv


def _iou(a: np.ndarray, b: np.ndarray) -> float:
    ix1, iy1 = max(a[0], b[0]), max(a[1], b[1])
    ix2, iy2 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
    ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / ua if ua > 0 else 0.0


@dataclass
class RefinedPose:
    frame: int
    box: np.ndarray        # refined box in source pixels
    kp: np.ndarray         # (17, 2)
    kc: np.ndarray         # (17,)
    matched_iou: float


def refine_on_crops(
    crops: list[np.ndarray],
    invs: list[np.ndarray],
    target_boxes: list[np.ndarray],
    frames: list[int],
    batch: int = 16,
    flip_tta: bool = True,
) -> list[RefinedPose | None]:
    """Top-down YOLO11x pose on bowler crops. Picks the person matching the tracked box (crops can contain
    the umpire/batter), maps keypoints back to the source frame. Horizontal-flip TTA averages out jitter."""
    model = _yolo("refine")
    device = config.torch_device()
    results: list[RefinedPose | None] = []
    for i in range(0, len(crops), batch):
        chunk = crops[i:i + batch]
        preds = model.predict(chunk, imgsz=config.REFINE_IMGSZ, device=device, verbose=False, conf=0.15)
        preds_f = None
        if flip_tta:
            preds_f = model.predict([np.ascontiguousarray(c[:, ::-1]) for c in chunk], imgsz=config.REFINE_IMGSZ,
                                    device=device, verbose=False, conf=0.15)
        for j, r in enumerate(preds):
            k = i + j
            inv = invs[k]
            tb = target_boxes[k]
            size = chunk[j].shape[1]
            best = _pick(r, inv, tb)
            if best is None:
                results.append(None)
                continue
            box, kp, kc, iou = best
            if preds_f is not None:
                bf = _pick(preds_f[j], inv, tb, flipped_width=size)
                if bf is not None and _iou(bf[0], box) > 0.6:
                    kpf, kcf = bf[1][COCO_FLIP], bf[2][COCO_FLIP]
                    w1, w2 = kc[:, None] + 1e-3, kcf[:, None] + 1e-3
                    agree = np.linalg.norm(kp - kpf, axis=1) < 0.08 * (box[3] - box[1])
                    kp = np.where(agree[:, None], (kp * w1 + kpf * w2) / (w1 + w2), kp)
                    kc = np.where(agree, np.maximum(kc, kcf), kc * 0.85)
            results.append(RefinedPose(frames[k], box, kp, kc, iou))
    return results


def _pick(r, inv: np.ndarray, target_box: np.ndarray, flipped_width: int | None = None):
    if r.boxes is None or len(r.boxes) == 0:
        return None
    boxes = r.boxes.xyxy.cpu().numpy().copy()
    kps = r.keypoints.xy.cpu().numpy().copy()
    kcs = r.keypoints.conf.cpu().numpy() if r.keypoints.conf is not None else np.ones(kps.shape[:2])
    if flipped_width is not None:
        boxes[:, [0, 2]] = flipped_width - boxes[:, [2, 0]]
        kps[..., 0] = flipped_width - kps[..., 0]
    best, best_score = None, -1.0
    for b, k, kc in zip(boxes, kps, kcs):
        src_b = _affine_box(b, inv)
        iou = _iou(src_b, target_box)
        score = iou + 0.1 * float(kc.mean())
        if score > best_score:
            best_score = score
            src_k = (inv[:, :2] @ k.T).T + inv[:, 2]
            best = (src_b, src_k.astype(np.float32), kc.astype(np.float32), iou)
    if best is None or best[3] < 0.2:
        return None
    return best


def _affine_box(b: np.ndarray, inv: np.ndarray) -> np.ndarray:
    pts = np.array([[b[0], b[1]], [b[2], b[3]]], dtype=np.float32)
    p = (inv[:, :2] @ pts.T).T + inv[:, 2]
    return np.array([p[0, 0], p[0, 1], p[1, 0], p[1, 1]], dtype=np.float32)


def detections_by_track(dets: Iterable[Detection]) -> dict[int, list[Detection]]:
    tracks: dict[int, list[Detection]] = {}
    for d in dets:
        tracks.setdefault(d.track, []).append(d)
    for v in tracks.values():
        v.sort(key=lambda d: d.frame)
    return tracks
