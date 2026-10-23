/**
 * Metric 3D skeleton reconstruction and body-fixed reference frames (port of backend/bowlnet/kinematics.py).
 *
 * The lifter gives plausible depth but its bone lengths drift frame to frame (~10-20 % CV on fast bowling).
 * We solve for a root-relative metric skeleton P (T,17,3) [m] that
 *   * keeps constant, left/right-symmetric bone lengths scaled to the athlete's stature,
 *   * re-projects onto the (high-res, confidence-weighted) 2D keypoints under a per-frame weak-perspective
 *     camera whose scale varies smoothly,
 *   * keeps the lifter's relative depth structure, and
 *   * is temporally smooth (looser for the fast bowling arm).
 * Camera axes: x right, y down, z away from the camera.
 *
 * Python minimises the loss with torch autograd + torch.optim.LBFGS; here the loss has hand-written gradients
 * and `lbfgs` is a line-by-line port of torch's optimiser (strong-Wolfe line search, same defaults).
 */
import { interp, median, percentile, uniformFilter1d, type Arr2, type Arr3, type Vec3 } from "./nd";
import { H36M_PARENTS, type Skeleton3D, type WorldFrame } from "./types";
import { round } from "./util";

/** (child, parent) joint pairs, one per bone (16). */
export const BONES: [number, number][] = H36M_PARENTS.flatMap((p, j) => (p >= 0 ? [[j, p] as [number, number]] : []));
const BIDX: Record<number, number> = Object.fromEntries(BONES.map(([j], i) => [j, i]));
// symmetric pairs (indices into BONES): (R hip, L hip), (R thigh, L thigh), (R shank, L shank),
// (L clavicle, R clavicle), (L upper arm, R upper arm), (L forearm, R forearm)
export const SYM: [number, number][] = [[BIDX[1], BIDX[4]], [BIDX[2], BIDX[5]], [BIDX[3], BIDX[6]],
  [BIDX[11], BIDX[14]], [BIDX[12], BIDX[15]], [BIDX[13], BIDX[16]]];
export const ARM = [12, 13, 15, 16];
// stature ~= (shank + thigh + pelvis->spine->thorax + thorax->head-top) * k ; k calibrated on Anny
// (ankle height + head-top offset of the H36M head joint)
export const STATURE_K = 1.06;
// (Python's ANTHRO_LIMBS branch is disabled there and not ported; SELF_CONSISTENT_LIMBS is always on.)

// weights of the skeleton-fit loss terms (tuned against synthetic ground truth, see docs/RESEARCH.md)
// depth 6.0 (was 0.6): trusting the lifter's depth more brought the synthetic side-on error from 96 to 80 mm
// (PA-MPJPE) with no change from behind, where the lifter's depth itself is the limit
export const LOSS_W = { bone: 400.0, "2d": 60.0, depth: 6.0, smooth: 30.0, k: 2000.0, kprior: 300.0,
  hinge: 40.0, elbow: 25.0, order: 400.0 } as const;

/** Ordering constraint: (J[jointB] - J[jointA]) . dir >= margin on `frames` (soft hinge penalty). */
export type Prior = [frames: number[], jointA: number, jointB: number, dir: number[], margin: number];

const dist = (a: number[], b: number[]): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const dist2 = (a: number[], b: number[]): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** (T,16) bone lengths of a (T,17,3) skeleton. */
export const boneLengths = (X: Arr3): Arr2 => X.map((fr) => BONES.map(([j, p]) => dist(fr[j], fr[p])));

export function statureFromLengths(L: number[]): number {
  const b = (j: number) => L[BIDX[j]];
  const shank = (b(3) + b(6)) / 2;
  const thigh = (b(2) + b(5)) / 2;
  const trunk = b(7) + b(8);
  const head = b(9) + b(10);
  return (shank + thigh + trunk + 0.85 * head) * STATURE_K;
}

export function symmetricLengths(L: number[]): number[] {
  L = L.slice();
  for (const [a, b] of SYM) L[a] = L[b] = (L[a] + L[b]) / 2;
  return L;
}

/** Weak-perspective scale per frame. A segment's projected length is L*k*cos(tilt) <= L*k, and over +/-0.5 s
 * the trunk and limbs sweep through the image plane, so a high percentile of projected/true length ratios
 * estimates k without knowing depth. */
