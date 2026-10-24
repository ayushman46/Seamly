/**
 * Biomechanics metrics, view-aware (port of backend/bowlnet/metrics.py).
 *
 * Every metric declares the anatomical plane it lives in. If that plane is (nearly) parallel to the image
 * plane for the detected camera view we measure it directly on the high-resolution 2D keypoints (e.g. Cottam
 * 2016 for rear-view lateral flexion); otherwise we use the reconstructed 3D skeleton and lower the confidence.
 * Norms, thresholds and references are in docs/RESEARCH.md; thresholds marked 'heuristic' are ±1-2 SD bands
 * around elite norms, not published cut-offs, and are labelled as such in the UI.
 *
 * Numerics follow numpy where it changes a rounded result: pairwise summation for means, numpy's percentile
 * interpolation, NaN-first argmax/argmin, and Python's round / f-string formatting (half-even on the exact
 * binary value, see pyRound / pyFormat).
 */
import type { Metric } from "../types";
import { amax, amin, type Arr1, type Arr2, type Arr3 } from "./nd";
import { PELVIS, THORAX, type Events, type Side, type ViewInfo, type WorldFrame } from "./types";

export const ANKLE_HEIGHT_FRAC = 0.044; // ankle joint centre height / stature (Anny & anthropometric tables)
export const HAND_OFFSET_M = 0.07;      // wrist joint -> ball centre at release

// ------------------------------------------------------------------------------------------------------
// Python / numpy semantics
// ------------------------------------------------------------------------------------------------------

/** Python f"{x:.{n}f}": correctly rounded on the exact binary value, exact ties to even (toFixed ties away). */
export function pyFormat(x: number, n = 0): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  const neg = x < 0 || Object.is(x, -0);
  const ax = Math.abs(x);
  let s = ax.toFixed(n);   // exact except for ties
  // a tie is only possible if the (n+1)-digit rendering ends in 5; then look at the exact expansion
  if (ax.toFixed(n + 1).endsWith("5")) {
    const exact = ax.toFixed(Math.min(100, n + 80));
    const dot = exact.indexOf(".");
    const frac = exact.slice(dot + 1);
    if (frac[n] === "5" && /^0*$/.test(frac.slice(n + 1))) {
      const trunc = n > 0 ? exact.slice(0, dot + 1 + n) : exact.slice(0, dot);
      if (Number(trunc[trunc.length - 1]) % 2 === 0) s = trunc;
    }
  }
  return (neg ? "-" : "") + s;
}

/** Python round(x, n) (n given: float result) or round(x) (n omitted: int result, so no -0). */
export function pyRound(x: number, n?: number): number {
  if (!Number.isFinite(x)) return x;
  if (n === undefined) return Number(pyFormat(x, 0)) + 0;
  return Number(pyFormat(x, n));
}

/** Python builtin min(a, b) / max(a, b): the first argument wins unless the second compares smaller/larger. */
export const pyMin = (a: number, b: number): number => (b < a ? b : a);
export const pyMax = (a: number, b: number): number => (b > a ? b : a);

const DEG = 180 / Math.PI;
const degrees = (r: number): number => r * DEG; // np.degrees: x * (180 / pi)
const npClip = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);   // NaN propagates

/** numpy pairwise summation (add.reduce on a contiguous 1-D array). */
function npSum(a: Arr1, lo = 0, n = a.length - lo): number {
  if (n < 8) {
    let r = 0;
    for (let i = 0; i < n; i++) r += a[lo + i];
    return r;
  }
  if (n <= 128) {
    const r = a.slice(lo, lo + 8);
    let i = 8;
    for (; i < n - (n % 8); i += 8) for (let j = 0; j < 8; j++) r[j] += a[lo + i + j];
    let res = ((r[0] + r[1]) + (r[2] + r[3])) + ((r[4] + r[5]) + (r[6] + r[7]));
    for (; i < n; i++) res += a[lo + i];
    return res;
  }
  let n2 = Math.floor(n / 2);
  n2 -= n2 % 8;
  return npSum(a, lo, n2) + npSum(a, lo + n2, n - n2);
}
const npMean = (a: Arr1): number => npSum(a) / a.length;

/** np.argmax / np.argmin: the first NaN wins, else the first extreme. */
function npArgmax(a: Arr1): number {
  let bi = 0;
  for (let i = 0; i < a.length; i++) {
    if (Number.isNaN(a[i])) return i;
    if (a[i] > a[bi]) bi = i;
  }
  return bi;
}
function npArgmin(a: Arr1): number {
  let bi = 0;
  for (let i = 0; i < a.length; i++) {
    if (Number.isNaN(a[i])) return i;
    if (a[i] < a[bi]) bi = i;
  }
  return bi;
}

/** np.percentile(a, q), method "linear" (numpy's _lerp, which interpolates from the upper end for t >= 0.5). */
function npPercentile(a: Arr1, q: number): number {
  if (!a.length || a.some((v) => Number.isNaN(v))) return NaN;
  const s = a.slice().sort((x, y) => x - y);
  const vi = (s.length - 1) * (q / 100);
  const lo = Math.floor(vi), hi = Math.min(lo + 1, s.length - 1);
  const t = vi - lo, d = s[hi] - s[lo];
  return t >= 0.5 ? s[hi] - d * (1 - t) : s[lo] + d * t;
}
function npMedian(a: Arr1): number {
  if (!a.length || a.some((v) => Number.isNaN(v))) return NaN;
  const s = a.slice().sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const vsub = (a: number[], b: number[]): number[] => a.map((v, i) => v - b[i]);
const vdot = (a: number[], b: number[]): number => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};
const vnorm = (a: number[]): number => Math.sqrt(vdot(a, a));
/** kinematics.unit: v / max(|v|, 1e-9) */
const unitPy = (a: number[]): number[] => {
  const n = Math.max(vnorm(a), 1e-9);
  return a.map((v) => v / n);
};
/** kinematics.joint_angle per frame: angle at b between b->a and b->c, degrees. */
function jointAngle(a: Arr2, b: Arr2, c: Arr2): Arr1 {
  return a.map((_, t) => degrees(Math.acos(npClip(vdot(unitPy(vsub(a[t], b[t])), unitPy(vsub(c[t], b[t]))), -1, 1))));
}
const jnt = (A: Arr3, j: number): Arr2 => A.map((f) => f[j]);
/** WorldFrame.to_world for one vector: (forward, lateral, up) coordinates. */
const toWorld1 = (wf: WorldFrame, p: number[]): number[] => [vdot(wf.forward, p), vdot(wf.lateral, p), vdot(wf.up, p)];

