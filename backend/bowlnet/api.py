"""HTTP API (FastAPI). Run:  uvicorn bowlnet.api:app --port 8000   (from backend/)"""
from __future__ import annotations

import csv
import io
import json
import logging
import math
import os
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Literal

import cv2
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import __version__, config, insights, jobs, players, progress, store
from .pipeline import AnalysisError, stage_b

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("bowlnet.api")

ALLOWED_EXT = {".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm"}

from contextlib import asynccontextmanager


@asynccontextmanager
async def _lifespan(_app):
    _startup()
    yield


app = FastAPI(title="BowlNet API", version=__version__, lifespan=_lifespan)
app.add_middleware(GZipMiddleware, minimum_size=1024)
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
                   allow_methods=["*"], allow_headers=["*"])


@app.middleware("http")
async def _upload_size_guard(request, call_next):
    # reject oversize uploads before the multipart body is spooled to disk
    if request.method == "POST" and request.url.path == "/api/analyses":
        try:
            cl = int(request.headers.get("content-length") or 0)
        except ValueError:
            cl = 0
        if cl > config.MAX_UPLOAD_MB * 1024 * 1024 + 1024 * 1024:
            return JSONResponse({"detail": f"File is larger than {config.MAX_UPLOAD_MB} MB. Trim the clip around "
                                           "the delivery."}, status_code=413)
    return await call_next(request)


def _startup() -> None:
    store.root()
    store.recover_interrupted()


def _require(aid: str) -> Path:
    try:
        d = store.path(aid)
    except KeyError:
        raise HTTPException(404, "Analysis not found") from None
    if not (d / "meta.json").exists():
        raise HTTPException(404, "Analysis not found")
    return d


class _edit_lock:
    """Per-analysis edit lock; gives up with 409 instead of waiting behind a whole analysis."""

    def __init__(self, aid: str, timeout: float = 10.0):
        self.lock, self.timeout = store.edit_lock(aid), timeout

    def __enter__(self):
        if not self.lock.acquire(timeout=self.timeout):
            raise HTTPException(409, "This analysis is busy (being re-analysed). Try again in a moment.")
        return self

    def __exit__(self, *exc):
        self.lock.release()
        return False


def _require_done(aid: str) -> Path:
    d = _require(aid)
    if not (d / "analysis.json").exists():
        raise HTTPException(409, "This analysis isn't finished yet.")
    return d


def _public_meta(m: dict) -> dict:
    keys = ("id", "name", "created", "updated", "status", "progress", "stage", "stage_label", "error", "score",
            "grade", "view", "arm", "thumb_frame", "options", "timing_s", "elapsed", "size_mb", "notice", "suggest",
            "player_id")
    out = {k: m.get(k) for k in keys}
    if m.get("status") == "queued":
        out["queue_position"] = jobs.queue_position(m["id"])
    return out


# ------------------------------------------------------------------------------------------------------
@app.get("/api/health")
def health() -> dict:
    files = {
        "yolo_track": config.YOLO_TRACK_WEIGHTS, "yolo_refine": config.YOLO_REFINE_WEIGHTS,
        "motionbert": config.MOTIONBERT_WEIGHTS, "body_model": config.BODY_MODEL,
    }
    missing = [k for k, p in files.items() if not Path(p).exists()]
    return {"ok": not missing, "version": __version__, "device": config.torch_device(), "missing_models": missing}


