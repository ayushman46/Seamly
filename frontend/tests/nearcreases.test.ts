import { describe, expect, it } from "vitest";
import { project, onPlaneY, onPlaneZ, solveCamera, isCamera, worldOf, type Camera, type Mark, type MarkKind, type Pt } from "../src/lib/camcal";
import { findNearCreases } from "../src/lib/autopitch";
import type { V3 } from "../src/lib/biomech";

/**
 * The creases at the bowler's end, found on pictures rendered here where the camera is known exactly: a pitch painted
 * to the Laws' sizes on rough turf, through a pinhole camera, with noise. What matters is not the camera itself but
 * what it then measures at that end, so each test places a hand and a heel through the found camera and compares.
 */
function camAt(pos: V3, at: V3, f: number, W: number, H: number): Camera {
  const z = [at[0] - pos[0], at[1] - pos[1], at[2] - pos[2]], n = Math.hypot(z[0], z[1], z[2]), zc = z.map((v) => v / n);
  const nx = Math.hypot(zc[2], zc[0]), xc = [-zc[2] / nx, 0, zc[0] / nx];
  const yc = [zc[1] * xc[2] - zc[2] * xc[1], zc[2] * xc[0] - zc[0] * xc[2], zc[0] * xc[1] - zc[1] * xc[0]];
  const R = [...xc, ...yc, ...zc];
  const t: V3 = [-(R[0] * pos[0] + R[1] * pos[1] + R[2] * pos[2]), -(R[3] * pos[0] + R[4] * pos[1] + R[5] * pos[2]), -(R[6] * pos[0] + R[7] * pos[1] + R[8] * pos[2])];
  return { f, R, t, w: W, h: H, pos, rms: 0, worst: 0, marks: 0 };
}
const hash = (a: number, b: number) => { let h = (a * 374761393 + b * 668265263) | 0; h = (h ^ (h >>> 13)) * 1274126177; return ((h ^ (h >>> 16)) >>> 0) / 4294967295; };
function ground(x: number, z: number, creases: boolean): [number, number, number] {
  const n = hash(Math.floor(x / 0.05), Math.floor(z / 0.05)) - 0.5, n2 = hash(Math.floor(x / 0.6) + 99, Math.floor(z / 0.6)) - 0.5;
  const onPitch = Math.abs(x) < 1.525 && z < 1.22 && z > -21.34;
  let r = onPitch ? 196 : 70, g = onPitch ? 180 : 125, b = onPitch ? 140 : 60;
  const v = 18 * n + 16 * n2; r += v; g += v; b += v;
  if (creases) {
    const line = (x0: number, x1: number, z0: number, z1: number) => x >= x0 && x <= x1 && z >= Math.min(z0, z1) && z <= Math.max(z0, z1);
    for (const [zs, to] of [[0, -1], [-20.12, 1]] as const) {
      if (line(-1.36, 1.36, zs, zs + to * 0.04) || line(-2.6, 2.6, zs + to * 1.22, zs + to * 1.26) || line(1.32, 1.36, zs + to * 1.26, zs - to * 1.22) || line(-1.36, -1.32, zs + to * 1.26, zs - to * 1.22)) { r = g = b = 232; }
    }
  }
  return [r, g, b];
}
function picture(cam: Camera, creases = true) {
  const W = cam.w, H = cam.h, img = new Uint8ClampedArray(W * H * 4), R = cam.R, S = 3;
  let seed = 5; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let r = 0, g = 0, b = 0;
    for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
      const dx = (x + (sx + 0.5) / S - 0.5 - W / 2) / cam.f, dy = (y + (sy + 0.5) / S - 0.5 - H / 2) / cam.f;
      const wx = R[0] * dx + R[3] * dy + R[6], wy = R[1] * dx + R[4] * dy + R[7], wz = R[2] * dx + R[5] * dy + R[8];
      if (wy >= -1e-4) { r += 60; g += 80; b += 70; } else { const s = -cam.pos[1] / wy, c = ground(cam.pos[0] + wx * s, cam.pos[2] + wz * s, creases); r += c[0]; g += c[1]; b += c[2]; }
    }
    const k = (y * W + x) * 4, e = 6 * rnd();
    img[k] = r / (S * S) + e; img[k + 1] = g / (S * S) + e; img[k + 2] = b / (S * S) + e; img[k + 3] = 255;
  }
  return img;
}
const hand: V3 = [-0.45, 2.0, -1.15], heel: V3 = [-0.5, 0.055, -0.9];
/** What the found camera makes of a hand and a heel placed by the true one, in centimetres out. */
function measured(found: Camera, truth: Camera) {
  const hz = onPlaneY(found, project(truth, heel)!, 0.055)!, hd = onPlaneZ(found, project(truth, hand)!, hz[2] + (hand[2] - heel[2]))!;
  return { height: (hd[1] - hand[1]) * 100, across: (hd[0] - hand[0]) * 100, heelZ: (hz[2] - heel[2]) * 100 };
}