export function estimatePxPerM(kp2d: Arr3, conf: Arr2, Lm: number[], fps: number): number[] {
  const T = kp2d.length;
  const seg = BONES.flatMap(([j], b) => ([2, 3, 5, 6, 8, 12, 13, 15, 16].includes(j) || j === 7 ? [b] : []));
  const ratios: number[][] = kp2d.map((fr, t) => seg.map((b) => {
    const [j, p] = BONES[b];
    return Math.min(conf[t][j], conf[t][p]) > 0.3 ? dist2(fr[j], fr[p]) / Math.max(Lm[b], 1e-3) : NaN;
  }));
  const half = Math.max(3, round(0.5 * fps));
  let k = new Array<number>(T).fill(NaN);
  for (let t = 0; t < T; t++) {
    const w = ratios.slice(Math.max(0, t - half), t + half + 1).flat().filter(Number.isFinite);
    if (w.length >= 6) k[t] = percentile(w, 90);
  }
  if (k.every(Number.isNaN)) k = k.map(() => 100.0);
  const good = k.flatMap((v, i) => (Number.isFinite(v) ? [i] : []));
  const kg = good.map((i) => k[i]);
  k = k.map((_, i) => interp(i, good, kg));
  return uniformFilter1d(k, Math.min(T, Math.max(3, half)));
}

// ---------------------------------------------------------------------------------------------------------
// Skeleton fit
// ---------------------------------------------------------------------------------------------------------

export interface ReconProblem {
  T: number;
  /** initial parameters: P without the root joint (T,16,3) row-major, then log k (T) */
  x0: Float64Array;
  /** loss at x; writes d loss / d x into g */
  fg: (x: Float64Array, g: Float64Array) => number;
  L: number[];
  rel2d: Arr3;
  rootPx: Arr2;
}

