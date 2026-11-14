import { describe, expect, it } from "vitest";
import { fitBall, isTracked, trackedAt, type BallObs, type Tracked } from "../src/lib/balltrack";
import { solveCamera, project, worldOf, type Camera, type Mark, type MarkId } from "../src/lib/camcal";
import { fly, ballAt, aimAt, STUMPS_Z } from "../src/lib/flight";
import type { V3 } from "../src/lib/biomech";

let seed = 11;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());

function makeCam(pos: V3, at: V3, f: number, w = 1920, h = 1080) {
  const z = [at[0] - pos[0], at[1] - pos[1], at[2] - pos[2]]; const n = Math.hypot(z[0], z[1], z[2]); const zc = z.map((v) => v / n);
  let xc = [-zc[2], 0, zc[0]]; const nx = Math.hypot(xc[0], xc[2]); xc = xc.map((v) => v / nx);
  const yc = [zc[1] * xc[2] - zc[2] * xc[1], zc[2] * xc[0] - zc[0] * xc[2], zc[0] * xc[1] - zc[1] * xc[0]];
  const R = [...xc, ...yc, ...zc];
  const t: V3 = [-(R[0] * pos[0] + R[1] * pos[1] + R[2] * pos[2]), -(R[3] * pos[0] + R[4] * pos[1] + R[5] * pos[2]), -(R[6] * pos[0] + R[7] * pos[1] + R[8] * pos[2])];
  return { f, R, t, w, h };
}
const IDS: MarkId[] = (["bowler", "batter"] as const).flatMap((end) => (["pop_l", "pop_r", "bowl_l", "bowl_r", "stump_base", "stump_top"] as const).map((kind) => ({ end, kind })));
const calibrated = (truth: ReturnType<typeof makeCam>, noise = 0): Camera =>
  solveCamera(IDS.map((id): Mark => { const p = project(truth, worldOf(id))!; return { ...id, px: [p[0] + noise * gauss(), p[1] + noise * gauss()] }; }), truth.w, truth.h) as Camera;

interface Ball { kmh: number; length: number; line: number; swing: number; from: V3; bounce?: { up: number; along: number } }
/** What the camera would see: the ball's centre in each frame from just after release until it reaches the batter. */
function film(truth: ReturnType<typeof makeCam>, ball: Ball, fps: number, noise: number, phase = 0.4) {
  const launch = aimAt(ball.from, ball.kmh / 3.6, { length: ball.length, line: ball.line }, ball.swing)!;
  const path = fly(launch, undefined, ball.bounce);
  const tEnd = path.crease!.t, obs: BallObs[] = [];
  for (let t = phase / fps; t < tEnd; t += 1 / fps) {
    const p = project(truth, ballAt(path, t))!;
    obs.push({ t: 10 + t, px: [p[0] + noise * gauss(), p[1] + noise * gauss()] });
  }
  return { obs, path, launch, releaseT: 10 };
}
const BROADCAST = makeCam([2, 17, 78], [0, 0, -9], 8500), PHONE = makeCam([0.5, 3.2, 8], [0, 0.3, -11], 1550), LOW = makeCam([0.3, 1.5, 5], [0, 0.8, -12], 1500);
const BALL: Ball = { kmh: 135, length: 6.5, line: 0.12, swing: 0.1, from: [-0.6, 2.05, -1.6] };

