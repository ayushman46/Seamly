import { describe, expect, test } from "vitest";
import {
  BONES, boneLengths, estimatePxPerM, estimateWorldFrame, lbfgs, reconstruct, reconstructProblem, rotationAboutX,
  statureFromLengths, symmetricLengths, type Prior,
} from "../src/engine/kinematics";
import { median, type Arr3 } from "../src/engine/nd";
import { FIXTURES, loadFixture, maxAbsDiff } from "./fixtures";

// Deterministic perturbation of the initial parameters, shared with the Python reference below.
function perturb(x0: Float64Array, T: number): Float64Array {
  const x = x0.slice(), NP = T * 48;
  for (let k = 0; k < NP; k++) x[k] += 0.02 * Math.sin(0.37 * k + 0.1);
  for (let t = 0; t < T; t++) x[NP + t] += 0.05 * Math.cos(0.5 * t);
  return x;
}

// torch autograd at perturb(x0) on each fixture's second reconstruct call (with priors), recorded from
// bowlnet.kinematics.reconstruct's own closure; k0 = estimate_px_per_m(kp2d, conf, L_units * m_per_unit, fps)
// sampled at [0, T // 2, T - 1] and its mean.
const TORCH: Record<string, { loss: number; l1: number; gw: number; g0: number; gLast: number; k0: number[] }> = {
  synth_side: { loss: 793.8714299154699, l1: 85697.17619143243, gw: 1047.9432640303917, g0: -0.6638614338310371, gLast: 26.10812678126806, k0: [222.9782181734715, 221.97027367617042, 218.2498780803707, 221.4758469229137] },
  epping_side: { loss: 990.6484298543804, l1: 62402.26280290507, gw: -2588.1482168981966, g0: -88.4947014102748, gLast: -8.42259270858904, k0: [522.3245787696547, 519.6185962689377, 507.13645017231096, 516.3866762902579] },
  bumrah_behind: { loss: 1009.6997387282792, l1: 68032.14501351828, gw: -700.7679532127338, g0: -89.11217576139765, gLast: -19.981882344347657, k0: [168.65001128092615, 199.77314851421937, 265.12027379786537, 207.79642872859898] },
  anderson_edited: { loss: 3200.4579493609863, l1: 129342.84137042373, gw: -3844.875095254899, g0: -8.397097543086868, gLast: 6.974159251471967, k0: [85.55936982752475, 113.22113382219904, 152.38932814837855, 116.78312195124253] },
};

