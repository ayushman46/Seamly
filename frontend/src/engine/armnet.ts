/**
 * The arm tracer: the elbows and wrists corrected from the whole delivery.
 *
 * The pose model reads each frame alone. When an arm is behind the body, or points at the camera, it has nothing to
 * read and gives a guess, often a confident one (nine pose models from three families were tried: all guess the
 * same way, docs/ACCURACY.md 9n). What a single frame cannot show, the frames round it can: where the arm was, how
 * it was moving, where it comes out. This is a small network (five dilated 1D convolutions over time, about a third
 * of a second each way) that takes all 17 joints and their confidences through the clip and gives, for both elbows
 * and both wrists, a correction and how sure it is of the result. It was trained on rendered deliveries of many
 * styles, builds, kits and cameras with exact joint truth (backend/tools/synth_arms.py,
 * frontend/_local/loop/armnet/train.py); its weights are public/models/armnet.{json,bin}.
 *
 * It runs in plain arithmetic, the same in the browser and in tests.
 */
type Arr2 = number[][]; type Arr3 = number[][][];

/** Settings (changed only by the accuracy loop's experiments). `far`, `unsure`: a joint moved further than this, or
 * with a spread wider than this (fractions of the body's height), is drawn as an estimate. */
export const ARMNET = { on: false, bowlElbow: true, bowlWrist: false, fig: true, far: 0.04, unsure: 0.03 };

export interface ArmNetAsset { header: { hz: number; ch: number; dil: number[]; out: number[]; tensors: Record<string, { shape: number[]; offset: number }> }; bin: ArrayBuffer }
export type ArmNetLoader = () => Promise<ArmNetAsset>;
const defaultLoader: ArmNetLoader = async () => {
  const base = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/";
  const get = async (ext: string) => {
    const r = await fetch(`${base}models/armnet.${ext}`);
    if (!r.ok) throw new Error(`armnet.${ext}: ${r.status}`);
    return r;
  };
  const [h, b] = await Promise.all([get("json"), get("bin")]);
  return { header: await h.json(), bin: await b.arrayBuffer() };
};
let loader: ArmNetLoader | null = defaultLoader;
let cached: Promise<ArmNetAsset | null> | null = null;
/** Replace how the weights are fetched (tests read them from disk); null turns the tracer off. */
export function setArmNetLoader(l: ArmNetLoader | null | "default"): void { loader = l === "default" ? defaultLoader : l; cached = null; }
/** The weights, loaded once; null when there are none (the analysis then goes on without the tracer). */
export function loadArmNet(): Promise<ArmNetAsset | null> {
  if (!loader) return Promise.resolve(null);
  if (!cached) cached = loader().catch(() => null);
  return cached;
}

/** y (co, T) = conv1d(x (ci, T)) with kernel k, dilation d, zero padding that keeps the length */
function conv(x: Float32Array, ci: number, T: number, w: Float32Array, b: Float32Array, co: number, k: number, d: number): Float32Array {
  const y = new Float32Array(co * T), half = ((k - 1) / 2) * d;
  for (let o = 0; o < co; o++) {
    const yo = o * T; y.fill(b[o], yo, yo + T);
    for (let i = 0; i < ci; i++) {
      const xi = i * T;
      for (let q = 0; q < k; q++) {
        const wv = w[(o * ci + i) * k + q]; if (wv === 0) continue;
        const sh = q * d - half, t0 = Math.max(0, -sh), t1 = Math.min(T, T - sh);
        for (let t = t0; t < t1; t++) y[yo + t] += wv * x[xi + t + sh];
      }
    }
  }
  return y;
}
const relu = (a: Float32Array) => { for (let i = 0; i < a.length; i++) if (a[i] < 0) a[i] = 0; return a; };

const PAD = 40;

export interface ArmTrace {
  /** the joints, with both elbows and both wrists (COCO 7, 8, 9, 10) corrected */
  kp: Arr3;
  /** how far the correction moved each of them, pixels: [T][4] in the order 7, 8, 9, 10 */
  moved: number[][];
  /** the tracer's own spread for each (one sigma-like, pixels) */
  spread: number[][];
}

