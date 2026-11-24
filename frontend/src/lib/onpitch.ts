/**
 * The bowler, measured on the pitch in real metres. Filmed from behind, both sets of stumps and the creases are in the
 * picture, and the Laws fix their sizes: lib/camcal.ts turns a few marks on them into the camera. From then on a point
 * known to be on the ground (a heel) has one place on the pitch, and a point at a known distance down the pitch (the
 * hand at release, above the planted front foot) has one height and one distance from the stumps. No height is typed
 * in and none is assumed: the stumps are the ruler.
 *
 * Why this is accurate from behind in particular: the lines of sight run nearly along the pitch, so not knowing
 * exactly how far down the pitch the hand is moves its measured height very little (a 30 cm doubt in distance is 2 to
 * 5 cm of height for the cameras people use). Every figure carries that doubt, worked out for this camera.
 *
 * Scene axes as lib/camcal.ts: y up, the bowler's stumps at z = 0, the batter's at z = -20.12, +x to the right seen
 * from behind the bowler. The bowler runs towards -z.
 */
import { onPlaneY, onPlaneZ, ray, solveCameraPoints, isCamera, worldOf, POPPING, RETURN_X, type Camera, type Mark, type Pt } from "./camcal";
import type { AnalysisResult } from "../types";
import type { V3 } from "./biomech";

export interface Est { value: number; sigma: number }
export interface Foot { heel: V3; toe: V3 | null; frame: number; sx: number; sz: number; from: "heel" | "ankle" }
export type CreaseVerdict = "legal" | "no_ball" | "close";

export interface OnPitch {
  still: boolean;                     // the camera did not move through the delivery
  side: "left" | "right";             // the bowling arm
  frontSeen: boolean;                 // false: the front foot's landing was hidden (usually by the back leg) and is not measured
  back: Foot | null;                  // the back foot where it landed
  front: Foot | null;                 // the front foot where it landed
  /** Where the ball left the hand: the top of the hand's arc (`arc`), or, when there was no arc to go by, the hand as
   * the release frame caught it (then `timing` is the part of the height's doubt that comes from knowing the release
   * to the frame and not within it). `caught`: the hand's height in the release frame itself. `arm`: shoulder to ball,
   * metres. Also the wrist in that frame, and the front ankle's z the hand was placed above. */
  release: { p: V3; wrist: V3; footZ: number; height: Est; across: Est; frame: number; timing: number; arc: boolean; caught: number; arm: number | null;
    /** When the hand was at the top of its arc, as a video frame number with a fraction (null without an arc to go by). */
    topFrame: number | null } | null;
  stride: Est | null;                 // heel to heel, metres
  across: Est | null;                 // how far across the front foot lands from the back foot's line, metres (+x)
  alignDeg: Est | null;               // that as an angle to the line of the pitch
  popping: { margin: Est; verdict: CreaseVerdict } | null;   // the front heel behind the popping crease's back edge, metres (negative: over it)
  returnGap: Est | null;              // the back foot inside the return crease, metres (negative: on or over it)
  stature: Est | null;                // the bowler's height, measured
  runup: Est | null;                  // run-up speed into the delivery stride, km/h
  steps: Foot[];                      // feet on the ground after the release (the follow-through)
  danger: Foot | null;                // the first of those inside the protected area
  body: (V3[] | null)[];              // per frame of the analysis: the 17 COCO joints in scene metres
  depth: (number | null)[];           // per frame: how far down the pitch the bowler is (z of the hips)
}

// Law 41.13: the protected area starts 1.52 m in front of the popping crease and is 30.48 cm either side of middle stump
export const PROTECTED_Z = -(POPPING + 1.52), PROTECTED_X = 0.3048;
/** Where the pose model's heel and toe points sit above the ground, metres (the back of the heel, the tip of the shoe). */
export const HEEL_Y = 0.055, TOE_Y = 0.02;
const FOOT_LEN = 0.22;                       // heel point to toe points along the ground, metres (a little under a foot's length)
const ANKLE_Y = 0.08, ANKLE_AHEAD = 0.07;   // the ankle joint: above the ground and ahead of the heel point
// At release the hand is a little ahead of the planted front ankle (the trunk has come over the front leg): 10 cm
// further down the pitch, give or take 25 cm.
const HAND_AHEAD = 0.0, HAND_DEPTH_SIGMA = 0.25;
// Shoulder to the middle of the ball in the hand, as a share of standing height: upper arm 18.6%, forearm 14.6% and
// the hand's reach to the ball a third of the forearm again (Drillis and Contini's segment lengths).
const ARM_OF_HEIGHT = 0.186 + 1.35 * 0.146;
/** Switches for trying one way of measuring against another (tests and the local accuracy loop only). */
export const TUNE: { release: "arc" | "fit" | "blend"; planeZ: number | null; timing: "sides" | "fit"; arms: "raw" | "smooth"; stature: "new" | "old" } = { release: "blend", planeZ: null, timing: "fit", arms: "raw", stature: "new" };
const L_SH = 5, R_SH = 6, L_EL = 7, R_EL = 8, L_WR = 9, R_WR = 10, L_HIP = 11, R_HIP = 12, L_AN = 15, R_AN = 16;
// COCO joint -> the H36M joint the 3D estimate has for it
const COCO_TO_H36M = [9, 9, 9, 9, 9, 11, 14, 12, 15, 13, 16, 4, 1, 5, 2, 6, 3];

/** Each video frame's place over the marked frame: a point p of that frame (pixels of the marked canvas) is at
 * s p + (dx, dy) in the marked frame. Frames in between are filled in. */
export type FrameShifts = Map<number, { s: number; dx: number; dy: number }>;

type M3 = number[][];
const mul = (a: M3, b: M3): M3 => a.map((r) => [0, 1, 2].map((j) => r[0] * b[0][j] + r[1] * b[1][j] + r[2] * b[2][j]));
function inv(m: M3): M3 {
  const [a, b, c] = m[0], [d, e, f] = m[1], [g, h, i] = m[2];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C;
  return [[A / det, -(b * i - c * h) / det, (b * f - c * e) / det], [B / det, (a * i - c * g) / det, -(a * f - c * d) / det], [C / det, -(a * h - b * g) / det, (a * e - b * d) / det]];
}
const median = (v: number[]) => { const s = [...v].sort((p, q) => p - q), n = s.length; return n ? (n % 2 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2) : NaN; };
const quantile = (v: number[], q: number) => { const s = [...v].sort((p, r) => p - r); if (!s.length) return NaN; const i = q * (s.length - 1), a = Math.floor(i); return s[a] + (s[Math.min(s.length - 1, a + 1)] - s[a]) * (i - a); };

/**
 * Each frame's pixels in the marked frame's pixels (the canvas the pitch was marked on, `cam.w` wide). A camera on a
 * tripod gives the same picture throughout; one that pans or zooms is followed by the analysis's own background
 * motion. `markFrame` is a video frame number.
 */
