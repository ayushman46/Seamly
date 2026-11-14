import { describe, expect, it } from "vitest";
import { solveCamera, project, worldOf, isCamera, type Camera, type Mark, type MarkId, type Pt } from "../src/lib/camcal";
import { scan, autoTrack, withDoubt, refit, recordOf, fromRecord, shiftsOf, trackedRead, type FrameGetter, type PoseHints } from "../src/lib/tracker";
import { grayOf, motion, blobs, STILL } from "../src/lib/ballfind";
import { isTracked } from "../src/lib/balltrack";
import { fly, ballAt, aimAt, BALL_R } from "../src/lib/flight";
import type { V3 } from "../src/lib/biomech";
import type { AnalysisResult } from "../src/types";

/**
 * A small film studio: a regulation pitch on textured turf, seen by a pinhole camera that can zoom, with a ball
 * flying by lib/flight.ts and its shadow under a sun. Everything the tracker is asked to find is known exactly.
 */
const W = 960, H = 540;
function camAt(pos: V3, at: V3, f: number) {
  const z = [at[0] - pos[0], at[1] - pos[1], at[2] - pos[2]]; const n = Math.hypot(z[0], z[1], z[2]); const zc = z.map((v) => v / n);
  let xc = [-zc[2], 0, zc[0]]; const nx = Math.hypot(xc[0], xc[2]); xc = xc.map((v) => v / nx);
  const yc = [zc[1] * xc[2] - zc[2] * xc[1], zc[2] * xc[0] - zc[0] * xc[2], zc[0] * xc[1] - zc[1] * xc[0]];
  const R = [...xc, ...yc, ...zc];
  const t: V3 = [-(R[0] * pos[0] + R[1] * pos[1] + R[2] * pos[2]), -(R[3] * pos[0] + R[4] * pos[1] + R[5] * pos[2]), -(R[6] * pos[0] + R[7] * pos[1] + R[8] * pos[2])];
  return { f, R, t, w: W, h: H, pos };
}
const hash = (a: number, b: number) => { let h = (a * 374761393 + b * 668265263) | 0; h = (h ^ (h >>> 13)) * 1274126177; return ((h ^ (h >>> 16)) >>> 0) / 4294967295; };
/** The ground's colour at a point: turf, the pitch strip, scuffs, and the creases painted to the Laws' sizes. */
function ground(x: number, z: number, out: number[]) {
  const n = hash(Math.floor(x / 0.06), Math.floor(z / 0.06)) - 0.5, n2 = hash(Math.floor(x / 0.5) + 99, Math.floor(z / 0.5)) - 0.5;
  const onPitch = Math.abs(x) < 1.525 && z < 1.22 && z > -21.34;
  let r = onPitch ? 200 : 70, g = onPitch ? 185 : 125, b = onPitch ? 145 : 60;
  const v = 30 * n + 22 * n2; r += v; g += v; b += v;
  const line = (x0: number, x1: number, z0: number, z1: number) => x >= x0 && x <= x1 && z >= Math.min(z0, z1) && z <= Math.max(z0, z1);
  for (const [zs, to] of [[0, -1], [-20.12, 1]] as const) {
    if (line(-1.36, 1.36, zs, zs + to * 0.04) || line(-1.83, 1.83, zs + to * 1.22, zs + to * 1.26) || line(1.32, 1.36, zs + to * 1.26, zs - to * 1.22) || line(-1.36, -1.32, zs + to * 1.26, zs - to * 1.22)) { r = g = b = 240; }
  }
  out[0] = r; out[1] = g; out[2] = b;
}
interface Film { frames: Uint8ClampedArray[]; cams: ReturnType<typeof camAt>[]; ball: (Pt | null)[]; fps: number; release: number; path: ReturnType<typeof fly>; from: V3; fall: [number, number] | null }
function film(o: { fps: number; kmh: number; length: number; line: number; swing: number; zoom?: number; sun?: boolean; pos?: V3; f?: number }): Film {
  const fps = o.fps, release = Math.round(0.3 * fps), from: V3 = [-0.5, 2.05, -1.1];
  const launch = aimAt(from, o.kmh / 3.6, { length: o.length, line: o.line }, o.swing)!, path = fly(launch);
  const tEnd = path.crease!.t + 0.02, n = release + Math.ceil(tEnd * fps) + 2;
  const fall: [number, number] | null = o.sun === false ? null : [0.5, -0.15];
  const frames: Uint8ClampedArray[] = [], cams: Film["cams"] = [], ball: (Pt | null)[] = [], c3 = [0, 0, 0];
  let seed = 9; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  for (let i = 0; i < n; i++) {
    const u = Math.max(0, Math.min(1, (i - release + 3) / (n - release))), cam = camAt(o.pos ?? [0.8, 4.2, 11], [0, 0.5, -9.5 - 2 * u * ((o.zoom ?? 1) - 1)], (o.f ?? 950) * (1 + ((o.zoom ?? 1) - 1) * u));
    cams.push(cam);
    const img = new Uint8ClampedArray(W * H * 4), R = cam.R;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const dx = (x - W / 2) / cam.f, dy = (y - H / 2) / cam.f;
      const wx = R[0] * dx + R[3] * dy + R[6], wy = R[1] * dx + R[4] * dy + R[7], wz = R[2] * dx + R[5] * dy + R[8];
      const k = (y * W + x) * 4;
      if (wy >= -1e-4) { img[k] = 60; img[k + 1] = 80; img[k + 2] = 70; } else { const s = -cam.pos[1] / wy; ground(cam.pos[0] + wx * s, cam.pos[2] + wz * s, c3); img[k] = c3[0]; img[k + 1] = c3[1]; img[k + 2] = c3[2]; }
      img[k + 3] = 255;
    }
    const t = (i - release) / fps - 0.35 / fps;   // released a third of a frame after the release frame
    const disc = (p: V3, colour: number[], strength: number) => {
      const q = project(cam, p); if (!q) return null;
      const depth = Math.hypot(p[0] - cam.pos[0], p[1] - cam.pos[1], p[2] - cam.pos[2]), r = Math.max(1.3, (cam.f * BALL_R) / depth);
      for (let y = Math.floor(q[1] - r - 1); y <= q[1] + r + 1; y++) for (let x = Math.floor(q[0] - r - 1); x <= q[0] + r + 1; x++) {
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        let cover = 0;
        for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) if (Math.hypot(x + (a + 0.5) / 4 - 0.5 - q[0], y + (b + 0.5) / 4 - 0.5 - q[1]) <= r) cover++;
        const al = (cover / 16) * strength, k = (y * W + x) * 4;
        for (let c = 0; c < 3; c++) img[k + c] = img[k + c] * (1 - al) + colour[c] * al;
      }
      return q;
    };
    if (t > 0 && t < tEnd) {
      const p = ballAt(path, t);
      if (fall) disc([p[0] + fall[0] * p[1], 0, p[2] + fall[1] * p[1]], [40, 50, 30], 0.75);
      ball.push(disc(p, [190, 30, 40], 1));
    } else ball.push(null);
    for (let k = 0; k < img.length; k += 4) { const e = 5 * rnd(); img[k] += e; img[k + 1] += e; img[k + 2] += e; }
    frames.push(img);
  }
  return { frames, cams, ball, fps, release, path, from, fall };
}
const IDS: MarkId[] = (["bowler", "batter"] as const).flatMap((end) => (["pop_l", "pop_r", "bowl_l", "bowl_r"] as const).map((kind) => ({ end, kind })));
function setup(F: Film, markFrame: number) {
  const marks: Mark[] = IDS.map((id) => ({ ...id, px: project(F.cams[markFrame], worldOf(id))! }));
  const cam = solveCamera(marks, W, H) as Camera;
  const getter: FrameGetter = { w: W, h: H, get: async (f) => F.frames[f] };
  const hints: PoseHints = { releaseFrame: F.release, hand: project(F.cams[F.release], F.from), ankles: [project(F.cams[F.release], [F.from[0], 0.09, F.from[2] - 0.15])!],
    releaseHeight: null, time: (f) => f / F.fps, fps: F.fps, first: 0, last: F.frames.length - 1 };
  return { marks, cam, getter, hints };
}

