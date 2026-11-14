/** Bio-mech replay (lib/biomech.ts): the body's travel, the arm's speed, the callouts and the timeline. */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { armSpeed, backLegDip, swingPlane, velocityAt, buildMotion, kineticChain, calloutsAt, findFlight, gaussian, replayScript, replayState, sampleJoints, sceneJoints, sides, speedColor, LANDING_Z } from "../src/lib/biomech";
import type { AnalysisResult } from "../src/types";
const J_HEAD = 10;

const club = JSON.parse(readFileSync(new URL("../public/samples/club/bundle.json", import.meta.url), "utf8")).result as AnalysisResult;
const at = (k: "bfc" | "ffc" | "br") => club.events[k]!.frame - club.frames.start;

describe("the run through the crease", () => {
  const J = sceneJoints(club), s = sides(club.bowling_arm.arm === "right");
  it("keeps the planted foot still: the back foot from its landing to the front foot's, then the front foot", () => {
    const slide = (j: number, a: number, b: number) => Math.hypot(J[b][j][0] - J[a][j][0], J[b][j][2] - J[a][j][2]);
    expect(slide(s.backAnkle, at("bfc") + 1, at("ffc") - 1)).toBeLessThan(0.12);
    expect(slide(s.frontAnkle, at("ffc") + 1, at("br"))).toBeLessThan(0.12);
  });
  it("moves the bowler towards the batter, lands the front foot at the landing spot, keeps every foot on or above the ground", () => {
    expect(J[at("br")][0][2]).toBeLessThan(J[0][0][2] - 0.5);
    expect(J[at("ffc")][s.frontAnkle][2]).toBeCloseTo(LANDING_Z, 5);
    for (let t = 1; t < J.length; t++) {
      expect(Math.hypot(J[t][0][0] - J[t - 1][0][0], J[t][0][2] - J[t - 1][0][2])).toBeLessThan(10 / club.fps_real + 0.02);
      expect(Math.min(J[t][3][1], J[t][6][1])).toBeGreaterThan(0.05);
    }
    // the planted ankles sit at ankle height
    expect(J[at("bfc") + 2][s.backAnkle][1]).toBeCloseTo(0.08, 1);
    expect(J[at("br")][s.frontAnkle][1]).toBeCloseTo(0.08, 1);
  });
  it("gives every bone one length for the whole delivery", () => {
    const parents = club.skeleton3d.parents;
    for (let j = 1; j < parents.length; j++) {
      const ls = J.map((fr) => Math.hypot(fr[j][0] - fr[parents[j]][0], fr[j][1] - fr[parents[j]][1], fr[j][2] - fr[parents[j]][2]));
      // the feet and hands are pushed up where they would go under the ground, nothing else changes length
      if (![3, 6].includes(j)) expect(Math.max(...ls) - Math.min(...ls)).toBeLessThan(0.012);
    }
  });
  it("gives each limb a bending axis that never flips between frames", () => {
    const m = buildMotion(club);
    for (let l = 0; l < 4; l++) for (let t = 1; t < m.hinges.length; t++) {
      const a = m.hinges[t - 1][l], b = m.hinges[t][l];
      expect(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]).toBeGreaterThan(0.6);
      expect(Math.hypot(...b)).toBeCloseTo(1, 5);
    }
    expect(buildMotion(club)).toBe(m);   // built once per analysis
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
    expect(b.map((c) => c.key)).toEqual(["back_knee_bfc", "trunk_bfc"]);     // hip–shoulder separation isn't measured side-on
    expect(b[1].detail).toMatch(/^Trunk \d+° from upright$/);
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
  it("goes video, a dissolve, the stops in order, a turn round the bowler, video", () => {
    expect(sc.segments[0]).toMatchObject({ kind: "video", from: 0, trail: true });      // the delivery, the arm's speed drawn over it
    expect(sc.segments[1]).toMatchObject({ kind: "video", fade: 1 });                  // back at the gather, fading into 3D
    expect(sc.segments[sc.segments.length - 1].kind).toBe("video");
    const holds = sc.segments.filter((s) => s.kind === "hold" && s.callouts.length).map((s) => s.title);
    expect(holds).toEqual(["Back foot contact", "Back leg", "Front foot contact", "Release"]);
    const orbit = sc.segments.filter((s) => s.orbit);
    expect(orbit).toHaveLength(1);
    expect(orbit[0]).toMatchObject({ title: "Skeleton, 3D", from: sc.br, to: sc.br });
    expect(Math.abs(orbit[0].shot!.drift * orbit[0].dur)).toBeGreaterThan(300);
    expect(orbit[0].strobe).toBe(true);
    expect(sc.ghosts.map((g) => g.label)).toEqual(["Back foot", "Front foot"]);         // nearly a full turn
    expect(sc.total).toBeGreaterThan(18);
    expect(sc.total).toBeLessThan(45);
    expect(sc.total).toBeCloseTo(sc.segments.reduce((a, s) => a + s.dur, 0), 6);
  });
  it("shows the back leg's deepest bend, lit green only when it holds firm", () => {
    const dip = backLegDip(club)!;
    expect(dip.t).toBeGreaterThan(at("bfc"));
    expect(dip.t).toBeLessThan(at("ffc"));
    const c = sc.segments.find((s) => s.title === "Back leg" && s.kind === "hold")!.callouts[0];
    expect(c.detail).toBe(`Back knee bends to ${Math.round(dip.angle)}°`);   // from the knees measured on the video
    expect(c.good).toBe(dip.angle >= 146);
    expect(c.limbs).toEqual(["leg_back"]);
    expect(backLegDip({ ...club, keypoints2d: undefined } as unknown as AnalysisResult)).toBeNull();   // no measured knees: no such stop
    // a camera behind doesn't see the knee bend: no such stop
    expect(replayScript({ ...club, view: { ...club.view, view: "behind" } } as AnalysisResult).segments.some((x) => x.title === "Back leg")).toBe(false);
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
    // no jump in the camera from one moment to the next (the turn round the bowler is 52° a second: 1° a step)
    let jumps = 0, prev = replayState(sc, 0);
    for (let t = 0.02; t <= sc.total; t += 0.02) {
      const st = replayState(sc, t);
      if (st.video < 1 && prev.video < 1 && Math.abs(st.shot.az - prev.shot.az) > 6) jumps++;
      prev = st;
    }
    expect(jumps).toBe(0);
  });
  it("still makes a replay when contacts are missing", () => {
    const bare = { ...club, events: { ...club.events, bfc: null, ffc: null } } as unknown as AnalysisResult;
    const s2 = replayScript(bare);
    expect(s2.total).toBeGreaterThan(8);
    expect(sceneJoints(bare)).toHaveLength(club.skeleton3d.joints.length);
  });
});

describe("the bound", () => {
  // a run-in where the front-side foot is down, then both feet are up for `air` frames, then the back foot lands
  function bound(air: number, fps = 60) {
    const s = sides(club.bowling_arm.arm === "right"), T = club.skeleton3d.joints.length, bfc = 30;
    const joints = Array.from({ length: T }, (_, t) => club.skeleton3d.joints[at("bfc")].map((p, j) => {
      const q = [...p] as [number, number, number];
      if (j === s.frontAnkle) q[1] = t <= bfc - air ? 0.08 : 0.3;
      if (j === s.backAnkle) q[1] = t >= bfc ? 0.08 : 0.28;
      return q;
    }));
    const ev = (f: number) => ({ frame: club.frames.start + f, time: 0, confidence: 0.9, method: "detected" });
    return { ...club, fps, fps_real: fps, keypoints2d: undefined, skeleton3d: { ...club.skeleton3d, joints }, events: { ...club.events, bfc: ev(bfc), ffc: ev(36), br: ev(39), ft: ev(41) } } as unknown as AnalysisResult;
  }
  it("times the flight from take-off to back-foot contact and gets the rise from gravity", () => {
    const f = findFlight(bound(18))!;                    // 18 frames at 60 fps: the foot leaves between frames 12 and 13
    expect([11, 12]).toContain(f.takeoff);              // within a frame
    expect(f.seconds).toBeCloseTo((30 - f.takeoff - 0.5) / 60, 6);
    expect(f.height).toBeCloseTo((9.81 * f.seconds ** 2) / 8, 6);   // about 10 cm
    expect(f.height).toBeGreaterThan(0.08);
    expect(f.height).toBeLessThan(0.13);
    const m = buildMotion(bound(18));
    expect(m.flight!.clearance).toBeGreaterThan(m.flight!.height);   // the legs are tucked up as well as the body rising
    expect(m.flight!.length).toBeGreaterThan(0.5);
    // the hips rise and come back down through the flight
    const y = m.joints.map((fr) => fr[0][1]);
    expect(Math.max(...y.slice(13, 30))).toBeGreaterThan(Math.max(y[12], y[30]) + 0.05);
  });
  it("says nothing when the clip doesn't show a bound, or its timing isn't believable", () => {
    expect(findFlight(club)).toBeNull();                 // the sample starts two frames before back-foot contact
    expect(findFlight(bound(60, 60))).toBeNull();        // the front-side foot is never down in the window
    expect(findFlight(bound(3, 60))).toBeNull();         // 40 ms: not a flight
    const guessed = bound(18); (guessed.events.bfc as { method: string }).method = "timing_prior";
    expect(findFlight(guessed)).toBeNull();              // the landing itself was only estimated
  });
  it("puts the stop at the top of the bound into the replay, with the clearance as an estimate", () => {
    const sc = replayScript(bound(18));
    const hold = sc.segments.find((x) => x.kind === "hold" && x.callouts.some((c) => c.key === "jump_clearance"))!;
    expect(hold.title).toBe("Jump / gather");
    expect(hold.callouts[0].detail).toMatch(/^Jump clearance ≈0\.\d\d m$/);
    expect(hold.callouts.map((c) => c.key)).toContain("jump_length");   // side-on: the run-in speed is seen
    const behind = replayScript({ ...bound(18), view: { ...club.view, view: "behind" } } as AnalysisResult);
    expect(behind.segments.flatMap((x) => x.callouts).map((c) => c.key)).not.toContain("jump_length");
  });
  it("filters without lag and leaves a constant alone", () => {
    expect(gaussian([2, 2, 2, 2], 1.5)).toEqual([2, 2, 2, 2]);
    const g = gaussian([0, 0, 1, 0, 0], 1);
    expect(g[2]).toBeGreaterThan(g[1]);
    expect(g[1]).toBeCloseTo(g[3], 9);
  });
});

describe("the kinetic chain", () => {
  it("finds when the hips, trunk, arm and hand are each fastest, the hand near release", () => {
    const k = kineticChain(club);
    expect(k.names).toEqual(["Hips", "Trunk", "Arm", "Hand"]);
    expect(Math.abs(k.peak[3] - at("br"))).toBeLessThanOrEqual(3);
    expect(k.top[2]).toBeGreaterThan(k.top[0]);                 // the arm turns faster than the hips
    expect(k.top[3]).toBeGreaterThan(8);                        // the hand: metres a second
    for (const row of k.speed) for (const v of row) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); }
    expect(k.timed).toBe(false);                                // 25 fps: too coarse to say the order
    expect(k.ordered).toBeNull();
  });
  it("judges the order only on slow-motion footage", () => {
    const fast = kineticChain({ ...club, fps: 120, fps_real: 120 } as AnalysisResult);
    expect(fast.timed).toBe(true);
    expect(typeof fast.ordered).toBe("boolean");
  });
});

