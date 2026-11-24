/**
 * The in-browser analysis pipeline (port of backend/bowlnet/pipeline.py).
 *
 * Stage A (heavy, once per video): probe -> detect + track people -> pick the bowler -> high-precision 2D on
 * crops of the delivery window -> 3D lift. Its output is stored so Stage B (skeleton fit, events, metrics,
 * coaching, body mesh) can re-run in a fraction of a second whenever the user corrects an event, the height or
 * the bowling arm.
 */
import type { Arr2, Arr3 } from "./nd";
import { clip } from "./nd";
import { PoseModels, forceWasm, type RefinedPose } from "./detector";
import { Lifter, cocoToH36m } from "./lifter";
import { FrameSource, repeatedFraction, segmentShots, signature, sigDistance, videoInfoDict,
  type Signature, type VideoInfo } from "./video";
import { IDENTITY, MotionEstimator, appearance, detectionsByTrack, toGrey, track, type FrameDets, FLOW_SIZE } from "./tracking";
import { isDelivery, scoreTracks, trackScoreDict, type Detection, type TrackScore, type TrackScoreDict } from "./bowler";
import { ARMNET, loadArmNet, traceArms } from "./armnet";
import { assemble, bodyHeightPx, fixArmGlitches, fixSwaps, hampel, interpolateGaps, mendLostArms, MEND, smoothKeypoints } from "./pose2d";
import { armPeakSpeed, bestUpswing, classifyView, decideBowlingArm, detectEvents, facingDirection, sizeTrend, stabilise, strideAcross, wristLift } from "./events";
import { estimateWorldFrame, reconstruct } from "./kinematics";
import { FEET_OUT_TIP, HAND_OUT_TIP, compute, feetOutOfFrame, handOutOfFrame, type Ctx } from "./metrics";
import { coach } from "./coaching";
import { exportMesh, worldToThree } from "./body";
import { COCO_FLIP, COCO_NAMES, H36M_FLIP, H36M_NAMES, H36M_PARENTS, PELVIS, eventsAsDict, sideForArm, toWorld,
  worldFrameDict, type Arm, type EventKey, type Events, type ViewInfo } from "./types";
import { round } from "./util";

export const STAGES: [string, string, number][] = [
  ["probe", "Loading models & reading video", 0.08],
  ["detect", "Detecting & tracking people", 0.42],
  ["select", "Identifying the bowler", 0.01],
  ["pose2d", "High-precision 2D pose", 0.38],
  ["lift", "3D reconstruction", 0.07],
  ["events", "Detecting delivery events", 0.02],
  ["metrics", "Biomechanics & coaching", 0.01],
  ["mesh", "Fitting 3D body model", 0.005],
  ["save", "Saving results", 0.005],
];

export { AnalysisError, SLOWMO_CHOICES, MIN_FPS, DEFAULT_HEIGHT_M, MAX_VIDEO_SECONDS, optionsFrom, type Options } from "./common";
import { AnalysisError, SLOWMO_CHOICES, MIN_FPS, DEFAULT_HEIGHT_M, MAX_VIDEO_SECONDS, optionsFrom, type Options } from "./common";
import { modelsCached } from "../lib/modelCache";

const FRAME_JPEG_MAX_SIDE = 1280;
const FRAME_JPEG_QUALITY = 0.78;   // ~40% smaller than 0.85 on grassy footage (storage, backups), still sharp when zoomed

export type ProgressCb = (p: { stage: string; label: string; progress: number; detail?: string | null; elapsed: number }) => void;

/** Where the time goes inside the stages (ms, by name), printed with the stage timings in debug mode. */
const CLOCK = new Map<string, number>();
const clock = (key: string, since: number): number => { const now = performance.now(); CLOCK.set(key, (CLOCK.get(key) ?? 0) + now - since); return now; };

class Progress {
  private t0 = performance.now();
  private paused = 0;                   // ms spent waiting for a hidden tab: not working time
  private pausedAt: number | null = null;
  constructor(private cb?: ProgressCb) {}
  pause(on: boolean) {
    const t = performance.now();
    if (on && this.pausedAt === null) this.pausedAt = t;
    else if (!on && this.pausedAt !== null) { this.paused += t - this.pausedAt; this.pausedAt = null; }
  }
  private marks: [string, number][] = [];
  /** With localStorage "seamly:debug" = "1": how long each stage took, to the console (for making the pipeline faster). */
  report(tag: string) {
    try {
      if (typeof localStorage === "undefined" || localStorage.getItem("seamly:debug") !== "1") return;
      const now = performance.now();
      console.info(`[time] ${tag}: ` + this.marks.map(([k, t], i) => `${k} ${Math.round((this.marks[i + 1]?.[1] ?? now) - t)} ms`).join(", ") + `; fetching frames so far ${Math.round(FrameSource.seekMs)} ms for ${FrameSource.seekN}; inside: ${[...CLOCK].map(([k, v]) => `${k} ${Math.round(v)}`).join(", ")}`);
      CLOCK.clear();
    } catch { /* no storage */ }
  }
  stage(key: string, frac = 0, detail: string | null = null) {
    if (!this.marks.length || this.marks[this.marks.length - 1][0] !== key) this.marks.push([key, performance.now()]);
    if (!this.cb) return;
    let acc = 0;
    for (const [k, label, w] of STAGES) {
      if (k === key) {
        this.cb({ stage: key, label, progress: Math.min(0.999, acc + w * clip(frac, 0, 1)), detail,
          elapsed: round((performance.now() - this.t0 - this.paused) / 1000, 1) });
        return;
      }
      acc += w;
    }
  }
}

/** Everything Stage B needs (the browser counterpart of stage_a.npz + stage_a.json). */
export interface StageA {
  X: Arr3; seq: Arr3; kp: Arr3; kp_s: Arr3; kc: Arr2; motions: number[][][]; bbox: Arr2; timestamps: number[];
  /** Per frame of the window: the crop model's nine extra points (head top, neck, mid-hip, big toes, small toes, heels;
   * left before right) as [x, y, confidence] in video pixels, unsmoothed; null where the bowler was not read. */
  feet?: (number[][] | null)[];
  meta: {
    version: number; video: ReturnType<typeof videoInfoDict>; analysis_window: { start: number; end: number };
    display_scale: number; fps: number; options: Options;
    bowler: { track: number; shot: number; score: TrackScoreDict };
    sweep: { side: string; start: number; end: number; peak: number; peak_speed_dps: number };
    candidates: TrackScoreDict[];
    pose3d: string;
    quality: { lr_swaps_fixed: number; mean_kp_conf: number; frames_refined: number; frames_total: number; repeated_frames: number };
    timing_stage_a_s: number;
  };
}

export interface Models { pose: PoseModels; lifter: Lifter }

let modelsP: Promise<Models> | null = null;
let modelsAt = 0;
const modelWatchers = new Set<(f: number) => void>();
/** Load (once) the detection and lifting models; ~170 MB, cached by the browser after the first visit. The load can
 *  be started early (when a clip is chosen) and joined later: every caller's onProgress hears how far it has got. */
export function loadModels(onProgress?: (f: number) => void): Promise<Models> {
  if (onProgress) { modelWatchers.add(onProgress); onProgress(modelsAt); }
  if (!modelsP) {
    let a = 0, b = 0;
    modelsAt = 0;
    const rep = () => { modelsAt = 0.8 * a + 0.2 * b; for (const w of modelWatchers) w(modelsAt); };
    modelsP = Promise.all([PoseModels.load((f) => { a = f; rep(); }), Lifter.load((f) => { b = f; rep(); })])
      .then(([pose, lifter]) => { modelsAt = 1; modelWatchers.clear(); return { pose, lifter }; })
      .catch((e) => { modelsP = null; modelWatchers.clear(); throw e; });
  }
  return modelsP;
}

function canvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return c;
}

/** JPEG of a canvas. toDataURL is synchronous (~10 ms at 720p); some browsers schedule toBlob with a ~1 s delay. */
function jpeg(c: HTMLCanvasElement, quality: number): Blob {
  const url = c.toDataURL("image/jpeg", quality);
  const bin = atob(url.slice(url.indexOf(",") + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: "image/jpeg" });
}

