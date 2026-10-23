/**
 * 2D keypoint sequence assembly and cleanup for the bowler (port of backend/bowlnet/pose2d.py).
 *
 * Order of operations (follows markerless-biomechanics practice, e.g. Sports2D / OpenCap):
 *  1. merge top-down refined keypoints with tracker keypoints (fallback), confidence-gated
 *  2. Hampel outlier rejection per joint (window ~0.1 s, 3 MAD)
 *  3. left/right swap correction per limb chain (2-state Viterbi on motion continuity) - must run before 3D lifting,
 *     otherwise the lifter inherits the swaps
 *  4. short-gap interpolation (Akima), long gaps keep low confidence
 *  5. zero-lag Butterworth smoothing with joint-specific cut-offs (arms are left sharper than trunk/legs)
 *
 * Also hosts exact ports of the scipy/numpy routines this needs (Akima1DInterpolator, butter, lfilter_zi, filtfilt,
 * uniform_filter1d, np.interp, np.median). Python stores keypoints as float32; Math.fround mirrors the explicit
 * float32 casts (assemble, body_height_px, smooth_keypoints), everything else is float64.
 */
import type { Arr1, Arr2, Arr3 } from "./nd";
import type { Detection } from "./bowler";
import { round } from "./util";

// COCO indices
export const CHAINS: Record<string, [number[], number[]]> = {
  arm: [[5, 7, 9], [6, 8, 10]],
  // the forearms alone: when the arms cross at release a detector can swap elbows + wrists but not the shoulders,
  // which the whole-arm chain (shoulders included) can't repair
  forearm: [[7, 9], [8, 10]],
  leg: [[11, 13, 15], [12, 14, 16]],
  face: [[1, 3], [2, 4]],
};
export const ARM_JOINTS = new Set([7, 8, 9, 10]);

const f32 = Math.fround;
const pyRound = (x: number): number => Math.trunc(round(x));

// ---------------- numpy / scipy ports ----------------
/** np.median of a 1-D array (NaN if empty or any NaN). */
export function npMedian(a: Arr1): number {
  const n = a.length;
  if (!n || a.some((v) => Number.isNaN(v))) return NaN;
  const s = a.slice().sort((x, y) => x - y);
  const h = n >> 1;
  return n % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}

/** scipy.ndimage.uniform_filter1d(a, size, mode="nearest"): scipy's running-sum arithmetic. */
export function uniformFilter1dScipy(a: Arr1, size: number): Arr1 {
  const n = a.length;
  if (!n) return [];
  const s1 = Math.floor(size / 2);
  const at = (i: number) => a[Math.min(n - 1, Math.max(0, i - s1))];   // extended line, index 0 = a[-s1]
  const out = new Array<number>(n);
  let tmp = 0.0;
  for (let k = 0; k < size; k++) tmp += at(k);
  tmp /= size;
  out[0] = tmp;
  for (let k = 1; k < n; k++) {
    tmp += (at(k + size - 1) - at(k - 1)) / size;
    out[k] = tmp;
  }
  return out;
}

/** np.interp(x, xp, fp) for increasing xp (numpy's slope arithmetic, end values outside). */
export function npInterp(xs: Arr1, xp: Arr1, fp: Arr1): Arr1 {
  const n = xp.length;
  return xs.map((x) => {
    if (Number.isNaN(x)) return x;
    if (x < xp[0]) return fp[0];
    if (x > xp[n - 1]) return fp[n - 1];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (xp[m] <= x) lo = m; else hi = m;
    }
    const j = x >= xp[n - 1] ? n - 1 : lo;
    if (j === n - 1 || xp[j] === x) return fp[j];
    const slope = (fp[j + 1] - fp[j]) / (xp[j + 1] - xp[j]);
    let r = slope * (x - xp[j]) + fp[j];
    if (Number.isNaN(r)) {
      r = slope * (x - xp[j + 1]) + fp[j + 1];
      if (Number.isNaN(r) && fp[j] === fp[j + 1]) r = fp[j];
    }
    return r;
  });
}

