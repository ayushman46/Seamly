/** Trust checks (lib/sanity.ts): a usable delivery, and a body that is really bowling. */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { concerns } from "../src/lib/sanity";
import type { AnalysisResult } from "../src/types";

const club = JSON.parse(readFileSync(new URL("../public/samples/club/bundle.json", import.meta.url), "utf8")).result as AnalysisResult;
const ev = (frame: number) => ({ frame, time: 0, confidence: 0.9, method: "detected" });

describe("trust checks", () => {
  it("has nothing to say about a sound analysis", () => {
    expect(concerns(club)).toEqual([]);
  });
  it("blocks an analysis whose key moments sit on top of each other (a shot that starts at release)", () => {
    const f0 = club.frames.start;
    const tiny = { ...club, frames: { ...club.frames, end: f0 + 3 }, events: { ...club.events, bfc: ev(f0), ffc: ev(f0), br: ev(f0) } } as unknown as AnalysisResult;
    expect(concerns(tiny)).toMatchObject([{ level: "block", key: "too_short" }]);
    expect(concerns(tiny)[0].text).toMatch(/^Only 3 frames/);
    // release two frames after back-foot contact at 25 fps (80 ms): still not a delivery stride
    const squashed = { ...club, events: { ...club.events, bfc: ev(club.events.br!.frame - 2) } } as unknown as AnalysisResult;
    expect(concerns(squashed)[0].key).toBe("too_short");
  });
  it("blocks a 'release' with the hand at chest height and a low release (a batter's swing), and warns when the hand is only just up", () => {
    const t = club.events.br!.frame - club.frames.start, w = club.bowling_arm.arm === "right" ? 10 : 9;
    const sy = (fr: number[][]) => (fr[5][1] + fr[6][1]) / 2;
    const torso = (fr: number[][]) => Math.hypot((fr[5][0] + fr[6][0] - fr[11][0] - fr[12][0]) / 2, sy(fr) - (fr[11][1] + fr[12][1]) / 2);
    // the wrist `up` torso lengths above the shoulders in the release frame and the one before
    const at = (up: number, rh?: number) => ({ ...club,
      keypoints2d: { ...club.keypoints2d, xy: club.keypoints2d.xy.map((fr, i) => (i === t || i === t - 1 ? fr.map((p, j) => (j === w ? [p[0], sy(fr) - up * torso(fr)] : p)) : fr)) },
      metrics: club.metrics.map((m) => (m.key === "release_height_pct" && rh !== undefined ? { ...m, value: rh } : m)) }) as AnalysisResult;
    expect(concerns(at(0.1, 75)).map((c) => [c.level, c.key])).toEqual([["block", "hand_below_head"]]);
    expect(concerns(at(0.1)).map((c) => [c.level, c.key])).toEqual([["warn", "hand_low"]]);     // a slinger: low arm, normal release height
    expect(concerns(at(0.45)).map((c) => [c.level, c.key])).toEqual([["warn", "hand_low"]]);
    expect(concerns(at(1.2))).toEqual([]);
  });
  it("warns about a release height no bowler has", () => {
    const tall = { ...club, metrics: club.metrics.map((m) => (m.key === "release_height_pct" ? { ...m, value: 120 } : m)) } as AnalysisResult;
    expect(concerns(tall)).toMatchObject([{ level: "warn", key: "release_height" }]);
    expect(concerns(tall)[0].text).toMatch(/120% of the bowler's height/);
  });
});
