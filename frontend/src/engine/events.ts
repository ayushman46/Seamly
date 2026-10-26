/**
 * Delivery events, bowling arm and camera view (port of backend/bowlnet/events.py).
 *
 * Monocular depth is the least reliable quantity, so every event is detected from *image-plane* signals that are
 * observable from any viewpoint, with 3D only used as a tie-breaker:
 *  - ball release (BR): the bowling wrist's final upswing - after the arm's last low point behind the body, the frame
 *    where the wrist reaches its highest point relative to the shoulder; refined towards peak arm angular speed at
 *    high frame rates.
 *  - upper-arm horizontal (UAH): the elbow rises through shoulder height during that upswing.
 *  - foot contacts (BFC/FFC): a planted foot is stationary in the world, hence stationary in camera-motion-stabilised
 *    image coordinates. Contact = onset of ankle stationarity. Zeni et al. (2008) pelvis-relative foot position is a
 *    secondary cue for side-on views.
 * Candidates are solved jointly with timing priors from 92 bowlers (Andrews 2024):
 * BFC->FFC 197 +/- 59 ms, FFC->BR 126 +/- 37 ms; ordering BFC < FFC < BR.
 */
import type { Arr1, Arr2, Arr3 } from "./nd";
import { cross, dot } from "./nd";
import { npMedian, uniformFilter1dScipy } from "./pose2d";
import { L_SH, L_WR, PELVIS, R_HIP, L_HIP, R_SH, R_WR } from "./types";
import type { Arm, EventKey, Events, Side, ViewInfo } from "./types";
import { round } from "./util";

export const BFC_FFC_MS: [number, number] = [197.0, 59.0];
export const FFC_BR_MS: [number, number] = [126.0, 37.0];

// ---------------- numpy-exact helpers ----------------
/** np.degrees / np.radians (x * (180 / pi), as numpy computes them). */
export const degrees = (x: number): number => x * (180.0 / Math.PI);
export const radians = (x: number): number => x * (Math.PI / 180.0);
/** np.sign (0 -> 0, NaN -> NaN; never -0). */
export const npSign = (v: number): number => (v > 0 ? 1 : v < 0 ? -1 : v === 0 ? 0 : NaN);
/** np.clip on a scalar (lo > hi gives hi, like numpy). */
export const npClip = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);
/** np.mod / Python % on floats (result takes the divisor's sign). */
export function pyMod(a: number, b: number): number {
  let m = a % b;
  if (m !== 0 && (b < 0) !== (m < 0)) m += b;
  return m;
}
/** kinematics.unit: v / max(|v|, 1e-9). */
export function unitK(v: number[]): number[] {
  const n = Math.sqrt(dot(v, v));
  const d = Math.max(n, 1e-9);
  return v.map((x) => x / d);
}
const norm2 = (x: number, y: number): number => Math.sqrt(x * x + y * y);
const amaxN = (a: Arr1): number => a.reduce((m, v) => (v > m || Number.isNaN(v) ? v : m), -Infinity);
const aminN = (a: Arr1): number => a.reduce((m, v) => (v < m || Number.isNaN(v) ? v : m), Infinity);
const meanN = (a: Arr1): number => a.reduce((s, v) => s + v, 0) / a.length;
/** np.percentile(a, q), linear method, with numpy's lerp arithmetic. */
export function npPercentile(a: Arr1, q: number): number {
  const n = a.length;
  if (!n || a.some((v) => Number.isNaN(v))) return NaN;
  const s = a.slice().sort((x, y) => x - y);
  const vi = (n - 1) * (q / 100);
  const lo = vi >= n - 1 ? n - 1 : Math.floor(vi), hi = vi >= n - 1 ? n - 1 : lo + 1;
  const t = vi - Math.floor(vi);
  const d = s[hi] - s[lo];
  return t >= 0.5 ? s[hi] - d * (1 - t) : s[lo] + d * t;
}
/** Python's built-in max(range, key=f): first maximal element. */
function argmaxBy(lo: number, hi: number, key: (t: number) => number): number {
  let best = lo;
  for (let t = lo + 1; t < hi; t++) if (key(t) > key(best)) best = t;
  return best;
}
/** w (n-1 rates between frames) -> n per-frame values: ends kept, interior averaged. */
function endsAvg(w: Arr1): Arr1 {
  const out = [w[0]];
  for (let i = 1; i < w.length; i++) out.push((w[i] + w[i - 1]) / 2);
  out.push(w[w.length - 1]);
  return out;
}
/** np.unwrap (period 2 pi), numpy's exact arithmetic. */
export function unwrap(p: Arr1): Arr1 {
  const hiI = Math.PI, loI = -Math.PI, period = 2 * Math.PI;
  const out = p.slice();
  let cum = 0;
  for (let i = 1; i < p.length; i++) {
    const dd = p[i] - p[i - 1];
    let ddmod = pyMod(dd - loI, period) + loI;
    if (ddmod === loI && dd > 0) ddmod = hiI;
    let ph = ddmod - dd;
    if (Math.abs(dd) < Math.PI) ph = 0;
    cum += ph;
    out[i] = p[i] + cum;
  }
  return out;
}
/** np.gradient along axis 0 (edge_order=1) of a (T,2) array. */
function gradient2(p: Arr2): Arr2 {
  const T = p.length;
  return p.map((_, t) => {
    if (t === 0) return [p[1][0] - p[0][0], p[1][1] - p[0][1]];
    if (t === T - 1) return [p[t][0] - p[t - 1][0], p[t][1] - p[t - 1][1]];
    return [(p[t + 1][0] - p[t - 1][0]) / 2.0, (p[t + 1][1] - p[t - 1][1]) / 2.0];
  });
}