export function frameMaps(r: AnalysisResult, cam: Pick<Camera, "w">, markFrame: number, shifts?: FrameShifts | null): { map: (t: number, p: Pt) => Pt; still: boolean } {
  const T = r.keypoints2d.xy.length, k = cam.w / (r.video.width * r.display_scale), ds = r.display_scale;
  const mot = r.camera_motion, W = r.video.width, Hh = r.video.height;
  const plain = (_t: number, p: Pt): Pt => [p[0] * k, p[1] * k];
  if (shifts && shifts.size >= 2) {
    // measured on the frames themselves (the page lines each frame up with the marked one): zoom s and slide dx, dy
    const fs = [...shifts.keys()].sort((a, b) => a - b), f0 = r.frames.start;
    const still = fs.every((f) => { const m = shifts.get(f)!; return Math.abs(m.s - 1) < 0.002 && Math.hypot(m.dx, m.dy) < 0.0015 * cam.w; });
    if (still) return { map: plain, still: true };
    const at = (f: number) => {
      if (f <= fs[0]) return shifts.get(fs[0])!;
      if (f >= fs[fs.length - 1]) return shifts.get(fs[fs.length - 1])!;
      let i = 1;
      while (fs[i] < f) i++;
      const a = shifts.get(fs[i - 1])!, b = shifts.get(fs[i])!, u = (f - fs[i - 1]) / (fs[i] - fs[i - 1]);
      return { s: Math.exp(Math.log(a.s) + (Math.log(b.s) - Math.log(a.s)) * u), dx: a.dx + (b.dx - a.dx) * u, dy: a.dy + (b.dy - a.dy) * u };
    };
    return { still: false, map: (t, p) => { const m = at(t + f0); return [m.s * p[0] * k + m.dx, m.s * p[1] * k + m.dy]; } };
  }
  if (!mot || mot.length !== T) return { map: plain, still: true };
  const H: M3[] = [[[1, 0, 0], [0, 1, 0], [0, 0, 1]]];
  for (let t = 1; t < T; t++) H.push(mul([mot[t][0], mot[t][1], [0, 0, 1]], H[t - 1]));
  const tm = Math.max(0, Math.min(T - 1, markFrame - r.frames.start));
  const G = H.map((h) => mul(H[tm], inv(h)));   // frame t -> the marked frame, video pixels
  // how far the picture's corners wander: under a third of a percent of its width is a tripod and the motion's own noise
  let far = 0;
  for (const g of G) for (const [x, y] of [[0, 0], [W, 0], [0, Hh], [W, Hh]]) far = Math.max(far, Math.hypot(g[0][0] * x + g[0][1] * y + g[0][2] - x, g[1][0] * x + g[1][1] * y + g[1][2] - y));
  if (far < 0.0035 * W) return { map: plain, still: true };
  const kv = cam.w / W;
  return { still: false, map: (t, p) => {
    const g = G[Math.max(0, Math.min(T - 1, t))], x = p[0] / ds, y = p[1] / ds;
    return [(g[0][0] * x + g[0][1] * y + g[0][2]) * kv, (g[1][0] * x + g[1][1] * y + g[1][2]) * kv];
  } };
}

interface FeetPx { heel: (Pt | null)[]; toe: (Pt | null)[] }   // [left, right] in the analysis's labels, display px
/** The heel and toe of each foot in a frame, given to the ankle they belong to (the foot points keep the crop model's
 * own left and right, which the analysis may since have put right). */
function feetOf(r: AnalysisResult, t: number): FeetPx | null {
  const f = r.feet?.[t], kp = r.keypoints2d.xy[t];
  if (!f || !kp) return null;
  const pt = (i: number): Pt | null => (f[i] && f[i][2] >= 0.3 ? [f[i][0], f[i][1]] : null);
  const toeOf = (a: number, b: number): Pt | null => { const p = pt(a), q = pt(b); return p && q ? [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2] : p ?? q; };
  const A = { heel: pt(7), toe: toeOf(3, 5) }, B = { heel: pt(8), toe: toeOf(4, 6) };
  const d = (p: Pt | null, j: number) => (p ? Math.hypot(p[0] - kp[j][0], p[1] - kp[j][1]) : 0);
  const keep = d(A.heel ?? A.toe, L_AN) + d(B.heel ?? B.toe, R_AN), swap = d(A.heel ?? A.toe, R_AN) + d(B.heel ?? B.toe, L_AN);
  const [l, rt] = swap < keep ? [B, A] : [A, B];
  return { heel: [l.heel, rt.heel], toe: [l.toe, rt.toe] };
}

/** How tall the bowler stands in the picture (pixels of the marked canvas), for the size of a keypoint's doubt. */
function bodyPx(r: AnalysisResult, k: number): number {
  const hs: number[] = [];
  for (const kp of r.keypoints2d.xy) {
    const top = Math.min(kp[0][1], kp[L_SH][1], kp[R_SH][1]), bot = Math.max(kp[L_AN][1], kp[R_AN][1]);
    if (bot > top) hs.push((bot - top) * k);
  }
  return quantile(hs, 0.8) || 200;
}

