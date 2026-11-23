/**
 * Find the pitch without being told where it is. The creases are white paint in a pattern the Laws fix: at each end a
 * bowling crease 2.64 m long with a return crease at each tip, and a popping crease 1.22 m in front. Find the pale
 * lines in the picture, try each pair of them as the two bowling creases, and keep the pairing under which the rest
 * of the pattern (both popping creases, all four return creases) lands on paint as well. Then polish the camera
 * against every stretch of paint that can be seen, so a crease corner hidden behind the bowler or the umpire does
 * not matter.
 *
 * The answer is given as the same marks a person would tap, so everything downstream is unchanged, with a score that
 * says how much of the pattern was found. No paint, no answer: nets without creases still need marking by hand.
 */
import { PITCH_LEN, POPPING, RETURN_X, LINE_HALF, project, refineCamera, solveCameraPoints, solveLevelCamera, isCamera, worldOf, type Camera, type Mark, type MarkId, type Pt, type Sight } from "./camcal";
import { solve } from "./lm";
import type { V3 } from "./biomech";

export interface Across { y0: number; m: number; votes: number }   // y = y0 + m (x - w/2), in the picture's own pixels
export interface AutoPitch {
  marks: Mark[];
  cam: Camera;
  score: number;            // 0-1: the share of the crease pattern that lands on paint
  parts: number[];          // the same, for each line of the pattern
  sights: number;
}
/** Roughly where the middle stump stands at each end (picture pixels): two taps that tell the finder where to look. */
export interface PitchHint { near: Pt; far: Pt }
export interface AutoDebug { lines?: Across[]; tried?: number; combos?: number; note?: string[] }

interface Maps { w: number; h: number; k: number; across: Uint8Array; along: Uint8Array; acrossD: Uint8Array; alongD: Uint8Array }

/**
 * Where whiteness (the least of red, green and blue) forms a thin ridge across the picture and along it. Each is
 * looked for after smoothing along the line's own direction, which is what lets a faint, two-pixel crease in a
 * compressed broadcast picture stand clear of the grain of the turf.
 */
function maps(rgba: Uint8ClampedArray | Uint8Array, w0: number, h0: number, k: number, TH: number, inside?: (x: number, y: number) => boolean): Maps {
  const w = Math.floor(w0 / k), h = Math.floor(h0 / k), n = w * h;
  const W = new Float32Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0;
    for (let j = 0; j < k; j++) for (let i = 0; i < k; i++) { const o = ((y * k + j) * w0 + x * k + i) * 4; s += Math.min(rgba[o], rgba[o + 1], rgba[o + 2]); }
    W[y * w + x] = s / (k * k);
  }
  const Sx = new Float32Array(n), Sy = new Float32Array(n), B = 4, C = 2;
  for (let y = 0; y < h; y++) {
    let run = 0;
    for (let x = 0; x < w; x++) { run += W[y * w + x]; if (x > 2 * B) run -= W[y * w + x - 2 * B - 1]; if (x >= 2 * B) Sx[y * w + x - B] = run / (2 * B + 1); }
  }
  for (let x = 0; x < w; x++) {
    let run = 0;
    for (let y = 0; y < h; y++) { run += W[y * w + x]; if (y > 2 * C) run -= W[(y - 2 * C - 1) * w + x]; if (y >= 2 * C) Sy[(y - C) * w + x] = run / (2 * C + 1); }
  }
  const across = new Uint8Array(n), along = new Uint8Array(n);
  for (let y = 8; y < h - 8; y++) for (let x = 8; x < w - 8; x++) {
    const i = y * w + x, a = Sx[i], b = Sy[i];
    if (inside && !inside(x * k, y * k)) continue;
    if (a > 60) for (const d of [2, 4, 7]) if (a - Math.max(Sx[i - d * w], Sx[i + d * w]) > TH) { across[i] = 1; break; }
    if (b > 60) for (const d of [2, 4, 7]) if (b - Math.max(Sy[i - d], Sy[i + d]) > TH) { along[i] = 1; break; }
  }
  const acrossD = new Uint8Array(n), alongD = new Uint8Array(n);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    if (across[i] || across[i - w] || across[i + w]) acrossD[i] = 1;
    if (along[i] || along[i - 1] || along[i + 1]) alongD[i] = 1;
  }
  return { w, h, k, across, along, acrossD, alongD };
}

/** The strongest lines running across the picture (within 12 degrees of level), by counting ridge pixels on each. */
function acrossLines(m: Maps): Across[] {
  const { w, h, across } = m, NA = 97, slopes: number[] = [];
  for (let a = 0; a < NA; a++) slopes.push(Math.tan(((a - (NA - 1) / 2) * 0.25 * Math.PI) / 180));
  const pad = Math.ceil(0.22 * w), rows = h + 2 * pad, acc = new Uint16Array(NA * rows);
  for (let y = 0; y < h; y++) for (let x = (y & 1); x < w; x += 2) {
    if (!across[y * w + x]) continue;   // (x + y) even: half the pixels are plenty
    const dx = x - w / 2;
    for (let a = 0; a < NA; a++) { const r = Math.round(y - slopes[a] * dx) + pad; if (acc[a * rows + r] < 65535) acc[a * rows + r]++; }
  }
  // strongest first; each one's pixels are then taken back out of the count, so that a bold crease does not come
  // up again and again at slightly different tilts and crowd out the faint one next to it
  const out: Across[] = [], min = 0.03 * w / 2, gone = new Uint8Array(w * h);
  for (let it = 0; it < 44; it++) {
    let bv = 0, ba = 0, br = 0;
    for (let a = 0; a < NA; a++) for (let r = 0; r < rows; r++) { const v = acc[a * rows + r]; if (v > bv) { bv = v; ba = a; br = r; } }
    if (bv < min) break;
    const y0 = br - pad, sl = slopes[ba];
    out.push({ y0, m: sl, votes: bv * 2 });
    for (let x = 0; x < w; x++) {
      const yc = Math.round(y0 + sl * (x - w / 2));
      for (let y = yc - 2; y <= yc + 2; y++) {
        if (y < 0 || y >= h || ((x + y) & 1) || !across[y * w + x] || gone[y * w + x]) continue;
        gone[y * w + x] = 1;
        const dx = x - w / 2;
        for (let a = 0; a < NA; a++) { const r = Math.round(y - slopes[a] * dx) + pad; if (acc[a * rows + r] > 0) acc[a * rows + r]--; }
      }
    }
  }
  return out;
}

