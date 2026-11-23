/**
 * Find the wickets without being told where they are. A wicket seen from along the pitch is three thin upright bars
 * of the same height, the same distance apart, paler or darker than what is behind them, that start at the ground
 * and stop at the top: 71.1 cm tall, 22.86 cm across. That shape is looked for at every place and size in the
 * picture; then two of them, a bigger one lower in the picture and a smaller one above it, are tried as the two ends
 * of one pitch. A level camera either explains both or it does not (lib/camcal.ts).
 *
 * This is deliberately not trusted on its own: fences, net poles and trouser legs are upright bars too. The caller
 * checks every candidate against the bowler (lib/autocam.ts): a camera under which the bowler is three metres tall or
 * lands ten metres from the crease is not the camera.
 */
import { solveLevelCamera, isCamera, STUMP_TOP, PITCH_LEN, type Camera, type Pt } from "./camcal";

export interface Wicket { base: Pt; top: Pt; h: number; score: number }   // the middle stump: its foot and its top (picture pixels), its height, how sure

interface Level { w: number; h: number; k: number; sat: Float64Array }
/** Luminance at 1/k of the size, as a summed-area table: the mean of any box in four look-ups. */
function level(rgba: Uint8ClampedArray | Uint8Array, w0: number, h0: number, k: number): Level {
  const w = Math.floor(w0 / k), h = Math.floor(h0 / k), sat = new Float64Array((w + 1) * (h + 1)), norm = 1 / (k * k);
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let j = 0; j < k; j++) { let o = ((y * k + j) * w0 + x * k) * 4; for (let i = 0; i < k; i++, o += 4) s += 0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2]; }
      row += s * norm;
      sat[(y + 1) * (w + 1) + x + 1] = sat[y * (w + 1) + x + 1] + row;
    }
  }
  return { w, h, k, sat };
}
/** Mean of the box [x0, x1) x [y0, y1) (clamped to the picture). */
function box(L: Level, x0: number, y0: number, x1: number, y1: number): number {
  const a = Math.max(0, Math.min(L.w, Math.round(x0))), b = Math.max(0, Math.min(L.w, Math.round(x1))), c = Math.max(0, Math.min(L.h, Math.round(y0))), d = Math.max(0, Math.min(L.h, Math.round(y1)));
  if (b <= a || d <= c) return 0;
  const W = L.w + 1, s = L.sat;
  return (s[d * W + b] - s[c * W + b] - s[d * W + a] + s[c * W + a]) / ((b - a) * (d - c));
}

const SPACING = 0.1143 / STUMP_TOP, WIDTH = 0.038 / STUMP_TOP;   // as shares of a stump's height
/** How much the three bars standing on (x, y) with height hs look like a wicket: 0 for nothing, bigger is surer. */
function wicketScore(L: Level, x: number, y: number, hs: number): number {
  const sp = hs * SPACING, wb = Math.max(1, hs * WIDTH), g = Math.max(1, (sp - wb) * 0.7), y0 = y - hs, y1 = y;
  const bar = (cx: number, a: number, b: number) => box(L, cx - wb / 2, a, cx + wb / 2, b);
  const gap = (cx: number, a: number, b: number) => box(L, cx - g / 2, a, cx + g / 2, b);
  // the middle of the stumps' height first: cheapest, and most candidates fall here
  const m0 = y0 + 0.2 * hs, m1 = y1 - 0.15 * hs;
  const gl = gap(x - sp / 2, m0, m1), gr = gap(x + sp / 2, m0, m1), c0 = bar(x, m0, m1) - (gl + gr) / 2;
  if (Math.abs(c0) < 6) return 0;
  const sg = Math.sign(c0), ol = gap(x - 1.5 * sp, m0, m1), or = gap(x + 1.5 * sp, m0, m1);
  const cl = (bar(x - sp, m0, m1) - (ol + gl) / 2) * sg, cr = (bar(x + sp, m0, m1) - (gr + or) / 2) * sg;
  const least = Math.min(c0 * sg, cl, cr);
  if (least < 5) return 0;
  // what is between and beside the bars is one background: the gaps agree with each other
  const even = Math.max(Math.abs(gl - gr), Math.abs(ol - gl), Math.abs(gr - or));
  if (even > 0.9 * least + 6) return 0;
  // the bars run the whole height: the top third and the bottom third each show them too
  const third = (a: number, b: number) => Math.min(bar(x, a, b) - (gap(x - sp / 2, a, b) + gap(x + sp / 2, a, b)) / 2, bar(x - sp, a, b) - (gap(x - 1.5 * sp, a, b) + gap(x - sp / 2, a, b)) / 2,
    bar(x + sp, a, b) - (gap(x + sp / 2, a, b) + gap(x + 1.5 * sp, a, b)) / 2) * sg;   // (the sign makes "paler" and "darker" the same test)
  const upper = third(y0 + 0.04 * hs, y0 + 0.35 * hs), lower = third(y1 - 0.35 * hs, y1 - 0.04 * hs);
  if (Math.min(upper, lower) < 0.45 * least) return 0;
  // and they stop: above the top and below the foot the same columns are background again
  const e = Math.max(2, 0.22 * hs);
  const above = Math.max(0, third(y0 - e, y0 - 1)), below = Math.max(0, third(y1 + 1, y1 + e));
  const ends = Math.max(above, below);
  if (ends > 0.6 * least) return 0;
  return least * (1 - ends / least) / (1 + even / (least + 6));
}

