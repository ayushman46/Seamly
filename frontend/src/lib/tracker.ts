/**
 * Ball tracking, end to end: from the frames of a clip and a few marks on the pitch to the ball's measured flight.
 * This file ties the pieces together and has no drawing or DOM in it, so the same code runs in the browser
 * (components/BallTracker.tsx hands it frames from the video) and in the tests (which hand it rendered frames).
 *
 *   marks on the pitch  ->  camera                    lib/camcal.ts
 *   frames              ->  camera movement, blobs    lib/ballfind.ts
 *   blobs + camera      ->  the ball, its shadow      lib/ballfind.ts, lib/balltrack.ts
 *   sightings + camera  ->  the flight, with +/-      lib/balltrack.ts
 *
 * From the bowling analysis it takes three things: the release frame, where the bowling hand is in that frame (the
 * flight has to start there), and where the front foot is (it is on the ground, so its place on the pitch is known,
 * and the hand lets go just behind it).
 */
import type { AnalysisResult } from "../types";
import { grayOf, motion, blobs, linkChains, findShadows, chain, invertShift, applyShift, STILL, type Shift, type Blob, type Gray, type Seen } from "./ballfind";
import { project, onPlaneY, solveCameraPoints, worldOf, isCamera, type Camera, type Pt, type Mark } from "./camcal";
import { fitBall, pickBall, isTracked, trackedAt, reproject, withCameraDoubt, type Tracked, type TrackProblem, type TrackPriors, type BallObs } from "./balltrack";
import { readDelivery, CREASE_Z, REACTION_S, type Read, type FlightPath } from "./flight";
import type { V3 } from "./biomech";

export interface FrameGetter {
  w: number; h: number;
  /** RGBA pixels of a video frame (by its index in the video), w x h. */
  get(frame: number): Promise<Uint8ClampedArray | Uint8Array>;
}

export interface PoseHints {
  releaseFrame: number;
  releaseTSigma?: number;          // how well the release frame is known, in frames (default 0.4)
  hand: Pt | null;                 // the ball in the bowling hand at the release frame (that frame's pixels)
  ankles: Pt[];                    // the front foot's ankle at the release frame (both ankles when it is not clear which)
  releaseHeight: number | null;    // metres, when the clip measured it
  time: (frame: number) => number; // real seconds (slow motion undone)
  fps: number;                     // real frames per second
  first: number; last: number;     // the frames of this shot (inclusive)
}

/** What the bowling analysis knows that the tracker needs, in the tracker's pixels (a picture `w` wide). */
export function poseHints(r: AnalysisResult, w: number): PoseHints | null {
  const br = r.events.br?.frame;
  if (br == null) return null;
  const k = w / (r.video.width * r.display_scale), t = br - r.frames.start;
  const kp = r.keypoints2d.xy[t], kc = r.keypoints2d.conf[t];
  if (!kp) return null;
  const right = r.bowling_arm.arm === "right", wi = right ? 10 : 9, ei = right ? 8 : 7;
  let hand: Pt | null = null;
  if (kc[wi] > 0.2) {
    const e = kc[ei] > 0.2 ? kp[ei] : kp[wi];
    hand = [(kp[wi][0] + 0.35 * (kp[wi][0] - e[0])) * k, (kp[wi][1] + 0.35 * (kp[wi][1] - e[1])) * k];
  }
  // the front foot is planted from landing to release: of the two ankles, the one that has moved less. (The back
  // foot is in the air by then, and a foot in the air cannot be placed on the pitch.)
  const before = r.keypoints2d.xy[Math.max(0, (r.events.ffc?.frame ?? br - Math.round(0.08 * (r.video.fps || r.fps))) - r.frames.start)] ?? kp;
  const seenA = [15, 16].filter((j) => kc[j] > 0.2);
  const moved = (j: number) => Math.hypot(kp[j][0] - before[j][0], kp[j][1] - before[j][1]);
  if (seenA.length === 2 && before !== kp) seenA.sort((a, b) => moved(a) - moved(b)).splice(1);
  const ankles = seenA.map((j): Pt => [kp[j][0] * k, kp[j][1] * k]);
  const rh = r.metrics?.find((m) => m.key === "release_height_pct");
  // The release height the bowling analysis measures is against the bowler's own height in the picture, which a
  // camera looking down the pitch from behind reads poorly (docs/ACCURACY.md 9c): it is not used here. The tracker
  // has a calibrated camera, and gets the height from the flight itself.
  void rh;
  const releaseHeight: number | null = null;
  const slow = Math.max(1, r.options.slowmo_factor || 1), fpsV = r.video.fps || r.fps;
  const t0 = r.frames.times[t] ?? br / fpsV;
  const shot = r.video.shots?.find((s) => br >= s.start && br < s.end) ?? { start: 0, end: r.video.frame_count };
  return {
    releaseFrame: br, hand, ankles, releaseHeight,
    time: (f) => { const i = f - r.frames.start; return (r.frames.times[i] ?? t0 + (f - br) / fpsV) / slow; },
    fps: r.fps_real || fpsV * slow, first: shot.start, last: shot.end - 1,
  };
}

