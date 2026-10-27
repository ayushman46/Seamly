/** Display numbers (lib/format.ts): exact halves round to even, as the engine's coaching text does. */
import { describe, expect, it } from "vitest";
import { fmt } from "../src/lib/format";
import { pyFormat } from "../src/engine/metrics";

describe("fmt", () => {
  it("rounds exact halves to even, like the coaching text", () => {
    expect(fmt(126.5)).toBe("126");
    expect(fmt(127.5)).toBe("128");
    expect(fmt(-2.5)).toBe("−2");
    expect(fmt(0.25, 1)).toBe("0.2");
    expect(fmt(126.6)).toBe("127");
    for (const v of [126.5, 127.5, 2.25, 33.35, -0.5, 104.45]) for (const d of [0, 1]) expect(fmt(v, d).replace("−", "-")).toBe(pyFormat(v, d).replace(/^-0(\.0+)?$/, "0$1"));
  });
  it("keeps the dash, the true minus and no minus zero", () => {
    expect(fmt(null)).toBe("–");
    expect(fmt(-0.2)).toBe("0");
    expect(fmt(-3)).toBe("−3");
  });
});
