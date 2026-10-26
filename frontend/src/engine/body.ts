/**
 * The Anny body model in the browser: port of backend/bowlnet/body/{model,fit,export}.py.
 *
 * Fits the compact body model to the analysed skeleton W (x fwd, y left, z up) with analytic, anatomy-aware IK and
 * produces the same binaries the Python export_mesh writes (consumed by lib/mesh.ts), little-endian:
 *   mesh_rest.bin : float32 positions (V*3) | uint16 indices (F*3) | uint8 skinIndex (V*4) | float32 skinWeight (V*4)
 *   pose.bin      : float32 bone matrices (T * B * 12), row-major 3x4, mapping rest -> posed
 * in three.js axes: +x = bowler's right, +y = up, -z = down the pitch (direction of travel).
 *
 * Model data: public/models/anny_body.{json,bin}, written by backend/tools/export_body_asset.py. Rotations are 3x3
 * row-major `number[]` (length 9); scipy's Rotation is reimplemented with the same quaternion formulas.
 */
import type { Arr2, Arr3 } from "./nd";

// ---------------- asset ----------------
export interface BodyAssetHeader {
  format: string;
  version: number;
  source: string | null;
  vertices: number;
  faces: number;
  bones: number;
  weight: number;               // the weight phenotype the grid slice was taken at (BodyModel.instance default)
  grid_gender: number[];
  grid_height: number[];
  stature_m: number[][];        // (G,H)
  bone_labels: string[];
  bone_parents: number[];
  arrays: Record<string, { offset: number; dtype: string; shape: number[] }>;
  bytes: number;
}
export interface BodyAsset { header: BodyAssetHeader; bin: ArrayBuffer }
export type BodyAssetLoader = () => Promise<BodyAsset>;

export interface BodyModel {
  V: number;
  F: number;
  B: number;
  gridGender: number[];
  gridHeight: number[];
  stature: number[][];          // (G,H) stature of each grid mesh, metres
  restVertices: Float32Array;   // (G,H,V,3) Anny axes
  restPoses: Float32Array;      // (G,H,B,3,4) rest bone poses (rotation | head), Anny axes
  faces: Uint16Array;           // (F,3)
  skinIndex: Uint8Array;        // (V,4) top-4 influences (renormalised), for real-time skinning
  skinWeight: Float32Array;     // (V,4)
  labels: string[];
  parents: number[];
  idx: Record<string, number>;
  order: number[];              // topological order (parents before children)
}

export function parseBodyAsset({ header: h, bin }: BodyAsset): BodyModel {
  const arr = <T>(name: string, Ctor: { new (b: ArrayBuffer): T; BYTES_PER_ELEMENT: number }): T => {
    const a = h.arrays[name];
    if (!a) throw new Error(`body model asset: missing ${name}`);
    const n = a.shape.reduce((x, y) => x * y, 1);
    return new Ctor(bin.slice(a.offset, a.offset + n * Ctor.BYTES_PER_ELEMENT));   // copy: aligned, detached from bin
  };
  const parents = h.bone_parents;
  const order: number[] = [];
  const seen = new Set<number>();
  const visit = (b: number) => {
    if (seen.has(b)) return;
    if (parents[b] >= 0) visit(parents[b]);
    seen.add(b);
    order.push(b);
  };
  for (let b = 0; b < h.bones; b++) visit(b);
  return {
    V: h.vertices, F: h.faces, B: h.bones, gridGender: h.grid_gender, gridHeight: h.grid_height, stature: h.stature_m,
    restVertices: arr("rest_vertices", Float32Array), restPoses: arr("rest_bone_poses", Float32Array),
    faces: arr("faces", Uint16Array), skinIndex: arr("skin_index", Uint8Array), skinWeight: arr("skin_weight", Float32Array),
    labels: h.bone_labels, parents, idx: Object.fromEntries(h.bone_labels.map((n, i) => [n, i])), order,
  };
}

const defaultLoader: BodyAssetLoader = async () => {
  // Vite's base URL (hash routing, so this resolves the same from every page and from workers)
  const base = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/";
  const get = async (ext: string) => {
    const r = await fetch(`${base}models/anny_body.${ext}`);
    if (!r.ok) throw new Error(`body model unavailable (${r.status})`);
    return r;
  };
  const [header, bin] = await Promise.all([get("json").then((r) => r.json()), get("bin").then((r) => r.arrayBuffer())]);
  return { header, bin };
};
let loader: BodyAssetLoader = defaultLoader;
let cached: Promise<BodyModel> | null = null;

