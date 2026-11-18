import { describe, expect, it } from "vitest";
import { solveCamera, isCamera, project, worldOf, type Camera, type Mark, type MarkKind } from "../src/lib/camcal";
import { measureOnPitch, frameMaps, recordOnPitch, cleanOnPitch, HEEL_Y, TOE_Y } from "../src/lib/onpitch";
import type { AnalysisResult } from "../src/types";
import type { V3 } from "../src/lib/biomech";

/** A camera at `pos` looking at `at`, as a phone on a tripod behind the bowler's arm. */
function cameraAt(pos: V3, at: V3, f: number, w = 1920, h = 1080): Camera {
  const z = [at[0] - pos[0], at[1] - pos[1], at[2] - pos[2]], n = Math.hypot(z[0], z[1], z[2]);
  const zc = z.map((v) => v / n), x0 = [-zc[2], 0, zc[0]], nx = Math.hypot(x0[0], x0[2]), xc = x0.map((v) => v / nx);
  const yc = [zc[1] * xc[2] - zc[2] * xc[1], zc[2] * xc[0] - zc[0] * xc[2], zc[0] * xc[1] - zc[1] * xc[0]];
  const R = [...xc, ...yc, ...zc], t: V3 = [0, 1, 2].map((i) => -(R[3 * i] * pos[0] + R[3 * i + 1] * pos[1] + R[3 * i + 2] * pos[2])) as V3;
  const truth = { f, R, t, w, h };
  const marks: Mark[] = [];
  for (const end of ["bowler", "batter"] as const) for (const kind of ["pop_l", "pop_r", "bowl_l", "bowl_r", "stump_base", "stump_top"] as MarkKind[]) marks.push({ end, kind, px: project(truth, worldOf({ end, kind }))! });
  const cam = solveCamera(marks, w, h);
  if (!isCamera(cam)) throw new Error("no camera");
  return cam;
}

const H = 1.8, FPS = 60, T = 70, BFC = 36, FFC = 48, BR = 56;
const BACK0: V3 = [-0.28, 0, 0.72], BACK = BACK0, FRONT: V3 = [-0.52, 0, -0.66];   // heels on the ground
/** A stick bowler: runs towards -z at 6 m/s, plants the back then the front foot, lets go above the front foot. */
function bowler(t: number, frontHeel = FRONT, BACK: V3 = BACK0) {
  const zRun = BACK[2] + 0.1 + (BFC - t) * (6 / FPS);
  const pelvisZ = t < BFC ? zRun : t < FFC ? BACK[2] - 0.1 + ((frontHeel[2] + 0.45 - (BACK[2] - 0.1)) * (t - BFC)) / (FFC - BFC) : frontHeel[2] + 0.45 - (0.25 * Math.min(1, (t - FFC) / (BR - FFC)));
  const x = -0.4;
  const heelR: V3 = t < BFC ? [x + 0.12, (t % 12 < 6 ? 0 : 0.25), zRun + (t % 12 < 6 ? 0 : 0.5)] : [BACK[0], t < FFC + 2 ? 0 : 0.3, BACK[2]];
  const heelL: V3 = t < FFC ? (t < BFC ? [x - 0.12, (t % 12 < 6 ? 0.25 : 0), zRun + (t % 12 < 6 ? 0.5 : 0)] : [frontHeel[0], 0.2, pelvisZ]) : [frontHeel[0], 0, frontHeel[2]];
  // in the run-up one heel is always on the ground under the hips
  if (t < BFC) { if (t % 12 < 6) { heelR[2] = zRun; } else { heelL[2] = zRun; } }
  const J: V3[] = Array.from({ length: 17 }, () => [x, 1.0, pelvisZ] as V3);
  J[0] = [x, H - 0.12, pelvisZ]; J[5] = [x - 0.2, 1.48, pelvisZ]; J[6] = [x + 0.2, 1.48, pelvisZ];
  J[11] = [x - 0.13, 0.98, pelvisZ]; J[12] = [x + 0.13, 0.98, pelvisZ];
  J[13] = [heelL[0], heelL[1] + 0.5, heelL[2] - 0.05]; J[14] = [heelR[0], heelR[1] + 0.5, heelR[2] - 0.05];
  J[15] = [heelL[0], heelL[1] + 0.08, heelL[2] - 0.07]; J[16] = [heelR[0], heelR[1] + 0.08, heelR[2] - 0.07];
  // the bowling arm (right): straight up above the front ankle at release
  const az = frontHeel[2] - 0.07;
  J[8] = [x + 0.22, 1.78, az]; J[10] = [x + 0.24, 2.04, az]; J[7] = [x - 0.3, 1.2, pelvisZ]; J[9] = [x - 0.35, 0.95, pelvisZ];
  const head: V3 = [x, H, pelvisZ];
  return { J, heelL, heelR, head };
}
function resultFor(cam: Camera, opts: { frontHeel?: V3; backHeel?: V3; ds?: number; pan?: number } = {}): AnalysisResult {
  const ds = opts.ds ?? 0.5, xy: [number, number][][] = [], conf: number[][] = [], feet: number[][][] = [], motion: number[][][] = [];
  for (let t = 0; t < T; t++) {
    const b = bowler(t, opts.frontHeel, opts.backHeel), dx = (opts.pan ?? 0) * (t - BR);   // the camera pans: the picture slides by dx pixels (none in the marked frame)
    const px = (p: V3): [number, number] => { const q = project(cam, p)!; return [(q[0] + dx) * ds, q[1] * ds]; };
    xy.push(b.J.map(px)); conf.push(b.J.map(() => 0.9));
    const lh: V3 = [b.heelL[0], b.heelL[1] + HEEL_Y, b.heelL[2]], rh: V3 = [b.heelR[0], b.heelR[1] + HEEL_Y, b.heelR[2]];
    const lt: V3 = [b.heelL[0], b.heelL[1] + TOE_Y, b.heelL[2] - 0.27], rt: V3 = [b.heelR[0], b.heelR[1] + TOE_Y, b.heelR[2] - 0.27];
    feet.push([[...px(b.head), 0.9], [0, 0, 0], [0, 0, 0], [...px(lt), 0.9], [...px(rt), 0.9], [...px(lt), 0.9], [...px(rt), 0.9], [...px(lh), 0.9], [...px(rh), 0.9]]);
    motion.push([[1, 0, t ? (opts.pan ?? 0) : 0], [0, 1, 0]]);
  }
  const ev = (f: number) => ({ frame: f, time: f / FPS, confidence: 1 });
  return { video: { width: cam.w, height: cam.h, fps: FPS, frame_count: T, duration: T / FPS, shots: [] }, display_scale: ds, fps: FPS, fps_real: FPS,
    frames: { start: 0, end: T, times: [] }, bowling_arm: { arm: "right", confidence: 1, source: "user" },
    events: { bfc: ev(BFC), ffc: ev(FFC), uah: null, br: ev(BR), ft: null }, keypoints2d: { names: [], xy, conf }, feet, camera_motion: motion,
  } as unknown as AnalysisResult;
}

