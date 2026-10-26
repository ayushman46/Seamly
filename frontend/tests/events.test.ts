/** Parity of engine/events.ts (and body_height_px) with the recorded Python pipeline calls. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURES, loadFixture, maxAbsDiff } from "./fixtures";
import { classifyView, decideBowlingArm, detectEvents, facingDirection, stabilise, strideAcross } from "../src/engine/events";
import { bodyHeightPx } from "../src/engine/pose2d";
import { sideForArm } from "../src/engine/types";
import type { Side } from "../src/engine/types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const relClose = (a: number, b: number, rel = 1e-6, abs = 1e-9) => Math.abs(a - b) <= Math.max(abs, rel * Math.abs(b));
/** Max |a-b| / max(|b|, floor) over nested arrays. */
function maxRel(a: Any, b: Any, floor = 1): number {
  if (Array.isArray(a)) return a.reduce((m: number, v: Any, i: number) => Math.max(m, maxRel(v, b[i], floor)), 0);
  return Math.abs(a - b) / Math.max(Math.abs(b), floor);
}
const side = (s: Any): Side => s as Side;
const calls = (name: (typeof FIXTURES)[number], fn: string): Any[] => loadFixture(name).calls[fn] ?? [];

describe.each(FIXTURES)("events parity: %s", (name) => {
  it("detect_events", () => {
    const cs = calls(name, "detect_events");
    expect(cs.length).toBeGreaterThan(0);
    for (const { args: a, out } of cs) {
      const ev = detectEvents(a.kp, a.kc, a.kp_stab, a.P, side(a.side), a.up, a.forward, a.fps, a.body_px,
        a.sweep_window, a.sweep_peak, a.fixed);
      for (const k of ["bfc", "ffc", "uah", "br", "ft"] as const) expect(ev[k], k).toBe(out[k]);
      expect(ev.method).toEqual(out.method);
      expect(Object.keys(ev.confidence).sort()).toEqual(Object.keys(out.confidence).sort());
      for (const [k, v] of Object.entries(out.confidence)) {
        expect(relClose((ev.confidence as Any)[k], v as number), `conf ${k}: ${(ev.confidence as Any)[k]} vs ${v}`).toBe(true);
      }
    }
  });

  it("decide_bowling_arm", () => {
    for (const { args: a, out } of calls(name, "decide_bowling_arm")) {
      const [arm, conf, votes] = decideBowlingArm(a.kp, a.kc, a.P, a.fps, a.sweep_hint, a.window);
      expect(arm).toBe(out[0]);
      expect(relClose(conf, out[1])).toBe(true);
      expect(votes).toEqual(out[2]);
    }
  });

  it("stabilise", () => {
    for (const { args: a, out } of calls(name, "stabilise")) {
      // the recorded motions are rounded to 7 decimals, which moves far-from-origin points by up to ~1e-4 px
      // (exact parity on the rounded inputs is checked by the generated cases below)
      expect(maxAbsDiff(stabilise(a.kp, a.motions, a.ref), out)).toBeLessThan(1e-3);
    }
  });

  it("facing_direction / stride_across / classify_view / body_height_px", () => {
    for (const { args: a, out } of calls(name, "facing_direction")) {
      expect(maxAbsDiff(facingDirection(a.P, a.up, a.frames), out)).toBeLessThan(1e-6);
    }
    for (const { args: a, out } of calls(name, "stride_across")) {
      const v = strideAcross(a.kp, a.k, a.leg_m, side(a.side), a.ffc, a.br);
      expect(out === null ? v === null : relClose(v!, out)).toBe(true);
    }
    for (const { args: a, out } of calls(name, "classify_view")) {
      expect(classifyView(a.forward_cam, a.kp, a.kc, a.runup, a.stride_x)).toEqual(out);
    }
    for (const { args: a, out } of calls(name, "body_height_px")) {
      expect(maxRel(bodyHeightPx(a.kp, a.kc), out, 1)).toBeLessThan(1e-6);
    }
  });
});

// ---------------- extra cases: Python re-run on the recorded (rounded) inputs, with variations ----------------
const CASES: Any = JSON.parse(readFileSync(join(__dirname, "fixtures", "pose_events_bowler_cases.json"), "utf8"));
const COCO_FLIP = [0, 2, 1, 4, 3, 6, 5, 8, 7, 10, 9, 12, 11, 14, 13, 16, 15];