/** Replace how the asset is fetched (tests read it from disk). Clears the cached model. */
export function setBodyAssetLoader(l: BodyAssetLoader | null): void {
  loader = l ?? defaultLoader;
  cached = null;
}

/** The body model, loaded once (BodyModel.get). A failed load is retried on the next call. */
export function loadBodyModel(): Promise<BodyModel> {
  if (!cached) {
    const p = loader().then(parseBodyAsset);
    cached = p;
    p.catch(() => { if (cached === p) cached = null; });
  }
  return cached;
}

// ---------------- small linear algebra (numpy evaluation order) ----------------
type M3 = number[];   // row-major 3x3
const EYE: M3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const dot3 = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm3 = (a: number[]) => Math.sqrt(dot3(a, a));
const cross3 = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const sub3 = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
/** fit._unit: v / max(|v|, 1e-9) */
const unit3 = (v: number[]) => {
  const n = Math.max(norm3(v), 1e-9);
  return [v[0] / n, v[1] / n, v[2] / n];
};
function mmul(a: M3, b: M3): M3 {
  const o = new Array(9);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) o[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return o;
}
const mT = (a: M3): M3 => [a[0], a[3], a[6], a[1], a[4], a[7], a[2], a[5], a[8]];
const mv = (a: M3, v: number[]) => [
  a[0] * v[0] + a[1] * v[1] + a[2] * v[2], a[3] * v[0] + a[4] * v[1] + a[5] * v[2], a[6] * v[0] + a[7] * v[1] + a[8] * v[2]];
/** Matrix with columns (c0, c1, c2). */
const cols = (c0: number[], c1: number[], c2: number[]): M3 => [c0[0], c1[0], c2[0], c0[1], c1[1], c2[1], c0[2], c1[2], c2[2]];

// ---------------- scipy.spatial.transform.Rotation (same formulas) ----------------
function quatToMat(x: number, y: number, z: number, w: number): M3 {
  const x2 = x * x, y2 = y * y, z2 = z * z, w2 = w * w;
  const xy = x * y, zw = z * w, xz = x * z, yw = y * w, yz = y * z, xw = x * w;
  return [x2 - y2 - z2 + w2, 2 * (xy - zw), 2 * (xz + yw),
    2 * (xy + zw), -x2 + y2 - z2 + w2, 2 * (yz - xw),
    2 * (xz - yw), 2 * (yz + xw), -x2 - y2 + z2 + w2];
}
/** Rotation.from_rotvec(rv).as_matrix() */
function rotvecToMat(rv: number[]): M3 {
  const a = norm3(rv);
  let s: number;
  if (a <= 1e-3) {   // small-angle Taylor expansion
    const a2 = a * a;
    s = 0.5 - a2 / 48 + (a2 * a2) / 3840;
  } else s = Math.sin(a / 2) / a;
  return quatToMat(s * rv[0], s * rv[1], s * rv[2], Math.cos(a / 2));
}
/** Rotation.from_matrix(m).as_rotvec() */
function matToRotvec(m: M3): number[] {
  const d = [m[0], m[4], m[8]];
  d.push(d[0] + d[1] + d[2]);
  let c = 0;
  for (let i = 1; i < 4; i++) if (d[i] > d[c]) c = i;
  let q: number[];
  if (c !== 3) {
    const i = c, j = (i + 1) % 3, k = (j + 1) % 3;
    q = [0, 0, 0, 0];
    q[i] = 1 - d[3] + 2 * m[i * 4];
    q[j] = m[j * 3 + i] + m[i * 3 + j];
    q[k] = m[k * 3 + i] + m[i * 3 + k];
    q[3] = m[k * 3 + j] - m[j * 3 + k];
  } else {
    q = [m[7] - m[5], m[2] - m[6], m[3] - m[1], 1 + d[3]];
  }
  const n = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
  q = q.map((v) => v / n);
  if (q[3] < 0) q = q.map((v) => -v);   // w >= 0 so that 0 <= angle <= pi
  const a = 2 * Math.atan2(norm3(q), q[3]);
  let s: number;
  if (a <= 1e-3) {
    const a2 = a * a;
    s = 2 + a2 / 12 + (7 * a2 * a2) / 2880;
  } else s = a / Math.sin(a / 2);
  return [s * q[0], s * q[1], s * q[2]];
}
/** Rotation.from_euler("z", yaw).as_matrix() */
const eulerZ = (yaw: number): M3 => quatToMat(0, 0, Math.sin(yaw / 2), Math.cos(yaw / 2));

