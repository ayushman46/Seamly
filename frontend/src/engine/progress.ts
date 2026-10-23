/**
 * Progress over time for one player (port of backend/bowlnet/progress.py, plus the `player` block the
 * /api/players/{pid}/progress endpoint adds): score and key-metric trends, what changed since the last session,
 * personal bests and the current focus. Built from the compact per-analysis summary kept with each analysis'
 * meta, so the history page never has to load full results. There is no file store here: the caller passes the
 * analysis metas.
 */
import type { AnalysisResult, Player, PlayerProgress, View } from "../types";
import { NORMS, pyFormat, pyMax, pyMin, pyRound } from "./metrics";

type BetterRule = "higher" | "lower" | ["band", number, number];
// which way is "better" for each rated metric (absent = descriptive, no direction)
export const BETTER: Record<string, BetterRule> = {
  front_knee_br: "higher", front_knee_ffc: "higher", front_knee_flexion: "lower", back_knee_bfc: "higher",
  trunk_forward_br: "higher", trunk_flexion_ffc_br: "higher", trunk_lateral_br: "lower",
  hip_shoulder_sep_bfc: "lower", shoulder_counter_rotation: "lower", release_height_pct: "higher",
  stride_length_pct: ["band", 70.0, 87.0], ffc_to_br_ms: "lower", head_offset_br: "lower",
  elbow_extension: "lower",
};
// smallest change worth calling an improvement: about the measurement resolution of each kind of value
// (timings: at least one frame of the slower clip, see improved(); release height: its stated +/- 8 points)
export const MIN_CHANGE: Record<string, number> = { deg: 3.0, "% height": 2.0, ms: 20.0, cm: 5.0 };
export const MIN_CHANGE_KEY: Record<string, number> = { release_height_pct: 8.0 };
// how fast each value typically moves around the event it is read at (units per second, conservative). A reading
// one frame earlier or later differs by about this / fps, so smaller changes can't be told from timing noise.
export const EVENT_RATE: Record<string, number> = {
  trunk_forward_br: 450.0, trunk_flexion_ffc_br: 500.0, trunk_lateral_br: 200.0, front_knee_br: 150.0, front_knee_ffc: 150.0,
  front_knee_flexion: 150.0, back_knee_bfc: 250.0, hip_shoulder_sep_bfc: 150.0, head_offset_br: 200.0, release_height_pct: 100.0,
};
// shown on the progress page, in this order (when measured)
export const KEY_METRICS = ["release_height_pct", "front_knee_br", "trunk_lateral_br", "trunk_flexion_ffc_br",
  "head_offset_br", "ffc_to_br_ms", "stride_length_pct", "hip_shoulder_sep_bfc", "back_knee_bfc"] as const;

const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

export interface SummaryMetric { label: string; unit: string; value: number; rating: string; reliability: string }
export interface Top { key: string; headline: string; title: string }
/** Compact record of one analysis (what Python stores as meta.json "summary"). */
export interface Summary {
  score: number | null;
  grade: string | null;
  view: View;
  arm: string;
  fps_real: number;
  top: Top | null;
  metrics: Record<string, SummaryMetric>;
}

type ResultLike = Pick<AnalysisResult, "coaching" | "view" | "bowling_arm" | "metrics"> & { fps_real?: number | null };

/** Compact record of one analysis for history and progress. */
export function summarise(result: ResultLike): Summary {
  const c = result.coaching;
  const top = (c.priorities && c.priorities.length ? c.priorities : [null])[0];
  const metrics: Record<string, SummaryMetric> = {};
  for (const m of result.metrics) {
    if (m.value === null || m.value === undefined) continue;
    metrics[m.key] = { label: m.label, unit: m.unit, value: m.value, rating: m.rating, reliability: m.reliability };
  }
  return {
    score: c.score ?? null, grade: c.grade ?? null, view: result.view.view,
    arm: result.bowling_arm.arm, fps_real: pyRound(result.fps_real || 0, 1),
    top: top ? { key: top.key, headline: top.headline, title: top.drill.title } : null,
    metrics,
  };
}

/** True/False if the change is meaningful and in the better/worse direction; null if too small or no direction.
 * fps: real frame rate of the slower of the two clips (a timing can't resolve less than one frame). */
