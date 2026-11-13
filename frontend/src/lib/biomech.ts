import type { AnalysisResult, EventKey, Metric } from "../types";

/**
 * Bio-mech replay: the delivery as a broadcast-style 3D sequence. The video dissolves into a bone skeleton on a pitch,
 * the action plays in slow motion and stops at back-foot contact, front-foot contact and release with the numbers
 * measured there, the bowling arm leaves a ribbon coloured by its speed, and the camera moves round the bowler.
 * Everything here is plain arithmetic on the analysis (no drawing), so the timeline can be tested and scrubbed.
 */

export type V3 = [number, number, number];

// H36M joints
export const J = { pelvis: 0, rHip: 1, rKnee: 2, rAnkle: 3, lHip: 4, lKnee: 5, lAnkle: 6, spine: 7, thorax: 8, nose: 9, head: 10,
  lShoulder: 11, lElbow: 12, lWrist: 13, rShoulder: 14, rElbow: 15, rWrist: 16 } as const;

export interface Sides { shoulder: number; elbow: number; wrist: number; backHip: number; backKnee: number; backAnkle: number;
  frontHip: number; frontKnee: number; frontAnkle: number; frontShoulder: number }
/** The bowling arm, and the legs by their role: the back leg is on the bowling-arm side. */
export function sides(right: boolean): Sides {
  return right
    ? { shoulder: J.rShoulder, elbow: J.rElbow, wrist: J.rWrist, backHip: J.rHip, backKnee: J.rKnee, backAnkle: J.rAnkle,
      frontHip: J.lHip, frontKnee: J.lKnee, frontAnkle: J.lAnkle, frontShoulder: J.lShoulder }
    : { shoulder: J.lShoulder, elbow: J.lElbow, wrist: J.lWrist, backHip: J.lHip, backKnee: J.lKnee, backAnkle: J.lAnkle,
      frontHip: J.rHip, frontKnee: J.rKnee, frontAnkle: J.rAnkle, frontShoulder: J.rShoulder };
}

// where the front foot lands in the scene: just behind the popping crease (z = -1.22; the bowler runs towards -z),
// beside the stumps. The pitch is drawn for scale: where the foot really landed against the crease isn't measured here.
export const LANDING_Z = -1.0;
export const LANDING_X = 0.62;

/** A zero-lag Gaussian filter over frames (sigma in frames; the ends use the samples there are). */
export function gaussian(x: number[], sigma: number): number[] {
  if (!(sigma > 0.05)) return x.slice();
  const r = Math.max(1, Math.ceil(3 * sigma)), w: number[] = [];
  for (let k = -r; k <= r; k++) w.push(Math.exp(-(k * k) / (2 * sigma * sigma)));
  return x.map((_, i) => {
    let a = 0, n = 0;
    for (let k = -r; k <= r; k++) { const j = i + k; if (j < 0 || j >= x.length) continue; a += x[j] * w[k + r]; n += w[k + r]; }
    return a / n;
  });
}

export interface Flight {
  takeoff: number; land: number;   // frames (in the analysis window): the last one on the take-off foot, back-foot contact
  apex: number;                    // the frame at the top of the bound
  seconds: number;                 // time in the air
  height: number;                  // how high the body rises, from the time in the air (g·t²/8), metres
  clearance: number;               // how far the lower foot is off the ground at its highest (the legs tuck up), metres
  length: number;                  // how far it travels in the air at its run-in speed, metres
}
export interface Motion {
  joints: V3[][];                  // every frame's joints in the scene: smoothed, on the ground, moving down the pitch
  hinges: V3[][];                  // per frame, the axis each limb bends about: right leg, left leg, right arm, left arm
  focus: V3[];                     // where the camera looks: the hips, eased
  flight: Flight | null;           // the bound into back-foot contact, when the clip shows it
  speed: number;                   // the run-in speed used for the travel (m/s)
  kneesMeasured: boolean;          // the skeleton's knees follow the angles measured on the video (a square side-on camera)
  assumed: boolean;                // the camera can't see along the pitch (behind or in front): the run-in and the
                                   // stride's length are assumed, and the legs are re-solved over the planted feet
}

const ANKLE = 0.08;   // an ankle joint's height when its foot is flat on the ground (m)
const G = 9.81;

/** The bound into back-foot contact: the bowler leaves the ground off the front-side foot and lands on the back foot.
 * The take-off is the last frame that foot is still down (within 3.5 cm of its lowest in the half-second before);
 * the time in the air gives the rise (a body in flight follows g, whatever the camera sees). Null when the clip
 * doesn't show it, or the timing isn't believable. */
export function findFlight(result: AnalysisResult): Omit<Flight, "length" | "clearance"> | null {
  const P = result.skeleton3d.joints as V3[][], f0 = result.frames.start, fps = Math.max(1, result.fps_real || result.fps);
  const bf = result.events.bfc;
  if (!bf || bf.method === "timing_prior" || bf.method === "constrained") return null;
  const bfc = bf.frame - f0, s = sides(result.bowling_arm.arm === "right");
  const lo = Math.max(0, bfc - Math.round(0.6 * fps));
  if (bfc - lo < Math.max(3, Math.round(0.12 * fps))) return null;
  const y = gaussian(P.map((fr) => fr[s.frontAnkle][1]), 0.012 * fps), other = P.map((fr) => fr[s.backAnkle][1]);
  let m = Infinity;
  for (let t = lo; t < bfc; t++) if (y[t] < other[t]) m = Math.min(m, y[t]);
  if (!Number.isFinite(m)) return null;
  let takeoff = -1;
  for (let t = bfc - 1; t >= lo; t--) if (y[t] <= m + 0.035 && y[t] < other[t]) { takeoff = t; break; }
  if (takeoff < 0) return null;
  const seconds = (bfc - takeoff - 0.5) / fps;   // the foot leaves between that frame and the next
  if (seconds < 0.12 || bfc - takeoff < 3 || seconds > 0.75) return null;   // under three frames or 0.12 s isn't a bound that can be timed
  return { takeoff, land: bfc, apex: Math.round((takeoff + bfc) / 2), seconds, height: (G * seconds * seconds) / 8 };
}

const motions = new WeakMap<AnalysisResult, Motion>();

/** The delivery as it is shown in 3D, rebuilt from the analysis so it moves like a body and not like a measurement:
 *  1. every bone gets one length (its median) and its direction is filtered over time, lightly on the bowling arm so
 *     the release isn't softened, then the body is put back together from the hips;
 *  2. the planted foot stays put (the back foot from its contact to the front foot's, then the front foot), which
 *     gives the run through the crease; before that the body keeps its run-in speed;
 *  3. the analysis keeps the lower foot on the ground in every frame, so the bound has no flight in it: between
 *     take-off and back-foot contact the body follows the arc its time in the air implies;
 *  4. the axis each limb bends about is found per frame, kept from flipping and filtered, so bones don't twitch. */