export interface Cand { px: Pt; raw: Pt; blob: Blob }
export interface Scan {
  frames: number[];                 // the frames looked at, in order
  shifts: Map<number, Shift>;       // each frame laid over the marked frame (its pixels -> the marked frame's)
  cands: Map<number, Cand[]>;       // moving blobs per frame
  still: boolean;                   // the camera did not move
}

/** How many pixels a metre is, at its largest, around a point of the scene. */
function pxPerMetre(cam: Camera, p: V3): number {
  const o = project(cam, p), a = project(cam, [p[0] + 1, p[1], p[2]]), b = project(cam, [p[0], p[1] + 1, p[2]]), c = project(cam, [p[0], p[1], p[2] - 1]);
  if (!o) return 0;
  return Math.max(...[a, b, c].map((q) => (q ? Math.hypot(q[0] - o[0], q[1] - o[1]) : 0)));
}

/**
 * The frames a scan covers: from 0.7 s before the release the analysis found (it can have the moment wrong, and then
 * the ball is looked for on its own) until the ball has had time to reach the far end.
 */
export function scanFrames(markFrame: number, h: PoseHints): number[] {
  const perSec = 1 / Math.max(1e-6, h.time(h.releaseFrame + 1) - h.time(h.releaseFrame));   // video frames per real second
  const stride = Math.max(1, Math.round(perSec / 100));
  const want = Math.min(h.last, h.releaseFrame + Math.ceil(1.25 * perSec));
  const a = Math.max(h.first, Math.min(markFrame, h.releaseFrame - Math.ceil(0.7 * perSec))), b = Math.min(h.last, Math.max(markFrame, want));
  const out: number[] = [];
  // keep the marked frame and the release frame on the grid
  for (let f = h.releaseFrame; f >= a; f -= stride) out.push(f);
  out.reverse();
  for (let f = h.releaseFrame + stride; f <= b; f += stride) out.push(f);
  if (!out.includes(markFrame)) { out.push(markFrame); out.sort((p, q) => p - q); }
  return out;
}

/**
 * Go through the frames once: measure the camera's movement between them and collect the moving blobs. The heavy
 * part (a second or two for a 25 fps broadcast clip, longer for slow motion); everything after it is instant.
 */
