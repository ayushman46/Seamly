/** Parity of engine/pose2d.ts (and its scipy/numpy ports) with Python cases generated from the fixture keypoints. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURES, loadFixture } from "./fixtures";
import {
  akima1d, assemble, bodyHeightPx, butter, filtfilt, fixSwaps, hampel, interpolateGaps, npInterp, smoothKeypoints,
  uniformFilter1dScipy,
} from "../src/engine/pose2d";
import { npPercentile, unwrap } from "../src/engine/events";
import type { Detection } from "../src/engine/bowler";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const CASES: Any = JSON.parse(readFileSync(join(__dirname, "fixtures", "pose_events_bowler_cases.json"), "utf8"));

/** Max |a-b| over nested arrays; NaN/null on both sides count as equal. */
function maxDiff(a: Any, b: Any): number {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return Infinity;
    return a.reduce((m: number, v: Any, i: number) => Math.max(m, maxDiff(v, b[i])), 0);
  }
  const na = a === null || Number.isNaN(a), nb = b === null || Number.isNaN(b);
  if (na || nb) return na && nb ? 0 : Infinity;
  return Math.abs(a - b);
}
/** Like maxDiff, relative to max(|b|, 1). */
function maxRel(a: Any, b: Any): number {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return Infinity;
    return a.reduce((m: number, v: Any, i: number) => Math.max(m, maxRel(v, b[i])), 0);
  }
  const na = a === null || Number.isNaN(a), nb = b === null || Number.isNaN(b);
  if (na || nb) return na && nb ? 0 : Infinity;
  return Math.abs(a - b) / Math.max(1, Math.abs(b));
}
const PX = 1e-6;   // px tolerance asked for; most cases agree to ~1e-12
const EXACT = 1e-9;   // expected outputs are stored to 12 significant digits
/** Same zero/non-zero pattern (outlier rejection decisions) and values within EXACT. */
function sameConf(a: number[][], b: number[][]) {
  expect(a.map((r) => r.map((v) => v > 0))).toEqual(b.map((r) => r.map((v) => v > 0)));
  expect(maxDiff(a, b)).toBeLessThan(EXACT);
}

describe("scipy / numpy primitives", () => {
  it.each((CASES.signal as Any[]).map((c, i) => [i, c.fn, c]))("#%i %s", (_i, fn, c: Any) => {
    const a = c.args;
    switch (fn) {
      case "butter": {
        const [b, aa] = butter(a.N, a.Wn);
        expect(maxDiff([b, aa], c.out)).toBeLessThan(1e-13);
        break;
      }
      case "filtfilt":
        expect(maxRel(filtfilt(a.b, a.a, a.x, a.padlen), c.out)).toBeLessThan(1e-11);
        break;
      case "akima":
        expect(maxRel(akima1d(a.x, a.y)(a.xs), c.out)).toBeLessThan(1e-12);
        break;
      case "interp":
        expect(maxRel(npInterp(a.xs, a.x, a.y), c.out)).toBeLessThan(1e-14);
        break;
      case "uniform_filter1d":
        expect(maxRel(uniformFilter1dScipy(a.x, a.size), c.out)).toBeLessThan(1e-13);
        break;
      case "percentile":
        expect(maxRel(npPercentile(a.x, a.q), c.out)).toBeLessThan(1e-14);
        break;
      case "unwrap":
        expect(maxRel(unwrap(a.x), c.out)).toBeLessThan(1e-14);
        break;
      default:
        throw new Error(fn);
    }
  });
});