export function buildMotion(result: AnalysisResult): Motion {
  const hit = motions.get(result);
  if (hit) return hit;
  const raw = result.skeleton3d.joints as V3[][], T = raw.length, f0 = result.frames.start;
  const parents = result.skeleton3d.parents, fps = Math.max(1, result.fps_real || result.fps);
  const right = result.bowling_arm.arm === "right", s = sides(right);
  const at = (k: EventKey) => { const f = result.events[k]?.frame; return f === undefined || f === null ? null : Math.max(0, Math.min(T - 1, f - f0)); };
  const br = at("br") ?? Math.round(T * 0.6);
  const ffc = Math.min(at("ffc") ?? Math.max(0, br - Math.round(0.12 * fps)), br);
  const bfc = Math.min(at("bfc") ?? Math.max(0, ffc - Math.round(0.2 * fps)), ffc);
  const ft = Math.max(at("ft") ?? Math.min(T - 1, br + Math.round(0.25 * fps)), br);

  // 1. fixed bone lengths, filtered directions
  const NJ = raw[0].length;
  const len: number[] = [], sig: number[] = [];
  for (let j = 0; j < NJ; j++) {
    const p = parents[j];
    if (p < 0) { len.push(0); sig.push(0); continue; }
    const ls = raw.map((fr) => Math.hypot(fr[j][0] - fr[p][0], fr[j][1] - fr[p][1], fr[j][2] - fr[p][2])).sort((a, b) => a - b);
    len.push(ls[ls.length >> 1]);
    sig.push((j === s.elbow || j === s.wrist ? 0.012 : j === J.nose || j === J.head ? 0.04 : 0.028) * fps);
  }
  const dir: V3[][] = raw.map(() => []);
  for (let j = 0; j < NJ; j++) {
    const p = parents[j];
    if (p < 0) continue;
    const c = [0, 1, 2].map((k) => gaussian(raw.map((fr) => (fr[j][k] - fr[p][k])), sig[j]));
    for (let t = 0; t < T; t++) { const l = Math.hypot(c[0][t], c[1][t], c[2][t]) || 1; dir[t][j] = [c[0][t] / l, c[1][t] / l, c[2][t] / l]; }
  }
  const rel: V3[][] = raw.map((_, t) => {
    const out: V3[] = [];
    for (let j = 0; j < NJ; j++) {   // parents come before their children in this skeleton
      const p = parents[j];
      out.push(p < 0 ? [0, 0, 0] : [out[p][0] + dir[t][j][0] * len[j], out[p][1] + dir[t][j][1] * len[j], out[p][2] + dir[t][j][2] * len[j]]);
    }
    return out;
  });

  // 1b. A side-on camera measures the knee angles on the video itself (that is where the callouts' numbers come from);
  // the 3D estimate of a knee can be tens of degrees off. So there each leg is re-solved to the measured angle: the
  // ankle stays on its line from the hip, at the distance that knee angle gives, and the knee bends the way it did.
  let kneesMeasured = false;
  if (result.view.view === "side_on" && !result.view.oblique && result.keypoints2d?.xy?.length === T) {
    const kp = result.keypoints2d.xy, kc = result.keypoints2d.conf;
    const legs: [number, number, number, number, number, number][] = [[J.rHip, J.rKnee, J.rAnkle, 12, 14, 16], [J.lHip, J.lKnee, J.lAnkle, 11, 13, 15]];
    let done = 0;
    for (const [hip, knee, ankle, ch, ck, ca] of legs) {
      // the angle at the knee in the picture, where all three points are tracked; gaps are bridged from their ends
      const th: (number | null)[] = kp.map((fr, t) => {
        if (Math.min(kc[t][ch], kc[t][ck], kc[t][ca]) < 0.35) return null;
        const u = [fr[ch][0] - fr[ck][0], fr[ch][1] - fr[ck][1]], w = [fr[ca][0] - fr[ck][0], fr[ca][1] - fr[ck][1]];
        const l = Math.hypot(u[0], u[1]) * Math.hypot(w[0], w[1]);
        return l > 1e-6 ? (Math.acos(Math.max(-1, Math.min(1, (u[0] * w[0] + u[1] * w[1]) / l))) * 180) / Math.PI : null;
      });
      if (th.filter((v) => v !== null).length < 0.6 * T) continue;
      const filled = th.map((v, t) => {
        if (v !== null) return v;
        let a = t - 1, b = t + 1;
        while (a >= 0 && th[a] === null) a--;
        while (b < T && th[b] === null) b++;
        return a < 0 ? (th[b] as number) : b >= T ? (th[a] as number) : (th[a] as number) + (((th[b] as number) - (th[a] as number)) * (t - a)) / (b - a);
      });
      const angle = gaussian(filled, 0.02 * fps);
      const l1 = len[knee], l2 = len[ankle];
      for (let t = 0; t < T; t++) {
        const H = rel[t][hip], K = rel[t][knee], A = rel[t][ankle];
        const n: V3 = [A[0] - H[0], A[1] - H[1], A[2] - H[2]], nl = Math.hypot(n[0], n[1], n[2]) || 1;
        n[0] /= nl; n[1] /= nl; n[2] /= nl;
        const c = Math.cos((Math.min(179.5, Math.max(40, angle[t])) * Math.PI) / 180);
        const d = Math.sqrt(Math.max(1e-6, l1 * l1 + l2 * l2 - 2 * l1 * l2 * c));
        const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d), h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
        let k: V3 = [K[0] - H[0], K[1] - H[1], K[2] - H[2]];
        const dot = k[0] * n[0] + k[1] * n[1] + k[2] * n[2];
        k = [k[0] - n[0] * dot, k[1] - n[1] * dot, k[2] - n[2] * dot];
        let kl = Math.hypot(k[0], k[1], k[2]);
        if (kl < 0.015) { k = [0 - n[0] * -n[2], 0 - n[1] * -n[2], -1 - n[2] * -n[2]]; kl = Math.hypot(k[0], k[1], k[2]) || 1; }   // straight: a knee bends forwards
        rel[t][knee] = [H[0] + n[0] * a + (k[0] / kl) * h, H[1] + n[1] * a + (k[1] / kl) * h, H[2] + n[2] * a + (k[2] / kl) * h];
        rel[t][ankle] = [H[0] + n[0] * d, H[1] + n[1] * d, H[2] + n[2] * d];
      }
      done++;
    }
    kneesMeasured = done === 2;
  }

  // 3. the hips' height: the planted foot's ankle at ankle height; in the bound, the arc of the flight
  const fl = findFlight(result);
  const planted = (t: number) => (t >= bfc && t < ffc ? s.backAnkle : t >= ffc && t <= ft ? s.frontAnkle
    : rel[t][s.backAnkle][1] < rel[t][s.frontAnkle][1] ? s.backAnkle : s.frontAnkle);
  let rootY = rel.map((fr, t) => ANKLE - fr[planted(t)][1]);
  rootY = gaussian(rootY, 0.03 * fps);
  if (fl) {
    const a = fl.takeoff, b = fl.land, ya = rootY[a], yb = rootY[b];
    for (let t = a + 1; t < b; t++) { const u = (t - a) / (b - a); rootY[t] = ya + (yb - ya) * u + 4 * fl.height * u * (1 - u); }
    rootY = gaussian(rootY, 0.012 * fps);
  }
  // no foot goes into the ground (the foot named as planted isn't always the lower one in the 3D estimate)
  rootY = rootY.map((y, t) => Math.max(y, ANKLE - 0.015 - Math.min(rel[t][s.backAnkle][1], rel[t][s.frontAnkle][1])));

  // 3b. The release height is measured on the video; the 3D estimate often has the hand lower (a bent arm, too much
  // lean). Round release the bowling arm is swung up about the shoulder until the wrist is at the measured height,
  // and if the arm alone can't reach, the trunk is stood up about the hips by what is missing. The change fades
  // out either side of release, so the swing stays the measured swing.
  const rh = result.metrics?.find((q) => q.key === "release_height_pct");
  if (rh && rh.value !== null && rh.reliability === "measured" && rh.rating !== "unrated") {
    const target = (rh.value / 100) * result.skeleton.stature_m;
    const err = target - (rel[br][s.wrist][1] + rootY[br]);
    const sg = Math.max(1.5, 0.07 * fps);
    /** Turn `joints` about `pivot` so that `tip` rises by dy (as far as its length allows), in its own vertical plane. */
    const lift = (fr: V3[], pivot: number, tip: number, joints: number[], dy: number): number => {
      const O = fr[pivot], v: V3 = [fr[tip][0] - O[0], fr[tip][1] - O[1], fr[tip][2] - O[2]], L = Math.hypot(v[0], v[1], v[2]);
      if (L < 1e-4) return dy;
      const y1 = Math.max(-0.995 * L, Math.min(0.995 * L, v[1] + dy));
      const h0 = Math.hypot(v[0], v[2]), h1 = Math.sqrt(Math.max(0, L * L - y1 * y1));
      const hx = h0 > 1e-4 ? v[0] / h0 : 0, hz = h0 > 1e-4 ? v[2] / h0 : -1;
      const a0 = Math.atan2(v[1], h0), a1 = Math.atan2(y1, h1), da = a1 - a0, c = Math.cos(da), sn = Math.sin(da);
      for (const j of joints) {
        const q: V3 = [fr[j][0] - O[0], fr[j][1] - O[1], fr[j][2] - O[2]];
        const along = q[0] * hx + q[2] * hz, side: [number, number] = [q[0] - along * hx, q[2] - along * hz];
        const a2 = along * c - q[1] * sn, y2 = along * sn + q[1] * c;   // a turn in the (along, up) plane
        fr[j] = [O[0] + a2 * hx + side[0], O[1] + y2, O[2] + a2 * hz + side[1]];
      }
      return v[1] + dy - y1;   // what couldn't be reached
    };
    const upper = [J.spine, J.thorax, J.nose, J.head, J.lShoulder, J.lElbow, J.lWrist, J.rShoulder, J.rElbow, J.rWrist];
    if (Math.abs(err) > 0.01) for (let t = Math.max(0, Math.floor(br - 3 * sg)); t <= Math.min(T - 1, Math.ceil(br + 3 * sg)); t++) {
      const want = rel[t][s.wrist][1] + err * Math.exp(-0.5 * ((t - br) / sg) ** 2);
      // the arm first, then the trunk for what the arm can't reach, then the arm again on the stood-up trunk
      for (let pass = 0; pass < 3; pass++) {
        const left = lift(rel[t], s.shoulder, s.wrist, [s.elbow, s.wrist], want - rel[t][s.wrist][1]);
        if (left <= 0.005) break;
        lift(rel[t], J.pelvis, J.thorax, upper, left);
      }
    }
  }

  // 2. the run through the crease
  const maxStep = 10 / fps;
  const step: [number, number][] = Array.from({ length: T }, () => [0, 0]);
  const lock = (t: number, j: number) => {
    let dx = -(rel[t][j][0] - rel[t - 1][j][0]), dz = -(rel[t][j][2] - rel[t - 1][j][2]);
    const m = Math.hypot(dx, dz);
    if (m > maxStep) { dx *= maxStep / m; dz *= maxStep / m; }
    step[t] = [dx, dz];
  };
  for (let t = bfc + 1; t <= ffc; t++) lock(t, s.backAnkle);
  for (let t = ffc + 1; t <= ft && t < T; t++) lock(t, s.frontAnkle);
  let vx = 0, vz = 0, n = 0;
  for (let t = bfc + 1; t <= ffc; t++) { vx += step[t][0]; vz += step[t][1]; n++; }
  if (n) { vx /= n; vz /= n; }
  vz = Math.min(vz, -3 / fps);   // at least a jog, towards the batter
  for (let t = 1; t <= bfc; t++) step[t] = [vx, vz];
  let ex = step[Math.min(T - 1, ft)][0], ez = step[Math.min(T - 1, ft)][1];
  const decay = Math.pow(0.5, 1 / Math.max(1, 0.2 * fps));
  for (let t = ft + 1; t < T; t++) { ex *= decay; ez *= decay; step[t] = [ex, ez]; }
  // A camera behind or in front of the bowler can't see movement along the pitch, and the 3D estimate from it has the
  // legs almost under the hips. There the run-in is assumed from the arm (a faster arm, a faster run-in), the body
  // slows over the stride as bowlers do, the front foot lands a stride ahead, and each planted foot is pinned to the
  // ground with its leg re-solved from hip to foot (the way motion capture is cleaned up).
  const assumed = result.view.view !== "side_on";
  if (assumed) {
    let hand = 0;
    for (let t = Math.max(1, bfc); t <= br; t++) hand = Math.max(hand, Math.hypot(...([0, 1, 2].map((k) => (rel[t][s.wrist][k] - rel[t - 1][s.wrist][k]) * fps) as V3)));
    const run = Math.max(2.5, Math.min(6.5, 0.3 * hand)) / fps;
    for (let t = 1; t < T; t++) {
      const k = t <= bfc ? 1 : t <= ffc ? 1 - 0.3 * ((t - bfc) / Math.max(1, ffc - bfc)) : t <= ft ? 0.55 - 0.35 * ((t - ffc) / Math.max(1, ft - ffc)) : 0.2 * Math.pow(decay, t - ft);
      step[t] = [0, -run * k];
    }
    vx = 0; vz = -run;
  }
  let ox = [0], oz = [0];
  for (let t = 1; t < T; t++) { ox.push(ox[t - 1] + step[t][0]); oz.push(oz[t - 1] + step[t][1]); }
  ox = gaussian(ox, 0.03 * fps); oz = gaussian(oz, 0.03 * fps);
  const world = rel.map((fr, t) => fr.map((p) => [p[0] + ox[t], Math.max(0.03, p[1] + rootY[t]), p[2] + oz[t]] as V3));
  if (assumed) {
    const legOf = (ankle: number): [number, number] => (ankle === J.rAnkle ? [J.rHip, J.rKnee] : [J.lHip, J.lKnee]);
    /** Put the ankle at `target` and bend the knee to fit, keeping the knee on the side of the leg it was on. */
    const solve = (t: number, ankle: number, target: V3) => {
      const [hip, knee] = legOf(ankle), H = world[t][hip], K = world[t][knee], l1 = len[knee], l2 = len[ankle];
      let d: V3 = [target[0] - H[0], target[1] - H[1], target[2] - H[2]], dl = Math.hypot(d[0], d[1], d[2]) || 1e-6;
      const reach = (l1 + l2) * 0.985;
      if (dl > reach) { d = [d[0] * reach / dl, d[1] * reach / dl, d[2] * reach / dl]; dl = reach; }
      const n: V3 = [d[0] / dl, d[1] / dl, d[2] / dl];
      const a = (l1 * l1 - l2 * l2 + dl * dl) / (2 * dl), h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
      // the knee points where it did (forwards if that isn't clear)
      let k: V3 = [K[0] - H[0], K[1] - H[1], K[2] - H[2] - 0.12];
      const dot = k[0] * n[0] + k[1] * n[1] + k[2] * n[2];
      k = [k[0] - n[0] * dot, k[1] - n[1] * dot, k[2] - n[2] * dot];
      const kl = Math.hypot(k[0], k[1], k[2]);
      k = kl > 1e-4 ? [k[0] / kl, k[1] / kl, k[2] / kl] : [0, 0, -1];
      world[t][knee] = [H[0] + n[0] * a + k[0] * h, H[1] + n[1] * a + k[1] * h, H[2] + n[2] * a + k[2] * h];
      world[t][ankle] = [H[0] + d[0], H[1] + d[1], H[2] + d[2]];
    };
    const ramp = Math.max(1, Math.round(0.05 * fps));
    const mix = (a: V3, b: V3, u: number): V3 => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
    // the back foot: down at back-foot contact, lifting as the front foot lands
    const backPin: V3 = [world[bfc][s.backAnkle][0], ANKLE, world[bfc][s.backAnkle][2]];
    for (let t = Math.max(0, bfc - ramp); t <= Math.min(T - 1, ffc + ramp); t++) {
      const w = t < bfc ? 1 - (bfc - t) / (ramp + 1) : t > ffc ? 1 - (t - ffc) / (ramp + 1) : 1;
      solve(t, s.backAnkle, mix(world[t][s.backAnkle], backPin, w));
    }
    // the front foot: reaching a stride ahead through the delivery stride, then planted there
    const stride = 0.55 * (len[s.frontKnee] + len[s.frontAnkle]);
    const frontPin: V3 = [world[ffc][s.frontAnkle][0], ANKLE, world[ffc][J.pelvis][2] - stride];
    for (let t = bfc + 1; t < ffc; t++) { const u = (t - bfc) / (ffc - bfc), e = u * u * (3 - 2 * u), p = world[t][s.frontAnkle]; solve(t, s.frontAnkle, [p[0], p[1], p[2] - stride * e]); }
    for (let t = ffc; t <= Math.min(T - 1, ft + ramp); t++) {
      const w = t > ft ? 1 - (t - ft) / (ramp + 1) : 1;
      solve(t, s.frontAnkle, mix(world[t][s.frontAnkle], frontPin, w));
    }
  }
  const ax = LANDING_X * (right ? -1 : 1) - world[ffc][s.frontAnkle][0];
  const az = LANDING_Z - world[ffc][s.frontAnkle][2];
  const joints = world.map((fr) => fr.map((p) => [p[0] + ax, p[1], p[2] + az] as V3));
  const speed = Math.hypot(vx, vz) * fps;

  // 4. the axis each limb bends about
  const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const unit = (a: V3): V3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  const limbs: [number, number, number, boolean][] = [[J.rHip, J.rKnee, J.rAnkle, true], [J.lHip, J.lKnee, J.lAnkle, true],
    [J.rShoulder, J.rElbow, J.rWrist, false], [J.lShoulder, J.lElbow, J.lWrist, false]];
  const rawH: V3[][] = joints.map((fr) => limbs.map(([a, b, c, leg]) => {
    const up = unit(sub(fr[b], fr[a])), low = unit(sub(fr[c], fr[b]));
    const side = unit(leg ? sub(fr[J.rHip], fr[J.lHip]) : sub(fr[J.rShoulder], fr[J.lShoulder]));
    const h = leg ? cross(low, up) : cross(up, low);   // a knee bends back, an elbow forward
    // a nearly straight limb has no bending plane: lean on the body's own right
    return unit([h[0] + side[0] * 0.35, h[1] + side[1] * 0.35, h[2] + side[2] * 0.35]);
  }));
  const hinges: V3[][] = rawH.map(() => []);
  for (let l = 0; l < 4; l++) {
    for (let t = 1; t < T; t++) { const a = rawH[t - 1][l], b = rawH[t][l]; if (a[0] * b[0] + a[1] * b[1] + a[2] * b[2] < 0) rawH[t][l] = [-b[0], -b[1], -b[2]]; }
    const c = [0, 1, 2].map((k) => gaussian(rawH.map((h) => h[l][k]), (l < 2 ? 0.05 : 0.03) * fps));
    for (let t = 0; t < T; t++) hinges[t][l] = unit([c[0][t], c[1][t], c[2][t]]);
  }
  const fx = gaussian(joints.map((fr) => fr[0][0]), 0.14 * fps), fz = gaussian(joints.map((fr) => fr[0][2]), 0.14 * fps);
  const focus = joints.map((_, t) => [fx[t], 0.98, fz[t]] as V3);
  let flight: Flight | null = null;
  if (fl) {
    let d = 0, c = 0, apex = fl.apex;
    for (let t = fl.takeoff + 1; t <= fl.land; t++) d += Math.hypot(step[t][0], step[t][1]);
    for (let t = fl.takeoff + 1; t < fl.land; t++) { const low = Math.min(joints[t][s.backAnkle][1], joints[t][s.frontAnkle][1]) - ANKLE; if (low > c) { c = low; apex = t; } }
    flight = { ...fl, apex, clearance: c, length: d };
  }
  const out: Motion = { joints, hinges, focus, flight, speed, assumed, kneesMeasured };
  motions.set(result, out);
  return out;
}