@app.post("/api/analyses")
async def create_analysis(
    file: UploadFile = File(...),
    bowling_arm: str = Form("auto"),
    height_cm: float | None = Form(None),
    slowmo_factor: float = Form(1.0),
    name: str | None = Form(None),
    player_id: str | None = Form(None),
    profile_defaults: str | None = Form(None),   # "false": keep the form's values (a str: absent bools parse as False)
) -> dict:
    ext = Path(file.filename or "").suffix.lower()
    if ext not in ALLOWED_EXT:
        raise HTTPException(400, f"Unsupported file type '{ext or '?'}'. Upload MP4, MOV, AVI, MKV or WEBM.")
    if height_cm is not None and not (math.isfinite(height_cm) and 120 <= height_cm <= 230):
        raise HTTPException(400, "Height must be between 120 and 230 cm.")
    if not (math.isfinite(slowmo_factor) and 1 <= slowmo_factor <= 20):
        raise HTTPException(400, "Clip speed must be between 1x and 20x slow motion.")
    player = None
    if player_id:
        try:
            player = players.get(player_id)
        except KeyError:
            raise HTTPException(400, "Unknown player.") from None
        # the player's profile fills in what the request left open. The web app pre-fills its form from the
        # profile and sends profile_defaults=false, so a per-clip choice ("auto" arm, blank height) is respected.
        if (profile_defaults or "true").strip().lower() not in ("false", "0", "no"):
            if bowling_arm == "auto" and player.get("arm") in ("left", "right"):
                bowling_arm = player["arm"]
            if height_cm is None and player.get("height_cm"):
                height_cm = float(player["height_cm"])
    aid = store.new_id()
    d = store.root() / aid
    d.mkdir(parents=True)
    dest = d / f"input{ext}"
    size = 0
    limit = config.MAX_UPLOAD_MB * 1024 * 1024
    try:
        with open(dest, "wb") as f:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > limit:
                    raise HTTPException(413, f"File is larger than {config.MAX_UPLOAD_MB} MB. Trim the clip around the delivery.")
                f.write(chunk)
    except BaseException:   # oversize, client disconnect, full disk...: never leave a half upload behind
        shutil.rmtree(d, ignore_errors=True)
        raise
    if size == 0:
        shutil.rmtree(d, ignore_errors=True)
        raise HTTPException(400, "The uploaded file is empty.")
    opts = {"bowling_arm": bowling_arm if bowling_arm in ("auto", "left", "right") else "auto",
            "height_m": round(height_cm / 100.0, 3) if height_cm else None,
            "slowmo_factor": float(slowmo_factor)}
    store.write_meta(aid, id=aid, name=(name or Path(file.filename or "Delivery").stem)[:80], created=time.time(),
                     input=dest.name, options=opts, status="queued", size_mb=round(size / 1e6, 2),
                     player_id=player["id"] if player else None)
    jobs.submit(aid)
    return {"id": aid}


_demo_lock = threading.Lock()


@app.post("/api/demo")
def create_demo() -> dict:
    """Queue a demo analysis: a scripted side-on delivery rendered with the body model, so every number has an
    exact ground truth. Lets people try the app without a video; the clip is rendered once and cached."""
    demo = config.DATA_DIR / "demo" / "synthetic_side_60fps.mp4"
    with _demo_lock:
        if not demo.exists():
            demo.parent.mkdir(parents=True, exist_ok=True)
            tmp = demo.with_name("render.mp4")
            try:
                subprocess.run([sys.executable, "-m", "tools.synth_bowler", str(tmp), "--view", "side", "--fps", "60"],
                               cwd=config.BACKEND_ROOT, check=True, capture_output=True, timeout=300)
            except (subprocess.SubprocessError, OSError) as e:
                log.error("demo render failed: %s", getattr(e, "stderr", e))
                raise HTTPException(500, "Couldn't create the demo clip.") from None
            cap = cv2.VideoCapture(str(tmp))
            n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0) if cap.isOpened() else 0
            cap.release()
            if n < 30:   # never cache a broken render
                tmp.unlink(missing_ok=True)
                log.error("demo render produced an unreadable clip (%d frames)", n)
                raise HTTPException(500, "Couldn't create the demo clip.")
            os.replace(tmp, demo)
            if tmp.with_suffix(".json").exists():   # the render's exact ground truth, kept next to the clip
                os.replace(tmp.with_suffix(".json"), demo.with_suffix(".json"))
    aid = store.new_id()
    d = store.root() / aid
    d.mkdir(parents=True)
    try:
        shutil.copyfile(demo, d / "input.mp4")
    except OSError:
        shutil.rmtree(d, ignore_errors=True)
        raise HTTPException(500, "Couldn't start the demo (disk full?).") from None
    store.write_meta(aid, id=aid, name="Demo: synthetic side-on delivery (60 fps)", created=time.time(),
                     input="input.mp4", status="queued", size_mb=round(demo.stat().st_size / 1e6, 2),
                     options={"bowling_arm": "auto", "height_m": 1.80, "slowmo_factor": 1.0})
    jobs.submit(aid)
    return {"id": aid}


@app.get("/api/analyses")
def list_analyses() -> list[dict]:
    return [_public_meta(m) for m in store.list_meta()]


@app.get("/api/analyses/{aid}")
def get_analysis(aid: str):
    d = _require(aid)
    meta = store.read_meta(aid)
    out = {"meta": _public_meta(meta)}
    if meta.get("status") == "done" and (d / "analysis.json").exists():
        return Response(content=b'{"meta":' + json.dumps(out["meta"]).encode() + b',"result":'
                        + (d / "analysis.json").read_bytes() + b"}", media_type="application/json")
    return out


