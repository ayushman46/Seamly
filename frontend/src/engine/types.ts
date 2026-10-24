/**
 * Shared engine types and constants (ports of the dataclasses in backend/bowlnet/events.py and
 * kinematics.py). Camera axes: x right, y down, z away from the camera; metres.
 */
import type { Arr2, Arr3, Vec3 } from "./nd";
import { round } from "./util";

// H36M indices (3D)
export const PELVIS = 0, R_HIP = 1, R_KNEE = 2, R_ANK = 3, L_HIP = 4, L_KNEE = 5, L_ANK = 6, SPINE = 7, THORAX = 8,
  NOSE = 9, HEAD = 10, L_SH = 11, L_EL = 12, L_WR = 13, R_SH = 14, R_EL = 15, R_WR = 16;
export const H36M_NAMES = ["pelvis", "r_hip", "r_knee", "r_ankle", "l_hip", "l_knee", "l_ankle", "spine", "thorax",
  "nose", "head", "l_shoulder", "l_elbow", "l_wrist", "r_shoulder", "r_elbow", "r_wrist"];
export const H36M_PARENTS = [-1, 0, 1, 2, 0, 4, 5, 0, 7, 8, 9, 8, 11, 12, 8, 14, 15];
export const H36M_FLIP = [0, 4, 5, 6, 1, 2, 3, 7, 8, 9, 10, 14, 15, 16, 11, 12, 13];
// COCO indices (2D)
export const COCO_NAMES = ["nose", "l_eye", "r_eye", "l_ear", "r_ear", "l_shoulder", "r_shoulder", "l_elbow",
  "r_elbow", "l_wrist", "r_wrist", "l_hip", "r_hip", "l_knee", "r_knee", "l_ankle", "r_ankle"];
export const COCO_FLIP = [0, 2, 1, 4, 3, 6, 5, 8, 7, 10, 9, 12, 11, 14, 13, 16, 15];
export const C = { nose: 0, l_sh: 5, r_sh: 6, l_el: 7, r_el: 8, l_wr: 9, r_wr: 10, l_hip: 11, r_hip: 12, l_kn: 13,
  r_kn: 14, l_an: 15, r_an: 16 } as const;

export type Arm = "left" | "right";
export type EventKey = "bfc" | "ffc" | "uah" | "br" | "ft";
export const EVENT_KEYS: EventKey[] = ["bfc", "ffc", "uah", "br", "ft"];

export interface Side {
  bowling_arm: Arm;
  // 3D (H36M)
  shoulder: number; elbow: number; wrist: number;
  front_shoulder: number; front_elbow: number; front_wrist: number;
  front_hip: number; front_knee: number; front_ankle: number;
  back_hip: number; back_knee: number; back_ankle: number;
  // 2D (COCO)
  c_sh: number; c_el: number; c_wr: number; c_fsh: number; c_fel: number; c_fwr: number;
  c_fhip: number; c_fkn: number; c_fan: number; c_bhip: number; c_bkn: number; c_ban: number;
}

export function sideForArm(arm: Arm): Side {
  const v = arm === "right"
    ? [R_SH, R_EL, R_WR, L_SH, L_EL, L_WR, L_HIP, L_KNEE, L_ANK, R_HIP, R_KNEE, R_ANK, 6, 8, 10, 5, 7, 9, 11, 13, 15, 12, 14, 16]
    : [L_SH, L_EL, L_WR, R_SH, R_EL, R_WR, R_HIP, R_KNEE, R_ANK, L_HIP, L_KNEE, L_ANK, 5, 7, 9, 6, 8, 10, 12, 14, 16, 11, 13, 15];
  const keys = ["shoulder", "elbow", "wrist", "front_shoulder", "front_elbow", "front_wrist", "front_hip", "front_knee",
    "front_ankle", "back_hip", "back_knee", "back_ankle", "c_sh", "c_el", "c_wr", "c_fsh", "c_fel", "c_fwr", "c_fhip",
    "c_fkn", "c_fan", "c_bhip", "c_bkn", "c_ban"] as const;
  const s = { bowling_arm: arm } as Side;
  keys.forEach((k, i) => { (s as unknown as Record<string, number>)[k] = v[i]; });
  return s;
}

/** Event frames are window-relative indices (0 = analysis window start). */
export interface Events {
  bfc: number | null;
  ffc: number | null;
  uah: number | null;
  br: number;
  ft: number | null;
  confidence: Partial<Record<EventKey, number>>;
  method: Partial<Record<EventKey, string>>;
}

export interface EventOut { frame: number; time: number; confidence: number; method: string }

/** Events.as_dict: absolute frame numbers and timestamps. */
export function eventsAsDict(ev: Events, f0: number, timestamps: number[]): Record<EventKey, EventOut | null> {
  const out = {} as Record<EventKey, EventOut | null>;
  for (const k of EVENT_KEYS) {
    const v = ev[k];
    out[k] = v === null || v === undefined ? null : {
      frame: v + f0, time: round(timestamps[Math.min(timestamps.length - 1, v + f0)], 4),
      confidence: round(ev.confidence[k] ?? 0.5, 2), method: ev.method[k] ?? "auto",
    };
  }
  return out;
}

/** Orthonormal frame: up (against gravity), forward (direction of delivery), lateral = up x forward. */
export interface WorldFrame {
  up: Vec3;
  forward: Vec3;
  lateral: Vec3;
  camera_pitch_deg: number;
}

/** Camera-axes points -> (forward, lateral, up) coordinates. P: (T,17,3). */
export function toWorld(wf: WorldFrame, P: Arr3): Arr3 {
  const R = [wf.forward, wf.lateral, wf.up];
  return P.map((fr) => fr.map((p) => R.map((r) => r[0] * p[0] + r[1] * p[1] + r[2] * p[2])));
}

export function worldFrameDict(wf: WorldFrame) {
  return { up: wf.up.map((v) => round(v, 4)), forward: wf.forward.map((v) => round(v, 4)),
    lateral: wf.lateral.map((v) => round(v, 4)), camera_pitch_deg: round(wf.camera_pitch_deg, 1) };
}

export interface Skeleton3D {
  joints: Arr3;          // (T,17,3) metres, root-relative, camera axes
  bone_lengths: number[]; // (16,) metres
  px_per_m: number[];    // (T,) weak-perspective scale
  root_px: Arr2;         // (T,2) pelvis position in the image
  stature_m: number;
  reproj_err_px: Arr2;   // (T,17)
}

export interface ViewInfo {
  view: "side_on" | "behind" | "front_on";
  angle_to_optical_axis_deg: number;
  hip_width_ratio: number | null;
  stride_across?: number;
  oblique?: boolean;   // the 2D view cues disagree (camera well off the pitch line): plane metrics aren't rated
  source?: string;
}
