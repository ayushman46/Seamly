import numpy as np

from bowlnet.metrics import NORMS, _metric, _rate


def icc_extension(flex, uah, br):
    """Reference implementation of the ICC/UWA computation."""
    flex = np.maximum(flex, 0)
    win = flex[uah:br + 1]
    i = int(np.argmax(win))
    return float(win[i] - win[i:].min())


def test_icc_elbow_extension_definition():
    # elbow flexes after UAH (25 -> 32) then straightens to 12 at release: extension = 32 - 12 = 20
    flex = np.array([30, 25, 28, 32, 26, 18, 12], float)
    assert icc_extension(flex, 1, 6) == 20
    # hyperextension is floored at zero: 10 -> -8 counts as 10, not 18
    assert icc_extension(np.array([10, 5, -8.0]), 0, 2) == 10


def test_rating_bands():
    assert _rate("elbow_extension", 6) == "good"
    assert _rate("elbow_extension", 12) == "watch"
    assert _rate("elbow_extension", 22) == "risk"
    assert _rate("trunk_lateral_br", 52) == "risk"
    assert _rate("shoulder_alignment_bfc", 230) == "info"   # descriptive only


def test_view_requirement_unrates_metric():
    m = _metric("front_knee_br", "Front knee", 150.0, confidence=0.8, needs=("side_on",), view="behind")
    assert m["rating"] == "unrated" and m["reliability"] == "estimate" and m["confidence"] <= 0.3
    m2 = _metric("front_knee_br", "Front knee", 150.0, confidence=0.8, needs=("side_on",), view="side_on")
    assert m2["rating"] == "watch" and m2["reliability"] == "measured"


def test_implausible_estimates_are_withheld():
    m = _metric("stride_length_pct", "Stride", 4.0, confidence=0.2, needs=("side_on",), view="behind")
    assert m["value"] is None and "Not measurable" in m["note"]


def test_frame_tolerance_on_timings():
    # 133 ms at 30 fps is within one frame (33 ms) of the 125 ms band edge -> not penalised
    m = _metric("ffc_to_br_ms", "FFC->BR", 133.0, confidence=0.8, tolerance=33.3)
    assert m["rating"] == "good"


def test_every_rated_norm_has_reference():
    for k, n in NORMS.items():
        assert n.get("ref"), k


def test_view_from_planted_stride():
    """The planted stride's foreshortening decides the view even when the 3D direction of travel is off (a
    clip without run-up: the hips have already turned at release)."""
    from bowlnet.events import classify_view
    oblique = np.array([np.sin(np.radians(47)), 0.0, np.cos(np.radians(47))])
    assert classify_view(oblique, stride_x=1.05)["view"] == "side_on"
    assert classify_view(np.array([0.95, 0, 0.3]), stride_x=0.1)["view"] == "behind"
    assert classify_view(np.array([0.95, 0, -0.3]), stride_x=0.1)["view"] == "front_on"
    # in between (a ~35-45 deg view): falls back to the 3D direction
    assert classify_view(oblique, stride_x=0.55)["view"] == "behind"


def test_coaching_says_which_way_a_band_was_missed():
    from bowlnet.coaching import coach
    def m(key, v):
        return {"key": key, "label": key, "value": v, "rating": _rate(key, v), "confidence": 0.7}
    short = coach([m("stride_length_pct", 52)], "side_on", 240)["priorities"][0]["headline"]
    long_ = coach([m("stride_length_pct", 98)], "side_on", 240)["priorities"][0]["headline"]
    assert short.startswith("Short delivery stride (52%") and long_.startswith("Long delivery stride (98%")
    # one-sided bands (no lower bound) still work
    assert coach([m("front_knee_flexion", 35), m("trunk_lateral_br", 55)], "side_on", 240)["priorities"]


def test_classify_view_flags_oblique_cameras():
    """The two 2D view cues disagreeing (or both undecided) marks an oblique camera; agreeing cues don't."""
    import numpy as np
    from bowlnet.events import classify_view

    def kp_ratio(r, n=6):
        kp = np.zeros((n, 17, 2))
        kp[:, 11] = [100 - 50 * r, 300]
        kp[:, 12] = [100 + 50 * r, 300]
        kp[:, 5] = kp[:, 6] = [100, 200]     # torso 100 px, so hip width / torso = r
        return kp

    run = np.arange(6)
    fwd_behind = np.array([0.0, 0.0, 1.0])
    side = classify_view(np.array([1.0, 0, 0]), kp_ratio(0.1), None, run, 1.05)
    behind = classify_view(fwd_behind, kp_ratio(0.5), None, run, 0.2)
    assert (side["view"], side.get("oblique")) == ("side_on", None)
    assert (behind["view"], behind.get("oblique")) == ("behind", None)
    clash = classify_view(fwd_behind, kp_ratio(0.05), None, run, 0.01)          # hips side-on, feet along the axis
    assert clash["oblique"] is True
    undecided = classify_view(fwd_behind, kp_ratio(0.33), None, run, 0.5)       # both cues in between
    assert undecided["oblique"] is True
    one_cue = classify_view(fwd_behind, kp_ratio(0.33), None, run, 0.2)         # stride decides, ratio unsure
    assert one_cue.get("oblique") is None
    assert classify_view(fwd_behind).get("oblique") is None                     # no 2D cue at all: unchanged
