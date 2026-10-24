"""End-to-end analysis of one bowling video."""
from __future__ import annotations

import json
import os
import shutil
import logging
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import numpy as np

from . import config
from .store import write_atomic
from .bowler import TrackScore, is_delivery, score_tracks
from .detect import COCO_FLIP, COCO_NAMES, detections_by_track, refine_on_crops, square_crop
from .events import (PELVIS, Side, classify_view, decide_bowling_arm, detect_events, facing_direction, stabilise,
                     stride_across)
from .kinematics import estimate_world_frame, reconstruct
from .lifting import sam3d
from .lifting.motionbert import H36M_NAMES, H36M_PARENTS, coco_to_h36m, lift

H36M_PARENTS_LIST = list(H36M_PARENTS)
H36M_FLIP = [0, 4, 5, 6, 1, 2, 3, 7, 8, 9, 10, 14, 15, 16, 11, 12, 13]
from .pose2d import assemble, body_height_px, fix_swaps, hampel, interpolate_gaps, smooth_keypoints
from .tracking import detect_frames, track
from .video import VideoError, VideoInfo, iter_frames, probe, write_jpeg

log = logging.getLogger("bowlnet")

# weights = typical share of the run time (measured on broadcast clips: detection dominates), so the
# progress bar and the time-left estimate move steadily
STAGES = [
    ("probe", "Reading video", 0.05),
    ("detect", "Detecting & tracking people", 0.62),
    ("select", "Identifying the bowler", 0.01),
    ("pose2d", "High-precision 2D pose", 0.24),
    ("lift", "3D reconstruction", 0.02),
    ("events", "Detecting delivery events", 0.03),
    ("metrics", "Biomechanics & coaching", 0.01),
    ("mesh", "Fitting 3D body model", 0.01),
    ("save", "Saving results", 0.01),
]


class AnalysisError(RuntimeError):
    """User-facing failure with a helpful message (and optionally a suggested option change, e.g. clip speed)."""

    def __init__(self, message: str, suggest: dict | None = None):
        super().__init__(message)
        self.suggest = suggest or {}


SLOWMO_CHOICES = (1, 2, 3, 4, 5, 6, 8, 10)   # clip-speed factors offered in the UI


@dataclass
class Options:
    bowling_arm: str = "auto"        # auto | right | left
    height_m: float | None = None    # athlete stature; default used when None
    slowmo_factor: float = 1.0       # >1 if the clip is slowed down (e.g. 4 for 120->30 fps replay)
    shot: int | None = None          # force a particular shot index
    candidate: int | None = None     # force a particular delivery candidate (index into candidates)

    @staticmethod
    def from_dict(d: dict | None) -> "Options":
        d = d or {}
        o = Options()
        for k in ("bowling_arm", "height_m", "slowmo_factor", "shot", "candidate"):
            if k in d and d[k] is not None:
                setattr(o, k, d[k])
        if o.bowling_arm not in ("auto", "right", "left"):
            o.bowling_arm = "auto"
        try:
            h = float(o.height_m) if o.height_m is not None else None
        except (TypeError, ValueError):
            h = None
        o.height_m = float(np.clip(h, 1.2, 2.3)) if h is not None and np.isfinite(h) else None
        try:
            f = float(o.slowmo_factor or 1.0)
        except (TypeError, ValueError):
            f = 1.0
        o.slowmo_factor = float(np.clip(f, 1.0, 20.0)) if np.isfinite(f) else 1.0
        for k in ("shot", "candidate"):
            v = getattr(o, k)
            setattr(o, k, int(v) if isinstance(v, (int, float)) and np.isfinite(v) else None)
        return o


DEFAULT_HEIGHT_M = 1.80
# A delivery stride (back-foot to front-foot contact to release) lasts ~0.2-0.3 s. Below ~20 distinct frames per
# second it spans 4-5 frames and release lands on the wrong part of the action depending on the sampling phase
# (verified on 10 and 15 fps resamplings of broadcast clips), so such clips are refused instead of mis-measured.
MIN_FPS = 20.0
DEPTH_W_SAM3D = 20.0   # skeleton-fit depth weight for SAM 3D Body input (synthetic side-on PA-MPJPE 78 -> 74 mm)