/** Every frame's joints in the scene. */
export function sceneJoints(result: AnalysisResult): V3[][] { return buildMotion(result).joints; }

/** A per-frame track (hinges, the camera's focus) at a fractional frame. */
export function sampleTrack(track: V3[], tf: number): V3 {
  const x = Math.max(0, Math.min(track.length - 1, tf)), i = Math.min(track.length - 2, Math.floor(x)), u = track.length < 2 ? 0 : x - i;
  if (track.length < 2) return track[0];
  const a = track[i], b = track[i + 1];
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
}

/** The joints at a fractional frame (Catmull-Rom through the frames), so slow motion is smooth at any frame rate. */
export function sampleJoints(frames: V3[][], tf: number, out?: V3[]): V3[] {
  const T = frames.length, x = Math.max(0, Math.min(T - 1, tf)), i = Math.min(T - 2, Math.floor(x)), u = T < 2 ? 0 : x - i;
  const res = out ?? frames[0].map(() => [0, 0, 0] as V3);
  if (T < 2) { frames[0].forEach((p, j) => { res[j][0] = p[0]; res[j][1] = p[1]; res[j][2] = p[2]; }); return res; }
  const a = frames[Math.max(0, i - 1)], b = frames[i], c = frames[i + 1], d = frames[Math.min(T - 1, i + 2)];
  const u2 = u * u, u3 = u2 * u;
  for (let j = 0; j < b.length; j++) for (let k = 0; k < 3; k++) {
    res[j][k] = 0.5 * (2 * b[j][k] + (c[j][k] - a[j][k]) * u + (2 * a[j][k] - 5 * b[j][k] + 4 * c[j][k] - d[j][k]) * u2
      + (3 * b[j][k] - a[j][k] - 3 * c[j][k] + d[j][k]) * u3);
  }
  return res;
}

