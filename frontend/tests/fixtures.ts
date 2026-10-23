/** Loads the Python-pipeline fixtures recorded by backend/tools/export_fixtures.py. */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const FIXTURES = ["synth_side", "epping_side", "bumrah_behind", "anderson_edited"] as const;
export type FixtureName = (typeof FIXTURES)[number];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Fixture = any;
const cache = new Map<string, Fixture>();
export function loadFixture(name: FixtureName): Fixture {
  if (!cache.has(name)) cache.set(name, JSON.parse(readFileSync(join(__dirname, "fixtures", `${name}.json`), "utf8")));
  return cache.get(name);
}

/** Max absolute difference between two nested numeric arrays (NaN/null treated as equal to each other). */
export function maxAbsDiff(a: unknown, b: unknown): number {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return Infinity;
    let m = 0;
    for (let i = 0; i < a.length; i++) m = Math.max(m, maxAbsDiff(a[i], b[i]));
    return m;
  }
  const na = a === null || (typeof a === "number" && Number.isNaN(a));
  const nb = b === null || (typeof b === "number" && Number.isNaN(b));
  if (na || nb) return na && nb ? 0 : Infinity;
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b);
  return a === b ? 0 : Infinity;
}
