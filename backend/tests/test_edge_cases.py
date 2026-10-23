"""Bad inputs must fail with a clear, user-facing message - never a crash or a silent wrong answer."""
import os

import cv2
import numpy as np
import pytest

from bowlnet.pipeline import AnalysisError, Options, analyse


def _write(path, frames, fps=30):
    h, w = frames[0].shape[:2]
    vw = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h))
    for f in frames:
        vw.write(f)
    vw.release()


def test_corrupt_file(tmp_path):
    p = tmp_path / "corrupt.mp4"
    p.write_bytes(os.urandom(100_000))
    with pytest.raises(AnalysisError, match="Could not open"):
        analyse(str(p), tmp_path / "out", Options())


def test_too_short(tmp_path):
    p = tmp_path / "short.mp4"
    _write(p, [np.full((240, 320, 3), 90, np.uint8)] * 6)
    with pytest.raises(AnalysisError, match="too short"):
        analyse(str(p), tmp_path / "out", Options())


@pytest.mark.slow
def test_no_bowler(tmp_path):
    rng = np.random.default_rng(0)
    p = tmp_path / "grass.mp4"
    _write(p, [(rng.random((240, 426, 3)) * 50 + [40, 110, 60]).astype(np.uint8) for _ in range(60)])
    with pytest.raises(AnalysisError, match="couldn't find a bowling delivery"):
        analyse(str(p), tmp_path / "out", Options())


def test_options_are_sanitised():
    o = Options.from_dict({"bowling_arm": "both", "height_m": 9.0, "slowmo_factor": 0})
    assert o.bowling_arm == "auto" and o.height_m == 2.3 and o.slowmo_factor == 1.0


def test_user_event_order_is_validated():
    from bowlnet.events import Events
    from bowlnet.pipeline import _check_event_order
    ok = Events(bfc=10, ffc=16, uah=18, br=20, ft=30)
    _check_event_order(ok, ["ffc"], 0)                       # valid order passes
    bad = Events(bfc=10, ffc=25, uah=18, br=20, ft=30)
    with pytest.raises(AnalysisError, match="must come before"):
        _check_event_order(bad, ["ffc"], 100)
    same = Events(bfc=10, ffc=10, uah=None, br=20, ft=None)
    with pytest.raises(AnalysisError):
        _check_event_order(same, ["bfc"], 0)


def test_options_reject_non_finite():
    o = Options.from_dict({"height_m": float("nan"), "slowmo_factor": float("inf"), "candidate": "x"})
    assert o.height_m is None and o.slowmo_factor == 1.0 and o.candidate is None


def _sweep_dets(fps, stride, deg=360.0, dur=0.35):
    """A right arm turning `deg` degrees in `dur` seconds, sampled every `stride` frames."""
    from bowlnet.detect import Detection
    dets = []
    n = int(round(1.2 * fps))
    t0 = int(0.4 * fps)
    for f in range(0, n, stride):
        a = np.radians(deg) * np.clip((f - t0) / (dur * fps), 0, 1)
        kp = np.zeros((17, 2), np.float32)
        kp[6] = (300, 200)
        kp[10] = (300 + 60 * np.sin(a), 200 + 60 * np.cos(a))
        kc = np.ones(17, np.float32)
        dets.append(Detection(f, 1, np.array([250, 100, 350, 400], np.float32), 0.9, kp, kc))
    return dets


@pytest.mark.parametrize("fps,stride", [(30, 1), (60, 1), (60, 5), (120, 4), (240, 7)])
def test_arm_speed_measured_at_any_scan_stride(fps, stride):
    from bowlnet.bowler import best_sweep
    sw = best_sweep(_sweep_dets(fps, stride), fps, "right")
    assert sw is not None and sw.sweep_deg > 300
    # true speed ~1030 deg/s; a strided scan must still see a fast arm (it used to read 0 at stride >= 4)
    assert 600 < sw.peak_speed < 1500, sw.peak_speed


def test_repeated_frames_detected():
    """Frame-repeat slow motion is flagged; broadcast telecine (1 in 6) and static stretches are not."""
    from bowlnet.video import VideoInfo
    new = np.random.default_rng(1).uniform(1, 3, 240)
    dup4 = new.copy(); dup4[np.arange(240) % 4 != 0] = 0.03
    tele = new.copy(); tele[::6] = 0.02
    mk = lambda d: VideoInfo("x", 64, 36, 30.0, 241, 8.0, np.arange(241) / 30.0, frame_diff=d.astype(np.float32))
    assert mk(dup4).repeated_fraction(0, 241) > 0.7
    assert mk(tele).repeated_fraction(0, 241) < 0.2
    assert mk(np.full(240, 0.02)).repeated_fraction(0, 241) == 0.0


