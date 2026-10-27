import { describe, expect, it } from "vitest";
import { coach } from "../src/engine/coaching";
import { FIXTURES, loadFixture } from "./fixtures";
import { deepDiff } from "./pyparity";

describe("coaching.coach parity with the Python pipeline", () => {
  for (const name of FIXTURES) {
    it(name, () => {
      const call = loadFixture(name).calls.coach[0];
      const { metrics, view, fps } = call.args;
      expect(deepDiff(coach(metrics, view, fps), call.out, 0)).toEqual([]);
    });
  }
});

describe("drills match the measurement", () => {
  it("gives a folding back leg its own back-leg drill, not the front-leg one", () => {
    const m = (key: string, value: number, rating: string) => ({ key, label: key, value, unit: "deg", rating, confidence: 0.8, event: "bfc", reliability: "measured" });
    const c = coach([m("back_knee_bfc", 140, "risk")] as unknown as Parameters<typeof coach>[0], "side_on", 60);
    expect(c.priorities[0].drill.title).toBe("Land on a firm back leg");
    expect(c.priorities[0].drill.cue).toMatch(/back foot/);
    const f = coach([m("front_knee_br", 150, "watch")] as unknown as Parameters<typeof coach>[0], "side_on", 60);
    expect(f.priorities[0].drill.title).toBe("Brace the front leg");
  });
});
