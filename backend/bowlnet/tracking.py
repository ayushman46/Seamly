"""Multi-person tracking built for broadcast/phone cricket footage.

We deliberately do not use the trackers bundled with ultralytics: in the pinned version their output
swaps identities between near-equal-confidence detections even when nobody moves. This tracker is a
SORT-style association with the cues that matter for bowling clips:

* global motion compensation (pans/zooms) from background optical flow,
* constant-velocity prediction in stabilised coordinates (bowler running past a static umpire),
* appearance (HSV colour of torso/legs: umpires and batters dress differently from bowlers),
* pose similarity (OKS-like), and
* Hungarian assignment with gating.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable

import cv2
import numpy as np
from scipy.optimize import linear_sum_assignment

from . import config
from .detect import Detection, _yolo
from .video import iter_frames

FLOW_SIZE = 640


@dataclass
class FrameDets:
    frame: int
    boxes: np.ndarray       # (N, 4)
    confs: np.ndarray       # (N,)
    kps: np.ndarray         # (N, 17, 2)
    kcs: np.ndarray         # (N, 17)
    appearance: np.ndarray  # (N, D)
    motion: np.ndarray      # (2, 3) affine mapping previous-frame pixels -> this frame


def _appearance(frame: np.ndarray, box: np.ndarray) -> np.ndarray:
    h, w = frame.shape[:2]
    x1, y1, x2, y2 = box
    bw, bh = x2 - x1, y2 - y1
    feats = []
    for (fy1, fy2) in [(0.18, 0.55), (0.55, 0.95)]:  # torso, legs
        xa, xb = int(max(0, x1 + 0.25 * bw)), int(min(w, x2 - 0.25 * bw))
        ya, yb = int(max(0, y1 + fy1 * bh)), int(min(h, y1 + fy2 * bh))
        if xb - xa < 2 or yb - ya < 2:
            feats.append(np.full(48, 1 / 48, np.float32))
            continue
        patch = cv2.cvtColor(frame[ya:yb, xa:xb], cv2.COLOR_BGR2HSV)
        hist = cv2.calcHist([patch], [0, 1, 2], None, [8, 3, 2], [0, 180, 0, 256, 0, 256]).flatten()
        hist = hist / max(hist.sum(), 1e-6)
        feats.append(hist.astype(np.float32))
    return np.concatenate(feats)


def _sparse_motion(prev_gray: np.ndarray, gray: np.ndarray, mask: np.ndarray) -> np.ndarray | None:
    """Similarity prev->curr from tracked corners (fast; fails on low-texture grass)."""
    pts = cv2.goodFeaturesToTrack(prev_gray, maxCorners=400, qualityLevel=0.01, minDistance=8, mask=mask)
    if pts is None or len(pts) < 12:
        return None
    nxt, st, _ = cv2.calcOpticalFlowPyrLK(prev_gray, gray, pts, None, winSize=(21, 21), maxLevel=3)
    good = st.reshape(-1) == 1
    if good.sum() < 12:
        return None
    M, inl = cv2.estimateAffinePartial2D(pts[good], nxt[good], method=cv2.RANSAC, ransacReprojThreshold=2.0)
    if M is None or inl is None or inl.sum() < 10:
        return None
    return M.astype(np.float32)


STATIC_WINDOW = 6


def _static_mask(diffs: list[np.ndarray]) -> np.ndarray | None:
    """Pixels that stayed (near) identical over the last few frames: overlays, or the whole frame on a tripod."""
    if len(diffs) < 3:
        return None
    static = (np.max(np.stack(diffs), axis=0) <= 4).astype(np.uint8)
    return cv2.dilate(static, np.ones((5, 5), np.uint8)) > 0


def _camera_motion(prev_gray: np.ndarray | None, gray: np.ndarray, boxes: np.ndarray, scale: float,
                   prev_boxes: np.ndarray | None = None, static_mask: np.ndarray | None = None) -> np.ndarray:
    """Camera motion prev->curr (pan/tilt/zoom) estimated on the background with people masked out.

    Dense ECC alignment is the primary estimator: broadcast backgrounds (grass, pitch) have too few corners
    for sparse flow, which then silently degrades to identity during zooms. Sparse flow seeds ECC when it
    succeeds and is the fallback when ECC fails to converge."""
    eye = np.array([[1, 0, 0], [0, 1, 0]], np.float32)
    if prev_gray is None:
        return eye
    mask = np.full(prev_gray.shape, 255, np.uint8)
    for bb in (boxes, prev_boxes if prev_boxes is not None else np.zeros((0, 4))):
        for b in bb:
            x1, y1, x2, y2 = (b * scale).astype(int)
            mask[max(0, y1 - 8):y2 + 8, max(0, x1 - 8):x2 + 8] = 0
    # static overlays (score bars, logos) barely change over several frames while the camera moves; they would
    # pin the alignment to "no motion", so mask them (textureless regions carry no information anyway)
    if static_mask is not None:
        mask[static_mask] = 0
    sparse = _sparse_motion(prev_gray, gray, mask)
    M = sparse if sparse is not None else eye.copy()
    if mask.mean() > 255 * 0.15:   # enough background left to align on
        try:
            _, W = cv2.findTransformECC(prev_gray.astype(np.float32), gray.astype(np.float32), M.copy(),
                                        cv2.MOTION_AFFINE,
                                        (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 50, 1e-5), mask, 5)
            # sanity: reject wild solutions (more than 15% zoom or a third of the frame of shift per frame)
            sc = float(np.sqrt(abs(np.linalg.det(W[:, :2]))))
            if 0.85 < sc < 1.15 and np.all(np.abs(W[:, 2]) < 0.33 * max(prev_gray.shape)):
                M = W.astype(np.float32)
        except cv2.error:
            pass
    # back to full-resolution pixel units
    M = M.astype(np.float32)
    M[:, 2] /= scale
    return M


def detect_frames(path: str, start: int, end: int, progress: Callable[[float], None] | None = None,
                  batch: int = 8, stride: int = 1) -> list[FrameDets]:
    """Per-frame YOLO11-pose person detections + appearance + camera motion over [start, end)."""
    model = _yolo("track")
    device = config.torch_device()
    out: list[FrameDets] = []
    buf: list[tuple[int, np.ndarray]] = []
    prev_gray = None
    prev_boxes = None
    diffs: list[np.ndarray] = []
    total = max(1, end - start)

    def flush():
        nonlocal prev_gray, prev_boxes
        if not buf:
            return
        preds = model.predict([f for _, f in buf], imgsz=config.TRACK_IMGSZ, device=device, verbose=False,
                              conf=config.DET_CONF, classes=[0])
        for (idx, frame), r in zip(buf, preds):
            if r.boxes is not None and len(r.boxes):
                boxes = r.boxes.xyxy.cpu().numpy().astype(np.float32)
                confs = r.boxes.conf.cpu().numpy().astype(np.float32)
                kps = r.keypoints.xy.cpu().numpy().astype(np.float32)
                kcs = (r.keypoints.conf.cpu().numpy() if r.keypoints.conf is not None
                       else np.ones(kps.shape[:2])).astype(np.float32)
            else:
                boxes = np.zeros((0, 4), np.float32); confs = np.zeros(0, np.float32)
                kps = np.zeros((0, 17, 2), np.float32); kcs = np.zeros((0, 17), np.float32)
            scale = FLOW_SIZE / max(frame.shape[:2])
            gray = cv2.cvtColor(cv2.resize(frame, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA),
                                cv2.COLOR_BGR2GRAY)
            if prev_gray is not None:
                diffs.append(cv2.absdiff(prev_gray, gray))
                del diffs[:-STATIC_WINDOW]
            motion = _camera_motion(prev_gray, gray, boxes, scale, prev_boxes, _static_mask(diffs))
            prev_gray = gray
            prev_boxes = boxes
            app = np.stack([_appearance(frame, b) for b in boxes]) if len(boxes) else np.zeros((0, 96), np.float32)
            out.append(FrameDets(idx, boxes, confs, kps, kcs, app, motion))
        if progress:
            progress(min(1.0, (buf[-1][0] - start + 1) / total))
        buf.clear()

    for idx, frame in iter_frames(path, start, end):
        if (idx - start) % stride:
            continue
        buf.append((idx, frame))
        if len(buf) >= batch:
            flush()
    flush()
    return out


def _apply_affine(M: np.ndarray, box: np.ndarray) -> np.ndarray:
    pts = np.array([[box[0], box[1]], [box[2], box[3]]], np.float32)
    p = pts @ M[:, :2].T + M[:, 2]
    return np.array([p[0, 0], p[0, 1], p[1, 0], p[1, 1]], np.float32)


def _iou_matrix(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    if len(a) == 0 or len(b) == 0:
        return np.zeros((len(a), len(b)), np.float32)
    x1 = np.maximum(a[:, None, 0], b[None, :, 0]); y1 = np.maximum(a[:, None, 1], b[None, :, 1])
    x2 = np.minimum(a[:, None, 2], b[None, :, 2]); y2 = np.minimum(a[:, None, 3], b[None, :, 3])
    inter = np.clip(x2 - x1, 0, None) * np.clip(y2 - y1, 0, None)
    aa = (a[:, 2] - a[:, 0]) * (a[:, 3] - a[:, 1]); ab = (b[:, 2] - b[:, 0]) * (b[:, 3] - b[:, 1])
    return inter / np.maximum(aa[:, None] + ab[None, :] - inter, 1e-6)


@dataclass
class _Track:
    tid: int
    box: np.ndarray
    vel: np.ndarray                 # (4,) per-frame box velocity in stabilised coords
    app: np.ndarray
    kp: np.ndarray
    kc: np.ndarray
    missed: int = 0
    hits: int = 1
    history: list = field(default_factory=list)


def _dedupe(fd: FrameDets) -> FrameDets:
    """Drop duplicate boxes of one person. NMS keeps two boxes when a limb swings out (the bowling arm at
    release: one box with the arm, one without, IoU ~0.65); the spare would start a new track that steals the
    bowler. Duplicates share their keypoints (median distance < 8% of height); two overlapping people don't
    (>= ~20%)."""
    n = len(fd.boxes)
    if n < 2:
        return fd
    iou = _iou_matrix(fd.boxes, fd.boxes)
    h = np.maximum(fd.boxes[:, 3] - fd.boxes[:, 1], 1.0)
    drop: set[int] = set()
    for i in np.argsort(-fd.confs):
        if i in drop:
            continue
        for j in range(n):
            if j == i or j in drop or iou[i, j] < 0.3 or fd.confs[j] > fd.confs[i]:
                continue
            w = (fd.kcs[i] > 0.3) & (fd.kcs[j] > 0.3)
            if w.sum() >= 6 and np.median(np.linalg.norm(fd.kps[i] - fd.kps[j], axis=1)[w]) < 0.08 * max(h[i], h[j]):
                drop.add(j)
    if not drop:
        return fd
    keep = np.array([i for i in range(n) if i not in drop])
    return FrameDets(fd.frame, fd.boxes[keep], fd.confs[keep], fd.kps[keep], fd.kcs[keep], fd.appearance[keep],
                     fd.motion)


def track(frames: list[FrameDets], fps: float) -> list[Detection]:
    """Associate per-frame detections into identities. Returns Detection objects with stable track ids."""
    max_missed = max(5, int(round(0.6 * fps)))
    tracks: list[_Track] = []
    next_id = 1
    out: list[Detection] = []
    for fd in map(_dedupe, frames):
        # predict: constant velocity, then camera motion
        for t in tracks:
            t.box = _apply_affine(fd.motion, t.box + t.vel)
            t.kp = t.kp @ fd.motion[:, :2].T + fd.motion[:, 2]
        n_t, n_d = len(tracks), len(fd.boxes)
        matches: list[tuple[int, int]] = []
        if n_t and n_d:
            tb = np.stack([t.box for t in tracks])
            iou = _iou_matrix(tb, fd.boxes)
            th = np.maximum(tb[:, 3] - tb[:, 1], 1.0)
            tc = np.stack([(tb[:, 0] + tb[:, 2]) / 2, (tb[:, 1] + tb[:, 3]) / 2], 1)
            dc = np.stack([(fd.boxes[:, 0] + fd.boxes[:, 2]) / 2, (fd.boxes[:, 1] + fd.boxes[:, 3]) / 2], 1)
            cdist = np.linalg.norm(tc[:, None] - dc[None], axis=2) / th[:, None]
            dh = np.maximum(fd.boxes[:, 3] - fd.boxes[:, 1], 1.0)
            size_ratio = np.abs(np.log(dh[None, :] / th[:, None]))
            ta = np.stack([t.app for t in tracks])
            bc = np.sqrt(np.clip(ta[:, None, :] * fd.appearance[None, :, :], 0, None)).sum(-1) / 2.0  # 2 regions
            app_d = 1.0 - np.clip(bc, 0, 1)
            # pose similarity: mean keypoint distance (both confident) normalised by height
            tk = np.stack([t.kp for t in tracks]); tkc = np.stack([t.kc for t in tracks])
            kd = np.linalg.norm(tk[:, None] - fd.kps[None], axis=3)  # (T, D, 17)
            w = (tkc[:, None] > 0.3) & (fd.kcs[None] > 0.3)
            pose_d = np.where(w.sum(-1) >= 4, (kd * w).sum(-1) / np.maximum(w.sum(-1), 1), 0.5 * th[:, None])
            pose_d = pose_d / th[:, None]
            cost = (1.0 - iou) * 1.0 + 0.8 * np.minimum(cdist, 2.0) + 1.2 * app_d + 0.8 * np.minimum(pose_d, 1.0) \
                + 0.5 * np.minimum(size_ratio, 1.0)
            missed = np.array([t.missed for t in tracks])[:, None]
            gate = (iou > 0.05) | (cdist < 0.6 + 0.15 * np.minimum(missed, 6))
            gate &= size_ratio < 0.7
            cost = np.where(gate, cost, 1e6)
            r, c = linear_sum_assignment(cost)
            for i, j in zip(r, c):
                if cost[i, j] < 2.6:
                    matches.append((i, j))
        matched_t = {i for i, _ in matches}
        matched_d = {j for _, j in matches}
        for i, j in matches:
            t = tracks[i]
            new_box = fd.boxes[j]
            # velocity in current coordinates (camera motion already applied to the prediction)
            t.vel = 0.6 * t.vel + 0.4 * (new_box - (t.box - t.vel)) if t.hits > 1 else np.zeros(4, np.float32)
            t.vel = np.clip(t.vel, -0.25 * (new_box[3] - new_box[1]), 0.25 * (new_box[3] - new_box[1]))
            t.box = new_box.copy()
            t.app = 0.8 * t.app + 0.2 * fd.appearance[j]
            t.kp = fd.kps[j].copy(); t.kc = fd.kcs[j].copy()
            t.missed = 0; t.hits += 1
            out.append(Detection(fd.frame, t.tid, new_box.copy(), float(fd.confs[j]), fd.kps[j].copy(), fd.kcs[j].copy()))
        for i, t in enumerate(tracks):
            if i not in matched_t:
                t.missed += 1
                t.vel = t.vel * 0.7
        tracks = [t for t in tracks if t.missed <= max_missed]
        for j in range(n_d):
            if j in matched_d:
                continue
            if fd.confs[j] < 0.35:
                continue
            t = _Track(next_id, fd.boxes[j].copy(), np.zeros(4, np.float32), fd.appearance[j].copy(),
                       fd.kps[j].copy(), fd.kcs[j].copy())
            next_id += 1
            tracks.append(t)
            out.append(Detection(fd.frame, t.tid, fd.boxes[j].copy(), float(fd.confs[j]), fd.kps[j].copy(), fd.kcs[j].copy()))
    return out
