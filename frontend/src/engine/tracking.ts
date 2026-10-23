/**
 * Multi-person tracking for phone/broadcast cricket footage (port of backend/bowlnet/tracking.py).
 *
 * SORT-style association with the cues that matter for bowling clips: global motion compensation
 * (pans/zooms) from the background, constant-velocity prediction in stabilised coordinates, appearance
 * (HSV colour of torso/legs), pose similarity and Hungarian assignment with gating.
 */
import type { Detection } from "./bowler";

export interface FrameDets {
  frame: number;
  boxes: number[][];      // (N,4) x1,y1,x2,y2 source pixels
  confs: number[];
  kps: number[][][];      // (N,17,2)
  kcs: number[][];        // (N,17)
  appearance: number[][]; // (N,96)
  motion: number[][];     // 2x3 affine mapping previous-frame pixels -> this frame
}

export const IDENTITY: number[][] = [[1, 0, 0], [0, 1, 0]];

// ---------------- appearance ----------------
/** Torso + legs HSV histograms (8x3x2 bins each, OpenCV HSV ranges), from an RGBA image. */
export function appearance(img: ImageData, box: number[], scale = 1): number[] {
  const { width: w, height: h, data } = img;
  const [x1, y1, x2, y2] = box.map((v) => v * scale);
  const bw = x2 - x1, bh = y2 - y1;
  const feats: number[] = [];
  for (const [fy1, fy2] of [[0.18, 0.55], [0.55, 0.95]]) {
    const xa = Math.trunc(Math.max(0, x1 + 0.25 * bw)), xb = Math.trunc(Math.min(w, x2 - 0.25 * bw));
    const ya = Math.trunc(Math.max(0, y1 + fy1 * bh)), yb = Math.trunc(Math.min(h, y1 + fy2 * bh));
    if (xb - xa < 2 || yb - ya < 2) {
      for (let i = 0; i < 48; i++) feats.push(1 / 48);
      continue;
    }
    const hist = new Array(48).fill(0);
    let n = 0;
    for (let y = ya; y < yb; y++) {
      for (let x = xa; x < xb; x++) {
        const o = (y * w + x) * 4;
        const [hh, s, v] = rgbToHsv(data[o], data[o + 1], data[o + 2]);
        const hb = Math.min(7, Math.floor(hh / 22.5)), sb = Math.min(2, Math.floor(s / 85.34)), vb = Math.min(1, Math.floor(v / 128));
        hist[hb * 6 + sb * 2 + vb] += 1;
        n++;
      }
    }
    for (let i = 0; i < 48; i++) feats.push(hist[i] / Math.max(n, 1e-6));
  }
  return feats;
}

/** OpenCV 8-bit HSV: H in [0,180), S and V in [0,255]. */
function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const v = Math.max(r, g, b), mn = Math.min(r, g, b), d = v - mn;
  const s = v === 0 ? 0 : (255 * d) / v;
  let h = 0;
  if (d > 0) {
    if (v === r) h = (60 * (g - b)) / d;
    else if (v === g) h = 120 + (60 * (b - r)) / d;
    else h = 240 + (60 * (r - g)) / d;
    if (h < 0) h += 360;
  }
  return [h / 2, s, v];
}

// ---------------- camera motion ----------------
export const FLOW_SIZE = 320;

/** Grey image at FLOW_SIZE (longest side) for motion estimation. */
export interface Grey { w: number; h: number; px: Float32Array; scale: number }

export function toGrey(img: ImageData, scale: number): Grey {
  const { width: w, height: h, data } = img;
  const px = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) px[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  return { w, h, px, scale };
}

const STATIC_WINDOW = 6;

/**
 * Camera motion prev->curr (pan/tilt/zoom) on the background, people masked out. The Python pipeline uses
 * dense ECC; here a grid of textured background patches is block-matched coarse-to-fine and a similarity
 * (scale + translation) is fitted robustly, which covers phone pans and broadcast zooms.
 * Static overlays (pixels identical over the last few frames: score bars, or everything on a tripod) are masked.
 */
