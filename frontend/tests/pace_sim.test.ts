/**
 * Ball speed against simulated deliveries: drag (new to old ball), a bounce anywhere from short to full that keeps
 * 70-92% of the horizontal speed, a release point from 0.2 m behind to 0.7 m in front of the popping crease, and each
 * mark (release, pitch, arrival) a frame off either way. The stated range must hold the true speed nearly always.
 * (The full 20,000-delivery run is reported in docs/ACCURACY.md.)
 */
import { describe, expect, it } from "vitest";
import { paceFrom } from "../src/lib/pace";

// seeded random
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const U = (a: number, b: number) => a + (b - a) * rnd();

/** Flight of a cricket ball: quadratic drag, bounce losing horizontal speed. Returns times from release to the pitch
 * and to a line `target` m beyond the bowler's popping crease, for a release `delta` m in front of that crease. */
function fly(v0: number, pitchAt: number, cd: number, ex: number, delta: number, target: number) {
  const k = 0.5 * 1.2 * cd * Math.PI * 0.036 ** 2 / 0.156, g = 9.81, dt = 2e-4;
  const shoot = (vz0: number) => {   // horizontal position where the ball lands, for a launch vertical speed
    let x = delta, z = 2.2, vx = v0, vz = vz0;
    while (z > 0) { const v = Math.hypot(vx, vz); vx -= k * v * vx * dt; vz -= (g + k * v * vz) * dt; x += vx * dt; z += vz * dt; }
    return x;
  };
  let lo = -15, hi = 5;
  for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (shoot(m) < pitchAt) lo = m; else hi = m; }
  let x = delta, z = 2.2, vx = v0, vz = (lo + hi) / 2, t = 0, tp = 0, bounced = false;
  while (x < target) {
    const v = Math.hypot(vx, vz); vx -= k * v * vx * dt; vz -= (g + k * v * vz) * dt; x += vx * dt; z += vz * dt; t += dt;
    if (!bounced && z <= 0) { bounced = true; tp = t; vx *= ex; vz = -0.5 * vz; z = 0; }
  }
  return { tp, ta: t };
}

function run(fps: number, markPitch: boolean, n: number) {
  const errs: number[] = []; let inside = 0, ok = 0;
  for (let i = 0; i < n; i++) {
    const kmh = U(95, 150), v0 = kmh / 3.6;
    const pitchAt = U(9, 16), cd = U(0.45, 0.65), ex = U(0.70, 0.92), delta = U(-0.2, 0.7);
    const { tp, ta } = fly(v0, pitchAt, cd, ex, delta, 17.68);
    const t0 = 5 / fps + U(0, 1 / fps);
    const frame = (t: number) => Math.round((t0 + t) * fps);
    const jitter = () => Math.round(U(-1, 1));
    const N = Math.ceil((t0 + ta) * fps) + 8;
    const r = { frames: { start: 0, end: N, times: Array.from({ length: N }, (_, j) => j / fps) }, fps_real: fps, options: { slowmo_factor: 1 } } as never;
    const p = paceFrom(r, { release: frame(0) + jitter(), arrival: frame(ta) + jitter(), target: "crease", bounced: true, pitch: markPitch ? frame(tp) + jitter() : null });
    if (!p) continue;
    ok++; errs.push(Math.abs(p.kmh - kmh));
    if (kmh >= p.lo && kmh <= p.hi) inside++;
  }
  errs.sort((a, b) => a - b);
  return { coverage: inside / ok, median: errs[Math.floor(errs.length / 2)], refused: 1 - ok / n };
}

describe("ball speed on simulated deliveries", () => {
  it("at 60 fps: the range holds the true speed and the error is a few km/h", () => {
    const free = run(60, false, 300), marked = run(60, true, 300);
    expect(free.coverage).toBeGreaterThan(0.9);
    expect(marked.coverage).toBeGreaterThan(0.85);
    expect(free.median).toBeLessThan(7);
    expect(marked.median).toBeLessThan(5);
    expect(free.refused + marked.refused).toBeLessThan(0.02);
  });
  it("at 240 fps with the pitch marked: tighter", () => {
    const r = run(240, true, 300);
    expect(r.coverage).toBeGreaterThan(0.85);
    expect(r.median).toBeLessThan(4);
  });
});
