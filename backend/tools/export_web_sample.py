"""Package a finished analysis as a static sample for the web app (opens instantly, no models needed).

    cd backend && ../.venv/bin/python -m tools.export_web_sample <aid> <name> <title> <out_dir>

Writes <out_dir>/<name>/{bundle.json, f/<frame>.jpg, mesh_rest.bin, pose.bin}. bundle.json holds the meta, the
result and Stage A (so corrections in the app re-run Stage B in the browser).
Only ship clips whose licence allows it (the club clip is CC BY-SA 4.0; the synthetic render is ours).
"""
import json
import shutil
import sys
from pathlib import Path

import numpy as np

from bowlnet import store
from tools.export_fixtures import enc


def main(aid: str, name: str, title: str, out: Path):
    src = store.root() / aid
    meta = json.loads((src / "meta.json").read_text())
    result = json.loads((src / "analysis.json").read_text())
    sa = json.loads((src / "stage_a.json").read_text())
    A = np.load(src / "stage_a.npz")
    d = out / name
    shutil.rmtree(d, ignore_errors=True)
    (d / "f").mkdir(parents=True)
    for f in range(result["frames"]["start"], result["frames"]["end"]):
        shutil.copy(src / "frames" / f"{f:06d}.jpg", d / "f" / f"{f}.jpg")
    for n in ("mesh_rest.bin", "pose.bin"):
        shutil.copy(src / n, d / n)
    keep = ("score", "grade", "view", "arm", "thumb_frame", "options", "timing_s", "summary", "overrides")
    bundle = {
        "meta": {**{k: meta.get(k) for k in keep}, "name": title, "status": "done", "sample": name},
        "result": result,
        "stagea": {"meta": sa, **{k: enc(A[k]) for k in A.files}},
    }
    (d / "bundle.json").write_text(json.dumps(bundle, separators=(",", ":")))
    size = sum(p.stat().st_size for p in d.rglob("*") if p.is_file())
    print(f"{name}: {result['frames']['end'] - result['frames']['start']} frames, {size / 1e6:.1f} MB")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3], Path(sys.argv[4]))