/** How fast the bowling hand moves round the body at each frame (m/s, relative to the pelvis, so the run-in doesn't
 * count), lightly smoothed. */
export function armSpeed(result: AnalysisResult): number[] {
  const P = result.skeleton3d.joints as V3[][], T = P.length, w = sides(result.bowling_arm.arm === "right").wrist;
  const t = result.frames.times, slow = Math.max(1, result.options.slowmo_factor || 1);
  const raw = P.map((_, i) => {
    const a = Math.max(0, i - 1), b = Math.min(T - 1, i + 1);
    const dt = (t[b] - t[a]) / slow;
    if (b === a || !(dt > 0)) return 0;
    const rel = (k: number, c: number) => P[k][w][c] - P[k][0][c];
    return Math.hypot(rel(b, 0) - rel(a, 0), rel(b, 1) - rel(a, 1), rel(b, 2) - rel(a, 2)) / dt;
  });
  return raw.map((_, i) => (raw[Math.max(0, i - 1)] + 2 * raw[i] + raw[Math.min(T - 1, i + 1)]) / 4);
}

/** The ribbon's colour for a speed between 0 (slow) and 1 (this delivery's fastest): blue, cyan, green, yellow, red. */
export function speedColor(u: number): [number, number, number] {
  const stops: [number, [number, number, number]][] = [[0, [0.16, 0.42, 0.95]], [0.3, [0.1, 0.78, 0.86]], [0.55, [0.2, 0.86, 0.36]],
    [0.78, [0.98, 0.84, 0.16]], [1, [0.92, 0.16, 0.14]]];
  const x = Math.max(0, Math.min(1, u));
  for (let i = 1; i < stops.length; i++) {
    if (x <= stops[i][0]) {
      const [x0, a] = stops[i - 1], [x1, b] = stops[i], k = (x - x0) / (x1 - x0);
      return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
    }
  }
  return stops[stops.length - 1][1];
}

