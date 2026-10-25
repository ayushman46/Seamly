/** Ball speed from marked frames (lib/pace.ts) and run-up speed from the pelvis (lib/runup.ts). */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { paceFrom } from "../src/lib/pace";
import { runupSpeed } from "../src/lib/runup";
import type { AnalysisResult } from "../src/types";

const bundle = (name: string) => JSON.parse(readFileSync(new URL(`../public/samples/${name}/bundle.json`, import.meta.url), "utf8"));
// a clip at `fps` whose frame f has time f / fps
const clip = (fps: number, n = 400, slowmo = 1) => ({
  frames: { start: 0, end: n, times: Array.from({ length: n }, (_, i) => i / fps) },
  fps_real: fps / slowmo, options: { slowmo_factor: slowmo },
}) as unknown as AnalysisResult;

describe("ball speed from two frames", () => {
  it("turns the time over the pitch into a release speed, with a range from the frame rate", () => {
    // 17.68 m in 0.52 s = 34 m/s average = 122 km/h; with air drag only, ~130 km/h at release
    const p = paceFrom(clip(240), { release: 0, arrival: Math.round(0.52 * 240), target: "crease", bounced: false })!;
    expect(p.avgKmh).toBeCloseTo(122.4, 0);
    expect(p.kmh).toBeGreaterThan(128);
    expect(p.kmh).toBeLessThan(132);
    expect(p.hi - p.lo).toBeLessThan(18);   // the half-metre doubt about where the ball left the hand, and air drag
    const slow = paceFrom(clip(30), { release: 0, arrival: Math.round(0.52 * 30), target: "crease", bounced: false })!;
    expect(slow.hi - slow.lo).toBeGreaterThan(p.hi - p.lo);   // 30 fps: wider range
  });
  it("divides slow motion back to real time, and allows for a bounce", () => {
    const real = paceFrom(clip(240), { release: 0, arrival: 125, target: "stumps", bounced: false })!;
    const slomo = paceFrom(clip(240, 2000, 8), { release: 0, arrival: 1000, target: "stumps", bounced: false })!;
    expect(slomo.kmh).toBeCloseTo(real.kmh, 0);
    const bounced = paceFrom(clip(240), { release: 0, arrival: 125, target: "stumps", bounced: true })!;
    expect(bounced.kmh).toBeGreaterThan(real.kmh);
  });
  it("uses the pitching frame to split air and bounce, which narrows the range", () => {
    // a 130 km/h ball (36.1 m/s) pitching 12 m out: ~0.94 of release speed in the air, ~0.75 after the bounce
    const v = 130 / 3.6, t1 = 12 / (0.94 * v), t2 = 5.68 / (0.75 * v);
    const marks = { release: 0, arrival: Math.round((t1 + t2) * 240), target: "crease" as const, bounced: true };
    const marked = paceFrom(clip(240), { ...marks, pitch: Math.round(t1 * 240) })!;
    const unmarked = paceFrom(clip(240), marks)!;
    expect(marked.kmh).toBeGreaterThan(127);
    expect(marked.kmh).toBeLessThan(133);
    expect(marked.lo).toBeLessThan(130);
    expect(marked.hi).toBeGreaterThan(130);
    expect(marked.hi - marked.lo).toBeLessThan(unmarked.hi - unmarked.lo);
    expect(paceFrom(clip(240), { ...marks, pitch: marks.arrival + 1 })).toBeNull();   // pitched after it arrived
  });
  it("refuses marks that can't be a bowled ball", () => {
    expect(paceFrom(clip(30), { release: 20, arrival: 10, target: "crease", bounced: true })).toBeNull();
    expect(paceFrom(clip(30), { release: 0, arrival: 300, target: "crease", bounced: true })).toBeNull();
  });
});

describe("run-up speed at back-foot contact", () => {
  it("matches the scripted speed of the rendered bowler (about 5.1 m/s before back-foot contact)", () => {
    const b = bundle("synthetic");
    const r = runupSpeed(b.result, b.stagea.motions)!;
    expect(r).not.toBeNull();
    expect(r.ms).toBeGreaterThan(4.3);
    expect(r.ms).toBeLessThan(5.9);
  });
  it("undoes a panning camera in display pixels (the motions are in source pixels)", () => {
    // 50 fps, display at half the source size; the camera pans 30 source px a frame while the bowler runs
    // 40 source px a frame; legs 180 display px for 0.9 m: the true speed is 40 × 0.5 × 50 / 200 = 5 m/s
    const fps = 50, n = 60, ds = 0.5, pan = 30, run = 40;
    const xy = Array.from({ length: n }, (_, t) => {
      const x = (600 + (run - pan) * t) * ds;
      return Array.from({ length: 17 }, (_, j) => [x, j >= 15 ? 480 : j >= 13 ? 390 : 300]);
    });
    const r = {
      events: { bfc: { frame: 40, method: "foot_stops_stabilised_2d" } }, view: { view: "side_on" },
      frames: { start: 0, end: n, times: Array.from({ length: n }, (_, i) => i / fps) }, options: { slowmo_factor: 1 },
      keypoints2d: { xy, conf: xy.map((f) => f.map(() => 0.9)) }, video: { width: 1920 }, display_scale: ds,
      skeleton: { bone_lengths_m: [0, 0.45, 0.45] },
    } as unknown as AnalysisResult;
    const motions = Array.from({ length: n }, () => [[1, 0, -pan], [0, 1, 0]]);
    expect(runupSpeed(r, motions)!.ms).toBeCloseTo(5, 1);
  });
  it("gives a plausible speed for the club example", () => {
    const b = bundle("club");
    const r = runupSpeed(b.result, b.stagea.motions);
    expect(r === null || (r.ms > 2 && r.ms < 8)).toBe(true);
  });
});
