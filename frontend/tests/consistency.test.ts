/** Consistency across a player's recent deliveries (lib/consistency.ts). */
import { describe, expect, it } from "vitest";
import { consistency } from "../src/lib/consistency";
import type { Session } from "../src/engine/progress";

const s = (i: number, knee: number, height: number, view: Session["view"] = "side_on", fps = 240): Session => ({
  id: `a${i}`, name: null, created: i, score: 70, grade: "Strong", view, arm: "right", fps_real: fps, top: null,
  metrics: {
    front_knee_br: { label: "Front knee at release", unit: "deg", value: knee, rating: "good", reliability: "measured" },
    release_height_pct: { label: "Release height", unit: "% height", value: height, rating: "good", reliability: "measured" },
  },
});

describe("consistency", () => {
  it("needs three deliveries from the same angle", () => {
    expect(consistency([s(1, 170, 110), s(2, 171, 110)]).rows).toEqual([]);
    expect(consistency([s(1, 170, 110), s(2, 171, 110), s(3, 160, 100, "behind")]).rows).toEqual([]);
  });

  it("calls a spread within what one camera resolves steady, and puts the least repeatable first", () => {
    const r = consistency([s(1, 170, 110), s(2, 171, 112), s(3, 169, 108), s(4, 150, 111), s(5, 180, 109)]);
    expect(r.view).toBe("side_on");
    expect(r.rows.map((x) => x.key)).toEqual(["front_knee_br", "release_height_pct"]);
    expect(r.rows[0].level).toBe("varies");
    expect(r.rows[1].level).toBe("steady");      // release height resolves to about 8 points
    expect(r.rows[0].n).toBe(5);
  });

  it("widens the noise floor at low frame rates", () => {
    // ±4° at 240 fps is "some"; at 25 fps a frame either side moves the knee about 6°, so it's steady
    const knees = [166, 170, 174, 170];
    expect(consistency(knees.map((k, i) => s(i, k, 110))).rows.find((x) => x.key === "front_knee_br")!.level).toBe("some");
    expect(consistency(knees.map((k, i) => s(i, k, 110, "side_on", 25))).rows.find((x) => x.key === "front_knee_br")!.level).toBe("steady");
  });

  it("leaves out deliveries with the other bowling arm", () => {
    const left = [1, 2].map((i) => ({ ...s(i, 120, 110), arm: "left" }));
    expect(consistency([...left, s(3, 170, 110), s(4, 171, 110)]).rows).toEqual([]);
    expect(consistency([...left, s(3, 170, 110), s(4, 171, 110), s(5, 169, 110)]).rows[0].n).toBe(3);
  });

  it("uses only the last six from the latest angle", () => {
    const old = [s(1, 120, 110), s(2, 125, 110)];
    const recent = [3, 4, 5, 6, 7, 8].map((i) => s(i, 170, 110));
    expect(consistency([...old, ...recent]).rows[0].n).toBe(6);
    expect(consistency([...old, ...recent]).rows.every((x) => x.level === "steady")).toBe(true);
  });
});
