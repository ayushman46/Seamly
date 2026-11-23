/**
 * The ball's real flight, from where it was seen in the video. Given a camera worked out from the pitch markings
 * (lib/camcal.ts) and the ball's position in a handful of frames, this finds the one flight through the air, off the
 * pitch and on to the batter that passes through those sightings: where it was let go and how fast, where it pitched,
 * how much it swung and how much it moved off the pitch, how high it arrived and whether it was hitting the stumps.
 *
 * How one camera can do it. One picture gives a line of sight, not a position. Three things turn the lines into a
 * flight:
 *   1. the ball is on the ground when it pitches, and the ground is a known plane, so the kink in its path is a
 *      known point on the pitch;
 *   2. in the air it follows gravity and drag, whose size is known, and the frames are a clock;
 *   3. it starts in the bowler's hand, whose height above the ground and place at the crease the analysis already
 *      has (the front foot is on the ground, so its position is known too).
 * After the bounce there is no second anchor, so the speed it keeps along the ground leans on what cricket balls
 * usually keep (0.87 +/- 0.08 of it); the error bars say what that costs.
 *
 * Every figure comes with its own uncertainty, from how well the flight fits the sightings and how far each figure
 * can move before the fit gets worse (the covariance of the least-squares fit), and, in `withCameraDoubt`, from
 * re-fitting with the pitch marks nudged by a pixel or two.
 *
 * Scene axes as lib/flight.ts: y up, bowler's stumps z = 0, batter's z = -20.12.
 */
import { levenbergMarquardt, invert, jacobian, solve } from "./lm";
import { project, onPlaneY, onPlaneZ, type Camera, type Pt } from "./camcal";
import { BALL_R, BALL_M, STUMPS_Z, CREASE_Z, STUMP_H, STUMPS_W, CD, BOUNCE } from "./flight";
import type { V3 } from "./biomech";

const G = 9.81, RHO = 1.2, AREA = Math.PI * BALL_R * BALL_R, KD = (0.5 * RHO * CD * AREA) / BALL_M, KS1 = (0.5 * RHO * AREA) / BALL_M;
/** What a cricket ball usually keeps off the pitch (the prior for the part one camera cannot see directly). */
export const KEEP = { along: BOUNCE.along, alongSigma: 0.08, up: BOUNCE.up, upSigma: 0.3 } as const;

export interface BallObs {
  t: number;            // seconds, real time (slow-motion already undone), any origin
  px: Pt;               // centre of the ball in the picture the camera was fitted on
  sigma?: number;       // how well that centre is known, pixels (default 1.5)
  /**
   * The ball's shadow on the ground in the same frame, when the sun is out. A shadow is a second sighting from a
   * second direction (the sun's): the ball is on the line of sight AND straight up-sun from its shadow, and the
   * ground under the shadow is a known place. That fixes how far away the ball is, which one camera alone cannot.
   */
  shadow?: Pt | null;
}
export interface TrackPriors {
  releaseT: number;                 // when the analysis saw the release (same clock as the sightings)
  releaseZ: number;                 // how far down the pitch the hand lets go (scene z)
  releaseZSigma?: number;           // default 0.35 m
  releaseTSigma?: number;           // how well that moment is known, in frames (default 0.4)
  releaseHeight?: number | null;    // measured release height, metres
  releaseHeightSigma?: number;      // default 0.12 m
  fps: number;                      // real frames per second
  /**
   * Which way shadows fall on the ground (x, z), read off the shadow of something upright: a stump, an umpire. The
   * ball's own shadow says how far the sun pushes it sideways but, through a long lens, not how far along the pitch;
   * this does, and with it the ball's distance from the camera no longer leans on the release point or on drag.
   */
  shadowDir?: [number, number] | null;
  shadowDirSigma?: number;          // degrees (default 6: people do not stand quite straight)
}

export interface Sigma { value: number; sigma: number }
export interface Tracked {
  release: { t: number; p: V3; kmh: Sigma; down: number };                 // down: degrees below level as it leaves
  pitch: { t: number; p: V3; length: Sigma; line: Sigma; kmhIn: number; kmhOut: number; angleIn: number } | null;
  /** Sideways movement in the air before it pitched (metres, + is towards +x), against the straight line it set off on. */
  swing: Sigma;
  /** Change of direction off the pitch, degrees (+ is towards +x). Null without sightings after the bounce. */
  deviation: Sigma | null;
  stumps: { p: V3; x: Sigma; height: Sigma; hitting: "hitting" | "missing" | "close"; measured: boolean } | null;
  /** The sun, when the ball's shadow was used: how high it is and which way the shadows fall, and how well the shadows fit. */
  sun: { elevation: number; used: number; rmsPx: number; fall: [number, number] } | null;
  crease: { t: number; kmh: number } | null;
  seconds: number | null;            // hand to the batter's popping crease
  rmsPx: number;                     // how far the fitted flight sits from the sightings
  worstPx: number;
  used: number;                      // sightings in the fit
  afterBounce: number;               // of which after the bounce
  outliers: number[];                // indices of sightings the fit could not pass through
  samples: { t: number; p: V3 }[];   // the flight, every 4 ms from the hand to the batter's stumps (t from release)
  theta: number[]; t0: number; split: number;
}
export interface TrackProblem { reason: "few" | "fit"; text: string }
export const isTracked = (t: Tracked | TrackProblem | null | undefined): t is Tracked => !!t && "release" in t;

type State = [number, number, number, number, number, number];

function accel(vx: number, vy: number, vz: number, sw: number, out: number[]) {
  const v = Math.hypot(vx, vy, vz), h = Math.hypot(vx, vz) || 1, s = KS1 * sw * v * v;
  out[0] = -KD * v * vx + s * (-vz / h); out[1] = -G - KD * v * vy; out[2] = -KD * v * vz + s * (vx / h);
}
const A1 = [0, 0, 0], A2 = [0, 0, 0];
/** One midpoint step of free flight (dt may be negative: backwards in time). */
function step(s: State, dt: number, sw: number) {
  accel(s[3], s[4], s[5], sw, A1);
  const mx = s[3] + A1[0] * dt / 2, my = s[4] + A1[1] * dt / 2, mz = s[5] + A1[2] * dt / 2;
  accel(mx, my, mz, sw, A2);
  s[0] += mx * dt; s[1] += my * dt; s[2] += mz * dt;
  s[3] += A2[0] * dt; s[4] += A2[1] * dt; s[5] += A2[2] * dt;
}

interface Sim {
  at: V3[];                                               // the ball at each asked-for time
  bounce: { t: number; p: V3; vin: V3; vout: V3 } | null;
}
/**
 * Fly from the state at t0 through the given (ascending) times. theta = [x, y, z, vx, vy, vz, swing, wx, wy, wz]:
 * w is the velocity straight after the bounce. With `model` the bounce follows the usual-ball rule instead.
 */