export function measureOnPitch(r: AnalysisResult, cam: Camera, markFrame: number, shifts?: FrameShifts | null): OnPitch | null {
  const T = r.keypoints2d.xy.length, f0 = r.frames.start;
  const ev = (k: "bfc" | "ffc" | "br") => { const f = r.events[k]?.frame; return f == null ? null : Math.max(0, Math.min(T - 1, f - f0)); };
  const bfc = ev("bfc"), ffc = ev("ffc"), br = ev("br");
  if (br === null) return null;
  const { map, still } = frameMaps(r, cam, markFrame, shifts);
  // a point the model placed at the very edge of the picture is a guess at something out of view
  const dw = r.video.width * r.display_scale, dh = r.video.height * r.display_scale;
  const inView = (p: Pt | number[]) => p[0] > 0.015 * dw && p[0] < 0.985 * dw && p[1] > 0.015 * dh && p[1] < 0.985 * dh;
  const k = cam.w / (r.video.width * r.display_scale);
  const side = r.bowling_arm.arm, right = side === "right";
  const frontI = right ? 0 : 1, backI = 1 - frontI;                  // index into [left, right]
  const frontAn = right ? L_AN : R_AN, backAn = right ? R_AN : L_AN;
  const fps = Math.max(1, r.fps_real || r.fps);
  // a keypoint is good to about 1.2% of the bowler's height in the picture; the camera fit adds its own misfit
  const spx = Math.hypot(0.012 * bodyPx(r, k), cam.rms);
  const kc = r.keypoints2d.conf;

  /** A foot on the ground in frame t: from its heel point, or from the ankle when the heel was not read. */
  const footAt = (t: number, i: number): Foot | null => {
    const fp = feetOf(r, t), an = i === 0 ? L_AN : R_AN;
    let px: Pt | null = fp?.heel[i] ?? null, y = HEEL_Y, from: Foot["from"] = "heel", back = 0;
    if (!px) {
      if (kc[t][an] < 0.3) return null;
      px = r.keypoints2d.xy[t][an]; y = ANKLE_Y; from = "ankle"; back = ANKLE_AHEAD;
    }
    if (!inView(px)) return null;
    const m = map(t, px), g = onPlaneY(cam, m, y);
    if (!g) return null;
    const gy = onPlaneY(cam, [m[0], m[1] + spx], y), gx = onPlaneY(cam, [m[0] + spx, m[1]], y), gh = onPlaneY(cam, m, y + 0.02);
    if (!gy || !gx || !gh) return null;
    const heel: V3 = [g[0], 0, g[2] + back];
    const tp = fp?.toe[i], tg = tp ? onPlaneY(cam, map(t, tp), TOE_Y) : null;
    return { heel, toe: tg ? [tg[0], 0, tg[2]] : null, frame: t + f0, from,
      sx: Math.hypot(gx[0] - g[0], gh[0] - g[0]), sz: Math.hypot(gy[2] - g[2], gh[2] - g[2], from === "ankle" ? 0.04 : 0) };
  };
  /** The foot while it is planted: the middle of what the frames from t0 to t1 say. */
  const planted = (i: number, t0: number, t1: number, onToes = true): Foot | null => {
    const fs: Foot[] = [];
    for (let t = Math.max(0, t0); t <= Math.min(T - 1, t1); t++) { const f = footAt(t, i); if (f) fs.push(f); }
    if (!fs.length) return null;
    const mid = fs[fs.length >> 1], toes = fs.filter((f) => f.toe).map((f) => f.toe!);
    const n = Math.sqrt(fs.length);
    // How far down the pitch: a foot that is not yet down, or is up on its toes (a fast bowler's back foot often
    // never puts its heel down), is seen along a line that meets the ground further away than the foot is. So of
    // what the frames say, the nearer readings are the true ones; and the toes, when they are the part on the
    // ground, put the heel a foot's length behind them.
    // (Only the back foot is read from its toes. The front foot lands heel first and stays flat until the ball has
    // gone, so its heel is the reading; its toes, seen from above and behind, read 10 to 20 cm short of where
    // they are, and going by them put the heel that much too near.)
    const zs = fs.map((f) => Math.max(f.heel[2], onToes && f.toe && f.from === "heel" ? f.toe[2] + FOOT_LEN : -Infinity));
    return { ...mid, heel: [median(fs.map((f) => f.heel[0])), 0, fs.length >= 3 ? quantile(zs, 0.75) : Math.max(...zs)],
      toe: toes.length ? [median(toes.map((p) => p[0])), 0, median(toes.map((p) => p[2]))] : null,
      // frames of one planted foot share most of their error (where the model puts a heel), so more frames help only a little
      sx: mid.sx * (0.7 + 0.3 / n), sz: mid.sz * (0.7 + 0.3 / n), frame: t0 + f0 };
  };
  const hold = Math.max(1, Math.round(0.05 * fps));
  /**
   * The frames a foot is down for, around the frame the analysis gave for its landing. That frame can be one or two
   * early at 25 to 30 fps, when the foot is still swinging through (past the other foot, well short of where it will
   * land). A foot that is down has stopped in the picture: the first frames from just before the given one in which
   * its heel moves less than 3% of the bowler's height from one to the next.
   */
  const stance = (i: number, e: number, last: number): [number, number] => {
    const an = i === 0 ? L_AN : R_AN, lim = 0.03 * bodyPx(r, k), hi = Math.min(T - 1, last, e + Math.max(3, Math.round(0.2 * fps)));
    const at = (t: number): Pt | null => { if (t < 0 || t >= T) return null; const fp = feetOf(r, t)?.heel[i] ?? (kc[t][an] >= 0.3 ? r.keypoints2d.xy[t][an] : null); return fp ? map(t, fp) : null; };
    const stepPx = (t: number) => { const a = at(t), b = at(t + 1); return a && b ? Math.hypot(a[0] - b[0], a[1] - b[1]) * Math.min(1, fps / 30) : Infinity; };
    for (let t = Math.max(0, e - 1); t < hi; t++) {
      if (stepPx(t) >= lim) continue;
      let u = t + 1;
      while (u < hi && u - t < hold + 2 && stepPx(u) < lim) u++;
      return [t, u];
    }
    return [e, Math.min(hi, e + hold + 1)];   // never seen to stop (a blur, a dragged toe): the frames after the given one
  };
  const sb = bfc !== null ? stance(backI, bfc, (ffc ?? br) - 1) : null, sf = ffc !== null ? stance(frontI, ffc, br + hold) : null;
  (globalThis as { __onpDbg3?: (x: unknown) => void }).__onpDbg3?.({ sb, sf, frontI, backI, f0, feet: Array.from({ length: T }, (_, t) => [footAt(t, 0), footAt(t, 1)]) });
  const back = sb ? planted(backI, sb[0], sb[1]) : null;
  let front = sf ? planted(frontI, sf[0], sf[1], false) : null;
  // at the release itself (the hand is placed above it): the frames either side, but not from before the foot was down
  let frontAtBr = planted(frontI, Math.max(sf ? sf[0] : br - 1, br - 1), Math.min(T - 1, Math.max(br + 1, sf ? sf[0] + 1 : 0)), false) ?? front;

  // ---- how far down the pitch the bowler is, frame by frame ----
  // Before the delivery stride: of the two feet, the one on the ground is the one whose line of sight meets the
  // ground nearer the camera (a lifted foot's meets it further away). A line through the nearest 30% says where the
  // feet land through the run-up; the hips are over them.
  const near: (number | null)[] = [];
  for (let t = 0; t < T; t++) {
    const a = footAt(t, 0), b = footAt(t, 1);
    near.push(a && b ? Math.max(a.heel[2], b.heel[2]) : a ? a.heel[2] : b ? b.heel[2] : null);
  }
  const runEnd = bfc ?? ffc ?? br;
  let line: { a: number; b: number; rms: number } | null = null;
  {
    const lo = Math.max(0, runEnd - Math.round(0.8 * fps));
    const pts: [number, number][] = [];
    for (let t = lo; t <= runEnd; t++) if (near[t] !== null) pts.push([t, near[t]!]);
    if (pts.length >= Math.max(5, Math.round(0.25 * fps))) {
      let w = pts.map(() => 1), a = 0, b = 0;
      for (let it = 0; it < 12; it++) {
        let sw = 0, st = 0, sz = 0, stt = 0, stz = 0;
        pts.forEach(([t, z], i) => { sw += w[i]; st += w[i] * t; sz += w[i] * z; stt += w[i] * t * t; stz += w[i] * t * z; });
        const den = sw * stt - st * st;
        if (Math.abs(den) < 1e-9) break;
        b = (sw * stz - st * sz) / den; a = (sz - b * st) / sw;
        // quantile regression at 0.7: points beyond the line (a lifted foot) count for less
        w = pts.map(([t, z]) => { const e = z - (a + b * t); return (e >= 0 ? 0.7 : 0.3) / Math.max(0.02, Math.abs(e)); });
      }
      const res = pts.map(([t, z]) => z - (a + b * t));
      line = { a, b, rms: Math.sqrt(res.reduce((s, e) => s + e * e, 0) / res.length) };
    }
  }
  // The run-up is read off feet a long way from the crease (and, on broadcast footage, through a zoom): when it
  // comes out at a speed nobody runs in at, or going the wrong way, that reading is not to be believed, and nothing
  // that leans on it (the run-up speed, the bowler's height) is given.
  const runKmh = line ? -line.b * fps * 3.6 : null;
  if (runKmh !== null && (runKmh < 4 || runKmh > 29)) line = null;   // (the quickest run in at the top level is about 25 km/h)
  // ---- the bowler's height: the top of the head above the ground through the run-up ----
  let stature: Est | null = null;
  if (r.feet && line) {
    // The head is not over the foot the line follows. That line runs through the feet as they are left behind (of
    // the two feet, the one nearer the camera); the hips are a short step ahead of it and a running bowler's head a
    // little ahead of the hips: about a quarter of the bowler's height in all. Reading the head on the foot's own
    // plane makes it too high from a camera looking down (Bumrah, 1.78 m, read 1.82) and too small from a camera
    // close behind at chest height (a 1.80 m figure read 1.68). So it is read where it is, a first time for a
    // bowler of ordinary height and again with the height that gives.
    let hs: number[] = [];
    for (let pass = 0, H0 = 1.8; pass < 2; pass++) {
      hs = [];
      const ahead = TUNE.stature === "old" ? 0 : 0.25 * H0;
      for (let t = Math.max(0, runEnd - Math.round(0.8 * fps)); t < runEnd; t++) {
        const h = r.feet[t]?.[0], z = line.a + line.b * t;
        if (!h || h[2] < 0.3 || z == null || !inView(h)) continue;
        const p = onPlaneZ(cam, map(t, [h[0], h[1]]), z - ahead);
        if (p) hs.push(p[1]);
      }
      if (hs.length < 5) break;
      H0 = Math.max(1.3, Math.min(2.2, quantile(hs, 0.75) * (TUNE.stature === "old" ? 1 : 1.025)));
    }
    if (hs.length >= 5) {
      // running, the head rides a little below standing height for most of each stride and reaches it at the top
      const top = onPlaneZ(cam, map(runEnd, [r.feet[runEnd]?.[0]?.[0] ?? 0, r.feet[runEnd]?.[0]?.[1] ?? 0]), line.a + line.b * runEnd);
      const top2 = onPlaneZ(cam, map(runEnd, [r.feet[runEnd]?.[0]?.[0] ?? 0, r.feet[runEnd]?.[0]?.[1] ?? 0]), line.a + line.b * runEnd + Math.max(0.25, line.rms));
      const dd = top && top2 ? Math.abs(top2[1] - top[1]) : 0.05;
      // (and a bowler running in rides a few centimetres under standing height: 2.5% is allowed for it)
      stature = { value: quantile(hs, 0.75) * (TUNE.stature === "old" ? 1 : 1.025), sigma: Math.max(0.06, Math.hypot(dd, 0.02, (quantile(hs, 0.9) - quantile(hs, 0.5)) / 2)) };
    }
  }
  (globalThis as { __onpDbg2?: (x: unknown) => void }).__onpDbg2?.({ line, runKmh, near, stature, runEnd, f0 });
  // ---- is the front foot's landing spot believable? ----
  // Seen from straight behind, the front foot often lands hidden by the back leg, and the model then guesses at it.
  // A delivery stride is between about 45% and 105% of the bowler's height (spinners to the longest-striding quicks):
  // a "stride" outside that is a foot that was not seen, and nothing is measured from it. The hand's distance down
  // the pitch is then taken from the back foot instead, a usual stride ahead of it, with a wider doubt.
  // (a height the user entered is surer than one read off a running bowler's head: it sizes the stride check and the arm)
  const known = r.skeleton?.height_source === "user" && r.skeleton.stature_m > 1 ? r.skeleton.stature_m : null;
  const Hs = known ?? stature?.value ?? 1.8;
  let frontSeen = true;
  if (back && front) {
    const st = Math.hypot(front.heel[0] - back.heel[0], front.heel[2] - back.heel[2]);
    if (st < 0.45 * Hs || st > 1.05 * Hs || front.heel[2] > back.heel[2] - 0.3) frontSeen = false;
  }
  const usualFront = back ? back.heel[2] - 0.72 * Hs : null;   // where a usual stride would put the front heel
  if (!frontSeen) { front = null; frontAtBr = null; }
  const depth: (number | null)[] = [];
  for (let t = 0; t < T; t++) {
    let z: number | null = null;
    const zb = back ? back.heel[2] - ANKLE_AHEAD : null, zf = front ? front.heel[2] - ANKLE_AHEAD : usualFront !== null ? usualFront - ANKLE_AHEAD : null, zr = frontAtBr ? frontAtBr.heel[2] - ANKLE_AHEAD : zf;
    if (ffc !== null && t >= ffc && zf !== null && zr !== null) {
      // on the front foot: the hips come from well behind it at landing to just behind it at release, and go past after
      const u = Math.max(0, Math.min(1.6, (t - ffc) / Math.max(1, br - ffc)));
      z = zf + 0.45 + (zr + 0.2 - (zf + 0.45)) * Math.min(1, u) - Math.max(0, u - 1) * 0.6;
    } else if (bfc !== null && t >= bfc && zb !== null) {
      const end = ffc ?? br, u = (t - bfc) / Math.max(1, end - bfc);
      const z1 = zf !== null ? zf + 0.45 : zb - 0.6;
      z = zb + 0.1 + (z1 - (zb + 0.1)) * u;
    } else if (line) z = line.a + line.b * t;
    else z = near[t];
    depth.push(z);
  }

  // ---- the body in scene metres: each joint where its line of sight meets its own distance down the pitch ----
  const J3 = r.skeleton3d?.joints;
  const body: (V3[] | null)[] = [];
  for (let t = 0; t < T; t++) {
    const z0 = depth[t];
    if (z0 === null) { body.push(null); continue; }
    const kp = r.keypoints2d.xy[t], j3 = J3?.[t];
    const out: V3[] = [];
    let ok = true;
    // around the release the bowling hand is above the planted front foot (where the release is measured), the elbow
    // on its way there: that is surer than the 3D estimate's depth for the arm, which is weakest seen from behind
    const wAt = Math.max(0, 1 - Math.abs(t - br) / Math.max(2, 0.12 * fps)), zFoot = frontAtBr ? frontAtBr.heel[2] : usualFront, zArm = zFoot !== null ? zFoot - ANKLE_AHEAD - HAND_AHEAD - z0 : null;
    for (let j = 0; j < 17; j++) {
      // the 3D estimate says how far in front of or behind the hips each joint is (its z runs back, as the scene's)
      let off = j3 ? Math.max(-0.9, Math.min(0.9, j3[COCO_TO_H36M[j]][2] - j3[0][2])) : 0;
      if (zArm !== null && wAt > 0) {
        if (j === (right ? R_WR : L_WR)) off += (zArm - off) * wAt;
        else if (j === (right ? R_EL : L_EL)) off += (0.6 * zArm - off) * wAt;
      }
      const p = onPlaneZ(cam, map(t, kp[j]), z0 + off);
      if (!p) { ok = false; break; }
      out.push(p);
    }
    body.push(ok ? out : null);
  }

  // ---- the release: the top of the hand's arc, above the planted front foot ----
  // The ball leaves the hand going nearly level (a fast bowler's good-length ball about 6 degrees below level, a
  // spinner's about level), and a hand on the end of a turning arm is going level at the top of its arc. So the
  // ball leaves at the top of the arc, to within a centimetre of height for anything from a yorker to a bouncer.
  // That matters because the hand is the fastest thing in the picture: at 30 frames a second it travels about a
  // metre between frames, and the frame nearest the release can catch it 5 to 30 cm below the top. The top itself
  // does not depend on catching the moment: it is the shoulder, plus the arm's own length (measured through the
  // delivery, checked against the bowler's height), along the line the arm is seen on. Seen from behind that line
  // stays put as the arm turns; only how much of the arm's length shows changes.
  let release: OnPitch["release"] = null;
  {
    const sh = right ? R_SH : L_SH, wr = right ? R_WR : L_WR, el = right ? R_EL : L_EL;
    const za = frontAtBr ? frontAtBr.heel[2] - ANKLE_AHEAD : usualFront !== null ? usualFront - ANKLE_AHEAD : depth[br], zf = TUNE.planeZ ?? (za == null ? null : za - HAND_AHEAD);
    // how well that distance is known: the hand over the foot, and the foot itself when it had to be assumed
    const dSig = frontAtBr ? HAND_DEPTH_SIGMA : Math.hypot(HAND_DEPTH_SIGMA, 0.22 * Hs);
    type Arm = { S: V3; H: V3; W: V3; r: number; px: Pt };
    // The elbow and wrist as the model read them in each frame, where the analysis kept them (it smooths the joints
    // in time for everything else, and smoothing flattens and delays the top of a fast arm: against rendered
    // deliveries at 120 frames a second the top came out 14 ms late from the smoothed joints, 1 ms from these).
    const armJ = (t: number, j: number): Pt => { const a = r.arms_raw?.[t]?.[j - 7]; return a && TUNE.arms !== "smooth" ? [a[0], a[1]] : r.keypoints2d.xy[t][j]; };
    const armAt = (t: number): Arm | null => {
      if (zf == null || t < 0 || t >= T || kc[t][wr] < 0.2 || kc[t][sh] < 0.2) return null;
      const q = r.keypoints2d.xy[t], w0 = armJ(t, wr), e = kc[t][el] >= 0.2 ? armJ(t, el) : w0;
      const px = map(t, [w0[0] + 0.35 * (w0[0] - e[0]), w0[1] + 0.35 * (w0[1] - e[1])]);
      const S = onPlaneZ(cam, map(t, q[sh]), zf), H = onPlaneZ(cam, px, zf), W = onPlaneZ(cam, map(t, w0), zf);
      return S && H && W ? { S, H, W, r: Math.hypot(H[0] - S[0], H[1] - S[1]), px } : null;
    };
    const at = armAt(br);
    if (at && zf != null) {
      // the arm from the shoulder to the ball: upper arm and forearm, each as long as it is ever seen through the
      // delivery (a limb pointing at the camera shows short; square to it, whole), and the hand beyond the wrist
      const ua: number[] = [], fa: number[] = [];
      // (through the delivery stride only: there the feet say how far away the bowler is, and a limb's size in the
      // picture can be turned into metres without leaning on the run-up's rougher distance)
      for (let t = Math.max(0, (bfc ?? br) - Math.round(0.15 * fps)); t <= Math.min(T - 1, br + 2); t++) {
        const z = depth[t];
        if (z == null || Math.min(kc[t][sh], kc[t][el], kc[t][wr]) < 0.3) continue;
        const q = r.keypoints2d.xy[t], S = onPlaneZ(cam, map(t, q[sh]), z), E = onPlaneZ(cam, map(t, armJ(t, el)), z), W = onPlaneZ(cam, map(t, armJ(t, wr)), z);
        if (S && E && W) { ua.push(Math.hypot(E[0] - S[0], E[1] - S[1])); fa.push(Math.hypot(W[0] - E[0], W[1] - E[1])); }
      }
      const seenLen = ua.length >= 5 ? quantile(ua, 0.85) + 1.35 * quantile(fa, 0.85) : null;
      const byHeight = known ?? stature?.value ? ARM_OF_HEIGHT * (known ?? stature!.value) : null;
      // Two readings of the arm: as long as it was seen (right when there were frames enough to catch it square to
      // the camera; short when there were not) and what a person of the bowler's height has (right to a few per
      // cent for most people). When they agree to 15% the middle of the two is taken. When they do not, slow motion
      // trusts what it saw, and ordinary frame rates, which sample the arm too coarsely, go by the height.
      const agree = seenLen !== null && byHeight !== null && Math.abs(seenLen / byHeight - 1) <= 0.15;
      const L = agree ? (seenLen! + byHeight!) / 2 : seenLen !== null && (byHeight === null || fps >= 100) ? seenLen : byHeight;
      // of the frames round the release, the one that shows most of the arm: the nearest to the top
      let top = at, tTop = br;
      for (const t of [br - 1, br + 1]) { const q = armAt(t); if (q && q.r > top.r) { top = q; tTop = t; } }
      let u: Pt = [(top.H[0] - top.S[0]) / (top.r || 1), (top.H[1] - top.S[1]) / (top.r || 1)];
      const arc = L !== null && u[1] > 0.5 && top.r > 0.45 * L;
      let reach = top.r, topFrame: number | null = null;
      if (arc) {
        // An arm caught short of the top is leaning back towards the camera, and one caught past it is leaning away,
        // so its hand is not on the plane its shoulder is on, and through a camera looking down it shows too short
        // or too long. But the hand is one arm's length from the shoulder: on the line of sight through it there
        // are two such places, the nearer for an arm before the top and the further for one past it. Which it is
        // in the frame nearest the top is settled by the frames either side: the arm turns steadily, so the right
        // choice is the one that makes the turn from frame to frame even.
        const len = L!;
        const hands = (q: Arm | null): { near: V3; far: V3 } | null => {
          if (!q) return null;
          const { o, d } = ray(cam, q.px), oc = [o[0] - q.S[0], o[1] - q.S[1], o[2] - q.S[2]], bq = d[0] * oc[0] + d[1] * oc[1] + d[2] * oc[2];
          const disc = bq * bq - (oc[0] * oc[0] + oc[1] * oc[1] + oc[2] * oc[2] - len * len), root = Math.sqrt(Math.max(0, disc));
          const on = (k: number): V3 => [o[0] + d[0] * k, o[1] + d[1] * k, o[2] + d[2] * k];
          return { near: on(-bq - root), far: on(-bq + root) };   // (a line of sight that misses by a little: the one place nearest the shoulder)
        };
        // how far past the top an arm is, in radians (before it: negative), from where its hand is
        const past = (h: V3, q: Arm) => Math.atan2(q.S[2] - h[2], Math.hypot(h[0] - q.S[0], h[1] - q.S[1]));
        const A = armAt(tTop - 1), C = armAt(tTop + 1), hA = hands(A), hB = hands(top)!, hC = hands(C);
        // towards the camera is before the top for a camera behind the bowler (and the other way round in front)
        const camBehind = cam.pos[2] > top.S[2], before = (h: { near: V3; far: V3 }) => (camBehind ? h.near : h.far), after = (h: { near: V3; far: V3 }) => (camBehind ? h.far : h.near);
        const b1 = past(before(hB), top), b2 = past(after(hB), top);
        const a = A && hA ? past(before(hA), A) : null, c = C && hC ? past(after(hC), C) : null;
        let early: boolean;   // the frame nearest the top is before it
        if (a !== null && c !== null) early = Math.abs((b1 - a) - (c - b1)) <= Math.abs((b2 - a) - (c - b2));
        else early = (C?.r ?? 0) > (A?.r ?? 0);
        const hTop = early ? before(hB) : after(hB), th = early ? b1 : b2;
        const rc = Math.hypot(hTop[0] - top.S[0], hTop[1] - top.S[1]);
        if (rc > 0.2 * len) u = [(hTop[0] - top.S[0]) / rc, (hTop[1] - top.S[1]) / rc];
        // (an arm seen longer than it was measured to be, by more than the lean explains, is taken at what was seen)
        reach = Math.max(len, Math.hypot(hTop[0] - top.S[0], hTop[1] - top.S[1], hTop[2] - top.S[2]));
        // when it was at the top: the turn is steady through the two frames either side of it
        if (early && c !== null && c - th > 1e-6) topFrame = f0 + tTop + Math.max(0, Math.min(1, -th / (c - th)));
        else if (!early && a !== null && th - a > 1e-6) topFrame = f0 + tTop - Math.max(0, Math.min(1, th / (th - a)));
        else topFrame = f0 + tTop;
      }
      // What the frames themselves say about the top. A hand on a steadily turning arm is A.cos(angle from the top)
      // above the shoulder; three frames give three such heights, and from them the height at the top (A), how far
      // the middle frame was from it and how fast the arm turns, with no assumption about how long anybody's arm
      // is. (A hand short of the top is nearer the camera than the shoulder, one past it further: each height is
      // read on its own plane, worked out from the turn, and the sum done again.)
      const arcTop = top;
      let fit: { A: number; th0: number; om: number; k: number; B: number | null } | null = null;
      if (arc && TUNE.release !== "arc") {
        const kk = Math.max(1, Math.round(fps / 60));
        let tM = tTop, qM = top;
        for (let t = br - kk; t <= br + kk; t++) { const q = armAt(t); if (q && q.H[1] - q.S[1] > qM.H[1] - qM.S[1]) { qM = q; tM = t; } }
        const qa = armAt(tM - kk), qc = armAt(tM + kk);
        if (qa && qc) {
          const Lz = (uy: number) => 1 / Math.max(0.5, uy);
          let dA = 0, dB = 0, dC = 0;
          for (let it = 0; it < 4; it++) {
            const hy = (q: Arm, dz: number) => { const P = onPlaneZ(cam, q.px, zf + dz); return P ? P[1] - q.S[1] : null; };
            const a = hy(qa, dA), b = hy(qM, dB), c = hy(qc, dC);
            if (a == null || b == null || c == null || b < 0.25) break;
            const co = (a + c) / (2 * b);
            if (!(co > -0.35)) break;
            if (co >= 0.9995) { fit = { A: b, th0: 0, om: 0, k: kk, B: null }; break; }
            const om = Math.acos(co), q = (a - c) / (2 * Math.sin(om)), A = Math.hypot(b, q), th0 = Math.atan2(q, b);
            fit = { A, th0, om, k: kk, B: null };
            const len = A * Lz(u[1]);
            dB = -len * Math.sin(th0); dA = -len * Math.sin(th0 - om); dC = -len * Math.sin(th0 + om);
          }
          if (fit) {
            top = qM; tTop = tM;
            // across the pitch the hand is B.cos(the same angle) from the shoulder: B from the same three frames
            if (fit.om > 0) {
              const hx = (q: Arm, dz: number) => { const P = onPlaneZ(cam, q.px, zf + dz); return P ? P[0] - q.S[0] : null; };
              const xs = [hx(qa, dA), hx(qM, dB), hx(qc, dC)], cs = [Math.cos(fit.th0 - fit.om), Math.cos(fit.th0), Math.cos(fit.th0 + fit.om)];
              // (the frames nearest the top count most: far from it the arm has bent or the turn has changed)
              let num = 0, den = 0;
              xs.forEach((x, i) => { if (x != null && cs[i] > 0.3) { num += x * cs[i] * cs[i]; den += cs[i] * cs[i] * cs[i]; } });
              if (den > 0) fit.B = num / den;
            }
          }
        }
      }
      (globalThis as { __onpDbg?: (x: unknown) => void }).__onpDbg?.({ fit, seenLen, byHeight, L, agree, reach, u });
      let p: V3 = arc ? [arcTop.S[0] + reach * u[0], arcTop.S[1] + reach * u[1], zf] : at.H;
      // Two readings of the top, then: from the arm's length (sure of the arm's line, as good as the length is: a
      // person's arm is within about 5% of what their height or the frames suggest) and from the frames' own heights
      // (no length assumed; exact when the middle frame is near the top, and the less sure the further from the top
      // it was, because the height is then divided by the cosine of an angle that is itself only estimated). Each
      // is weighted by how sure it is. At 50 frames a second and more the frames decide; at 25, with the arm turning
      // 70 degrees between frames, the arm's length does unless a frame happened to fall at the top.
      let sTop = agree ? 0.025 : 0.04;
      if (fit && TUNE.release !== "arc") {
        const b0 = top.H[1] - top.S[1], g = b0 > 0.2 ? fit.A / b0 : 1;
        const pf: V3 = [top.S[0] + (fit.B ?? (top.H[0] - top.S[0]) * Math.min(1.6, g)), top.S[1] + fit.A, zf];
        const sf = Math.hypot(0.015, 0.14 * fit.A * Math.tan(Math.min(1.3, Math.abs(fit.th0))), 0.05 * (1 - Math.cos(Math.min(1.5, fit.om))));
        const sp = (agree ? 0.05 : 0.07) * reach;
        const w = TUNE.release === "fit" ? 1 : (sp * sp) / (sp * sp + sf * sf);
        p = [p[0] + w * (pf[0] - p[0]), p[1] + w * (pf[1] - p[1]), zf];
        sTop = TUNE.release === "fit" ? sf : Math.sqrt(1 / (1 / (sp * sp) + 1 / (sf * sf)));
        reach = Math.hypot(p[0] - top.S[0], p[1] - top.S[1]);
        const tf = f0 + tTop - (fit.om > 1e-6 ? (fit.th0 / fit.om) * fit.k : 0);
        topFrame = topFrame == null ? tf : topFrame + w * (tf - topFrame);
      }
      // When the hand was at the top. The heights either side of the top are not a mirror image (the arm comes up
      // to the release faster than it goes on after it), so fitting one even turn through both sides puts the top
      // late. Each side is timed on its own: a hand at height y over a shoulder it tops out A above is acos(y/A)
      // from the top; the frames before the top give the turn coming up, and that turn carried on reaches the top
      // at one moment; the frames after it, traced back at their own rate, give another. The two are averaged.
      if (arc && TUNE.timing !== "fit") {
        const A = p[1] - top.S[1], len = A / Math.max(0.5, u[1]);
        if (A > 0.3) {
          const W = Math.max(2, Math.ceil(0.07 * fps)), pre: Pt[] = [], post: Pt[] = [];
          for (let t = tTop - W; t <= tTop + W; t++) {
            const q = armAt(t);
            if (!q || t === tTop) continue;
            const before = t < tTop;
            let th = 0, ok = true;
            for (let it = 0; it < 3; it++) {
              const P = onPlaneZ(cam, q.px, zf - len * Math.sin(th));
              if (!P) { ok = false; break; }
              const c = (P[1] - q.S[1]) / A;
              if (c > 0.985 || c < -0.35) { ok = false; break; }   // too near the top to say how far from it, or far round where the arm has bent
              th = (before ? -1 : 1) * Math.acos(c);
            }
            if (ok) (before ? pre : post).push([t, th]);
          }
          const cross = (pts: Pt[], before: boolean): number | null => {
            // the frames nearest the top on this side (up to four), and the straight line through them
            const q = (before ? pts.slice(-4) : pts.slice(0, 4));
            if (q.length < 2) return null;
            let st = 0, sy = 0, stt = 0, sty = 0;
            for (const [t, y] of q) { st += t; sy += y; stt += t * t; sty += t * y; }
            const den = q.length * stt - st * st;
            if (Math.abs(den) < 1e-9) return null;
            const b = (q.length * sty - st * sy) / den, a = (sy - b * st) / q.length;
            if (!(b > 0.02)) return null;   // the arm must be turning forwards
            const t0 = -a / b;
            return t0 > tTop - 1.6 * Math.max(1, fps / 60) && t0 < tTop + 1.6 * Math.max(1, fps / 60) ? t0 : null;
          };
          const c1 = cross(pre, true), c2 = cross(post, false);
          const tt = c1 !== null && c2 !== null ? (c1 + c2) / 2 : c1 ?? c2;
          (globalThis as { __onpDbg4?: (x: unknown) => void }).__onpDbg4?.({ pre, post, c1, c2, tTop, f0, old: topFrame });
          if (tt !== null) topFrame = f0 + tt;
        }
      }
      // doubts: a joint's place in the picture, the plane the arm is put on (the hand over the foot; the foot itself)
      const near = onPlaneZ(cam, [top.px[0], top.px[1] + spx], zf), side = onPlaneZ(cam, [top.px[0] + spx, top.px[1]], zf);
      const pn = onPlaneZ(cam, top.px, zf + dSig), fz = frontAtBr ? onPlaneZ(cam, top.px, zf + frontAtBr.sz) : top.H;
      if (near && side && pn && fz) {
        const ky = Math.abs(near[1] - top.H[1]), kx = Math.abs(side[0] - top.H[0]);
        let sh2 = ky * ky + (pn[1] - top.H[1]) ** 2 + (fz[1] - top.H[1]) ** 2, sx2 = kx * kx + (pn[0] - top.H[0]) ** 2 + (fz[0] - top.H[0]) ** 2, timing = 0;
        if (arc) {
          // the arm's length (3 cm; 4 when there was nothing to check it against) and the line it is seen on
          // (read off the frames: 1.5 cm, and more the further the arm turns between frames, where a turn that is not
          // quite steady matters; from the arm's length: 2.5 cm, or 4 when there was nothing to check it against)
          const sL = sTop, sDir = (Math.SQRT2 * Math.max(kx, ky)) / Math.max(0.2, top.r);
          sh2 += (sL * u[1]) ** 2 + (reach * u[0] * sDir) ** 2 + ky * ky;
          sx2 += (sL * u[0]) ** 2 + (reach * u[1] * sDir) ** 2 + kx * kx;
        } else {
          // no arc to go by: the hand as the release frame caught it, and how far it moves in a frame either side
          const a = armAt(br - 1)?.H ?? null, b = armAt(br + 1)?.H ?? null;
          const drift = (i: number) => (a && b ? 0.6 * Math.abs(b[i] - a[i]) / 2 + 0.18 * Math.abs(b[i] - 2 * at.H[i] + a[i]) : a ? 0.6 * Math.abs(at.H[i] - a[i]) : b ? 0.6 * Math.abs(b[i] - at.H[i]) : 0);
          timing = Math.min(0.4, drift(1));
          sh2 += timing * timing; sx2 += Math.min(0.4, drift(0)) ** 2;
        }
        release = { p, wrist: at.W, footZ: zf, frame: br + f0, timing, arc, caught: at.H[1], arm: arc ? reach : null, topFrame,
          height: { value: p[1], sigma: Math.sqrt(sh2) }, across: { value: p[0], sigma: Math.sqrt(sx2) } };
      }
    }
  }

  // ---- the delivery stride ----
  let stride: Est | null = null, across: Est | null = null, alignDeg: Est | null = null;
  if (back && front) {
    const dx = front.heel[0] - back.heel[0], dz = back.heel[2] - front.heel[2], len = Math.hypot(dx, dz);
    const sx = Math.hypot(back.sx, front.sx), sz = Math.hypot(back.sz, front.sz);
    stride = { value: len, sigma: len > 0 ? Math.hypot((dx / len) * sx, (dz / len) * sz) : sz };
    across = { value: dx, sigma: sx };
    const a = Math.atan2(dx, dz), d2 = dx * dx + dz * dz || 1;
    alignDeg = { value: (a * 180) / Math.PI, sigma: (Math.hypot((dz / d2) * sx, (dx / d2) * sz) * 180) / Math.PI };
  }
  let popping: OnPitch["popping"] = null;
  if (front && front.from === "heel") {
    // Law 21.5.2: some part of the front foot, grounded or raised, must be behind the popping crease. The heel is the
    // part furthest back; the crease's back edge is 1.22 m in front of the stumps.
    const margin = front.heel[2] + POPPING, s = front.sz;
    popping = { margin: { value: margin, sigma: s }, verdict: margin > 1.5 * s ? "legal" : margin < -1.5 * s ? "no_ball" : "close" };
  }
  // Law 21.5.1: the back foot must land inside the return crease and not touch it (its inside edge is 1.32 m out)
  const returnGap: Est | null = back ? { value: RETURN_X - Math.abs(back.heel[0]) - 0.05, sigma: back.sx } : null;

  const runup: Est | null = line && line.b < 0 ? { value: -line.b * fps * 3.6, sigma: (line.rms / Math.max(0.2, Math.min(0.8, runEnd / fps))) * 3.6 * 1.5 } : null;

  // ---- after the release: feet on the ground, and the protected area ----
  const steps: Foot[] = [];
  let danger: Foot | null = null;
  {
    // a foot is on the ground where its ground point stops moving: under 12 cm between frames a twentieth of a second apart
    const gap = Math.max(1, Math.round(0.05 * fps));
    for (const i of [0, 1]) {
      let run: Foot[] = [];
      const flush = () => {
        if (run.length >= 2) {
          const f = run[run.length >> 1];
          if (!steps.some((s) => Math.hypot(s.heel[0] - f.heel[0], s.heel[2] - f.heel[2]) < 0.25)) steps.push(f);
        }
        run = [];
      };
      for (let t = br + gap; t < T; t += gap) {
        const a = footAt(t, i), b = footAt(Math.max(0, t - gap), i);
        if (a && b && a.from === "heel" && Math.hypot(a.heel[0] - b.heel[0], a.heel[2] - b.heel[2]) < 0.12) run.push(a); else flush();
      }
      flush();
    }
    steps.sort((p, q) => p.frame - q.frame);
    danger = steps.find((s) => s.heel[2] < PROTECTED_Z + s.sz && Math.abs(s.heel[0]) < PROTECTED_X - s.sx) ?? null;
  }
  void [L_HIP, R_HIP, frontAn, backAn];
  return { still, side, frontSeen, back, front, release, stride, across, alignDeg, popping, returnGap, stature, runup, steps, danger, body, depth };
}

