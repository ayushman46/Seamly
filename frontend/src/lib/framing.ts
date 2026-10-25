/**
 * Live camera check: is this camera position going to give a clip Seamly can measure? Judged from one person's pose
 * (the bowler standing at the crease) on the live picture, before anything is filmed. The thresholds follow the filming
 * guide: side-on needs the delivery stride and follow-through across the frame (a phone's main lens 10–15 m from the
 * bowler shows them at about a fifth to a third of the picture's height; the club example, which measures well, is at
 * 0.5–0.7); from behind the stumps the bowler starts close and runs away from the camera.
 */
export type FilmView = "side_on" | "behind";

export interface Person { box: number[]; kps: number[][]; kcs: number[]; conf: number }
export interface Check { key: "person" | "body" | "size" | "angle" | "orientation" | "light" | "fps"; ok: boolean | null; label: string; tip?: string }

// bowler height as a share of the picture height
export const SIZE: Record<FilmView, [number, number]> = { side_on: [0.18, 0.66], behind: [0.25, 0.85] };
const KP_OK = 0.3;

const iou = (a: number[], b: number[]) => {
  const w = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])), h = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const i = w * h, u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - i;
  return u > 0 ? i / u : 0;
};

/**
 * The bowler: the person followed so far (the box overlapping the last one), else the biggest confident box. Staying
 * on the same person stops the check jumping to the non-striker or an umpire for a frame.
 */
export function mainPerson(det: { boxes: number[][]; confs: number[]; kps: number[][][]; kcs: number[][] }, prev?: number[] | null): Person | null {
  let best: Person | null = null, area = 0, overlap = 0.3;
  let kept: Person | null = null;
  det.boxes.forEach((b, i) => {
    if (det.confs[i] < 0.4) return;
    const p = { box: b, kps: det.kps[i], kcs: det.kcs[i], conf: det.confs[i] };
    const a = (b[2] - b[0]) * (b[3] - b[1]);
    if (a > area) { area = a; best = p; }
    if (prev) { const o = iou(b, prev); if (o >= overlap) { overlap = o; kept = p; } }
  });
  // a much bigger person than the one followed is the bowler walking up to the crease: switch to them
  const size = (p: Person | null) => (p ? (p.box[2] - p.box[0]) * (p.box[3] - p.box[1]) : 0);
  return kept && size(best) <= 1.6 * size(kept) ? kept : best;
}

const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const midpoint = (a: number[], b: number[]) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

/**
 * Width of the shoulders and hips against the trunk's length: a body seen side-on is narrow (both ratios small),
 * one seen from behind or in front is wide. Square on, the shoulder keypoints are about 0.2 of the height apart and the
 * trunk is about 0.3 long (~0.65); side-on the ratio drops to 0.15–0.35. Null when the trunk isn't clearly visible.
 */
export function bodyWidth(p: Person): number | null {
  const c = p.kcs, k = p.kps;
  if ([5, 6, 11, 12].some((j) => c[j] < KP_OK)) return null;
  const trunk = dist(midpoint(k[5], k[6]), midpoint(k[11], k[12]));
  if (trunk < 8) return null;
  return Math.max(dist(k[5], k[6]), dist(k[11], k[12]) * 1.35) / trunk;   // hips are narrower than shoulders
}

