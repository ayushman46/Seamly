"""Many different rendered deliveries with exact joint truth, for training and testing the arm tracer (the small
model that corrects the pose model's arm joints from the whole delivery: frontend/src/engine/armnet.ts).

Each delivery is the scripted bowler of tools/synth_bowler.py with its style drawn at random: how high and how far
out the front arm goes and how it is pulled down and tucked, the bowling arm's line and elbow, the trunk's lean, the
legs, the bowler's build and kit, and the camera (behind, in front, either side, or anywhere between; near or far;
low or high), the light, the ground, blur and compression. Nothing is drawn but the bowler and the ground.

    python -m tools.synth_arms OUTDIR --n 200 --seed 0 [--pose-model m256.onnx]
Writes OUTDIR/NNNNN.npz: truth (T,12,2) picture pixels of the limb joints, hidden (T,12) flags, det (T,17,3) the
pose model's joints and confidences on the rendered frames, fps, view angle, body height in pixels.
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import cv2
import numpy as np
cv2.setNumThreads(1)
from scipy.interpolate import PchipInterpolator

from bowlnet.body.fit import Fitter
from bowlnet.body.model import BodyModel
from tools.synth_bowler import EV, L_TH, R_TH, R_KN, SPEED

LIMBS = ["upperarm01.L", "lowerarm01.L", "wrist.L", "upperarm01.R", "lowerarm01.R", "wrist.R",
         "upperleg01.L", "lowerleg01.L", "foot.L", "upperleg01.R", "lowerleg01.R", "foot.R"]
OWN = [0.20, 0.13, 0.11] * 2 + [0.22, 0.16, 0.13] * 2      # how deep each joint sits under its own limb's skin
DUR = 1.45
KT = [0, .15, .3, .45, .6, .72, .8, .86, .92, 1.05, 1.22, 1.45]


def key(ts, vs):
    f = PchipInterpolator(np.array(ts, float), np.array(vs, float))
    return lambda t: f(np.clip(t, ts[0], ts[-1]))


def style(rng) -> dict:
    """One bowler's way of bowling, as keyframe curves."""
    j = lambda s: rng.normal(0, s)
    u = rng.uniform
    s = {}
    ffc, br = u(5, 40), u(0, 35)
    s["L_KN"] = key(KT, [60, 20, 60, 20, 75 + j(8), 40 + j(8), ffc, (ffc + br) / 2 + 10, br, br + 5, 30 + j(10), 10 + j(5)])
    sb, tf = u(5, 45), u(22, 55)
    s["TRUNK_L"] = key([0, .6, .8, .92, 1.1, 1.45], [j(3), -5 + j(4), 5 + j(5), sb, sb * u(0.3, 0.8), 5 + j(4)])
    s["TRUNK_F"] = key([0, .6, .8, .92, 1.1, 1.45], [8 + j(3), 2 + j(4), 8 + j(5), tf, tf + u(5, 25), 30 + j(8)])
    # bowling arm: the same turn (the events hang on it), a little early or late, with its own elbow and line
    d = j(8)
    s["ARM"] = key([0, .55, .7, .865, .92, 1.0, 1.15, 1.45], [20 + j(10), -10 + j(10), -40 + d, -95 + d * 0.5, -175 + j(4), -245 + j(10), -300 + j(15), -330 + j(15)])
    s["ELB"] = key([0, .6, .8, .9, 1.1, 1.45], [u(30, 100), u(10, 70), u(3, 25), u(2, 15), u(5, 50), u(15, 70)])
    s["ABD"] = key([0, .7, .92, 1.1, 1.45], [u(0, 20), u(0, 25), u(0, 30), u(0, 25), u(0, 20)])        # out from the sagittal plane
    s["EPL"] = key([0, .7, .92, 1.45], [u(-60, 60), u(-40, 40), u(-30, 30), u(-60, 60)])                # the plane the elbow bends in
    # front arm: up and out in front by front-foot landing, then pulled down: straight, or tucked in to the side
    peak, t_pk, t_dn = u(100, 185), u(.66, .8), u(.98, 1.12)
    s["FARM"] = key([0, .45, .56, t_pk, .9, t_dn, 1.25, 1.45], [u(-40, 30), u(-20, 60), peak * u(0.6, 0.95), peak, peak * u(0.2, 0.7), u(-45, 15), u(-70, 10), u(-60, 10)])
    tuck = u(0, 1) ** 1.5 * 125
    s["FELB"] = key([0, .5, t_pk, .9, t_dn, 1.25, 1.45], [u(20, 90), u(5, 60), u(0, 45), max(5, tuck * u(0.5, 1) + j(8)), max(5, tuck * u(0.6, 1.1) + j(10)), u(10, 90), u(10, 70)])
    s["FABD"] = key([0, .55, t_pk, .9, t_dn, 1.45], [u(0, 25), u(-15, 35), u(-20, 40), u(-10, 50), u(0, 45), u(0, 25)])
    s["FEPL"] = key([0, .6, .9, 1.1, 1.45], [u(-90, 90), u(-70, 70), u(-90, 90), u(-90, 90), u(-90, 90)])
    s["H"] = u(1.60, 1.98)
    return s


