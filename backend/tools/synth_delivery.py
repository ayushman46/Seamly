"""A rendered delivery with a known ball: a test film for ball tracking.

The mannequin from tools/synth_bowler.py bowls on a full pitch (creases painted to the Laws' measurements, stumps
at both ends), seen by a real pinhole camera behind the bowler's arm: a phone on a high tripod, or a broadcast
camera with a long lens that zooms and tilts through the delivery. The ball leaves the hand and flies by the same
physics as frontend/src/lib/flight.ts (gravity, drag, swing, one bounce); the sun casts the ball's, the bowler's and
the stumps' shadows on the ground. Everything the tracker is meant to find is written next to the video as truth:
the camera, where each crease corner is in the picture, the release, the speed, where it pitched, how far it swung
and where it passed the stumps.

  python -m tools.synth_delivery out.mp4 [--view phone|broadcast] [--kmh 128] [--length 6.5] [--line 0.05]
                                         [--swing 0.1] [--fps 60] [--ball red|white] [--no-sun] [--raw frames.rgba]
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import cv2
import numpy as np

from bowlnet.body.fit import Fitter
from bowlnet.body.model import BodyModel
from tools.synth_bowler import EV, SPEED, skeleton

G, RHO, BALL_R, BALL_M, CD = 9.81, 1.2, 0.036, 0.156, 0.45
AREA = np.pi * BALL_R ** 2
PITCH, POP, RET, STUMP_H, STUMP_X, LINE = 20.12, 1.22, 1.32, 0.711, 0.1143, 0.04


def fly(p0, speed, elev, azim, swing, bounce=(0.55, 0.87), dt=0.0005, t_end=1.6):
    """The ball's path: times and positions (scene axes: x across, y up, z along the pitch, batter at -20.12).
    Returns (t, p, info): info has the bounce and the crossing of the batter's stumps."""
    kd, ks = 0.5 * RHO * CD * AREA / BALL_M, 0.5 * RHO * swing * AREA / BALL_M
    ce = np.cos(elev)
    p = np.array(p0, float)
    v = speed * np.array([np.sin(azim) * ce, np.sin(elev), -np.cos(azim) * ce])
    v_straight, x_straight = v.copy(), p[0]

    def acc(v, s):
        sp, h = np.linalg.norm(v), np.hypot(v[0], v[2]) or 1.0
        return np.array([-kd * sp * v[0] + s * sp * sp * (-v[2] / h), -G - kd * sp * v[1], -kd * sp * v[2] + s * sp * sp * (v[0] / h)])
    ts, ps, info, bounced, t = [0.0], [p.copy()], {"bounce": None, "stumps": None, "swung": 0.0}, False, 0.0
    while t < t_end:
        s = 0.0 if bounced else ks
        m = v + acc(v, s) * dt / 2
        a2 = acc(m, s)
        prev = p.copy()
        p = p + m * dt
        v = v + a2 * dt
        if not bounced:
            m0 = v_straight + acc(v_straight, 0) * dt / 2
            x_straight += m0[0] * dt
            v_straight = v_straight + acc(m0, 0) * dt
            info["swung"] = float(p[0] - x_straight)
        t += dt
        if prev[2] > -PITCH >= p[2] and info["stumps"] is None:
            u = (prev[2] + PITCH) / (prev[2] - p[2])
            info["stumps"] = {"t": float(t - dt + u * dt), "x": float(prev[0] + (p[0] - prev[0]) * u), "y": float(prev[1] + (p[1] - prev[1]) * u)}
        if p[1] <= BALL_R and v[1] < 0:
            u = max(0.0, min(1.0, (prev[1] - BALL_R) / (prev[1] - p[1])))
            p = prev + (p - prev) * u
            t += (u - 1) * dt
            vin = v.copy()
            p[1] = BALL_R
            v = np.array([v[0] * bounce[1], -v[1] * bounce[0], v[2] * bounce[1]])
            if not bounced:
                info["bounce"] = {"t": float(t), "x": float(p[0]), "z": float(p[2]), "kmh_in": float(np.linalg.norm(vin) * 3.6),
                                  "kmh_out": float(np.linalg.norm(v) * 3.6)}
            bounced = True
        ts.append(t); ps.append(p.copy())
        if p[2] < -PITCH - 3:
            break
    return np.array(ts), np.array(ps), info


