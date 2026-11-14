/** The ball's flight (lib/flight.ts): the integration against exact answers and a finer independent one, the aiming,
 * and the numbers a delivery comes to against what ball-tracking shows for real ones. */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { aimAt, ballAt, fly, lengthFromTime, lengthName, measuredBall, readDelivery, releaseOf, BALL_M, BALL_R, CD, BOUNCE, CREASE_Z, STUMPS_Z, type Launch } from "../src/lib/flight";
import type { AnalysisResult } from "../src/types";
import type { V3 } from "../src/lib/biomech";

const FROM: V3 = [-0.6, 2.1, -1.2], deg = Math.PI / 180;
const sample = (n: string) => JSON.parse(readFileSync(new URL(`../public/samples/${n}/bundle.json`, import.meta.url), "utf8")).result as AnalysisResult;

/** The same physics written again, as fourth-order Runge-Kutta at a tenth of the step, with the bounce found exactly. */
function reference(l: Launch, cd = CD) {
  const kd = (0.5 * 1.2 * cd * Math.PI * BALL_R ** 2) / BALL_M, ks = (0.5 * 1.2 * l.swing * Math.PI * BALL_R ** 2) / BALL_M, dt = 1e-4;
  let s = [l.from[0], l.from[1], l.from[2], l.speed * Math.sin(l.azim) * Math.cos(l.elev), l.speed * Math.sin(l.elev), -l.speed * Math.cos(l.azim) * Math.cos(l.elev)];
  let swing = ks, t = 0, pitch: number[] | null = null, tp = 0;
  const f = (q: number[]) => {
    const v = Math.hypot(q[3], q[4], q[5]), h = Math.hypot(q[3], q[5]);
    return [q[3], q[4], q[5], -kd * v * q[3] + swing * v * v * (-q[5] / h), -9.81 - kd * v * q[4], -kd * v * q[5] + swing * v * v * (q[3] / h)];
  };
  const step = (q: number[], h: number) => {
    const k1 = f(q), k2 = f(q.map((x, i) => x + (h / 2) * k1[i])), k3 = f(q.map((x, i) => x + (h / 2) * k2[i])), k4 = f(q.map((x, i) => x + h * k3[i]));
    return q.map((x, i) => x + (h / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]));
  };
  for (;;) {
    let n = step(s, dt), h = dt;
    if (n[1] < BALL_R && n[4] < 0) {   // the bounce: shorten the step until the ball just touches
      let lo = 0, hi = dt;
      for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (step(s, m)[1] < BALL_R) hi = m; else lo = m; }
      h = lo; n = step(s, h);
      n[4] = -BOUNCE.up * n[4]; n[3] *= BOUNCE.along; n[5] *= BOUNCE.along; swing = 0;
      if (!pitch) { pitch = n.slice(0, 3); tp = t + h; }
    }
    if (n[2] <= CREASE_Z) { const u = (s[2] - CREASE_Z) / (s[2] - n[2]); return { t: t + u * h, p: s.map((x, i) => x + (n[i] - x) * u), pitch, tp }; }
    s = n; t += h;
  }
}

describe("the integration", () => {
  it("with no air it is the textbook parabola", () => {
    const v = 38, el = -6 * deg, path = fly({ from: FROM, speed: v, elev: el, azim: 0, swing: 0 }, 0);
    const vy = v * Math.sin(el), T = (vy + Math.sqrt(vy * vy + 2 * 9.81 * (FROM[1] - BALL_R))) / 9.81;
    expect(path.pitch!.t).toBeCloseTo(T, 3);
    expect(path.pitch!.p[2]).toBeCloseTo(FROM[2] - v * Math.cos(el) * T, 2);
    expect(path.pitch!.p[0]).toBeCloseTo(FROM[0], 6);
    // energy: its speed at the pitch is what the fall gives it
    expect(path.pitch!.speedIn).toBeCloseTo(Math.sqrt(v * v + 2 * 9.81 * (FROM[1] - BALL_R)), 2);
  });
  it("agrees with a finer, independently written integration to within millimetres and a tenth of a millisecond", () => {
    for (const l of [{ speed: 39, elev: -7.6 * deg, azim: 1.5 * deg, swing: 0 }, { speed: 33, elev: -5 * deg, azim: -2 * deg, swing: 0.25 },
      { speed: 24, elev: 1 * deg, azim: 0, swing: -0.2 }, { speed: 41, elev: -13 * deg, azim: 3 * deg, swing: 0.1 }]) {
      const a = fly({ from: FROM, ...l }), b = reference({ from: FROM, ...l });
      expect(a.pitch!.t).toBeCloseTo(b.tp, 3);
      for (let k = 0; k < 3; k += 2) expect(Math.abs(a.pitch!.p[k] - b.pitch![k])).toBeLessThan(0.004);
      expect(Math.abs(a.crease!.t - b.t)).toBeLessThan(2e-4);
      for (let k = 0; k < 2; k++) expect(Math.abs(a.crease!.p[k] - b.p[k])).toBeLessThan(0.004);
      expect(Math.abs(a.crease!.speed - Math.hypot(b.p[3], b.p[4], b.p[5]))).toBeLessThan(0.02);
    }
  });
  it("gives the ball's place at any moment, on its path", () => {
    const path = fly({ from: FROM, speed: 38, elev: -7 * deg, azim: 0, swing: 0 });
    expect(ballAt(path, 0)).toEqual(FROM);
    expect(ballAt(path, path.pitch!.t)[1]).toBeCloseTo(BALL_R, 2);
    expect(ballAt(path, path.crease!.t)[2]).toBeCloseTo(CREASE_Z, 2);
    let last = FROM[2];
    for (let t = 0.01; t < path.stumps!.t; t += 0.013) { const z = ballAt(path, t)[2]; expect(z).toBeLessThan(last); last = z; }
    expect(ballAt(path, 9)[2]).toBeCloseTo(STUMPS_Z, 6);
  });
});