export async function scan(getter: FrameGetter, cam: Camera, markFrame: number, h: PoseHints,
  onProgress?: (done: number, total: number) => void, cancelled?: () => boolean): Promise<Scan | null> {
  const frames = scanFrames(markFrame, h), n = frames.length, { w, h: hh } = getter;
  if (n < 5) return null;
  const fwd: Shift[] = [];
  const cands = new Map<number, Cand[]>();
  // the corridor above the pitch, in the marked frame
  const box: Pt[] = [];
  for (const x of [-2.4, 2.4]) for (const y of [0, 3.2]) for (const z of [2, -22]) { const p = project(cam, [x, y, z]); if (p) box.push(p); }
  if (box.length < 4) return null;
  const bx0 = Math.min(...box.map((p) => p[0])), bx1 = Math.max(...box.map((p) => p[0])), by0 = Math.min(...box.map((p) => p[1])), by1 = Math.max(...box.map((p) => p[1]));
  // One pass over the frames, holding three at a time: the camera's movement from each frame to the next, and the
  // blobs of the middle frame once both its neighbours are in hand. Blobs are looked for only in the corridor above
  // the pitch when the frame's place over the marked frame is already known (the usual case: the pitch was marked on
  // or before the release frame); otherwise over the whole frame, and sifted afterwards.
  const r = frames.indexOf(markFrame), toRef: (Shift | undefined)[] = new Array(n);
  toRef[r] = STILL;
  const startI = 1;
  const raw = new Map<number, Blob[]>(), matched: number[] = [];
  let prevG: Gray | null = null, prev: Uint8ClampedArray | Uint8Array | null = null, cur: Uint8ClampedArray | Uint8Array | null = null;
  for (let j = 0; j < frames.length; j++) {
    if (cancelled?.()) return null;
    const img = await getter.get(frames[j]), g = grayOf(img, w, hh);
    if (prevG) {
      const m = motion(prevG, g);
      // a cut to another camera: the picture no longer lines up with the one before it. Stop there.
      matched.push(m.matched);
      const usual = matched.slice(0, -1).sort((a, b) => a - b)[(matched.length - 1) >> 1] ?? m.matched;
      if (frames[j] > h.releaseFrame + 3 && (m.matched < 0.25 * usual || Math.abs(m.s - 1) > 0.2)) { frames.length = j; break; }
      fwd.push(m);
    }
    if (j > r && toRef[j - 1]) toRef[j] = chain(invertShift(fwd[j - 1]), toRef[j - 1]!);
    const i = j - 1;   // the middle frame, now that its next neighbour is here
    if (i >= startI && prev && cur) {
      const m = toRef[i];
      let roi;
      if (m) { const inv = invertShift(m), c1 = applyShift(inv, [bx0, by0]), c2 = applyShift(inv, [bx1, by1]); roi = { x0: c1[0], y0: c1[1], x1: c2[0], y1: c2[1] }; }
      raw.set(i, blobs(prev, cur, img, w, hh, invertShift(fwd[i - 1]), fwd[i], roi));
    }
    prev = cur; cur = img; prevG = g;
    onProgress?.(j + 1, n);
  }
  if (r >= frames.length || frames.length < 5) return null;   // the cut came before the marked frame
  for (let i = r - 1; i >= 0; i--) toRef[i] = chain(fwd[i], toRef[i + 1]!);
  const still = fwd.every((m) => Math.abs(m.s - 1) < 0.0015 && Math.hypot(m.dx, m.dy) < 1.0);
  if (still) toRef.fill(STILL);
  toRef.length = frames.length;
  for (const [i, bl] of raw) {
    const m = toRef[i]!;
    cands.set(frames[i], bl.map((b) => ({ px: applyShift(m, [b.x, b.y]), raw: [b.x, b.y] as Pt, blob: b }))
      .filter((c) => c.px[0] > bx0 && c.px[0] < bx1 && c.px[1] > by0 && c.px[1] < by1));
  }
  const shifts = new Map<number, Shift>();
  frames.forEach((f, i) => shifts.set(f, toRef[i]!));
  return { frames, shifts, cands, still };
}

export interface Upright { frame: number; foot: Pt; tip: Pt }   // something upright and the end of its shadow (that frame's pixels)
export interface Sighting { frame: number; px: Pt; shadow?: Pt | null; auto?: boolean }   // the ball in a frame (that frame's pixels)

