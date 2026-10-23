"""Generate extra Python-reference cases for frontend/src/engine/{events,pose2d,bowler}.ts.

    cd backend && ../.venv/bin/python <this file>
Writes frontend/tests/fixtures/pose_events_bowler_cases.json. Inputs are stored explicitly (float64 reprs) unless they
are a fixture's recorded call args, which the tests load themselves ({"fixture", "call", "index"} refs).
"""
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, ".")
from bowlnet import events as E  # noqa: E402
from bowlnet import pose2d as P2  # noqa: E402
from bowlnet import bowler as B  # noqa: E402
from bowlnet.detect import COCO_FLIP, Detection  # noqa: E402
from scipy.interpolate import Akima1DInterpolator  # noqa: E402
from scipy.signal import butter, filtfilt  # noqa: E402

FIX = Path("../frontend/tests/fixtures")
NAMES = ["synth_side", "epping_side", "bumrah_behind", "anderson_edited"]
rng = np.random.default_rng(1234)


def enc(o):
    if isinstance(o, np.ndarray):
        return enc(o.tolist())
    if isinstance(o, (np.floating,)):
        return float(o)
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, np.bool_):
        return bool(o)
    if isinstance(o, E.Events):
        return {"bfc": o.bfc, "ffc": o.ffc, "uah": o.uah, "br": o.br, "ft": o.ft, "confidence": enc(o.confidence),
                "method": o.method}
    if isinstance(o, dict):
        return {str(k): enc(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [enc(v) for v in o]
    if isinstance(o, float) and not np.isfinite(o):
        return None
    return o


def oenc(o):
    """Outputs: floats to 12 significant digits (the tests compare at <= 1e-9 relative)."""
    o = enc(o)
    if isinstance(o, float):
        return float(f"{o:.12g}")
    if isinstance(o, list):
        return [oenc(v) for v in o]
    if isinstance(o, dict):
        return {k: oenc(v) for k, v in o.items()}
    return o


def side_of(d):
    return E.Side.for_arm(d["bowling_arm"])


def A(x):
    return np.asarray(x, dtype=np.float64)


out = {"events": {}, "pose2d": {}, "bowler": {}, "signal": {}}

# ---------------- events: re-run on the recorded (rounded) args + variations ----------------
for n in NAMES:
    fx = json.load(open(FIX / f"{n}.json"))
    c = fx["calls"]
    ev = []
    a = c["stabilise"][0]["args"]
    ev.append({"fn": "stabilise", "ref": {"call": "stabilise", "index": 0}, "args": {},
               "out": oenc(E.stabilise(A(a["kp"]), A(a["motions"]), a["ref"]))})
    a = c["body_height_px"][0]["args"]
    ev.append({"fn": "body_height_px", "ref": {"call": "body_height_px", "index": 0}, "args": {},
               "out": oenc(P2.body_height_px(A(a["kp"]), A(a["kc"])))})
    # detect_events: as recorded, plus user-fixed events, high-fps branch, no sweep peak
    a = c["detect_events"][-1]["args"]
    T = len(a["kp"])
    base = dict(kp=A(a["kp"]), kc=A(a["kc"]), kp_stab=A(a["kp_stab"]), P=A(a["P"]), side=side_of(a["side"]),
                up=A(a["up"]), forward=A(a["forward"]), fps=a["fps"], body_px=A(a["body_px"]),
                sweep_window=tuple(a["sweep_window"]), sweep_peak=a["sweep_peak"])
    rec = E.detect_events(**base, fixed=a["fixed"])
    variants = [
        {"fixed": a["fixed"]},
        {"fixed": {}},
        {"fixed": {"bfc": max(0, rec.bfc - 2)}},
        {"fixed": {"br": min(T - 1, rec.br + 1)}},
        {"fixed": {"uah": max(0, rec.br - 2), "ft": min(T - 1, rec.br + 5)}},
        {"fixed": {"bfc": max(0, rec.bfc - 1), "ffc": rec.ffc + 1, "br": rec.br, "uah": None, "ft": -5}},
        {"fixed": {}, "sweep_peak": None},
        {"fixed": {}, "fps": a["fps"] * 4},
        {"fixed": {"bfc": max(0, rec.bfc - 3)}, "fps": a["fps"] * 4},
        {"fixed": {}, "fps": a["fps"] * 2, "sweep_window": [max(0, a["sweep_window"][0] - 5), a["sweep_window"][1]]},
        {"fixed": {}, "side": "flip"},
        {"fixed": {}, "sweep_window": [0, 2], "sweep_peak": 0},          # no upswing candidate: fastest-arm fallback
        {"fixed": {"br": 2, "ffc": 0}},                                  # events at the clip start
        {"fixed": {}, "trim": rec.br + 4},                               # clip ends just after release
        {"fixed": {"ft": T - 1, "bfc": T - 3}},
        {"fixed": {}, "fps": a["fps"] / 2},
    ]
    for v in variants:
        kw = dict(base)
        for k in ("fps", "sweep_peak"):
            if k in v:
                kw[k] = v[k]
        if "sweep_window" in v:
            kw["sweep_window"] = tuple(v["sweep_window"])
        if v.get("side") == "flip":
            kw["side"] = E.Side.for_arm("left" if base["side"].bowling_arm == "right" else "right")
        fixed = v["fixed"]
        if "trim" in v:
            for k in ("kp", "kc", "kp_stab", "P", "body_px"):
                kw[k] = kw[k][:v["trim"]]
        r = E.detect_events(**kw, fixed=fixed)
        args = {k: v[k] for k in v if k != "side"}
        if v.get("side") == "flip":
            args["bowling_arm"] = kw["side"].bowling_arm
        ev.append({"fn": "detect_events", "ref": {"call": "detect_events", "index": len(c["detect_events"]) - 1},
                   "args": args, "out": oenc(r)})
    # decide_bowling_arm variations
    a = c["decide_bowling_arm"][0]["args"]
    kp, kc, Pp = A(a["kp"]), A(a["kc"]), A(a["P"])
    for hint, win, flip in [(a["sweep_hint"], a["window"], False), (None, a["window"], False),
                            (None, [0, len(kp)], False), (a["sweep_hint"], [len(kp) - 2, len(kp) + 4], False),
                            (None, a["window"], True)]:
        k2 = kp[:, COCO_FLIP] if flip else kp
        r = E.decide_bowling_arm(k2, kc, Pp, a["fps"], hint, tuple(win))
        ev.append({"fn": "decide_bowling_arm", "ref": {"call": "decide_bowling_arm", "index": 0},
                   "args": {"sweep_hint": hint, "window": win, "flip": flip}, "out": oenc(r)})
    # facing / stride / classify variations
    a = c["facing_direction"][0]["args"]
    for frames in (a["frames"], list(range(0, len(a["P"]), 3)), [len(a["P"]) - 1]):
        ev.append({"fn": "facing_direction", "ref": {"call": "facing_direction", "index": 0}, "args": {"frames": frames},
                   "out": oenc(E.facing_direction(A(a["P"]), A(a["up"]), np.asarray(frames)))})
    a = c["stride_across"][0]["args"]
    for ffc, br in ((a["ffc"], a["br"]), (a["ffc"] - 3, a["br"] + 4), (None, a["br"]), (a["br"] + 1, a["br"])):
        ev.append({"fn": "stride_across", "ref": {"call": "stride_across", "index": 0}, "args": {"ffc": ffc, "br": br},
                   "out": oenc(E.stride_across(A(a["kp"]), A(a["k"]), a["leg_m"], side_of(a["side"]), ffc, br))})
    a = c["classify_view"][0]["args"]
    kp = A(a["kp"])
    runup = a["runup"] if a["runup"] is not None else list(range(0, 8))
    for fwd, ru, sx in [(a["forward_cam"], a["runup"], a["stride_x"]), (a["forward_cam"], runup, None),
                        (a["forward_cam"], None, None), (a["forward_cam"], runup, 0.55),
                        ([0.2, 0.1, -0.9], runup, 0.1), ([0.2, 0.1, -0.9], None, None), ([0.9, 0.0, 0.3], None, 0.5),
                        ([0.6, 0.05, -0.6], runup, 0.5), ([0.6, 0.05, 0.6], None, 0.5)]:
        r = E.classify_view(A(fwd), kp, A(a["kc"]), None if ru is None else np.asarray(ru), sx)
        ev.append({"fn": "classify_view", "ref": {"call": "classify_view", "index": 0},
                   "args": {"forward_cam": fwd, "runup": ru, "stride_x": sx}, "out": oenc(r)})
    out["events"][n] = ev

# ---------------- pose2d ----------------
for n in NAMES:
    fx = json.load(open(FIX / f"{n}.json"))
    sa, meta = fx["stage_a"], fx["stage_a_meta"]
    fps = meta["fps"] * meta["options"]["slowmo_factor"]
    kp = A(sa["kp"]); kc = A(sa["kc"])
    T = len(kp)
    cases = []
    # outliers on non-arm joints (and one arm joint, which hampel must ignore)
    kpo = kp.copy()
    for _ in range(12):
        t, j = rng.integers(0, T), rng.choice([0, 5, 6, 11, 12, 13, 14, 15, 16, 9])
        kpo[t, j] += rng.normal(0, 60, 2)
    kcz = kc.copy(); kcz[rng.integers(0, T, 6), rng.integers(0, 17, 6)] = 0.0
    cases.append({"fn": "hampel", "args": {"kp": kpo, "kc": kcz, "fps": fps}, "out": P2.hampel(kpo, kcz, fps)})
    cases.append({"fn": "hampel", "args": {"kp": kpo, "kc": kcz, "fps": fps * 4, "n_sigma": 2.0},
                  "out": P2.hampel(kpo, kcz, fps * 4, 2.0)})
    # left/right swaps on frame ranges
    kps = kp.copy(); kcs = kc.copy()
    for (L, R), (t0, t1) in [(P2.CHAINS["leg"], (T // 3, T // 3 + 4)), (P2.CHAINS["arm"], (T // 2, T // 2 + 2)),
                             (P2.CHAINS["face"], (5, 7))]:
        kps[t0:t1, L + R] = kps[t0:t1, R + L]; kcs[t0:t1, L + R] = kcs[t0:t1, R + L]
    k2, c2, ch = P2.fix_swaps(kps, kcs)
    cases.append({"fn": "fix_swaps", "args": {"kp": kps, "kc": kcs}, "out": [k2, c2, ch]})
    k2, c2, ch = P2.fix_swaps(kps, kcs, 0.05)
    cases.append({"fn": "fix_swaps", "args": {"kp": kps, "kc": kcs, "switch_cost": 0.05}, "out": [k2, c2, ch]})
    # gaps: interior short/long, leading, trailing, joints with 2 / 1 valid samples
    kcg = kc.copy()
    kcg[10:13, 15] = 0; kcg[20:20 + int(0.4 * fps), 16] = 0; kcg[:4, 13] = 0; kcg[T - 5:, 14] = 0
    kcg[:, 1] = 0; kcg[[3, T - 2], 1] = 0.9; kcg[:, 2] = 0; kcg[7, 2] = 0.9
    kcg[rng.integers(0, T, 10), rng.integers(0, 17, 10)] = 0
    k2, c2 = P2.interpolate_gaps(kp, kcg, fps)
    cases.append({"fn": "interpolate_gaps", "args": {"kp": kp, "kc": kcg, "fps": fps}, "out": [k2, c2]})
    k2, c2 = P2.interpolate_gaps(kp, kcg, fps, 0.1)
    cases.append({"fn": "interpolate_gaps", "args": {"kp": kp, "kc": kcg, "fps": fps, "max_gap_s": 0.1}, "out": [k2, c2]})
    # smoothing (normal, high fps, low fps near Nyquist, too short)
    for f in (fps, fps * 8, 12.0):
        cases.append({"fn": "smooth_keypoints", "args": {"kp": kp, "fps": f}, "out": P2.smooth_keypoints(kp, f)})
    cases.append({"fn": "smooth_keypoints", "args": {"kp": kp[:15], "fps": fps}, "out": P2.smooth_keypoints(kp[:15], fps)})
    # body height fallback
    kcb = kc.copy(); kcb[:, 15] = 0; kcb[2, 15] = 0.5
    cases.append({"fn": "body_height_px", "args": {"kp": kp, "kc": kcb}, "out": P2.body_height_px(kp, kcb)})
    # assemble from synthetic float32 refined poses + tracker detections, then the whole stage-A cleanup chain
    f0 = 100
    refined, dets = [], {}
    for t in range(T):
        if rng.random() < 0.85:
            rk = (kp[t] + rng.normal(0, 1.5, (17, 2))).astype(np.float32)
            rc = np.clip(kc[t] - rng.uniform(0, 0.5, 17), 0, 1).astype(np.float32)
            refined.append({"frame": f0 + t, "kps": rk, "kcs": rc})
        if rng.random() < 0.9:
            dk = (kp[t] + rng.normal(0, 3, (17, 2))).astype(np.float32)
            dc = np.clip(kc[t] - rng.uniform(-0.2, 0.4, 17), 0, 1).astype(np.float32)
            dets[f0 + t] = {"frame": f0 + t, "kps": dk, "kcs": dc}
    dets[f0 - 3] = {"frame": f0 - 3, "kps": kp[0].astype(np.float32), "kcs": np.ones(17, np.float32)}

    class R:  # RefinedPose / Detection stand-ins with .kp/.kc
        def __init__(s, d):
            s.kp, s.kc = d["kps"], d["kcs"]
    frames = [r["frame"] for r in refined]
    akp, akc = P2.assemble(frames, [R(r) for r in refined], {k: R(v) for k, v in dets.items()}, f0, f0 + T)
    cases.append({"fn": "assemble", "args": {"refined": refined + [None], "tracked": list(dets.values()), "f0": f0,
                                             "f1": f0 + T}, "out": [akp, akc]})
    # the stage-A chain twice: on float64 copies (TS arithmetic) and on the float32 arrays stage A really uses
    for dtype, (k0, c0) in (("float64", (akp.astype(np.float64), akc.astype(np.float64))), ("float32", (akp, akc))):
        hk = P2.hampel(k0, c0, fps)
        sk, sc, nsw = P2.fix_swaps(k0, hk)
        ik, ic = P2.interpolate_gaps(sk, sc, fps)
        ks = P2.smooth_keypoints(ik, fps)
        cases.append({"fn": "chain", "args": {"fps": fps, "dtype": dtype},
                      "out": {"kc_hampel": hk, "swaps": nsw, "kp": ik, "kc": ic, "kp_s": ks}})
    def mark(v):
        if isinstance(v, np.ndarray) and v.shape == kp.shape and np.array_equal(v, kp):
            return "$kp"
        if isinstance(v, np.ndarray) and v.shape == kc.shape and np.array_equal(v, kc):
            return "$kc"
        if isinstance(v, np.ndarray) and v.shape == kp[:15].shape and np.array_equal(v, kp[:15]):
            return "$kp15"
        return enc(v)
    out["pose2d"][n] = [{"fn": cs["fn"], "args": {k: mark(v) for k, v in cs["args"].items()}, "out": oenc(cs["out"])}
                        for cs in cases]

# ---------------- signal primitives ----------------
sig = []
for N, Wn in [(2, 0.1), (2, 0.4), (2, 0.9), (1, 0.3), (3, 0.25), (4, 0.6)]:
    b, a = butter(N, Wn)
    sig.append({"fn": "butter", "args": {"N": N, "Wn": Wn}, "out": [b, a]})
x = np.cumsum(rng.normal(0, 1, 60)) * 10
b, a = butter(2, 0.3)
sig.append({"fn": "filtfilt", "args": {"b": b, "a": a, "x": x, "padlen": 9}, "out": filtfilt(b, a, x, padtype="odd", padlen=9)})
b, a = butter(3, 0.2)
sig.append({"fn": "filtfilt", "args": {"b": b, "a": a, "x": x, "padlen": 12}, "out": filtfilt(b, a, x, padtype="odd", padlen=12)})
xs = np.sort(rng.choice(np.arange(40), 14, replace=False)).astype(float)
ys = rng.normal(0, 5, 14); ys[5:8] = 2.0
q = np.linspace(-2, 42, 177)
sig.append({"fn": "akima", "args": {"x": xs, "y": ys, "xs": q}, "out": Akima1DInterpolator(xs, ys)(q)})
sig.append({"fn": "akima", "args": {"x": xs[:3], "y": ys[:3], "xs": q}, "out": Akima1DInterpolator(xs[:3], ys[:3])(q)})
sig.append({"fn": "interp", "args": {"x": xs, "y": ys, "xs": q}, "out": np.interp(q, xs, ys)})
from scipy.ndimage import uniform_filter1d  # noqa: E402
for size in (1, 2, 3, 4, 9, 70):
    sig.append({"fn": "uniform_filter1d", "args": {"x": x, "size": size}, "out": uniform_filter1d(x, size, mode="nearest")})
for qq in (90, 50, 10, 100, 0, 33.3):
    sig.append({"fn": "percentile", "args": {"x": x[:17], "q": qq}, "out": np.percentile(x[:17], qq)})
uw = np.cumsum(rng.normal(0, 2.0, 50)); uw = np.arctan2(np.sin(uw), np.cos(uw)); uw[10] = uw[9] + np.pi
sig.append({"fn": "unwrap", "args": {"x": uw}, "out": np.unwrap(uw)})
out["signal"] = enc(sig)


# ---------------- bowler ----------------
def det_list(frames, kps, kcs, boxes, track, dtype):
    return [Detection(int(f), track, np.asarray(b, dtype), 0.9, np.asarray(k, dtype), np.asarray(c, dtype))
            for f, k, c, b in zip(frames, kps, kcs, boxes)]


def dets_json(ds):
    return [{"frame": d.frame, "track": d.track, "box": d.box, "conf": d.conf, "kps": d.kp, "kcs": d.kc} for d in ds]


def ts_json(ts):
    s = ts.sweep
    return {"track": ts.track, "shot": ts.shot, "n": ts.n, "first": ts.first, "last": ts.last,
            "median_height": ts.median_height, "overhead_frames": ts.overhead_frames, "score": ts.score,
            "legs_visibility": ts.legs_visibility, "is_delivery": B.is_delivery(ts), "dict": ts.to_dict(),
            "sweep": None if s is None else {"side": s.side, "sweep_deg": s.sweep_deg, "peak_speed": s.peak_speed,
                                             "start_frame": s.start_frame, "end_frame": s.end_frame,
                                             "peak_frame": s.peak_frame, "direction": s.direction}}


for n in NAMES:
    fx = json.load(open(FIX / f"{n}.json"))
    sa, meta = fx["stage_a"], fx["stage_a_meta"]
    fps = meta["fps"] * meta["options"]["slowmo_factor"]
    f0 = meta["analysis_window"]["start"]
    kp = A(sa["kp"]); kc = A(sa["kc"]); bb = A(sa["bbox"])
    T = len(kp)
    frames = np.arange(f0, f0 + T)
    cases = []
    # one set of people (float64); the float32 run casts exactly these values
    people = {}
    people[7] = (kp, kc, bb)                                                    # the bowler
    um = kp[T // 2] + np.array([300.0, 20.0])                                   # a static umpire, arms down
    people[3] = (np.array([um + rng.normal(0, 1.0, (17, 2)) for _ in frames]), np.full((T, 17), 0.8),
                 np.array([bb[T // 2] + np.array([300.0, 20.0, 300.0, 20.0])] * T))
    wc = kc.copy(); wc[:, 13:] = 0.1                                            # a waist-up arm waver (no legs)
    people[11] = (kp + np.array([-250.0, -40.0]), wc, bb + np.array([-250.0, -40.0, -250.0, -40.0]))
    people[5] = (kp[:4], kc[:4], bb[:4])                                        # a short track (skipped)
    c0 = kp.mean((0, 1))                                                        # a tiny distant person
    people[9] = ((kp - c0) * 0.05 + 50, kc, (bb - np.concatenate([c0, c0])) * 0.05 + 50)
    for dtype in ("float64", "float32"):
        dt = np.float64 if dtype == "float64" else np.float32
        tracks = {k: det_list(frames[:len(p[0])], p[0], p[1], p[2], k, dt) for k, p in people.items()}
        for stride in (1, 2):
            tr = {k: v[::stride] for k, v in tracks.items()}
            scores = B.score_tracks(tr, 0, fps, meta["video"]["height"], stride)
            if dtype == "float64" and stride == 1:
                out["bowler"].setdefault(n, {})["tracks"] = enc({str(k): dets_json(v) for k, v in tr.items()})
            cases.append({"dtype": dtype, "stride": stride, "fps": enc(fps), "frame_h": meta["video"]["height"],
                          "scores": oenc([ts_json(s) for s in scores]),
                          "sweeps": {str(k): [None if s is None else oenc(vars(s)) for s in
                                              (B.best_sweep(v, fps, "left"), B.best_sweep(v, fps, "right"))]
                                     for k, v in tr.items()}})
    out["bowler"][n]["cases"] = cases

p = FIX / "pose_events_bowler_cases.json"
p.write_text(json.dumps(out, separators=(",", ":")))
print(p, f"{p.stat().st_size / 1e6:.2f} MB")
