/**
 * The camera, found without anyone marking anything. Three ways of finding the pitch are tried on the clip's own
 * frames, and every answer is then checked against the bowler before it is believed:
 *
 *   1. the whole crease pattern, both ends, on its own (lib/autopitch.ts): when a high or long-lens camera shows it;
 *   2. the creases at the bowler's end alone (the bowling crease, the popping crease and the two return creases),
 *      found around the bowler's wicket (lib/stumpfind.ts) or around the bowler's own feet. This end is always the
 *      one that can be read, and it is where the bowler is measured: a camera from these four lines places a hand
 *      above them to within a centimetre (tests/onpitch.test.ts), whatever it makes of the far end;
 *   3. the two wickets alone, when there is no paint to hold on to: a much shorter ruler, so a much wider doubt.
 *
 * On a tripod the bowler is first taken out of the picture (the middle value of each pixel over frames spread through
 * the clip, leaving out the bowler's own box), so nothing hides a stump or a crease. A camera that moves is followed
 * frame by frame. The check: under the right camera the bowler is a person's height, lets go at a bowler's height,
 * and lands by the crease. A camera that makes the bowler three metres tall, or lands them in the outfield, is wrong
 * however well it fits the paint.
 */
import type { AnalysisResult } from "../types";
import { solveCameraPoints, isCamera, worldOf, project, STUMP_TOP, PITCH_LEN, type Camera, type Mark } from "./camcal";
import { findPitch, pitchFound, findNearCreases } from "./autopitch";
import { findWickets, pairWickets, type Wicket } from "./stumpfind";
import { grayOf, motion, chain, invertShift, applyShift, STILL, type Gray, type Shift } from "./ballfind";
import { measureOnPitch, type FrameShifts, type OnPitch } from "./onpitch";

export type AutoHow = "creases" | "near creases" | "stumps+creases" | "stumps";
export interface AutoCam { w: number; h: number; markFrame: number; marks: Mark[]; how: AutoHow; tapPx: number; shifts: FrameShifts;
  far: Mark[] | null }   // far: the batter's wicket, when it was found where this camera expects it (for following the ball to that end)
export interface FrameReader { w: number; h: number; get: (frame: number) => Promise<Uint8ClampedArray> }

/** Is this the measurement of a bowler? (Generous bounds: they are there to throw out wrong cameras, not odd actions.) */
export function believable(o: OnPitch | null): boolean {
  if (!o || !o.release || !(o.back || o.front)) return false;
  const h = o.release.height.value;
  if (h < 1.3 || h > 2.8 || Math.abs(o.release.across.value) > 2.6) return false;
  if (o.stature && (o.stature.value < 1.35 || o.stature.value > 2.15 || h / o.stature.value < 0.88 || h / o.stature.value > 1.32)) return false;
  if (o.back && (Math.abs(o.back.heel[0]) > 2.4 || o.back.heel[2] < -1.9 || o.back.heel[2] > 2.8)) return false;
  if (o.front && (Math.abs(o.front.heel[0]) > 2.4 || o.front.heel[2] < -3.2 || o.front.heel[2] > 0.5)) return false;
  return true;
}

/** How the camera moved: every sampled frame's place over the frame `ref`, and whether it moved at all. */
export function register(grays: Gray[], frames: number[], ref: number): { toRef: Shift[]; moved: boolean } {
  const fwd: Shift[] = [];
  for (let j = 1; j < frames.length; j++) fwd.push(motion(grays[j - 1], grays[j]));
  const toRef: Shift[] = new Array(frames.length);
  toRef[ref] = STILL;
  for (let j = ref + 1; j < frames.length; j++) toRef[j] = chain(invertShift(fwd[j - 1]), toRef[j - 1]);
  for (let j = ref - 1; j >= 0; j--) toRef[j] = chain(fwd[j], toRef[j + 1]);
  return { toRef, moved: !fwd.every((m) => Math.abs(m.s - 1) < 0.0015 && Math.hypot(m.dx, m.dy) < 1.0) };
}