export interface Priors { pri: TrackPriors; hand: Pt | null; handTol: number; foot: V3 | null }

/** What the fit is told about the release, and the sun: from the pose, the camera and the marked upright shadow. */
export function priorsOf(cam: Camera, h: PoseHints, shifts: Map<number, Shift>, upright?: Upright | null): Priors {
  const sr = shifts.get(h.releaseFrame) ?? STILL;
  // the front foot: the ankle further down the pitch, on the ground (the ankle joint is about 9 cm up)
  let foot: V3 | null = null, footSig = 0;
  for (const a of h.ankles) {
    const px = applyShift(sr, a), g = onPlaneY(cam, px, 0.09);
    if (!g || g[2] > 3 || g[2] < -6 || Math.abs(g[0]) > 3) continue;
    if (!foot || g[2] < foot[2]) {
      foot = g;
      const up = onPlaneY(cam, px, 0.14), dn = onPlaneY(cam, [px[0], px[1] + 4], 0.09);
      footSig = Math.hypot(up ? up[2] - g[2] : 0.3, dn ? dn[2] - g[2] : 0.3);
    }
  }
  // Where the hand lets go, along the pitch. Two things say: the Laws (the front foot lands at the popping crease,
  // 1.22 m in front of the stumps: nearly every ball is let go between 0.4 m and 1.4 m in front of them), and the
  // front foot the analysis found, when it lands somewhere a front foot can (the hand is about 15 cm behind it).
  let releaseZ = -0.9, zSigma = 0.45;
  if (foot && foot[2] > -2.0 && foot[2] < 0.2) {
    const zf = foot[2] + 0.15, sf = Math.hypot(0.35, Math.min(1, footSig)), w0 = 1 / (zSigma * zSigma), w1 = 1 / (sf * sf);
    releaseZ = (releaseZ * w0 + zf * w1) / (w0 + w1); zSigma = Math.sqrt(1 / (w0 + w1));
  } else foot = null;
  const pri: TrackPriors = { releaseT: h.time(h.releaseFrame), releaseZ, releaseZSigma: zSigma, releaseHeight: h.releaseHeight, releaseHeightSigma: 0.12, fps: h.fps, releaseTSigma: h.releaseTSigma };
  if (upright) {
    const su = shifts.get(upright.frame) ?? STILL;
    const A = onPlaneY(cam, applyShift(su, upright.foot), 0), B = onPlaneY(cam, applyShift(su, upright.tip), 0);
    if (A && B && Math.hypot(B[0] - A[0], B[2] - A[2]) > 0.15) pri.shadowDir = [B[0] - A[0], B[2] - A[2]];
  }
  const at: V3 = foot ? [foot[0], 2, releaseZ] : [0, 2, releaseZ];
  return { pri, hand: h.hand ? applyShift(sr, h.hand) : null, handTol: Math.max(30, 0.8 * pxPerMetre(cam, at)), foot };
}

const toObs = (s: Sighting[], shifts: Map<number, Shift>, h: PoseHints): BallObs[] => s.map((o) => {
  const m = shifts.get(o.frame) ?? STILL;
  return { t: h.time(o.frame), px: applyShift(m, o.px), shadow: o.shadow ? applyShift(m, o.shadow) : null, sigma: o.auto === false ? 2.5 : 1.5 };
});