/** Builds the skeleton-fit loss of `reconstruct` (exported for gradient tests). */
export function reconstructProblem(Xnorm: Arr3, kp2d: Arr3, conf: Arr2, statureM: number, fps: number,
  priors: Prior[] | null = null, depthW: number | null = null): ReconProblem {
  const T = Xnorm.length;
  const Xr = Xnorm.map((fr) => fr.map((p) => [p[0] - fr[0][0], p[1] - fr[0][1], p[2] - fr[0][2]]));
  const bl = boneLengths(Xr);
  const Lunits = symmetricLengths(BONES.map((_, b) => median(bl.map((r) => r[b]))));
  const mPerUnit = statureM / statureFromLengths(Lunits);
  let L = Lunits.map((v) => v * mPerUnit);
  const rootPx = kp2d.map((fr) => [fr[0][0], fr[0][1]]);
  const rel2d = kp2d.map((fr, t) => fr.map((p) => [p[0] - rootPx[t][0], p[1] - rootPx[t][1]]));
  const k0 = estimatePxPerM(kp2d, conf, L, fps);
  // Each limb sweeps through the image plane during a delivery, so its longest (robust p95) projection divided
  // by the image scale is its true length *in the 2D keypoints' own convention*. Using it stops the solver from
  // folding elbows/knees in depth just because the lifter's limbs are a bit too long.
  const Lc = L.slice();
  for (const j of [2, 3, 5, 6, 12, 13, 15, 16]) {
    const b = BIDX[j];
    const [jj, pp] = BONES[b];
    const proj: number[] = [];
    for (let t = 0; t < T; t++)
      if (Math.min(conf[t][jj], conf[t][pp]) > 0.3) proj.push(dist2(kp2d[t][jj], kp2d[t][pp]) / k0[t]);
    if (proj.length >= Math.max(5, Math.trunc(0.1 * T))) Lc[b] = 0.25 * L[b] + 0.75 * percentile(proj, 95);
  }
  L = symmetricLengths(Lc);

  const NP = T * 48, n = NP + T;
  const x0 = new Float64Array(n);
  const zl = new Float64Array(T * 17), tgt = new Float64Array(T * 34), w2d = new Float64Array(T * 17);
  const lk0 = new Float64Array(T);
  for (let t = 0; t < T; t++) {
    for (let j = 0; j < 17; j++) {
      const p = Xr[t][j];
      if (j > 0) for (let c = 0; c < 3; c++) x0[(t * 16 + j - 1) * 3 + c] = p[c] * mPerUnit;
      zl[t * 17 + j] = p[2] * mPerUnit;
      tgt[(t * 17 + j) * 2] = rel2d[t][j][0];
      tgt[(t * 17 + j) * 2 + 1] = rel2d[t][j][1];
      w2d[t * 17 + j] = Math.min(1, Math.max(0, conf[t][j])) ** 2;
    }
    lk0[t] = x0[NP + t] = Math.log(k0[t]);
  }
  const jw = new Float64Array(17).fill(1);
  for (const j of ARM) jw[j] = 0.15;
  const CH = BONES.map(([j]) => j), PA = BONES.map(([, p]) => p);
  const elbows = ([[11, 12, 13], [14, 15, 16]] as const).map(([sh, el, wr]) => {
    const c2 = new Float64Array(T), cw = new Float64Array(T);
    for (let t = 0; t < T; t++) {
      const k = kp2d[t];
      const ax = k[sh][0] - k[el][0], ay = k[sh][1] - k[el][1], bx = k[wr][0] - k[el][0], by = k[wr][1] - k[el][1];
      c2[t] = (ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by) + 1e-9);
      cw[t] = Math.min(1, Math.max(0, Math.min(conf[t][sh], conf[t][el], conf[t][wr])));
    }
    return { sh, el, wr, c2, cw };
  });
  const pri = (priors ?? []).map(([frames, ja, jb, dvec, margin]) => ({
    fr: frames.map((f) => Math.trunc(f)).filter((f) => f >= 0 && f < T), ja: Math.trunc(ja), jb: Math.trunc(jb),
    d: dvec.map(Number), margin: Number(margin),
  })).filter((p) => p.fr.length);

  const S = statureM;
  const WB = LOSS_W.bone, W2 = LOSS_W["2d"], WD = depthW ?? LOSS_W.depth, WS = LOSS_W.smooth, WK = LOSS_W.k;
  const WKP = LOSS_W.kprior, WH = LOSS_W.hinge, WE = LOSS_W.elbow, WO = LOSS_W.order;
  const smoothW = (30.0 / fps) ** 2; // acceleration penalty expressed per (1/30 s)^2
  const J = new Float64Array(T * 51), G = new Float64Array(T * 51), gk = new Float64Array(T);
  const u = [0, 0, 0], f = [0, 0, 0], cr = [0, 0, 0], nn = [0, 0, 0], off = [0, 0, 0], lat = [0, 0, 0];
  const gl = [0, 0, 0], gn = [0, 0, 0];

  const fg = (x: Float64Array, g: Float64Array): number => {
    for (let t = 0; t < T; t++) {
      const o = t * 51, q = t * 48;
      J[o] = J[o + 1] = J[o + 2] = 0;
      for (let i = 0; i < 48; i++) J[o + 3 + i] = x[q + i];
    }
    G.fill(0);
    gk.fill(0);
    // bones
    let eBone = 0;
    for (let t = 0; t < T; t++) {
      const o = t * 51;
      for (let b = 0; b < 16; b++) {
        const c = o + CH[b] * 3, p = o + PA[b] * 3;
        const dx = J[c] - J[p], dy = J[c + 1] - J[p + 1], dz = J[c + 2] - J[p + 2];
        const nb = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const r = nb - L[b];
        eBone += r * r;
        if (nb > 0) {
          const s = (2 * WB * r) / nb;
          G[c] += s * dx; G[c + 1] += s * dy; G[c + 2] += s * dz;
          G[p] -= s * dx; G[p + 1] -= s * dy; G[p + 2] -= s * dz;
        }
      }
    }
    eBone *= WB;
    // 2D re-projection, normalised by the body height in pixels
    let e2d = 0;
    for (let t = 0; t < T; t++) {
      const k = Math.exp(x[NP + t]), h = k * S, o = t * 51;
      let gt = 0;
      for (let j = 0; j < 17; j++) {
        const w = w2d[t * 17 + j];
        for (let c = 0; c < 2; c++) {
          const tg = tgt[(t * 17 + j) * 2 + c];
          const r = (J[o + j * 3 + c] * k - tg) / h;
          e2d += r * r * w;
          const a = 2 * W2 * w * r;
          G[o + j * 3 + c] += (a * k) / h;
          gt += (a * tg) / h; // d r / d log k = tgt / h
        }
      }
      gk[t] += gt;
    }
    e2d *= W2;
    // lifter depth
    let eDepth = 0;
    for (let i = 0; i < T * 17; i++) {
      const dz = J[i * 3 + 2] - zl[i];
      eDepth += dz * dz;
      G[i * 3 + 2] += 2 * WD * dz;
    }
    eDepth *= WD;
    // smoothness (acceleration) of joints and of log k
    let eSmooth = 0, eK = 0;
    if (T >= 3) {
      const ws = WS * smoothW;
      for (let t = 0; t + 2 < T; t++) {
        const o0 = t * 51, o1 = o0 + 51, o2 = o1 + 51;
        for (let j = 0; j < 17; j++) {
          let s2 = 0;
          for (let c = 0; c < 3; c++) {
            const i = j * 3 + c;
            const a = J[o2 + i] - 2 * J[o1 + i] + J[o0 + i];
            s2 += a * a;
            const ga = 2 * ws * jw[j] * a;
            G[o2 + i] += ga; G[o1 + i] -= 2 * ga; G[o0 + i] += ga;
          }
          eSmooth += s2 * jw[j];
        }
        const a = x[NP + t + 2] - 2 * x[NP + t + 1] + x[NP + t];
        eK += a * a;
        const ga = 2 * WK * a;
        gk[t + 2] += ga; gk[t + 1] -= 2 * ga; gk[t] += ga;
      }
      eSmooth = eSmooth * WS * smoothW;
      eK *= WK;
    }
    // the image scale is observable (segments sweep through the image plane): keep k near its estimate,
    // otherwise the solver can shrink k and lay every bone flat in the image plane (no foreshortening)
    let eKp = 0;
    for (let t = 0; t < T; t++) {
      const d = x[NP + t] - lk0[t];
      eKp += d * d;
      gk[t] += 2 * WKP * d;
    }
    eKp *= WKP;
    // knees are hinges: the bend axis (thigh x shank) must stay along the pelvis' mediolateral axis.
    // Without this, monocular depth lets knees "bend" sideways (a zig-zag the eye can't see in 2D).
    let eHinge = 0;
    const eLeg = [0, 0];
    for (let t = 0; t < T; t++) {
      const o = t * 51;
      for (let c = 0; c < 3; c++) lat[c] = J[o + 12 + c] - J[o + 3 + c];
      const nl = Math.hypot(lat[0], lat[1], lat[2]), dl = nl + 1e-9;
      const lr = [lat[0], lat[1], lat[2]];
      for (let c = 0; c < 3; c++) { lat[c] /= dl; gl[c] = 0; }
      for (let leg = 0; leg < 2; leg++) {
        const hip = o + (leg ? 12 : 3), knee = hip + 3, ank = hip + 6;
        for (let c = 0; c < 3; c++) { u[c] = J[knee + c] - J[hip + c]; f[c] = J[ank + c] - J[knee + c]; }
        const nu = Math.hypot(u[0], u[1], u[2]), nf = Math.hypot(f[0], f[1], f[2]);
        cr[0] = u[1] * f[2] - u[2] * f[1]; cr[1] = u[2] * f[0] - u[0] * f[2]; cr[2] = u[0] * f[1] - u[1] * f[0];
        const s = nu * nf + 1e-9;
        for (let c = 0; c < 3; c++) nn[c] = cr[c] / s;
        const a = nn[0] * lat[0] + nn[1] * lat[1] + nn[2] * lat[2];
        let e = 0;
        for (let c = 0; c < 3; c++) { off[c] = nn[c] - a * lat[c]; e += off[c] * off[c]; }
        eLeg[leg] += e;
        // backprop: off = n - a lat, a = n . lat, n = (u x f) / (|u||f| + eps)
        let gol = 0;
        for (let c = 0; c < 3; c++) { off[c] *= 2 * WH; gol += off[c] * lat[c]; }
        let gnc = 0;
        for (let c = 0; c < 3; c++) {
          gn[c] = off[c] - gol * lat[c];
          gl[c] += -a * off[c] - gol * nn[c];
          gnc += gn[c] * cr[c];
        }
        const gs = -gnc / (s * s);
        for (let c = 0; c < 3; c++) gn[c] /= s; // d loss / d (u x f)
        const su = nu > 0 ? (gs * nf) / nu : 0, sf = nf > 0 ? (gs * nu) / nf : 0;
        const gu0 = f[1] * gn[2] - f[2] * gn[1] + su * u[0], gu1 = f[2] * gn[0] - f[0] * gn[2] + su * u[1],
          gu2 = f[0] * gn[1] - f[1] * gn[0] + su * u[2];
        const gf0 = gn[1] * u[2] - gn[2] * u[1] + sf * f[0], gf1 = gn[2] * u[0] - gn[0] * u[2] + sf * f[1],
          gf2 = gn[0] * u[1] - gn[1] * u[0] + sf * f[2];
        G[hip] -= gu0; G[hip + 1] -= gu1; G[hip + 2] -= gu2;
        G[knee] += gu0 - gf0; G[knee + 1] += gu1 - gf1; G[knee + 2] += gu2 - gf2;
        G[ank] += gf0; G[ank + 1] += gf1; G[ank + 2] += gf2;
      }
      // lat = lr / (|lr| + eps)
      const glr = (gl[0] * lr[0] + gl[1] * lr[1] + gl[2] * lr[2]) / (dl * dl);
      const sl = nl > 0 ? glr / nl : 0;
      for (let c = 0; c < 3; c++) {
        const v = gl[c] / dl - sl * lr[c];
        G[o + 12 + c] += v;
        G[o + 3 + c] -= v;
      }
    }
    eHinge = eLeg[0] * WH + eLeg[1] * WH;
    // elbows: when depth is ambiguous, prefer the least bend consistent with the image (natural-pose prior);
    // weak, so arms that are visibly bent in 2D stay bent
    let eElbow = 0;
    for (const { sh, el, wr, c2, cw } of elbows) {
      let e = 0;
      for (let t = 0; t < T; t++) {
        const o = t * 51, ps = o + sh * 3, pe = o + el * 3, pw = o + wr * 3;
        for (let c = 0; c < 3; c++) { u[c] = J[ps + c] - J[pe + c]; f[c] = J[pw + c] - J[pe + c]; }
        const nu = Math.hypot(u[0], u[1], u[2]), nf = Math.hypot(f[0], f[1], f[2]);
        const num = u[0] * f[0] + u[1] * f[1] + u[2] * f[2], den = nu * nf + 1e-9;
        const dc = num / den - c2[t];
        e += cw[t] * dc * dc;
        const g3 = 2 * WE * cw[t] * dc, gnum = g3 / den, gden = (-g3 * num) / (den * den);
        const su = nu > 0 ? (gden * nf) / nu : 0, sf = nf > 0 ? (gden * nu) / nf : 0;
        for (let c = 0; c < 3; c++) {
          const gu = gnum * f[c] + su * u[c], gf = gnum * u[c] + sf * f[c];
          G[ps + c] += gu; G[pw + c] += gf; G[pe + c] -= gu + gf;
        }
      }
      eElbow += e * WE;
    }
    // ordering priors (physics, e.g. a planted front foot stays ahead of its knee)
    let eOrder = 0;
    for (const { fr, ja, jb, d, margin } of pri) {
      let e = 0;
      for (const t of fr) {
        const pa = t * 51 + ja * 3, pb = t * 51 + jb * 3;
        const v = margin - ((J[pb] - J[pa]) * d[0] + (J[pb + 1] - J[pa + 1]) * d[1] + (J[pb + 2] - J[pa + 2]) * d[2]);
        if (v > 0) {
          e += v * v;
          const gg = -2 * WO * v;
          for (let c = 0; c < 3; c++) { G[pb + c] += gg * d[c]; G[pa + c] -= gg * d[c]; }
        }
      }
      eOrder += e * WO;
    }
    for (let t = 0; t < T; t++) {
      const o = t * 51 + 3, q = t * 48;
      for (let i = 0; i < 48; i++) g[q + i] = G[o + i];
      g[NP + t] = gk[t];
    }
    return eBone + e2d + eDepth + eSmooth + eK + eKp + eHinge + eOrder + eElbow;
  };
  return { T, x0, fg, L, rel2d, rootPx };
}