/** The same, packed by the browser off this thread when it can be (the picture is copied at the call). */
function jpegAsync(c: HTMLCanvasElement, quality: number): Promise<Blob> {
  if (typeof c.toBlob !== "function") return Promise.resolve(jpeg(c, quality));
  return new Promise((resolve) => {
    // (a browser that hands back nothing gets an empty picture for that frame: by then the canvas holds a later one)
    try { c.toBlob((b) => resolve(b ?? new Blob([], { type: "image/jpeg" })), "image/jpeg", quality); } catch { resolve(jpeg(c, quality)); }
  });
}

function boxIou(a: number[], b: number[]): number {
  const ix1 = Math.max(a[0], b[0]), iy1 = Math.max(a[1], b[1]), ix2 = Math.min(a[2], b[2]), iy2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
  const u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return u > 0 ? inter / u : 0;
}

/** Per-frame detections (full frame) + appearance + camera motion, for the given frame indices. */
async function detectFrames(src: FrameSource, models: Models, frames: number[], onFrame: (i: number) => void,
  sigs?: Map<number, Signature>, abort?: AbortSignal): Promise<FrameDets[]> {
  const { width: W, height: H } = src.info;
  const s = Math.min(1, 640 / Math.max(W, H));
  const work = canvas(Math.round(W * s), Math.round(H * s));
  const wctx = work.getContext("2d", { willReadFrequently: true })!;
  const fs = FLOW_SIZE / Math.max(W, H);
  const flow = canvas(Math.round(W * fs), Math.round(H * fs));
  const fctx = flow.getContext("2d", { willReadFrequently: true })!;
  const sigc = canvas(64, 36).getContext("2d", { willReadFrequently: true })!;
  const motion = new MotionEstimator();
  const out: FrameDets[] = [];
  for (let n = 0; n < frames.length; n++) {
    if (abort?.aborted) throw new AnalysisError("Analysis cancelled.");
    const f = frames[n];
    let tc = performance.now();
    await src.seek(f);
    tc = clock("scan: frame", tc);
    const v = src.video;
    if (sigs && !sigs.has(f)) sigs.set(f, signature(sigc, v, W, H));
    tc = clock("scan: signature", tc);
    const det = await models.pose.detect(v, W, H);
    tc = clock("scan: people model", tc);
    wctx.drawImage(v, 0, 0, work.width, work.height);
    const img = wctx.getImageData(0, 0, work.width, work.height);
    fctx.drawImage(v, 0, 0, flow.width, flow.height);
    const grey = toGrey(fctx.getImageData(0, 0, flow.width, flow.height), fs);
    tc = clock("scan: pixels", tc);
    const m = motion.next(grey, det.boxes);
    tc = clock("scan: camera motion", tc);
    out.push({ frame: f, boxes: det.boxes, confs: det.confs, kps: det.kps, kcs: det.kcs,
      appearance: det.boxes.map((b) => appearance(img, b, s)), motion: m });
    clock("scan: appearance", tc);
    onFrame(n);
  }
  return out;
}

/** Number of leading frames worth analysing (see pipeline._usable_length). */
function usableLength(kc: Arr2, motions: (number[][] | undefined)[], peak: number, fps: number, minConf = 0.6, maxZoom = 1.35): number {
  const T = kc.length;
  const start = Math.max(0, Math.min(T, peak + Math.max(2, Math.round(0.1 * fps))));
  let zoom = 1;
  // "Collapses" is against the clip's own level: in a close-up the legs are out of the picture from the first frame,
  // so the average over the body is low throughout, and that is not the tracking failing.
  const body = (t: number) => kc[t].slice(5).reduce((a, b) => a + b, 0) / 12;
  const lead = kc.slice(0, Math.max(1, Math.min(T, peak + 1))).map((_, t) => body(t)).sort((a, b) => a - b);
  // (0.7 of it: at 0.75 a close-up whose level dipped from 0.58 to 0.44 for two frames as the arm crossed the
  // face was cut off before the release)
  const floor = Math.min(minConf, 0.7 * lead[lead.length >> 1]);
  for (let t = Math.max(1, peak + 1); t < T; t++) {
    const m = motions[t];
    if (m) zoom *= Math.sqrt(Math.abs(m[0][0] * m[1][1] - m[0][1] * m[1][0]));
    if (t >= start && (body(t) < floor || zoom > maxZoom)) return t;
  }
  return T;
}

/** The ball is bowled before it is played. A batter lifting and swinging the bat turns the arms through as wide an
 * arc as a bowler does, and can outscore the bowler; but the swing comes a fraction of a second after the release.
 * So when a second person, in the picture at the same time, made a comparable arm sweep 0.25 to 1.2 s before the
 * top-scoring one, that earlier person is the bowler and the top scorer is the batter. `list` is best first. */
function bowlerFirst(list: TrackScore[], stride: number, fps: number): TrackScore[] {
  const top = list[0];
  if (!top?.sweep) return list;
  const earlier = list.find((d) => d !== top && !!d.sweep && d.shot === top.shot && d.track !== top.track && d.score >= 0.6 * top.score
    && d.legs_visibility >= 0.5 && Math.min(d.last, top.last) - Math.max(d.first, top.first) >= 5 * stride
    && top.sweep!.peak_frame - d.sweep.peak_frame >= 0.25 * fps && top.sweep!.peak_frame - d.sweep.peak_frame <= 1.2 * fps);
  return earlier ? [earlier, ...list.filter((d) => d !== earlier)] : list;
}

function select(info: VideoInfo, perShot: Map<number, Detection[]>, opts: Options, stride: number, fps: number): [TrackScore[], TrackScore] {
  let scores: TrackScore[] = [];
  for (const [si, dets] of perShot) scores = scores.concat(scoreTracks(detectionsByTrack(dets), si, fps, info.height, stride, true));
  scores.sort((a, b) => b.score - a.score);
  let deliveries = scores.filter((s) => isDelivery(s));
  if (opts.shot !== null && perShot.has(opts.shot)) {
    const inShot = deliveries.filter((s) => s.shot === opts.shot);
    deliveries = inShot.length ? inShot : scores.filter((s) => s.shot === opts.shot && s.sweep);
  }
  if (!deliveries.length) {
    // a clip that starts (or ends) mid-swing measures only part of the arm's sweep (short clips cut from edited footage)
    const top = bowlerFirst(scores, stride, fps)[0], sw = top?.sweep;
    const cut = !!sw && (sw.start_frame - top.first <= stride || top.last - sw.end_frame <= stride);
    if (sw && (sw.sweep_deg > 150 || (cut && sw.sweep_deg >= 120 && sw.peak_speed >= 450))) deliveries = [top];
    else throw new AnalysisError("We couldn't find a bowling delivery in this video. Make sure the bowler's full body is visible "
      + "from run-up to follow-through, ideally filmed side-on or from behind the bowler.");
  }
  deliveries = bowlerFirst(deliveries, stride, fps);
  const best = deliveries[0].score;
  deliveries = deliveries.filter((d, i) => i === 0 || (d.legs_visibility >= 0.5 && d.score >= 0.4 * best));
  const uniq: TrackScore[] = [];
  for (const d of deliveries)
    if (uniq.every((u) => !(d.shot === u.shot && Math.abs(d.sweep!.peak_frame - u.sweep!.peak_frame) < fps * 0.8))) uniq.push(d);
  const idx = opts.candidate !== null && opts.candidate >= 0 && opts.candidate < uniq.length ? opts.candidate : 0;
  return [uniq, uniq[idx]];
}

/** Refuse clips with too few distinct frames per second (frame-repeat slow motion or frame-rate conversion). */
function checkRepeats(info: VideoInfo, f0: number, f1: number, realFps: number, opts: Options) {
  const rep = repeatedFraction(info, f0, f1);
  const distinct = realFps * (1 - rep);
  if (distinct < MIN_FPS - 0.5) {
    const k = 1 / Math.max(1e-3, 1 - rep);
    const factor = SLOWMO_CHOICES.reduce((a, c) => (Math.abs(c - k) < Math.abs(a - k) ? c : a), SLOWMO_CHOICES[0]);
    if (k >= 1.5 && factor > opts.slowmo_factor) {
      throw new AnalysisError(`Most frames in this clip are repeats (each shown ~${k.toFixed(1)}x), leaving only `
        + `~${distinct.toFixed(0)} distinct frames per second. If the clip was slowed down, analyse it again with the clip speed set to ${factor}x; otherwise film at 30 fps or more.`,
        { slowmo_factor: factor });
    }
    throw new AnalysisError(`This clip has only ~${distinct.toFixed(0)} distinct frames per second (many frames are repeats). `
      + `A delivery stride lasts about 0.2 s, so at least ${MIN_FPS} fps is needed; film at 30 fps or more.`);
  }
}