/** scipy.interpolate.Akima1DInterpolator(x, y) (method="akima", extrapolate=False: NaN outside [x0, xn]).
 * x strictly increasing, n >= 2. Returns the evaluator. */
export function akima1d(x: Arr1, y: Arr1): (xs: Arr1) => Arr1 {
  const n = x.length;
  const dx = x.slice(1).map((v, i) => v - x[i]);
  let t: Arr1;
  if (n === 2) {
    const mk = (y[1] - y[0]) / dx[0];
    t = [mk, mk];
  } else {
    const m = new Array<number>(n + 3);
    for (let i = 0; i < n - 1; i++) m[i + 2] = (y[i + 1] - y[i]) / dx[i];
    // two additional points on the left ... and on the right
    m[1] = 2.0 * m[2] - m[3];
    m[0] = 2.0 * m[1] - m[2];
    m[n + 1] = 2.0 * m[n] - m[n - 1];
    m[n + 2] = 2.0 * m[n + 1] - m[n];
    // if m1 == m2 != m3 == m4, the slope at the breakpoint is not defined; this is the fill value
    t = Array.from({ length: n }, (_, i) => 0.5 * (m[i + 3] + m[i]));
    const dm = Array.from({ length: n + 2 }, (_, i) => Math.abs(m[i + 1] - m[i]));
    const f1 = dm.slice(2), f2 = dm.slice(0, n);
    const f12 = f1.map((v, i) => v + f2[i]);
    const lim = 1e-9 * f12.reduce((a, b) => (b > a || Number.isNaN(b) ? b : a), -Infinity);
    for (let i = 0; i < n; i++) if (f12[i] > lim) t[i] = (f1[i] * m[i + 1] + f2[i] * m[i + 2]) / f12[i];
  }
  // CubicHermiteSpline -> PPoly coefficients
  const c: Arr2 = dx.map((h, i) => {
    const slope = (y[i + 1] - y[i]) / h;
    const tt = (t[i] + t[i + 1] - 2 * slope) / h;
    return [tt / h, (slope - t[i]) / h - tt, t[i], y[i]];
  });
  return (xs: Arr1) => xs.map((xv) => {
    if (!(x[0] <= xv && xv <= x[n - 1])) return NaN;
    let i: number;
    if (xv === x[n - 1]) i = n - 2;
    else {
      let lo = 0, hi = n - 1;   // x[lo] <= xv < x[hi]
      while (hi - lo > 1) {
        const mm = (lo + hi) >> 1;
        if (x[mm] <= xv) lo = mm; else hi = mm;
      }
      i = lo;
    }
    // PPoly evaluate_poly1: sum of c[k] * s**(3-k), accumulated from the constant term
    const s = xv - x[i];
    let res = 0.0, z = 1.0;
    for (let k = 3; k >= 0; k--) {
      res = res + c[i][k] * z;
      if (k > 0) z *= s;
    }
    return res;
  });
}

type Cx = [number, number];
const cmul = (a: Cx, b: Cx): Cx => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
/** numpy's complex division (Smith's method). */
function cdiv(a: Cx, b: Cx): Cx {
  const [ar, ai] = a, [br, bi] = b;
  if (Math.abs(br) >= Math.abs(bi)) {
    const rat = bi / br, scl = 1.0 / (br + bi * rat);
    return [(ar + ai * rat) * scl, (ai - ar * rat) * scl];
  }
  const rat = br / bi, scl = 1.0 / (bi + br * rat);
  return [(ar * rat + ai) * scl, (ai * rat - ar) * scl];
}
/** np.poly(roots): polynomial coefficients from roots (complex). */
function polyC(roots: Cx[]): Cx[] {
  let a: Cx[] = [[1, 0]];
  for (const r of roots) {
    const v: Cx[] = [[1, 0], [-r[0], -r[1]]];
    const out: Cx[] = Array.from({ length: a.length + 1 }, () => [0, 0] as Cx);
    for (let i = 0; i < a.length; i++) {
      for (let k = 0; k < 2; k++) {
        const p = cmul(a[i], v[k]);
        out[i + k] = [out[i + k][0] + p[0], out[i + k][1] + p[1]];
      }
    }
    a = out;
  }
  return a;
}

