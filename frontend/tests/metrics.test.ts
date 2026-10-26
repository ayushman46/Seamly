import { describe, expect, it } from "vitest";
import { compute, pyFormat, pyRound, type Ctx } from "../src/engine/metrics";
import { FIXTURES, loadFixture } from "./fixtures";
import { deepDiff } from "./pyparity";

describe("pyRound / pyFormat follow Python", () => {
  it("rounds on the exact binary value, ties to even", () => {
    // expected values from CPython
    expect([2.675, 1.005, 1.45, 0.15, 0.935, 0.2375].map((x) => pyRound(x, 2))).toEqual([2.67, 1.0, 1.45, 0.15, 0.94, 0.24]);
    expect([0.15, 0.25, 0.35, 2.675, 1.45].map((x) => pyRound(x, 1))).toEqual([0.1, 0.2, 0.3, 2.7, 1.4]);
    expect([0.5, 1.5, 2.5, -2.5, -0.4, 12.5, 172.5].map((x) => pyRound(x))).toEqual([0, 2, 2, -2, 0, 12, 172]);
    expect([2.5, 12.5, 0.5, -0.4, 172.5, 1.45].map((x) => pyFormat(x, 0))).toEqual(["2", "12", "0", "-0", "172", "1"]);
    expect([pyFormat(0.125, 2), pyFormat(0.375, 2), pyFormat(2.675, 2), pyFormat(NaN, 2)]).toEqual(["0.12", "0.38", "2.67", "nan"]);
  });
});

describe("metrics.compute parity with the Python pipeline", () => {
  for (const name of FIXTURES) {
    it(name, () => {
      const call = loadFixture(name).calls.compute[0];
      const out = compute(call.args.ctx as Ctx);
      // metrics: exact keys/order/text, numbers within 1e-6
      expect(deepDiff(out.metrics, call.out.metrics)).toEqual([]);
      // series: the fixture's inputs are stored rounded to 7 decimals, which moves a handful of values across a
      // 0.01 rounding boundary (Python itself reproduces those same flips when re-run on the stored inputs)
      const flips = deepDiff(out.series, call.out.series, 1e-6);
      expect(deepDiff(out.series, call.out.series, 0.01 + 1e-9)).toEqual([]);
      expect(flips.length).toBeLessThanOrEqual(8);
    });
  }
});

describe("the body leaving the picture", () => {
  const frames = (n: number, wristY: number, ankleY: number, ankleConf = 0.9) => {
    const kp = Array.from({ length: n }, () => Array.from({ length: 17 }, () => [100, 300]));
    const kc = Array.from({ length: n }, () => Array(17).fill(0.9));
    for (const f of kp) { f[10] = [100, wristY]; f[15] = [90, ankleY]; f[16] = [120, ankleY]; }
    for (const c of kc) { c[15] = ankleConf; c[16] = ankleConf; }
    return { kp, kc };
  };
  it("tells a bowling hand above the top edge at release", async () => {
    const { handOutOfFrame } = await import("../src/engine/metrics");
    expect(handOutOfFrame(frames(20, -6, 600).kp, 10, 10, 720)).toBe(true);
    expect(handOutOfFrame(frames(20, 57, 600).kp, 10, 10, 720)).toBe(false);
    expect(handOutOfFrame(frames(20, -6, 600).kp, 10, 10, null)).toBe(false);
  });
  it("tells feet below the bottom edge or unseen around landing and release", async () => {
    const { feetOutOfFrame } = await import("../src/engine/metrics");
    const below = frames(30, 100, 749);
    expect(feetOutOfFrame(below.kp, below.kc, 15, 18, 25, 720)).toBe(true);
    const unseen = frames(30, 100, 500, 0.05);
    expect(feetOutOfFrame(unseen.kp, unseen.kc, 15, 18, 25, 720)).toBe(true);
    const fine = frames(30, 100, 690);
    expect(feetOutOfFrame(fine.kp, fine.kc, 15, 18, 25, 720)).toBe(false);
    expect(feetOutOfFrame(fine.kp, fine.kc, null, 18, 25, 720)).toBe(false);
  });
});