export interface StageAOut { stageA: StageA; frames: Map<number, Blob> }

/** Stage A on a video file. */
/** Stop using WebGPU (it failed at run time): the next analysis reloads the models on WebAssembly. */
export function useWasmOnly() {
  forceWasm();
  modelsP = null;
}

/** onFrame: receives each display frame as it is encoded (otherwise they are returned in `frames`). */
export async function analyseVideo(file: Blob, options: Partial<Options>, onProgress?: ProgressCb, abort?: AbortSignal,
  onFrame?: (frame: number, jpeg: Blob) => void): Promise<StageAOut> {
  const opts = optionsFrom(options);
  let lastProgress: Parameters<ProgressCb>[0] | null = null;
  const prog = new Progress((p) => { lastProgress = p; onProgress?.(p); });
  const t0 = performance.now();
  const loading = (await modelsCached()) ? "Loading the analysis models" : "Downloading the analysis models (first time only, about 170 MB)";
  prog.stage("probe", 0, loading);
  const models = await loadModels((f) => prog.stage("probe", 0.9 * f, loading));
  prog.stage("probe", 0.92, "Reading video");
  let src: FrameSource;
  try {
    src = await FrameSource.open(file, MAX_VIDEO_SECONDS * opts.slowmo_factor);
  } catch (e) {
    throw new AnalysisError((e as Error).message);
  }
  src.onHidden = (paused) => {
    prog.pause(paused);
    if (paused && lastProgress) onProgress?.({ ...lastProgress, label: "Paused",
      detail: "Paused while Seamly is in the background — come back to this tab to continue." });
  };
  try {
    return await stageA(src, opts, models, prog, t0, abort, onFrame);
  } finally {
    src.close();
  }
}