/** X_norm: lifter output (T,17,3); kp2d/conf: H36M-ordered 2D pixels (T,17,2) and confidences (T,17).
 *
 * priors: optional ordering constraints [(frames, joint_a, joint_b, direction(3,), margin_m)] meaning
 * (J[joint_b] - J[joint_a]) . direction >= margin on those frames (soft hinge penalty). Used to resolve the
 * monocular depth-sign ambiguity with physics, e.g. a planted front foot stays ahead of its knee. */
export function reconstruct(Xnorm: Arr3, kp2d: Arr3, conf: Arr2, statureM: number, fps: number,
  opts: { iters?: number; priors?: Prior[] | null; depthW?: number | null } = {}): Skeleton3D {
  const pb = reconstructProblem(Xnorm, kp2d, conf, statureM, fps, opts.priors ?? null, opts.depthW ?? null);
  const T = pb.T, NP = T * 48;
  const x = pb.x0.slice();
  lbfgs(pb.fg, x, opts.iters ?? 250);
  // outputs are float32 in Python
  const F = Math.fround;
  const k = Array.from({ length: T }, (_, t) => Math.exp(x[NP + t]));
  const joints: Arr3 = [], err: Arr2 = [];
  for (let t = 0; t < T; t++) {
    const fr: number[][] = [[0, 0, 0]], e: number[] = [0];
    for (let j = 1; j < 17; j++) fr.push([x[(t * 16 + j - 1) * 3], x[(t * 16 + j - 1) * 3 + 1], x[(t * 16 + j - 1) * 3 + 2]]);
    for (let j = 0; j < 17; j++) {
      e[j] = F(Math.hypot(fr[j][0] * k[t] - pb.rel2d[t][j][0], fr[j][1] * k[t] - pb.rel2d[t][j][1]));
      fr[j] = fr[j].map(F);
    }
    joints.push(fr);
    err.push(e);
  }
  return { joints, bone_lengths: pb.L.map(F), px_per_m: k.map(F), root_px: pb.rootPx.map((r) => r.map(F)),
    stature_m: statureM, reproj_err_px: err };
}

