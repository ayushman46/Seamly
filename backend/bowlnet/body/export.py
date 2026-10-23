"""Fit the body model to the analysed skeleton and export compact binaries for real-time skinning.

Files (little-endian):
  mesh_rest.bin : float32 positions (V*3) | uint16 indices (F*3) | uint8 skinIndex (V*4) | float32 skinWeight (V*4)
  pose.bin      : float32 bone matrices (T * B * 12), row-major 3x4, mapping rest -> posed
Coordinates are three.js world axes: +x = bowler's right, +y = up, -z = down the pitch (direction of travel).
"""
from __future__ import annotations

import io
import json
from pathlib import Path

import numpy as np

from ..store import write_atomic
from .fit import Fitter, ground_offsets
from .model import BodyModel

# analysis world (x fwd, y left, z up) -> three.js (x right, y up, z back)
W2T = np.array([[0.0, -1.0, 0.0],
                [0.0, 0.0, 1.0],
                [-1.0, 0.0, 0.0]])
ANKLE_HEIGHT_FRAC = 0.044


def world_to_three(p: np.ndarray) -> np.ndarray:
    return p @ W2T.T


def fit_body(W: np.ndarray, height: float, gender: float = 0.0):
    model = BodyModel.get()
    inst = model.instance(height, gender=gender)
    fitter = Fitter(model, inst)
    out = fitter.fit(W)
    feet = [fitter.b["foot.L"], fitter.b["foot.R"]]
    off = ground_offsets(out["heads"], feet, ANKLE_HEIGHT_FRAC * height)
    heads = out["heads"] + off[:, None, :]
    return model, inst, out["D"], heads, off


def _bone_groups(model, bowling_arm: str) -> dict:
    """Bone indices per body role, for colouring the mesh (bowling arm / front leg)."""
    s_arm = ".R" if bowling_arm == "right" else ".L"
    s_leg = ".L" if bowling_arm == "right" else ".R"
    arm_roots = ("upperarm", "lowerarm", "wrist", "finger", "metacarpal")
    leg_roots = ("upperleg", "lowerleg", "foot", "toe")
    arm = [i for i, n in enumerate(model.labels) if n.endswith(s_arm) and n.startswith(arm_roots)]
    leg = [i for i, n in enumerate(model.labels) if n.endswith(s_leg) and n.startswith(leg_roots)]
    return {"bowling_arm": arm, "front_leg": leg}


def export_mesh(out_dir: Path, W: np.ndarray, height: float, gender: float = 0.0, bowling_arm: str = "right") -> dict:
    model, inst, D, heads, off = fit_body(W, height, gender)
    T, B = D.shape[:2]
    # bone transforms in three.js axes: x' -> M D M^T x' + M (head - D rest_head)
    Dt = np.einsum("ij,tbjk,lk->tbil", W2T, D, W2T)
    trans = np.einsum("ij,tbj->tbi", W2T, heads - np.einsum("tbij,bj->tbi", D, inst.rest_head))
    mats = np.concatenate([Dt, trans[..., None]], axis=-1).astype(np.float32)   # (T,B,3,4)
    rest_v = world_to_three(inst.rest_vertices).astype(np.float32)
    faces = model.faces.astype(np.uint16)
    write_atomic(out_dir / "mesh_rest.bin", rest_v.tobytes() + faces.tobytes()
                 + model.vbi4.astype(np.uint8).tobytes() + model.vbw4.astype(np.float32).tobytes())
    write_atomic(out_dir / "pose.bin", mats.reshape(T, B * 12).tobytes())
    buf = io.BytesIO()
    np.save(buf, off.astype(np.float32))
    write_atomic(out_dir / "ground_offset.npy", buf.getvalue())
    return {"vertices": int(len(rest_v)), "faces": int(len(faces)), "bones": int(B), "frames": int(T),
            "coords": "three", "stature_m": height, "gender": gender,
            "files": {"rest": "mesh_rest.bin", "pose": "pose.bin"},
            "bone_groups": _bone_groups(model, bowling_arm),
            "model": "NAVER Anny (CC0 assets / Apache-2.0 code)"}


def frame_obj(out_dir: Path, frame_index: int) -> str:
    """OBJ text for one analysed frame (index into the analysis window), in metres, y-up."""
    rest = (out_dir / "mesh_rest.bin").read_bytes()
    meta = json.loads((out_dir / "analysis.json").read_text())["mesh"]
    V, F, B = meta["vertices"], meta["faces"], meta["bones"]
    o = 0
    pos = np.frombuffer(rest, np.float32, V * 3, o).reshape(V, 3); o += V * 12
    idx = np.frombuffer(rest, np.uint16, F * 3, o).reshape(F, 3); o += F * 6
    si = np.frombuffer(rest, np.uint8, V * 4, o).reshape(V, 4); o += V * 4
    sw = np.frombuffer(rest, np.float32, V * 4, o).reshape(V, 4)
    pose = np.frombuffer((out_dir / "pose.bin").read_bytes(), np.float32).reshape(-1, B, 3, 4)
    fi = int(np.clip(frame_index, 0, len(pose) - 1))
    M = pose[fi]
    vh = np.concatenate([pos, np.ones((V, 1), np.float32)], 1)
    out = np.zeros((V, 3), np.float32)
    for k in range(4):
        out += sw[:, k:k + 1] * np.einsum("vij,vj->vi", M[si[:, k]], vh)
    lines = ["# BowlNet body mesh (NAVER Anny topology), metres, y-up", f"# frame index {fi}"]
    lines += [f"v {x:.5f} {y:.5f} {z:.5f}" for x, y, z in out]
    lines += [f"f {a + 1} {b + 1} {c + 1}" for a, b, c in idx]
    return "\n".join(lines) + "\n"