export function improved(key: string, before: number, after: number, unit: string, fps: number | null = null): boolean | null {
  const rule = BETTER[key];
  let tol = has(MIN_CHANGE_KEY, key) ? MIN_CHANGE_KEY[key] : has(MIN_CHANGE, unit) ? MIN_CHANGE[unit] : 0.0;
  if (unit === "ms" && fps) tol = pyMax(tol, 1000.0 / fps);
  // a value read at an event differs by about its speed / fps when the event lands one frame either side
  else if (fps && has(EVENT_RATE, key)) tol = pyMax(tol, EVENT_RATE[key] / fps);
  // other angles and heights: demand a proportionally bigger change at low frame rates
  else if (fps && fps < 60) tol *= 60.0 / fps;
  if (rule === undefined || Math.abs(after - before) < tol) return null;
  if (Array.isArray(rule)) {
    const [, lo, hi] = rule;
    const dist = (v: number) => (lo <= v && v <= hi ? 0.0 : pyMin(Math.abs(v - lo), Math.abs(v - hi)));
    if (Math.abs(dist(after) - dist(before)) < tol) return null;
    return dist(after) < dist(before);
  }
  return rule === "higher" ? after > before : after < before;
}

function betterOf(key: string, a: number, b: number): number {
  const rule = BETTER[key];
  if (Array.isArray(rule)) {
    const [, lo, hi] = rule;
    const mid = (lo + hi) / 2;
    return Math.abs(a - mid) <= Math.abs(b - mid) ? a : b;
  }
  return rule === "higher" ? (b > a ? b : a) : (b < a ? b : a);
}

function betterLabel(key: string): string | null {
  const rule = BETTER[key];
  if (rule === undefined) return null;
  if (Array.isArray(rule)) return `${pyFormat(rule[1], 0)}–${pyFormat(rule[2], 0)}`;
  return rule;
}

/** An analysis meta as the store keeps it (id/name/created/status/player_id/score, and the summary). */
export interface AnalysisMetaLike {
  id: string;
  name?: string | null;
  created?: number | null;
  status?: string | null;
  player_id?: string | null;
  score?: number | null;
  summary?: Summary | null;
}
export type PlayerProfile = Omit<Player, "analyses" | "latest_score" | "last_analysis">;

export type Session = { id: string; name: string | null; created: number | null } & Summary;
interface TrendPoint { id: string; created: number | null; value: number; rating: string }
/** progress.player_progress; the endpoint adds `player` (see playerOut). */
export interface ProgressOut {
  sessions: Session[];
  trends: Record<string, { label: string; unit: string; points: TrendPoint[]; better: string | null;
    good: [number | null, number | null] | null; norm: string | null }>;
  best: Record<string, TrendPoint & { label: string; unit: string }>;
  since_last: PlayerProgress["since_last"];
  compared_to: { id: string; created: number | null; view: View } | null;
  focus: (Top & { sessions: number; first_value: number | null; latest_value: number | null }) | null;
  stats: { count: number; best_score: number | null; latest_score: number | null; first_score: number | null;
    first: number | null; last: number | null };
}

type AnalysisIn = AnalysisMetaLike | { meta: AnalysisMetaLike; summary?: Summary | null };
const asMeta = (a: AnalysisIn): AnalysisMetaLike =>
  "meta" in a && a.meta && typeof a.meta === "object" ? { ...a.meta, summary: a.summary ?? a.meta.summary } : a as AnalysisMetaLike;
/** This player's finished analyses, oldest first (stable for equal times). */
const finished = (player: PlayerProfile, analyses: AnalysisIn[]): AnalysisMetaLike[] =>
  analyses.map(asMeta).filter((m) => m.player_id === player.id && m.status === "done")
    .sort((a, b) => (a.created ?? 0) - (b.created ?? 0));

/** api._player_out: the profile plus its analysis count, latest score and time. */
export function playerOut(player: PlayerProfile, analyses: AnalysisIn[]): Player {
  const mine = finished(player, analyses);
  const last = mine[mine.length - 1];
  return { ...player, analyses: mine.length, latest_score: last ? last.score ?? null : null,
    last_analysis: last ? last.created ?? null : null };
}

/** progress.player_progress, without the store: `analyses` are analysis metas (all of them or just this player's;
 * like Python only this player's finished ones count) carrying their `summary`, or `{meta, summary}` pairs.
 * /api/players/{pid}/progress returns `{player: playerOut(player, analyses), ...playerProgress(player, analyses)}`. */