def skeleton(t: float, s: dict) -> np.ndarray:
    """H36M-17 joints, mannequin axes (x forward, y left, z up), pelvis at the origin."""
    th, sh_, tr = 0.44, 0.43, 0.50
    J = np.zeros((17, 3))
    hipL, hipR = np.array([0, 0.11, -0.02]), np.array([0, -0.11, -0.02])

    def leg(hip, a, k):
        a, k = np.radians(a), np.radians(k)
        knee = hip + th * np.array([np.sin(a), 0, -np.cos(a)])
        return knee, knee + sh_ * np.array([np.sin(a - k), 0, -np.cos(a - k)])
    kL, aL = leg(hipL, L_TH(t), s["L_KN"](t)); kR, aR = leg(hipR, R_TH(t), R_KN(t))
    f, l = np.radians(s["TRUNK_F"](t)), np.radians(s["TRUNK_L"](t))
    up = np.array([np.sin(f) * np.cos(l), np.sin(l), np.cos(f) * np.cos(l)])
    thorax = up * tr
    lat = np.array([0, 1.0, 0]) - up * up[1]; lat /= np.linalg.norm(lat)
    shL, shR = thorax + 0.19 * lat - 0.03 * up, thorax - 0.19 * lat - 0.03 * up

    def rot(v, axis, ang):
        axis = axis / np.linalg.norm(axis); c, si = np.cos(ang), np.sin(ang)
        return v * c + np.cross(axis, v) * si + axis * (axis @ v) * (1 - c)

    def arm(sh, ang, bend, abd, plane, side):
        a, p = np.radians(ang), np.radians(abd)
        ua = np.cos(p) * np.array([np.sin(a), 0, -np.cos(a)]) + np.sin(p) * np.array([0, side, 0])
        el = sh + 0.31 * ua
        n = np.cross(ua, np.array([0, 1.0, 0]))                       # bending about this axis keeps the forearm in the arm's own swing plane
        if np.linalg.norm(n) < 1e-6:
            n = np.array([1.0, 0, 0])
        n = rot(n, ua, np.radians(plane))
        return el, el + 0.26 * rot(ua, n, np.radians(bend))
    eR, wR = arm(shR, s["ARM"](t), s["ELB"](t), s["ABD"](t), s["EPL"](t), -1)
    eL, wL = arm(shL, s["FARM"](t), s["FELB"](t), s["FABD"](t), s["FEPL"](t), 1)
    J[1], J[2], J[3] = hipR, kR, aR; J[4], J[5], J[6] = hipL, kL, aL
    J[7] = thorax / 2; J[8] = thorax; J[9] = thorax + up * 0.13 + np.array([0.09, 0, 0]); J[10] = thorax + up * 0.25
    J[11], J[12], J[13] = shL, eL, wL; J[14], J[15], J[16] = shR, eR, wR
    return J


def look_at(pos, at):
    pos, at = np.array(pos, float), np.array(at, float)
    z = at - pos; z /= np.linalg.norm(z)
    x = np.cross(z, np.array([0, 0, 1.0])); x /= np.linalg.norm(x)     # (mannequin axes: z up)
    y = np.cross(z, x)
    R = np.stack([x, y, z]); return R, -R @ pos


def hidden(T, lo, hi, depth, faces, q, dq, own):
    c = np.where((lo[:, 0] <= q[0]) & (hi[:, 0] >= q[0]) & (lo[:, 1] <= q[1]) & (hi[:, 1] >= q[1]))[0]
    if not len(c):
        return False
    a, b, cc = T[c, 0], T[c, 1], T[c, 2]; v0, v1, v2 = b - a, cc - a, q - a
    den = v0[:, 0] * v1[:, 1] - v1[:, 0] * v0[:, 1]; ok = np.abs(den) > 1e-9; den = np.where(ok, den, 1)
    u = np.where(ok, (v2[:, 0] * v1[:, 1] - v1[:, 0] * v2[:, 1]) / den, -1); v = np.where(ok, (v0[:, 0] * v2[:, 1] - v2[:, 0] * v0[:, 1]) / den, -1)
    ins = (u >= 0) & (v >= 0) & (u + v <= 1)
    if not ins.any():
        return False
    d = depth[faces[c]]; z = d[:, 0] + u * (d[:, 1] - d[:, 0]) + v * (d[:, 2] - d[:, 0])
    return bool(dq - z[ins].min() > own)