/** Orthogonal polar factor (= u @ vt of the SVD) by Newton iteration X <- (X + X^-T) / 2. */
function polar(m: M3): M3 {
  let x = m.slice();
  for (let it = 0; it < 50; it++) {
    const [a, b, c, d, e, f, g, h, i] = x;
    const cof = [e * i - f * h, f * g - d * i, d * h - e * g, c * h - b * i, a * i - c * g, b * g - a * h,
      b * f - c * e, c * d - a * f, a * e - b * d];   // cofactors: X^-T = cof / det
    const det = a * cof[0] + b * cof[1] + c * cof[2];
    const nx = x.map((v, k) => 0.5 * (v + cof[k] / det));
    const delta = Math.max(...nx.map((v, k) => Math.abs(v - x[k])));
    x = nx;
    if (!(delta > 1e-15)) break;
  }
  return x;
}

// ---------------- model.py ----------------
export interface BodyInstance {
  restVertices: Float64Array;   // (V,3) world axes, metres, feet on z=0
  restRot: Float64Array;        // (B,3,3) rest bone orientations (world axes)
  restHead: Float64Array;       // (B,3) rest bone head positions
  stature: number;
}

/** np.searchsorted(grid, x) - 1 clipped to a valid cell, and the clipped fraction within it. */
function lerpIdx(grid: number[], x: number): [number, number] {
  let ss = 0;
  while (ss < grid.length && grid[ss] < x) ss++;
  const i = Math.min(Math.max(ss - 1, 0), grid.length - 2);
  const t = (x - grid[i]) / (grid[i + 1] - grid[i]);
  return [i, Math.min(Math.max(t, 0), 1)];
}

/** np.interp (numpy's evaluation order). */
function npInterp(x: number, xp: number[], fp: number[]): number {
  const n = xp.length;
  if (Number.isNaN(x)) return x;
  if (x < xp[0]) return fp[0];
  if (x > xp[n - 1]) return fp[n - 1];
  let j = 0;
  while (j < n - 1 && xp[j + 1] <= x) j++;
  if (j === n - 1 || xp[j] === x) return fp[j];
  const slope = (fp[j + 1] - fp[j]) / (xp[j + 1] - xp[j]);
  return slope * (x - xp[j]) + fp[j];
}

// Anny (x left, y back, z up) -> world (x fwd, y left, z up): world = (-y, x, z)
const a2w = (x: number, y: number, z: number) => [-y, x, z];

/**
 * Interpolate the phenotype grid (gender, height) to the requested stature (BodyModel.instance; the weight
 * phenotype is fixed at the asset's slice, 0.5 = the Python default).
 */
export function bodyInstance(m: BodyModel, statureM: number, gender = 0): BodyInstance {
  const g = Math.min(Math.max(gender, 0), 1);
  const [gi, gt] = lerpIdx(m.gridGender, g);
  // stature is linear in the height phenotype: find the height value giving the target stature
  const stW = m.gridHeight.map((_, h) => (1 - gt) * m.stature[gi][h] + gt * m.stature[gi + 1][h]);
  const [hi, ht] = lerpIdx(m.gridHeight, npInterp(statureM, stW, m.gridHeight));
  const H = m.gridHeight.length, { V, B } = m;
  const corners: [number, number][] = [];   // (grid cell, blend weight), in Python's accumulation order
  for (const [a, wa] of [[gi, 1 - gt], [gi + 1, gt]])
    for (const [b, wb] of [[hi, 1 - ht], [hi + 1, ht]]) if (wa * wb) corners.push([a * H + b, wa * wb]);
  const tri = (src: Float32Array, n: number) => {
    const out = new Float64Array(n);
    for (const [cell, w] of corners) {
      const o = cell * n;
      for (let k = 0; k < n; k++) out[k] = out[k] + w * src[o + k];
    }
    return out;
  };
  const Va = tri(m.restVertices, V * 3);
  const Pz = tri(m.restPoses, B * 12);
  const Vw = new Float64Array(V * 3), restHead = new Float64Array(B * 3), restRot = new Float64Array(B * 9);
  for (let v = 0; v < V; v++) Vw.set(a2w(Va[v * 3], Va[v * 3 + 1], Va[v * 3 + 2]), v * 3);
  for (let b = 0; b < B; b++) {
    const p = Pz.subarray(b * 12, b * 12 + 12);
    const R = polar([p[0], p[1], p[2], p[4], p[5], p[6], p[8], p[9], p[10]]);   // re-orthonormalise after blending
    restRot.set([-R[3], -R[4], -R[5], R[0], R[1], R[2], R[6], R[7], R[8]], b * 9);   // A2W @ R
    restHead.set(a2w(p[3], p[7], p[11]), b * 3);
  }
  // put the feet on z=0 and exactly match the requested stature
  let z0 = Infinity;
  for (let v = 0; v < V; v++) z0 = Math.min(z0, Vw[v * 3 + 2]);
  for (let v = 0; v < V; v++) Vw[v * 3 + 2] -= z0;
  for (let b = 0; b < B; b++) restHead[b * 3 + 2] -= z0;
  let zmax = -Infinity;
  for (let v = 0; v < V; v++) zmax = Math.max(zmax, Vw[v * 3 + 2]);
  const s = statureM / zmax;
  for (let k = 0; k < Vw.length; k++) Vw[k] *= s;
  for (let k = 0; k < restHead.length; k++) restHead[k] *= s;
  return { restVertices: Vw, restRot, restHead, stature: statureM };
}