@app.get("/api/analyses/{aid}/status")
def get_status(aid: str) -> dict:
    _require(aid)
    return _public_meta(store.read_meta(aid))


EVENT_KEYS = ("bfc", "ffc", "uah", "br", "ft")


class Recompute(BaseModel):
    events: dict[str, int | None] | None = None
    bowling_arm: str | None = None
    height_m: float | None = Field(None, ge=1.2, le=2.3)
    slowmo_factor: float | None = Field(None, ge=1, le=20)
    view: str | None = None
    gender: float | None = Field(None, ge=0, le=1)


def _require_editable(aid: str) -> dict:
    meta = store.read_meta(aid)
    if meta.get("status") != "done":
        raise HTTPException(409, "This analysis isn't finished yet." if meta.get("status") in ("queued", "running")
                            else "This analysis has no result to edit. Retry it first.")
    return meta


def _apply(aid: str, d: Path, meta: dict, overrides: dict, latest: list[str] | None = None) -> JSONResponse:
    """Run the light stage with these overrides and persist the result (caller holds the edit lock).
    latest: events changed by this request, so an ordering error names the marker the user just moved."""
    try:
        result = stage_b(d, {**overrides, "latest_events": latest} if latest else overrides)
    except AnalysisError as e:
        raise HTTPException(400, str(e)) from None
    result["timing_s"] = meta.get("timing_s")
    store.write_atomic(d / "analysis.json", json.dumps(result))
    c = result["coaching"]
    meta = store.write_meta(aid, overrides=overrides, score=c.get("score"), grade=c.get("grade"), notice=None,
                            summary=progress.summarise(result),
                            arm=result["bowling_arm"]["arm"], view=result["view"]["view"],
                            thumb_frame=result["events"]["br"]["frame"])
    return JSONResponse({"meta": _public_meta(meta), "result": result})


@app.post("/api/analyses/{aid}/recompute")
def recompute(aid: str, body: Recompute):
    d = _require(aid)
    _require_editable(aid)   # fail fast instead of queueing behind a running analysis
    overrides = {k: v for k, v in body.model_dump().items() if v is not None}
    # stage B uses no ML models (reconstruction + metrics only), so edits stay instant even while another video
    # is being analysed. Read-merge-compute-write happens under the per-analysis lock so quick successive
    # edits (dragging two markers) can't drop one another, and a re-analysis can't interleave.
    with _edit_lock(aid):
        meta = _require_editable(aid)
        sm = overrides.pop("slowmo_factor", None)
        if sm is not None and abs(sm - float((meta.get("options") or {}).get("slowmo_factor") or 1.0)) > 1e-6:
            raise HTTPException(400, "Changing the clip speed needs a re-analysis (it changes the analysis "
                                     "window). Use rerun with slowmo_factor.")
        prev = meta.get("overrides") or {}
        merged = {**prev, **overrides}
        if "events" in overrides:
            overrides["events"] = {k: v for k, v in overrides["events"].items() if k in EVENT_KEYS}
            merged["events"] = {**(prev.get("events") or {}), **overrides["events"]}
            merged["events"] = {k: v for k, v in merged["events"].items() if v is not None}
        return _apply(aid, d, meta, merged, latest=list(overrides.get("events") or {}))


class Reset(BaseModel):
    events_only: bool = False


@app.post("/api/analyses/{aid}/reset")
def reset_edits(aid: str, body: Reset | None = None):
    """Drop user edits: only the event markers (events_only) or every correction."""
    d = _require(aid)
    _require_editable(aid)
    with _edit_lock(aid):
        meta = _require_editable(aid)
        keep = {k: v for k, v in (meta.get("overrides") or {}).items() if k != "events"} if body and body.events_only else {}
        return _apply(aid, d, meta, keep)


class Rerun(BaseModel):
    candidate: int | None = None
    shot: int | None = None
    bowling_arm: str | None = None
    height_m: float | None = Field(None, ge=1.2, le=2.3)
    slowmo_factor: float | None = Field(None, ge=1, le=20)


