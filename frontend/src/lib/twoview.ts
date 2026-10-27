import type { AnalysisResult, Insights, Metric, Player, Priority } from "../types";
import { coach } from "../engine/coaching";
import { rate } from "../engine/metrics";
import { backHealth, summary } from "../engine/insights";
import { SLOWMO_CHOICES } from "../engine/common";

/**
 * Two cameras, one ball: a side-on clip and a clip from behind (or in front of) the bowler of the same delivery,
 * from two ordinary phones that were never synchronised. The clips are lined up in real time at the release each
 * analysis found, and every measurement is taken from the camera that sees its plane (knees, trunk flexion and
 * stride side-on; side-bend and alignment from behind), so one delivery gets the whole action and the complete
 * back-health screen, which no single camera can give.
 */

export type Camera = "side" | "rear";

/** Which camera a clip is: square side-on, or square from behind / in front. Angled clips are neither. */
export function cameraOf(r: AnalysisResult): Camera | null {
  if (r.view.oblique) return null;
  return r.view.view === "side_on" ? "side" : r.view.view === "behind" || r.view.view === "front_on" ? "rear" : null;
}

/** Real seconds from this clip's release to frame f (slow motion divided back to real time). */
export function sinceRelease(r: AnalysisResult, f: number): number | null {
  const br = r.events.br?.frame;
  if (br == null) return null;
  const t = r.frames.times, f0 = r.frames.start;
  const i = Math.max(0, Math.min(t.length - 1, f - f0)), j = Math.max(0, Math.min(t.length - 1, br - f0));
  return (t[i] - t[j]) / Math.max(1, r.options.slowmo_factor || 1);
}

/** The frame of clip b at the same moment as frame fa of clip a, and whether b reaches that moment. The moment is real
 * time from each clip's release plus `offset` (seconds, from syncOffset: how much later b's timeline runs). */
export function alignFrame(a: AnalysisResult, fa: number, b: AnalysisResult, offset = 0): { frame: number; inside: boolean } {
  const t0 = sinceRelease(a, fa);
  const t = t0 === null ? null : t0 + offset;
  const f0 = b.frames.start, last = b.frames.end - 1;
  if (t === null || b.events.br?.frame == null) return { frame: f0, inside: false };
  let best = f0, bestD = Infinity;
  for (let f = f0; f <= last; f++) {
    const d = Math.abs((sinceRelease(b, f) ?? 0) - t);
    if (d < bestD) { bestD = d; best = f; }
  }
  // outside b's analysed window the nearest frame is its first or last one: say so rather than pretend (within half a
  // frame of one of b's frames is inside)
  const frameS = 1 / Math.max(1, b.fps_real || b.fps);
  return { frame: best, inside: bestD <= frameS / 2 + 1e-6 };
}

/** Four curves that look alike from the side and from behind, whichever limb is labelled left or right: the higher and
 * the lower wrist, and the higher and the lower ankle, each above the hips in torso lengths (so camera distance, zoom
 * and height don't matter), against real time from the clip's release. */
function motionCurves(r: AnalysisResult): { t: number[]; f: (number | null)[][] } {
  const t: number[] = [], f: (number | null)[][] = [[], [], [], []];
  if (!r.keypoints2d?.xy?.length) return { t, f };
  const kp = r.keypoints2d.xy, kc = r.keypoints2d.conf, f0 = r.frames.start;
  for (let i = 0; i < kp.length; i++) {
    const s = sinceRelease(r, f0 + i);
    if (s === null) continue;
    const p = kp[i], c = kc[i];
    t.push(s);
    const hip = (p[11][1] + p[12][1]) / 2, torso = Math.abs(hip - (p[5][1] + p[6][1]) / 2);
    const ok = (j: number) => c[j] >= 0.3 && Math.min(c[5], c[6], c[11], c[12]) >= 0.3 && torso > 1;
    const up = (j: number) => (ok(j) ? (hip - p[j][1]) / torso : null);
    const pair = (a: number, b: number) => { const x = up(a), y = up(b); return x === null || y === null ? [null, null] : [Math.max(x, y), Math.min(x, y)]; };
    const [wHi, wLo] = pair(9, 10), [aHi, aLo] = pair(15, 16);
    f[0].push(wHi); f[1].push(wLo); f[2].push(aHi); f[3].push(aLo);
  }
  return { t, f };
}