export class MotionEstimator {
  private prev: Grey | null = null;
  private prevBoxes: number[][] = [];
  private diffs: Uint8Array[] = [];

  next(g: Grey, boxes: number[][]): number[][] {
    const prev = this.prev;
    let M = IDENTITY.map((r) => r.slice());
    if (prev && prev.w === g.w && prev.h === g.h) {
      const n = g.w * g.h;
      const diff = new Uint8Array(n);
      for (let i = 0; i < n; i++) diff[i] = Math.abs(prev.px[i] - g.px[i]) <= 4 ? 1 : 0;
      this.diffs.push(diff);
      if (this.diffs.length > STATIC_WINDOW) this.diffs.shift();
      const mask = new Uint8Array(n).fill(1);
      for (const bb of [boxes, this.prevBoxes]) {
        for (const b of bb) {
          const [x1, y1, x2, y2] = b.map((v) => Math.round(v * g.scale));
          for (let y = Math.max(0, y1 - 4); y < Math.min(g.h, y2 + 4); y++)
            for (let x = Math.max(0, x1 - 4); x < Math.min(g.w, x2 + 4); x++) mask[y * g.w + x] = 0;
        }
      }
      if (this.diffs.length >= 3) {
        for (let i = 0; i < n; i++) {
          let still = 1;
          for (const d of this.diffs) still &= d[i];
          if (still) mask[i] = 0;
        }
      }
      const est = estimateSimilarity(prev, g, mask);
      if (est) {
        const [s, tx, ty] = est;
        M = [[s, 0, tx / g.scale], [0, s, ty / g.scale]];
      }
    }
    this.prev = g;
    this.prevBoxes = boxes;
    return M;
  }
}

/** Robust similarity fit (scale, tx, ty) between two grey frames from block-matched patches. */
function estimateSimilarity(a: Grey, b: Grey, mask: Uint8Array): [number, number, number] | null {
  const { w, h } = a;
  const P = 6, R = 12, STEP = 14;   // patch half-size, search radius (px at FLOW_SIZE), grid step
  const src: [number, number][] = [], dst: [number, number][] = [];
  for (let y = P + R; y < h - P - R; y += STEP) {
    for (let x = P + R; x < w - P - R; x += STEP) {
      // patch must be background and textured
      let ok = true, gx = 0, gy = 0;
      for (let dy = -P; dy <= P && ok; dy += 2)
        for (let dx = -P; dx <= P; dx += 2) {
          const i = (y + dy) * w + x + dx;
          if (!mask[i]) { ok = false; break; }
          gx += Math.abs(a.px[i + 1] - a.px[i - 1]);
          gy += Math.abs(a.px[i + w] - a.px[i - w]);
        }
      if (!ok || Math.min(gx, gy) < 49 * 6) continue;
      // coarse search (step 2), then refine (step 1) around the best
      let best = Infinity, bx = 0, by = 0;
      const sad = (ox: number, oy: number) => {
        let s = 0;
        for (let dy = -P; dy <= P; dy += 2) {
          const ra = (y + dy) * w + x, rb = (y + dy + oy) * w + x + ox;
          for (let dx = -P; dx <= P; dx += 2) s += Math.abs(a.px[ra + dx] - b.px[rb + dx]);
        }
        return s;
      };
      for (let oy = -R; oy <= R; oy += 2) for (let ox = -R; ox <= R; ox += 2) {
        const s = sad(ox, oy);
        if (s < best) { best = s; bx = ox; by = oy; }
      }
      const cx = bx, cy = by;
      for (let oy = cy - 1; oy <= cy + 1; oy++) for (let ox = cx - 1; ox <= cx + 1; ox++) {
        if (Math.abs(ox) > R || Math.abs(oy) > R) continue;
        const s = sad(ox, oy);
        if (s < best) { best = s; bx = ox; by = oy; }
      }
      if (best / 49 > 18) continue;   // no good match (occlusion / moving object)
      src.push([x, y]); dst.push([x + bx, y + by]);
    }
  }
  if (src.length < 12) return null;
  // robust: translation from the median displacement, then scale about the centre, then refit on inliers
  const cx = w / 2, cy = h / 2;
  let s = 1, tx = 0, ty = 0;
  let inl = src.map((_, i) => i);
  for (let it = 0; it < 3; it++) {
    const ddx = inl.map((i) => dst[i][0] - src[i][0]).sort((p, q) => p - q);
    const ddy = inl.map((i) => dst[i][1] - src[i][1]).sort((p, q) => p - q);
    const mx = ddx[ddx.length >> 1], my = ddy[ddy.length >> 1];
    // least squares for s with translation: d = (s-1)(p-c) + t
    let num = 0, den = 0;
    for (const i of inl) {
      const px = src[i][0] - cx, py = src[i][1] - cy;
      num += px * (dst[i][0] - src[i][0] - mx) + py * (dst[i][1] - src[i][1] - my);
      den += px * px + py * py;
    }
    const k = den > 0 ? num / den : 0;
    s = 1 + k;
    // affine x' = s x + t  with  t = (1 - s) c + m
    tx = (1 - s) * cx + mx;
    ty = (1 - s) * cy + my;
    const res = src.map((p, i) => Math.hypot(s * p[0] + tx - dst[i][0], s * p[1] + ty - dst[i][1]));
    const next = src.map((_, i) => i).filter((i) => res[i] < 1.5);
    if (next.length < 10) break;
    inl = next;
  }
  if (!(s > 0.85 && s < 1.15) || Math.abs(tx) > 0.33 * w || Math.abs(ty) > 0.33 * h) return null;
  if (inl.length < 10) return null;
  return [s, tx, ty];
}