// ---------------- fit.py ----------------
// H36M indices
const PELVIS = 0, R_HIP = 1, R_KNEE = 2, R_ANK = 3, L_HIP = 4, L_KNEE = 5, L_ANK = 6, THORAX = 8, HEAD = 10;
const L_SH = 11, L_EL = 12, L_WR = 13, R_SH = 14, R_EL = 15, R_WR = 16;

/** Frame with columns (forward, left, up) that keeps `up` exact and squares `left` to it: for the trunk, whose direction
 * matters more than the hip or shoulder line's (a side-bent trunk is far from square to the hips). */
function frameUp(left: number[], up: number[]): M3 {
  const u = unit3(up);
  const d = dot3(left, u);
  const l = unit3([left[0] - u[0] * d, left[1] - u[1] * d, left[2] - u[2] * d]);
  return cols(cross3(l, u), l, u);
}

/** Minimal rotation taking direction a -> b. */
function rotMin(a0: number[], b0: number[]): M3 {
  const a = unit3(a0), b = unit3(b0);
  const v = cross3(a, b);
  const c = dot3(a, b);
  const s = norm3(v);
  if (s > 1e-8) {
    const ang = Math.atan2(s, c);
    return rotvecToMat([(v[0] / s) * ang, (v[1] / s) * ang, (v[2] / s) * ang]);
  }
  if (c < 0) {
    // 180 deg: rotate about any axis orthogonal to a
    let ortho = cross3(a, [1, 0, 0]);
    if (norm3(ortho) < 1e-6) ortho = cross3(a, [0, 1, 0]);
    const o = unit3(ortho);
    return rotvecToMat([o[0] * Math.PI, o[1] * Math.PI, o[2] * Math.PI]);
  }
  return EYE.slice();
}

/** Rotation mapping (u_r, n_r) -> (u_t, n_t) exactly on u, best-effort on n (n orthogonalised). */
function twoVector(ur: number[], nr: number[], ut: number[], nt: number[]): M3 {
  const basis = (u0: number[], n0: number[]) => {
    const u = unit3(u0);
    const d = dot3(n0, u);
    const n = unit3([n0[0] - u[0] * d, n0[1] - u[1] * d, n0[2] - u[2] * d]);
    return cols(u, n, cross3(u, n));
  };
  return mmul(basis(ut, nt), mT(basis(ur, nr)));
}

/** Per-frame bend-plane normal; straight joints keep the previous frame's (or the default) axis. */
function bendNormals(ut: number[][], ft: number[][], def: number[][], straightDeg = 15): number[][] {
  let prev: number[] | null = null;
  return ut.map((u, t) => {
    const n = cross3(unit3(u), unit3(ft[t]));
    const s = norm3(n);
    const bend = Math.asin(Math.min(Math.max(s, 0), 1)) * (180 / Math.PI);   // np.degrees
    if (bend >= straightDeg) {
      prev = [n[0] / s, n[1] / s, n[2] / s];   // flexion only goes one way, so cross(upper, lower) is the anatomical axis
      return prev;
    }
    return prev ?? def[t];
  });
}

export interface BodyFit {
  D: Float64Array;       // (T,B,3,3) world delta rotations
  heads: Float64Array;   // (T,B,3) posed bone heads
  T: number;
}

/**
 * Poses the body model from the metric 3D skeleton (fit.Fitter). Per frame, world-space delta rotations D_b:
 *  - pelvis / thorax frames from the hip and shoulder lines + trunk direction; spine bones slerp between them;
 *  - limbs: two-vector alignment matching the segment direction exactly, with the twist chosen so the model's
 *    elbow/knee flexion axis lines up with the observed bend plane; the forearm/shank then follows the distal segment;
 *  - feet stay level along the pelvis heading; hands/fingers follow the forearm.
 * Matching directions (not positions) keeps the posture faithful despite bone-length differences.
 */