describe("finding a moving ball in frames", () => {
  it("measures a zoom and shift between two frames to a fraction of a pixel", () => {
    const F = film({ fps: 30, kmh: 120, length: 6, line: 0, swing: 0, zoom: 1.5 });
    const a = grayOf(F.frames[14], W, H), b = grayOf(F.frames[15], W, H), m = motion(a, b);
    // the truth, from where two ground points land in each frame
    const g1: V3 = [-1.3, 0, -3], g2: V3 = [1.2, 0, -16], p1 = project(F.cams[14], g1)!, p2 = project(F.cams[14], g2)!, q1 = project(F.cams[15], g1)!, q2 = project(F.cams[15], g2)!;
    expect(Math.hypot(m.s * p1[0] + m.dx - q1[0], m.s * p1[1] + m.dy - q1[1])).toBeLessThan(0.6);
    expect(Math.hypot(m.s * p2[0] + m.dx - q2[0], m.s * p2[1] + m.dy - q2[1])).toBeLessThan(0.6);
    expect(m.s).toBeGreaterThan(1.005);
  });
  it("a still camera reads as still, and the ball is the strongest blob, centred to half a pixel", () => {
    const F = film({ fps: 30, kmh: 120, length: 6, line: 0, swing: 0 });
    const i = F.release + 5, m = motion(grayOf(F.frames[i - 1], W, H), grayOf(F.frames[i], W, H));
    expect(Math.abs(m.s - 1)).toBeLessThan(0.001); expect(Math.hypot(m.dx, m.dy)).toBeLessThan(0.5);
    const bl = blobs(F.frames[i - 1], F.frames[i], F.frames[i + 1], W, H, STILL, STILL);
    expect(bl.length).toBeGreaterThan(0);
    expect(bl.length).toBeLessThan(12);   // the ball, its shadow, and little else
    expect(Math.min(...bl.map((b) => Math.hypot(b.x - F.ball[i]![0], b.y - F.ball[i]![1])))).toBeLessThan(0.6);
  });
});

