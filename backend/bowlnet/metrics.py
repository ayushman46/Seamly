"""Biomechanics metrics, view-aware.

Every metric declares the anatomical plane it lives in. If that plane is (nearly) parallel to the image
plane for the detected camera view we measure it directly on the high-resolution 2D keypoints (the
approach validated for field biomechanics, e.g. Cottam 2016 for rear-view lateral flexion); otherwise we
use the reconstructed 3D skeleton and lower the confidence. Norms, thresholds and references are in
docs/RESEARCH.md; thresholds marked 'heuristic' are ±1-2 SD bands around elite norms, not published
cut-offs, and are labelled as such in the UI.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .events import Events, Side, PELVIS, THORAX
from .kinematics import WorldFrame, joint_angle, unit

ANKLE_HEIGHT_FRAC = 0.044      # ankle joint centre height / stature (Anny & anthropometric tables)
HAND_OFFSET_M = 0.07           # wrist joint -> ball centre at release


# ------------------------------------------------------------------------------------------------------
# norms and rating bands (see docs/RESEARCH.md)
# ------------------------------------------------------------------------------------------------------
NORMS = {
    # shown for reference only, never rated: on a rendered straight-armed delivery at 120 fps one camera read 12°
    "elbow_extension": dict(unit="deg",
                            norm="Legal bowlers: 0-10° (mean ~6°); ICC limit 15°",
                            ref="ICC Illegal Bowling Regulations; Ferdinands & Kersting 2005; King & Yeadon 2013"),
    "front_knee_ffc": dict(unit="deg", norm="Elite men 164 ± 6° at FFC", ref="Felton 2019"),
    "front_knee_br": dict(unit="deg", good=(160, None), watch=(140, 160), risk=None,
                          norm="Aim for 160° or straighter at release. Elite men average 167 ± 19°; a straighter front knee goes with faster bowling (r ≈ 0.4)",
                          ref="Felton 2019; Ramachandran 2024 meta-analysis"),
    "front_knee_flexion": dict(unit="deg", good=(None, 20), watch=(20, None), risk=None,
                               norm="Elite men flex 9 ± 11° after FFC (guide range)", ref="Felton 2019"),
    "back_knee_bfc": dict(unit="deg", good=(156, None), watch=(146, 156), risk=(None, 146),
                          norm="Injured bowlers 146° vs uninjured 156° at BFC (rear hip/knee)",
                          ref="Alway et al. 2021 (prospective, MRI)"),
    "trunk_forward_br": dict(unit="deg", good=(30, None), watch=(15, 30), risk=None,
                             norm="Elite men ~42 ± 5° forward at release (guide range)", ref="Felton 2019"),
    "trunk_flexion_ffc_br": dict(unit="deg", good=(25, None), watch=(15, 25), risk=None,
                                 norm="Elite men flex the trunk 31 ± 8° from FFC to release", ref="Felton 2019"),
    "trunk_lateral_br": dict(unit="deg", good=(None, 45), watch=(45, 50), risk=(50, None),
                             norm="Later-injured juniors 50 ± 6° vs uninjured 40 ± 8° (thorax lateral flexion at BR)",
                             ref="Bayne et al. 2016; contested in elite adults (Alway 2021)"),
    "shoulder_alignment_bfc": dict(unit="deg", norm="180 = side-on, 270 = front-on; side-on < 210, semi-open 210-240, front-on > 240",
                                   ref="Portus et al. 2004; elite men 232 ± 14 (Felton 2019)"),
    "hip_shoulder_sep_bfc": dict(unit="deg", good=(None, 20), watch=(20, 30), risk=(30, None),
                                 norm=">= 30° at BFC classifies a mixed action", ref="Portus et al. 2004"),
    "shoulder_counter_rotation": dict(unit="deg", good=(None, 30), watch=(30, 40), risk=(40, None),
                                      norm=">= 30° is the common mixed-action criterion (stronger evidence in juniors)",
                                      ref="Portus 2004; Elliott & Foster 1989; Ranson 2008; Alway 2021"),
    "release_height_pct": dict(unit="% height", good=(108, None), watch=(104, 108), risk=None,
                               norm="Elite men 113 ± 4% of standing height (guide range)", ref="Felton 2019"),
    "stride_length_pct": dict(unit="% height", good=(70, 87), watch=(64, 93), risk=None,
                              norm="Elite men 79 ± 7% of standing height (guide range)", ref="Felton 2019"),
    "ffc_to_br_ms": dict(unit="ms", good=(None, 140), watch=(140, None), risk=None,
                         norm="Elite men 103 ± 11 ms; juniors 126 ± 37 ms", ref="Felton 2019; Andrews 2024"),
    "bfc_to_ffc_ms": dict(unit="ms", norm="Elite men 192 ± 31 ms; juniors 197 ± 59 ms", ref="Felton 2019; Andrews 2024"),
    "arm_slot_br": dict(unit="deg", norm="Angle of the bowling arm from vertical at release (descriptive; higher slot often costs more side-bend)",
                        ref="descriptive"),
    "head_offset_br": dict(unit="cm", good=(None, 15), watch=(15, 30), risk=(30, None),
                           norm="Lateral distance of the head outside the front foot at release (heuristic; 'falling away')",
                           ref="coaching heuristic"),
    "runup_speed": dict(unit="m/s", norm="Elite men 5.8 ± 0.6 m/s; juniors 5.8 ± 0.7; finger spinners 2.5 ± 0.5",
                        ref="Felton 2019; Andrews 2024; Sanders 2018"),
}


def _rate(key: str, value: float | None) -> str:
    if value is None or key not in NORMS:
        return "info"
    n = NORMS[key]
    def inside(band):
        if band is None:
            return False
        lo, hi = band
        return (lo is None or value >= lo) and (hi is None or value < hi)
    if "good" not in n:
        return "info"
    if inside(n.get("risk")):
        return "risk"
    if inside(n.get("good")):
        return "good"
    if inside(n.get("watch")):
        return "watch"
    return "watch"


@dataclass
class Ctx:
    P: np.ndarray            # (T,17,3) camera axes, metres, root-relative
    W: np.ndarray            # (T,17,3) world (forward, lateral, up) coordinates
    kp: np.ndarray           # (T,17,2) COCO smoothed pixels
    kc: np.ndarray           # (T,17)
    side: Side
    wf: WorldFrame
    view: str
    fps: float
    stature: float
    k: np.ndarray            # (T,) px per metre
    ev: Events
    bone_lengths: np.ndarray
    fps_unique: float | None = None   # distinct frames per real second (repeated frames add no information)
    oblique: bool = False             # camera well off the pitch line: no plane-specific measurement is rated


def _img_angle_from_vertical(v: np.ndarray) -> np.ndarray:
    """Signed angle (deg) of image vector v (x right, y down) from image-up; + = towards image right."""
    return np.degrees(np.arctan2(v[..., 0], -v[..., 1]))


def _conf2d(c: Ctx, t: int, joints: list[int]) -> float:
    lo, hi = max(0, t - 1), min(len(c.kc), t + 2)
    return float(np.clip(np.mean(c.kc[lo:hi][:, joints]), 0, 1))


VIEW_LABEL = {"side_on": "side-on", "behind": "behind the bowler", "front_on": "front-on"}
# physically plausible ranges; estimates outside them are withheld rather than shown
PLAUSIBLE = {
    "stride_length_pct": (35, 130), "front_knee_ffc": (90, 185), "front_knee_br": (90, 185),
    "back_knee_bfc": (80, 185), "release_height_pct": (70, 140), "trunk_forward_br": (-30, 85),
    "trunk_flexion_ffc_br": (-30, 85), "trunk_lateral_br": (0, 75), "elbow_extension": (0, 60),
    "front_knee_flexion": (0, 70), "head_offset_br": (0, 120), "arm_slot_br": (0, 90),
    # projected-width alignment is very sensitive near front-on (arccos); withhold implausible readings
    "hip_shoulder_sep_bfc": (0, 45), "shoulder_counter_rotation": (0, 60), "shoulder_alignment_bfc": (160, 300),
}


def _metric(key, label, value, *, event=None, source="3d", confidence=0.5, decimals=1, explain="",
            extra=None, needs: tuple[str, ...] | None = None, view: str | None = None,
            min_fps: float | None = None, fps: float | None = None, tolerance: float = 0.0) -> dict:
    """needs: camera views in which this metric is measured reliably. Outside them the value is kept as a
    rough 3D estimate but not rated, not scored and not used for coaching priorities."""
    n = NORMS.get(key, {})
    v = None if value is None or not np.isfinite(value) else round(float(value), decimals)
    rating = _rate(key, v)
    if tolerance and v is not None and rating in ("watch", "risk"):
        # give the benefit of the measurement resolution (e.g. ± one frame for timings)
        better = [_rate(key, v + d) for d in (-tolerance, tolerance)]
        order = {"good": 0, "watch": 1, "risk": 2}
        best = min(better, key=lambda r: order.get(r, 3))
        if order.get(best, 3) < order.get(rating, 3):
            rating = best
    reliability = "measured"
    note = None
    conf = float(np.clip(confidence, 0, 1))
    withheld = None
    if needs and view not in needs:
        # The plane this metric lives in is not visible from this camera. Monocular 3D depth gives absolute
        # angles that can be far off (e.g. a 170° front knee read as 96° from behind), and nothing tells a
        # good estimate from a bad one, so the value is withheld (kept as estimate_3d in the JSON export).
        reliability = "estimate"
        where = "side-on or from behind the stumps" if len(needs) == 3 else " or ".join(VIEW_LABEL[x] for x in needs)
        note = ("The camera is at an angle to the pitch, so this can't be measured reliably — film "
                if view == "oblique" else "Not measurable from this camera view — film ") + where + " to measure it."
        rating = "unrated"
        conf = min(conf, 0.3)
        withheld, v = v, None
        lo_hi = PLAUSIBLE.get(key)
        if withheld is not None and lo_hi and not (lo_hi[0] <= withheld <= lo_hi[1]):
            withheld = None   # not even kept in the export when physically implausible
    if min_fps and fps is not None and fps < min_fps:
        reliability = "estimate"
        note = (note + " " if note else "") + f"Needs >= {min_fps:.0f} fps slow-motion for a reliable value."
        rating = "unrated"
        conf = min(conf, 0.25)
    lo_hi = PLAUSIBLE.get(key)
    if v is not None and lo_hi and not (lo_hi[0] <= v <= lo_hi[1]):
        if reliability == "estimate" or conf < 0.5:
            note = "Not measurable from this camera view." if needs and view not in needs else "Couldn't be measured reliably in this clip."
            v, rating, reliability, conf = None, "unrated", "estimate", min(conf, 0.2)
    if v is not None and rating not in ("unrated",) and conf < 0.25:
        rating = "unrated"
        reliability = "estimate"
        note = note or "Low tracking confidence around this event."
    d = {"key": key, "label": label, "value": v, "unit": n.get("unit", ""), "event": event, "source": source,
         "confidence": round(conf, 2), "rating": rating, "reliability": reliability, "note": note,
         "needs_view": list(needs) if needs else None,
         "norm": n.get("norm"), "ref": n.get("ref"), "explain": explain}
    if extra:
        d.update(extra)
    if needs and view not in needs:
        d["estimate_3d"] = withheld
    if d["value"] is None:   # nothing measured: drop what was derived from the number
        for k in ("technique", "action_type", "metres", "flexion_after_ffc", "extension_to_br", "min_frame"):
            d.pop(k, None)
    return d


# ------------------------------------------------------------------------------------------------------
# time series (used for charts and the per-frame inspector)
# ------------------------------------------------------------------------------------------------------

def time_series(c: Ctx) -> dict[str, list]:
    P, W, s = c.P, c.W, c.side
    up = c.wf.up
    trunk = P[:, THORAX] - P[:, PELVIS]
    tw = c.wf.to_world(trunk)
    fwd_flex = np.degrees(np.arctan2(tw[:, 0], tw[:, 2]))
    lat_flex = np.degrees(np.arctan2(tw[:, 1], tw[:, 2]))
    if s.bowling_arm == "left":
        lat_flex = -lat_flex
    sh = _alignment_series(c, "shoulder")
    hp = _alignment_series(c, "hip")
    out = {
        "elbow_flexion_bowling": (180 - joint_angle(P[:, s.shoulder], P[:, s.elbow], P[:, s.wrist])).tolist(),
        "elbow_flexion_front": (180 - joint_angle(P[:, s.front_shoulder], P[:, s.front_elbow], P[:, s.front_wrist])).tolist(),
        "knee_front": joint_angle(P[:, s.front_hip], P[:, s.front_knee], P[:, s.front_ankle]).tolist(),
        "knee_back": joint_angle(P[:, s.back_hip], P[:, s.back_knee], P[:, s.back_ankle]).tolist(),
        "trunk_forward_flexion": fwd_flex.tolist(),
        "trunk_lateral_flexion": lat_flex.tolist(),
        "shoulder_alignment": sh.tolist(),
        "hip_alignment": hp.tolist(),
        "hip_shoulder_separation": (sh - hp).tolist(),
        "bowling_arm_elevation": np.degrees(np.arcsin(np.clip(unit(P[:, s.wrist] - P[:, s.shoulder]) @ up, -1, 1))).tolist(),
        "bowling_wrist_height_pct": (100 * (W[:, s.wrist, 2] - np.minimum(W[:, s.front_ankle, 2], W[:, s.back_ankle, 2])
                                            + ANKLE_HEIGHT_FRAC * c.stature) / c.stature).tolist(),
        "front_knee_2d": joint_angle(c.kp[:, s.c_fhip], c.kp[:, s.c_fkn], c.kp[:, s.c_fan]).tolist(),
        "elbow_flexion_2d": (180 - joint_angle(c.kp[:, s.c_sh], c.kp[:, s.c_el], c.kp[:, s.c_wr])).tolist(),
        "trunk_angle_2d": _img_angle_from_vertical(
            (c.kp[:, 5] + c.kp[:, 6]) / 2 - (c.kp[:, 11] + c.kp[:, 12]) / 2).tolist(),
    }
    return {k: [round(float(x), 2) for x in v] for k, v in out.items()}


def _alignment_series(c: Ctx, which: str) -> np.ndarray:
    return _alignment_parts(c, which)[0]


def _alignment_parts(c: Ctx, which: str) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """(angle from 2D width + 3D sign, the 3D model's own angle, out-of-image-plane angle phi), per frame."""
    """Transverse-plane orientation of the shoulder (or hip) line, Portus convention:
    180° = side-on (line pointing down the pitch), 270° = front-on. Bowling-arm independent.

    For behind/front views the angle is recovered from the projected width (w = W cos(phi), phi = angle of
    the line out of the image plane) and only the sign comes from 3D; for side views the projection gives
    the complementary angle. W = 3D segment length x image scale."""
    s = c.side
    if which == "shoulder":
        a3, b3, a2, b2 = s.front_shoulder, s.shoulder, s.c_fsh, s.c_sh
    else:
        a3, b3, a2, b2 = s.front_hip, s.back_hip, s.c_fhip, s.c_bhip
    # 3D estimate: line from bowling-side joint to front-side joint, in the horizontal plane
    v = c.W[:, a3] - c.W[:, b3]
    ang3 = np.degrees(np.arctan2(v[:, 1] * (1 if s.bowling_arm == "right" else -1), v[:, 0]))  # 0 = pointing forward
    theta3 = 180 + np.abs(ang3)
    theta3 = np.clip(theta3, 180, 360)
    w = np.linalg.norm(c.kp[:, a2] - c.kp[:, b2], axis=1)
    # True line width in the 2D keypoints' own convention: the line swings through the image plane during a
    # delivery, so its widest (robust p95) projection is its length. The 3D model's joint distance can't be used:
    # its joints follow another convention (e.g. SAM 3D Body's hip joint centres are ~1/3 narrower than the 2D
    # hip keypoints, which pinned the hips at "front-on" and produced false 39° separations).
    ok = np.minimum(c.kc[:, a2], c.kc[:, b2]) > 0.3
    wk = w[ok] / np.maximum(c.k[ok], 1e-6) if ok.sum() >= 5 else np.zeros(0)
    L = float(np.percentile(wk, 95)) if len(wk) else float(np.median(np.linalg.norm(c.P[:, a3] - c.P[:, b3], axis=1)))
    ratio = np.clip(w / np.maximum(L * c.k, 1e-6), 0, 1)
    phi = np.degrees(np.arccos(ratio))  # angle of the line out of the image plane
    if c.view in ("behind", "front_on"):
        theta2 = 270 - phi                      # line in image plane = front-on (270), along depth = side-on (180)
        # beyond front-on (> 270) produces the same width; the 3D sign decides
        theta2 = np.where(theta3 > 270, 270 + phi, theta2)
    else:
        theta2 = 180 + phi                      # side camera: line in image plane = side-on
        # beyond front-on (> 270) the width shrinks again; the 3D sign decides the branch
        theta2 = np.where(theta3 > 270, 360 - phi, theta2)
    return theta2, theta3, phi


# ------------------------------------------------------------------------------------------------------
# event-locked metrics
# ------------------------------------------------------------------------------------------------------

SIDE = ("side_on",)
REAR = ("behind", "front_on")
SQUARE = ("side_on", "behind", "front_on")   # any view square to the pitch (only an angled camera is excluded)


def _leg_stature_px(c: Ctx, t: int) -> float | None:
    """Stature in pixels from the front leg's longest projection around frame t (thigh + shank = 0.491 H)."""
    s, kp, kc = c.side, c.kp, c.kc
    lo, hi = max(0, t - 2), min(len(kp), t + 3)
    total = 0.0
    for a, b in ((s.c_fhip, s.c_fkn), (s.c_fkn, s.c_fan)):
        ok = np.minimum(kc[lo:hi, a], kc[lo:hi, b]) > 0.3
        if not ok.any():
            return None
        total += float(np.linalg.norm(kp[lo:hi, a] - kp[lo:hi, b], axis=1)[ok].max())
    return total / 0.491


def _release_height_2d(c: Ctx):
    """Ball height at release from the image, scaled by the athlete's own body *at release*.

    At release the bowling arm is near-vertical and the front leg braced, so both lie close to the image
    plane in side and rear views; their pixel lengths divided by anthropometric segment ratios (upper arm +
    forearm = 0.332 H, thigh + shank = 0.491 H; Drillis & Contini 1966) give the stature in pixels right at
    that frame, independent of camera zoom or the bowler's distance from the camera."""
    s, br = c.side, c.ev.br
    kp, kc = c.kp, c.kc
    lo, hi = max(0, br - 2), min(len(kp), br + 3)
    def seg(a, b):
        # the longest projection near release is the least foreshortened one
        ok = np.minimum(kc[lo:hi, a], kc[lo:hi, b]) > 0.3
        if not ok.any():
            return float("nan")
        return float(np.linalg.norm(kp[lo:hi, a] - kp[lo:hi, b], axis=1)[ok].max())
    need = [s.c_sh, s.c_el, s.c_wr, s.c_fhip, s.c_fkn, s.c_fan]
    if float(kc[br][need].mean()) < 0.35:
        return None, None, None
    arm_px = seg(s.c_sh, s.c_el) + seg(s.c_el, s.c_wr)
    leg_px = seg(s.c_fhip, s.c_fkn) + seg(s.c_fkn, s.c_fan)
    est = [x for x in (arm_px / 0.332, leg_px / 0.491) if np.isfinite(x)]
    if not est:
        return None, None, None
    stature_px = float(max(est))                    # foreshortening only ever shortens segments
    hand_y = kp[br, s.c_wr, 1] + (kp[br, s.c_wr, 1] - kp[br, s.c_el, 1]) * 0.25   # ball sits beyond the wrist
    ground_y = kp[br, s.c_fan, 1] + ANKLE_HEIGHT_FRAC * stature_px
    pct = 100.0 * (ground_y - hand_y) / max(stature_px, 1e-6)
    if not (60 <= pct <= 140):
        return None, None, None
    agree = min(est) / max(est) if len(est) == 2 else 0.6
    return float(pct), "2d", float(0.5 + 0.3 * agree)


def compute(c: Ctx) -> dict:
    s, ev, fps, H = c.side, c.ev, c.fps, c.stature
    ts = time_series(c)
    view = c.view
    gate = "oblique" if c.oblique else view   # the view plane-specific metrics are checked against
    side_view = view == "side_on"
    rear_view = view in ("behind", "front_on")
    fps_eff = c.fps_unique or fps   # precision follows the distinct frames, timings the frame clock
    low_fps = fps_eff < 90
    metrics: list[dict] = []
    ms = 1000.0 / fps
    bfc, ffc, uah, br = ev.bfc, ev.ffc, ev.uah, ev.br

    # ---------------- timing ----------------
    prior_note = ("A foot contact was estimated (no clear foot-strike in this clip, or moved to keep the delivery "
                  "order). Drag the event marker to the exact frame, or confirm it in the 'At this frame' card, to measure this.")
    guessed_m = ("timing_prior", "constrained")
    est_b = ev.method.get("bfc") in guessed_m
    est_f = ev.method.get("ffc") in guessed_m
    res_ms = 1000.0 / fps_eff   # time resolution of the footage
    # From behind / in front, a foot travelling along the camera axis looks still in the image, so a detected
    # "stop" can precede the real foot strike by several frames. Timings are the most sensitive to that, so in
    # these views they are only rated once the user has confirmed the contact markers.
    rear_note = ("From behind or in front of the bowler the exact frame the foot lands is hard to see, so this "
                 "timing is an estimate. Check the contact frames: drag a marker to correct it, or confirm it in the 'At this "
                 "frame' card, to measure it.")
    def timing_extra(*keys):
        if any(ev.method.get(k) in guessed_m for k in keys):
            return {"rating": "unrated", "reliability": "estimate", "note": prior_note, "confidence": 0.25}
        if rear_view and any(ev.method.get(k) != "user" for k in keys):
            return {"rating": "unrated", "reliability": "estimate", "note": rear_note, "confidence": 0.3}
        return None
    if bfc is not None and ffc is not None and ffc > bfc:
        metrics.append(_metric("bfc_to_ffc_ms", "Back-foot to front-foot contact", (ffc - bfc) * ms, event="bfc-ffc",
                               source="events", confidence=min(ev.confidence["bfc"], ev.confidence["ffc"]),
                               decimals=0, tolerance=res_ms, explain="Duration of the delivery stride. Reported ± one frame "
                                                   f"({res_ms:.0f} ms for this footage).",
                               extra=timing_extra("bfc", "ffc")))
    if ffc is not None and br > ffc:
        metrics.append(_metric("ffc_to_br_ms", "Front-foot contact to release", (br - ffc) * ms, event="ffc-br",
                               source="events", confidence=min(ev.confidence["ffc"], ev.confidence["br"]),
                               decimals=0, tolerance=res_ms, explain="How quickly you go from landing to letting the ball go. Shorter "
                                                   "(with a stable front leg) usually means better energy transfer.",
                               extra=timing_extra("ffc")))

    # ---------------- elbow (ICC method) ----------------
    flex = np.maximum(np.array(ts["elbow_flexion_bowling"]), 0.0)  # hyperextension floored at 0
    if uah is not None and br > uah:
        win = flex[uah:br + 1]
        i_max = int(np.argmax(win))
        ext = float(win[i_max] - win[i_max:].min())
        conf = 0.25 if low_fps else 0.45
        conf *= _conf2d(c, br, [s.c_sh, s.c_el, s.c_wr])
        # the shoulder keypoint drifts while the arm passes over the head: an upper arm far from its anatomical
        # length (0.186 H, Drillis & Contini) at UAH or release means the elbow angle there can't be trusted
        leg_h = _leg_stature_px(c, br)
        if leg_h:
            ua = [float(np.linalg.norm(c.kp[t, s.c_sh] - c.kp[t, s.c_el])) / (0.186 * leg_h) for t in (uah, br)]
            if not all(0.6 <= x <= 1.25 for x in ua):
                conf = min(conf, 0.2)
        metrics.append(_metric(
            "elbow_extension", "Elbow extension (UAH → release)", ext, event="uah-br", source="3d", confidence=conf,
            needs=("side_on",), view=gate, min_fps=100, fps=fps_eff,
            explain="Straightening of the bowling elbow between the arm passing horizontal and release, computed "
                    "the ICC way (maximum flexion minus the following minimum). Shown for reference only, not rated: "
                    "a single camera can be several degrees out here, and it never replaces an accredited ICC test.",
            extra={"flexion_at_uah": round(float(flex[uah]), 1), "flexion_at_br": round(float(flex[br]), 1),
                   "max_flexion": round(float(win.max()), 1),
                   "precision_note": "insufficient precision below ~120 fps" if low_fps else None}))
        if metrics[-1]["reliability"] == "estimate":
            # a legality-adjacent number that can't be measured reliably is withheld, not shown greyed out
            if view != "side_on":
                why = "Elbow extension needs a side-on clip at 120–240 fps"
            elif fps_eff < 100:
                why = f"Elbow extension needs 120–240 fps slow motion (this clip has ~{fps_eff:.0f} distinct fps)"
            else:
                why = ("The bowling arm wasn't tracked reliably around release (the shoulder is hidden as the arm "
                       "passes over the head, or motion blur)")
            metrics[-1].update(value=None, estimate_3d=None, flexion_at_uah=None, flexion_at_br=None, max_flexion=None,
                               note=why + "; it isn't estimated from this video. Never a substitute for an "
                                          "accredited ICC test.")

    # ---------------- front leg ----------------
    knee3 = np.array(ts["knee_front"]); knee2 = np.array(ts["front_knee_2d"])
    knee = knee2 if side_view else knee3
    src = "2d" if side_view else "3d"
    kconf = 0.8 if side_view else 0.3
    if ffc is not None and br > ffc:
        seg = knee[ffc:br + 1]
        k_ffc, k_br, k_min = float(knee[ffc]), float(knee[br]), float(seg.min())
        i_min = ffc + int(np.argmin(seg))
        flexion = k_ffc - k_min
        extension = k_br - k_min
        if flexion >= 10 and extension < 10:
            tech = "Flexor"
        elif flexion >= 10 and extension >= 10:
            tech = "Flexor-extender"
        elif flexion < 10 and extension >= 10:
            tech = "Extender"
        else:
            tech = "Constant brace"
        cf = kconf * min(_conf2d(c, ffc, [s.c_fhip, s.c_fkn, s.c_fan]), _conf2d(c, br, [s.c_fhip, s.c_fkn, s.c_fan]))
        metrics.append(_metric("front_knee_ffc", "Front knee at front-foot contact", k_ffc, event="ffc", source=src,
                               confidence=cf, explain="180° = straight leg.", needs=SIDE, view=gate))
        metrics.append(_metric("front_knee_br", "Front knee at release", k_br, event="br", source=src, confidence=cf,
                               needs=SIDE, view=gate,
                               explain="A straighter front leg at release acts as a lever and is associated with "
                                       "higher ball speed; some flexion is normal and may reduce load.",
                               extra={"flexion_after_ffc": round(flexion, 1),
                                      "extension_to_br": round(extension, 1), "min_frame": i_min}))
        metrics.append(_metric("front_knee_flexion", "Front knee bend after landing", flexion, event="ffc-br",
                               source=src, confidence=cf, needs=SIDE, view=gate,
                               explain="Flexion of the front knee from landing to its most bent point. Together with "
                                       "the extension to release it gives the front-leg technique (Portus et al. 2004).",
                               extra={"technique": tech}))
    if bfc is not None:
        bk = joint_angle(c.kp[:, s.c_bhip], c.kp[:, s.c_bkn], c.kp[:, s.c_ban]) if side_view else np.array(ts["knee_back"])
        metrics.append(_metric("back_knee_bfc", "Back knee at back-foot contact", float(bk[bfc]), event="bfc",
                               source="2d" if side_view else "3d",
                               confidence=(0.7 * _conf2d(c, bfc, [s.c_bhip, s.c_bkn, s.c_ban])) if side_view else 0.3,
                               needs=SIDE, view=gate,
                               explain="A very flexed back leg at back-foot contact was one of the strongest "
                                       "predictors of lumbar stress injury in a prospective elite study."))

    # ---------------- trunk ----------------
    tf = np.array(ts["trunk_forward_flexion"])
    t2 = np.array(ts["trunk_angle_2d"])
    if side_view:
        sign = np.sign(c.wf.forward[0]) if abs(c.wf.forward[0]) > 1e-3 else 1.0
        tf_use = t2 * sign
        tsrc, tconf = "2d", 0.75
    else:
        tf_use, tsrc, tconf = tf, "3d", 0.3
    metrics.append(_metric("trunk_forward_br", "Trunk forward flexion at release", float(tf_use[br]), event="br",
                           source=tsrc, confidence=tconf * _conf2d(c, br, [5, 6, 11, 12]), needs=SIDE, view=gate,
                           explain="How far the trunk is pitched towards the batter at release. Fast bowlers "
                                   "flex strongly through the delivery stride. This is the lean at the moment of release; "
                                   "'Trunk flexion FFC → release' is how much it bends during the stride."))
    if ffc is not None and br > ffc:
        metrics.append(_metric("trunk_flexion_ffc_br", "Trunk flexion FFC → release", float(tf_use[br] - tf_use[ffc]),
                               event="ffc-br", source=tsrc,
                               confidence=tconf * 0.9 * min(_conf2d(c, ffc, [5, 6, 11, 12]), _conf2d(c, br, [5, 6, 11, 12])),
                               needs=SIDE, view=gate,
                               explain="Trunk flexion produced during the delivery stride — a key contributor to "
                                       "ball speed."))
    tl3 = np.array(ts["trunk_lateral_flexion"])
    if rear_view:
        # image angle of the trunk from vertical, positive = leaning away from the bowling arm side
        sign = 1.0 if s.bowling_arm == "right" else -1.0
        if view == "front_on":
            sign = -sign
        tl = -t2 * sign
        lsrc, lconf = "2d", 0.75
    else:
        tl, lsrc, lconf = tl3, "3d", 0.3
    metrics.append(_metric("trunk_lateral_br", "Trunk side-bend at release", abs(float(tl[br])), event="br",
                           source=lsrc, confidence=lconf * _conf2d(c, br, [5, 6, 11, 12]), needs=REAR, view=gate,
                           explain="Lateral flexion of the trunk away from the bowling arm. Large side-bend "
                                   "loads the lower back; it is one of the better single-camera measures from "
                                   "behind the bowler."))

    # ---------------- alignment / mixed action ----------------
    sh = np.array(ts["shoulder_alignment"]); hp = np.array(ts["hip_alignment"])
    acon = 0.45 if rear_view else 0.3
    if bfc is not None:
        acon *= _conf2d(c, bfc, [5, 6, 11, 12])
        th = float(sh[bfc])
        action = "side-on" if th < 210 else ("semi-open" if th <= 240 else "front-on")
        sep = float(sh[bfc] - hp[bfc])
        sep_conf = 1.0
        if rear_view:
            # From behind/in front only the *size* of each line's out-of-plane angle is seen; which side of front-on
            # it lies comes from the 3D model. Near front-on that side is uncertain, and putting hips and shoulders
            # on opposite sides adds two small angles into a large, false separation (synthetic check: 39° read
            # for a true 0). Then use the same-side reading (the conservative one) at lower confidence.
            _, s3, s_phi = _alignment_parts(c, "shoulder")
            _, h3, h_phi = _alignment_parts(c, "hip")
            if (s3[bfc] > 270) != (h3[bfc] > 270) and min(abs(s3[bfc] - 270), abs(h3[bfc] - 270)) < 20:
                sep = float(h_phi[bfc] - s_phi[bfc]) if s3[bfc] > 270 else float(s_phi[bfc] - h_phi[bfc])
                sep_conf = 0.6
        hi_ = ffc if (ffc is not None and ffc > bfc) else min(len(sh) - 1, bfc + int(0.2 * fps))
        scr = float(th - sh[bfc:hi_ + 1].min())
        mixed = (30 <= abs(sep) <= 45) or (30 <= scr <= 60)   # same plausibility gates as the metrics
        metrics.append(_metric("shoulder_alignment_bfc", "Shoulder alignment at back-foot contact", th, event="bfc",
                               source="2d+3d", confidence=acon, needs=REAR, view=gate,
                               explain="180 = side-on, 270 = front-on.",
                               extra={"action_type": "mixed" if mixed else action}))
        metrics.append(_metric("hip_shoulder_sep_bfc", "Hip-shoulder separation at BFC", abs(sep), event="bfc",
                               source="2d+3d", confidence=acon * 0.9 * sep_conf, needs=REAR, view=gate,
                               explain="Misalignment between hips and shoulders when the back foot lands; large "
                                       "values define a 'mixed' action, which twists the lower back."))
        metrics.append(_metric("shoulder_counter_rotation", "Shoulder counter-rotation", max(scr, 0.0),
                               event="bfc-ffc", source="2d+3d", confidence=acon * 0.85, needs=REAR, view=gate,
                               explain="How much the shoulders rotate back towards side-on after back-foot "
                                       "contact."))

    # ---------------- release ----------------
    W = c.W
    rel_h, rh_src, rh_conf = _release_height_2d(c)
    if rel_h is None:
        ground = min(W[br, s.front_ankle, 2], W[br, s.back_ankle, 2]) - ANKLE_HEIGHT_FRAC * H
        arm_dir = unit(W[br, s.wrist] - W[br, s.elbow])
        hand_h = W[br, s.wrist, 2] + HAND_OFFSET_M * max(arm_dir[2], 0.3)
        rel_h, rh_src, rh_conf = 100 * (hand_h - ground) / H, "3d", 0.35
    metrics.append(_metric("release_height_pct", "Release height", rel_h, event="br", source=rh_src,
                           confidence=rh_conf * _conf2d(c, br, [s.c_wr, s.c_fan]),
                           explain=f"Height of the ball at release as a percentage of your height "
                                   f"(~{rel_h * H / 100:.2f} m for a stature of {H:.2f} m). Single-camera "
                                   "precision is about ± 8 points.",
                           extra={"metres": round(float(rel_h * H / 100), 2)}, needs=SQUARE, view=gate))
    # arm slot: angle of shoulder->wrist from vertical in the frontal plane
    if rear_view:
        v = c.kp[br, s.c_wr] - c.kp[br, s.c_sh]
        slot = abs(float(_img_angle_from_vertical(v)))
        ssrc, sconf = "2d", 0.75
    else:
        aw = W[br, s.wrist] - W[br, s.shoulder]
        slot = abs(float(np.degrees(np.arctan2(aw[1], aw[2]))))
        ssrc, sconf = "3d", 0.35
    metrics.append(_metric("arm_slot_br", "Arm slot at release", slot, event="br", source=ssrc,
                           confidence=sconf * _conf2d(c, br, [s.c_sh, s.c_wr]), needs=REAR, view=gate,
                           explain="0° = bowling arm straight up (high arm); larger = more round-arm."))
    if rear_view:
        head_x = c.kp[br, 0, 0] if c.kc[br, 0] > 0.3 else (c.kp[br, 3, 0] + c.kp[br, 4, 0]) / 2
        foot_x = c.kp[br, s.c_fan, 0]
        off_m = abs(head_x - foot_x) / max(c.k[br], 1e-6)
        metrics.append(_metric("head_offset_br", "Head outside front foot at release", 100 * off_m, event="br",
                               source="2d", confidence=0.6 * _conf2d(c, br, [s.c_fan, 3, 4]), decimals=0,
                               explain="How far the head is laterally from the front foot at release. A head "
                                       "falling outside the front foot ('falling away') costs accuracy and "
                                       "increases side-bend.", needs=REAR, view=gate))
    # ---------------- stride ----------------
    if ffc is not None:
        if side_view:
            dx = abs(c.kp[ffc, s.c_fan, 0] - c.kp[ffc, s.c_ban, 0]) / max(c.k[ffc], 1e-6)
            stsrc, stconf = "2d", 0.7
        else:
            d = W[ffc, s.front_ankle] - W[ffc, s.back_ankle]
            dx = float(np.hypot(d[0], d[1]))
            stsrc, stconf = "3d", 0.2
        metrics.append(_metric("stride_length_pct", "Delivery stride length", 100 * dx / H, event="ffc",
                               source=stsrc, confidence=stconf * _conf2d(c, ffc, [s.c_fan, s.c_ban]), needs=SIDE, view=gate,
                               explain="Distance between the ankles at front-foot contact.",
                               extra={"metres": round(float(dx), 2)}))
    # Values read at a contact that was only placed from typical timing are measured at a guessed frame: keep
    # them visible, but unrated and out of the score until the user confirms the event on the timeline.
    guessed = {k for k, est in (("bfc", est_b), ("ffc", est_f)) if est}
    for m in metrics:
        if guessed & set((m.get("event") or "").split("-")) and m["rating"] != "unrated":
            m.update(rating="unrated", reliability="estimate", confidence=min(m["confidence"], 0.25),
                     note=m.get("note") or prior_note)
    return {"metrics": metrics, "series": ts}