/** scipy.signal.butter(N, Wn) low-pass, output="ba" (buttap -> lp2lp_zpk -> bilinear_zpk -> zpk2tf). */
export function butter(N: number, Wn: number): [Arr1, Arr1] {
  const p: Cx[] = [];
  for (let m = -N + 1; m < N; m += 2) {
    const th = (Math.PI * m) / (2 * N);
    p.push([-Math.cos(th), -Math.sin(th)]);
  }
  const fs = 2.0;
  const wo = 2 * fs * Math.tan((Math.PI * Wn) / fs);   // pre-warped
  const pl = p.map(([r, i]): Cx => [wo * r, wo * i]);
  const kl = wo ** N;
  const fs2 = 2.0 * fs;
  const pz = pl.map((q) => cdiv([fs2 + q[0], q[1]], [fs2 - q[0], -q[1]]));
  let prod: Cx = [1, 0];
  pl.forEach((q, i) => { prod = i === 0 ? [fs2 - q[0], -q[1]] : cmul(prod, [fs2 - q[0], -q[1]]); });
  const kz = kl * cdiv([1, 0], prod)[0];
  const zz: Cx[] = Array.from({ length: N }, () => [-1, 0] as Cx);
  const b = polyC(zz).map((v) => kz * v[0]);
  const a = polyC(pz).map((v) => v[0]);   // conjugate pole pairs -> real
  return [b, a];
}

/** Solve A x = B (LU with partial pivoting, like LAPACK gesv). */
function solve(A: Arr2, B: Arr1): Arr1 {
  const n = B.length;
  const M = A.map((r) => r.slice()), y = B.slice();
  for (let k = 0; k < n; k++) {
    let piv = k;
    for (let i = k + 1; i < n; i++) if (Math.abs(M[i][k]) > Math.abs(M[piv][k])) piv = i;
    [M[k], M[piv]] = [M[piv], M[k]];
    [y[k], y[piv]] = [y[piv], y[k]];
    const r = 1.0 / M[k][k];
    for (let i = k + 1; i < n; i++) {
      const l = M[i][k] * r;
      for (let j = k + 1; j < n; j++) M[i][j] -= l * M[k][j];
      y[i] -= l * y[k];
    }
  }
  const x = new Array<number>(n);
  for (let k = n - 1; k >= 0; k--) {
    let s = y[k];
    for (let j = k + 1; j < n; j++) s -= M[k][j] * x[j];
    x[k] = s / M[k][k];
  }
  return x;
}

/** scipy.signal.lfilter_zi: steady state of the step response (a[0] == 1 assumed, as butter returns). */
export function lfilterZi(b: Arr1, a: Arr1): Arr1 {
  const n = Math.max(a.length, b.length);
  const aa = [...a, ...new Array(n - a.length).fill(0)], bb = [...b, ...new Array(n - b.length).fill(0)];
  // IminusA = I - companion(a).T; companion: first row -a[1:]/a[0], ones on the sub-diagonal
  const comp = (i: number, j: number) => (i === 0 ? -aa[j + 1] / aa[0] : i === j + 1 ? 1 : 0);
  const IminusA = Array.from({ length: n - 1 }, (_, i) => Array.from({ length: n - 1 }, (_, j) => (i === j ? 1 : 0) - comp(j, i)));
  const B = bb.slice(1).map((v, i) => v - aa[i + 1] * bb[0]);
  return solve(IminusA, B);
}

/** scipy.signal.lfilter(b, a, x, zi=zi): direct form II transposed (a[0] == 1). */
export function lfilter(b: Arr1, a: Arr1, x: Arr1, zi: Arr1): Arr1 {
  const n = b.length;
  const Z = zi.slice();
  return x.map((xn) => {
    const yn = Z[0] + b[0] * xn;
    for (let i = 0; i < n - 2; i++) Z[i] = Z[i + 1] + xn * b[i + 1] - yn * a[i + 1];
    Z[n - 2] = xn * b[n - 1] - yn * a[n - 1];
    return yn;
  });
}