describe("against real deliveries", () => {
  it("a 140 km/h good-length ball: about half a second, about 10% lost in the air, about a quarter lost by the batter", () => {
    const r = readDelivery(FROM, 140 / 3.6, { length: 7, line: 0 })!;
    expect(r.seconds).toBeGreaterThan(0.47); expect(r.seconds).toBeLessThan(0.54);
    const air = r.path.pitch!.speedIn / (140 / 3.6);
    expect(air).toBeGreaterThan(0.88); expect(air).toBeLessThan(0.95);
    expect(r.arriveKmh).toBeGreaterThan(100); expect(r.arriveKmh).toBeLessThan(118);
    // a good length is the one that threatens the top of the stumps
    expect(r.atStumps!.height).toBeGreaterThan(0.55); expect(r.atStumps!.height).toBeLessThan(0.95);
    expect(r.atStumps!.hitting).toBe(r.atStumps!.height <= 0.711 + BALL_R);
  });
  it("the average speed to the batter is the share of the release speed the pace measurement assumes", () => {
    // lib/pace.ts: 0.76-0.95 of the release speed over the whole way, when it bounces somewhere between short and full
    for (const [kmh, len] of [[145, 11], [135, 7], [120, 4], [100, 6]] as const) {
      const r = readDelivery(FROM, kmh / 3.6, { length: len, line: 0 })!, avg = (FROM[2] - CREASE_Z) / r.seconds / (kmh / 3.6);
      expect(avg).toBeGreaterThan(0.76); expect(avg).toBeLessThan(0.95);
    }
  });
  it("a yorker hits the base of the stumps, a bouncer passes over head height, a slower ball takes longer", () => {
    const y = readDelivery(FROM, 140 / 3.6, { length: 1.3, line: 0 })!, b = readDelivery(FROM, 140 / 3.6, { length: 11.5, line: 0 })!;
    expect(y.atStumps!.height).toBeLessThan(0.25); expect(y.atStumps!.hitting).toBe(true);
    expect(b.height).toBeGreaterThan(1.3); expect(b.atStumps!.hitting).toBe(false);
    expect(readDelivery(FROM, 110 / 3.6, { length: 7, line: 0 })!.seconds).toBeGreaterThan(readDelivery(FROM, 140 / 3.6, { length: 7, line: 0 })!.seconds + 0.1);
  });
  it("swing: a side-force coefficient of 0.2 moves a 130 km/h ball 15-30 cm, the same either way, and none after it pitches", () => {
    const out = readDelivery(FROM, 130 / 3.6, { length: 6, line: 0 }, 0.2)!, inn = readDelivery(FROM, 130 / 3.6, { length: 6, line: 0 }, -0.2)!;
    expect(out.path.swung).toBeGreaterThan(0.15); expect(out.path.swung).toBeLessThan(0.3);
    expect(inn.path.swung).toBeCloseTo(-out.path.swung, 2);
    // after the pitch it goes straight: three points on the way to the stumps are in line
    const p = out.path.pitch!, a = ballAt(out.path, p.t + 0.02), b = ballAt(out.path, p.t + 0.06), c = ballAt(out.path, p.t + 0.1);
    expect((b[0] - a[0]) / (b[2] - a[2])).toBeCloseTo((c[0] - b[0]) / (c[2] - b[2]), 3);
  });
});

