/**
 * Finding the ball in the frames. A cricket ball in a wide shot is a few pixels of blur, so it is found the way an
 * eye finds it: it is the small thing that moves when everything else is still.
 *
 *   1. Cancel the camera's own movement. Broadcast cameras zoom and tilt through a delivery; a phone on a tripod
 *      does not. Either way, the zoom and shift between neighbouring frames are measured by matching small patches of
 *      the picture (`motion`), so every frame can be laid over its neighbours and over the frame the pitch was
 *      marked on.
 *   2. Three-frame difference (`blobs`): what is in this frame but in neither the frame before nor the frame after
 *      (both laid over this one) is something that was only here now. Small compact patches of that are candidates;
 *      players are too big.
 *   3. Link (`linkBall`): the ball is the chain of candidates that moves down the pitch smoothly, with at most one
 *      kink where it pitches.
 *
 * Nothing here knows about cricket balls' colour: it works for red, white and pink.
 */
import type { Pt } from "./camcal";

/** Picture B over picture A: a point (x, y) in A is at (s x + dx, s y + dy) in B. */
export interface Shift { s: number; dx: number; dy: number; matched: number }
export const STILL: Shift = { s: 1, dx: 0, dy: 0, matched: 0 };
export const applyShift = (m: Shift, p: Pt): Pt => [m.s * p[0] + m.dx, m.s * p[1] + m.dy];
export const invertShift = (m: Shift): Shift => ({ s: 1 / m.s, dx: -m.dx / m.s, dy: -m.dy / m.s, matched: m.matched });
/** a then b */
export const chain = (a: Shift, b: Shift): Shift => ({ s: a.s * b.s, dx: b.s * a.dx + b.dx, dy: b.s * a.dy + b.dy, matched: Math.min(a.matched, b.matched) });

export interface Gray { w: number; h: number; d: Float32Array }

/** Luminance at 1/k of the size (box average). */
export function grayOf(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number, k = 2): Gray {
  const gw = Math.floor(w / k), gh = Math.floor(h / k), d = new Float32Array(gw * gh), norm = 1 / (k * k);
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    let s = 0;
    for (let j = 0; j < k; j++) {
      let o = ((y * k + j) * w + x * k) * 4;
      for (let i = 0; i < k; i++, o += 4) s += 0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2];
    }
    d[y * gw + x] = s * norm;
  }
  return { w: gw, h: gh, d };
}
function shrink(g: Gray, k: number): Gray {
  const gw = Math.floor(g.w / k), gh = Math.floor(g.h / k), d = new Float32Array(gw * gh), norm = 1 / (k * k);
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    let s = 0;
    for (let j = 0; j < k; j++) for (let i = 0; i < k; i++) s += g.d[(y * k + j) * g.w + x * k + i];
    d[y * gw + x] = s * norm;
  }
  return { w: gw, h: gh, d };
}