/** scipy.signal.filtfilt(b, a, x, padtype="odd", padlen=padlen, method="pad") on a 1-D signal. */
export function filtfilt(b: Arr1, a: Arr1, x: Arr1, padlen = 3 * Math.max(a.length, b.length)): Arr1 {
  const n = padlen, L = x.length;
  if (L <= n) throw new Error(`The length of the input vector x must be greater than padlen, which is ${n}.`);
  let ext = x;
  if (n > 0) {
    const left: Arr1 = [], right: Arr1 = [];
    for (let i = n; i >= 1; i--) left.push(2 * x[0] - x[i]);
    for (let i = L - 2; i >= L - n - 1; i--) right.push(2 * x[L - 1] - x[i]);
    ext = [...left, ...x, ...right];
  }
  const zi = lfilterZi(b, a);
  const y = lfilter(b, a, ext, zi.map((z) => z * ext[0]));
  const y0 = y[y.length - 1];
  const yb = lfilter(b, a, y.slice().reverse(), zi.map((z) => z * y0)).reverse();
  return n > 0 ? yb.slice(n, yb.length - n) : yb;
}

// ---------------- pipeline steps ----------------
/** A refined (top-down) pose; structurally compatible with detector.ts's RefinedPose. */
export interface RefinedKps { frame: number; kps: number[][]; kcs: number[] }

/** Dense (T,17,2)/(T,17) arrays over [f0, f1). Refined crop poses win; tracker poses fill holes. */
export function assemble(refined: (RefinedKps | null)[], tracked: Map<number, Detection>, f0: number, f1: number,
  minConf = 0.2): [Arr3, Arr2] {
  const T = f1 - f0;
  const kp: Arr3 = Array.from({ length: T }, () => Array.from({ length: 17 }, () => [0, 0]));
  const kc: Arr2 = Array.from({ length: T }, () => new Array(17).fill(0));
  for (const r of refined) {
    if (!r || r.frame - f0 < 0 || r.frame - f0 >= T) continue;
    const t = r.frame - f0;
    for (let j = 0; j < 17; j++) { kp[t][j] = [f32(r.kps[j][0]), f32(r.kps[j][1])]; kc[t][j] = f32(r.kcs[j]); }
  }
  const k08 = f32(0.8);   // float32 arithmetic, as numpy does on the float32 detector output
  for (const [fr, d] of tracked) {
    const t = fr - f0;
    if (!(t >= 0 && t < T)) continue;
    for (let j = 0; j < 17; j++) {
      const c8 = f32(f32(d.kcs[j]) * k08);
      if (kc[t][j] < Math.min(c8, 0.5)) {
        kp[t][j] = [f32(d.kps[j][0]), f32(d.kps[j][1])];
        kc[t][j] = c8;
      }
    }
  }
  for (const row of kc) for (let j = 0; j < 17; j++) if (row[j] < minConf) row[j] = 0.0;
  return [kp, kc];
}

/** Per-frame bowler size proxy (shoulder-mid to ankle-mid distance / 0.8), robust to missing joints. */
export function bodyHeightPx(kp: Arr3, kc: Arr2): Arr1 {
  const h = kp.map((f) => {
    const dx = (f[5][0] + f[6][0]) / 2 - (f[15][0] + f[16][0]) / 2, dy = (f[5][1] + f[6][1]) / 2 - (f[15][1] + f[16][1]) / 2;
    return Math.sqrt(dx * dx + dy * dy) / 0.8;
  });
  const ok = kc.map((c) => Math.min(c[5], c[6]) > 0 && Math.min(c[15], c[16]) > 0);
  const nOk = ok.filter(Boolean).length;
  if (nOk >= 2) {
    const med = npMedian(h.filter((_, t) => ok[t]));
    return h.map((v, t) => f32(ok[t] ? v : med));
  }
  return h.map(() => 200.0);
}