/**
 * The same, with the doubt in the camera itself carried into every figure. The camera comes from marks placed by eye
 * or by a line finder, each good to a pixel or so; the marks are nudged by that much a dozen ways, the camera worked
 * out again each time, and how far each figure moves is added to its own doubt. A pitch marked only along the ground
 * through a wide lens pins heights down less well than one with a stump top marked, and this is where that shows.
 */
export function measureWithDoubt(r: AnalysisResult, marks: Mark[], w: number, h: number, markFrame: number, shifts?: FrameShifts | null, tapPx = 1.2, trials = 12):
  { cam: Camera; o: OnPitch } | null {
  const pts = marks.map((m) => ({ world: worldOf(m), px: m.px }));
  const cam = solveCameraPoints(pts, w, h);
  if (!isCamera(cam)) return null;
  const o = measureOnPitch(r, cam, markFrame, shifts);
  if (!o) return null;
  let seed = 20261118;
  const gauss = () => { let s = 0; for (let i = 0; i < 4; i++) { seed = (seed * 16807) % 2147483647; s += seed / 2147483647 - 0.5; } return s * Math.sqrt(3); };   // about unit spread
  const k = tapPx * Math.max(1, w / 1280);
  const alt: OnPitch[] = [];
  for (let t = 0; t < trials; t++) {
    const c = solveCameraPoints(pts.map((p) => ({ world: p.world, px: [p.px[0] + k * gauss(), p.px[1] + k * gauss()] as Pt })), w, h, cam);
    const a = isCamera(c) ? measureOnPitch(r, c, markFrame, shifts) : null;
    if (a) alt.push(a);
  }
  if (alt.length < trials / 2) return { cam, o };
  const sd = (get: (x: OnPitch) => number | null | undefined, base: number) => {
    const v = alt.map(get).filter((x): x is number => typeof x === "number");
    return v.length ? Math.sqrt(v.reduce((s, x) => s + (x - base) ** 2, 0) / v.length) : 0;
  };
  const widen = (e: Est | null, get: (x: OnPitch) => number | null | undefined) => { if (e) e.sigma = Math.hypot(e.sigma, sd(get, e.value)); };
  if (o.release) { widen(o.release.height, (x) => x.release?.height.value); widen(o.release.across, (x) => x.release?.across.value); }
  widen(o.stride, (x) => x.stride?.value); widen(o.across, (x) => x.across?.value); widen(o.alignDeg, (x) => x.alignDeg?.value);
  widen(o.stature, (x) => x.stature?.value); widen(o.runup, (x) => x.runup?.value); widen(o.returnGap, (x) => x.returnGap?.value);
  if (o.popping) {
    widen(o.popping.margin, (x) => x.popping?.margin.value);
    const m = o.popping.margin;
    o.popping.verdict = m.value > 1.5 * m.sigma ? "legal" : m.value < -1.5 * m.sigma ? "no_ball" : "close";
  }
  for (const key of ["front", "back"] as const) {
    const f = o[key];
    if (f) { f.sx = Math.hypot(f.sx, sd((x) => x[key]?.heel[0], f.heel[0])); f.sz = Math.hypot(f.sz, sd((x) => x[key]?.heel[2], f.heel[2])); }
  }
  return { cam, o };
}

