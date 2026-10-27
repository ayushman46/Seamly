/** Two cameras, one ball (lib/twoview.ts): real-time alignment, the same-ball check and which camera each number is from. */
import { describe, expect, it } from "vitest";
import { alignFrame, cameraOf, fuseMetrics, sameBall, sharedContacts, sinceRelease, syncOffset, twoView } from "../src/lib/twoview";
import type { AnalysisResult, Metric } from "../src/types";

const ev = (frame: number, method = "detected") => ({ frame, time: 0, confidence: 0.9, method });
const metric = (key: string, value: number, rating: string, needs: string[] | null, extra: Partial<Metric> = {}): Metric => ({
  key, label: key, value, unit: key.endsWith("_ms") ? "ms" : "deg", event: "br", source: "2d", confidence: 0.8, rating,
  reliability: rating === "unrated" ? "estimate" : "measured", note: null, needs_view: needs, norm: null, ref: null, explain: "", ...extra,
}) as Metric;

/** A clip at `fps` (a slow-motion factor plays it back slower) whose events are given in real seconds from the start. */
function clip(view: string, fps: number, ev_s: Record<string, number>, metrics: Metric[] = [], opts: { slowmo?: number; arm?: string; oblique?: boolean; methods?: Record<string, string> } = {}) {
  const slow = opts.slowmo ?? 1, n = Math.round(2.0 * fps * slow);
  const times = Array.from({ length: n }, (_, i) => i / fps);   // the file's own clock
  const f = (s: number) => Math.round(s * fps * slow);
  return {
    view: { view, oblique: !!opts.oblique }, fps: fps, fps_real: fps * slow, options: { slowmo_factor: slow },
    frames: { start: 0, end: n, times }, quality: { repeated_frames: 0 }, bowling_arm: { arm: opts.arm ?? "right" },
    events: Object.fromEntries(["bfc", "ffc", "uah", "br", "ft"].map((k) => [k, ev_s[k] !== undefined ? ev(f(ev_s[k]), opts.methods?.[k]) : null])),
    metrics,
  } as unknown as AnalysisResult;
}
const BALL = { bfc: 0.8, ffc: 1.0, br: 1.1, ft: 1.3 };

describe("lining two clips up", () => {
  it("measures real time from each clip's own release, slow motion divided out", () => {
    const a = clip("side_on", 240, BALL);
    const b = clip("behind", 30, BALL, [], { slowmo: 4 });   // 120 fps footage played at 30
    expect(sinceRelease(a, a.events.ffc!.frame)).toBeCloseTo(-0.1, 2);
    expect(sinceRelease(b, b.events.ffc!.frame)).toBeCloseTo(-0.1, 2);
  });
  it("finds the frame of the other camera at the same moment, at any frame rates", () => {
    const a = clip("side_on", 240, BALL), b = clip("behind", 60, BALL);
    expect(alignFrame(a, a.events.br!.frame, b)).toEqual({ frame: b.events.br!.frame, inside: true });
    expect(alignFrame(a, a.events.ffc!.frame, b).frame).toBe(b.events.ffc!.frame);
    // 0.05 s after release at 240 fps = 12 frames; at 60 fps = 3 frames
    expect(alignFrame(a, a.events.br!.frame + 12, b).frame).toBe(b.events.br!.frame + 3);
    // beyond the other clip: its last frame, flagged
    const short = { ...b, frames: { ...b.frames, end: b.events.br!.frame + 2 } } as AnalysisResult;
    expect(alignFrame(a, a.events.br!.frame + 60, short)).toEqual({ frame: b.events.br!.frame + 1, inside: false });
  });
});

describe("same ball?", () => {
  it("agrees when the arm and the stride timings match within a frame of each clip", () => {
    const s = sameBall(clip("side_on", 60, BALL), clip("behind", 30, BALL));
    expect(s.verdict).toBe("match");
    expect(s.checks.map((c) => c.label)).toEqual(["Bowling arm", "Back-foot to front-foot contact", "Front-foot contact to release"]);
  });
  it("flags a different bowling arm or a stride far out of time", () => {
    expect(sameBall(clip("side_on", 60, BALL), clip("behind", 60, BALL, [], { arm: "left" })).verdict).toBe("mismatch");
    expect(sameBall(clip("side_on", 60, BALL), clip("behind", 60, { ...BALL, bfc: 0.6 })).verdict).toBe("mismatch");
  });
  it("is unsure when the contacts were only estimated (nothing to compare but the arm)", () => {
    const r = clip("behind", 60, BALL, [], { methods: { bfc: "timing_prior", ffc: "timing_prior" } });
    const s = sameBall(clip("side_on", 60, BALL), r);
    expect(s.verdict).toBe("unsure");
    expect(s.checks).toHaveLength(1);
  });
});

