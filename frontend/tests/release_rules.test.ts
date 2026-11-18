/** The app-only rules added with the RTMO / RTMPose models (not in the Python reference engine). */
import { describe, expect, it } from "vitest";
import { bestUpswing, decideBowlingArm, upright, upswings } from "../src/engine/events";
import { bestSweep, type Detection } from "../src/engine/bowler";
import { segmentShots } from "../src/engine/video";

const FPS = 30;
/** A standing figure, 17 COCO keypoints; wrist heights (arm lengths above the shoulder) set per arm. */
function figure(liftR: number, liftL: number, lean = 0): number[][] {
  const p = Array.from({ length: 17 }, () => [100, 100]);
  const shY = 100 + 80 * (1 - Math.cos(lean)), shX = 100 + 80 * Math.sin(lean);
  p[5] = [shX - 20, shY]; p[6] = [shX + 20, shY]; p[11] = [90, 180]; p[12] = [110, 180];
  p[13] = [90, 230]; p[14] = [110, 230]; p[15] = [90, 280]; p[16] = [110, 280];
  for (const [sh, el, wr, l] of [[6, 8, 10, liftR], [5, 7, 9, liftL]] as const) {
    const a = Math.asin(Math.max(-1, Math.min(1, l)));   // arm straight, 60 px long
    const dx = (sh === 6 ? 1 : -1) * Math.cos(a), dy = -Math.sin(a);
    p[el] = [p[sh][0] + 30 * dx, p[sh][1] + 30 * dy]; p[wr] = [p[sh][0] + 60 * dx, p[sh][1] + 60 * dy];
  }
  return p;
}
const ones = (T: number, v = 1) => Array.from({ length: T }, () => new Array(17).fill(v));
const P0 = (T: number) => Array.from({ length: T }, () => Array.from({ length: 17 }, () => [0, 0, 0]));
/** Wrist height over time: down, up and over at `top`, down again. */
const over = (t: number, top: number, w = 4) => Math.max(-0.95, 0.95 - 1.9 * Math.abs(t - top) / w);

describe("up-and-over", () => {
  it("finds the rise from below the shoulder, the top and the fall", () => {
    const lift = Array.from({ length: 40 }, (_, t) => over(t, 20));
    const u = upswings(lift, 0, 40, FPS);
    expect(u.some(([, th, amp, fall]) => th === 20 && amp > 1.5 && fall > 1.3)).toBe(true);
  });
  it("a wrist misread for one frame after the top does not end the top early", () => {
    const lift = Array.from({ length: 40 }, (_, t) => (t === 20 ? 1.5 : t === 21 ? 0.1 : t === 22 || t === 23 ? 0.95 : over(t, 23, 3)));
    const u = upswings(lift, 0, 40, FPS);
    expect(u.map((x) => x[1]), JSON.stringify(u)).toContain(23);
  });
  it("seen from behind, a flat top reads as its middle frame", () => {
    const lift = Array.from({ length: 60 }, (_, t) => (t >= 28 && t <= 34 ? 0.99 + (t === 29 ? 0.005 : 0) : over(t, t < 28 ? 28 : 34, 6)));
    expect(upswings(lift, 0, 60, 60).some(([, th]) => th === 31)).toBe(true);
  });
  it("bent double with an arm in the air is the follow-through, not a release", () => {
    expect(upright(figure(0, 0))).toBeGreaterThan(0.9);
    expect(upright(figure(0, 0, 1.3))).toBeLessThan(0.5);
    const kp = Array.from({ length: 40 }, (_, t) => figure(over(t, 20), -0.9, 1.3));
    expect(bestUpswing(kp, ones(40), 6, 8, 10, 0, 40, FPS)[0]).toBe(0);
  });
  it("a wrist the model barely saw counts for less", () => {
    const kp = Array.from({ length: 40 }, (_, t) => figure(over(t, 20), -0.9));
    const seen = bestUpswing(kp, ones(40), 6, 8, 10, 0, 40, FPS)[0], unseen = bestUpswing(kp, ones(40, 0.25), 6, 8, 10, 0, 40, FPS)[0];
    expect(seen).toBeGreaterThan(3);
    expect(unseen).toBeLessThan(0.5 * seen);
  });
});