// ------------------------------------------------------------------------------------------------------
// norms and rating bands (see docs/RESEARCH.md)
// ------------------------------------------------------------------------------------------------------
export type Band = [number | null, number | null];
export interface Norm {
  unit: string;
  good?: Band | null;   // absent = descriptive metric (rated "info")
  watch?: Band | null;
  risk?: Band | null;
  norm: string;
  ref: string;
}

export const NORMS: Record<string, Norm> = {
  // shown for reference only, never rated: on a rendered straight-armed delivery at 120 fps one camera read 12°
  elbow_extension: { unit: "deg",
    norm: "Legal bowlers: 0-10° (mean ~6°); ICC limit 15°",
    ref: "ICC Illegal Bowling Regulations; Ferdinands & Kersting 2005; King & Yeadon 2013" },
  front_knee_ffc: { unit: "deg", norm: "Elite men 164 ± 6° at FFC", ref: "Felton 2019" },
  front_knee_br: { unit: "deg", good: [160, null], watch: [140, 160], risk: null,
    norm: "Aim for 160° or straighter at release. Elite men average 167 ± 19°; a straighter front knee goes with faster bowling (r ≈ 0.4)",
    ref: "Felton 2019; Ramachandran 2024 meta-analysis" },
  front_knee_flexion: { unit: "deg", good: [null, 20], watch: [20, null], risk: null,
    norm: "Elite men flex 9 ± 11° after FFC (guide range)", ref: "Felton 2019" },
  back_knee_bfc: { unit: "deg", good: [156, null], watch: [146, 156], risk: [null, 146],
    norm: "Injured bowlers 146° vs uninjured 156° at BFC (rear hip/knee)",
    ref: "Alway et al. 2021 (prospective, MRI)" },
  trunk_forward_br: { unit: "deg", good: [30, null], watch: [15, 30], risk: null,
    norm: "Elite men ~42 ± 5° forward at release (guide range)", ref: "Felton 2019" },
  trunk_flexion_ffc_br: { unit: "deg", good: [25, null], watch: [15, 25], risk: null,
    norm: "Elite men flex the trunk 31 ± 8° from FFC to release", ref: "Felton 2019" },
  trunk_lateral_br: { unit: "deg", good: [null, 45], watch: [45, 50], risk: [50, null],
    norm: "Later-injured juniors 50 ± 6° vs uninjured 40 ± 8° (thorax lateral flexion at BR)",
    ref: "Bayne et al. 2016; contested in elite adults (Alway 2021)" },
  shoulder_alignment_bfc: { unit: "deg",
    norm: "180 = side-on, 270 = front-on; side-on < 210, semi-open 210-240, front-on > 240",
    ref: "Portus et al. 2004; elite men 232 ± 14 (Felton 2019)" },
  hip_shoulder_sep_bfc: { unit: "deg", good: [null, 20], watch: [20, 30], risk: [30, null],
    norm: ">= 30° at BFC classifies a mixed action", ref: "Portus et al. 2004" },
  shoulder_counter_rotation: { unit: "deg", good: [null, 30], watch: [30, 40], risk: [40, null],
    norm: ">= 30° is the common mixed-action criterion (stronger evidence in juniors)",
    ref: "Portus 2004; Elliott & Foster 1989; Ranson 2008; Alway 2021" },
  release_height_pct: { unit: "% height", good: [108, null], watch: [104, 108], risk: null,
    norm: "Elite men 113 ± 4% of standing height (guide range)", ref: "Felton 2019" },
  stride_length_pct: { unit: "% height", good: [70, 87], watch: [64, 93], risk: null,
    norm: "Elite men 79 ± 7% of standing height (guide range)", ref: "Felton 2019" },
  ffc_to_br_ms: { unit: "ms", good: [null, 140], watch: [140, null], risk: null,
    norm: "Elite men 103 ± 11 ms; juniors 126 ± 37 ms", ref: "Felton 2019; Andrews 2024" },
  bfc_to_ffc_ms: { unit: "ms", norm: "Elite men 192 ± 31 ms; juniors 197 ± 59 ms", ref: "Felton 2019; Andrews 2024" },
  arm_slot_br: { unit: "deg",
    norm: "Angle of the bowling arm from vertical at release (descriptive; higher slot often costs more side-bend)",
    ref: "descriptive" },
  head_offset_br: { unit: "cm", good: [null, 15], watch: [15, 30], risk: [30, null],
    norm: "Lateral distance of the head outside the front foot at release (heuristic; 'falling away')",
    ref: "coaching heuristic" },
  runup_speed: { unit: "m/s", norm: "Elite men 5.8 ± 0.6 m/s; juniors 5.8 ± 0.7; finger spinners 2.5 ± 0.5",
    ref: "Felton 2019; Andrews 2024; Sanders 2018" },
};

type Rating = Metric["rating"];

/** metrics._rate */
export function rate(key: string, value: number | null): Rating {
  const n = NORMS[key];
  if (value === null || n === undefined) return "info";
  const inside = (band: Band | null | undefined): boolean => {
    if (!band) return false;
    const [lo, hi] = band;
    return (lo === null || value >= lo) && (hi === null || value < hi);
  };
  if (n.good === undefined) return "info";
  if (inside(n.risk)) return "risk";
  if (inside(n.good)) return "good";
  if (inside(n.watch)) return "watch";
  return "watch";
}