/** Linear interpolation of a curve at time x (null outside it or across a gap). */
function sample(t: number[], y: (number | null)[], x: number): number | null {
  if (!t.length || x < t[0] || x > t[t.length - 1]) return null;
  // the last time before x (binary search: the speed check samples a lot)
  let lo = 0, hi = t.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (t[m] < x) lo = m; else hi = m - 1; }
  const i = lo;
  if (i + 1 >= t.length) return y[i];
  const a = y[i], b = y[i + 1];
  if (a === null || b === null) return null;
  const w = (x - t[i]) / Math.max(1e-9, t[i + 1] - t[i]);
  return a + (b - a) * w;
}

function pearson(x: number[], y: number[]): number {
  const n = x.length, mx = x.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  return sxx > 1e-12 && syy > 1e-12 ? sxy / Math.sqrt(sxx * syy) : 0;
}

export interface Sync { offset: number; score: number; method: "motion" | "release" }

/** How well the two clips' motion curves match when the rear timeline runs c seconds later: the mean correlation over
 * the curves with enough frames in common (-1 when fewer than two do). */
export function syncScorer(side: AnalysisResult, rear: AnalysisResult): (c: number) => number {
  const A = motionCurves(side), B = motionCurves(rear);
  return (c: number) => matchScore(A, B, c, 1, 1);
}

type Curves = ReturnType<typeof motionCurves>;

/** The mean correlation of the curves when B runs c seconds later, with each clip's time divided by its stretch (a
 * clip whose time runs k times too long, slow motion played at normal speed, has stretch k). */
function matchScore(A: Curves, B: Curves, c: number, ka: number, kb: number): number {
  let sum = 0, n = 0;
  for (let k = 0; k < 4; k++) {
    const x: number[] = [], y: number[] = [];
    for (let i = 0; i < A.t.length; i++) {
      const ta = A.t[i] / ka;
      if (ta < -0.5 || ta > 0.25 || A.f[k][i] === null) continue;
      const v = sample(B.t, B.f[k], (ta + c) * kb);
      if (v === null) continue;
      x.push(A.f[k][i]!); y.push(v);
    }
    if (x.length >= 8) { sum += pearson(x, y); n++; }
  }
  return n >= 2 ? sum / n : -1;
}

/** How much later (seconds) the rear clip's timeline runs than the side clip's, both counted from their own release:
 * 0 if both releases were found on the same moment. Found by matching the four motion curves over the delivery stride
 * (half a second before release to a quarter after), so one clip's release a frame or two off doesn't throw the pair
 * out of step; kept at 0 (the releases) when the curves don't agree well enough to decide. */
export function syncOffset(side: AnalysisResult, rear: AnalysisResult): Sync {
  const score = syncScorer(side, rear);
  let best = 0, bestS = -Infinity;
  for (let c = -0.25; c <= 0.25 + 1e-9; c += 0.002) {
    const v = score(c);
    if (v > bestS) { bestS = v; best = c; }
  }
  const atRelease = score(0);
  // the motion decides only when it matches well, and better than lining up the releases does
  if (bestS >= 0.6 && bestS > atRelease + 0.01) return { offset: Math.round(best * 1000) / 1000, score: Math.round(bestS * 100) / 100, method: "motion" };
  return { offset: 0, score: Math.round(Math.max(atRelease, 0) * 100) / 100, method: "release" };
}