/** Find the ball (and its shadow) on its own. Null when nothing in the frames makes a believable delivery. */
export function autoTrack(cam: Camera, sc: Scan, h: PoseHints, upright?: Upright | null, debug?: (line: string) => void): { sightings: Sighting[]; tracked: Tracked; hints: PoseHints } | null {
  const P = priorsOf(cam, h, sc.shifts, upright);
  const fs = sc.frames.filter((f) => sc.cands.has(f)), times = fs.map((f) => h.time(f));
  if (fs.length < 5) return null;
  const perFrame = (times[times.length - 1] - times[0]) / (fs.length - 1);
  const scale = Math.max(pxPerMetre(cam, [0, 1, -1]), pxPerMetre(cam, [0, 1, -19]), pxPerMetre(cam, [0, 1, -10]));
  const chains = linkChains(fs, times, fs.map((f) => sc.cands.get(f)!), { maxStep: scale * 50 * perFrame * 1.5, chains: 12 });
  debug?.(`release z ${P.pri.releaseZ.toFixed(2)} +/- ${P.pri.releaseZSigma?.toFixed(2)}, hand ${P.hand?.map((v) => v.toFixed(0))} tol ${P.handTol.toFixed(0)}, chains ${chains.map((c) => `${c.length}[${c[0].frame}-${c[c.length - 1].frame}]`).join(" ")}`);
  debug?.("CHAINS " + JSON.stringify(chains.map((c) => c.map((s) => [s.frame, Math.round(s.blob.x * 10) / 10, Math.round(s.blob.y * 10) / 10]))));
  // the first few of a chain can be the hand and arm at release, not the ball: they are several times its size
  const trimmed = chains.map((c) => {
    const areas = c.map((s) => s.blob.area).sort((a, b) => a - b), med = areas[areas.length >> 1];
    let k = 0;
    while (k < Math.min(5, c.length - 5) && c[k].blob.area > 2.5 * med) k++;
    // how much each sighting stands out: the ball is a strong, compact blob
    return c.slice(k).map((s) => ({ ...s, weight: 0.3 + Math.min(1, s.blob.peak / 200) * Math.min(1, s.blob.area / (s.blob.w * s.blob.h)) }));
  });
  // The flight should start at the bowling hand, at the release the analysis found. When nothing does (the analysis
  // can have the wrong arm or the wrong moment), the best flight from that release without the hand; and failing
  // that, the best flight anywhere after it, with the release taken from the ball itself.
  const cross = Math.max(18, 0.3 * scale);
  const pool = fs.flatMap((f) => sc.cands.get(f)!.map((c) => ({ frame: f, t: h.time(f), px: c.px, blob: c.blob, weight: 1 })));
  let pick = pickBall(cam, trimmed, P.pri, { hand: P.hand, handTol: P.handTol, crossPx: cross, budgetMs: 3000, pool, debug })
    ?? (P.hand ? pickBall(cam, trimmed, P.pri, { crossPx: cross, budgetMs: 1500, pool, debug }) : null);
  let hints = h;
  if (!pick) {
    pick = pickBall(cam, trimmed, { ...P.pri, releaseZ: -0.9, releaseZSigma: 0.45 }, { crossPx: cross, fromChain: true, budgetMs: 3000, pool, debug });
    if (pick) {
      // the frame nearest the release the ball implies; nothing else is taken from the pose
      const tRel = pick.pri.releaseT;
      const f = sc.frames.reduce((a, b) => (Math.abs(h.time(b) - tRel) < Math.abs(h.time(a) - tRel) ? b : a));
      hints = { ...h, releaseFrame: f, releaseTSigma: 1.5, hand: null, ankles: [], releaseHeight: null };
      debug?.(`release taken from the ball: frame ${f} (the analysis had ${h.releaseFrame})`);
    }
  }
  if (!pick) return null;
  const seen = pick.seen as Seen[];
  const heights = seen.map((s) => trackedAt(pick.tracked, s.t - pick.tracked.release.t)[1]);
  const shadows = findShadows(seen, heights, sc.cands, scale * 4.5);
  debug?.(`picked frames ${seen.map((x) => x.frame).join(",")}; heights ${heights.map((v) => v.toFixed(2)).join(",")}; shadows in ${shadows.filter(Boolean).length}`);
  const back = (f: number, p: Pt): Pt => applyShift(invertShift(sc.shifts.get(f) ?? STILL), p);
  const sightings: Sighting[] = seen.map((s, i) => ({ frame: s.frame, px: back(s.frame, s.px), shadow: shadows[i] ? back(s.frame, shadows[i]!) : null, auto: true }));
  const pri = priorsOf(cam, hints, sc.shifts, upright).pri;
  let kept = sightings, tr = fitBall(cam, toObs(kept, sc.shifts, hints), pri);
  // a sighting the finished flight passes well wide of is not the ball (its shadow for a frame where they part, say)
  for (let round = 0; round < 2 && isTracked(tr); round++) {
    const at = reproject(cam, tr, kept.map((s) => hints.time(s.frame))), lim = Math.max(3, 4 * tr.rmsPx);
    const good = kept.filter((s, i) => { const q = at[i], p = applyShift(sc.shifts.get(s.frame) ?? STILL, s.px); return !q || Math.hypot(q[0] - p[0], q[1] - p[1]) <= lim; });
    if (good.length === kept.length || good.length < 7) break;
    const again = fitBall(cam, toObs(good, sc.shifts, hints), pri);
    if (!isTracked(again)) break;
    kept = good; tr = again;
  }
  return { sightings: kept, tracked: isTracked(tr) ? tr : pick.tracked, hints };
}