describe("each number from the camera that sees it", () => {
  const SIDE = ["side_on"], REAR = ["behind", "front_on"], SQUARE = ["side_on", "behind", "front_on"];
  const side = clip("side_on", 60, BALL, [
    metric("front_knee_br", 165, "good", SIDE), metric("trunk_lateral_br", 30, "unrated", REAR),
    metric("release_height_pct", 108, "good", SQUARE, { confidence: 0.6 }), metric("ffc_to_br_ms", 100, "good", null),
    metric("back_knee_bfc", 150, "watch", SIDE),
  ]);
  const rear = clip("behind", 120, BALL, [
    metric("front_knee_br", 120, "unrated", SIDE), metric("trunk_lateral_br", 38, "watch", REAR),
    metric("release_height_pct", 104, "watch", SQUARE, { confidence: 0.75 }), metric("ffc_to_br_ms", 108, "good", null),
    metric("hip_shoulder_sep_bfc", 12, "good", REAR),
  ]);
  it("takes knees from side-on, side-bend from behind, and keeps the other reading of shared ones", () => {
    const rows = fuseMetrics(side, rear);
    const by = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(by.front_knee_br.from).toBe("side");
    expect(by.front_knee_br.other).toBeNull();
    expect(by.trunk_lateral_br.from).toBe("rear");
    expect(by.trunk_lateral_br.metric.value).toBe(38);
    // both cameras measure release height and agree: weighted by each camera's measured error (7.4 side-on, 5.4 behind)
    expect(by.release_height_pct.from).toBe("both");
    const ws = 1 / 7.4 ** 2, wr = 1 / 5.4 ** 2;
    expect(by.release_height_pct.metric.value).toBeCloseTo((108 * ws + 104 * wr) / (ws + wr), 1);
    expect(by.release_height_pct.other?.value).toBe(108);
    expect(by.ffc_to_br_ms.from).toBe("rear");                // timings from the faster camera
    expect(by.hip_shoulder_sep_bfc.from).toBe("rear");
  });
  it("never uses an angled clip", () => {
    const angled = { ...rear, view: { ...rear.view, oblique: true } } as AnalysisResult;
    expect(fuseMetrics(side, angled).every((r) => r.from === "side")).toBe(true);
    expect(cameraOf(angled)).toBeNull();
    expect(cameraOf(side)).toBe("side");
    expect(cameraOf(rear)).toBe("rear");
  });
  it("makes all three back-health checks, each on its own camera", () => {
    const tv = twoView(side, rear, { age_group: "u17", style: "fast" });
    expect(tv.back?.measured).toBe(3);
    expect(tv.back?.checks.map((c) => c.status)).toEqual(["watch", "ok", "watch"]);
    expect(tv.backFrom).toEqual({ side_bend: "rear", mixed_action: "rear", back_knee: "side" });
    expect(tv.summary.unlock).toEqual(["Use slow motion (120–240 fps) on both phones to time release and foot contacts precisely."]);
  });
});

describe("shared readings and contacts", () => {
  const SQUARE = ["side_on", "behind", "front_on"];
  it("keeps the more confident reading when two cameras disagree beyond their precision", () => {
    const a = clip("side_on", 60, BALL, [metric("release_height_pct", 120, "good", SQUARE, { unit: "% height", confidence: 0.5 })]);
    const b = clip("behind", 60, BALL, [metric("release_height_pct", 100, "watch", SQUARE, { unit: "% height", confidence: 0.7 })]);
    const [row] = fuseMetrics(a, b);
    expect(row.from).toBe("rear");
    expect(row.metric.value).toBe(100);
    expect(row.other?.value).toBe(120);
  });
  it("when release heights disagree, uses the camera behind (it measures release height better)", () => {
    const a = clip("side_on", 60, BALL, [metric("release_height_pct", 130, "good", SQUARE, { unit: "% height", confidence: 0.9 })]);
    const b = clip("behind", 60, BALL, [metric("release_height_pct", 106, "watch", SQUARE, { unit: "% height", confidence: 0.6 })]);
    const [row] = fuseMetrics(a, b);
    expect([row.from, row.metric.value, row.other?.value]).toEqual(["rear", 106, 130]);
  });
  it("carries a contact one camera saw to the clip that only estimated it, at the same real time", () => {
    const side = clip("side_on", 240, BALL, [], { methods: { bfc: "timing_prior" } });
    const rear = clip("behind", 60, BALL, [], { methods: { ffc: "timing_prior" } });
    const c = sharedContacts(side, rear);
    expect(c.from).toEqual({ bfc: "rear", ffc: "side" });
    expect(c.side).toEqual({ bfc: side.events.bfc!.frame });   // the rear camera's back-foot contact, at 240 fps
    expect(c.rear).toEqual({ ffc: rear.events.ffc!.frame });
    // a contact the user set is theirs
    const set = clip("behind", 60, BALL, [], { methods: { ffc: "user" } });
    expect(sharedContacts(side, set).rear).toEqual({});
  });
  it("never carries a contact that would break the delivery's order", () => {
    const side = clip("side_on", 60, BALL);
    // the rear clip's own back-foot contact comes after the front-foot contact the side camera saw
    const rear = clip("behind", 60, { ...BALL, bfc: 1.05 }, [], { methods: { ffc: "timing_prior" } });
    expect(sharedContacts(side, rear).rear).toEqual({});
  });
});

