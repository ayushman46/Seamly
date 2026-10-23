"""Pose the Anny body model from the metric 3D skeleton with analytic, anatomy-aware IK.

Per frame we compute world-space delta rotations D_b for every bone:
  * pelvis / thorax frames from the hip and shoulder lines + trunk direction; spine bones interpolate
    between them (slerp), so the torso twists and bends smoothly;
  * limbs use two-vector alignment: the segment direction is matched exactly and the twist is chosen so
    the model's anatomical elbow/knee flexion axis lines up with the observed bend plane (falls back to
    the previous frame when the joint is straight);
  * the forearm/shank then rotates about that axis to match the distal segment;
  * feet stay level and point along the pelvis heading; hands/fingers follow the forearm.
Bone lengths of the model differ slightly from the athlete's skeleton; matching directions (not
positions) keeps the posture faithful.
"""
from __future__ import annotations

import numpy as np
from scipy.spatial.transform import Rotation

from .model import BodyInstance, BodyModel

# H36M indices
PELVIS, R_HIP, R_KNEE, R_ANK, L_HIP, L_KNEE, L_ANK, SPINE, THORAX, NOSE, HEAD = range(11)
L_SH, L_EL, L_WR, R_SH, R_EL, R_WR = 11, 12, 13, 14, 15, 16


def _unit(v):
    return v / np.maximum(np.linalg.norm(v, axis=-1, keepdims=True), 1e-9)


def _frame(fwd_hint, left, up):
    """Orthonormal frame matrices with columns (forward, left, up) built from left + up."""
    left = _unit(left)
    up = _unit(up - left * (up * left).sum(-1, keepdims=True))
    fwd = np.cross(left, up)
    return np.stack([fwd, left, up], axis=-1)


def _rot_min(a, b):
    """Minimal rotation matrices taking unit vectors a -> b (batched)."""
    a, b = _unit(a), _unit(b)
    v = np.cross(a, b)
    c = (a * b).sum(-1)
    s = np.linalg.norm(v, axis=-1)
    out = np.tile(np.eye(3), a.shape[:-1] + (1, 1))
    ok = s > 1e-8
    if ok.any():
        axis = v[ok] / s[ok, None]
        ang = np.arctan2(s[ok], c[ok])
        out[ok] = Rotation.from_rotvec(axis * ang[:, None]).as_matrix()
    flip = (~ok) & (c < 0)
    if flip.any():
        # 180 deg: rotate about any axis orthogonal to a
        aa = a[flip]
        ortho = np.cross(aa, np.array([1.0, 0, 0]))
        bad = np.linalg.norm(ortho, axis=-1) < 1e-6
        ortho[bad] = np.cross(aa[bad], np.array([0, 1.0, 0]))
        out[flip] = Rotation.from_rotvec(_unit(ortho) * np.pi).as_matrix()
    return out


def _two_vector(u_r, n_r, u_t, n_t):
    """Rotation mapping (u_r, n_r) -> (u_t, n_t) exactly on u, best-effort on n (n orthogonalised)."""
    def basis(u, n):
        u = _unit(u)
        n = _unit(n - u * (n * u).sum(-1, keepdims=True))
        return np.stack([u, n, np.cross(u, n)], axis=-1)
    return basis(u_t, n_t) @ np.swapaxes(basis(u_r, n_r), -1, -2)


