/** Bio-mech replay (lib/biomech.ts): the body's travel, the arm's speed, the callouts and the timeline. */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { armSpeed, calloutsAt, replayScript, replayState, sampleJoints, sceneJoints, sides, speedColor, travel, LANDING_Z } from "../src/lib/biomech";
import type { AnalysisResult } from "../src/types";

const club = JSON.parse(readFileSync(new URL("../public/samples/club/bundle.json", import.meta.url), "utf8")).result as AnalysisResult;
const at = (k: "bfc" | "ffc" | "br") => club.events[k]!.frame - club.frames.start;

describe("the run through the crease", () => {
  const J = sceneJoints(club), s = sides(club.bowling_arm.arm === "right");
  it("keeps the planted foot still: the back foot from its landing to the front foot's, then the front foot", () => {
    const slide = (j: number, a: number, b: number) => Math.hypot(J[b][j][0] - J[a][j][0], J[b][j][2] - J[a][j][2]);
    expect(slide(s.backAnkle, at("bfc") + 1, at("ffc") - 1)).toBeLessThan(0.12);
    expect(slide(s.frontAnkle, at("ffc") + 1, at("br"))).toBeLessThan(0.12);
  });
  it("moves the bowler towards the batter and lands the front foot at the landing spot", () => {
    const off = travel(club);
    expect(off[at("br")][1]).toBeLessThan(off[0][1] - 0.5);
    expect(J[at("ffc")][s.frontAnkle][2]).toBeCloseTo(LANDING_Z, 5);
    for (let t = 1; t < off.length; t++) expect(Math.hypot(off[t][0] - off[t - 1][0], off[t][1] - off[t - 1][1])).toBeLessThan(10 / club.fps_real + 1e-6);
  });
  it("gives the joints between frames, and the frames themselves on whole numbers", () => {
    sampleJoints(J, 7)[3].forEach((v, c) => expect(v).toBeCloseTo(J[7][3][c], 9));
    const mid = sampleJoints(J, 7.5)[0];
    expect(mid[2]).toBeGreaterThan(Math.min(J[7][0][2], J[8][0][2]) - 0.05);
    expect(mid[2]).toBeLessThan(Math.max(J[7][0][2], J[8][0][2]) + 0.05);
    sampleJoints(J, 999)[0].forEach((v, c) => expect(v).toBeCloseTo(J[J.length - 1][0][c], 9));
  });
});

describe("arm speed", () => {
  it("peaks around release, at a speed a bowling hand reaches", () => {
    const v = armSpeed(club), top = Math.max(...v), i = v.indexOf(top);
    expect(Math.abs(i - at("br"))).toBeLessThanOrEqual(3);
    expect(top).toBeGreaterThan(8);
    expect(top).toBeLessThan(40);
  });
  it("colours slow blue and fast red", () => {
    const slow = speedColor(0), fast = speedColor(1);
    expect(slow[2]).toBeGreaterThan(slow[0]);
    expect(fast[0]).toBeGreaterThan(fast[2]);
    expect(speedColor(-3)).toEqual(slow);
    expect(speedColor(7)).toEqual(fast);
  });
});

describe("callouts", () => {
  it("only shows what the clip measured, worded by how it rates", () => {
    const b = calloutsAt(club, "bfc"), f = calloutsAt(club, "ffc"), r = calloutsAt(club, "br");
    expect(b.map((c) => c.key)).toEqual(["back_knee_bfc"]);                  // hip–shoulder separation isn't measured side-on
    expect(b[0]).toMatchObject({ title: "Back leg stays tall", detail: "Back knee angle 166°" });
    expect(f.map((c) => c.key)).toEqual(["front_knee_ffc", "stride_length_pct"]);
    expect(f[1].detail).toBe("Stride length 52% of height");                // the height wasn't given: no metres
    expect(r.map((c) => c.key)).toEqual(["release_height_pct", "trunk_forward_br", "front_knee_br"]);
    expect(r[2].title).toBe("Front knee softens");
  });
  it("gives metres when the bowler's height was entered, and nothing for an unrated estimate", () => {
    const tall = { ...club, skeleton: { ...club.skeleton, height_source: "user", stature_m: 1.9 } } as AnalysisResult;
    expect(calloutsAt(tall, "ffc")[1].detail).toBe("Stride length 0.99 m (52% of height)");
    const none = { ...club, metrics: club.metrics.map((m) => ({ ...m, reliability: "estimate" })) } as AnalysisResult;
    expect(calloutsAt(none, "br")).toEqual([]);
  });
});

describe("the timeline", () => {
  const sc = replayScript(club);
  it("goes video, the three stops in order, two replays, video", () => {
    expect(sc.segments[0].kind).toBe("video");
    expect(sc.segments[sc.segments.length - 1].kind).toBe("video");
    const holds = sc.segments.filter((s) => s.kind === "hold" && s.callouts.length).map((s) => s.title);
    expect(holds).toEqual(["Back foot contact", "Front foot contact", "Release"]);
    expect(sc.segments.filter((s) => s.title === "Replay")).toHaveLength(2);
    expect(sc.total).toBeGreaterThan(15);
    expect(sc.total).toBeLessThan(45);
    expect(sc.total).toBeCloseTo(sc.segments.reduce((a, s) => a + s.dur, 0), 6);
  });
  it("starts and ends on the video and never shows a frame outside the clip", () => {
    expect(replayState(sc, 0).video).toBe(1);
    expect(replayState(sc, sc.total).video).toBeGreaterThan(0.99);
    const T = club.skeleton3d.joints.length;
    for (let t = 0; t <= sc.total; t += 0.05) {
      const st = replayState(sc, t);
      expect(st.tf).toBeGreaterThanOrEqual(0);
      expect(st.tf).toBeLessThanOrEqual(T - 1);
      expect(st.video).toBeGreaterThanOrEqual(0);
      expect(st.video).toBeLessThanOrEqual(1);
      expect(Number.isFinite(st.shot.az + st.shot.el + st.shot.dist)).toBe(true);
    }
  });
  it("stops on each key frame with its callouts fully shown, and moves the camera smoothly between shots", () => {
    let acc = 0;
    for (const s of sc.segments) {
      if (s.kind === "hold" && s.callouts.length) {
        const st = replayState(sc, acc + s.dur / 2);
        expect(st.tf).toBe(s.from);
        expect(st.callout).toBe(1);
        expect(st.title).toBe(s.title);
      }
      acc += s.dur;
    }
    // no jump in the camera from one moment to the next, except the cuts to the two replays
    let jumps = 0, prev = replayState(sc, 0);
    for (let t = 0.02; t <= sc.total; t += 0.02) {
      const st = replayState(sc, t);
      if (st.video < 1 && prev.video < 1 && Math.abs(st.shot.az - prev.shot.az) > 6) jumps++;
      prev = st;
    }
    expect(jumps).toBeLessThanOrEqual(3);
  });
  it("still makes a replay when contacts are missing", () => {
    const bare = { ...club, events: { ...club.events, bfc: null, ffc: null } } as unknown as AnalysisResult;
    const s2 = replayScript(bare);
    expect(s2.total).toBeGreaterThan(8);
    expect(sceneJoints(bare)).toHaveLength(club.skeleton3d.joints.length);
  });
});
