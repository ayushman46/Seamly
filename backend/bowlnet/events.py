"""Delivery events, bowling arm and camera view.

Design notes (see docs/RESEARCH.md for sources):
  * Monocular depth is the least reliable quantity (telephoto broadcast views flatten it almost entirely),
    so every event is detected from *image-plane* signals that are observable from any viewpoint, with 3D
    only used as a tie-breaker:
      - ball release (BR): the bowling wrist's final upswing - after the arm's last low point behind the
        body, the frame where the wrist reaches its highest point relative to the shoulder (arm ~vertical);
        refined towards peak arm angular speed at high frame rates.
      - upper-arm horizontal (UAH): the elbow rises through shoulder height during that upswing.
      - foot contacts (BFC/FFC): a planted foot is stationary in the world, hence stationary in
        camera-motion-stabilised image coordinates. Contact = onset of ankle stationarity.
        Zeni et al. (2008) pelvis-relative foot position is added as a secondary cue for side-on views.
  * Candidates are solved jointly with timing priors from 92 bowlers (Andrews 2024):
    BFC->FFC 197 +/- 59 ms, FFC->BR 126 +/- 37 ms; ordering BFC < FFC < BR.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from scipy.ndimage import uniform_filter1d

from .kinematics import unit

# H36M indices (3D)
PELVIS, R_HIP, R_KNEE, R_ANK, L_HIP, L_KNEE, L_ANK, SPINE, THORAX, NOSE, HEAD = range(11)
L_SH, L_EL, L_WR, R_SH, R_EL, R_WR = 11, 12, 13, 14, 15, 16
# COCO indices (2D)
C = dict(nose=0, l_sh=5, r_sh=6, l_el=7, r_el=8, l_wr=9, r_wr=10, l_hip=11, r_hip=12, l_kn=13, r_kn=14,
         l_an=15, r_an=16)

BFC_FFC_MS = (197.0, 59.0)
FFC_BR_MS = (126.0, 37.0)


@dataclass
class Side:
    bowling_arm: str
    # 3D (H36M)
    shoulder: int; elbow: int; wrist: int
    front_shoulder: int; front_elbow: int; front_wrist: int
    front_hip: int; front_knee: int; front_ankle: int
    back_hip: int; back_knee: int; back_ankle: int
    # 2D (COCO)
    c_sh: int; c_el: int; c_wr: int; c_fsh: int; c_fel: int; c_fwr: int
    c_fhip: int; c_fkn: int; c_fan: int; c_bhip: int; c_bkn: int; c_ban: int

    @staticmethod
    def for_arm(arm: str) -> "Side":
        if arm == "right":
            return Side("right", R_SH, R_EL, R_WR, L_SH, L_EL, L_WR, L_HIP, L_KNEE, L_ANK, R_HIP, R_KNEE, R_ANK,
                        6, 8, 10, 5, 7, 9, 11, 13, 15, 12, 14, 16)
        return Side("left", L_SH, L_EL, L_WR, R_SH, R_EL, R_WR, R_HIP, R_KNEE, R_ANK, L_HIP, L_KNEE, L_ANK,
                    5, 7, 9, 6, 8, 10, 12, 14, 16, 11, 13, 15)


@dataclass
class Events:
    bfc: int | None
    ffc: int | None
    uah: int | None
    br: int
    ft: int | None
    confidence: dict = field(default_factory=dict)
    method: dict = field(default_factory=dict)

    def as_dict(self, f0: int, timestamps: np.ndarray) -> dict:
        out = {}
        for k in ("bfc", "ffc", "uah", "br", "ft"):
            v = getattr(self, k)
            out[k] = None if v is None else {
                "frame": int(v + f0), "time": round(float(timestamps[min(len(timestamps) - 1, v + f0)]), 4),
                "confidence": round(float(self.confidence.get(k, 0.5)), 2), "method": self.method.get(k, "auto"),
            }
        return out

    def get(self, k: str) -> int | None:
        return getattr(self, k)


def stabilise(kp: np.ndarray, motions: np.ndarray, ref: int) -> np.ndarray:
    """Map per-frame image points into frame `ref`'s pixel coordinates using camera motion.
    motions[t] (2x3) maps frame t-1 pixels -> frame t pixels."""
    T = len(kp)
    H = np.zeros((T, 3, 3))
    H[0] = np.eye(3)
    for t in range(1, T):
        M = np.eye(3); M[:2] = motions[t]
        H[t] = M @ H[t - 1]              # frame 0 -> frame t
    Hr = H[ref]
    out = np.empty_like(kp, dtype=np.float64)
    for t in range(T):
        G = Hr @ np.linalg.inv(H[t])     # frame t -> frame ref
        out[t] = kp[t] @ G[:2, :2].T + G[:2, 2]
    return out


def arm_angular_speed(P: np.ndarray, sh: int, wr: int, fps: float) -> np.ndarray:
    a = unit(P[:, wr] - P[:, sh])
    if len(a) < 2:
        return np.zeros(len(a))
    dots = np.clip((a[1:] * a[:-1]).sum(-1), -1, 1)
    w = np.degrees(np.arccos(dots)) * fps
    return np.concatenate([[w[0]], (w[1:] + w[:-1]) / 2, [w[-1]]])


def arm_speed_2d(kp: np.ndarray, sh: int, wr: int, fps: float) -> np.ndarray:
    v = kp[:, wr] - kp[:, sh]
    a = np.arctan2(v[:, 1], v[:, 0])
    d = np.diff(np.unwrap(a))
    w = np.degrees(np.abs(d)) * fps
    return np.concatenate([[w[0]], (w[1:] + w[:-1]) / 2, [w[-1]]]) if len(w) else np.zeros(len(kp))


def wrist_lift(kp: np.ndarray, sh: int, el: int, wr: int) -> np.ndarray:
    """Height of the wrist above the shoulder in arm lengths (image y is down)."""
    arm = np.linalg.norm(kp[:, el] - kp[:, sh], axis=1) + np.linalg.norm(kp[:, wr] - kp[:, el], axis=1)
    arm = np.maximum(uniform_filter1d(arm, size=min(len(arm), 9), mode="nearest"), 1.0)
    return (kp[:, sh, 1] - kp[:, wr, 1]) / arm


def decide_bowling_arm(kp: np.ndarray, kc: np.ndarray, P: np.ndarray, fps: float, sweep_hint: str | None,
                       window: tuple[int, int]) -> tuple[str, float, dict]:
    """Vote: (1) which arm makes the fast final upswing to the highest point, (2) 2D angular speed,
    (3) 3D angular speed, (4) the tracker-level sweep hint."""
    lo, hi = max(0, window[0]), min(len(kp), window[1])
    if hi - lo < 3:   # degenerate window (very low fps / sweep at the clip edge)
        lo = max(0, min(lo, len(kp) - 3))
        hi = min(len(kp), lo + 3)
    votes: dict[str, float] = {}
    wr = arm_speed_2d(kp, 6, 10, fps)[lo:hi]; wl = arm_speed_2d(kp, 5, 9, fps)[lo:hi]
    votes["speed_2d"] = float(np.sign(np.percentile(wr, 90) - np.percentile(wl, 90)))
    lr = wrist_lift(kp, 6, 8, 10)[lo:hi]; ll = wrist_lift(kp, 5, 7, 9)[lo:hi]
    # height reached while moving fast (the front arm is high early and slow; the bowling arm high & fast)
    fr = lr * (wr / (wr.max() + 1e-6)); fl = ll * (wl / (wl.max() + 1e-6))
    votes["fast_high_2d"] = float(np.sign(fr.max() - fl.max()))
    w3r = arm_angular_speed(P, R_SH, R_WR, fps)[lo:hi]; w3l = arm_angular_speed(P, L_SH, L_WR, fps)[lo:hi]
    votes["speed_3d"] = float(np.sign(np.percentile(w3r, 90) - np.percentile(w3l, 90)))
    if sweep_hint in ("left", "right"):
        votes["sweep_2d"] = 1.0 if sweep_hint == "right" else -1.0
    weights = {"speed_2d": 1.0, "fast_high_2d": 1.4, "speed_3d": 0.6, "sweep_2d": 1.0}
    s = sum(weights[k] * v for k, v in votes.items())
    total = sum(weights[k] for k in votes)
    return ("right" if s >= 0 else "left"), abs(s) / total, votes


def _gauss(dt_ms: float, mu: float, sd: float) -> float:
    return -0.5 * ((dt_ms - mu) / sd) ** 2


def _contact_onsets(speed: np.ndarray, lo: int, hi: int, thr: float, min_still: int,
                    fps: float = 30.0) -> list[tuple[int, float]]:
    """Frames where a foot stops: speed falls well below its recent swing speed and stays low.
    Relative criterion (post/pre speed) tolerates residual camera-zoom drift at broadcast frame rates; at
    high frame rates (>= 120 fps) a genuine stop is observable, so the absolute criterion tightens.
    All windows are defined in seconds so the detector behaves the same at 25-240 fps. Returns (frame, strength)."""
    out = []
    pre_n = max(4, int(round(0.12 * fps)))
    hi_fps = float(np.clip((fps - 60.0) / 60.0, 0.0, 1.0))          # 0 at <=60 fps, 1 at >=120 fps
    rel_now = 0.6 - 0.3 * hi_fps                                     # speed now vs swing speed
    rel_post = 0.45 - 0.2 * hi_fps
    abs_post = 2.5 - 1.5 * hi_fps                                    # x thr (body heights / s)
    lo, hi = max(1, lo), min(len(speed) - min_still, hi)
    for t in range(lo, hi):
        pre = float(speed[max(0, t - pre_n):t].max())
        post = float(np.median(speed[t:t + min_still + 1]))
        if pre < 1.6 * thr:
            continue                      # foot was not swinging
        if speed[t] > rel_now * pre or post > rel_post * pre or speed[t] > speed[t - 1]:
            continue
        if post > abs_post * thr:
            continue                      # still moving in absolute terms
        out.append((t, float(min(pre / max(post, 0.2 * thr), 6.0))))
    # keep the first frame of each run of consecutive onsets
    dedup = []
    for t, st in out:
        if dedup and t - dedup[-1][0] <= max(1, int(round(0.01 * fps))):
            if st > dedup[-1][1]:
                dedup[-1] = (dedup[-1][0], st)
            continue
        dedup.append((t, st))
    return dedup


def detect_events(kp: np.ndarray, kc: np.ndarray, kp_stab: np.ndarray, P: np.ndarray, side: Side,
                  up: np.ndarray, forward: np.ndarray, fps: float, body_px: np.ndarray,
                  sweep_window: tuple[int, int], sweep_peak: int | None = None,
                  fixed: dict[str, int] | None = None) -> Events:
    """fixed: events the user placed (window-relative frames). The remaining events are detected around them,
    so e.g. moving back-foot contact re-searches front-foot contact after it instead of keeping a stale one."""
    T = len(kp)
    ms = 1000.0 / fps
    conf: dict[str, float] = {}
    meth: dict[str, str] = {}
    fixed = {k: int(np.clip(v, 0, T - 1)) for k, v in (fixed or {}).items() if v is not None}

    # ---------------- ball release: final upswing of the bowling wrist ----------------
    lift = uniform_filter1d(wrist_lift(kp, side.c_sh, side.c_el, side.c_wr), size=1)
    w2 = arm_speed_2d(kp, side.c_sh, side.c_wr, fps)
    lo, hi = sweep_window
    anchor = int(np.clip((lo + hi) // 2 if sweep_peak is None else sweep_peak, 0, T - 1))
    lo, hi = max(1, lo - int(0.2 * fps)), min(T - 1, hi + int(0.15 * fps))
    # Candidate releases: a rise of the wrist from below the shoulder (arm down/back) to a peak above it,
    # followed by the fall into the follow-through. (A gather where the arms drop from overhead is a fall
    # without a preceding rise, so it never qualifies.)
    rise_win = max(3, int(0.3 * fps))
    cands = []
    for t_l in range(lo, hi):
        if lift[t_l] > -0.15 or lift[t_l] > lift[max(0, t_l - 1)] or lift[t_l] > lift[min(T - 1, t_l + 1)]:
            continue
        seg_hi = min(T, t_l + rise_win + 1)
        t_h = t_l + int(np.argmax(lift[t_l:seg_hi]))
        if lift[t_h] < 0.3:
            continue
        amp = lift[t_h] - lift[t_l]
        rise_s = max(1, t_h - t_l) / fps
        after = lift[t_h:min(T, t_h + max(2, int(0.15 * fps)))]
        fall = lift[t_h] - after.min() if len(after) else 0.0
        prox = abs(t_h - anchor) / fps
        score = amp + 0.6 * min(fall, 2.0) + 0.15 * min(amp / rise_s, 20) - 3.0 * prox
        cands.append((score, t_l, t_h))
    if "br" in fixed:
        t_top = fixed["br"]
        t_low = max(0, t_top - rise_win)
    elif cands:
        _, t_low, t_top = max(cands)
    else:
        t_fast = lo + int(np.argmax(w2[lo:hi])) if hi > lo else lo
        t_low = t_fast
        t_top = max(range(max(0, t_fast - 2), min(T, t_fast + 3)), key=lambda t: lift[t])
    br = t_top
    if fps >= 90 and "br" not in fixed:  # high frame rate: release sits just past vertical, where the arm is fastest
        span = max(1, int(round(0.012 * fps)))
        cand = range(t_top, min(T, t_top + span + 1))
        br = max(cand, key=lambda t: w2[t])
    meth["br"] = "wrist_final_upswing_peak"
    conf["br"] = float(np.clip(0.35 + 0.5 * np.mean(kc[max(0, br - 1):br + 2, side.c_wr])
                               + (0.15 if lift[t_low] < 0 < lift[t_top] else -0.15), 0.15, 0.95))

    # ---------------- upper-arm horizontal: elbow rises through shoulder height ----------------
    el_rel = kp[:, side.c_sh, 1] - kp[:, side.c_el, 1]   # >0 when elbow above shoulder
    uah = fixed.get("uah")
    for t in ([] if uah is not None else range(br, max(t_low, br - int(0.3 * fps)), -1)):
        if el_rel[t] >= 0 > el_rel[t - 1]:
            uah = t if abs(el_rel[t]) <= abs(el_rel[t - 1]) else t - 1
            break
    if "uah" in fixed:
        meth["uah"], conf["uah"] = "user", 1.0
    elif uah is None:
        # fall back to 3D elevation
        ua = unit(P[:, side.elbow] - P[:, side.shoulder])
        elev = np.degrees(np.arcsin(np.clip(ua @ up, -1, 1)))
        for t in range(br, max(1, br - int(0.3 * fps)), -1):
            if elev[t] >= 0 > elev[t - 1]:
                uah = t
                break
        meth["uah"] = "elevation_3d"
        conf["uah"] = 0.4 if uah is not None else 0.0
    else:
        meth["uah"] = "elbow_crosses_shoulder_2d"
        conf["uah"] = 0.7
    if uah is not None and "uah" not in fixed and uah >= br:
        uah = br - 1 if br >= 1 else None   # the crossing can share release's frame at low fps; UAH precedes it

    # ---------------- foot contacts: ankle stationarity in stabilised image coordinates ----------------
    h = np.maximum(body_px, 1.0)
    def foot_speed(j):
        p = kp_stab[:, j]
        sp = np.linalg.norm(np.gradient(p, axis=0), axis=1) * fps / h  # body heights per second
        return uniform_filter1d(sp, size=max(3, int(round(0.025 * fps))), mode="nearest")
    sp_f, sp_b = foot_speed(side.c_fan), foot_speed(side.c_ban)
    thr = 0.55   # body heights / s (~1 m/s for a 1.8 m athlete); swing foot moves 3-8 h/s
    still = max(2, int(round(0.04 * fps)))
    f_lo, f_hi = br - int(0.35 * fps), br - max(1, int(0.015 * fps)) + 1
    if "bfc" in fixed:   # front foot lands after the (user-placed) back foot
        f_lo = fixed["bfc"] + max(1, int(round(0.08 * fps)))
    ffc_c = _contact_onsets(sp_f, f_lo, f_hi, thr, still, fps)
    # Zeni secondary cue: front ankle most anterior relative to pelvis (3D) - adds candidates for side views
    fwd = unit(forward - up * (forward @ up))
    front_rel = (P[:, side.front_ankle] - P[:, PELVIS]) @ fwd
    prior_f = max(0, br - int(round(FFC_BR_MS[0] / ms)))
    if "bfc" in fixed:
        lo_p = min(T - 1, fixed["bfc"] + 1)
        prior_f = int(np.clip(fixed["bfc"] + round(BFC_FFC_MS[0] / ms), lo_p, min(T - 1, max(lo_p, br - 1))))
    ffc_c = [(f, sf) for f, sf in ffc_c] + [(prior_f, 0.0)]
    if "ffc" in fixed:
        ffc_c = [(fixed["ffc"], 6.0)]
    best = None
    for f, sf in ffc_c:
        lp = 1.5 * _gauss((br - f) * ms, *FFC_BR_MS)
        zeni_f = 0.4 if f > 0 and front_rel[f] >= front_rel[max(0, f - 2):f + 3].max() - 0.03 else 0.0
        bfc_c = _contact_onsets(sp_b, f - int(0.45 * fps), f - max(1, int(0.05 * fps)) + 1, thr, still, fps)
        bfc_c = bfc_c + [(max(0, f - int(round(BFC_FFC_MS[0] / ms))), 0.0)]
        if "bfc" in fixed:
            bfc_c = [(fixed["bfc"], 6.0)]
        for b, sb in bfc_c:
            lb = 1.5 * _gauss((f - b) * ms, *BFC_FFC_MS)
            score = lp + lb + 0.8 * np.log1p(sf) + 0.6 * np.log1p(sb) + zeni_f
            if best is None or score > best[0]:
                best = (score, f, b, sf, sb)
    _, ffc, bfc, sf, sb = best
    if sf == 0.0:
        meth["ffc"] = "timing_prior"
    if sb == 0.0:
        meth["bfc"] = "timing_prior"
    meth.setdefault("ffc", "foot_stops_stabilised_2d")
    meth.setdefault("bfc", "foot_stops_stabilised_2d")
    conf["ffc"] = float(np.clip(0.25 + 0.1 * min(sf, 4) + 0.3 * np.mean(kc[max(0, ffc - 1):ffc + 2, side.c_fan]), 0.2, 0.85))
    conf["bfc"] = float(np.clip(0.2 + 0.08 * min(sb, 4) + 0.3 * np.mean(kc[max(0, bfc - 1):bfc + 2, side.c_ban]), 0.15, 0.8))
    # contacts placed from typical timing (no clear foot-strike signal) are estimates, not measurements
    if meth["ffc"] == "timing_prior":
        conf["ffc"] = 0.25
    if meth["bfc"] == "timing_prior":
        conf["bfc"] = 0.2

    # ---------------- follow-through: next back-foot contact after release ----------------
    ft_c = _contact_onsets(sp_b, br + int(0.12 * fps), br + int(0.9 * fps), thr, still, fps)
    ft = ft_c[0][0] if ft_c else min(T - 1, br + int(0.5 * fps))
    if "ft" in fixed:
        ft, ft_c = fixed["ft"], [(fixed["ft"], 6.0)]
    meth["ft"] = "back_foot_recovery_step" if ft_c else "fixed_offset"
    conf["ft"] = 0.6 if ft_c else 0.3
    for k in fixed:
        meth[k], conf[k] = "user", 1.0
    return Events(bfc, ffc, uah, br, ft, conf, meth)


def facing_direction(P: np.ndarray, up: np.ndarray, frames: np.ndarray) -> np.ndarray:
    """Anterior direction (horizontal) from the hip line: up x (R_hip - L_hip)."""
    f = np.cross(up, P[frames, R_HIP] - P[frames, L_HIP])
    f = f - up * (f @ up)[:, None]
    return unit(unit(f).mean(0))


def stride_across(kp: np.ndarray, k: np.ndarray, leg_m: float, side: Side, ffc: int | None, br: int) -> float | None:
    """Median horizontal image distance between the ankles from FFC to just after release, in leg lengths.
    The planted stride is ~1.1 leg lengths long, so this is ~1 when filmed side-on and ~0-0.3 from behind or in
    front: a depth-free view cue (it needs no 3D), measured when the stride is open."""
    if ffc is None or br < ffc:
        return None
    t = np.arange(ffc, min(len(kp), br + 3))
    dx = np.abs(kp[t, side.c_fan, 0] - kp[t, side.c_ban, 0]) / np.maximum(k[t] * leg_m, 1e-6)
    return float(np.median(dx))


def classify_view(forward_cam: np.ndarray, kp: np.ndarray | None = None, kc: np.ndarray | None = None,
                  runup: np.ndarray | None = None, stride_x: float | None = None) -> dict:
    """Side-on / behind / front-on from the direction of travel in camera axes (z = optical axis).
    The planted stride's foreshortening (stride_across) decides when it is clear; otherwise the apparent hip width /
    torso length ratio during the run-up (side-on -> narrow), then the 3D direction."""
    f = unit(forward_cam)
    ang = float(np.degrees(np.arccos(np.clip(abs(f[2]), 0, 1))))  # 0 = along optical axis
    ratio = None
    if kp is not None and runup is not None and len(runup):
        hipw = np.linalg.norm(kp[runup, 11] - kp[runup, 12], axis=1)
        torso = np.linalg.norm((kp[runup, 5] + kp[runup, 6]) / 2 - (kp[runup, 11] + kp[runup, 12]) / 2, axis=1)
        ratio = float(np.median(hipw / np.maximum(torso, 1)))
    extra = {} if stride_x is None else {"stride_across": round(stride_x, 2)}
    if stride_x is not None and (stride_x > 0.7 or stride_x < 0.4):
        # behind/front-on clips measure 0.03-0.3, side-on 1.0-1.1 (an oblique ~35-45 deg view lands in between)
        view = "side_on" if stride_x > 0.7 else ("behind" if f[2] >= 0 else "front_on")
    elif ratio is not None:
        # the 2D ratio is the more reliable cue (depth from monocular lifting is weak)
        if ratio < 0.28:
            view = "side_on"
        elif ratio > 0.42:
            view = "behind" if f[2] >= 0 else "front_on"
        else:
            view = "side_on" if ang > 55 else ("behind" if f[2] >= 0 else "front_on")
    else:
        view = "side_on" if ang > 55 else ("behind" if f[2] > 0 else "front_on")
    # An oblique camera (well off the line of the pitch, or high in the stands) shows up as the two 2D cues
    # contradicting each other, or both sitting in their in-between bands so only the weak 3D direction decided.
    # Plane-specific measurements aren't trustworthy then.
    s_dec = stride_x is not None and (stride_x > 0.7 or stride_x < 0.4)
    r_dec = ratio is not None and (ratio < 0.28 or ratio > 0.42)
    clash = s_dec and r_dec and ((stride_x > 0.7) != (ratio < 0.28))
    oblique = clash or (not s_dec and not r_dec and (stride_x is not None or ratio is not None))
    if oblique:
        extra["oblique"] = True
    return {"view": view, "angle_to_optical_axis_deg": round(ang, 1),
            "hip_width_ratio": None if ratio is None else round(ratio, 3), **extra}