export interface SpeedFix {
  cam: Camera;           // the clip whose clip speed is wrong
  factor: number;        // the clip speed it should have (its current one times or divided by `ratio`)
  ratio: number;         // how many times longer the slower-looking clip's time runs than the other's
  timed: number;         // that ratio as measured (the stride's phases both clips timed, or the wrist's rise time)
  score: number;         // how well the motion matches with the time corrected (0–1), against `as_is` as the clips are
  as_is: number;
}

// phases long enough to time at 25–30 fps (a frame is a small part of them), from contacts and release each clip
// found itself
const LONG_PHASES = [["bfc", "br"], ["bfc", "ffc"], ["ffc", "br"]] as const;
// how fast the higher wrist rises towards release (torso lengths a real second): 13–51 on every real and rendered
// delivery tested, under 1 on slow motion analysed at normal speed (its last half-second before release is a
// fraction of the real swing, when the wrist is already near the top); far above 51, a real-time clip analysed as
// slow motion
const RISE_SLOW = 5, RISE_REAL = 10, RISE_FAST = 80;

/** The fastest the higher wrist rises, in torso lengths a second of the clip's real time, over the half-second before
 * release (to just after it). */
export function wristRise(r: AnalysisResult): number | null {
  const { t, f } = motionCurves(r);
  let top: number | null = null;
  for (let i = 1; i < t.length; i++) {
    const a = f[0][i - 1], b = f[0][i], dt = t[i] - t[i - 1];
    if (a === null || b === null || dt <= 0 || t[i] < -0.5 || t[i] > 0.1) continue;
    const v = (b - a) / dt;
    top = top === null ? v : Math.max(top, v);
  }
  // a wrist that never rises in that half-second says the release is misplaced, not that the clip is slow
  return top !== null && top > 0 ? top : null;
}

/** How long the higher wrist takes to climb from 20% to 80% of its rise to its highest point (seconds of the clip's
 * real time): for one ball, the same on both cameras, so its ratio is how many times too long one clip's time runs. */
export function wristRiseTime(r: AnalysisResult): number | null {
  const { t, f } = motionCurves(r);
  const cv = t.map((x, i) => [x, f[0][i]] as const).filter((p): p is readonly [number, number] => p[1] !== null);
  if (cv.length < 8) return null;
  let iPk = 0;
  for (let i = 1; i < cv.length; i++) if (cv[i][1] > cv[iPk][1]) iPk = i;
  const pk = cv[iPk][1];
  // back from the highest point to the bottom of the swing (until the wrist comes clearly back up)
  let j = iPk, lo = pk;
  while (j > 0 && cv[j - 1][1] <= lo + 0.15) { j--; lo = Math.min(lo, cv[j][1]); }
  if (pk - lo < 0.5) return null;
  const cross = (level: number) => {
    for (let i = iPk; i > j; i--) {
      const [ta, va] = cv[i - 1], [tb, vb] = cv[i];
      if (va <= level && level <= vb) return ta + ((level - va) / Math.max(1e-9, vb - va)) * (tb - ta);
    }
    return null;
  };
  const t20 = cross(lo + 0.2 * (pk - lo)), t80 = cross(lo + 0.8 * (pk - lo));
  return t20 === null || t80 === null || t80 <= t20 ? null : t80 - t20;
}

// phones film slow motion at 60, 120 or 240 fps and save it at the file's rate (30, or 24–25): from a 30 fps file 2x,
// 4x or 8x, from a 24 or 25 fps one 2x, 5x or 10x, are by far the likeliest factors
const CAPTURE_FPS = [60, 120, 240];
const nearest = (xs: number[], k: number) => xs.reduce((a, c) => (Math.abs(c - k) < Math.abs(a - k) ? c : a), xs[0]);
/** The clip-speed factor a measured ratio is, for a slow-motion file playing at `fileFps`: the nearest phone factor
 * within 25%, otherwise the nearest clip-speed choice within 15%, otherwise none (too unclear to guess). */
