"""2D keypoint sequence assembly and cleanup for the bowler.

Order of operations (follows markerless-biomechanics practice, e.g. Sports2D / OpenCap):
  1. merge top-down refined keypoints with tracker keypoints (fallback), confidence-gated
  2. Hampel outlier rejection per joint (window ~0.1 s, 3 MAD)
  3. left/right swap correction per limb chain (2-state Viterbi on motion continuity) - must run before
     3D lifting, otherwise the lifter inherits the swaps
  4. short-gap interpolation (Akima), long gaps keep low confidence
  5. zero-lag Butterworth smoothing with joint-specific cut-offs (arms are left sharper than trunk/legs)
"""
from __future__ import annotations

import numpy as np
from scipy.interpolate import Akima1DInterpolator
from scipy.signal import butter, filtfilt

# COCO indices
CHAINS = {
    "arm": ([5, 7, 9], [6, 8, 10]),
    # the forearms alone: when the arms cross at release a detector can swap elbows + wrists but not the shoulders,
    # which the whole-arm chain (shoulders included) can't repair
    "forearm": ([7, 9], [8, 10]),
    "leg": ([11, 13, 15], [12, 14, 16]),
    "face": ([1, 3], [2, 4]),
}
ARM_JOINTS = {7, 8, 9, 10}


def assemble(frames: list[int], refined: list, tracked: dict[int, object], f0: int, f1: int,
             min_conf: float = 0.2) -> tuple[np.ndarray, np.ndarray]:
    """Dense (T,17,2)/(T,17) arrays over [f0, f1). Refined crop poses win; tracker poses fill holes."""
    T = f1 - f0
    kp = np.zeros((T, 17, 2), np.float32)
    kc = np.zeros((T, 17), np.float32)
    for fr, r in zip(frames, refined):
        if r is None:
            continue
        kp[fr - f0] = r.kp
        kc[fr - f0] = r.kc
    for fr, d in tracked.items():
        t = fr - f0
        if not (0 <= t < T):
            continue
        worse = kc[t] < np.minimum(d.kc * 0.8, 0.5)
        kp[t][worse] = d.kp[worse]
        kc[t][worse] = d.kc[worse] * 0.8
    kc[kc < min_conf] = 0.0
    return kp, kc


def body_height_px(kp: np.ndarray, kc: np.ndarray) -> np.ndarray:
    """Per-frame bowler size proxy (shoulder-mid to ankle-mid distance / 0.8), robust to missing joints."""
    sh = (kp[:, 5] + kp[:, 6]) / 2
    an = (kp[:, 15] + kp[:, 16]) / 2
    ok = (np.minimum(kc[:, 5], kc[:, 6]) > 0) & (np.minimum(kc[:, 15], kc[:, 16]) > 0)
    h = np.linalg.norm(sh - an, axis=1) / 0.8
    if ok.sum() >= 2:
        med = np.median(h[ok])
        h = np.where(ok, h, med)
    else:
        h = np.full(len(kp), 200.0)
    return h.astype(np.float32)


def hampel(kp: np.ndarray, kc: np.ndarray, fps: float, n_sigma: float = 3.0) -> np.ndarray:
    """Zero the confidence of isolated spikes (per joint, per axis)."""
    T = len(kp)
    w = max(2, int(round(0.1 * fps)))
    kc = kc.copy()
    h = body_height_px(kp, kc)
    for j in range(17):
        if j in ARM_JOINTS:
            continue  # arm joints legitimately move ~0.3 body heights per frame at release
        v = kc[:, j] > 0
        for t in range(T):
            if not v[t]:
                continue
            lo, hi = max(0, t - w), min(T, t + w + 1)
            nb = [i for i in range(lo, hi) if v[i] and i != t]
            if len(nb) < 3:
                continue
            med = np.median(kp[nb, j], axis=0)
            mad = np.median(np.abs(kp[nb, j] - med), axis=0) * 1.4826
            thr = np.maximum(n_sigma * mad, 0.04 * h[t])
            if np.any(np.abs(kp[t, j] - med) > thr):
                kc[t, j] = 0.0
    return kc


