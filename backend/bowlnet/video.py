"""Video probing, frame access and shot (scene-cut) segmentation."""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterator

import cv2
import numpy as np


class VideoError(RuntimeError):
    pass


@dataclass
class Shot:
    start: int  # inclusive frame index
    end: int    # exclusive frame index

    @property
    def length(self) -> int:
        return self.end - self.start

    def to_dict(self) -> dict:
        return {"start": self.start, "end": self.end}


@dataclass
class VideoInfo:
    path: str
    width: int
    height: int
    fps: float
    frame_count: int
    duration: float
    timestamps: np.ndarray = field(repr=False)  # seconds, one per decoded frame
    shots: list[Shot] = field(default_factory=list)
    frame_diff: np.ndarray | None = field(default=None, repr=False)  # mean abs grey diff to the previous frame

    def repeated_fraction(self, start: int, end: int) -> float:
        """Share of frames in [start, end) that repeat the previous frame (frame-doubling slow motion or
        frame-rate conversion). Measured where the bowler moves, so a genuinely new frame always differs."""
        if self.frame_diff is None or end - start < 6:
            return 0.0
        d = self.frame_diff[max(0, start - 1):max(0, end - 1)]
        if not len(d):
            return 0.0
        # a repeat is (near) pixel-identical while a genuinely new frame nearby clearly differs; a static
        # stretch (everything ~0) is not a repeat pattern
        local_max = np.array([d[max(0, i - 4):i + 5].max() for i in range(len(d))])
        return float(np.mean((d < 0.15) & (d < 0.1 * local_max)))

    def to_dict(self) -> dict:
        return {
            "width": self.width,
            "height": self.height,
            "fps": round(self.fps, 3),
            "frame_count": self.frame_count,
            "duration": round(self.duration, 3),
            "shots": [s.to_dict() for s in self.shots],
        }


def _open(path: str | Path) -> cv2.VideoCapture:
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        raise VideoError("Could not open the video. Supported formats: MP4, MOV, AVI, MKV, WEBM (H.264/HEVC/VP9).")
    return cap


def iter_frames(path: str | Path, start: int = 0, end: int | None = None) -> Iterator[tuple[int, np.ndarray]]:
    """Decode frames sequentially (exact indexing, no seeking ambiguity). Yields (index, BGR frame)."""
    cap = _open(path)
    try:
        idx = 0
        while True:
            if end is not None and idx >= end:
                break
            if idx < start:
                if not cap.grab():
                    break
                idx += 1
                continue
            ok, frame = cap.read()
            if not ok:
                break
            yield idx, frame
            idx += 1
    finally:
        cap.release()


def _shot_signature(frame: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    small = cv2.resize(frame, (64, 36), interpolation=cv2.INTER_AREA)
    hsv = cv2.cvtColor(small, cv2.COLOR_BGR2HSV)
    hist = cv2.calcHist([hsv], [0, 1], None, [16, 8], [0, 180, 0, 256]).astype(np.float32)
    cv2.normalize(hist, hist)
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY).astype(np.float32)
    return hist, gray