function snapFactor(k: number, fileFps: number): number | null {
  const choices = SLOWMO_CHOICES.filter((x) => x > 1);
  const phone = [...new Set(CAPTURE_FPS.map((c) => nearest(choices, c / Math.max(1, fileFps))))];
  const p = nearest(phone, k);
  if (Math.abs(k - p) / p <= 0.25) return p;
  const c = nearest(choices, k);
  return Math.abs(k - c) / c <= 0.15 ? c : null;
}

/** One clip's time running a whole number of times too long or too short: slow motion that the phone saved at
 * normal speed, or a clip speed set for both clips when only one phone filmed in slow motion. It takes two things
 * that agree. First, the clip's timing: every phase of the stride both clips timed is about the same whole number of
 * times longer on one of them; or, when the contacts weren't found (a clip at the wrong speed often hides them), one
 * clip's wrist rises to release far slower than any real bowler's while the other's is normal. Second, the movement:
 * the motion curves match with that clip's time shrunk by that factor, clearly better than as they are. The motion
 * alone isn't enough: a wrist's rise to release is one bump, and one bump still looks like another stretched. The fix
 * raises the slower clip's speed or lowers the faster one's (a speed shared by both clips at upload), whichever is
 * possible; when both are, the wrists decide, and when they don't, nothing is said. */
export function speedFix(side: AnalysisResult, rear: AnalysisResult): SpeedFix | null {
  const A = motionCurves(side), B = motionCurves(rear);
  if (A.t.length < 8 || B.t.length < 8) return null;
  const best = (ka: number, kb: number) => {
    let top = -Infinity, at = 0;
    for (let c = -0.25; c <= 0.25 + 1e-9; c += 0.005) { const v = matchScore(A, B, c, ka, kb); if (v > top) { top = v; at = c; } }
    for (let c = at - 0.005; c <= at + 0.005 + 1e-9; c += 0.001) top = Math.max(top, matchScore(A, B, c, ka, kb));
    return top;
  };
  const stretched = (slow: Camera, k: number) => (slow === "rear" ? best(1, k) : best(k, 1));
  const q: number[] = [];
  for (const [k0, k1] of LONG_PHASES) {
    const a = durMs(side, k0, k1), b = durMs(rear, k0, k1);
    if (a !== null && b !== null && a >= 60 && b >= 60) q.push(b / a);
  }
  let slow: Camera, k: number, timed: number | null = null;
  if (q.length) {
    const sorted = [...q].sort((x, y) => x - y);
    const med = sorted.length % 2 ? sorted[sorted.length >> 1] : Math.sqrt(sorted[sorted.length / 2 - 1] * sorted[sorted.length / 2]);
    slow = med >= 1 ? "rear" : "side";
    k = med >= 1 ? med : 1 / med;
    if (!q.every((x) => Math.abs((med >= 1 ? x : 1 / x) - k) / k <= 0.25)) return null;
    timed = Math.round(k * 100) / 100;
  } else {
    // no phase both timed: a wrist far slower than a bowler's says which clip, the wrist's rise time how much
    const rs = wristRise(side), rr = wristRise(rear);
    if (rs === null || rr === null) return null;
    if (rr < RISE_SLOW && rs >= RISE_REAL) slow = "rear";
    else if (rs < RISE_SLOW && rr >= RISE_REAL) slow = "side";
    else return null;
    const ts = wristRiseTime(side), tr = wristRiseTime(rear);
    if (ts === null || tr === null) return null;
    k = slow === "rear" ? tr / ts : ts / tr;
  }
  const snapped = k >= 1.6 ? snapFactor(k, (slow === "side" ? side : rear).fps) : null;
  if (snapped === null) return null;
  const ratio = snapped;
  const asIs = best(1, 1), score = stretched(slow, ratio);
  if (score < 0.5 || score < asIs + 0.1) return null;
  const clip = (c: Camera) => (c === "side" ? side : rear);
  const fast: Camera = slow === "side" ? "rear" : "side";
  const cur = (c: Camera) => Math.max(1, clip(c).options.slowmo_factor || 1);
  const lowered = cur(fast) / ratio, raised = cur(slow) * ratio;
  const valid = (f: number) => SLOWMO_CHOICES.some((x) => Math.abs(x - f) < 1e-6);
  const raise = valid(raised) ? { cam: slow, factor: raised } : null, lower = valid(lowered) ? { cam: fast, factor: lowered } : null;
  // the timing says only how the two clips' speeds compare: with both a lower speed on one and a higher on the other
  // possible, a wrist far slower than a bowler's says raise, far faster says lower, and otherwise it's too unclear
  const rSlow = wristRise(clip(slow)), rFast = wristRise(clip(fast));
  const fix = timed === null ? raise
    : raise && lower ? (rSlow !== null && rSlow < RISE_SLOW ? raise : rFast !== null && rFast > RISE_FAST ? lower : null)
      : raise ?? lower;
  if (!fix) return null;
  return { ...fix, ratio, timed: timed ?? Math.round(k * 100) / 100, score: Math.round(score * 100) / 100, as_is: Math.round(Math.max(asIs, 0) * 100) / 100 };
}