describe("bowling arm", () => {
  it("the arm that goes up and over bowls, whatever the scan guessed", () => {
    const T = 50, kp = Array.from({ length: T }, (_, t) => figure(over(t, 30), t < 26 ? 0.6 : -0.5));
    const [arm, , votes] = decideBowlingArm(kp, ones(T), P0(T), FPS, "left", [20, 36], true);
    expect(votes.over_top).toBe(1);
    expect(arm).toBe("right");
  });
  it("the other arm swinging up 0.3 s after the release is not the bowling arm", () => {
    const T = 60, kp = Array.from({ length: T }, (_, t) => figure(over(t, 28), over(t, 37)));
    expect(decideBowlingArm(kp, ones(T), P0(T), FPS, null, [20, 40], true)[2].over_top).toBe(1);
    const mirror = Array.from({ length: T }, (_, t) => figure(over(t, 37), over(t, 28)));
    expect(decideBowlingArm(mirror, ones(T), P0(T), FPS, null, [20, 40], true)[2].over_top).toBe(-1);
  });
  it("without the app's flag the votes are the reference engine's", () => {
    const T = 50, kp = Array.from({ length: T }, (_, t) => figure(over(t, 30), -0.5));
    expect("over_top" in decideBowlingArm(kp, ones(T), P0(T), FPS, "right", [20, 36])[2]).toBe(false);
  });
});

describe("scan", () => {
  it("the sweep's fastest moment is taken from inside the sweep", () => {
    // a slow full turn (frames 0-20), a pause, then a short fast turn the same way (frames 40-42)
    const ang = (f: number) => (f <= 20 ? (f / 20) * 5.5 : f < 40 ? 5.5 : 5.5 + Math.min(f - 40, 2) * 0.9);
    const dets: Detection[] = Array.from({ length: 46 }, (_, f) => ({ frame: f, track: 1, conf: 1, box: [0, 0, 100, 200],
      kps: Array.from({ length: 17 }, (_, j) => (j === 10 ? [50 + 60 * Math.cos(ang(f)), 60 + 60 * Math.sin(ang(f))] : [50, 60])), kcs: new Array(17).fill(1) }));
    const loose = bestSweep(dets, FPS, "right")!, inside = bestSweep(dets, FPS, "right", true)!;
    expect(loose.peak_frame).toBeGreaterThan(loose.end_frame);
    expect(inside.peak_frame).toBeLessThanOrEqual(inside.end_frame);
  });
  it("a cut between two shots of the same ground is found by the app", () => {
    const n = 40, frames = Array.from({ length: n }, (_, i) => i);
    const hd = new Array(n - 1).fill(0.003), pd = new Array(n - 1).fill(9);
    hd[19] = 0.037; pd[19] = 21.6;                    // the real clip's numbers: green outfield to green pitch
    for (let i = 20; i < n - 1; i++) pd[i] = 3;
    expect(segmentShots(hd, pd, frames, n, 25).length).toBe(1);
    expect(segmentShots(hd, pd, frames, n, 25, true).map((s) => s.start)).toEqual([0, 20]);
    pd[19] = 9; hd[19] = 0.003;
    expect(segmentShots(hd, pd, frames, n, 25, true).length).toBe(1);
  });
});

import { sizeTrend } from "../src/engine/events";
describe("a bowler running away from the camera gets smaller", () => {
  // a stick body whose size in the picture follows `scale(t)`
  const body = (scale: (t: number) => number, T = 60) => {
    const kp: number[][][] = [], kc: number[][] = [];
    for (let t = 0; t < T; t++) {
      const s = scale(t), p = Array.from({ length: 17 }, () => [500, 300]);
      p[5] = [500 - 20 * s, 300]; p[6] = [500 + 20 * s, 300]; p[11] = [500 - 12 * s, 300 + 60 * s]; p[12] = [500 + 12 * s, 300 + 60 * s];
      p[13] = [500 - 12 * s, 300 + 105 * s]; p[14] = [500 + 12 * s, 300 + 105 * s]; p[15] = [500 - 12 * s, 300 + 150 * s]; p[16] = [500 + 12 * s, 300 + 150 * s];
      kp.push(p); kc.push(new Array(17).fill(0.9));
    }
    return { kp, kc };
  };
  it("reads the rate of change in % per second", () => {
    const away = body((t) => Math.exp(-0.5 * (t / 30))), toward = body((t) => Math.exp(0.2 * (t / 30)));
    expect(sizeTrend(away.kp, away.kc, 59, 30)!).toBeCloseTo(-50, 0);
    expect(sizeTrend(toward.kp, toward.kc, 59, 30)!).toBeCloseTo(20, 0);
  });
  it("says nothing with too little run-up or joints that were not read", () => {
    const b = body(() => 1, 12);
    expect(sizeTrend(b.kp, b.kc, 11, 30)).toBeNull();
    const c = body(() => 1);
    for (const f of c.kc) f[15] = 0.1;
    expect(sizeTrend(c.kp, c.kc, 59, 30)).toBeNull();
  });
});