def test_detector_never_drops_detections_on_a_slow_batch():
    """ultralytics' NMS returns empty results for the rest of a batch after ~2.4 s; the pipeline lifts that."""
    import torch
    from ultralytics.utils import nms

    from bowlnet.detect import _configure_ultralytics
    _configure_ultralytics()
    _configure_ultralytics()   # idempotent
    assert getattr(nms.non_max_suppression, "_bowlnet", False)
    # a batch of 8 identical predictions must give 8 identical, non-empty outputs
    pred = torch.zeros(8, 4 + 1 + 51, 50)
    pred[:, :4, 0] = torch.tensor([100.0, 100.0, 50.0, 120.0])
    pred[:, 4, 0] = 0.9
    out = nms.non_max_suppression(pred, 0.25, 0.7, nc=1)
    assert len(out) == 8 and all(len(o) == 1 for o in out)
    assert cv2.getNumThreads() > 1


def test_automatic_events_keep_the_delivery_order_after_an_edit():
    from bowlnet.events import Events
    from bowlnet.pipeline import _check_event_order, _reconcile_auto_events
    # user BFC right before release: the automatic FFC (detected on the release frame) has no room left
    ev = Events(bfc=19, ffc=20, uah=18, br=20, ft=30, confidence={}, method={})
    _reconcile_auto_events(ev, ["bfc"], 40)
    _check_event_order(ev, ["bfc"], 0)
    order = [getattr(ev, k) for k in ("bfc", "ffc", "br", "ft")]
    assert ev.ffc is None or ev.bfc < ev.ffc < ev.br, order
    # user release at the window start: automatic contacts squeezed to the edge are dropped, never equal
    ev = Events(bfc=0, ffc=0, uah=0, br=1, ft=10, confidence={}, method={})
    _reconcile_auto_events(ev, ["br"], 40)
    assert ev.bfc is None or ev.ffc is None or ev.bfc < ev.ffc
    assert all(getattr(ev, k) is None or getattr(ev, k) < ev.br for k in ("bfc", "ffc", "uah"))
    # every event that had to move is flagged as an estimate
    assert all(ev.method.get(k) == "constrained" for k in ("bfc", "ffc", "uah") if k in ev.method)
    assert ev.method.get("br") is None   # release (the user's marker) is never moved


def test_restart_during_reanalysis_keeps_previous_result(tmp_path, monkeypatch):
    import json
    from bowlnet import config, store
    monkeypatch.setattr(config, "ANALYSES_DIR", tmp_path)
    for aid, status, stamp_ok in (("a" * 12, "running", True), ("b" * 12, "queued", None), ("c" * 12, "running", False)):
        d = tmp_path / aid
        (d / "frames.new").mkdir(parents=True)
        for f in ("stage_a.npz", "stage_a.json", "analysis.json", "stage_a.tmp.npz"):
            (d / f).write_text("x")
        stamp = store.stage_stamp(d) if stamp_ok else ([1, 2, 3] if stamp_ok is False else None)
        prev = {"options": {"slowmo_factor": 1.0}, "overrides": {"height_m": 1.9}}
        store.write_meta(aid, id=aid, status=status, options={"slowmo_factor": 8.0}, previous=prev, stamp=stamp)
    store.recover_interrupted()
    m = {aid: json.loads((tmp_path / aid / "meta.json").read_text()) for aid in ("a" * 12, "b" * 12, "c" * 12)}
    assert m["a" * 12]["status"] == "done" and m["a" * 12]["options"] == {"slowmo_factor": 1.0}
    assert m["b" * 12]["status"] == "done" and m["b" * 12]["overrides"] == {"height_m": 1.9}
    assert m["c" * 12]["status"] == "failed"   # stage A was replaced: the old result can't be trusted
    for aid in m:
        assert not (tmp_path / aid / "frames.new").exists() and not (tmp_path / aid / "stage_a.tmp.npz").exists()


def test_too_low_frame_rate_is_refused(tmp_path):
    p = tmp_path / "fps10.mp4"
    _write(p, [np.full((240, 320, 3), 90, np.uint8)] * 40, fps=10)
    with pytest.raises(AnalysisError, match="frames per second"):
        analyse(str(p), tmp_path / "out", Options())