function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("reconstruct loss gradient", () => {
  test("analytic gradient matches central finite differences (small random problem, active priors)", () => {
    const rnd = mulberry32(7);
    const a = loadFixture("synth_side").calls.reconstruct[0].args;
    const T = 6;
    const X: Arr3 = a.X_norm.slice(30, 30 + T).map((fr: number[][]) => fr.map((p) => p.map((v) => v + 0.05 * (rnd() - 0.5))));
    const kp: Arr3 = a.kp2d.slice(30, 30 + T).map((fr: number[][]) => fr.map((p) => p.map((v) => v + 8 * (rnd() - 0.5))));
    const conf = a.conf.slice(30, 30 + T).map((r: number[]) => r.map(() => 0.2 + 0.8 * rnd()));
    const priors: Prior[] = [[[0, 1, 2, 3, 4, 5], 5, 6, [0.9, 0.1, 0.42], 0.5], [[2, 3, 9], 0, 6, [0, 0.2, 0.98], 0.3]];
    const pb = reconstructProblem(X, kp, conf, 1.8, 50, priors, null);
    const x = pb.x0.slice();
    for (let i = 0; i < x.length; i++) x[i] += 0.03 * (rnd() - 0.5);
    const g = new Float64Array(x.length);
    pb.fg(x, g);
    const h = 1e-6, tmp = new Float64Array(x.length);
    let worst = 0;
    for (let i = 0; i < x.length; i++) {
      const xp = x.slice(), xm = x.slice();
      xp[i] += h; xm[i] -= h;
      const fd = (pb.fg(xp, tmp) - pb.fg(xm, tmp)) / (2 * h);
      worst = Math.max(worst, Math.abs(fd - g[i]) / (1 + Math.abs(g[i])));
    }
    expect(worst).toBeLessThan(1e-5);
  });

  test.each(FIXTURES)("loss, gradient and k0 match torch autograd: %s", (name) => {
    const a = loadFixture(name).calls.reconstruct[1].args;
    const pb = reconstructProblem(a.X_norm, a.kp2d, a.conf, a.stature_m, a.fps, a.priors, a.depth_w);
    const x = perturb(pb.x0, pb.T);
    const g = new Float64Array(x.length);
    const loss = pb.fg(x, g);
    const ref = TORCH[name];
    let l1 = 0, gw = 0;
    g.forEach((v, i) => { l1 += Math.abs(v); gw += v * Math.cos(0.11 * i); });
    expect(Math.abs(loss / ref.loss - 1)).toBeLessThan(1e-12);
    expect(Math.abs(l1 / ref.l1 - 1)).toBeLessThan(1e-12);
    expect(Math.abs(gw - ref.gw)).toBeLessThan(1e-8);
    expect(Math.abs(g[0] - ref.g0)).toBeLessThan(1e-9);
    expect(Math.abs(g[g.length - 1] - ref.gLast)).toBeLessThan(1e-9);
    // estimate_px_per_m through the exported helpers
    const Xr = a.X_norm.map((fr: number[][]) => fr.map((p) => p.map((v, c) => v - fr[0][c])));
    const bl = boneLengths(Xr);
    const Lu = symmetricLengths(BONES.map((_, b) => median(bl.map((r) => r[b]))));
    const m = a.stature_m / statureFromLengths(Lu);
    const k0 = estimatePxPerM(a.kp2d, a.conf, Lu.map((v) => v * m), a.fps);
    const T = k0.length;
    const got = [k0[0], k0[T >> 1], k0[T - 1], k0.reduce((s, v) => s + v, 0) / T];
    expect(maxAbsDiff(got, ref.k0)).toBeLessThan(1e-9);
  });
});

describe("lbfgs", () => {
  // torch.optim.LBFGS([x], lr=1, max_iter=n, line_search_fn="strong_wolfe") on Rosenbrock from (-1.5, 2)
  test.each([
    [10, -1.0768265614154306, 1.1112274823448032, 12],
    [25, 0.3747914191717632, 0.12471993249716422, 31], // stops at max_eval = 25 * 5 // 4
    [100, 0.9999979943196398, 0.9999973438921637, 51],
  ])("reproduces torch's iterates (max_iter=%i)", (iters, x0, x1, evals) => {
    const x = new Float64Array([-1.5, 2.0]);
    let n = 0;
    lbfgs((p, g) => {
      n++;
      const a = 1 - p[0], b = p[1] - p[0] * p[0];
      g[0] = -2 * a - 400 * b * p[0];
      g[1] = 200 * b;
      return a * a + 100 * b * b;
    }, x, iters);
    expect(Math.abs(x[0] - x0)).toBeLessThan(1e-9);
    expect(Math.abs(x[1] - x1)).toBeLessThan(1e-9);
    expect(n).toBe(evals);
  });
});

