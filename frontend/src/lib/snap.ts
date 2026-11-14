/**
 * Snap a tap to the crease corner it was aimed at. Painted creases are pale lines on darker turf; near the tap, find
 * the two strongest pale lines that cross at a real angle and return where their centre-lines meet. A finger is a
 * centimetre wide and a far crease corner is a few pixels: this is what makes marking the pitch on a phone exact.
 * Returns null when there is no clear corner within reach (the tap is kept as it is).
 */
import type { Pt } from "./camcal";

export function snapCorner(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number, tap: Pt, radius = 16): Pt | null {
  const R = Math.round(radius), cx = Math.round(tap[0]), cy = Math.round(tap[1]);
  const x0 = Math.max(0, cx - R), y0 = Math.max(0, cy - R), x1 = Math.min(w - 1, cx + R), y1 = Math.min(h - 1, cy + R);
  const ww = x1 - x0 + 1, hh = y1 - y0 + 1;
  if (ww < 9 || hh < 9) return null;
  const L = new Float32Array(ww * hh);
  for (let y = 0; y < hh; y++) for (let x = 0; x < ww; x++) { const o = ((y + y0) * w + x + x0) * 4; L[y * ww + x] = 0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2]; }
  const sorted = Array.from(L).sort((a, b) => a - b), med = sorted[sorted.length >> 1], hi = sorted[Math.floor(sorted.length * 0.97)];
  const mad = sorted.map((v) => Math.abs(v - med)).sort((a, b) => a - b)[sorted.length >> 1] * 1.48 + 1;
  if (hi - med < Math.max(12, 3 * mad)) return null;   // nothing pale enough in reach
  const thr = med + 0.45 * (hi - med);
  const pts: { x: number; y: number; w: number }[] = [];
  for (let y = 0; y < hh; y++) for (let x = 0; x < ww; x++) { const v = L[y * ww + x]; if (v > thr) pts.push({ x, y, w: v - med }); }
  if (pts.length < 8 || pts.length > 0.5 * ww * hh) return null;
  // strongest line through the pale pixels: angle and offset (Hough), then a weighted least-squares polish
  const line = (use: boolean[]): { nx: number; ny: number; c: number; support: number } | null => {
    let best = -1, bA = 0, bR = 0;
    const NA = 90, diag = Math.ceil(Math.hypot(ww, hh)), acc = new Float32Array(2 * diag + 1);
    for (let a = 0; a < NA; a++) {
      const th = (a * Math.PI) / NA, nx = Math.cos(th), ny = Math.sin(th);
      acc.fill(0);
      for (let i = 0; i < pts.length; i++) if (use[i]) acc[Math.round(pts[i].x * nx + pts[i].y * ny) + diag] += pts[i].w;
      for (let r = 1; r < acc.length - 1; r++) { const v = acc[r - 1] + acc[r] + acc[r + 1]; if (v > best) { best = v; bA = th; bR = r - diag; } }
    }
    if (best <= 0) return null;
    let nx = Math.cos(bA), ny = Math.sin(bA), c = bR;
    for (let it = 0; it < 3; it++) {
      let W = 0, mx = 0, my = 0;
      const near: number[] = [];
      for (let i = 0; i < pts.length; i++) if (use[i] && Math.abs(pts[i].x * nx + pts[i].y * ny - c) < 2.5) { near.push(i); W += pts[i].w; mx += pts[i].w * pts[i].x; my += pts[i].w * pts[i].y; }
      if (near.length < 5) return null;
      mx /= W; my /= W;
      let sxx = 0, sxy = 0, syy = 0;
      for (const i of near) { const dx = pts[i].x - mx, dy = pts[i].y - my; sxx += pts[i].w * dx * dx; sxy += pts[i].w * dx * dy; syy += pts[i].w * dy * dy; }
      const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);   // direction of the line
      nx = -Math.sin(ang); ny = Math.cos(ang); c = mx * nx + my * ny;
    }
    let support = 0;
    for (let i = 0; i < pts.length; i++) if (use[i] && Math.abs(pts[i].x * nx + pts[i].y * ny - c) < 2.5) support++;
    return { nx, ny, c, support };
  };
  const all = pts.map(() => true), a = line(all);
  if (!a || a.support < 6) return null;
  const rest = pts.map((p) => Math.abs(p.x * a.nx + p.y * a.ny - a.c) >= 3), b = line(rest);
  if (!b || b.support < 4) return null;
  const det = a.nx * b.ny - a.ny * b.nx;
  if (Math.abs(det) < Math.sin((20 * Math.PI) / 180)) return null;   // nearly parallel: not a corner
  const x = (a.c * b.ny - a.ny * b.c) / det, y = (a.nx * b.c - a.c * b.nx) / det;
  const out: Pt = [x + x0, y + y0];
  return Math.hypot(out[0] - tap[0], out[1] - tap[1]) <= radius ? out : null;
}
