import type { EventKey, Rating, View } from "../types";

export const EVENTS: { key: EventKey; short: string; label: string; color: string; help: string }[] = [
  { key: "bfc", short: "BFC", label: "Back-foot contact", color: "var(--ev-bfc)", help: "Back foot lands after the bound" },
  { key: "ffc", short: "FFC", label: "Front-foot contact", color: "var(--ev-ffc)", help: "Front foot lands - start of the delivery stride's braking phase" },
  { key: "uah", short: "UAH", label: "Upper arm horizontal", color: "var(--ev-uah)", help: "Bowling upper arm passes horizontal (start of the ICC elbow window)" },
  { key: "br", short: "REL", label: "Ball release", color: "var(--ev-br)", help: "Ball leaves the hand" },
  { key: "ft", short: "FT", label: "Follow-through", color: "var(--ev-ft)", help: "First step after release" },
];
export const EVENT_HEX: Record<EventKey, string> = { bfc: "#f59e0b", ffc: "#22c55e", uah: "#a78bfa", br: "#f43f5e", ft: "#38bdf8" };

export const RATING_LABEL: Record<Rating, string> = { good: "Good", watch: "Watch", risk: "Risk", info: "Info", unrated: "Estimate" };
export const RATING_HEX: Record<Rating, string> = { good: "#22c55e", watch: "#f59e0b", risk: "#ef4444", info: "#8b9bb4", unrated: "#5b6880" };
export const VIEW_LABEL: Record<View, string> = { side_on: "Side-on view", behind: "Behind the bowler", front_on: "Front-on view" };

// COCO-17 skeleton
export const COCO_EDGES: [number, number][] = [
  [5, 7], [7, 9], [6, 8], [8, 10], [5, 6], [11, 12], [5, 11], [6, 12], [11, 13], [13, 15], [12, 14], [14, 16], [0, 5], [0, 6],
];
export const LEFT = new Set([1, 3, 5, 7, 9, 11, 13, 15]);
export const RIGHT = new Set([2, 4, 6, 8, 10, 12, 14, 16]);

export const SERIES_INFO: Record<string, { label: string; unit: string; plane: "sagittal" | "frontal" | "transverse" | "any"; help: string }> = {
  elbow_flexion_bowling: { label: "Bowling elbow flexion", unit: "deg", plane: "sagittal", help: "0 = straight arm" },
  knee_front: { label: "Front knee angle", unit: "deg", plane: "sagittal", help: "180 = straight leg" },
  knee_back: { label: "Back knee angle", unit: "deg", plane: "sagittal", help: "180 = straight leg" },
  front_knee_2d: { label: "Front knee (image plane)", unit: "deg", plane: "sagittal", help: "Measured directly on the video" },
  elbow_flexion_2d: { label: "Bowling elbow (image plane)", unit: "deg", plane: "sagittal", help: "0 = straight arm, measured on the video" },
  trunk_forward_flexion: { label: "Trunk forward flexion", unit: "deg", plane: "sagittal", help: "Positive = towards the batter" },
  trunk_lateral_flexion: { label: "Trunk side-bend", unit: "deg", plane: "frontal", help: "Positive = away from the bowling arm" },
  trunk_angle_2d: { label: "Trunk angle (image plane)", unit: "deg", plane: "any", help: "Trunk line vs. image vertical" },
  shoulder_alignment: { label: "Shoulder alignment", unit: "deg", plane: "transverse", help: "180 = side-on, 270 = front-on" },
  hip_alignment: { label: "Hip alignment", unit: "deg", plane: "transverse", help: "180 = side-on, 270 = front-on" },
  hip_shoulder_separation: { label: "Hip-shoulder separation", unit: "deg", plane: "transverse", help: "Shoulders minus hips" },
  bowling_arm_elevation: { label: "Bowling arm elevation", unit: "deg", plane: "any", help: "90 = arm straight up" },
  bowling_wrist_height_pct: { label: "Bowling wrist height", unit: "% height", plane: "any", help: "Above the ground" },
  elbow_flexion_front: { label: "Front elbow flexion", unit: "deg", plane: "sagittal", help: "Non-bowling arm" },
};

// angles of the 3D model only: on the video the same joints are measured directly (front_knee_2d,
// elbow_flexion_2d, trunk_angle_2d, which the metrics use), so these are always shown as estimates
const MODEL_ONLY = new Set(["knee_front", "knee_back", "elbow_flexion_bowling", "elbow_flexion_front", "trunk_forward_flexion", "trunk_lateral_flexion"]);

/** Measured for this view (shown by default) or a 3D estimate (shown on request, clearly labelled). */
export function measuredForView(key: string, plane: string, view: View): boolean {
  return !MODEL_ONLY.has(key) && reliableForView(plane, view);
}

/** Keep displayed joint angles in their physical range (3D estimates can overshoot a straight joint). */
export function physical(key: string, v: number): number {
  if (!Number.isFinite(v)) return v;
  if (key.startsWith("knee_") || key === "front_knee_2d") return Math.min(180, v);
  if (key.startsWith("elbow_flexion")) return Math.max(0, v);
  return v;
}

export function reliableForView(plane: string, view: View): boolean {
  if (plane === "any") return true;
  if (plane === "sagittal") return view === "side_on";
  // hip and shoulder rotation turns towards / away from a side-on camera: only behind or front-on shows it
  if (plane === "frontal" || plane === "transverse") return view !== "side_on";
  return true;
}

/** Clip-speed (slow-motion) factors offered everywhere; matches SLOWMO_CHOICES in the backend. */
export const SLOWMO_OPTIONS: { value: number; label: string }[] = [
  { value: 1, label: "Real time" },
  { value: 2, label: "Slowed 2×" },
  { value: 3, label: "Slowed 3×" },
  { value: 4, label: "Slowed 4× (120→30 fps)" },
  { value: 5, label: "Slowed 5× (120→24 fps)" },
  { value: 6, label: "Slowed 6×" },
  { value: 8, label: "Slowed 8× (240→30 fps)" },
  { value: 10, label: "Slowed 10× (240→24 fps)" },
];
