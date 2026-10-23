/** Parity of engine/insights.ts with backend/bowlnet/insights.py (exact JSON, crc32-based item ids included). */
import { describe, expect, it } from "vitest";
import { insights } from "../src/engine/insights";
import { FIXTURES, loadFixture } from "./fixtures";

describe.each(FIXTURES)("insights %s", (name) => {
  const fx = loadFixture(name);
  it("with a player profile", () => {
    const out = insights(fx.result, fx.insights.player);
    expect(out).toEqual(fx.insights.out);
    expect(JSON.stringify(out)).toBe(JSON.stringify(fx.insights.out));
  });
  it("anonymous", () => {
    const out = insights(fx.result, null);
    expect(out).toEqual(fx.insights.out_anon);
    expect(JSON.stringify(out)).toBe(JSON.stringify(fx.insights.out_anon));
  });
});