function simulate(theta: number[], t0: number, times: number[], dt: number, model: boolean, tEnd = 0): Sim {
  const s: State = [theta[0], theta[1], theta[2], theta[3], theta[4], theta[5]];
  let sw = theta[6], t = t0, bounce: Sim["bounce"] = null;
  const at: V3[] = [];
  const advance = (target: number) => {
    while (t < target - 1e-9) {
      const h = Math.min(dt, target - t), py = s[1], px = s[0], pz = s[2], pvx = s[3], pvy = s[4], pvz = s[5];
      step(s, h, sw);
      if (!bounce && s[1] <= BALL_R && s[4] < 0 && py > BALL_R) {
        const u = (py - BALL_R) / (py - s[1]);
        const vin: V3 = [pvx + (s[3] - pvx) * u, pvy + (s[4] - pvy) * u, pvz + (s[5] - pvz) * u];
        const p: V3 = [px + (s[0] - px) * u, BALL_R, pz + (s[2] - pz) * u];
        const vout: V3 = model ? [vin[0] * KEEP.along, -vin[1] * KEEP.up, vin[2] * KEEP.along] : [theta[7], theta[8], theta[9]];
        bounce = { t: t + u * h, p, vin, vout };
        s[0] = p[0]; s[1] = p[1]; s[2] = p[2]; s[3] = vout[0]; s[4] = vout[1]; s[5] = vout[2];
        sw = 0;
        const rest = (1 - u) * h;
        if (rest > 1e-9) step(s, rest, 0);
        if (s[1] < BALL_R) s[1] = BALL_R;
      } else if (bounce && s[1] < BALL_R) { s[1] = BALL_R; if (s[4] < 0) s[4] = -s[4] * 0.4; }   // a second bounce: keep it on the ground
      t += h;
    }
  };
  for (const tt of times) { advance(tt); at.push([s[0], s[1], s[2]]); }
  if (tEnd > t) advance(tEnd);
  return { at, bounce };
}

interface Rel { t: number; p: V3; v: V3; zAnchor: number }
/**
 * Where the ball left the hand: back along the flight from the first sighting to the plane across the pitch at
 * releaseZ (the hand is over the front foot, give or take). zAnchor is where the flight has the ball at the moment
 * the analysis saw the release; the prior holds that near releaseZ, as tightly as the frame rate allows.
 */
function releaseOf(theta: number[], S: Setup): Rel {
  const { pri, t0 } = S;
  const s: State = [theta[0], theta[1], theta[2], theta[3], theta[4], theta[5]], sw = theta[6], h = 0.002;
  const ts: number[] = [t0], ps: V3[] = [[s[0], s[1], s[2]]], vs: V3[] = [[s[3], s[4], s[5]]];
  for (let i = 0; i < 300 && (i < 2 || s[2] < pri.releaseZ + 0.3 || t0 - i * h > pri.releaseT); i++) { step(s, -h, sw); ts.push(t0 - (i + 1) * h); ps.push([s[0], s[1], s[2]]); vs.push([s[3], s[4], s[5]]); }
  const n = ts.length;
  const mix = (k: number, u: number): Rel => {
    const a = Math.max(0, Math.min(n - 1, k)), b = Math.max(0, Math.min(n - 1, k + 1));
    const l = (x: V3, y: V3): V3 => [x[0] + (y[0] - x[0]) * u, x[1] + (y[1] - x[1]) * u, x[2] + (y[2] - x[2]) * u];
    const p = l(ps[a], ps[b]);
    return { t: ts[a] + (ts[b] - ts[a]) * u, p, v: l(vs[a], vs[b]), zAnchor: p[2] };
  };
  let cross: Rel | null = null;
  if (ps[0][2] > pri.releaseZ) {
    // the first sighting is still short of the release plane (the ball was caught in or just out of the hand): go on
    const f: State = [theta[0], theta[1], theta[2], theta[3], theta[4], theta[5]];
    for (let i = 0; i < 400 && !cross; i++) {
      const pz = f[2], p0: V3 = [f[0], f[1], f[2]], v0: V3 = [f[3], f[4], f[5]];
      step(f, h, sw);
      if (f[2] <= pri.releaseZ) {
        const u = (pz - pri.releaseZ) / (pz - f[2] || 1);
        const p: V3 = [p0[0] + (f[0] - p0[0]) * u, p0[1] + (f[1] - p0[1]) * u, pri.releaseZ];
        cross = { t: t0 + (i + u) * h, p, v: [v0[0] + (f[3] - v0[0]) * u, v0[1] + (f[4] - v0[1]) * u, v0[2] + (f[5] - v0[2]) * u], zAnchor: p[2] };
      }
      if (f[5] >= 0) break;
    }
  } else for (let i = 0; i + 1 < n; i++) if ((ps[i][2] - pri.releaseZ) * (ps[i + 1][2] - pri.releaseZ) <= 0) { cross = mix(i, (ps[i][2] - pri.releaseZ) / (ps[i][2] - ps[i + 1][2] || 1)); break; }
  if (!cross) cross = mix(n - 1, 0);
  const tRel = Math.min(pri.releaseT, t0), kf = Math.max(0, Math.min(n - 1.001, (t0 - tRel) / h)), ki = Math.floor(kf);
  cross.zAnchor = ps[ki][2] + (ps[ki + 1][2] - ps[ki][2]) * (kf - ki);
  return cross;
}

const KMH = 3.6;
const STEPS = [1e-4, 1e-4, 1e-4, 1e-3, 1e-3, 1e-3, 1e-4, 1e-3, 1e-3, 1e-3, 1e-4, 1e-4];
const SHADOW_SIGMA = 2.5;

interface Setup { cam: Camera; obs: BallObs[]; pri: TrackPriors; t0: number; times: number[]; free: boolean; zSig: number; hSig: number; sun: boolean }

function residuals(th: number[], S: Setup, dt: number): number[] {
  const sim = simulate(th, S.t0, S.times, dt, !S.free), out: number[] = [];
  for (let i = 0; i < S.obs.length; i++) {
    const p = project(S.cam, sim.at[i]), sg = S.obs[i].sigma ?? 1.5;
    if (!p) { out.push(1e3, 1e3); continue; }
    out.push((p[0] - S.obs[i].px[0]) / sg, (p[1] - S.obs[i].px[1]) / sg);
  }
  if (S.sun) for (let i = 0; i < S.obs.length; i++) {
    const sh = S.obs[i].shadow;
    if (!sh) continue;
    const b = sim.at[i], q = project(S.cam, [b[0] + th[10] * b[1], 0, b[2] + th[11] * b[1]]);
    if (!q) { out.push(1e3, 1e3); continue; }
    out.push((q[0] - sh[0]) / SHADOW_SIGMA, (q[1] - sh[1]) / SHADOW_SIGMA);
  }
  if (S.sun && S.pri.shadowDir) {
    const d = S.pri.shadowDir, cross = th[10] * d[1] - th[11] * d[0], dot = th[10] * d[0] + th[11] * d[1];
    out.push(Math.atan2(cross, dot) / (((S.pri.shadowDirSigma ?? 6) * Math.PI) / 180));
  }
  const rel = releaseOf(th, S);
  out.push((rel.zAnchor - S.pri.releaseZ) / S.zSig);
  out.push(S.pri.releaseHeight != null ? (rel.p[1] - S.pri.releaseHeight) / S.hSig : 0);
  out.push(th[6] / 0.35);
  if (S.free && sim.bounce) {
    const b = sim.bounce;
    out.push((th[9] / (b.vin[2] || -1) - KEEP.along) / KEEP.alongSigma, (th[8] / (-b.vin[1] || 1) - KEEP.up) / KEEP.upSigma, (th[7] - b.vin[0] * KEEP.along) / 3);
    out.push(th[8] < 0.2 ? (0.2 - th[8]) * 20 : 0);   // it comes up off the pitch
  } else out.push(0, 0, 0, 0);
  return out;
}

/** The figures a fitted flight gives (used for the answer and, nudged, for the error bars). */
function figures(th: number[], S: Setup): number[] & { sim?: Sim } {
  const tl = S.times[S.times.length - 1];
  const sim = simulate(th, S.t0, [], 0.001, !S.free, tl);
  const back = { cross: releaseOf(th, S) }, v = back.cross.v;
  const kmh = Math.hypot(v[0], v[1], v[2]) * KMH;
  const b = sim.bounce;
  let length = NaN, line = NaN, swing = NaN, dev = NaN, sx = NaN, sy = NaN;
  if (b) {
    length = b.p[2] - STUMPS_Z; line = b.p[0];
    const tb = b.t - back.cross.t, straight = back.cross.p[0] + (v[0] / (v[2] || -1)) * (b.p[2] - back.cross.p[2]);
    swing = b.p[0] - straight; void tb;
    dev = ((Math.atan2(b.vout[0], -b.vout[2]) - Math.atan2(b.vin[0], -b.vin[2])) * 180) / Math.PI;
  }
  const st = stumpsCross(th, S);
  if (st) { sx = st.p[0]; sy = st.p[1]; }
  return [kmh, length, line, swing, dev, sx, sy];
}

