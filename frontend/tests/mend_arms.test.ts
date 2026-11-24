import { describe, expect, it } from "vitest";
import { mendLostArms } from "../src/engine/pose2d";

/** A standing figure 300 px tall whose left arm swings; `spoil` overwrites the left wrist on some frames. */
function clip(T: number, spoil: (t: number) => { p: number[]; c: number } | null) {
  const kp: number[][][] = [], kc: number[][] = [];
  for (let t = 0; t < T; t++) {
    const f = Array.from({ length: 17 }, () => [200, 100]);
    f[5] = [180, 100]; f[6] = [220, 100]; f[11] = [185, 200]; f[12] = [215, 200]; f[15] = [185, 340]; f[16] = [215, 340];
    f[7] = [180 - 2 * t, 140]; f[9] = [180 - 4 * t, 180];        // left elbow and wrist moving steadily
    f[8] = [240, 140]; f[10] = [250, 180];
    const c = new Array(17).fill(1);
    const s = spoil(t); if (s) { f[9] = s.p; c[9] = s.c; }
    kp.push(f); kc.push(c);
  }
  return { kp, kc };
}

describe("an arm the model has lost", () => {
  it("is carried across a short loss, from where it was last seen to where it is next seen", () => {
    const { kp, kc } = clip(20, (t) => (t >= 8 && t <= 10 ? { p: [400, 400], c: 0.3 } : null));
    const lost = kp.map(() => new Array<boolean>(17).fill(false));
    const out = mendLostArms(kp, kc, 60, [0], lost);
    for (let t = 8; t <= 10; t++) { expect(out[t][9][0]).toBeCloseTo(180 - 4 * t, 3); expect(out[t][9][1]).toBeCloseTo(180, 3); expect(lost[t][9]).toBe(true); }
    expect(out[7][9]).toEqual(kp[7][9]); expect(lost[7][9]).toBe(false);
  });
  it("leaves the other arm, and joints the model is sure of, alone", () => {
    const { kp, kc } = clip(20, (t) => (t >= 8 && t <= 10 ? { p: [400, 400], c: 0.3 } : null));
    const out = mendLostArms(kp, kc, 60, [1]);
    expect(out).toEqual(kp);
    const sure = clip(20, (t) => (t === 9 ? { p: [150, 170], c: 0.9 } : null));
    expect(mendLostArms(sure.kp, sure.kc, 60)).toEqual(sure.kp);
  });
  it("leaves a long unsure stretch as the model gave it", () => {
    const { kp, kc } = clip(40, (t) => (t >= 8 && t <= 30 ? { p: [180 - 4 * t + 5, 185], c: 0.45 } : null));
    expect(mendLostArms(kp, kc, 60)).toEqual(kp);
  });
  it("holds a wrist that has jumped onto the other arm's wrist until the clip ends", () => {
    const { kp, kc } = clip(30, (t) => (t >= 20 ? { p: [250 + (t % 2), 180], c: 0.3 } : null));
    const out = mendLostArms(kp, kc, 60, [0]);
    // held as last seen relative to the shoulder (frame 19)
    for (let t = 20; t < 30; t++) { expect(out[t][9][0]).toBeCloseTo(180 - 4 * 19, 3); expect(out[t][9][1]).toBeCloseTo(180, 3); }
  });
});