describe("the creases at the bowler's end, on their own", () => {
  const views: [string, V3, V3, number, number, number][] = [
    ["a phone on a tall tripod, 720p (the far creases a fifth of a pixel thick)", [0.9, 3.4, 10.5], [0, 0.6, -10], 1180, 1280, 720],
    ["a tripod at chest height, close behind", [-0.5, 1.45, 6], [0, 0.9, -10], 1000, 1280, 720],
    ["high and far, a long lens", [1.5, 12, 60], [0, 0, -8], 5200, 1280, 720],
  ];
  for (const [name, pos, at, f, W, H] of views) {
    const truth = camAt(pos, at, f, W, H), img = picture(truth);
    const base = project(truth, [0, 0, 0])!, top = project(truth, [0, 0.711, 0])!, size = Math.hypot(base[0] - top[0], base[1] - top[1]);
    it(`found around the foot of the stumps, and what they measure is right: ${name}`, () => {
      const nc = findNearCreases(img, W, H, base, size, true);
      expect(nc, "found").toBeTruthy();
      expect(nc!.least).toBeGreaterThanOrEqual(12);          // paint seen on every one of the four lines
      expect(nc!.cam.rms).toBeLessThan(1);
      const m = measured(nc!.cam, truth);
      expect(Math.abs(m.height)).toBeLessThan(1.5); expect(Math.abs(m.across)).toBeLessThan(2); expect(Math.abs(m.heelZ)).toBeLessThan(6);
      // the marks it hands on give the same camera again (this is what is kept with the analysis)
      const again = solveCamera(nc!.marks, W, H);
      expect(isCamera(again)).toBe(true);
      expect(Math.abs(measured(again as Camera, truth).height)).toBeLessThan(1.5);
    });
    it(`found around the bowler's feet when the stumps were not: ${name}`, () => {
      // a place a metre off the stumps and not on the crease, and a size a tenth out: what the bowler's back foot gives
      const foot = project(truth, [-0.6, 0, 0.5])!;
      const nc = findNearCreases(img, W, H, foot, size * 0.9, false);
      expect(nc, "found").toBeTruthy();
      const m = measured(nc!.cam, truth);
      expect(Math.abs(m.height)).toBeLessThan(1.5); expect(Math.abs(m.across)).toBeLessThan(2); expect(Math.abs(m.heelZ)).toBeLessThan(6);
    });
  }
  it("finds nothing on a strip with no creases painted", () => {
    const truth = camAt([0.9, 3.4, 10.5], [0, 0.6, -10], 1180, 1280, 720), base = project(truth, [0, 0, 0])!;
    expect(findNearCreases(picture(truth, false), 1280, 720, base, 77, true)).toBeNull();
  });
});

describe("a camera from the bowler's end alone", () => {
  // marks as the finder gives them: the four corners at this end, each good to half a pixel; nothing at the far end
  const ids: MarkKind[] = ["pop_l", "pop_r", "bowl_l", "bowl_r"];
  for (const [name, pos, at, f, W, H] of [["phone, tall tripod", [0.9, 3.4, 10.5], [0, 0.6, -10], 1180, 1280, 720], ["chest height, close", [-0.5, 1.45, 6], [0, 0.9, -10], 1500, 1920, 1080],
    ["club boundary, 25 m back", [2, 2.0, 25], [0, 0.8, -8], 3000, 1920, 1080], ["broadcast", [1.5, 16, 84], [0, 0, -7.5], 11500, 1920, 1080]] as [string, V3, V3, number, number, number][]) {
    it(`measures at that end to about a centimetre: ${name}`, () => {
      const truth = camAt(pos, at, f, W, H);
      let seed = 99; const g = () => { let s = 0; for (let i = 0; i < 4; i++) { seed = (seed * 16807) % 2147483647; s += seed / 2147483647 - 0.5; } return s * Math.sqrt(3); };
      const eh: number[] = [], ez: number[] = [];
      for (let k = 0; k < 20; k++) {
        const marks: Mark[] = ids.map((kind) => { const p = project(truth, worldOf({ end: "bowler", kind }))!; return { end: "bowler" as const, kind, px: [p[0] + 0.5 * g(), p[1] + 0.5 * g()] as Pt }; });
        const cam = solveCamera(marks, W, H);
        expect(isCamera(cam)).toBe(true);
        const m = measured(cam as Camera, truth);
        eh.push(m.height); ez.push(m.heelZ);
      }
      const rms = (v: number[]) => Math.sqrt(v.reduce((s, e) => s + e * e, 0) / v.length);
      expect(rms(eh)).toBeLessThan(1.2);       // the release height: under a centimetre or so from the camera alone
      expect(rms(ez)).toBeLessThan(6);         // a heel down the pitch: a few centimetres (most from far away and low)
    });
  }
});
