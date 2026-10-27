export type EventKey = "bfc" | "ffc" | "uah" | "br" | "ft";
export type Rating = "good" | "watch" | "risk" | "info" | "unrated";
export type View = "side_on" | "behind" | "front_on";

export interface EventInfo {
  frame: number;
  time: number;
  confidence: number;
  method: string;
}

export interface Metric {
  key: string;
  label: string;
  value: number | null;
  unit: string;
  event: string | null;
  source: string;
  confidence: number;
  rating: Rating;
  reliability: "measured" | "estimate";
  note: string | null;
  needs_view: View[] | null;
  norm: string | null;
  ref: string | null;
  explain: string;
  technique?: string;
  action_type?: string;
  metres?: number;
  flexion_at_uah?: number | null;
  flexion_at_br?: number | null;
  max_flexion?: number | null;
  precision_note?: string | null;
  flexion_after_ffc?: number;
  extension_to_br?: number;
}

export interface Drill {
  title: string;
  cue: string;
  drills: string[];
}

export interface Priority {
  key: string;
  category: "pace" | "load" | "accuracy" | "legality";
  severity: number;
  rating: Rating;
  borderline?: boolean;   // within one measurement step of the target: ranked below clear misses
  headline: string;
  evidence: string;
  why: string;
  metric: string;
  confidence: number;
  drill: Drill;
  event: string | null;
}

export interface Coaching {
  score: number | null;
  grade: string | null;
  score_breakdown: { key: string; label: string; rating: Rating; weight: number }[];
  priorities: Priority[];
  all_issues: Priority[];
  strengths: string[];
  capture_tips: string[];
  disclaimer: string;
}

export interface Candidate {
  track: number;
  shot: number;
  frames: number;
  first: number;
  last: number;
  score: number;
  sweep?: { arm: string; sweep_deg: number; peak_speed_dps: number; peak_frame: number };
}

export interface AnalysisResult {
  version: number;
  video: { width: number; height: number; fps: number; frame_count: number; duration: number; shots: { start: number; end: number }[] };
  analysis_window: { start: number; end: number };
  display_scale: number;
  fps: number;
  fps_real: number;
  pose3d?: "sam3d" | "motionbert";
  options: { bowling_arm: string; height_m: number | null; slowmo_factor: number };
  bowler: { track: number; shot: number; score: Candidate };
  candidates: Candidate[];
  bowling_arm: { arm: "left" | "right"; confidence: number; source: string };
  view: { view: View; source?: string; angle_to_optical_axis_deg: number; oblique?: boolean };
  events: Record<EventKey, EventInfo | null>;
  events_edited: EventKey[];
  metrics: Metric[];
  series: Record<string, number[]>;
  coaching: Coaching;
  frames: { start: number; end: number; times: number[] };
  keypoints2d: { names: string[]; xy: [number, number][][]; conf: number[][] };
  skeleton3d: { names: string[]; parents: number[]; joints: [number, number, number][][] };
  skeleton: { bone_lengths_m: number[]; stature_m: number; height_source: string; reproj_err_px_median: number };
  mesh: { vertices: number; faces: number; bones: number; frames: number; stature_m: number; bone_groups?: { bowling_arm: number[]; front_leg: number[] } };
  quality: { lr_swaps_fixed: number; mean_kp_conf: number; frames_refined: number; frames_total: number; repeated_frames?: number };
  timing_s?: number;
}

export interface AnalysisMeta {
  id: string;
  name: string;
  created: number;
  updated: number;
  status: "queued" | "running" | "done" | "failed";
  progress: number | null;
  stage: string | null;
  stage_label: string | null;
  error: string | null;
  score: number | null;
  grade: string | null;
  view: View | null;
  arm: string | null;
  thumb_frame: number | null;
  options: { bowling_arm: string; height_m: number | null; slowmo_factor: number } | null;
  timing_s: number | null;
  elapsed: number | null;
  size_mb: number | null;
  input_type?: string | null;   // MIME type of the uploaded video
  arm_conf?: number | null;     // confidence of the detected bowling arm (1 = set by the user)
  queue_position?: number | null;
  notice?: string | null;   // e.g. a failed re-analysis that fell back to the previous result
  suggest?: { slowmo_factor?: number } | null;   // option change that would make a failed analysis work
  player_id?: string | null;
  pace?: PaceRecord | null;   // ball speed measured on this clip (the marked frames and the result)
  crease?: CreaseRecord | null;   // front-foot no-ball check: the marked crease and the call
  source_id?: string | null;   // split from another analysis' video (several deliveries in one clip)
  pair?: string | null;   // the same ball filmed by a second camera (side-on with behind / in front)
  angled?: boolean | null;   // the camera was at an angle to the pitch (view.oblique), kept for lists
}