export class Fitter {
  readonly b: Record<string, number>;
  private readonly restPelvis: M3;
  private readonly restThorax: M3;
  private readonly restHeadDir: number[];

  constructor(readonly m: BodyModel, readonly inst: BodyInstance) {
    const names = ["root", "spine05", "spine04", "spine03", "spine02", "spine01", "neck01", "neck02", "neck03", "head",
      "clavicle.L", "clavicle.R", "shoulder01.L", "shoulder01.R", "upperarm01.L", "upperarm01.R",
      "upperarm02.L", "upperarm02.R", "lowerarm01.L", "lowerarm01.R", "lowerarm02.L", "lowerarm02.R",
      "wrist.L", "wrist.R", "pelvis.L", "pelvis.R", "upperleg01.L", "upperleg01.R", "upperleg02.L",
      "upperleg02.R", "lowerleg01.L", "lowerleg01.R", "lowerleg02.L", "lowerleg02.R", "foot.L", "foot.R"];
    this.b = Object.fromEntries(names.map((n) => {
      if (!(n in m.idx)) throw new Error(`body model: missing bone ${n}`);
      return [n, m.idx[n]];
    }));
    const h = (n: string) => this.rh(this.b[n]);
    this.restPelvis = frameUp(sub3(h("upperleg01.L"), h("upperleg01.R")), sub3(h("neck01"), h("root")));
    this.restThorax = frameUp(sub3(h("upperarm01.L"), h("upperarm01.R")), sub3(h("neck01"), h("spine02")));
    let top = -Infinity;
    const rv = inst.restVertices;
    for (let k = 2; k < rv.length; k += 3) top = Math.max(top, rv[k]);
    const headTop = h("head");
    headTop[2] = top;
    this.restHeadDir = sub3(headTop, h("neck01"));
  }

  private rh(bone: number): number[] {
    const r = this.inst.restHead;
    return [r[bone * 3], r[bone * 3 + 1], r[bone * 3 + 2]];
  }

