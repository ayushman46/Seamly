"""Render a synthetic, scripted right-arm delivery with the Anny body model (ground truth known exactly).

Used to validate the side-on measurement path end-to-end (detection -> tracking -> 2D -> 3D -> events ->
metrics) where real labelled side-on footage isn't available.

    python -m tools.synth_bowler out.mp4 [--view side|behind] [--fps 60]
Writes out.mp4 and out.json (ground-truth events and metrics).
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import cv2
import numpy as np
from scipy.interpolate import PchipInterpolator

from bowlnet.body.fit import Fitter
from bowlnet.body.model import BodyModel
from bowlnet.kinematics import joint_angle

DUR = 1.45
EV = {"bfc": 0.60, "ffc": 0.80, "uah": 0.865, "br": 0.92, "ft": 1.22}


def key(ts, vs):
    f = PchipInterpolator(np.array(ts, float), np.array(vs, float))
    return lambda t: f(np.clip(t, ts[0], ts[-1]))


# leg keyframes: (thigh angle from vertical, +forward) and knee flexion (0 = straight), degrees
L_TH = key([0, .15, .3, .45, .6, .72, .8, .86, .92, 1.05, 1.22, 1.45], [25, -20, 25, -20, 45, 55, 30, 33, 35, 20, -15, 0])
L_KN = key([0, .15, .3, .45, .6, .72, .8, .86, .92, 1.05, 1.22, 1.45], [60, 20, 60, 20, 75, 40, 15, 30, 10, 15, 30, 10])
R_TH = key([0, .15, .3, .45, .6, .72, .8, .92, 1.05, 1.22, 1.45], [-20, 25, -20, 25, 5, -15, -35, -25, 10, 45, 10])
R_KN = key([0, .15, .3, .45, .6, .72, .8, .92, 1.05, 1.22, 1.45], [20, 60, 20, 60, 30, 25, 20, 60, 90, 40, 15])
# trunk forward flexion and lateral flexion (+ = away from the bowling arm, i.e. to the left)
TRUNK_F = key([0, .6, .8, .92, 1.1, 1.45], [8, 2, 8, 40, 55, 30])
TRUNK_L = key([0, .6, .8, .92, 1.1, 1.45], [0, -5, 5, 28, 15, 5])
# bowling arm angle in the sagittal plane: 0 = pointing down, -90 = backwards, -180 = straight up, -270 = forward-down
ARM = key([0, .55, .7, .865, .92, 1.0, 1.15, 1.45], [20, -10, -40, -95, -175, -245, -300, -330])
ELB = key([0, .8, .9, 1.45], [70, 10, 6, 30])
# front arm: raised high up/forward at FFC then pulled down
FARM = key([0, .55, .75, .9, 1.05, 1.45], [-20, 140, 160, 70, -10, -25])
SPEED = key([0, .6, .8, .92, 1.2, 1.45], [5.5, 5.0, 3.5, 2.5, 1.5, 1.2])


def skeleton(t: float) -> np.ndarray:
    """H36M-17 joints in world axes (x forward, y left, z up), pelvis at origin."""
    th, sh_, tr = 0.44, 0.43, 0.50
    J = np.zeros((17, 3))
    hipL, hipR = np.array([0, 0.11, -0.02]), np.array([0, -0.11, -0.02])

    def leg(hip, a, k):
        a, k = np.radians(a), np.radians(k)
        knee = hip + th * np.array([np.sin(a), 0, -np.cos(a)])
        ank = knee + sh_ * np.array([np.sin(a - k), 0, -np.cos(a - k)])
        return knee, ank
    kL, aL = leg(hipL, L_TH(t), L_KN(t))
    kR, aR = leg(hipR, R_TH(t), R_KN(t))
    f, l = np.radians(TRUNK_F(t)), np.radians(TRUNK_L(t))
    up = np.array([np.sin(f) * np.cos(l), np.sin(l), np.cos(f) * np.cos(l)])
    thorax = up * tr
    lat = np.array([0, 1.0, 0]) - up * up[1]
    lat /= np.linalg.norm(lat)
    shL, shR = thorax + 0.19 * lat - 0.03 * up, thorax - 0.19 * lat - 0.03 * up
    head = thorax + up * 0.25
    nose = thorax + up * 0.13 + np.array([0.09, 0, 0])

    def arm(sh, ang, bend, side):
        a = np.radians(ang)
        ua = np.array([np.sin(a), 0, -np.cos(a)])         # sagittal plane: 0 down, -90 back, -180 up, -270 forward
        el = sh + 0.31 * ua
        b = np.radians(bend)
        fa = np.array([np.sin(a + side * b), 0, -np.cos(a + side * b)])
        return el, el + 0.26 * fa
    eR, wR = arm(shR, ARM(t), ELB(t), -1)
    eL, wL = arm(shL, FARM(t), 25, -1)
    J[0] = 0; J[1], J[2], J[3] = hipR, kR, aR; J[4], J[5], J[6] = hipL, kL, aL
    J[7] = thorax / 2; J[8] = thorax; J[9] = nose; J[10] = head
    J[11], J[12], J[13] = shL, eL, wL; J[14], J[15], J[16] = shR, eR, wR
    return J


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--view", default="side", choices=["side", "behind"])
    ap.add_argument("--fps", type=float, default=60.0)
    ap.add_argument("--height", type=float, default=1.80)
    a = ap.parse_args()
    fps, H = a.fps, a.height
    ts = np.arange(0, DUR, 1 / fps)
    J = np.stack([skeleton(t) for t in ts])
    m = BodyModel.get()
    inst = m.instance(H)
    fit = Fitter(m, inst)
    out = fit.fit(J)
    heads = out["heads"]
    b = fit.b
    # ground contact: lowest foot at ankle height; integrate forward speed
    feet = [b["foot.L"], b["foot.R"]]
    lowest = heads[:, feet, 2].min(1)
    zoff = 0.08 - lowest
    xoff = np.concatenate([[0], np.cumsum(SPEED(ts[:-1]) / fps)])
    off = np.stack([xoff, np.zeros_like(xoff), zoff], 1)
    heads = heads + off[:, None]
    V = m.skin(inst, out["D"], heads)

    W, Hh = 1280, 720
    if a.view == "side":      # camera on the bowler's right, looking along +y (world)
        def proj(P):
            s = 210.0
            cx = 640 - s * (xoff.mean())
            return np.stack([cx + s * P[..., 0], 640 - s * P[..., 2]], -1), P[..., 1]
    else:                     # behind the bowler, slightly elevated, looking along +x
        def proj(P):
            depth = 9.0 + P[..., 0]
            f = 1900.0
            return np.stack([640 - f * P[..., 1] / depth, 400 - f * (P[..., 2] - 1.6) / depth + f * 0.06], -1), -P[..., 0]
    faces = m.faces
    vw = cv2.VideoWriter(str(a.out), cv2.VideoWriter_fourcc(*"mp4v"), fps, (W, Hh))
    rng = np.random.default_rng(0)
    bg = np.zeros((Hh, W, 3), np.uint8)
    bg[:] = (60, 120, 70)
    bg[440:, :] = (55, 140, 80)
    cv2.rectangle(bg, (0, 560), (W, 680), (120, 160, 190), -1)                 # pitch
    for x in range(0, W, 40):
        cv2.line(bg, (x, 440), (x + 25, 720), (50, 128, 72), 2)                # mown stripes (texture)
    noise = rng.integers(0, 12, bg.shape, dtype=np.uint8)
    bg = cv2.add(bg, noise)
    light = np.array([0.4, -0.5, 0.75]); light /= np.linalg.norm(light)
    for t in range(len(ts)):
        img = bg.copy()
        p2, depth = proj(V[t])
        tri = V[t][faces]
        n = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
        n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)
        shade = np.clip(np.abs(n @ light), 0.2, 1.0)
        order = np.argsort(-depth[faces].mean(1))
        P = p2[faces].astype(np.int32)
        zc = V[t][:, 2][faces].mean(1)
        for i in order:
            base = (235, 235, 240) if zc[i] < 1.0 * H / 1.8 * 0.55 else (200, 205, 215)   # whites
            if zc[i] > 0.84 * H:
                base = (150, 170, 205)                                                    # skin/head
            col = tuple(int(c * (0.35 + 0.65 * shade[i])) for c in base)
            cv2.fillConvexPoly(img, P[i], col, lineType=cv2.LINE_AA)
        vw.write(img)
    vw.release()

    # ground truth from the *rendered* model (bone heads), same definitions as BowlNet
    Hd = heads
    def ang(a_, b_, c_):
        return float(joint_angle(Hd[:, b[a_]], Hd[:, b[b_]], Hd[:, b[c_]])[0]) if False else None
    def frame(tsec):
        return int(round(tsec * fps))
    knee = joint_angle(Hd[:, b["upperleg01.L"]], Hd[:, b["lowerleg01.L"]], Hd[:, b["foot.L"]])
    bknee = joint_angle(Hd[:, b["upperleg01.R"]], Hd[:, b["lowerleg01.R"]], Hd[:, b["foot.R"]])
    ev = {k: frame(v) for k, v in EV.items()}
    stride = abs(Hd[ev["ffc"], b["foot.L"], 0] - Hd[ev["ffc"], b["foot.R"], 0])
    rel = (Hd[ev["br"], b["wrist.R"], 2] + 0.07) / H * 100

    def trunk(fr):
        """Trunk (mid hip joints -> mid shoulder joints) of the *rendered* body: forward lean in the sagittal
        plane and side lean in the frontal plane. The IK-posed body model does not reproduce the scripted
        angles exactly (e.g. 28 deg scripted side-bend renders as ~21 deg), so ground truth is measured on it."""
        t = (Hd[fr, b["upperarm01.L"]] + Hd[fr, b["upperarm01.R"]] - Hd[fr, b["upperleg01.L"]] - Hd[fr, b["upperleg01.R"]]) / 2
        return float(np.degrees(np.arctan2(t[0], t[2]))), float(np.degrees(np.arctan2(abs(t[1]), t[2])))
    tf_br, tl_br = trunk(ev["br"])
    tf_ffc, _ = trunk(ev["ffc"])
    gt = {"fps": fps, "events": ev, "front_knee_ffc": float(knee[ev["ffc"]]), "front_knee_br": float(knee[ev["br"]]),
          "back_knee_bfc": float(bknee[ev["bfc"]]), "trunk_flexion_ffc_br": tf_br - tf_ffc,
          "trunk_forward_br": tf_br, "trunk_lateral_br": tl_br,
          "stride_length_pct": float(100 * stride / H), "release_height_pct": float(rel), "view": a.view}
    Path(a.out).with_suffix(".json").write_text(json.dumps(gt, indent=1))
    print(json.dumps(gt, indent=1))


if __name__ == "__main__":
    main()