function stumpsCross(th: number[], S: Setup): { t: number; p: V3; crease: { t: number; v: number } | null } | null {
  // fly on (with the same rules) until the line of the batter's stumps
  const s: State = [th[0], th[1], th[2], th[3], th[4], th[5]];
  let sw = th[6], t = S.t0, bounced = false, crease: { t: number; v: number } | null = null;
  for (let i = 0; i < 3000; i++) {
    const pz = s[2], py = s[1], p0 = [s[0], s[1], s[2]], pv: V3 = [s[3], s[4], s[5]];
    step(s, 0.001, sw); t += 0.001;
    if (!bounced && s[1] <= BALL_R && s[4] < 0 && py > BALL_R) {
      const u = (py - BALL_R) / (py - s[1]);
      const vin: V3 = [pv[0] + (s[3] - pv[0]) * u, pv[1] + (s[4] - pv[1]) * u, pv[2] + (s[5] - pv[2]) * u];
      s[0] = p0[0] + (s[0] - p0[0]) * u; s[2] = p0[2] + (s[2] - p0[2]) * u; s[1] = BALL_R;
      const w: V3 = S.free ? [th[7], th[8], th[9]] : [vin[0] * KEEP.along, -vin[1] * KEEP.up, vin[2] * KEEP.along];
      s[3] = w[0]; s[4] = w[1]; s[5] = w[2]; sw = 0; bounced = true; t += (u - 1) * 0.001;
      continue;
    } else if (bounced && s[1] < BALL_R) { s[1] = BALL_R; if (s[4] < 0) s[4] = -s[4] * 0.4; }
    if (!crease && pz > CREASE_Z && s[2] <= CREASE_Z) crease = { t: t - 0.001 * (1 - (pz - CREASE_Z) / (pz - s[2] || 1)), v: Math.hypot(s[3], s[4], s[5]) };
    if (pz > STUMPS_Z && s[2] <= STUMPS_Z) {
      const u = (pz - STUMPS_Z) / (pz - s[2] || 1);
      return { t: t - 0.001 * (1 - u), p: [p0[0] + (s[0] - p0[0]) * u, p0[1] + (s[1] - p0[1]) * u, STUMPS_Z], crease };
    }
    if (s[5] >= 0) return null;
  }
  return null;
}

function initial(S: Setup, split: number): number[] | null {
  const { cam, obs, pri } = S, n = obs.length, t0 = S.t0;
  const tRel = Math.min(pri.releaseT, t0 - 0.25 / pri.fps);
  let zb: number, xb: number, tb: number;
  if (split < n - 1) {
    // the bounce is between sightings `split` and `split + 1`: where the path in and the path out meet
    const a = obs[Math.max(0, split - 1)], b = obs[split], c = obs[split + 1], d = obs[Math.min(n - 1, split + 2)];
    let bp: Pt = [(b.px[0] + c.px[0]) / 2, (b.px[1] + c.px[1]) / 2], frac = 0.5;
    if (split >= 1 && split + 2 <= n - 1) {
      const d1 = [b.px[0] - a.px[0], b.px[1] - a.px[1]], d2 = [d.px[0] - c.px[0], d.px[1] - c.px[1]];
      const den = d1[0] * d2[1] - d1[1] * d2[0];
      if (Math.abs(den) > 1e-6) {
        const u = ((c.px[0] - b.px[0]) * d2[1] - (c.px[1] - b.px[1]) * d2[0]) / den;   // from b along d1
        const step1 = (b.t - a.t) || 1 / pri.fps;
        const f = (u * step1) / ((c.t - b.t) || 1 / pri.fps);
        if (f > -0.2 && f < 1.2) { frac = Math.max(0.02, Math.min(0.98, f)); bp = [b.px[0] + d1[0] * u, b.px[1] + d1[1] * u]; }
      }
    }
    const g = onPlaneY(cam, bp, BALL_R);
    if (!g) return null;
    xb = g[0]; zb = g[2]; tb = b.t + frac * (c.t - b.t);
  } else {
    // no bounce seen: assume it would pitch a little after the last sighting
    const g = onPlaneY(cam, obs[n - 1].px, BALL_R + 0.3);
    if (!g) return null;
    xb = g[0]; zb = Math.min(g[2], pri.releaseZ - 6); tb = obs[n - 1].t + 1.5 / pri.fps;
  }
  if (!(tb > tRel + 0.05) || !(zb < pri.releaseZ - 1)) return null;
  const z0 = pri.releaseZ + (zb - pri.releaseZ) * Math.max(0.01, Math.min(0.9, (t0 - tRel) / (tb - tRel)));
  const p0 = onPlaneZ(cam, obs[0].px, z0);
  if (!p0) return null;
  const dT = tb - t0;
  const vz = ((zb - z0) / dT) * 1.03, vx = (xb - p0[0]) / dT, vy = (BALL_R - p0[1] + 0.5 * G * dT * dT) / dT;
  let wz = vz * 0.82, wx = vx * 0.85, wy = Math.max(0.5, -(vy - G * dT) * KEEP.up);
  if (split < n - 2) {
    const l = obs[n - 1], dl = l.t - tb, zl = zb + wz * dl, pl = onPlaneZ(cam, l.px, zl);
    if (pl && dl > 0) { wx = (pl[0] - xb) / dl; wy = Math.max(0.3, (Math.max(BALL_R, pl[1]) - BALL_R + 0.5 * G * dl * dl) / dl); }
  }
  return [p0[0], p0[1], z0, vx, vy, vz, 0, wx, wy, wz];
}