// ---------------------------------------------------------------------------------------------------------
// L-BFGS: port of torch.optim.LBFGS (lr=1, history 100, tolerance_grad 1e-7, tolerance_change 1e-9,
// max_eval = max_iter * 5 // 4, line_search_fn="strong_wolfe"), a single .step() call. Minimises in place.
// ---------------------------------------------------------------------------------------------------------

type FG = (x: Float64Array, g: Float64Array) => number;

// Dot products use 4 accumulators (latency-bound otherwise); torch's BLAS sums in its own order anyway.
function vdot(a: Float64Array, b: Float64Array): number {
  const n = a.length;
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0, i = 0;
  for (; i + 3 < n; i += 4) {
    s0 += a[i] * b[i]; s1 += a[i + 1] * b[i + 1]; s2 += a[i + 2] * b[i + 2]; s3 += a[i + 3] * b[i + 3];
  }
  for (; i < n; i++) s0 += a[i] * b[i];
  return s0 + s1 + (s2 + s3);
}
/** q += a * v in place, then returns w . q (fused: one pass over memory). */
function axpyDot(q: Float64Array, a: number, v: Float64Array, w: Float64Array | null): number {
  const n = q.length;
  if (!w) {
    for (let i = 0; i < n; i++) q[i] += a * v[i];
    return 0;
  }
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0, i = 0;
  for (; i + 3 < n; i += 4) {
    const q0 = (q[i] += a * v[i]), q1 = (q[i + 1] += a * v[i + 1]);
    const q2 = (q[i + 2] += a * v[i + 2]), q3 = (q[i + 3] += a * v[i + 3]);
    s0 += w[i] * q0; s1 += w[i + 1] * q1; s2 += w[i + 2] * q2; s3 += w[i + 3] * q3;
  }
  for (; i < n; i++) s0 += w[i] * (q[i] += a * v[i]);
  return s0 + s1 + (s2 + s3);
}
const absMax = (a: Float64Array): number => {
  let m = 0;
  for (let i = 0; i < a.length; i++) { const v = Math.abs(a[i]); if (v > m || v !== v) m = v; }
  return m;
};