describe("a camera behind or in front of the bowler", () => {
  const behind = { ...club, view: { ...club.view, view: "behind" } } as AnalysisResult;
  const m = buildMotion(behind), s = sides(club.bowling_arm.arm === "right"), P = m.joints;
  it("assumes the run-in, and says so", () => {
    expect(m.assumed).toBe(true);
    expect(buildMotion(club).assumed).toBe(false);
    expect(m.speed).toBeGreaterThanOrEqual(2.5);
    expect(m.speed).toBeLessThanOrEqual(6.5);
    expect(P[at("bfc")][0][2] - P[at("br")][0][2]).toBeGreaterThan(0.5);   // the hips travel through the crease
  });
  it("pins each planted foot and re-solves its leg without stretching a bone", () => {
    const still = (j: number, a: number, b: number) => Math.hypot(P[b][j][0] - P[a][j][0], P[b][j][2] - P[a][j][2]);
    expect(still(s.backAnkle, at("bfc"), at("ffc") - 1)).toBeLessThan(0.05);
    expect(still(s.frontAnkle, at("ffc"), at("br"))).toBeLessThan(0.05);
    // the front foot lands ahead of the hips, a stride from the back foot
    expect(P[at("ffc")][s.frontAnkle][2]).toBeLessThan(P[at("ffc")][0][2] - 0.3);
    expect(P[at("bfc")][s.backAnkle][2] - P[at("ffc")][s.frontAnkle][2]).toBeGreaterThan(0.7);
    const parents = club.skeleton3d.parents, len = (t: number, j: number) => Math.hypot(P[t][j][0] - P[t][parents[j]][0], P[t][j][1] - P[t][parents[j]][1], P[t][j][2] - P[t][parents[j]][2]);
    for (const j of [2, 5]) for (let t = at("bfc"); t <= at("br"); t++) expect(Math.abs(len(t, j) - len(0, j))).toBeLessThan(0.012);   // thighs
    for (const j of [3, 6]) for (let t = at("bfc"); t <= at("br"); t++) expect(len(t, j)).toBeLessThan(len(0, j) + 0.03);                // shins never stretch
    for (const fr of P) for (const q of fr) expect(Number.isFinite(q[0] + q[1] + q[2])).toBe(true);
  });
});