interface Solved { th: number[]; cost: number; split: number; S: Setup; obs: BallObs[]; outliers: number[] }
/** The search itself: every place the bounce could be, outliers dropped, the best fit polished. */
function solveFlight(cam: Camera, sightings: BallObs[], pri: TrackPriors, quick = false): Solved | null {
  const order = sightings.map((o, i) => ({ o, i })).sort((a, b) => a.o.t - b.o.t);
  let obs = order.map((x) => x.o);
  const index = order.map((x) => x.i);
  const outliers: number[] = [];
  let best: { th: number[]; cost: number; split: number; S: Setup } | null = null;
  for (let round = 0; round < 3; round++) {
    best = null;
    const t0 = obs[0].t, n = obs.length, speedGuess = 35;
    const base = { cam, obs, pri, t0, times: obs.map((o) => o.t), zSig: Math.hypot(pri.releaseZSigma ?? 0.35, (speedGuess * (pri.releaseTSigma ?? 0.4)) / pri.fps), hSig: pri.releaseHeightSigma ?? 0.12 };
    // a quick look at every place the bounce could be, then the two most promising in earnest
    const rough: { split: number; S: Setup; x: number[]; cost: number }[] = [];
    for (const split of splits(obs)) {
      const S: Setup = { ...base, free: n - 1 - split >= 2, sun: false };
      const th0 = initial(S, split);
      if (!th0) continue;
      const q = lmOn((x) => residuals(x, S, 0.006), [...th0, 0, 0], S, 10);
      rough.push({ split, S, x: q.x, cost: q.cost });
    }
    rough.sort((a, b) => a.cost - b.cost);
    // nowhere near a flight after a quick look: not worth polishing (cost is in sigmas; this is ~10 px a sighting)
    if (quick && rough.length && Math.sqrt(rough[0].cost / (2 * n)) > 7) return null;
    for (const { split, S, x } of rough.slice(0, n <= 24 ? rough.length : 4)) {
      const free = S.free;
      const fit = lmOn((x2) => residuals(x2, S, 0.005), x, S, 30);
      // where the fit put the bounce decides whether the flight after it was really seen (two sightings or more)
      const sim = simulate(fit.x, t0, [], 0.002, !free, obs[n - 1].t + 0.2);
      const tb = sim.bounce?.t ?? Infinity, after = obs.filter((o) => o.t > tb).length;
      if (!(fit.x[5] < -3) || (free && after < 2)) continue;
      if (!best || fit.cost < best.cost) best = { th: fit.x, cost: fit.cost, split, S };
    }
    if (!best) break;
    // polish at a fine step, then look for sightings the flight cannot pass through
    const fine = lmOn((x) => residuals(x, best!.S, 0.001), best.th, best.S, 20);
    best.th = fine.x; best.cost = fine.cost;
    const r = fine.residuals;
    let worst = -1, worstV = 0;
    for (let i = 0; i < obs.length; i++) { const e = Math.hypot(r[2 * i], r[2 * i + 1]); if (e > worstV) { worstV = e; worst = i; } }
    const rest = Math.sqrt((r.slice(0, 2 * obs.length).reduce((s, v) => s + v * v, 0) - worstV * worstV) / Math.max(1, 2 * obs.length - 2));
    if (worst >= 0 && worstV > 6 && worstV > 5 * rest && obs.length > 5 && round < 2) {
      outliers.push(index[worst]);
      obs = obs.filter((_, i) => i !== worst); index.splice(worst, 1);
      continue;
    }
    break;
  }
  return best ? { ...best, obs, outliers } : null;
}

/** The few figures needed to judge whether a fit is a delivery at all (cheap: no error bars). */
function glance(sol: Solved): { kmh: number; rel: V3; pitch: V3 | null; lastZ: number; firstZ: number; rmsPx: number; used: number; up: number | null; after: number } {
  const { th, S, obs } = sol, rel = releaseOf(th, S), tl = obs[obs.length - 1].t;
  const sim = simulate(th, S.t0, [tl], 0.002, !S.free), r = residuals(th, S, 0.002);
  let ss = 0;
  for (let i = 0; i < obs.length; i++) { const sg = obs[i].sigma ?? 1.5; ss += (r[2 * i] ** 2 + r[2 * i + 1] ** 2) * sg * sg; }
  return { kmh: Math.hypot(rel.v[0], rel.v[1], rel.v[2]) * KMH, rel: rel.p, pitch: sim.bounce?.p ?? null, up: sim.bounce && S.free ? sim.bounce.vout[1] / Math.max(0.1, -sim.bounce.vin[1]) : null, after: sim.bounce ? obs.filter((o) => o.t > sim.bounce!.t).length : 0,
    lastZ: sim.at[0][2], firstZ: th[2], rmsPx: Math.sqrt(ss / obs.length), used: obs.length };
}

/**
 * Fit the flight to the sightings. Needs at least four of them, three before the ball pitches. Tries the places the
 * bounce could be (and a flight with no bounce in view) and keeps the one that fits best; then, when the ball's
 * shadow was seen too, fits the flight and the sun together.
 */
export function fitBall(cam: Camera, sightings: BallObs[], pri: TrackPriors): Tracked | TrackProblem {
  if (sightings.length < 4) return { reason: "few", text: "Mark the ball in at least four frames, three of them before it pitches." };
  const best = solveFlight(cam, sightings, pri);
  if (!best) return { reason: "fit", text: "Those points do not make a ball's flight. Check the marks, and that the ball is marked before and after it pitches." };
  const { obs, outliers } = best;
  const plain = describe(best.th, best.S, best.split, outliers);
  // the shadow, when there is one: start the sun where the first fit and the shadows put it, then fit both together
  const sh = obs.map((o, i) => ({ o, i })).filter((x) => x.o.shadow);
  if (sh.length >= 3) {
    const sim = simulate(best.th, best.S.t0, best.S.times, 0.001, !best.S.free);
    const fx: number[] = [], fz: number[] = [];
    for (const { o, i } of sh) {
      const g = onPlaneY(cam, o.shadow!, 0), b = sim.at[i];
      if (g && b[1] > 0.15) { fx.push((g[0] - b[0]) / b[1]); fz.push((g[2] - b[2]) / b[1]); }
    }
    if (fx.length >= 3) {
      const med = (v: number[]) => v.slice().sort((a, b) => a - b)[v.length >> 1];
      const S: Setup = { ...best.S, sun: true }, th0 = best.th.slice(); th0[10] = med(fx); th0[11] = med(fz);
      const fit = lmOn((x) => residuals(x, S, 0.002), th0, S, 50);
      const fine = lmOn((x) => residuals(x, S, 0.001), fit.x, S, 20);
      const withSun = describe(fine.x, S, best.split, outliers);
      if (withSun.sun && withSun.sun.rmsPx < 6 && withSun.rmsPx < Math.max(3, 2 * plain.rmsPx)) return withSun;
    }
  }
  return plain;
}

const active = (S: Setup) => [0, 1, 2, 3, 4, 5, 6, ...(S.free ? [7, 8, 9] : []), ...(S.sun ? [10, 11] : [])];
/** Least squares over the unknowns this setup really has (the rest of theta stays as given). */
function lmOn(f: (x: number[]) => number[], th: number[], S: Setup, iters: number) {
  const act = active(S), full = (x: number[]) => { const o = th.slice(); act.forEach((a, k) => { o[a] = x[k]; }); return o; };
  const fit = levenbergMarquardt((x) => f(full(x)), act.map((a) => th[a]), act.map((a) => STEPS[a]), iters);
  return { ...fit, x: full(fit.x) };
}

/** How badly a smooth curve (a parabola in time, for x and for y) fits sightings a..b: the sum of squared misses. */
function smoothMiss(obs: BallObs[], a: number, b: number): number {
  const m = b - a + 1;
  if (m <= 2) return 0;
  const deg = m >= 4 ? 2 : 1, t0 = obs[a].t, span = obs[b].t - t0 || 1;
  let total = 0;
  for (const c of [0, 1]) {
    // normal equations for a polynomial in u = (t - t0) / span
    const k = deg + 1, A = Array.from({ length: k }, () => new Array<number>(k).fill(0)), y = new Array<number>(k).fill(0);
    for (let i = a; i <= b; i++) {
      const u = (obs[i].t - t0) / span, pw = [1, u, u * u];
      for (let p = 0; p < k; p++) { y[p] += pw[p] * obs[i].px[c]; for (let q = 0; q < k; q++) A[p][q] += pw[p] * pw[q]; }
    }
    const co = solve(A, y);
    if (!co) continue;
    for (let i = a; i <= b; i++) { const u = (obs[i].t - t0) / span; const e = co[0] + co[1] * u + (deg === 2 ? co[2] * u * u : 0) - obs[i].px[c]; total += e * e; }
  }
  return total;
}
/** How far (pixels, root mean square) sightings sit from the smoothest path with at most one kink in it. */
function kinkedRms(obs: BallObs[]): number {
  const n = obs.length;
  let best = smoothMiss(obs, 0, n - 1);
  for (let s = 1; s <= n - 3; s++) best = Math.min(best, smoothMiss(obs, 0, s) + smoothMiss(obs, s + 1, n - 1));
  return Math.sqrt(best / (2 * n));
}
/**
 * Where the bounce could be: the breaks that leave the path smoothest on both sides (the three best), and "after
 * the last sighting". A value s means the ball pitched between sightings s and s + 1.
 */
