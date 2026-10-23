"""Player profiles: who bowled a delivery, so analyses can be grouped and tracked over time and the coaching
pitched at the right level (age group, bowling style). Stored as one small JSON file next to the analyses."""
from __future__ import annotations

import json
import threading
import time
import uuid

from . import config
from .store import write_atomic

AGE_GROUPS = ("u11", "u13", "u15", "u17", "u19", "adult")
STYLES = ("fast", "medium", "spin")
ARMS = ("auto", "right", "left")
AGE_LABEL = {"u11": "Under 11", "u13": "11-13", "u15": "13-15", "u17": "15-17", "u19": "17-19", "adult": "Adult"}

_lock = threading.RLock()


def _path():
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    return config.DATA_DIR / "players.json"


def _load() -> dict[str, dict]:
    p = _path()
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text()).get("players", {})
    except (OSError, ValueError):
        return {}


def _save(players: dict[str, dict]) -> None:
    write_atomic(_path(), json.dumps({"players": players}, indent=1))


def clean(fields: dict) -> dict:
    """Validated subset of editable fields (unknown keys and bad values are dropped)."""
    out: dict = {}
    if isinstance(fields.get("name"), str) and fields["name"].strip():
        out["name"] = fields["name"].strip()[:60]
    if fields.get("age_group") in AGE_GROUPS:
        out["age_group"] = fields["age_group"]
    if fields.get("style") in STYLES:
        out["style"] = fields["style"]
    if fields.get("arm") in ARMS:
        out["arm"] = fields["arm"]
    if "height_cm" in fields:
        h = fields["height_cm"]
        out["height_cm"] = float(h) if isinstance(h, (int, float)) and 120 <= h <= 230 else None
    return out


def list_players() -> list[dict]:
    with _lock:
        return sorted(_load().values(), key=lambda p: p.get("created", 0))


def get(pid: str) -> dict:
    with _lock:
        p = _load().get(pid)
    if p is None:
        raise KeyError(pid)
    return p


def create(fields: dict) -> dict:
    f = clean(fields)
    if "name" not in f:
        raise ValueError("A player needs a name.")
    p = {"id": uuid.uuid4().hex[:12], "created": time.time(), "age_group": "adult", "style": "fast", "arm": "auto",
         "height_cm": None, **f}
    with _lock:
        players = _load()
        players[p["id"]] = p
        _save(players)
    return p


def update(pid: str, fields: dict) -> dict:
    with _lock:
        players = _load()
        if pid not in players:
            raise KeyError(pid)
        players[pid].update(clean(fields))
        _save(players)
        return players[pid]


def delete(pid: str) -> None:
    with _lock:
        players = _load()
        if players.pop(pid, None) is None:
            raise KeyError(pid)
        _save(players)
