import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { AnalysisResult } from "../types";
import { COCO_EDGES } from "../lib/constants";

interface Props {
  id: string;
  result: AnalysisResult;
  frame: number;
  overlay: { skeleton: boolean; angles: boolean; trail: boolean };
  selMetric: string | null;
  hud: string;
}

type Pt = [number, number];
const angleAt = (a: Pt, b: Pt, c: Pt) => {
  const v1 = [a[0] - b[0], a[1] - b[1]], v2 = [c[0] - b[0], c[1] - b[1]];
  const d = (v1[0] * v2[0] + v1[1] * v2[1]) / (Math.hypot(v1[0], v1[1]) * Math.hypot(v2[0], v2[1]) + 1e-9);
  return (Math.acos(Math.max(-1, Math.min(1, d))) * 180) / Math.PI;
};

export default function FramePlayer({ id, result, frame, overlay, selMetric, hud }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const imgs = useRef<Map<number, HTMLImageElement>>(new Map());
  const [loaded, setLoaded] = useState(0);
  const [zoom, setZoom] = useState<boolean | null>(null);
  const f0 = result.frames.start, f1 = result.frames.end, n = f1 - f0;
  const kp = result.keypoints2d.xy, kc = result.keypoints2d.conf;
  const right = result.bowling_arm.arm === "right";
  // bowling-side COCO indices
  const B = right ? { sh: 6, el: 8, wr: 10, hip: 12, kn: 14, an: 16 } : { sh: 5, el: 7, wr: 9, hip: 11, kn: 13, an: 15 };
  const F = right ? { sh: 5, el: 7, wr: 9, hip: 11, kn: 13, an: 15 } : { sh: 6, el: 8, wr: 10, hip: 12, kn: 14, an: 16 };

  // preload all frames (they are small JPEGs) so scrubbing and playback are instant. Only a new analysis
  // window reloads them; edits (recompute) keep the same frames.
  const brRef = useRef(result.events.br?.frame ?? f0);
  brRef.current = result.events.br?.frame ?? f0;
  useEffect(() => {
    let cancelled = false;
    const map = imgs.current;
    map.clear();
    setLoaded(0);
    const order: number[] = [];
    const br = brRef.current;
    for (let d = 0; d < n; d++) {
      for (const f of [br + d, br - d - 1]) if (f >= f0 && f < f1 && !order.includes(f)) order.push(f);
    }
    let count = 0;
    let idx = 0;
    const next = () => {
      if (cancelled || idx >= order.length) return;
      const f = order[idx++];
      const im = new Image();
      im.onload = im.onerror = () => {
        if (cancelled) return;
        map.set(f, im);
        count++;
        if (count % 6 === 0 || count === order.length) setLoaded(count);
        next();
      };
      im.src = api.frameUrl(id, f);
    };
    for (let k = 0; k < 6; k++) next();
    return () => { cancelled = true; };
  }, [id, f0, f1, n]);

  // smoothed bowler crop window for auto-zoom (broadcast footage: bowler is small)
  const crops = useMemo(() => {
    const out: [number, number, number, number][] = [];
    const W = result.video.width * result.display_scale, H = result.video.height * result.display_scale;
    let prev: [number, number, number, number] | null = null;
    for (let t = 0; t < n; t++) {
      const pts = kp[t].filter((_, j) => kc[t][j] > 0.15);
      if (!pts.length) { out.push(prev ?? [0, 0, W, H]); continue; }
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
      const h = Math.max(Math.max(...ys) - Math.min(...ys), (Math.max(...xs) - Math.min(...xs)) * 9 / 16) * 1.9;
      const hh = Math.min(H, Math.max(h, H * 0.28)), ww = Math.min(W, hh * (W / H));
      let c: [number, number, number, number] = [cx - ww / 2, cy - hh / 2, ww, hh];
      if (prev) c = c.map((v, k) => prev![k] * 0.75 + v * 0.25) as typeof c;
      c[0] = Math.max(0, Math.min(W - c[2], c[0])); c[1] = Math.max(0, Math.min(H - c[3], c[1]));
      out.push(c);
      prev = c;
    }
    // backward pass to remove lag
    for (let t = n - 2; t >= 0; t--) out[t] = out[t].map((v, k) => v * 0.5 + out[t + 1][k] * 0.5) as typeof out[number];
    return out;
  }, [kp, kc, n, result.video, result.display_scale]);

  const autoZoom = useMemo(() => {
    const H = result.video.height * result.display_scale;
    const br = (result.events.br?.frame ?? f0) - f0;
    const pts = kp[Math.max(0, Math.min(n - 1, br))];
    const ys = pts.map((p) => p[1]);
    return (Math.max(...ys) - Math.min(...ys)) / H < 0.45;
  }, [kp, n, f0, result]);
  const zoomOn = zoom ?? autoZoom;

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const ctx = c.getContext("2d")!;
    const t = Math.max(0, Math.min(n - 1, frame - f0));
    let im = imgs.current.get(frame);
    if (!im) {
      // nearest loaded frame while preloading
      for (let d = 1; d < n && !im; d++) im = imgs.current.get(frame - d) || imgs.current.get(frame + d);
    }
    const W = result.video.width * result.display_scale, H = result.video.height * result.display_scale;
    const crop = zoomOn ? crops[t] : [0, 0, W, H];
    const cw = 1280, ch = 720;
    if (c.width !== cw) { c.width = cw; c.height = ch; }
    ctx.fillStyle = "#03050a";
    ctx.fillRect(0, 0, cw, ch);
    const s = Math.min(cw / crop[2], ch / crop[3]);
    const ox = (cw - crop[2] * s) / 2 - crop[0] * s, oy = (ch - crop[3] * s) / 2 - crop[1] * s;
    if (im && im.complete && im.naturalWidth) ctx.drawImage(im, ox, oy, W * s, H * s);
    const P = (p: Pt): Pt => [p[0] * s + ox, p[1] * s + oy];
    const pts = kp[t].map((p) => P(p as Pt));
    const cf = kc[t];
    // keep overlay text/lines readable whatever size the canvas is displayed at
    const ui = Math.max(1, Math.min(3, (cw / Math.max(200, c.clientWidth || cw)) * 0.8));
    const lw = Math.max(2, Math.min(5, s * 2.2)) * Math.min(ui, 1.8);
    const font = (px: number, w = 600) => `${w} ${Math.round(px * ui)}px -apple-system, Inter, sans-serif`;

    if (overlay.trail) {
      const span = Math.round(result.fps * 0.45);
      for (let k = Math.max(0, t - span); k < t; k++) {
        if (kc[k][B.wr] < 0.2 || kc[k + 1][B.wr] < 0.2) continue;
        const a = P(kp[k][B.wr] as Pt), b = P(kp[k + 1][B.wr] as Pt);
        ctx.strokeStyle = `rgba(244,63,94,${0.15 + 0.75 * ((k - (t - span)) / span)})`;
        ctx.lineWidth = lw * 1.2;
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      }
    }
    if (overlay.skeleton) {
      ctx.lineCap = "round";
      for (const [a, b] of COCO_EDGES) {
        const c0 = Math.min(cf[a], cf[b]);
        if (c0 < 0.1) continue;
        const bowling = [B.sh, B.el, B.wr, B.hip, B.kn, B.an].includes(a) && [B.sh, B.el, B.wr, B.hip, B.kn, B.an].includes(b);
        const front = [F.sh, F.el, F.wr, F.hip, F.kn, F.an].includes(a) && [F.sh, F.el, F.wr, F.hip, F.kn, F.an].includes(b);
        ctx.strokeStyle = bowling ? "rgba(251,113,133,A)" : front ? "rgba(52,211,153,A)" : "rgba(226,232,240,A)";
        ctx.strokeStyle = ctx.strokeStyle.replace("A", String(0.35 + 0.6 * Math.min(1, c0)));
        ctx.lineWidth = lw;
        ctx.beginPath(); ctx.moveTo(pts[a][0], pts[a][1]); ctx.lineTo(pts[b][0], pts[b][1]); ctx.stroke();
      }
      for (let j = 5; j < 17; j++) {
        if (cf[j] < 0.1) continue;
        ctx.fillStyle = cf[j] > 0.5 ? "#fff" : "rgba(255,255,255,0.5)";
        ctx.beginPath(); ctx.arc(pts[j][0], pts[j][1], lw * 0.9, 0, Math.PI * 2); ctx.fill();
      }
    }
    if (overlay.angles) {
      const placed: [number, number, number, number][] = [];
      const place = (x: number, y: number, w: number, h: number): [number, number] => {
        // nudge labels vertically until they don't overlap earlier ones
        let yy = y;
        for (let k = 0; k < 8; k++) {
          const hit = placed.find((r) => x < r[0] + r[2] && x + w > r[0] && yy < r[1] + r[3] && yy + h > r[1]);
          if (!hit) break;
          yy = hit[1] + hit[3] + 3;
        }
        placed.push([x, yy, w, h]);
        return [x, yy];
      };
      // bend = show the flexion (0 = straight), as the elbow metrics do; knees keep the included angle (180 = straight)
      const arc = (a: number, b: number, c: number, col: string, label: string, want: boolean, bend = false) => {
        if (!want || Math.min(cf[a], cf[b], cf[c]) < 0.2) return;
        const A = pts[a], Bp = pts[b], Cc = pts[c];
        const ang = angleAt(A, Bp, Cc);
        const a1 = Math.atan2(A[1] - Bp[1], A[0] - Bp[0]), a2 = Math.atan2(Cc[1] - Bp[1], Cc[0] - Bp[0]);
        let d = a2 - a1; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
        const r = Math.max(14, Math.min(46, Math.hypot(A[0] - Bp[0], A[1] - Bp[1]) * 0.35)) * Math.min(ui, 1.5);
        ctx.strokeStyle = col; ctx.lineWidth = lw * 0.8;
        ctx.beginPath(); ctx.arc(Bp[0], Bp[1], r, a1, a1 + d, d < 0); ctx.stroke();
        const mid = a1 + d / 2;
        const tx = Bp[0] + Math.cos(mid) * (r + 18 * ui), ty = Bp[1] + Math.sin(mid) * (r + 18 * ui);
        const text = `${label} ${(bend ? 180 - ang : ang).toFixed(0)}°`;
        ctx.font = font(15);
        const tw = ctx.measureText(text).width;
        const bh = 22 * ui;
        const [bx, by] = place(tx - tw / 2 - 6 * ui, ty - bh / 2, tw + 12 * ui, bh);
        ctx.fillStyle = "rgba(5,8,13,0.78)";
        ctx.fillRect(bx, by, tw + 12 * ui, bh);
        ctx.fillStyle = col; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(text, bx + (tw + 12 * ui) / 2, by + bh / 2);
      };
      const sel = selMetric || "";
      const all = !sel;
      // knees and elbow bend along the run-up: only a side-on video shows their true angle (from behind they
      // are foreshortened and the numbers would be misleading)
      const sideOn = result.view.view === "side_on";
      if (sideOn) {
        arc(F.hip, F.kn, F.an, "#34d399", "Front knee", all || sel.startsWith("front_knee"));
        arc(B.sh, B.el, B.wr, "#fb7185", "Elbow bend", all || sel.startsWith("elbow"), true);
        if (all || sel.startsWith("back_knee")) arc(B.hip, B.kn, B.an, "#fbbf24", "Back knee", true);
      }
      // trunk line vs vertical
      if ((all || sel.startsWith("trunk")) && Math.min(cf[5], cf[6], cf[11], cf[12]) > 0.2) {
        const sh: Pt = [(pts[5][0] + pts[6][0]) / 2, (pts[5][1] + pts[6][1]) / 2];
        const hp: Pt = [(pts[11][0] + pts[12][0]) / 2, (pts[11][1] + pts[12][1]) / 2];
        const len = Math.hypot(sh[0] - hp[0], sh[1] - hp[1]);
        ctx.setLineDash([6, 6]); ctx.strokeStyle = "rgba(148,163,184,0.8)"; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(hp[0], hp[1]); ctx.lineTo(hp[0], hp[1] - len * 1.1); ctx.stroke(); ctx.setLineDash([]);
        ctx.strokeStyle = "#38bdf8"; ctx.lineWidth = lw * 0.9;
        ctx.beginPath(); ctx.moveTo(hp[0], hp[1]); ctx.lineTo(sh[0], sh[1]); ctx.stroke();
        const tilt = (Math.atan2(sh[0] - hp[0], hp[1] - sh[1]) * 180) / Math.PI;
        const text = sideOn ? `Trunk lean ${Math.abs(tilt).toFixed(0)}°` : `Side-bend ${Math.abs(tilt).toFixed(0)}°`;
        ctx.font = font(14);
        const tw = ctx.measureText(text).width;
        const bh = 22 * ui;
        const [bx, by] = place(sh[0] + 12, sh[1] - 10 - bh, tw + 12 * ui, bh);
        ctx.fillStyle = "rgba(5,8,13,0.78)"; ctx.fillRect(bx, by, tw + 12 * ui, bh);
        ctx.fillStyle = "#7dd3fc"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
        ctx.fillText(text, bx + 6 * ui, by + bh / 2);
      }
    }
  }, [frame, loaded, overlay, selMetric, zoomOn, crops, kp, kc, n, f0, result, B, F]);

  return (
    <div className="player-stage">
      <canvas ref={canvas} role="img" aria-label={`Video frame ${frame} with the bowler's skeleton and joint angles drawn on top`} />
      <div className="player-hud">
        {hud && <span className="chip" style={{ color: "#fff", borderColor: "#fff" }}>{hud}</span>}
        {loaded < n && <span className="chip">Loading frames {Math.round((loaded / n) * 100)}%</span>}
      </div>
      <div className="player-hud-r">
        <button className={`btn sm ${zoomOn ? "active" : ""}`} aria-pressed={zoomOn} onClick={() => setZoom(!zoomOn)} title="Follow and zoom on the bowler">
          {zoomOn ? "Zoom: bowler" : "Zoom: full frame"}
        </button>
      </div>
    </div>
  );
}