function splits(obs: BallObs[]): number[] {
  const n = obs.length, cost: { s: number; e: number }[] = [];
  for (let s = 2; s <= n - 3; s++) cost.push({ s, e: smoothMiss(obs, 0, s) + smoothMiss(obs, s + 1, n - 1) });
  cost.sort((a, b) => a.e - b.e);
  const out = new Set<number>([n - 1, n - 2]);
  for (const c of cost) {
    if (out.size >= 7) break;
    out.add(c.s); if (c.s - 1 >= 2) out.add(c.s - 1); if (c.s + 1 <= n - 1) out.add(c.s + 1);
  }
  return [...out].filter((v) => v >= 2 && v <= n - 1).sort((a, b) => a - b);
}

function describe(th: number[], S: Setup, split: number, outliers: number[]): Tracked {
  const { obs } = S, n = obs.length;
  const fin = (x: number[]) => residuals(x, S, 0.001);
  const r = fin(th);
  let ss = 0, worst = 0;
  for (let i = 0; i < n; i++) { const sg = obs[i].sigma ?? 1.5, e = Math.hypot(r[2 * i], r[2 * i + 1]) * sg; ss += e * e; worst = Math.max(worst, e); }
  // covariance: (J'J)^-1, scaled up when the flight fits the sightings worse than their stated sigma
  const act = active(S), np = act.length, steps = act.map((a) => STEPS[a]);
  const full = (x: number[]) => { const f = th.slice(); act.forEach((a, k) => { f[a] = x[k]; }); return f; };
  const J = jacobian((x) => fin(full(x)), act.map((a) => th[a]), r, steps);
  const N = Array.from({ length: np }, (_, a) => Array.from({ length: np }, (_, b) => J.reduce((s, row) => s + row[a] * row[b], 0)));
  const cov = invert(N);
  const nSh = S.sun ? obs.filter((o) => o.shadow).length : 0;
  const dof = Math.max(1, 2 * n + 2 * nSh + 3 + (S.free ? 3 : 0) + (S.sun && S.pri.shadowDir ? 1 : 0) - np), scale = Math.max(1, r.reduce((s, v) => s + v * v, 0) / dof);
  const f0 = figures(th, S);
  const sig = f0.map(() => NaN);
  if (cov) {
    const grads = f0.map(() => new Array<number>(np).fill(0));
    for (let j = 0; j < np; j++) {
      const h = steps[j] * 20, a = th.slice(), b = th.slice();
      a[act[j]] += h; b[act[j]] -= h;
      const fa = figures(a, S), fb = figures(b, S);
      for (let k = 0; k < f0.length; k++) grads[k][j] = (fa[k] - fb[k]) / (2 * h);
    }
    for (let k = 0; k < f0.length; k++) {
      let v = 0;
      for (let a = 0; a < np; a++) for (let b = 0; b < np; b++) v += grads[k][a] * cov[a][b] * grads[k][b];
      sig[k] = Math.sqrt(Math.max(0, v * scale));
    }
  }
  const back = { cross: releaseOf(th, S) }, v = back.cross.v;
  const tl = obs[n - 1].t;
  const sim = simulate(th, S.t0, [], 0.001, !S.free, tl + 0.3), b = sim.bounce;
  const st = stumpsCross(th, S);
  const after = b ? obs.filter((o) => o.t > b.t).length : 0;
  // drag is known to a few percent of itself: about 1.5% of the release speed (docs/ACCURACY.md)
  const kmhSigma = Math.hypot(sig[0], 0.015 * f0[0]);
  const samples: { t: number; p: V3 }[] = [];
  {
    const tEnd = st?.t ?? tl + 0.2, times: number[] = [];
    for (let t = Math.max(S.t0, back.cross.t); t < tEnd; t += 0.004) times.push(t);
    if (!times.length) times.push(Math.max(S.t0, back.cross.t));
    times.push(tEnd);
    // before the first sighting: back along the flight to the hand
    const pre: { t: number; p: V3 }[] = [];
    if (back.cross.t < S.t0) {
      const s: State = [th[0], th[1], th[2], th[3], th[4], th[5]];
      for (let t = S.t0; t > back.cross.t + 1e-9; ) { const h = Math.min(0.004, t - back.cross.t); step(s, -h, th[6]); t -= h; pre.push({ t: t - back.cross.t, p: [s[0], s[1], s[2]] }); }
      pre.reverse();
    }
    const fwd = simulate(th, S.t0, times, 0.001, !S.free);
    samples.push(...pre, ...times.map((t, i) => ({ t: t - back.cross.t, p: fwd.at[i] })));
  }
  let sun: Tracked["sun"] = null;
  if (S.sun) {
    let q = 0;
    for (let k = 0; k < nSh; k++) q += (r[2 * n + 2 * k] ** 2 + r[2 * n + 2 * k + 1] ** 2) * SHADOW_SIGMA * SHADOW_SIGMA;
    sun = { elevation: (Math.atan2(1, Math.hypot(th[10], th[11])) * 180) / Math.PI, used: nSh, rmsPx: Math.sqrt(q / Math.max(1, nSh)), fall: [th[10], th[11]] };
  }
  const half = STUMPS_W / 2 + BALL_R;
  let hitting: "hitting" | "missing" | "close" = "missing";
  if (st) {
    const dx = Math.max(0, Math.abs(st.p[0]) - half), dy = Math.max(0, st.p[1] - (STUMP_H + BALL_R));
    const sx = Number.isFinite(sig[5]) ? sig[5] : 0.05, sy = Number.isFinite(sig[6]) ? sig[6] : 0.1;
    const inside = dx === 0 && dy === 0;
    const margin = inside ? Math.min((half - Math.abs(st.p[0])) / sx, (STUMP_H + BALL_R - st.p[1]) / sy) : Math.max(dx / sx, dy / sy);
    hitting = margin < 1 ? "close" : inside ? "hitting" : "missing";
  }
  return {
    release: { t: back.cross.t, p: back.cross.p, kmh: { value: f0[0], sigma: kmhSigma }, down: (Math.atan2(-v[1], Math.hypot(v[0], v[2])) * 180) / Math.PI },
    pitch: b ? {
      t: b.t - back.cross.t, p: [b.p[0], 0, b.p[2]], length: { value: f0[1], sigma: sig[1] }, line: { value: f0[2], sigma: sig[2] },
      kmhIn: Math.hypot(...b.vin) * KMH, kmhOut: Math.hypot(...b.vout) * KMH, angleIn: (Math.atan2(-b.vin[1], Math.hypot(b.vin[0], b.vin[2])) * 180) / Math.PI,
    } : null,
    swing: { value: b ? f0[3] : 0, sigma: sig[3] },
    deviation: b && S.free ? { value: f0[4], sigma: sig[4] } : null,
    stumps: st ? { p: st.p, x: { value: st.p[0], sigma: sig[5] }, height: { value: st.p[1], sigma: sig[6] }, hitting, measured: S.free || !b } : null,
    crease: st?.crease ? { t: st.crease.t - back.cross.t, kmh: st.crease.v * KMH } : null,
    seconds: st?.crease ? st.crease.t - back.cross.t : null,
    sun, rmsPx: Math.sqrt(ss / n), worstPx: worst, used: n, afterBounce: after, outliers,
    samples, theta: th, t0: S.t0, split,
  };
}

