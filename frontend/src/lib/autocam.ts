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
  {
    // The bowler-free picture: the middle value of each pixel over seven frames, leaving out the bowler's own box in
    // each, so nothing hides a crease. On a tripod the frames are used as they are. A camera that pans and zooms
    // (broadcast) has its frames laid over the release frame first, each by its own measured zoom and shift, taken
    // from round the delivery where the bowler crosses the crease and the lens has settled: the bowler, the umpire
    // walking in and a passing fielder are each somewhere else in most of them.
    const pick = moved ? [...new Set([clamp(br), ...want.slice(0, 6)])] : [...spread].filter((f) => kept.has(f));
    const use: { d: Uint8ClampedArray; x0: number; y0: number; x1: number; y1: number; m: Shift | null }[] = [];
    for (const f of pick) {
      const idx = frames.indexOf(f), m = moved ? toRef[idx] : null;
      if (idx < 0 || (m && !(m.s > 0.4 && m.s < 2.5))) continue;
      const d = kept.get(f) ?? (await reader.get(f));
      if (cancelled?.()) return null;
      const kp = r.keypoints2d.xy[f - f0];
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      if (kp) for (const p of kp) { const q = m ? applyShift(m, [p[0] * kd, p[1] * kd]) : [p[0] * kd, p[1] * kd]; x0 = Math.min(x0, q[0]); y0 = Math.min(y0, q[1]); x1 = Math.max(x1, q[0]); y1 = Math.max(y1, q[1]); }
      const g = 0.22 * Math.max(x1 - x0, y1 - y0);
      use.push({ d, x0: x0 - g, y0: y0 - 1.2 * g, x1: x1 + g, y1: y1 + 0.6 * g, m });
    }
    if (use.length >= (moved ? 4 : 1)) {
      const bg = new Uint8ClampedArray(w * h * 4), v = [new Array<number>(), new Array<number>(), new Array<number>()];
      const refI = use.findIndex((u) => !u.m || (Math.abs(u.m.s - 1) < 1e-9 && u.m.dx === 0 && u.m.dy === 0));
      for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i += 4) {
        let n = 0;
        for (const u of use) {
          if (x > u.x0 && x < u.x1 && y > u.y0 && y < u.y1) continue;
          if (!u.m) { v[0][n] = u.d[i]; v[1][n] = u.d[i + 1]; v[2][n] = u.d[i + 2]; n++; continue; }
          // this pixel of the release frame, in that frame: between four of its pixels
          const sx = (x - u.m.dx) / u.m.s, sy = (y - u.m.dy) / u.m.s, ix = Math.floor(sx), iy = Math.floor(sy);
          if (ix < 0 || iy < 0 || ix >= w - 1 || iy >= h - 1) continue;
          const fx = sx - ix, fy = sy - iy, a = (iy * w + ix) * 4, b = a + 4, c = a + w * 4, e = c + 4;
          const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
          for (let k = 0; k < 3; k++) v[k][n] = u.d[a + k] * w00 + u.d[b + k] * w10 + u.d[c + k] * w01 + u.d[e + k] * w11;
          n++;
        }
        if (!n) { const u = use[refI >= 0 ? refI : 0]; v[0][0] = u.d[i]; v[1][0] = u.d[i + 1]; v[2][0] = u.d[i + 2]; n = 1; }
        for (let c = 0; c < 3; c++) { const a = v[c]; a.length = n; a.sort((p, q) => p - q); bg[i + c] = a[n >> 1]; }
        bg[i + 3] = 255;
      }
      looks.push({ img: bg, frame: clamp(br) });
    }
  }
  const laidOver = moved && looks.length > 0;   // the bowler-free picture was put together from frames laid over one another
  kept.clear();
  for (const f of moved ? want.slice(0, 6) : want.slice(0, 2)) looks.push({ img: null, frame: f });
  // (A picture laid together from a zooming camera's frames is sharp where they were lined up, at the bowler's end,
  // and a pixel or two soft at the far end: it is used for the creases at the bowler's end only, after one true
  // frame has had its chance to show the whole pattern.)
  if (laidOver && looks.length > 1) { const [bgLook, first] = looks; looks[0] = first; looks[1] = bgLook; }

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
    const a = laidOver && clean ? null : findPitch(look.img, w, h);
    if (a && pitchFound(a)) {
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
      // The far end, for following the ball: the far popping crease when it can be seen (it fixes the far end to
      // about 10 cm), else the batter's stump top. On a picture laid together from a moving camera's frames the far
      // end is soft, so the true frame is looked at for it.
      const farImg = laidOver && clean ? await reader.get(look.frame) : look.img;
      const far = farEndFromCrease(farImg, w, h, nc.marks, nc.cam, dbg) ?? farWicket(nc.cam, wk);
      const c = consider("near creases", nc.marks, look.frame, Math.max(0.6, 1.5 * nc.cam.rms), sd.exact ? 3 : 2.5, far);
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

/**
 * The popping crease at the batter's end, looked for where a camera worked out from the bowler's end expects it.
 * That camera is sure of everything at the bowler's end and unsure of how far away it stands (its four corners a
 * pixel out move the far crease a metre along the pitch); one seen line at the far end settles it, to a few
 * centimetres. The line is searched for up and down the picture from where it is expected: a pale stroke a pixel or
 * more thick, darker pitch above and below it, along most of its length (a batter and a wicketkeeper stand on part
 * of it), with the bowling crease a known step beyond it. Returns the crease's two ends between the return creases
 * as marks, or null when no such line stands out.
 */
export function findFarCrease(img: Uint8ClampedArray | Uint8Array, w: number, h: number, cam: Camera, dbg?: (line: string) => void): Mark[] | null {
  const zPop = -(PITCH_LEN - 1.22);
  const A = project(cam, [-1.32, 0, zPop]), B = project(cam, [1.32, 0, zPop]), nearPop = project(cam, [0, 0, -1.22]), bowl = project(cam, [0, 0, -PITCH_LEN]), mid = project(cam, [0, 0, zPop]), thickP = project(cam, [0, 0, zPop - 0.045]);
  if (!A || !B || !nearPop || !bowl || !mid || !thickP) return null;
  const len = Math.hypot(B[0] - A[0], B[1] - A[1]);
  const thick = Math.hypot(thickP[0] - mid[0], thickP[1] - mid[1]);
  if (len < 40 || thick < 0.5) { dbg?.(`  far crease: too small to see (${len.toFixed(0)} px long, ${thick.toFixed(2)} px thick)`); return null; }
  const dx = (B[0] - A[0]) / len, dy = (B[1] - A[1]) / len, nx = -dy, ny = dx;   // along the line, and across it (down the picture)
  const step = (bowl[0] - mid[0]) * nx + (bowl[1] - mid[1]) * ny;                // from the popping crease to the bowling crease, across
  const reach = Math.max(14, 0.3 * Math.abs((mid[0] - nearPop[0]) * nx + (mid[1] - nearPop[1]) * ny));
  const lum = (x: number, y: number) => { const xi = Math.round(x), yi = Math.round(y); if (xi < 0 || yi < 0 || xi >= w || yi >= h) return -1; const i = (yi * w + xi) * 4; return 0.299 * img[i] + 0.587 * img[i + 1] + 0.114 * img[i + 2]; };
  const gap = Math.max(2, Math.ceil(thick) + 1), N = Math.max(40, Math.min(160, Math.round(len / 2)));
  // how much of a line across the pitch at this offset is pale paint standing out from the pitch either side of it
  const resp = (o: number, x0: number, x1: number): number[] => {
    const out: number[] = [];
    for (let k = 0; k < N; k++) {
      const u = x0 + ((x1 - x0) * k) / (N - 1), px = A[0] + (B[0] - A[0]) * u + nx * o, py = A[1] + (B[1] - A[1]) * u + ny * o;
      const c = lum(px, py), a = lum(px - nx * gap, py - ny * gap), b = lum(px + nx * gap, py + ny * gap);
      out.push(c < 0 || a < 0 || b < 0 ? 0 : c - Math.max(a, b));
    }
    return out;
  };
  const frac = (r: number[]) => r.filter((v) => v > 9).length / r.length;
  let best = { o: 0, s: 0 };
  const all: number[] = [];
  for (let o = -reach; o <= reach; o += 0.5) {
    // (the popping crease runs on past the return creases; the bowling crease stops at them)
    const s = frac(resp(o, -0.15, 1.15)) + 0.5 * frac(resp(o + step * (1 + o / Math.max(1, Math.abs((mid[0] - nearPop[0]) * nx + (mid[1] - nearPop[1]) * ny))), 0.05, 0.95));
    all.push(s);
    if (s > best.s) best = { o, s };
  }
  const sorted = all.slice().sort((p, q) => p - q), medS = sorted[sorted.length >> 1];
  dbg?.(`  far crease: expected at ${mid.map((v) => v.toFixed(0))}, ${len.toFixed(0)} px long, ${thick.toFixed(1)} px thick; best ${best.s.toFixed(2)} at ${best.o.toFixed(1)} px (typical ${medS.toFixed(2)}), looked ${reach.toFixed(0)} px either way`);
  if (best.s < 0.45 || best.s < medS + 0.3) return null;
  // the line itself: where the paint is brightest across it, sample by sample, and the straight line through those
  const pts: [number, number][] = [];
  for (let k = 0; k < N; k++) {
    const u = -0.15 + (1.3 * k) / (N - 1), bx = A[0] + (B[0] - A[0]) * u, by = A[1] + (B[1] - A[1]) * u;
    let sw = 0, so = 0;
    for (let o = best.o - gap; o <= best.o + gap; o += 0.5) {
      const c = lum(bx + nx * o, by + ny * o), a = lum(bx + nx * (o - gap), by + ny * (o - gap)), b = lum(bx + nx * (o + gap), by + ny * (o + gap));
      const v = c < 0 || a < 0 || b < 0 ? 0 : Math.max(0, c - Math.max(a, b));
      sw += v; so += v * o;
    }
    if (sw > 12) pts.push([u, so / sw]);
  }
  if (pts.length < 0.3 * N) return null;
  // a line o = p + q.u through them, the ones far from it dropped once
  const fit = (q: [number, number][]) => { let n = 0, su = 0, so = 0, suu = 0, suo = 0; for (const [u, o] of q) { n++; su += u; so += o; suu += u * u; suo += u * o; } const den = n * suu - su * su; const b = Math.abs(den) < 1e-9 ? 0 : (n * suo - su * so) / den; return { a: (so - b * su) / n, b }; };
  let f = fit(pts);
  const kept = pts.filter(([u, o]) => Math.abs(o - (f.a + f.b * u)) <= 1.5);
  if (kept.length >= 0.25 * N) f = fit(kept);
  const at = (u: number): [number, number] => { const o = f.a + f.b * u; return [A[0] + (B[0] - A[0]) * u + nx * o, A[1] + (B[1] - A[1]) * u + ny * o]; };
  return [{ end: "batter", kind: "pop_l", px: at(0) }, { end: "batter", kind: "pop_r", px: at(1) }];
}

/**
 * The far end of the pitch from the far popping crease: marks for its two ends, placed by a camera that fits the
 * marks at the bowler's end and passes the middle of the far crease through the line that was found. (Only the
 * line's height in the picture is taken from the picture. Where along it the return creases meet it is not seen
 * from here, and marks put where the first camera guessed them would hold the far end at that guess.)
 */
export function farEndFromCrease(img: Uint8ClampedArray | Uint8Array, w: number, h: number, near: Mark[], cam0: Camera, dbg?: (line: string) => void): Mark[] | null {
  let cam = cam0;
  const mid: [number, number, number] = [0, 0, -(PITCH_LEN - 1.22 - 0.02)];
  for (let it = 0; it < 3; it++) {
    const ends = findFarCrease(img, w, h, cam, it === 0 ? dbg : undefined);
    if (!ends) return null;
    const px: [number, number] = [(ends[0].px[0] + ends[1].px[0]) / 2, (ends[0].px[1] + ends[1].px[1]) / 2];
    const c = solveCameraPoints([...near.map((m) => ({ world: worldOf(m), px: m.px })), { world: mid, px }], w, h);
    if (!isCamera(c)) return null;
    cam = c;
  }
  const out: Mark[] = [];
  for (const kind of ["pop_l", "pop_r"] as const) { const q = project(cam, worldOf({ end: "batter", kind })); if (!q) return null; out.push({ end: "batter", kind, px: q }); }
  dbg?.(`  far end from the far popping crease: camera ${cam.pos.map((v) => v.toFixed(1))} f ${cam.f.toFixed(0)} (from the bowler's end alone: ${cam0.pos.map((v) => v.toFixed(1))} f ${cam0.f.toFixed(0)})`);
  return out;
}

/** The marks the ball is followed with: the pitch as it was found, with the far end taken from `far` (the batter's
 *  stumps) when that was seen and the pattern's own far corners could not be. */
export function trackingMarks(marks: Mark[], far: Mark[] | null | undefined): Mark[] {
  return far && far.length ? [...marks.filter((m) => m.end === "bowler"), ...far] : marks;
}