async function stageA(src: FrameSource, opts: Options, models: Models, prog: Progress, t0: number, abort?: AbortSignal,
  onFrame?: (frame: number, jpeg: Blob) => void): Promise<StageAOut> {
  const info = src.info;
  if (info.frameCount < 12) throw new AnalysisError("Video is too short to analyse.");
  const realFps = info.fps * opts.slowmo_factor;
  if (realFps < MIN_FPS - 0.5) {
    throw new AnalysisError(`This clip has only ${realFps.toFixed(0)} frames per second. A delivery stride lasts about 0.2 s, so `
      + `at least ${MIN_FPS} fps is needed. Phones film at 30 fps or more; 120–240 fps slow motion is best. (If the clip plays in slow motion, set its clip speed.)`);
  }
  // ---------------- scan: detect + track (adaptive stride: ~350 scanned frames find the delivery) ----------------
  const n = info.frameCount;
  // An experiment, off unless localStorage "seamly:scan" = "fast": look for people in about thirty frames of each real
  // second (every other frame at 60 fps, every fourth at 120) and place the bowler in the frames between from the
  // scanned ones either side, instead of running the people model on every frame of the delivery. Not the default
  // until it is shown to leave the key moments and the measurements where they are (docs/ACCURACY.md 9k).
  const fastScan = (() => { try { return typeof localStorage !== "undefined" && localStorage.getItem("seamly:scan") === "fast"; } catch { return false; } })();
  const maxStride = Math.max(1, Math.floor(info.fps / 12));
  const scanStride = Math.max(clip(Math.ceil(n / 350), 1, maxStride), fastScan ? clip(Math.round(info.fps / 30), 1, maxStride) : 1);
  const scanFrames: number[] = [];
  for (let f = 0; f < n; f += scanStride) scanFrames.push(f);
  const sigs = new Map<number, Signature>();
  const scanWeight = scanStride > 1 ? 0.75 : 1;
  const fdsAll = await detectFrames(src, models, scanFrames, (i) => prog.stage("detect", scanWeight * (i + 1) / scanFrames.length), sigs, abort);
  // scene cuts from the scanned frames' signatures
  const hd: number[] = [], pd: number[] = [];
  for (let i = 1; i < scanFrames.length; i++) {
    const [h, p] = sigDistance(sigs.get(scanFrames[i - 1])!, sigs.get(scanFrames[i])!);
    hd.push(h); pd.push(p);
  }
  info.shots = segmentShots(hd, pd, scanFrames, n, info.fps, true);
  // a stride-1 scan has seen consecutive frames: the repeated-frame check can run before the expensive 2D pass
  if (scanStride === 1) scanFrames.slice(1).forEach((f, i) => info.frameDiff.set(f, pd[i]));
  const usable = info.shots.map((s, i) => [i, s] as const).filter(([, s]) => s.end - s.start >= Math.max(10, Math.trunc(0.4 * info.fps)));
  const perShot = new Map<number, Detection[]>();
  const motions = new Map<number, number[][]>();
  for (const [si, s] of usable) {
    const fds = fdsAll.filter((fd) => fd.frame >= s.start && fd.frame < s.end).map((fd, i) => (i === 0 ? { ...fd, motion: IDENTITY } : fd));
    perShot.set(si, track(fds, info.fps / scanStride));
    for (const fd of fds) motions.set(fd.frame, fd.motion);
  }
  prog.stage("select", 0);
  const [candidates, chosen] = select(info, perShot, opts, scanStride, realFps);
  const shot = info.shots[chosen.shot];
  const tracks = detectionsByTrack(perShot.get(chosen.shot)!);
  let bowlerDets = tracks.get(chosen.track)!;
  let others: Map<number, Detection[]> = new Map([...tracks].filter(([id]) => id !== chosen.track));   // everyone else, at the best rate scanned
  if (scanStride > 1 && fastScan) {
    // the camera's movement between two scanned frames, shared out over the frames between them
    for (const d of bowlerDets) {
      const M = motions.get(d.frame);
      if (!M || d.frame - scanStride < shot.start) continue;
      const sc = M[0][0], s1 = Math.pow(Math.max(1e-6, sc), 1 / scanStride);
      let sum = 0;
      for (let i = 0; i < scanStride; i++) sum += Math.pow(s1, i);
      const m1 = [[s1, 0, M[0][2] / sum], [0, s1, M[1][2] / sum]];
      for (let f = d.frame - scanStride + 1; f <= d.frame; f++) motions.set(f, m1);
    }
  } else if (scanStride > 1) {
    const pk0 = chosen.sweep!.peak_frame;
    const w0 = Math.max(shot.start, bowlerDets[0].frame, pk0 - Math.trunc(2.5 * realFps));
    const w1 = Math.min(shot.end, bowlerDets[bowlerDets.length - 1].frame + 1, pk0 + Math.trunc(1.2 * realFps));
    const wf: number[] = [];
    for (let f = w0; f < w1; f++) wf.push(f);
    const wsigs = new Map<number, Signature>();
    let fds = await detectFrames(src, models, wf, (i) => prog.stage("detect", scanWeight + (1 - scanWeight) * (i + 1) / wf.length), wsigs, abort);
    // the strided scan only places a cut to within `stride` frames: re-check the window at full rate and keep the
    // shot that contains the delivery (a replay or close-up right after the follow-through must not join it)
    const whd: number[] = [], wpd: number[] = [];
    for (let i = 1; i < wf.length; i++) {
      const [h, p] = sigDistance(wsigs.get(wf[i - 1])!, wsigs.get(wf[i])!);
      whd.push(h); wpd.push(p);
      info.frameDiff.set(wf[i], p);
    }
    const sub = segmentShots(whd, wpd, wf, w1, info.fps, true).find((x) => x.start <= pk0 && pk0 < x.end);
    const lo = Math.max(w0, sub?.start ?? w0), hi = Math.min(w1, sub?.end ?? w1);
    if (lo > w0 || hi < w1) fds = fds.filter((fd) => fd.frame >= lo && fd.frame < hi);
    fds[0] = { ...fds[0], motion: IDENTITY };
    for (const fd of fds) motions.set(fd.frame, fd.motion);
    // The strided scan chose the bowler; every frame of the window now has its own detections. Each frame's bowler
    // is the detection that lies where the scan's bowler is at that moment (between the two scanned frames either
    // side of it). Tracking the window afresh instead can swap two people as they cross: a bowler running past the
    // umpire came out of it as the umpire.
    const scanned = bowlerDets.filter((d) => d.frame >= lo - scanStride && d.frame < hi + scanStride);
    const picked: Detection[] = [];
    const rest: Detection[] = [];
    for (const fd of fds) {
      let p: Detection | null = null, q: Detection | null = null;
      for (const d of scanned) { if (d.frame <= fd.frame) p = d; else if (q === null) q = d; }
      p ??= q; q ??= p;
      if (!p || !q || Math.abs(fd.frame - p.frame) > 2 * scanStride || Math.abs(q.frame - fd.frame) > 2 * scanStride) continue;
      const a = q.frame === p.frame ? 0 : clip((fd.frame - p.frame) / (q.frame - p.frame), 0, 1);
      const box = p.box.map((v, i) => (1 - a) * v + a * q!.box[i]);
      const kps = p.kps.map((v, i) => [(1 - a) * v[0] + a * q!.kps[i][0], (1 - a) * v[1] + a * q!.kps[i][1]]);
      const hgt = Math.max(1, box[3] - box[1]);
      let bi = -1, bc = Infinity;
      fd.boxes.forEach((b, i) => {
        if (boxIou(b, box) < 0.2) return;
        const c = fd.kps[i].reduce((s2, k, j2) => s2 + Math.hypot(k[0] - kps[j2][0], k[1] - kps[j2][1]), 0) / 17 / hgt;
        if (c < bc) { bc = c; bi = i; }
      });
      fd.boxes.forEach((b, i) => {
        const d: Detection = { frame: fd.frame, track: i === bi && bc < 0.25 ? chosen.track : -1 - i, box: b, conf: fd.confs[i], kps: fd.kps[i], kcs: fd.kcs[i] };
        (d.track === chosen.track ? picked : rest).push(d);
      });
    }
    if (picked.length >= 5) {
      bowlerDets = picked;
      others = new Map([[-1, rest]]);
    } else if (lo > w0 || hi < w1) {
      const inShot = bowlerDets.filter((d) => d.frame >= lo && d.frame < hi);
      if (inShot.length) bowlerDets = inShot;
    }
  }
  // analysis window: from up to 2.5 s (real time) before release to 1.2 s after, inside the track
  const pk = chosen.sweep!.peak_frame;
  const f0 = Math.max(bowlerDets[0].frame, pk - Math.trunc(2.5 * realFps));
  let f1 = Math.min(bowlerDets[bowlerDets.length - 1].frame + 1, pk + Math.trunc(1.2 * realFps));
  const detByFrame = new Map(bowlerDets.filter((d) => d.frame >= f0 && d.frame < f1).map((d) => [d.frame, d]));
  // interpolate boxes over short tracker gaps so the refiner still gets a crop
  const known = [...detByFrame.keys()].sort((a, b) => a - b);
  const boxes = new Map<number, number[]>();
  // How visible each joint is, from the full-frame model. The crop model (RTMPose) places a joint it cannot see
  // about as confidently as one it can (it is trained to guess occluded joints), while the full-frame model's
  // confidence falls to near nothing on a hidden joint: a face seen from behind, an arm behind the trunk. The
  // engine's reading of which way the bowler faces and which arm bowls rests on that, so the crop model's
  // confidence is capped by it.
  const seen = new Map<number, number[]>();
  for (let fr = f0; fr < f1; fr++) {
    const d = detByFrame.get(fr);
    if (d) { boxes.set(fr, d.box); seen.set(fr, d.kcs); continue; }
    let prev: number | null = null, next: number | null = null;
    for (const k of known) { if (k < fr) prev = k; else if (k > fr && next === null) next = k; }
    if (prev !== null && next !== null && next - prev <= Math.trunc(0.5 * info.fps)) {
      const a = (fr - prev) / (next - prev), pd = detByFrame.get(prev)!, nd = detByFrame.get(next)!;
      // (in the fast scan every other frame is placed this way: the crop then covers the bowler in both the frames
      // either side, so that an arm on its way up is not cut off)
      boxes.set(fr, fastScan && next - prev <= scanStride ? [Math.min(pd.box[0], nd.box[0]), Math.min(pd.box[1], nd.box[1]), Math.max(pd.box[2], nd.box[2]), Math.max(pd.box[3], nd.box[3])]
        : pd.box.map((v, i) => (1 - a) * v + a * nd.box[i]));
      seen.set(fr, pd.kcs.map((v, i) => (1 - a) * v + a * nd.kcs[i]));
    }
  }

  if (scanStride === 1) checkRepeats(info, f0, f1, realFps, opts);

  // ---------------- top-down 2D on crops + display frames ----------------
  const { width: W, height: H } = info;
  const ds = Math.min(1, FRAME_JPEG_MAX_SIDE / Math.max(W, H));
  const disp = canvas(Math.round(W * ds), Math.round(H * ds));
  const dctx = disp.getContext("2d")!;
  const sigc = canvas(64, 36).getContext("2d", { willReadFrequently: true })!;
  const frames = new Map<number, Blob>();
  const refined: (RefinedPose | null)[] = [];
  const pendingJpeg: Promise<void>[] = [];
  let feet: (number[][] | null)[] = [];
  // For tuning the rules offline: a test page can set window.__seamlyRaw to receive the models' raw output for a
  // clip (see docs/ACCURACY.md 9h). Nothing sets it in the app.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dbgRaw = (globalThis as any).__seamlyRaw as ((x: unknown) => void) | undefined;
  const rawRefined: unknown[] = [];
  let prevSig: Signature | null = null;
  if (f0 > 0) { await src.seek(f0 - 1); prevSig = signature(sigc, src.video, W, H); }
  const nWin = f1 - f0;
  for (let fr = f0; fr < f1; fr++) {
    if (abort?.aborted) throw new AnalysisError("Analysis cancelled.");
    let tc = performance.now();
    await src.seek(fr);
    tc = clock("joints: frame", tc);
    const v = src.video;
    const sg = signature(sigc, v, W, H);
    if (prevSig) info.frameDiff.set(fr, sigDistance(prevSig, sg)[1]);
    prevSig = sg;
    tc = clock("joints: signature", tc);
    dctx.drawImage(v, 0, 0, disp.width, disp.height);
    // the frame as shown on the page is packed while the joints model runs (the browser does it off this thread)
    pendingJpeg.push(jpegAsync(disp, FRAME_JPEG_QUALITY).then((jp) => { if (onFrame) onFrame(fr, jp); else frames.set(fr, jp); }));
    tc = clock("joints: jpeg", tc);
    const b = boxes.get(fr);
    const rp = b ? await models.pose.refineCrop(v, W, H, b, fr) : null, vis = seen.get(fr);
    clock("joints: crop model", tc);
    if (rp && dbgRaw) rawRefined.push({ frame: fr, kps: rp.kps.map((p) => [...p]), kcs: [...rp.kcs], extra: rp.extra ?? null });
    if (rp && vis) rp.kcs = rp.kcs.map((c, j) => Math.min(c, 0.15 + 1.2 * vis[j]));
    refined.push(rp);
    feet.push(rp?.extra ? rp.extra.map((p) => [p[0], p[1], p[2]]) : null);
    prog.stage("pose2d", (fr - f0 + 1) / nWin);
  }
  await Promise.all(pendingJpeg);
  checkRepeats(info, f0, f1, realFps, opts);
  const refinedList = refined.filter((r): r is RefinedPose => r !== null);
  let [kp, kc] = assemble(refinedList, detByFrame, f0, f1);
  const fps = realFps;   // filters and the lifter work in real time
  kc = hampel(kp, kc, fps);
  let nSwaps: number;
  [kp, kc, nSwaps] = fixSwaps(kp, kc, 0.25, true);   // a flicker is fixed; limbs that really cross are left
  [kp, kc] = interpolateGaps(kp, kc, fps);
  kp = fixArmGlitches(kp, kc, fps);   // a wrist or elbow misread for one frame, before it is smeared by the smoothing
  let kpS = smoothKeypoints(kp, fps);
  // broadcast cameras zoom in after release (phone clips can lose the bowler off the frame edge): end the
  // window where tracking collapses or the camera has zoomed in hard since release
  const winMot = [];
  for (let fr = f0; fr < f1; fr++) winMot.push(motions.get(fr));
  const Tuse = usableLength(kc, winMot, pk - f0, fps);
  if (Tuse < f1 - f0) {
    for (let fr = f0 + Tuse; fr < f1; fr++) frames.delete(fr);
    f1 = f0 + Tuse;
    kp = kp.slice(0, Tuse); kc = kc.slice(0, Tuse); kpS = kpS.slice(0, Tuse); feet = feet.slice(0, Tuse);
  }

  // ---------------- 3D lifting ----------------
  prog.stage("lift", 0);
  const seq = cocoToH36m(kpS, kc);
  const X = await models.lifter.liftResampled(seq, fps);
  const mot = [];
  for (let fr = f0; fr < f1; fr++) mot.push(motions.get(fr) ?? IDENTITY);
  mot[0] = IDENTITY;
  const bbox = [];
  for (let fr = f0; fr < f1; fr++) bbox.push(boxes.get(fr) ?? [NaN, NaN, NaN, NaN]);
  const meanKc = kc.flat().reduce((a, b) => a + b, 0) / Math.max(1, kc.length * 17);
  const stageA: StageA = {
    X, seq, kp, kp_s: kpS, kc, motions: mot, bbox, timestamps: info.timestamps, feet,
    meta: {
      version: 3, video: videoInfoDict(info), analysis_window: { start: f0, end: f1 }, display_scale: ds, fps: info.fps,
      options: opts, bowler: { track: chosen.track, shot: chosen.shot, score: trackScoreDict(chosen) },
      sweep: { side: chosen.sweep!.side, start: chosen.sweep!.start_frame, end: chosen.sweep!.end_frame, peak: chosen.sweep!.peak_frame,
        peak_speed_dps: chosen.sweep!.peak_speed },
      candidates: candidates.map(trackScoreDict), pose3d: "motionbert",
      quality: { lr_swaps_fixed: nSwaps, mean_kp_conf: round(meanKc, 3), frames_refined: refinedList.length, frames_total: f1 - f0,
        repeated_frames: round(repeatedFraction(info, f0, f1), 3) },
      timing_stage_a_s: round((performance.now() - t0) / 1000, 1),
    },
  };
  prog.stage("lift", 1);
  prog.report("stage A");
  if (dbgRaw) dbgRaw({ hd, pd, others: [...others.values()].map((v) => v.filter((d) => d.frame >= f0 - 30 && d.frame < f1 + 30)).filter((v) => v.length), stageA, rawRefined, f0, f1: f0 + (f1 - f0), pk, scanStride, dets: [...detByFrame.values()].map((d) => ({ frame: d.frame, box: d.box, kps: d.kps, kcs: d.kcs })),
    scan: fdsAll.map((fd) => ({ frame: fd.frame, boxes: fd.boxes, confs: fd.confs, kps: fd.kps, kcs: fd.kcs, appearance: fd.appearance.map((x) => Array.from(x as ArrayLike<number>)), motion: fd.motion })) });
  return { stageA, frames };
}