describe("ball flight from one camera", () => {
  for (const [name, truth, fps] of [["broadcast 25 fps", BROADCAST, 25], ["phone high behind the arm, 60 fps", PHONE, 60], ["phone high, 30 fps", PHONE, 30]] as const) {
    it(`finds the flight exactly from exact sightings (${name})`, () => {
      const cam = calibrated(truth), shot = film(truth, BALL, fps, 0);
      const tr = fitBall(cam, shot.obs, { releaseT: shot.releaseT, releaseZ: BALL.from[2], releaseHeight: BALL.from[1], fps }) as Tracked;
      expect(isTracked(tr)).toBe(true);
      expect(tr.rmsPx).toBeLessThan(0.05);
      expect(tr.release.kmh.value).toBeCloseTo(BALL.kmh, 0);
      expect(tr.pitch!.length.value).toBeCloseTo(BALL.length, 1);
      expect(tr.pitch!.line.value).toBeCloseTo(shot.path.pitch!.p[0], 2);
      expect(tr.stumps!.height.value).toBeCloseTo(shot.path.stumps!.p[1], 1);
      expect(tr.stumps!.x.value).toBeCloseTo(shot.path.stumps!.p[0], 1);
      expect(Math.abs(tr.swing.value - shot.path.swung)).toBeLessThan(0.03);
      // and the whole path, not just the headline numbers
      for (const t of [0.1, 0.25, 0.4]) {
        const a = trackedAt(tr, t), b = ballAt(shot.path, t - (tr.release.t - shot.releaseT));
        expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])).toBeLessThan(0.08);
      }
    });
  }

  it("does not need the pitch to behave like the model: a slow, low pitch is read off the sightings", () => {
    const cam = calibrated(BROADCAST), ball = { ...BALL, bounce: { up: 0.4, along: 0.8 } }, shot = film(BROADCAST, ball, 25, 0);
    const tr = fitBall(cam, shot.obs, { releaseT: 10, releaseZ: ball.from[2], releaseHeight: ball.from[1], fps: 25 }) as Tracked;
    expect(tr.pitch!.length.value).toBeCloseTo(ball.length, 1);
    expect(Math.abs(tr.stumps!.height.value - shot.path.stumps!.p[1])).toBeLessThan(0.12);
  });

  it("the stated uncertainties are honest: with noisy sightings, marks and release, the truth sits inside them about as often as it should", () => {
    const rows: { name: string; n: number; cover: number[]; rms: number[] }[] = [];
    for (const [name, truth, fps, px] of [["broadcast", BROADCAST, 25, 1.5], ["phone high", PHONE, 60, 1.5], ["phone low", LOW, 60, 1.5]] as const) {
      const inside = [0, 0, 0, 0, 0], sq = [0, 0, 0, 0, 0]; let n = 0;
      for (let k = 0; k < 40; k++) {
        const ball: Ball = { kmh: 100 + 45 * rnd(), length: 3 + 7 * rnd(), line: -0.3 + 0.6 * rnd(), swing: -0.2 + 0.4 * rnd(), from: [rnd() < 0.5 ? -0.7 : 0.7, 1.85 + 0.4 * rnd(), -1.2 - 0.8 * rnd()] };
        const shot = film(truth, ball, fps, px, rnd());
        const tr = fitBall(calibrated(truth, 1.5), shot.obs, {
          releaseT: 10 + 0.4 * gauss() / fps, releaseZ: ball.from[2] + 0.3 * gauss(), releaseHeight: ball.from[1] + 0.1 * gauss(), fps });
        if (!isTracked(tr) || !tr.pitch || !tr.stumps) { if (process.env.DBG) console.log(name, k, ball.kmh.toFixed(0), ball.length.toFixed(1), shot.obs.length, isTracked(tr) ? `pitch ${!!tr.pitch} stumps ${!!tr.stumps} split ${tr.split} rms ${tr.rmsPx.toFixed(2)}` : tr.text); continue; }
        n++;
        const err = [tr.release.kmh.value - ball.kmh, tr.pitch.length.value - ball.length, tr.pitch.line.value - shot.path.pitch!.p[0],
          tr.stumps.height.value - shot.path.stumps!.p[1], tr.stumps.x.value - shot.path.stumps!.p[0]];
        const sg = [tr.release.kmh.sigma, tr.pitch.length.sigma, tr.pitch.line.sigma, tr.stumps.height.sigma, tr.stumps.x.sigma];
        err.forEach((e, i) => { if (Math.abs(e) <= 2 * sg[i]) inside[i]++; sq[i] += e * e; });
      }
      rows.push({ name, n, cover: inside.map((v) => v / n), rms: sq.map((v) => Math.sqrt(v / n)) });
    }
    console.log(rows.map((r) => `${r.name}: n=${r.n} within 2 sigma [kmh,length,line,height,x]=${r.cover.map((c) => c.toFixed(2)).join(",")} rms=${r.rms.map((c) => c.toFixed(3)).join(",")}`).join("\n"));
    for (const r of rows) {
      expect(r.n).toBeGreaterThanOrEqual(38);
      for (const c of r.cover) expect(c).toBeGreaterThan(0.8);
    }
    // a broadcast-style camera: speed to a few km/h, length to a hand's width or two, line to a few centimetres
    expect(rows[0].rms[0]).toBeLessThan(7.5); expect(rows[0].rms[1]).toBeLessThan(0.15); expect(rows[0].rms[2]).toBeLessThan(0.03);
    expect(rows[1].rms[0]).toBeLessThan(5); expect(rows[2].rms[1]).toBeLessThan(0.2);
  }, 120000);

  it("throws out a sighting that is not the ball", () => {
    const cam = calibrated(BROADCAST), shot = film(BROADCAST, BALL, 50, 0.5);
    shot.obs[5] = { ...shot.obs[5], px: [shot.obs[5].px[0] + 40, shot.obs[5].px[1] - 25] };
    const tr = fitBall(cam, shot.obs, { releaseT: 10, releaseZ: BALL.from[2], releaseHeight: BALL.from[1], fps: 50 }) as Tracked;
    expect(tr.outliers).toEqual([5]);
    expect(tr.release.kmh.value).toBeGreaterThan(130); expect(tr.release.kmh.value).toBeLessThan(140);
  });

  it("says so when there is too little to go on", () => {
    const cam = calibrated(BROADCAST), shot = film(BROADCAST, BALL, 25, 0);
    expect(isTracked(fitBall(cam, shot.obs.slice(0, 3), { releaseT: 10, releaseZ: -1.6, fps: 25 }))).toBe(false);
  });
  it("a full toss (no bounce in view) still gives a speed and where it would pass the stumps", () => {
    const cam = calibrated(PHONE), ball = { ...BALL, length: 0.4, kmh: 120 }, shot = film(PHONE, ball, 60, 0);
    const tr = fitBall(cam, shot.obs, { releaseT: 10, releaseZ: ball.from[2], releaseHeight: ball.from[1], fps: 60 }) as Tracked;
    expect(isTracked(tr)).toBe(true);
    expect(Math.abs(tr.release.kmh.value - 120)).toBeLessThan(4);
    expect(tr.afterBounce).toBe(0);
    void STUMPS_Z;
  });
});