export interface Callout {
  key: string;
  title: string;          // what it means ("Front leg firm")
  detail: string;         // the number ("Front knee angle 172°")
  anchor: number[];       // joints whose mean the leader line points at
  graphic: "knee_front" | "knee_back" | "stride" | "height" | "trunk" | "clearance" | "none";
  side: 1 | -1;           // which side of the anchor the box sits on
  limbs: ("leg_front" | "leg_back" | "arm" | "trunk")[];   // the bones to light up while it shows
  good: boolean;          // lit green (reads well) or pale blue
}

const usable = (m: Metric | undefined): m is Metric => !!m && m.value !== null && m.reliability === "measured" && m.rating !== "unrated";
const deg = (v: number) => `${Math.round(v)}°`;

// what each measurement is called when it reads well, when it's worth watching and when it's a concern
const WORDS: Record<string, { good: string; watch: string; risk: string; info: string; name: string }> = {
  back_knee_bfc: { good: "Back leg stays tall", watch: "Back leg softens", risk: "Back leg collapses", info: "Back leg at landing", name: "Back knee angle" },
  front_knee_ffc: { good: "Front leg lands firm", watch: "Front knee soft at landing", risk: "Front knee bent at landing", info: "Front leg at landing", name: "Front knee angle" },
  front_knee_br: { good: "Braced front leg", watch: "Front knee softens", risk: "Front knee collapses", info: "Front knee at release", name: "Front knee angle" },
  stride_length_pct: { good: "Good stride", watch: "Stride to watch", risk: "Stride to work on", info: "Delivery stride", name: "Stride length" },
  release_height_pct: { good: "Tall release", watch: "Release could be taller", risk: "Low release", info: "Release height", name: "Release height" },
  trunk_forward_br: { good: "Strong forward drive", watch: "Trunk lean to watch", risk: "Trunk lean to work on", info: "Trunk at release", name: "Trunk forward lean" },
  trunk_lateral_br: { good: "Side-bend in the safe range", watch: "Side-bend to watch", risk: "High side-bend", info: "Side-bend at release", name: "Trunk side-bend" },
  hip_shoulder_sep_bfc: { good: "Hips and shoulders in line", watch: "Hips and shoulders apart", risk: "Mixed action", info: "Hip–shoulder separation", name: "Hip–shoulder separation" },
};

