import { describe, expect, it } from "vitest";
import { project, type Pt } from "../src/lib/camcal";
import { findWickets, pairWickets } from "../src/lib/stumpfind";
import { believable } from "../src/lib/autocam";
import type { OnPitch } from "../src/lib/onpitch";
import type { V3 } from "../src/lib/biomech";

/** Pictures drawn here, where the answer is known: rough ground, and the two wickets as three pale stumps each. */
const W = 1280, H = 720;
function camAt(pos: V3, at: V3, f: number) {
  const z = [at[0] - pos[0], at[1] - pos[1], at[2] - pos[2]], n = Math.hypot(z[0], z[1], z[2]), zc = z.map((v) => v / n);
  const nx = Math.hypot(zc[2], zc[0]), xc = [-zc[2] / nx, 0, zc[0] / nx];
  const yc = [zc[1] * xc[2] - zc[2] * xc[1], zc[2] * xc[0] - zc[0] * xc[2], zc[0] * xc[1] - zc[1] * xc[0]];
  const R = [...xc, ...yc, ...zc];
  const t: V3 = [-(R[0] * pos[0] + R[1] * pos[1] + R[2] * pos[2]), -(R[3] * pos[0] + R[4] * pos[1] + R[5] * pos[2]), -(R[6] * pos[0] + R[7] * pos[1] + R[8] * pos[2])];
  return { f, R, t, w: W, h: H, pos };
}
function picture(cam: ReturnType<typeof camAt>, wickets: boolean, fence = false) {
  const img = new Uint8ClampedArray(W * H * 4);
  let seed = 11; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  const horizon = project(cam, [0, 0, -4000])![1];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const k = (y * W + x) * 4, e = 10 * rnd(), sky = y < horizon;
    img[k] = (sky ? 70 : 78) + e; img[k + 1] = (sky ? 90 : 128) + e; img[k + 2] = (sky ? 110 : 66) + e; img[k + 3] = 255;
  }
  // an upright pale bar from a foot on the ground to a top, drawn with soft edges
  const bar = (x: number, z: number, tall: number, thick: number, col: number) => {
    const a = project(cam, [x, 0, z])!, b = project(cam, [x, tall, z])!, c = project(cam, [x + thick, 0, z])!, wpx = Math.max(0.6, Math.abs(c[0] - a[0]));
    for (let y = Math.floor(b[1]) - 1; y <= Math.ceil(a[1]) + 1; y++) for (let xx = Math.floor(a[0] - wpx) - 1; xx <= Math.ceil(a[0] + wpx) + 1; xx++) {
      if (xx < 0 || y < 0 || xx >= W || y >= H) continue;
      const cx = Math.max(0, Math.min(1, wpx / 2 + 0.5 - Math.abs(xx + 0.5 - a[0]))), cy = Math.max(0, Math.min(1, y + 1 - b[1])) * Math.max(0, Math.min(1, a[1] - y)), al = Math.min(1, cx) * Math.min(1, cy);
      const k = (y * W + xx) * 4;
      for (let i = 0; i < 3; i++) img[k + i] = img[k + i] * (1 - al) + col * al;
    }
  };
  if (wickets) for (const z of [0, -20.12]) for (const x of [-0.1143, 0, 0.1143]) bar(x, z, 0.711, 0.038, 225);
  // a picket fence along the far boundary: many equal upright bars, which are not a wicket
  if (fence) for (let x = -30; x <= 30; x += 0.25) bar(x, -70, 1.0, 0.09, 235);
  return img;
}
const near = (p: Pt, q: Pt, tol: number) => Math.hypot(p[0] - q[0], p[1] - q[1]) < tol;