class Progress:
    def __init__(self, cb: Callable[[dict], None] | None):
        self.cb = cb
        self.done = 0.0
        self.t0 = time.time()

    def stage(self, key: str, frac: float = 0.0, detail: str | None = None):
        if not self.cb:
            return
        acc = 0.0
        for k, label, w in STAGES:
            if k == key:
                self.cb({"stage": key, "label": label, "progress": round(min(0.999, acc + w * frac), 4),
                         "detail": detail, "elapsed": round(time.time() - self.t0, 1)})
                return
            acc += w


def _box_iou(a, b) -> float:
    ix1, iy1 = max(a[0], b[0]), max(a[1], b[1])
    ix2, iy2 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
    u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return float(inter / u) if u > 0 else 0.0


def _select(info: VideoInfo, per_shot: dict[int, list], opts: Options, stride: int = 1,
            fps: float | None = None) -> tuple[list[TrackScore], TrackScore]:
    """fps: real-time frame rate (video fps x slow-motion factor), so arm speeds and windows are in real time."""
    fps = fps or info.fps
    scores: list[TrackScore] = []
    for si, dets in per_shot.items():
        scores += score_tracks(detections_by_track(dets), si, fps, info.height, stride)
    scores.sort(key=lambda s: -s.score)
    deliveries = [s for s in scores if is_delivery(s)]
    if opts.shot is not None and opts.shot in per_shot:
        deliveries = ([s for s in deliveries if s.shot == opts.shot]
                      or [s for s in scores if s.shot == opts.shot and s.sweep is not None])
    if not deliveries:
        if scores and scores[0].sweep and scores[0].sweep.sweep_deg > 150:
            deliveries = [scores[0]]
        else:
            raise AnalysisError(
                "We couldn't find a bowling delivery in this video. Make sure the bowler's full body is visible "
                "from run-up to follow-through, ideally filmed side-on or from behind the bowler.")
    # only offer plausible deliveries: whole body visible and comparable in strength to the best one
    best_score = deliveries[0].score if deliveries else 0.0
    deliveries = [d for d in deliveries if d is deliveries[0] or (d.legs_visibility >= 0.5 and d.score >= 0.4 * best_score)]
    # de-duplicate: one candidate per (shot, overlapping time window)
    uniq: list[TrackScore] = []
    for d in deliveries:
        if all(not (d.shot == u.shot and abs(d.sweep.peak_frame - u.sweep.peak_frame) < fps * 0.8) for u in uniq):
            uniq.append(d)
    idx = opts.candidate if opts.candidate is not None and 0 <= opts.candidate < len(uniq) else 0
    return uniq, uniq[idx]


