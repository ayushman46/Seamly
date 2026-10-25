/**
 * Run-up speed at back-foot contact: how fast the bowler's pelvis travels towards the batter over the last quarter of a
 * second before the back foot lands. Measured on the video side-on (the run-up crosses the frame), with any camera
 * movement taken out, and scaled to metres by the bowler's own legs (the fitted thigh and shank lengths). Run-up speed
 * is the technique variable most strongly related to ball speed in fast bowlers (r = 0.50 across 18 studies).
 */
import type { AnalysisResult } from "../types";

export interface Runup {
  ms: number;          // metres per second
  kmh: number;
  estimated: boolean;  // back-foot contact was placed from typical timing, not seen
}

type Motion = number[][];   // 2 × 3: maps frame t-1 pixels to frame t pixels

/**
 * Pixel position in frame t mapped into frame `ref`'s pixels, undoing the camera's movement in between. The motions
 * are in source pixels and the keypoints in display pixels (source × ds), so the translations are scaled by ds.
 */
function stabiliser(motions: Motion[] | null, n: number, ref: number, ds: number): (p: number[], t: number) => [number, number] {
  if (!motions || motions.length < n) return (p) => [p[0], p[1]];
  // cumulative affine maps frame 0 -> frame t, as 3 × 3
  const H: number[][][] = [[[1, 0, 0], [0, 1, 0], [0, 0, 1]]];
  const mul = (a: number[][], b: number[][]) => a.map((r) => [0, 1, 2].map((j) => r[0] * b[0][j] + r[1] * b[1][j] + r[2] * b[2][j]));
  for (let t = 1; t < n; t++) {
    const [r0, r1] = motions[t];
    H.push(mul([[r0[0], r0[1], r0[2] * ds], [r1[0], r1[1], r1[2] * ds], [0, 0, 1]], H[t - 1]));
  }
  const inv = (m: number[][]) => {   // inverse of an affine 3 × 3
    const [a, b, c] = m[0], [d, e, f] = m[1], det = a * e - b * d || 1e-9;
    return [[e / det, -b / det, (b * f - c * e) / det], [-d / det, a / det, (c * d - a * f) / det], [0, 0, 1]];
  };
  return (p, t) => {
    const G = mul(H[ref], inv(H[t]));
    return [G[0][0] * p[0] + G[0][1] * p[1] + G[0][2], G[1][0] * p[0] + G[1][1] * p[1] + G[1][2]];
  };
}

/** Run-up speed at back-foot contact, or null when this clip can't give it (not side-on, too short, implausible). */
export function runupSpeed(r: AnalysisResult, motions: Motion[] | null): Runup | null {
  const bfc = r.events.bfc;
  if (!bfc || r.view.view !== "side_on" || r.view.oblique) return null;
  const f0 = r.frames.start, n = r.frames.end - f0, tb = bfc.frame - f0;
  if (tb < 2 || tb >= n) return null;
  const slow = Math.max(1, r.options.slowmo_factor || 1);
  const time = (t: number) => r.frames.times[t] / slow;
  const ts: number[] = [];
  for (let t = tb; t >= 0 && time(tb) - time(t) <= 0.25 + 1e-6; t--) ts.unshift(t);
  if (ts.length < 3) return null;
  const { xy, conf } = r.keypoints2d;
  const stab = stabiliser(motions, n, tb, r.display_scale || 1);
  const xs: number[] = [], tt: number[] = [], legs: number[] = [];
  const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  for (const t of ts) {
    const k = xy[t], c = conf[t];
    if (Math.min(c[11], c[12]) < 0.3) continue;
    // a bowler entering or leaving the picture is only partly tracked: those frames would give a wrong speed
    const W = r.video.width * r.display_scale, px = (k[11][0] + k[12][0]) / 2;
    if (px < 0.05 * W || px > 0.95 * W) continue;
    xs.push(stab([(k[11][0] + k[12][0]) / 2, (k[11][1] + k[12][1]) / 2], t)[0]);
    tt.push(time(t));
    for (const [h, kn, an] of [[11, 13, 15], [12, 14, 16]]) {
      if (Math.min(c[h], c[kn], c[an]) > 0.3) legs.push(dist(k[h], k[kn]) + dist(k[kn], k[an]));
    }
  }
  if (xs.length < 3 || !legs.length) return null;
  // the straightest leg in the window is the least foreshortened: its length in pixels against the fitted one
  const legM = r.skeleton.bone_lengths_m[1] + r.skeleton.bone_lengths_m[2];
  const pxPerM = Math.max(...legs) / legM;
  // least-squares slope of the pelvis' horizontal position against real time
  const mt = tt.reduce((a, b) => a + b, 0) / tt.length, mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  let num = 0, den = 0;
  tt.forEach((t, i) => { num += (t - mt) * (xs[i] - mx); den += (t - mt) ** 2; });
  if (den <= 0) return null;
  const ms = Math.abs(num / den) / pxPerM;
  if (!(ms >= 1.5 && ms <= 10)) return null;   // walking pace or faster than any bowler: a tracking problem
  return { ms, kmh: ms * 3.6, estimated: bfc.method === "timing_prior" || bfc.method === "constrained" };
}
