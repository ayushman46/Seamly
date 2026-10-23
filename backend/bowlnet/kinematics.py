"""Metric 3D skeleton reconstruction and body-fixed reference frames.

The lifter gives plausible depth but its bone lengths drift frame to frame (~10-20 % CV on fast bowling).
We solve for a root-relative metric skeleton P (T,17,3) [m] that
  * keeps constant, left/right-symmetric bone lengths scaled to the athlete's stature,
  * re-projects onto the (high-res, confidence-weighted) 2D keypoints under a per-frame weak-perspective
    camera whose scale varies smoothly,
  * keeps the lifter's relative depth structure, and
  * is temporally smooth (looser for the fast bowling arm).
Camera axes: x right, y down, z away from the camera.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import torch

from .lifting.motionbert import H36M_PARENTS

BONES = [(j, p) for j, p in enumerate(H36M_PARENTS) if p >= 0]
# symmetric pairs (indices into BONES list): (R hip, L hip), (R thigh, L thigh), (R shank, L shank),
# (L clavicle, R clavicle), (L upper arm, R upper arm), (L forearm, R forearm)
_bidx = {j: i for i, (j, _) in enumerate(BONES)}
SYM = [(_bidx[1], _bidx[4]), (_bidx[2], _bidx[5]), (_bidx[3], _bidx[6]),
       (_bidx[11], _bidx[14]), (_bidx[12], _bidx[15]), (_bidx[13], _bidx[16])]
ARM = [12, 13, 15, 16]
# stature ~= (shank + thigh + pelvis->spine->thorax + thorax->head-top) * k ; k calibrated on Anny
# (ankle height + head-top offset of the H36M head joint)
STATURE_K = 1.06
ANTHRO_LIMBS = False   # anthropometric lengths disagree with COCO keypoint conventions (fold limbs in depth)
SELF_CONSISTENT_LIMBS = True
# child joint -> segment length / stature (thigh, shank, upper arm, forearm)
ANTHRO = {2: 0.245, 5: 0.245, 3: 0.246, 6: 0.246, 12: 0.186, 15: 0.186, 13: 0.146, 16: 0.146}


@dataclass
class Skeleton3D:
    joints: np.ndarray        # (T,17,3) metres, root-relative, camera axes
    bone_lengths: np.ndarray  # (16,) metres
    px_per_m: np.ndarray      # (T,) weak-perspective scale
    root_px: np.ndarray       # (T,2) pelvis position in the image
    stature_m: float
    reproj_err_px: np.ndarray  # (T,17)


def bone_lengths(X: np.ndarray) -> np.ndarray:
    return np.stack([np.linalg.norm(X[:, j] - X[:, p], axis=-1) for j, p in BONES], axis=1)


def stature_from_lengths(L: np.ndarray) -> float:
    b = {j: L[i] for i, (j, _) in enumerate(BONES)}
    shank = (b[3] + b[6]) / 2
    thigh = (b[2] + b[5]) / 2
    trunk = b[7] + b[8]
    head = b[9] + b[10]
    return float((shank + thigh + trunk + 0.85 * head) * STATURE_K)


def symmetric_lengths(L: np.ndarray) -> np.ndarray:
    L = L.copy()
    for a, b in SYM:
        m = (L[a] + L[b]) / 2
        L[a] = L[b] = m
    return L


def estimate_px_per_m(kp2d: np.ndarray, conf: np.ndarray, L_m: np.ndarray, fps: float) -> np.ndarray:
    """Weak-perspective scale per frame. A segment's projected length is L*k*cos(tilt) <= L*k, and over
    +/-0.5 s the trunk and limbs sweep through the image plane, so a high percentile of projected/true
    length ratios estimates k without knowing depth."""
    T = len(kp2d)
    seg = [b for b in range(len(BONES)) if BONES[b][0] in (2, 3, 5, 6, 8, 12, 13, 15, 16) or BONES[b][0] == 7]
    ratios = np.full((T, len(seg)), np.nan)
    for c, b in enumerate(seg):
        j, p = BONES[b]
        ok = np.minimum(conf[:, j], conf[:, p]) > 0.3
        r = np.linalg.norm(kp2d[:, j] - kp2d[:, p], axis=1) / max(L_m[b], 1e-3)
        ratios[ok, c] = r[ok]
    half = max(3, int(round(0.5 * fps)))
    k = np.full(T, np.nan)
    for t in range(T):
        w = ratios[max(0, t - half):t + half + 1].ravel()
        w = w[np.isfinite(w)]
        if len(w) >= 6:
            k[t] = np.percentile(w, 90)
    if np.all(np.isnan(k)):
        k[:] = 100.0
    idx = np.arange(T)
    good = np.isfinite(k)
    k = np.interp(idx, idx[good], k[good])
    from scipy.ndimage import uniform_filter1d
    return uniform_filter1d(k, size=min(T, max(3, half)), mode="nearest")


# weights of the skeleton-fit loss terms (tuned against synthetic ground truth, see docs/RESEARCH.md)
# depth 6.0 (was 0.6): trusting the lifter's depth more brought the synthetic side-on error from 96 to 80 mm
# (PA-MPJPE) with no change from behind, where the lifter's depth itself is the limit
LOSS_W = {"bone": 400.0, "2d": 60.0, "depth": 6.0, "smooth": 30.0, "k": 2000.0, "kprior": 300.0,
          "hinge": 40.0, "elbow": 25.0, "order": 400.0}


def reconstruct(X_norm: np.ndarray, kp2d: np.ndarray, conf: np.ndarray, stature_m: float, fps: float,
                iters: int = 250, priors: list | None = None, depth_w: float | None = None) -> Skeleton3D:
    """X_norm: lifter output (T,17,3); kp2d/conf: H36M-ordered 2D pixels (T,17,2) and confidences (T,17).

    priors: optional ordering constraints [(frames, joint_a, joint_b, direction(3,), margin_m)] meaning
    (J[joint_b] - J[joint_a]) . direction >= margin on those frames (soft hinge penalty). Used to resolve the
    monocular depth-sign ambiguity with physics, e.g. a planted front foot stays ahead of its knee."""
    T = len(X_norm)
    X_norm = np.ascontiguousarray(X_norm, dtype=np.float64)
    kp2d = np.ascontiguousarray(kp2d, dtype=np.float64)
    conf = np.ascontiguousarray(conf, dtype=np.float64)
    Xr = X_norm - X_norm[:, :1]
    L_units = symmetric_lengths(np.median(bone_lengths(Xr), axis=0))
    m_per_unit = stature_m / stature_from_lengths(L_units)
    L_np = L_units * m_per_unit
    if ANTHRO_LIMBS:
        # limb lengths from anthropometric ratios (Drillis & Contini 1966) blended with the lifter's estimate:
        # lifted limb *ratios* are unreliable on athletic motion and directly control how much the solver must
        # fold a limb in depth to match its 2D projection
        for j, frac in ANTHRO.items():
            b = _bidx[j]
            L_np[b] = 0.3 * L_np[b] + 0.7 * frac * stature_m
    L_m = torch.tensor(L_np, dtype=torch.float64)

    root_px = kp2d[:, 0].astype(np.float64)
    rel2d = kp2d.astype(np.float64) - root_px[:, None]
    P0 = Xr.astype(np.float64) * m_per_unit
    k0 = estimate_px_per_m(kp2d, conf, L_units * m_per_unit, fps)
    if SELF_CONSISTENT_LIMBS:
        # Each limb sweeps through the image plane during a delivery, so its longest (robust p95) projection
        # divided by the image scale is its true length *in the 2D keypoints' own convention*. Using it stops
        # the solver from folding elbows/knees in depth just because the lifter's limbs are a bit too long.
        Lc = L_np.copy()
        for j in (2, 3, 5, 6, 12, 13, 15, 16):
            b = _bidx[j]
            jj, pp = BONES[b]
            ok = np.minimum(conf[:, jj], conf[:, pp]) > 0.3
            if ok.sum() >= max(5, int(0.1 * T)):
                proj = np.linalg.norm(kp2d[ok, jj] - kp2d[ok, pp], axis=1) / k0[ok]
                Lc[b] = 0.25 * L_np[b] + 0.75 * float(np.percentile(proj, 95))
        L_np = symmetric_lengths(Lc)
        L_m = torch.tensor(L_np, dtype=torch.float64)

    P = torch.tensor(np.ascontiguousarray(P0[:, 1:]), dtype=torch.float64).contiguous().requires_grad_(True)
    logk = torch.tensor(np.log(k0), dtype=torch.float64, requires_grad=True)
    logk0 = torch.tensor(np.log(k0), dtype=torch.float64)
    tgt = torch.tensor(rel2d, dtype=torch.float64)
    w2d = torch.tensor(np.clip(conf, 0, 1), dtype=torch.float64) ** 2
    zlift = torch.tensor(P0[..., 2], dtype=torch.float64)
    jw = torch.ones(17, dtype=torch.float64)
    jw[ARM] = 0.15
    parents = torch.tensor([p for _, p in BONES]); childs = torch.tensor([j for j, _ in BONES])

    elbow_t = []
    for sh, el, wr in ((11, 12, 13), (14, 15, 16)):
        a = kp2d[:, sh] - kp2d[:, el]
        b = kp2d[:, wr] - kp2d[:, el]
        c2 = (a * b).sum(-1) / (np.linalg.norm(a, axis=-1) * np.linalg.norm(b, axis=-1) + 1e-9)
        cw = np.clip(np.minimum.reduce([conf[:, sh], conf[:, el], conf[:, wr]]), 0, 1)
        elbow_t.append((sh, el, wr, torch.tensor(c2, dtype=torch.float64), torch.tensor(cw, dtype=torch.float64)))
    prior_t = []
    for frames, ja, jb, dvec, margin in (priors or []):
        fr = torch.tensor([int(f) for f in frames if 0 <= int(f) < T], dtype=torch.long)
        if len(fr):
            prior_t.append((fr, int(ja), int(jb), torch.tensor(np.asarray(dvec, np.float64)), float(margin)))
    opt = torch.optim.LBFGS([P, logk], lr=1.0, max_iter=iters, line_search_fn="strong_wolfe")
    smooth_w = (30.0 / fps) ** 2  # acceleration penalty expressed per (1/30 s)^2

    def full():
        return torch.cat([torch.zeros(T, 1, 3, dtype=torch.float64), P], dim=1)

    def closure():
        opt.zero_grad()
        J = full()
        k = torch.exp(logk)
        bl = torch.linalg.norm(J[:, childs] - J[:, parents], dim=-1)
        e_bone = ((bl - L_m) ** 2).sum() * LOSS_W["bone"]
        proj = J[..., :2] * k[:, None, None]
        h_px = k * stature_m
        e_2d = ((((proj - tgt) / h_px[:, None, None]) ** 2).sum(-1) * w2d).sum() * LOSS_W["2d"]
        e_depth = ((J[..., 2] - zlift) ** 2).sum() * (LOSS_W["depth"] if depth_w is None else depth_w)
        if T >= 3:
            acc = J[2:] - 2 * J[1:-1] + J[:-2]
            e_smooth = ((acc ** 2).sum(-1) * jw).sum() * LOSS_W["smooth"] * smooth_w
            kacc = logk[2:] - 2 * logk[1:-1] + logk[:-2]
            e_k = (kacc ** 2).sum() * LOSS_W["k"]
        else:
            e_smooth = e_k = torch.zeros((), dtype=torch.float64)
        # the image scale is observable (segments sweep through the image plane): keep k near its estimate,
        # otherwise the solver can shrink k and lay every bone flat in the image plane (no foreshortening)
        e_kprior = ((logk - logk0) ** 2).sum() * LOSS_W["kprior"]
        # knees are hinges: the bend axis (thigh x shank) must stay along the pelvis' mediolateral axis.
        # Without this, monocular depth lets knees "bend" sideways (a zig-zag the eye can't see in 2D).
        lat = J[:, 4] - J[:, 1]
        lat = lat / (torch.linalg.norm(lat, dim=-1, keepdim=True) + 1e-9)
        e_hinge = torch.zeros((), dtype=torch.float64)
        for hip, knee, ank in ((1, 2, 3), (4, 5, 6)):
            u = J[:, knee] - J[:, hip]
            f = J[:, ank] - J[:, knee]
            n = torch.cross(u, f, dim=-1) / ((torch.linalg.norm(u, dim=-1) * torch.linalg.norm(f, dim=-1))[:, None] + 1e-9)
            off = n - (n * lat).sum(-1, keepdim=True) * lat
            e_hinge = e_hinge + (off ** 2).sum() * LOSS_W["hinge"]
        # elbows: when depth is ambiguous, prefer the least bend consistent with the image (natural-pose prior);
        # weak, so arms that are visibly bent in 2D stay bent
        e_elbow = torch.zeros((), dtype=torch.float64)
        for sh, el, wr, c2, cw in elbow_t:
            u = J[:, sh] - J[:, el]
            f = J[:, wr] - J[:, el]
            c3 = (u * f).sum(-1) / (torch.linalg.norm(u, dim=-1) * torch.linalg.norm(f, dim=-1) + 1e-9)
            e_elbow = e_elbow + (cw * (c3 - c2) ** 2).sum() * LOSS_W["elbow"]
        e_order = torch.zeros((), dtype=torch.float64)
        for frames, ja, jb, dvec, margin in prior_t:
            gap = ((J[frames, jb] - J[frames, ja]) * dvec).sum(-1)
            e_order = e_order + (torch.clamp(margin - gap, min=0.0) ** 2).sum() * LOSS_W["order"]
        loss = e_bone + e_2d + e_depth + e_smooth + e_k + e_kprior + e_hinge + e_order + e_elbow
        loss.backward()
        return loss

    opt.step(closure)
    with torch.no_grad():
        J = full().numpy()
        k = torch.exp(logk).numpy()
    err = np.linalg.norm(J[..., :2] * k[:, None, None] - rel2d, axis=-1)
    return Skeleton3D(J.astype(np.float32), (L_m.numpy()).astype(np.float32), k.astype(np.float32),
                      root_px.astype(np.float32), float(stature_m), err.astype(np.float32))


# ---------------------------------------------------------------------------------------------------------
# Reference frames
# ---------------------------------------------------------------------------------------------------------

def unit(v: np.ndarray) -> np.ndarray:
    n = np.linalg.norm(v, axis=-1, keepdims=True)
    return v / np.maximum(n, 1e-9)


def angle_between(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    a, b = unit(a), unit(b)
    return np.degrees(np.arccos(np.clip((a * b).sum(-1), -1.0, 1.0)))


def joint_angle(a: np.ndarray, b: np.ndarray, c: np.ndarray) -> np.ndarray:
    """Angle at b between segments b->a and b->c, degrees (180 = straight)."""
    return angle_between(a - b, c - b)


def rotation_about_x(deg: float) -> np.ndarray:
    r = np.radians(deg)
    c, s = np.cos(r), np.sin(r)
    return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])


@dataclass
class WorldFrame:
    """Orthonormal frame: up (against gravity), forward (direction of delivery), lateral = up x forward."""
    up: np.ndarray
    forward: np.ndarray
    lateral: np.ndarray
    camera_pitch_deg: float

    def to_world(self, P: np.ndarray) -> np.ndarray:
        """Camera-axes points -> (forward, lateral, up) coordinates."""
        R = np.stack([self.forward, self.lateral, self.up])
        return P @ R.T

    def to_dict(self) -> dict:
        return {"up": self.up.round(4).tolist(), "forward": self.forward.round(4).tolist(),
                "lateral": self.lateral.round(4).tolist(), "camera_pitch_deg": round(self.camera_pitch_deg, 1)}


def estimate_world_frame(P: np.ndarray, ffc: int | None, bfc: int | None, front_ankle: int, back_ankle: int,
                         forward_hint: np.ndarray | None = None, hint_reliable: bool = True) -> WorldFrame:
    """Gravity ~ camera -y corrected by a pitch estimated from the ground contact geometry.

    At FFC the front foot is planted and the back foot is (still) near the ground, so the back->front ankle
    vector lies close to the ground plane. Its elevation in the camera's y-z plane gives the camera pitch
    (broadcast/phone cameras are levelled, so roll is assumed ~0). The stride vector is only trusted when it
    agrees with the direction of travel (forward_hint, from the run-up facing direction). Without a run-up in the
    clip the hint comes from the hips around release, which have already turned towards the batter: then the
    stride itself is the direction of travel (it only has to point the same way as the hint)."""
    up0 = np.array([0.0, -1.0, 0.0])
    pitch = 0.0
    forward = forward_hint
    if ffc is not None:
        v = P[ffc, front_ankle] - P[ffc, back_ankle]
        agrees = forward_hint is None or float(unit(v) @ unit(forward_hint)) > (0.5 if hint_reliable else 0.0)
        if np.linalg.norm(v) > 0.35 and agrees:
            # pitch only from the depth component (behind/front views); side views barely constrain it
            if abs(v[2]) > 0.5 * np.linalg.norm(v):
                pitch = float(np.degrees(np.arctan2(-v[1], abs(v[2]))) * np.sign(v[2]))
                # at FFC the back heel is lifted (ankle ~8 cm above the planted front ankle)
                pitch += float(np.degrees(np.arctan2(0.08, np.linalg.norm(v)))) * float(np.sign(v[2]))
                pitch = float(np.clip(pitch, -25, 25))
            if forward_hint is None or not hint_reliable:
                forward = v
    R = rotation_about_x(pitch)
    up = R @ up0
    if forward is None:
        forward = np.array([0.0, 0.0, 1.0])
    forward = forward - up * (forward @ up)
    if np.linalg.norm(forward) < 1e-6:
        forward = np.array([0.0, 0.0, 1.0]) - up * up[2]
    forward = unit(forward)
    lateral = unit(np.cross(up, forward))
    return WorldFrame(up, forward, lateral, pitch)