describe("ball tracking, end to end, on a rendered delivery", () => {
  const cases = [
    { name: "phone on a high tripod, 60 fps, sunshine", o: { fps: 60, kmh: 126, length: 6.4, line: 0.06, swing: 0.12 }, kmh: 6, len: 0.3 },
    { name: "30 fps, no shadow", o: { fps: 30, kmh: 112, length: 7.5, line: -0.1, swing: -0.1, sun: false }, kmh: 9, len: 0.35 },
    { name: "a camera that zooms in through the delivery, 50 fps", o: { fps: 50, kmh: 138, length: 8.5, line: 0.15, swing: 0, zoom: 1.6, pos: [1, 7, 24] as V3, f: 2300 }, kmh: 7, len: 0.3 },
  ];
  for (const c of cases) {
    it(`${c.name}: speed, length, line and height at the stumps against the truth`, async () => {
      const F = film(c.o), { marks, cam, getter, hints } = setup(F, F.release - 2);
      expect(isCamera(cam)).toBe(true);
      const sc = (await scan(getter, cam, F.release - 2, hints))!;
      expect(sc.still).toBe(!c.o.zoom);
      const a = autoTrack(cam, sc, hints, null)!;
      expect(a).not.toBeNull();
      // every sighting really is the ball
      // (where it pitches the ball and its shadow are one blob, a few pixels out; the fit rides over that)
      const off = a.sightings.map((s) => Math.hypot(s.px[0] - F.ball[s.frame]![0], s.px[1] - F.ball[s.frame]![1])).sort((p, q) => p - q);
      if (off[off.length - 1] >= 5) console.log(c.name, a.sightings.map((s) => `${s.frame}:${Math.hypot(s.px[0] - F.ball[s.frame]![0], s.px[1] - F.ball[s.frame]![1]).toFixed(1)}`).join(" "), "outliers", a.tracked.outliers, "pitch t", a.tracked.pitch?.t, "release frame", F.release);
      expect(off[off.length - 1]).toBeLessThan(5);
      expect(off[off.length >> 1]).toBeLessThan(0.8);
      expect(a.sightings.length).toBeGreaterThanOrEqual(7);
      const tr = withDoubt(a.tracked, cam, marks, a.sightings, sc.shifts, a.hints, null);
      const truth = F.path;
      expect(Math.abs(tr.release.kmh.value - c.o.kmh)).toBeLessThan(c.kmh);
      expect(Math.abs(tr.release.kmh.value - c.o.kmh)).toBeLessThan(3 * tr.release.kmh.sigma);
      expect(Math.abs(tr.pitch!.length.value - c.o.length)).toBeLessThan(c.len);
      expect(Math.abs(tr.pitch!.line.value - truth.pitch!.p[0])).toBeLessThan(0.05);
      expect(Math.abs(tr.stumps!.x.value - truth.stumps!.p[0])).toBeLessThan(0.08);
      expect(Math.abs(tr.stumps!.height.value - truth.stumps!.p[1])).toBeLessThan(0.15);
      if (F.fall) { expect(tr.sun).not.toBeNull(); expect(Math.abs(tr.sun!.fall[0] - F.fall[0])).toBeLessThan(0.08); }
      // kept and brought back: the same delivery
      const rec = recordOf(cam, F.release - 2, marks, null, a.sightings, sc.shifts, tr, a.hints);
      expect(shiftsOf(rec).has(F.release)).toBe(true);
      const again = refit(cam, rec.sightings, shiftsOf(rec), a.hints, null);
      expect(isTracked(again) && Math.abs(again.release.kmh.value - tr.release.kmh.value) < 0.01).toBe(true);
      // and in the terms the batter's-eye view replays
      const read = trackedRead(tr)!;
      expect(read.seconds).toBeCloseTo(truth.crease!.t, 1);
      expect(Math.abs(read.height - truth.crease!.p[1])).toBeLessThan(0.15);
    }, 60000);
  }
  it("still finds the ball when the analysis has the release half a second out, and says its speed is rough", async () => {
    const F = film({ fps: 30, kmh: 112, length: 7.5, line: -0.1, swing: -0.1 }), { cam, getter, hints } = setup(F, F.release - 2);
    const wrong: PoseHints = { ...hints, releaseFrame: F.release + 14, hand: [100, 100], ankles: [] };
    const sc = (await scan(getter, cam, F.release - 2, wrong))!, a = autoTrack(cam, sc, wrong, null)!;
    expect(a).not.toBeNull();
    expect(Math.abs(a.hints.releaseFrame - F.release)).toBeLessThanOrEqual(2);
    expect(a.hints.releaseTSigma).toBe(1.5);
    expect(Math.abs(a.tracked.pitch!.length.value - 7.5)).toBeLessThan(0.35);   // the length does not need the release
    expect(a.tracked.release.kmh.sigma).toBeGreaterThan(4);
  }, 60000);
  it("finds nothing in frames with no ball, rather than something", async () => {
    const F = film({ fps: 30, kmh: 112, length: 7.5, line: -0.1, swing: 0 }), { cam, hints } = setup(F, F.release - 2);
    const empty: FrameGetter = { w: W, h: H, get: async (f) => F.frames[Math.min(f, F.release)] };   // the same picture, over and over
    const sc = (await scan(empty, cam, F.release - 2, hints))!;
    expect(autoTrack(cam, sc, hints, null)).toBeNull();
  }, 60000);
  it("a kept record needs an analysis with a release to come back", () => {
    const r = { events: { br: null } } as unknown as AnalysisResult;
    expect(fromRecord({ v: 1, w: W, h: H, markFrame: 0, marks: [], upright: null, sightings: [], shifts: [], kmh: 100, kmhSigma: 1, length: null, line: null, swing: 0, deviation: null, height: null, hitting: null, rmsPx: 0 }, r)).toBeNull();
  });
});