describe.each(FIXTURES)("events generated cases: %s", (name) => {
  const cases: Any[] = CASES.events[name];
  const recorded = (c: Any) => loadFixture(name).calls[c.ref.call][c.ref.index].args;
  it.each(cases.map((c, i) => [i, c.fn, c]))("#%i %s", (_i, fn, c: Any) => {
    const a = { ...recorded(c), ...c.args };
    if (c.args.trim) for (const k of ["kp", "kc", "kp_stab", "P", "body_px"]) a[k] = a[k].slice(0, c.args.trim);
    switch (fn) {
      case "stabilise":
        expect(maxRel(stabilise(a.kp, a.motions, a.ref), c.out, 1)).toBeLessThan(1e-9);
        break;
      case "body_height_px":
        expect(maxRel(bodyHeightPx(a.kp, a.kc), c.out, 1)).toBeLessThan(1e-9);
        break;
      case "detect_events": {
        const sd = a.bowling_arm ? sideForArm(a.bowling_arm) : side(a.side);
        const ev = detectEvents(a.kp, a.kc, a.kp_stab, a.P, sd, a.up, a.forward, a.fps, a.body_px, a.sweep_window,
          a.sweep_peak, a.fixed);
        for (const k of ["bfc", "ffc", "uah", "br", "ft"] as const) expect(ev[k], k).toBe(c.out[k]);
        expect(ev.method).toEqual(c.out.method);
        expect(Object.keys(ev.confidence)).toEqual(Object.keys(c.out.confidence));
        expect(maxRel(Object.values(ev.confidence), Object.values(c.out.confidence), 1)).toBeLessThan(1e-9);
        break;
      }
      case "decide_bowling_arm": {
        const kp = a.flip ? a.kp.map((f: Any) => COCO_FLIP.map((j) => f[j])) : a.kp;
        const [arm, conf, votes] = decideBowlingArm(kp, a.kc, a.P, a.fps, a.sweep_hint, a.window);
        expect([arm, votes]).toEqual([c.out[0], c.out[2]]);
        expect(relClose(conf, c.out[1], 1e-9)).toBe(true);
        break;
      }
      case "facing_direction":
        expect(maxAbsDiff(facingDirection(a.P, a.up, a.frames), c.out)).toBeLessThan(1e-9);
        break;
      case "stride_across": {
        const v = strideAcross(a.kp, a.k, a.leg_m, side(a.side), a.ffc, a.br);
        expect(c.out === null ? v === null : relClose(v!, c.out, 1e-9)).toBe(true);
        break;
      }
      case "classify_view":
        expect(classifyView(a.forward_cam, a.kp, a.kc, a.runup, a.stride_x)).toEqual(c.out);
        break;
      default:
        throw new Error(fn);
    }
  });
});

describe("arm speed around release from the refined keypoints", () => {
  it("takes the second-fastest step and leaves out glitches", async () => {
    const { armPeakSpeed } = await import("../src/engine/events");
    // the shoulder at (0, 0); the wrist turns 20 deg a frame, one step of 150 deg (a swap) and one of 40 deg
    const deg = [0, 20, 40, 60, 210, 230, 250, 290, 310, 330, 350, 10, 30];
    const kp = deg.map((a) => Array.from({ length: 17 }, (_, j) => (j === 10 ? [Math.cos((a * Math.PI) / 180) * 100, Math.sin((a * Math.PI) / 180) * 100] : [0, 0])));
    const kc = deg.map(() => Array(17).fill(0.9));
    expect(armPeakSpeed(kp, kc, 6, 10, 8, 25)).toBeCloseTo(20 * 25, 6);   // 40-deg step is the fastest, 20 the second
    kc[7][10] = 0.1;   // the 40-deg step's frame unseen: second-fastest of the rest is still 20
    expect(armPeakSpeed(kp, kc, 6, 10, 8, 25)).toBeCloseTo(20 * 25, 6);
    expect(armPeakSpeed(kp.slice(0, 2), kc.slice(0, 2), 6, 10, 1, 25)).toBeNull();
  });
});