interface Ret { u: number; s: number; score: number }
/**
 * Return creases at one end: short pale lines running up the picture that cross the bowling crease, reach the popping
 * crease and carry on behind the bowling crease. `u` is where one crosses the bowling crease, `s` how it leans. A wide
 * guide line or a stump covers the stretch between the creases but not the stretch behind, and is not taken.
 */
function returns(m: Maps, bowl: Across, pop: Across): Ret[] {
  const { w, h, alongD } = m, yb = (x: number) => bowl.y0 + bowl.m * (x - w / 2), yp = (x: number) => pop.y0 + pop.m * (x - w / 2);
  const best: Ret[] = [];
  // how many upright-ridge pixels each column holds in the band the creases span: where there are too few within
  // reach of `u` for any lean to pass, the leans need not be tried (most of the picture, most of the time)
  const gm = yp(w / 2) - yb(w / 2), y0 = Math.max(0, Math.floor(Math.min(yb(0), yb(w), yp(0), yp(w)) - 0.8 * Math.abs(gm))), y1 = Math.min(h - 1, Math.ceil(Math.max(yb(0), yb(w), yp(0), yp(w)) + 0.8 * Math.abs(gm)));
  const cum = new Int32Array(w + 1);
  for (let x = 0; x < w; x++) { let c = 0; for (let y = y0; y <= y1; y++) c += alongD[y * w + x]; cum[x + 1] = cum[x] + c; }
  for (let u = 4; u < w - 4; u++) {
    const b = yb(u), g = yp(u) - b, N = Math.max(10, Math.round(Math.abs(g) * 1.7));
    const reach = Math.ceil(0.6 * Math.abs(g)) + 2, lo = Math.max(0, u - reach), hi = Math.min(w, u + reach + 1);
    if (cum[hi] - cum[lo] < 0.4 * N) continue;
    let top: Ret | null = null;
    for (let si = -12; si <= 12; si++) {
      const s = si * 0.05;
      let inH = 0, inT = 0, outH = 0, outT = 0;
      for (let i = 0; i <= N; i++) {
        const tau = -0.7 + (1.7 * i) / N;
        if (Math.abs(tau) < 0.12 || tau > 0.88) continue;
        const y = Math.round(b + tau * g), x = Math.round(u + s * (tau * g));
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const hit = alongD[y * w + x];
        if (tau > 0) { inT++; inH += hit; } else { outT++; outH += hit; }
      }
      if (inT < 3 || outT < 2) continue;
      const sc = Math.min(inH / inT, outH / outT);
      if (!top || sc > top.score) top = { u, s, score: sc };
    }
    if (top && top.score >= 0.55) best.push(top);
  }
  // one per crease: the best within six pixels
  best.sort((p, q) => q.score - p.score);
  const out: Ret[] = [];
  for (const r of best) { if (!out.some((o) => Math.abs(o.u - r.u) < 7)) out.push(r); if (out.length >= 10) break; }
  return out.sort((p, q) => p.u - q.u);
}

/**
 * The same, quickly, for a camera of any height and distance (so return creases that may lean a long way) and only
 * where they can be: `ranges` are the stretches of the bowling crease a return crease may cross. Rather than try
 * every lean at every column, a return crease is proposed from two of its own points: a pale upright stroke on a row
 * behind the bowling crease, and one on a row between the creases. Each such pair is one line, and is then scored
 * along its whole length as above.
 */
