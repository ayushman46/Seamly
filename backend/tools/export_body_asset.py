"""Convert models/body/anny_body.npz into the compact asset the in-browser engine loads (frontend/src/engine/body.ts).

Only what export_mesh needs is kept: the rest meshes and rest bone poses on the (gender, height) grid at the default
weight (BodyModel.instance always uses weight 0.5, which sits exactly on a grid node, so the other weight slices get
zero blend weight), the faces, and the top-4 skinning influences exactly as BodyModel computes them for mesh_rest.bin.

Files (little-endian, every array 4-byte aligned; offsets and shapes are in the JSON header):
  anny_body.json : sizes, grids, stature table, bone labels/parents, array table
  anny_body.bin  : rest_vertices f32 (G,H,V,3) | rest_bone_poses f32 (G,H,B,3,4) | skin_weight f32 (V,4)
                   | faces u16 (F,3) | skin_index u8 (V,4)

    cd backend && ../.venv/bin/python -m tools.export_body_asset [--out ../frontend/public/models]
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

from bowlnet import config
from bowlnet.body.model import BodyModel

WEIGHT = 0.5   # BodyModel.instance default


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=str(config.BODY_MODEL))
    ap.add_argument("--out", default=str(Path(__file__).resolve().parents[2] / "frontend" / "public" / "models"))
    a = ap.parse_args()
    d = np.load(a.src)
    model = BodyModel(a.src)
    gw = d["grid_weight"]
    wi = int(np.flatnonzero(np.isclose(gw, WEIGHT))[0])   # the only weight slice instance() blends with non-zero weight
    V, F, B = len(model.rest_vertices[0, 0, 0]), len(model.faces), len(model.labels)
    arrays = [
        ("rest_vertices", d["rest_vertices"][:, :, wi].astype("<f4")),            # (G,H,V,3) Anny axes, metres
        ("rest_bone_poses", d["rest_bone_poses"][:, :, wi, :, :3, :].astype("<f4")),   # (G,H,B,3,4)
        ("skin_weight", model.vbw4.astype("<f4")),                                 # (V,4) as written to mesh_rest.bin
        ("faces", model.faces.astype("<u2")),                                      # (F,3)
        ("skin_index", model.vbi4.astype("u1")),                                   # (V,4)
    ]
    assert model.faces.max() < 2 ** 16 and model.vbi4.max() < 2 ** 8
    table, chunks, off = {}, [], 0
    for name, arr in arrays:
        raw = np.ascontiguousarray(arr).tobytes()
        table[name] = {"offset": off, "dtype": arr.dtype.name, "shape": list(arr.shape)}
        pad = (-len(raw)) % 4
        chunks.append(raw + b"\0" * pad)
        off += len(raw) + pad
    meta = json.loads(str(d["meta"]))
    header = {
        "format": "bowlnet-anny-body", "version": 1, "source": meta.get("source"),
        "vertices": V, "faces": F, "bones": B, "weight": float(gw[wi]),
        # float32 values written as their exact float64 value, so JS sees the same numbers numpy does
        "grid_gender": [float(x) for x in d["grid_gender"]],
        "grid_height": [float(x) for x in d["grid_height"]],
        "stature_m": [[float(x) for x in row] for row in d["stature_m"][:, :, wi]],
        "bone_labels": model.labels, "bone_parents": [int(p) for p in model.parents],
        "arrays": table, "bytes": off,
    }
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "anny_body.bin").write_bytes(b"".join(chunks))
    (out / "anny_body.json").write_text(json.dumps(header, separators=(",", ":")))
    print(f"wrote {out / 'anny_body.bin'} ({off / 1e6:.2f} MB) and anny_body.json "
          f"({(out / 'anny_body.json').stat().st_size / 1e3:.1f} kB)")


if __name__ == "__main__":
    main()