describe("measuring on the pitch", () => {
  const cams: [string, Camera][] = [
    ["phone on a tall tripod", cameraAt([0.9, 3.4, 10.5], [0, 0.6, -10], 1180 * 1.5)],
    ["tripod at chest height", cameraAt([-0.5, 1.45, 6], [0, 0.9, -10], 1500)],
    ["broadcast, long lens", cameraAt([1.5, 16, 84], [0, 0, -7.5], 11500)],
  ];
  for (const [name, cam] of cams) {
    it(`puts the feet, the release and the bowler's height where they are: ${name}`, () => {
      const o = measureOnPitch(resultFor(cam), cam, BR)!;
      expect(o.still).toBe(true);
      expect(o.back!.heel[0]).toBeCloseTo(BACK[0], 2); expect(o.back!.heel[2]).toBeCloseTo(BACK[2], 1);
      expect(o.front!.heel[0]).toBeCloseTo(FRONT[0], 2); expect(o.front!.heel[2]).toBeCloseTo(FRONT[2], 1);
      expect(Math.abs(o.stride!.value - Math.hypot(FRONT[0] - BACK[0], FRONT[2] - BACK[2]))).toBeLessThan(0.03);
      // the ball in the hand: 35% of the forearm beyond the wrist
      expect(Math.abs(o.release!.height.value - (2.04 + 0.35 * 0.26))).toBeLessThan(0.02);
      expect(Math.abs(o.release!.across.value - (-0.4 + 0.24 + 0.35 * 0.02))).toBeLessThan(0.02);
      expect(Math.abs(o.stature!.value - H)).toBeLessThan(0.05);
      expect(Math.abs(o.runup!.value - 21.6)).toBeLessThan(2.5);
      expect(o.popping!.verdict).toBe("legal");
      expect(Math.abs(o.popping!.margin.value - (FRONT[2] + 1.22))).toBeLessThan(0.03);
      // each figure's own doubt is honest: small, and not zero
      expect(o.release!.height.sigma).toBeGreaterThan(0.005); expect(o.release!.height.sigma).toBeLessThan(0.12);
      expect(o.body[BR]![10][1]).toBeGreaterThan(1.9);
    });
  }
  it("calls a heel over the popping crease a no-ball, and one on it too close", () => {
    const cam = cams[0][1];
    expect(measureOnPitch(resultFor(cam, { frontHeel: [-0.52, 0, -1.55], backHeel: [-0.28, 0, -0.15] }), cam, BR)!.popping!.verdict).toBe("no_ball");
    expect(measureOnPitch(resultFor(cam, { frontHeel: [-0.52, 0, -1.24], backHeel: [-0.28, 0, 0.1] }), cam, BR)!.popping!.verdict).toBe("close");
  });
  it("measures nothing from a front foot that cannot be where the model put it", () => {
    // a "stride" of 30 cm: the front foot was hidden behind the back leg and guessed at
    const cam = cams[0][1], o = measureOnPitch(resultFor(cam, { frontHeel: [-0.52, 0, 0.4] }), cam, BR)!;
    expect(o.frontSeen).toBe(false);
    expect(o.front).toBeNull(); expect(o.stride).toBeNull(); expect(o.popping).toBeNull();
    // the release is still measured, a usual stride ahead of the back foot, with a wider doubt
    const seen = measureOnPitch(resultFor(cam), cam, BR)!;
    expect(o.release).not.toBeNull();
    expect(o.release!.height.sigma).toBeGreaterThan(seen.release!.height.sigma);
  });
  it("follows a camera that pans", () => {
    const cam = cams[0][1], r = resultFor(cam, { pan: 6 });
    expect(frameMaps(r, cam, BR).still).toBe(false);
    const o = measureOnPitch(r, cam, BR)!;
    expect(o.front!.heel[0]).toBeCloseTo(FRONT[0], 2);
    expect(Math.abs(o.release!.height.value - (2.04 + 0.35 * 0.26))).toBeLessThan(0.02);
    // without the camera's movement the same clip reads wrong: the test would not pass by accident
    const blind = measureOnPitch({ ...r, camera_motion: undefined }, cam, BR)!;
    expect(Math.abs(blind.back!.heel[0] - BACK[0])).toBeGreaterThan(0.2);
  });
  it("falls back to the ankles when the feet's own points are missing", () => {
    const cam = cams[0][1], r = resultFor(cam);
    const o = measureOnPitch({ ...r, feet: undefined }, cam, BR)!;
    expect(o.front!.from).toBe("ankle");
    expect(Math.abs(o.front!.heel[2] - FRONT[2])).toBeLessThan(0.08);
    expect(o.popping).toBeNull();          // the crease call needs the heel itself
    expect(o.stature).toBeNull();
  });
  it("keeps and restores its record", () => {
    const cam = cams[0][1], o = measureOnPitch(resultFor(cam), cam, BR)!;
    const marks: Mark[] = [{ end: "bowler", kind: "stump_base", px: [1, 2] }, { end: "bowler", kind: "stump_top", px: [1, 2] }, { end: "batter", kind: "stump_base", px: [1, 2] }, { end: "batter", kind: "stump_top", px: [1, 2] }];
    const rec = recordOnPitch(o, cam, BR, marks);
    expect(cleanOnPitch(JSON.parse(JSON.stringify(rec)))).toEqual(rec);
    expect(cleanOnPitch({ ...rec, marks: marks.slice(0, 2) })).toBeNull();
    expect(cleanOnPitch({ ...rec, release: [1, NaN, 2] })!.release).toBeNull();
  });
});