function returnsFast(m: Maps, bowl: Across, pop: Across, ranges: [number, number][], maxLean: number): Ret[] {
  const { w, h, alongD } = m, yb = (x: number) => bowl.y0 + bowl.m * (x - w / 2), yp = (x: number) => pop.y0 + pop.m * (x - w / 2);
  const best: Ret[] = [];
  /** the middles of the runs of upright-ridge pixels on a row (and the rows either side), between two columns */
  const strokes = (row: number, x0: number, x1: number): number[] => {
    const out: number[] = [], a = Math.max(1, Math.floor(x0)), b = Math.min(w - 2, Math.ceil(x1));
    if (row < 1 || row >= h - 1) return out;
    let start = -1;
    for (let x = a; x <= b + 1; x++) {
      const on = x <= b && (alongD[row * w + x] || alongD[(row - 1) * w + x] || alongD[(row + 1) * w + x]);
      if (on && start < 0) start = x;
      if (!on && start >= 0) { out.push((start + x - 1) / 2); start = -1; }
    }
    return out;
  };
  for (const [lo, hi] of ranges) {
    const uc = (lo + hi) / 2, b0 = yb(uc), g0 = yp(uc) - b0, reach = maxLean * Math.abs(g0);
    if (Math.abs(g0) < 2) continue;
    const xa = strokes(Math.round(b0 - 0.5 * g0), lo - 0.5 * reach - 2, hi + 0.5 * reach + 2), xb = strokes(Math.round(b0 + 0.6 * g0), lo - 0.6 * reach - 2, hi + 0.6 * reach + 2);
    if (xa.length > 60 || xb.length > 60) continue;   // a patch of texture, not a pitch
    for (const A of xa) for (const B of xb) {
      const s = (B - A) / (1.1 * g0);
      if (Math.abs(s) > maxLean) continue;
      const u = A + s * 0.5 * g0;
      if (u < lo || u > hi || u < 4 || u > w - 4) continue;
      const b = yb(u), g = yp(u) - b, N = Math.max(10, Math.min(72, Math.round(Math.abs(g) * 1.7)));
      let inH = 0, inT = 0, outH = 0, outT = 0;
      for (let i = 0; i <= N; i++) {
        const tau = -0.7 + (1.7 * i) / N;
        if (Math.abs(tau) < 0.12 || tau > 0.88) continue;
        const y = Math.round(b + tau * g), x = Math.round(u + s * (tau * g));
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const hit = alongD[y * w + x];
        if (tau > 0) { inT++; inH += hit; } else { outT++; outH += hit; }
      }
      if (inT < 3 || outT < 2) continue;
      const sc = Math.min(inH / inT, outH / outT);
      if (sc >= 0.55) best.push({ u, s, score: sc });
    }
  }
  best.sort((p, q) => q.score - p.score);
  const out: Ret[] = [];
  for (const r of best) { if (!out.some((o) => Math.abs(o.u - r.u) < 7)) out.push(r); if (out.length >= 12) break; }
  return out.sort((p, q) => p.u - q.u);
}

/** Ground (x, z) to picture, from four matches. */
function homography(g: [number, number][], p: Pt[]): number[] | null {
  const A: number[][] = [], b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [x, z] = g[i], [u, v] = p[i];
    A.push([x, z, 1, 0, 0, 0, -u * x, -u * z]); b.push(u);
    A.push([0, 0, 0, x, z, 1, -v * x, -v * z]); b.push(v);
  }
  const s = solve(A, b);
  return s ? [...s, 1] : null;
}
const viaH = (H: number[], x: number, z: number): Pt | null => {
  const d = H[6] * x + H[7] * z + H[8];
  return Math.abs(d) < 1e-9 ? null : [(H[0] * x + H[1] * z + H[2]) / d, (H[3] * x + H[4] * z + H[5]) / d];
};

/** The pattern: each line as two ends on the ground, and whether it runs across or along the pitch. */
interface Line { a: [number, number]; b: [number, number]; across: boolean; weight: number }
const X = RETURN_X + LINE_HALF;
function pattern(): Line[] {
  const out: Line[] = [];
  for (const [z0, to] of [[0, -1], [-PITCH_LEN, 1]] as const) {
    const zb = z0 + to * LINE_HALF, zp = z0 + to * (POPPING + LINE_HALF);
    out.push({ a: [-X, zb], b: [X, zb], across: true, weight: 1 });
    out.push({ a: [-X, zp], b: [X, zp], across: true, weight: 1 });
    for (const s of [-1, 1]) out.push({ a: [s * X, zp], b: [s * X, z0 - to * 0.9], across: false, weight: 0.5 });
  }
  return out;
}
const PATTERN = pattern();

function support(m: Maps, at: (x: number, z: number) => Pt | null): { parts: number[]; score: number } {
  const parts: number[] = [];
  const share = (ax: number, az: number, bx: number, bz: number, mask: Uint8Array, N: number) => {
    let hit = 0, tot = 0;
    for (let i = 0; i <= N; i++) {
      const t = i / N, p = at(ax + (bx - ax) * t, az + (bz - az) * t);
      if (!p) continue;
      const x = Math.round(p[0] / m.k), y = Math.round(p[1] / m.k);
      tot++;
      if (x >= 0 && y >= 0 && x < m.w && y < m.h && mask[y * m.w + x]) hit++;
    }
    return tot ? hit / tot : 0;
  };
  let num = 0, den = 0;
  for (const l of PATTERN) { const sh = share(l.a[0], l.a[1], l.b[0], l.b[1], l.across ? m.acrossD : m.alongD, 60); parts.push(sh); num += sh * l.weight; den += l.weight; }
  // what must not be there: a bowling crease stops at the return creases, and a return crease stops at the popping
  // crease. Paint that carries on past either is some other line (a wide guide, a boundary, a caption).
  let wrong = 0, worst = 0;
  for (const [z0, to] of [[0, -1], [-PITCH_LEN, 1]] as const) {
    const zb = z0 + to * LINE_HALF, zp = z0 + to * (POPPING + LINE_HALF);
    for (const sd of [-1, 1]) {
      const on = share(sd * (X + 0.3), zb, sd * (X + 0.9), zb, m.acrossD, 14), up = share(sd * X, zp + to * 0.3, sd * X, zp + to * 0.9, m.alongD, 14);
      wrong += on + up; worst = Math.max(worst, on);
    }
  }
  // a bowling crease that plainly runs on past its "return crease" means that upright line is something else (a wide
  // guide line, the stumps): the pattern has been laid over part of the pitch, at the wrong size
  return { parts, score: worst > 0.6 ? 0 : num / den - 0.35 * (wrong / 8) };
}

