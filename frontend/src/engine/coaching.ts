/**
 * Turn metrics into a headline score, prioritised coaching points and drills (port of backend/bowlnet/coaching.py).
 *
 * Feedback style follows what works in the category (one score, then three priorities, each tagged as a pace or
 * load/injury issue with an evidence level and a drill), and never presents legality or injury estimates as
 * verdicts.
 */
import type { Coaching, Drill, Metric, Priority } from "../types";
import { NORMS, pyFormat, pyMin, pyRound } from "./metrics";

export const DRILLS: Record<string, Drill> = {
  front_leg: {
    title: "Brace the front leg",
    cue: "Land tall, push the ground away — ‘stand up’ through the front leg as the arm comes over.",
    drills: [
      "Standing brace: front foot planted, bowl from a static delivery-stride position, focus on a firm knee (3 × 6).",
      "Walk-through then jog-through deliveries, adding speed only while the knee stays firm (3 × 6).",
      "Gather-and-bound drill onto a mat, freezing at front-foot contact to feel the brace (2 × 8).",
    ],
  },
  trunk_flexion: {
    title: "Drive the chest through",
    cue: "Chest over the front knee — finish with your bowling shoulder pointing at the batter.",
    drills: [
      "Kneeling throws with a light ball: front knee down, pull the trunk down and through towards a target (3 × 8).",
      "Med-ball slam from the delivery stride position, 2–3 kg ball (17+ only) (3 × 6).",
      "Follow-through line drill: finish with the chest past the front knee on a chalk line (2 × 8).",
    ],
  },
  side_bend: {
    title: "Stay tall at release",
    cue: "Head over the front foot, front arm drives towards the target rather than yanking down.",
    drills: [
      "Chalk-line run-ups: run and land on a straight line so the body isn't forced to lean (3 × 6).",
      "Front-arm drive drill: hand reaches towards the target and finishes near the chest (2 × 10).",
      "Wall drill: bowl alongside a wall/net on the non-bowling side to discourage falling away (2 × 8).",
    ],
  },
  mixed_action: {
    title: "Line up hips and shoulders",
    cue: "Hips and shoulders face the same way at back-foot contact — side-on, semi-open or front-on are all fine; mixing them isn't.",
    drills: [
      "Chalk the crease: mark back-foot and front-foot positions and match shoulders to the back-foot line (3 × 6).",
      "Mirror/phone checks at back-foot contact from behind; fix the shoulders first (2 × 8).",
      "Slow-motion walk-throughs freezing at back-foot contact to rehearse alignment (2 × 6).",
    ],
  },
  release_height: {
    title: "Get taller at release",
    cue: "Stand tall on your front leg and let the ball go at the top of your natural arm path.",
    drills: [
      "High-target drill: release over a raised rope/bar 1 m in front of the crease (3 × 6).",
      "Standing-start bowling focusing on reaching up through the bowling arm (3 × 6).",
    ],
  },
  stride: {
    title: "Find your stride",
    cue: "Bound up, not along — land with a stride that lets you stay tall.",
    drills: [
      "Stride markers: mark a target front-foot position at ~75–80% of your height from the back foot (3 × 6).",
      "Bound and stick: bound into the delivery stride and hold balance for two seconds (2 × 8).",
    ],
  },
  // the same drills for a short stride, with a cue that asks for more length, not less
  stride_short: {
    title: "Find your stride",
    cue: "Push off and reach your front foot a little further down the pitch.",
    drills: [
      "Stride markers: mark a target front-foot position at ~75–80% of your height from the back foot (3 × 6).",
      "Bound and stick: bound into the delivery stride and hold balance for two seconds (2 × 8).",
    ],
  },
  rhythm: {
    title: "Quicker through the crease",
    cue: "Land and go — front foot down, arm over, no pause.",
    drills: [
      "Short run-up (5 steps) focusing on the time from front-foot landing to release (3 × 6).",
      "Metronome / clap timing: the release follows the front-foot 'thud' immediately (2 × 8).",
    ],
  },
  elbow: {
    title: "Keep an eye on the elbow",
    cue: "Keep the arm long and relaxed from horizontal to release.",
    drills: [
      "Film side-on at 120–240 fps from 10 m and re-analyse. If the estimate stays high, talk to your coach; your state or county association can advise if they're worried.",
    ],
  },
};

export type Rule = [key: string, trigger: readonly string[], category: Priority["category"], drill: string, weight: number,
  headline: string, evidence: string];