// ---------------- camera stabilisation ----------------
type M3 = number[][];
const matmul3 = (A: M3, B: M3): M3 =>
  A.map((r) => [0, 1, 2].map((j) => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));
function inv3(M: M3): M3 {
  const [[a, b, c], [d, e, f], [g, h, i]] = M;
  const A = e * i - f * h, B = -(d * i - f * g), Cc = d * h - e * g;
  const det = a * A + b * B + c * Cc;
  return [[A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [Cc / det, -(a * h - b * g) / det, (a * e - b * d) / det]];
}

/** Map per-frame image points into frame `ref`'s pixel coordinates using camera motion.
 * motions[t] (2x3) maps frame t-1 pixels -> frame t pixels. */
export function stabilise(kp: Arr3, motions: Arr3, ref: number): Arr3 {
  const T = kp.length;
  const H: M3[] = [[[1, 0, 0], [0, 1, 0], [0, 0, 1]]];
  for (let t = 1; t < T; t++) H.push(matmul3([motions[t][0], motions[t][1], [0, 0, 1]], H[t - 1]));   // frame 0 -> t
  const Hr = H[ref];
  return kp.map((fr, t) => {
    const G = matmul3(Hr, inv3(H[t]));   // frame t -> frame ref
    return fr.map(([x, y]) => [x * G[0][0] + y * G[0][1] + G[0][2], x * G[1][0] + y * G[1][1] + G[1][2]]);
  });
}

// ---------------- arm signals ----------------
export function armAngularSpeed(P: Arr3, sh: number, wr: number, fps: number): Arr1 {
  const a = P.map((f) => unitK([f[wr][0] - f[sh][0], f[wr][1] - f[sh][1], f[wr][2] - f[sh][2]]));
  if (a.length < 2) return new Array(a.length).fill(0);
  const w: Arr1 = [];
  for (let i = 1; i < a.length; i++) {
    const d = npClip(a[i][0] * a[i - 1][0] + a[i][1] * a[i - 1][1] + a[i][2] * a[i - 1][2], -1, 1);
    w.push(degrees(Math.acos(d)) * fps);
  }
  return endsAvg(w);
}

export function armSpeed2d(kp: Arr3, sh: number, wr: number, fps: number): Arr1 {
  const a = unwrap(kp.map((f) => Math.atan2(f[wr][1] - f[sh][1], f[wr][0] - f[sh][0])));
  const w: Arr1 = [];
  for (let i = 1; i < a.length; i++) w.push(degrees(Math.abs(a[i] - a[i - 1])) * fps);
  return w.length ? endsAvg(w) : new Array(kp.length).fill(0);
}

/** Height of the wrist above the shoulder in arm lengths (image y is down). */
export function wristLift(kp: Arr3, sh: number, el: number, wr: number): Arr1 {
  const arm = kp.map((f) => norm2(f[el][0] - f[sh][0], f[el][1] - f[sh][1]) + norm2(f[wr][0] - f[el][0], f[wr][1] - f[el][1]));
  const armS = uniformFilter1dScipy(arm, Math.min(arm.length, 9)).map((v) => Math.max(v, 1.0));
  return kp.map((f, t) => (f[sh][1] - f[wr][1]) / armS[t]);
}

/** Vote: (1) which arm makes the fast final upswing to the highest point, (2) 2D angular speed,
 * (3) 3D angular speed, (4) the tracker-level sweep hint. kc is unused (kept for the Python signature). */
export function decideBowlingArm(kp: Arr3, _kc: Arr2, P: Arr3, fps: number, sweepHint: string | null | undefined,
  window: [number, number]): [Arm, number, Record<string, number>] {
  let lo = Math.max(0, window[0]), hi = Math.min(kp.length, window[1]);
  if (hi - lo < 3) {   // degenerate window (very low fps / sweep at the clip edge)
    lo = Math.max(0, Math.min(lo, kp.length - 3));
    hi = Math.min(kp.length, lo + 3);
  }
  const votes: Record<string, number> = {};
  const wr = armSpeed2d(kp, 6, 10, fps).slice(lo, hi), wl = armSpeed2d(kp, 5, 9, fps).slice(lo, hi);
  votes.speed_2d = npSign(npPercentile(wr, 90) - npPercentile(wl, 90));
  const lr = wristLift(kp, 6, 8, 10).slice(lo, hi), ll = wristLift(kp, 5, 7, 9).slice(lo, hi);
  // height reached while moving fast (the front arm is high early and slow; the bowling arm high & fast)
  const mr = amaxN(wr) + 1e-6, ml = amaxN(wl) + 1e-6;
  const fr = lr.map((v, i) => v * (wr[i] / mr)), fl = ll.map((v, i) => v * (wl[i] / ml));
  votes.fast_high_2d = npSign(amaxN(fr) - amaxN(fl));
  const w3r = armAngularSpeed(P, R_SH, R_WR, fps).slice(lo, hi), w3l = armAngularSpeed(P, L_SH, L_WR, fps).slice(lo, hi);
  votes.speed_3d = npSign(npPercentile(w3r, 90) - npPercentile(w3l, 90));
  if (sweepHint === "left" || sweepHint === "right") votes.sweep_2d = sweepHint === "right" ? 1.0 : -1.0;
  const weights: Record<string, number> = { speed_2d: 1.0, fast_high_2d: 1.4, speed_3d: 0.6, sweep_2d: 1.0 };
  let s = 0, total = 0;
  for (const [k, v] of Object.entries(votes)) { s += weights[k] * v; total += weights[k]; }
  return [s >= 0 ? "right" : "left", Math.abs(s) / total, votes];
}

const gauss = (dtMs: number, mu: number, sd: number): number => -0.5 * ((dtMs - mu) / sd) ** 2;

/** Frames where a foot stops: speed falls well below its recent swing speed and stays low.
 * Relative criterion (post/pre speed) tolerates residual camera-zoom drift at broadcast frame rates; at >= 120 fps a
 * genuine stop is observable, so the absolute criterion tightens. Windows are in seconds so the detector behaves the
 * same at 25-240 fps. Returns [frame, strength]. */
export function contactOnsets(speed: Arr1, lo: number, hi: number, thr: number, minStill: number,
  fps = 30.0): [number, number][] {
  const out: [number, number][] = [];
  const preN = Math.max(4, Math.trunc(round(0.12 * fps)));
  const hiFps = npClip((fps - 60.0) / 60.0, 0.0, 1.0);   // 0 at <=60 fps, 1 at >=120 fps
  const relNow = 0.6 - 0.3 * hiFps;                     // speed now vs swing speed
  const relPost = 0.45 - 0.2 * hiFps;
  const absPost = 2.5 - 1.5 * hiFps;                    // x thr (body heights / s)
  lo = Math.max(1, lo);
  hi = Math.min(speed.length - minStill, hi);
  for (let t = lo; t < hi; t++) {
    const pre = amaxN(speed.slice(Math.max(0, t - preN), t));
    const post = npMedian(speed.slice(t, t + minStill + 1));
    if (pre < 1.6 * thr) continue;   // foot was not swinging
    if (speed[t] > relNow * pre || post > relPost * pre || speed[t] > speed[t - 1]) continue;
    if (post > absPost * thr) continue;   // still moving in absolute terms
    out.push([t, Math.min(pre / Math.max(post, 0.2 * thr), 6.0)]);
  }
  // keep the first frame of each run of consecutive onsets
  const dedup: [number, number][] = [];
  const gap = Math.max(1, Math.trunc(round(0.01 * fps)));
  for (const [t, st] of out) {
    const last = dedup[dedup.length - 1];
    if (last && t - last[0] <= gap) {
      if (st > last[1]) dedup[dedup.length - 1] = [last[0], st];
      continue;
    }
    dedup.push([t, st]);
  }
  return dedup;
}

/** fixed: events the user placed (window-relative frames). The remaining events are detected around them, so e.g.
 * moving back-foot contact re-searches front-foot contact after it instead of keeping a stale one. */
export function detectEvents(kp: Arr3, kc: Arr2, kpStab: Arr3, P: Arr3, side: Side, up: number[], forward: number[],
  fps: number, bodyPx: Arr1, sweepWindow: [number, number], sweepPeak: number | null = null,
  fixedIn?: Partial<Record<EventKey, number | null>> | null): Events {
  const T = kp.length;
  const ms = 1000.0 / fps;
  const conf: Partial<Record<EventKey, number>> = {};
  const meth: Partial<Record<EventKey, string>> = {};
  const fixed: Partial<Record<EventKey, number>> = {};
  for (const [k, v] of Object.entries(fixedIn ?? {})) {
    if (v !== null && v !== undefined) fixed[k as EventKey] = Math.trunc(npClip(v, 0, T - 1));
  }
  const kcAt = (a: number, b: number, j: number) => kc.slice(Math.max(0, a), b).map((r) => r[j]);

  // ---------------- ball release: final upswing of the bowling wrist ----------------
  const lift = wristLift(kp, side.c_sh, side.c_el, side.c_wr);   // (uniform_filter1d size=1 is the identity)
  const w2 = armSpeed2d(kp, side.c_sh, side.c_wr, fps);
  let [lo, hi] = sweepWindow;
  const anchor = Math.trunc(npClip(sweepPeak === null ? Math.floor((lo + hi) / 2) : sweepPeak, 0, T - 1));
  lo = Math.max(1, lo - Math.trunc(0.2 * fps));
  hi = Math.min(T - 1, hi + Math.trunc(0.15 * fps));
  // Candidate releases: a rise of the wrist from below the shoulder (arm down/back) to a peak above it, followed by
  // the fall into the follow-through. (A gather where the arms drop from overhead is a fall without a preceding
  // rise, so it never qualifies.)
  const riseWin = Math.max(3, Math.trunc(0.3 * fps));
  let bestC: [number, number, number] | null = null;   // (score, t_low, t_high); Python max() on tuples
  const cands: [number, number, number][] = [];
  const full = new Set<string>();   // candidates with a complete rise above the shoulder and fall into the follow-through
  for (let tl = lo; tl < hi; tl++) {
    if (lift[tl] > -0.15 || lift[tl] > lift[Math.max(0, tl - 1)] || lift[tl] > lift[Math.min(T - 1, tl + 1)]) continue;
    const segHi = Math.min(T, tl + riseWin + 1);
    let th = tl;
    for (let t = tl + 1; t < segHi; t++) if (lift[t] > lift[th]) th = t;
    if (lift[th] < 0.3) continue;
    const amp = lift[th] - lift[tl];
    const riseS = Math.max(1, th - tl) / fps;
    const after = lift.slice(th, Math.min(T, th + Math.max(2, Math.trunc(0.15 * fps))));
    const fall = after.length ? lift[th] - aminN(after) : 0.0;
    const prox = Math.abs(th - anchor) / fps;
    const score = amp + 0.6 * Math.min(fall, 2.0) + 0.15 * Math.min(amp / riseS, 20) - 3.0 * prox;
    cands.push([score, tl, th]);
    if (amp >= 1.5 && fall >= 1.5) full.add(`${tl},${th}`);
    if (!bestC || score > bestC[0] || (score === bestC[0] && (tl > bestC[1] || (tl === bestC[1] && th > bestC[2])))) {
      bestC = [score, tl, th];
    }
  }
  let tLow: number, tTop: number;
  if (fixed.br !== undefined) {
    tTop = fixed.br;
    tLow = Math.max(0, tTop - riseWin);
  } else if (bestC) {
    [, tLow, tTop] = bestC;
    // The release is the last complete up-and-over: when a later candidate also rises well above the shoulder and
    // falls away into the follow-through, the earlier one was the gather or the back-swing (seen from behind, the
    // 2D speed peak that anchors the search can sit on the back-swing).
    if (full.has(`${tLow},${tTop}`)) {
      let pick: [number, number, number] | null = null;   // Python max(key=(t_high, score, t_low))
      for (const c of cands) {
        if (!full.has(`${c[1]},${c[2]}`) || c[2] - tTop < 0.1 * fps) continue;
        if (!pick || c[2] > pick[2] || (c[2] === pick[2] && (c[0] > pick[0] || (c[0] === pick[0] && c[1] > pick[1])))) pick = c;
      }
      if (pick) [, tLow, tTop] = pick;
    }
  } else {
    let tFast = lo;
    if (hi > lo) for (let t = lo + 1; t < hi; t++) if (w2[t] > w2[tFast]) tFast = t;
    tLow = tFast;
    tTop = argmaxBy(Math.max(0, tFast - 2), Math.min(T, tFast + 3), (t) => lift[t]);
  }
  let br = tTop;
  if (fps >= 90 && fixed.br === undefined) {   // high frame rate: release sits just past vertical, where the arm is fastest
    const span = Math.max(1, Math.trunc(round(0.012 * fps)));
    br = argmaxBy(tTop, Math.min(T, tTop + span + 1), (t) => w2[t]);
  }
  meth.br = "wrist_final_upswing_peak";
  conf.br = npClip(0.35 + 0.5 * meanN(kcAt(br - 1, br + 2, side.c_wr))
    + (lift[tLow] < 0 && 0 < lift[tTop] ? 0.15 : -0.15), 0.15, 0.95);

  // ---------------- upper-arm horizontal: elbow rises through shoulder height ----------------
  const elRel = kp.map((f) => f[side.c_sh][1] - f[side.c_el][1]);   // >0 when elbow above shoulder
  let uah: number | null = fixed.uah ?? null;
  if (uah === null) {
    for (let t = br; t > Math.max(tLow, br - Math.trunc(0.3 * fps)); t--) {
      if (elRel[t] >= 0 && 0 > elRel[t - 1]) {
        uah = Math.abs(elRel[t]) <= Math.abs(elRel[t - 1]) ? t : t - 1;
        break;
      }
    }
  }
  if (fixed.uah !== undefined) {
    meth.uah = "user"; conf.uah = 1.0;
  } else if (uah === null) {
    // fall back to 3D elevation
    const elev = P.map((f) => {
      const ua = unitK([f[side.elbow][0] - f[side.shoulder][0], f[side.elbow][1] - f[side.shoulder][1],
        f[side.elbow][2] - f[side.shoulder][2]]);
      return degrees(Math.asin(npClip(ua[0] * up[0] + ua[1] * up[1] + ua[2] * up[2], -1, 1)));
    });
    for (let t = br; t > Math.max(1, br - Math.trunc(0.3 * fps)); t--) {
      if (elev[t] >= 0 && 0 > elev[t - 1]) { uah = t; break; }
    }
    meth.uah = "elevation_3d";
    conf.uah = uah !== null ? 0.4 : 0.0;
  } else {
    meth.uah = "elbow_crosses_shoulder_2d";
    conf.uah = 0.7;
  }
  if (uah !== null && fixed.uah === undefined && uah >= br) {
    uah = br >= 1 ? br - 1 : null;   // the crossing can share release's frame at low fps; UAH precedes it
  }

  // ---------------- foot contacts: ankle stationarity in stabilised image coordinates ----------------
  const h = bodyPx.map((v) => Math.max(v, 1.0));
  const footSpeed = (j: number): Arr1 => {
    const g = gradient2(kpStab.map((f) => f[j]));
    const sp = g.map((d, t) => (norm2(d[0], d[1]) * fps) / h[t]);   // body heights per second
    return uniformFilter1dScipy(sp, Math.max(3, Math.trunc(round(0.025 * fps))));
  };
  const spF = footSpeed(side.c_fan), spB = footSpeed(side.c_ban);
  const thr = 0.55;   // body heights / s (~1 m/s for a 1.8 m athlete); swing foot moves 3-8 h/s
  const still = Math.max(2, Math.trunc(round(0.04 * fps)));
  let fLo = br - Math.trunc(0.35 * fps);
  const fHi = br - Math.max(1, Math.trunc(0.015 * fps)) + 1;
  if (fixed.bfc !== undefined) fLo = fixed.bfc + Math.max(1, Math.trunc(round(0.08 * fps)));   // front foot lands after the back foot
  let ffcC = contactOnsets(spF, fLo, fHi, thr, still, fps);
  // Zeni secondary cue: front ankle most anterior relative to pelvis (3D) - adds candidates for side views
  const fu = dot(forward, up);
  const fwd = unitK(forward.map((v, i) => v - up[i] * fu));
  const frontRel = P.map((f) => (f[side.front_ankle][0] - f[PELVIS][0]) * fwd[0]
    + (f[side.front_ankle][1] - f[PELVIS][1]) * fwd[1] + (f[side.front_ankle][2] - f[PELVIS][2]) * fwd[2]);
  let priorF = Math.max(0, br - Math.trunc(round(FFC_BR_MS[0] / ms)));
  if (fixed.bfc !== undefined) {
    const loP = Math.min(T - 1, fixed.bfc + 1);
    priorF = Math.trunc(npClip(fixed.bfc + round(BFC_FFC_MS[0] / ms), loP, Math.min(T - 1, Math.max(loP, br - 1))));
  }
  ffcC = [...ffcC, [priorF, 0.0]];
  if (fixed.ffc !== undefined) ffcC = [[fixed.ffc, 6.0]];
  let best: [number, number, number, number, number] | null = null;
  for (const [f, sf] of ffcC) {
    const lp = 1.5 * gauss((br - f) * ms, ...FFC_BR_MS);
    const zeniF = f > 0 && frontRel[f] >= amaxN(frontRel.slice(Math.max(0, f - 2), f + 3)) - 0.03 ? 0.4 : 0.0;
    let bfcC = contactOnsets(spB, f - Math.trunc(0.45 * fps), f - Math.max(1, Math.trunc(0.05 * fps)) + 1, thr, still, fps);
    bfcC = [...bfcC, [Math.max(0, f - Math.trunc(round(BFC_FFC_MS[0] / ms))), 0.0]];
    if (fixed.bfc !== undefined) bfcC = [[fixed.bfc, 6.0]];
    for (const [b, sb] of bfcC) {
      const lb = 1.5 * gauss((f - b) * ms, ...BFC_FFC_MS);
      const score = lp + lb + 0.8 * Math.log1p(sf) + 0.6 * Math.log1p(sb) + zeniF;
      if (best === null || score > best[0]) best = [score, f, b, sf, sb];
    }
  }
  const [, ffc, bfc, sf, sb] = best!;
  if (sf === 0.0) meth.ffc = "timing_prior";
  if (sb === 0.0) meth.bfc = "timing_prior";
  meth.ffc ??= "foot_stops_stabilised_2d";
  meth.bfc ??= "foot_stops_stabilised_2d";
  conf.ffc = npClip(0.25 + 0.1 * Math.min(sf, 4) + 0.3 * meanN(kcAt(ffc - 1, ffc + 2, side.c_fan)), 0.2, 0.85);
  conf.bfc = npClip(0.2 + 0.08 * Math.min(sb, 4) + 0.3 * meanN(kcAt(bfc - 1, bfc + 2, side.c_ban)), 0.15, 0.8);
  // contacts placed from typical timing (no clear foot-strike signal) are estimates, not measurements
  if (meth.ffc === "timing_prior") conf.ffc = 0.25;
  if (meth.bfc === "timing_prior") conf.bfc = 0.2;

  // ---------------- follow-through: next back-foot contact after release ----------------
  let ftC = contactOnsets(spB, br + Math.trunc(0.12 * fps), br + Math.trunc(0.9 * fps), thr, still, fps);
  let ft = ftC.length ? ftC[0][0] : Math.min(T - 1, br + Math.trunc(0.5 * fps));
  if (fixed.ft !== undefined) { ft = fixed.ft; ftC = [[fixed.ft, 6.0]]; }
  meth.ft = ftC.length ? "back_foot_recovery_step" : "fixed_offset";
  conf.ft = ftC.length ? 0.6 : 0.3;
  for (const k of Object.keys(fixed) as EventKey[]) { meth[k] = "user"; conf[k] = 1.0; }
  return { bfc, ffc, uah, br, ft, confidence: conf, method: meth };
}

/** Anterior direction (horizontal) from the hip line: up x (R_hip - L_hip). */
export function facingDirection(P: Arr3, up: number[], frames: number[]): number[] {
  const acc = [0, 0, 0];
  for (const t of frames) {
    const f = cross(up, [P[t][R_HIP][0] - P[t][L_HIP][0], P[t][R_HIP][1] - P[t][L_HIP][1], P[t][R_HIP][2] - P[t][L_HIP][2]]);
    const fu = dot(f, up);
    const u = unitK(f.map((v, i) => v - up[i] * fu));
    for (let i = 0; i < 3; i++) acc[i] += u[i];
  }
  return unitK(acc.map((v) => v / frames.length));
}

/** Median horizontal image distance between the ankles from FFC to just after release, in leg lengths.
 * The planted stride is ~1.1 leg lengths long, so this is ~1 when filmed side-on and ~0-0.3 from behind or in front:
 * a depth-free view cue, measured when the stride is open. */
export function strideAcross(kp: Arr3, k: Arr1, legM: number, side: Side, ffc: number | null, br: number): number | null {
  if (ffc === null || ffc === undefined || br < ffc) return null;
  const dx: Arr1 = [];
  for (let t = ffc; t < Math.min(kp.length, br + 3); t++) {
    dx.push(Math.abs(kp[t][side.c_fan][0] - kp[t][side.c_ban][0]) / Math.max(k[t] * legM, 1e-6));
  }
  return npMedian(dx);
}

/** Side-on / behind / front-on from the direction of travel in camera axes (z = optical axis).
 * The planted stride's foreshortening (strideAcross) decides when it is clear; otherwise the apparent hip width /
 * torso length ratio during the run-up (side-on -> narrow), then the 3D direction. */
/** events.arm_peak_speed: peak angular speed (deg/s) of the bowling arm's shoulder-to-wrist line from 0.25 s before
 * release to 0.1 s after, on the refined 2D keypoints: the second-fastest frame step, so one keypoint glitch doesn't
 * count, and steps over 110 deg (a swap or a misdetection) are left out. null with fewer than two usable steps. */
export function armPeakSpeed(kp: Arr3, kc: Arr2, sh: number, wr: number, br: number, fps: number): number | null {
  const lo = Math.max(0, br - round(0.25 * fps)), hi = Math.min(kp.length - 1, br + round(0.1 * fps));
  const steps: number[] = [];
  for (let t = lo; t < hi; t++) {
    if (Math.min(kc[t][sh], kc[t][wr], kc[t + 1][sh], kc[t + 1][wr]) < 0.3) continue;
    const a0 = Math.atan2(kp[t][wr][1] - kp[t][sh][1], kp[t][wr][0] - kp[t][sh][0]);
    const a1 = Math.atan2(kp[t + 1][wr][1] - kp[t + 1][sh][1], kp[t + 1][wr][0] - kp[t + 1][sh][0]);
    const twoPi = 2 * Math.PI;
    const d = ((((a1 - a0 + Math.PI) % twoPi) + twoPi) % twoPi) - Math.PI;   // Python's % (always >= 0)
    if (Math.abs(d) <= (110 * Math.PI) / 180) steps.push(Math.abs(d));
  }
  if (steps.length < 2) return null;
  steps.sort((x, y) => x - y);
  return ((steps[steps.length - 2] * 180) / Math.PI) * fps;
}

export function classifyView(forwardCam: number[], kp?: Arr3 | null, _kc?: Arr2 | null, runup?: number[] | null,
  strideX?: number | null): ViewInfo {
  const f = unitK(forwardCam);
  const ang = degrees(Math.acos(npClip(Math.abs(f[2]), 0, 1)));   // 0 = along optical axis
  let ratio: number | null = null;
  if (kp && runup && runup.length) {
    ratio = npMedian(runup.map((t) => {
      const p = kp[t];
      const hipw = norm2(p[11][0] - p[12][0], p[11][1] - p[12][1]);
      const torso = norm2((p[5][0] + p[6][0]) / 2 - (p[11][0] + p[12][0]) / 2, (p[5][1] + p[6][1]) / 2 - (p[11][1] + p[12][1]) / 2);
      return hipw / Math.max(torso, 1);
    }));
  }
  let view: ViewInfo["view"];
  if (strideX != null && (strideX > 0.7 || strideX < 0.4)) {
    // behind/front-on clips measure 0.03-0.3, side-on 1.0-1.1 (an oblique ~35-45 deg view lands in between)
    view = strideX > 0.7 ? "side_on" : f[2] >= 0 ? "behind" : "front_on";
  } else if (ratio !== null) {
    // the 2D ratio is the more reliable cue (depth from monocular lifting is weak)
    if (ratio < 0.28) view = "side_on";
    else if (ratio > 0.42) view = f[2] >= 0 ? "behind" : "front_on";
    else view = ang > 55 ? "side_on" : f[2] >= 0 ? "behind" : "front_on";
  } else {
    view = ang > 55 ? "side_on" : f[2] > 0 ? "behind" : "front_on";
  }
  const out: ViewInfo = { view, angle_to_optical_axis_deg: round(ang, 1),
    hip_width_ratio: ratio === null ? null : round(ratio, 3) };
  if (strideX != null) out.stride_across = round(strideX, 2);
  // An oblique camera (well off the line of the pitch, or high in the stands) shows up as the two 2D cues
  // contradicting each other, or both sitting in their in-between bands so only the weak 3D direction decided.
  // Plane-specific measurements aren't trustworthy then.
  const sDec = strideX != null && (strideX > 0.7 || strideX < 0.4);
  const rDec = ratio !== null && (ratio < 0.28 || ratio > 0.42);
  const clash = sDec && rDec && ((strideX! > 0.7) !== (ratio! < 0.28));
  // With no run-up in the clip the stride is the only 2D cue. When it says the camera looks along the pitch but the
  // body's 3D direction of travel runs well across the picture, the camera is behind (or in front) and off to one
  // side: short clips cut from edited footage show this (real IPL net clips, 2026-10-27).
  const lone = sDec && ratio === null && strideX! < 0.4 && ang > 60;
  // neither 2D cue decided (in-between values, or none at all): only the weak 3D direction chose the view
  if (clash || lone || (!sDec && !rDec)) out.oblique = true;
  return out;
}