  /** J: (T,17,3) world-frame joints (x fwd, y left, z up), root-relative metres. upOffset: optional (T,3). */
  fit(J: Arr3, upOffset?: Arr2): BodyFit {
    const T = J.length, nb = this.m.labels.length, b = this.b;
    const D = new Float64Array(T * nb * 9);
    for (let k = 0; k < T * nb; k++) D.set(EYE, k * 9);
    const setD = (bone: number, mats: M3[]) => mats.forEach((M, t) => D.set(M, (t * nb + bone) * 9));
    const jt = (j: number) => J.map((f) => f[j]);
    const diff = (a: number, c: number) => J.map((f) => sub3(f[a], f[c]));

    // ---- pelvis & thorax ----
    const Lh = diff(L_HIP, R_HIP), Tp = diff(THORAX, PELVIS), Ls = diff(L_SH, R_SH);
    const pT = mT(this.restPelvis), tT = mT(this.restThorax);
    // both frames share the whole trunk's direction (pelvis to thorax) exactly, so the body's spine twists between the
    // hip and shoulder lines but its trunk lies along the skeleton's, however far it bends to the side
    const Rp = J.map((_, t) => mmul(frameUp(Lh[t], Tp[t]), pT));
    const Rt = J.map((_, t) => mmul(frameUp(Ls[t], Tp[t]), tT));
    setD(b.root, Rp);
    const rel = Rp.map((R, t) => matToRotvec(mmul(mT(R), Rt[t])));
    let Dth: M3[] = [];
    for (const [frac, name] of [[0.15, "spine05"], [0.35, "spine04"], [0.55, "spine03"], [0.78, "spine02"], [1.0, "spine01"]] as const) {
      const mats = Rp.map((R, t) => mmul(R, rotvecToMat(rel[t].map((v) => v * frac))));
      setD(b[name], mats);
      Dth = mats;
    }

    // ---- head ----
    const headDir = diff(HEAD, THORAX);
    const Dh = Dth.map((M, t) => mmul(rotMin(mv(M, this.restHeadDir), headDir[t]), M));
    const headRel = Dh.map((M, t) => matToRotvec(mmul(M, mT(Dth[t]))));
    for (const [name, w] of [["neck01", 0.5], ["neck02", 0.7], ["neck03", 0.85], ["head", 1.0]] as const)
      setD(b[name], Dth.map((M, t) => mmul(rotvecToMat(headRel[t].map((v) => v * w)), M)));

    // ---- arms ----
    for (const [s, SH, EL, WR] of [["L", L_SH, L_EL, L_WR], ["R", R_SH, R_EL, R_WR]] as const) {
      for (const n of ["clavicle", "shoulder01"]) setD(b[`${n}.${s}`], Dth);
      const ur = sub3(this.rh(b[`lowerarm01.${s}`]), this.rh(b[`upperarm01.${s}`]));
      const fr = sub3(this.rh(b[`wrist.${s}`]), this.rh(b[`lowerarm01.${s}`]));
      const nr = cross3(unit3(ur), unit3(fr));
      const ut = diff(EL, SH), ft = diff(WR, EL);
      const nt = bendNormals(ut, ft, Dth.map((M) => mv(M, nr)));
      const Dua = ut.map((u, t) => twoVector(ur, nr, u, nt[t]));
      setD(b[`upperarm01.${s}`], Dua);
      setD(b[`upperarm02.${s}`], Dua);
      const Dfa = Dua.map((M, t) => mmul(rotMin(mv(M, fr), ft[t]), M));
      for (const n of ["lowerarm01", "lowerarm02", "wrist"]) setD(b[`${n}.${s}`], Dfa);
    }
    // ---- legs ----
    const heading = Rp.map((R) => unit3([R[0] + 1e-9, R[3] + 1e-9, 0 + 1e-9]));
    for (const [s, HP, KN, AN] of [["L", L_HIP, L_KNEE, L_ANK], ["R", R_HIP, R_KNEE, R_ANK]] as const) {
      setD(b[`pelvis.${s}`], Rp);
      const ur = sub3(this.rh(b[`lowerleg01.${s}`]), this.rh(b[`upperleg01.${s}`]));
      const fr = sub3(this.rh(b[`foot.${s}`]), this.rh(b[`lowerleg01.${s}`]));
      const nr = [0, 1, 0];   // mediolateral knee axis (world 'left')
      const ut = diff(KN, HP), ft = diff(AN, KN);
      const nt = bendNormals(ut, ft, Rp.map((M) => mv(M, nr)), 12);
      const Dthigh = ut.map((u, t) => twoVector(ur, nr, u, nt[t]));
      setD(b[`upperleg01.${s}`], Dthigh);
      setD(b[`upperleg02.${s}`], Dthigh);
      const Dsh = Dthigh.map((M, t) => mmul(rotMin(mv(M, fr), ft[t]), M));
      setD(b[`lowerleg01.${s}`], Dsh);
      setD(b[`lowerleg02.${s}`], Dsh);
      // level foot, pointing along the pelvis heading
      setD(b[`foot.${s}`], heading.map((hd) => eulerZ(Math.atan2(hd[1], hd[0]))));
    }

    // ---- propagate to every other bone (rigidly follow the parent) and run FK ----
    const explicit = new Set(Object.values(b));
    const heads = new Float64Array(T * nb * 3);
    const pelvis = jt(PELVIS);
    const rh = this.inst.restHead;
    for (const bone of this.m.order) {
      const p = this.m.parents[bone];
      const off = p >= 0 ? [rh[bone * 3] - rh[p * 3], rh[bone * 3 + 1] - rh[p * 3 + 1], rh[bone * 3 + 2] - rh[p * 3 + 2]] : null;
      for (let t = 0; t < T; t++) {
        const o = (t * nb + bone) * 3;
        if (!explicit.has(bone) && p >= 0) D.copyWithin((t * nb + bone) * 9, (t * nb + p) * 9, (t * nb + p) * 9 + 9);
        if (!off) heads.set(pelvis[t], o);
        else {
          const po = (t * nb + p) * 3, Dp = D.subarray((t * nb + p) * 9, (t * nb + p) * 9 + 9);
          const d = mv(Array.from(Dp), off);
          heads[o] = heads[po] + d[0]; heads[o + 1] = heads[po + 1] + d[1]; heads[o + 2] = heads[po + 2] + d[2];
        }
      }
    }
    // root sits at the target pelvis; make bones' heads consistent with the root offset
    const root = b.root;
    for (let t = 0; t < T; t++) {
      const r = (t * nb + root) * 3, rx = heads[r], ry = heads[r + 1], rz = heads[r + 2];
      for (let bone = 0; bone < nb; bone++) {
        const o = (t * nb + bone) * 3;
        heads[o] = heads[o] - rx + pelvis[t][0];
        heads[o + 1] = heads[o + 1] - ry + pelvis[t][1];
        heads[o + 2] = heads[o + 2] - rz + pelvis[t][2];
        if (upOffset) { heads[o] += upOffset[t][0]; heads[o + 1] += upOffset[t][1]; heads[o + 2] += upOffset[t][2]; }
      }
    }
    return { D, heads, T };
  }
}