def probe(path: str | Path, progress: Callable[[float], None] | None = None) -> VideoInfo:
    """Decode the whole video once: exact frame count, per-frame timestamps and scene cuts."""
    cap = _open(path)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    nominal_fps = float(cap.get(cv2.CAP_PROP_FPS) or 0.0)
    approx_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)

    stamps: list[float] = []
    hist_dist: list[float] = []
    pix_dist: list[float] = []
    prev = None
    n = 0
    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            if n == 0:
                height, width = frame.shape[:2]  # after any rotation metadata is applied
            stamps.append(float(cap.get(cv2.CAP_PROP_POS_MSEC)) / 1000.0)
            sig = _shot_signature(frame)
            if prev is not None:
                corr = cv2.compareHist(prev[0], sig[0], cv2.HISTCMP_CORREL)
                hist_dist.append(1.0 - float(corr))
                pix_dist.append(float(np.mean(np.abs(prev[1] - sig[1]))))
            prev = sig
            n += 1
            if progress and approx_count and n % 15 == 0:
                progress(min(1.0, n / approx_count))
    finally:
        cap.release()

    if n == 0:
        raise VideoError("The video contains no decodable frames.")

    ts = _clean_timestamps(np.asarray(stamps, dtype=np.float64), nominal_fps)
    fps = _robust_fps(ts, nominal_fps)
    shots = _segment_shots(np.asarray(hist_dist), np.asarray(pix_dist), n, fps)
    return VideoInfo(
        path=str(path), width=width, height=height, fps=fps, frame_count=n,
        duration=float(ts[-1] - ts[0] + 1.0 / fps), timestamps=ts, shots=shots,
        frame_diff=np.asarray(pix_dist, np.float32),
    )


def _clean_timestamps(ts: np.ndarray, nominal_fps: float) -> np.ndarray:
    """Container timestamps can be missing/non-monotonic; fall back to a uniform clock when they are."""
    n = len(ts)
    fps = nominal_fps if nominal_fps and nominal_fps > 1 else 30.0
    uniform = np.arange(n) / fps
    if n < 3:
        return uniform
    d = np.diff(ts)
    if np.any(d <= 0) or np.ptp(ts) <= 0:
        return uniform
    ts = ts - ts[0]
    # reject absurd gaps (> 10x median frame interval) by replacing with median interval
    med = float(np.median(d))
    if med <= 0:
        return uniform
    d = np.where(d > 10 * med, med, d)
    return np.concatenate([[0.0], np.cumsum(d)])


def _robust_fps(ts: np.ndarray, nominal: float) -> float:
    if len(ts) > 2:
        med = float(np.median(np.diff(ts)))
        if med > 0:
            return 1.0 / med
    return nominal if nominal > 1 else 30.0


def _segment_shots(hist_d: np.ndarray, pix_d: np.ndarray, n: int, fps: float) -> list[Shot]:
    """Hard cuts: a histogram jump that is large both absolutely and relative to the local motion level."""
    if n < 2:
        return [Shot(0, n)]
    cuts = []
    for i in range(len(hist_d)):
        lo, hi = max(0, i - 8), min(len(hist_d), i + 9)
        local = np.median(np.concatenate([hist_d[lo:i], hist_d[i + 1:hi]])) if hi - lo > 1 else 0.0
        h, p = hist_d[i], pix_d[i]
        strong = (h > 0.45 and p > 18) or (p > 45)
        relative = h > 4.0 * local + 0.15 and p > 12
        if strong or relative:
            cuts.append(i + 1)  # cut happens before frame i+1
    bounds = [0] + cuts + [n]
    shots = [Shot(a, b) for a, b in zip(bounds[:-1], bounds[1:]) if b > a]
    # merge flashes / transition frames (< ~0.2 s) into the previous shot
    min_len = max(3, int(round(0.2 * fps)))
    merged: list[Shot] = []
    for s in shots:
        if merged and s.length < min_len:
            merged[-1] = Shot(merged[-1].start, s.end)
        else:
            merged.append(s)
    if len(merged) > 1 and merged[0].length < min_len:
        merged[1] = Shot(merged[0].start, merged[1].end)
        merged = merged[1:]
    return merged


def write_jpeg(path: Path, frame: np.ndarray, max_side: int, quality: int) -> float:
    """Save a display frame; returns the scale factor applied (display px / source px)."""
    h, w = frame.shape[:2]
    scale = min(1.0, max_side / max(h, w))
    if scale < 1.0:
        frame = cv2.resize(frame, (int(round(w * scale)), int(round(h * scale))), interpolation=cv2.INTER_AREA)
    cv2.imwrite(str(path), frame, [cv2.IMWRITE_JPEG_QUALITY, quality])
    return scale