/** The callouts shown at one key moment: only what this clip measured (rated, from a camera that sees it). */
export function calloutsAt(result: AnalysisResult, event: "bfc" | "ffc" | "br"): Callout[] {
  const s = sides(result.bowling_arm.arm === "right");
  const m = (key: string) => { const x = result.metrics.find((q) => q.key === key); return usable(x) ? x : null; };
  const userHeight = result.skeleton.height_source === "user", h = result.skeleton.stature_m;
  const pct = (v: number) => (userHeight ? `${(v / 100 * h).toFixed(2)} m (${Math.round(v)}% of height)` : `${Math.round(v)}% of height`);
  const out: Callout[] = [];
  const add = (key: string, detail: (v: number) => string, anchor: number[], graphic: Callout["graphic"], side: 1 | -1) => {
    const x = m(key), w = WORDS[key];
    if (!x || !w) return;
    const title = x.rating === "good" ? w.good : x.rating === "watch" ? w.watch : x.rating === "risk" ? w.risk : w.info;
    const limbs: Callout["limbs"] = graphic === "knee_front" ? ["leg_front"] : graphic === "knee_back" ? ["leg_back"] : graphic === "stride" ? ["leg_front", "leg_back"] : [];
    out.push({ key, title, detail: `${w.name} ${detail(x.value!)}`, anchor, graphic, side, limbs, good: false });
  };
  if (event === "bfc") {
    add("back_knee_bfc", deg, [s.backKnee], "knee_back", 1);
    const lean = result.view.view === "side_on" && !result.view.oblique ? result.series?.trunk_angle_2d?.[(result.events.bfc?.frame ?? -1) - result.frames.start] : null;
    if (lean !== null && lean !== undefined && Number.isFinite(lean)) out.push({ key: "trunk_bfc", title: Math.abs(lean) <= 12 ? "Tall at landing" : "Trunk leans at landing",
      detail: `Trunk ${Math.round(Math.abs(lean))}° from upright`, anchor: [J.thorax], graphic: "trunk", side: -1, limbs: [], good: false });
    add("hip_shoulder_sep_bfc", deg, [J.spine], "none", -1);
  } else if (event === "ffc") {
    add("front_knee_ffc", deg, [s.frontKnee], "knee_front", 1);
    add("stride_length_pct", pct, [s.frontAnkle, s.backAnkle], "stride", -1);
  } else {
    add("release_height_pct", pct, [s.wrist], "height", 1);
    add("trunk_forward_br", deg, [J.thorax], "trunk", -1);
    add("trunk_lateral_br", deg, [J.thorax], "none", -1);
    add("front_knee_br", deg, [s.frontKnee], "knee_front", 1);
  }
  return out;
}

export interface Shot { az: number; el: number; dist: number; drift: number }   // degrees, degrees, metres, degrees a second
export interface Segment {
  kind: "video" | "play" | "hold";
  dur: number;                 // seconds on screen
  from: number; to: number;    // fractional frames (index into the analysis window) at the start and the end
  title: string;
  sub: string;                 // a small line under the title
  orbit: boolean;              // the camera goes right round the bowler, rising and falling
  strobe: boolean;             // the body's earlier key moments stand along the crease as ghosts
  callouts: Callout[];
  shot: Shot | null;           // where the camera is (3D segments)
  fade: number;                // video segments: seconds of cross-fade with the 3D scene at the 3D end of the segment
  trail: boolean;              // whether the arm ribbon is shown
}
export interface Script { segments: Segment[]; total: number; br: number; trailFrom: number; ghosts: { frame: number; label: string }[] }

export interface Chain {
  names: string[];        // the hips' turn, the shoulders' turn, the upper arm's swing, the hand
  speed: number[][];      // per link, per frame: its speed as a share of its own fastest (0–1)
  top: number[];          // each link's fastest: degrees a second for the three turns, m/s for the hand
  peak: number[];         // the frame each link is fastest at (between frames, from the three samples round the peak)
  timed: boolean;         // filmed fast enough (90+ frames a second) to say which peaked first
  ordered: boolean | null;   // each link peaks no earlier than the one before it (null when it can't be timed)
}

/** The kinetic chain: a fast delivery passes speed up the body, the hips turning first, then the shoulders, then the
 * bowling arm swinging, then the hand, each peaking as the one before slows. From the 3D body, in the stride and
 * release (from just before back-foot contact to just after release). */
export function kineticChain(result: AnalysisResult): Chain {
  const m = buildMotion(result), P = m.joints, T = P.length, f0 = result.frames.start, fps = Math.max(1, result.fps_real || result.fps);
  const s = sides(result.bowling_arm.arm === "right");
  const br = Math.max(0, Math.min(T - 1, (result.events.br?.frame ?? f0 + Math.round(T * 0.6)) - f0));
  const lo = Math.max(1, Math.min(br - 2, (result.events.bfc?.frame ?? f0) - f0 - Math.round(0.1 * fps))), hi = Math.min(T - 2, br + Math.round(0.06 * fps));
  // how fast a line between two joints is turning (degrees a second), or a joint is moving relative to the hips (m/s)
  const turn = (a: number, b: number) => P.map((_, t) => {
    const u = Math.max(0, t - 1), w = Math.min(T - 1, t + 1);
    const d = (i: number): V3 => { const x = P[i][b][0] - P[i][a][0], y = P[i][b][1] - P[i][a][1], z = P[i][b][2] - P[i][a][2], l = Math.hypot(x, y, z) || 1; return [x / l, y / l, z / l]; };
    const p = d(u), q = d(w);
    return ((Math.acos(Math.max(-1, Math.min(1, p[0] * q[0] + p[1] * q[1] + p[2] * q[2]))) * 180) / Math.PI) * fps / Math.max(1, w - u);
  });
  const move = (j: number) => P.map((_, t) => {
    const u = Math.max(0, t - 1), w = Math.min(T - 1, t + 1), r = (i: number, c: number) => P[i][j][c] - P[i][0][c];
    return (Math.hypot(r(w, 0) - r(u, 0), r(w, 1) - r(u, 1), r(w, 2) - r(u, 2)) * fps) / Math.max(1, w - u);
  });
  const raw = [turn(J.lHip, J.rHip), turn(J.lShoulder, J.rShoulder), turn(s.shoulder, s.elbow), move(s.wrist)].map((v) => gaussian(v, 0.012 * fps));
  const top: number[] = [], peak: number[] = [];
  for (const v of raw) {
    let i = lo;
    for (let t = lo; t <= hi; t++) if (v[t] > v[i]) i = t;
    // the top of the parabola through the three samples round the fastest frame
    const d = v[i - 1] - 2 * v[i] + v[i + 1];
    peak.push(i > 0 && i < T - 1 && d < 0 ? i + (0.5 * (v[i - 1] - v[i + 1])) / d : i);
    top.push(v[i]);
  }
  const timed = fps * (1 - (result.quality?.repeated_frames ?? 0)) >= 90;
  const ordered = timed ? peak.every((p, i) => i === 0 || p >= peak[i - 1] - 0.5) : null;
  return { names: ["Hips", "Trunk", "Arm", "Hand"], speed: raw.map((v, i) => v.map((x) => Math.max(0, Math.min(1, x / Math.max(1e-6, top[i]))))), top, peak, timed, ordered };
}