/** Distinct frames per real second (repeated frames add nothing). */
const distinctFps = (r: AnalysisResult) => r.fps_real * (1 - (r.quality.repeated_frames ?? 0));

const FOUND = (m: string | undefined) => !!m && m !== "timing_prior" && m !== "constrained";
function durMs(r: AnalysisResult, k0: "bfc" | "ffc" | "uah", k1: "ffc" | "br"): number | null {
  const a = r.events[k0], b = r.events[k1];
  if (!a || !b || !FOUND(a.method) || !FOUND(b.method)) return null;
  const s0 = sinceRelease(r, a.frame), s1 = sinceRelease(r, b.frame);
  return s0 === null || s1 === null ? null : (s1 - s0) * 1000;
}

export type Contact = "bfc" | "ffc";
export interface SharedContacts {
  side: Partial<Record<Contact, number>>;   // contacts to set on the side-on clip (frames), carried from the other
  rear: Partial<Record<Contact, number>>;
  from: Partial<Record<Contact, Camera>>;   // the camera that saw each contact
}

/** Foot contacts found on the video by one camera and only estimated by the other (side-on sees a foot land; from
 * behind, often only the back foot's stop): carried across at the same real time from release. Contacts the user set
 * on a clip are left alone; side-on wins when both cameras found one. */
export function sharedContacts(side: AnalysisResult, rear: AnalysisResult, offset = 0): SharedContacts {
  const out: SharedContacts = { side: {}, rear: {}, from: {} };
  for (const k of ["bfc", "ffc"] as const) {
    const s = side.events[k], r = rear.events[k];
    const sFound = !!s && FOUND(s.method), rFound = !!r && FOUND(r.method);
    if (sFound) out.from[k] = "side"; else if (rFound) out.from[k] = "rear";
    if (sFound && !rFound && r?.method !== "user") {
      const a = alignFrame(side, s!.frame, rear, offset);
      if (a.inside) out.rear[k] = a.frame;
    } else if (rFound && !sFound && s?.method !== "user") {
      const a = alignFrame(rear, r!.frame, side, -offset);
      if (a.inside) out.side[k] = a.frame;
    }
  }
  // a carried contact must keep the delivery's order on the clip that receives it, against what stays fixed there (contacts
  // found or set by the user, and release; estimated ones are placed again around it): a contact that can't is dropped
  for (const cam of ["side", "rear"] as const) {
    const r = cam === "side" ? side : rear, set = out[cam];
    const fixed = (k: "bfc" | "ffc" | "br") => {
      if (k !== "br" && set[k] !== undefined) return set[k]!;
      const e = r.events[k];
      return e && (k === "br" || FOUND(e.method)) ? e.frame : null;
    };
    const br = fixed("br");
    if (set.bfc !== undefined && ((br !== null && set.bfc >= br) || (fixed("ffc") !== null && set.bfc >= fixed("ffc")!))) delete set.bfc;
    if (set.ffc !== undefined && ((br !== null && set.ffc >= br) || (fixed("bfc") !== null && set.ffc <= fixed("bfc")!))) delete set.ffc;
  }
  return out;
}

