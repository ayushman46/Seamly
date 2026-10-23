"""
Export a compact, license-free body model from NAVER's Anny (Apache-2.0 code, CC0 MakeHuman assets).

The full `anny` package builds a ~780 MB cache on first use. At runtime we only need, for a small
grid of phenotypes, the rest mesh + rest skeleton, plus the (phenotype independent) skinning weights,
faces and bone hierarchy. This script writes all of that into one small .npz so the server can pose
and skin the mesh with plain PyTorch/NumPy (see bowlnet/body/model.py).

Usage:  python -m tools.export_body_model  (from the backend/ directory)
"""
from __future__ import annotations

import itertools
import json
import os
from pathlib import Path

import numpy as np
import torch

OUT = Path(__file__).resolve().parents[1] / "models" / "body" / "anny_body.npz"

GENDERS = [0.0, 1.0]                       # 0 = male, 1 = female (Anny convention)
HEIGHTS = [0.0, 0.25, 0.5, 0.75, 1.0]      # Anny 'height' phenotype (min..max)
WEIGHTS = [0.25, 0.5, 0.75]                # Anny 'weight' phenotype (min..max)
FIXED = dict(age=2.0 / 3.0, muscle=0.65, proportions=0.5)   # young adult, athletic build


def main() -> None:
    import anny

    model = anny.Anny().to(dtype=torch.float32)
    model.eval()
    nb = model.bone_count
    labels = list(model.bone_labels)
    parents = model.bone_parents.detach().cpu().numpy().astype(np.int32) if torch.is_tensor(model.bone_parents) \
        else np.asarray(model.bone_parents, dtype=np.int32)

    identity = torch.eye(4)[None, None].repeat(1, nb, 1, 1)
    rest_vertices, rest_poses, heights_m = [], [], []
    grid = list(itertools.product(GENDERS, HEIGHTS, WEIGHTS))
    with torch.no_grad():
        for g, h, w in grid:
            ph = {k: 0.5 for k in model.phenotype_labels}
            ph.update(FIXED)
            ph.update(gender=g, height=h, weight=w)
            out = model(pose_parameters=identity, phenotype_kwargs=ph)
            v = out["rest_vertices"][0].cpu().numpy().astype(np.float32)
            p = out["rest_bone_poses"][0].cpu().numpy().astype(np.float32)
            # sanity: identity pose must reproduce rest mesh
            pass  # identity "local-ref" pose = reference pose (not the rest pose); checked via LBS below
            rest_vertices.append(v)
            rest_poses.append(p)
            heights_m.append(float(v[:, 2].max() - v[:, 2].min()))
            print(f"gender={g} height={h} weight={w} -> stature {heights_m[-1]:.3f} m")

    # Verify our own LBS reproduces Anny for a random pose (guards against convention drift).
    torch.manual_seed(0)
    import roma
    rand_rot = roma.rotvec_to_rotmat(0.3 * torch.randn(1, nb, 3))
    pose = identity.clone()
    pose[..., :3, :3] = rand_rot
    with torch.no_grad():
        ph = {k: 0.5 for k in model.phenotype_labels}
        ph.update(FIXED)
        ph.update(gender=0.0, height=0.5, weight=0.5)
        out = model(pose_parameters=pose, phenotype_kwargs=ph)
        T = out["bone_poses"] @ torch.linalg.inv(out["rest_bone_poses"])
        idx = model.vertex_bone_indices.long()
        wts = model.vertex_bone_weights
        vh = torch.cat([out["rest_vertices"][0], torch.ones(out["rest_vertices"].shape[1], 1)], -1)
        M = (wts[..., None, None] * T[0][idx][:, :, :3, :]).sum(1)
        mine = torch.einsum("vij,vj->vi", M, vh)
        err = (mine - out["vertices"][0]).abs().max().item()
        print("LBS reproduction max error:", err)
        assert err < 1e-3

    np.savez_compressed(
        OUT,
        grid_gender=np.array(GENDERS, np.float32),
        grid_height=np.array(HEIGHTS, np.float32),
        grid_weight=np.array(WEIGHTS, np.float32),
        rest_vertices=np.stack(rest_vertices).reshape(len(GENDERS), len(HEIGHTS), len(WEIGHTS), -1, 3),
        rest_bone_poses=np.stack(rest_poses).reshape(len(GENDERS), len(HEIGHTS), len(WEIGHTS), nb, 4, 4),
        stature_m=np.array(heights_m, np.float32).reshape(len(GENDERS), len(HEIGHTS), len(WEIGHTS)),
        faces=model.faces.cpu().numpy().astype(np.int32),
        vertex_bone_indices=model.vertex_bone_indices.cpu().numpy().astype(np.int16),
        vertex_bone_weights=model.vertex_bone_weights.cpu().numpy().astype(np.float32),
        bone_parents=parents,
        bone_labels=np.array(labels),
        meta=np.array(json.dumps({
            "source": "NAVER Anny %s (Apache-2.0 code, CC0 1.0 MakeHuman/MPFB2 assets)" % getattr(anny, "__version__", ""),
            "up_axis": "z", "units": "m", "fixed_phenotype": FIXED,
        })),
    )
    print("wrote", OUT, os.path.getsize(OUT) // 1024, "KB")


if __name__ == "__main__":
    main()