/** Along a normal through `p`, the middle of the nearest pale ridge within `reach` pixels (full-size picture). */
function ridgeNear(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number, p: Pt, n: Pt, reach: number): Pt | null {
  const val = (x: number, y: number) => {
    const xi = Math.round(x), yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= w || yi >= h) return -1;
    const o = (yi * w + xi) * 4; return Math.min(rgba[o], rgba[o + 1], rgba[o + 2]);
  };
  const R = Math.ceil(reach), v: number[] = [];
  for (let s = -R - 4; s <= R + 4; s++) { const q = val(p[0] + n[0] * s, p[1] + n[1] * s); if (q < 0) return null; v.push(q); }
  const sorted = v.slice().sort((a, b) => a - b), base = sorted[Math.floor(v.length * 0.3)];
  let best = -1, bi = 0;
  for (let i = 4; i < v.length - 4; i++) if (v[i] > best) { best = v[i]; bi = i; }
  if (best - base < 14) return null;
  const half = base + 0.5 * (best - base);
  let lo = bi, hi = bi;
  while (lo > 0 && v[lo - 1] > half) lo--;
  while (hi < v.length - 1 && v[hi + 1] > half) hi++;
  if (lo === 0 || hi === v.length - 1 || hi - lo > reach * 1.2 + 6) return null;
  let sw = 0, ss = 0;
  for (let i = lo; i <= hi; i++) { sw += v[i] - half; ss += (v[i] - half) * i; }
  const c = ss / sw - (R + 4);
  return [p[0] + n[0] * c, p[1] + n[1] * c];
}

const CORNERS: MarkId[] = (["bowler", "batter"] as const).flatMap((end) => (["pop_l", "pop_r", "bowl_l", "bowl_r"] as const).map((kind) => ({ end, kind })));

/** How much of the strip between the creases is grass-green. A pitch is rolled earth or straw-coloured turf. */
function grassy(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number, H: number[]): number {
  let green = 0, tot = 0;
  for (let i = 0; i < 12; i++) for (let j = 0; j < 5; j++) {
    const p = viaH(H, -1 + 0.5 * j, -2 - (16 * i) / 11);
    if (!p) continue;
    const x = Math.round(p[0]), y = Math.round(p[1]);
    if (x < 0 || y < 0 || x >= w || y >= h) { tot++; green++; continue; }
    const o = (y * w + x) * 4;
    tot++;
    if (rgba[o + 1] - Math.max(rgba[o], rgba[o + 2]) > 14) green++;
  }
  return tot ? green / tot : 1;
}

/** The one-dimensional map from distance down the pitch to height in the picture, from three matches. */
function depthMap(s: number[], y: number[]): ((d: number) => number) | null {
  // y = (a d + b) / (c d + 1)
  const A = [0, 1, 2].map((i) => [s[i], 1, -s[i] * y[i]]), q = solve(A, [y[0], y[1], y[2]]);
  return q ? (d) => (q[0] * d + q[1]) / (q[2] * d + 1) : null;
}

/**
 * Find the pitch in one frame. The near end (lower in the picture) is taken as the bowler's; a camera behind the
 * batter gives the same answer with the ends named the other way round, which the caller can swap.
 */
export function findPitch(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number, hint?: PitchHint | null, dbg?: AutoDebug): AutoPitch | null {
  let best: AutoPitch | null = null;
  // thin lines at full size; fat ones (a phone close behind the stumps) at a third. With a hint the clutter is kept
  // out, so fainter paint can be let in on a second look.
  const scales = w >= 1200 ? [1, 3] : [1, 2];
  for (const th of hint ? [6, 3.5] : [6]) for (const k of scales) {
    const r = findAt(rgba, w, h, k, th, hint ?? null, dbg), was: number = best ? (best as AutoPitch).score : -1;
    if (r && r.score > was) best = r;
    if (best && (best as AutoPitch).score >= 0.72) break;
  }
  if (!best) return null;
  // the last word is the paint at full size, however coarsely it was first found
  const b: AutoPitch = best, fine = polish(rgba, w, h, b.cam, 1, [3]), marks = CORNERS.map((id) => ({ ...id, px: project(fine.cam, worldOf(id)) }));
  if (fine.sights >= 0.6 * b.sights && marks.every((q) => q.px)) return { ...b, cam: fine.cam, marks: marks as Mark[], sights: fine.sights };
  return b;
}

/** Polish a camera against the paint itself: each stretch of crease it can find near where the camera puts it. */
function polish(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number, start: Camera, k: number, reaches = [7, 4]): { cam: Camera; sights: number } {
  let cam = start, count = 0;
  for (const reach of reaches) {
    const sights: Sight[] = [];
    for (const l of PATTERN) {
      const N = 28;
      for (let i = 1; i < N; i++) {
        const t = i / N, g: V3 = [l.a[0] + (l.b[0] - l.a[0]) * t, 0, l.a[1] + (l.b[1] - l.a[1]) * t];
        const g2: V3 = [g[0] + (l.b[0] - l.a[0]) * 0.02, 0, g[2] + (l.b[1] - l.a[1]) * 0.02];
        const p = project(cam, g), p2 = project(cam, g2);
        if (!p || !p2) continue;
        const dx = p2[0] - p[0], dy = p2[1] - p[1], dn = Math.hypot(dx, dy);
        if (dn < 1e-6) continue;
        const n: Pt = [-dy / dn, dx / dn], hit = ridgeNear(rgba, w, h, p, n, reach * k);
        if (hit) sights.push({ world: g, px: hit, n });
      }
    }
    const r = refineCamera(cam, sights, 2.5 * k);
    if (!r) break;
    cam = r; count = sights.length;
  }
  return { cam, sights: count };
}