/** Zero the confidence of isolated spikes (per joint, per axis). */
export function hampel(kp: Arr3, kcIn: Arr2, fps: number, nSigma = 3.0): Arr2 {
  const T = kp.length;
  const w = Math.max(2, pyRound(0.1 * fps));
  const kc = kcIn.map((r) => r.slice());
  const h = bodyHeightPx(kp, kc);
  for (let j = 0; j < 17; j++) {
    if (ARM_JOINTS.has(j)) continue;   // arm joints legitimately move ~0.3 body heights per frame at release
    const v = kc.map((r) => r[j] > 0);
    for (let t = 0; t < T; t++) {
      if (!v[t]) continue;
      const nb: number[] = [];
      for (let i = Math.max(0, t - w); i < Math.min(T, t + w + 1); i++) if (v[i] && i !== t) nb.push(i);
      if (nb.length < 3) continue;
      let out = false;
      for (let c = 0; c < 2; c++) {
        const med = npMedian(nb.map((i) => kp[i][j][c]));
        const mad = npMedian(nb.map((i) => Math.abs(kp[i][j][c] - med))) * 1.4826;
        const thr = Math.max(nSigma * mad, 0.04 * h[t]);
        if (Math.abs(kp[t][j][c] - med) > thr) out = true;
      }
      if (out) kc[t][j] = 0.0;
    }
  }
  return kc;
}

/** Per-chain 2-state Viterbi: choose, per frame, whether the detector's left/right labels are swapped, minimising
 * frame-to-frame keypoint motion (normalised by body height). Returns corrected arrays and the number of frames
 * changed. */
export function fixSwaps(kpIn: Arr3, kcIn: Arr2, switchCost = 0.25): [Arr3, Arr2, number] {
  const kp = kpIn.map((f) => f.map((p) => p.slice())), kc = kcIn.map((r) => r.slice());
  const T = kp.length;
  if (T < 3) return [kp, kc, 0];
  const h = bodyHeightPx(kp, kc);
  let changed = 0;
  for (const [L, R] of Object.values(CHAINS)) {
    const idxA = [...L, ...R], idxB = [...R, ...L];
    const ids = (s: number) => (s === 0 ? idxA : idxB);
    const cost: Arr2 = Array.from({ length: T }, () => [0, 0]);
    const back: Arr2 = Array.from({ length: T }, () => [0, 0]);
    for (let t = 1; t < T; t++) {
      for (const s of [0, 1]) {
        const ia = ids(s);
        let best = Infinity, arg = 0;
        for (const sp of [0, 1]) {
          const ib = ids(sp);
          let ws = 0, num = 0;
          for (let k = 0; k < ia.length; k++) ws += Math.min(kc[t][ia[k]], kc[t - 1][ib[k]]);
          let d = 0.0;
          if (!(ws < 1e-3)) {
            for (let k = 0; k < ia.length; k++) {
              const p = kp[t][ia[k]], q = kp[t - 1][ib[k]];
              const dx = p[0] - q[0], dy = p[1] - q[1];
              num += Math.sqrt(dx * dx + dy * dy) * Math.min(kc[t][ia[k]], kc[t - 1][ib[k]]);
            }
            d = num / ws / Math.max(h[t], 1.0);
          }
          const total = cost[t - 1][sp] + d + (s !== sp ? switchCost : 0.0);
          if (total < best) { best = total; arg = sp; }
        }
        cost[t][s] = best;
        back[t][s] = arg;
      }
    }
    // anchor: the globally cheaper path; prefer "as detected" on ties
    let s = cost[T - 1][0] + 0.0 <= cost[T - 1][1] + 1e-6 ? 0 : 1;
    const states = new Array<number>(T).fill(0);
    for (let t = T - 1; t >= 0; t--) { states[t] = s; s = back[t][s]; }
    // never flip the majority labelling: if most frames are "swapped", the detector labels are consistent
    const flip = states.reduce((a, v) => a + v, 0) / T > 0.5;
    for (let t = 0; t < T; t++) {
      if ((flip ? 1 - states[t] : states[t]) === 0) continue;
      const pts = idxB.map((j) => kp[t][j].slice()), cs = idxB.map((j) => kc[t][j]);
      idxA.forEach((j, k) => { kp[t][j] = pts[k]; kc[t][j] = cs[k]; });
      changed += 1;
    }
  }
  return [kp, kc, changed];
}