/** The lowest the back knee gets between back-foot and front-foot contact, on the skeleton whose knees follow the
 * angles measured on the video (so a square side-on camera only): the frame and the angle, or null. */
export function backLegDip(result: AnalysisResult): { t: number; angle: number } | null {
  const m = buildMotion(result), f0 = result.frames.start;
  const bfc = result.events.bfc?.frame, ffc = result.events.ffc?.frame;
  if (!m.kneesMeasured || bfc == null || ffc == null || ffc - bfc < 3) return null;
  const s = sides(result.bowling_arm.arm === "right");
  let best: { t: number; angle: number } | null = null;
  for (let t = bfc - f0 + 1; t < ffc - f0; t++) {
    const P = m.joints[t], u = [0, 1, 2].map((k) => P[s.backHip][k] - P[s.backKnee][k]), w = [0, 1, 2].map((k) => P[s.backAnkle][k] - P[s.backKnee][k]);
    const v = (Math.acos(Math.max(-1, Math.min(1, (u[0] * w[0] + u[1] * w[1] + u[2] * w[2]) / (Math.hypot(...u) * Math.hypot(...w))))) * 180) / Math.PI;
    if (!best || v < best.angle) best = { t, angle: v };
  }
  return best;
}

/** The whole replay, in the order a broadcast shows it: the video through the delivery, a dissolve into the 3D scene
 * at the gather, a stop at each key moment with its numbers, a turn right round the bowler at release, the video out. */
export function replayScript(result: AnalysisResult): Script {
  const T = result.skeleton3d.joints.length, f0 = result.frames.start;
  const fps = Math.max(1, result.fps_real || result.fps);
  const at = (k: EventKey) => { const f = result.events[k]?.frame; return f === undefined || f === null ? null : Math.max(0, Math.min(T - 1, f - f0)); };
  const br = at("br") ?? Math.round(T * 0.6);
  const ffc = Math.min(at("ffc") ?? br, br), bfc = Math.min(at("bfc") ?? ffc, ffc);
  let start = Math.max(0, bfc - Math.round(0.45 * fps));        // the gather: a little before the back foot lands
  const realS = (a: number, b: number) => Math.max(0, b - a) / fps;
  const right = result.bowling_arm.arm === "right";
  // the camera starts where the video's camera was: beside the pitch for a side-on clip (on the bowler's open side),
  // behind the bowler or in front otherwise
  const open = right ? -1 : 1;
  const base = result.view.view === "side_on" ? 90 * open : result.view.view === "front_on" ? 180 : 0;
  const shot = (az: number, el: number, dist: number, drift = 0): Shot => ({ az, el, dist, drift });
  const slow = (a: number, b: number, rate: number) => Math.max(0.9, (realS(a, b) / rate) * 1.35);   // longer, because it eases in and out
  const seg = (s: Partial<Segment> & Pick<Segment, "kind" | "dur" | "from" | "to">): Segment =>
    ({ title: "", sub: "", orbit: false, strobe: false, callouts: [], shot: null, fade: 0, trail: true, ...s });
  const cam = (off: number, el: number, dist: number, drift = 0) => shot(base + off * open, el, dist * 0.86, drift * open);
  const segments: Segment[] = [];
  const motion = buildMotion(result), fl = motion.flight;
  if (fl) start = Math.max(0, Math.min(start, fl.takeoff - Math.round(0.12 * fps)));
  // 1. the video, through the delivery to just after release, the arm's speed drawn over it
  const out = Math.min(T - 1, br + Math.round(0.12 * fps));
  segments.push(seg({ kind: "video", dur: Math.min(3.4, Math.max(1.8, realS(0, out) / 0.55)), from: 0, to: out }));
  // 2. back before the bound, the video fades and the skeleton stands in the bowler's place
  segments.push(seg({ kind: "video", dur: 1.0, from: start, to: start, fade: 1.0, trail: false }));
  segments.push(seg({ kind: "hold", dur: 0.7, from: start, to: start, title: "Jump / gather", shot: cam(-34, 8, 4.7, 3), trail: false }));
  // 3. the bound: a stop at its top with what the time in the air says (an estimate: the camera doesn't measure height)
  let from = start;
  if (fl && fl.apex > start && fl.apex < bfc) {
    const s = sides(right), side = result.view.view === "side_on";
    const c: Callout[] = [{ key: "jump_clearance", title: fl.clearance >= 0.25 ? "High gather" : fl.clearance >= 0.12 ? "Gather" : "Low gather",
      detail: `Jump clearance ≈${fl.clearance.toFixed(2)} m`, anchor: [s.backAnkle], graphic: "clearance", side: 1, limbs: [], good: false }];
    // how far the bound carries needs the run-in speed, which only a side-on camera sees
    if (side && fl.length > 0.3) c.push({ key: "jump_length", title: "Jump length (forward)", detail: `≈${fl.length.toFixed(2)} m`, anchor: [J.pelvis], graphic: "none", side: 1, limbs: [], good: false });
    segments.push(seg({ kind: "play", dur: slow(start, fl.apex, 0.2), from: start, to: fl.apex, title: "Jump / gather", shot: cam(-32, 8, 4.7), trail: false }));
    segments.push(seg({ kind: "hold", dur: 3.0, from: fl.apex, to: fl.apex, title: "Jump / gather", callouts: c, shot: cam(-30, 7, 4.6, 3), trail: false }));
    from = fl.apex;
  }
  // back-foot contact
  if (bfc > from) segments.push(seg({ kind: "play", dur: slow(from, bfc, 0.2), from, to: bfc, title: fl ? "Jump / gather" : "Gather", shot: cam(-28, 8, 4.6) }));
  const cB = calloutsAt(result, "bfc");
  segments.push(seg({ kind: "hold", dur: cB.length ? 3.0 : 1.3, from: bfc, to: bfc, title: "Back foot contact", callouts: cB, shot: cam(-22, 7, 4.4, 3) }));
  // 4. the back leg through the stride, at its deepest bend
  const dip = backLegDip(result);
  from = bfc;
  if (dip && dip.t > bfc && dip.t < ffc) {
    const s = sides(right), firm = dip.angle >= 146;   // the same line the back-knee measurement uses for a red flag
    segments.push(seg({ kind: "play", dur: slow(bfc, dip.t, 0.16), from: bfc, to: dip.t, title: "Back leg", shot: cam(-14, 7, 4.5) }));
    segments.push(seg({ kind: "hold", dur: 2.6, from: dip.t, to: dip.t, title: "Back leg", shot: cam(-10, 7, 4.4, 3),
      callouts: [{ key: "back_knee_min", title: firm ? "Back leg holds firm" : dip.angle >= 125 ? "Back leg bends" : "Back leg collapses",
        detail: `Back knee bends to ${Math.round(dip.angle)}°`, anchor: [s.backKnee], graphic: "none", side: 1, limbs: ["leg_back"], good: firm }] }));
    from = dip.t;
  }
  // 5. front-foot contact
  if (ffc > from) segments.push(seg({ kind: "play", dur: slow(from, ffc, 0.16), from, to: ffc, title: "Delivery stride", shot: cam(-2, 7, 4.6) }));
  const cF = calloutsAt(result, "ffc");
  segments.push(seg({ kind: "hold", dur: cF.length ? 3.2 : 1.3, from: ffc, to: ffc, title: "Front foot contact", callouts: cF, shot: cam(6, 8, 4.5, 3) }));
  // 6. release
  if (br > ffc) segments.push(seg({ kind: "play", dur: slow(ffc, br, 0.12), from: ffc, to: br, title: "Release", shot: cam(18, 7, 5.0) }));
  const cR = calloutsAt(result, "br");
  segments.push(seg({ kind: "hold", dur: cR.length ? 3.8 : 1.5, from: br, to: br, title: "Release", callouts: cR, shot: cam(24, 7, 5.1, 3) }));
  // 7. right round the bowler at release, the whole ribbon in view
  segments.push(seg({ kind: "hold", dur: 7.5, from: br, to: br, title: "Skeleton, 3D", sub: "action strobe: every key moment at once · drag to look round", orbit: true, strobe: true, shot: cam(35, 16, 6.1, 46) }));
  // 8. back to the video at release, out through the follow-through
  segments.push(seg({ kind: "video", dur: Math.max(1.2, realS(br, T - 1) / 0.5), from: br, to: T - 1, fade: -0.6, trail: false }));
  // the moments left standing in the strobe: the top of the bound, the two foot contacts (release is the body itself)
  const ghosts = [...(fl && fl.apex < bfc ? [{ frame: fl.apex, label: "Gather" }] : []), ...(bfc < ffc ? [{ frame: bfc, label: "Back foot" }] : []), ...(ffc < br ? [{ frame: ffc, label: "Front foot" }] : [])];
  // the ribbon covers the delivery swing: from a little before back-foot contact (a long run-up would smear it out)
  return { segments, total: segments.reduce((a, s) => a + s.dur, 0), br, trailFrom: Math.max(start, bfc - Math.round(0.14 * fps)), ghosts };
}