/** Fit the flight to the sightings as they stand (after the user moved, added or removed some). */
export function refit(cam: Camera, sightings: Sighting[], shifts: Map<number, Shift>, h: PoseHints, upright?: Upright | null): Tracked | TrackProblem {
  return fitBall(cam, toObs(sightings, shifts, h), priorsOf(cam, h, shifts, upright).pri);
}

/**
 * The same fit with the camera's own doubt added to the error bars: the pitch marks are nudged by as much as they
 * disagree with the fitted camera (at least a pixel), the camera re-fitted, the flight re-fitted, a dozen times.
 */
export function withDoubt(tracked: Tracked, cam: Camera, marks: Mark[], sightings: Sighting[], shifts: Map<number, Shift>, h: PoseHints, upright?: Upright | null, trials = 12): Tracked {
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const sd = Math.max(1, cam.rms), alt: (Tracked | TrackProblem)[] = [];
  for (let k = 0; k < trials; k++) {
    const c = solveCameraPoints(marks.map((m) => ({ world: worldOf(m), px: [m.px[0] + sd * gauss(), m.px[1] + sd * gauss()] as Pt })), cam.w, cam.h, cam);
    if (isCamera(c)) alt.push(refit(c, sightings, shifts, h, upright));
  }
  return withCameraDoubt(tracked, alt);
}

/** What is kept with an analysis: the marks and sightings (enough to rebuild everything) and the headline figures. */
export interface TrackRecord {
  v: 1;
  w: number; h: number;
  markFrame: number;
  marks: Mark[];
  upright: Upright | null;
  sightings: Sighting[];
  shifts: [number, number, number, number][];   // frame, zoom, dx, dy
  release?: number | null;                      // the release frame, when it is not the bowling analysis's
  releaseSigma?: number | null;                 // how well it is known, frames (1.5 when it was taken from the ball)
  kmh: number; kmhSigma: number;
  length: number | null; line: number | null; swing: number; deviation: number | null;
  height: number | null; hitting: "hitting" | "missing" | "close" | null;
  rmsPx: number;
}
export function recordOf(cam: Camera, markFrame: number, marks: Mark[], upright: Upright | null, sightings: Sighting[], shifts: Map<number, Shift>, tr: Tracked, h: PoseHints): TrackRecord {
  const need = new Set<number>([markFrame, h.releaseFrame, ...sightings.map((s) => s.frame), ...(upright ? [upright.frame] : [])]);
  const r2 = (v: number) => Math.round(v * 100) / 100;
  return {
    v: 1, w: cam.w, h: cam.h, markFrame, marks, upright, sightings,
    shifts: [...shifts.entries()].map(([f, m]): [number, number, number, number] => [f, m.s, m.dx, m.dy]).filter(([f]) => need.has(f)),
    kmh: r2(tr.release.kmh.value), kmhSigma: r2(tr.release.kmh.sigma),
    length: tr.pitch ? r2(tr.pitch.length.value) : null, line: tr.pitch ? r2(tr.pitch.line.value) : null,
    swing: r2(tr.swing.value), deviation: tr.deviation ? r2(tr.deviation.value) : null,
    height: tr.stumps ? r2(tr.stumps.height.value) : null, hitting: tr.stumps?.hitting ?? null, rmsPx: r2(tr.rmsPx),
  };
}
export const shiftsOf = (rec: TrackRecord): Map<number, Shift> => new Map(rec.shifts.map(([f, s, dx, dy]) => [f, { s, dx, dy, matched: 0 }]));