/** key, issue (ratings that trigger), category, drill, weight, headline (Python str.format with value), evidence */
export const RULES: Rule[] = [
  ["front_knee_br", ["watch"], "pace", "front_leg", 1.0,
    "Front knee softens to {v:.0f}° at release (aim for 160° or straighter)", "Moderate evidence for pace (r ≈ 0.4)"],
  ["front_knee_flexion", ["watch"], "pace", "front_leg", 0.7,
    "Front knee flexes {v:.0f}° after landing", "Moderate evidence"],
  ["trunk_flexion_ffc_br", ["watch"], "pace", "trunk_flexion", 0.8,
    "Not much forward bend of the upper body from landing to release ({v:.0f}°)", "Moderate evidence for pace"],
  ["trunk_forward_br", ["watch"], "pace", "trunk_flexion", 0.6,
    "Upright trunk at release ({v:.0f}°)", "Moderate evidence for pace"],
  ["trunk_lateral_br", ["watch", "risk"], "load", "side_bend", 1.1,
    "High side-bend at release ({v:.0f}°)", "Moderate evidence in juniors, contested in adults"],
  ["hip_shoulder_sep_bfc", ["watch", "risk"], "load", "mixed_action", 1.0,
    "Hips and shoulders misaligned at back-foot contact ({v:.0f}°)", "Classification; injury link debated"],
  ["shoulder_counter_rotation", ["watch", "risk"], "load", "mixed_action", 0.9,
    "Shoulders twist back {v:.0f}° after back-foot contact", "Low-moderate evidence (stronger in juniors)"],
  ["back_knee_bfc", ["watch", "risk"], "load", "front_leg", 0.6,
    "Back leg folds at back-foot contact ({v:.0f}°)", "One prospective study"],
  ["release_height_pct", ["watch"], "pace", "release_height", 0.6,
    "Release point is low ({v:.0f}% of height)", "Descriptive"],
  ["stride_length_pct", ["watch"], "pace", "stride", 0.4,
    "{side} delivery stride ({v:.0f}% of height; typical 70–87%)", "Weak evidence"],
  ["ffc_to_br_ms", ["watch"], "pace", "rhythm", 0.4,
    "Slow from front-foot contact to release ({v:.0f} ms)", "Low confidence"],
  ["head_offset_br", ["watch", "risk"], "accuracy", "side_bend", 0.6,
    "Head falls {v:.0f} cm outside the front foot", "Coaching heuristic"],
  ["elbow_extension", ["watch", "risk"], "legality", "elbow", 0.8,
    "Estimated elbow extension {v:.0f}°", "Screening only — not an ICC test"],
];

export const POSITIVES: Record<string, string> = {
  front_knee_br: "Strong, braced front leg at release",
  trunk_lateral_br: "Controlled side-bend at release",
  hip_shoulder_sep_bfc: "Hips and shoulders aligned at back-foot contact",
  shoulder_counter_rotation: "Minimal shoulder counter-rotation",
  release_height_pct: "High release point",
  trunk_flexion_ffc_br: "Good forward bend of the upper body from landing to release",
  stride_length_pct: "Stride length in the typical elite range",
  back_knee_bfc: "Firm back leg at back-foot contact",
  head_offset_br: "Head stays over the front foot",
};

/** Body area of each metric, so a strength is never listed for an area that is also a fix. */
export const AREA: Record<string, string> = {
  front_knee_br: "front_knee", front_knee_flexion: "front_knee", front_knee_ffc: "front_knee",
  trunk_flexion_ffc_br: "trunk", trunk_forward_br: "trunk", trunk_lateral_br: "side_bend",
  head_offset_br: "side_bend", hip_shoulder_sep_bfc: "alignment", shoulder_counter_rotation: "alignment",
  back_knee_bfc: "back_knee", release_height_pct: "release", stride_length_pct: "stride",
  ffc_to_br_ms: "rhythm", elbow_extension: "elbow",
};

export const SCORE_WEIGHTS: Record<string, number> = {
  front_knee_br: 1.0, trunk_flexion_ffc_br: 0.8, trunk_lateral_br: 1.0, hip_shoulder_sep_bfc: 0.8,
  shoulder_counter_rotation: 0.6, release_height_pct: 0.6, stride_length_pct: 0.4,
  back_knee_bfc: 0.5, ffc_to_br_ms: 0.3, head_offset_br: 0.5, trunk_forward_br: 0.4,
};
export const RATING_POINTS: Record<string, number> = { good: 1.0, watch: 0.55, risk: 0.15 };
export const MIN_SCORED = 3;

/** A coaching issue as Python emits it (Priority plus the drill key insights uses). */
export type Issue = Priority & { drill_key: string };
export type CoachingOut = Omit<Coaching, "priorities" | "all_issues"> & { priorities: Issue[]; all_issues: Issue[] };

/** Python str.format for the placeholders RULES use: {name} and {name:.Nf}. */
function formatStr(tpl: string, vals: Record<string, number | string>): string {
  return tpl.replace(/\{(\w+)(?::\.(\d+)f)?\}/g, (_, k: string, nd?: string) =>
    nd === undefined ? String(vals[k]) : pyFormat(vals[k] as number, Number(nd)));
}
const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

// headline values that keep their sign (a negative trunk lean is a lean backwards, not a small forward one)
const SIGNED = new Set(["trunk_flexion_ffc_br", "trunk_forward_br"]);

// a "watch" reading within one measurement step of its target is borderline: still listed, but ranked below clear misses
const BORDER_STEP: Record<string, number> = { deg: 3.0, "% height": 3.0, cm: 5.0 };