const ease = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
// the action between two stops: it starts from rest and comes to rest (speed and acceleration both zero at the ends)
const glide = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * u * (u * (6 * u - 15) + 10));

export interface ReplayState {
  index: number; segment: Segment;
  tf: number;                // the fractional frame to show
  u: number;                 // how far through the segment (0–1)
  video: number;             // how much of the picture is the video (1) or the 3D scene (0)
  shot: Shot;                // the camera, already blended from the last segment's
  callout: number;           // the callouts' opacity (0–1)
  title: string; sub: string;
}

/** What is on screen `time` seconds into the replay. */
export function replayState(script: Script, time: number): ReplayState {
  const t = Math.max(0, Math.min(script.total - 1e-6, time));
  let acc = 0, index = 0;
  for (; index < script.segments.length - 1; index++) { if (t < acc + script.segments[index].dur) break; acc += script.segments[index].dur; }
  const s = script.segments[index], local = t - acc, u = s.dur > 0 ? local / s.dur : 1;
  // motion eases in and out of each stop, so nothing jerks
  const tf = s.from + (s.to - s.from) * (s.kind === "play" ? glide(u) : u);
  let video = 0;
  if (s.kind === "video") video = s.fade > 0 ? 1 - ease((local - (s.dur - s.fade)) / s.fade) : s.fade < 0 ? ease(local / -s.fade) : 1;
  // the camera: this segment's shot, turning slowly, reached from where the previous 3D segment's camera ended
  const shots = script.segments.map((x) => x.shot);
  const near = (i: number, dir: 1 | -1) => { for (let k = i; k >= 0 && k < shots.length; k += dir) if (shots[k]) return k; return -1; };
  // a video segment borrows the camera of the 3D segment it fades to or from (the next one, at the very start)
  let cur = s.shot ? index : near(index, s.fade > 0 ? 1 : -1);
  if (cur < 0) cur = near(index, 1);
  const own = shots[cur] ?? { az: 0, el: 10, dist: 6, drift: 0 };
  const inCur = cur === index ? local : cur > index || cur < 0 ? 0 : script.segments[cur].dur;
  let shot: Shot = { ...own, az: own.az + own.drift * inCur };
  // going right round: the camera rises over the bowler and comes back down, a little closer in the middle
  if (script.segments[cur]?.orbit) { const w = Math.sin(Math.PI * Math.min(1, inCur / script.segments[cur].dur)); shot.el = own.el + 26 * w * Math.sin(2 * Math.PI * inCur / script.segments[cur].dur + 0.6) ** 2; shot.dist = own.dist - 0.5 * w; }
  const prev = cur === index ? near(index - 1, -1) : -1;
  // a replay starts the action again: the camera cuts to its new place instead of flying there
  const cut = index > 0 && s.kind === "play" && s.from < script.segments[index - 1].to;
  if (prev >= 0 && shots[prev] && !cut) {
    const p = shots[prev]!, pEnd = { ...p, az: p.az + p.drift * script.segments[prev].dur };
    const k = glide(Math.min(1, local / Math.min(1.8, Math.max(0.6, s.dur * 0.75))));
    shot = { az: pEnd.az + (shot.az - pEnd.az) * k, el: pEnd.el + (shot.el - pEnd.el) * k, dist: pEnd.dist + (shot.dist - pEnd.dist) * k, drift: own.drift };
  }
  const callout = s.kind === "hold" && s.callouts.length ? Math.min(ease(local / 0.5), ease((s.dur - local) / 0.35)) : 0;
  return { index, segment: s, tf, u, video, shot, callout, title: s.title, sub: s.sub };
}