/** Rebuild the camera and the flight from a kept record. */
export function fromRecord(rec: TrackRecord, r: AnalysisResult): { cam: Camera; tracked: Tracked; hints: PoseHints } | null {
  const cam = solveCameraPoints(rec.marks.map((m) => ({ world: worldOf(m), px: m.px })), rec.w, rec.h);
  let h = poseHints(r, rec.w);
  if (!isCamera(cam) || !h) return null;
  if (rec.release != null && rec.release !== h.releaseFrame) h = { ...h, releaseFrame: rec.release, releaseTSigma: rec.releaseSigma ?? undefined, hand: null, ankles: [], releaseHeight: null };
  const shifts = shiftsOf(rec), tr = refit(cam, rec.sightings, shifts, h, rec.upright);
  return isTracked(tr) ? { cam, tracked: withDoubt(tr, cam, rec.marks, rec.sightings, shifts, h, rec.upright), hints: h } : null;
}

/**
 * A tracked ball in the terms the batter's-eye view replays (lib/flight.ts Read): the measured flight itself, and,
 * for "what the release is worth", the flight model's answer for the same hand, pace and spot.
 */
export function trackedRead(tr: Tracked): Read | null {
  if (!tr.crease || tr.seconds === null) return null;
  const s = tr.samples, end = s[s.length - 1], speed = tr.release.kmh.value / 3.6;
  const atCrease = trackedAt(tr, tr.crease.t);
  const path: FlightPath = {
    samples: s, bounces: tr.pitch ? 1 : 0, swung: tr.swing.value,
    pitch: tr.pitch ? { t: tr.pitch.t, p: tr.pitch.p, speedIn: tr.pitch.kmhIn / 3.6, speedOut: tr.pitch.kmhOut / 3.6, angle: tr.pitch.angleIn } : null,
    crease: { t: tr.crease.t, p: atCrease, speed: tr.crease.kmh / 3.6 },
    stumps: tr.stumps ? { t: end.t, p: tr.stumps.p, speed: tr.crease.kmh / 3.6 } : null,
  };
  const like = tr.pitch ? readDelivery(tr.release.p, speed, { length: Math.max(0.4, tr.pitch.length.value), line: tr.stumps?.x.value ?? tr.pitch.line.value }, 0) : null;
  const before = trackedAt(tr, tr.crease.t - REACTION_S);
  return {
    launch: { from: tr.release.p, speed, elev: (-tr.release.down * Math.PI) / 180, azim: 0, swing: 0 }, path,
    down: tr.release.down, seconds: tr.seconds, arriveKmh: tr.crease.kmh, height: atCrease[1],
    atStumps: tr.stumps ? { height: tr.stumps.height.value, x: tr.stumps.x.value, hitting: tr.stumps.hitting === "hitting" } : null,
    commit: tr.crease.t > REACTION_S ? before[2] - CREASE_Z : null,
    perDegree: like?.perDegree ?? 0, perTen: like?.perTen ?? 0, window: like?.window ?? null,
  };
}