/** Match textured patches of a in b around where `guess` puts them; fit zoom + shift to the matches, robustly. */
function matchLevel(a: Gray, b: Gray, B: number, R: number, grid: number, guess: Shift): Shift {
  const { w, h } = a, pts: number[] = [];
  const cost = new Float32Array((2 * R + 1) * (2 * R + 1));
  for (let y = R + B; y < h - R - 2 * B; y += grid) for (let x = R + B; x < w - R - 2 * B; x += grid) {
    // enough texture both ways, or the match can slide along an edge
    let ex = 0, ey = 0;
    for (let j = 0; j < B; j++) for (let i = 0; i < B; i++) {
      const o = (y + j) * w + x + i, gx = a.d[o + 1] - a.d[o - 1], gy = a.d[o + w] - a.d[o - w];
      ex += gx * gx; ey += gy * gy;
    }
    if (Math.min(ex, ey) < B * B * 2.5) continue;
    const cx = x + B / 2, cy = y + B / 2;
    const ox = Math.round(guess.s * cx + guess.dx - cx), oy = Math.round(guess.s * cy + guess.dy - cy);
    if (y + oy - R < 0 || x + ox - R < 0 || y + oy + B + R > b.h || x + ox + B + R > b.w) continue;
    let best = Infinity, bi = 0, bj = 0;
    for (let v = -R; v <= R; v++) for (let u = -R; u <= R; u++) {
      let s = 0;
      for (let j = 0; j < B && s < best; j++) {
        let oa = (y + j) * w + x, ob = (y + oy + v + j) * b.w + x + ox + u;
        for (let i = 0; i < B; i++, oa++, ob++) { const d = a.d[oa] - b.d[ob]; s += d * d; }
      }
      cost[(v + R) * (2 * R + 1) + u + R] = s;
      if (s < best) { best = s; bi = u; bj = v; }
    }
    if (Math.abs(bi) === R || Math.abs(bj) === R) continue;
    // the early exit leaves neighbours of the best as lower bounds: recompute the four around it exactly
    const exact = (u: number, v: number) => {
      let s = 0;
      for (let j = 0; j < B; j++) {
        let oa = (y + j) * w + x, ob = (y + oy + v + j) * b.w + x + ox + u;
        for (let i = 0; i < B; i++, oa++, ob++) { const d = a.d[oa] - b.d[ob]; s += d * d; }
      }
      return s;
    };
    const sub = (m: number, c: number, p: number) => { const den = m - 2 * c + p; return den <= 1e-9 ? 0 : (0.5 * (m - p)) / den; };
    const fx = bi + sub(exact(bi - 1, bj), best, exact(bi + 1, bj)), fy = bj + sub(exact(bi, bj - 1), best, exact(bi, bj + 1));
    pts.push(cx, cy, cx + ox + fx, cy + oy + fy);
  }
  const n = pts.length / 4;
  if (n < 8) return { ...guess, matched: 0 };
  const wt = new Float64Array(n).fill(1);
  let s = guess.s, dx = guess.dx, dy = guess.dy, inl = 0;
  for (let it = 0; it < 8; it++) {
    // minimise sum w [(s x + dx - x')^2 + (s y + dy - y')^2]
    let W = 0, Sx = 0, Sy = 0, Sxx = 0, Sxp = 0, Syp = 0, Sxxp = 0;
    for (let i = 0; i < n; i++) {
      const x = pts[4 * i], y = pts[4 * i + 1], xp = pts[4 * i + 2], yp = pts[4 * i + 3], k = wt[i];
      W += k; Sx += k * x; Sy += k * y; Sxx += k * (x * x + y * y); Sxp += k * xp; Syp += k * yp; Sxxp += k * (x * xp + y * yp);
    }
    const den = Sxx - (Sx * Sx + Sy * Sy) / W;
    if (!(Math.abs(den) > 1e-9)) break;
    s = (Sxxp - (Sx * Sxp + Sy * Syp) / W) / den; dx = (Sxp - s * Sx) / W; dy = (Syp - s * Sy) / W;
    const e: number[] = [];
    for (let i = 0; i < n; i++) e.push(Math.hypot(s * pts[4 * i] + dx - pts[4 * i + 2], s * pts[4 * i + 1] + dy - pts[4 * i + 3]));
    const sorted = e.slice().sort((p, q) => p - q), sig = Math.max(0.15, 1.48 * sorted[n >> 1]);
    inl = 0;
    for (let i = 0; i < n; i++) { const r = e[i] / (2 * sig); wt[i] = 1 / ((1 + r * r) * (1 + r * r)); if (e[i] < 3 * sig) inl++; }
  }
  return { s, dx, dy, matched: inl };
}

/**
 * The camera's movement from frame a to frame b (half-size luminance in, full-size pixels out): coarse first, so a
 * fast zoom is not lost, then fine.
 */
export function motion(a: Gray, b: Gray, k = 2): Shift {
  const ca = shrink(a, 4), cb = shrink(b, 4);
  const c = matchLevel(ca, cb, 12, 10, 10, STILL);
  const f = matchLevel(a, b, 16, 5, 24, { s: c.s, dx: c.dx * 4, dy: c.dy * 4, matched: 0 });
  return { s: f.s, dx: f.dx * k, dy: f.dy * k, matched: f.matched };
}

export interface Blob {
  x: number; y: number;        // centre (weighted by how strongly it stands out), pixels of its own frame
  area: number; w: number; h: number;
  peak: number;                // strongest difference inside it (sum over red, green, blue; 0-765)
  lum: number;                 // how much brighter (+) or darker (-) than what was there before and after
  rgb: [number, number, number];
}
export interface Roi { x0: number; y0: number; x1: number; y1: number }