@app.post("/api/analyses/{aid}/rerun")
def rerun(aid: str, body: Rerun) -> dict:
    _require(aid)
    if store.read_meta(aid).get("status") in ("queued", "running"):
        raise HTTPException(409, "Analysis is already running")
    with _edit_lock(aid):   # waits for an in-flight edit so it can't write stale overrides afterwards
        meta = store.read_meta(aid)
        if meta.get("status") in ("queued", "running"):
            raise HTTPException(409, "Analysis is already running")
        # corrections made in Settings (height, bowling arm) carry over; event markers belong to the old window
        prev = meta.get("overrides") or {}
        old_opts = meta.get("options") or {}
        carried = {k: prev[k] for k in ("bowling_arm", "height_m") if prev.get(k) is not None}
        req = {k: v for k, v in body.model_dump().items() if v is not None}
        opts = {**old_opts, **carried, **req}
        if "slowmo_factor" in req and req["slowmo_factor"] != old_opts.get("slowmo_factor") and "candidate" not in req:
            opts.pop("candidate", None)   # candidates are re-scored at the new clip speed; their order may change
        keep = {k: prev[k] for k in ("gender",) if prev.get(k) is not None}
        # remember the finished state so a failed re-analysis can fall back to it
        previous = {"options": old_opts, "overrides": prev} if meta.get("status") == "done" else None
        store.write_meta(aid, options=opts, overrides=keep, error=None, previous=previous)
        jobs.submit(aid)
    return {"id": aid}


class AnalysisPatch(BaseModel):
    name: str | None = Field(None, max_length=80)
    player_id: str | None = None   # null unassigns


@app.patch("/api/analyses/{aid}")
def patch_analysis(aid: str, body: AnalysisPatch) -> dict:
    """Rename an analysis or move it to (or off) a player profile."""
    _require(aid)
    fields: dict = {}
    if body.name is not None and body.name.strip():
        fields["name"] = body.name.strip()
    if "player_id" in body.model_fields_set:
        if body.player_id is not None:
            try:
                players.get(body.player_id)
            except KeyError:
                raise HTTPException(400, "Unknown player.") from None
        fields["player_id"] = body.player_id
    return _public_meta(store.write_meta(aid, **fields) if fields else store.read_meta(aid))


@app.get("/api/analyses/{aid}/insights")
def analysis_insights(aid: str) -> dict:
    """Plain-language summary, lower-back screen and two-week practice plan for this delivery."""
    d = _require_done(aid)
    meta = store.read_meta(aid)
    player = None
    if meta.get("player_id"):
        try:
            player = players.get(meta["player_id"])
        except KeyError:
            player = None
    return insights.insights(json.loads((d / "analysis.json").read_text()), player)


# ------------------------------------------------------------------------------------------------------
# players
class PlayerIn(BaseModel):
    name: str | None = Field(None, max_length=60)
    age_group: Literal["u11", "u13", "u15", "u17", "u19", "adult"] | None = None
    style: Literal["fast", "medium", "spin"] | None = None
    arm: Literal["auto", "right", "left"] | None = None
    height_cm: float | None = Field(None, ge=120, le=230)


def _player_out(p: dict, metas: list[dict]) -> dict:
    mine = sorted((m for m in metas if m.get("player_id") == p["id"] and m.get("status") == "done"),
                  key=lambda m: m.get("created", 0))
    return {**p, "analyses": len(mine), "latest_score": mine[-1].get("score") if mine else None,
            "last_analysis": mine[-1].get("created") if mine else None}


def _require_player(pid: str) -> dict:
    try:
        return players.get(pid)
    except KeyError:
        raise HTTPException(404, "Player not found") from None


@app.get("/api/players")
def list_players() -> list[dict]:
    metas = store.list_meta()
    return [_player_out(p, metas) for p in players.list_players()]


@app.post("/api/players")
def create_player(body: PlayerIn) -> dict:
    try:
        p = players.create(body.model_dump(exclude_unset=True))
    except ValueError as e:
        raise HTTPException(400, str(e)) from None
    return _player_out(p, [])


@app.patch("/api/players/{pid}")
def update_player(pid: str, body: PlayerIn) -> dict:
    _require_player(pid)
    return _player_out(players.update(pid, body.model_dump(exclude_unset=True)), store.list_meta())


@app.delete("/api/players/{pid}")
def delete_player(pid: str) -> dict:
    """Delete a profile; its analyses are kept (unassigned)."""
    _require_player(pid)
    for m in store.list_meta():
        if m.get("player_id") == pid:
            store.write_meta(m["id"], player_id=None)
    players.delete(pid)
    return {"deleted": pid}


@app.get("/api/players/{pid}/progress")
def player_progress(pid: str) -> dict:
    return {"player": _player_out(_require_player(pid), store.list_meta()), **progress.player_progress(pid)}