/** Where a tracked ball is at a time after release. */
export function trackedAt(tr: Tracked, t: number, out: V3 = [0, 0, 0]): V3 {
  const s = tr.samples, n = s.length;
  let lo = 0, hi = n - 1;
  if (t <= s[0].t) { out[0] = s[0].p[0]; out[1] = s[0].p[1]; out[2] = s[0].p[2]; return out; }
  if (t >= s[hi].t) { out[0] = s[hi].p[0]; out[1] = s[hi].p[1]; out[2] = s[hi].p[2]; return out; }
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (s[m].t <= t) lo = m; else hi = m; }
  const a = s[lo], b = s[hi], u = (t - a.t) / (b.t - a.t || 1);
  out[0] = a.p[0] + (b.p[0] - a.p[0]) * u; out[1] = a.p[1] + (b.p[1] - a.p[1]) * u; out[2] = a.p[2] + (b.p[2] - a.p[2]) * u;
  return out;
}

/** Where the fitted flight puts the ball in the picture at each sighting's time (to draw it over the video). */
export function reproject(cam: Camera, tr: Tracked, times: number[]): (Pt | null)[] {
  return times.map((t) => { const p = trackedAt(tr, t - tr.release.t); return t < tr.release.t - 1e-6 ? null : project(cam, p); });
}

/**
 * Add the camera's own doubt to the error bars: re-fit the flight with cameras whose pitch marks were nudged, and
 * combine the spread of the answers with the fit's own sigmas.
 */
export function withCameraDoubt(tr: Tracked, alternatives: (Tracked | TrackProblem)[]): Tracked {
  const ok = alternatives.filter(isTracked);
  if (ok.length < 4) return tr;
  const sd = (get: (t: Tracked) => number | null | undefined) => {
    const base = get(tr); if (base == null) return 0;
    const d = ok.map(get).filter((v): v is number => v != null && Number.isFinite(v)).map((v) => v - base);
    return d.length ? Math.sqrt(d.reduce((s, v) => s + v * v, 0) / d.length) : 0;
  };
  const add = (s: Sigma, extra: number): Sigma => ({ value: s.value, sigma: Math.hypot(Number.isFinite(s.sigma) ? s.sigma : 0, extra) });
  const out: Tracked = { ...tr, release: { ...tr.release, kmh: add(tr.release.kmh, sd((t) => t.release.kmh.value)) }, swing: add(tr.swing, sd((t) => t.swing.value)) };
  if (tr.pitch) out.pitch = { ...tr.pitch, length: add(tr.pitch.length, sd((t) => t.pitch?.length.value)), line: add(tr.pitch.line, sd((t) => t.pitch?.line.value)) };
  if (tr.deviation) out.deviation = add(tr.deviation, sd((t) => t.deviation?.value));
  if (tr.stumps) out.stumps = { ...tr.stumps, x: add(tr.stumps.x, sd((t) => t.stumps?.x.value)), height: add(tr.stumps.height, sd((t) => t.stumps?.height.value)) };
  return out;
}

/**
 * The ball after the bounce, when a chain carried on along its shadow instead. The flight up to the bounce is trusted;
 * after it, the ball leaves the pitch at some angle and the candidates in the following frames are searched for the
 * run that one such departure passes through (the speed it keeps along the ground taken as usual, to place it).
 * Returns the candidates on the best departure (three or more), or null.
 */
function afterBounce<T extends { t: number; px: Pt }>(sol: Solved, pool: T[], frame: number, avoid: T[], tol: number): T[] | null {
  const { th, S } = sol, last = S.times[S.times.length - 1];
  const b = simulate(th, S.t0, [], 0.002, !S.free, last + 0.3).bounce;
  if (!b) return null;
  const later = pool.filter((c) => c.t > b.t + 0.2 * frame && c.t < b.t + 16 * frame
    && !avoid.some((a) => Math.abs(a.t - c.t) < 0.3 * frame && Math.hypot(a.px[0] - c.px[0], a.px[1] - c.px[1]) < tol));
  const vdown = Math.max(0.5, -b.vin[1]);
  let best: T[] | null = null, bestErr = Infinity;
  // the speed it keeps along the ground is not known yet: try the range cricket balls keep
  for (const keep of [0.72, 0.8, 0.87, 0.93, 0.98]) {
    const wz = b.vin[2] * keep;
    // where a ball that left the bounce with (wx, wy, wz) is at time t (drag is small over these few frames)
    const at = (wx: number, wy: number, t: number): V3 => { const d = t - b.t; return [b.p[0] + wx * d, Math.max(BALL_R, BALL_R + wy * d - 0.5 * G * d * d), b.p[2] + wz * (1 - 0.12 * d) * d]; };
    for (const c of later) {
      if (c.t > b.t + 6 * frame || c.t < b.t + 0.8 * frame) continue;   // the departure is read off a candidate soon after the bounce
      const d = c.t - b.t, z = b.p[2] + wz * (1 - 0.12 * d) * d, P = onPlaneZ(S.cam, c.px, z);
      if (!P) continue;
      const wx = (P[0] - b.p[0]) / d, wy = (P[1] - BALL_R + 0.5 * G * d * d) / d, up = wy / vdown;
      if (!(up > 0.25 && up < 1.0) || Math.abs(wx) > 6) continue;
      const byTime = new Map<number, { o: T; e: number }>();
      for (const o of later) {
        const q = project(S.cam, at(wx, wy, o.t));
        if (!q) continue;
        const e = Math.hypot(q[0] - o.px[0], q[1] - o.px[1]);
        if (e > tol) continue;
        const k = Math.round(o.t / frame * 4), had = byTime.get(k);
        if (!had || e < had.e) byTime.set(k, { o, e });
      }
      const got = [...byTime.values()], err = got.reduce((a, v) => a + v.e, 0) / Math.max(1, got.length);
      if (got.length >= 3 && (!best || got.length > best.length || (got.length === best.length && err < bestErr))) { best = got.map((v) => v.o); bestErr = err; }
    }
  }
  return best ? best.sort((p, q) => p.t - q.t) : null;
}

/** Where a fitted flight puts the ball in the picture at any time (before the first sighting too). */
function predictPx(sol: Solved, t: number): Pt | null {
  const { th, S } = sol;
  if (t >= S.t0) return project(S.cam, simulate(th, S.t0, [t], 0.002, !S.free).at[0]);
  const s: State = [th[0], th[1], th[2], th[3], th[4], th[5]];
  for (let u = S.t0; u > t + 1e-9; ) { const h = Math.min(0.002, u - t); step(s, -h, th[6]); u -= h; }
  return project(S.cam, [s[0], s[1], s[2]]);
}

/** A believable delivery: bowled at a human speed from a human height, from the crease, heading down the pitch. */
function believable(g: ReturnType<typeof glance>, pri: TrackPriors): boolean {
  const h = g.rel[1];
  // let go between the return creases (1.32 m either side, and a little for a wide angle), at a bowler's height
  if (!(g.kmh > 40 && g.kmh < 170) || !(h > 1.2 && h < 3.0) || Math.abs(g.rel[0]) > 1.6 || Math.abs(g.rel[2] - pri.releaseZ) > 0.01) return false;
  if (g.pitch && (Math.abs(g.pitch[0]) > 2.2 || g.pitch[2] - STUMPS_Z < -0.5 || g.pitch[2] - STUMPS_Z > 19)) return false;
  // A ball comes up off the pitch: a cricket ball keeps a third to four fifths of its downward speed. A path that
  // stays on the ground after the kink is the ball's shadow carrying on (it meets the ball where it pitches).
  if (g.up !== null && g.after >= 3 && g.up < 0.22) return false;
  // seen over a fair stretch of the pitch, starting in the bowler's half: a few frames of anything can be fitted
  return g.lastZ < -8 && g.firstZ > -9 && g.firstZ - g.lastZ > 5;
}