def analyse(video_path: str, out_dir: Path, opts: Options | None = None,
            progress_cb: Callable[[dict], None] | None = None, overrides: dict | None = None) -> dict:
    """overrides: light-stage corrections to apply to the fresh result (e.g. body-model gender)."""
    opts = opts or Options()
    prog = Progress(progress_cb)
    out_dir.mkdir(parents=True, exist_ok=True)
    t_start = time.time()

    # ---------------- probe ----------------
    prog.stage("probe", 0.0)
    try:
        info = probe(video_path, progress=lambda f: prog.stage("probe", f))
    except VideoError as e:
        raise AnalysisError(str(e)) from e
    if info.duration > config.MAX_VIDEO_SECONDS * opts.slowmo_factor:
        raise AnalysisError(f"Video is {info.duration:.0f}s long; please trim it to under "
                            f"{config.MAX_VIDEO_SECONDS:.0f}s around the delivery.")
    if info.frame_count < 12:
        raise AnalysisError("Video is too short to analyse.")
    real_fps = info.fps * opts.slowmo_factor
    if real_fps < MIN_FPS - 0.5:
        raise AnalysisError(f"This clip has only {real_fps:.0f} frames per second. A delivery stride lasts about 0.2 s, so "
                            f"at least {MIN_FPS:.0f} fps is needed. Phones film at 30 fps or more; 120–240 fps slow motion "
                            "is best. (If the clip plays in slow motion, set its clip speed.)")

    # ---------------- detect + track every usable shot ----------------
    shots = [(i, s) for i, s in enumerate(info.shots) if s.length >= max(10, int(0.4 * info.fps))]
    if opts.shot is not None:
        shots = [(i, s) for i, s in shots if i == opts.shot] or shots
    total_frames = sum(s.length for _, s in shots) or 1
    # long clips: scan at half rate to find the delivery, then re-detect the delivery window at full rate
    # adaptive: ~350 scanned frames is plenty to find the delivery, but keep >= ~12 fps effective so the arm
    # sweep is still sampled (240 fps slow-motion clips get a large stride, short 30 fps clips none)
    scan_stride = int(np.clip(int(np.ceil(total_frames / 350.0)), 1, max(1, int(info.fps // 12))))
    done = 0
    per_shot: dict[int, list] = {}
    motions: dict[int, np.ndarray] = {}
    scan_weight = 0.75 if scan_stride > 1 else 1.0
    for si, s in shots:
        fds = detect_frames(video_path, s.start, s.end, stride=scan_stride,
                            progress=lambda f, d0=done, n=s.length: prog.stage("detect", scan_weight * (d0 + f * n) / total_frames))
        per_shot[si] = track(fds, info.fps / scan_stride)
        for fd in fds:
            motions[fd.frame] = fd.motion
        done += s.length
    prog.stage("select", 0.0)
    candidates, chosen = _select(info, per_shot, opts, scan_stride, real_fps)
    shot = info.shots[chosen.shot]
    tracks = detections_by_track(per_shot[chosen.shot])
    bowler_dets = tracks[chosen.track]
    if scan_stride > 1:
        pk0 = chosen.sweep.peak_frame
        w0 = max(shot.start, bowler_dets[0].frame, pk0 - int(2.5 * real_fps))
        w1 = min(shot.end, bowler_dets[-1].frame + 1, pk0 + int(1.2 * real_fps))
        fds = detect_frames(video_path, w0, w1,
                            progress=lambda f: prog.stage("detect", scan_weight + (1 - scan_weight) * f))
        full = detections_by_track(track(fds, info.fps))
        for fd in fds:
            motions[fd.frame] = fd.motion
        scan_boxes = {d.frame: d.box for d in bowler_dets}
        def overlap(dets):
            ious = [_box_iou(d.box, scan_boxes[d.frame]) for d in dets if d.frame in scan_boxes]
            return (np.mean(ious) if ious else 0.0) * min(1.0, len(ious) / 5.0)
        best = max(full.values(), key=overlap, default=None)
        if best is not None and overlap(best) > 0.3:
            # keep the full-rate track, and fill any frames it misses from the scan track
            got = {d.frame for d in best}
            bowler_dets = sorted(best + [d for d in bowler_dets if d.frame not in got and w0 <= d.frame < w1],
                                 key=lambda d: d.frame)

    # analysis window: from up to 2.5 s (real time) before release to 1.2 s after, inside the track
    pk = chosen.sweep.peak_frame
    f0 = max(bowler_dets[0].frame, pk - int(2.5 * real_fps))
    f1 = min(bowler_dets[-1].frame + 1, pk + int(1.2 * real_fps))
    rep = info.repeated_fraction(f0, f1)
    distinct = real_fps * (1.0 - rep)
    if distinct < MIN_FPS - 0.5:
        n = 1.0 / max(1e-3, 1.0 - rep)                       # each frame is shown ~n times
        factor = min(SLOWMO_CHOICES, key=lambda c: abs(c - n))
        if n >= 1.5 and factor > opts.slowmo_factor:
            # frame-repeat slow motion: the repeats are the slow-down
            raise AnalysisError(f"Most frames in this clip are repeats (each shown ~{n:.1f}x), leaving only "
                                f"~{distinct:.0f} distinct frames per second. If the clip was slowed down, analyse it "
                                f"again with the clip speed set to {factor}x; otherwise film at 30 fps or more.",
                                suggest={"slowmo_factor": factor})
        raise AnalysisError(f"This clip has only ~{distinct:.0f} distinct frames per second (many frames are repeats). "
                            f"A delivery stride lasts about 0.2 s, so at least {MIN_FPS:.0f} fps is needed; film at "
                            "30 fps or more.")
    det_by_frame = {d.frame: d for d in bowler_dets if f0 <= d.frame < f1}
    # interpolate boxes over short tracker gaps so the refiner still gets a crop
    frames_needed = list(range(f0, f1))
    known = sorted(det_by_frame)
    boxes = {}
    for fr in frames_needed:
        if fr in det_by_frame:
            boxes[fr] = det_by_frame[fr].box
        else:
            prev = max([k for k in known if k < fr], default=None)
            nxt = min([k for k in known if k > fr], default=None)
            if prev is not None and nxt is not None and nxt - prev <= int(0.5 * info.fps):
                a = (fr - prev) / (nxt - prev)
                boxes[fr] = (1 - a) * det_by_frame[prev].box + a * det_by_frame[nxt].box

    # ---------------- top-down 2D + display frames ----------------
    # display frames go to a staging folder that replaces frames/ together with stage A, so a re-analysis that
    # fails part-way leaves the previous result (frames included) intact
    frames_dir = out_dir / "frames.new"
    shutil.rmtree(frames_dir, ignore_errors=True)
    frames_dir.mkdir()
    crops, invs, tboxes, cframes = [], [], [], []
    display_scale = 1.0
    refined_all = []
    n_needed = len(frames_needed)
    for k, (fr, img) in enumerate(iter_frames(video_path, f0, f1)):
        display_scale = write_jpeg(frames_dir / f"{fr:06d}.jpg", img, config.FRAME_JPEG_MAX_SIDE,
                                   config.FRAME_JPEG_QUALITY)
        if fr in boxes:
            c, inv = square_crop(img, boxes[fr], config.REFINE_IMGSZ, 1.35)
            crops.append(c); invs.append(inv); tboxes.append(boxes[fr]); cframes.append(fr)
        if len(crops) >= 32:
            refined_all += refine_on_crops(crops, invs, tboxes, cframes)
            crops, invs, tboxes, cframes = [], [], [], []
        prog.stage("pose2d", (k + 1) / max(1, n_needed))
    if crops:
        refined_all += refine_on_crops(crops, invs, tboxes, cframes)
    refined_frames = [r.frame for r in refined_all if r is not None]
    refined_list = [r for r in refined_all if r is not None]
    kp, kc = assemble(refined_frames, refined_list, det_by_frame, f0, f1)
    fps = real_fps   # filters and the lifter work in real time (slow-motion clips have more frames per second)
    kc = hampel(kp, kc, fps)
    kp, kc, n_swaps = fix_swaps(kp, kc)
    kp, kc = interpolate_gaps(kp, kc, fps)
    kp_s = smooth_keypoints(kp, fps)

    # Broadcast cameras zoom in on the bowler after release (and phone clips can lose them off the edge of the
    # frame): the keypoints there are junk and would end up as a broken follow-through. End the window at the
    # first frame after release where tracking collapses or the camera has zoomed in hard since release.
    T_use = _usable_length(kc, [motions.get(fr) for fr in range(f0, f1)], pk - f0, fps)
    if T_use < f1 - f0:
        f1 = f0 + T_use
        kp, kc, kp_s = kp[:T_use], kc[:T_use], kp_s[:T_use]
        frames_needed = frames_needed[:T_use]

    # ---------------- 3D lifting ----------------
    prog.stage("lift", 0.0)
    seq = coco_to_h36m(kp_s, kc)
    pose3d = "motionbert"
    X = None
    if sam3d.available():
        # image-based 3D (SAM 3D Body) on the bowler crops; ~30 analysed frames per real second is plenty
        try:
            stride = max(1, int(round(info.fps / 30.0)))
            X, _ = sam3d.lift_frames(iter_frames(video_path, f0, f1), boxes, f0, f1 - f0,
                                     progress=lambda f: prog.stage("lift", 0.95 * f), stride=stride)
            pose3d = "sam3d"
        except Exception as e:   # noqa: BLE001 - fall back to the temporal lifter rather than fail the analysis
            log.warning("SAM 3D Body failed (%s); using MotionBERT", e)
            X = None
    if X is None:
        X = lift_resampled(seq, fps)
    mot = np.stack([motions.get(fr, np.array([[1, 0, 0], [0, 1, 0]], np.float32)) for fr in range(f0, f1)])
    mot[0] = np.array([[1, 0, 0], [0, 1, 0]], np.float32)
    bbox = np.array([boxes.get(fr, np.full(4, np.nan)) for fr in range(f0, f1)], np.float32)
    np.savez_compressed(out_dir / "stage_a.tmp.npz", X=X, seq=seq, kp=kp, kp_s=kp_s, kc=kc, motions=mot, bbox=bbox,
                        timestamps=info.timestamps.astype(np.float64))
    os.replace(out_dir / "stage_a.tmp.npz", out_dir / "stage_a.npz")
    stage_a = {
        "version": 3,
        "video": info.to_dict(),
        "analysis_window": {"start": f0, "end": f1},
        "display_scale": display_scale,
        "fps": info.fps,
        "options": opts.__dict__,
        "bowler": {"track": chosen.track, "shot": chosen.shot, "score": chosen.to_dict()},
        "sweep": {"side": chosen.sweep.side, "start": chosen.sweep.start_frame, "end": chosen.sweep.end_frame,
                  "peak": chosen.sweep.peak_frame, "peak_speed_dps": chosen.sweep.peak_speed},
        "candidates": [c.to_dict() for c in candidates],
        "pose3d": pose3d,
        "quality": {"lr_swaps_fixed": int(n_swaps), "mean_kp_conf": round(float(kc.mean()), 3),
                    "frames_refined": len(refined_list), "frames_total": int(f1 - f0),
                    "repeated_frames": round(info.repeated_fraction(f0, f1), 3)},
        "timing_stage_a_s": round(time.time() - t_start, 1),
    }
    write_atomic(out_dir / "stage_a.json", json.dumps(stage_a))
    shutil.rmtree(out_dir / "frames", ignore_errors=True)
    os.replace(frames_dir, out_dir / "frames")
    prog.stage("lift", 1.0)
    result = stage_b(out_dir, overrides, progress=prog)
    result["timing_s"] = round(time.time() - t_start, 1)
    write_atomic(out_dir / "analysis.json", json.dumps(result))
    prog.stage("save", 1.0)
    return result


def _usable_length(kc: np.ndarray, motions: list, peak: int, fps: float, min_conf: float = 0.6,
                   max_zoom: float = 1.35) -> int:
    """Number of leading frames worth analysing: stops at the first frame (from ~0.1 s after the arm-sweep peak)
    where the bowler's mean keypoint confidence drops below min_conf, or the camera has zoomed in by more than
    max_zoom since the peak (broadcast close-up after release)."""
    T = len(kc)
    start = max(0, min(T, peak + max(2, int(round(0.1 * fps)))))
    zoom = 1.0
    for t in range(max(1, peak + 1), T):
        m = motions[t] if t < len(motions) else None
        if m is not None:
            zoom *= float(np.sqrt(abs(np.linalg.det(np.asarray(m)[:, :2]))))
        if t >= start and (float(kc[t, 5:].mean()) < min_conf or zoom > max_zoom):
            return t
    return T


def lift_resampled(seq: np.ndarray, fps: float) -> np.ndarray:
    """MotionBERT was trained on 50 fps H36M. Resample the 2D to ~50 fps, lift, and map back.
    For high frame rates use phase-shifted strided passes so no temporal detail is lost."""
    T = len(seq)
    if 40 <= fps <= 65 or T < 8:
        return lift(seq)
    if fps > 65:
        k = int(round(fps / 50.0))
        out = np.zeros((T, 17, 3), np.float32)
        for ph in range(k):
            idx = np.arange(ph, T, k)
            if len(idx) < 4:
                idx = np.arange(T)
            out[idx] = lift(seq[idx])
        return out
    # low fps (e.g. 25/30): upsample with linear interpolation, lift, sample back
    t_src = np.arange(T) / fps
    n_dst = int(np.floor(t_src[-1] * 50.0)) + 1
    t_dst = np.arange(n_dst) / 50.0
    up = np.empty((n_dst, 17, 3), np.float32)
    for j in range(17):
        for c in range(3):
            up[:, j, c] = np.interp(t_dst, t_src, seq[:, j, c])
    X50 = lift(up)
    out = np.empty((T, 17, 3), np.float32)
    for j in range(17):
        for c in range(3):
            out[:, j, c] = np.interp(t_src, t_dst, X50[:, j, c])
    return out


EVENT_LABELS = {"bfc": "Back-foot contact", "ffc": "Front-foot contact", "uah": "Upper arm horizontal",
                "br": "Ball release", "ft": "Follow-through"}


ORDER_RULES = [("bfc", "ffc"), ("ffc", "br"), ("bfc", "br"), ("uah", "br"), ("br", "ft")]


def _reconcile_auto_events(ev, edited: list[str], T: int) -> None:
    """After an edit every automatic event must still respect the delivery order. An automatic event on the
    wrong side of another one (a user-placed marker, or another automatic event squeezed against it at the
    window edge) is moved next to it and flagged as an estimate; if there is no room it is dropped. Release
    anchors everything else, so an automatic release is never moved (_check_event_order explains instead)."""
    def to_move(a: str, b: str) -> str | None:
        if a in edited and b in edited:
            return None
        if a in edited or b in edited:
            auto = b if a in edited else a
            return None if auto == "br" else auto
        return b if a == "br" else a   # both automatic: keep release, else move the earlier event back

    for it in range(4):
        changed = False
        for a, b in ORDER_RULES:
            fa, fb = getattr(ev, a), getattr(ev, b)
            if fa is None or fb is None or fa < fb:
                continue
            auto = to_move(a, b)
            if auto is None:
                continue
            new = (fa + 1 if auto == b else fb - 1) if it < 3 else None   # still squeezed: no room for it
            setattr(ev, auto, new if new is not None and 0 <= new < T else None)
            ev.method[auto] = "constrained"
            ev.confidence[auto] = min(ev.confidence.get(auto, 0.5), 0.25)
            changed = True
        if not changed:
            return


def _check_event_order(ev, edited: list[str], f0: int, latest: list[str] | None = None) -> None:
    """User-edited events must respect the delivery sequence BFC < FFC < BR < FT and UAH < BR."""
    for a, b in ORDER_RULES:
        fa, fb = getattr(ev, a), getattr(ev, b)
        if fa is None or fb is None or fa < fb:
            continue
        if a in edited or b in edited:
            # point at the marker the user just moved when it is part of the conflict
            moved = next((k for k in (latest or []) if k in (a, b)), b if b in edited else a)
            other = a if moved == b else b
            hint = (f"Move the {EVENT_LABELS[moved].lower()} marker to a frame in the right order"
                    + ("." if other in edited else
                       f", or first correct the automatic {EVENT_LABELS[other].lower()} if it is wrong."))
            raise AnalysisError(
                f"{EVENT_LABELS[a]} (frame {fa + f0}) must come before {EVENT_LABELS[b].lower()} (frame {fb + f0}). "
                + hint)


def stage_b(out_dir: Path, overrides: dict | None = None, progress: Progress | None = None) -> dict:
    """Everything after 3D lifting: metric skeleton, events, metrics, coaching, body mesh, exports.
    Fast (< 1-2 s) so the UI can re-run it when the user edits events, height or bowling arm."""
    from .body.export import export_mesh, world_to_three
    from .coaching import coach
    from .metrics import Ctx, compute

    overrides = overrides or {}
    prog = progress or Progress(None)
    A = np.load(out_dir / "stage_a.npz")
    meta = json.loads((out_dir / "stage_a.json").read_text())
    X, seq, kp_s, kc, mot = A["X"], A["seq"], A["kp_s"], A["kc"], A["motions"]
    ts_all = A["timestamps"]
    f0, f1 = meta["analysis_window"]["start"], meta["analysis_window"]["end"]
    T = f1 - f0
    # clip speed is a stage-A option (it sets the analysis window and filters), so it is not overridable here
    opts = Options.from_dict({**meta["options"], **{k: v for k, v in overrides.items()
                                                    if k in ("bowling_arm", "height_m")}})
    fps = float(meta["fps"])
    real_fps = fps * opts.slowmo_factor
    height = opts.height_m or DEFAULT_HEIGHT_M
    sweep = meta["sweep"]
    # an image-based 3D model's depth deserves more trust than a 2D-to-3D lifter's (tuned on synthetic ground truth)
    depth_w = DEPTH_W_SAM3D if meta.get("pose3d") == "sam3d" else None
    prog.stage("events", 0.1)

    sweep_lo = int(np.clip(sweep["start"] - f0, 0, T - 1))
    sweep_hi = int(np.clip(sweep["end"] - f0, 0, T - 1))
    arm_window = (sweep_lo - int(0.1 * real_fps), sweep_hi + int(0.1 * real_fps))
    skel = reconstruct(X, seq[..., :2], seq[..., 2], height, real_fps, depth_w=depth_w)
    P = skel.joints
    labels_swapped = False
    if opts.bowling_arm == "auto":
        arm, arm_conf, votes = decide_bowling_arm(kp_s, kc, P, real_fps, sweep["side"], arm_window)
    else:
        arm, arm_conf, votes = opts.bowling_arm, 1.0, {"user": 1.0}
        auto_arm, auto_conf, av = decide_bowling_arm(kp_s, kc, P, real_fps, sweep["side"], arm_window)
        other = -1.0 if arm == "right" else 1.0
        if av.get("speed_2d") == other and av.get("fast_high_2d") == other:
            # Every cue says the *other* arm bowls: the detector labelled left/right as if the bowler faced the
            # other way (front/back ambiguity). Mirror the labels consistently in 2D and 3D.
            kp_s, kc = np.ascontiguousarray(kp_s[:, COCO_FLIP]), np.ascontiguousarray(kc[:, COCO_FLIP])
            X, seq = np.ascontiguousarray(X[:, H36M_FLIP]), np.ascontiguousarray(seq[:, H36M_FLIP])
            skel = reconstruct(X, seq[..., :2], seq[..., 2], height, real_fps, depth_w=depth_w)
            P = skel.joints
            labels_swapped = True
    side = Side.for_arm(arm)
    up0 = np.array([0.0, -1.0, 0.0])
    runup = np.arange(0, max(0, sweep_lo - int(0.35 * real_fps)))
    hint_reliable = len(runup) >= max(4, int(0.2 * real_fps))
    if hint_reliable:
        forward_hint = facing_direction(P, up0, runup)
    else:
        rel = np.arange(min(T - 1, sweep_hi), min(T, sweep_hi + int(0.15 * real_fps) + 1))
        forward_hint = facing_direction(P, up0, rel if len(rel) else np.array([T - 1]))
    ref = min(T - 1, max(0, sweep_hi))
    kp_stab = stabilise(kp_s, mot, ref)
    body_px = body_height_px(kp_s, kc)
    peak = sweep["peak"] - f0
    # user-edited events (absolute frame numbers) are fixed; the others are detected around them
    fixed = {k: int(np.clip(int(v) - f0, 0, T - 1)) for k, v in (overrides.get("events") or {}).items()
             if k in ("bfc", "ffc", "uah", "br", "ft") and v is not None}
    edited = sorted(fixed)
    ev = detect_events(kp_s, kc, kp_stab, P, side, up0, forward_hint, real_fps, body_px, (sweep_lo, sweep_hi), peak,
                       fixed=fixed)
    wf = estimate_world_frame(P, ev.ffc, ev.bfc, side.front_ankle, side.back_ankle, forward_hint, hint_reliable)
    ev = detect_events(kp_s, kc, kp_stab, P, side, wf.up, wf.forward, real_fps, body_px, (sweep_lo, sweep_hi), peak,
                       fixed=fixed)
    if edited:
        _reconcile_auto_events(ev, edited, T)
        _check_event_order(ev, edited, f0, overrides.get("latest_events"))
        wf = estimate_world_frame(P, ev.ffc, ev.bfc, side.front_ankle, side.back_ankle, forward_hint, hint_reliable)
    # Second 3D pass with physics: while the front foot is planted (FFC -> just after release) it stays ahead of
    # its knee and of the pelvis along the direction of travel. This resolves the monocular depth-sign
    # ambiguity that otherwise folds the front leg in behind/front-on views.
    if ev.ffc is not None and ev.br > ev.ffc:
        stance = range(ev.ffc, min(T, ev.br + max(2, int(round(0.05 * real_fps))) + 1))
        fwd = wf.forward
        priors = [(stance, side.front_knee, side.front_ankle, fwd, -0.03),
                  (stance, PELVIS, side.front_ankle, fwd, 0.05)]
        skel = reconstruct(X, seq[..., :2], seq[..., 2], height, real_fps, priors=priors, depth_w=depth_w)
        P = skel.joints
        wf = estimate_world_frame(P, ev.ffc, ev.bfc, side.front_ankle, side.back_ankle, forward_hint, hint_reliable)
    stride_x = stride_across(kp_s, skel.px_per_m, float(skel.bone_lengths[1] + skel.bone_lengths[2]), side, ev.ffc, ev.br)
    view = classify_view(wf.forward, kp_s, kc, runup if len(runup) >= 4 else None, stride_x)
    if overrides.get("view") in ("side_on", "behind", "front_on"):
        view = {**{k: v for k, v in view.items() if k != "oblique"}, "view": overrides["view"], "source": "user"}
    oblique = bool(view.get("oblique"))
    prog.stage("metrics", 0.2)

    W = wf.to_world(P)
    rep = float(meta["quality"].get("repeated_frames") or 0.0)
    fps_unique = real_fps * (1.0 - rep)   # frame-repeat slow motion / frame-rate conversion add no information
    ctx = Ctx(P=P, W=W, kp=kp_s, kc=kc, side=side, wf=wf, view=view["view"], fps=real_fps, stature=height,
              k=skel.px_per_m, ev=ev, bone_lengths=skel.bone_lengths, fps_unique=fps_unique, oblique=oblique)
    mres = compute(ctx)
    coaching = coach(mres["metrics"], "oblique" if oblique else view["view"], fps_unique if rep >= 0.4 else real_fps)
    # a real delivery's arm turns at >~700°/s; much slower suggests a slowed-down (replay) clip
    peak_real = float(sweep.get("peak_speed_dps") or 0.0)   # measured in real time (stage A uses real fps)
    if meta.get("version", 2) < 3:
        peak_real *= opts.slowmo_factor
    if rep >= 0.4:
        # many frames are repeats: either "slow motion" made by repeating frames, or a low-frame-rate clip
        # converted up. Only the user knows which, so ask rather than assume.
        n = 1.0 / max(1e-3, 1.0 - rep)
        n_txt = f"{n:.0f}" if abs(n - round(n)) < 0.15 else f"{n:.1f}"
        if opts.slowmo_factor <= 1.0:
            coaching["capture_tips"].insert(0, f"Many frames in this clip are exact repeats (each shown ~{n_txt}x). If "
                                               f"it was slowed down, set its clip speed to ~{n_txt}x in Detection & "
                                               "settings so timings are correct; if it was filmed at a low frame rate, "
                                               f"timing precision is limited to ~{1000 / fps_unique:.0f} ms.")
        else:
            coaching["capture_tips"].insert(0, f"Each frame of this clip is repeated ~{n_txt}x, so only ~{fps_unique:.0f} "
                                               "distinct frames were captured per real second; precision follows that "
                                               "rate, not the slowed-down frame count.")
    elif 0 < peak_real < 650:
        coaching["capture_tips"].insert(0, f"The bowling arm peaks at only ~{peak_real:.0f}°/s, which is unusually slow "
                                           "for a real delivery. If this clip is a slowed-down replay, set its clip speed "
                                           "in Detection & settings so timings are correct.")
    prog.stage("mesh", 0.1)
    mesh_info = export_mesh(out_dir, W, height, gender=float(overrides.get("gender", meta["options"].get("gender", 0.0)) or 0.0),
                            bowling_arm=arm)
    prog.stage("save", 0.2)

    ds = meta["display_scale"]
    frames = list(range(f0, f1))
    result = {
        **{k: meta[k] for k in ("version", "video", "analysis_window", "display_scale", "bowler", "candidates",
                                "quality")},
        "fps": fps, "fps_real": real_fps,
        "pose3d": meta.get("pose3d", "motionbert"),
        "options": opts.__dict__,
        "bowling_arm": {"arm": arm, "confidence": round(float(arm_conf), 2), "votes": votes,
                        "source": "user" if opts.bowling_arm != "auto" else "auto", "labels_swapped": labels_swapped},
        "view": view,
        "world": wf.to_dict(),
        "events": ev.as_dict(f0, ts_all),
        "events_edited": edited,
        "metrics": mres["metrics"],
        "series": mres["series"],
        "coaching": coaching,
        "frames": {"start": f0, "end": f1, "times": [round(float(ts_all[f]), 4) for f in frames]},
        "keypoints2d": {
            "names": COCO_NAMES,
            "xy": np.round(kp_s * ds, 1).tolist(),
            "conf": np.round(kc, 2).tolist(),
        },
        "skeleton3d": {"names": H36M_NAMES, "parents": H36M_PARENTS_LIST, "coords": "three",
                       "joints": np.round(world_to_three(W + np.load(out_dir / "ground_offset.npy")[:, None, :]), 4).tolist()},
        "skeleton": {"bone_lengths_m": skel.bone_lengths.round(4).tolist(), "stature_m": height,
                     "height_source": "user" if opts.height_m else "default",
                     "reproj_err_px_median": round(float(np.median(skel.reproj_err_px)), 2)},
        "mesh": mesh_info,
    }
    if stage := meta.get("timing_stage_a_s"):
        result["timing_stage_a_s"] = stage
    return result