/**
 * What is in `cur` but in neither `prev` nor `next`. toPrev / toNext lay those frames over cur (cur coordinates to
 * theirs). Small patches only (a ball, its shadow, noise); the linker sorts out which is which.
 */
export function blobs(prev: Uint8ClampedArray | Uint8Array, cur: Uint8ClampedArray | Uint8Array, next: Uint8ClampedArray | Uint8Array,
  w: number, h: number, toPrev: Shift, toNext: Shift, roi?: Roi, maxSide = 70): Blob[] {
  const x0 = Math.max(2, Math.floor(roi?.x0 ?? 0)), y0 = Math.max(2, Math.floor(roi?.y0 ?? 0));
  const x1 = Math.min(w - 2, Math.ceil(roi?.x1 ?? w)), y1 = Math.min(h - 2, Math.ceil(roi?.y1 ?? h));
  const rw = x1 - x0, rh = y1 - y0;
  if (rw < 8 || rh < 8) return [];
  const raw = new Float32Array(rw * rh), sign = new Float32Array(rw * rh);
  const sample = (img: Uint8ClampedArray | Uint8Array, m: Shift, x: number, y: number, out: number[]): boolean => {
    const fx = m.s * x + m.dx, fy = m.s * y + m.dy, ix = Math.floor(fx), iy = Math.floor(fy);
    if (ix < 0 || iy < 0 || ix >= w - 1 || iy >= h - 1) return false;
    const u = fx - ix, v = fy - iy, o = (iy * w + ix) * 4, o2 = o + w * 4;
    const a = (1 - u) * (1 - v), b = u * (1 - v), c = (1 - u) * v, d = u * v;
    out[0] = a * img[o] + b * img[o + 4] + c * img[o2] + d * img[o2 + 4];
    out[1] = a * img[o + 1] + b * img[o + 5] + c * img[o2 + 1] + d * img[o2 + 5];
    out[2] = a * img[o + 2] + b * img[o + 6] + c * img[o2 + 2] + d * img[o2 + 6];
    return true;
  };
  const P = [0, 0, 0], N = [0, 0, 0];
  const moving = Math.abs(toPrev.s - 1) > 0.002 || Math.abs(toNext.s - 1) > 0.002 || Math.hypot(toPrev.dx, toPrev.dy) > 1.5 || Math.hypot(toNext.dx, toNext.dy) > 1.5;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    if (!sample(prev, toPrev, x, y, P) || !sample(next, toNext, x, y, N)) continue;
    const o = (y * w + x) * 4, r = cur[o], g = cur[o + 1], b = cur[o + 2];
    const d1 = Math.abs(r - P[0]) + Math.abs(g - P[1]) + Math.abs(b - P[2]), d2 = Math.abs(r - N[0]) + Math.abs(g - N[1]) + Math.abs(b - N[2]);
    const i = (y - y0) * rw + x - x0;
    // score graphics sit still on the screen while the camera moves under them: the ball differs from the
    // neighbouring frames as they were shown, too
    const d3 = moving ? Math.abs(r - prev[o]) + Math.abs(g - prev[o + 1]) + Math.abs(b - prev[o + 2]) : d1;
    const d4 = moving ? Math.abs(r - next[o]) + Math.abs(g - next[o + 1]) + Math.abs(b - next[o + 2]) : d2;
    raw[i] = Math.min(d1, d2, d3, d4);
    const l = 0.299 * r + 0.587 * g + 0.114 * b, lp = 0.299 * P[0] + 0.587 * P[1] + 0.114 * P[2], ln = 0.299 * N[0] + 0.587 * N[1] + 0.114 * N[2];
    sign[i] = l - (d1 < d2 ? lp : ln);
  }
  // 3x3 blur, then a threshold well above the picture's own noise
  const d = new Float32Array(rw * rh), hist = new Uint32Array(256);
  for (let y = 1; y < rh - 1; y++) for (let x = 1; x < rw - 1; x++) {
    const i = y * rw + x;
    const v = (raw[i - rw - 1] + raw[i - rw] + raw[i - rw + 1] + raw[i - 1] + raw[i] + raw[i + 1] + raw[i + rw - 1] + raw[i + rw] + raw[i + rw + 1]) / 9;
    d[i] = v; hist[Math.min(255, v | 0)]++;
  }
  let acc = 0, med = 0;
  const half = ((rw - 2) * (rh - 2)) / 2;
  for (; med < 255 && (acc += hist[med]) < half; med++);
  const thr = Math.max(30, 8 * (1.48 * med + 1));
  const seen = new Uint8Array(rw * rh), out: Blob[] = [], stack: number[] = [];
  for (let s = 0; s < rw * rh; s++) {
    if (seen[s] || d[s] <= thr) continue;
    stack.length = 0; stack.push(s); seen[s] = 1;
    let area = 0, sx = 0, sy = 0, sw = 0, peak = 0, lum = 0, r = 0, g = 0, b = 0, bx0 = rw, bx1 = 0, by0 = rh, by1 = 0;
    while (stack.length) {
      const i = stack.pop()!, x = i % rw, y = (i - x) / rw, v = d[i];
      area++; sx += x * v; sy += y * v; sw += v; if (v > peak) peak = v; lum += sign[i] * v;
      const o = ((y + y0) * w + x + x0) * 4; r += cur[o]; g += cur[o + 1]; b += cur[o + 2];
      if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= rw || ny >= rh) continue;
        const j = ny * rw + nx;
        if (!seen[j] && d[j] > thr) { seen[j] = 1; stack.push(j); }
      }
    }
    const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1;
    if (area < 4 || bw > maxSide || bh > maxSide || area > maxSide * maxSide * 0.5) continue;
    out.push({ x: x0 + sx / sw, y: y0 + sy / sw, area, w: bw, h: bh, peak, lum: lum / sw, rgb: [r / area, g / area, b / area] });
  }
  return out;
}