class Fitter:
    def __init__(self, model: BodyModel, inst: BodyInstance):
        self.m, self.inst = model, inst
        L = model.idx
        self.b = {k: L[k] for k in [
            "root", "spine05", "spine04", "spine03", "spine02", "spine01", "neck01", "neck02", "neck03", "head",
            "clavicle.L", "clavicle.R", "shoulder01.L", "shoulder01.R", "upperarm01.L", "upperarm01.R",
            "upperarm02.L", "upperarm02.R", "lowerarm01.L", "lowerarm01.R", "lowerarm02.L", "lowerarm02.R",
            "wrist.L", "wrist.R", "pelvis.L", "pelvis.R", "upperleg01.L", "upperleg01.R", "upperleg02.L",
            "upperleg02.R", "lowerleg01.L", "lowerleg01.R", "lowerleg02.L", "lowerleg02.R", "foot.L", "foot.R"]}
        h = inst.rest_head
        b = self.b
        self.rest = {
            "pelvis": _frame(None, h[b["upperleg01.L"]] - h[b["upperleg01.R"]], h[b["neck01"]] - h[b["root"]]),
            "thorax": _frame(None, h[b["upperarm01.L"]] - h[b["upperarm01.R"]], h[b["neck01"]] - h[b["spine02"]]),
        }
        top = inst.rest_vertices[:, 2].max()
        head_top = h[b["head"]].copy(); head_top[2] = top
        self.rest_head_dir = head_top - h[b["neck01"]]
        self.head_top_rest = head_top

    def fit(self, J: np.ndarray, up_offset: np.ndarray | None = None) -> dict:
        """J: (T,17,3) world-frame joints (x fwd, y left, z up), root-relative metres."""
        T = len(J)
        m, inst, b = self.m, self.inst, self.b
        nb = len(m.labels)
        D = np.tile(np.eye(3), (T, nb, 1, 1))
        rh = inst.rest_head

        # ---- pelvis & thorax ----
        Fp = _frame(None, J[:, L_HIP] - J[:, R_HIP], J[:, THORAX] - J[:, PELVIS])
        Ft = _frame(None, J[:, L_SH] - J[:, R_SH], J[:, THORAX] - J[:, SPINE])
        Rp = Fp @ self.rest["pelvis"].T
        Rt = Ft @ self.rest["thorax"].T
        D[:, b["root"]] = Rp
        rel = Rotation.from_matrix(np.swapaxes(Rp, -1, -2) @ Rt).as_rotvec()
        for frac, name in zip((0.15, 0.35, 0.55, 0.78, 1.0), ("spine05", "spine04", "spine03", "spine02", "spine01")):
            D[:, b[name]] = Rp @ Rotation.from_rotvec(rel * frac).as_matrix()
        D_th = D[:, b["spine01"]]

        # ---- head ----
        v_r = np.einsum("tij,j->ti", D_th, self.rest_head_dir)
        Dh = _rot_min(v_r, J[:, HEAD] - J[:, THORAX]) @ D_th
        for name, w in (("neck01", 0.5), ("neck02", 0.7), ("neck03", 0.85), ("head", 1.0)):
            D[:, b[name]] = Rotation.from_rotvec(Rotation.from_matrix(Dh @ np.swapaxes(D_th, -1, -2)).as_rotvec() * w).as_matrix() @ D_th

        # ---- arms ----
        for s, SH, EL, WR in (("L", L_SH, L_EL, L_WR), ("R", R_SH, R_EL, R_WR)):
            for n in ("clavicle", "shoulder01"):
                D[:, b[f"{n}.{s}"]] = D_th
            u_r = rh[b[f"lowerarm01.{s}"]] - rh[b[f"upperarm01.{s}"]]
            f_r = rh[b[f"wrist.{s}"]] - rh[b[f"lowerarm01.{s}"]]
            n_r = np.cross(_unit(u_r), _unit(f_r))
            u_t = J[:, EL] - J[:, SH]
            f_t = J[:, WR] - J[:, EL]
            n_t = self._bend_normals(u_t, f_t, np.einsum("tij,j->ti", D_th, n_r))
            Dua = _two_vector(np.tile(u_r, (T, 1)), np.tile(n_r, (T, 1)), u_t, n_t)
            D[:, b[f"upperarm01.{s}"]] = Dua
            D[:, b[f"upperarm02.{s}"]] = Dua
            Dfa = _rot_min(np.einsum("tij,j->ti", Dua, f_r), f_t) @ Dua
            for n in ("lowerarm01", "lowerarm02", "wrist"):
                D[:, b[f"{n}.{s}"]] = Dfa
        # ---- legs ----
        heading = Rp[:, :, 0].copy(); heading[:, 2] = 0
        heading = _unit(heading + 1e-9)
        for s, HP, KN, AN in (("L", L_HIP, L_KNEE, L_ANK), ("R", R_HIP, R_KNEE, R_ANK)):
            D[:, b[f"pelvis.{s}"]] = Rp
            u_r = rh[b[f"lowerleg01.{s}"]] - rh[b[f"upperleg01.{s}"]]
            f_r = rh[b[f"foot.{s}"]] - rh[b[f"lowerleg01.{s}"]]
            n_r = np.array([0.0, 1.0, 0.0])      # mediolateral knee axis (world 'left')
            u_t = J[:, KN] - J[:, HP]
            f_t = J[:, AN] - J[:, KN]
            n_t = self._bend_normals(u_t, f_t, np.einsum("tij,j->ti", Rp, n_r), straight_deg=12)
            Dth = _two_vector(np.tile(u_r, (T, 1)), np.tile(n_r, (T, 1)), u_t, n_t)
            D[:, b[f"upperleg01.{s}"]] = Dth
            D[:, b[f"upperleg02.{s}"]] = Dth
            Dsh = _rot_min(np.einsum("tij,j->ti", Dth, f_r), f_t) @ Dth
            D[:, b[f"lowerleg01.{s}"]] = Dsh
            D[:, b[f"lowerleg02.{s}"]] = Dsh
            # level foot, pointing along the pelvis heading
            yaw = np.arctan2(heading[:, 1], heading[:, 0])
            D[:, b[f"foot.{s}"]] = Rotation.from_euler("z", yaw).as_matrix()

        # ---- propagate to every other bone (rigidly follow the parent) and run FK ----
        explicit = set(b.values())
        heads = np.zeros((T, nb, 3))
        for bone in m.order:
            p = m.parents[bone]
            if bone not in explicit and p >= 0:
                D[:, bone] = D[:, p]
            if p < 0:
                heads[:, bone] = J[:, PELVIS]
            else:
                heads[:, bone] = heads[:, p] + np.einsum("tij,j->ti", D[:, p], rh[bone] - rh[p])
        # root sits at the target pelvis; make bones' heads consistent with the root offset
        root = b["root"]
        heads = heads - heads[:, root:root + 1] + J[:, PELVIS:PELVIS + 1]
        if up_offset is not None:
            heads = heads + up_offset[:, None, :]
        return {"D": D, "heads": heads}

    @staticmethod
    def _bend_normals(u_t, f_t, default, straight_deg: float = 15.0):
        n = np.cross(_unit(u_t), _unit(f_t))
        s = np.linalg.norm(n, axis=-1)
        bend = np.degrees(np.arcsin(np.clip(s, 0, 1)))
        out = np.empty_like(n)
        prev = None
        for t in range(len(n)):
            if bend[t] >= straight_deg:
                cand = n[t] / s[t]   # flexion only goes one way, so cross(upper, lower) is the anatomical axis
                prev = cand
            elif prev is not None:
                cand = prev
            else:
                cand = default[t]
            out[t] = cand
        return out


def ground_offsets(model_heads: np.ndarray, foot_bones: list[int], ankle_height: float) -> np.ndarray:
    """Vertical offset per frame that places the lower foot on z=0 (smoothed)."""
    lowest = model_heads[:, foot_bones, 2].min(axis=1)
    off = ankle_height - lowest
    from scipy.ndimage import uniform_filter1d
    off = uniform_filter1d(off, size=min(len(off), 5), mode="nearest")
    out = np.zeros((len(off), 3)); out[:, 2] = off
    return out
