/**
 * The flight of a cricket ball, from where this bowler lets it go to the batter: gravity, air drag, swing as a side
 * force, and a bounce off the pitch. Used by the "Face it" view (components/FaceIt.tsx) to show a delivery from the
 * batter's eye, and to work out what a release point is worth: how steep the ball has to leave the hand for each
 * length, how much time the batter gets, and how high it arrives.
 *
 * What is measured and what is physics: the release point comes from the clip (its height is measured against the
 * bowler's own height), and the pace is the clip's measured pace when there is one. Everything after the hand is
 * simulated; the line, the length and the swing are chosen by the viewer.
 *
 * Scene axes (as lib/biomech.ts): y up, the pitch along z with the bowler's stumps at z = 0 and the batter's at
 * z = -20.12, x across the pitch.
 *
 * Numbers: a ball is 156 g and 72 mm across (Law 4). Drag coefficient 0.45, a new ball at bowling speeds (the same
 * wind-tunnel figure the ball-speed measurement uses, docs/RESEARCH.md). Swing is a steady side force until the ball
 * pitches; its coefficient in Test-match ball tracking runs from about 0.1 to 0.5 ("Review and reassessment of the
 * aerodynamics of cricket ball swing", Cambridge University Press 2024), and the control here stops at 0.25, which
 * moves a 130 km/h ball 29 cm before it pitches on a good length and 50 cm before a full one. The bounce keeps 55% of the vertical speed (a
 * cricket ball dropped on a hard surface keeps 0.58: R. Cross, "Physics of cricket", University of Sydney) and 87% of
 * the speed along the ground, so the ball reaches the batter at about 0.8 of its release speed, inside the 0.65-0.85
 * the ball-speed measurement allows for. That is a firm pitch; a slow one keeps less of both.
 */
import type { V3 } from "./biomech";

export const BALL_R = 0.036, BALL_M = 0.156;
export const STUMPS_Z = -20.12, CREASE_Z = -18.9;       // the batter's stumps and popping crease
export const STUMP_H = 0.711, STUMPS_W = 0.2286;
const G = 9.81, RHO = 1.2, AREA = Math.PI * BALL_R * BALL_R;
export const CD = 0.45, BOUNCE = { up: 0.55, along: 0.87 } as const;
export const MAX_SWING = 0.25;   // the most the swing control gives: a little under the most measured

export interface Launch {
  from: V3;            // where the ball leaves the hand
  speed: number;       // m/s
  elev: number;        // radians above the horizontal (negative: downwards)
  azim: number;        // radians towards +x, from straight down the pitch
  swing: number;       // side-force coefficient: positive pushes towards +x
}
export interface Sample { t: number; p: V3 }
export interface FlightPath {
  samples: Sample[];                 // every millisecond-ish step from the hand to the batter's stumps
  pitch: { t: number; p: V3; speedIn: number; speedOut: number; angle: number } | null;   // the first bounce (angle: degrees it comes down at)
  bounces: number;
  crease: { t: number; p: V3; speed: number } | null;    // crossing the batter's popping crease
  stumps: { t: number; p: V3; speed: number } | null;    // crossing the line of the batter's stumps
  swung: number;                     // how far the swing moved it sideways by the time it pitched (or reached the batter), metres
}

const DT = 0.001;

