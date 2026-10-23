"""Record stage-B inputs/outputs of stored analyses as JSON fixtures for the TypeScript (in-browser) engine's
parity tests. Every function stage_b calls is wrapped; its bound arguments and return value are recorded.

    cd backend && ../.venv/bin/python -m tools.export_fixtures <aid>:<name> ... --out ../frontend/tests/fixtures
"""
from __future__ import annotations

import argparse
import base64
import dataclasses
import functools
import inspect
import json
import shutil
import sys
import tempfile
from pathlib import Path

import numpy as np

from bowlnet import config, pipeline, store
from bowlnet.events import Events, Side
from bowlnet.kinematics import Skeleton3D, WorldFrame


def enc(o):
    if isinstance(o, np.ndarray):
        if o.dtype.kind in "iub":
            return o.astype(int).tolist()
        return np.round(o.astype(np.float64), 7).tolist()
    if isinstance(o, (np.floating,)):
        return round(float(o), 7)
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, np.bool_):
        return bool(o)
    if isinstance(o, Side):
        return {"__side__": True, **{f.name: getattr(o, f.name) for f in dataclasses.fields(o)}}
    if isinstance(o, (Events, Skeleton3D)):
        return {f.name: enc(getattr(o, f.name)) for f in dataclasses.fields(o)}
    if isinstance(o, WorldFrame):
        return {"up": enc(o.up), "forward": enc(o.forward), "lateral": enc(o.lateral), "camera_pitch_deg": o.camera_pitch_deg}
    if isinstance(o, Path):
        return str(o)
    if isinstance(o, dict):
        return {str(k): enc(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [enc(v) for v in o]
    if isinstance(o, range):
        return list(o)
    if dataclasses.is_dataclass(o):
        return {f.name: enc(getattr(o, f.name)) for f in dataclasses.fields(o)}
    return o


def recorder(log: dict, name: str, fn, skip=()):
    sig = inspect.signature(fn)

    @functools.wraps(fn)
    def wrapped(*a, **k):
        b = sig.bind(*a, **k)
        b.apply_defaults()
        args = {n: enc(v) for n, v in b.arguments.items() if n not in skip}
        out = fn(*a, **k)
        log.setdefault(name, []).append({"args": args, "out": enc(out)})
        return out
    return wrapped


def export(aid: str, name: str, out_dir: Path, with_mesh: bool):
    src = store.root() / aid
    meta = json.loads((src / "meta.json").read_text())
    overrides = meta.get("overrides") or {}
    log: dict = {}
    import bowlnet.metrics as M
    import bowlnet.coaching as C
    import bowlnet.body.export as E
    patches = [(pipeline, n) for n in ("reconstruct", "decide_bowling_arm", "detect_events", "estimate_world_frame",
                                        "stride_across", "classify_view", "facing_direction", "stabilise",
                                        "body_height_px")] + [(M, "compute"), (C, "coach")]
    saved = [(mod, n, getattr(mod, n)) for mod, n in patches]
    real_export = E.export_mesh
    mesh_files = {}

    def export_mesh(out_dir_, W, height, gender=0.0, bowling_arm="right"):
        info = real_export(out_dir_, W, height, gender=gender, bowling_arm=bowling_arm)
        rec = {"args": {"W": enc(W), "height": height, "gender": gender, "bowling_arm": bowling_arm}, "out": enc(info)}
        for f in ("mesh_rest.bin", "pose.bin"):
            if with_mesh or f == "pose.bin":
                mesh_files[f] = base64.b64encode((Path(out_dir_) / f).read_bytes()).decode()
        rec["files"] = dict(mesh_files)
        log["export_mesh"] = [rec]
        return info
    try:
        for mod, n, fn in saved:
            setattr(mod, n, recorder(log, n, fn, skip=("ctx",) if n == "compute" else ()))
        # compute's ctx is a dataclass: record its fields explicitly
        inner_compute = M.compute
        def compute(ctx):
            out = inner_compute(ctx)
            log["compute"][-1]["args"] = {"ctx": enc({f.name: getattr(ctx, f.name) for f in dataclasses.fields(ctx)})}
            return out
        M.compute = compute
        E.export_mesh = export_mesh
        with tempfile.TemporaryDirectory() as td:
            d = Path(td)
            for f in ("stage_a.npz", "stage_a.json", "meta.json"):
                shutil.copy(src / f, d / f)
            result = pipeline.stage_b(d, overrides)
    finally:
        for mod, n, fn in saved:
            setattr(mod, n, fn)
        E.export_mesh = real_export
    A = np.load(src / "stage_a.npz")
    from bowlnet import insights as I
    player = {"id": "p_fixture", "name": "Fixture", "age_group": "u15", "style": "fast", "arm": "auto", "height_cm": None}
    fx = {"name": name, "aid": aid, "overrides": overrides,
          "stage_a_meta": json.loads((src / "stage_a.json").read_text()),
          "stage_a": {k: enc(A[k]) for k in A.files},
          "calls": log, "result": enc(result),
          "insights": {"player": player, "out": enc(I.insights(result, player)),
                       "out_anon": enc(I.insights(result, None))}}
    out_dir.mkdir(parents=True, exist_ok=True)
    p = out_dir / f"{name}.json"
    p.write_text(json.dumps(fx, separators=(",", ":")))
    print(f"{name}: {p.stat().st_size / 1e6:.1f} MB, calls: " + ", ".join(f"{k}x{len(v)}" for k, v in log.items()))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("items", nargs="+", help="aid:name")
    ap.add_argument("--out", default="../frontend/tests/fixtures")
    ap.add_argument("--mesh", default="", help="name of the fixture that also stores mesh_rest.bin")
    a = ap.parse_args()
    for it in a.items:
        aid, name = it.split(":")
        export(aid, name, Path(a.out), with_mesh=(name == a.mesh))
