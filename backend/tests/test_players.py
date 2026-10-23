"""Player profiles, progress over time and plain-language coaching (the features aimed at club/junior bowlers)."""
import json

import pytest
from fastapi.testclient import TestClient

from bowlnet import config, insights, progress, store
from bowlnet.api import app

client = TestClient(app)


@pytest.fixture
def scratch(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    monkeypatch.setattr(config, "ANALYSES_DIR", tmp_path / "analyses")
    return tmp_path


def _metric(key, value, rating="good", unit="deg", reliability="measured", label=None, confidence=0.7):
    return {"key": key, "label": label or key, "unit": unit, "value": value, "rating": rating,
            "reliability": reliability, "note": None, "event": "br", "confidence": confidence}


def _result(metrics, score=80, grade="Strong", priorities=(), view="side_on", strengths=()):
    return {"coaching": {"score": score, "grade": grade, "priorities": list(priorities), "strengths": list(strengths)},
            "metrics": metrics, "view": {"view": view}, "bowling_arm": {"arm": "right"}, "fps_real": 60.0}


def _priority(key="front_knee_br", drill="front_leg"):
    from bowlnet.coaching import DRILLS
    return {"key": key, "headline": "Front knee collapses to 140 deg at release", "drill": DRILLS[drill],
            "drill_key": drill, "rating": "watch", "event": "br"}


def _done(aid, pid, created, result):
    d = store.root() / aid
    d.mkdir(parents=True)
    (d / "analysis.json").write_text(json.dumps(result))
    store.write_meta(aid, id=aid, name=aid, created=created, status="done", player_id=pid,
                     score=result["coaching"]["score"])


def test_player_crud_and_upload_defaults(scratch):
    r = client.post("/api/players", json={"name": "  Aarav  ", "age_group": "u15", "style": "fast", "arm": "left",
                                         "height_cm": 168})
    assert r.status_code == 200
    p = r.json()
    assert p["name"] == "Aarav" and p["age_group"] == "u15" and p["analyses"] == 0
    assert client.post("/api/players", json={"name": ""}).status_code == 400
    assert client.post("/api/players", json={"name": "x", "height_cm": 500}).status_code == 422
    assert client.post("/api/players", json={"name": "x", "age_group": "U13"}).status_code == 422   # not silently adult
    assert client.patch(f"/api/players/{p['id']}", json={"age_group": "nonsense"}).status_code == 422
    r = client.patch(f"/api/players/{p['id']}", json={"style": "medium"})
    assert r.json()["style"] == "medium" and r.json()["age_group"] == "u15"
    assert [q["id"] for q in client.get("/api/players").json()] == [p["id"]]
    # an upload for this player inherits arm and height (the analysis itself is not run here)
    from bowlnet import jobs
    import io
    jobs_submit = jobs.submit
    jobs.submit = lambda aid: None
    try:
        r = client.post("/api/analyses", data={"player_id": p["id"]},
                        files={"file": ("clip.mp4", io.BytesIO(b"\0" * 2000), "video/mp4")})
        aid = r.json()["id"]
        meta = store.read_meta(aid)
        assert meta["player_id"] == p["id"]
        assert meta["options"]["bowling_arm"] == "left" and meta["options"]["height_m"] == 1.68
        # the web app sends its own (profile-prefilled, user-editable) values: an explicit "auto" is kept
        r2 = client.post("/api/analyses", data={"player_id": p["id"], "profile_defaults": "false", "bowling_arm": "auto"},
                         files={"file": ("clip.mp4", io.BytesIO(b"\0" * 2000), "video/mp4")})
        m2 = store.read_meta(r2.json()["id"])
        assert m2["options"]["bowling_arm"] == "auto" and m2["options"]["height_m"] is None
        assert client.post("/api/analyses", data={"player_id": "0" * 12},
                           files={"file": ("c.mp4", io.BytesIO(b"\0" * 10), "video/mp4")}).status_code == 400
        # move it off the player, then back on
        assert client.patch(f"/api/analyses/{aid}", json={"player_id": None}).json()["player_id"] is None
        assert client.patch(f"/api/analyses/{aid}", json={"player_id": p["id"], "name": "Nets 1"}).json()["name"] == "Nets 1"
    finally:
        jobs.submit = jobs_submit
    # deleting the player keeps the analysis, unassigned
    assert client.delete(f"/api/players/{p['id']}").status_code == 200
    assert store.read_meta(aid)["player_id"] is None
    assert client.get(f"/api/players/{p['id']}/progress").status_code == 404


def test_progress_trends_bests_and_since_last(scratch):
    pid = client.post("/api/players", json={"name": "Mia"}).json()["id"]
    _done("a" * 12, pid, 100, _result([_metric("front_knee_br", 145, "watch"), _metric("release_height_pct", 104, "watch", "% height"),
                                       _metric("trunk_lateral_br", 30, reliability="estimate")], score=62, grade="Developing",
                                      priorities=[_priority()]))
    _done("b" * 12, pid, 200, _result([_metric("front_knee_br", 158, "watch"), _metric("release_height_pct", 103, "watch", "% height")],
                                      score=70, priorities=[_priority()]))
    _done("c" * 12, None, 300, _result([_metric("front_knee_br", 120, "watch")]))   # someone else's
    pr = client.get(f"/api/players/{pid}/progress").json()
    assert pr["stats"]["count"] == 2 and pr["stats"]["first_score"] == 62 and pr["stats"]["latest_score"] == 70
    assert [p["value"] for p in pr["trends"]["front_knee_br"]["points"]] == [145, 158]
    assert "trunk_lateral_br" not in pr["trends"]   # estimates are not trended
    assert pr["best"]["front_knee_br"]["value"] == 158
    since = {d["key"]: d for d in pr["since_last"]}
    assert since["front_knee_br"]["improved"] is True            # 13 deg straighter
    assert since["release_height_pct"]["improved"] is None       # 1 point: within measurement resolution
    assert pr["compared_to"]["id"] == "a" * 12
    assert pr["focus"]["title"] == "Brace the front leg" and pr["focus"]["sessions"] == 2
    assert pr["focus"]["first_value"] == 145 and pr["focus"]["latest_value"] == 158
    # summaries were backfilled into meta
    assert store.read_meta("a" * 12)["summary"]["metrics"]["front_knee_br"]["value"] == 145


def test_improvement_direction_rules():
    assert progress.improved("trunk_lateral_br", 48, 40, "deg") is True
    assert progress.improved("ffc_to_br_ms", 160, 120, "ms") is True
    assert progress.improved("stride_length_pct", 60, 75, "% height") is True     # into the 70-87 band
    assert progress.improved("stride_length_pct", 80, 84, "% height") is None     # both inside the band
    assert progress.improved("arm_slot_br", 5, 30, "deg") is None                 # descriptive


def test_insights_respect_age_group_limits_and_style():
    res = _result([_metric("trunk_lateral_br", 52, "risk"), _metric("hip_shoulder_sep_bfc", 12, "good")],
                  priorities=[_priority("trunk_lateral_br", "side_bend")], view="behind")
    junior = insights.insights(res, {"id": "p", "name": "A", "age_group": "u13", "style": "fast"})
    lim = junior["plan"]["limits"]
    assert lim["spell"] == 4 and lim["day"] == 8 and lim["days_week"] == 3
    texts = [it["text"] for w in junior["plan"]["weeks"] for d in w["days"] for it in d["items"]]
    assert not any("17+" in t for t in texts)                       # no med-ball slams for a 12-year-old
    assert any("4 overs" in t for t in texts) and not any("5 overs" in t for t in texts)
    bowling_days = [d["day"] for d in junior["plan"]["weeks"][0]["days"] if d["kind"] == "bowling"]
    assert bowling_days == ["Mon", "Wed", "Fri"]                     # never two bowling days in a row
    assert junior["back_health"]["overall"] == "flag"
    assert any("physiotherapist" in a for a in junior["back_health"]["advice"])
    assert "Stay tall" in junior["summary"]["headline"] or "stay tall" in junior["summary"]["headline"]
    ids = [it["id"] for w in junior["plan"]["weeks"] for d in w["days"] for it in d["items"]]
    assert len(ids) == len(set(ids))                                 # checkbox ids are unique
    spin = insights.insights(res, {"id": "p", "name": "A", "age_group": "adult", "style": "spin"})
    assert spin["back_health"] is None and spin["plan"]["limits"] is None
    young_spin = insights.insights(res, {"id": "p", "name": "A", "age_group": "u11", "style": "spin"})
    assert young_spin["plan"]["limits"]["spell"] == 2                # junior limits apply whatever the style
    # every bowling session, counted in deliveries, stays inside the age group's daily limit
    for prof in ({"age_group": a, "style": st} for a in ("u11", "u13", "u15", "u17", "u19") for st in ("fast", "spin")):
        plan = insights.practice_plan(res, prof)
        for w in plan["weeks"]:
            for d in w["days"]:
                if d.get("load"):
                    assert d["load"]["deliveries"] <= d["load"]["limit"], (prof, d["day"], d["load"])
    # a shaky reading is not flagged in the back-health check
    shaky = _result([_metric("trunk_lateral_br", 55, "risk", confidence=0.2)], view="behind")
    assert insights.back_health(shaky, None)["overall"] == "unknown"
    anon = insights.insights(_result([], score=None, grade=None))
    assert "Not enough" in anon["summary"]["headline"] and anon["plan"]["weeks"]


def test_progress_compares_same_view_and_keeps_focus_across_angles(scratch):
    pid = client.post("/api/players", json={"name": "Sam"}).json()["id"]
    _done("d" * 12, pid, 100, _result([_metric("front_knee_br", 140, "watch"), _metric("ffc_to_br_ms", 133, "watch", "ms")],
                                      priorities=[_priority()]))
    # filmed from behind: the knee can't be measured there, and release height reads differently
    _done("e" * 12, pid, 200, _result([_metric("trunk_lateral_br", 30)], view="behind", priorities=[]))
    _done("f" * 12, pid, 300, _result([_metric("front_knee_br", 146, "watch"), _metric("ffc_to_br_ms", 110, "good", "ms")],
                                      priorities=[_priority()]))
    pr = client.get(f"/api/players/{pid}/progress").json()
    assert pr["compared_to"]["id"] == "d" * 12                       # the previous side-on session
    since = {d["key"]: d for d in pr["since_last"]}
    assert since["front_knee_br"]["improved"] is True                 # +6 deg
    assert since["ffc_to_br_ms"]["improved"] is True                  # 23 ms is more than a frame at 60 fps
    assert "trunk_lateral_br" not in since                            # only in the behind-view clip
    assert pr["focus"]["sessions"] == 2 and pr["focus"]["first_value"] == 140   # the behind clip didn't break it
    assert pr["focus"]["latest_value"] == 146
    assert progress.improved("ffc_to_br_ms", 133, 110, "ms", fps=30) is None    # 23 ms < one frame (33 ms) at 30 fps
    assert progress.improved("release_height_pct", 104, 110, "% height") is None  # within the +/- 8 point precision
