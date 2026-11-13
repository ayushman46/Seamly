import type { AnalysisResult, EventKey, Metric } from "../types";

/**
 * Bio-mech replay: the delivery as a broadcast-style 3D sequence. The video dissolves into a bone skeleton on a pitch,
 * the action plays in slow motion and stops at back-foot contact, front-foot contact and release with the numbers
 * measured there, the bowling arm leaves a ribbon coloured by its speed, and the camera moves round the bowler.
 * Everything here is plain arithmetic on the analysis (no drawing), so the timeline can be tested and scrubbed.
 */

export type V3 = [number, number, number];

// H36M joints
export const J = { pelvis: 0, rHip: 1, rKnee: 2, rAnkle: 3, lHip: 4, lKnee: 5, lAnkle: 6, spine: 7, thorax: 8, nose: 9, head: 10,
  lShoulder: 11, lElbow: 12, lWrist: 13, rShoulder: 14, rElbow: 15, rWrist: 16 } as const;

export interface Sides { shoulder: number; elbow: number; wrist: number; backHip: number; backKnee: number; backAnkle: number;
  frontHip: number; frontKnee: number; frontAnkle: number; frontShoulder: number }
/** The bowling arm, and the legs by their role: the back leg is on the bowling-arm side. */
export function sides(right: boolean): Sides {
  return right
    ? { shoulder: J.rShoulder, elbow: J.rElbow, wrist: J.rWrist, backHip: J.rHip, backKnee: J.rKnee, backAnkle: J.rAnkle,
      frontHip: J.lHip, frontKnee: J.lKnee, frontAnkle: J.lAnkle, frontShoulder: J.lShoulder }
    : { shoulder: J.lShoulder, elbow: J.lElbow, wrist: J.lWrist, backHip: J.lHip, backKnee: J.lKnee, backAnkle: J.lAnkle,
      frontHip: J.rHip, frontKnee: J.rKnee, frontAnkle: J.rAnkle, frontShoulder: J.rShoulder };
}

// where the front foot lands in the scene: just behind the popping crease (z = -1.22; the bowler runs towards -z),
// beside the stumps. The pitch is drawn for scale: where the foot really landed against the crease isn't measured here.
export const LANDING_Z = -1.0;
export const LANDING_X = 0.62;

/** The body's travel down the pitch. The analysis keeps the pelvis in place (the 3D body is measured relative to it),
 * so the run through the crease is rebuilt from the feet: a planted foot doesn't slide. From back-foot contact to
 * front-foot contact the back foot is held still, from front-foot contact on the front foot is; before the back foot
 * lands the body keeps the speed it has just after, and after the follow-through step it eases to a stop. Returns one
 * (x, z) offset per frame, placed so the front foot lands at the landing spot. */