export interface PickOpts {
  sigma?: number;             // how well a found ball's centre is known, pixels (default 1.5)
  hand?: Pt | null;           // the bowling hand in the picture at release: the flight starts there
  handTol?: number;           // how near, pixels
  startOk?: (first: { frame: number; px: Pt }, second: { frame: number; px: Pt }) => boolean;   // may this flight begin where it does?
  onBody?: (s: { frame: number; px: Pt }) => boolean;   // is this sighting on the bowler's body? A flight that mostly is, is a limb
  crossPx?: number;           // how close two chains must come to count as crossing (default 18)
  /** Take the release from each chain itself (a frame before its first sighting, give or take a frame and a half)
   * rather than from the bowling analysis: for when the analysis has the release frame wrong. */
  fromChain?: boolean;
  /** Every candidate in every frame (same pixels and clock as the chains): lets a flight that turned out to follow
   * the shadow after the bounce look again for the ball there. */
  pool?: { t: number; px: Pt }[];
  budgetMs?: number;          // (no longer used: a limit in time made the answer depend on how fast, or how busy, the device was)
  maxRuns?: number;           // stop after trying this many stretches of chain as flights (default 60: a real flight is found in the first ten) and keep the best so far
  debug?: (line: string) => void;
}
/**
 * Which chain of candidates is the ball: the one that makes the best cricket delivery. Chains that cross are also
 * tried swapped over (the ball and its shadow meet where it pitches, and each carries on more smoothly along the
 * other's path). Sightings past the bat are trimmed off when the flight fits far better without them.
 */
