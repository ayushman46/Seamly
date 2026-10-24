/** Weekly bowling-log check (lib/bowlingLog.ts) against the age-group limits. */
import { describe, expect, it } from "vitest";
import { weekCheck, type LogLimits } from "../src/lib/bowlingLog";
import type { BowlingLogEntry } from "../src/types";

const U13: LogLimits = { day: 8, days_week: 3, rule: "At least one day off after every bowling day.", label: "11–12" };
const U19: LogLimits = { day: 18, days_week: 4, rule: "No more than two bowling days in a row.", label: "17–18" };
const e = (date: string, overs: number, kind: BowlingLogEntry["kind"] = "nets"): BowlingLogEntry => ({ id: date + overs, date, overs, kind });
const WED = new Date(2026, 9, 28);   // Wednesday 28 Oct 2026; that week is Mon 26 – Sun 1 Nov

describe("bowling log week check", () => {
  it("sums each day and counts bowling days in the Monday–Sunday week", () => {
    const w = weekCheck([e("2026-10-26", 3), e("2026-10-26", 2), e("2026-10-28", 4), e("2026-10-20", 6)], WED, U13);
    expect([w.from, w.to]).toEqual(["2026-10-26", "2026-11-01"]);
    expect(w.days).toBe(2);
    expect(w.overs).toBe(9);
    expect(w.perDay).toEqual([{ date: "2026-10-26", overs: 5 }, { date: "2026-10-28", overs: 4 }]);
    expect(w.warnings).toEqual([]);
  });

  it("flags too many bowling days, too many overs in a day and no rest day (under 17)", () => {
    const w = weekCheck([e("2026-10-26", 9, "match"), e("2026-10-28", 2), e("2026-10-29", 2), e("2026-10-31", 2)], WED, U13);
    expect(w.warnings.some((x) => x.startsWith("4 bowling days this week"))).toBe(true);
    expect(w.warnings.some((x) => x.includes("more than the 8-over daily limit"))).toBe(true);
    expect(w.warnings.some((x) => x.includes("should rest the day after"))).toBe(true);
  });

  it("allows two days in a row from 17 but not three", () => {
    expect(weekCheck([e("2026-10-26", 4), e("2026-10-27", 4)], WED, U19).warnings).toEqual([]);
    const w = weekCheck([e("2026-10-26", 4), e("2026-10-27", 4), e("2026-10-28", 4)], WED, U19);
    expect(w.warnings.some((x) => x.startsWith("Three bowling days in a row"))).toBe(true);
  });

  it("catches a Sunday–Monday pair across the week boundary", () => {
    const w = weekCheck([e("2026-10-25", 3), e("2026-10-26", 3)], WED, U13);
    expect(w.days).toBe(1);
    expect(w.warnings.some((x) => x.includes("should rest the day after"))).toBe(true);
  });

  it("only sums without limits (adult spinners)", () => {
    expect(weekCheck([e("2026-10-26", 30), e("2026-10-27", 30)], WED, null).warnings).toEqual([]);
  });
});