type View = ViewInfo["view"];

export interface Ctx {
  P: Arr3;            // (T,17,3) camera axes, metres, root-relative
  W: Arr3;            // (T,17,3) world (forward, lateral, up) coordinates
  kp: Arr3;           // (T,17,2) COCO smoothed pixels
  kc: Arr2;           // (T,17)
  side: Side;
  wf: WorldFrame;
  view: View;
  fps: number;
  stature: number;
  k: Arr1;            // (T,) px per metre
  ev: Events;
  bone_lengths: Arr1;
  fps_unique?: number | null;   // distinct frames per real second (repeated frames add no information)
  oblique?: boolean;            // camera well off the pitch line: no plane-specific measurement is rated
}

/** Signed angle (deg) of image vector v (x right, y down) from image-up; + = towards image right. */
const imgAngleFromVertical = (v: number[]): number => degrees(Math.atan2(v[0], -v[1]));

/** Mean 2D keypoint confidence of `joints` over frames t-1..t+1, clipped to [0, 1]. */
function conf2d(c: Ctx, t: number, joints: number[]): number {
  const lo = Math.max(0, t - 1), hi = Math.min(c.kc.length, t + 2);
  // numpy lays kc[lo:hi][:, joints] out column-major and sums it pairwise
  const vals: number[] = [];
  for (const j of joints) for (let i = lo; i < hi; i++) vals.push(c.kc[i][j]);
  return npClip(npMean(vals), 0, 1);
}

export const VIEW_LABEL: Record<View, string> = { side_on: "side-on", behind: "behind the bowler", front_on: "front-on" };
// physically plausible ranges; estimates outside them are withheld rather than shown
export const PLAUSIBLE: Record<string, [number, number]> = {
  stride_length_pct: [35, 130], front_knee_ffc: [90, 185], front_knee_br: [90, 185],
  back_knee_bfc: [80, 185], release_height_pct: [70, 140], trunk_forward_br: [-30, 85],
  trunk_flexion_ffc_br: [-30, 85], trunk_lateral_br: [0, 75], elbow_extension: [0, 60],
  front_knee_flexion: [0, 70], head_offset_br: [0, 120], arm_slot_br: [0, 90],
  // projected-width alignment is very sensitive near front-on (arccos); withhold implausible readings
  hip_shoulder_sep_bfc: [0, 45], shoulder_counter_rotation: [0, 60], shoulder_alignment_bfc: [160, 300],
};

/** A metric as produced by compute (Metric plus the export-only fields). */
export type MetricDict = Metric & { estimate_3d?: number | null; min_frame?: number } & Record<string, unknown>;

export interface MetricOpts {
  event?: string | null;
  source?: string;
  confidence?: number;
  decimals?: number;
  explain?: string;
  extra?: Record<string, unknown> | null;
  needs?: readonly View[] | null;   // camera views in which this metric is measured reliably
  view?: View | "oblique" | null;
  minFps?: number | null;
  fps?: number | null;
  tolerance?: number;
}

/** metrics._metric. Outside `needs` the value is kept as a rough 3D estimate but not rated, not scored and not
 * used for coaching priorities. */
export function metric(key: string, label: string, value: number | null, o: MetricOpts = {}): MetricDict {
  const { event = null, source = "3d", confidence = 0.5, decimals = 1, explain = "", extra = null, needs = null,
    view = null, minFps = null, fps = null, tolerance = 0 } = o;
  const n: Partial<Norm> = NORMS[key] ?? {};
  let v: number | null = value === null || !Number.isFinite(value) ? null : pyRound(value, decimals);
  let rating: Rating = rate(key, v);
  if (tolerance && v !== null && (rating === "watch" || rating === "risk")) {
    // give the benefit of the measurement resolution (e.g. ± one frame for timings)
    const order: Record<string, number> = { good: 0, watch: 1, risk: 2 };
    const ord = (r: string) => order[r] ?? 3;
    const better = [rate(key, v - tolerance), rate(key, v + tolerance)];
    const best = ord(better[1]) < ord(better[0]) ? better[1] : better[0];
    if (ord(best) < ord(rating)) rating = best;
  }
  let reliability: "measured" | "estimate" = "measured";
  let note: string | null = null;
  let conf = npClip(confidence, 0, 1);
  let withheld: number | null = null;
  const outside = !!(needs && needs.length) && !needs!.includes(view as View);
  if (outside) {
    // The plane this metric lives in is not visible from this camera. Monocular 3D depth gives absolute angles
    // that can be far off (e.g. a 170° front knee read as 96° from behind), and nothing tells a good
    // estimate from a bad one, so the value is withheld (kept as estimate_3d in the JSON export).
    reliability = "estimate";
    const where = needs!.length === 3 ? "side-on or from behind the stumps" : needs!.map((x) => VIEW_LABEL[x]).join(" or ");
    note = (view === "oblique" ? "The camera is at an angle to the pitch, so this can't be measured reliably — film "
      : "Not measurable from this camera view — film ") + where + " to measure it.";
    rating = "unrated";
    conf = pyMin(conf, 0.3);
    [withheld, v] = [v, null];
    const lh = PLAUSIBLE[key];
    if (withheld !== null && lh && !(lh[0] <= withheld && withheld <= lh[1])) withheld = null;   // implausible: not even exported
  }
  if (minFps && fps !== null && fps < minFps) {
    reliability = "estimate";
    note = (note ? note + " " : "") + `Needs >= ${pyFormat(minFps, 0)} fps slow-motion for a reliable value.`;
    rating = "unrated";
    conf = pyMin(conf, 0.25);
  }
  const lh = PLAUSIBLE[key];
  if (v !== null && lh && !(lh[0] <= v && v <= lh[1])) {
    if (reliability === "estimate" || conf < 0.5) {
      note = outside ? "Not measurable from this camera view." : "Couldn't be measured reliably in this clip.";
      [v, rating, reliability, conf] = [null, "unrated", "estimate", pyMin(conf, 0.2)];
    }
  }
  if (v !== null && rating !== "unrated" && conf < 0.25) {
    rating = "unrated";
    reliability = "estimate";
    note = note || "Low tracking confidence around this event.";
  }
  const d: Record<string, unknown> = {
    key, label, value: v, unit: n.unit ?? "", event, source, confidence: pyRound(conf, 2), rating, reliability, note,
    needs_view: needs && needs.length ? [...needs] : null, norm: n.norm ?? null, ref: n.ref ?? null, explain,
  };
  if (extra && Object.keys(extra).length) Object.assign(d, extra);
  if (outside) d.estimate_3d = withheld;
  if (d.value === null) {   // nothing measured: drop what was derived from the number
    for (const k of ["technique", "action_type", "metres", "flexion_after_ffc", "extension_to_br", "min_frame"]) delete d[k];
  }
  return d as MetricDict;
}