function cubicInterpolate(x1: number, f1: number, g1: number, x2: number, f2: number, g2: number,
  bounds?: [number, number]): number {
  const [lo, hi] = bounds ?? (x1 <= x2 ? [x1, x2] : [x2, x1]);
  const d1 = g1 + g2 - (3 * (f1 - f2)) / (x1 - x2);
  const d2sq = d1 * d1 - g1 * g2;
  if (d2sq >= 0) {
    const d2 = Math.sqrt(d2sq);
    const p = x1 <= x2 ? x2 - (x2 - x1) * ((g2 + d2 - d1) / (g2 - g1 + 2 * d2))
      : x1 - (x1 - x2) * ((g1 + d2 - d1) / (g1 - g2 + 2 * d2));
    return Math.min(Math.max(p, lo), hi);
  }
  return (lo + hi) / 2;
}

function strongWolfe(obj: (t: number) => [number, Float64Array], t: number, d: Float64Array, f: number,
  g: Float64Array, gtd: number, c1 = 1e-4, c2 = 0.9, tolChange = 1e-9, maxLs = 25): [number, Float64Array, number, number] {
  const dNorm = absMax(d);
  let [fNew, gNew] = obj(t);
  let evals = 1;
  let gtdNew = vdot(gNew, d);
  let tPrev = 0, fPrev = f, gPrev = g, gtdPrev = gtd;
  let done = false, it = 0;
  let br: number[] = [], bf: number[] = [], bg: Float64Array[] = [], bgtd: number[] = [];
  // bracketing phase
  while (it < maxLs) {
    if (fNew > f + c1 * t * gtd || (it > 1 && fNew >= fPrev)) {
      br = [tPrev, t]; bf = [fPrev, fNew]; bg = [gPrev, gNew]; bgtd = [gtdPrev, gtdNew];
      break;
    }
    if (Math.abs(gtdNew) <= -c2 * gtd) {
      br = [t]; bf = [fNew]; bg = [gNew]; done = true;
      break;
    }
    if (gtdNew >= 0) {
      br = [tPrev, t]; bf = [fPrev, fNew]; bg = [gPrev, gNew]; bgtd = [gtdPrev, gtdNew];
      break;
    }
    const minStep = t + 0.01 * (t - tPrev), maxStep = t * 10, tmp = t;
    t = cubicInterpolate(tPrev, fPrev, gtdPrev, t, fNew, gtdNew, [minStep, maxStep]);
    tPrev = tmp; fPrev = fNew; gPrev = gNew; gtdPrev = gtdNew;
    [fNew, gNew] = obj(t);
    evals++;
    gtdNew = vdot(gNew, d);
    it++;
  }
  if (it === maxLs) { br = [0, t]; bf = [f, fNew]; bg = [g, gNew]; }
  // zoom phase
  let insuf = false;
  let [low, high] = bf[0] <= bf[bf.length - 1] ? [0, 1] : [1, 0];
  while (!done && it < maxLs) {
    if (Math.abs(br[1] - br[0]) * dNorm < tolChange) break;
    t = cubicInterpolate(br[0], bf[0], bgtd[0], br[1], bf[1], bgtd[1]);
    const bmax = Math.max(br[0], br[1]), bmin = Math.min(br[0], br[1]);
    const eps = 0.1 * (bmax - bmin);
    if (Math.min(bmax - t, t - bmin) < eps) {
      // interpolation close to the boundary, or out of the bracket
      if (insuf || t >= bmax || t <= bmin) {
        t = Math.abs(t - bmax) < Math.abs(t - bmin) ? bmax - eps : bmin + eps;
        insuf = false;
      } else insuf = true;
    } else insuf = false;
    [fNew, gNew] = obj(t);
    evals++;
    gtdNew = vdot(gNew, d);
    it++;
    if (fNew > f + c1 * t * gtd || fNew >= bf[low]) {
      br[high] = t; bf[high] = fNew; bg[high] = gNew; bgtd[high] = gtdNew;
      [low, high] = bf[0] <= bf[1] ? [0, 1] : [1, 0];
    } else {
      if (Math.abs(gtdNew) <= -c2 * gtd) done = true;
      else if (gtdNew * (br[high] - br[low]) >= 0) {
        br[high] = br[low]; bf[high] = bf[low]; bg[high] = bg[low]; bgtd[high] = bgtd[low];
      }
      br[low] = t; bf[low] = fNew; bg[low] = gNew; bgtd[low] = gtdNew;
    }
  }
  return [bf[low], bg[low], br[low], evals];
}

