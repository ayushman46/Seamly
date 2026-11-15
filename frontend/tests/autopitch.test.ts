import { describe, expect, it } from "vitest";
import { project, worldOf, type MarkId, type Pt } from "../src/lib/camcal";
import { findPitch, pitchFound } from "../src/lib/autopitch";
import type { V3 } from "../src/lib/biomech";

/**
 * The pitch finder on pictures rendered here, where the right answer is known exactly: a pitch painted to the Laws'
 * sizes on rough turf, seen through a pinhole camera, with noise, and with people-sized blocks standing where the
 * umpire, bowler and batter hide the creases.
 */
const W = 1280, H = 720;
function camAt(pos: V3, at: V3, f: number) {
  const z = [at[0] - pos[0], at[1] - pos[1], at[2] - pos[2]]; const n = Math.hypot(z[0], z[1], z[2]); const zc = z.map((v) => v / n);
  let xc = [-zc[2], 0, zc[0]]; const nx = Math.hypot(xc[0], xc[2]); xc = xc.map((v) => v / nx);
  const yc = [zc[1] * xc[2] - zc[2] * xc[1], zc[2] * xc[0] - zc[0] * xc[2], zc[0] * xc[1] - zc[1] * xc[0]];
  const R = [...xc, ...yc, ...zc];
  const t: V3 = [-(R[0] * pos[0] + R[1] * pos[1] + R[2] * pos[2]), -(R[3] * pos[0] + R[4] * pos[1] + R[5] * pos[2]), -(R[6] * pos[0] + R[7] * pos[1] + R[8] * pos[2])];
  return { f, R, t, w: W, h: H, pos };
}
const hash = (a: number, b: number) => { let h = (a * 374761393 + b * 668265263) | 0; h = (h ^ (h >>> 13)) * 1274126177; return ((h ^ (h >>> 16)) >>> 0) / 4294967295; };
function ground(x: number, z: number, creases: boolean, paint: number): [number, number, number] {
  const n = hash(Math.floor(x / 0.05), Math.floor(z / 0.05)) - 0.5, n2 = hash(Math.floor(x / 0.6) + 99, Math.floor(z / 0.6)) - 0.5;
  const onPitch = Math.abs(x) < 1.525 && z < 1.22 && z > -21.34;
  let r = onPitch ? 196 : 70, g = onPitch ? 180 : 125, b = onPitch ? 140 : 60;
  const v = 18 * n + 16 * n2; r += v; g += v; b += v;
  // mowing stripes: pale bands across the outfield, the kind of line that is not a crease
  if (!onPitch && Math.floor((z + 100) / 3) % 2 === 0) { r += 10; g += 12; b += 8; }
  if (creases) {
    const line = (x0: number, x1: number, z0: number, z1: number) => x >= x0 && x <= x1 && z >= Math.min(z0, z1) && z <= Math.max(z0, z1);
    for (const [zs, to] of [[0, -1], [-20.12, 1]] as const) {
      if (line(-1.36, 1.36, zs, zs + to * 0.04) || line(-2.6, 2.6, zs + to * 1.22, zs + to * 1.26) || line(1.32, 1.36, zs + to * 1.26, zs - to * 1.22) || line(-1.36, -1.32, zs + to * 1.26, zs - to * 1.22)
        // wide guide lines, as in one-day cricket: between the creases only
        || line(0.87, 0.91, zs + to * 1.22, zs) || line(-0.91, -0.87, zs + to * 1.22, zs)) { r = g = b = paint; }
    }
  }
  return [r, g, b];
}
function picture(cam: ReturnType<typeof camAt>, o: { creases?: boolean; people?: boolean; paint?: number } = {}) {
  const img = new Uint8ClampedArray(W * H * 4), R = cam.R, S = 2;
  let seed = 5; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let r = 0, g = 0, b = 0;
    for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
      const dx = (x + (sx + 0.5) / S - 0.5 - W / 2) / cam.f, dy = (y + (sy + 0.5) / S - 0.5 - H / 2) / cam.f;
      const wx = R[0] * dx + R[3] * dy + R[6], wy = R[1] * dx + R[4] * dy + R[7], wz = R[2] * dx + R[5] * dy + R[8];
      if (wy >= -1e-4) { r += 60; g += 80; b += 70; } else { const s = -cam.pos[1] / wy, c = ground(cam.pos[0] + wx * s, cam.pos[2] + wz * s, o.creases !== false, o.paint ?? 232); r += c[0]; g += c[1]; b += c[2]; }
    }
    const k = (y * W + x) * 4, e = 6 * rnd();
    img[k] = r / (S * S) + e; img[k + 1] = g / (S * S) + e; img[k + 2] = b / (S * S) + e; img[k + 3] = 255;
  }
  if (o.people) {
    // upright blocks: the umpire behind the near stumps, the bowler at the crease, the batter and keeper at the far end
    for (const [x, z, half, tall, col] of [[0, 1.6, 0.3, 1.85, [30, 30, 40]], [-0.9, -0.6, 0.3, 1.9, [235, 235, 240]], [0.25, -19.2, 0.3, 1.8, [235, 235, 240]], [0.1, -21.3, 0.35, 1.2, [235, 235, 240]]] as [number, number, number, number, number[]][]) {
      const a = project(cam, [x - half, 0, z])!, b = project(cam, [x + half, tall, z])!;
      for (let y = Math.max(0, Math.round(b[1])); y <= Math.min(H - 1, Math.round(a[1])); y++) for (let xx = Math.max(0, Math.round(a[0])); xx <= Math.min(W - 1, Math.round(b[0])); xx++) { const k = (y * W + xx) * 4; img[k] = col[0]; img[k + 1] = col[1]; img[k + 2] = col[2]; }
    }
  }
  return img;
}
const IDS: MarkId[] = (["bowler", "batter"] as const).flatMap((end) => (["pop_l", "pop_r", "bowl_l", "bowl_r"] as const).map((kind) => ({ end, kind })));
const worst = (cam: ReturnType<typeof camAt>, marks: { end: string; kind: string; px: Pt }[]) =>
  Math.max(...IDS.map((id) => { const t = project(cam, worldOf(id))!, m = marks.find((q) => q.end === id.end && q.kind === id.kind)!; return Math.hypot(t[0] - m.px[0], t[1] - m.px[1]); }));

