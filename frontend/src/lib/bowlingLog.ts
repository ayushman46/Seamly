/**
 * The bowling log's weekly check against the age group's limits (Cricket Australia junior pace guidelines):
 * bowling days this week, balls on any one day, and rest between bowling days. Counted in balls, written in
 * cricket notation (4.3 = 4 overs and 3 balls).
 */
import type { BowlingLogEntry } from "../types";

export interface LogLimits { day: number | null; days_week: number; rule: string; label: string }
export interface WeekCheck {
  from: string;                // Monday of the week, YYYY-MM-DD
  to: string;                  // Sunday
  days: number;                // days with any bowling
  balls: number;               // total balls this week
  perDay: { date: string; balls: number }[];
  warnings: string[];
}

/** "4.3" (4 overs, 3 balls) → 27 balls; null if it isn't a number of overs (the ball digit is 0–5). */
export function parseOvers(text: string): number | null {
  const m = String(text).trim().match(/^(\d{1,2})(?:\.([0-5]))?$/);
  return m ? Number(m[1]) * 6 + Number(m[2] ?? 0) : null;
}
/** 27 balls → "4.3"; 24 → "4". */
export const formatOvers = (balls: number) => `${Math.floor(balls / 6)}${balls % 6 ? `.${balls % 6}` : ""}`;

export const isoDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const addDays = (iso: string, n: number) => {
  const [y, m, d] = iso.split("-").map(Number);
  return isoDate(new Date(y, m - 1, d + n));
};
const pretty = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
};

/** This week's bowling (Monday to Sunday around `today`) checked against the limits. */
export function weekCheck(log: BowlingLogEntry[], today: Date, limits: LogLimits | null): WeekCheck {
  const t = isoDate(today);
  const dow = (today.getDay() + 6) % 7;
  const from = addDays(t, -dow), to = addDays(from, 6);
  const byDay = new Map<string, number>();
  for (const e of log) if (e.date >= addDays(from, -2) && e.date <= to) byDay.set(e.date, (byDay.get(e.date) ?? 0) + e.balls);
  const perDay = [...byDay.entries()].filter(([d]) => d >= from).sort(([a], [b]) => a.localeCompare(b)).map(([date, balls]) => ({ date, balls }));
  const warnings: string[] = [];
  if (limits) {
    if (perDay.length > limits.days_week) {
      warnings.push(`${perDay.length} bowling days this week: the guideline for ${limits.label} bowlers is at most ${limits.days_week}.`);
    }
    for (const d of perDay) {
      if (limits.day !== null && d.balls > limits.day * 6) {
        warnings.push(`${pretty(d.date)}: ${formatOvers(d.balls)} overs is more than the ${limits.day}-over daily limit.`);
      }
    }
    // rest between bowling days: one warning per run of consecutive days (the two days before Monday count, so a
    // Sunday–Monday pair is caught). Under 17: a day off after every bowling day; from 17: at most two in a row.
    const most = /two bowling days in a row/i.test(limits.rule) ? 2 : 1;
    const days = [...byDay.keys()].sort();
    for (let i = 0; i < days.length;) {
      let j = i;
      while (j + 1 < days.length && addDays(days[j], 1) === days[j + 1]) j++;
      const len = j - i + 1;
      if (len > most && days[j] >= from) {
        warnings.push(most === 1
          ? `Bowled on ${len} days in a row (${pretty(days[i])} to ${pretty(days[j])}): ${limits.label} bowlers should rest the day after a bowling day.`
          : `${len} bowling days in a row (${pretty(days[i])} to ${pretty(days[j])}): no more than two in a row.`);
      }
      i = j + 1;
    }
  }
  const balls = perDay.reduce((n, d) => n + d.balls, 0);
  return { from, to, days: perDay.length, balls, perDay, warnings };
}

export interface Workload {
  acute: number;      // balls in the last 7 days, today included
  chronic: number;    // average balls a week over the last 28 days
  ratio: number;      // acute / chronic
  zone: "low" | "ok" | "high" | "spike";
}

/**
 * Acute:chronic workload ratio from the log: this week's balls against the weekly average of the last four weeks.
 * Spikes well above the bowler's usual load went with more injuries in fast bowlers (Hulin et al. 2014, BJSM);
 * 0.8–1.3 is the range usually aimed for. Needs three weeks of logging to mean anything, else null.
 */
export function workload(log: BowlingLogEntry[], today: Date): Workload | null {
  const t = isoDate(today);
  const from28 = addDays(t, -27), from7 = addDays(t, -6);
  const inRange = log.filter((e) => e.date >= from28 && e.date <= t);
  const first = inRange.reduce<string | null>((m, e) => (m === null || e.date < m ? e.date : m), null);
  if (!first || first > addDays(t, -20)) return null;
  const sum = (xs: BowlingLogEntry[]) => xs.reduce((n, e) => n + e.balls, 0);
  const acute = sum(inRange.filter((e) => e.date >= from7));
  // the weekly average over the weeks actually logged (three or four), not always four
  const [fy, fm, fd] = first.split("-").map(Number);
  const days = Math.min(28, Math.round((today.getTime() - new Date(fy, fm - 1, fd).getTime()) / 86400000) + 1);
  const chronic = sum(inRange) / (days / 7);
  if (chronic <= 0) return null;
  const ratio = Math.round((acute / chronic) * 100) / 100;   // the zone follows the value shown
  return { acute, chronic, ratio, zone: ratio < 0.8 ? "low" : ratio <= 1.3 ? "ok" : ratio <= 1.5 ? "high" : "spike" };
}