/** Fly one ball. Stops at the line of the batter's stumps, or after 3 seconds. */
export function fly(l: Launch, cd = CD, bounce: { up: number; along: number } = BOUNCE): FlightPath {
  const kd = (0.5 * RHO * cd * AREA) / BALL_M, ks = (0.5 * RHO * l.swing * AREA) / BALL_M;
  const ce = Math.cos(l.elev);
  let x = l.from[0], y = l.from[1], z = l.from[2];
  let vx = l.speed * Math.sin(l.azim) * ce, vy = l.speed * Math.sin(l.elev), vz = -l.speed * Math.cos(l.azim) * ce;
  const samples: Sample[] = [{ t: 0, p: [x, y, z] }];
  const out: FlightPath = { samples, pitch: null, bounces: 0, crease: null, stumps: null, swung: 0 };
  // the same ball without swing, to say how far the swing moved it
  let x0 = x, vx0 = vx, vz0 = vz, vy0 = vy;
  const acc = (ax: number, ay: number, az: number, swing: number): V3 => {
    const v = Math.hypot(ax, ay, az), h = Math.hypot(ax, az) || 1;
    // the side force is level and square to the ball's path: for a ball going down the pitch (-z), +x
    return [-kd * v * ax + swing * v * v * (-az / h), -G - kd * v * ay, -kd * v * az + swing * v * v * (ax / h)];
  };
  for (let t = 0; t < 3; ) {
    const sw = out.bounces === 0 ? ks : 0;   // swing is in the air, before it pitches
    // midpoint step
    const a1 = acc(vx, vy, vz, sw);
    const mx = vx + a1[0] * DT / 2, my = vy + a1[1] * DT / 2, mz = vz + a1[2] * DT / 2;
    const a2 = acc(mx, my, mz, sw);
    const px = x, py = y, pz = z;
    x += mx * DT; y += my * DT; z += mz * DT;
    vx += a2[0] * DT; vy += a2[1] * DT; vz += a2[2] * DT;
    if (out.bounces === 0) {
      const b1 = acc(vx0, vy0, vz0, 0), b2 = acc(vx0 + b1[0] * DT / 2, vy0 + b1[1] * DT / 2, vz0 + b1[2] * DT / 2, 0);
      x0 += (vx0 + b1[0] * DT / 2) * DT; vx0 += b2[0] * DT; vy0 += b2[1] * DT; vz0 += b2[2] * DT;
      out.swung = x - x0;
    }
    t += DT;
    const cross = (line: number) => pz > line && z <= line;
    const at = (line: number): { t: number; p: V3; speed: number } => {
      const u = (pz - line) / (pz - z || 1);
      return { t: t - DT + u * DT, p: [px + (x - px) * u, py + (y - py) * u, line], speed: Math.hypot(vx, vy, vz) };
    };
    if (!out.crease && cross(CREASE_Z)) out.crease = at(CREASE_Z);
    if (cross(STUMPS_Z)) { out.stumps = at(STUMPS_Z); samples.push({ t: out.stumps.t, p: out.stumps.p }); break; }
    if (y <= BALL_R && vy < 0) {
      const speedIn = Math.hypot(vx, vy, vz), angle = (Math.atan2(-vy, Math.hypot(vx, vz)) * 180) / Math.PI;
      // back to the moment it touched (a step is up to 4 cm of travel)
      const u = Math.max(0, Math.min(1, (py - BALL_R) / (py - y || 1)));
      x = px + (x - px) * u; z = pz + (z - pz) * u; t += (u - 1) * DT;
      y = BALL_R; vy = -bounce.up * vy; vx *= bounce.along; vz *= bounce.along;
      out.bounces++;
      if (!out.pitch) out.pitch = { t, p: [x, 0, z], speedIn, speedOut: Math.hypot(vx, vy, vz), angle };
      if (out.bounces > 6) break;   // it is rolling
    }
    samples.push({ t, p: [x, y, z] });
  }
  return out;
}

/** Where the ball is at a time after release (between the samples). */
export function ballAt(path: FlightPath, t: number, out: V3 = [0, 0, 0]): V3 {
  const s = path.samples, n = s.length;
  if (t <= 0) { out[0] = s[0].p[0]; out[1] = s[0].p[1]; out[2] = s[0].p[2]; return out; }
  let i = Math.min(n - 2, Math.floor(t / DT));
  while (i > 0 && s[i].t > t) i--;
  while (i < n - 2 && s[i + 1].t < t) i++;
  const a = s[i], b = s[i + 1], u = Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t || 1)));
  for (let k = 0; k < 3; k++) out[k] = a.p[k] + (b.p[k] - a.p[k]) * u;
  return out;
}

export interface Aim {
  length: number;   // where it pitches: metres up the pitch from the batter's stumps
  line: number;     // where it passes the batter's stumps: x, metres from middle stump
}