/** scipy.ndimage.uniform_filter1d(a, size, mode="nearest"), same running-sum evaluation as scipy's C loop. */
function uniformFilterNearest(a: number[], size: number): number[] {
  const n = a.length, left = Math.floor(size / 2);
  const ext = (i: number) => a[Math.min(n - 1, Math.max(0, i - left))];
  let tmp = 0;
  for (let k = 0; k < size; k++) tmp += ext(k);
  tmp /= size;
  const out = [tmp];
  for (let i = 1; i < n; i++) {
    tmp += (ext(i + size - 1) - ext(i - 1)) / size;
    out.push(tmp);
  }
  return out;
}

/** Vertical offset per frame (T,3) that places the lower foot on z=0 (smoothed). */
export function groundOffsets(fit: BodyFit, nb: number, footBones: number[], ankleHeight: number): Arr2 {
  const off: number[] = [];
  for (let t = 0; t < fit.T; t++) {
    let lowest = Infinity;
    for (const f of footBones) {
      const z = fit.heads[(t * nb + f) * 3 + 2];
      lowest = Number.isNaN(z) || Number.isNaN(lowest) ? NaN : Math.min(lowest, z);
    }
    off.push(ankleHeight - lowest);
  }
  return uniformFilterNearest(off, Math.min(off.length, 5)).map((z) => [0, 0, z]);
}

// ---------------- export.py ----------------
const ANKLE_HEIGHT_FRAC = 0.044;
// analysis world (x fwd, y left, z up) -> three.js (x right, y up, z back)
const W2T: M3 = [0, -1, 0, 0, 0, 1, -1, 0, 0];

/** export.world_to_three for a point, a (N,3) or a (T,N,3) array. */
export function worldToThree(p: number[]): number[];
export function worldToThree(p: Arr2): Arr2;
export function worldToThree(p: Arr3): Arr3;
export function worldToThree(p: unknown[]): unknown[] {
  if (typeof p[0] === "number") return mv(W2T, p as number[]);
  return (p as unknown[][]).map((q) => worldToThree(q as number[]));
}

export interface FittedBody extends BodyFit {
  inst: BodyInstance;
  fitter: Fitter;
  off: Arr2;   // (T,3) ground offset (float64), already added to heads
}

export function fitBody(m: BodyModel, W: Arr3, height: number, gender = 0): FittedBody {
  const inst = bodyInstance(m, height, gender);
  const fitter = new Fitter(m, inst);
  const out = fitter.fit(W);
  const nb = m.labels.length;
  const off = groundOffsets(out, nb, [fitter.b["foot.L"], fitter.b["foot.R"]], ANKLE_HEIGHT_FRAC * height);
  const heads = out.heads;
  for (let t = 0; t < out.T; t++) for (let bone = 0; bone < nb; bone++) heads[(t * nb + bone) * 3 + 2] += off[t][2];
  return { ...out, heads, inst, fitter, off };
}

/** Bone indices per body role, for colouring the mesh (bowling arm / front leg). */
function boneGroups(m: BodyModel, bowlingArm: string) {
  const sArm = bowlingArm === "right" ? ".R" : ".L";
  const sLeg = bowlingArm === "right" ? ".L" : ".R";
  const armRoots = ["upperarm", "lowerarm", "wrist", "finger", "metacarpal"];
  const legRoots = ["upperleg", "lowerleg", "foot", "toe"];
  const pick = (suffix: string, roots: string[]) =>
    m.labels.flatMap((n, i) => (n.endsWith(suffix) && roots.some((r) => n.startsWith(r)) ? [i] : []));
  return { bowling_arm: pick(sArm, armRoots), front_leg: pick(sLeg, legRoots) };
}

export interface MeshInfo {
  vertices: number;
  faces: number;
  bones: number;
  frames: number;
  coords: "three";
  stature_m: number;
  gender: number;
  files: { rest: string; pose: string };
  bone_groups: { bowling_arm: number[]; front_leg: number[] };
  model: string;
}

export interface MeshExport {
  info: MeshInfo;            // the dict export_mesh returns (result.mesh)
  rest: ArrayBuffer;         // mesh_rest.bin
  pose: ArrayBuffer;         // pose.bin
  groundOffset: Arr2;        // ground_offset.npy (T,3), float32 values: skeleton3d.joints = worldToThree(W + groundOffset)
}

