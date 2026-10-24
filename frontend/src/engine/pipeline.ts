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
import { assemble, bodyHeightPx, fixSwaps, hampel, interpolateGaps, smoothKeypoints } from "./pose2d";
import { classifyView, decideBowlingArm, detectEvents, facingDirection, stabilise, strideAcross } from "./events";
import { estimateWorldFrame, reconstruct } from "./kinematics";
import { compute, type Ctx } from "./metrics";
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
const FRAME_JPEG_QUALITY = 0.85;

export type ProgressCb = (p: { stage: string; label: string; progress: number; detail?: string | null; elapsed: number }) => void;

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
  stage(key: string, frac = 0, detail: string | null = null) {
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
/** Load (once) the detection and lifting models; ~70 MB, cached by the browser after the first visit. */
export function loadModels(onProgress?: (f: number) => void): Promise<Models> {
  if (!modelsP) {
    let a = 0, b = 0;
    const rep = () => onProgress?.(0.8 * a + 0.2 * b);
    modelsP = Promise.all([PoseModels.load((f) => { a = f; rep(); }), Lifter.load((f) => { b = f; rep(); })])
      .then(([pose, lifter]) => ({ pose, lifter }))
      .catch((e) => { modelsP = null; throw e; });
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
    await src.seek(f);
    const v = src.video;
    if (sigs && !sigs.has(f)) sigs.set(f, signature(sigc, v, W, H));
    const det = await models.pose.detect(v, W, H);
    wctx.drawImage(v, 0, 0, work.width, work.height);
    const img = wctx.getImageData(0, 0, work.width, work.height);
    fctx.drawImage(v, 0, 0, flow.width, flow.height);
    const grey = toGrey(fctx.getImageData(0, 0, flow.width, flow.height), fs);
    const m = motion.next(grey, det.boxes);
    out.push({ frame: f, boxes: det.boxes, confs: det.confs, kps: det.kps, kcs: det.kcs,
      appearance: det.boxes.map((b) => appearance(img, b, s)), motion: m });
    onFrame(n);
  }
  return out;
}

/** Number of leading frames worth analysing (see pipeline._usable_length). */
function usableLength(kc: Arr2, motions: (number[][] | undefined)[], peak: number, fps: number, minConf = 0.6, maxZoom = 1.35): number {
  const T = kc.length;
  const start = Math.max(0, Math.min(T, peak + Math.max(2, Math.round(0.1 * fps))));
  let zoom = 1;
  for (let t = Math.max(1, peak + 1); t < T; t++) {
    const m = motions[t];
    if (m) zoom *= Math.sqrt(Math.abs(m[0][0] * m[1][1] - m[0][1] * m[1][0]));
    const mc = kc[t].slice(5).reduce((a, b) => a + b, 0) / 12;
    if (t >= start && (mc < minConf || zoom > maxZoom)) return t;
  }
  return T;
}

function select(info: VideoInfo, perShot: Map<number, Detection[]>, opts: Options, stride: number, fps: number): [TrackScore[], TrackScore] {
  let scores: TrackScore[] = [];
  for (const [si, dets] of perShot) scores = scores.concat(scoreTracks(detectionsByTrack(dets), si, fps, info.height, stride));
  scores.sort((a, b) => b.score - a.score);
  let deliveries = scores.filter((s) => isDelivery(s));
  if (opts.shot !== null && perShot.has(opts.shot)) {
    const inShot = deliveries.filter((s) => s.shot === opts.shot);
    deliveries = inShot.length ? inShot : scores.filter((s) => s.shot === opts.shot && s.sweep);
  }
  if (!deliveries.length) {
    if (scores.length && scores[0].sweep && scores[0].sweep.sweep_deg > 150) deliveries = [scores[0]];
    else throw new AnalysisError("We couldn't find a bowling delivery in this video. Make sure the bowler's full body is visible "
      + "from run-up to follow-through, ideally filmed side-on or from behind the bowler.");
  }
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
  const loading = (await modelsCached()) ? "Loading the analysis models" : "Downloading the analysis models (first time only, about 70 MB)";
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
  const scanStride = clip(Math.ceil(n / 350), 1, Math.max(1, Math.floor(info.fps / 12)));
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
  info.shots = segmentShots(hd, pd, scanFrames, n, info.fps);
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
  if (scanStride > 1) {
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
    const sub = segmentShots(whd, wpd, wf, w1, info.fps).find((x) => x.start <= pk0 && pk0 < x.end);
    const lo = Math.max(w0, sub?.start ?? w0), hi = Math.min(w1, sub?.end ?? w1);
    if (lo > w0 || hi < w1) fds = fds.filter((fd) => fd.frame >= lo && fd.frame < hi);
    fds[0] = { ...fds[0], motion: IDENTITY };
    const full = detectionsByTrack(track(fds, info.fps));
    for (const fd of fds) motions.set(fd.frame, fd.motion);
    const scanBoxes = new Map(bowlerDets.map((d) => [d.frame, d.box]));
    const overlap = (dets: Detection[]) => {
      const ious = dets.filter((d) => scanBoxes.has(d.frame)).map((d) => boxIou(d.box, scanBoxes.get(d.frame)!));
      return (ious.length ? ious.reduce((a, b) => a + b, 0) / ious.length : 0) * Math.min(1, ious.length / 5);
    };
    let best: Detection[] | null = null, bo = -1;
    for (const v of full.values()) { const o = overlap(v); if (o > bo) { bo = o; best = v; } }
    if (best && bo > 0.3) {
      const got = new Set(best.map((d) => d.frame));
      bowlerDets = [...best, ...bowlerDets.filter((d) => !got.has(d.frame) && d.frame >= lo && d.frame < hi)].sort((a, b) => a.frame - b.frame);
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
  for (let fr = f0; fr < f1; fr++) {
    const d = detByFrame.get(fr);
    if (d) { boxes.set(fr, d.box); continue; }
    let prev: number | null = null, next: number | null = null;
    for (const k of known) { if (k < fr) prev = k; else if (k > fr && next === null) next = k; }
    if (prev !== null && next !== null && next - prev <= Math.trunc(0.5 * info.fps)) {
      const a = (fr - prev) / (next - prev), pb = detByFrame.get(prev)!.box, nb = detByFrame.get(next)!.box;
      boxes.set(fr, pb.map((v, i) => (1 - a) * v + a * nb[i]));
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
  let prevSig: Signature | null = null;
  if (f0 > 0) { await src.seek(f0 - 1); prevSig = signature(sigc, src.video, W, H); }
  const nWin = f1 - f0;
  for (let fr = f0; fr < f1; fr++) {
    if (abort?.aborted) throw new AnalysisError("Analysis cancelled.");
    await src.seek(fr);
    const v = src.video;
    const sg = signature(sigc, v, W, H);
    if (prevSig) info.frameDiff.set(fr, sigDistance(prevSig, sg)[1]);
    prevSig = sg;
    dctx.drawImage(v, 0, 0, disp.width, disp.height);
    const jp = jpeg(disp, FRAME_JPEG_QUALITY);
    if (onFrame) onFrame(fr, jp); else frames.set(fr, jp);
    const b = boxes.get(fr);
    refined.push(b ? await models.pose.refineCrop(v, W, H, b, fr) : null);
    prog.stage("pose2d", (fr - f0 + 1) / nWin);
  }
  checkRepeats(info, f0, f1, realFps, opts);
  const refinedList = refined.filter((r): r is RefinedPose => r !== null);
  let [kp, kc] = assemble(refinedList, detByFrame, f0, f1);
  const fps = realFps;   // filters and the lifter work in real time
  kc = hampel(kp, kc, fps);
  let nSwaps: number;
  [kp, kc, nSwaps] = fixSwaps(kp, kc);
  [kp, kc] = interpolateGaps(kp, kc, fps);
  let kpS = smoothKeypoints(kp, fps);
  // broadcast cameras zoom in after release (phone clips can lose the bowler off the frame edge): end the
  // window where tracking collapses or the camera has zoomed in hard since release
  const winMot = [];
  for (let fr = f0; fr < f1; fr++) winMot.push(motions.get(fr));
  const Tuse = usableLength(kc, winMot, pk - f0, fps);
  if (Tuse < f1 - f0) {
    for (let fr = f0 + Tuse; fr < f1; fr++) frames.delete(fr);
    f1 = f0 + Tuse;
    kp = kp.slice(0, Tuse); kc = kc.slice(0, Tuse); kpS = kpS.slice(0, Tuse);
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
    X, seq, kp, kp_s: kpS, kc, motions: mot, bbox, timestamps: info.timestamps,
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
  const sweepLo = Math.trunc(clip(sweep.start - f0, 0, T - 1));
  const sweepHi = Math.trunc(clip(sweep.end - f0, 0, T - 1));
  const armWindow: [number, number] = [sweepLo - Math.trunc(0.1 * realFps), sweepHi + Math.trunc(0.1 * realFps)];
  const h2d = (s: Arr3) => s.map((f) => f.map((p) => [p[0], p[1]]));
  const c2d = (s: Arr3) => s.map((f) => f.map((p) => p[2]));
  let skel = reconstruct(X, h2d(seq), c2d(seq), height, realFps, { depthW });
  let P = skel.joints;
  let labelsSwapped = false;
  let arm: Arm, armConf: number, votes: Record<string, number>;
  if (opts.bowling_arm === "auto") {
    [arm, armConf, votes] = decideBowlingArm(kpS, kc, P, realFps, sweep.side, armWindow);
  } else {
    arm = opts.bowling_arm; armConf = 1; votes = { user: 1 };
    const [, , av] = decideBowlingArm(kpS, kc, P, realFps, sweep.side, armWindow);
    const other = arm === "right" ? -1 : 1;
    if (av.speed_2d === other && av.fast_high_2d === other) {
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
  const side = sideForArm(arm);
  const up0: [number, number, number] = [0, -1, 0];
  const runup: number[] = [];
  for (let t = 0; t < Math.max(0, sweepLo - Math.trunc(0.35 * realFps)); t++) runup.push(t);
  const hintReliable = runup.length >= Math.max(4, Math.trunc(0.2 * realFps));
  let forwardHint: number[];
  if (hintReliable) forwardHint = facingDirection(P, up0, runup);
  else {
    const rel: number[] = [];
    for (let t = Math.min(T - 1, sweepHi); t < Math.min(T, sweepHi + Math.trunc(0.15 * realFps) + 1); t++) rel.push(t);
    forwardHint = facingDirection(P, up0, rel.length ? rel : [T - 1]);
  }
  const ref = Math.min(T - 1, Math.max(0, sweepHi));
  const kpStab = stabilise(kpS, mot, ref);
  const bodyPx = bodyHeightPx(kpS, kc);
  const peak = sweep.peak - f0;
  // user-edited events (absolute frame numbers) are fixed; the others are detected around them
  const fixed: Partial<Record<EventKey, number>> = {};
  for (const [k, v] of Object.entries(overrides.events ?? {}))
    if (["bfc", "ffc", "uah", "br", "ft"].includes(k) && v !== null && v !== undefined) fixed[k as EventKey] = Math.trunc(clip(Math.trunc(v) - f0, 0, T - 1));
  const edited = (Object.keys(fixed) as EventKey[]).sort();
  let ev = detectEvents(kpS, kc, kpStab, P, side, up0, forwardHint, realFps, bodyPx, [sweepLo, sweepHi], peak, fixed);
  let wf = estimateWorldFrame(P, ev.ffc, ev.bfc, side.front_ankle, side.back_ankle, forwardHint, hintReliable);
  ev = detectEvents(kpS, kc, kpStab, P, side, wf.up, wf.forward, realFps, bodyPx, [sweepLo, sweepHi], peak, fixed);
  if (edited.length) {
    reconcileAutoEvents(ev, edited, T);
    checkEventOrder(ev, edited, f0, overrides.latest_events);
    wf = estimateWorldFrame(P, ev.ffc, ev.bfc, side.front_ankle, side.back_ankle, forwardHint, hintReliable);
  }
  // second 3D pass with physics: while the front foot is planted (FFC -> just after release) it stays ahead of its
  // knee and of the pelvis along the direction of travel (resolves the monocular depth-sign ambiguity)
  if (ev.ffc !== null && ev.br > ev.ffc) {
    const stance: number[] = [];
    for (let t = ev.ffc; t < Math.min(T, ev.br + Math.max(2, Math.round(0.05 * realFps)) + 1); t++) stance.push(t);
    const fwd = wf.forward;
    skel = reconstruct(X, h2d(seq), c2d(seq), height, realFps, { depthW,
      priors: [[stance, side.front_knee, side.front_ankle, fwd, -0.03], [stance, PELVIS, side.front_ankle, fwd, 0.05]] });
    P = skel.joints;
    wf = estimateWorldFrame(P, ev.ffc, ev.bfc, side.front_ankle, side.back_ankle, forwardHint, hintReliable);
  }
  const strideX = strideAcross(kpS, skel.px_per_m, skel.bone_lengths[1] + skel.bone_lengths[2], side, ev.ffc, ev.br);
  let view: ViewInfo = classifyView(wf.forward, kpS, kc, runup.length >= 4 ? runup : null, strideX);
  if (overrides.view === "side_on" || overrides.view === "behind" || overrides.view === "front_on") {
    const { oblique: _o, ...rest } = view;
    view = { ...rest, view: overrides.view, source: "user" };
  }
  const oblique = !!view.oblique;
  prog.stage("metrics", 0.2);
  const Wd = toWorld(wf, P);
  const rep = meta.quality.repeated_frames || 0;
  const fpsUnique = realFps * (1 - rep);
  const ctx: Ctx = { P, W: Wd, kp: kpS, kc, side, wf, view: view.view, fps: realFps, stature: height, k: skel.px_per_m, ev,
    bone_lengths: skel.bone_lengths, fps_unique: fpsUnique, oblique };
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
  } else if (peakReal > 0 && peakReal < 650) {
    coaching.capture_tips.unshift(`The bowling arm peaks at only ~${peakReal.toFixed(0)}°/s, which is unusually slow for a real delivery. If this clip is a slowed-down replay, set its clip speed in Detection & settings so timings are correct.`);
  }
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
    skeleton3d: { names: H36M_NAMES, parents: H36M_PARENTS, coords: "three",
      joints: worldToThree(groundW).map((fr) => fr.map((p) => p.map((v) => round(v, 4)))) },
    skeleton: { bone_lengths_m: skel.bone_lengths.map((v) => round(v, 4)), stature_m: height,
      height_source: opts.height_m ? "user" : "default", reproj_err_px_median: round(medReproj, 2) },
    mesh: mesh.info,
    timing_stage_a_s: meta.timing_stage_a_s,
  };
  return { result, mesh: { rest: mesh.rest, pose: mesh.pose } };
}