export function playerProgress(player: PlayerProfile, analyses: AnalysisIn[]): ProgressOut {
  const metas = finished(player, analyses);
  const sessions: Session[] = [];
  for (const m of metas) {
    // Python rebuilds a missing summary from analysis.json; without a store such analyses are skipped
    const s = m.summary && Object.keys(m.summary).length ? m.summary : null;
    if (s) sessions.push({ id: m.id, name: m.name ?? null, created: m.created ?? null, ...s });
  }
  const trends: Record<string, TrendPoint[]> = {};
  const labels: Record<string, { label: string; unit: string }> = {};
  for (const s of sessions) {
    for (const [k, v] of Object.entries(s.metrics)) {
      if (v.reliability !== "measured") continue;
      labels[k] = { label: v.label, unit: v.unit };
      (trends[k] ??= []).push({ id: s.id, created: s.created, value: v.value, rating: v.rating });
    }
  }
  const best: ProgressOut["best"] = {};
  for (const [k, pts] of Object.entries(trends)) {
    if (!has(BETTER, k)) continue;
    let b = pts[0];
    for (const p of pts.slice(1)) if (betterOf(k, p.value, b.value) === p.value && p.value !== b.value) b = p;
    best[k] = { ...b, ...labels[k] };
  }
  // since last time: the latest session against the previous one filmed from the same camera angle (values from
  // different angles are measured differently and don't compare)
  const sinceLast: ProgressOut["since_last"] = [];
  let comparedTo: ProgressOut["compared_to"] = null;
  if (sessions.length) {
    const cur = sessions[sessions.length - 1];
    const prev = sessions.slice(0, -1).reverse().find((s) => s.view === cur.view);
    if (prev) {
      comparedTo = { id: prev.id, created: prev.created, view: prev.view };
      const fps = Math.min(cur.fps_real || 0, prev.fps_real || 0) || null;
      for (const [k, v] of Object.entries(cur.metrics)) {
        const pv = prev.metrics[k];
        if (!pv || v.reliability !== "measured" || pv.reliability !== "measured" || !has(BETTER, k)) continue;
        // a value not rated against a norm in both sessions (e.g. "info") gets no better/worse verdict
        const RATED = ["good", "watch", "risk"];
        const rated = RATED.includes(v.rating) && RATED.includes(pv.rating);
        sinceLast.push({ key: k, label: v.label, unit: v.unit, before: pv.value, after: v.value, rated,
          improved: rated ? improved(k, pv.value, v.value, v.unit, fps) : null });
      }
      const rank = (d: { improved: boolean | null }) => (d.improved === null ? 2 : 0) + (!d.improved ? 1 : 0);
      sinceLast.sort((a, b) => rank(a) - rank(b));
    }
  }
  // focus: the most recent top priority. Sessions that couldn't measure it (another camera angle) neither end nor
  // extend the streak; a later session that measured it as good means it has been fixed.
  let focus: ProgressOut["focus"] = null;
  let iTop = -1;
  for (let i = sessions.length - 1; i >= 0; i--) if (sessions[i].top) { iTop = i; break; }
  if (iTop >= 0) {
    const t = sessions[iTop].top as Top;
    const fixed = sessions.slice(iTop + 1).some((s) => s.metrics[t.key]?.rating === "good");
    if (!fixed) {
      let streak = 0, first: Session | null = null;
      for (const s of sessions.slice(0, iTop + 1).reverse()) {
        const isTop = !!s.top && s.top.key === t.key;
        if (!has(s.metrics, t.key) && !isTop) continue;   // not measured in that clip
        if (isTop) [streak, first] = [streak + 1, s];
        else break;
      }
      const latest = sessions.slice().reverse().find((s) => has(s.metrics, t.key));
      focus = { ...t, sessions: streak, first_value: first ? first.metrics[t.key]?.value ?? null : null,
        latest_value: latest ? latest.metrics[t.key].value : null };
    }
  }
  const scores = sessions.map((s) => s.score).filter((x): x is number => x !== null && x !== undefined);
  const trendsOut: ProgressOut["trends"] = {};
  for (const k of KEY_METRICS) {
    if (!has(trends, k)) continue;
    const good = NORMS[k]?.good;
    trendsOut[k] = { ...labels[k], points: trends[k], better: betterLabel(k), good: good ? [good[0], good[1]] : null,
      norm: NORMS[k]?.norm ?? null };
  }
  return {
    sessions,
    trends: trendsOut,
    best,
    since_last: sinceLast,
    compared_to: comparedTo,
    focus,
    stats: { count: sessions.length, best_score: scores.length ? scores.reduce(pyMax) : null,
      latest_score: scores.length ? scores[scores.length - 1] : null,
      first_score: scores.length ? scores[0] : null,
      first: sessions.length ? sessions[0].created : null,
      last: sessions.length ? sessions[sessions.length - 1].created : null },
  };
}
