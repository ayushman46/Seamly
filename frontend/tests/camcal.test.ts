import { describe, expect, it } from "vitest";
import { solveCamera, project, onPlaneY, isCamera, worldOf, lookDown, cameraEnd, type Mark, type MarkId, type Camera } from "../src/lib/camcal";
import type { V3 } from "../src/lib/biomech";

// an independent camera: build R from yaw/pitch/roll, not through camcal's helpers
function makeCam(pos: V3, at: V3, f: number, roll = 0, w = 1920, h = 1080) {
  const z = [at[0] - pos[0], at[1] - pos[1], at[2] - pos[2]]; const n = Math.hypot(z[0], z[1], z[2]); const zc = z.map((v) => v / n);
  let xc = [-zc[2], 0, zc[0]]; const nx = Math.hypot(xc[0], xc[2]); xc = xc.map((v) => v / nx);
  let yc = [zc[1] * xc[2] - zc[2] * xc[1], zc[2] * xc[0] - zc[0] * xc[2], zc[0] * xc[1] - zc[1] * xc[0]];
  const c = Math.cos(roll), s = Math.sin(roll);
  const x2 = xc.map((v, i) => c * v + s * yc[i]), y2 = yc.map((v, i) => -s * xc[i] + c * v);
  const R = [...x2, ...y2, ...zc];
  const t: V3 = [-(R[0] * pos[0] + R[1] * pos[1] + R[2] * pos[2]), -(R[3] * pos[0] + R[4] * pos[1] + R[5] * pos[2]), -(R[6] * pos[0] + R[7] * pos[1] + R[8] * pos[2])];
  return { f, R, t, w, h };
}
const GROUND: MarkId[] = (["bowler", "batter"] as const).flatMap((end) => (["pop_l", "pop_r", "bowl_l", "bowl_r"] as const).map((kind) => ({ end, kind })));
const STUMPS: MarkId[] = (["bowler", "batter"] as const).flatMap((end) => (["stump_base", "stump_top"] as const).map((kind) => ({ end, kind })));
let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
const marksFor = (cam: ReturnType<typeof makeCam>, ids: MarkId[], noise = 0): Mark[] =>
  ids.map((id) => { const p = project(cam, worldOf(id))!; return { ...id, px: [p[0] + noise * gauss(), p[1] + noise * gauss()] }; });

const CAMS: { name: string; pos: V3; at: V3; f: number; roll?: number }[] = [
  { name: "phone on a tripod behind the bowler", pos: [0.4, 1.6, 6], at: [0, 0.6, -12], f: 1500 },
  { name: "phone high behind the bowler", pos: [-1, 3.5, 9], at: [0, 0, -10], f: 1700, roll: 0.02 },
  { name: "broadcast, long lens", pos: [2, 18, 75], at: [0, 0, -9], f: 9000 },
  { name: "behind the batter", pos: [0.5, 2.2, -27], at: [0, 0.5, -8], f: 1400 },
  { name: "broadcast behind the batter", pos: [-3, 22, -95], at: [0, 0, -10], f: 9500, roll: -0.01 },
];

describe("camera from the pitch markings", () => {
  for (const c of CAMS) {
    it(`recovers ${c.name} from exact marks`, () => {
      const truth = makeCam(c.pos, c.at, c.f, c.roll ?? 0);
      const cam = solveCamera(marksFor(truth, [...GROUND, ...STUMPS]), 1920, 1080);
      expect(isCamera(cam)).toBe(true);
      const k = cam as Camera;
      expect(k.rms).toBeLessThan(0.02);
      // what matters: any point on or above the pitch lands on the same pixel
      for (const p of [[0.3, 0.036, -13], [-0.5, 1.9, -1.5], [0.1, 0.6, -19], [0, 2.3, -6]] as V3[]) {
        const a = project(truth, p)!, b = project(k, p)!;
        expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThan(0.3);
      }
      expect(cameraEnd(k)).toBe(c.pos[2] > -10 ? "bowler" : "batter");
      expect(lookDown(k)).toBeGreaterThan(0);
    });
  }
  it("works from the eight crease corners alone (no stumps)", () => {
    const truth = makeCam([0.4, 2.2, 7], [0, 0.4, -12], 1500);
    const k = solveCamera(marksFor(truth, GROUND), 1920, 1080) as Camera;
    expect(k.rms).toBeLessThan(0.02);
    const a = project(truth, [0.2, 1.0, -15])!, b = project(k, [0.2, 1.0, -15])!;
    expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThan(0.5);
  });
  it("puts a pixel back on the ground where it came from", () => {
    const truth = makeCam([2, 18, 75], [0, 0, -9], 9000);
    const k = solveCamera(marksFor(truth, [...GROUND, ...STUMPS]), 1920, 1080) as Camera;
    for (const g of [[0.2, 0, -14], [-0.4, 0, -17.5], [0, 0, -6]] as V3[]) {
      const back = onPlaneY(k, project(truth, g)!, 0)!;
      expect(Math.hypot(back[0] - g[0], back[2] - g[2])).toBeLessThan(0.01);
    }
  });
  it("with marks 1.5 px out, the ground position stays within a few centimetres across and a hand's width along (phone, high tripod)", () => {
    const truth = makeCam([0.3, 3.0, 8], [0, 0, -11], 1600);
    let worstX = 0, sumL = 0, n = 0;
    for (let trial = 0; trial < 60; trial++) {
      const k = solveCamera(marksFor(truth, [...GROUND, ...STUMPS], 1.5), 1920, 1080);
      if (!isCamera(k)) continue;
      const g: V3 = [0.15, 0, -14];
      const back = onPlaneY(k, project(truth, g)!, 0)!;
      worstX = Math.max(worstX, Math.abs(back[0] - g[0])); sumL += (back[2] - g[2]) ** 2; n++;
    }
    expect(n).toBe(60);
    expect(worstX).toBeLessThan(0.06);
    expect(Math.sqrt(sumL / n)).toBeLessThan(0.25);
  });
  it("refuses too few marks, or marks at one end only", () => {
    const truth = makeCam([0.4, 1.6, 6], [0, 0.6, -12], 1500);
    expect(isCamera(solveCamera(marksFor(truth, GROUND.slice(0, 3)), 1920, 1080))).toBe(false);
    expect(isCamera(solveCamera(marksFor(truth, GROUND.slice(0, 4)), 1920, 1080))).toBe(false);
  });
});