export function coach(metrics: Metric[], view: string, fps: number): CoachingOut {
  const by: Record<string, Metric> = {};
  for (const m of metrics) by[m.key] = m;
  // ---------- headline score: confidence-weighted average of rated metrics ----------
  let num = 0, den = 0;
  const contrib: CoachingOut["score_breakdown"] = [];
  for (const [k, w] of Object.entries(SCORE_WEIGHTS)) {
    const m = by[k];
    if (!m || m.value === null || !has(RATING_POINTS, m.rating) || m.confidence < 0.3) continue;
    const cw = w * (0.3 + 0.7 * m.confidence);
    num += cw * RATING_POINTS[m.rating];
    den += cw;
    contrib.push({ key: k, label: m.label, rating: m.rating, weight: pyRound(cw, 2) });
  }
  // a headline number needs a few independent measurements behind it, not one lucky metric
  const score = den !== 0 && contrib.length >= MIN_SCORED ? pyRound((100 * num) / den) : null;
  let grade: string | null = null;
  if (score !== null) {
    // grades the action's checkpoints, not the player's standard (so no "Elite" for a club bowler)
    grade = score >= 85 ? "Excellent" : score >= 70 ? "Strong" : score >= 55 ? "Developing" : "Needs work";
  }

  // ---------- priorities ----------
  const issues: Issue[] = [];
  for (const [key, trig, cat, drill, w, head, evidence] of RULES) {
    const m = by[key];
    if (!m || m.value === null || !trig.includes(m.rating) || m.confidence < 0.3) continue;
    let sev = (m.rating === "risk" ? 1.5 : 1.0) * w * (0.4 + 0.6 * m.confidence);
    // {side}: which way a two-sided band was missed (a beginner needs "short", not "outside the range")
    const good = NORMS[key]?.good;
    const lo = good ? good[0] : null, hi = good ? good[1] : null;
    const v = m.value;
    const side = lo !== null && v < lo ? "Short" : "Long";
    const gap = lo !== null && v < lo ? lo - v : hi !== null && v > hi ? v - hi : 0.0;
    const step = m.unit === "ms" && fps ? 1000.0 / fps : BORDER_STEP[m.unit] ?? 0.0;
    const borderline = m.rating === "watch" && gap > 0 && gap <= step;
    if (borderline) sev *= 0.5;
    issues.push({
      key, category: cat, severity: pyRound(sev, 2), rating: m.rating, borderline,
      // trunk lean keeps its sign (a negative value leans back); a true minus sign for display
      headline: formatStr(head, { v: SIGNED.has(key) ? m.value : Math.abs(m.value), side }).replace(/(^|[\s(])-(?=\d)/g, "$1\u2212"), evidence,
      why: "explain" in m ? m.explain : "", metric: key, confidence: m.confidence,
      drill: DRILLS[drill === "stride" && side === "Short" ? "stride_short" : drill], drill_key: drill, event: m.event ?? null,
    });
  }
  issues.sort((a, b) => b.severity - a.severity);   // stable, like Python's sort
  const seen = new Set<string>();
  const priorities: Issue[] = [];
  for (const it of issues) {
    if (seen.has(it.drill.title)) continue;
    seen.add(it.drill.title);
    priorities.push(it);
    if (priorities.length === 3) break;
  }
  // never praise a body area that is also flagged (e.g. "good trunk flexion" next to "upright trunk at release")
  const flagged = new Set(issues.map((i) => AREA[i.key]));
  const strengths = metrics
    .filter((m) => has(POSITIVES, m.key) && m.rating === "good" && m.confidence >= 0.3 && !flagged.has(AREA[m.key]))
    .map((m) => POSITIVES[m.key]).slice(0, 4);

  // ---------- capture quality advice ----------
  const capture: string[] = [];
  if (fps < 90) {
    capture.push(`Filmed at ${pyFormat(fps, 0)} fps, so release timing is approximate: the arm moves about `
      + `${pyFormat(pyMin(80, 2000 / fps), 0)}° from one frame to the next. Film in slow motion (120–240 fps) next time `
      + "for precise release and elbow measurements.");
  }
  if (view === "oblique") {
    capture.push("Filmed at an angle to the pitch: knee, trunk, stride, side-bend and alignment can't be measured "
      + "reliably. Film square on: side-on (10–15 m away, hip height) or straight from behind the stumps.");
  } else if (view === "behind" || view === "front_on") {
    capture.push("Filmed from behind/in front: side-bend, arm slot and alignment are measured well, but knee, "
      + "trunk-flexion and stride can't be measured from this angle. Add a side-on clip for those.");
  } else if (view === "side_on") {
    capture.push("Filmed side-on: knee, trunk flexion, stride and release height are measured well; add a "
      + "clip from behind the bowler for side-bend and alignment.");
  }
  return { score, grade, score_breakdown: contrib, priorities, all_issues: issues, strengths, capture_tips: capture,
    disclaimer: "Estimates from a single video. Not a medical assessment and not an ICC legality test." };
}