/** Both elbows and wrists corrected from the whole clip. `kp`, `kc`: the pose model's joints (T,17,2) and confidences. */
export function traceArms(net: ArmNetAsset, kp: Arr3, kc: Arr2, fps: number): ArmTrace | null {
  const T = kp.length, H = net.header, HZ = H.hz, CH = H.ch;
  if (T < 4 || !(fps > 0)) return null;
  const hs = kp.map((f) => Math.hypot((f[5][0] + f[6][0]) / 2 - (f[15][0] + f[16][0]) / 2, (f[5][1] + f[6][1]) / 2 - (f[15][1] + f[16][1]) / 2) / 0.8).sort((a, b) => a - b);
  const body = T % 2 ? hs[T >> 1] : (hs[T / 2 - 1] + hs[T / 2]) / 2;
  if (!(body > 20)) return null;
  // A close-up with the legs out of the picture: the pose model invents the ankles, the body's size cannot be told,
  // and the tracer has never seen such a clip. It is left out (blind judging of real frames: its worst mistakes
  // were all on these).
  if (kc.filter((c) => Math.min(c[15], c[16]) >= 0.3).length < 0.6 * T) return null;
  // the clip at the tracer's own rate (straight lines between frames)
  // (with the first and last frames held for PAD samples beyond each end: the network looks a third of a second each
  // way, and was trained on clips cut out of longer ones, never on a clip that starts from nothing)
  const n0 = Math.max(2, Math.round(((T - 1) / fps) * HZ) + 1), n = n0 + 2 * PAD;
  const x = new Float32Array(51 * n);
  for (let g = 0; g < n; g++) {
    const pos = Math.min(T - 1, Math.max(0, ((g - PAD) / HZ) * fps)), i = Math.min(T - 2, Math.max(0, Math.floor(pos))), u = pos - i;
    const a = kp[i], b = kp[i + 1], ca = kc[i], cb = kc[i + 1];
    const J = (j: number, c: number) => a[j][c] * (1 - u) + b[j][c] * u;
    const ox = (J(5, 0) + J(6, 0)) / 2, oy = (J(5, 1) + J(6, 1)) / 2;
    for (let j = 0; j < 17; j++) {
      x[(2 * j) * n + g] = (J(j, 0) - ox) / body; x[(2 * j + 1) * n + g] = (J(j, 1) - oy) / body;
      x[(34 + j) * n + g] = ca[j] * (1 - u) + cb[j] * u;
    }
  }
  const all = new Float32Array(net.bin);
  const ten = (name: string) => { const t = H.tensors[name]; return all.subarray(t.offset, t.offset + t.shape.reduce((p, c) => p * c, 1)); };
  let h = relu(conv(x, 51, n, ten("inp.weight"), ten("inp.bias"), CH, 3, 1));
  H.dil.forEach((d, q) => {
    const a = relu(conv(h, CH, n, ten(`a.${q}.weight`), ten(`a.${q}.bias`), CH, 3, d));
    const b = conv(a, CH, n, ten(`b.${q}.weight`), ten(`b.${q}.bias`), CH, 1, 1);
    for (let i = 0; i < b.length; i++) b[i] += h[i];
    h = relu(b);
  });
  const o = conv(h, CH, n, ten("out.weight"), ten("out.bias"), 12, 1, 1);
  // back at the clip's own frames
  const out = kp.map((f) => f.map((p) => p.slice())), moved: number[][] = [], spread: number[][] = [];
  for (let t = 0; t < T; t++) {
    const pos = Math.min(n - 1, PAD + (t / fps) * HZ), g = Math.min(n - 2, Math.floor(pos)), u = pos - g;
    const at = (c: number) => o[c * n + g] * (1 - u) + o[c * n + g + 1] * u;
    const mv: number[] = [], sp: number[] = [];
    H.out.forEach((j, q) => {
      const dx = at(2 * q) * body, dy = at(2 * q + 1) * body;
      out[t][j] = [kp[t][j][0] + dx, kp[t][j][1] + dy]; mv.push(Math.hypot(dx, dy));
      sp.push(Math.exp(Math.max(-7, Math.min(2, at(8 + q)))) * body);
    });
    moved.push(mv); spread.push(sp);
  }
  return { kp: out, moved, spread };
}