describe("the skeleton agrees with what was measured", () => {
  const angle = (P: number[][], a: number, b: number, c: number) => {
    const u = [0, 1, 2].map((k) => P[a][k] - P[b][k]), w = [0, 1, 2].map((k) => P[c][k] - P[b][k]);
    return (Math.acos((u[0] * w[0] + u[1] * w[1] + u[2] * w[2]) / (Math.hypot(...u) * Math.hypot(...w))) * 180) / Math.PI;
  };
  const m = buildMotion(club), s = sides(club.bowling_arm.arm === "right"), val = (k: string) => club.metrics.find((x) => x.key === k)!.value!;
  it("bends its knees to the angles measured on the video (side-on), not the looser 3D estimate", () => {
    expect(m.kneesMeasured).toBe(true);
    expect(angle(m.joints[at("bfc")], s.backHip, s.backKnee, s.backAnkle)).toBeCloseTo(val("back_knee_bfc"), -0.5);   // within about 1.5°
    expect(angle(m.joints[at("ffc")], s.frontHip, s.frontKnee, s.frontAnkle)).toBeCloseTo(val("front_knee_ffc"), -0.5);
    expect(angle(m.joints[at("br")], s.frontHip, s.frontKnee, s.frontAnkle)).toBeCloseTo(val("front_knee_br"), -0.5);
    // the raw 3D estimate had the back knee about 40° more bent than the video shows
    const raw = club.skeleton3d.joints[at("bfc")];
    expect(Math.abs(angle(raw, s.backHip, s.backKnee, s.backAnkle) - val("back_knee_bfc"))).toBeGreaterThan(20);
    // from behind the knees aren't measured: they are left to the estimate (and the leg solve)
    expect(buildMotion({ ...club, view: { ...club.view, view: "behind" } } as AnalysisResult).kneesMeasured).toBe(false);
  });
  it("puts the bowling wrist at the measured release height, and fades the change out away from release", () => {
    const h = (val("release_height_pct") / 100) * club.skeleton.stature_m;
    expect(m.joints[at("br")][s.wrist][1]).toBeCloseTo(h, 1);
    // a clip whose 3D arm is 7 cm low at release is lifted to the measurement
    const low = { ...club, metrics: club.metrics.map((x) => (x.key === "release_height_pct" ? { ...x, value: x.value! + 4 } : x)) } as AnalysisResult;
    const m2 = buildMotion(low), h2 = ((val("release_height_pct") + 4) / 100) * club.skeleton.stature_m;
    expect(m2.joints[at("br")][s.wrist][1]).toBeCloseTo(h2, 1);
    expect(Math.abs(m2.joints[0][s.wrist][1] - m.joints[0][s.wrist][1])).toBeLessThan(0.02);   // nothing changed early in the clip
    const parents = club.skeleton3d.parents;
    for (const j of [s.elbow, s.wrist]) {
      const l = (P: number[][]) => Math.hypot(P[j][0] - P[parents[j]][0], P[j][1] - P[parents[j]][1], P[j][2] - P[parents[j]][2]);
      expect(l(m2.joints[at("br")])).toBeCloseTo(l(m.joints[0]), 2);   // the arm is turned, not stretched
    }
  });
});