@app.delete("/api/analyses/{aid}")
def delete_analysis(aid: str) -> dict:
    _require(aid)
    meta = store.read_meta(aid)
    if meta.get("status") == "running":
        raise HTTPException(409, "Can't delete while the analysis is running")
    with _edit_lock(aid):   # not in the middle of an edit
        store.delete(aid)
    return {"deleted": aid}


@app.get("/api/analyses/{aid}/frames/{frame}.jpg")
def frame_jpg(aid: str, frame: int):
    d = _require(aid)
    p = d / "frames" / f"{int(frame):06d}.jpg"
    if not p.exists():
        raise HTTPException(404, "Frame not available")
    return FileResponse(p, media_type="image/jpeg", headers={"Cache-Control": "public, max-age=86400"})


@app.get("/api/analyses/{aid}/mesh/{name}")
def mesh_file(aid: str, name: str):
    d = _require(aid)
    if name not in ("mesh_rest.bin", "pose.bin"):
        raise HTTPException(404)
    p = d / name
    if not p.exists():
        raise HTTPException(404, "Mesh not available")
    return FileResponse(p, media_type="application/octet-stream", headers={"Cache-Control": "no-cache"})


@app.get("/api/analyses/{aid}/video")
def video(aid: str):
    d = _require(aid)
    meta = store.read_meta(aid)
    return FileResponse(d / meta["input"], filename=f"{meta.get('name', 'delivery')}{Path(meta['input']).suffix}")


@app.get("/api/analyses/{aid}/export/obj")
def export_obj(aid: str, frame: int):
    from .body.export import frame_obj

    d = _require_done(aid)
    res = json.loads((d / "analysis.json").read_text())
    idx = int(frame) - res["frames"]["start"]
    txt = frame_obj(d, idx)
    return PlainTextResponse(txt, headers={"Content-Disposition": f'attachment; filename="bowlnet_frame_{frame}.obj"'})


@app.get("/api/analyses/{aid}/export/json")
def export_json(aid: str):
    d = _require_done(aid)
    return FileResponse(d / "analysis.json", media_type="application/json", filename=f"bowlnet_{aid}.json")


@app.get("/api/analyses/{aid}/export/csv")
def export_csv(aid: str):
    d = _require_done(aid)
    res = json.loads((d / "analysis.json").read_text())
    series = res["series"]
    keys = list(series.keys())
    buf = io.StringIO()
    w = csv.writer(buf)
    # where each column comes from: measured on the video (2D) or the 3D reconstruction (an estimate)
    head = [(k[:-3] + "_video" if k.endswith("_2d") else k + "_3d") + ("" if k.endswith("_pct") else "_deg") for k in keys]
    w.writerow(["frame", "time_s"] + head)
    for i, (fr, t) in enumerate(zip(range(res["frames"]["start"], res["frames"]["end"]), res["frames"]["times"])):
        w.writerow([fr, t] + [series[k][i] for k in keys])
    return PlainTextResponse(buf.getvalue(), media_type="text/csv",
                             headers={"Content-Disposition": f'attachment; filename="bowlnet_{aid}_series.csv"'})


# ------------------------------------------------------------------------------------------------------
# production: serve the built React app from the same origin
_dist = Path(__file__).resolve().parents[2] / "frontend" / "dist"
class _ImmutableAssets(StaticFiles):
    """Vite assets have content hashes in their names, so they can be cached forever."""

    async def get_response(self, path, scope):
        resp = await super().get_response(path, scope)
        if resp.status_code == 200:
            resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return resp


# index.html must be revalidated: after an update a cached copy would point at bundles that no longer exist
_NO_CACHE = {"Cache-Control": "no-cache"}

if _dist.exists():
    app.mount("/assets", _ImmutableAssets(directory=_dist / "assets"), name="assets")

    _dist_root = _dist.resolve()

    @app.api_route("/{full_path:path}", methods=["GET", "HEAD"])
    def spa(full_path: str, request: Request):
        if full_path.startswith("api/") or full_path == "api":
            # this catch-all also matches HEAD for the GET-only API routes: answer 405 as they would
            raise HTTPException(405 if request.method == "HEAD" else 404, "Not found")
        if full_path:
            p = (_dist_root / full_path).resolve()
            # never serve anything outside the built frontend (path traversal)
            if p.is_file() and (p == _dist_root or _dist_root in p.parents):
                return FileResponse(p, headers=_NO_CACHE if p.name == "index.html" else None)
        return FileResponse(_dist_root / "index.html", headers=_NO_CACHE)