describe("finding the wickets on their own", () => {
  const views: [string, V3, V3, number][] = [["phone on a tall tripod", [0.9, 3.4, 10.5], [0, 0.6, -10], 1180], ["tripod at chest height", [-0.5, 1.45, 6], [0, 0.9, -10], 1000], ["high and far, long lens", [1.5, 12, 60], [0, 0, -8], 5200]];
  for (const [name, pos, at, f] of views) it(`finds both, and the camera they give is the camera: ${name}`, () => {
    const cam = camAt(pos, at, f), c = findWickets(picture(cam, true, true), W, H);
    const nb = project(cam, [0, 0, 0])!, nt = project(cam, [0, 0.711, 0])!, fb = project(cam, [0, 0, -20.12])!, ft = project(cam, [0, 0.711, -20.12])!;
    const pairs = pairWickets(c, W, H);
    const right = pairs.find((p) => near(p.near.base, nb, 3) && near(p.far.base, fb, 3));
    expect(right, "the true pair is among the candidates").toBeTruthy();
    // the ends of the stumps to a pixel or so: they are the ruler
    expect(Math.abs(right!.near.top[1] - nt[1])).toBeLessThan(1.5); expect(Math.abs(right!.near.base[1] - nb[1])).toBeLessThan(1.5);
    expect(Math.abs(right!.far.top[1] - ft[1])).toBeLessThan(1.2); expect(Math.abs(right!.far.base[1] - fb[1])).toBeLessThan(1.2);
    // the size of things at the bowler's end (zoom over distance) within 4%
    const scale = (q: { f: number; pos: V3 }) => q.f / Math.hypot(q.pos[0], q.pos[1], q.pos[2]);
    expect(Math.abs(scale(right!.cam) / scale(cam) - 1)).toBeLessThan(0.04);
  });
  it("makes no pitch of bare ground and a fence", () => {
    const cam = camAt([0.9, 3.4, 10.5], [0, 0.6, -10], 1180), c = findWickets(picture(cam, false, true), W, H);
    // whatever pairs of fence posts it can string together, none is a camera low behind a wicket twenty metres from another
    for (const p of pairWickets(c, W, H)) expect(p.far.h / p.near.h).toBeGreaterThan(0.5);
  });
});

describe("checking a found camera against the bowler", () => {
  const ok = { release: { height: { value: 2.0, sigma: 0.05 }, across: { value: -0.5, sigma: 0.03 } }, stature: { value: 1.8, sigma: 0.06 },
    back: { heel: [-0.3, 0, 0.4] }, front: { heel: [-0.5, 0, -0.9] }, runup: { value: 20, sigma: 2 } } as unknown as OnPitch;
  it("believes a bowler", () => expect(believable(ok)).toBe(true));
  it("does not believe a giant, a release at the knees, or a bowler in the outfield", () => {
    expect(believable({ ...ok, stature: { value: 2.6, sigma: 0.1 } } as OnPitch)).toBe(false);
    expect(believable({ ...ok, release: { ...ok.release!, height: { value: 0.9, sigma: 0.05 } } } as OnPitch)).toBe(false);
    expect(believable({ ...ok, front: { heel: [-0.5, 0, -7] } } as unknown as OnPitch)).toBe(false);
    expect(believable({ ...ok, back: { heel: [5, 0, 0.4] } } as unknown as OnPitch)).toBe(false);
    expect(believable(null)).toBe(false);
  });
});

import { trackingMarks } from "../src/lib/autocam";
describe("the marks the ball is followed with", () => {
  const mk = (end: "bowler" | "batter", kind: string, x: number, y: number) => ({ end, kind, px: [x, y] }) as never;
  const pattern = [mk("bowler", "pop_l", 1, 1), mk("bowler", "pop_r", 2, 1), mk("bowler", "bowl_l", 1, 2), mk("bowler", "bowl_r", 2, 2), mk("batter", "pop_l", 5, 5), mk("batter", "pop_r", 6, 5)];
  it("are the pitch as found when nothing better was seen at the far end", () => {
    expect(trackingMarks(pattern, null)).toEqual(pattern);
    expect(trackingMarks(pattern, [])).toEqual(pattern);
  });
  it("take the far end from the batter's stump top when it was seen, in place of far creases too thin to read", () => {
    const top = [mk("batter", "stump_top", 5.5, 4)], out = trackingMarks(pattern, top);
    expect(out.filter((m) => m.end === "bowler")).toHaveLength(4);
    expect(out.filter((m) => m.end === "batter")).toEqual(top);
  });
});