def aim(p0, speed, length, line, swing, bounce):
    """Elevation and azimuth that pitch the ball `length` metres from the batter's stumps and pass them at x = line."""
    azim = 0.0
    for _ in range(6):
        lo, hi = np.radians(-25), np.radians(8)
        for _ in range(40):
            mid = (lo + hi) / 2
            _, _, info = fly(p0, speed, mid, azim, swing, bounce, dt=0.001)
            z = info["bounce"]["z"] if info["bounce"] else -99
            if z + PITCH < length:      # pitched too far up: aim lower... (further from the bowler = smaller z)
                lo, hi = lo, mid
            else:
                lo, hi = mid, hi
        elev = (lo + hi) / 2
        _, _, info = fly(p0, speed, elev, azim, swing, bounce, dt=0.001)
        if info["stumps"] is None:
            break
        azim += np.arctan2(line - info["stumps"]["x"], PITCH)
    return elev, azim


def look_at(pos, at, roll=0.0):
    z = np.array(at, float) - np.array(pos, float); z /= np.linalg.norm(z)
    x = np.array([-z[2], 0, z[0]]); x /= np.linalg.norm(x)
    y = np.cross(z, x)
    c, s = np.cos(roll), np.sin(roll)
    x, y = c * x + s * y, -s * x + c * y
    R = np.stack([x, y, z])
    return R, -R @ np.array(pos, float)