describe("the swing plane and the vectors", () => {
  const behind = JSON.parse(readFileSync(new URL("../public/samples/nets-behind/bundle.json", import.meta.url), "utf8")).result as AnalysisResult;
  const front = JSON.parse(readFileSync(new URL("../public/samples/club-front/bundle.json", import.meta.url), "utf8")).result as AnalysisResult;
  const slot = (r: AnalysisResult) => r.metrics.find((q) => q.key === "arm_slot_br")!.value!;
  it("leans the skeleton's bowling arm by the arm slot measured on the video, behind and in front", () => {
    for (const r of [behind, front]) {
      const m = buildMotion(r), sp = swingPlane(r)!;
      expect(m.slotMeasured).toBe(true);
      expect(sp.measured).toBeCloseTo(slot(r), 6);
      expect(Math.abs(sp.tilt - slot(r))).toBeLessThan(0.5);      // the arm drawn is the arm measured
      // ... and the hand stays as high as it was without the lean, to within a few centimetres (leaning an arm that
      // is already at full stretch lowers it by 1 - cos of the lean)
      const s = sides(r.bowling_arm.arm === "right");
      const plain = buildMotion({ ...r, metrics: r.metrics.filter((q) => q.key !== "arm_slot_br") } as AnalysisResult);
      expect(plain.slotMeasured).toBe(false);
      expect(Math.abs(m.joints[sp.release][s.wrist][1] - plain.joints[sp.release][s.wrist][1])).toBeLessThan(0.05);
      // the arm leans out to its own side, away from the head
      const P = m.joints[sp.release];
      expect(Math.sign(P[s.wrist][0] - P[s.shoulder][0])).toBe(Math.sign(P[s.shoulder][0] - P[J_HEAD][0]));
    }
  });
  it("changes the arm only round release, and stretches no bone", () => {
    const m = buildMotion(behind), s = sides(behind.bowling_arm.arm === "right"), br = swingPlane(behind)!.release;
    const len = (t: number, a: number, b: number) => Math.hypot(m.joints[t][a][0] - m.joints[t][b][0], m.joints[t][a][1] - m.joints[t][b][1], m.joints[t][a][2] - m.joints[t][b][2]);
    for (const t of [0, br - 3, br, Math.min(m.joints.length - 1, br + 3)]) {
      expect(len(t, s.shoulder, s.elbow)).toBeCloseTo(len(0, s.shoulder, s.elbow), 2);
      expect(len(t, s.elbow, s.wrist)).toBeCloseTo(len(0, s.elbow, s.wrist), 2);
    }
    // frame to frame the wrist never jumps: the turn is eased in and out
    const fps = behind.fps_real;
    for (let t = 1; t < m.joints.length; t++) expect(len(t, s.wrist, s.wrist) + Math.hypot(...[0, 1, 2].map((i) => m.joints[t][s.wrist][i] - m.joints[t - 1][s.wrist][i]))).toBeLessThan(45 / fps);
  });
  it("gives the plane that holds the pitch's line and the arm at release: a level unit normal, square to the arm", () => {
    for (const r of [club, behind, front]) {
      const sp = swingPlane(r)!, P = sceneJoints(r)[sp.release], s = sides(r.bowling_arm.arm === "right");
      expect(Math.hypot(...sp.normal)).toBeCloseTo(1, 9);
      expect(sp.normal[2]).toBe(0);                                  // the pitch's line lies in the plane
      const a = [0, 1, 2].map((i) => P[s.wrist][i] - P[s.shoulder][i]);
      expect(Math.abs(a[0] * sp.normal[0] + a[1] * sp.normal[1])).toBeLessThan(1e-9);   // so does the arm
      expect(sp.radius).toBeGreaterThan(0.5);
      expect(sp.radius).toBeLessThan(1.0);
    }
  });
  it("gives no number side-on (the lean is along the camera's line of sight), and no plane without a release", () => {
    expect(buildMotion(club).slotMeasured).toBe(false);
    expect(swingPlane(club)!.measured).toBeNull();
    expect(swingPlane({ ...club, events: { ...club.events, br: null } } as AnalysisResult)).toBeNull();
  });
  it("gives the hand's velocity as a vector whose length is its speed, eased between frames", () => {
    const J2 = sceneJoints(club), s = sides(club.bowling_arm.arm === "right"), fps = club.fps_real;
    const v = velocityAt(J2, s.wrist, at("br"), fps), speed = Math.hypot(...v);
    expect(speed).toBeGreaterThan(8);
    expect(speed).toBeLessThan(40);
    expect(v[2]).toBeLessThan(0);              // towards the batter
    const a = velocityAt(J2, s.wrist, at("br") - 1, fps), b = velocityAt(J2, s.wrist, at("br") - 0.5, fps);
    expect(b[2]).toBeCloseTo((a[2] + v[2]) / 2, 6);
  });
});