describe("reconstruct parity with the Python pipeline", () => {
  const cases = FIXTURES.flatMap((n) => [0, 1].map((i) => [n, i] as const));
  test.each(cases)("%s call %i", (name, i) => {
    const { args: a, out } = loadFixture(name).calls.reconstruct[i];
    const s = reconstruct(a.X_norm, a.kp2d, a.conf, a.stature_m, a.fps,
      { iters: a.iters, priors: a.priors, depthW: a.depth_w });
    const T = a.X_norm.length;
    expect(s.joints.length).toBe(T);
    // L-BFGS stops at max_eval before full convergence, so trajectories (and a few boundary-frame joints) differ
    // at the level of the optimisation's own sensitivity to 1e-9 input changes (~1 mm mean in TS and in torch)
    let sum = 0;
    for (let t = 0; t < T; t++) for (let j = 0; j < 17; j++) {
      const p = s.joints[t][j], q = out.joints[t][j];
      sum += Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
    }
    expect(sum / (T * 17)).toBeLessThan(0.005);
    const rel = (u: number[], v: number[]) => Math.max(...u.map((x, k) => Math.abs(x / v[k] - 1)));
    expect(rel(s.bone_lengths, out.bone_lengths)).toBeLessThan(1e-5);
    expect(rel(s.px_per_m, out.px_per_m)).toBeLessThan(5e-3);
    expect(maxAbsDiff(s.root_px, out.root_px)).toBeLessThan(1e-4);
    expect(s.stature_m).toBe(out.stature_m);
    const mean = (E: number[][]) => E.flat().reduce((p, q) => p + q, 0) / E.flat().length;
    expect(Math.abs(mean(s.reproj_err_px) / mean(out.reproj_err_px) - 1)).toBeLessThan(0.01);
  });
});

describe("world frame", () => {
  test("rotationAboutX", () => {
    const R = rotationAboutX(90);
    expect(maxAbsDiff(R, [[1, 0, 0], [0, 0, -1], [0, 1, 0]])).toBeLessThan(1e-15);
  });

  const cases = FIXTURES.flatMap((n) => loadFixture(n).calls.estimate_world_frame.map((_: unknown, i: number) => [n, i] as const));
  test.each(cases)("estimateWorldFrame %s call %i", (name, i) => {
    const { args: a, out } = loadFixture(name).calls.estimate_world_frame[i];
    const wf = estimateWorldFrame(a.P, a.ffc, a.bfc, a.front_ankle, a.back_ankle, a.forward_hint, a.hint_reliable);
    expect(maxAbsDiff(wf.up, out.up)).toBeLessThan(1e-6);
    expect(maxAbsDiff(wf.forward, out.forward)).toBeLessThan(1e-6);
    expect(maxAbsDiff(wf.lateral, out.lateral)).toBeLessThan(1e-6);
    expect(Math.abs(wf.camera_pitch_deg - out.camera_pitch_deg)).toBeLessThan(1e-4);
  });

  test("stride defines forward when the hint is unreliable; a disagreeing reliable hint wins (vs Python)", () => {
    const P: Arr3 = [Array.from({ length: 17 }, () => [0, 0, 0])];
    P[0][6] = [0.2, 0.05, 0.8]; // front ankle ahead, in depth
    const a = estimateWorldFrame(P, 0, null, 6, 3, [0, 0, 1], false);
    expect(a.camera_pitch_deg).toBeCloseTo(1.9547371498417427, 12);
    expect(maxAbsDiff(a.up, [0.0, -0.9994180852731454, -0.03410998136850911])).toBeLessThan(1e-12);
    expect(maxAbsDiff(a.forward, [0.24315663481521443, -0.03308623974213522, 0.9694225867417503])).toBeLessThan(1e-12);
    expect(maxAbsDiff(a.lateral, [-0.969987036483138, -0.008294068283176338, 0.24301513838848304])).toBeLessThan(1e-12);
    const b = estimateWorldFrame(P, 0, null, 6, 3, [1, 0, 0], true);
    expect(b.camera_pitch_deg).toBe(0);
    expect(maxAbsDiff([b.up, b.forward, b.lateral], [[0, -1, 0], [1, 0, 0], [0, 0, 1]])).toBe(0);
    const c = estimateWorldFrame(P, null, null, 6, 3, null);
    expect(maxAbsDiff([c.up, c.forward], [[0, -1, 0], [0, 0, 1]])).toBe(0);
  });
});