export function travel(result: AnalysisResult): [number, number][] {
  const P = result.skeleton3d.joints as V3[][], T = P.length, f0 = result.frames.start;
  const s = sides(result.bowling_arm.arm === "right");
  const fps = Math.max(1, result.fps_real || result.fps);
  const at = (k: EventKey) => { const f = result.events[k]?.frame; return f === undefined || f === null ? null : Math.max(0, Math.min(T - 1, f - f0)); };
  const br = at("br") ?? Math.round(T * 0.6);
  const ffc = Math.min(at("ffc") ?? Math.max(0, br - Math.round(0.12 * fps)), br);
  const bfc = Math.min(at("bfc") ?? Math.max(0, ffc - Math.round(0.2 * fps)), ffc);
  const ft = Math.max(at("ft") ?? Math.min(T - 1, br + Math.round(0.25 * fps)), br);
  const maxStep = 10 / fps;   // nobody runs in faster than 10 m/s
  const step: [number, number][] = Array.from({ length: T }, () => [0, 0]);
  const lock = (t: number, j: number) => {
    let dx = -(P[t][j][0] - P[t - 1][j][0]), dz = -(P[t][j][2] - P[t - 1][j][2]);
    const m = Math.hypot(dx, dz);
    if (m > maxStep) { dx *= maxStep / m; dz *= maxStep / m; }
    step[t] = [dx, dz];
  };
  for (let t = bfc + 1; t <= ffc; t++) lock(t, s.backAnkle);
  for (let t = ffc + 1; t <= ft && t < T; t++) lock(t, s.frontAnkle);
  // the run-in: the mean speed of the first steps after back-foot contact (at least a jog, towards the batter)
  let vx = 0, vz = 0, n = 0;
  for (let t = bfc + 1; t <= Math.min(ffc, bfc + Math.max(2, Math.round(0.12 * fps))); t++) { vx += step[t][0]; vz += step[t][1]; n++; }
  if (n) { vx /= n; vz /= n; }
  vz = Math.min(vz, -2.5 / fps);
  for (let t = 1; t <= bfc; t++) step[t] = [vx, vz];
  // after the follow-through step: ease to a stop over about half a second
  let ex = step[Math.min(T - 1, ft)][0], ez = step[Math.min(T - 1, ft)][1];
  const decay = Math.pow(0.5, 1 / Math.max(1, 0.2 * fps));
  for (let t = ft + 1; t < T; t++) { ex *= decay; ez *= decay; step[t] = [ex, ez]; }
  const raw: [number, number][] = [[0, 0]];
  for (let t = 1; t < T; t++) raw.push([raw[t - 1][0] + step[t][0], raw[t - 1][1] + step[t][1]]);
  // a little smoothing where one rule hands over to the next
  const off = raw.map((_, t) => {
    let x = 0, z = 0, w = 0;
    for (let k = -1; k <= 1; k++) { const u = Math.max(0, Math.min(T - 1, t + k)), g = k === 0 ? 2 : 1; x += raw[u][0] * g; z += raw[u][1] * g; w += g; }
    return [x / w, z / w] as [number, number];
  });
  const ax = LANDING_X * (result.bowling_arm.arm === "right" ? -1 : 1) - (P[ffc][s.frontAnkle][0] + off[ffc][0]);
  const az = LANDING_Z - (P[ffc][s.frontAnkle][2] + off[ffc][1]);
  return off.map(([x, z]) => [x + ax, z + az]);
}

/** Every frame's joints in the scene: the analysis' joints moved by the travel. */
export function sceneJoints(result: AnalysisResult): V3[][] {
  const off = travel(result);
  return (result.skeleton3d.joints as V3[][]).map((fr, t) => fr.map((p) => [p[0] + off[t][0], p[1], p[2] + off[t][1]] as V3));
}

/** The joints at a fractional frame (Catmull-Rom through the frames), so slow motion is smooth at any frame rate. */
export function sampleJoints(frames: V3[][], tf: number, out?: V3[]): V3[] {
  const T = frames.length, x = Math.max(0, Math.min(T - 1, tf)), i = Math.min(T - 2, Math.floor(x)), u = T < 2 ? 0 : x - i;
  const res = out ?? frames[0].map(() => [0, 0, 0] as V3);
  if (T < 2) { frames[0].forEach((p, j) => { res[j][0] = p[0]; res[j][1] = p[1]; res[j][2] = p[2]; }); return res; }
  const a = frames[Math.max(0, i - 1)], b = frames[i], c = frames[i + 1], d = frames[Math.min(T - 1, i + 2)];
  const u2 = u * u, u3 = u2 * u;
  for (let j = 0; j < b.length; j++) for (let k = 0; k < 3; k++) {
    res[j][k] = 0.5 * (2 * b[j][k] + (c[j][k] - a[j][k]) * u + (2 * a[j][k] - 5 * b[j][k] + 4 * c[j][k] - d[j][k]) * u2
      + (3 * b[j][k] - a[j][k] - 3 * c[j][k] + d[j][k]) * u3);
  }
  return res;
}

/** How fast the bowling hand moves round the body at each frame (m/s, relative to the pelvis, so the run-in doesn't
 * count), lightly smoothed. */
export function armSpeed(result: AnalysisResult): number[] {
  const P = result.skeleton3d.joints as V3[][], T = P.length, w = sides(result.bowling_arm.arm === "right").wrist;
  const t = result.frames.times, slow = Math.max(1, result.options.slowmo_factor || 1);
  const raw = P.map((_, i) => {
    const a = Math.max(0, i - 1), b = Math.min(T - 1, i + 1);
    const dt = (t[b] - t[a]) / slow;
    if (b === a || !(dt > 0)) return 0;
    const rel = (k: number, c: number) => P[k][w][c] - P[k][0][c];
    return Math.hypot(rel(b, 0) - rel(a, 0), rel(b, 1) - rel(a, 1), rel(b, 2) - rel(a, 2)) / dt;
  });
  return raw.map((_, i) => (raw[Math.max(0, i - 1)] + 2 * raw[i] + raw[Math.min(T - 1, i + 1)]) / 4);
}