import { solveLevelCamera } from "../src/lib/camcal";
describe("a camera from four taps on the stumps", () => {
  const worlds: V3[] = [[0, 0, 0], [0, 0.711, 0], [0, 0, -20.12], [0, 0.711, -20.12]];
  const views: [string, V3, V3, number][] = [["phone on a tall tripod", [0.9, 3.4, 10.5], [0, 0.6, -10], 1770], ["tripod at chest height", [-0.5, 1.45, 6], [0, 0.9, -10], 1500],
    ["umpire's eye", [0.3, 1.7, 3.5], [0, 0.8, -10], 1400], ["broadcast", [1.5, 16, 84], [0, 0, -7.5], 11500]];
  for (const [name, pos, at, f] of views) {
    it(`finds the camera exactly from exact taps: ${name}`, () => {
      const truth = cameraAt(pos, at, f);
      const cam = solveLevelCamera(worlds.map((world) => ({ world, px: project(truth, world)! })), 1920, 1080);
      if (!isCamera(cam)) throw new Error("no camera");
      expect(cam.rms).toBeLessThan(0.05);
      for (let i = 0; i < 3; i++) expect(Math.abs(cam.pos[i] - pos[i])).toBeLessThan(0.02 * Math.hypot(...pos) + 0.02);
      expect(Math.abs(cam.f / f - 1)).toBeLessThan(0.01);
    });
    if (name !== "umpire's eye") it(`taps a pixel and a half out move the measured release by a few centimetres: ${name}`, () => {
      const truth = cameraAt(pos, at, f), r = resultFor(truth), o0 = measureOnPitch(r, truth, BR)!;
      // a fixed spread of tap errors (the same every run)
      let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
      const eh: number[] = [], ex: number[] = [], ez: number[] = [];
      for (let k = 0; k < 40; k++) {
        const cam = solveLevelCamera(worlds.map((world) => { const p = project(truth, world)!; return { world, px: [p[0] + 3 * rnd() * 1.5, p[1] + 3 * rnd() * 1.5] as [number, number] }; }), 1920, 1080);
        if (!isCamera(cam)) continue;
        const o = measureOnPitch(r, cam, BR)!;
        eh.push(o.release!.height.value - o0.release!.height.value); ex.push(o.release!.across.value - o0.release!.across.value); ez.push(o.front!.heel[2] - o0.front!.heel[2]);
      }
      const rms = (v: number[]) => Math.sqrt(v.reduce((s, e) => s + e * e, 0) / v.length);
      console.log(`${name}: ${eh.length} of 40 solved; release height ${(rms(eh) * 100).toFixed(1)} cm, across ${(rms(ex) * 100).toFixed(1)} cm, front heel down the pitch ${(rms(ez) * 100).toFixed(1)} cm (rms)`);
      expect(eh.length).toBeGreaterThanOrEqual(38);
    });
  }
});