def one(rng, sess, out: Path, video: str | None = None):
    from tools.elbow_infer import simcc
    s = style(rng); H = s["H"]
    fps = float(rng.choice([25, 30, 30, 50, 60, 60, 100, 120]))
    t0, t1 = EV["bfc"] - rng.uniform(0.25, 0.5), min(DUR, EV["ft"] + rng.uniform(0.02, 0.2))
    ts = np.arange(t0, t1, 1 / fps)
    J = np.stack([skeleton(t, s) for t in ts])
    m = BodyModel.get(); inst = m.instance(H, gender=float(rng.uniform(0, 1)), weight=float(rng.uniform(0.3, 0.7)))
    fit = Fitter(m, inst); o = fit.fit(J); b = fit.b; heads = o["heads"]
    tall = np.arange(0, DUR, 1 / fps); xall = np.concatenate([[0], np.cumsum(SPEED(tall[:-1]) / fps)])
    xoff = np.interp(ts, tall, xall)
    off = np.stack([xoff, np.zeros_like(xoff), 0.08 - heads[:, [b["foot.L"], b["foot.R"]], 2].min(1)], 1)
    heads = heads + off[:, None]; V = m.skin(inst, o["D"], heads)
    # the camera: anywhere round the bowler (0 = straight behind, 90 = on the bowling-arm side, 180 = in front)
    az = np.radians(rng.choice([rng.normal(0, 12), rng.normal(180, 15), rng.normal(90, 15), rng.normal(-90, 15), rng.uniform(-180, 180)], p=[.35, .15, .2, .1, .2]))
    dist = float(np.exp(rng.uniform(np.log(5), np.log(60)))); hcam = float(np.clip(rng.choice([rng.uniform(1.0, 2.2), rng.uniform(2.2, 6), dist * rng.uniform(0.1, 0.3)]), 0.8, 20))
    ctr = heads[len(ts) // 2, b["spine03"]] if "spine03" in b else heads[len(ts) // 2].mean(0)
    pos = ctr + np.array([-dist * np.cos(az), dist * np.sin(az), 0]); pos[2] = hcam
    W, Hh = 640, 640
    px_tall = float(rng.uniform(140, 420)); f0 = px_tall * dist / H
    follow = rng.uniform() < 0.5                                   # a camera that follows the bowler, or a still one
    kit = [tuple(int(c) for c in rng.integers(20, 245, 3)) for _ in range(2)]
    if rng.uniform() < 0.35:
        kit = [(232, 236, 238), (225, 230, 233)]
    tone = rng.uniform(0.35, 1.0); skin = (int(125 * tone + 10), int(160 * tone + 5), int(215 * tone))
    hair = tuple(int(c) for c in rng.integers(15, 120, 3)); sleeve = rng.choice(["short", "mid", "long", "none"], p=[.3, .4, .15, .15])
    dom = np.array(m.labels)[m.vbi4[:, 0]][m.faces[:, 0]]
    top = V[0][:, 2].max(); hy = V[0][:, 2][m.faces].mean(1)
    cols = np.zeros((len(dom), 3), np.float32)
    for fi, d in enumerate(dom):
        if d.startswith(("wrist", "finger", "metacarpal", "neck", "eye")) or (d.startswith("lowerarm") and sleeve != "long") or (d.startswith("upperarm02") and sleeve in ("short", "none")) or (d.startswith("upperarm01") and sleeve == "none"):
            c = skin
        elif d == "head":
            c = hair if hy[fi] > top - 0.13 * H / 1.8 else skin
        elif d.startswith(("foot", "toe")):
            c = (240, 240, 240)
        elif d.startswith(("upperleg", "lowerleg", "pelvis", "root")):
            c = kit[1]
        else:
            c = kit[0]
        cols[fi] = c
    g1, g2 = rng.integers(40, 170, 3), rng.integers(40, 200, 3)
    bg = np.zeros((Hh, W, 3), np.float32); hz = int(rng.uniform(0.1, 0.6) * Hh)
    bg[:hz] = g2; bg[hz:] = g1
    bg += cv2.resize(rng.normal(0, rng.uniform(2, 9), (40, 40, 3)).astype(np.float32), (W, Hh), interpolation=cv2.INTER_CUBIC)
    for _ in range(int(rng.integers(0, 8))):                         # boards, lines, other clutter
        p1 = (int(rng.integers(0, W)), int(rng.integers(0, Hh))); p2 = (p1[0] + int(rng.integers(-300, 300)), p1[1] + int(rng.integers(-40, 40)))
        cv2.line(bg, p1, p2, tuple(int(c) for c in rng.integers(30, 250, 3)), int(rng.integers(1, 30)))
    light = np.array([rng.normal(0, 0.5), rng.normal(0, 0.5), 1.0]); light /= np.linalg.norm(light)
    amb = rng.uniform(0.3, 0.6); blur = max(0.0, rng.normal(0.4, 0.5)); jpg = int(rng.uniform(25, 95)); noise = rng.uniform(1, 5)
    mblur = rng.uniform(0, 1) < 0.5
    faces = m.faces
    truth = np.zeros((len(ts), 12, 2), np.float32); hid = np.zeros((len(ts), 12), bool); det = np.zeros((len(ts), 17, 3), np.float32); size = np.zeros(len(ts), np.float32)
    vw = cv2.VideoWriter(video, cv2.VideoWriter_fourcc(*"mp4v"), fps, (W, Hh)) if video else None
    prev = None
    for i in range(len(ts)):
        at = heads[i, b["root"]] + np.array([0, 0, 0.15]) if follow else ctr
        R, tv = look_at(pos, at); f = f0 * (np.linalg.norm(at - pos) / dist if follow else 1.0)
        cam = V[i] @ R.T + tv; p2 = np.stack([W / 2 + f * cam[:, 0] / cam[:, 2], Hh / 2 + f * cam[:, 1] / cam[:, 2]], 1); depth = cam[:, 2]
        tri = V[i][faces]; n = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0]); n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)
        P = p2[faces]
        front = ((P[:, 1, 0] - P[:, 0, 0]) * (P[:, 2, 1] - P[:, 0, 1]) - (P[:, 1, 1] - P[:, 0, 1]) * (P[:, 2, 0] - P[:, 0, 0])) != 0
        shade = amb + (1 - amb) * np.clip(np.abs(n @ light), 0, 1)
        img = bg.copy().astype(np.uint8)
        order = np.argsort(-depth[faces].mean(1)); Pi = np.round(P).astype(np.int32); cc = (cols * shade[:, None]).astype(np.int32)
        for k in order:
            if front[k]:
                cv2.fillConvexPoly(img, Pi[k], (int(cc[k, 0]), int(cc[k, 1]), int(cc[k, 2])), lineType=cv2.LINE_AA)
        if mblur and prev is not None and fps <= 60:                 # a slow shutter: the frame smeared with the one before
            a = rng.uniform(0.15, 0.4); img = cv2.addWeighted(img, 1 - a, prev, a, 0)
        raw = img.copy()
        if blur > 0.2:
            img = cv2.GaussianBlur(img, (0, 0), blur)
        img = np.clip(img.astype(np.float32) + rng.normal(0, noise, img.shape), 0, 255).astype(np.uint8)
        img = cv2.imdecode(cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, jpg])[1], cv2.IMREAD_COLOR)
        prev = raw
        hp = heads[i][[b[n_] for n_ in LIMBS]]; hc = hp @ R.T + tv
        truth[i] = np.stack([W / 2 + f * hc[:, 0] / hc[:, 2], Hh / 2 + f * hc[:, 1] / hc[:, 2]], 1)
        lo, hi = P.min(1), P.max(1)
        for q in range(12):
            hid[i, q] = hidden(P, lo, hi, depth, faces, truth[i, q], hc[q, 2], OWN[q])
        x0, y0 = p2.min(0); x1, y1 = p2.max(0); size[i] = y1 - y0
        jit = rng.normal(0, 0.03, 4) * (y1 - y0)                     # the tracker's box is never exact
        k, cf = simcc(sess, img, [x0 + jit[0], y0 + jit[1], x1 + jit[2], y1 + jit[3]])
        det[i, :, :2] = k; det[i, :, 2] = cf
        if vw:
            vw.write(img)
    if vw:
        vw.release()
    np.savez_compressed(out, truth=truth, hidden=hid, det=det, fps=fps, az=float(np.degrees(az)), size=size, height=H, dist=dist, hcam=hcam)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out"); ap.add_argument("--n", type=int, default=10); ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--pose-model", default=str(Path(__file__).resolve().parents[2] / "frontend/_local/loop/models/m256.onnx"))
    ap.add_argument("--video", type=int, default=0, help="also write the first N clips as videos, to look at")
    a = ap.parse_args()
    import onnxruntime as ort
    so = ort.SessionOptions(); so.intra_op_num_threads = 2
    sess = ort.InferenceSession(a.pose_model, so, providers=["CPUExecutionProvider"])
    out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
    for i in range(a.n):
        fp = out / f"{a.seed:03d}_{i:04d}.npz"
        if fp.exists():
            continue
        rng = np.random.default_rng([a.seed, i])
        try:
            one(rng, sess, fp, str(fp.with_suffix(".mp4")) if i < a.video else None)
        except Exception as e:                                         # a pose the body model cannot make: skip it
            print("skip", i, repr(e)[:120], flush=True)
        if i % 10 == 0:
            print(a.seed, i, flush=True)


if __name__ == "__main__":
    main()
