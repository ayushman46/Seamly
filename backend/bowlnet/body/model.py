"""Runtime for the compact Anny body model (see tools/export_body_model.py).

Coordinates: Anny is Z-up with -Y forward and +X to the model's left. We convert everything to the
analysis world frame (x forward, y left, z up) at load time so the rest of the code never has to care.
"""
from __future__ import annotations

import threading
from dataclasses import dataclass

import numpy as np

from .. import config

# Anny (x left, y back, z up) -> world (x forward, y left, z up)
A2W = np.array([[0.0, -1.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 0.0, 1.0]])

_lock = threading.Lock()
_cache: dict[str, "BodyModel"] = {}


@dataclass
class BodyInstance:
    rest_vertices: np.ndarray   # (V,3) world axes, metres
    rest_rot: np.ndarray        # (B,3,3) rest bone orientations (world axes)
    rest_head: np.ndarray       # (B,3) rest bone head positions
    stature: float


class BodyModel:
    def __init__(self, path=None):
        d = np.load(str(path or config.BODY_MODEL))
        self.gg, self.gh, self.gw = d["grid_gender"], d["grid_height"], d["grid_weight"]
        self.rest_vertices = d["rest_vertices"].astype(np.float64)
        self.rest_poses = d["rest_bone_poses"].astype(np.float64)
        self.stature_grid = d["stature_m"].astype(np.float64)
        self.faces = d["faces"].astype(np.int32)
        self.parents = d["bone_parents"].astype(np.int64)
        self.labels = [str(x) for x in d["bone_labels"]]
        self.idx = {n: i for i, n in enumerate(self.labels)}
        vbi = d["vertex_bone_indices"].astype(np.int64)
        vbw = d["vertex_bone_weights"].astype(np.float64)
        self.vbi_full, self.vbw_full = vbi, vbw
        # top-4 influences (renormalised) for real-time skinning in the browser
        order = np.argsort(-vbw, axis=1)[:, :4]
        self.vbi4 = np.take_along_axis(vbi, order, 1)
        w4 = np.take_along_axis(vbw, order, 1)
        self.vbw4 = w4 / np.maximum(w4.sum(1, keepdims=True), 1e-9)
        # topological order (parents before children)
        self.order = []
        seen = set()
        def visit(b):
            if b in seen:
                return
            p = self.parents[b]
            if p >= 0:
                visit(p)
            seen.add(b)
            self.order.append(b)
        for b in range(len(self.labels)):
            visit(b)

    @staticmethod
    def get() -> "BodyModel":
        with _lock:
            if "default" not in _cache:
                _cache["default"] = BodyModel()
            return _cache["default"]

    def instance(self, stature_m: float, gender: float = 0.0, weight: float = 0.5) -> BodyInstance:
        """Interpolate the phenotype grid (gender, height, weight) to the requested stature."""
        g = float(np.clip(gender, 0, 1)); w = float(np.clip(weight, self.gw[0], self.gw[-1]))
        def lerp_idx(grid, x):
            i = int(np.clip(np.searchsorted(grid, x) - 1, 0, len(grid) - 2))
            t = (x - grid[i]) / (grid[i + 1] - grid[i])
            return i, float(np.clip(t, 0, 1))
        gi, gt = lerp_idx(self.gg, g)
        wi, wt = lerp_idx(self.gw, w)
        # stature is linear in the height phenotype: find the height value giving the target stature
        st = (1 - gt) * self.stature_grid[gi] + gt * self.stature_grid[gi + 1]           # (H, W)
        st_w = (1 - wt) * st[:, wi] + wt * st[:, wi + 1]                                   # (H,)
        hval = float(np.interp(stature_m, st_w, self.gh))
        hi, ht = lerp_idx(self.gh, hval)

        def tri(arr):
            out = 0.0
            for a, wa in ((gi, 1 - gt), (gi + 1, gt)):
                for b, wb in ((hi, 1 - ht), (hi + 1, ht)):
                    for c, wc in ((wi, 1 - wt), (wi + 1, wt)):
                        if wa * wb * wc:
                            out = out + wa * wb * wc * arr[a, b, c]
            return out
        V = tri(self.rest_vertices)
        Pz = tri(self.rest_poses)
        R = Pz[:, :3, :3]
        u, _, vt = np.linalg.svd(R)
        R = u @ vt                                          # re-orthonormalise after blending
        head = Pz[:, :3, 3]
        # move to world axes, put the feet on z=0 and exactly match the requested stature
        V = V @ A2W.T; head = head @ A2W.T; R = A2W @ R
        z0 = V[:, 2].min()
        V[:, 2] -= z0; head[:, 2] -= z0
        s = stature_m / (V[:, 2].max())
        V *= s; head *= s
        return BodyInstance(V, R, head, stature_m)

    def skin(self, inst: BodyInstance, D: np.ndarray, heads: np.ndarray) -> np.ndarray:
        """Vertices for world delta rotations D (T,B,3,3) and posed bone heads (T,B,3) -> (T,V,3)."""
        T = D.shape[0]
        # bone transform: x -> D (x - rest_head) + head
        out = np.zeros((T, len(inst.rest_vertices), 3))
        vb, vw = self.vbi_full, self.vbw_full
        for k in range(vb.shape[1]):
            b = vb[:, k]
            w = vw[:, k]
            m = w > 0
            if not m.any():
                continue
            rel = inst.rest_vertices[m] - inst.rest_head[b[m]]               # (n,3)
            Dm = D[:, b[m]]                                                  # (T,n,3,3)
            out[:, m] += w[m][None, :, None] * (np.einsum("tnij,nj->tni", Dm, rel) + heads[:, b[m]])
        return out