def ground_texture(rng, res=0.025):
    x0, x1, z0, z1 = -14.0, 14.0, -60.0, 16.0
    w, h = int((x1 - x0) / res), int((z1 - z0) / res)
    tex = np.zeros((h, w, 3), np.float32)
    tex[:] = (62, 128, 72)
    zz = z0 + (np.arange(h) + 0.5) * res
    xx = x0 + (np.arange(w) + 0.5) * res
    stripe = ((np.floor(xx / 2.5) % 2) * 9 - 4).astype(np.float32)          # mown stripes down the ground
    tex += stripe[None, :, None]
    coarse = cv2.resize(rng.normal(0, 1, (h // 12 + 1, w // 12 + 1)).astype(np.float32), (w, h), interpolation=cv2.INTER_CUBIC)
    fine = rng.normal(0, 1, (h, w)).astype(np.float32)
    tex += (7 * coarse + 5 * fine)[..., None]
    X, Z = np.meshgrid(xx, zz)
    pitch = (np.abs(X) < 1.525) & (Z < POP) & (Z > -PITCH - POP)
    tan = np.array((150, 190, 205), np.float32)
    tex[pitch] = tan + (9 * coarse[pitch] + 6 * fine[pitch])[:, None]
    for _ in range(40):                                                     # footmarks and scuffs: texture to match on
        cx, cz, r = rng.uniform(-1.3, 1.3), rng.uniform(-PITCH - 1, 1), rng.uniform(0.05, 0.22)
        m = ((X - cx) ** 2 + ((Z - cz) / 1.6) ** 2 < r * r) & pitch
        tex[m] *= rng.uniform(0.82, 0.93)
    white = np.array((235, 240, 240), np.float32)

    def paint(xa, xb, za, zb):
        tex[(X >= min(xa, xb)) & (X <= max(xa, xb)) & (Z >= min(za, zb)) & (Z <= max(za, zb))] = white
    for z_st, to in ((0.0, -1.0), (-PITCH, 1.0)):                           # each end: `to` points towards the middle
        paint(-RET - LINE, RET + LINE, z_st, z_st + to * LINE)              # bowling crease (back edge through the stumps)
        paint(-1.83, 1.83, z_st + to * POP, z_st + to * (POP + LINE))       # popping crease (back edge 1.22 m in front)
        for sx in (-1, 1):
            paint(sx * RET, sx * (RET + LINE), z_st + to * (POP + LINE), z_st - to * POP)   # return crease, 2.44 m long
    return np.clip(tex, 0, 255).astype(np.uint8), (x0, z0, res)


def capsule(img, a, b, r, colour, strength=1.0, ss=4):
    """An anti-aliased thick segment (a blurred ball, or its shadow): blend `colour` into img."""
    x0, y0 = int(np.floor(min(a[0], b[0]) - r - 2)), int(np.floor(min(a[1], b[1]) - r - 2))
    x1, y1 = int(np.ceil(max(a[0], b[0]) + r + 2)), int(np.ceil(max(a[1], b[1]) + r + 2))
    H, W = img.shape[:2]
    x0, y0, x1, y1 = max(0, x0), max(0, y0), min(W, x1), min(H, y1)
    if x1 <= x0 or y1 <= y0:
        return
    m = np.zeros(((y1 - y0) * ss, (x1 - x0) * ss), np.uint8)
    pa = (int(round((a[0] - x0) * ss)), int(round((a[1] - y0) * ss)))
    pb = (int(round((b[0] - x0) * ss)), int(round((b[1] - y0) * ss)))
    rr = max(1, int(round(r * ss)))
    cv2.line(m, pa, pb, 255, 2 * rr)
    cv2.circle(m, pa, rr, 255, -1); cv2.circle(m, pb, rr, 255, -1)
    al = cv2.resize(m, (x1 - x0, y1 - y0), interpolation=cv2.INTER_AREA).astype(np.float32)[..., None] / 255 * strength
    roi = img[y0:y1, x0:x1].astype(np.float32)
    img[y0:y1, x0:x1] = np.clip(roi * (1 - al) + np.array(colour, np.float32) * al, 0, 255).astype(np.uint8)


def body_truth(Vs, Hs, b, H, fps):
    """Where the bowler really is, frame by frame, in scene metres: for measuring on the pitch (lib/onpitch.ts)."""
    out = {"stature": H, "events": {k: int(round(v * fps)) for k, v in EV.items()}, "frames": []}
    for i in range(len(Vs)):
        fr = {"head_top": float(Vs[i][:, 1].max())}
        for sd in ("L", "R"):
            a = Hs[i, b["foot." + sd]]
            near = (np.linalg.norm(Vs[i] - a, axis=1) < 0.30) & (Vs[i][:, 1] < a[1] + 0.02)
            v = Vs[i][near]
            low = v[v[:, 1] < v[:, 1].min() + 0.04]          # the sole
            fr["ankle_" + sd] = a.tolist()
            fr["heel_" + sd] = low[np.argmax(low[:, 2])].tolist()   # the bowler runs towards -z: the heel is the sole's largest z
            fr["toe_" + sd] = low[np.argmin(low[:, 2])].tolist()
            fr["sole_y_" + sd] = float(v[:, 1].min())
            fr["wrist_" + sd] = Hs[i, b["wrist." + sd]].tolist()
        out["frames"].append(fr)
    return out


def plant_feet(J, ts, xoff, fps):
    """Feet that stay where they land. The scripted legs swing about a pelvis that moves at a scripted speed, so a
    foot on the ground slides (the front foot by half a metre between landing and release). Here each foot of the
    delivery stride is held where it lands: the thigh is turned, with the knee's scripted bend kept, so the ankle
    stays put under the moving pelvis, for as long as the leg can reach; then it eases back to the script.
    J is changed in place (H36M joints, mannequin axes). Returns {side: (first frame, last frame planted)}."""
    from tools.synth_bowler import L_KN, R_KN
    th, sh = 0.44, 0.43
    out = {}
    for sd, hip, knee, ank, KN, t_on, t_off in (("R", 1, 2, 3, R_KN, EV["bfc"], EV["ffc"] + 0.03), ("L", 4, 5, 6, L_KN, EV["ffc"], 1.04)):
        i0 = int(round(t_on * fps)); x_lock = xoff[i0] + J[i0, ank, 0]
        if sd == "L":
            # Where the front foot lands. Real bowlers filmed side-on have the hip 0.17 to 0.23 of their height
            # behind the front ankle at release, and the bowling shoulder about over the ankle; the script alone
            # lands the foot so close that the body ends half a metre past it. So the foot is put down where the
            # hip will be 0.25 m behind it at release, the leg reaching out to that spot over the tenth of a second
            # before it lands.
            i_br = int(round(EV["br"] * fps))
            x_lock = xoff[i_br] + J[i_br, hip, 0] + 0.25
            n_in = max(2, int(round(0.12 * fps)))
            for i in range(i0 - n_in, i0):
                u = (i - (i0 - n_in)) / n_in; u = u * u * (3 - 2 * u)
                k = np.radians(KN(ts[i]))
                need = (1 - u) * J[i, ank, 0] - (1 - u) * J[i, hip, 0] + u * (x_lock - xoff[i] - J[i, hip, 0])
                A, B = th + sh * np.cos(k), -sh * np.sin(k); R = np.hypot(A, B)
                a = float(np.arcsin(np.clip(need / R, -0.985, 0.985)) - np.arctan2(B, A))
                kn = J[i, hip] + th * np.array([np.sin(a), 0, -np.cos(a)])
                J[i, knee], J[i, ank] = kn, kn + sh * np.array([np.sin(a - k), 0, -np.cos(a - k)])

        def leg(i, a):
            k = np.radians(KN(ts[i]))
            kn = J[i, hip] + th * np.array([np.sin(a), 0, -np.cos(a)])
            return kn, kn + sh * np.array([np.sin(a - k), 0, -np.cos(a - k)])

        def scripted(i):
            d = J[i, knee] - J[i, hip]
            return float(np.arctan2(d[0], -d[2]))
        last, a_last = i0, scripted(i0)
        for i in range(i0, len(ts)):
            if ts[i] > t_off:
                break
            k = np.radians(KN(ts[i]))
            need = x_lock - xoff[i] - J[i, hip, 0]
            A, B = th + sh * np.cos(k), -sh * np.sin(k)
            R = np.hypot(A, B)
            if abs(need) > 0.985 * R or need < -0.40:
                break                                 # the leg is trailing well behind the hip: the heel lifts and the foot comes off the ground
            a = float(np.arcsin(need / R) - np.arctan2(B, A))
            J[i, knee], J[i, ank] = leg(i, a)
            last, a_last = i, a
        out[sd] = (i0, last)
        n = max(1, int(round(0.10 * fps)))
        d0 = a_last - scripted(last + 1) if last + 1 < len(ts) else 0.0
        for q in range(1, n):
            i = last + q
            if i >= len(ts):
                break
            J[i, knee], J[i, ank] = leg(i, scripted(i) + d0 * (1 - q / n))
    return out


VIEWS = {
    # a phone on a tall tripod behind the bowler's arm: still, wide
    "phone": dict(size=(1280, 720), pos=(0.9, 3.4, 10.5), at=(0.0, 0.6, -10.0), f=1180.0, zoom=1.0, tilt=0.0),
    # the same in full HD, a little closer and lower: a phone on a tripod just behind the umpire
    "phone_hd": dict(size=(1920, 1080), pos=(0.7, 2.6, 7.5), at=(0.0, 0.7, -10.0), f=1750.0, zoom=1.0, tilt=0.0),
    # a broadcast camera high behind the arm: long lens, zooming in and following the ball
    # a phone on an ordinary tripod at chest height a few metres behind the stumps: a net session
    "tripod_low": dict(size=(1920, 1080), pos=(-0.5, 1.45, 6.0), at=(0.0, 0.9, -10.0), f=1500.0, zoom=1.0, tilt=0.0),
    "broadcast": dict(size=(1920, 1080), pos=(1.5, 16.0, 84.0), at=(0.0, 0.0, -7.5), f=11500.0, zoom=1.75, tilt=4.0),
}


def render(out, view="phone", fps=60.0, kmh=128.0, length=6.5, line=0.05, swing=0.1, ball="red", sun=True, H=1.80,
           bounce=(0.55, 0.87), seed=0, dur=1.72, shutter=1 / 500, raw=None, fall=(0.55, -0.12), wide=0.0, foot=0.0, lock=True, kit=None):
    rng = np.random.default_rng(seed)
    cfg = VIEWS[view]
    W, Hh = cfg["size"]
    ts = np.arange(0, dur, 1 / fps)
    # the mannequin (axes: x forward, y left, z up), moved along its run and stood on the ground
    J = np.stack([skeleton(t) for t in ts])
    xoff = np.concatenate([[0], np.cumsum(SPEED(ts[:-1]) / fps)])
    plants = plant_feet(J, ts, xoff, fps) if lock else {}
    m = BodyModel.get(); inst = m.instance(H); fit = Fitter(m, inst); o = fit.fit(J); b = fit.b
    heads = o["heads"]
    lowest = heads[:, [b["foot.L"], b["foot.R"]], 2].min(1)
    # a planted foot is the one on the ground (the other may swing through lower than the script's ankle height)
    for sd, (i0, i1) in plants.items():
        for i in range(i0, i1 + 1):
            lowest[i] = min(heads[i, b["foot." + s2], 2] for s2, (j0, j1) in plants.items() if j0 <= i <= j1)
    off = np.stack([xoff, np.zeros_like(xoff), 0.08 - lowest], 1)
    heads = heads + off[:, None]
    V = m.skin(inst, o["D"], heads)
    f_ffc, f_br = int(round(EV["ffc"] * fps)), int(round(EV["br"] * fps))
    Xf = heads[f_br, b["foot.L"], 0]                 # the front ankle at release: just behind the popping crease
    y_w = heads[f_br, b["wrist.R"], 1]
    x0s = -0.45 + y_w + wide                         # `wide`: the whole bowler moved across the crease, metres

    def scene(P):                                    # mannequin axes -> scene axes
        return np.stack([x0s - P[..., 1], P[..., 2], -1.05 - foot - (P[..., 0] - Xf)], -1)   # `foot`: landing further down the pitch
    Vs, Hs = scene(V), scene(heads)
    # the ball: in the hand until release (a third of a frame after the release frame), then in flight
    t_rel = EV["br"] + 0.3 / fps

    def hand(t):
        i = min(len(ts) - 2, int(np.floor(t * fps))); u = t * fps - i
        w = Hs[i, b["wrist.R"]] * (1 - u) + Hs[i + 1, b["wrist.R"]] * u
        e = Hs[i, b["lowerarm01.R"]] * (1 - u) + Hs[i + 1, b["lowerarm01.R"]] * u
        d = w - e
        return w + 0.09 * d / np.linalg.norm(d)
    p_rel = hand(t_rel)
    elev, azim = aim(p_rel, kmh / 3.6, length, line, swing, bounce)
    ft, fp, info = fly(p_rel, kmh / 3.6, elev, azim, swing, bounce)

    def ball_at(t):
        if t <= t_rel:
            return hand(t)
        return np.array([np.interp(t - t_rel, ft, fp[:, k]) for k in range(3)])
    # `kit`: the figure dressed as a player (short-sleeved shirt, trousers, bare forearms and hands, hair, shoes),
    # each face coloured by the bone that moves it; plain grey-white otherwise
    kit_cols = None
    if kit:
        dom = np.array(m.labels)[m.vbi4[:, 0]][m.faces[:, 0]]
        shirt, trousers, skin, hair, shoe = {"blue": ((170, 95, 35), (150, 80, 30)), "white": ((232, 236, 238), (225, 230, 233)),
                                             "red": ((50, 45, 185), (40, 40, 60))}[kit] + ((125, 160, 215), (35, 40, 50), (240, 240, 240))
        head_y = Vs[0][:, 1][m.faces].mean(1); top = Vs[0][:, 1].max()
        kit_cols = []
        for f, d in enumerate(dom):
            # (the blue kit's sleeves stop half-way down the upper arm; the others reach the elbow)
            if d.startswith(("lowerarm", "wrist", "finger", "metacarpal", "neck", "eye")) or (d.startswith("upperarm02") and kit == "blue"):
                c = skin
            elif d == "head":
                c = hair if head_y[f] > top - 0.13 * H / 1.8 else skin
            elif d.startswith(("foot", "toe")):
                c = shoe
            elif d.startswith(("upperleg", "lowerleg", "pelvis", "root")):
                c = trousers
            else:
                c = shirt
            kit_cols.append(c)
    tex, (tx0, tz0, res) = ground_texture(rng)
    fall = np.array(fall, float)
    col_ball = (45, 40, 190) if ball == "red" else (235, 238, 240)
    vw = cv2.VideoWriter(str(out), cv2.VideoWriter_fourcc(*"avc1"), fps, (W, Hh))
    rawf = open(raw, "wb") if raw else None
    cams = []
    t_end_zoom = t_rel + 0.5
    for i, t in enumerate(ts):
        # the camera this frame
        u = float(np.clip((t - (t_rel - 0.35)) / (t_end_zoom - (t_rel - 0.35)), 0, 1)); u = u * u * (3 - 2 * u)
        f = cfg["f"] * (1 + (cfg["zoom"] - 1) * u)
        at = np.array(cfg["at"], float) + np.array([0.0, 0.0, -cfg["tilt"] * u])
        R, tv = look_at(cfg["pos"], at)
        cams.append({"f": f, "R": R.tolist(), "t": tv.tolist()})

        def proj(P):
            c = P @ R.T + tv
            return np.stack([W / 2 + f * c[..., 0] / c[..., 2], Hh / 2 + f * c[..., 1] / c[..., 2]], -1), c[..., 2]
        # ground: texture pixel (a, b) -> scene (tx0 + a res, 0, tz0 + b res) -> picture
        K = np.array([[f, 0, W / 2], [0, f, Hh / 2], [0, 0, 1]])
        Hm = K @ np.stack([R[:, 0] * res, R[:, 2] * res, R @ np.array([tx0, 0, tz0]) + tv], 1)
        img = cv2.warpPerspective(tex, Hm, (W, Hh), flags=cv2.INTER_AREA, borderMode=cv2.BORDER_CONSTANT, borderValue=(70, 90, 80))
        tri = Vs[i][m.faces]
        if sun:                                       # shadows first: they lie on the ground
            sh = np.zeros((Hh, W), np.uint8)
            g = tri.copy(); g[..., 0] += fall[0] * tri[..., 1]; g[..., 2] += fall[1] * tri[..., 1]; g[..., 1] = 0
            p2, _ = proj(g)
            cv2.fillPoly(sh, list(np.round(p2).astype(np.int32)), 255)
            for z_st in (0.0, -PITCH):
                for sx in (-STUMP_X, 0, STUMP_X):
                    q, _ = proj(np.array([[sx, 0, z_st], [sx + fall[0] * STUMP_H, 0, z_st + fall[1] * STUMP_H]]))
                    d, _ = proj(np.array([[sx, 0, z_st], [sx + 0.019, 0, z_st]]))
                    cv2.line(sh, tuple(np.round(q[0]).astype(int)), tuple(np.round(q[1]).astype(int)), 255, max(1, int(round(2 * np.linalg.norm(d[1] - d[0])))))
            sh = cv2.GaussianBlur(sh, (0, 0), 0.8).astype(np.float32)[..., None] / 255
            img = (img.astype(np.float32) * (1 - 0.42 * sh)).astype(np.uint8)
            pa, pb = ball_at(t - shutter / 2), ball_at(t + shutter / 2)
            ga, gb = np.array([pa[0] + fall[0] * pa[1], 0, pa[2] + fall[1] * pa[1]]), np.array([pb[0] + fall[0] * pb[1], 0, pb[2] + fall[1] * pb[1]])
            q, dep = proj(np.stack([ga, gb]))
            capsule(img, q[0], q[1], max(1.0, f * BALL_R / dep.mean()), tuple(int(c * 0.5) for c in img[int(np.clip(q[0][1], 0, Hh - 1)), int(np.clip(q[0][0], 0, W - 1))]), 0.9)
        # stumps
        for z_st in (-PITCH, 0.0):
            for sx in (-STUMP_X, 0, STUMP_X):
                q, dep = proj(np.array([[sx, 0, z_st], [sx, STUMP_H, z_st]]))
                capsule(img, q[0], q[1], max(0.8, f * 0.019 / dep.mean()), (185, 215, 235))
        # the bowler, far triangles first
        p2, depth = proj(Vs[i])
        n = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0]); n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)
        light = np.array([-fall[0], 1.0, -fall[1]]); light /= np.linalg.norm(light)
        shade = np.clip(np.abs(n @ light), 0.2, 1.0)
        order = np.argsort(-depth[m.faces].mean(1))
        P = np.round(p2[m.faces]).astype(np.int32)
        yc = Vs[i][:, 1][m.faces].mean(1)
        for k in order:
            base = (235, 235, 240) if yc[k] < 0.55 * H else (200, 205, 215)
            if yc[k] > 0.84 * H:
                base = (150, 170, 205)
            if kit_cols is not None:
                base = kit_cols[k]
            cv2.fillConvexPoly(img, P[k], tuple(int(c * (0.35 + 0.65 * shade[k])) for c in base), lineType=cv2.LINE_AA)
        # the ball, blurred over the shutter time
        pa, pb = ball_at(t - shutter / 2), ball_at(t + shutter / 2)
        q, dep = proj(np.stack([pa, pb]))
        capsule(img, q[0], q[1], max(1.0, f * BALL_R / dep.mean()), col_ball)
        img = np.clip(img.astype(np.float32) + rng.normal(0, 2.0, img.shape), 0, 255).astype(np.uint8)
        vw.write(img)
        if rawf:
            rawf.write(cv2.cvtColor(img, cv2.COLOR_BGR2RGBA).tobytes())
    vw.release()
    if rawf:
        rawf.close()

    # truth, in the tracker's terms
    def px(P, i):
        c = cams[i]; R, tv, f = np.array(c["R"]), np.array(c["t"]), c["f"]
        q = np.array(P, float) @ R.T + tv
        return [float(W / 2 + f * q[0] / q[2]), float(Hh / 2 + f * q[1] / q[2])]
    X = RET + LINE / 2
    marks = {}
    for end, z_st, to in (("bowler", 0.0, -1.0), ("batter", -PITCH, 1.0)):
        marks[end] = {"pop_l": [-X, 0, z_st + to * (POP + LINE / 2)], "pop_r": [X, 0, z_st + to * (POP + LINE / 2)],
                      "bowl_l": [-X, 0, z_st + to * LINE / 2], "bowl_r": [X, 0, z_st + to * LINE / 2],
                      "stump_base": [0, 0, z_st], "stump_top": [0, STUMP_H, z_st]}
    v0 = (fp[1] - fp[0]) / (ft[1] - ft[0])
    truth = {
        "view": view, "fps": fps, "size": [W, Hh], "frames": len(ts), "cameras": cams, "marks_world": marks,
        "release": {"t": float(t_rel), "frame": f_br, "p": p_rel.tolist(), "kmh": kmh,
                    "down_deg": float(np.degrees(np.arctan2(-v0[1], np.hypot(v0[0], v0[2]))))},
        "pitch": None if info["bounce"] is None else {"length": info["bounce"]["z"] + PITCH, "line": info["bounce"]["x"],
                                                      "t": info["bounce"]["t"], "kmh_in": info["bounce"]["kmh_in"], "kmh_out": info["bounce"]["kmh_out"]},
        "swing": info["swung"], "stumps": info["stumps"], "sun_fall": list(map(float, fall)) if sun else None,
        "ball_px": [px(ball_at(t), i) for i, t in enumerate(ts)],
        "hand_px": px(hand(ts[f_br]), f_br), "ankle_px": [px(Hs[f_br, b["foot.L"]], f_br), px(Hs[f_br, b["foot.R"]], f_br)],
        "ankle_world": Hs[f_br, b["foot.L"]].tolist(),
        "body": body_truth(Vs, Hs, b, H, fps),
        "plant": {("back" if sd == "R" else "front"): [int(i0), int(i1)] for sd, (i0, i1) in plants.items()},
        "upright": {"foot": [0, 0, 0], "tip": [fall[0] * STUMP_H, 0, fall[1] * STUMP_H]} if sun else None,
    }
    return truth


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--view", default="phone", choices=list(VIEWS))
    ap.add_argument("--fps", type=float, default=60.0)
    ap.add_argument("--kmh", type=float, default=128.0)
    ap.add_argument("--length", type=float, default=6.5)
    ap.add_argument("--line", type=float, default=0.05)
    ap.add_argument("--swing", type=float, default=0.1)
    ap.add_argument("--ball", default="red", choices=["red", "white"])
    ap.add_argument("--no-sun", action="store_true")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--raw")
    ap.add_argument("--height", type=float, default=1.80)
    ap.add_argument("--wide", type=float, default=0.0)
    ap.add_argument("--foot", type=float, default=0.0)
    ap.add_argument("--kit", choices=["blue", "white", "red"], help="dress the figure as a player (default: plain)")
    ap.add_argument("--slide", action="store_true", help="the old figure, whose planted feet slide along the ground")
    a = ap.parse_args()
    truth = render(a.out, a.view, a.fps, a.kmh, a.length, a.line, a.swing, a.ball, not a.no_sun, H=a.height, seed=a.seed, raw=a.raw, wide=a.wide, foot=a.foot, lock=not a.slide, kit=a.kit)
    Path(a.out).with_suffix(".truth.json").write_text(json.dumps(truth))
    print(json.dumps({k: truth[k] for k in ("release", "pitch", "swing", "stumps")}, indent=1))


if __name__ == "__main__":
    main()