/** The ribbon's colour for a speed between 0 (slow) and 1 (this delivery's fastest): blue, cyan, green, yellow, red. */
export function speedColor(u: number): [number, number, number] {
  const stops: [number, [number, number, number]][] = [[0, [0.16, 0.42, 0.95]], [0.3, [0.1, 0.78, 0.86]], [0.55, [0.2, 0.86, 0.36]],
    [0.78, [0.98, 0.84, 0.16]], [1, [0.92, 0.16, 0.14]]];
  const x = Math.max(0, Math.min(1, u));
  for (let i = 1; i < stops.length; i++) {
    if (x <= stops[i][0]) {
      const [x0, a] = stops[i - 1], [x1, b] = stops[i], k = (x - x0) / (x1 - x0);
      return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
    }
  }
  return stops[stops.length - 1][1];
}

export interface Callout {
  key: string;
  title: string;          // what it means ("Front leg firm")
  detail: string;         // the number ("Front knee angle 172°")
  anchor: number[];       // joints whose mean the leader line points at
  graphic: "knee_front" | "knee_back" | "stride" | "height" | "trunk" | "none";
  side: 1 | -1;           // which side of the anchor the box sits on
}

const usable = (m: Metric | undefined): m is Metric => !!m && m.value !== null && m.reliability === "measured" && m.rating !== "unrated";
const deg = (v: number) => `${Math.round(v)}°`;

// what each measurement is called when it reads well, when it's worth watching and when it's a concern
const WORDS: Record<string, { good: string; watch: string; risk: string; info: string; name: string }> = {
  back_knee_bfc: { good: "Back leg stays tall", watch: "Back leg softens", risk: "Back leg collapses", info: "Back leg at landing", name: "Back knee angle" },
  front_knee_ffc: { good: "Front leg lands firm", watch: "Front knee soft at landing", risk: "Front knee bent at landing", info: "Front leg at landing", name: "Front knee angle" },
  front_knee_br: { good: "Braced front leg", watch: "Front knee softens", risk: "Front knee collapses", info: "Front knee at release", name: "Front knee angle" },
  stride_length_pct: { good: "Good stride", watch: "Stride to watch", risk: "Stride to work on", info: "Delivery stride", name: "Stride length" },
  release_height_pct: { good: "Tall release", watch: "Release could be taller", risk: "Low release", info: "Release height", name: "Release height" },
  trunk_forward_br: { good: "Strong forward drive", watch: "Trunk lean to watch", risk: "Trunk lean to work on", info: "Trunk at release", name: "Trunk forward lean" },
  trunk_lateral_br: { good: "Side-bend in the safe range", watch: "Side-bend to watch", risk: "High side-bend", info: "Side-bend at release", name: "Trunk side-bend" },
  hip_shoulder_sep_bfc: { good: "Hips and shoulders in line", watch: "Hips and shoulders apart", risk: "Mixed action", info: "Hip–shoulder separation", name: "Hip–shoulder separation" },
};

/** The callouts shown at one key moment: only what this clip measured (rated, from a camera that sees it). */
export function calloutsAt(result: AnalysisResult, event: "bfc" | "ffc" | "br"): Callout[] {
  const s = sides(result.bowling_arm.arm === "right");
  const m = (key: string) => { const x = result.metrics.find((q) => q.key === key); return usable(x) ? x : null; };
  const userHeight = result.skeleton.height_source === "user", h = result.skeleton.stature_m;
  const pct = (v: number) => (userHeight ? `${(v / 100 * h).toFixed(2)} m (${Math.round(v)}% of height)` : `${Math.round(v)}% of height`);
  const out: Callout[] = [];
  const add = (key: string, detail: (v: number) => string, anchor: number[], graphic: Callout["graphic"], side: 1 | -1) => {
    const x = m(key), w = WORDS[key];
    if (!x || !w) return;
    const title = x.rating === "good" ? w.good : x.rating === "watch" ? w.watch : x.rating === "risk" ? w.risk : w.info;
    out.push({ key, title, detail: `${w.name} ${detail(x.value!)}`, anchor, graphic, side });
  };
  if (event === "bfc") {
    add("back_knee_bfc", deg, [s.backKnee], "knee_back", 1);
    add("hip_shoulder_sep_bfc", deg, [J.spine], "none", -1);
  } else if (event === "ffc") {
    add("front_knee_ffc", deg, [s.frontKnee], "knee_front", 1);
    add("stride_length_pct", pct, [s.frontAnkle, s.backAnkle], "stride", -1);
  } else {
    add("release_height_pct", pct, [s.wrist], "height", 1);
    add("trunk_forward_br", deg, [J.thorax], "trunk", -1);
    add("trunk_lateral_br", deg, [J.thorax], "none", -1);
    add("front_knee_br", deg, [s.frontKnee], "knee_front", 1);
  }
  return out;
}