import { measureWithDoubt } from "../src/lib/onpitch";
describe("the camera's own doubt", () => {
  const sets: [string, [("bowler" | "batter"), MarkKind][]][] = [
    ["four taps on the stumps", [["bowler", "stump_base"], ["bowler", "stump_top"], ["batter", "stump_base"], ["batter", "stump_top"]]],
    ["eight crease corners, no stump", (["bowler", "batter"] as const).flatMap((e) => (["pop_l", "pop_r", "bowl_l", "bowl_r"] as MarkKind[]).map((k) => [e, k] as ["bowler" | "batter", MarkKind]))],
    ["creases and stumps", (["bowler", "batter"] as const).flatMap((e) => (["pop_l", "pop_r", "bowl_l", "bowl_r", "stump_base", "stump_top"] as MarkKind[]).map((k) => [e, k] as ["bowler" | "batter", MarkKind]))],
  ];
  for (const [vn, pos, at, f] of [["phone on a tall tripod", [0.9, 3.4, 10.5], [0, 0.6, -10], 1770], ["tripod at chest height", [-0.5, 1.45, 6], [0, 0.9, -10], 1500], ["broadcast", [1.5, 16, 84], [0, 0, -7.5], 11500]] as [string, V3, V3, number][]) {
    for (const [sn, ids] of sets) it(`is carried into the figures: ${vn}, ${sn}`, () => {
      const truth = cameraAt(pos, at, f), r = resultFor(truth);
      const marks: Mark[] = ids.map(([end, kind]) => ({ end, kind, px: project(truth, worldOf({ end, kind }))! }));
      const m = measureWithDoubt(r, marks, 1920, 1080, BR)!;
      const plain = measureOnPitch(r, m.cam, BR)!;
      console.log(`${vn}, ${sn}: release height ± ${(m.o.release!.height.sigma * 100).toFixed(1)} cm (camera known exactly: ${(plain.release!.height.sigma * 100).toFixed(1)}), across ± ${(m.o.release!.across.sigma * 100).toFixed(1)}, front heel down the pitch ± ${(m.o.front!.sz * 100).toFixed(1)} (${(plain.front!.sz * 100).toFixed(1)}), height ${m.o.release!.height.value.toFixed(3)}`);
      expect(m.o.release!.height.sigma).toBeGreaterThanOrEqual(plain.release!.height.sigma);
      expect(Math.abs(m.o.release!.height.value - (2.04 + 0.35 * 0.26))).toBeLessThan(0.03);
    });
  }
});