/** The launch that pitches the ball on a length and passes the stumps on a line: the angle down is found by bisection
 * (a steeper release pitches shorter), the angle across by correcting what the last try missed by at the stumps.
 * Null when this pace can't reach the length. */
export function aimAt(from: V3, speed: number, aim: Aim, swing = 0): Launch | null {
  const zT = STUMPS_Z + aim.length;
  if (zT >= from[2] - 0.5) return null;
  let azim = Math.atan2(aim.line - from[0], from[2] - STUMPS_Z);
  let elev = 0;
  for (let round = 0; round < 6; round++) {
    let lo = -1.2, hi = 0.35;   // radians: steeply down to a lob
    const landing = (e: number) => fly({ from, speed, elev: e, azim, swing }).pitch;
    const far = landing(hi);
    if (far && far.p[2] > zT) return null;   // even the lob falls short
    for (let i = 0; i < 26; i++) {
      const m = (lo + hi) / 2, p = landing(m);
      if (!p || p.p[2] < zT) hi = m; else lo = m;   // past the spot (or never pitched): aim lower
    }
    elev = (lo + hi) / 2;
    const end = fly({ from, speed, elev, azim, swing });
    if (!end.pitch || !end.stumps) return null;
    const miss = aim.line - end.stumps.p[0];
    if (Math.abs(miss) < 0.001) break;
    azim += Math.atan2(miss, from[2] - STUMPS_Z);
  }
  return { from, speed, elev, azim, swing };
}

export type LengthName = "Yorker" | "Full" | "Good length" | "Back of a length" | "Short";
/** The usual bands, in metres from the batter's stumps. */
export const LENGTHS: { name: LengthName; from: number; to: number }[] = [
  { name: "Yorker", from: 0, to: 2 }, { name: "Full", from: 2, to: 6 }, { name: "Good length", from: 6, to: 8 },
  { name: "Back of a length", from: 8, to: 10 }, { name: "Short", from: 10, to: 14 },
];
export const lengthName = (m: number): LengthName => (LENGTHS.find((b) => m < b.to) ?? LENGTHS[LENGTHS.length - 1]).name;

export interface Read {
  launch: Launch; path: FlightPath;
  down: number;            // degrees below the horizontal the ball leaves the hand
  seconds: number;         // release to the batter's popping crease
  arriveKmh: number;       // its speed there
  height: number;          // how high it is as it passes the batter's crease, metres
  atStumps: { height: number; x: number; hitting: boolean } | null;
  commit: number | null;   // how far from the batter the ball is 0.2 s before it arrives (the latest a shot can be changed), metres
  perDegree: number;       // metres of length one degree of release angle is worth, here
  perTen: number;          // how much higher the ball reaches the batter from a release 10 cm higher, same length, metres
  window: number | null;   // the spread of release angles that still lands on a good length (6-8 m), degrees
}

/** A typical visual reaction time: a shot can't be changed in the last 0.2 s (McLeod, "Visual reaction time and
 * high-speed ball games", Perception 1987). */
export const REACTION_S = 0.2;

/** Everything a delivery from this release point, at this pace, to this spot comes to. */
export function readDelivery(from: V3, speed: number, aim: Aim, swing = 0): Read | null {
  const launch = aimAt(from, speed, aim, swing);
  if (!launch) return null;
  const path = fly(launch);
  if (!path.crease) return null;
  const deg = 180 / Math.PI, st = path.stumps;
  const steeper = fly({ ...launch, elev: launch.elev - 0.5 / deg }).pitch, flatter = fly({ ...launch, elev: launch.elev + 0.5 / deg }).pitch;
  const perDegree = steeper && flatter ? Math.abs(steeper.p[2] - flatter.p[2]) : 0;
  const high = aimAt([from[0], from[1] + 0.1, from[2]], speed, aim, swing), hc = high ? fly(high).crease : null;
  const a6 = aimAt(from, speed, { length: 6, line: aim.line }, swing), a8 = aimAt(from, speed, { length: 8, line: aim.line }, swing);
  const before = ballAt(path, path.crease.t - REACTION_S);
  return {
    launch, path, down: -launch.elev * deg, seconds: path.crease.t, arriveKmh: path.crease.speed * 3.6, height: path.crease.p[1],
    atStumps: st ? { height: st.p[1], x: st.p[0], hitting: st.p[1] <= STUMP_H + BALL_R && Math.abs(st.p[0]) <= STUMPS_W / 2 + BALL_R } : null,
    commit: path.crease.t > REACTION_S ? before[2] - CREASE_Z : null,
    perDegree, perTen: hc ? hc.p[1] - path.crease.p[1] : 0,
    window: a6 && a8 ? Math.abs(a6.elev - a8.elev) * deg : null,
  };
}

