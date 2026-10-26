/** Live camera check (lib/framing.ts): judged from one pose on the picture. */
import { describe, expect, it } from "vitest";
import { assess, bodyWidth, mainPerson, ready, steady, type Person } from "../src/lib/framing";

// a standing person `ht` px tall with its feet at y = foot, centred at x; `wide` = seen square on, else side-on
function person(x: number, foot: number, ht: number, wide: boolean, conf = 0.9): Person {
  const u = ht / 8, sh = wide ? 0.8 * u : 0.25 * u, hp = wide ? 0.45 * u : 0.12 * u;
  const y = (k: number) => foot - k * u;
  const kps = [
    [x, y(7.5)], [x - 0.1 * u, y(7.6)], [x + 0.1 * u, y(7.6)], [x - 0.2 * u, y(7.5)], [x + 0.2 * u, y(7.5)],   // face
    [x - sh, y(6.5)], [x + sh, y(6.5)], [x - sh, y(5)], [x + sh, y(5)], [x - sh, y(3.8)], [x + sh, y(3.8)],    // arms
    [x - hp, y(4)], [x + hp, y(4)], [x - hp, y(2)], [x + hp, y(2)], [x - hp, y(0.1)], [x + hp, y(0.1)],         // legs
  ];
  return { box: [x - 1.2 * u, foot - ht, x + 1.2 * u, foot], kps, kcs: kps.map(() => conf), conf };
}
const keyOk = (cs: ReturnType<typeof assess>, k: string) => cs.find((c) => c.key === k)?.ok;

describe("camera check", () => {
  it("passes a side-on bowler at a good distance in landscape", () => {
    const cs = assess(person(640, 600, 260, false), 1280, 720, "side_on", 60, 120);
    expect(cs.filter((c) => c.ok === false)).toEqual([]);
    expect(ready(cs)).toBe(true);
  });
  it("asks to turn the phone, move closer or back, and film square on", () => {
    expect(keyOk(assess(person(360, 1100, 400, false), 720, 1280, "side_on", 30, 120), "orientation")).toBe(false);
    const far = assess(person(640, 600, 90, false), 1280, 720, "side_on", 30, 120);
    expect(keyOk(far, "size")).toBe(false);
    expect(far.find((c) => c.key === "size")!.tip).toMatch(/Move closer/);
    expect(keyOk(assess(person(640, 700, 600, false), 1280, 720, "side_on", 30, 120), "size")).toBe(false);
    const square = assess(person(640, 600, 260, true), 1280, 720, "side_on", 30, 120);
    expect(keyOk(square, "angle")).toBe(false);
    expect(ready(square)).toBe(false);
  });
  it("wants a wide body from behind the stumps, and the whole body in view", () => {
    expect(keyOk(assess(person(640, 650, 400, true), 1280, 720, "behind", 30, 120), "angle")).toBe(true);
    expect(keyOk(assess(person(640, 650, 400, false), 1280, 720, "behind", 30, 120), "angle")).toBe(false);
    const cut = person(640, 650, 400, true);
    cut.kcs[15] = cut.kcs[16] = 0.05;
    const cs = assess(cut, 1280, 720, "behind", 30, 120);
    expect(keyOk(cs, "body")).toBe(false);
    expect(cs.find((c) => c.key === "body")!.tip).toMatch(/feet/);
  });
  it("treats the frame rate as advice and darkness or nobody as blocking", () => {
    const slow = assess(person(640, 600, 260, false), 1280, 720, "side_on", 30, 120);
    expect(keyOk(slow, "fps")).toBeNull();
    expect(ready(slow)).toBe(true);
    expect(ready(assess(person(640, 600, 260, false), 1280, 720, "side_on", 60, 30))).toBe(false);
    expect(ready(assess(null, 1280, 720, "side_on", 60, 120))).toBe(false);
  });
  it("picks the biggest confident person and measures body width", () => {
    const a = person(300, 600, 200, false), b = person(900, 600, 300, false), c = person(600, 700, 600, true, 0.2);
    const p = mainPerson({ boxes: [a.box, b.box, c.box], confs: [0.9, 0.8, 0.2], kps: [a.kps, b.kps, c.kps], kcs: [a.kcs, b.kcs, c.kcs] });
    expect(p!.box).toEqual(b.box);
    // stays on the person it was following, unless someone much bigger comes into view
    const near = person(300, 600, 260, false);   // a little smaller than b
    const det = { boxes: [near.box, b.box], confs: [0.9, 0.9], kps: [near.kps, b.kps], kcs: [near.kcs, b.kcs] };
    expect(mainPerson(det, near.box)!.box).toEqual(near.box);
    // with the picture's width, a person in the middle beats a slightly bigger one at the edge
    const mid = person(640, 600, 250, false), edge = person(1200, 600, 270, false);
    const two = { boxes: [edge.box, mid.box], confs: [0.9, 0.9], kps: [edge.kps, mid.kps], kcs: [edge.kcs, mid.kcs] };
    expect(mainPerson(two, null, 1280)!.box).toEqual(mid.box);
    expect(mainPerson(two)!.box).toEqual(edge.box);
    const big = person(900, 650, 420, false);
    expect(mainPerson({ ...det, boxes: [near.box, big.box], kps: [near.kps, big.kps] }, near.box)!.box).toEqual(big.box);
    expect(bodyWidth(person(0, 600, 260, false))!).toBeLessThan(0.45);
    expect(bodyWidth(person(0, 600, 260, true))!).toBeGreaterThan(0.5);
  });
  it("smooths over missed detections without dropping a failing check", () => {
    const far = assess(person(640, 600, 90, false), 1280, 720, "side_on", 60, 120);   // too far: distance fails
    const missed = assess(null, 1280, 720, "side_on", 60, 120);
    const shown = steady([far, far, missed, far, missed]);
    expect(shown.find((c) => c.key === "person")!.ok).toBe(true);
    expect(shown.find((c) => c.key === "size")!.ok).toBe(false);
    expect(ready(shown)).toBe(false);
    // the bowler mostly gone: the body checks go too
    expect(steady([missed, missed, far]).some((c) => c.key === "size")).toBe(false);
  });
});