// ======================================================================================================
// Stage B
// ======================================================================================================
const EVENT_LABELS: Record<EventKey, string> = { bfc: "Back-foot contact", ffc: "Front-foot contact", uah: "Upper arm horizontal",
  br: "Ball release", ft: "Follow-through" };
const ORDER_RULES: [EventKey, EventKey][] = [["bfc", "ffc"], ["ffc", "br"], ["bfc", "br"], ["uah", "br"], ["br", "ft"]];

function reconcileAutoEvents(ev: Events, edited: EventKey[], T: number) {
  const toMove = (a: EventKey, b: EventKey): EventKey | null => {
    if (edited.includes(a) && edited.includes(b)) return null;
    if (edited.includes(a) || edited.includes(b)) {
      const auto = edited.includes(a) ? b : a;
      return auto === "br" ? null : auto;
    }
    return a === "br" ? b : a;
  };
  for (let it = 0; it < 4; it++) {
    let changed = false;
    for (const [a, b] of ORDER_RULES) {
      const fa = ev[a], fb = ev[b];
      if (fa === null || fb === null || fa < fb) continue;
      const auto = toMove(a, b);
      if (auto === null) continue;
      const nw = it < 3 ? (auto === b ? fa + 1 : fb - 1) : null;
      (ev as unknown as Record<string, number | null>)[auto] = nw !== null && nw >= 0 && nw < T ? nw : null;
      ev.method[auto] = "constrained";
      ev.confidence[auto] = Math.min(ev.confidence[auto] ?? 0.5, 0.25);
      changed = true;
    }
    if (!changed) return;
  }
}

function checkEventOrder(ev: Events, edited: EventKey[], f0: number, latest?: EventKey[] | null) {
  for (const [a, b] of ORDER_RULES) {
    const fa = ev[a], fb = ev[b];
    if (fa === null || fb === null || fa < fb) continue;
    if (edited.includes(a) || edited.includes(b)) {
      const moved = (latest ?? []).find((k) => k === a || k === b) ?? (edited.includes(b) ? b : a);
      const other = moved === b ? a : b;
      const hint = `Move the ${EVENT_LABELS[moved].toLowerCase()} marker to a frame in the right order`
        + (edited.includes(other) ? "." : `, or first correct the automatic ${EVENT_LABELS[other].toLowerCase()} if it is wrong.`);
      throw new AnalysisError(`${EVENT_LABELS[a]} (frame ${fa + f0}) must come before ${EVENT_LABELS[b].toLowerCase()} (frame ${fb + f0}). ${hint}`);
    }
  }
}

export interface Overrides {
  events?: Partial<Record<EventKey, number | null>>;
  latest_events?: EventKey[];
  bowling_arm?: "auto" | "left" | "right";
  height_m?: number | null;
  default_height_m?: number | null;   // stature to assume when none is entered (e.g. typical for the player's age)
  view?: ViewInfo["view"];
  gender?: number;
}

export interface StageBOut {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result: any;
  mesh: { rest: ArrayBuffer; pose: ArrayBuffer };
}

// left/right swapped for the arms only (shoulders, elbows, wrists), in COCO and H36M order
const COCO_ARM_FLIP = [0, 1, 2, 3, 4, 6, 5, 8, 7, 10, 9, 11, 12, 13, 14, 15, 16];
const H36M_ARM_FLIP = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 14, 15, 16, 11, 12, 13];

