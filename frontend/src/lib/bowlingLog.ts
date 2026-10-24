/**
 * The bowling log's weekly check against the age group's limits (Cricket Australia junior pace guidelines):
 * bowling days this week, overs on any one day, and rest between bowling days.
 */
import type { BowlingLogEntry } from "../types";

export interface LogLimits { day: number | null; days_week: number; rule: string; label: string }
export interface WeekCheck {
  from: string;                // Monday of the week, YYYY-MM-DD
  to: string;                  // Sunday
  days: number;                // days with any bowling
  overs: number;               // total overs this week
  perDay: { date: string; overs: number }[];
  warnings: string[];
}

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
  for (const e of log) if (e.date >= addDays(from, -2) && e.date <= to) byDay.set(e.date, (byDay.get(e.date) ?? 0) + e.overs);
  const perDay = [...byDay.entries()].filter(([d]) => d >= from).sort(([a], [b]) => a.localeCompare(b)).map(([date, overs]) => ({ date, overs }));
  const warnings: string[] = [];
  if (limits) {
    if (perDay.length > limits.days_week) {
      warnings.push(`${perDay.length} bowling days this week: the guideline for ${limits.label} bowlers is at most ${limits.days_week}.`);
    }
    for (const d of perDay) {
      if (limits.day !== null && d.overs > limits.day) warnings.push(`${pretty(d.date)}: ${d.overs} overs is more than the ${limits.day}-over daily limit.`);
    }
    // rest between bowling days (the two days before Monday count, so a Sunday–Monday pair is caught)
    const days = [...byDay.keys()].sort();
    const run = /two bowling days in a row/i.test(limits.rule) ? 3 : 2;   // under 17: a day off after every bowling day
    for (let i = 0; i + run - 1 < days.length; i++) {
      const last = days[i + run - 1];
      if (last < from) continue;
      if (addDays(days[i], run - 1) === last) {
        warnings.push(run === 2
          ? `Bowled on ${pretty(days[i])} and ${pretty(last)}: ${limits.label} bowlers should rest the day after a bowling day.`
          : `Three bowling days in a row (${pretty(days[i])} to ${pretty(last)}): no more than two in a row.`);
      }
    }
  }
  const overs = Math.round(perDay.reduce((n, d) => n + d.overs, 0) * 10) / 10;
  return { from, to, days: perDay.length, overs, perDay, warnings };
}
