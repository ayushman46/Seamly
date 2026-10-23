/**
 * Identify the bowler among all tracked people and find the delivery window (port of backend/bowlnet/bowler.py).
 *
 * A delivery has an unmistakable kinematic signature: one arm sweeps ~270-360 degrees around the shoulder,
 * monotonically, in roughly half a second, peaking well above 600 deg/s, while the wrist passes above the head.
 * Umpires, batters and celebrating fielders never produce that pattern, so every track is scored by its best
 * "arm sweep" window rather than by size or track length.
 */
import type { Arm } from "./types";
import { round } from "./util";
import { degrees, pyMod, radians } from "./events";
import { npMedian } from "./pose2d";

/** One person in one frame (backend/bowlnet/detect.py Detection). */
export interface Detection {
  frame: number;
  track: number;
  box: number[];    // (4,) x1, y1, x2, y2 in source pixels
  conf: number;
  kps: number[][];  // (17, 2) source pixels
  kcs: number[];    // (17,) confidence
}

const L_SH = 5, R_SH = 6, L_WR = 9, R_WR = 10, L_HIP = 11, R_HIP = 12;
const NOSE = 0;
const pyRound = (x: number): number => Math.trunc(round(x));

export interface ArmSweep {
  side: Arm;            // anatomical side of the arm as labelled by the detector
  sweep_deg: number;    // max |monotonic rotation| inside the window
  peak_speed: number;   // deg/s
  start_frame: number;
  end_frame: number;
  peak_frame: number;
  direction: number;    // +1 / -1 rotation sense in image coordinates
}

export interface TrackScore {
  track: number;
  shot: number;
  n: number;
  first: number;
  last: number;
  median_height: number;
  sweep: ArmSweep | null;
  overhead_frames: number;
  score: number;
  legs_visibility: number;
}

export interface TrackScoreDict {
  track: number; shot: number; frames: number; first: number; last: number; median_height_px: number;
  overhead_frames: number; score: number; legs_visibility: number;
  sweep?: { arm: Arm; sweep_deg: number; peak_speed_dps: number; peak_frame: number; start_frame: number; end_frame: number };
}

/** TrackScore.to_dict */
export function trackScoreDict(ts: TrackScore): TrackScoreDict {
  const d: TrackScoreDict = {
    track: ts.track, shot: ts.shot, frames: ts.n, first: ts.first, last: ts.last,
    median_height_px: round(ts.median_height, 1), overhead_frames: ts.overhead_frames,
    score: round(ts.score, 2), legs_visibility: round(ts.legs_visibility, 2),
  };
  if (ts.sweep) {
    const s = ts.sweep;
    d.sweep = { arm: s.side, sweep_deg: round(s.sweep_deg, 1), peak_speed_dps: round(s.peak_speed, 1),
      peak_frame: s.peak_frame, start_frame: s.start_frame, end_frame: s.end_frame };
  }
  return d;
}

export function armAngles(dets: Detection[], sh: number, wr: number, minConf = 0.25): [number[], number[]] {
  const frames: number[] = [], ang: number[] = [];
  for (const d of dets) {
    if (d.kcs[sh] >= minConf && d.kcs[wr] >= minConf) {
      const vx = d.kps[wr][0] - d.kps[sh][0], vy = d.kps[wr][1] - d.kps[sh][1];
      const h = Math.max(d.box[3] - d.box[1], 1.0);
      if (Math.sqrt(vx * vx + vy * vy) < 0.08 * h) continue;   // wrist on top of shoulder: angle undefined
      frames.push(d.frame);
      ang.push(Math.atan2(vy, vx));
    }
  }
  return [frames, ang];
}

