/**
 * The camera, worked out from the pitch itself. A cricket pitch is a ruler: the creases and the stumps are painted and
 * planted at distances the Laws fix to the millimetre. Mark a few of them on one frame and the camera's position, its
 * direction and its zoom follow, and from then on every pixel is a known line of sight through the ground.
 *
 * Scene axes (as lib/flight.ts): y up, the pitch along z, the bowler's stumps at z = 0 and the batter's at z = -20.12.
 * Seen from behind the bowler, +x is to the right.
 *
 * Law 7: the bowling crease runs through the centres of the stumps; the popping crease is 1.22 m in front of it; the
 * return creases are 1.32 m either side of the middle stump. Law 8: the stumps are 71.1 cm tall and the wicket 22.86 cm
 * wide.
 *
 * The camera is a pinhole with square pixels and its centre in the middle of the picture: seven unknowns (zoom, three
 * of direction, three of position). Each mark gives two equations, so four marks are the least and more are better.
 */
import { levenbergMarquardt } from "./lm";
import type { V3 } from "./biomech";

export type Pt = [number, number];
export const PITCH_LEN = 20.12, POPPING = 1.22, RETURN_X = 1.32, STUMP_TOP = 0.711, STUMP_X = 0.1143, LINE_HALF = 0.02;

export type End = "bowler" | "batter";
export type MarkKind = "pop_l" | "pop_r" | "bowl_l" | "bowl_r" | "stump_base" | "stump_top" | "off_base" | "off_top" | "leg_base" | "leg_top";
export interface MarkId { end: End; kind: MarkKind }
export interface Mark extends MarkId { px: Pt }

/**
 * Where a landmark is on the ground. "l" and "r" are -x and +x (left and right as seen from behind the bowler); the
 * two outer stumps are named the same way ("off" is -x, "leg" is +x: a right-hander's off and leg).
 */
export function worldOf(m: MarkId): V3 {
  // Crease corners are marked at the middle of the painted lines. The Laws' distances are to a line's edge (the
  // inside edge of a return crease, the back edge of the popping and bowling creases), so the middle is half a line
  // further on: lines are about 4 cm wide.
  const z0 = m.end === "bowler" ? 0 : -PITCH_LEN, to = m.end === "bowler" ? -1 : 1, X = RETURN_X + LINE_HALF;
  switch (m.kind) {
    case "pop_l": return [-X, 0, z0 + to * (POPPING + LINE_HALF)];
    case "pop_r": return [X, 0, z0 + to * (POPPING + LINE_HALF)];
    case "bowl_l": return [-X, 0, z0 + to * LINE_HALF];
    case "bowl_r": return [X, 0, z0 + to * LINE_HALF];
    case "stump_base": return [0, 0, z0];
    case "stump_top": return [0, STUMP_TOP, z0];
    case "off_base": return [-STUMP_X, 0, z0];
    case "off_top": return [-STUMP_X, STUMP_TOP, z0];
    case "leg_base": return [STUMP_X, 0, z0];
    case "leg_top": return [STUMP_X, STUMP_TOP, z0];
  }
}

export interface Camera {
  w: number; h: number;      // picture size the marks were made on
  f: number;                 // focal length in pixels
  R: number[];               // 3x3 row-major, world to camera (camera: x right, y down, z forward)
  t: V3;
  pos: V3;                   // where the camera is, in scene metres
  rms: number;               // how far the marks sit from where this camera puts them, pixels (root mean square)
  worst: number;             // the worst single mark, pixels
  marks: number;
}

