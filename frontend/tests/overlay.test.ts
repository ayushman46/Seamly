/** The compare overlay's alignment: phase matching between each clip's own events, run direction, body-size unit. */
import { describe, expect, it } from "vitest";
import { frameAt, mirrored, torsoPx } from "../src/components/OverlayCompare";
import type { AnalysisResult, EventKey } from "../src/types";

// a 17-joint pose whose hips sit at x and whose shoulders are `torso` pixels above them
const body = (x: number, torso: number): [number, number][] =>
  Array.from({ length: 17 }, (_, j) => [x + (j % 2 ? 4 : -4), j === 5 || j === 6 ? 300 - torso : j === 11 || j === 12 ? 300 : 250]);
function clip(xs: number[], torso: number, events: Partial<Record<EventKey, number>>, view = "side_on"): AnalysisResult {
  const ev = Object.fromEntries((["bfc", "ffc", "uah", "br", "ft"] as EventKey[]).map((k) => [k, events[k] !== undefined ? { frame: events[k] } : null]));
  return {
    frames: { start: 10, end: 10 + xs.length, times: [] },
    keypoints2d: { names: [], xy: xs.map((x) => body(x, torso)), conf: xs.map(() => Array(17).fill(0.9)) },
    events: ev, view: { view },
  } as unknown as AnalysisResult;
}

describe("compare overlay alignment", () => {
  it("matches phases between each clip's own events", () => {
    const r = clip(Array(40).fill(0), 50, { bfc: 10, ffc: 20, br: 26, ft: 40 });
    const keys: EventKey[] = ["bfc", "ffc", "br", "ft"];
    expect(frameAt(r, keys, 0)).toBe(10);
    expect(frameAt(r, keys, 1)).toBe(20);
    expect(frameAt(r, keys, 1.5)).toBe(23);
    expect(frameAt(r, keys, 3)).toBe(40);
    expect(frameAt(r, ["br"], 0)).toBe(26);
  });

  it("mirrors side-on clips that run right to left, and leaves other views alone", () => {
    const xs = Array.from({ length: 30 }, (_, i) => 600 - i * 10);
    expect(mirrored(clip(xs, 50, { bfc: 12, ft: 35 }))).toBe(true);
    expect(mirrored(clip(xs.map((x) => 900 - x), 50, { bfc: 12, ft: 35 }))).toBe(false);
    expect(mirrored(clip(xs, 50, { bfc: 12, ft: 35 }, "behind"))).toBe(false);
  });

  it("takes the median torso length as the body-size unit", () => {
    const r = clip(Array(9).fill(100), 60, {});
    r.keypoints2d.xy[0] = body(100, 300);   // one bad frame doesn't move it
    expect(torsoPx(r)).toBeCloseTo(60, 5);
  });
});