describe("review cases", () => {
  it("never calls two balls the same on the arm's last phase alone", () => {
    const a = clip("side_on", 30, { ...BALL, uah: 1.03 }, [], { methods: { bfc: "timing_prior", ffc: "timing_prior" } });
    const b = clip("behind", 30, { ...BALL, uah: 1.03 }, [], { methods: { bfc: "timing_prior", ffc: "timing_prior" } });
    expect(sameBall(a, b).verdict).toBe("unsure");
    // ... but a very different last phase is a mismatch
    const c = clip("behind", 30, { ...BALL, uah: 0.85 }, [], { methods: { bfc: "timing_prior", ffc: "timing_prior" } });
    expect(sameBall(a, c).verdict).toBe("mismatch");
  });
  it("is unsure, not a match, when a stride timing is more than a frame of each clip apart but not far", () => {
    // 60 fps each: the limit is 2 frames + 5 ms = 38 ms; 50 ms apart
    expect(sameBall(clip("side_on", 60, BALL), clip("behind", 60, { ...BALL, bfc: 0.75 })).verdict).toBe("unsure");
  });
  it("treats a moment more than half a frame outside the other clip as outside", () => {
    const a = clip("side_on", 60, BALL), b = clip("behind", 60, BALL);
    const short = { ...b, frames: { ...b.frames, end: b.events.br!.frame + 1 } } as AnalysisResult;   // ends at release
    expect(alignFrame(a, a.events.br!.frame + 1, short).inside).toBe(false);
    expect(alignFrame(a, a.events.br!.frame, short).inside).toBe(true);
  });
  it("drops only the carried contact that breaks the order, and only against contacts that stay fixed", () => {
    // the rear clip estimated its back-foot contact after the front-foot contact the side camera saw: estimated, so it
    // moves, and the front-foot contact is still carried
    const side = clip("side_on", 60, BALL);
    const rear = clip("behind", 60, { ...BALL, bfc: 1.02 }, [], { methods: { bfc: "timing_prior", ffc: "timing_prior" } });
    expect(sharedContacts(side, rear).rear).toEqual({ bfc: rear.events.br!.frame - 18, ffc: rear.events.br!.frame - 6 });
  });
});

describe("lining up by the movement", () => {
  // one delivery's motion in real time: the bowling wrist swings up to release (t = 1.1 s), the feet land in turn
  const wristUp = (t: number) => 1.6 * Math.exp(-((t - 1.1) ** 2) / 0.02) - 0.4;
  const backFoot = (t: number) => (t < 0.8 ? 0.4 * Math.max(0, Math.sin((t - 0.5) * 10)) : 0) - 2.2;
  const frontFoot = (t: number) => (t > 0.8 && t < 1.0 ? 0.5 * Math.sin((t - 0.8) * 15) : 0) - 2.2;
  function moving(view: string, fps: number, releaseAt: number) {
    const n = Math.round(2 * fps), torso = 200, hip = 500;
    const xy: [number, number][][] = [], conf: number[][] = [];
    for (let i = 0; i < n; i++) {
      const t = i / fps;
      const p: [number, number][] = Array.from({ length: 17 }, () => [300, 300] as [number, number]);
      p[5] = [290, hip - torso]; p[6] = [310, hip - torso]; p[11] = [295, hip]; p[12] = [305, hip];
      p[10] = [320, hip - torso * wristUp(t)]; p[9] = [280, hip - torso * (-0.3)];
      p[15] = [290, hip - torso * backFoot(t)]; p[16] = [310, hip - torso * frontFoot(t)];
      xy.push(p); conf.push(Array(17).fill(0.9));
    }
    const r = clip(view, fps, { ...BALL, br: releaseAt });
    return { ...r, keypoints2d: { names: [], xy, conf } } as AnalysisResult;
  }
  it("finds how far apart two cameras put the same release, from the motion", () => {
    // the rear camera found its release 3 frames early at 60 fps: its timeline runs 50 ms later
    const s = syncOffset(moving("side_on", 120, 1.1), moving("behind", 60, 1.05));
    expect(s.method).toBe("motion");
    expect(s.offset).toBeCloseTo(0.05, 2);
    // both found the true release: nothing to correct
    expect(syncOffset(moving("side_on", 120, 1.1), moving("behind", 60, 1.1)).offset).toBeCloseTo(0, 2);
  });
  it("keeps the releases when there's no motion to match", () => {
    expect(syncOffset(clip("side_on", 60, BALL), clip("behind", 60, BALL))).toEqual({ offset: 0, score: 0, method: "release" });
  });
});