function rodrigues(r: number[]): number[] {
  const th = Math.hypot(r[0], r[1], r[2]);
  if (th < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const x = r[0] / th, y = r[1] / th, z = r[2] / th, c = Math.cos(th), s = Math.sin(th), C = 1 - c;
  return [c + x * x * C, x * y * C - z * s, x * z * C + y * s,
    y * x * C + z * s, c + y * y * C, y * z * C - x * s,
    z * x * C - y * s, z * y * C + x * s, c + z * z * C];
}
function rotVec(R: number[]): number[] {
  const tr = R[0] + R[4] + R[8], c = Math.max(-1, Math.min(1, (tr - 1) / 2)), th = Math.acos(c);
  if (th < 1e-9) return [0, 0, 0];
  if (Math.PI - th < 1e-6) {
    // half-turn: the axis is the largest column of (R + I) / 2
    const xx = Math.sqrt(Math.max(0, (R[0] + 1) / 2)), yy = Math.sqrt(Math.max(0, (R[4] + 1) / 2)), zz = Math.sqrt(Math.max(0, (R[8] + 1) / 2));
    const ax = xx >= yy && xx >= zz ? [xx, (R[1] + R[3]) / (4 * xx), (R[2] + R[6]) / (4 * xx)]
      : yy >= zz ? [(R[1] + R[3]) / (4 * yy), yy, (R[5] + R[7]) / (4 * yy)] : [(R[2] + R[6]) / (4 * zz), (R[5] + R[7]) / (4 * zz), zz];
    return ax.map((v) => v * th);
  }
  const k = th / (2 * Math.sin(th));
  return [(R[7] - R[5]) * k, (R[2] - R[6]) * k, (R[3] - R[1]) * k];
}

/** A camera at `pos` looking at `at`, level (no roll). */
function lookAt(pos: V3, at: V3): number[] {
  const fz = [at[0] - pos[0], at[1] - pos[1], at[2] - pos[2]], n = Math.hypot(fz[0], fz[1], fz[2]);
  const zc = fz.map((v) => v / n);
  // camera x = forward x world-up... chosen so that x is to the right and y down
  let xc = [zc[1] * 0 - zc[2] * 1, zc[2] * 0 - zc[0] * 0, zc[0] * 1 - zc[1] * 0];   // zc x up(0,1,0)
  const nx = Math.hypot(xc[0], xc[1], xc[2]) || 1;
  xc = xc.map((v) => v / nx);
  const yc = [zc[1] * xc[2] - zc[2] * xc[1], zc[2] * xc[0] - zc[0] * xc[2], zc[0] * xc[1] - zc[1] * xc[0]];   // zc x xc: down
  return [...xc, ...yc, ...zc];
}

/** Scene point to pixel. Null when the point is behind the camera. */
export function project(c: Pick<Camera, "f" | "R" | "t" | "w" | "h">, p: V3): Pt | null {
  const R = c.R, X = R[0] * p[0] + R[1] * p[1] + R[2] * p[2] + c.t[0], Y = R[3] * p[0] + R[4] * p[1] + R[5] * p[2] + c.t[1],
    Z = R[6] * p[0] + R[7] * p[1] + R[8] * p[2] + c.t[2];
  if (Z <= 1e-6) return null;
  return [c.w / 2 + (c.f * X) / Z, c.h / 2 + (c.f * Y) / Z];
}

/** The line of sight through a pixel: the camera position and a unit direction in scene axes. */
export function ray(c: Camera, px: Pt): { o: V3; d: V3 } {
  const x = (px[0] - c.w / 2) / c.f, y = (px[1] - c.h / 2) / c.f, R = c.R;
  const d: V3 = [R[0] * x + R[3] * y + R[6], R[1] * x + R[4] * y + R[7], R[2] * x + R[5] * y + R[8]];
  const n = Math.hypot(d[0], d[1], d[2]);
  return { o: c.pos, d: [d[0] / n, d[1] / n, d[2] / n] };
}

/** Where the line of sight through a pixel meets the level plane at height y. Null when it never does. */
export function onPlaneY(c: Camera, px: Pt, y = 0): V3 | null {
  const { o, d } = ray(c, px);
  if (Math.abs(d[1]) < 1e-9) return null;
  const s = (y - o[1]) / d[1];
  return s > 0 ? [o[0] + d[0] * s, y, o[2] + d[2] * s] : null;
}
/** Where the line of sight through a pixel meets the upright plane across the pitch at z. */
export function onPlaneZ(c: Camera, px: Pt, z: number): V3 | null {
  const { o, d } = ray(c, px);
  if (Math.abs(d[2]) < 1e-9) return null;
  const s = (z - o[2]) / d[2];
  return s > 0 ? [o[0] + d[0] * s, o[1] + d[1] * s, z] : null;
}

const fromParams = (q: number[], w: number, h: number) => {
  const R = rodrigues([q[1], q[2], q[3]]);
  return { f: Math.exp(q[0]), R, t: [q[4], q[5], q[6]] as V3, w, h };
};

export interface CameraProblem { reason: "few" | "spread" | "fit"; text: string }

/**
 * Fit the camera to the marks. Tries many starting cameras (behind either end, low and high, near and far, wide and
 * long lenses) and keeps the best: a pitch seen through a long lens fits almost as well from a range of distances,
 * and that is fine, because all of those cameras agree about where things are on and above the pitch.
 */
export function solveCamera(marks: Mark[], w: number, h: number): Camera | CameraProblem {
  return solveCameraPoints(marks.map((m) => ({ world: worldOf(m), px: m.px })), w, h);
}
/** The same from any points whose place on the ground is known. */
export function solveCameraPoints(marks: { world: V3; px: Pt }[], w: number, h: number, start?: Camera): Camera | CameraProblem {
  if (marks.length < 4) return { reason: "few", text: "Mark at least four points." };
  const world = marks.map((m) => m.world);
  const zs = world.map((p) => p[2]);
  const xs = world.map((p) => p[0]), spanX = Math.max(...xs) - Math.min(...xs);
  if (Math.max(...zs) - Math.min(...zs) < 10) return { reason: "spread", text: "Mark points at both ends of the pitch: one end alone cannot give the distance between them." };
  if (spanX < 0.2) return { reason: "spread", text: "Mark points on both sides of the pitch as well as both ends." };
  const cu = marks.reduce((s, m) => s + m.px[0], 0) / marks.length, cv = marks.reduce((s, m) => s + m.px[1], 0) / marks.length;
  const spreadPx = Math.sqrt(marks.reduce((s, m) => s + (m.px[0] - cu) ** 2 + (m.px[1] - cv) ** 2, 0) / marks.length);
  const cw: V3 = [0, 0, 0];
  for (const p of world) { cw[0] += p[0] / world.length; cw[1] += p[1] / world.length; cw[2] += p[2] / world.length; }
  const resid = (q: number[]) => {
    const c = fromParams(q, w, h), out: number[] = [];
    for (let i = 0; i < marks.length; i++) {
      const p = project(c, world[i]);
      if (!p) { out.push(1e4, 1e4); continue; }
      out.push(p[0] - marks[i].px[0], p[1] - marks[i].px[1]);
    }
    return out;
  };
  let best: { q: number[]; cost: number } | null = null;
  const steps = [1e-4, 1e-5, 1e-5, 1e-5, 1e-3, 1e-3, 1e-3];
  if (start) {
    const fit = levenbergMarquardt(resid, [Math.log(start.f), ...rotVec(start.R), ...start.t], steps, 60);
    best = { q: fit.x, cost: fit.cost };
  } else for (const side of [1, -1]) for (const dist of [4, 9, 18, 35, 70, 120]) for (const height of [1.2, 3, 7, 14, 28]) for (const off of [0, -4, 4]) {
    if (height > dist * 1.2) continue;
    const pos: V3 = [off, height, side > 0 ? dist : -PITCH_LEN - dist];
    const R = lookAt(pos, cw);
    const t: V3 = [-(R[0] * pos[0] + R[1] * pos[1] + R[2] * pos[2]), -(R[3] * pos[0] + R[4] * pos[1] + R[5] * pos[2]), -(R[6] * pos[0] + R[7] * pos[1] + R[8] * pos[2])];
    // zoom so that the marks spread as widely as they do in the picture
    const unit = { f: 1, R, t, w: 0, h: 0 };
    const pr = world.map((p) => project(unit, p));
    if (pr.some((p) => !p)) continue;
    const mu = pr.reduce((s, p) => s + p![0], 0) / pr.length, mv = pr.reduce((s, p) => s + p![1], 0) / pr.length;
    const sp = Math.sqrt(pr.reduce((s, p) => s + (p![0] - mu) ** 2 + (p![1] - mv) ** 2, 0) / pr.length);
    if (!(sp > 0)) continue;
    const q0 = [Math.log(spreadPx / sp), ...rotVec(R), ...t];
    const fit = levenbergMarquardt(resid, q0, steps, 80);
    if (!best || fit.cost < best.cost) best = { q: fit.x, cost: fit.cost };
    if (best.cost / marks.length < 1e-6) break;
  }
  if (!best) return { reason: "fit", text: "Those marks do not fit a camera. Check each one is on the right corner." };
  const c = fromParams(best.q, w, h), R = c.R;
  const pos: V3 = [-(R[0] * c.t[0] + R[3] * c.t[1] + R[6] * c.t[2]), -(R[1] * c.t[0] + R[4] * c.t[1] + R[7] * c.t[2]), -(R[2] * c.t[0] + R[5] * c.t[1] + R[8] * c.t[2])];
  const r = resid(best.q);
  let worst = 0;
  for (let i = 0; i < marks.length; i++) worst = Math.max(worst, Math.hypot(r[2 * i], r[2 * i + 1]));
  const cam: Camera = { ...c, pos, rms: Math.sqrt(best.cost / marks.length), worst, marks: marks.length };
  if (!(pos[1] > 0.05) || !Number.isFinite(cam.rms)) return { reason: "fit", text: "Those marks put the camera under the ground. Check each one is on the right corner." };
  return cam;
}

export const isCamera = (c: Camera | CameraProblem | null | undefined): c is Camera => !!c && "f" in c;

/** How steeply the camera looks down at the middle of the pitch, degrees. */
export function lookDown(c: Camera): number {
  const d = [0 - c.pos[0], 0 - c.pos[1], -PITCH_LEN / 2 - c.pos[2]];
  return (Math.atan2(-d[1], Math.hypot(d[0], d[2])) * 180) / Math.PI;
}
/** Which end the camera is behind. */
export const cameraEnd = (c: Camera): End => (c.pos[2] > -PITCH_LEN / 2 ? "bowler" : "batter");

/** What the camera saw of a known place: a point, or (with `n`, a unit normal in the picture) a point on a line across `n`. */
export interface Sight { world: V3; px: Pt; n?: Pt }
/**
 * Polish a camera against sightings, some of which are only known to lie on a line in the picture (a point somewhere
 * along a painted crease says where the crease is across its width, not where along it). Far-off sightings are held
 * back (their pull levels off beyond `clip` pixels) so that one bad one cannot drag the camera.
 */
export function refineCamera(start: Camera, sights: Sight[], clip = 3): Camera | null {
  if (sights.length < 6) return null;
  const { w, h } = start;
  const soft = (r: number) => { const a = Math.abs(r) / clip; return a <= 1 ? r : Math.sign(r) * clip * Math.sqrt(2 * a - 1); };
  const resid = (q: number[]) => {
    const c = fromParams(q, w, h), out: number[] = [];
    for (const s of sights) {
      const p = project(c, s.world);
      if (!p) { if (s.n) out.push(1e3); else out.push(1e3, 1e3); continue; }
      const dx = p[0] - s.px[0], dy = p[1] - s.px[1];
      if (s.n) out.push(soft(dx * s.n[0] + dy * s.n[1])); else out.push(soft(dx), soft(dy));
    }
    return out;
  };
  const fit = levenbergMarquardt(resid, [Math.log(start.f), ...rotVec(start.R), ...start.t], [1e-4, 1e-5, 1e-5, 1e-5, 1e-3, 1e-3, 1e-3], 60);
  const c = fromParams(fit.x, w, h), R = c.R;
  const pos: V3 = [-(R[0] * c.t[0] + R[3] * c.t[1] + R[6] * c.t[2]), -(R[1] * c.t[0] + R[4] * c.t[1] + R[7] * c.t[2]), -(R[2] * c.t[0] + R[5] * c.t[1] + R[8] * c.t[2])];
  const r = resid(fit.x);
  const rms = Math.sqrt(r.reduce((s, v) => s + v * v, 0) / r.length);
  if (!(pos[1] > 0.05) || !Number.isFinite(rms)) return null;
  return { ...c, pos, rms, worst: Math.max(...r.map(Math.abs)), marks: sights.length };
}
