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