export interface Seen { frame: number; t: number; px: Pt; blob: Blob }
export interface LinkOpts {
  /** the most the ball can move between frames one frame-time apart, pixels */
  maxStep: number;
  /** only candidates inside this test count (the corridor above the pitch) */
  inside?: (p: Pt) => boolean;
  maxGap?: number;
  chains?: number;      // how many chains to return (default 5)
  perFrame?: number;    // how many candidates a frame may put forward (default 36)
}

/**
 * Chains of candidates that move smoothly, best first: the ball is one of them (lib/balltrack.ts pickBall decides
 * which, by asking which is a cricket ball's flight). `cands[i]` are frame i's candidates already in the marked
 * frame's coordinates (camera movement cancelled); `times` are the frames' times. A kink (the bounce, or the bat)
 * costs a fixed amount, so a chain carries on through one.
 */
export function linkChains(frames: number[], times: number[], cands: { px: Pt; blob: Blob }[][], o: LinkOpts): Seen[][] {
  interface Node { f: number; px: Pt; blob: Blob; gain: number }
  let nodes: Node[] = [];
  for (let f = 0; f < cands.length; f++) {
    const here: Node[] = [];
    for (const c of cands[f]) {
      if (o.inside && !o.inside(c.px)) continue;
      const compact = Math.min(1, c.blob.area / (c.blob.w * c.blob.h));
      here.push({ f, px: c.px, blob: c.blob, gain: 1 + 0.6 * Math.min(1, c.blob.peak / 200) * compact });
    }
    // the ball stands out: the strongest few dozen per frame are plenty, and keep the search quick
    here.sort((a, b) => b.gain - a.gain);
    nodes.push(...here.slice(0, o.perFrame ?? 36));
  }
  const maxGap = o.maxGap ?? 3, frameT = (times[times.length - 1] - times[0]) / Math.max(1, times.length - 1), out: Seen[][] = [];
  const KINK = 2.2;
  for (let round = 0; round < (o.chains ?? 5) && nodes.length >= 4; round++) {
    const n = nodes.length;
    const next: number[][] = nodes.map(() => []);
    for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) {
      const gap = nodes[b].f - nodes[a].f;
      if (gap < 1 || gap > maxGap) continue;
      const dt = (times[nodes[b].f] - times[nodes[a].f]) / frameT;
      const d = Math.hypot(nodes[b].px[0] - nodes[a].px[0], nodes[b].px[1] - nodes[a].px[1]);
      if (d < 1.5 * dt || d > o.maxStep * dt) continue;
      next[a].push(b);
    }
    // best[a][k]: best score of a chain ending with the edge a -> next[a][k]
    const best: number[][] = next.map((l) => l.map(() => -Infinity)), from: ([number, number] | null)[][] = next.map((l) => l.map(() => null));
    const order = nodes.map((_, i) => i).sort((p, q) => nodes[p].f - nodes[q].f);
    let top = -Infinity, topEdge: [number, number] | null = null;
    for (const a of order) for (let k = 0; k < next[a].length; k++) {
      const b = next[a][k];
      const fresh = nodes[a].gain + nodes[b].gain - 0.15 * (nodes[b].f - nodes[a].f - 1);
      if (fresh > best[a][k]) { best[a][k] = fresh; from[a][k] = null; }
      const sc = best[a][k];
      if (sc > top) { top = sc; topEdge = [a, k]; }
      const tab = times[nodes[b].f] - times[nodes[a].f];
      for (let k2 = 0; k2 < next[b].length; k2++) {
        const c = next[b][k2], tbc = times[nodes[c].f] - times[nodes[b].f], r = tbc / tab;
        const px = nodes[b].px[0] + (nodes[b].px[0] - nodes[a].px[0]) * r, py = nodes[b].px[1] + (nodes[b].px[1] - nodes[a].px[1]) * r;
        const step = Math.hypot(nodes[b].px[0] - nodes[a].px[0], nodes[b].px[1] - nodes[a].px[1]) * r;
        const e = Math.hypot(nodes[c].px[0] - px, nodes[c].px[1] - py) / (0.12 * step + 2.5);
        const cand = sc + nodes[c].gain - Math.min(KINK, 0.35 * e * e) - 0.15 * (nodes[c].f - nodes[b].f - 1);
        if (cand > best[b][k2]) { best[b][k2] = cand; from[b][k2] = [a, k]; }
      }
    }
    if (!topEdge) break;
    const idx: number[] = [];
    let e: [number, number] | null = topEdge;
    idx.push(next[e[0]][e[1]]);
    while (e) { idx.push(e[0]); e = from[e[0]][e[1]]; }
    idx.reverse();
    if (idx.length < 4) break;
    out.push(idx.map((i) => ({ frame: frames[nodes[i].f], t: times[nodes[i].f], px: nodes[i].px, blob: nodes[i].blob })));
    const used = new Set(idx);
    nodes = nodes.filter((_, i) => !used.has(i));
  }
  return out;
}

