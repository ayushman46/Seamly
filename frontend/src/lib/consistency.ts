/**
 * How repeatable a bowler's action is: the spread of each key measurement over their recent deliveries filmed from
 * the same angle, against what one camera can resolve. A repeatable action is the base for accuracy, and a sudden
 * change in one measurement is worth a look.
 */
import { KEY_METRICS, changeTolerance } from "../engine/progress";
import type { SessionSummary, View } from "../types";

type Session = Pick<SessionSummary, "view" | "arm" | "fps_real" | "metrics">;

export type Steadiness = "steady" | "some" | "varies";
export interface ConsistencyRow {
  key: string;
  label: string;
  unit: string;
  n: number;            // deliveries used
  mean: number;
  sd: number;           // sample standard deviation
  noise: number;        // what one camera can resolve for this value at these frame rates
  level: Steadiness;
}

/** Spread of each key metric over the last `last` sessions filmed from the latest session's angle (3 or more needed). */
export function consistency(sessions: Session[], last = 6): { view: View | null; rows: ConsistencyRow[] } {
  const latest = sessions[sessions.length - 1];
  if (!latest) return { view: null, rows: [] };
  // like with like: the same camera angle and the same bowling arm as the latest delivery
  const same = sessions.filter((s) => s.view === latest.view && (s.arm ?? latest.arm) === latest.arm).slice(-last);
  const rows: ConsistencyRow[] = [];
  for (const key of KEY_METRICS) {
    const pts = same.filter((s) => s.metrics[key]?.reliability === "measured");
    if (pts.length < 3) continue;
    const v = pts.map((s) => s.metrics[key].value);
    const mean = v.reduce((a, b) => a + b, 0) / v.length;
    const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (v.length - 1));
    const { label, unit } = pts[pts.length - 1].metrics[key];
    // what one camera resolves for this value at the slowest of these clips (the rule compare and progress use)
    const fpsMin = Math.min(...pts.map((s) => s.fps_real || Infinity));
    const noise = changeTolerance(key, unit, Number.isFinite(fpsMin) ? fpsMin : null) || 3;
    rows.push({ key, label, unit, n: v.length, mean, sd, noise, level: sd <= noise ? "steady" : sd <= 2 * noise ? "some" : "varies" });
  }
  // the least repeatable first
  rows.sort((a, b) => b.sd / b.noise - a.sd / a.noise);
  return { view: latest.view, rows };
}