/** Everything after 3D lifting; fast enough to re-run on every user correction. */
export async function stageB(A: StageA, overrides: Overrides = {}, onProgress?: ProgressCb): Promise<StageBOut> {
  const prog = new Progress(onProgress);
  const meta = A.meta;
  let { X, seq, kp_s: kpS, kc } = A;
  const mot = A.motions, tsAll = A.timestamps;
  const f0 = meta.analysis_window.start, f1 = meta.analysis_window.end;
  const T = f1 - f0;
  // clip speed is a stage-A option (it sets the analysis window and filters), so it is not overridable here
  const opts = optionsFrom({ ...meta.options, ...(overrides.bowling_arm ? { bowling_arm: overrides.bowling_arm } : {}),
    ...(overrides.height_m !== undefined ? { height_m: overrides.height_m } : {}) });
  const fps = meta.fps;
  const realFps = fps * opts.slowmo_factor;
  const height = opts.height_m ?? overrides.default_height_m ?? DEFAULT_HEIGHT_M;
  const sweep = meta.sweep;
  const depthW = meta.pose3d === "sam3d" ? 20 : null;
  prog.stage("events", 0.1);
  let sweepLo = Math.trunc(clip(sweep.start - f0, 0, T - 1));
  let sweepHi = Math.trunc(clip(sweep.end - f0, 0, T - 1));
  let sweepSide: string | null = sweep.side;
  {
    // The scan places the delivery by the widest turn of an arm in the picture. Filmed from in front or behind,
    // the bowling arm turns in a plane the camera sees edge-on, and the widest turn can be the gather before the
    // delivery or the other arm's swing after it (a 100 fps net clip put it 0.35 s late, on the follow-through).
    // What shows from every side is the wrist going up and over. When either arm has a clear one near the scan's
    // window but outside it, the delivery is there: the window moves to it, and the scan's guess at the arm is dropped.
    const w = Math.trunc(0.8 * realFps);
    const [vr, tr] = bestUpswing(kpS, kc, 6, 8, 10, sweepLo - w, sweepHi + w, realFps);
    const [vl, tl] = bestUpswing(kpS, kc, 5, 7, 9, sweepLo - w, sweepHi + w, realFps);
    let [v, at] = vr >= vl ? [vr, tr] : [vl, tl];
    const [v2, at2] = vr >= vl ? [vl, tl] : [vr, tr];
    // the other arm went over first, 0.15 to 0.45 s earlier and nearly as strongly: this one is the trailing arm
    if (v2 >= 2.5 && at - at2 >= 0.15 * realFps && at - at2 <= 0.45 * realFps && v - v2 <= 1.0) [v, at] = [v2, at2];
    const m = Math.trunc(0.1 * realFps);
    // (a little less clear, 3.0, is enough when the scan's own window holds no up-and-over worth the name by either
    // arm: at 25 frames a second the arm's fall after the top is three frames long and scores lower than it should,
    // and the scan had settled on the front arm's rise before the delivery, eight frames early)
    const topIn = ([q, t]: [number, number]) => (t >= sweepLo - m && t <= sweepHi + m ? q : 0);   // (one that tops out inside the window)
    const inside = Math.max(topIn(bestUpswing(kpS, kc, 6, 8, 10, sweepLo - m, sweepHi + m, realFps)), topIn(bestUpswing(kpS, kc, 5, 7, 9, sweepLo - m, sweepHi + m, realFps)));
    if ((v >= 3.5 || (v >= 3.0 && inside < 2.5)) && (at < sweepLo - m || at > sweepHi + m)) {
      sweepLo = Math.max(0, at - Math.trunc(0.25 * realFps));
      sweepHi = Math.min(T - 1, at + m);
      sweepSide = null;
    }
  }
  const armWindow: [number, number] = [sweepLo - Math.trunc(0.1 * realFps), sweepHi + Math.trunc(0.1 * realFps)];
  const h2d = (s: Arr3) => s.map((f) => f.map((p) => [p[0], p[1]]));
  const c2d = (s: Arr3) => s.map((f) => f.map((p) => p[2]));
  let skel = reconstruct(X, h2d(seq), c2d(seq), height, realFps, { depthW });
  let P = skel.joints;
  let labelsSwapped = false;
  let arm: Arm, armConf: number, votes: Record<string, number>;
  if (opts.bowling_arm === "auto") {
    [arm, armConf, votes] = decideBowlingArm(kpS, kc, P, realFps, sweepSide, armWindow, true);
  } else {
    arm = opts.bowling_arm; armConf = 1; votes = { user: 1 };
    const [, , av] = decideBowlingArm(kpS, kc, P, realFps, sweepSide, armWindow, true);
    const other = arm === "right" ? -1 : 1;
    if (av.fast_high_2d === other && (av.speed_2d === other || av.over_top === other)) {
      // every cue says the *other* arm bowls: the detector labelled left/right as if the bowler faced the other
      // way (front/back ambiguity). Mirror the labels consistently in 2D and 3D.
      kpS = kpS.map((f) => COCO_FLIP.map((j) => f[j]));
      kc = kc.map((f) => COCO_FLIP.map((j) => f[j]));
      X = X.map((f) => H36M_FLIP.map((j) => f[j]));
      seq = seq.map((f) => H36M_FLIP.map((j) => f[j]));
      skel = reconstruct(X, h2d(seq), c2d(seq), height, realFps, { depthW });
      P = skel.joints;
      labelsSwapped = true;
    }
  }
  // (one-frame misreadings mended as stage A now does, for analyses whose stage A was made before it did; the same
  // left/right labels as the smoothed joints)
  const armsRaw0 = fixArmGlitches(A.kp, A.kc, realFps);
  let armsRaw = labelsSwapped ? armsRaw0.map((f) => COCO_FLIP.map((j) => f[j])) : armsRaw0;
  // the same joints with an arm the model lost behind the body carried across the loss (pose2d.mendLostArms), kept
  // beside the plain ones under the same labels: the non-bowling arm is taken from these once the arm is settled.
  // The bowling arm is never mended: its release is read from the joints as the model gave them.
  const lost0: boolean[][] = A.kp.map(() => new Array<boolean>(17).fill(false));
  let kpM = smoothKeypoints(fixArmGlitches(mendLostArms(A.kp, A.kc, realFps, [0, 1], lost0), A.kc, realFps), realFps);
  // The arm tracer (engine/armnet.ts), when its weights are there: both elbows and wrists corrected from the whole
  // clip. It takes the place of the carrying-across above; a joint it moved far, or is unsure of, counts as not seen.
  const armNet = ARMNET.on ? await loadArmNet() : null;
  const traced = armNet ? traceArms(armNet, A.kp, A.kc, realFps) : null;
  if (traced) {
    kpM = smoothKeypoints(traced.kp, realFps);
    const bh = bodyHeightPx(A.kp, A.kc);
    traced.moved.forEach((mv, t) => [7, 8, 9, 10].forEach((j, q) => { lost0[t][j] = mv[q] > ARMNET.far * bh[t] || traced.spread[t][q] > ARMNET.unsure * bh[t]; }));
  }
  let lostM = lost0;
  if (labelsSwapped) { kpM = kpM.map((f) => COCO_FLIP.map((j) => f[j])); lostM = lostM.map((f) => COCO_FLIP.map((j) => f[j])); }
  const up0: [number, number, number] = [0, -1, 0];
  const runup: number[] = [];
  for (let t = 0; t < Math.max(0, sweepLo - Math.trunc(0.35 * realFps)); t++) runup.push(t);
  const hintReliable = runup.length >= Math.max(4, Math.trunc(0.2 * realFps));
  const fwdHint = (P: Arr3): number[] => {
    if (hintReliable) return facingDirection(P, up0, runup);
    const rel: number[] = [];
    for (let t = Math.min(T - 1, sweepHi); t < Math.min(T, sweepHi + Math.trunc(0.15 * realFps) + 1); t++) rel.push(t);
    return facingDirection(P, up0, rel.length ? rel : [T - 1]);
  };
  let side = sideForArm(arm);
  const ref = Math.min(T - 1, Math.max(0, sweepHi));
  // Where to look for the release. The scan's fastest moment belongs to whichever arm swept the wider arc, which
  // from in front or behind is often the front arm; the bowling arm's own clearest up-and-over, on the refined
  // keypoints, is the better anchor when there is one.
  const anchorFor = (sd: ReturnType<typeof sideForArm>): number => {
    const [v, at] = bestUpswing(kpS, kc, sd.c_sh, sd.c_el, sd.c_wr, armWindow[0] - Math.trunc(0.2 * realFps), armWindow[1] + Math.trunc(0.15 * realFps), realFps);
    return v >= 2.5 ? at : sweep.peak - f0;
  };
  // user-edited events (absolute frame numbers) are fixed; the others are detected around them
  const fixed: Partial<Record<EventKey, number>> = {};
  for (const [k, v] of Object.entries(overrides.events ?? {}))
    if (["bfc", "ffc", "uah", "br", "ft"].includes(k) && v !== null && v !== undefined) fixed[k as EventKey] = Math.trunc(clip(Math.trunc(v) - f0, 0, T - 1));
  const edited = (Object.keys(fixed) as EventKey[]).sort();

  /** Events, world frame and camera view from the current labels, with the final skeleton. */
  const locate = (P0: Arr3) => {
    let P = P0;
    const forwardHint = fwdHint(P);
    const kpStab = stabilise(kpS, mot, ref);
    const bodyPx = bodyHeightPx(kpS, kc);
    let ev = detectEvents(kpS, kc, kpStab, P, side, up0, forwardHint, realFps, bodyPx, [sweepLo, sweepHi], anchorFor(side), fixed, true);
    let wf = estimateWorldFrame(P, ev.ffc, ev.bfc, side.front_ankle, side.back_ankle, forwardHint, hintReliable);
    ev = detectEvents(kpS, kc, kpStab, P, side, wf.up, wf.forward, realFps, bodyPx, [sweepLo, sweepHi], anchorFor(side), fixed, true);
    if (edited.length) {
      reconcileAutoEvents(ev, edited, T);
      checkEventOrder(ev, edited, f0, overrides.latest_events);
      wf = estimateWorldFrame(P, ev.ffc, ev.bfc, side.front_ankle, side.back_ankle, forwardHint, hintReliable);
    }
    let sk = skel;
    // second 3D pass with physics: while the front foot is planted (FFC -> just after release) it stays ahead of its
    // knee and of the pelvis along the direction of travel (resolves the monocular depth-sign ambiguity)
    if (ev.ffc !== null && ev.br > ev.ffc) {
      const stance: number[] = [];
      for (let t = ev.ffc; t < Math.min(T, ev.br + Math.max(2, Math.round(0.05 * realFps)) + 1); t++) stance.push(t);
      const fwd = wf.forward;
      // (the non-bowling arm, where the model lost it, is fitted to where it was carried, not to the misreading)
      const s2 = h2d(seq), c2 = c2d(seq);
      if (traced && ARMNET.fig) {
        // (the tracer's joints for both arms; the bowling wrist only if it is trusted with it)
        const H2C: [number, number][] = [[12, 7], [13, 9], [15, 8], [16, 10]];
        for (const [hj, cj] of H2C) {
          if (cj === side.c_wr && !ARMNET.bowlWrist) continue;
          if (cj === side.c_el && !ARMNET.bowlElbow) continue;
          for (let t = 0; t < T; t++) { s2[t][hj] = [kpM[t][cj][0], kpM[t][cj][1]]; if (lostM[t][cj]) c2[t][hj] = Math.max(c2[t][hj], MEND.figConf); }
        }
      } else if (MEND.on && MEND.fig) {
        const cj = side.c_wr === 10 ? [7, 9] : [8, 10], hj = side.c_wr === 10 ? [12, 13] : [15, 16];
        for (let t = 0; t < T; t++) cj.forEach((j, q) => { if (lostM[t][j]) { s2[t][hj[q]] = [kpM[t][j][0], kpM[t][j][1]]; c2[t][hj[q]] = Math.max(c2[t][hj[q]], MEND.figConf); } });
      }
      sk = reconstruct(X, s2, c2, height, realFps, { depthW,
        priors: [[stance, side.front_knee, side.front_ankle, fwd, -0.03], [stance, PELVIS, side.front_ankle, fwd, 0.05]] });
      P = sk.joints;
      wf = estimateWorldFrame(P, ev.ffc, ev.bfc, side.front_ankle, side.back_ankle, forwardHint, hintReliable);
    }
    // with the feet out of the picture the ankles are extrapolated: the stride can't tell the camera's view
    const strideX = feetOutOfFrame(kpS, kc, ev.ffc, ev.br, realFps, meta.video.height) ? null
      : strideAcross(kpS, sk.px_per_m, sk.bone_lengths[1] + sk.bone_lengths[2], side, ev.ffc, ev.br);
    const view: ViewInfo = classifyView(wf.forward, kpS, kc, runup.length >= 4 ? runup : null, strideX);
    return { ev, wf, sk, P, view };
  };
  let L = locate(P);
  // The user says the camera was behind the bowler and the analysis read it as in front (or the reverse): the
  // detector took the back for the front, so left and right are labelled as if the bowler faced the other way.
  // Mirror the labels (undoing an arm-cue mirror if one was made) and locate everything again.
  // The same mirror without being told: a bowler who gets much smaller through the run-up is running away from the
  // camera, so the camera is behind. Seen from behind in poor light the model can take the back for the front (a
  // dark copy of a nets clip did); a real front-on bowler grows, or is followed by a zoom, and never shrinks by a
  // third in a second (the most on any front-on clip tested was 22% a second; from behind near the camera, 35 to 100%).
  const shrinking = overrides.view === undefined && L.view.view === "front_on" && (sizeTrend(kpS, kc, sweepHi, realFps) ?? 0) <= -30;
  const opposite = overrides.view === "behind" || shrinking ? "front_on" : overrides.view === "front_on" ? "behind" : null;
  if (opposite !== null && L.view.view === opposite) {
    armsRaw = armsRaw.map((f) => COCO_FLIP.map((j) => f[j]));
    kpM = kpM.map((f) => COCO_FLIP.map((j) => f[j])); lostM = lostM.map((f) => COCO_FLIP.map((j) => f[j]));
    kpS = kpS.map((f) => COCO_FLIP.map((j) => f[j]));
    kc = kc.map((f) => COCO_FLIP.map((j) => f[j]));
    X = X.map((f) => H36M_FLIP.map((j) => f[j]));
    seq = seq.map((f) => H36M_FLIP.map((j) => f[j]));
    skel = reconstruct(X, h2d(seq), c2d(seq), height, realFps, { depthW });
    P = skel.joints;
    labelsSwapped = !labelsSwapped;
    if (opts.bowling_arm === "auto") [arm, armConf, votes] = decideBowlingArm(kpS, kc, P, realFps, sweepSide, armWindow, true);
    else {
      // The arm and the view are separate facts. A bowling arm goes well above its shoulder around release: if after
      // the mirror the user's bowling arm never does and the other arm does, the detector had labelled the arms right
      // and only the body the wrong way round, so the arms go back.
      const lo = Math.max(0, armWindow[0]), hi = Math.min(T, armWindow[1] + 1);
      const top = (sd: ReturnType<typeof sideForArm>) => (hi > lo ? Math.max(...wristLift(kpS, sd.c_sh, sd.c_el, sd.c_wr).slice(lo, hi)) : 0);
      if (top(sideForArm(arm)) < 0.3 && top(sideForArm(arm === "right" ? "left" : "right")) > 0.8) {
        kpS = kpS.map((f) => COCO_ARM_FLIP.map((j) => f[j]));
        kpM = kpM.map((f) => COCO_ARM_FLIP.map((j) => f[j])); lostM = lostM.map((f) => COCO_ARM_FLIP.map((j) => f[j]));
        kc = kc.map((f) => COCO_ARM_FLIP.map((j) => f[j]));
        X = X.map((f) => H36M_ARM_FLIP.map((j) => f[j]));
        seq = seq.map((f) => H36M_ARM_FLIP.map((j) => f[j]));
        skel = reconstruct(X, h2d(seq), c2d(seq), height, realFps, { depthW });
        P = skel.joints;
      }
    }
    side = sideForArm(arm);
    L = locate(P);
  }
  const { ev, wf } = L;
  skel = L.sk; P = L.P;
  // the non-bowling arm where the model lost it: carried across (see above). `armLost`: those frames, elbow and wrist.
  const nb = arm === "right" ? [7, 9] : [8, 10];
  const armLost = lostM.map((f) => nb.map((j) => f[j]));
  if (traced) {
    const take = [...nb, ...(ARMNET.bowlElbow ? [side.c_el] : []), ...(ARMNET.bowlWrist ? [side.c_wr] : [])];
    kpS = kpS.map((f, t) => f.map((p, j) => (take.includes(j) ? kpM[t][j] : p)));
  } else if (MEND.on && armLost.some((f) => f[0] || f[1])) kpS = kpS.map((f, t) => f.map((p, j) => (nb.includes(j) ? kpM[t][j] : p)));
  let view = L.view;
  if (overrides.view === "side_on" || overrides.view === "behind" || overrides.view === "front_on") {
    const { oblique: _o, ...rest } = view;
    view = { ...rest, view: overrides.view, source: "user" };
  }
  const oblique = !!view.oblique;
  prog.stage("metrics", 0.2);
  const Wd = toWorld(wf, P);
  const rep = meta.quality.repeated_frames || 0;
  const fpsUnique = realFps * (1 - rep);
  const frameH = meta.video.height;
  const ctx: Ctx = { P, W: Wd, kp: kpS, kc, side, wf, view: view.view, fps: realFps, stature: height, k: skel.px_per_m, ev,
    bone_lengths: skel.bone_lengths, fps_unique: fpsUnique, oblique, frame_h: frameH };
  const mres = compute(ctx);
  const coaching = coach(mres.metrics, oblique ? "oblique" : view.view, rep >= 0.4 ? fpsUnique : realFps);
  // a real delivery's arm turns at >~700°/s; much slower suggests a slowed-down (replay) clip
  let peakReal = sweep.peak_speed_dps || 0;
  if ((meta.version ?? 2) < 3) peakReal *= opts.slowmo_factor;
  if (rep >= 0.4) {
    const n = 1 / Math.max(1e-3, 1 - rep);
    const nTxt = Math.abs(n - Math.round(n)) < 0.15 ? n.toFixed(0) : n.toFixed(1);
    if (opts.slowmo_factor <= 1) {
      coaching.capture_tips.unshift(`Many frames in this clip are exact repeats (each shown ~${nTxt}x). If it was slowed down, set its clip speed to ~${nTxt}x in Detection & `
        + `settings so timings are correct; if it was filmed at a low frame rate, timing precision is limited to ~${(1000 / fpsUnique).toFixed(0)} ms.`);
    } else {
      coaching.capture_tips.unshift(`Each frame of this clip is repeated ~${nTxt}x, so only ~${fpsUnique.toFixed(0)} distinct frames were captured per real second; precision follows that rate, not the slowed-down frame count.`);
    }
  } else if (peakReal > 0 && peakReal < 650 && (armPeakSpeed(kpS, kc, side.c_sh, side.c_wr, ev.br, realFps) ?? 0) < 650) {
    // the scan's arm speed reads low on blurred, fast arms; the refined keypoints around release must agree
    coaching.capture_tips.unshift(`The bowling arm peaks at only ~${peakReal.toFixed(0)}°/s, which is unusually slow for a real delivery. If this clip is a slowed-down replay, set its clip speed in Detection & settings so timings are correct.`);
  }
  if (peakReal > 7000) {
    // no bowling arm turns this fast on video; a bat swing close to the camera can. (The bar was 4500: three real
    // nets clips at 60 to 100 frames a second read 5000 to 5600 with the skeleton on the bowler throughout, and
    // raters who looked at them called the warning false. The scan's speed reads higher at high frame rates.)
    coaching.capture_tips.unshift("The arm movement Seamly followed is faster than a bowling arm turns, so it may have followed the wrong person (for example a batter close to the camera). Check the skeleton is on the bowler, and film from behind the bowler's stumps.");
  }
  // the whole body in the picture: feet around landing and release, the bowling hand at release
  if (feetOutOfFrame(kpS, kc, ev.ffc, ev.br, realFps, frameH)) coaching.capture_tips.unshift(FEET_OUT_TIP);
  // Not a delivery at all? A bowler's hand goes well above the shoulder at release and the feet are a stride apart
  // just before it. When neither is so (the hand never a fifth of the body's height above the shoulder, the feet
  // never more than 0.15 of it apart), the clip is someone standing or walking: a fielder, an umpire, a bowler
  // walking back. Of 39 real clips, the two this catches were both such (rated 2 out of 10 by eye); every real
  // delivery clears one bar or the other.
  let looksLikeDelivery = true;
  {
    const bhs = bodyHeightPx(kpS, kc).slice().sort((a, b) => a - b), bodyH = bhs[bhs.length >> 1] || 0;
    if (bodyH > 0) {
      let lift = -Infinity, stride = 0;
      for (let t = Math.max(0, ev.br - 3); t <= Math.min(T - 1, ev.br + 3); t++) lift = Math.max(lift, (kpS[t][side.c_sh][1] - kpS[t][side.c_wr][1]) / bodyH);
      for (let t = Math.max(0, ev.br - Math.round(0.4 * realFps)); t <= ev.br; t++) stride = Math.max(stride, Math.hypot(kpS[t][15][0] - kpS[t][16][0], kpS[t][15][1] - kpS[t][16][1]) / bodyH);
      if (lift < 0.2 && stride < 0.15) {
        looksLikeDelivery = false;
        coaching.capture_tips.unshift("This does not look like a bowling delivery: the person Seamly followed never lifts a hand well above the shoulder or takes a stride. It may have followed a fielder or an umpire, or the clip may not contain the delivery. Check the skeleton is on the bowler, and trim the clip to one delivery.");
      }
    }
  }
  if (handOutOfFrame(kpS, side.c_wr, ev.br, frameH)) coaching.capture_tips.unshift(HAND_OUT_TIP);
  prog.stage("mesh", 0.1);
  const mesh = await exportMesh(Wd, height, overrides.gender ?? meta.options.gender ?? 0, arm);
  prog.stage("save", 0.2);
  const ds = meta.display_scale;
  const frames: number[] = [];
  for (let f = f0; f < f1; f++) frames.push(f);
  const groundW = Wd.map((fr, t) => fr.map((p) => p.map((v, c) => v + (mesh.groundOffset[t][c] as number))));
  const reprojAll = skel.reproj_err_px.flat().slice().sort((a, b) => a - b);
  const medReproj = reprojAll.length ? (reprojAll.length % 2 ? reprojAll[reprojAll.length >> 1]
    : (reprojAll[reprojAll.length / 2 - 1] + reprojAll[reprojAll.length / 2]) / 2) : 0;
  const result = {
    version: meta.version, video: meta.video, analysis_window: meta.analysis_window, display_scale: meta.display_scale,
    bowler: meta.bowler, candidates: meta.candidates, quality: meta.quality,
    fps, fps_real: realFps, pose3d: meta.pose3d, options: opts,
    bowling_arm: { arm, confidence: round(armConf, 2), votes, source: opts.bowling_arm !== "auto" ? "user" : "auto", labels_swapped: labelsSwapped },
    view, world: worldFrameDict(wf), events: eventsAsDict(ev, f0, tsAll), events_edited: edited,
    metrics: mres.metrics, series: mres.series, coaching,
    frames: { start: f0, end: f1, times: frames.map((f) => round(tsAll[f], 4)) },
    keypoints2d: { names: COCO_NAMES, xy: kpS.map((fr) => fr.map((p) => [round(p[0] * ds, 1), round(p[1] * ds, 1)])),
      conf: kc.map((fr) => fr.map((c) => round(c, 2))) },
    // for measuring on the pitch (lib/onpitch.ts): the feet's own points and how the camera moved, frame to frame
    // the bowling arm as the model read it frame by frame, not smoothed in time (elbows and wrists: left, right):
    // the release is measured from these, because smoothing flattens and delays the top of a fast arm
    // frames where the non-bowling arm's elbow / wrist was not seen and is carried across from where it was (0/1 pairs)
    arm_lost: armLost.map((f) => [f[0] ? 1 : 0, f[1] ? 1 : 0]),
    arm_tracer: !!traced,
    looks_like_delivery: looksLikeDelivery,
    arms_raw: armsRaw.map((fr) => [7, 8, 9, 10].map((j) => [round(fr[j][0] * ds, 1), round(fr[j][1] * ds, 1)])),
    ...(A.feet ? { feet: A.feet.map((fr) => (fr ? fr.map((p) => [round(p[0] * ds, 1), round(p[1] * ds, 1), round(p[2], 2)]) : null)) } : {}),
    camera_motion: mot.map((m) => m.map((r) => r.map((v) => round(v, 5)))),
    skeleton3d: { names: H36M_NAMES, parents: H36M_PARENTS, coords: "three",
      joints: worldToThree(groundW).map((fr) => fr.map((p) => p.map((v) => round(v, 4)))) },
    skeleton: { bone_lengths_m: skel.bone_lengths.map((v) => round(v, 4)), stature_m: height,
      height_source: opts.height_m ? "user" : "default", reproj_err_px_median: round(medReproj, 2) },
    mesh: mesh.info,
    timing_stage_a_s: meta.timing_stage_a_s,
  };
  prog.report("stage B");
  return { result, mesh: { rest: mesh.rest, pose: mesh.pose } };
}
