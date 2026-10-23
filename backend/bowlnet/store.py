"""On-disk store for analyses: data/analyses/<id>/{meta.json, input.*, analysis.json, frames/, *.bin}."""
from __future__ import annotations

import json
import os
import re
import shutil
import threading
import time
import uuid
from pathlib import Path

from . import config

_lock = threading.RLock()
ID_RE = re.compile(r"^[a-f0-9]{12}$")


_edit_locks: dict[str, threading.Lock] = {}


def edit_lock(aid: str) -> threading.Lock:
    """Serialises everything that rewrites an analysis' files (the job, recompute, reset, rerun)."""
    with _lock:
        return _edit_locks.setdefault(aid, threading.Lock())


def write_atomic(p: Path, data: str | bytes) -> None:
    """Readers see either the old or the new file, never a half-written one."""
    tmp = p.with_name(p.name + ".tmp")
    if isinstance(data, str):
        tmp.write_text(data)
    else:
        tmp.write_bytes(data)
    os.replace(tmp, p)


STAGING = ("frames.new", "stage_a.tmp.npz", "stage_a.json.tmp", "analysis.json.tmp", "mesh_rest.bin.tmp",
           "pose.bin.tmp", "ground_offset.npy.tmp")


def stage_stamp(d: Path) -> list[int] | None:
    """Modification times of the files a finished result consists of (None if one is missing)."""
    try:
        return [(d / f).stat().st_mtime_ns for f in ("stage_a.npz", "stage_a.json", "analysis.json")]
    except FileNotFoundError:
        return None


def clean_staging(d: Path) -> None:
    for name in STAGING:
        p = d / name
        if p.is_dir():
            shutil.rmtree(p, ignore_errors=True)
        else:
            p.unlink(missing_ok=True)


def root() -> Path:
    config.ANALYSES_DIR.mkdir(parents=True, exist_ok=True)
    return config.ANALYSES_DIR


def new_id() -> str:
    return uuid.uuid4().hex[:12]


def path(aid: str) -> Path:
    if not ID_RE.match(aid or ""):
        raise KeyError(aid)
    return root() / aid


def write_meta(aid: str, **fields) -> dict:
    with _lock:
        p = path(aid) / "meta.json"
        meta = json.loads(p.read_text()) if p.exists() else {}
        meta.update(fields)
        meta["updated"] = time.time()
        tmp = p.with_suffix(".tmp")
        tmp.write_text(json.dumps(meta))
        os.replace(tmp, p)
        return meta


def read_meta(aid: str) -> dict:
    p = path(aid) / "meta.json"
    if not p.exists():
        raise KeyError(aid)
    with _lock:
        return json.loads(p.read_text())


def list_meta() -> list[dict]:
    out = []
    for d in root().iterdir():
        if d.is_dir() and ID_RE.match(d.name) and (d / "meta.json").exists():
            try:
                out.append(json.loads((d / "meta.json").read_text()))
            except Exception:
                continue
    return sorted(out, key=lambda m: -m.get("created", 0))


def delete(aid: str) -> None:
    p = path(aid)
    if p.exists():
        shutil.rmtree(p)


def recover_interrupted() -> None:
    """Jobs that were running when the server stopped can't resume; mark them failed (user can retry).
    Upload folders without meta.json (an upload cut off mid-write) are removed."""
    for d in root().iterdir():
        if d.is_dir() and ID_RE.match(d.name) and not (d / "meta.json").exists():
            shutil.rmtree(d, ignore_errors=True)
    for m in list_meta():
        if m.get("status") not in ("queued", "running"):
            continue
        d = path(m["id"])
        clean_staging(d)
        prev = m.get("previous")
        now = stage_stamp(d)
        # a re-analysis that never started, or never replaced the previous result, can fall back to it
        intact = prev and now is not None and (m.get("stamp") == now or (m.get("status") == "queued" and not m.get("stamp")))
        if intact:
            write_meta(m["id"], status="done", progress=1.0, stage="done", stage_label="Complete",
                       options=prev["options"], overrides=prev["overrides"], previous=None, stamp=None, error=None,
                       notice="The server restarted during the re-analysis, so the previous result is kept.")
        else:
            write_meta(m["id"], status="failed", previous=None, stamp=None,
                       error="The server restarted while this analysis was running. Please retry.")
