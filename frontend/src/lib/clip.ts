import type { AnalysisResult, EventKey, PaceRecord } from "../types";
import { EVENTS, EVENT_HEX } from "./constants";

/**
 * Side-by-side clip: the video with its overlay beside the 3D body, played in slow motion with the key moments held,
 * the numbers measured at each moment written under it and the cue at the end. Recorded in the browser
 * (MediaRecorder), so it can go to a coach, a parent or a WhatsApp group without the app.
 */

/** The 3D viewer registers how to draw its current view into a canvas (it renders the same scene at any size). */
export interface Capture3D { draw: (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) => void; end: () => void }
let scene3d: Capture3D | null = null;
export const register3D = (c: Capture3D | null) => { scene3d = c; };
export const capture3D = () => scene3d;

/** The first video format this browser can record (MP4 where it can: phones and WhatsApp play it everywhere). */
export function clipMime(audio: boolean): string | null {
  if (typeof MediaRecorder === "undefined" || typeof HTMLCanvasElement === "undefined" || !("captureStream" in HTMLCanvasElement.prototype)) return null;
  const options = audio
    ? ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]
    : ["video/mp4;codecs=avc1.42E01E", "video/mp4", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
  return options.find((m) => { try { return MediaRecorder.isTypeSupported(m); } catch { return false; } }) ?? null;
}
export const clipExt = (mime: string) => (mime.startsWith("video/mp4") ? "mp4" : "webm");

export interface ClipStep { frame: number; ms: number; hold: EventKey | "end" | null }
const HOLDS: EventKey[] = ["bfc", "ffc", "br"];
const MIN_MS = 1000 / 30;   // the clip runs at up to 30 frames a second; faster footage skips frames

/** The frames to show and for how long: the delivery stride with a lead-in, in slow motion, pausing at back-foot
 * contact, front-foot contact and release, and on the last frame for the cue. */
export function clipPlan(result: AnalysisResult, speed: number, holdMs = 800, endMs = 2200): ClipStep[] {
  const f0 = result.frames.start, last = result.frames.end - 1, times = result.frames.times, fps = result.fps;
  const ev = (k: EventKey) => result.events[k]?.frame ?? null;
  const clampF = (f: number) => Math.max(f0, Math.min(last, f));
  const lo = clampF((ev("bfc") ?? ev("ffc") ?? ev("br") ?? f0) - Math.round(0.5 * fps));
  const hi = clampF((ev("ft") ?? last) + Math.round(0.3 * fps));
  const dt = (f: number) => {
    const i = f - f0;
    return (i + 1 < times.length ? Math.max(1e-4, times[i + 1] - times[i]) : 1 / fps) * 1000 / speed;
  };
  const holds = new Map<number, EventKey>();
  for (const k of HOLDS) { const f = ev(k); if (f !== null && f >= lo && f <= hi) holds.set(f, k); }
  const steps: ClipStep[] = [];
  let f = lo;
  while (f <= hi) {
    let ms = dt(f), g = f + 1;
    while (ms < MIN_MS && g <= hi && !holds.has(g)) { ms += dt(g); g++; }
    steps.push({ frame: f, ms, hold: null });
    if (holds.has(f)) steps.push({ frame: f, ms: holdMs, hold: holds.get(f)! });
    f = g;
  }
  if (steps.length) steps.push({ frame: steps[steps.length - 1].frame, ms: endMs, hold: "end" });
  return steps;
}

export interface ClipLayout { W: number; H: number; video: [number, number, number, number]; three: [number, number, number, number] | null; bar: number }

/** Landscape footage: video 16:9 beside a 3D panel; portrait (4:5) footage: two equal panels. Sizes are even (H.264). */
export function clipLayout(portrait: boolean, with3d: boolean): ClipLayout {
  const bar = 76;
  if (portrait) {
    const w = 560, h = 700;
    return { W: with3d ? 2 * w : w, H: h + bar, video: [0, 0, w, h], three: with3d ? [w, 0, w, h] : null, bar };
  }
  const w = with3d ? 1120 : 1280, h = with3d ? 630 : 720;
  return { W: with3d ? 1600 : w, H: h + bar, video: [0, 0, w, h], three: with3d ? [w, 0, 480, h] : null, bar };
}

const LABEL: Record<string, string> = {
  front_knee_ffc: "Front knee at landing", front_knee_br: "Front knee at release", trunk_forward_br: "Trunk lean at release",
  trunk_lateral_br: "Side-bend at release", release_height_pct: "Release height",
};

/** The measured numbers to write under the clip at this frame: each appears from the moment it is measured at. */
export function clipFacts(result: AnalysisResult, frame: number, pace: PaceRecord | null | undefined): string[] {
  if (result.view.oblique) return pace ? [`Ball speed ≈ ${Math.round(pace.kmh)} km/h`] : [];
  const out: string[] = [];
  const at = (k: EventKey) => { const f = result.events[k]?.frame; return f !== undefined && f !== null && frame >= f; };
  for (const key of ["front_knee_ffc", "front_knee_br", "trunk_forward_br", "trunk_lateral_br", "release_height_pct"]) {
    const m = result.metrics.find((x) => x.key === key);
    if (!m || m.value === null || m.reliability !== "measured" || m.rating === "unrated") continue;
    if (!at(key.endsWith("_ffc") ? "ffc" : "br")) continue;
    out.push(`${LABEL[key]} ${Math.round(m.value)}${m.unit === "deg" ? "°" : "% of height"}`);
  }
  if (pace && at("br")) out.push(`Ball speed ≈ ${Math.round(pace.kmh)} km/h`);
  return out;
}

