import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { improved, playerOut, playerProgress, summarise } from "../src/engine/progress";
import { FIXTURES, loadFixture } from "./fixtures";
import { deepDiff } from "./pyparity";

// Recorded from backend/bowlnet/progress.py (+ api._player_out) on a temporary store: summarise() of the four
// fixture results, improved() on a grid, and the progress payload for four players (multi-view sessions, a failed
// and a queued analysis, one without a summary, a focus streak across a clip that can't measure it, a fixed
// focus, an empty profile, a single session).
const ref = JSON.parse(readFileSync(join(__dirname, "fixtures", "progress_case.json"), "utf8"));

describe("progress parity with Python", () => {
  it("summarise", () => {
    for (const name of FIXTURES) expect(deepDiff(summarise(loadFixture(name).result), ref.summaries[name], 0)).toEqual([]);
    const r = structuredClone(loadFixture("bumrah_behind").result);
    r.coaching.priorities = [];
    delete r.fps_real;
    expect(deepDiff(summarise(r), ref.summarise_edge, 0)).toEqual([]);
  });

  it("improved", () => {
    const bad = (ref.improved as [string, number, number, string, number | null, boolean | null][])
      .filter(([k, b, a, u, fps, out]) => improved(k, b, a, u, fps) !== out);
    expect(bad).toEqual([]);
  });

  it("playerProgress (+ playerOut = the /api/players/{pid}/progress payload)", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payload = (p: any, metas: any[]) => ({ player: playerOut(p, metas), ...playerProgress(p, metas) });
    for (const c of ref.cases) expect(deepDiff(payload(c.player, ref.metas), c.out, 0)).toEqual([]);
    // {meta, summary} pairs of just this player's analyses give the same result
    const p0 = ref.cases[0].player;
    const pairs = ref.metas.filter((m: { player_id: string }) => m.player_id === p0.id)
      .map((m: { summary?: unknown }) => ({ meta: { ...m, summary: undefined }, summary: m.summary }));
    expect(deepDiff(payload(p0, pairs), ref.cases[0].out, 0)).toEqual([]);
  });
});