function findAt(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number, k: number, th: number, hint: PitchHint | null, dbg?: AutoDebug): AutoPitch | null {
  // with a hint, look only around the pitch it points at: captions, boundary ropes and the next strip are left out
  const R = Math.max(10, 0.02 * w);
  let inside: ((x: number, y: number) => boolean) | undefined;
  if (hint) {
    const D = Math.hypot(hint.near[0] - hint.far[0], hint.near[1] - hint.far[1]), ax = (hint.near[0] - hint.far[0]) / (hint.near[1] - hint.far[1] || 1);
    const top = Math.min(hint.near[1], hint.far[1]) - 0.12 * D - 2 * R, bot = Math.max(hint.near[1], hint.far[1]) + 0.3 * D + 2 * R, half = 0.75 * D + 0.1 * w;
    inside = (x, y) => y >= top && y <= bot && Math.abs(x - (hint.far[0] + ax * (y - hint.far[1]))) <= half;
  }
  const m = maps(rgba, w, h, k, th, inside), lines = acrossLines(m).sort((p, q) => q.y0 - p.y0);
  if (dbg) { dbg.lines = lines.map((l) => ({ y0: l.y0 * k, m: l.m, votes: l.votes })); dbg.note = dbg.note ?? []; }
  const S = [LINE_HALF, POPPING + LINE_HALF, PITCH_LEN - POPPING - LINE_HALF, PITCH_LEN - LINE_HALF];
  const zN = -LINE_HALF, zF = -PITCH_LEN + LINE_HALF, cx = m.w / 2;
  // four lines whose spacing is the creases' spacing seen in perspective
  const combos: { i: number[]; votes: number }[] = [];
  const n = lines.length;
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) {
    const g1 = lines[a].y0 - lines[b].y0;
    if (hint && Math.abs((lines[a].y0 + lines[a].m * (hint.near[0] / k - cx)) * k - hint.near[1]) > R) continue;
    if (lines[a].y0 > m.h || lines[b].y0 < 0 || g1 < 3 || g1 > 0.3 * m.h || Math.abs(lines[a].m - lines[b].m) > 0.03) continue;
    for (let c = b + 1; c < n; c++) {
      if (lines[b].y0 - lines[c].y0 < Math.max(2.5 * g1, 0.15 * m.h) || Math.abs(lines[a].m - lines[c].m) > 0.06) continue;
      for (let d = c + 1; d < n; d++) {
        const g2 = lines[c].y0 - lines[d].y0;
        if (hint && Math.abs((lines[d].y0 + lines[d].m * (hint.far[0] / k - cx)) * k - hint.far[1]) > R) continue;
        if (g2 < 2 || g2 > g1 * 1.02 || Math.abs(lines[c].m - lines[d].m) > 0.03) continue;
        const f = depthMap(S.slice(0, 3), [lines[a].y0, lines[b].y0, lines[c].y0]);
        if (!f) continue;
        if (Math.abs(f(S[3]) - lines[d].y0) > Math.max(1.5, 0.12 * g2)) continue;
        combos.push({ i: [a, b, c, d], votes: lines[a].votes + lines[b].votes + lines[c].votes + lines[d].votes });
      }
    }
  }
  // a bowling crease is often hidden (the far one behind the batter and keeper, the near one behind the umpire):
  // three creases fix where the fourth must be, so try each trio with the missing one filled in
  const nearHint = (l: Across) => !hint || Math.abs((l.y0 + l.m * (hint.near[0] / k - cx)) * k - hint.near[1]) <= R;
  const farHint = (l: Across) => !hint || Math.abs((l.y0 + l.m * (hint.far[0] / k - cx)) * k - hint.far[1]) <= R;
  const real = n, add = (l: Across) => { const at = lines.findIndex((o, i) => i >= real && Math.abs(o.y0 - l.y0) < 1.5 && Math.abs(o.m - l.m) < 0.01); if (at >= 0) return at; lines.push(l); return lines.length - 1; };
  for (let b = 0; b < real; b++) for (let c = b + 1; c < real; c++) {
    if (lines[b].y0 - lines[c].y0 < 0.15 * m.h || Math.abs(lines[b].m - lines[c].m) > 0.06) continue;
    // far bowling crease missing: near bowl a, near pop b, far pop c
    for (let a = 0; a < b; a++) {
      const g1 = lines[a].y0 - lines[b].y0;
      if (g1 < 3 || g1 > 0.3 * m.h || lines[b].y0 - lines[c].y0 < 2.5 * g1 || Math.abs(lines[a].m - lines[b].m) > 0.03 || !nearHint(lines[a])) continue;
      const f = depthMap(S.slice(0, 3), [lines[a].y0, lines[b].y0, lines[c].y0]);
      if (!f) continue;
      const y = f(S[3]), g2 = lines[c].y0 - y;
      if (!(g2 >= 2 && g2 <= g1 * 1.02)) continue;
      const l = { y0: y, m: lines[c].m, votes: 0 };
      if (!farHint(l) || lines.slice(0, real).some((o) => Math.abs(o.y0 - y) < 2.5)) continue;
      combos.push({ i: [a, b, c, add(l)], votes: lines[a].votes + lines[b].votes + lines[c].votes });
    }
    // near bowling crease missing: near pop b, far pop c, far bowl d
    for (let d = c + 1; d < real; d++) {
      const g2 = lines[c].y0 - lines[d].y0;
      if (g2 < 2 || Math.abs(lines[c].m - lines[d].m) > 0.03 || !farHint(lines[d])) continue;
      const f = depthMap(S.slice(1), [lines[b].y0, lines[c].y0, lines[d].y0]);
      if (!f) continue;
      const y = f(S[0]), g1 = y - lines[b].y0;
      if (!(g1 >= g2 / 1.02 && g1 <= 0.3 * m.h) || lines[b].y0 - lines[c].y0 < 2.5 * g1) continue;
      const l = { y0: y, m: lines[b].m, votes: 0 };
      if (!nearHint(l) || lines.slice(0, real).some((o) => Math.abs(o.y0 - y) < 2.5)) continue;
      combos.push({ i: [add(l), b, c, d], votes: lines[b].votes + lines[c].votes + lines[d].votes });
    }
  }
  combos.sort((p, q) => q.votes - p.votes);
  const cache = new Map<string, Ret[]>(), rets = (bi: number, pi: number) => {
    const key = bi + ":" + pi; let r = cache.get(key);
    if (!r) { r = returns(m, lines[bi], lines[pi]); cache.set(key, r); }
    return r;
  };
  const at = (l: Across, u: number): Pt => [u * k, (l.y0 + l.m * (u - cx)) * k];
  const hyps: { score: number; parts: number[]; H: number[] }[] = [];
  let tried = 0;
  for (const co of combos.slice(0, 60)) {
    const [a, b, c, d] = co.i, near = rets(a, b), far = rets(d, c);
    const g1 = lines[a].y0 - lines[b].y0, g2 = lines[c].y0 - lines[d].y0;
    for (let i = 0; i < near.length; i++) for (let j = i + 1; j < near.length; j++) {
      const wn = near[j].u - near[i].u;
      if (wn < 2 * g1 || wn < 0.09 * m.w) continue;
      if (hint && Math.abs((near[i].u + near[j].u) / 2 * k - hint.near[0]) > 0.12 * wn * k + R) continue;
      for (let p = 0; p < far.length; p++) for (let q = p + 1; q < far.length; q++) {
        const wf = far[q].u - far[p].u;
        if (wf < 2 * g2 || wf > wn * 1.02 || wf < wn * 0.08) continue;
        if (hint && Math.abs((far[p].u + far[q].u) / 2 * k - hint.far[0]) > 0.12 * wf * k + R) continue;
        const H = homography([[-X, zN], [X, zN], [-X, zF], [X, zF]], [at(lines[a], near[i].u), at(lines[a], near[j].u), at(lines[d], far[p].u), at(lines[d], far[q].u)]);
        if (!H || grassy(rgba, w, h, H) > 0.35) continue;
        tried++;
        const s = support(m, (x, z) => viaH(H, x, z));
        if (Math.min(s.parts[0], s.parts[1], s.parts[4], s.parts[5]) < (hint ? 0.15 : 0.35)) continue;
        hyps.push({ ...s, H });
      }
    }
  }
  hyps.sort((a, b) => b.score - a.score);
  if (dbg) { dbg.tried = tried; dbg.combos = combos.length; dbg.note!.push(`scale ${k}: lines ${lines.length} combos ${combos.length} pairings ${tried} kept ${hyps.length}`); }
  let best: AutoPitch | null = null;
  for (const hy of hyps.slice(0, 4)) {
    const pts = CORNERS.map((id) => { const wd = worldOf(id); return { world: wd, px: viaH(hy.H, wd[0], wd[2])! }; });
    let cam = solveCameraPoints(pts, w, h);
    if (!isCamera(cam) || cam.rms > 6) { dbg?.note?.push("no camera for a pairing: " + (isCamera(cam) ? "rms " + cam.rms.toFixed(1) : cam.text)); continue; }
    const pol = polish(rgba, w, h, cam, k), sights = pol.sights;
    cam = pol.cam;
    if (!isCamera(cam)) continue;
    const c2: Camera = cam, s = support(m, (x, z) => project(c2, [x, 0, z]));
    if (dbg) dbg.note!.push(`pairing ${hy.score.toFixed(2)} -> polished ${s.score.toFixed(2)} sights ${sights} rms ${c2.rms.toFixed(2)} pos ${c2.pos.map((v) => v.toFixed(1))} f ${c2.f.toFixed(0)}`);
    // the camera must be behind the near end, above the ground, somewhere a camera could be, with a lens that exists
    if (Math.abs(c2.R[1]) > 0.1) continue;   // and held level: a camera's sideways axis has no business pointing up or down
    if (c2.pos[2] < 1 || c2.pos[2] > 200 || c2.pos[1] < 0.3 || c2.pos[1] > 80 || Math.abs(c2.pos[0]) > 40 || c2.f < 0.25 * w || c2.f > 30 * w) continue;
    if (!best || s.score > best.score) {
      const marks = CORNERS.map((id) => ({ ...id, px: project(c2, worldOf(id))! }));
      if (marks.some((q) => !q.px)) continue;
      best = { marks, cam: c2, score: s.score, parts: s.parts, sights };
    }
  }
  return best;
}