/** Front-foot no-ball check (lib/crease.ts): the crease edge marked on the landing frame (display px) and the call. */
export interface CreaseRecord {
  line: { a: [number, number]; b: [number, number] }; frame: number;
  behind_cm: number; band_cm: number; verdict: "legal" | "no_ball" | "close";
}

/** Ball speed from the marked frames (lib/pace.ts), kept with the analysis. */
export interface PaceRecord {
  release: number; arrival: number; target: "crease" | "stumps"; bounced: boolean; pitch?: number | null;
  kmh: number; lo: number; hi: number;
}

// ---------------- players, progress, insights ----------------
export type AgeGroup = "u11" | "u13" | "u15" | "u17" | "u19" | "adult";
export type Style = "fast" | "medium" | "spin";

export interface Player {
  id: string;
  name: string;
  age_group: AgeGroup;
  style: Style;
  arm: "auto" | "right" | "left";
  height_cm: number | null;
  created: number;
  analyses: number;
  latest_score: number | null;
  last_analysis: number | null;
  log?: BowlingLogEntry[];   // bowling the player did (matches, nets, training), newest first
}

/** One day's bowling, as entered by the player or parent. */
export interface BowlingLogEntry { id: string; date: string; balls: number; kind: "match" | "nets" | "training" }

export interface SessionSummary {
  id: string;
  name: string;
  created: number;
  score: number | null;
  grade: string | null;
  view: View;
  arm?: string;
  fps_real?: number | null;
  top: { key: string; headline: string; title: string } | null;
  metrics: Record<string, { label: string; unit: string; value: number; rating: string; reliability: string }>;
}

export interface PlayerProgress {
  player: Player;
  sessions: SessionSummary[];
  trends: Record<string, { label: string; unit: string; better: string | null; good: [number | null, number | null] | null; norm: string | null; points: { id: string; created: number; value: number; rating: string }[] }>;
  best: Record<string, { id: string; created: number; value: number; label: string; unit: string }>;
  since_last: { key: string; label: string; unit: string; before: number; after: number; rated?: boolean; improved: boolean | null }[];
  compared_to: { id: string; created: number; view: View } | null;
  focus: { key: string; headline: string; title: string; sessions: number; first_value: number | null; latest_value: number | null } | null;
  stats: { count: number; best_score: number | null; latest_score: number | null; first_score: number | null; first: number | null; last: number | null };
  pace?: { id: string; created: number; kmh: number; lo: number; hi: number }[];   // measured ball speeds, oldest first
}

export interface PlanItem { id: string; text: string; detail: string | null }
export interface PlanDay { day: string; kind: "bowling" | "strength" | "rest" | "film"; title: string; items: PlanItem[]; load?: { deliveries: number; limit: number | null } | null }
export interface Insights {
  summary: {
    headline: string;
    working: string[];
    fixes: { title: string; what: string; why: string; cue: string; event: string | null; rating: string }[];
    unlock: string[];
    notes: string[];
  };
  back_health: {
    overall: "ok" | "watch" | "flag" | "unknown";
    checks: { key: string; label: string; status: "ok" | "watch" | "flag" | "unknown"; value: number | null; unit: string | null; text: string }[];
    advice: string[];
    disclaimer: string;
    measured: number;
    total: number;
  } | null;
  plan: {
    focus: { title: string; cue: string; key: string }[];
    weeks: { title: string; days: PlanDay[] }[];
    limits: { spell: number; day: number | null; days_week: number; rule: string; label: string; source: string; between_spells_min: number; preseason_weeks: number | null } | null;
    notes: string[];
  };
  player: { id: string; name: string; age_group: AgeGroup; style: Style } | null;
}