// ------------------------------------------------------------------------------------------------------
// time series (used for charts and the per-frame inspector)
// ------------------------------------------------------------------------------------------------------
export type Series = Record<string, number[]>;

export function timeSeries(c: Ctx): Series {
  const { P, W, side: s, kp } = c;
  const up = c.wf.up;
  const tw = P.map((f) => toWorld1(c.wf, vsub(f[THORAX], f[PELVIS])));
  const fwdFlex = tw.map((v) => degrees(Math.atan2(v[0], v[2])));
  let latFlex = tw.map((v) => degrees(Math.atan2(v[1], v[2])));
  if (s.bowling_arm === "left") latFlex = latFlex.map((x) => -x);
  const sh = alignmentParts(c, "shoulder")[0];
  const hp = alignmentParts(c, "hip")[0];
  const minus180 = (a: Arr1) => a.map((x) => 180 - x);
  const out: Series = {
    elbow_flexion_bowling: minus180(jointAngle(jnt(P, s.shoulder), jnt(P, s.elbow), jnt(P, s.wrist))),
    elbow_flexion_front: minus180(jointAngle(jnt(P, s.front_shoulder), jnt(P, s.front_elbow), jnt(P, s.front_wrist))),
    knee_front: jointAngle(jnt(P, s.front_hip), jnt(P, s.front_knee), jnt(P, s.front_ankle)),
    knee_back: jointAngle(jnt(P, s.back_hip), jnt(P, s.back_knee), jnt(P, s.back_ankle)),
    trunk_forward_flexion: fwdFlex,
    trunk_lateral_flexion: latFlex,
    shoulder_alignment: sh,
    hip_alignment: hp,
    hip_shoulder_separation: sh.map((x, t) => x - hp[t]),
    bowling_arm_elevation: P.map((f) => degrees(Math.asin(npClip(vdot(unitPy(vsub(f[s.wrist], f[s.shoulder])), up), -1, 1)))),
    bowling_wrist_height_pct: W.map((f) => (100 * (f[s.wrist][2] - Math.min(f[s.front_ankle][2], f[s.back_ankle][2])
      + ANKLE_HEIGHT_FRAC * c.stature)) / c.stature),
    front_knee_2d: jointAngle(jnt(kp, s.c_fhip), jnt(kp, s.c_fkn), jnt(kp, s.c_fan)),
    elbow_flexion_2d: minus180(jointAngle(jnt(kp, s.c_sh), jnt(kp, s.c_el), jnt(kp, s.c_wr))),
    trunk_angle_2d: kp.map((f) => imgAngleFromVertical([
      (f[5][0] + f[6][0]) / 2 - (f[11][0] + f[12][0]) / 2, (f[5][1] + f[6][1]) / 2 - (f[11][1] + f[12][1]) / 2])),
  };
  for (const k of Object.keys(out)) out[k] = out[k].map((x) => pyRound(x, 2));
  return out;
}

export const alignmentSeries = (c: Ctx, which: "shoulder" | "hip"): Arr1 => alignmentParts(c, which)[0];

/** (angle from 2D width + 3D sign, the 3D model's own angle, out-of-image-plane angle phi), per frame.
 *
 * Transverse-plane orientation of the shoulder (or hip) line, Portus convention: 180° = side-on (line pointing
 * down the pitch), 270° = front-on. Bowling-arm independent. For behind/front views the angle is recovered from
 * the projected width (w = W cos(phi), phi = angle of the line out of the image plane) and only the sign comes
 * from 3D; for side views the projection gives the complementary angle. W = 3D segment length x image scale. */
export function alignmentParts(c: Ctx, which: "shoulder" | "hip"): [Arr1, Arr1, Arr1] {
  const s = c.side;
  const [a3, b3, a2, b2] = which === "shoulder"
    ? [s.front_shoulder, s.shoulder, s.c_fsh, s.c_sh]
    : [s.front_hip, s.back_hip, s.c_fhip, s.c_bhip];
  // 3D estimate: line from bowling-side joint to front-side joint, in the horizontal plane
  const sgn = s.bowling_arm === "right" ? 1 : -1;
  const theta3 = c.W.map((f) => {
    const v = vsub(f[a3], f[b3]);
    return npClip(180 + Math.abs(degrees(Math.atan2(v[1] * sgn, v[0]))), 180, 360);   // 0 = pointing forward
  });
  const w = c.kp.map((f) => vnorm(vsub(f[a2], f[b2])));
  // True line width in the 2D keypoints' own convention: the line swings through the image plane during a
  // delivery, so its widest (robust p95) projection is its length. The 3D model's joint distance can't be used:
  // its joints follow another convention (e.g. SAM 3D Body's hip joint centres are ~1/3 narrower than the 2D
  // hip keypoints, which pinned the hips at "front-on" and produced false 39° separations).
  const okIdx: number[] = [];
  c.kc.forEach((r, t) => { if (Math.min(r[a2], r[b2]) > 0.3) okIdx.push(t); });
  const wk = okIdx.length >= 5 ? okIdx.map((t) => w[t] / Math.max(c.k[t], 1e-6)) : [];
  const L = wk.length ? npPercentile(wk, 95) : npMedian(c.P.map((f) => vnorm(vsub(f[a3], f[b3]))));
  const phi = w.map((x, t) => degrees(Math.acos(npClip(x / Math.max(L * c.k[t], 1e-6), 0, 1))));   // out of the image plane
  const theta2 = phi.map((p, t) => c.view === "behind" || c.view === "front_on"
    // line in image plane = front-on (270), along depth = side-on (180); beyond front-on the 3D sign decides
    ? (theta3[t] > 270 ? 270 + p : 270 - p)
    // side camera: line in image plane = side-on; beyond front-on (> 270) the width shrinks again
    : (theta3[t] > 270 ? 360 - p : 180 + p));
  return [theta2, theta3, phi];
}