export interface SameBallCheck { label: string; a: number | string; b: number | string; ok: boolean; tol?: number }
export interface SameBall {
  verdict: "match" | "unsure" | "mismatch"; checks: SameBallCheck[];
  coarse: boolean;                     // frames too far apart (e.g. 60 and 30 fps, or both 30) for the stride's timing to tell balls apart
  unseen: Record<Camera, Contact[]>;   // foot contacts each camera didn't see land (so the stride can't be compared)
}

/** Do the two clips look like the same delivery? The bowling arm must agree. A "match" needs a stride timing (back-foot
 * to front-foot contact, or front-foot contact to release) that both cameras found on the video, agreeing within one
 * frame of each clip, and frames close enough for that to mean something (both at 60 fps, or one in slow motion); more than
 * two frames apart is a mismatch. The arm's last phase (upper arm horizontal to release)
 * isn't compared: it's a frame or two long, and from behind or in front the upper arm's moment is often misread (on
 * two of six test clips by over 100 ms), which called the same ball two. */
export function sameBall(side: AnalysisResult, rear: AnalysisResult): SameBall {
  const checks: SameBallCheck[] = [];
  const armA = side.bowling_arm.arm, armB = rear.bowling_arm.arm;
  checks.push({ label: "Bowling arm", a: armA, b: armB, ok: armA === armB });
  // one frame of each clip, plus a little for the time base
  const tol = 1000 / distinctFps(side) + 1000 / distinctFps(rear) + 5;
  let far = false, stride = 0;
  for (const [label, k0, k1] of [["Back-foot to front-foot contact", "bfc", "ffc"], ["Front-foot contact to release", "ffc", "br"]] as const) {
    const a = durMs(side, k0, k1), b = durMs(rear, k0, k1);
    if (a === null || b === null) continue;
    const d = Math.abs(a - b);
    checks.push({ label, a: Math.round(a), b: Math.round(b), ok: d <= tol, tol: Math.round(tol) });
    if (d > 2 * tol) far = true;
    if (d <= tol) stride++;
  }
  // at 25–30 fps a frame each is ~75 ms, wider than most bowlers' strides differ by: agreeing then says little (one
  // phone in slow motion, 120 fps or more, with the other at 30 is fine)
  const coarse = tol > 50;
  const verdict = armA !== armB || far ? "mismatch" : stride > 0 && !coarse && checks.every((c) => c.ok) ? "match" : "unsure";
  const unseen = (r: AnalysisResult) => (["bfc", "ffc"] as const).filter((k) => !FOUND(r.events[k]?.method));
  return { verdict, checks, coarse, unseen: { side: unseen(side), rear: unseen(rear) } };
}

// how far two readings may differ and still be averaged (about each one's precision): degrees, % of height
const AGREE: Record<string, number> = { deg: 10, "% height": 12 };
// each camera's measured error on a reading both make (docs/ACCURACY.md: release height 7.4 points mean error side-on,
// 5.4 from behind): agreeing readings are weighted by 1/error², and when they disagree the better camera's is used
const ERROR: Record<string, Record<Camera, number>> = { release_height_pct: { side: 7.4, rear: 5.4 } };
const better = (key: string): Camera | undefined => (ERROR[key] ? (ERROR[key].rear < ERROR[key].side ? "rear" : "side") : undefined);

export interface FusedRow {
  key: string; label: string; unit: string; metric: Metric;
  from: Camera | "both";        // "both": the mean of the two cameras' readings
  other: Metric | null;          // the same measurement from the other camera, when it measures it too
}

/** A metric this camera measures: rated, and this camera's view is one it needs (or it needs none in particular). */
const measures = (r: AnalysisResult, m: Metric | undefined): m is Metric =>
  !!m && m.value !== null && m.rating !== "unrated" && m.reliability === "measured"
  && (!m.needs_view || m.needs_view.includes(r.view.view)) && !r.view.oblique;