/** export.export_mesh: fit the body to W (T,17,3 world frame) and build the binaries in memory. */
export async function exportMesh(W: Arr3, height: number, gender = 0, bowlingArm = "right"): Promise<MeshExport> {
  return exportMeshWith(await loadBodyModel(), W, height, gender, bowlingArm);
}

/** exportMesh with an already loaded model (synchronous). */
export function exportMeshWith(m: BodyModel, W: Arr3, height: number, gender = 0, bowlingArm = "right"): MeshExport {
  const fit = fitBody(m, W, height, gender);
  const { T, D, heads, inst } = fit;
  const B = m.labels.length, V = m.V, F = m.faces.length / 3;
  const W2Tt = mT(W2T);
  // bone transforms in three.js axes: x' -> M D M^T x' + M (head - D rest_head)
  const mats = new Float32Array(T * B * 12);
  const rh = inst.restHead;
  for (let t = 0; t < T; t++)
    for (let bone = 0; bone < B; bone++) {
      const k = t * B + bone;
      const Dk = Array.from(D.subarray(k * 9, k * 9 + 9));
      const Dt = mmul(mmul(W2T, Dk), W2Tt);
      const dr = mv(Dk, [rh[bone * 3], rh[bone * 3 + 1], rh[bone * 3 + 2]]);
      const tr = mv(W2T, [heads[k * 3] - dr[0], heads[k * 3 + 1] - dr[1], heads[k * 3 + 2] - dr[2]]);
      mats.set([Dt[0], Dt[1], Dt[2], tr[0], Dt[3], Dt[4], Dt[5], tr[1], Dt[6], Dt[7], Dt[8], tr[2]], k * 12);
    }
  const pos = new Float32Array(V * 3);
  for (let v = 0; v < V; v++) {
    const rv = inst.restVertices;
    pos.set(mv(W2T, [rv[v * 3], rv[v * 3 + 1], rv[v * 3 + 2]]), v * 3);
  }
  const parts = [pos, m.faces, m.skinIndex, m.skinWeight];
  const rest = new Uint8Array(parts.reduce((s, a) => s + a.byteLength, 0));
  let o = 0;
  for (const a of parts) {
    rest.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), o);
    o += a.byteLength;
  }
  return {
    info: {
      vertices: V, faces: F, bones: B, frames: T, coords: "three", stature_m: height, gender,
      files: { rest: "mesh_rest.bin", pose: "pose.bin" }, bone_groups: boneGroups(m, bowlingArm),
      model: "NAVER Anny (CC0 assets / Apache-2.0 code)",
    },
    rest: rest.buffer, pose: mats.buffer,
    groundOffset: fit.off.map(([x, y, z]) => [Math.fround(x), Math.fround(y), Math.fround(z)]),
  };
}

/** export.frame_obj: OBJ text for one analysed frame (index into the analysis window), in metres, y-up. */
export function frameObj(rest: ArrayBuffer, pose: ArrayBuffer, meta: { vertices: number; faces: number; bones: number },
  frameIndex: number): string {
  const { vertices: V, faces: F, bones: B } = meta;
  let o = 0;
  const pos = new Float32Array(rest.slice(o, o + V * 12)); o += V * 12;
  const idx = new Uint16Array(rest.slice(o, o + F * 6)); o += F * 6;
  const si = new Uint8Array(rest.slice(o, o + V * 4)); o += V * 4;
  const sw = new Float32Array(rest.slice(o, o + V * 16));
  const P = new Float32Array(pose);
  const T = Math.floor(P.length / (B * 12));
  const fi = Math.trunc(Math.min(Math.max(frameIndex, 0), T - 1));
  const f = Math.fround;
  const lines = ["# BowlNet body mesh (NAVER Anny topology), metres, y-up", `# frame index ${fi}`];
  for (let v = 0; v < V; v++) {
    const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
    const out = [0, 0, 0];
    for (let k = 0; k < 4; k++) {   // float32 arithmetic in numpy's einsum order, so the text matches
      const w = sw[v * 4 + k], p = (fi * B + si[v * 4 + k]) * 12;
      for (let i = 0; i < 3; i++) {
        const r = p + i * 4;
        const e = f(f(f(P[r] * x) + f(P[r + 1] * y)) + f(f(P[r + 2] * z) + P[r + 3]));
        out[i] = f(out[i] + f(w * e));
      }
    }
    lines.push(`v ${out[0].toFixed(5)} ${out[1].toFixed(5)} ${out[2].toFixed(5)}`);
  }
  for (let k = 0; k < F; k++) lines.push(`f ${idx[k * 3] + 1} ${idx[k * 3 + 1] + 1} ${idx[k * 3 + 2] + 1}`);
  return lines.join("\n") + "\n";
}
