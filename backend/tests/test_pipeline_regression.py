"""End-to-end regression on real broadcast clips with hand-labelled ground truth (frame numbers labelled
by eye from per-frame contact sheets). Slow: runs detection, tracking, lifting, events and mesh."""
import subprocess

import cv2
import pytest

from bowlnet.pipeline import Options, analyse

# ground truth: (bowling arm, view, release frame, front-foot contact window)
GT = {
    "bumrah_behind": ("right", "behind", 47, (43, 46)),
    "shami_behind": ("right", "behind", 32, (28, 31)),
}


@pytest.mark.slow
@pytest.mark.parametrize("name", list(GT))
def test_real_clip(name, clip, tmp_path):
    arm, view, br, ffc_win = GT[name]
    res = analyse(str(clip(name)), tmp_path, Options())
    assert res["bowling_arm"]["arm"] == arm
    assert res["view"]["view"] == view
    assert abs(res["events"]["br"]["frame"] - br) <= 1
    f = res["events"]["ffc"]["frame"]
    assert ffc_win[0] - 1 <= f <= ffc_win[1] + 1
    names = {m["key"] for m in res["metrics"]}
    assert {"trunk_lateral_br", "release_height_pct", "arm_slot_br"} <= names
    rel = next(m for m in res["metrics"] if m["key"] == "release_height_pct")
    assert rel["value"] is not None and 90 <= rel["value"] <= 130
    assert (tmp_path / "pose.bin").stat().st_size > 0
    # values read at a contact placed only from timing norms are never rated
    guessed = {k for k in ("bfc", "ffc") if res["events"][k]["method"] == "timing_prior"}
    for m in res["metrics"]:
        if guessed & set((m["event"] or "").split("-")):
            assert m["rating"] == "unrated", m["key"]


@pytest.mark.slow
def test_event_edits_redetect_dependent_events(clip, tmp_path):
    """Moving one marker re-detects the automatic events around it instead of rejecting a correct edit."""
    from bowlnet.pipeline import AnalysisError, stage_b
    res = analyse(str(clip("shami_behind")), tmp_path, Options())
    ev = {k: (v or {}).get("frame") for k, v in res["events"].items()}
    # back-foot contact moved past the automatic front-foot contact: FFC is searched again after it
    r = stage_b(tmp_path, {"events": {"bfc": ev["ffc"] + 1}})
    e = r["events"]
    assert e["bfc"]["method"] == "user" and e["bfc"]["frame"] == ev["ffc"] + 1
    assert e["bfc"]["frame"] < e["ffc"]["frame"] < e["br"]["frame"]
    # release moved earlier: UAH and the contacts follow it
    r = stage_b(tmp_path, {"events": {"br": ev["br"] - 3}})
    e = r["events"]
    assert e["br"]["frame"] == ev["br"] - 3
    assert e["ffc"]["frame"] < e["br"]["frame"] and (e["uah"] is None or e["uah"]["frame"] < e["br"]["frame"])
    # two user markers in the wrong order are still an error
    with pytest.raises(AnalysisError, match="must come before"):
        stage_b(tmp_path, {"events": {"ffc": ev["br"] - 4, "bfc": ev["br"] - 2}})
    # any release frame near the automatic one is accepted (UAH and contacts make room for it)
    for d in range(-4, 5):
        e = stage_b(tmp_path, {"events": {"br": ev["br"] + d}})["events"]
        assert e["br"]["frame"] == ev["br"] + d
        assert all(e[k] is None or e[k]["frame"] < e["br"]["frame"] for k in ("bfc", "ffc", "uah"))
    # markers at the very ends of the window never crash: they either work or explain the order
    first, last = res["frames"]["start"], res["frames"]["end"] - 1
    for k in ("bfc", "ffc", "uah", "br", "ft"):
        for f in (first, last):
            try:
                stage_b(tmp_path, {"events": {k: f}})
            except AnalysisError as err:
                assert "must come before" in str(err)