// ------------------------------------------------------------------------------------------------------
// event-locked metrics
// ------------------------------------------------------------------------------------------------------
const SIDE: readonly View[] = ["side_on"];
const REAR: readonly View[] = ["behind", "front_on"];
const SQUARE: readonly View[] = ["side_on", "behind", "front_on"];   // any view square to the pitch (only an angled camera is excluded)

/** Ball height at release from the image, scaled by the athlete's own body *at release*.
 *
 * At release the bowling arm is near-vertical and the front leg braced, so both lie close to the image plane in
 * side and rear views; their pixel lengths divided by anthropometric segment ratios (upper arm + forearm =
 * 0.332 H, thigh + shank = 0.491 H; Drillis & Contini 1966) give the stature in pixels right at that frame,
 * independent of camera zoom or the bowler's distance from the camera. */
/** metrics._leg_stature_px: stature in pixels from the front leg's longest projection around frame t
 * (thigh + shank = 0.491 H). */
export function legStaturePx(c: Ctx, t: number): number | null {
  const s = c.side, { kp, kc } = c;
  const lo = Math.max(0, t - 2), hi = Math.min(kp.length, t + 3);
  let total = 0.0;
  for (const [a, b] of [[s.c_fhip, s.c_fkn], [s.c_fkn, s.c_fan]]) {
    const lens: number[] = [];
    for (let u = lo; u < hi; u++) if (Math.min(kc[u][a], kc[u][b]) > 0.3) lens.push(vnorm(vsub(kp[u][a], kp[u][b])));
    if (!lens.length) return null;
    total += amax(lens);
  }
  return total / 0.491;
}

export function releaseHeight2d(c: Ctx): [number, string, number] | [null, null, null] {
  const s = c.side, br = c.ev.br, { kp, kc } = c;
  const lo = Math.max(0, br - 2), hi = Math.min(kp.length, br + 3);
  const seg = (a: number, b: number): number => {
    // the longest projection near release is the least foreshortened one
    const lens: number[] = [];
    for (let t = lo; t < hi; t++) if (Math.min(kc[t][a], kc[t][b]) > 0.3) lens.push(vnorm(vsub(kp[t][a], kp[t][b])));
    return lens.length ? amax(lens) : NaN;
  };
  const need = [s.c_sh, s.c_el, s.c_wr, s.c_fhip, s.c_fkn, s.c_fan];
  if (npMean(need.map((j) => kc[br][j])) < 0.35) return [null, null, null];
  const armPx = seg(s.c_sh, s.c_el) + seg(s.c_el, s.c_wr);
  const legPx = seg(s.c_fhip, s.c_fkn) + seg(s.c_fkn, s.c_fan);
  // the trunk (mid-shoulder to mid-hip = 0.288 H) averages both shoulders and both hips; side-on only, as its forward
  // lean at release runs along the camera axis from behind or in front and foreshortens it
  const trunks: number[] = [];
  for (let t = lo; t < hi; t++) {
    if (c.view === "side_on" && Math.min(kc[t][5], kc[t][6], kc[t][11], kc[t][12]) > 0.3) {
      const p = kp[t];
      trunks.push(Math.hypot((p[5][0] + p[6][0]) / 2 - (p[11][0] + p[12][0]) / 2, (p[5][1] + p[6][1]) / 2 - (p[11][1] + p[12][1]) / 2));
    }
  }
  const trunkPx = trunks.length ? amax(trunks) : NaN;
  const est = [armPx / 0.332, legPx / 0.491, trunkPx / 0.288].filter((x) => Number.isFinite(x));
  if (!est.length) return [null, null, null];
  // three independent scales: the median ignores the one a misplaced keypoint distorts (the shoulder drifting as the
  // arm passes over the head lengthens the arm); with fewer, the longest, as foreshortening only shortens segments
  const staturePx = est.length === 3 ? npMedian(est) : est.reduce(pyMax);
  const handY = kp[br][s.c_wr][1] + (kp[br][s.c_wr][1] - kp[br][s.c_el][1]) * 0.25;   // ball sits beyond the wrist
  const groundY = kp[br][s.c_fan][1] + ANKLE_HEIGHT_FRAC * staturePx;
  const pct = (100.0 * (groundY - handY)) / Math.max(staturePx, 1e-6);
  if (!(60 <= pct && pct <= 140)) return [null, null, null];
  const agree = est.length >= 2 ? est.reduce(pyMin) / est.reduce(pyMax) : 0.6;
  return [pct, "2d", 0.5 + 0.3 * agree];
}