export function pickBall<T extends { t: number; px: Pt; weight?: number }>(cam: Camera, chains: T[][], pri0: TrackPriors, o: PickOpts = {}): { seen: T[]; tracked: Tracked; pri: TrackPriors } | null {
  let pri = pri0;
  const sigma = o.sigma ?? 1.5, frame = 1 / pri.fps;
  const all: T[][] = chains.map((c) => (o.fromChain ? c.slice() : c.filter((s) => s.t > pri.releaseT - 1.5 * frame)));
  const nA = all.length;
  for (let a = 0; a < nA; a++) for (let b = a + 1; b < nA; b++) {
    // the closest the two chains come at (nearly) the same time
    let bestD = Infinity, ia = -1, ib = -1;
    // (and the first and the last time they are that close: where a ball meets its shadow the two can stay together
    // for several frames, and a chain can wander off for a frame or two in the middle of them; joining only at the
    // very closest point then keeps the wandering in, and the flight is thrown out for it)
    let first: [number, number] | null = null, last: [number, number] | null = null;
    for (let i = 0; i < all[a].length; i++) for (let j = 0; j < all[b].length; j++) {
      if (Math.abs(all[a][i].t - all[b][j].t) > 1.5 * frame) continue;
      const d = Math.hypot(all[a][i].px[0] - all[b][j].px[0], all[a][i].px[1] - all[b][j].px[1]);
      if (d < bestD) { bestD = d; ia = i; ib = j; }
      if (d <= (o.crossPx ?? 18)) { if (!first) first = [i, j]; last = [i, j]; }
    }
    if (ia < 0 || bestD > (o.crossPx ?? 18)) continue;   // they never meet
    const join = (x: T[], ix: number, y: T[], iy: number) => {
      for (const cut of [0, 1]) {
        const head = x.slice(0, ix + cut), tEnd = head.length ? head[head.length - 1].t : -Infinity;
        const tail = y.slice(iy).filter((s) => s.t > tEnd + 0.5 * frame);
        if (head.length >= 2 && tail.length >= 2) all.push([...head, ...tail]);
      }
    };
    join(all[a], ia, all[b], ib); join(all[b], ib, all[a], ia);
    for (const q of [first, last]) if (q && (q[0] !== ia || q[1] !== ib)) { join(all[a], q[0], all[b], q[1]); join(all[b], q[1], all[a], q[0]); }
  }
  let best: { seen: T[]; score: number; pri: TrackPriors } | null = null;
  const seenKeys = new Set<string>();
  const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now()), began = now(), maxRuns = o.maxRuns ?? 60;
  let tried = 0;
  const tight = Math.max(2.5, 2 * sigma), near = Math.max(6, 4 * sigma), smooth = Math.max(3, 2 * sigma);
  // The parts of each chain that could be a ball: a ball's path across the picture is smooth, with one kink where it
  // pitches. From each starting point, the longest run that stays that smooth. (The ends of a chain are where it goes
  // wrong: the hand and arm at release, the bat, a cut to another camera.) The runs are then tried as flights, the
  // longest and most ball-like (standing out most from the background) first.
  const runs: { chain: T[]; lo: number; hi: number; rank: number }[] = [];
  for (const chain of all) {
    const n = chain.length;
    if (n < 7) continue;
    const key = chain.map((s) => `${s.t.toFixed(4)}:${s.px[0].toFixed(0)},${s.px[1].toFixed(0)}`).join("|");
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    const okTo = (lo: number, hi: number) => kinkedRms(chain.slice(lo, hi)) <= smooth;
    let reach = 0;
    for (let lo = 0; lo + 7 <= n; lo++) {
      if (!okTo(lo, lo + 7)) continue;
      let good = lo + 7, bad = n + 1;
      if (okTo(lo, n)) good = n;
      else { bad = n; while (bad - good > 1) { const mid = (good + bad) >> 1; if (okTo(lo, mid)) good = mid; else bad = mid; } }
      if (good > reach) {   // not inside a run already found
        let w = 0;
        for (let i = lo; i < good; i++) w += chain[i].weight ?? 1;
        runs.push({ chain, lo, hi: good, rank: w }); reach = good;
      }
    }
  }
  // When the hand at release is known, the stretches that begin there go first: within a third of a second of the
  // release, and no further from the hand than a ball could have got. A broadcast frame holds a thousand or two
  // stretches of something moving (fielders' legs, the umpire, the crowd), and tried longest-first a slow spinner's
  // ball came sixtieth; a fast bowler's, eleven frames long, never came at all.
  if (o.hand) {
    const tol = o.handTol ?? 60;
    for (const q of runs) {
      const f = q.chain[q.lo], tg = f.t - pri.releaseT;
      const d = Math.hypot(f.px[0] - o.hand[0], f.px[1] - o.hand[1]);
      if (tg >= -1.5 * frame && tg <= Math.max(0.12, 3.5 * frame) && d <= tol * (1 + 12 * Math.max(0, tg))) q.rank += 1e6 - 5 * d - 1e3 * Math.max(0, tg);
    }
    o.debug?.(`stretches that begin at the hand: ${runs.filter((q) => q.rank >= 5e5).length} of ${runs.length}`);
  }
  runs.sort((p, q) => q.rank - p.rank);
  for (const { chain, lo, hi } of runs) {
    const n = chain.length;
    if (tried >= maxRuns) break;
    if (best && hi - lo + 4 < best.score) continue;   // too short to beat the best so far, even grown a little
    tried++;
    {
      const core = chain.slice(lo, hi);
      if (o.fromChain) pri = { ...pri0, releaseT: core[0].t - frame, releaseTSigma: 1.5 };
      let sol = solveFlight(cam, core.map((s) => ({ t: s.t, px: s.px, sigma })), pri, true);
      if (!sol) { o.debug?.(`chain of ${n}, part ${lo}-${hi}: no fit`); continue; }
      let g = glance(sol), seen = core.filter((_, i) => !sol!.outliers.includes(i));
      if (g.rmsPx > tight) { o.debug?.(`chain of ${n}, part ${lo}-${hi}: rms ${g.rmsPx.toFixed(2)}`); continue; }
      const fits = (s: T) => { const q = predictPx(sol!, s.t); return !!q && Math.hypot(q[0] - s.px[0], q[1] - s.px[1]) < near; };
      const head: T[] = [], tail: T[] = [];
      // (only neighbours: a candidate many frames on that happens to sit on the line is not the ball)
      for (let i = lo - 1; i >= 0 && chain[i + 1].t - chain[i].t < 2.5 * frame && fits(chain[i]); i--) head.unshift(chain[i]);
      for (let i = hi; i < n && chain[i].t - chain[i - 1].t < 2.5 * frame && fits(chain[i]); i++) tail.push(chain[i]);
      if (head.length || tail.length) {
        const wider = [...head, ...seen, ...tail], sol2 = solveFlight(cam, wider.map((s) => ({ t: s.t, px: s.px, sigma })), pri);
        if (sol2) { const g2 = glance(sol2); if (g2.rmsPx <= Math.max(1.2, 1.5 * g.rmsPx)) { sol = sol2; g = g2; seen = wider.filter((_, i) => !sol2.outliers.includes(i)); } }
      }
      // one or two sightings may still be something else (the shadow in the frame the two part): drop the one the
      // flight misses by far more than the rest, and fit again
      for (let round = 0; round < 3 && seen.length > 7 && g.rmsPx > 0.8; round++) {
        const miss = seen.map((x) => { const q = predictPx(sol!, x.t); return q ? Math.hypot(q[0] - x.px[0], q[1] - x.px[1]) : 99; });
        const sorted = miss.slice().sort((p, q) => p - q), med = sorted[sorted.length >> 1], worst = miss.indexOf(sorted[sorted.length - 1]);
        if (miss[worst] < Math.max(2.5, 3 * med)) break;
        const fewer = seen.filter((_, i) => i !== worst), sol3 = solveFlight(cam, fewer.map((x) => ({ t: x.t, px: x.px, sigma })), pri);
        if (!sol3) break;
        const g3 = glance(sol3);
        if (g3.rmsPx >= g.rmsPx) break;
        sol = sol3; g = g3; seen = fewer.filter((_, i) => !sol3.outliers.includes(i));
      }
      // it follows its own shadow after the bounce (or stops at the bounce): look for the ball itself there
      if (o.pool && g.pitch && ((g.up !== null && g.up < 0.22) || g.after < 2)) {
        const tb = simulate(sol.th, sol.S.t0, [], 0.002, !sol.S.free, seen[seen.length - 1].t + 0.3).bounce?.t ?? Infinity;
        const pre = seen.filter((x) => x.t <= tb), post = pre.length >= 4 ? afterBounce(sol, o.pool as T[], frame, seen.filter((x) => x.t > tb), near) : null;
        o.debug?.(`  looking again after the bounce (t ${tb.toFixed(3)}): ${post ? post.length + " candidates on one departure" : "nothing"}`);
        if (post) {
          // fit the flight through both parts; while it does not sit tight, the candidate after the bounce that it
          // misses by most is not the ball: leave it out and fit again
          let both = [...pre, ...post];
          for (let round = 0; round < 8; round++) {
            const sol4 = solveFlight(cam, both.map((x) => ({ t: x.t, px: x.px, sigma })), pri);
            if (!sol4) { o.debug?.("  no flight through them"); break; }
            const g4 = glance(sol4);
            o.debug?.(`  with ${both.length - pre.length} of them: rms ${g4.rmsPx.toFixed(2)} up ${g4.up?.toFixed(2)}`);
            if (g4.rmsPx <= Math.max(1.6, sigma) && (g4.up ?? 0) >= 0.22 && g4.after >= 3) { sol = sol4; g = g4; seen = both.filter((_, i) => !sol4.outliers.includes(i)); break; }
            if (both.length - pre.length <= 3) break;
            let worst = -1, wv = 0;
            for (let i = pre.length; i < both.length; i++) { const q = predictPx(sol4, both[i].t); const e = q ? Math.hypot(q[0] - both[i].px[0], q[1] - both[i].px[1]) : 99; if (e > wv) { wv = e; worst = i; } }
            both = both.filter((_, i) => i !== worst);
          }
        }
      }
      // frames the chain skipped: any candidate sitting on the fitted flight there is the ball too
      if (o.pool && g.rmsPx <= Math.max(1.6, sigma)) {
        const have = new Set(seen.map((x) => Math.round(x.t / frame * 4))), lim = Math.max(3, 2.5 * g.rmsPx), add: T[] = [];
        const t0 = seen[0].t - 2.5 * frame, t1 = seen[seen.length - 1].t + 2.5 * frame, byT = new Map<number, { c: T; e: number }>();
        for (const c of o.pool as T[]) {
          const k = Math.round(c.t / frame * 4);
          if (c.t < t0 || c.t > t1 || have.has(k)) continue;
          const q = predictPx(sol, c.t), e = q ? Math.hypot(q[0] - c.px[0], q[1] - c.px[1]) : 99, had = byT.get(k);
          if (e < lim && (!had || e < had.e)) byT.set(k, { c, e });
        }
        for (const v of byT.values()) add.push(v.c);
        if (add.length) {
          const more = [...seen, ...add].sort((p, q) => p.t - q.t), sol5 = solveFlight(cam, more.map((x) => ({ t: x.t, px: x.px, sigma })), pri);
          if (sol5) { const g5 = glance(sol5); if (g5.rmsPx <= Math.max(1.2, 1.3 * g.rmsPx) && (g5.up === null || g5.up >= 0.22)) { sol = sol5; g = g5; seen = more.filter((_, i) => !sol5.outliers.includes(i)); } }
        }
      }
      // found on its own, a ball has to earn it: at least seven sightings, and the flight within a pixel and a half of them
      let ok = believable(g, pri) && seen.length >= 7 && g.rmsPx <= Math.max(1.6, sigma);
      let limb = 0;
      if (ok && o.onBody) { limb = (seen as unknown as { frame: number; px: Pt }[]).filter(o.onBody).length; ok = limb <= Math.max(2, 0.25 * seen.length); }
      if (ok && o.startOk && seen.length > 1) { const fs = seen as unknown as { frame: number; px: Pt }[]; ok = o.startOk(fs[0], fs[1]); if (!ok) o.debug?.("  does not start at the bowler"); }
      if (ok && o.hand) { const q = project(cam, g.rel); ok = !!q && Math.hypot(q[0] - o.hand[0], q[1] - o.hand[1]) < (o.handTol ?? 60); }
      o.debug?.(`chain of ${n} -> ${seen.length} (t ${seen[0].t.toFixed(3)}-${seen[seen.length - 1].t.toFixed(3)}): ${g.kmh.toFixed(0)} km/h from ${g.rel.map((v) => v.toFixed(2))} pitch ${g.pitch?.map((v) => v.toFixed(2))} lastZ ${g.lastZ.toFixed(1)} rms ${g.rmsPx.toFixed(2)} ok ${ok} miss ${seen.map((x) => { const q = predictPx(sol!, x.t); return q ? Math.hypot(q[0] - x.px[0], q[1] - x.px[1]).toFixed(1) : "-"; }).join(",")} up ${g.up?.toFixed(2)} after ${g.after} on body ${limb}`);
      // more sightings are better, but not ones the flight has to bend to reach (the ball off the bat, say)
      const score = g.used - 6 * Math.max(0, g.rmsPx - 1);
      if (ok && (!best || score > best.score)) best = { seen, score, pri };
    }
  }
  o.debug?.(`tried ${tried} of ${runs.length} stretches in ${Math.round(now() - began)} ms: ${best ? "a flight" : "nothing"}`);
  if (!best) return null;
  const tracked = fitBall(cam, best.seen.map((s) => ({ t: s.t, px: s.px, sigma })), best.pri);
  return isTracked(tracked) ? { seen: best.seen, tracked, pri: best.pri } : null;
}