// ---------------- association ----------------
export function applyAffine(M: number[][], box: number[]): number[] {
  const p = (x: number, y: number) => [M[0][0] * x + M[0][1] * y + M[0][2], M[1][0] * x + M[1][1] * y + M[1][2]];
  const a = p(box[0], box[1]), b = p(box[2], box[3]);
  return [a[0], a[1], b[0], b[1]];
}

export function iouMatrix(a: number[][], b: number[][]): number[][] {
  return a.map((p) => b.map((q) => {
    const x1 = Math.max(p[0], q[0]), y1 = Math.max(p[1], q[1]), x2 = Math.min(p[2], q[2]), y2 = Math.min(p[3], q[3]);
    const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    const ua = (p[2] - p[0]) * (p[3] - p[1]) + (q[2] - q[0]) * (q[3] - q[1]) - inter;
    return inter / Math.max(ua, 1e-6);
  }));
}

/** scipy.optimize.linear_sum_assignment for a rectangular cost matrix (Hungarian, O(n^3)). */
export function linearSumAssignment(cost: number[][]): [number[], number[]] {
  const nr = cost.length, nc = nr ? cost[0].length : 0;
  if (!nr || !nc) return [[], []];
  const transpose = nr > nc;
  const C = transpose ? cost[0].map((_, j) => cost.map((r) => r[j])) : cost;
  const n = C.length, m = C[0].length;   // n <= m
  const INF = 1e18;
  const u = new Array(n + 1).fill(0), v = new Array(m + 1).fill(0), p = new Array(m + 1).fill(0), way = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(m + 1).fill(INF), used = new Array(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = INF, j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = C[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  const rows: number[] = [], cols: number[] = [];
  for (let j = 1; j <= m; j++) if (p[j]) { rows.push(p[j] - 1); cols.push(j - 1); }
  const pairs = rows.map((r, i) => (transpose ? [cols[i], r] : [r, cols[i]])).sort((x, y) => x[0] - y[0]);
  return [pairs.map((q) => q[0]), pairs.map((q) => q[1])];
}

/**
 * Drop duplicate boxes of one person. NMS keeps two boxes when a limb swings out (the bowling arm at release:
 * one box with the arm, one without, IoU ~0.65); the spare would start a new track that steals the bowler.
 * Duplicates share their keypoints (median distance < 8% of height); two overlapping people don't (>= ~20%).
 */
export function dedupe(fd: FrameDets): FrameDets {
  const n = fd.boxes.length;
  if (n < 2) return fd;
  const iou = iouMatrix(fd.boxes, fd.boxes);
  const h = fd.boxes.map((b) => Math.max(b[3] - b[1], 1));
  const drop = new Set<number>();
  const order = fd.confs.map((c, i) => [c, i]).sort((x, y) => y[0] - x[0]).map((x) => x[1]);
  for (const i of order) {
    if (drop.has(i)) continue;
    for (let j = 0; j < n; j++) {
      if (j === i || drop.has(j) || iou[i][j] < 0.3 || fd.confs[j] > fd.confs[i]) continue;
      const d: number[] = [];
      for (let k = 0; k < 17; k++)
        if (fd.kcs[i][k] > 0.3 && fd.kcs[j][k] > 0.3) d.push(Math.hypot(fd.kps[i][k][0] - fd.kps[j][k][0], fd.kps[i][k][1] - fd.kps[j][k][1]));
      if (d.length >= 6) {
        d.sort((a, b) => a - b);
        const med = d.length % 2 ? d[d.length >> 1] : (d[d.length / 2 - 1] + d[d.length / 2]) / 2;
        if (med < 0.08 * Math.max(h[i], h[j])) drop.add(j);
      }
    }
  }
  if (!drop.size) return fd;
  const keep = [...Array(n).keys()].filter((i) => !drop.has(i));
  return { frame: fd.frame, boxes: keep.map((i) => fd.boxes[i]), confs: keep.map((i) => fd.confs[i]), kps: keep.map((i) => fd.kps[i]),
    kcs: keep.map((i) => fd.kcs[i]), appearance: keep.map((i) => fd.appearance[i]), motion: fd.motion };
}

interface Track {
  tid: number; box: number[]; vel: number[]; app: number[]; kp: number[][]; kc: number[]; missed: number; hits: number;
}

/** Associate per-frame detections into identities. Returns detections with stable track ids. */
export function track(frames: FrameDets[], fps: number): Detection[] {
  const maxMissed = Math.max(5, Math.round(0.6 * fps));
  let tracks: Track[] = [];
  let nextId = 1;
  const out: Detection[] = [];
  for (const fd0 of frames) {
    const fd = dedupe(fd0);
    const M = fd.motion;
    // predict: constant velocity, then camera motion
    for (const t of tracks) {
      t.box = applyAffine(M, t.box.map((v, i) => v + t.vel[i]));
      t.kp = t.kp.map(([x, y]) => [M[0][0] * x + M[0][1] * y + M[0][2], M[1][0] * x + M[1][1] * y + M[1][2]]);
    }
    const nT = tracks.length, nD = fd.boxes.length;
    const matches: [number, number][] = [];
    if (nT && nD) {
      const tb = tracks.map((t) => t.box);
      const iou = iouMatrix(tb, fd.boxes);
      const cost: number[][] = [];
      for (let i = 0; i < nT; i++) {
        const t = tracks[i], b = tb[i];
        const th = Math.max(b[3] - b[1], 1);
        const tc = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
        const row: number[] = [];
        for (let j = 0; j < nD; j++) {
          const d = fd.boxes[j];
          const dc = [(d[0] + d[2]) / 2, (d[1] + d[3]) / 2];
          const cdist = Math.hypot(tc[0] - dc[0], tc[1] - dc[1]) / th;
          const dh = Math.max(d[3] - d[1], 1);
          const sizeRatio = Math.abs(Math.log(dh / th));
          let bc = 0;
          for (let k = 0; k < t.app.length; k++) bc += Math.sqrt(Math.max(0, t.app[k] * fd.appearance[j][k]));
          const appD = 1 - Math.min(1, Math.max(0, bc / 2));
          // pose similarity: mean keypoint distance (both confident) normalised by height
          let ks = 0, kn = 0;
          for (let k = 0; k < 17; k++) {
            if (t.kc[k] > 0.3 && fd.kcs[j][k] > 0.3) {
              ks += Math.hypot(t.kp[k][0] - fd.kps[j][k][0], t.kp[k][1] - fd.kps[j][k][1]);
              kn++;
            }
          }
          const poseD = (kn >= 4 ? ks / kn : 0.5 * th) / th;
          let c = (1 - iou[i][j]) + 0.8 * Math.min(cdist, 2) + 1.2 * appD + 0.8 * Math.min(poseD, 1) + 0.5 * Math.min(sizeRatio, 1);
          let gate = iou[i][j] > 0.05 || cdist < 0.6 + 0.15 * Math.min(t.missed, 6);
          gate = gate && sizeRatio < 0.7;
          if (!gate) c = 1e6;
          row.push(c);
        }
        cost.push(row);
      }
      const [r, c] = linearSumAssignment(cost);
      for (let k = 0; k < r.length; k++) if (cost[r[k]][c[k]] < 2.6) matches.push([r[k], c[k]]);
    }
    const matchedT = new Set(matches.map((m) => m[0])), matchedD = new Set(matches.map((m) => m[1]));
    for (const [i, j] of matches) {
      const t = tracks[i];
      const nb = fd.boxes[j];
      // velocity in current coordinates (camera motion already applied to the prediction)
      if (t.hits > 1) t.vel = t.vel.map((v, k) => 0.6 * v + 0.4 * (nb[k] - (t.box[k] - v)));
      else t.vel = [0, 0, 0, 0];
      const lim = 0.25 * (nb[3] - nb[1]);
      t.vel = t.vel.map((v) => Math.min(lim, Math.max(-lim, v)));
      t.box = nb.slice();
      t.app = t.app.map((v, k) => 0.8 * v + 0.2 * fd.appearance[j][k]);
      t.kp = fd.kps[j].map((p) => p.slice()); t.kc = fd.kcs[j].slice();
      t.missed = 0; t.hits += 1;
      out.push({ frame: fd.frame, track: t.tid, box: nb.slice(), conf: fd.confs[j], kps: fd.kps[j].map((p) => p.slice()), kcs: fd.kcs[j].slice() });
    }
    tracks.forEach((t, i) => {
      if (!matchedT.has(i)) { t.missed += 1; t.vel = t.vel.map((v) => v * 0.7); }
    });
    tracks = tracks.filter((t) => t.missed <= maxMissed);
    for (let j = 0; j < nD; j++) {
      if (matchedD.has(j) || fd.confs[j] < 0.35) continue;
      const t: Track = { tid: nextId++, box: fd.boxes[j].slice(), vel: [0, 0, 0, 0], app: fd.appearance[j].slice(),
        kp: fd.kps[j].map((p) => p.slice()), kc: fd.kcs[j].slice(), missed: 0, hits: 1 };
      tracks.push(t);
      out.push({ frame: fd.frame, track: t.tid, box: fd.boxes[j].slice(), conf: fd.confs[j], kps: fd.kps[j].map((p) => p.slice()), kcs: fd.kcs[j].slice() });
    }
  }
  return out;
}

export function detectionsByTrack(dets: Detection[]): Map<number, Detection[]> {
  const m = new Map<number, Detection[]>();
  for (const d of dets) {
    if (!m.has(d.track)) m.set(d.track, []);
    m.get(d.track)!.push(d);
  }
  for (const v of m.values()) v.sort((a, b) => a.frame - b.frame);
  return m;
}