export function compute(c: Ctx): { metrics: MetricDict[]; series: Series } {
  const { side: s, ev, fps, stature: H } = c;
  const ts = timeSeries(c);
  const view = c.view;
  const gate = c.oblique ? "oblique" as const : view;   // the view plane-specific metrics are checked against
  const sideView = view === "side_on";
  const rearView = view === "behind" || view === "front_on";
  // precision follows the distinct frames, timings the frame clock
  const fpsEff = c.fps_unique === null || c.fps_unique === undefined || c.fps_unique === 0 ? fps : c.fps_unique;
  const lowFps = fpsEff < 90;
  const metrics: MetricDict[] = [];
  const ms = 1000.0 / fps;
  const { bfc, ffc, uah, br } = ev;
  const evConf = (k: keyof Events["confidence"]) => ev.confidence[k] as number;

  // ---------------- timing ----------------
  const priorNote = "A foot contact was estimated (no clear foot-strike in this clip, or moved to keep the delivery "
    + "order). Drag the event marker to the exact frame, or confirm it in the 'At this frame' card, to measure this.";
  const guessedM = ["timing_prior", "constrained"];
  const isGuessed = (k: "bfc" | "ffc") => guessedM.includes(ev.method[k] as string);
  const estB = isGuessed("bfc"), estF = isGuessed("ffc");
  const resMs = 1000.0 / fpsEff;   // time resolution of the footage
  // From behind / in front, a foot travelling along the camera axis looks still in the image, so a detected "stop"
  // can precede the real foot strike by several frames. Timings are the most sensitive to that, so in these views
  // they are only rated once the user has confirmed the contact markers.
  const rearNote = "From behind or in front of the bowler the exact frame the foot lands is hard to see, so this "
    + "timing is an estimate. Check the contact frames: drag a marker to correct it, or confirm it in the 'At this "
    + "frame' card, to measure it.";
  const timingExtra = (...keys: ("bfc" | "ffc")[]) => {
    if (keys.some(isGuessed)) return { rating: "unrated", reliability: "estimate", note: priorNote, confidence: 0.25 };
    if (rearView && keys.some((k) => ev.method[k] !== "user"))
      return { rating: "unrated", reliability: "estimate", note: rearNote, confidence: 0.3 };
    return null;
  };
  if (bfc !== null && ffc !== null && ffc > bfc) {
    metrics.push(metric("bfc_to_ffc_ms", "Back-foot to front-foot contact", (ffc - bfc) * ms, {
      event: "bfc-ffc", source: "events", confidence: pyMin(evConf("bfc"), evConf("ffc")), decimals: 0,
      tolerance: resMs, explain: "Duration of the delivery stride. Reported ± one frame "
        + `(${pyFormat(resMs, 0)} ms for this footage).`,
      extra: timingExtra("bfc", "ffc") }));
  }
  if (ffc !== null && br > ffc) {
    metrics.push(metric("ffc_to_br_ms", "Front-foot contact to release", (br - ffc) * ms, {
      event: "ffc-br", source: "events", confidence: pyMin(evConf("ffc"), evConf("br")), decimals: 0,
      tolerance: resMs, explain: "How quickly you go from landing to letting the ball go. Shorter "
        + "(with a stable front leg) usually means better energy transfer.",
      extra: timingExtra("ffc") }));
  }

  // ---------------- elbow (ICC method) ----------------
  const flex = ts.elbow_flexion_bowling.map((x) => Math.max(x, 0.0));   // hyperextension floored at 0
  if (uah !== null && br > uah) {
    const win = flex.slice(uah, br + 1);
    const iMax = npArgmax(win);
    const ext = win[iMax] - amin(win.slice(iMax));
    let conf = lowFps ? 0.25 : 0.45;
    conf *= conf2d(c, br, [s.c_sh, s.c_el, s.c_wr]);
    // the shoulder keypoint drifts while the arm passes over the head: an upper arm far from its anatomical length
    // (0.186 H, Drillis & Contini) at UAH or release means the elbow angle there can't be trusted
    const legH = legStaturePx(c, br);
    if (legH) {
      const ua = [uah, br].map((t) => vnorm(vsub(c.kp[t][s.c_sh], c.kp[t][s.c_el])) / (0.186 * legH));
      if (!ua.every((x) => x >= 0.6 && x <= 1.25)) conf = pyMin(conf, 0.2);
    }
    metrics.push(metric("elbow_extension", "Elbow extension (UAH → release)", ext, {
      event: "uah-br", source: "3d", confidence: conf, needs: ["side_on"], view: gate, minFps: 100, fps: fpsEff,
      explain: "Straightening of the bowling elbow between the arm passing horizontal and release, computed "
        + "the ICC way (maximum flexion minus the following minimum). Shown for reference only, not rated: "
        + "a single camera can be several degrees out here, and it never replaces an accredited ICC test.",
      extra: { flexion_at_uah: pyRound(flex[uah], 1), flexion_at_br: pyRound(flex[br], 1),
        max_flexion: pyRound(amax(win), 1),
        precision_note: lowFps ? "insufficient precision below ~120 fps" : null } }));
    const last = metrics[metrics.length - 1];
    if (last.reliability === "estimate") {
      // a legality-adjacent number that can't be measured reliably is withheld, not shown greyed out
      let why: string;
      if (gate === "oblique") why = "The camera is at an angle to the pitch: elbow extension needs a square side-on clip at 120–240 fps";
      else if (view !== "side_on") why = "Elbow extension needs a side-on clip at 120–240 fps";
      else if (fpsEff < 100) why = `Elbow extension needs 120–240 fps slow motion (this clip has ~${pyFormat(fpsEff, 0)} distinct fps)`;
      else why = "The bowling arm wasn't tracked reliably around release (the shoulder is hidden as the arm "
        + "passes over the head, or motion blur)";
      Object.assign(last, { value: null, estimate_3d: null, flexion_at_uah: null, flexion_at_br: null, max_flexion: null,
        note: why + "; it isn't estimated from this video. Never a substitute for an accredited ICC test." });
    }
  }

  // ---------------- front leg ----------------
  const knee = sideView ? ts.front_knee_2d : ts.knee_front;
  const src = sideView ? "2d" : "3d";
  const kconf = sideView ? 0.8 : 0.3;
  if (ffc !== null && br > ffc) {
    const seg = knee.slice(ffc, br + 1);
    const kFfc = knee[ffc], kBr = knee[br], kMin = amin(seg);
    const iMin = ffc + npArgmin(seg);
    const flexion = kFfc - kMin;
    const extension = kBr - kMin;
    let tech: string;
    if (flexion >= 10 && extension < 10) tech = "Flexor";
    else if (flexion >= 10 && extension >= 10) tech = "Flexor-extender";
    else if (flexion < 10 && extension >= 10) tech = "Extender";
    else tech = "Constant brace";
    const legJ = [s.c_fhip, s.c_fkn, s.c_fan];
    const cf = kconf * pyMin(conf2d(c, ffc, legJ), conf2d(c, br, legJ));
    metrics.push(metric("front_knee_ffc", "Front knee at front-foot contact", kFfc, {
      event: "ffc", source: src, confidence: cf, explain: "180° = straight leg.", needs: SIDE, view: gate }));
    metrics.push(metric("front_knee_br", "Front knee at release", kBr, {
      event: "br", source: src, confidence: cf, needs: SIDE, view: gate,
      explain: "A straighter front leg at release acts as a lever and is associated with "
        + "higher ball speed; some flexion is normal and may reduce load.",
      extra: { flexion_after_ffc: pyRound(flexion, 1), extension_to_br: pyRound(extension, 1), min_frame: iMin } }));
    metrics.push(metric("front_knee_flexion", "Front knee bend after landing", flexion, {
      event: "ffc-br", source: src, confidence: cf, needs: SIDE, view: gate,
      explain: "Flexion of the front knee from landing to its most bent point. Together with "
        + "the extension to release it gives the front-leg technique (Portus et al. 2004).",
      extra: { technique: tech } }));
  }
  if (bfc !== null) {
    const bk = sideView ? jointAngle(jnt(c.kp, s.c_bhip), jnt(c.kp, s.c_bkn), jnt(c.kp, s.c_ban)) : ts.knee_back;
    metrics.push(metric("back_knee_bfc", "Back knee at back-foot contact", bk[bfc], {
      event: "bfc", source: sideView ? "2d" : "3d",
      confidence: sideView ? 0.7 * conf2d(c, bfc, [s.c_bhip, s.c_bkn, s.c_ban]) : 0.3, needs: SIDE, view: gate,
      explain: "A very flexed back leg at back-foot contact was one of the strongest "
        + "predictors of lumbar stress injury in a prospective elite study." }));
  }

  // ---------------- trunk ----------------
  const t2 = ts.trunk_angle_2d;
  let tfUse: Arr1, tsrc: string, tconf: number;
  if (sideView) {
    const f0 = c.wf.forward[0];
    const sign = Math.abs(f0) > 1e-3 ? Math.sign(f0) : 1.0;
    [tfUse, tsrc, tconf] = [t2.map((x) => x * sign), "2d", 0.75];
  } else {
    [tfUse, tsrc, tconf] = [ts.trunk_forward_flexion, "3d", 0.3];
  }
  const TRUNK = [5, 6, 11, 12];
  metrics.push(metric("trunk_forward_br", "Trunk forward flexion at release", tfUse[br], {
    event: "br", source: tsrc, confidence: tconf * conf2d(c, br, TRUNK), needs: SIDE, view: gate,
    explain: "How far the trunk is pitched towards the batter at release. Fast bowlers "
      + "flex strongly through the delivery stride. This is the lean at the moment of release; "
      + "'Trunk flexion FFC → release' is how much it bends during the stride." }));
  if (ffc !== null && br > ffc) {
    metrics.push(metric("trunk_flexion_ffc_br", "Trunk flexion FFC → release", tfUse[br] - tfUse[ffc], {
      event: "ffc-br", source: tsrc,
      confidence: tconf * 0.9 * pyMin(conf2d(c, ffc, TRUNK), conf2d(c, br, TRUNK)), needs: SIDE, view: gate,
      explain: "Trunk flexion produced during the delivery stride — a key contributor to ball speed." }));
  }
  let tl: Arr1, lsrc: string, lconf: number;
  if (rearView) {
    // image angle of the trunk from vertical, positive = leaning away from the bowling arm side
    let sign = s.bowling_arm === "right" ? 1.0 : -1.0;
    if (view === "front_on") sign = -sign;
    [tl, lsrc, lconf] = [t2.map((x) => -x * sign), "2d", 0.75];
  } else {
    [tl, lsrc, lconf] = [ts.trunk_lateral_flexion, "3d", 0.3];
  }
  metrics.push(metric("trunk_lateral_br", "Trunk side-bend at release", Math.abs(tl[br]), {
    event: "br", source: lsrc, confidence: lconf * conf2d(c, br, TRUNK), needs: REAR, view: gate,
    explain: "Lateral flexion of the trunk away from the bowling arm. Large side-bend "
      + "loads the lower back; it is one of the better single-camera measures from "
      + "behind the bowler." }));

  // ---------------- alignment / mixed action ----------------
  const sh = ts.shoulder_alignment, hp = ts.hip_alignment;
  let acon = rearView ? 0.45 : 0.3;
  if (bfc !== null) {
    acon *= conf2d(c, bfc, TRUNK);
    const th = sh[bfc];
    const action = th < 210 ? "side-on" : th <= 240 ? "semi-open" : "front-on";
    let sep = sh[bfc] - hp[bfc];
    let sepConf = 1.0;
    if (rearView) {
      // From behind/in front only the *size* of each line's out-of-plane angle is seen; which side of front-on it
      // lies comes from the 3D model. Near front-on that side is uncertain, and putting hips and shoulders on
      // opposite sides adds two small angles into a large, false separation (synthetic check: 39° read for a
      // true 0). Then use the same-side reading (the conservative one) at lower confidence.
      const [, s3, sPhi] = alignmentParts(c, "shoulder");
      const [, h3, hPhi] = alignmentParts(c, "hip");
      if ((s3[bfc] > 270) !== (h3[bfc] > 270) && pyMin(Math.abs(s3[bfc] - 270), Math.abs(h3[bfc] - 270)) < 20) {
        sep = s3[bfc] > 270 ? hPhi[bfc] - sPhi[bfc] : sPhi[bfc] - hPhi[bfc];
        sepConf = 0.6;
      }
    }
    const hi = ffc !== null && ffc > bfc ? ffc : pyMin(sh.length - 1, bfc + Math.trunc(0.2 * fps));
    const scr = th - amin(sh.slice(bfc, hi + 1));
    const mixed = (30 <= Math.abs(sep) && Math.abs(sep) <= 45) || (30 <= scr && scr <= 60);   // same gates as the metrics
    metrics.push(metric("shoulder_alignment_bfc", "Shoulder alignment at back-foot contact", th, {
      event: "bfc", source: "2d+3d", confidence: acon, needs: REAR, view: gate, explain: "180 = side-on, 270 = front-on.",
      extra: { action_type: mixed ? "mixed" : action } }));
    metrics.push(metric("hip_shoulder_sep_bfc", "Hip-shoulder separation at BFC", Math.abs(sep), {
      event: "bfc", source: "2d+3d", confidence: acon * 0.9 * sepConf, needs: REAR, view: gate,
      explain: "Misalignment between hips and shoulders when the back foot lands; large "
        + "values define a 'mixed' action, which twists the lower back." }));
    metrics.push(metric("shoulder_counter_rotation", "Shoulder counter-rotation", pyMax(scr, 0.0), {
      event: "bfc-ffc", source: "2d+3d", confidence: acon * 0.85, needs: REAR, view: gate,
      explain: "How much the shoulders rotate back towards side-on after back-foot contact." }));
  }

  // ---------------- release ----------------
  const W = c.W;
  let [relH, rhSrc, rhConf] = releaseHeight2d(c) as [number | null, string | null, number | null];
  if (relH === null) {
    const ground = pyMin(W[br][s.front_ankle][2], W[br][s.back_ankle][2]) - ANKLE_HEIGHT_FRAC * H;
    const armDir = unitPy(vsub(W[br][s.wrist], W[br][s.elbow]));
    const handH = W[br][s.wrist][2] + HAND_OFFSET_M * pyMax(armDir[2], 0.3);
    [relH, rhSrc, rhConf] = [(100 * (handH - ground)) / H, "3d", 0.35];
  }
  metrics.push(metric("release_height_pct", "Release height", relH, {
    event: "br", source: rhSrc as string, confidence: (rhConf as number) * conf2d(c, br, [s.c_wr, s.c_fan]),
    explain: "Height of the ball at release as a percentage of your height "
      + `(~${pyFormat((relH * H) / 100, 2)} m for a stature of ${pyFormat(H, 2)} m). Single-camera `
      + "precision is about ± 8 points.",
    extra: { metres: pyRound((relH * H) / 100, 2) }, needs: SQUARE, view: gate }));
  // arm slot: angle of shoulder->wrist from vertical in the frontal plane
  let slot: number, ssrc: string, sconf: number;
  if (rearView) {
    slot = Math.abs(imgAngleFromVertical(vsub(c.kp[br][s.c_wr], c.kp[br][s.c_sh])));
    [ssrc, sconf] = ["2d", 0.75];
  } else {
    const aw = vsub(W[br][s.wrist], W[br][s.shoulder]);
    slot = Math.abs(degrees(Math.atan2(aw[1], aw[2])));
    [ssrc, sconf] = ["3d", 0.35];
  }
  metrics.push(metric("arm_slot_br", "Arm slot at release", slot, {
    event: "br", source: ssrc, confidence: sconf * conf2d(c, br, [s.c_sh, s.c_wr]), needs: REAR, view: gate,
    explain: "0° = bowling arm straight up (high arm); larger = more round-arm." }));
  if (rearView) {
    const f = c.kp[br];
    const headX = c.kc[br][0] > 0.3 ? f[0][0] : (f[3][0] + f[4][0]) / 2;
    const footX = f[s.c_fan][0];
    const offM = Math.abs(headX - footX) / pyMax(c.k[br], 1e-6);
    metrics.push(metric("head_offset_br", "Head outside front foot at release", 100 * offM, {
      event: "br", source: "2d", confidence: 0.6 * conf2d(c, br, [s.c_fan, 3, 4]), decimals: 0,
      explain: "How far the head is laterally from the front foot at release. A head "
        + "falling outside the front foot ('falling away') costs accuracy and "
        + "increases side-bend.", needs: REAR, view: gate }));
  }
  // ---------------- stride ----------------
  if (ffc !== null) {
    let dx: number, stsrc: string, stconf: number;
    if (sideView) {
      dx = Math.abs(c.kp[ffc][s.c_fan][0] - c.kp[ffc][s.c_ban][0]) / pyMax(c.k[ffc], 1e-6);
      [stsrc, stconf] = ["2d", 0.7];
    } else {
      const d = vsub(W[ffc][s.front_ankle], W[ffc][s.back_ankle]);
      dx = Math.hypot(d[0], d[1]);
      [stsrc, stconf] = ["3d", 0.2];
    }
    metrics.push(metric("stride_length_pct", "Delivery stride length", (100 * dx) / H, {
      event: "ffc", source: stsrc, confidence: stconf * conf2d(c, ffc, [s.c_fan, s.c_ban]), needs: SIDE, view: gate,
      explain: "Distance between the ankles at front-foot contact.", extra: { metres: pyRound(dx, 2) } }));
  }
  // Values read at a contact that was only placed from typical timing are measured at a guessed frame: keep them
  // visible, but unrated and out of the score until the user confirms the event on the timeline.
  const guessed = new Set<string>([...(estB ? ["bfc"] : []), ...(estF ? ["ffc"] : [])]);
  for (const m of metrics) {
    if ((m.event || "").split("-").some((e) => guessed.has(e)) && m.rating !== "unrated") {
      Object.assign(m, { rating: "unrated", reliability: "estimate", confidence: pyMin(m.confidence, 0.25),
        note: m.note || priorNote });
    }
  }
  return { metrics, series: ts };
}