/** Every check for one picture. `fps` is the camera's frame rate when the browser reports it; `luma` the mean 0–255. */
export function assess(p: Person | null, w: number, h: number, view: FilmView, fps: number | null, luma: number): Check[] {
  const checks: Check[] = [];
  const landscape = w >= h;
  if (view === "side_on") {
    checks.push(landscape
      ? { key: "orientation", ok: true, label: "Phone sideways" }
      : { key: "orientation", ok: false, label: "Phone sideways", tip: "Turn the phone sideways: a side-on clip needs the width for the run-up and follow-through." });
  }
  checks.push(luma >= 55
    ? { key: "light", ok: true, label: "Enough light" }
    : { key: "light", ok: false, label: "Enough light", tip: "It's too dark for sharp frames: face away from the sun's glare but keep the bowler lit, or move to better light." });
  if (!p) {
    checks.push({ key: "person", ok: false, label: "Bowler in the picture", tip: "Stand where the bowler lands the front foot (at the crease), side-on to the camera or facing down the pitch." });
    return checks;
  }
  checks.push({ key: "person", ok: true, label: "Bowler in the picture" });

  const c = p.kcs, [x0, y0, x1, y1] = p.box;
  const head = Math.max(c[0], c[1], c[2], c[3], c[4]) >= KP_OK && y0 > 0.02 * h;
  const feet = c[15] >= KP_OK && c[16] >= KP_OK && y1 < 0.985 * h;
  const sides = x0 > 0.01 * w && x1 < 0.99 * w;
  checks.push(head && feet && sides
    ? { key: "body", ok: true, label: "Whole body in view" }
    : {
      key: "body", ok: false, label: "Whole body in view",
      tip: !feet ? "The feet are cut off: tilt the phone down a little or step back." : !head ? "Leave room above the head: tilt the phone up a little or step back." : "The bowler is at the edge of the picture: centre them.",
    });

  // height from the head to the feet (a raised arm would make the box taller than the bowler)
  const ys = [0, 1, 2, 3, 4, 5, 6, 11, 12, 13, 14, 15, 16].filter((j) => c[j] >= KP_OK).map((j) => p.kps[j][1]);
  const share = (ys.length >= 6 ? Math.max(...ys) - Math.min(...ys) : y1 - y0) / h, [lo, hi] = SIZE[view];
  checks.push(share < lo
    ? { key: "size", ok: false, label: "Distance", tip: `Move closer: the bowler fills ${Math.round(share * 100)}% of the picture's height, and ${Math.round(lo * 100)}–${Math.round(hi * 100)}% measures well.` }
    : share > hi
      ? { key: "size", ok: false, label: "Distance", tip: view === "side_on" ? "Step back: the last strides of the run-up and the follow-through need to fit in the picture too." : "Step back a little: the bowler gets bigger as the run-up comes towards you." }
      : { key: "size", ok: true, label: "Distance" });

  const wr = bodyWidth(p);
  if (wr === null) checks.push({ key: "angle", ok: null, label: "Camera angle", tip: "Can't see the shoulders and hips clearly yet." });
  else if (view === "side_on") {
    checks.push(wr <= 0.45
      ? { key: "angle", ok: true, label: "Camera angle: side-on" }
      : { key: "angle", ok: false, label: "Camera angle: side-on", tip: "The bowler looks square to the camera. Stand side-on as at back-foot contact, or move the camera level with the crease, square to the pitch." });
  } else {
    checks.push(wr >= 0.5
      ? { key: "angle", ok: true, label: "Camera angle: down the pitch" }
      : { key: "angle", ok: false, label: "Camera angle: down the pitch", tip: "The bowler looks side-on. Move the camera in line with the stumps, looking straight down the pitch." });
  }

  if (fps !== null) {
    checks.push(fps >= 50
      ? { key: "fps", ok: true, label: `${Math.round(fps)} fps` }
      : { key: "fps", ok: null, label: `${Math.round(fps)} fps`, tip: view === "behind"
        ? "Fine for the angles. For precise timings and ball speed, film from this spot in the phone's slow-motion mode (120–240 fps), with the batter in the picture."
        : "Fine for the angles. For precise timings, film from this spot in the phone's slow-motion mode (120–240 fps). Ball speed needs a clip from behind the bowler's stumps." });
  }
  return checks;
}

const ORDER: Check["key"][] = ["orientation", "light", "person", "body", "size", "angle", "fps"];

/**
 * Each check by majority over the last few pictures, so a single missed detection doesn't flicker the list. Every
 * check seen in that time counts (a picture where the bowler was missed has no body, distance or angle checks: the
 * earlier ones carry over rather than dropping out); once the bowler is mostly missing, those checks go.
 */
export function steady(history: Check[][]): Check[] {
  const out: Check[] = [];
  for (const key of ORDER) {
    const same = history.map((h) => h.find((x) => x.key === key)).filter((x): x is Check => !!x);
    if (!same.length) continue;
    const c = same[same.length - 1];
    const bad = same.filter((x) => x.ok === false), good = same.filter((x) => x.ok === true);
    if (bad.length > good.length) out.push({ ...c, ok: false, tip: c.ok === false ? c.tip : bad[bad.length - 1].tip });
    else if (good.length > bad.length) out.push({ ...c, ok: true, tip: c.ok === true ? c.tip : undefined });
    else out.push(c);
  }
  const person = out.find((c) => c.key === "person");
  return person && person.ok === true ? out : out.filter((c) => c.key !== "body" && c.key !== "size" && c.key !== "angle");
}

/** Blocking checks all passed (the frame rate is advice only). */
export const ready = (checks: Check[]) => checks.every((c) => c.ok !== false || c.key === "fps") && checks.some((c) => c.key === "person" && c.ok)
  && checks.every((c) => c.key === "fps" || c.ok !== null);
