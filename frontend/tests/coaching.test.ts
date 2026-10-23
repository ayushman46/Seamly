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