describe("aiming", () => {
  it("pitches on the length and passes the stumps on the line asked for, at any pace, with or without swing", () => {
    for (const kmh of [75, 100, 125, 150]) for (const length of [0.8, 3, 6.5, 9, 12]) for (const line of [-0.5, 0, 0.35]) for (const swing of [0, 0.25, -0.25]) {
      const a = aimAt(FROM, kmh / 3.6, { length, line }, swing)!;
      const path = fly(a);
      expect(Math.abs(path.pitch!.p[2] - (STUMPS_Z + length))).toBeLessThan(0.01);
      expect(Math.abs(path.stumps!.p[0] - line)).toBeLessThan(0.003);
    }
  });
  it("refuses a length this pace can't reach, or one behind the bowler", () => {
    expect(aimAt(FROM, 6, { length: 1, line: 0 })).toBeNull();
    expect(aimAt(FROM, 35, { length: 19.5, line: 0 })).toBeNull();
  });
  it("a steeper release pitches shorter; a degree is worth about a metre on a good length, more when full", () => {
    const good = readDelivery(FROM, 135 / 3.6, { length: 7, line: 0 })!, full = readDelivery(FROM, 135 / 3.6, { length: 3, line: 0 })!, short = readDelivery(FROM, 135 / 3.6, { length: 11, line: 0 })!;
    expect(short.down).toBeGreaterThan(good.down); expect(good.down).toBeGreaterThan(full.down);
    expect(good.perDegree).toBeGreaterThan(0.7); expect(good.perDegree).toBeLessThan(1.3);
    expect(full.perDegree).toBeGreaterThan(good.perDegree);
    // the good-length window is the angle between pitching at 6 m and at 8 m
    const a6 = aimAt(FROM, 135 / 3.6, { length: 6, line: 0 })!, a8 = aimAt(FROM, 135 / 3.6, { length: 8, line: 0 })!;
    expect(good.window!).toBeCloseTo((a6.elev - a8.elev) / deg, 6);
    expect(good.window!).toBeGreaterThan(1.5); expect(good.window!).toBeLessThan(2.8);
  });
  it("a higher release makes the same length bounce higher at the batter", () => {
    const r = readDelivery(FROM, 135 / 3.6, { length: 7, line: 0 })!, tall = readDelivery([FROM[0], FROM[1] + 0.1, FROM[2]], 135 / 3.6, { length: 7, line: 0 })!;
    expect(r.perTen).toBeGreaterThan(0.01);
    expect(tall.height - r.height).toBeCloseTo(r.perTen, 6);
  });
  it("the batter's last look: 0.2 s before it arrives the ball is still metres away", () => {
    const r = readDelivery(FROM, 145 / 3.6, { length: 7, line: 0 })!;
    expect(r.commit!).toBeGreaterThan(5.5); expect(r.commit!).toBeLessThan(7.5);
  });
  it("names the lengths, and turns a marked pitching time back into a length", () => {
    expect([1, 4, 7, 9, 12].map(lengthName)).toEqual(["Yorker", "Full", "Good length", "Back of a length", "Short"]);
    for (const len of [2.5, 7, 10.5]) {
      const t = fly(aimAt(FROM, 36, { length: len, line: 0 })!).pitch!.t;
      expect(lengthFromTime(FROM, 36, t)!).toBeCloseTo(len, 1);
    }
    expect(lengthFromTime(FROM, 36, 0.05)).toBeNull();
    expect(lengthFromTime(FROM, 36, 0.9)).toBeNull();
  });
});

describe("the release point of an analysed delivery", () => {
  it("is the bowling hand at release on every bundled example: above the head, by the bowler's crease, on the bowling arm's side", () => {
    for (const n of ["club", "club-front", "nets-behind", "synthetic"]) {
      const r = sample(n), rel = releaseOf(r)!;
      expect(rel.frame).toBe(r.events.br!.frame - r.frames.start);
      expect(rel.from[1]).toBeGreaterThan(1.6); expect(rel.from[1]).toBeLessThan(2.6);
      expect(rel.from[2]).toBeGreaterThan(-2.2); expect(rel.from[2]).toBeLessThan(0.5);
      expect(Math.sign(rel.from[0])).toBe(r.bowling_arm.arm === "right" ? -1 : 1);
      expect(rel.heightMeasured).toBe(true);
      // every length from a yorker to a bouncer can be bowled from it at club and at international pace
      for (const kmh of [95, 145]) for (const length of [1, 7, 12]) expect(readDelivery(rel.from, kmh / 3.6, { length, line: 0 })).not.toBeNull();
    }
  });
  it("takes the pace and the length from the clip when they were marked on it", () => {
    const r = sample("synthetic"), rel = releaseOf(r)!, br = r.events.br!.frame, fps = r.fps_real;
    expect(measuredBall(r, rel, null)).toEqual({ kmh: null, length: null });
    expect(measuredBall(r, rel, { kmh: 128, release: br })).toEqual({ kmh: 128, length: null });
    // a ball marked as pitching 0.35 s after release at 128 km/h: the length is the one whose flight takes that long
    const frames = Math.round(0.35 * fps), m = measuredBall(r, rel, { kmh: 128, release: br, pitch: br + frames });
    expect(m.kmh).toBe(128);
    const t = fly(aimAt(rel.from, 128 / 3.6, { length: m.length!, line: 0 })!).pitch!.t;
    expect(t).toBeCloseTo(frames / fps, 2);
    expect(m.length!).toBeGreaterThan(4); expect(m.length!).toBeLessThan(9);
    // a mark outside the clip, or a time no ball could take, gives no length
    expect(measuredBall(r, rel, { kmh: 128, release: br, pitch: br + 100000 }).length).toBeNull();
    expect(measuredBall(r, rel, { kmh: 128, release: br, pitch: br + 1 }).length).toBeNull();
  });
  it("is null without a release", () => {
    const r = sample("club");
    expect(releaseOf({ ...r, events: { ...r.events, br: null } } as AnalysisResult)).toBeNull();
  });
});