/**
 * The foot and the top of the middle stump to a fraction of a pixel: row by row, how much the three bars stand out
 * from the gaps; each end is where that falls to half of what it is along the stumps.
 */
function ends(L: Level, x: number, y: number, hs: number, score: number): Wicket {
  const sp = hs * SPACING, wb = Math.max(1, hs * WIDTH), g = Math.max(1, (sp - wb) * 0.7);
  const row = (r: number) => {
    const bar = (cx: number) => box(L, cx - wb / 2, r, cx + wb / 2, r + 1), gap = (cx: number) => box(L, cx - g / 2, r, cx + g / 2, r + 1);
    return bar(x - sp) + bar(x) + bar(x + sp) - (gap(x - 1.5 * sp) + 2 * gap(x - sp / 2) + 2 * gap(x + sp / 2) + gap(x + 1.5 * sp)) / 2;
  };
  // each end is where that changes fastest: looked for a third of the height either side of where the search put it
  const lo = Math.round(y - 1.4 * hs), hi = Math.round(y + 0.4 * hs), c: number[] = [];
  for (let r = lo; r <= hi; r++) c.push(row(r));
  const sm = c.map((_, i) => (c[Math.max(0, i - 1)] + 2 * c[i] + c[Math.min(c.length - 1, i + 1)]) / 4);
  const sgn = Math.sign(sm[Math.round(y - 0.5 * hs) - lo]) || 1;
  // how much the bars stand out along the middle half of their height
  const midA = Math.round(y - 0.75 * hs) - lo, midB = Math.round(y - 0.25 * hs) - lo;
  let full = 0;
  for (let i = midA; i < midB; i++) full += sm[i] * sgn;
  full /= Math.max(1, midB - midA);
  const edge = (_around: number, dir: 1 | -1): number => {
    // Walk outwards from the middle of the stumps. The bars carry on while they stand out by at least 40% of that;
    // a short stretch where they do not (a crease painted behind them, a bail's shadow) is stepped over, and the end
    // is the last row before a stretch too long to be one of those. The crossing is placed between rows.
    const from = Math.round(y - 0.5 * hs) - lo, allow = Math.max(2, Math.round(0.12 * hs)), th = 0.4 * full;
    let last = from;
    for (let i = from; i >= 1 && i < sm.length - 1; i += dir) {
      if (sm[i] * sgn >= th) last = i;
      else if (Math.abs(i - last) > allow) break;
    }
    const a = sm[last] * sgn, b = sm[last + dir] * sgn, u = a > b ? Math.max(0, Math.min(1, (a - th) / (a - b))) : 0.5;
    return lo + last + 0.5 + dir * u;   // the middle of row i is at i + 0.5
  };
  const bot = edge(y, 1), top = edge(y - hs, -1), k = L.k;
  return { base: [(x + 0.5) * k, bot * k], top: [(x + 0.5) * k, top * k], h: (bot - top) * k, score };
}

