import type { AnalysisResult } from "../types";

/**
 * Front-foot no-ball check (Law 21.5.2: some part of the front foot, grounded or raised, must land behind the popping
 * crease, which is the back edge of the crease marking).
 *
 * The user marks that edge with two points on the landing frame of a side-on clip. The back of the heel is placed from
 * the front ankle keypoint with body proportions: the ankle sits 3.9% of stature above the ground (Drillis & Contini),
 * the back of a shoe's heel about 3% of stature behind it. Its distance to the line is measured along the direction of
 * travel and turned into centimetres with the bowler's own leg length on the same frame. A band covers the heel
 * estimate, keypoint and marking errors: inside it the check says it is too close to call.
 *
 * Image geometry is exact for points on the ground (a ground line divides the ground in the picture just as on the
 * field), so the camera may sit a little off square; it must see along the crease, not down the pitch.
 */
export type Pt = [number, number];
export interface CreaseLine { a: Pt; b: Pt }
export type CreaseVerdict = "legal" | "no_ball" | "close";
export interface CreaseCall {
  frame: number;
  ankle: Pt;           // front ankle keypoint (display px)
  heel: Pt;            // estimated back of the heel, on the ground
  toe: Pt;             // estimated toe, on the ground (drawn, not judged)
  dir: Pt;             // direction of travel in the picture (unit)
  pxPerM: number;      // pixels per metre at the bowler
  behindCm: number;    // + heel behind the line (legal side), - beyond it
  bandCm: number;      // too close to call within ±bandCm
  verdict: CreaseVerdict;
}

export const ANKLE_HEIGHT = 0.039, HEEL_BACK = 0.03, TOE_AHEAD = 0.115;   // fractions of stature
const LEG = 0.491;   // hip joint to ankle (thigh + shank), fraction of stature

const mid = (p: Pt, q: Pt): Pt => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
const dist = (p: Pt, q: Pt) => Math.hypot(p[0] - q[0], p[1] - q[1]);

/** Direction of travel along the picture's horizontal: from the hips before landing to the hips at release. */
export function travel(result: AnalysisResult): Pt | null {
  const kp = result.keypoints2d.xy, kc = result.keypoints2d.conf, f0 = result.frames.start;
  const at = (f: number) => {
    const t = Math.max(0, Math.min(kp.length - 1, f - f0));
    return Math.min(kc[t][11], kc[t][12]) > 0.2 ? mid(kp[t][11] as Pt, kp[t][12] as Pt) : null;
  };
  const ffc = result.events.ffc?.frame, br = result.events.br?.frame;
  if (ffc == null || br == null) return null;
  const a = at(result.events.bfc?.frame ?? ffc - Math.round(0.2 * result.fps)), b = at(br);
  if (!a || !b) return null;
  const dx = b[0] - a[0];
  // the hips cover most of a stride between these frames: under ~2% of the frame width the direction is unclear
  if (Math.abs(dx) < 0.02 * result.video.width * result.display_scale) return null;
  return [Math.sign(dx), 0];
}

/** The bowler's stature in pixels at frame f: the longest leg projection nearby (least foreshortened) / 0.491. */
export function staturePx(result: AnalysisResult, f: number): number | null {
  const kp = result.keypoints2d.xy, kc = result.keypoints2d.conf, f0 = result.frames.start;
  const t0 = f - f0;
  let best = 0;
  for (const [h, k, a] of [[11, 13, 15], [12, 14, 16]]) {
    for (let t = Math.max(0, t0 - 3); t <= Math.min(kp.length - 1, t0 + 3); t++) {
      if (Math.min(kc[t][h], kc[t][k], kc[t][a]) < 0.3) continue;
      best = Math.max(best, dist(kp[t][h] as Pt, kp[t][k] as Pt) + dist(kp[t][k] as Pt, kp[t][a] as Pt));
    }
  }
  return best > 0 ? best / LEG : null;
}

/** The front foot at frame f: the ankle further along the direction of travel (robust to left/right label swaps). */
export function frontAnkle(result: AnalysisResult, f: number, dir: Pt): Pt | null {
  const kp = result.keypoints2d.xy, kc = result.keypoints2d.conf;
  const t = f - result.frames.start;
  if (t < 0 || t >= kp.length) return null;
  const cands = [15, 16].filter((j) => kc[t][j] > 0.2).map((j) => kp[t][j] as Pt);
  if (!cands.length) return null;
  return cands.reduce((p, q) => (q[0] * dir[0] + q[1] * dir[1] > p[0] * dir[0] + p[1] * dir[1] ? q : p));
}

/** Where a ray from p along dir meets the line through a and b: the distance along dir (px), or null if parallel. */
export function alongTo(p: Pt, dir: Pt, line: CreaseLine): number | null {
  const ex = line.b[0] - line.a[0], ey = line.b[1] - line.a[1];
  const den = dir[0] * ey - dir[1] * ex;
  if (Math.abs(den) < 1e-9 * (Math.abs(ex) + Math.abs(ey) + 1)) return null;
  return ((line.a[0] - p[0]) * ey - (line.a[1] - p[1]) * ex) / den;
}

/** The line must cross the direction of travel steeply enough to measure along it (a crease seen side-on does). */
export const lineUsable = (line: CreaseLine, dir: Pt) => {
  const ex = line.b[0] - line.a[0], ey = line.b[1] - line.a[1], len = Math.hypot(ex, ey);
  if (len < 8) return false;
  const sin = Math.abs(dir[0] * ey - dir[1] * ex) / len;   // 1 = square to the travel, 0 = along it
  return sin > 0.42;   // steeper than ~25°
};

export function creaseCall(result: AnalysisResult, frame: number, line: CreaseLine, statureM = result.skeleton.stature_m): CreaseCall | null {
  const dir = travel(result);
  if (!dir || !lineUsable(line, dir)) return null;
  const ankle = frontAnkle(result, frame, dir);
  const H = staturePx(result, frame);
  if (!ankle || !H) return null;
  const ground: Pt = [ankle[0], ankle[1] + ANKLE_HEIGHT * H];
  const heel: Pt = [ground[0] - dir[0] * HEEL_BACK * H, ground[1] - dir[1] * HEEL_BACK * H];
  const toe: Pt = [ground[0] + dir[0] * (TOE_AHEAD - HEEL_BACK) * H, ground[1] + dir[1] * (TOE_AHEAD - HEEL_BACK) * H];
  const t = alongTo(heel, dir, line);
  if (t === null) return null;
  const pxPerM = H / Math.max(1, statureM);
  // uncertainties (1 sd): heel placement 0.8% of stature (shoe and foot size), the ankle keypoint 1.2% of stature or
  // 3 px, the marked line 3 px; the band is two of them combined
  const sd = Math.hypot(0.008 * H, Math.max(0.012 * H, 3), 3);
  const behindCm = (100 * t) / pxPerM, bandCm = (100 * 2 * sd) / pxPerM;
  const verdict: CreaseVerdict = behindCm > bandCm ? "legal" : behindCm < -bandCm ? "no_ball" : "close";
  return { frame, ankle, heel, toe, dir, pxPerM, behindCm, bandCm, verdict };
}

export const VERDICT_TEXT: Record<CreaseVerdict, string> = { legal: "Legal", no_ball: "No-ball", close: "Too close to call" };
