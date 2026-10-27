import type { AnalysisResult, Insights, Metric, Player, Priority } from "../types";
import { coach } from "../engine/coaching";
import { rate } from "../engine/metrics";
import { backHealth, summary } from "../engine/insights";

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
  if (x < t[0] || x > t[t.length - 1]) return null;
  let i = 0;
  while (i + 1 < t.length && t[i + 1] < x) i++;
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
  return (c: number) => {
    let sum = 0, n = 0;
    for (let k = 0; k < 4; k++) {
      const x: number[] = [], y: number[] = [];
      for (let i = 0; i < A.t.length; i++) {
        const ta = A.t[i];
        if (ta < -0.5 || ta > 0.25 || A.f[k][i] === null) continue;
        const v = sample(B.t, B.f[k], ta + c);
        if (v === null) continue;
        x.push(A.f[k][i]!); y.push(v);
      }
      if (x.length >= 8) { sum += pearson(x, y); n++; }
    }
    return n >= 2 ? sum / n : -1;
  };
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

/** Distinct frames per real second (repeated frames add nothing). */
const distinctFps = (r: AnalysisResult) => r.fps_real * (1 - (r.quality.repeated_frames ?? 0));

const FOUND = (m: string | undefined) => !!m && m !== "timing_prior" && m !== "constrained";
const durMs = (r: AnalysisResult, k0: "bfc" | "ffc" | "uah", k1: "ffc" | "br") => {
  const a = r.events[k0], b = r.events[k1];
  if (!a || !b || !FOUND(a.method) || !FOUND(b.method)) return null;
  const s0 = sinceRelease(r, a.frame), s1 = sinceRelease(r, b.frame);
  return s0 === null || s1 === null ? null : (s1 - s0) * 1000;
};

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
  unseen: Record<Camera, Contact[]>;   // foot contacts each camera didn't see land (so the stride can't be compared)
}

/** Do the two clips look like the same delivery? The bowling arm must agree. A "match" needs a stride timing (back-foot
 * to front-foot contact, or front-foot contact to release) that both cameras found on the video, agreeing within one
 * frame of each clip; the arm's last phase (upper arm horizontal to release) is too short to tell balls apart, so it
 * can only show a mismatch (more than two frames of each clip apart). */
export function sameBall(side: AnalysisResult, rear: AnalysisResult): SameBall {
  const checks: SameBallCheck[] = [];
  const armA = side.bowling_arm.arm, armB = rear.bowling_arm.arm;
  checks.push({ label: "Bowling arm", a: armA, b: armB, ok: armA === armB });
  // one frame of each clip, plus a little for the time base
  const tol = 1000 / distinctFps(side) + 1000 / distinctFps(rear) + 5;
  let far = false, stride = 0;
  for (const [label, k0, k1, isStride] of [["Back-foot to front-foot contact", "bfc", "ffc", true], ["Front-foot contact to release", "ffc", "br", true],
    ["Upper arm horizontal to release", "uah", "br", false]] as const) {
    const a = durMs(side, k0, k1), b = durMs(rear, k0, k1);
    if (a === null || b === null) continue;
    const d = Math.abs(a - b), lim = isStride ? tol : 2 * tol;
    checks.push({ label, a: Math.round(a), b: Math.round(b), ok: d <= lim, tol: Math.round(lim) });
    if (d > 2 * tol) far = true;
    if (isStride && d <= tol) stride++;
  }
  const verdict = armA !== armB || far ? "mismatch" : stride > 0 && checks.every((c) => c.ok) ? "match" : "unsure";
  const unseen = (r: AnalysisResult) => (["bfc", "ffc"] as const).filter((k) => !FOUND(r.events[k]?.method));
  return { verdict, checks, unseen: { side: unseen(side), rear: unseen(rear) } };
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
}

/** The whole delivery from both cameras: the fused measurements, one score and coaching over all of them, and the
 * back-health screen with every check made on the camera that sees it. */
export function twoView(side: AnalysisResult, rear: AnalysisResult, player: Pick<Player, "age_group" | "style"> | null,
  original?: { side: AnalysisResult; rear: AnalysisResult }, sync?: Sync, carried?: SharedContacts): TwoView {
  const rows = fuseMetrics(side, rear);
  // a value read at a contact carried from the other camera is measured, but a red flag needs that contact confirmed on
  // its own clip: such a "risk" reads as "watch" (the contact can be a frame out, and the back knee reads a little low)
  for (const row of rows) {
    const set = row.from === "rear" ? carried?.rear : row.from === "side" ? carried?.side : undefined;
    const atCarried = (row.metric.event ?? "").split("-").some((e) => set && e in set);
    if (atCarried && row.metric.rating === "risk") {
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
    sync: sync ?? syncOffset(original?.side ?? side, original?.rear ?? rear) };
}
