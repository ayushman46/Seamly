"""Progress over time for one player: score and key-metric trends, what changed since the last session,
personal bests and the current focus. Built from a compact per-analysis summary kept in meta.json, so the
history page never has to load full results."""
from __future__ import annotations

import json

from . import store
from .metrics import NORMS

# which way is "better" for each rated metric (None = descriptive, no direction)
BETTER = {
    "front_knee_br": "higher", "front_knee_ffc": "higher", "front_knee_flexion": "lower", "back_knee_bfc": "higher",
    "trunk_forward_br": "higher", "trunk_flexion_ffc_br": "higher", "trunk_lateral_br": "lower",
    "hip_shoulder_sep_bfc": "lower", "shoulder_counter_rotation": "lower", "release_height_pct": "higher",
    "stride_length_pct": ("band", 70.0, 87.0), "ffc_to_br_ms": "lower", "head_offset_br": "lower",
    "elbow_extension": "lower",
}
# smallest change worth calling an improvement: about the measurement resolution of each kind of value
# (timings: at least one frame of the slower clip, see improved(); release height: its stated +/- 8 points)
MIN_CHANGE = {"deg": 3.0, "% height": 2.0, "ms": 20.0, "cm": 5.0}
MIN_CHANGE_KEY = {"release_height_pct": 8.0}
# how fast each value typically moves around the event it is read at (units per second, conservative). A reading
# one frame earlier or later differs by about this / fps, so smaller changes can't be told from timing noise.
EVENT_RATE = {"trunk_forward_br": 450.0, "trunk_flexion_ffc_br": 500.0, "trunk_lateral_br": 200.0,
              "front_knee_br": 150.0, "front_knee_ffc": 150.0, "front_knee_flexion": 150.0, "back_knee_bfc": 250.0,
              "hip_shoulder_sep_bfc": 150.0, "head_offset_br": 200.0, "release_height_pct": 100.0}
# shown on the progress page, in this order (when measured)
KEY_METRICS = ("release_height_pct", "front_knee_br", "trunk_forward_br", "trunk_lateral_br", "trunk_flexion_ffc_br", "head_offset_br",
               "ffc_to_br_ms", "stride_length_pct", "hip_shoulder_sep_bfc", "back_knee_bfc")


def summarise(result: dict) -> dict:
    """Compact record of one analysis for history and progress (stored in meta.json)."""
    c = result["coaching"]
    top = (c.get("priorities") or [None])[0]
    return {
        "score": c.get("score"), "grade": c.get("grade"), "view": result["view"]["view"],
        "arm": result["bowling_arm"]["arm"], "fps_real": round(float(result.get("fps_real") or 0), 1),
        "top": {"key": top["key"], "headline": top["headline"], "title": top["drill"]["title"]} if top else None,
        "metrics": {m["key"]: {"label": m["label"], "unit": m["unit"], "value": m["value"], "rating": m["rating"],
                               "reliability": m["reliability"]}
                    for m in result["metrics"] if m.get("value") is not None},
    }


def _summary_for(meta: dict) -> dict | None:
    if meta.get("summary"):
        return meta["summary"]
    try:   # analyses finished before summaries were stored: build it once and keep it
        result = json.loads((store.path(meta["id"]) / "analysis.json").read_text())
    except (OSError, ValueError, KeyError):
        return None
    s = summarise(result)
    store.write_meta(meta["id"], summary=s)
    return s


def improved(key: str, before: float, after: float, unit: str, fps: float | None = None) -> bool | None:
    """True/False if the change is meaningful and in the better/worse direction; None if too small or no direction.
    fps: real frame rate of the slower of the two clips (a timing can't resolve less than one frame)."""
    rule = BETTER.get(key)
    tol = MIN_CHANGE_KEY.get(key, MIN_CHANGE.get(unit, 0.0))
    if unit == "ms" and fps:
        tol = max(tol, 1000.0 / fps)
    elif fps and key in EVENT_RATE:
        # a value read at an event differs by about its speed / fps when the event lands one frame either side
        tol = max(tol, EVENT_RATE[key] / fps)
    elif fps and fps < 60:
        # other angles and heights: demand a proportionally bigger change at low frame rates
        tol *= 60.0 / fps
    if rule is None or abs(after - before) < tol:
        return None
    if isinstance(rule, tuple):
        _, lo, hi = rule
        dist = lambda v: 0.0 if lo <= v <= hi else min(abs(v - lo), abs(v - hi))
        if abs(dist(after) - dist(before)) < tol:
            return None
        return dist(after) < dist(before)
    return (after > before) if rule == "higher" else (after < before)