@pytest.mark.slow
def test_mirrored_clip_is_left_arm(clip, tmp_path):
    src = clip("bumrah_behind")
    cap = cv2.VideoCapture(str(src))
    fps = cap.get(cv2.CAP_PROP_FPS)
    w, h = int(cap.get(3)), int(cap.get(4))
    out_path = tmp_path / "mirrored.mp4"
    out = cv2.VideoWriter(str(out_path), cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h))
    while True:
        ok, fr = cap.read()
        if not ok:
            break
        out.write(cv2.flip(fr, 1))
    out.release()
    res = analyse(str(out_path), tmp_path / "out", Options())
    assert res["bowling_arm"]["arm"] == "left"
    assert abs(res["events"]["br"]["frame"] - 47) <= 1


@pytest.mark.slow
def test_synthetic_side_on_ground_truth(tmp_path):
    """Scripted delivery rendered side-on with the Anny model: every number has an exact ground truth."""
    import json
    import sys
    from pathlib import Path

    vid = tmp_path / "synth_side.mp4"
    r = subprocess.run([sys.executable, "-m", "tools.synth_bowler", str(vid), "--view", "side", "--fps", "60"],
                       cwd=Path(__file__).resolve().parents[1], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    gt = json.loads(vid.with_suffix(".json").read_text())
    res = analyse(str(vid), tmp_path / "out", Options(height_m=1.80))
    assert res["view"]["view"] == "side_on"
    assert res["bowling_arm"]["arm"] == "right"
    for k, tol in (("br", 1), ("ffc", 2), ("uah", 2), ("bfc", 3)):
        assert abs(res["events"][k]["frame"] - gt["events"][k]) <= tol, (k, res["events"][k], gt["events"][k])
    by = {m["key"]: m for m in res["metrics"]}
    assert abs(by["front_knee_ffc"]["value"] - gt["front_knee_ffc"]) <= 8
    assert abs(by["front_knee_br"]["value"] - gt["front_knee_br"]) <= 8
    assert abs(by["trunk_flexion_ffc_br"]["value"] - gt["trunk_flexion_ffc_br"]) <= 8
    assert abs(by["stride_length_pct"]["value"] - gt["stride_length_pct"]) <= 6
    assert abs(by["trunk_forward_br"]["value"] - gt["trunk_forward_br"]) <= 8
    assert by["front_knee_br"]["source"] == "2d" and by["front_knee_br"]["reliability"] == "measured"
    # side views cannot see lateral flexion: it must not be rated
    assert by["trunk_lateral_br"]["rating"] == "unrated"


@pytest.mark.slow
def test_synthetic_behind_ground_truth(tmp_path):
    """The same scripted delivery filmed from behind: rear-view metrics are measured on the video and match the
    rendered body; metrics in the sagittal plane are withheld (not shown as misleading 3D guesses)."""
    import json
    import sys
    from pathlib import Path

    vid = tmp_path / "synth_behind.mp4"
    r = subprocess.run([sys.executable, "-m", "tools.synth_bowler", str(vid), "--view", "behind", "--fps", "60"],
                       cwd=Path(__file__).resolve().parents[1], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    gt = json.loads(vid.with_suffix(".json").read_text())
    # a faceless mannequin is front/back ambiguous, so the arm is given (as a user would on upload)
    res = analyse(str(vid), tmp_path / "out", Options(height_m=1.80, bowling_arm="right"))
    assert res["view"]["view"] == "behind"
    for k, tol in (("br", 1), ("ffc", 2), ("uah", 2), ("bfc", 3)):
        assert abs(res["events"][k]["frame"] - gt["events"][k]) <= tol, (k, res["events"][k], gt["events"][k])
    by = {m["key"]: m for m in res["metrics"]}
    assert by["trunk_lateral_br"]["source"] == "2d" and by["trunk_lateral_br"]["reliability"] == "measured"
    assert abs(by["trunk_lateral_br"]["value"] - gt["trunk_lateral_br"]) <= 5
    for k in ("front_knee_ffc", "front_knee_br", "stride_length_pct"):
        assert by[k]["value"] is None and by[k]["rating"] == "unrated", k