export interface Shot { az: number; el: number; dist: number; drift: number }   // degrees, degrees, metres, degrees a second
export interface Segment {
  kind: "video" | "play" | "hold";
  dur: number;                 // seconds on screen
  from: number; to: number;    // fractional frames (index into the analysis window) at the start and the end
  title: string;
  callouts: Callout[];
  shot: Shot | null;           // where the camera is (3D segments)
  fade: number;                // video segments: seconds of cross-fade with the 3D scene at the 3D end of the segment
  trail: boolean;              // whether the arm ribbon is shown
}
export interface Script { segments: Segment[]; total: number; br: number; trailFrom: number }

/** The whole replay: video in, the four phases with their stops, two more looks from other angles, video out. */
export function replayScript(result: AnalysisResult): Script {
  const T = result.skeleton3d.joints.length, f0 = result.frames.start;
  const fps = Math.max(1, result.fps_real || result.fps);
  const at = (k: EventKey) => { const f = result.events[k]?.frame; return f === undefined || f === null ? null : Math.max(0, Math.min(T - 1, f - f0)); };
  const br = at("br") ?? Math.round(T * 0.6);
  const ffc = Math.min(at("ffc") ?? br, br), bfc = Math.min(at("bfc") ?? ffc, ffc);
  const start = Math.max(0, bfc - Math.round(0.45 * fps));        // the gather: a little before the back foot lands
  const end = Math.min(T - 1, br + Math.round(0.4 * fps));
  const realS = (a: number, b: number) => Math.max(0, b - a) / fps;
  const right = result.bowling_arm.arm === "right";
  // the camera starts where the video's camera was: beside the pitch for a side-on clip (on the bowler's open side),
  // behind the bowler or in front otherwise
  const open = right ? -1 : 1;
  const base = result.view.view === "side_on" ? 90 * open : result.view.view === "front_on" ? 180 : 0;
  const shot = (az: number, el: number, dist: number, drift = 0): Shot => ({ az, el, dist, drift });
  const slow = (a: number, b: number, rate: number) => Math.max(0.5, realS(a, b) / rate);
  const seg = (s: Partial<Segment> & Pick<Segment, "kind" | "dur" | "from" | "to">): Segment =>
    ({ title: "", callouts: [], shot: null, fade: 0, trail: true, ...s });
  const segments: Segment[] = [];
  // 1. the video, up to the gather (or its first frame, held, when the clip starts there), then it dissolves into 3D
  const lead = Math.max(0, start - Math.round(0.6 * fps));
  segments.push(seg({ kind: "video", dur: Math.min(2.6, Math.max(1.6, realS(lead, start) / 0.5 + 0.7)), from: lead, to: start, fade: 0.7, trail: false }));
  // the camera works round the bowler from behind the action towards the front, never far from the video's own view,
  // so each stop shows the plane its numbers were measured in
  const cam = (off: number, el: number, dist: number, drift = 0) => shot(base + off * open, el, dist, drift * open);
  segments.push(seg({ kind: "hold", dur: 0.8, from: start, to: start, title: "Gather", shot: cam(-38, 11, 5.6, 4) }));
  // 2. into back-foot contact
  if (bfc > start) segments.push(seg({ kind: "play", dur: slow(start, bfc, 0.22), from: start, to: bfc, title: "Gather", shot: cam(-30, 10, 5.3) }));
  const cB = calloutsAt(result, "bfc");
  segments.push(seg({ kind: "hold", dur: cB.length ? 3.0 : 1.3, from: bfc, to: bfc, title: "Back foot contact", callouts: cB, shot: cam(-24, 9, 5.0, 4) }));
  // 3. front-foot contact
  if (ffc > bfc) segments.push(seg({ kind: "play", dur: slow(bfc, ffc, 0.16), from: bfc, to: ffc, title: "Delivery stride", shot: cam(-6, 9, 5.2) }));
  const cF = calloutsAt(result, "ffc");
  segments.push(seg({ kind: "hold", dur: cF.length ? 3.2 : 1.3, from: ffc, to: ffc, title: "Front foot contact", callouts: cF, shot: cam(4, 10, 5.0, 4) }));
  // 4. release
  if (br > ffc) segments.push(seg({ kind: "play", dur: slow(ffc, br, 0.12), from: ffc, to: br, title: "Release", shot: cam(20, 9, 5.4) }));
  const cR = calloutsAt(result, "br");
  segments.push(seg({ kind: "hold", dur: cR.length ? 3.8 : 1.5, from: br, to: br, title: "Release", callouts: cR, shot: cam(28, 9, 5.5, 4) }));
  if (end > br) segments.push(seg({ kind: "play", dur: slow(br, end, 0.3), from: br, to: end, title: "Follow-through", shot: cam(48, 12, 6.0) }));
  // 5. twice more, straight through: from behind the bowler's arm, then from high in front
  for (const [off, el, dist] of [[-95, 15, 6.0], [112, 26, 5.8]] as const) {
    segments.push(seg({ kind: "play", dur: slow(start, end, 0.3), from: start, to: end, title: "Replay", shot: cam(off, el, dist, 8) }));
  }
  // 6. back to the video at release, out through the follow-through
  segments.push(seg({ kind: "video", dur: Math.max(1.2, realS(br, T - 1) / 0.5), from: br, to: T - 1, fade: -0.7, trail: false }));
  return { segments, total: segments.reduce((a, s) => a + s.dur, 0), br, trailFrom: Math.max(0, bfc - Math.round(0.3 * fps)) };
}

