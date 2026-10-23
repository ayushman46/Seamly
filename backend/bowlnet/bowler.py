"""Identify the bowler among all tracked people and find the delivery window.

A delivery has an unmistakable kinematic signature: one arm sweeps ~270-360 degrees around the shoulder,
monotonically, in roughly half a second, peaking well above 600 deg/s, while the wrist passes above the
head. Umpires, batters and celebrating fielders never produce that pattern, so we score every track by
its best "arm sweep" window rather than by size or track length.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .detect import Detection

L_SH, R_SH, L_EL, R_EL, L_WR, R_WR, L_HIP, R_HIP = 5, 6, 7, 8, 9, 10, 11, 12
NOSE = 0


@dataclass
class ArmSweep:
    side: str            # "left" | "right" (anatomical side of the arm as labelled by the detector)
    sweep_deg: float     # max |monotonic rotation| inside the window
    peak_speed: float    # deg/s
    start_frame: int
    end_frame: int
    peak_frame: int
    direction: int       # +1 / -1 rotation sense in image coordinates


@dataclass
class TrackScore:
    track: int
    shot: int
    n: int
    first: int
    last: int
    median_height: float
    sweep: ArmSweep | None
    overhead_frames: int
    score: float
    legs_visibility: float = 0.0

    def to_dict(self) -> dict:
        d = {
            "track": self.track, "shot": self.shot, "frames": self.n, "first": self.first, "last": self.last,
            "median_height_px": round(self.median_height, 1), "overhead_frames": self.overhead_frames,
            "score": round(self.score, 2), "legs_visibility": round(self.legs_visibility, 2),
        }
        if self.sweep:
            d["sweep"] = {
                "arm": self.sweep.side, "sweep_deg": round(self.sweep.sweep_deg, 1),
                "peak_speed_dps": round(self.sweep.peak_speed, 1), "peak_frame": self.sweep.peak_frame,
                "start_frame": self.sweep.start_frame, "end_frame": self.sweep.end_frame,
            }
        return d


def _arm_angles(dets: list[Detection], sh: int, wr: int, min_conf: float = 0.25):
    frames, ang = [], []
    for d in dets:
        if d.kc[sh] >= min_conf and d.kc[wr] >= min_conf:
            v = d.kp[wr] - d.kp[sh]
            h = max(d.box[3] - d.box[1], 1.0)
            if np.linalg.norm(v) < 0.08 * h:  # wrist on top of shoulder: angle undefined
                continue
            frames.append(d.frame)
            ang.append(np.arctan2(v[1], v[0]))
    return np.asarray(frames), np.asarray(ang)


def best_sweep(dets: list[Detection], fps: float, side: str) -> ArmSweep | None:
    sh, wr = (L_SH, L_WR) if side == "left" else (R_SH, R_WR)
    f, a = _arm_angles(dets, sh, wr)
    if len(f) < 5:
        return None
    max_gap = max(2, int(round(0.1 * fps)))
    steps = []  # (frame_from, frame_to, dtheta)
    for i in range(1, len(f)):
        gap = f[i] - f[i - 1]
        if gap > max_gap:
            continue
        d = (a[i] - a[i - 1] + np.pi) % (2 * np.pi) - np.pi
        if abs(d) > np.radians(110) * gap:  # implausible jump (keypoint swap / misdetection)
            continue
        steps.append((f[i - 1], f[i], d))
    if len(steps) < 4:
        return None
    win = max(6, int(round(0.7 * fps)))
    best = None
    for j in range(len(steps)):
        total = 0.0
        for k in range(j, len(steps)):
            if steps[k][1] - steps[j][0] > win:
                break
            total += steps[k][2]
            if best is None or abs(total) > abs(best[0]):
                best = (total, steps[j][0], steps[k][1])
    if best is None:
        return None
    total, s0, s1 = best
    direction = 1 if total > 0 else -1
    # peak angular speed over short (~3 frames at 30-60 fps) windows, in the sweep direction; a window always
    # holds at least one step so a strided scan (steps spanning several frames) still measures speed
    pw = max(3, int(round(0.05 * fps)))
    peak, peak_f = 0.0, s0
    for j in range(len(steps)):
        acc, k = 0.0, j
        while k < len(steps) and (k == j or steps[k][1] - steps[j][0] <= pw):
            acc += steps[k][2]
            k += 1
        dt = (steps[k - 1][1] - steps[j][0]) / fps
        if dt > 0 and acc * direction / dt > peak:
            peak = acc * direction / dt
            peak_f = int((steps[j][0] + steps[k - 1][1]) // 2)
    return ArmSweep(side, float(np.degrees(abs(total))), float(np.degrees(peak)), int(s0), int(s1), peak_f, direction)


def _overhead(dets: list[Detection]) -> int:
    n = 0
    for d in dets:
        h = max(d.box[3] - d.box[1], 1.0)
        head_y = d.kp[NOSE][1] if d.kc[NOSE] > 0.3 else d.box[1] + 0.08 * h
        for wr in (L_WR, R_WR):
            if d.kc[wr] > 0.3 and d.kp[wr][1] < head_y - 0.05 * h:
                n += 1
                break
    return n


def score_tracks(tracks: dict[int, list[Detection]], shot: int, fps: float, frame_h: int,
                 stride: int = 1) -> list[TrackScore]:
    out = []
    min_len = max(5, int(round(0.5 * fps / stride)))
    for tid, dets in tracks.items():
        if len(dets) < min_len:
            continue
        hs = np.array([d.box[3] - d.box[1] for d in dets])
        sweeps = [s for s in (best_sweep(dets, fps, "left"), best_sweep(dets, fps, "right")) if s]
        sweep = max(sweeps, key=lambda s: s.sweep_deg) if sweeps else None
        over = _overhead(dets)
        score = 0.0
        if sweep:
            # sweep >= ~240 deg with a fast peak is the delivery; saturate to avoid rewarding noise
            score += min(sweep.sweep_deg, 380.0) / 100.0 * 2.0
            score += min(sweep.peak_speed, 1500.0) / 500.0
        score += min(over, 6) * 0.15
        rel_h = float(np.median(hs)) / frame_h
        if rel_h < 0.06:
            score *= 0.5   # too small to analyse reliably anyway
        mean_conf = float(np.mean([d.kc[[L_SH, R_SH, L_HIP, R_HIP]].mean() for d in dets]))
        score *= 0.5 + 0.5 * min(1.0, mean_conf / 0.7)
        # A delivery we can analyse shows the whole body: feet/knees must be visible around the arm sweep.
        # (Waist-up close-ups of celebrating players also wave their arms, but never show the legs.)
        legs = _legs_visibility(dets, sweep, fps) if sweep else 0.0
        score *= 0.15 + 0.85 * legs
        # a batter's swing sweeps the arms just as fast, but with both hands on the bat: wrists together through
        # ~all of it (a club batter: 100%; a bowler filmed from behind, arms overlapping in the image: ~75%)
        if sweep and _two_handed(dets, sweep) > 0.9:
            score *= 0.3
        out.append(TrackScore(tid, shot, len(dets), dets[0].frame, dets[-1].frame, float(np.median(hs)),
                              sweep, over, score, legs))
    return sorted(out, key=lambda t: -t.score)


def _legs_visibility(dets: list[Detection], sweep: ArmSweep, fps: float) -> float:
    lo = sweep.start_frame - int(0.5 * fps)
    hi = sweep.end_frame + int(0.2 * fps)
    window = [d for d in dets if lo <= d.frame <= hi]
    if not window:
        return 0.0
    ok = 0
    for d in window:
        ankles = max(d.kc[15], d.kc[16])
        knees = max(d.kc[13], d.kc[14])
        ok += 1 if (ankles > 0.35 and knees > 0.35) else 0
    return ok / len(window)


def _two_handed(dets: list[Detection], sweep: ArmSweep) -> float:
    """Share of the arm sweep with both wrists together (< 12% of height apart): both hands on a bat."""
    n = together = 0
    for d in dets:
        if not (sweep.start_frame <= d.frame <= sweep.end_frame) or d.kc[L_WR] <= 0.3 or d.kc[R_WR] <= 0.3:
            continue
        n += 1
        h = max(d.box[3] - d.box[1], 1.0)
        together += float(np.linalg.norm(d.kp[L_WR] - d.kp[R_WR])) < 0.12 * h
    return together / n if n >= 3 else 0.0


def is_delivery(ts: TrackScore) -> bool:
    s = ts.sweep
    return bool(s and s.sweep_deg >= 200 and s.peak_speed >= 450)