/** Akima-interpolate gaps; interpolated samples get confidence 0.15 (short gaps) or 0.05 (long). */
export function interpolateGaps(kpIn: Arr3, kcIn: Arr2, fps: number, maxGapS = 0.25): [Arr3, Arr2] {
  const kp = kpIn.map((f) => f.map((p) => p.slice())), kc = kcIn.map((r) => r.slice());
  const T = kp.length;
  const t = Array.from({ length: T }, (_, i) => i);
  const maxGap = Math.max(1, pyRound(maxGapS * fps));
  for (let j = 0; j < 17; j++) {
    const v = kc.map((r) => r[j] > 0);
    const tv = t.filter((i) => v[i]);
    if (tv.length < 2) continue;
    const xv = tv.map((i) => kp[i][j][0]), yv = tv.map((i) => kp[i][j][1]);
    let xs: Arr1, ys: Arr1;
    if (tv.length >= 3) {
      xs = akima1d(tv, xv)(t); ys = akima1d(tv, yv)(t);
      const xl = npInterp(t, tv, xv), yl = npInterp(t, tv, yv);
      xs = xs.map((x, i) => (Number.isNaN(x) ? xl[i] : x));
      ys = ys.map((y, i) => (Number.isNaN(y) ? yl[i] : y));
    } else {
      xs = npInterp(t, tv, xv); ys = npInterp(t, tv, yv);
    }
    // gap lengths
    const gapLen = new Array<number>(T).fill(0);
    for (let i = 0; i < T;) {
      if (!v[i]) {
        let k = i;
        while (k < T && !v[k]) k++;
        for (let q = i; q < k; q++) gapLen[q] = k - i;
        i = k;
      } else i++;
    }
    for (let i = 0; i < T; i++) {
      if (v[i]) continue;
      kp[i][j] = [xs[i], ys[i]];
      kc[i][j] = gapLen[i] <= maxGap ? 0.15 : 0.05;
    }
  }
  return [kp, kc];
}

/** Zero-lag Butterworth along axis 0 of a (T,J,2) array (Winter's correction for the double pass). */
export function butterSmooth(x: Arr3, fps: number, cutoffHz: number, order = 4): Arr3 {
  const copy = () => x.map((f) => f.map((p) => p.slice()));
  if (x.length < 3 * (order + 1) + 1) return copy();
  const nyq = fps / 2.0;
  const corrected = cutoffHz / 0.802;   // filtfilt doubles the order; keep the -3 dB point at cutoff_hz
  if (corrected >= nyq * 0.95) return copy();
  const [b, a] = butter(Math.floor(order / 2), corrected / nyq);
  const pad = Math.min(x.length - 1, 3 * Math.max(a.length, b.length));
  const out = copy();
  const J = x[0].length;
  for (let j = 0; j < J; j++) {
    for (let c = 0; c < x[0][j].length; c++) {
      const y = filtfilt(b, a, x.map((f) => f[j][c]), pad);
      y.forEach((v, t) => { out[t][j][c] = v; });
    }
  }
  return out;
}

/** Trunk/legs ~ 8 Hz, arms ~ 12 Hz (capped below Nyquist). Fast bowling arm is left sharper. */
export function smoothKeypoints(kp: Arr3, fps: number): Arr3 {
  const body = Array.from({ length: 17 }, (_, j) => j).filter((j) => !ARM_JOINTS.has(j));
  const arms = [...ARM_JOINTS].sort((p, q) => p - q);
  const out = kp.map((f) => f.map((p) => p.slice()));
  const put = (js: number[], cutoff: number) => {
    const y = butterSmooth(kp.map((f) => js.map((j) => f[j])), fps, cutoff);
    y.forEach((f, t) => js.forEach((j, k) => { out[t][j] = f[k]; }));
  };
  put(body, Math.min(8.0, 0.3 * fps));
  put(arms, Math.min(12.0, 0.4 * fps));
  return out.map((f) => f.map((p) => p.map(f32)));
}
