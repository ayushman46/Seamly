/** Side-by-side clip (lib/clip.ts): which frames it shows, for how long, and the numbers written under it. */
import { describe, expect, it } from "vitest";
import { clipFacts, clipLayout, clipPlan } from "../src/lib/clip";
import type { AnalysisResult } from "../src/types";

const clip = (fps: number, n: number, ev: Record<string, number>, metrics: Partial<AnalysisResult["metrics"][number]>[] = [], oblique = false) => ({
  frames: { start: 0, end: n, times: Array.from({ length: n }, (_, i) => i / fps) }, fps, options: { slowmo_factor: 1 },
  events: Object.fromEntries(["bfc", "ffc", "uah", "br", "ft"].map((k) => [k, ev[k] !== undefined ? { frame: ev[k] } : null])),
  view: { view: "side_on", oblique }, metrics,
}) as unknown as AnalysisResult;

describe("clip plan", () => {
  it("covers the stride with a lead-in, holds the key moments and ends on a held frame", () => {
    const r = clip(60, 200, { bfc: 100, ffc: 112, br: 120, ft: 140 });
    const p = clipPlan(r, 0.25);
    expect(p[0].frame).toBe(70);                       // half a second before back-foot contact
    expect(p[p.length - 2].frame).toBe(158);           // 0.3 s after the follow-through step
    expect(p.filter((s) => s.hold && s.hold !== "end").map((s) => [s.hold, s.frame])).toEqual([["bfc", 100], ["ffc", 112], ["br", 120]]);
    expect(p[p.length - 1].hold).toBe("end");
    // 60 fps at quarter speed: each frame 66.7 ms
    expect(p[1].ms).toBeCloseTo(1000 / 15, 1);
  });
  it("skips frames of fast footage to stay at 30 a second, but never skips a key moment", () => {
    const r = clip(240, 800, { bfc: 401, ffc: 447, br: 479, ft: 560 });
    const p = clipPlan(r, 0.25);
    const shown = p.filter((s) => !s.hold).map((s) => s.frame);
    // only the frame just before a key moment can be shorter (it stops there rather than skip past it)
    const short = p.filter((s, i) => !s.hold && s.ms < 1000 / 30 - 1e-6 && p[i + 1] && ![401, 447, 479].includes(p[i + 1].frame));
    expect(short.length).toBeLessThanOrEqual(1);   // the very last frame of the stride
    for (const f of [401, 447, 479]) expect(shown).toContain(f);
    // total time follows real time: about (0.5 + stride + 0.3) s at quarter speed, plus the holds
    const real = p.filter((s) => !s.hold).reduce((a, s) => a + s.ms, 0) / 1000;
    expect(real).toBeCloseTo(((560 + 72 - (401 - 120)) / 240) * 4, 0);
  });
  it("stays inside the analysed frames", () => {
    const p = clipPlan(clip(30, 40, { bfc: 5, ffc: 10, br: 14, ft: 38 }), 0.5);
    expect(Math.min(...p.map((s) => s.frame))).toBe(0);
    expect(Math.max(...p.map((s) => s.frame))).toBe(39);
  });
});

describe("clip captions", () => {
  const ms = [
    { key: "front_knee_ffc", value: 171.6, unit: "deg", reliability: "measured", rating: "good" },
    { key: "front_knee_br", value: 158.2, unit: "deg", reliability: "measured", rating: "watch" },
    { key: "trunk_forward_br", value: 30, unit: "deg", reliability: "measured", rating: "unrated" },   // not rated: left out
    { key: "release_height_pct", value: 104.6, unit: "% height", reliability: "measured", rating: "info" },
  ] as Partial<AnalysisResult["metrics"][number]>[];
  const r = clip(60, 200, { bfc: 100, ffc: 112, br: 120, ft: 140 }, ms);
  it("adds each number from the moment it is measured at", () => {
    expect(clipFacts(r, 105, null)).toEqual([]);
    expect(clipFacts(r, 112, null)).toEqual(["Front knee at landing 172°"]);
    expect(clipFacts(r, 125, { kmh: 131.4 } as never)).toEqual(["Front knee at landing 172°", "Front knee at release 158°", "Release height 105% of height", "Ball speed ≈ 131 km/h"]);
  });
  it("writes no body angles for an angled camera", () => {
    expect(clipFacts(clip(60, 200, { ffc: 112, br: 120 }, ms, true), 150, null)).toEqual([]);
  });
  it("lays out even-sized frames for the encoder", () => {
    for (const L of [clipLayout(false, true), clipLayout(true, true), clipLayout(false, false), clipLayout(true, false)]) {
      expect(L.W % 2).toBe(0);
      expect(L.H % 2).toBe(0);
    }
  });
});