/**
 * Good enough to use. Without a hint the bar is high (most of the pattern on paint at both ends, a tight fit), since
 * nobody has pointed at the pitch; with two taps saying where it is, a little less will do.
 */
export const pitchFound = (a: AutoPitch | null, hinted = false): a is AutoPitch => {
  if (!a || a.score < (hinted ? 0.6 : 0.7) || a.cam.rms >= Math.max(2.5, a.cam.w / 500)) return false;
  if (Math.min(a.parts[0], a.parts[4]) < (hinted ? 0.4 : 0.5) || Math.min(a.parts[1], a.parts[5]) < (hinted ? 0.4 : 0.5)) return false;
  // the return creases are what fix the pitch's width: all four when nobody has pointed, three of four with taps
  const rets = [a.parts[2], a.parts[3], a.parts[6], a.parts[7]].sort((p, q) => p - q);
  return hinted ? rets[1] >= 0.5 : rets[0] >= 0.7;
};

/**
 * The same polish from a camera found some other way (lib/stumpfind.ts: the two wickets give a camera good to a few
 * per cent): slide it onto the painted creases, and say how much of the crease pattern then lands on paint. Null when
 * there is too little paint near where that camera puts the creases to hold on to.
 */
export function polishPitch(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number, start: Camera): AutoPitch | null {
  let best: AutoPitch | null = null;
  for (const k of w >= 1200 ? [1, 3] : [1, 2]) {
    const pol = polish(rgba, w, h, start, k, [14, 8, 4]), c = pol.cam;
    if (pol.sights < 40 || !isCamera(c) || Math.abs(c.R[1]) > 0.1 || c.pos[1] < 0.3) continue;
    const m = maps(rgba, w, h, k, 5), s = support(m, (x, z) => project(c, [x, 0, z]));
    const marks = CORNERS.map((id) => ({ ...id, px: project(c, worldOf(id))! }));
    if (marks.some((q) => !q.px)) continue;
    if (!best || s.score > best.score) best = { marks, cam: c, score: s.score, parts: s.parts, sights: pol.sights };
  }
  return best;
}