export function bestSweep(dets: Detection[], fps: number, side: Arm): ArmSweep | null {
  const [sh, wr] = side === "left" ? [L_SH, L_WR] : [R_SH, R_WR];
  const [f, a] = armAngles(dets, sh, wr);
  if (f.length < 5) return null;
  const maxGap = Math.max(2, pyRound(0.1 * fps));
  const steps: [number, number, number][] = [];   // (frame_from, frame_to, dtheta)
  for (let i = 1; i < f.length; i++) {
    const gap = f[i] - f[i - 1];
    if (gap > maxGap) continue;
    const d = pyMod(a[i] - a[i - 1] + Math.PI, 2 * Math.PI) - Math.PI;
    if (Math.abs(d) > radians(110) * gap) continue;   // implausible jump (keypoint swap / misdetection)
    steps.push([f[i - 1], f[i], d]);
  }
  if (steps.length < 4) return null;
  const win = Math.max(6, pyRound(0.7 * fps));
  let best: [number, number, number] | null = null;
  for (let j = 0; j < steps.length; j++) {
    let total = 0.0;
    for (let k = j; k < steps.length; k++) {
      if (steps[k][1] - steps[j][0] > win) break;
      total += steps[k][2];
      if (best === null || Math.abs(total) > Math.abs(best[0])) best = [total, steps[j][0], steps[k][1]];
    }
  }
  if (best === null) return null;
  const [total, s0, s1] = best;
  const direction = total > 0 ? 1 : -1;
  // peak angular speed over short (~3 frames at 30-60 fps) windows, in the sweep direction; a window always holds at
  // least one step so a strided scan (steps spanning several frames) still measures speed
  const pw = Math.max(3, pyRound(0.05 * fps));
  let peak = 0.0, peakF = s0;
  for (let j = 0; j < steps.length; j++) {
    let acc = 0.0, k = j;
    while (k < steps.length && (k === j || steps[k][1] - steps[j][0] <= pw)) {
      acc += steps[k][2];
      k += 1;
    }
    const dt = (steps[k - 1][1] - steps[j][0]) / fps;
    if (dt > 0 && (acc * direction) / dt > peak) {
      peak = (acc * direction) / dt;
      peakF = Math.floor((steps[j][0] + steps[k - 1][1]) / 2);
    }
  }
  return { side, sweep_deg: degrees(Math.abs(total)), peak_speed: degrees(peak), start_frame: s0, end_frame: s1,
    peak_frame: peakF, direction };
}

/** Frames with a wrist clearly above the head. */
export function overhead(dets: Detection[]): number {
  let n = 0;
  for (const d of dets) {
    const h = Math.max(d.box[3] - d.box[1], 1.0);
    const headY = d.kcs[NOSE] > 0.3 ? d.kps[NOSE][1] : d.box[1] + 0.08 * h;
    for (const wr of [L_WR, R_WR]) {
      if (d.kcs[wr] > 0.3 && d.kps[wr][1] < headY - 0.05 * h) { n += 1; break; }
    }
  }
  return n;
}

export function scoreTracks(tracks: Map<number, Detection[]>, shot: number, fps: number, frameH: number,
  stride = 1): TrackScore[] {
  const out: TrackScore[] = [];
  const minLen = Math.max(5, pyRound((0.5 * fps) / stride));
  for (const [tid, dets] of tracks) {
    if (dets.length < minLen) continue;
    const hs = dets.map((d) => d.box[3] - d.box[1]);
    const sweeps = [bestSweep(dets, fps, "left"), bestSweep(dets, fps, "right")].filter((s): s is ArmSweep => !!s);
    const sweep = sweeps.length ? sweeps.reduce((m, s) => (s.sweep_deg > m.sweep_deg ? s : m)) : null;
    const over = overhead(dets);
    let score = 0.0;
    if (sweep) {
      // sweep >= ~240 deg with a fast peak is the delivery; saturate to avoid rewarding noise
      score += (Math.min(sweep.sweep_deg, 380.0) / 100.0) * 2.0;
      score += Math.min(sweep.peak_speed, 1500.0) / 500.0;
    }
    score += Math.min(over, 6) * 0.15;
    const medH = npMedian(hs);
    if (medH / frameH < 0.06) score *= 0.5;   // too small to analyse reliably anyway
    const meanConf = dets.reduce((s, d) => s + (d.kcs[L_SH] + d.kcs[R_SH] + d.kcs[L_HIP] + d.kcs[R_HIP]) / 4, 0) / dets.length;
    score *= 0.5 + 0.5 * Math.min(1.0, meanConf / 0.7);
    // A delivery we can analyse shows the whole body: feet/knees must be visible around the arm sweep.
    // (Waist-up close-ups of celebrating players also wave their arms, but never show the legs.)
    const legs = sweep ? legsVisibility(dets, sweep, fps) : 0.0;
    score *= 0.15 + 0.85 * legs;
    out.push({ track: tid, shot, n: dets.length, first: dets[0].frame, last: dets[dets.length - 1].frame,
      median_height: medH, sweep, overhead_frames: over, score, legs_visibility: legs });
  }
  return out.sort((p, q) => q.score - p.score);   // stable, like Python's sorted
}

export function legsVisibility(dets: Detection[], sweep: ArmSweep, fps: number): number {
  const lo = sweep.start_frame - Math.trunc(0.5 * fps);
  const hi = sweep.end_frame + Math.trunc(0.2 * fps);
  const window = dets.filter((d) => lo <= d.frame && d.frame <= hi);
  if (!window.length) return 0.0;
  let ok = 0;
  for (const d of window) {
    const ankles = Math.max(d.kcs[15], d.kcs[16]);
    const knees = Math.max(d.kcs[13], d.kcs[14]);
    ok += ankles > 0.35 && knees > 0.35 ? 1 : 0;
  }
  return ok / window.length;
}

export function isDelivery(ts: TrackScore): boolean {
  const s = ts.sweep;
  return !!(s && s.sweep_deg >= 200 && s.peak_speed >= 450);
}
