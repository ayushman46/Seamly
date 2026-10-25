/**
 * Ball speed from the video's own clock: the release frame (found by the analysis) and the frame the ball reaches the
 * batter, over the known length of the pitch. No pixel calibration is needed, so it is as precise as the frame rate
 * and what the ball does on the way: at 240 fps the timing costs about ±1%, at 30 fps about ±6%.
 *
 * Distances (Laws of Cricket): stumps to stumps 20.12 m, popping crease 1.22 m in front of each set of stumps, so
 * popping crease to popping crease 17.68 m. A fast bowler lets go roughly above the front foot, which lands at the
 * bowler's popping crease: the release point is taken there, give or take half a metre.
 *
 * Radar guns read the speed at release; the ball then slows. Air drag (drag coefficient ~0.45 new, ~0.65 old) costs
 * 8–16% of the speed over the pitch, so the average to the batter is 0.92–0.96 of the release speed. Pitching costs far
 * more, and how much depends on the length: marking the frame where the ball lands splits the flight into the part
 * slowed by air alone and the shorter part after the bounce, which narrows the range.
 */
import type { AnalysisResult } from "../types";

export type PaceTarget = "crease" | "stumps";
export interface PaceMarks {
  release: number;
  arrival: number;
  target: PaceTarget;
  bounced: boolean;           // it pitched before the arrival frame
  pitch?: number | null;      // the frame it pitched, when marked
}
export interface Pace {
  kmh: number;          // estimated release speed
  lo: number;           // range from the frame timing, the release point and the slowing of the ball
  hi: number;
  avgKmh: number;       // the measured average over the distance
  seconds: number;      // real time from release to arrival
  metres: number;
  fps: number;          // real (filmed) frame rate
}

export const DISTANCE: Record<PaceTarget, number> = { crease: 17.68, stumps: 18.9 };
const RELEASE_SPREAD_M = 0.5;
// average speed as a share of the release speed: in the air only; after pitching; and over the whole way with an
// unmarked bounce somewhere between a short ball (~9 m from release) and a full one (~16 m)
const SLOWING = { air: [0.92, 0.96], after: [0.65, 0.85], bounce: [0.76, 0.95] } as const;
const mid = ([a, b]: readonly [number, number]) => (a + b) / 2;
const halfWidth = ([a, b]: readonly [number, number]) => (b - a) / 2;

/** Real seconds between two frames of the analysis (frame times are the video's, slowed-down clips divided back). */
export function realSeconds(r: AnalysisResult, a: number, b: number): number | null {
  const ta = r.frames.times[a - r.frames.start], tb = r.frames.times[b - r.frames.start];
  if (ta === undefined || tb === undefined) return null;
  return (tb - ta) / Math.max(1, r.options.slowmo_factor || 1);
}

/** The ball's speed from the marked frames, or null when they can't give one (wrong order, or impossibly fast/slow). */
export function paceFrom(r: AnalysisResult, m: PaceMarks): Pace | null {
  const dt = realSeconds(r, m.release, m.arrival);
  if (dt === null || dt <= 0) return null;
  const fps = r.fps_real;
  const d = DISTANCE[m.target];
  const avg = d / dt;                                   // m/s
  // independent doubts, each a relative half-width, combined in quadrature: the release point (± 0.5 m), one frame of
  // timing in all, and how much the ball slowed on the way
  const eD = RELEASE_SPREAD_M / d, eT = 1 / fps / dt;
  let kmh: number, eK: number;
  if (m.pitch !== undefined && m.pitch !== null) {
    const t1 = realSeconds(r, m.release, m.pitch);
    if (t1 === null || t1 <= 0 || t1 >= dt) return null;
    const t2 = dt - t1, den = mid(SLOWING.air) * t1 + mid(SLOWING.after) * t2;
    kmh = d / den * 3.6;
    eK = Math.hypot(halfWidth(SLOWING.air) * t1, halfWidth(SLOWING.after) * t2) / den;
  } else {
    const k = m.bounced ? SLOWING.bounce : SLOWING.air;
    kmh = (avg / mid(k)) * 3.6;
    eK = halfWidth(k) / mid(k);
  }
  const e = Math.hypot(eD, eT, eK), lo = kmh * (1 - e), hi = kmh * (1 + e);
  if (kmh < 30 || kmh > 175) return null;               // not a bowled ball: the marks are on the wrong frames
  return { kmh, lo, hi, avgKmh: avg * 3.6, seconds: dt, metres: d, fps };
}

/** "118 km/h" style rounding: whole km/h, the range to the nearest whole number either side. */
export const kmhText = (p: Pace) => `${Math.round(p.kmh)} km/h`;
export const rangeText = (p: Pace) => `${Math.round(p.lo)}–${Math.round(p.hi)}`;