/** Every measurement from the camera that sees it. Measured by both: timings from the clip with more distinct frames
 * a second; the rest averaged when the two agree, otherwise from the camera that measures it better (or the more
 * confident reading); the other reading is kept to compare. */
export function fuseMetrics(side: AnalysisResult, rear: AnalysisResult): FusedRow[] {
  const bySide = new Map(side.metrics.map((m) => [m.key, m])), byRear = new Map(rear.metrics.map((m) => [m.key, m]));
  const keys = [...new Set([...side.metrics.map((m) => m.key), ...rear.metrics.map((m) => m.key)])];
  const rows: FusedRow[] = [];
  for (const key of keys) {
    const s = bySide.get(key), r = byRear.get(key);
    const sOk = measures(side, s), rOk = measures(rear, r);
    if (!sOk && !rOk) continue;
    let from: Camera;
    if (sOk && rOk) {
      if (s!.unit === "ms") from = distinctFps(rear) > distinctFps(side) ? "rear" : "side";
      else from = better(key) ?? (r!.confidence > s!.confidence ? "rear" : "side");
    } else from = sOk ? "side" : "rear";
    let metric = from === "side" ? s! : r!;
    const other = from === "side" ? (rOk ? r! : null) : (sOk ? s! : null);
    // two independent readings that agree within their precision: their confidence-weighted mean is better than either
    const agree = AGREE[metric.unit];
    let both = false;
    if (other && agree !== undefined && Math.abs(metric.value! - other.value!) <= agree) {
      // the chosen reading and the other one, weighted by each camera's measured error (or by confidence without one)
      const e = ERROR[key], camOther: Camera = from === "side" ? "rear" : "side";
      const w1 = e ? 1 / e[from as Camera] ** 2 : metric.confidence, w2 = e ? 1 / e[camOther] ** 2 : other.confidence;
      const v = Math.round(((metric.value! * w1 + other.value! * w2) / (w1 + w2)) * 10) / 10;
      metric = { ...metric, value: v, rating: rate(key, v), confidence: Math.max(w1, w2), source: "both cameras" };
      both = true;
    }
    rows.push({ key, label: metric.label, unit: metric.unit, metric, from: both ? "both" : from, other });
  }
  return rows;
}

export interface TwoView {
  rows: FusedRow[];
  score: number | null;
  grade: string | null;
  priorities: Priority[];
  strengths: string[];
  summary: Insights["summary"];
  back: Insights["back_health"];
  backFrom: Record<string, Camera | "both" | null>;   // the camera each back-health check was measured on
  same: SameBall;
  sync: Sync;                                  // how the two clips are lined up in time
  speed: SpeedFix | null;                      // one clip's clip speed looks wrong (its time runs a whole number of times off)
}

/** The whole delivery from both cameras: the fused measurements, one score and coaching over all of them, and the
 * back-health screen with every check made on the camera that sees it. */