export interface NearCreases { marks: Mark[]; score: number; cam: Camera; sights: number; least: number; per: number[] }   // least: the fewest sightings of paint on any one of the four lines
/**
 * The creases at the bowler's end alone, found around a place to look: the foot of the middle stump when the wicket
 * was found (lib/stumpfind.ts), or the bowler's own feet when it was not. `size` is about a stump's height in the
 * picture there. This end is the one that can always be read: a phone ten metres behind the stumps sees the far
 * creases a fraction of a pixel thick, and this end's two or three pixels thick. And this end is where the bowler is
 * measured: a camera worked out from the bowling crease, the popping crease and the two return creases here places a
 * hand above them to within a centimetre, whatever it thinks of the far end (tests/onpitch.test.ts).
 *
 * `exact`: the place given is the foot of the stumps (the bowling crease passes through it and the return creases
 * are 1.32 m either side). Otherwise it is only near them.
 */
export function findNearCreases(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number, at: Pt, size: number, exact: boolean): NearCreases | null {
  type Found = { c: Record<"pop_l" | "pop_r" | "bowl_l" | "bowl_r", Pt>; score: number };
  const pick: { best: Found | null } = { best: null };
  // only the patch of the picture this end can be in is looked at
  const X0 = Math.max(0, Math.floor(at[0] - 6.5 * size)), X1 = Math.min(w, Math.ceil(at[0] + 6.5 * size)), Y0 = Math.max(0, Math.floor(at[1] - 3.2 * size)), Y1 = Math.min(h, Math.ceil(at[1] + 2.6 * size));
  const cw = X1 - X0, ch = Y1 - Y0;
  if (cw < 40 || ch < 24) return null;
  const crop = new Uint8Array(cw * ch * 4);
  for (let y = 0; y < ch; y++) crop.set(rgba.subarray(((Y0 + y) * w + X0) * 4, ((Y0 + y) * w + X1) * 4), y * cw * 4);
  const ax = at[0] - X0, ay = at[1] - Y0;
  // at sizes where a stump is about 80 and about 45 pixels tall: the creases across are thin and want the larger,
  // the return creases are fat seen from close behind and want the smaller
  const scales = [...new Set([Math.max(1, Math.round(size / 80)), Math.max(1, Math.round(size / 45))])];
  for (const th of [6, 3.5]) {
    for (const k of scales) {
      if (cw / k < 30 || ch / k < 18) continue;
      const m = maps(crop, cw, ch, k, th), lines = acrossLines(m).slice(0, exact ? 44 : 14);   // (strongest first)
      const Y = (l: Across, x: number) => k * (l.y0 + l.m * (x / k - m.w / 2));   // a line's height at x, crop pixels
      for (const bowl of lines) {
        const db = Y(bowl, ax) - ay;
        if (exact ? Math.abs(db) > Math.max(4, 0.22 * size) : Math.abs(db) > 1.6 * size) continue;
        for (const pop of lines) {
          const gap = Y(bowl, ax) - Y(pop, ax);   // the popping crease is further from the camera: higher in the picture
          if (pop === bowl || gap < Math.max(3, 0.05 * size) || gap > 2.2 * size || Math.abs(pop.m - bowl.m) > 0.07) continue;
          // where the return creases can cross the bowling crease: 1.32 m either side of the stumps, which is 1.6 to 2.5
          // stump-heights (more, the more steeply the camera looks down); anywhere near, when the stumps were not found
          const ranges: [number, number][] = exact ? [[(ax - 2.6 * size) / k, (ax - 1.5 * size) / k], [(ax + 1.5 * size) / k, (ax + 2.6 * size) / k]] : [[(ax - 5 * size) / k, (ax + 5 * size) / k]];
          const rets = returnsFast(m, bowl, pop, ranges, 2.6);
          for (const L of rets) for (const R of rets) {
            const xl = L.u * k, xr = R.u * k, wide = xr - xl;
            // the return creases are 2.68 m apart (their middles), a stump 71 cm tall: 3.4 to 4.9 stump-heights apart
            if (wide < 3.2 * size || wide > 4.9 * size) continue;
            // and they lean towards each other going away from the camera, or stand parallel (a long lens): never apart
            if (R.s - L.s < -0.12) continue;
            const mid = (xl + xr) / 2;
            if (exact ? Math.abs(mid - ax) > 0.5 * size : Math.abs(mid - ax) > 2.6 * size) continue;
            const corner = (r: Ret): [Pt, Pt] => {
              const g = (pop.y0 + pop.m * (r.u - m.w / 2)) - (bowl.y0 + bowl.m * (r.u - m.w / 2)), xp = r.u + r.s * g;
              return [[r.u * k + X0, Y(bowl, r.u * k) + Y0], [xp * k + X0, Y(pop, xp * k) + Y0]];
            };
            const [bl, pl] = corner(L), [br, pr] = corner(R);
            const score = Math.min(L.score, R.score) * (1 - (0.3 * Math.abs(mid - ax)) / (exact ? 0.5 * size : 2.6 * size)) + 0.02 * Math.min(10, (bowl.votes + pop.votes) / (0.1 * cw / k));
            if (!pick.best || score > pick.best.score) pick.best = { c: { pop_l: pl, pop_r: pr, bowl_l: bl, bowl_r: br }, score };
          }
        }
      }
    }
    if (pick.best && pick.best.score > 0.8) break;
  }
  const best = pick.best;
  if (!best) return null;
  const marks: Mark[] = (["pop_l", "pop_r", "bowl_l", "bowl_r"] as const).map((kind) => ({ end: "bowler" as const, kind, px: best.c[kind] }));
  // a camera from the four corners, then slid onto the paint of the four lines themselves (a hundred points, each
  // good to a fraction of a pixel, against four corners read off two crossing lines)
  const c0 = solveCameraPoints(marks.map((q) => ({ world: worldOf(q), px: q.px })), w, h);
  if (!isCamera(c0)) return null;
  let cam: Camera = c0, count = 0, rms = 99, least = 0, perLine: number[] = [];
  // How far to look for the paint either side of where the camera puts a line. The first camera, from four corners
  // read off crossing lines, can have a crease several pixels out, and a line that finds no paint at the start is
  // never pulled in: so the first look is wide (but under half the gap between the two creases across, so that one
  // is never taken for the other), and the later ones close in.
  const gapPx = Math.min(Math.hypot(best.c.pop_l[0] - best.c.bowl_l[0], best.c.pop_l[1] - best.c.bowl_l[1]), Math.hypot(best.c.pop_r[0] - best.c.bowl_r[0], best.c.pop_r[1] - best.c.bowl_r[1]));
  const wideR = Math.max(5, Math.min(0.38 * gapPx, Math.max(9, 0.13 * size))), fat = Math.max(6, 0.075 * size);
  for (const reach of [wideR, Math.min(wideR, fat), Math.min(wideR, fat), Math.max(4, Math.min(wideR, 0.6 * fat)), Math.max(3, Math.min(wideR, 0.4 * fat))]) {
    const sights: Sight[] = [], per: number[] = [];
    for (const l of PATTERN.slice(0, 4)) {
      const N = 36;
      let got = 0;
      for (let i = 1; i < N; i++) {
        const t = i / N, g: V3 = [l.a[0] + (l.b[0] - l.a[0]) * t, 0, l.a[1] + (l.b[1] - l.a[1]) * t];
        const g2: V3 = [g[0] + (l.b[0] - l.a[0]) * 0.02, 0, g[2] + (l.b[1] - l.a[1]) * 0.02];
        const p = project(cam, g), p2 = project(cam, g2);
        if (!p || !p2) continue;
        const dx = p2[0] - p[0], dy = p2[1] - p[1], dn = Math.hypot(dx, dy);
        if (dn < 1e-6) continue;
        const n: Pt = [-dy / dn, dx / dn], hit = ridgeNear(rgba, w, h, p, n, reach);
        if (hit) { sights.push({ world: g, px: hit, n }); got++; }
      }
      per.push(got);
    }
    if (sights.length < 30) break;
    const r = refineLevel(cam, sights, w, h);
    if (!r) break;
    cam = r; count = sights.length; least = Math.min(...per); perLine = per;
    let ss = 0;
    for (const sg of sights) { const p = project(cam, sg.world)!; ss += ((p[0] - sg.px[0]) * sg.n![0] + (p[1] - sg.px[1]) * sg.n![1]) ** 2; }
    rms = Math.sqrt(ss / sights.length);
  }
  if (count < 30) return null;
  // somewhere a camera could be, through a lens that exists
  if (cam.pos[1] < 0.3 || cam.pos[1] > 45 || cam.pos[2] < 1.2 || cam.pos[2] > 170 || Math.abs(cam.pos[0]) > 0.5 * cam.pos[2] + 4 || cam.f < 0.3 * w || cam.f > 18 * w) return null;
  const fine: Mark[] = marks.map((q) => ({ ...q, px: project(cam, worldOf(q))! }));
  if (fine.some((q) => !q.px)) return null;
  return { marks: fine, score: best.score, cam: { ...cam, rms }, sights: count, least, per: perLine };
}

/** A level camera polished against sightings (points, or points known only across a line), from one already close. */
function refineLevel(start: Camera, sights: Sight[], w: number, h: number): Camera | null {
  // the level solver takes points; a sighting on a line is given to it as the point on that line nearest to where the
  // camera now puts it, and the two are worked towards each other
  let cam = start;
  for (let it = 0; it < 4; it++) {
    const pts = sights.map((sg) => {
      const p = project(cam, sg.world);
      if (!p || !sg.n) return { world: sg.world, px: sg.px };
      const d = (p[0] - sg.px[0]) * sg.n[0] + (p[1] - sg.px[1]) * sg.n[1];
      return { world: sg.world, px: [p[0] - d * sg.n[0], p[1] - d * sg.n[1]] as Pt };
    });
    const r = solveLevelCamera(pts, w, h, cam);
    if (!isCamera(r)) return it ? cam : null;
    cam = r;
  }
  return cam;
}