describe("finding the pitch from its creases", () => {
  const high = camAt([0.6, 16, 84], [0, 0, -10], 9000);
  it("finds an empty pitch with no help, to within a pixel and a half at every corner", () => {
    const r = findPitch(picture(high), W, H);
    expect(pitchFound(r)).toBe(true);
    expect(worst(high, r!.marks)).toBeLessThan(1.5);
    expect(r!.cam.pos[1]).toBeGreaterThan(5);
  });
  it("finds it with players standing on the creases, and is not taken in by the wide guide lines", () => {
    const r = findPitch(picture(high, { people: true }), W, H);
    expect(pitchFound(r)).toBe(true);
    expect(worst(high, r!.marks)).toBeLessThan(2);
  });
  it("two rough taps on the stumps are enough when the paint is faint", () => {
    const img = picture(high, { people: true, paint: 205 });
    const near = project(high, [0, 0, 0])!, far = project(high, [0, 0, -20.12])!;
    const r = findPitch(img, W, H, { near: [near[0] + 9, near[1] - 7], far: [far[0] - 8, far[1] + 6] });
    expect(pitchFound(r, true)).toBe(true);
    expect(worst(high, r!.marks)).toBeLessThan(2.5);
  });
  it("finds nothing where there is no pitch, or a strip with no creases painted, rather than something", () => {
    expect(pitchFound(findPitch(picture(camAt([30, 16, 84], [30, 0, -10], 9000)), W, H))).toBe(false);
    expect(pitchFound(findPitch(picture(high, { creases: false }), W, H))).toBe(false);
    const near = project(high, [0, 0, 0])!, far = project(high, [0, 0, -20.12])!;
    expect(pitchFound(findPitch(picture(high, { creases: false }), W, H, { near, far }), true)).toBe(false);
  });
});
