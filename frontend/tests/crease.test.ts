/** Front-foot no-ball check (lib/crease.ts). */
import { describe, expect, it } from "vitest";
import { alongTo, creaseCall, lineUsable, travel, ANKLE_HEIGHT, HEEL_BACK, type CreaseLine } from "../src/lib/crease";
import type { AnalysisResult } from "../src/types";

// A side-on clip at 60 fps of a bowler running to the right (or left): leg 0.491 * 500 px (stature 500 px = 1.80 m),
// both feet planted at y = 600 from frame 30 (front-foot contact), the front ankle at x = 700.
function clip(toRight = true, frontX = 700): AnalysisResult {
  const n = 60, s = toRight ? 1 : -1;
  const xy: [number, number][][] = [], conf: number[][] = [];
  for (let t = 0; t < n; t++) {
    const hipX = 640 + s * (t - 30) * 6;   // the hips travel 6 px a frame
    const p: [number, number][] = Array.from({ length: 17 }, () => [hipX, 300] as [number, number]);
    const L = 0.491 * 500, ankleY = 600 - ANKLE_HEIGHT * 500;
    // front leg (11-13-15) from its hip straight to the front ankle, exactly L long
    p[15] = [frontX, ankleY];
    const dx = frontX - hipX, dy = ankleY - 355, d = Math.hypot(dx, dy);
    p[11] = [frontX - (dx / d) * L, ankleY - (dy / d) * L];
    p[13] = [(p[11][0] + frontX) / 2, (p[11][1] + ankleY) / 2];
    // back leg (12-14-16): L long, angled 40° back from the vertical
    p[12] = [hipX, 355];
    p[16] = [hipX - s * L * Math.sin(0.7), 355 + L * Math.cos(0.7)];
    p[14] = [(p[12][0] + p[16][0]) / 2, (p[12][1] + p[16][1]) / 2];
    xy.push(p); conf.push(Array(17).fill(0.9));
  }
  return {
    frames: { start: 0, end: n, times: Array.from({ length: n }, (_, i) => i / 60) }, fps: 60,
    video: { width: 1280, height: 720 }, display_scale: 1,
    events: { bfc: { frame: 22 }, ffc: { frame: 30 }, br: { frame: 36 }, uah: null, ft: null },
    keypoints2d: { names: [], xy, conf }, skeleton: { stature_m: 1.8 },
  } as unknown as AnalysisResult;
}
// a crease line through x at the foot's ground level, slanting like a crease seen from a camera a little above it
const lineAt = (x: number): CreaseLine => ({ a: [x - 20, 640], b: [x + 20, 560] });

describe("crease geometry", () => {
  it("measures along the direction of travel to the marked line", () => {
    expect(alongTo([0, 0], [1, 0], { a: [10, -5], b: [10, 5] })).toBeCloseTo(10);
    expect(alongTo([0, 0], [-1, 0], { a: [10, -5], b: [10, 5] })).toBeCloseTo(-10);
    expect(alongTo([0, 0], [1, 0], { a: [0, 3], b: [10, 3] })).toBeNull();   // parallel
    // a slanted line: where the ray meets it, not the nearest point
    expect(alongTo([0, 0], [1, 0], { a: [5, -10], b: [15, 10] })).toBeCloseTo(10);
  });
  it("needs a line that crosses the travel, not one along it", () => {
    expect(lineUsable({ a: [0, 0], b: [3, 40] }, [1, 0])).toBe(true);
    expect(lineUsable({ a: [0, 0], b: [40, 5] }, [1, 0])).toBe(false);
    expect(lineUsable({ a: [0, 0], b: [1, 2] }, [1, 0])).toBe(false);   // too short to place
  });
  it("finds the direction of travel from the hips", () => {
    expect(travel(clip(true))).toEqual([1, 0]);
    expect(travel(clip(false))).toEqual([-1, 0]);
  });
});

describe("no-ball call", () => {
  const H = 500, cm = H / 180;   // px per cm
  const heelX = 700 - HEEL_BACK * H;   // back of the heel, 15 px behind the ankle
  it("puts the back of the heel behind the ankle and measures it against the line in centimetres", () => {
    const c = creaseCall(clip(), 30, lineAt(heelX + 20 * cm))!;
    expect(c.heel[0]).toBeCloseTo(heelX, 0);
    expect(c.heel[1]).toBeCloseTo(600, 0);   // on the ground
    expect(c.behindCm).toBeCloseTo(20, 0);
    expect(c.verdict).toBe("legal");
    expect(c.bandCm).toBeGreaterThan(3);
    expect(c.bandCm).toBeLessThan(8);
  });
  it("calls a heel beyond the line a no-ball and one on it too close to call", () => {
    expect(creaseCall(clip(), 30, lineAt(heelX - 15 * cm))!.verdict).toBe("no_ball");
    const close = creaseCall(clip(), 30, lineAt(heelX - 1 * cm))!;
    expect(close.verdict).toBe("close");
    expect(close.behindCm).toBeCloseTo(-1, 0);
  });
  it("works the same for a bowler running to the left", () => {
    const left = clip(false, 600);
    const heel = 600 + HEEL_BACK * H;
    const c = creaseCall(left, 30, lineAt(heel - 20 * cm))!;
    expect(c.behindCm).toBeCloseTo(20, 0);
    expect(creaseCall(left, 30, lineAt(heel + 15 * cm))!.verdict).toBe("no_ball");
  });
  it("takes the foot further along the travel as the front foot, whatever its label", () => {
    const r = clip();
    for (const f of r.keypoints2d.xy) for (const [a, b] of [[11, 12], [13, 14], [15, 16]]) [f[a], f[b]] = [f[b], f[a]];
    expect(creaseCall(r, 30, lineAt(heelX + 20 * cm))!.behindCm).toBeCloseTo(20, 0);
  });
  it("refuses a line along the pitch", () => {
    expect(creaseCall(clip(), 30, { a: [500, 600], b: [900, 610] })).toBeNull();
  });
});