export function lbfgs(fg: FG, x: Float64Array, maxIter: number, lr = 1, tolGrad = 1e-7, tolChange = 1e-9,
  historySize = 100): void {
  const n = x.length, maxEval = Math.floor((maxIter * 5) / 4);
  let g = new Float64Array(n);
  let loss = fg(x, g);
  let evals = 1;
  if (absMax(g) <= tolGrad) return;
  // history (y = grad change, s = step) as a FIFO of reused buffers
  const dirs: Float64Array[] = [], stps: Float64Array[] = [], ro: number[] = [];
  let ySpare = new Float64Array(n), sSpare = new Float64Array(n);
  const al = new Float64Array(historySize);
  const d = new Float64Array(n), prevG = new Float64Array(n), xt = new Float64Array(n);
  let t = 0, Hdiag = 1, prevLoss = loss;
  const obj = (tt: number): [number, Float64Array] => {
    for (let i = 0; i < n; i++) xt[i] = x[i] + tt * d[i];
    const gg = new Float64Array(n);
    return [fg(xt, gg), gg];
  };
  for (let it = 1; it <= maxIter; it++) {
    // compute the descent direction
    if (it === 1) {
      for (let i = 0; i < n; i++) d[i] = -g[i];
      Hdiag = 1;
    } else {
      const y = ySpare, s = sSpare;
      for (let i = 0; i < n; i++) { y[i] = g[i] - prevG[i]; s[i] = d[i] * t; }
      const ys = vdot(y, s);
      if (ys > 1e-10) {
        // updating memory
        if (dirs.length === historySize) {
          ySpare = dirs.shift()!; sSpare = stps.shift()!; ro.shift();
        } else {
          ySpare = new Float64Array(n); sSpare = new Float64Array(n);
        }
        dirs.push(y); stps.push(s); ro.push(1.0 / ys);
        Hdiag = ys / vdot(y, y);
      }
      // two-loop recursion d = -H g (in d, which held the previous direction)
      const m = dirs.length;
      for (let i = 0; i < n; i++) d[i] = -g[i];
      if (m) {
        let sq = vdot(stps[m - 1], d);
        for (let i = m - 1; i >= 0; i--) {
          al[i] = sq * ro[i];
          sq = axpyDot(d, -al[i], dirs[i], i > 0 ? stps[i - 1] : null);
        }
      }
      for (let i = 0; i < n; i++) d[i] *= Hdiag;
      if (m) {
        let yr = vdot(dirs[0], d);
        for (let i = 0; i < m; i++) yr = axpyDot(d, al[i] - yr * ro[i], stps[i], i + 1 < m ? dirs[i + 1] : null);
      }
    }
    prevG.set(g);
    prevLoss = loss;
    // step size: first iteration scaled by the gradient's L1 norm
    if (it === 1) {
      let s1 = 0;
      for (let i = 0; i < n; i++) s1 += Math.abs(g[i]);
      t = Math.min(1.0, 1.0 / s1) * lr;
    } else t = lr;
    const gtd = vdot(g, d);
    if (gtd > -tolChange) break; // directional derivative below tolerance
    let lsEvals: number;
    [loss, g, t, lsEvals] = strongWolfe(obj, t, d, loss, g, gtd);
    for (let i = 0; i < n; i++) x[i] += t * d[i];
    const optCond = absMax(g) <= tolGrad;
    evals += lsEvals;
    // check conditions
    if (it === maxIter || evals >= maxEval || optCond) break;
    if (absMax(d) * Math.abs(t) <= tolChange) break;
    if (Math.abs(loss - prevLoss) < tolChange) break;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Reference frames
// ---------------------------------------------------------------------------------------------------------

// kinematics.unit: v / max(|v|, 1e-9)  (nd.unit uses |v| + 1e-12)
const unitPy = (v: number[]): Vec3 => {
  const nv = Math.max(Math.hypot(v[0], v[1], v[2]), 1e-9);
  return [v[0] / nv, v[1] / nv, v[2] / nv];
};
const dot3 = (a: number[], b: number[]): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export function rotationAboutX(deg: number): number[][] {
  const r = deg * (Math.PI / 180); // np.radians
  const c = Math.cos(r), s = Math.sin(r);
  return [[1, 0, 0], [0, c, -s], [0, s, c]];
}

/** Gravity ~ camera -y corrected by a pitch estimated from the ground contact geometry.
 *
 * At FFC the front foot is planted and the back foot is (still) near the ground, so the back->front ankle
 * vector lies close to the ground plane. Its elevation in the camera's y-z plane gives the camera pitch
 * (broadcast/phone cameras are levelled, so roll is assumed ~0). The stride vector is only trusted when it
 * agrees with the direction of travel (forwardHint, from the run-up facing direction). Without a run-up in the
 * clip the hint comes from the hips around release, which have already turned towards the batter: then the
 * stride itself is the direction of travel (it only has to point the same way as the hint). */
export function estimateWorldFrame(P: Arr3, ffc: number | null, _bfc: number | null, frontAnkle: number,
  backAnkle: number, forwardHint: number[] | null, hintReliable = true): WorldFrame {
  const deg = (r: number) => r * (180 / Math.PI); // np.degrees
  let pitch = 0;
  let forward: number[] | null = forwardHint ?? null;
  if (ffc !== null && ffc !== undefined) {
    const a = P[ffc][frontAnkle], b = P[ffc][backAnkle];
    const v = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    const nv = Math.hypot(v[0], v[1], v[2]);
    const agrees = forward === null || dot3(unitPy(v), unitPy(forward)) > (hintReliable ? 0.5 : 0.0);
    if (nv > 0.35 && agrees) {
      // pitch only from the depth component (behind/front views); side views barely constrain it
      if (Math.abs(v[2]) > 0.5 * nv) {
        const sg = Math.sign(v[2]);
        pitch = deg(Math.atan2(-v[1], Math.abs(v[2]))) * sg;
        // at FFC the back heel is lifted (ankle ~8 cm above the planted front ankle)
        pitch += deg(Math.atan2(0.08, nv)) * sg;
        pitch = Math.min(25, Math.max(-25, pitch));
      }
      if (forwardHint === null || forwardHint === undefined || !hintReliable) forward = v;
    }
  }
  const R = rotationAboutX(pitch);
  const up = R.map((r) => r[0] * 0 + r[1] * -1 + r[2] * 0) as Vec3; // R @ (0, -1, 0)
  let fw = forward ?? [0, 0, 1];
  const fu = dot3(fw, up);
  fw = [fw[0] - up[0] * fu, fw[1] - up[1] * fu, fw[2] - up[2] * fu];
  if (Math.hypot(fw[0], fw[1], fw[2]) < 1e-6) fw = [-up[0] * up[2], -up[1] * up[2], 1 - up[2] * up[2]];
  const fwd = unitPy(fw);
  const lateral = unitPy([up[1] * fwd[2] - up[2] * fwd[1], up[2] * fwd[0] - up[0] * fwd[2], up[0] * fwd[1] - up[1] * fwd[0]]);
  return { up, forward: fwd, lateral, camera_pitch_deg: pitch };
}
