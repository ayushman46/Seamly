/** Weekly bowling-log check (lib/bowlingLog.ts) against the age-group limits, counted in balls. */
import { describe, expect, it } from "vitest";
import { formatOvers, parseOvers, weekCheck, workload, type LogLimits } from "../src/lib/bowlingLog";
import type { BowlingLogEntry } from "../src/types";

const U13: LogLimits = { day: 8, days_week: 3, rule: "At least one day off after every bowling day.", label: "11–12" };
const U15: LogLimits = { day: 12, days_week: 3, rule: "At least one day off after every bowling day.", label: "13–14" };
const U19: LogLimits = { day: 18, days_week: 4, rule: "No more than two bowling days in a row.", label: "17–18" };
const e = (date: string, overs: string, kind: BowlingLogEntry["kind"] = "nets"): BowlingLogEntry => ({ id: date + overs, date, balls: parseOvers(overs)!, kind });
const WED = new Date(2026, 9, 28);   // Wednesday 28 Oct 2026; that week is Mon 26 – Sun 1 Nov

describe("overs in cricket notation", () => {
  it("reads 4.3 as four overs and three balls, and refuses non-overs", () => {
    expect(parseOvers("4")).toBe(24);
    expect(parseOvers("4.3")).toBe(27);
    expect(parseOvers("0.5")).toBe(5);
    for (const bad of ["4.6", "4.7", "4.33", "-1", "", "abc", "4."]) expect(parseOvers(bad)).toBeNull();
    expect(formatOvers(27)).toBe("4.3");
    expect(formatOvers(24)).toBe("4");
    expect(formatOvers(2 * 15)).toBe("5");   // 2.3 + 2.3 = 5 overs, not 4.6
  });
});

describe("bowling log week check", () => {
  it("sums each day and counts bowling days in the Monday–Sunday week", () => {
    const w = weekCheck([e("2026-10-26", "3"), e("2026-10-26", "2"), e("2026-10-28", "4"), e("2026-10-20", "6")], WED, U13);
    expect([w.from, w.to]).toEqual(["2026-10-26", "2026-11-01"]);
    expect(w.days).toBe(2);
    expect(formatOvers(w.balls)).toBe("9");
    expect(w.perDay).toEqual([{ date: "2026-10-26", balls: 30 }, { date: "2026-10-28", balls: 24 }]);
    expect(w.warnings).toEqual([]);
  });

  it("counts balls against the daily limit (6.5 + 5.5 is 12.4 overs, over 12)", () => {
    const w = weekCheck([e("2026-10-26", "6.5"), e("2026-10-26", "5.5")], WED, U15);
    expect(formatOvers(w.balls)).toBe("12.4");
    expect(w.warnings.some((x) => x.includes("12.4 overs is more than the 12-over daily limit"))).toBe(true);
  });

  it("flags too many bowling days and no rest day (under 17), once per run of days", () => {
    const w = weekCheck([e("2026-10-26", "4"), e("2026-10-27", "2"), e("2026-10-28", "2"), e("2026-10-30", "2")], WED, U13);
    expect(w.warnings.some((x) => x.startsWith("4 bowling days this week"))).toBe(true);
    const rest = w.warnings.filter((x) => x.includes("should rest the day after"));
    expect(rest).toHaveLength(1);
    expect(rest[0]).toContain("3 days in a row");
  });

  it("allows two days in a row from 17 but not three (one warning for a long run)", () => {
    expect(weekCheck([e("2026-10-26", "4"), e("2026-10-27", "4")], WED, U19).warnings).toEqual([]);
    const w = weekCheck(["26", "27", "28", "29", "30", "31"].map((d) => e(`2026-10-${d}`, "2")), WED, U19);
    expect(w.warnings.filter((x) => x.includes("in a row"))).toHaveLength(1);
    expect(w.warnings.some((x) => x.startsWith("6 bowling days in a row"))).toBe(true);
  });

  it("catches a Sunday–Monday pair across the week boundary", () => {
    const w = weekCheck([e("2026-10-25", "3"), e("2026-10-26", "3")], WED, U13);
    expect(w.days).toBe(1);
    expect(w.warnings.some((x) => x.includes("should rest the day after"))).toBe(true);
  });

  it("only sums without limits (adult spinners)", () => {
    expect(weekCheck([e("2026-10-26", "30"), e("2026-10-27", "30")], WED, null).warnings).toEqual([]);
  });
});

describe("acute:chronic workload", () => {
  const day = (n: number) => { const d = new Date(2026, 9, 28 + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  it("needs three weeks of logging", () => {
    expect(workload([e(day(-10), "6"), e(day(-2), "6")], WED)).toBeNull();
  });
  it("is about 1 for a steady load and flags a spike", () => {
    const steady = [-27, -24, -20, -17, -13, -10, -6, -3].map((d) => e(day(d), "5"));
    const w = workload(steady, WED)!;
    expect(w.acute).toBe(60);           // two sessions of 5 overs this week
    expect(w.chronic).toBe(60);         // 8 sessions × 30 balls over 4 weeks
    expect(w.zone).toBe("ok");
    const spike = workload([...steady, e(day(-1), "8"), e(day(0), "8")], WED)!;
    expect(spike.ratio).toBeGreaterThan(1.5);
    expect(spike.zone).toBe("spike");
  });
});