def _better_of(key: str, a: float, b: float) -> float:
    rule = BETTER[key]
    if isinstance(rule, tuple):
        _, lo, hi = rule
        mid = (lo + hi) / 2
        return a if abs(a - mid) <= abs(b - mid) else b
    return max(a, b) if rule == "higher" else min(a, b)


def player_progress(pid: str) -> dict:
    metas = [m for m in store.list_meta() if m.get("player_id") == pid and m.get("status") == "done"]
    metas.sort(key=lambda m: m.get("created", 0))
    sessions = []
    for m in metas:
        s = _summary_for(m)
        if s:
            sessions.append({"id": m["id"], "name": m.get("name"), "created": m.get("created"), **s})
    trends: dict[str, list] = {}
    labels: dict[str, dict] = {}
    for s in sessions:
        for k, v in s["metrics"].items():
            if v["reliability"] != "measured":
                continue
            labels[k] = {"label": v["label"], "unit": v["unit"]}
            trends.setdefault(k, []).append({"id": s["id"], "created": s["created"], "value": v["value"], "rating": v["rating"]})
    best = {}
    for k, pts in trends.items():
        if k not in BETTER:
            continue
        b = pts[0]
        for p in pts[1:]:
            if _better_of(k, p["value"], b["value"]) == p["value"] and p["value"] != b["value"]:
                b = p
        best[k] = {**b, **labels[k]}
    # since last time: the latest session against the previous one filmed from the same camera angle (values from
    # different angles are measured differently and don't compare)
    since_last, compared_to = [], None
    if sessions:
        cur = sessions[-1]
        prev = next((s for s in reversed(sessions[:-1]) if s["view"] == cur["view"]), None)
        if prev:
            compared_to = {"id": prev["id"], "created": prev["created"], "view": prev["view"]}
            fps = min(cur.get("fps_real") or 0, prev.get("fps_real") or 0) or None
            for k, v in cur["metrics"].items():
                pv = prev["metrics"].get(k)
                if not pv or v["reliability"] != "measured" or pv["reliability"] != "measured" or k not in BETTER:
                    continue
                # a value not rated against a norm in both sessions (e.g. "info") gets no better/worse verdict
                rated = v.get("rating") in ("good", "watch", "risk") and pv.get("rating") in ("good", "watch", "risk")
                since_last.append({"key": k, "label": v["label"], "unit": v["unit"], "before": pv["value"],
                                   "after": v["value"], "rated": rated,
                                   "improved": improved(k, pv["value"], v["value"], v["unit"], fps) if rated else None})
            since_last.sort(key=lambda d: (d["improved"] is None, not d["improved"]))
    # focus: the most recent top priority. Sessions that couldn't measure it (another camera angle) neither end nor
    # extend the streak; a later session that measured it as good means it has been fixed.
    focus = None
    i_top = next((i for i in range(len(sessions) - 1, -1, -1) if sessions[i]["top"]), None)
    if i_top is not None:
        t = sessions[i_top]["top"]
        fixed = any(s["metrics"].get(t["key"], {}).get("rating") == "good" for s in sessions[i_top + 1:])
        if not fixed:
            streak, first = 0, None
            for s in reversed(sessions[:i_top + 1]):
                if t["key"] not in s["metrics"] and not (s["top"] and s["top"]["key"] == t["key"]):
                    continue   # not measured in that clip
                if s["top"] and s["top"]["key"] == t["key"]:
                    streak, first = streak + 1, s
                else:
                    break
            latest = next((s for s in reversed(sessions) if t["key"] in s["metrics"]), None)
            focus = {**t, "sessions": streak,
                     "first_value": first["metrics"].get(t["key"], {}).get("value") if first else None,
                     "latest_value": latest["metrics"][t["key"]]["value"] if latest else None}
    scores = [s["score"] for s in sessions if s["score"] is not None]
    return {
        "sessions": sessions,
        "trends": {k: {**labels[k], "points": trends[k], "better": _better_label(k), "good": NORMS.get(k, {}).get("good"),
                       "norm": NORMS.get(k, {}).get("norm")}
                   for k in KEY_METRICS if k in trends},
        "best": best,
        "since_last": since_last,
        "compared_to": compared_to,
        "focus": focus,
        "stats": {"count": len(sessions), "best_score": max(scores) if scores else None,
                  "latest_score": scores[-1] if scores else None,
                  "first_score": scores[0] if scores else None,
                  "first": sessions[0]["created"] if sessions else None,
                  "last": sessions[-1]["created"] if sessions else None},
    }


def _better_label(key: str) -> str | None:
    rule = BETTER.get(key)
    if rule is None:
        return None
    if isinstance(rule, tuple):
        return f"{rule[1]:.0f}–{rule[2]:.0f}"
    return rule