export function twoView(side: AnalysisResult, rear: AnalysisResult, player: Pick<Player, "age_group" | "style"> | null,
  original?: { side: AnalysisResult; rear: AnalysisResult }, sync?: Sync, carried?: SharedContacts, speed?: SpeedFix | null): TwoView {
  const rows = fuseMetrics(side, rear);
  // a value read at a contact carried from the other camera is measured, but a red flag needs that contact confirmed on
  // its own clip: such a "risk" reads as "watch" (the contact can be a frame out, and the back knee reads a little low)
  const softened = new Set<string>();
  for (const row of rows) {
    const set = row.from === "rear" ? carried?.rear : row.from === "side" ? carried?.side : undefined;
    const atCarried = (row.metric.event ?? "").split("-").some((e) => set && e in set);
    if (atCarried && row.metric.rating === "risk") {
      softened.add(row.key);
      row.metric = { ...row.metric, rating: "watch",
        note: `Measured at a foot contact taken from the ${row.from === "side" ? "camera behind" : "side-on camera"}; confirm the contact on this clip before treating it as a red flag.` };
    }
  }
  const metrics = rows.map((r) => r.metric);
  // timing precision follows the slower camera's distinct frame rate
  const fps = Math.min(distinctFps(side), distinctFps(rear));
  const c = coach(metrics as unknown as Parameters<typeof coach>[0], "two_cameras", fps);
  const coachingIn = { score: c.score, grade: c.grade, priorities: c.priorities as unknown as Priority[], strengths: c.strengths };
  const ins = { coaching: coachingIn, view: { view: "two_cameras" }, fps_real: fps, metrics };
  const pl = player ? { age_group: player.age_group, style: player.style } : null;
  const back = backHealth(ins as unknown as Parameters<typeof backHealth>[0], pl) as Insights["back_health"];
  const fromOf = (key: string) => rows.find((r) => r.key === key)?.from ?? null;
  const backFrom: Record<string, Camera | "both" | null> = {
    side_bend: fromOf("trunk_lateral_br"),
    mixed_action: fromOf("hip_shoulder_sep_bfc") ?? fromOf("shoulder_counter_rotation"),
    back_knee: fromOf("back_knee_bfc"),
  };
  // a check that would be a red flag but rests on a carried contact says so (the generic "watch" text would understate it)
  const checkKeys: Record<string, string[]> = { side_bend: ["trunk_lateral_br"], mixed_action: ["hip_shoulder_sep_bfc", "shoulder_counter_rotation"], back_knee: ["back_knee_bfc"] };
  for (const ch of back?.checks ?? []) {
    if (!checkKeys[ch.key]?.some((k) => softened.has(k))) continue;
    const src = checkKeys[ch.key].map((k) => rows.find((r) => r.key === k)).find((r) => r && softened.has(r.key));
    ch.text = `In the range linked to back injury, but measured at a foot contact taken from the ${src?.from === "side" ? "camera behind" : "side-on camera"}: `
      + `check that contact on the ${src?.from === "side" ? "side-on" : "other"} clip (drag its marker if it's off) before treating this as a red flag.`;
  }
  // a check neither camera could make gives the reason from the camera that should make it, not a generic "film from behind"
  if (back) {
    const reasonOf: Record<string, [AnalysisResult, string[]]> = {
      side_bend: [rear, ["trunk_lateral_br"]], mixed_action: [rear, ["hip_shoulder_sep_bfc", "shoulder_counter_rotation"]], back_knee: [side, ["back_knee_bfc"]],
    };
    const camWord = (r: AnalysisResult) => (r === side ? "Side-on" : r.view.view === "front_on" ? "From in front" : "From behind");
    for (const ch of back.checks) {
      if (ch.status !== "unknown" || !reasonOf[ch.key]) continue;
      const [r, keys] = reasonOf[ch.key];
      const note = keys.map((k) => r.metrics.find((m) => m.key === k)?.note).find((n) => !!n);
      ch.text = `${camWord(r)}: ${note ? note.charAt(0).toLowerCase() + note.slice(1) : "couldn't be measured on this clip."}`;
    }
  }
  const sum = summary(ins as unknown as Parameters<typeof summary>[0], pl) as Insights["summary"];
  // both cameras are already here: what's left to unlock is the frame rate
  sum.unlock = fps < 90 ? ["Use slow motion (120–240 fps) on both phones to time release and foot contacts precisely."] : [];
  return { rows, score: c.score, grade: c.grade, priorities: coachingIn.priorities, strengths: c.strengths, summary: sum, back, backFrom,
    // the same-ball check compares what each camera found by itself, before any contact was carried across
    same: sameBall(original?.side ?? side, original?.rear ?? rear),
    sync: sync ?? syncOffset(original?.side ?? side, original?.rear ?? rear),
    speed: speed !== undefined ? speed : speedFix(original?.side ?? side, original?.rear ?? rear) };
}
