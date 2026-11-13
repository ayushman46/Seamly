import type { AnalysisResult } from "../types";

/**
 * Checks an analyst would make before trusting an analysis: was a whole delivery found, and is the body being
 * followed really bowling? Broadcast footage is where these fail (a short shot that starts at release; a batter's
 * swing taken for a bowling arm), and a wrong analysis read with confidence is worse than none.
 */

export interface Concern {
  level: "block" | "warn";   // block: the numbers can't be trusted at all; warn: check before relying on them
  key: "too_short" | "hand_below_head" | "hand_low" | "release_height";
  text: string;
}

export function concerns(result: AnalysisResult): Concern[] {
  const out: Concern[] = [];
  const f0 = result.frames.start, T = result.frames.end - f0, fps = Math.max(1, result.fps_real || result.fps);
  const br = result.events.br?.frame ?? null, bfc = result.events.bfc?.frame ?? null;
  // 1. a delivery stride is about 0.3 s from back-foot contact to release; a window with almost nothing before release
  // (or the key moments on top of each other) is not an analysis of a delivery
  const lead = br === null ? 0 : (br - (bfc ?? f0)) / fps;
  if (T < Math.max(6, 0.3 * fps) || br === null || lead < 0.1) {
    out.push({ level: "block", key: "too_short", text: `Only ${T} frame${T === 1 ? "" : "s"} of the delivery were found, with the key moments on top of each other, so these numbers can't be trusted. Use a clip that shows the bowler from the last strides of the run-up to the follow-through in one shot.` });
    return out;
  }
  // 2. an overarm release has the hand well above the shoulders (a torso length or more on every real delivery
  // tested; even a round-arm slinger's is at shoulder height). A hand at chest height that is also a low "release
  // height" is a batter's swing or a fielder's throw, not a delivery.
  const kp = result.keypoints2d?.xy, kc = result.keypoints2d?.conf, t = br - f0;
  const rh = result.metrics.find((m) => m.key === "release_height_pct");
  if (kp && kc && t >= 0 && t < kp.length) {
    const w = result.bowling_arm.arm === "right" ? 10 : 9;
    let up = -Infinity;
    for (const i of [t - 1, t]) {
      if (i < 0 || Math.min(kc[i][w], kc[i][5], kc[i][6], kc[i][11], kc[i][12]) < 0.2) continue;
      const sy = (kp[i][5][1] + kp[i][6][1]) / 2, torso = Math.hypot((kp[i][5][0] + kp[i][6][0] - kp[i][11][0] - kp[i][12][0]) / 2, sy - (kp[i][11][1] + kp[i][12][1]) / 2);
      if (torso > 1) up = Math.max(up, (sy - kp[i][w][1]) / torso);   // the wrist above the shoulders, in torso lengths (the picture's y runs down)
    }
    const lowRelease = !!rh && rh.value !== null && rh.value < 80;
    if (up > -Infinity && up < 0.3 && lowRelease) out.push({ level: "block", key: "hand_below_head", text: "At the moment taken as release the hand is at chest height, which isn't a bowling release: Seamly has probably followed someone else (a batter's swing, a fielder). Pick the bowler under Detection & settings, or use a clip where the bowler is the clearest moving person." });
    else if (up > -Infinity && up < 0.55) out.push({ level: "warn", key: "hand_low", text: "At the moment taken as release the hand is barely above the shoulders. Unless this is a very round-arm action, check the skeleton is on the bowler and the release frame is right." });
  }
  // 3. a release far outside what bowlers do
  if (rh && rh.value !== null && rh.reliability === "measured" && (rh.value < 80 || rh.value > 118) && !out.some((c) => c.level === "block")) {
    out.push({ level: "warn", key: "release_height", text: `A release height of ${Math.round(rh.value)}% of the bowler's height is outside what bowlers do (about 85–115%): check the release frame, the bowler's height and that the feet are in the picture.` });
  }
  return out;
}
