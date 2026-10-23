/**
 * Small numeric helpers for the in-browser engine, matching the numpy / scipy semantics the Python
 * pipeline (backend/bowlnet) relies on. Arrays are plain nested JS arrays: a (T,17,3) numpy array is
 * `number[][][]`, a 3-vector is `Vec3`. NaN marks missing values, as in numpy.
 */
export type Vec2 = [number, number];
export type Vec3 = [number, number, number];
export type Arr1 = number[];
export type Arr2 = number[][];
export type Arr3 = number[][][];

export const EPS = 1e-12;

// ---------------- construction ----------------
export const range = (a: number, b?: number, step = 1): number[] => {
  const [lo, hi] = b === undefined ? [0, a] : [a, b];
  const out: number[] = [];
  for (let i = lo; step > 0 ? i < hi : i > hi; i += step) out.push(i);
  return out;
};
export const full1 = (n: number, v: number): Arr1 => new Array(n).fill(v);
export const full2 = (n: number, m: number, v: number): Arr2 => Array.from({ length: n }, () => new Array(m).fill(v));
export const full3 = (n: number, m: number, k: number, v: number): Arr3 =>
  Array.from({ length: n }, () => Array.from({ length: m }, () => new Array(k).fill(v)));
export const clone2 = (a: Arr2): Arr2 => a.map((r) => r.slice());
export const clone3 = (a: Arr3): Arr3 => a.map((r) => r.map((c) => c.slice()));

// ---------------- vectors ----------------
export const add = (a: number[], b: number[]): number[] => a.map((v, i) => v + b[i]);
export const sub = (a: number[], b: number[]): number[] => a.map((v, i) => v - b[i]);
export const scale = (a: number[], s: number): number[] => a.map((v) => v * s);
export const dot = (a: number[], b: number[]): number => a.reduce((s, v, i) => s + v * b[i], 0);
export const norm = (a: number[]): number => Math.sqrt(dot(a, a));
export const cross = (a: number[], b: number[]): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
/** kinematics.unit: v / (|v| + 1e-12) */
export const unit = (a: number[]): number[] => scale(a, 1 / (norm(a) + EPS));
export const mid = (a: number[], b: number[]): number[] => a.map((v, i) => (v + b[i]) / 2);
export const clip = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
export const deg = (rad: number): number => (rad * 180) / Math.PI;
export const rad = (d: number): number => (d * Math.PI) / 180;
export const isFiniteNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

// ---------------- reductions (numpy semantics) ----------------
export const sum = (a: Arr1): number => a.reduce((s, v) => s + v, 0);
export const mean = (a: Arr1): number => (a.length ? sum(a) / a.length : NaN);
export const finite = (a: Arr1): Arr1 => a.filter((v) => Number.isFinite(v));
export const nanmean = (a: Arr1): number => mean(finite(a));
export const amax = (a: Arr1): number => a.reduce((m, v) => (v > m || Number.isNaN(v) ? v : m), -Infinity);
export const amin = (a: Arr1): number => a.reduce((m, v) => (v < m || Number.isNaN(v) ? v : m), Infinity);
export const argmax = (a: Arr1): number => {
  let bi = 0;
  for (let i = 1; i < a.length; i++) if (a[i] > a[bi]) bi = i;
  return bi;
};
export const argmin = (a: Arr1): number => {
  let bi = 0;
  for (let i = 1; i < a.length; i++) if (a[i] < a[bi]) bi = i;
  return bi;
};
/** np.percentile(a, q) with the default "linear" method. NaN if any NaN (use nanpercentile to skip them). */
export function percentile(a: Arr1, q: number): number {
  if (!a.length) return NaN;
  if (a.some((v) => Number.isNaN(v))) return NaN;
  const s = a.slice().sort((x, y) => x - y);
  const pos = (q / 100) * (s.length - 1);
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}
export const nanpercentile = (a: Arr1, q: number): number => percentile(finite(a), q);
export const median = (a: Arr1): number => percentile(a, 50);
export const nanmedian = (a: Arr1): number => percentile(finite(a), 50);
export const std = (a: Arr1): number => {
  const m = mean(a);
  return Math.sqrt(mean(a.map((v) => (v - m) ** 2)));
};

// ---------------- signal ----------------
/** np.interp(x, xp, fp): xp increasing; clamps to the end values outside the range. */
export function interp(x: number, xp: Arr1, fp: Arr1): number {
  const n = xp.length;
  if (n === 0) return NaN;
  if (x <= xp[0]) return fp[0];
  if (x >= xp[n - 1]) return fp[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (xp[m] <= x) lo = m; else hi = m;
  }
  const t = (x - xp[lo]) / (xp[hi] - xp[lo] || 1);
  return fp[lo] + t * (fp[hi] - fp[lo]);
}
export const interpMany = (xs: Arr1, xp: Arr1, fp: Arr1): Arr1 => xs.map((x) => interp(x, xp, fp));

/** scipy.ndimage.uniform_filter1d(a, size, mode="nearest") (origin 0). */
export function uniformFilter1d(a: Arr1, size: number): Arr1 {
  const n = a.length;
  if (n === 0) return [];
  size = Math.max(1, Math.round(size));
  // scipy centres the window at size // 2 (for even sizes the extra sample is on the left)
  const left = Math.floor(size / 2), right = size - 1 - left;
  const at = (i: number) => a[Math.min(n - 1, Math.max(0, i))];
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = i - left; k <= i + right; k++) s += at(k);
    out[i] = s / size;
  }
  return out;
}

/** Column `j` of a 2D array. */
export const col = (a: Arr2, j: number): Arr1 => a.map((r) => r[j]);
/** a[:, j, :] of a 3D array. */
export const joint = (a: Arr3, j: number): Arr2 => a.map((r) => r[j]);

// ---------------- angles (kinematics.angle_between / joint_angle, per vector) ----------------
/** Angle between vectors a and b in degrees (kinematics.angle_between). */
export function angleBetween(a: number[], b: number[]): number {
  const ua = unit(a), ub = unit(b);
  return deg(Math.acos(clip(dot(ua, ub), -1, 1)));
}
/** Angle at b between segments b->a and b->c, degrees (180 = straight). */
export const jointAngle = (a: number[], b: number[], c: number[]): number => angleBetween(sub(a, b), sub(c, b));
/** Rows version: one angle per frame. */
export const jointAngles = (a: Arr2, b: Arr2, c: Arr2): Arr1 => a.map((_, t) => jointAngle(a[t], b[t], c[t]));
