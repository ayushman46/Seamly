"""Accuracy benchmark: synthetic deliveries with exactly known answers, run through an engine and scored.

The clips are rendered by tools/synth_bowler.py from scripted skeletons (the body model is posed and drawn, so the
camera sees a body, not a stick figure) across frame rates, camera views, techniques (front knee, trunk lean,
side-bend), bowler heights, camera distance, and phone-like degradation (480p, JPEG artefacts, handheld shake).

    python -m tools.accuracy_bench generate OUT      # render the clips (H.264) with their truth
    python -m tools.accuracy_bench python OUT        # analyse every clip with the Python engine -> OUT/python/
    python -m tools.accuracy_bench score OUT ENGINE  # score OUT/ENGINE/*.json (python, or browser exports)

Truth comes from the rendered body: metrics as tools/synth_bowler.py defines them, 3D joints at the body model's
limb joints, and the posed mesh at the key events.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

# name, view, fps, stature (m), height entered by the user, technique variant, render options
CLIPS: list[tuple[str, str, float, float, bool, dict, dict]] = [
    ("side_60", "side", 60, 1.80, True, {}, {}),
    ("side_30", "side", 30, 1.80, True, {}, {}),
    ("side_120", "side", 120, 1.80, True, {}, {}),
    ("side_240", "side", 240, 1.80, True, {}, {}),
    ("side_knee_bent", "side", 60, 1.80, True, {"front_knee_bend": (30, 40)}, {}),
    ("side_knee_collapse", "side", 60, 1.80, True, {"front_knee_bend": (20, 55)}, {}),
    ("side_upright", "side", 60, 1.80, True, {"trunk_forward": 25}, {}),
    ("side_tall", "side", 60, 1.95, True, {}, {}),
    ("side_short_assumed", "side", 60, 1.62, False, {}, {}),
    ("side_far", "side", 60, 1.80, True, {}, {"scale": 0.55}),
    ("side_phone", "side", 30, 1.80, True, {}, {"size": (854, 480), "jpeg": 35, "shake": 25}),
    ("behind_60", "behind", 60, 1.80, True, {}, {}),
    ("behind_30", "behind", 30, 1.80, True, {}, {}),
    ("behind_120", "behind", 120, 1.80, True, {}, {}),
    ("behind_sidebend_15", "behind", 60, 1.80, True, {"side_bend": 15}, {}),
    ("behind_sidebend_45", "behind", 60, 1.80, True, {"side_bend": 45}, {}),
    ("behind_phone", "behind", 30, 1.80, True, {}, {"size": (854, 480), "jpeg": 35, "shake": 25}),
]

METRICS = ["front_knee_ffc", "front_knee_br", "back_knee_bfc", "trunk_forward_br", "trunk_flexion_ffc_br",
           "trunk_lateral_br", "stride_length_pct", "release_height_pct", "bfc_to_ffc_ms", "ffc_to_br_ms"]
EVENTS = ["bfc", "ffc", "uah", "br", "ft"]


def generate(out: Path) -> None:
    from tools.synth_bowler import render, variant
    out.mkdir(parents=True, exist_ok=True)
    for name, view, fps, H, entered, var, opts in CLIPS:
        if (out / f"{name}.json").exists():
            continue
        gt, arrays = render(out / f"{name}.mp4", view, fps, H, keys=variant(**var), fourcc="avc1", **opts)
        gt.update({"name": name, "stature_m": H, "height_entered": entered, "variant": var,
                   "render": {k: (list(v) if isinstance(v, tuple) else v) for k, v in opts.items()}})
        np.savez_compressed(out / f"{name}.npz", **arrays)
        (out / f"{name}.json").write_text(json.dumps(gt, indent=1))
        print(name, {k: round(gt[k], 1) for k in METRICS}, flush=True)


def run_python(out: Path) -> None:
    from bowlnet.pipeline import Options, analyse
    dst = out / "python"
    dst.mkdir(exist_ok=True)
    for name, *_ in CLIPS:
        if (dst / f"{name}.json").exists():
            continue
        gt = json.loads((out / f"{name}.json").read_text())
        # the arm is given, as a user answering the app's arm question would (a faceless mannequin is front/back
        # ambiguous from behind)
        res = analyse(str(out / f"{name}.mp4"), dst / name,
                      Options(height_m=gt["stature_m"] if gt["height_entered"] else None, bowling_arm="right"))
        (dst / f"{name}.json").write_text(json.dumps(res))
        print(name, "done", flush=True)


def _procrustes(a: np.ndarray, b: np.ndarray, scale: bool = True) -> np.ndarray:
    """b aligned to a by a similarity (or rigid) transform."""
    ma, mb = a.mean(0), b.mean(0)
    A, B = a - ma, b - mb
    U, s, Vt = np.linalg.svd(B.T @ A)
    d = np.sign(np.linalg.det(U @ Vt))
    D = np.diag([1, 1, d])
    R = U @ D @ Vt
    k = (s * np.diag(D)).sum() / (B ** 2).sum() if scale else 1.0
    return k * B @ R + ma


def _three_to_world():
    from bowlnet.body.export import world_to_three
    E = np.stack([world_to_three(np.eye(3)[i]) for i in range(3)])   # rows: images of the world axes
    return lambda p: np.asarray(p) @ E.T


def _angle(a, b, c):
    v1, v2 = a - b, c - b
    return float(np.degrees(np.arccos(np.clip((v1 @ v2) / (np.linalg.norm(v1) * np.linalg.norm(v2) + 1e-12), -1, 1))))


def score_clip(out: Path, engine: str, name: str) -> dict | None:
    rf = out / engine / f"{name}.json"
    if not rf.exists():
        return None
    gt = json.loads((out / f"{name}.json").read_text())
    arr = np.load(out / f"{name}.npz")
    res = json.loads(rf.read_text())
    res = res.get("result", res)
    fps = gt["fps"]
    row: dict = {"name": name, "view": gt["view"], "fps": fps, "found_view": res["view"]["view"],
                 "oblique": bool(res["view"].get("oblique")), "events": {}, "metrics": {}}
    for k in EVENTS:
        e = (res.get("events") or {}).get(k)
        if e and e.get("frame") is not None:
            d = e["frame"] - gt["events"][k]
            row["events"][k] = {"frames": d, "ms": 1000 * d / fps, "method": e.get("method")}
    by = {m["key"]: m for m in res["metrics"]}
    for k in METRICS:
        m = by.get(k)
        truth = gt[k]
        if m is None or m.get("value") is None:
            row["metrics"][k] = {"truth": truth, "value": None}
            continue
        row["metrics"][k] = {"truth": truth, "value": m["value"], "error": m["value"] - truth,
                             "reliability": m.get("reliability"), "rating": m.get("rating")}

    # 3D: the reconstructed skeleton against the rendered body's limb joints, over the delivery
    to_world = _three_to_world()
    f0 = res["frames"]["start"]
    rec = to_world(np.array(res["skeleton3d"]["joints"]))            # (Tw, 17, 3)
    ids = arr["joint_ids"]
    tj = arr["joints"]                                                  # (T, 12, 3)
    lo = max(f0, gt["events"]["bfc"] - int(0.1 * fps))
    hi = min(f0 + len(rec) - 1, gt["events"]["ft"])
    pa = []
    for f in range(lo, hi + 1):
        r = rec[f - f0][ids]
        t = tj[f]
        pa.append(np.linalg.norm(_procrustes(t, r) - t, axis=1))
    pa = np.array(pa)
    row["pa_mpjpe_mm"] = float(1000 * pa.mean())
    row["pa_mpjpe_br_mm"] = float(1000 * pa[min(len(pa) - 1, gt["events"]["br"] - lo)].mean())
    row["worst_joint"] = ["r_hip", "r_knee", "r_ankle", "l_hip", "l_knee", "l_ankle", "l_sh", "l_elb", "l_wr", "r_sh",
                          "r_elb", "r_wr"][int(pa.mean(0).argmax())]
    # 3D knee angles (the front knee is the left for this right-arm bowler)
    for ev in ("ffc", "br"):
        f = gt["events"][ev]
        if f0 <= f < f0 + len(rec):
            r = rec[f - f0]
            row[f"knee3d_{ev}"] = {"truth": gt[f"front_knee_{ev}"], "value": _angle(r[4], r[5], r[6])}

    # mesh: the body posed from the reconstruction, against the rendered body, at the key events
    from bowlnet.body.fit import Fitter
    from bowlnet.body.model import BodyModel
    m = BodyModel.get()
    stature = res["skeleton"]["stature_m"]
    inst = m.instance(stature)
    W = rec - rec[:, :1]                                               # root-relative
    fit = Fitter(m, inst).fit(W)
    V = m.skin(inst, fit["D"], fit["heads"])
    errs = {}
    for f, Vt in zip(arr["verts_frames"], arr["verts"]):
        if not (f0 <= f < f0 + len(V)):
            continue
        Vh = V[f - f0]
        rigid = np.linalg.norm(_procrustes(Vt, Vh, scale=False) - Vt, axis=1).mean()
        sim = np.linalg.norm(_procrustes(Vt, Vh) - Vt, axis=1).mean()
        ev = [k for k, v in gt["events"].items() if v == int(f)]
        errs["/".join(ev)] = {"rigid_cm": float(100 * rigid), "shape_cm": float(100 * sim)}
    row["mesh"] = errs
    row["stature_est"] = stature
    return row


def score(out: Path, engine: str) -> list[dict]:
    rows = [r for r in (score_clip(out, engine, name) for name, *_ in CLIPS) if r]
    (out / f"score_{engine}.json").write_text(json.dumps(rows, indent=1))
    return rows


def summary(out: Path, engine: str, exclude: list[str]) -> str:
    """Markdown: mean absolute error (and the worst case) per measurement and per event, by camera view."""
    rows = [r for r in json.loads((out / f"score_{engine}.json").read_text()) if r["name"] not in exclude]
    lines = []
    for view in ("side", "behind"):
        vr = [r for r in rows if r["view"] == view]
        if not vr:
            continue
        lines.append(f"\n{engine}, {view} ({len(vr)} clips)\n")
        lines.append("| | mean abs error | worst | clips measured |\n|---|---|---|---|")
        for k in EVENTS:
            v = [abs(r["events"][k]["ms"]) for r in vr if k in r["events"]]
            if v:
                lines.append(f"| {k} (ms) | {np.mean(v):.0f} | {max(v):.0f} | {len(v)} |")
        for k in METRICS:
            v = [r["metrics"][k] for r in vr if r["metrics"][k].get("value") is not None]
            if v:
                e = [abs(x["error"]) for x in v]
                lines.append(f"| {k} | {np.mean(e):.1f} | {max(e):.1f} | {len(v)}/{len(vr)} |")
        lines.append(f"| 3D joints, PA-MPJPE (mm) | {np.mean([r['pa_mpjpe_mm'] for r in vr]):.0f} | {max(r['pa_mpjpe_mm'] for r in vr):.0f} | {len(vr)} |")
        for ev in ("bfc", "ffc", "br"):
            v = [x["rigid_cm"] for r in vr for k, x in r["mesh"].items() if ev in k.split("/")]
            if v:
                lines.append(f"| body mesh at {ev} (cm, mean vertex) | {np.mean(v):.1f} | {max(v):.1f} | {len(v)} |")
    return "\n".join(lines)


if __name__ == "__main__":
    cmd, out = sys.argv[1], Path(sys.argv[2])
    if cmd == "generate":
        generate(out)
    elif cmd == "python":
        run_python(out)
    elif cmd == "summary":
        print(summary(out, sys.argv[3], sys.argv[4].split(",") if len(sys.argv) > 4 else []))
    elif cmd == "score":
        rows = score(out, sys.argv[3])
        for r in rows:
            ev = " ".join(f"{k}{v['frames']:+d}" for k, v in r["events"].items())
            mt = " ".join(f"{k.split('_')[0]}{k.split('_')[-1]}:{v['error']:+.1f}" for k, v in r["metrics"].items() if v.get("value") is not None)
            print(f"{r['name']:20s} view {r['found_view']:8s} PA-MPJPE {r['pa_mpjpe_mm']:5.0f} mm | {ev} | {mt}")