const ease = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));

export interface ReplayState {
  index: number; segment: Segment;
  tf: number;                // the fractional frame to show
  u: number;                 // how far through the segment (0–1)
  video: number;             // how much of the picture is the video (1) or the 3D scene (0)
  shot: Shot;                // the camera, already blended from the last segment's
  callout: number;           // the callouts' opacity (0–1)
  title: string;
}

/** What is on screen `time` seconds into the replay. */
export function replayState(script: Script, time: number): ReplayState {
  const t = Math.max(0, Math.min(script.total - 1e-6, time));
  let acc = 0, index = 0;
  for (; index < script.segments.length - 1; index++) { if (t < acc + script.segments[index].dur) break; acc += script.segments[index].dur; }
  const s = script.segments[index], local = t - acc, u = s.dur > 0 ? local / s.dur : 1;
  // motion eases in and out of each stop, so nothing jerks
  const tf = s.from + (s.to - s.from) * (s.kind === "play" ? ease(u) * 0.35 + u * 0.65 : u);
  let video = 0;
  if (s.kind === "video") video = s.fade > 0 ? 1 - ease((local - (s.dur - s.fade)) / s.fade) : s.fade < 0 ? ease(local / -s.fade) : 1;
  // the camera: this segment's shot, turning slowly, reached from where the previous 3D segment's camera ended
  const shots = script.segments.map((x) => x.shot);
  const near = (i: number, dir: 1 | -1) => { for (let k = i; k >= 0 && k < shots.length; k += dir) if (shots[k]) return k; return -1; };
  const cur = s.shot ? index : near(index, s.fade > 0 ? 1 : -1);
  const own = shots[cur] ?? { az: 0, el: 10, dist: 6, drift: 0 };
  const inCur = cur === index ? local : cur > index ? 0 : script.segments[cur].dur;
  let shot: Shot = { ...own, az: own.az + own.drift * inCur };
  const prev = cur === index ? near(index - 1, -1) : -1;
  // a replay starts the action again: the camera cuts to its new place instead of flying there
  const cut = index > 0 && s.kind === "play" && s.from < script.segments[index - 1].to;
  if (prev >= 0 && shots[prev] && !cut) {
    const p = shots[prev]!, pEnd = { ...p, az: p.az + p.drift * script.segments[prev].dur };
    const k = ease(Math.min(1, local / Math.min(1.4, Math.max(0.4, s.dur * 0.6))));
    shot = { az: pEnd.az + (shot.az - pEnd.az) * k, el: pEnd.el + (shot.el - pEnd.el) * k, dist: pEnd.dist + (shot.dist - pEnd.dist) * k, drift: own.drift };
  }
  const callout = s.kind === "hold" && s.callouts.length ? Math.min(ease(local / 0.5), ease((s.dur - local) / 0.35)) : 0;
  return { index, segment: s, tf, u, video, shot, callout, title: s.title };
}