/** The length a marked pitching time means: how far the ball has gone that long after release, at this pace. */
export function lengthFromTime(from: V3, speed: number, seconds: number): number | null {
  if (!(seconds > 0.1 && seconds < 1.2)) return null;
  let lo = 0.3, hi = Math.min(16, from[2] - STUMPS_Z - 1);
  const tp = (len: number) => { const a = aimAt(from, speed, { length: len, line: 0 }); return a ? fly(a).pitch?.t ?? null : null; };
  const tShort = tp(hi), tFull = tp(lo);
  if (tShort === null || tFull === null || seconds < tShort || seconds > tFull) return null;
  for (let i = 0; i < 22; i++) { const m = (lo + hi) / 2, t = tp(m); if (t === null) return null; if (t > seconds) lo = m; else hi = m; }
  return (lo + hi) / 2;
}

// ---------------------------------------------------------------- the release point of an analysed delivery

import type { AnalysisResult } from "../types";
import { buildMotion, sides } from "./biomech";

export interface Release {
  from: V3;                 // the ball in the hand at the release frame, in the scene
  frame: number;            // the release frame, in the analysis window
  heightMeasured: boolean;  // its height is the one measured on the video (otherwise it is the 3D estimate's)
}

/** Where the ball leaves the hand: the 3D skeleton's bowling hand at the release frame (13 cm beyond the wrist, along
 * the forearm). The skeleton's hand is put at the release height measured on the video when the clip measured one.
 * How wide of the stumps the bowler is isn't measured: the scene stands them 0.62 m from middle stump. */
export function releaseOf(result: AnalysisResult): Release | null {
  if (!result.events.br || !result.skeleton3d?.joints?.length) return null;
  const m = buildMotion(result), s = sides(result.bowling_arm.arm === "right");
  const frame = Math.max(0, Math.min(m.joints.length - 1, result.events.br.frame - result.frames.start));
  const P = m.joints[frame], e = P[s.elbow], w = P[s.wrist], d = Math.hypot(w[0] - e[0], w[1] - e[1], w[2] - e[2]) || 1;
  const from: V3 = [w[0] + ((w[0] - e[0]) / d) * 0.13, w[1] + ((w[1] - e[1]) / d) * 0.13, w[2] + ((w[2] - e[2]) / d) * 0.13];
  if (!from.every(Number.isFinite) || from[1] < 0.8) return null;   // an arm below the waist isn't a release
  const rh = result.metrics?.find((q) => q.key === "release_height_pct");
  return { from, frame, heightMeasured: !!rh && rh.value !== null && rh.reliability === "measured" && rh.rating !== "unrated" };
}

/** What the clip itself says about the ball: the pace, when it was measured (lib/pace.ts), and the length, when the
 * frame it pitched was marked too (the time to the pitch at that pace, turned into a distance). */
export function measuredBall(result: AnalysisResult, release: Release, pace: { kmh: number; release: number; pitch?: number | null } | null | undefined): { kmh: number | null; length: number | null } {
  if (!pace || !Number.isFinite(pace.kmh) || pace.kmh < 30) return { kmh: null, length: null };
  const f0 = result.frames.start, times = result.frames.times;
  let length: number | null = null;
  if (pace.pitch !== undefined && pace.pitch !== null) {
    const a = times[pace.release - f0], b = times[pace.pitch - f0];
    if (a !== undefined && b !== undefined) length = lengthFromTime(release.from, pace.kmh / 3.6, (b - a) / Math.max(1, result.options.slowmo_factor || 1));
  }
  return { kmh: pace.kmh, length };
}