describe.each(FIXTURES)("pose2d parity: %s", (name) => {
  const fx = loadFixture(name);
  const sa = fx.stage_a;
  const fps = fx.stage_a_meta.fps * fx.stage_a_meta.options.slowmo_factor;
  const resolve = (v: Any) => (v === "$kp" ? sa.kp : v === "$kc" ? sa.kc : v === "$kp15" ? sa.kp.slice(0, 15) : v);
  const cases: Any[] = CASES.pose2d[name];

  it.each(cases.map((c, i) => [i, c.fn, c]))("#%i %s", (_i, fn, c: Any) => {
    const a: Any = Object.fromEntries(Object.entries(c.args).map(([k, v]) => [k, resolve(v)]));
    switch (fn) {
      case "hampel":
        sameConf(hampel(a.kp, a.kc, a.fps, a.n_sigma), c.out);
        break;
      case "fix_swaps": {
        const [kp, kc, n] = fixSwaps(a.kp, a.kc, a.switch_cost);
        expect(n).toBe(c.out[2]);
        if (a.switch_cost !== undefined) expect(n).toBeGreaterThan(0);   // the injected swaps are found
        expect(maxDiff(kp, c.out[0])).toBeLessThan(EXACT);
        sameConf(kc, c.out[1]);
        break;
      }
      case "interpolate_gaps": {
        const [kp, kc] = interpolateGaps(a.kp, a.kc, a.fps, a.max_gap_s);
        expect(maxDiff(kp, c.out[0])).toBeLessThan(PX);
        expect(maxRel(kp, c.out[0])).toBeLessThan(1e-11);
        expect(maxDiff(kc, c.out[1])).toBeLessThan(EXACT);
        break;
      }
      case "smooth_keypoints":
        // float32 output: allow one float32 ulp in case the float64 results straddle a rounding boundary
        expect(maxRel(smoothKeypoints(a.kp, a.fps), c.out)).toBeLessThan(1.2e-7);
        expect(maxDiff(smoothKeypoints(a.kp, a.fps), c.out)).toBeLessThan(PX);
        break;
      case "body_height_px":
        expect(maxDiff(bodyHeightPx(a.kp, a.kc), c.out)).toBeLessThan(PX);
        break;
      case "assemble": {
        const tracked = new Map<number, Detection>((a.tracked as Any[]).map((d) => [d.frame, d]));
        const [kp, kc] = assemble(a.refined, tracked, a.f0, a.f1);
        expect(maxRel(kp, c.out[0])).toBeLessThan(1e-11);
        sameConf(kc, c.out[1]);
        break;
      }
      case "chain": {
        // assemble -> hampel -> fix_swaps -> interpolate_gaps -> smooth_keypoints, as stage A runs them. Python's
        // float32 run stores interpolated samples as float32 (<= ~6e-5 px off the float64 values); decisions match.
        const tol = a.dtype === "float32" ? 2e-4 : PX;
        const asm = cases.find((x) => x.fn === "assemble");
        const tracked = new Map<number, Detection>((asm.args.tracked as Any[]).map((d) => [d.frame, d]));
        const [akp, akc] = assemble(asm.args.refined, tracked, asm.args.f0, asm.args.f1);
        const hk = hampel(akp, akc, a.fps);
        sameConf(hk, c.out.kc_hampel);
        const [sk, sc, nsw] = fixSwaps(akp, hk);
        expect(nsw).toBe(c.out.swaps);
        const [ik, ic] = interpolateGaps(sk, sc, a.fps);
        expect(maxDiff(ik, c.out.kp)).toBeLessThan(tol);
        expect(ic.map((r) => r.map((v) => v > 0))).toEqual(c.out.kc.map((r: number[]) => r.map((v) => v > 0)));
        expect(maxDiff(ic, c.out.kc)).toBeLessThan(a.dtype === "float32" ? 1e-8 : EXACT);
        expect(maxDiff(smoothKeypoints(ik, a.fps), c.out.kp_s)).toBeLessThan(tol);
        break;
      }
      default:
        throw new Error(fn);
    }
  });

  it("smooth_keypoints(stage_a.kp) reproduces the stored stage_a.kp_s", () => {
    // stage A smooths the full window, then may trim it (_usable_length); compare away from the trimmed end
    const ks = smoothKeypoints(sa.kp, fps);
    const T = sa.kp_s.length;
    const n = Math.max(0, T - 20);
    // stored values are float32 (rounded to 7 decimals in the fixture): ~5e-8 px everywhere, ~3e-5 px where float32
    // padding arithmetic differs; bumrah_behind's window was trimmed after smoothing, which shows near its end
    expect(maxDiff(ks.slice(0, n), sa.kp_s.slice(0, n))).toBeLessThan(1e-4);
  });
});
