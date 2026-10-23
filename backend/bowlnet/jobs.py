"""Single-worker background queue (the ML models are heavy and not meant to run concurrently)."""
from __future__ import annotations

import logging
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor

from . import progress, store
from .pipeline import AnalysisError, Options, analyse

log = logging.getLogger("bowlnet.jobs")
_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="bowlnet-worker")
_queue_lock = threading.Lock()
_queued: list[str] = []
_active: set[str] = set()
model_lock = threading.Lock()   # shared with synchronous recompute calls


def submit(aid: str) -> None:
    with _queue_lock:
        _queued.append(aid)
    store.write_meta(aid, status="queued", progress=0.0, stage="queued", stage_label="Waiting in queue")
    _pool.submit(_run, aid)


def queue_position(aid: str) -> int | None:
    """Number of analyses ahead of this one (including the one currently running)."""
    with _queue_lock:
        return _queued.index(aid) + len(_active) if aid in _queued else None


def _run(aid: str) -> None:
    try:
        meta = store.read_meta(aid)
    except KeyError:   # deleted while queued
        with _queue_lock:
            if aid in _queued:
                _queued.remove(aid)
        return
    with _queue_lock:
        if aid in _queued:
            _queued.remove(aid)
        _active.add(aid)
    try:
        _run_inner(aid, meta)
    finally:
        with _queue_lock:
            _active.discard(aid)


def _what(meta: dict, prev: dict) -> str:
    new_sm = float((meta.get("options") or {}).get("slowmo_factor") or 1.0)
    old_sm = float((prev.get("options") or {}).get("slowmo_factor") or 1.0)
    if new_sm != old_sm:
        return " in real time" if new_sm == 1.0 else f" at {new_sm:g}x slow motion"
    return " of the other delivery" if (meta.get("options") or {}).get("candidate") is not None else ""


def _run_inner(aid: str, meta: dict) -> None:
    d = store.path(aid)
    video = d / meta["input"]
    last = {"t": 0.0}

    def on_progress(p: dict) -> None:
        now = time.time()
        if now - last["t"] < 0.25 and p.get("progress", 0) < 0.999:
            return
        last["t"] = now
        store.write_meta(aid, status="running", progress=p["progress"], stage=p["stage"],
                         stage_label=p["label"], elapsed=p.get("elapsed"))

    # a re-analysis of a finished result (another delivery, new clip speed) can be rolled back if it fails
    # before replacing stage A: the previous frames, stage A and result are still on disk
    prev = meta.get("previous")
    before = store.stage_stamp(d)
    store.write_meta(aid, status="running", progress=0.0, stage="probe", stage_label="Reading video",
                     started=time.time(), notice=None, stamp=before)
    try:
        with model_lock, store.edit_lock(aid):
            result = analyse(str(video), d, Options.from_dict(meta.get("options")), on_progress,
                             overrides=meta.get("overrides"))
        c = result.get("coaching", {})
        store.write_meta(aid, status="done", progress=1.0, stage="done", stage_label="Complete",
                         finished=time.time(), score=c.get("score"), grade=c.get("grade"),
                         view=result.get("view", {}).get("view"), arm=result.get("bowling_arm", {}).get("arm"),
                         thumb_frame=result["events"]["br"]["frame"], timing_s=result.get("timing_s"),
                         summary=progress.summarise(result),
                         error=None, previous=None, stamp=None, suggest=None)
    except Exception as e:  # noqa: BLE001 - surface a friendly message, keep the trace in the log
        suggest = getattr(e, "suggest", None) or None
        if isinstance(e, AnalysisError):
            msg = str(e)
        else:
            log.error("analysis %s crashed:\n%s", aid, traceback.format_exc())
            msg = (f"Unexpected error while analysing this video ({type(e).__name__}). "
                   "Please try another clip or retry.")
        store.clean_staging(d)
        if prev and before is not None and store.stage_stamp(d) == before:
            store.write_meta(aid, status="done", progress=1.0, stage="done", stage_label="Complete",
                             finished=time.time(), error=None, options=prev["options"], overrides=prev["overrides"],
                             previous=None, stamp=None, notice=f"The re-analysis{_what(meta, prev)} didn't work, so the previous "
                                                   f"result is kept. {msg}")
        else:
            store.write_meta(aid, status="failed", error=msg, finished=time.time(), previous=None, stamp=None,
                             suggest=suggest)