const relText = (result: AnalysisResult, frame: number) => {
  const br = result.events.br?.frame;
  if (br === undefined || br === null) return "";
  const i = frame - result.frames.start, j = br - result.frames.start, t = result.frames.times;
  if (i < 0 || j < 0 || i >= t.length || j >= t.length) return "";
  const ms = Math.round(((t[i] - t[j]) * 1000) / Math.max(1, result.options.slowmo_factor || 1));
  return ms === 0 ? "release" : `${ms > 0 ? "+" : "−"}${Math.abs(ms)} ms`;
};

/** Draws one frame of the clip: the player's canvas, the 3D panel and the caption bar. */
export function drawClipFrame(ctx: CanvasRenderingContext2D, L: ClipLayout, player: HTMLCanvasElement, step: ClipStep,
  result: AnalysisResult, opts: { title: string; cue: string | null; pace: PaceRecord | null | undefined }) {
  const { W, H, bar } = L;
  ctx.fillStyle = "#0b0b0c";
  ctx.fillRect(0, 0, W, H);
  const [vx, vy, vw, vh] = L.video;
  if (player.width) {
    const s = Math.min(vw / player.width, vh / player.height);
    ctx.drawImage(player, vx + (vw - player.width * s) / 2, vy + (vh - player.height * s) / 2, player.width * s, player.height * s);
  }
  const font = (px: number, w = 600) => `${w} ${px}px Inter, -apple-system, "Segoe UI", sans-serif`;
  if (L.three) {
    const [tx, ty, tw, th] = L.three;
    ctx.save();
    ctx.beginPath(); ctx.rect(tx, ty, tw, th); ctx.clip();
    ctx.fillStyle = "#0e0e10"; ctx.fillRect(tx, ty, tw, th);
    try { scene3d?.draw(ctx, tx, ty, tw, th); } catch { /* the video still records */ }
    ctx.restore();
    ctx.fillStyle = "rgba(255,255,255,0.12)"; ctx.fillRect(tx, ty, 1, th);
    ctx.font = font(15, 500); ctx.fillStyle = "rgba(226,232,240,0.75)"; ctx.textAlign = "left"; ctx.textBaseline = "top";
    ctx.fillText("3D body (estimated from the video)", tx + 14, ty + 12);
  }
  if (opts.title) {
    ctx.font = font(18, 600);
    const tw = ctx.measureText(opts.title).width;
    ctx.fillStyle = "rgba(10,10,11,0.72)"; ctx.fillRect(vx + 12, vy + 12, tw + 20, 32);
    ctx.fillStyle = "#f4f4f5"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.fillText(opts.title, vx + 22, vy + 28);
  }
  // caption bar: the moment (held key frames are named in their colour), the numbers measured so far, the brand
  const by = H - bar;
  ctx.fillStyle = "#111113"; ctx.fillRect(0, by, W, bar);
  ctx.fillStyle = "rgba(255,255,255,0.1)"; ctx.fillRect(0, by, W, 1);
  const cy = by + bar / 2;
  ctx.textBaseline = "middle"; ctx.textAlign = "left";
  let x = 22;
  const held = step.hold && step.hold !== "end" ? step.hold : null;
  const evAt = EVENTS.find((e) => result.events[e.key]?.frame === step.frame && HOLDS.includes(e.key));
  const label = held ? EVENTS.find((e) => e.key === held)!.label : evAt ? evAt.label : relText(result, step.frame);
  if (label) {
    ctx.font = font(22, 700);
    ctx.fillStyle = held ? EVENT_HEX[held] : evAt ? EVENT_HEX[evAt.key] : "#a1a1aa";
    ctx.fillText(label, x, cy);
    x += ctx.measureText(label).width + 28;
  }
  ctx.font = font(18, 500);
  const brand = "Seamly";
  const brandW = (ctx.font = font(16, 600), ctx.measureText(brand).width);
  const room = W - brandW - 44;
  if (step.hold === "end" && opts.cue) {
    ctx.font = font(20, 600); ctx.fillStyle = "#f4f4f5";
    ctx.fillText(fit(ctx, `Next: “${opts.cue}”`, room - x), x, cy);
  } else {
    ctx.font = font(18, 500);
    for (const f of clipFacts(result, step.frame, opts.pace)) {
      const w = ctx.measureText(f).width;
      if (x + w > room) break;
      ctx.fillStyle = "#e4e4e7"; ctx.fillText(f, x, cy);
      x += w + 26;
    }
  }
  ctx.font = font(16, 600); ctx.fillStyle = "#71717a"; ctx.textAlign = "right";
  ctx.fillText(brand, W - 22, cy);
}

function fit(ctx: CanvasRenderingContext2D, text: string, w: number): string {
  if (ctx.measureText(text).width <= w) return text;
  let t = text;
  while (t.length > 4 && ctx.measureText(t + "…").width > w) t = t.slice(0, -1);
  return t.trimEnd() + "…";
}