export async function autoCamera(reader: FrameReader, r: AnalysisResult, onProgress?: (done: number) => void, cancelled?: () => boolean, dbg?: (line: string) => void): Promise<AutoCam | null> {
  const { w, h } = reader, f0 = r.frames.start, T = r.keypoints2d.xy.length, last = f0 + T - 1;
  const br = r.events.br?.frame;
  if (br == null || T < 8) return null;
  const fps = Math.max(1, r.fps_real || r.fps), clamp = (f: number) => Math.max(f0, Math.min(last, Math.round(f)));
  const step = Math.max(1, Math.ceil(T / 45));
  // frames to look at one by one (a camera that moves has no bowler-free picture): around the delivery, where a
  // broadcast camera is steadiest, then earlier. A crease hidden behind the bowler in one is clear in another.
  const want = [...new Set([br - 0.45 * fps, br - 0.25 * fps, br + 0.12 * fps, br - 0.65 * fps, br - 0.9 * fps, br - 0.1 * fps, br - 1.2 * fps, f0 + 1].map(clamp))];
  const list = new Set<number>([clamp(br), last, ...want]);
  for (let f = f0; f <= last; f += step) list.add(f);
  const frames = [...list].sort((a, b) => a - b);
  const spread = new Set([0.04, 0.2, 0.35, 0.5, 0.65, 0.8, 0.97].map((u) => frames[Math.round(u * (frames.length - 1))]));
  const grays: Gray[] = [], kept = new Map<number, Uint8ClampedArray>();
  for (let i = 0; i < frames.length; i++) {
    if (cancelled?.()) return null;
    const img = await reader.get(frames[i]);
    grays.push(grayOf(img, w, h));
    if (spread.has(frames[i])) kept.set(frames[i], img.slice());   // (the others are read again if they are needed: a phone has little memory to spare)
    onProgress?.((0.6 * (i + 1)) / frames.length);
  }
  const ref = frames.indexOf(clamp(br)), { toRef, moved } = register(grays, frames, ref);
  /** The camera's movement with frame `m` as the one the pitch is marked on. */
  const shiftsFor = (m: number): FrameShifts => {
    const out: FrameShifts = new Map(), inv = invertShift(toRef[frames.indexOf(m)]);
    frames.forEach((f, i) => out.set(f, moved ? chain(toRef[i], inv) : STILL));
    return out;
  };
  const kd = w / (r.video.width * r.display_scale);
  // pictures to look for the pitch in, each with the frame it stands for
  const looks: { img: Uint8ClampedArray | null; frame: number }[] = [];
  if (!moved) {
    const use = [...spread].filter((f) => kept.has(f)).map((f) => {
      const kp = r.keypoints2d.xy[f - f0];
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      if (kp) for (const p of kp) { x0 = Math.min(x0, p[0] * kd); y0 = Math.min(y0, p[1] * kd); x1 = Math.max(x1, p[0] * kd); y1 = Math.max(y1, p[1] * kd); }
      const m = 0.22 * Math.max(x1 - x0, y1 - y0);
      return { d: kept.get(f)!, x0: x0 - m, y0: y0 - 1.2 * m, x1: x1 + m, y1: y1 + 0.6 * m };
    });
    const bg = new Uint8ClampedArray(w * h * 4), v = [new Array<number>(), new Array<number>(), new Array<number>()];
    for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i += 4) {
      let n = 0;
      for (const u of use) { if (x > u.x0 && x < u.x1 && y > u.y0 && y < u.y1) continue; v[0][n] = u.d[i]; v[1][n] = u.d[i + 1]; v[2][n] = u.d[i + 2]; n++; }
      if (!n) { const u = use[0]; v[0][0] = u.d[i]; v[1][0] = u.d[i + 1]; v[2][0] = u.d[i + 2]; n = 1; }
      for (let c = 0; c < 3; c++) { const a = v[c]; a.length = n; a.sort((p, q) => p - q); bg[i + c] = a[n >> 1]; }
      bg[i + 3] = 255;
    }
    looks.push({ img: bg, frame: clamp(br) });
  }
  kept.clear();
  for (const f of moved ? want.slice(0, 6) : want.slice(0, 2)) looks.push({ img: null, frame: f });

  // where the bowler's back foot comes down, in each picture: the bowler's wicket is beside it and about 40% of the bowler's height
  const bfc = r.events.bfc?.frame ?? r.events.ffc?.frame ?? br, tb = clamp(bfc) - f0, kb = r.keypoints2d.xy[tb];
  const foot = (frame: number) => {
    const sh = shiftsFor(frame), near = [...sh.keys()].reduce((a, b) => (Math.abs(b - (tb + f0)) < Math.abs(a - (tb + f0)) ? b : a));
    const m = sh.get(near)!, at = (j: number) => applyShift(m as Shift, [kb[j][0] * kd, kb[j][1] * kd]);
    const a = at(15), b = at(16), head = at(0);
    return { x: (a[0] + b[0]) / 2, y: Math.max(a[1], b[1]), tall: Math.abs(Math.max(a[1], b[1]) - head[1]) / m.s * m.s };
  };
  let done = 0;
  // every answer from every picture that makes a bowler of the bowler, with the release height it gives
  interface Hyp { how: AutoHow; marks: Mark[]; frame: number; tapPx: number; weight: number; height: number; shifts: FrameShifts; far: Mark[] | null; pos: number[] }
  const hyps: Hyp[] = [];
  const consider = (how: AutoHow, marks: Mark[], frame: number, tapPx: number, weight: number, far: Mark[] | null = null): Hyp | null => {
    const cam = solveCameraPoints(marks.map((m) => ({ world: worldOf(m), px: m.px })), w, h), sh = shiftsFor(frame);
    const o = isCamera(cam) ? measureOnPitch(r, cam, frame, sh) : null;
    dbg?.(`${how} @${frame}: ${isCamera(cam) ? `cam ${cam.pos.map((v) => v.toFixed(2))} f ${cam.f.toFixed(0)} rms ${cam.rms.toFixed(2)}` : "no camera"}; ${o?.release ? `release ${o.release.height.value.toFixed(2)} m, ${o.release.across.value.toFixed(2)} across` : "no release"}${o?.stature ? `, height ${o.stature.value.toFixed(2)}` : ""}${o?.back ? `, back heel z ${o.back.heel[2].toFixed(2)}` : ""}${o?.front ? `, front heel z ${o.front.heel[2].toFixed(2)}` : ""} -> ${o && believable(o) ? "believable" : "NOT believable"}`);
    if (!o || !believable(o)) return null;
    const hy: Hyp = { how, marks, frame, tapPx, weight, height: o.release!.height.value, shifts: sh, far, pos: (cam as Camera).pos.slice() };
    hyps.push(hy);
    return hy;
  };
  const answer = (c: Hyp): AutoCam => ({ w, h, markFrame: c.frame, marks: c.marks, how: c.how, tapPx: c.tapPx, shifts: c.shifts, far: c.far });
  /** The batter's wicket, if one was found about where a camera worked out from the bowler's end expects it. */
  const farWicket = (cam: Camera, wk: Wicket[]): Mark[] | null => {
    const b = project(cam, [0, 0, -PITCH_LEN]), t = project(cam, [0, STUMP_TOP, -PITCH_LEN]);
    if (!b || !t) return null;
    const tall = Math.hypot(b[0] - t[0], b[1] - t[1]);
    const q = wk.filter((c) => c.h > 0.6 * tall && c.h < 1.6 * tall && Math.abs(c.base[0] - b[0]) < 1.2 * tall + 8 && Math.abs(c.base[1] - b[1]) < 1.6 * tall + 8).sort((p, c) => c.score - p.score)[0];
    dbg?.(`  far wicket expected at ${b.map((v) => v.toFixed(0))}, ${tall.toFixed(0)} px tall: ${q ? `found at ${q.base.map((v) => v.toFixed(0))} h${q.h.toFixed(0)}` : "not found"}`);
    // Only the top of the stump is kept. Its foot is where its shadow starts and often has a crease painted behind
    // it: against rendered deliveries the foot was found 3 to 17 px out, the top within 2. A camera from the
    // bowler's end with the foot as well put the ball's pitching spot 33 to 108 cm out; with the top alone, 5 to 13.
    return q ? [{ end: "batter", kind: "stump_top", px: q.top }] : null;
  };
  for (let li = 0; li < looks.length; li++) {
    if (cancelled?.()) return null;
    const lk = looks[li], look = { frame: lk.frame, img: lk.img ?? (await reader.get(lk.frame)) };
    const ft = foot(look.frame), clean = lk.img !== null;   // clean: the picture with the bowler taken out
    dbg?.(`look ${li}: frame ${look.frame}${clean ? " (bowler-free picture)" : ""}, camera ${moved ? "moving" : "still"}, bowler's feet at ${ft.x.toFixed(0)},${ft.y.toFixed(0)}, ${ft.tall.toFixed(0)} px tall`);
    // 1. the whole crease pattern on its own: when it is all found on paint and the bowler fits, that is the answer
    const a = findPitch(look.img, w, h);
    if (pitchFound(a)) {
      // Is the far end of that pattern something the picture can show? A crease line is about 4.5 cm wide; from a
      // phone ten metres behind the stumps at 720p the far ones are a fifth of a pixel thick, and the pattern's far
      // corners are then where its near end says they should be, not where they were seen (one such camera had the
      // ball pitching 61 cm from where it did). The batter's stumps are seen: their top then stands for the far end.
      const p1 = project(a.cam, [0, 0, -(PITCH_LEN - 1.22)]), p2 = project(a.cam, [0, 0, -(PITCH_LEN - 1.22) - 0.045]);
      const thin = !p1 || !p2 || Math.hypot(p1[0] - p2[0], p1[1] - p2[1]) < 0.5;
      const far = thin ? farWicket(a.cam, findWickets(look.img, w, h)) : null;
      const c = consider("creases", a.marks, look.frame, 1.2, 3, far);
      if (c) return answer(c);
    }
    await new Promise((res) => setTimeout(res, 0));
    // 2. the creases at the bowler's end: around the bowler's wicket, and around the bowler's own feet
    const wk = findWickets(look.img, w, h);
    dbg?.(`  wickets: ${wk.length}; ${wk.slice(0, 5).map((q) => `${q.base.map((v) => v.toFixed(0))} h${q.h.toFixed(0)} s${q.score.toFixed(0)}`).join(" | ")}`);
    const nearOk = (q: Wicket) => q.h > 0.22 * ft.tall && q.h < 0.75 * ft.tall && Math.abs(q.base[0] - ft.x) < 3.2 * q.h && Math.abs(q.base[1] - ft.y) < 1.6 * q.h;
    const seeds: { at: [number, number]; size: number; exact: boolean }[] = wk.filter(nearOk).slice(0, 2).map((q) => ({ at: q.base, size: q.h, exact: true }));
    seeds.push({ at: [ft.x, ft.y], size: 0.4 * ft.tall, exact: false });
    let sure: Hyp | null = null;
    for (const sd of seeds) {
      const nc = findNearCreases(look.img, w, h, sd.at, sd.size, sd.exact);
      dbg?.(`  near end around ${sd.at.map((v) => v.toFixed(0))} (${sd.exact ? "wicket" : "feet"}, size ${sd.size.toFixed(0)}): ${nc ? `score ${nc.score.toFixed(2)}, ${nc.sights} sightings, fewest on a line ${nc.least}, rms ${nc.cam.rms.toFixed(2)} px` : "nothing"}`);
      await new Promise((res) => setTimeout(res, 0));
      // paint on all four lines (each one fixes something the others cannot), sitting on the camera's lines to a pixel
      if (!nc || nc.least < 9 || nc.cam.rms > Math.max(1.2, w / 1300)) continue;
      const c = consider("near creases", nc.marks, look.frame, Math.max(0.6, 1.5 * nc.cam.rms), sd.exact ? 3 : 2.5, farWicket(nc.cam, wk));
      if (c && nc.least >= 14 && nc.sights >= 80 && !sure) sure = c;
      if (c && sd.exact) break;
    }
    // on the bowler-free picture, with plenty of paint on every line: nothing a single frame could add to that
    if (sure && clean) return answer(sure);
    // 3. the wickets alone
    for (const p of pairWickets(wk, w, h, 3, nearOk)) {
      const stumps: Mark[] = [{ end: "bowler", kind: "stump_base", px: p.near.base }, { end: "bowler", kind: "stump_top", px: p.near.top }, { end: "batter", kind: "stump_base", px: p.far.base }, { end: "batter", kind: "stump_top", px: p.far.top }];
      consider("stumps", stumps, look.frame, Math.max(2.5, 0.08 * p.far.h), 0.6);
    }
    onProgress?.(0.6 + (0.4 * ++done) / looks.length);
    // two pictures that agree on the creases at the bowler's end: enough
    const near = hyps.filter((q) => q.how === "near creases");
    if (near.length >= 2) { const g = near.filter((q) => Math.abs(q.height - near[near.length - 1].height) <= 0.025 * q.height); if (g.length >= 2) break; }
    await new Promise((res) => setTimeout(res, 0));
  }
  // No picture showed the whole crease pattern. What is left are answers that each lean on a stump's end or a
  // stretch of paint read off one frame, and any one of them can be out. The right camera is the one the pictures
  // agree on: the release height that most of them give, to within 4%. One answer nobody else backs is not used.
  if (!hyps.length) return null;
  let best: Hyp[] = [], bw = 0;
  // (They must also agree on where the camera is: it does not move between frames by more than a pan or a zoom shows,
  // and two cameras 3 m and 6.5 m behind the stumps are not one camera. And answers from the wickets alone count
  // as agreeing only across different pictures: a county ground has two dozen things with three upright bars, and
  // two wrong pairs of them in one frame once "agreed" on a spinner letting go at 1.48 m.)
  const sameCam = (a: Hyp, b: Hyp) => Math.hypot(a.pos[0] - b.pos[0], a.pos[1] - b.pos[1], a.pos[2] - b.pos[2]) <= 0.25 * Math.hypot(a.pos[0], a.pos[1], a.pos[2]);
  for (const c of hyps) {
    let group = hyps.filter((q) => Math.abs(q.height - c.height) <= 0.04 * c.height && sameCam(c, q));
    if (group.every((q) => q.how === "stumps") && new Set(group.map((q) => q.frame)).size < 2) group = [c];
    const wt = group.reduce((t, q) => t + q.weight, 0);
    if (wt > bw) { bw = wt; best = group; }
  }
  // (one answer nobody else backs is used only when it is the creases at the bowler's end, which stand on their own paint)
  if (best.length < 2 && looks.length > 1 && best[0].how !== "near creases") return null;
  const mid = [...best].sort((p, q) => p.height - q.height)[best.length >> 1].height;
  best.sort((p, q) => q.weight - p.weight || Math.abs(p.height - mid) - Math.abs(q.height - mid));
  // how far the agreeing answers still differ is part of this one's doubt (in the pixels a mark would have to move)
  const lo = Math.min(...best.map((q) => q.height)), hi = Math.max(...best.map((q) => q.height));
  dbg?.(`agreed: ${best.length} of ${hyps.length} answers within 4%, release ${lo.toFixed(2)}-${hi.toFixed(2)} m; taking ${best[0].how} from frame ${best[0].frame}`);
  return { ...answer(best[0]), tapPx: Math.max(best[0].tapPx, best.length > 1 ? (40 * (hi - lo)) / Math.max(1, mid) : 0) };
}

/** The marks the ball is followed with: the pitch as it was found, with the far end taken from `far` (the batter's
 *  stumps) when that was seen and the pattern's own far corners could not be. */
export function trackingMarks(marks: Mark[], far: Mark[] | null | undefined): Mark[] {
  return far && far.length ? [...marks.filter((m) => m.end === "bowler"), ...far] : marks;
}