/** What is kept with an analysis: the pitch marks (enough to rebuild the camera and every figure) and the headline
 * figures as [value, doubt], for lists and for setting one ball beside another. Metres; the run-up in km/h. */
export interface OnPitchRecord {
  v: 1; w: number; h: number; markFrame: number; marks: Mark[];
  auto?: "creases" | "near creases" | "stumps+creases" | "stumps" | null;   // found by the app itself (lib/autocam.ts), and from what
  far?: Mark[] | null;                                      // the batter's wicket, when found: for following the ball to that end
  tapPx?: number | null;                                    // how exactly the marks are placed, pixels (default 1.2)
  release: [number, number, number] | null;                 // where the ball left the hand: x, y, z
  releaseSigma: [number, number] | null;                    // across, height
  front: [number, number] | null; back: [number, number] | null;   // heels: x, z
  stride: [number, number] | null; stature: [number, number] | null; popping: [number, number] | null; runup: [number, number] | null;
}
const r3 = (v: number) => Math.round(v * 1000) / 1000;
export function recordOnPitch(o: OnPitch, cam: Camera, markFrame: number, marks: Mark[], how?: Pick<OnPitchRecord, "auto" | "tapPx" | "far">): OnPitchRecord {
  const est = (e: Est | null): [number, number] | null => (e ? [r3(e.value), r3(e.sigma)] : null);
  return { v: 1, w: cam.w, h: cam.h, markFrame, marks, auto: how?.auto ?? null, tapPx: how?.tapPx ?? null, far: how?.far ?? null,
    release: o.release ? [r3(o.release.p[0]), r3(o.release.p[1]), r3(o.release.p[2])] : null,
    releaseSigma: o.release ? [r3(o.release.across.sigma), r3(o.release.height.sigma)] : null,
    front: o.front ? [r3(o.front.heel[0]), r3(o.front.heel[2])] : null, back: o.back ? [r3(o.back.heel[0]), r3(o.back.heel[2])] : null,
    stride: est(o.stride), stature: est(o.stature), popping: o.popping ? est(o.popping.margin) : null, runup: est(o.runup) };
}
/** A kept record with the right shape and finite numbers, or nothing (from the page or a restored file). */
export function cleanOnPitch(x: unknown): OnPitchRecord | null {
  const r = x as OnPitchRecord | null;
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  const arr = (v: unknown, n: number) => (Array.isArray(v) && v.length === n && v.every(num) ? (v as number[]) : null);
  if (!r || r.v !== 1 || !(r.w > 0) || !(r.h > 0) || !Number.isInteger(r.markFrame)) return null;
  if (!Array.isArray(r.marks) || r.marks.length < 4 || r.marks.length > 40 || !r.marks.every((m) => (m.end === "bowler" || m.end === "batter") && typeof m.kind === "string" && !!arr(m.px, 2))) return null;
  return { v: 1, w: r.w, h: r.h, markFrame: r.markFrame, marks: r.marks.map((m) => ({ end: m.end, kind: m.kind, px: [m.px[0], m.px[1]] })),
    auto: r.auto === "creases" || r.auto === "near creases" || r.auto === "stumps+creases" || r.auto === "stumps" ? r.auto : null,
    far: Array.isArray(r.far) && r.far.length <= 8 && r.far.every((m) => m.end === "batter" && typeof m.kind === "string" && !!arr(m.px, 2)) ? r.far.map((m) => ({ end: m.end, kind: m.kind, px: [m.px[0], m.px[1]] as Pt })) : null, tapPx: num(r.tapPx) && (r.tapPx as number) > 0 && (r.tapPx as number) < 50 ? r.tapPx : null,
    release: arr(r.release, 3) as [number, number, number] | null, releaseSigma: arr(r.releaseSigma, 2) as [number, number] | null,
    front: arr(r.front, 2) as [number, number] | null, back: arr(r.back, 2) as [number, number] | null, stride: arr(r.stride, 2) as [number, number] | null,
    stature: arr(r.stature, 2) as [number, number] | null, popping: arr(r.popping, 2) as [number, number] | null, runup: arr(r.runup, 2) as [number, number] | null };
}
