/** Parity of engine/bowler.ts with Python cases: the fixture bowler's track plus a static umpire, a waist-up arm
 * waver, a short track and a tiny distant person, as float64 and float32 detections, scanned at stride 1 and 2. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURES } from "./fixtures";
import { bestSweep, isDelivery, scoreTracks, trackScoreDict } from "../src/engine/bowler";
import type { ArmSweep, Detection } from "../src/engine/bowler";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const CASES: Any = JSON.parse(readFileSync(join(__dirname, "fixtures", "pose_events_bowler_cases.json"), "utf8"));
const rel = (a: number, b: number) => Math.abs(a - b) / Math.max(1, Math.abs(b));

function sweepClose(a: ArmSweep | null, b: Any, tol: number) {
  if (b === null) return expect(a).toBeNull();
  expect(a).not.toBeNull();
  const { sweep_deg, peak_speed, ...rest } = a!;
  const { sweep_deg: bd, peak_speed: bp, ...brest } = b;
  expect(rest).toEqual(brest);
  expect(rel(sweep_deg, bd)).toBeLessThan(tol);
  expect(rel(peak_speed, bp)).toBeLessThan(tol);
}

describe.each(FIXTURES)("bowler parity: %s", (name) => {
  const { tracks: raw, cases } = CASES.bowler[name];
  it.each((cases as Any[]).map((c) => [c.dtype, c.stride, c]))("%s detections, stride %i", (dtype, stride, c: Any) => {
    // Python's float32 detections hold exactly the fround of the stored float64 values
    const cast = dtype === "float32" ? Math.fround : (v: number) => v;
    const tracks = new Map<number, Detection[]>(Object.entries(raw as Record<string, Any[]>).map(([k, ds]) => [Number(k),
      ds.filter((_, i) => i % stride === 0).map((d) => ({ ...d, box: d.box.map(cast), kps: d.kps.map((p: number[]) => p.map(cast)),
        kcs: d.kcs.map(cast) }))]));
    // float64: identical arithmetic; float32: Python's arm vectors and atan2 are float32 (~1e-6 relative on speeds)
    const tol = dtype === "float64" ? 1e-9 : 1e-5;
    for (const [k, [l, r]] of Object.entries(c.sweeps as Record<string, Any[]>)) {
      sweepClose(bestSweep(tracks.get(Number(k))!, c.fps, "left"), l, tol);
      sweepClose(bestSweep(tracks.get(Number(k))!, c.fps, "right"), r, tol);
    }
    const scores = scoreTracks(tracks, 0, c.fps, c.frame_h, stride);
    expect(scores.map((s) => s.track)).toEqual(c.scores.map((s: Any) => s.track));   // same ranking
    scores.forEach((s, i) => {
      const e = c.scores[i];
      expect([s.n, s.first, s.last, s.overhead_frames, isDelivery(s)])
        .toEqual([e.n, e.first, e.last, e.overhead_frames, e.is_delivery]);
      expect(rel(s.legs_visibility, e.legs_visibility)).toBeLessThan(1e-11);
      expect(rel(s.score, e.score)).toBeLessThan(tol);
      expect(rel(s.median_height, e.median_height)).toBeLessThan(tol);
      sweepClose(s.sweep, e.sweep, tol);
      expect(trackScoreDict(s)).toEqual(e.dict);
    });
  });
});