def fix_swaps(kp: np.ndarray, kc: np.ndarray, switch_cost: float = 0.25) -> tuple[np.ndarray, np.ndarray, int]:
    """Per-chain 2-state Viterbi: choose, per frame, whether the detector's left/right labels are swapped,
    minimising frame-to-frame keypoint motion (normalised by body height). Returns corrected arrays and the
    number of frames changed."""
    kp, kc = kp.copy(), kc.copy()
    T = len(kp)
    if T < 3:
        return kp, kc, 0
    h = body_height_px(kp, kc)
    changed = 0
    for name, (L, R) in CHAINS.items():
        idx_a = L + R
        idx_b = R + L
        def pos(t, s):
            ids = idx_a if s == 0 else idx_b
            return kp[t, ids], kc[t, ids]
        cost = np.zeros((T, 2))
        back = np.zeros((T, 2), np.int8)
        for t in range(1, T):
            for s in (0, 1):
                p, c = pos(t, s)
                best, arg = np.inf, 0
                for sp in (0, 1):
                    q, cq = pos(t - 1, sp)
                    w = np.minimum(c, cq)
                    if w.sum() < 1e-3:
                        d = 0.0
                    else:
                        d = float((np.linalg.norm(p - q, axis=1) * w).sum() / w.sum()) / max(h[t], 1.0)
                    total = cost[t - 1, sp] + d + (switch_cost if s != sp else 0.0)
                    if total < best:
                        best, arg = total, sp
                cost[t, s] = best
                back[t, s] = arg
        # anchor: the globally cheaper path; prefer "as detected" on ties
        s = int(np.argmin(cost[-1] + np.array([0.0, 1e-6])))
        states = np.zeros(T, np.int8)
        for t in range(T - 1, -1, -1):
            states[t] = s
            s = back[t, s]
        # never flip the majority labelling: if most frames are "swapped", the detector labels are consistent
        if states.mean() > 0.5:
            states = 1 - states
        for t in np.nonzero(states)[0]:
            kp[t, idx_a] = kp[t, idx_b].copy()
            kc[t, idx_a] = kc[t, idx_b].copy()
            changed += 1
    return kp, kc, changed


def interpolate_gaps(kp: np.ndarray, kc: np.ndarray, fps: float, max_gap_s: float = 0.25) -> tuple[np.ndarray, np.ndarray]:
    """Akima-interpolate gaps; interpolated samples get confidence 0.15 (short gaps) or 0.05 (long)."""
    kp, kc = kp.copy(), kc.copy()
    T = len(kp)
    t = np.arange(T, dtype=np.float64)
    max_gap = max(1, int(round(max_gap_s * fps)))
    for j in range(17):
        v = kc[:, j] > 0
        if v.sum() < 2:
            continue
        if v.sum() >= 3:
            fx = Akima1DInterpolator(t[v], kp[v, j, 0]); fy = Akima1DInterpolator(t[v], kp[v, j, 1])
            xs, ys = fx(t), fy(t)
            xs = np.where(np.isnan(xs), np.interp(t, t[v], kp[v, j, 0]), xs)
            ys = np.where(np.isnan(ys), np.interp(t, t[v], kp[v, j, 1]), ys)
        else:
            xs = np.interp(t, t[v], kp[v, j, 0]); ys = np.interp(t, t[v], kp[v, j, 1])
        miss = ~v
        # gap lengths
        gap_len = np.zeros(T, int)
        i = 0
        while i < T:
            if miss[i]:
                k = i
                while k < T and miss[k]:
                    k += 1
                gap_len[i:k] = k - i
                i = k
            else:
                i += 1
        kp[miss, j, 0] = xs[miss]
        kp[miss, j, 1] = ys[miss]
        kc[miss, j] = np.where(gap_len[miss] <= max_gap, 0.15, 0.05)
    return kp, kc


def butter_smooth(x: np.ndarray, fps: float, cutoff_hz: float, order: int = 4) -> np.ndarray:
    """Zero-lag Butterworth along axis 0 (Winter's correction for the double pass)."""
    if len(x) < 3 * (order + 1) + 1:
        return x.copy()
    nyq = fps / 2.0
    corrected = cutoff_hz / 0.802  # filtfilt doubles the order; keep the -3 dB point at cutoff_hz
    if corrected >= nyq * 0.95:
        return x.copy()
    b, a = butter(order // 2, corrected / nyq)
    pad = min(len(x) - 1, 3 * max(len(a), len(b)))
    return filtfilt(b, a, x, axis=0, padtype="odd", padlen=pad)


def smooth_keypoints(kp: np.ndarray, fps: float) -> np.ndarray:
    """Trunk/legs ~ 8 Hz, arms ~ 12 Hz (capped below Nyquist). Fast bowling arm is left sharper."""
    out = kp.copy()
    body = [j for j in range(17) if j not in ARM_JOINTS]
    arms = sorted(ARM_JOINTS)
    out[:, body] = butter_smooth(kp[:, body], fps, min(8.0, 0.3 * fps))
    out[:, arms] = butter_smooth(kp[:, arms], fps, min(12.0, 0.4 * fps))
    return out.astype(np.float32)
