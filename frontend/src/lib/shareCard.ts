/**
 * A one-image summary of an analysis to send to a coach or parent (WhatsApp, messages): the release frame with the
 * skeleton, the score, the plain-words verdict and the top fixes with their cues. 1080 × 1350 (4:5), drawn on a canvas.
 */
import type { AnalysisMeta, AnalysisResult, Insights } from "../types";
import { COCO_EDGES } from "./constants";
import { AGE_LABEL } from "./player";
import { dateTime } from "./format";

const W = 1080, H = 1350, PAD = 64;
const C = { bg: "#070a12", card: "#111827", line: "#243043", text: "#f1f5f9", muted: "#a5b1c3", faint: "#7c8aa0", accent: "#3ddc97",
  bowl: "#fb7185", front: "#34d399", red: "#e11d48" };
const FONT = "Inter, -apple-system, 'Segoe UI', Roboto, sans-serif";

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => resolve(null);
    im.src = src;
  });
}

/** Draw `text` wrapped to `width`; returns the y below the last line. At most `maxLines` lines (the last ends in "…"). */
function wrap(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, width: number, lh: number, maxLines = 4): number {
  const words = text.split(/\s+/);
  let line = "", n = 0;
  for (let i = 0; i < words.length; i++) {
    const test = line ? `${line} ${words[i]}` : words[i];
    if (ctx.measureText(test).width > width && line) {
      if (++n === maxLines) { ctx.fillText(`${line}…`, x, y); return y + lh; }
      ctx.fillText(line, x, y);
      y += lh;
      line = words[i];
    } else line = test;
  }
  if (line) { ctx.fillText(line, x, y); y += lh; }
  return y;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export async function renderShareCard(meta: AnalysisMeta, r: AnalysisResult, ins: Insights | null, frameUrl: (f: number) => string,
  opts: { hideName?: boolean } = {}): Promise<Blob> {
  try { await document.fonts?.ready; } catch { /* system fonts then */ }
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d")!;
  ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = "alphabetic";

  // brand
  ctx.fillStyle = C.red; ctx.beginPath(); ctx.arc(PAD + 22, 86, 22, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.75)"; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(PAD + 14, 70); ctx.bezierCurveTo(PAD + 34, 80, PAD + 10, 92, PAD + 30, 102); ctx.stroke();
  ctx.fillStyle = C.text; ctx.font = `700 34px ${FONT}`; ctx.fillText("Seamly", PAD + 58, 98);
  ctx.fillStyle = C.faint; ctx.font = `500 24px ${FONT}`; ctx.textAlign = "right";
  ctx.fillText("Bowling action summary", W - PAD, 96); ctx.textAlign = "left";

  // who and what
  // the clip's file name often carries the child's name too, so hiding the name hides both
  const age = ins?.player ? AGE_LABEL[ins.player.age_group] ?? "" : "";
  const who = opts.hideName ? (age ? `A ${age} bowler` : "Bowling delivery") : ins?.player ? `${ins.player.name} · ${age}` : meta.name;
  ctx.fillStyle = C.text; ctx.font = `700 44px ${FONT}`;
  wrap(ctx, who, PAD, 176, W - 2 * PAD, 52, 1);
  ctx.fillStyle = C.muted; ctx.font = `500 24px ${FONT}`;
  const view = r.view.view === "side_on" ? "Side-on" : r.view.view === "behind" ? "From behind" : "Front-on";
  const unsure = r.bowling_arm.source !== "user" && r.bowling_arm.confidence < 0.7;
  ctx.fillText(`${dateTime(meta.created)} · ${view} · ${r.bowling_arm.arm === "right" ? "Right-arm" : "Left-arm"}${unsure ? " (not certain)" : ""} · ${Math.round(r.fps_real)} fps`, PAD, 218);

  // release frame around the bowler, with the skeleton
  const IX = PAD, IY = 250, IW = W - 2 * PAD, IH = 560;
  ctx.save(); roundRect(ctx, IX, IY, IW, IH, 24); ctx.clip();
  ctx.fillStyle = "#03050a"; ctx.fillRect(IX, IY, IW, IH);
  const br = r.events.br?.frame ?? r.frames.start;
  const t = Math.max(0, Math.min(r.frames.end - r.frames.start - 1, br - r.frames.start));
  const im = await loadImage(frameUrl(br));
  const pts = r.keypoints2d.xy[t] ?? [], cf = r.keypoints2d.conf[t] ?? [];
  const VW = r.video.width * r.display_scale, VH = r.video.height * r.display_scale;
  const vis = pts.filter((_, j) => (cf[j] ?? 0) > 0.2);
  let [cx, cy, ch] = [VW / 2, VH / 2, VH];
  if (vis.length) {
    const xs = vis.map((p) => p[0]), ys = vis.map((p) => p[1]);
    cx = (Math.min(...xs) + Math.max(...xs)) / 2; cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    ch = Math.min(VH, Math.max((Math.max(...ys) - Math.min(...ys)) * 1.45, ((Math.max(...xs) - Math.min(...xs)) * 1.3) * IH / IW, VH * 0.3));
  }
  const cw = Math.min(VW, ch * IW / IH);
  ch = cw * IH / IW;
  const x0 = Math.max(0, Math.min(VW - cw, cx - cw / 2)), y0 = Math.max(0, Math.min(VH - ch, cy - ch / 2));
  const s = Math.min(IW / cw, IH / ch);
  const ox = IX + (IW - cw * s) / 2 - x0 * s, oy = IY + (IH - ch * s) / 2 - y0 * s;
  if (im) ctx.drawImage(im, ox, oy, VW * s, VH * s);
  const P = (p: number[]) => [p[0] * s + ox, p[1] * s + oy];
  const bowlRight = r.bowling_arm.arm === "right";
  const BOWL = new Set(bowlRight ? [6, 8, 10, 12, 14, 16] : [5, 7, 9, 11, 13, 15]);
  const FRONT = new Set(bowlRight ? [5, 7, 9, 11, 13, 15] : [6, 8, 10, 12, 14, 16]);
  ctx.lineCap = "round"; ctx.lineWidth = 6;
  for (const [a, b] of COCO_EDGES) {
    if ((cf[a] ?? 0) < 0.2 || (cf[b] ?? 0) < 0.2 || !pts[a] || !pts[b]) continue;
    ctx.strokeStyle = BOWL.has(a) && BOWL.has(b) ? C.bowl : FRONT.has(a) && FRONT.has(b) ? C.front : "rgba(226,232,240,0.85)";
    const [ax, ay] = P(pts[a]), [bx, by] = P(pts[b]);
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
  }
  ctx.restore();
  ctx.fillStyle = "rgba(5,8,13,0.78)"; roundRect(ctx, IX + 20, IY + 20, 178, 46, 23); ctx.fill();
  ctx.fillStyle = C.text; ctx.font = `600 22px ${FONT}`; ctx.fillText("● Ball release", IX + 38, IY + 51);

  // score
  const score = r.coaching.score;
  if (score !== null && score !== undefined) {
    const sx = IX + IW - 92, sy = IY + 92;
    ctx.fillStyle = "rgba(5,8,13,0.82)"; ctx.beginPath(); ctx.arc(sx, sy, 70, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = C.line; ctx.lineWidth = 9; ctx.beginPath(); ctx.arc(sx, sy, 58, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = C.accent; ctx.beginPath(); ctx.arc(sx, sy, 58, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * score) / 100); ctx.stroke();
    ctx.fillStyle = C.text; ctx.textAlign = "center"; ctx.font = `800 46px ${FONT}`; ctx.fillText(String(score), sx, sy + 12);
    ctx.fillStyle = C.muted; ctx.font = `700 15px ${FONT}`; ctx.fillText((r.coaching.grade ?? "").toUpperCase(), sx, sy + 36);
    ctx.textAlign = "left";
  }

  // verdict and the top fixes
  let y = IY + IH + 66;
  ctx.fillStyle = C.text; ctx.font = `700 36px ${FONT}`;
  y = wrap(ctx, ins?.summary.headline ?? (r.coaching.priorities[0]?.headline ?? "Analysis complete."), PAD, y, W - 2 * PAD, 46, 2) + 12;
  const fixes = (ins?.summary.fixes ?? []).slice(0, 2);
  for (const [i, f] of fixes.entries()) {
    ctx.fillStyle = C.accent; ctx.beginPath(); ctx.arc(PAD + 18, y - 10, 18, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = C.bg; ctx.font = `800 20px ${FONT}`; ctx.textAlign = "center"; ctx.fillText(String(i + 1), PAD + 18, y - 3); ctx.textAlign = "left";
    ctx.fillStyle = C.text; ctx.font = `700 28px ${FONT}`;
    y = wrap(ctx, f.title, PAD + 52, y, W - 2 * PAD - 52, 36, 1);
    ctx.fillStyle = C.muted; ctx.font = `italic 500 24px ${FONT}`;
    y = wrap(ctx, `“${f.cue}”`, PAD + 52, y + 2, W - 2 * PAD - 52, 32, 2) + 18;
  }
  if (!fixes.length && r.coaching.strengths.length) {
    ctx.fillStyle = C.muted; ctx.font = `500 26px ${FONT}`;
    y = wrap(ctx, `Working well: ${r.coaching.strengths.slice(0, 2).join("; ")}.`, PAD, y, W - 2 * PAD, 34, 2);
  }

  // footer
  ctx.strokeStyle = C.line; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(PAD, H - 92); ctx.lineTo(W - PAD, H - 92); ctx.stroke();
  ctx.fillStyle = C.muted; ctx.font = `600 24px ${FONT}`; ctx.fillText(`Free analysis at ${location.host}`, PAD, H - 50);
  ctx.fillStyle = C.faint; ctx.font = `500 18px ${FONT}`; ctx.textAlign = "right";
  ctx.fillText("Estimates from one video · not a medical test", W - PAD, H - 50); ctx.textAlign = "left";

  return await new Promise<Blob>((resolve, reject) => cv.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't create the image."))), "image/png"));
}