/**
 * The ball's shadow, frame by frame. Seen through a camera, every sunbeam points at one spot in the picture, so the
 * shadow is always on the same side of the ball (at nearly the same angle), and its distance from the ball in the
 * picture is in step with the ball's height: closing in as the ball drops, touching it where it pitches, opening
 * again as it rises. `heights` are the ball's heights from a first fit (metres). Looks for the dark candidates that
 * share one angle and one distance-per-metre across the most frames. Returns each sighting's shadow, or null.
 */
export function findShadows(ball: Seen[], heights: number[], cands: Map<number, { px: Pt; blob: Blob }[]>, maxDist: number): (Pt | null)[] {
  const none = ball.map(() => null);
  const E: { i: number; a: number; lr: number; px: Pt }[] = [];
  ball.forEach((s, i) => {
    if (!(heights[i] > 0.3)) return;   // too low: the shadow is under the ball
    for (const c of cands.get(s.frame) ?? []) {
      if (c.blob.lum > -4) continue;   // a shadow is darker than the ground it falls on
      const dx = c.px[0] - s.px[0], dy = c.px[1] - s.px[1], d = Math.hypot(dx, dy);
      if (d < 5 || d > maxDist) continue;
      E.push({ i, a: Math.atan2(dy, dx), lr: Math.log(d / heights[i]), px: c.px });
    }
  });
  const dAng = (p: number, q: number) => Math.abs(Math.atan2(Math.sin(p - q), Math.cos(p - q)));
  let top: Map<number, { px: Pt; e: number }> | null = null;
  for (const seed of E) {
    const m = new Map<number, { px: Pt; e: number }>();
    for (const o of E) {
      const da = dAng(o.a, seed.a), dl = Math.abs(o.lr - seed.lr);
      if (da > 0.09 || dl > 0.3) continue;
      const e = da / 0.09 + dl / 0.3, had = m.get(o.i);
      if (!had || e < had.e) m.set(o.i, { px: o.px, e });
    }
    if (!top || m.size > top.size) top = m;
  }
  const usable = heights.filter((h) => h > 0.3).length;
  if (!top || top.size < 3 || top.size < 0.4 * usable) return none;
  return ball.map((_, i) => top!.get(i)?.px ?? null);
}