/** Candidates for a wicket anywhere in the picture, best first. */
export function findWickets(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number, max = 40): Wicket[] {
  const out: (Wicket & { L: Level; x: number; y: number; hs: number })[] = [];
  // each size of wicket is looked for on a picture shrunk until a stump is 18 to 46 pixels tall there
  for (let k = 1; Math.min(w, h) / k >= 120; k *= 2) {
    const L = level(rgba, w, h, k);
    const sizes = k === 1 ? [18, 21, 24, 28, 33, 39] : [24, 28, 33, 39];
    for (const hs of sizes) {
      for (let y = hs + 4; y < L.h - 3; y += 2) for (let x = 6; x < L.w - 6; x++) {
        const s = wicketScore(L, x, y, hs);
        if (s <= 0) continue;
        // settle the foot, the height and the place across to the pixel
        let b = { s, x, y, hs };
        for (let pass = 0; pass < 2; pass++) for (const [dx, dy, dh] of [[0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1], [1, 0, 0], [-1, 0, 0], [0, 1, 1], [0, -1, -1], [0, 2, 2], [0, -2, -2], [0, 0, 2], [0, 0, -2]]) {
          const q = wicketScore(L, b.x + dx, b.y + dy, b.hs + dh);
          if (q > b.s) b = { s: q, x: b.x + dx, y: b.y + dy, hs: b.hs + dh };
        }
        out.push({ base: [b.x * k, b.y * k], top: [b.x * k, (b.y - b.hs) * k], h: b.hs * k, score: b.s, L, x: b.x, y: b.y, hs: b.hs });
      }
    }
  }
  out.sort((a, b) => b.score - a.score);
  // one answer for one wicket
  const kept: Wicket[] = [];
  for (const c of out) {
    if (kept.some((q) => Math.abs(q.base[0] - c.base[0]) < 0.5 * Math.max(q.h, c.h) && Math.abs(q.base[1] - c.base[1]) < 0.7 * Math.max(q.h, c.h))) continue;
    kept.push(ends(c.L, c.x, c.y, c.hs, c.score));
    if (kept.length >= max) break;
  }
  return kept;
}

export interface WicketPair { near: Wicket; far: Wicket; cam: Camera; score: number }
/**
 * Two candidates as the two ends of one pitch: the level cameras that explain a bigger wicket below and a smaller one
 * above. A rough camera follows from the two sizes and places alone (the far wicket is 20.12 m beyond the near one,
 * so their sizes give the distance and the zoom, and how far apart their feet are in the picture gives the height and
 * the offset); the exact one is polished from it.
 */
export function pairWickets(c: Wicket[], w: number, h: number, max = 8, nearOk?: (q: Wicket) => boolean): WicketPair[] {
  const out: WicketPair[] = [];
  for (const near of c) {
    if (nearOk && !nearOk(near)) continue;
    for (const far of c) {
      if (far === near || far.h > 0.82 * near.h || far.h < 0.04 * near.h || far.base[1] > near.base[1] - 0.15 * near.h) continue;
      const Dn = PITCH_LEN / (near.h / far.h - 1), Df = Dn + PITCH_LEN, f = (near.h * Dn) / STUMP_TOP, u = f * (1 / Dn - 1 / Df);
      const Y = (near.base[1] - far.base[1]) / u, X = -(near.base[0] - far.base[0]) / u;
      if (!(Dn > 1.2 && Dn < 160) || !(f > 0.3 * w && f < 16 * w) || !(Y > 0.2 && Y < 45) || Math.abs(X) > 0.4 * Dn + 3) continue;
      const tilt = Y / Dn - (near.base[1] - h / 2) / f, yaw = -(near.base[0] - w / 2) / f - X / Dn;
      const cam = solveLevelCamera([{ world: [0, 0, 0], px: near.base }, { world: [0, STUMP_TOP, 0], px: near.top }, { world: [0, 0, -PITCH_LEN], px: far.base }, { world: [0, STUMP_TOP, -PITCH_LEN], px: far.top }], w, h,
        undefined, [[Math.log(f), yaw, tilt, X, Y, Dn]]);
      if (!isCamera(cam) || cam.rms > Math.max(1.5, w / 900)) continue;
      // a camera somebody could have filmed from: off the ground, behind the stumps, a lens between a phone's widest and a broadcast long lens
      if (cam.pos[1] < 0.3 || cam.pos[1] > 40 || cam.pos[2] < 1.2 || cam.pos[2] > 160 || Math.abs(cam.pos[0]) > 0.35 * cam.pos[2] + 3 || cam.f < 0.35 * w || cam.f > 14 * w) continue;
      out.push({ near, far, cam, score: Math.min(near.score, far.score) });
    }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, max);
}
