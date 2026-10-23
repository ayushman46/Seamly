/**
 * Temporal 2D -> 3D lifting with MotionBERT-Lite (ONNX, int8 weights) - port of
 * backend/bowlnet/lifting/motionbert.py and pipeline.lift_resampled.
 * Output: H36M-17 (T,17,3) in the network's normalised camera space (x right, y down, z depth).
 */
import * as ort from "onnxruntime-web/webgpu";
import { createSession } from "./detector";
import { interp, uniformFilter1d, median } from "./nd";
import type { Arr2, Arr3 } from "./nd";

export const CLIP_LEN = 243;
const H36M_LEFT = [4, 5, 6, 11, 12, 13];
const H36M_RIGHT = [1, 2, 3, 14, 15, 16];

/** (T,17,2)+(T,17) COCO -> (T,17,3) H36M [x, y, conf]. Head-top is extrapolated from the face. */
export function cocoToH36m(kp: Arr3, kc: Arr2): Arr3 {
  return kp.map((k, t) => {
    const c = kc[t];
    const lhip = k[11], rhip = k[12], lsh = k[5], rsh = k[6];
    const pelvis = [(lhip[0] + rhip[0]) / 2, (lhip[1] + rhip[1]) / 2];
    const thorax = [(lsh[0] + rsh[0]) / 2, (lsh[1] + rsh[1]) / 2];
    const cP = Math.min(c[11], c[12]), cT = Math.min(c[5], c[6]);
    const eyes = [(k[1][0] + k[2][0]) / 2, (k[1][1] + k[2][1]) / 2], cE = Math.min(c[1], c[2]);
    const ears = [(k[3][0] + k[4][0]) / 2, (k[3][1] + k[4][1]) / 2], cA = Math.min(c[3], c[4]);
    const face = cE >= cA ? eyes : ears, cF = Math.max(cE, cA);
    const head = [face[0] + 0.45 * (face[0] - thorax[0]), face[1] + 0.45 * (face[1] - thorax[1])];
    const p = (xy: number[], cc: number) => [xy[0], xy[1], cc];
    return [
      p(pelvis, cP), p(rhip, c[12]), p(k[14], c[14]), p(k[16], c[16]), p(lhip, c[11]), p(k[13], c[13]), p(k[15], c[15]),
      p([(pelvis[0] + thorax[0]) / 2, (pelvis[1] + thorax[1]) / 2], Math.min(cP, cT)), p(thorax, cT), p(k[0], c[0]),
      p(head, Math.min(cF, cT)), p(lsh, c[5]), p(k[7], c[7]), p(k[9], c[9]), p(rsh, c[6]), p(k[8], c[8]), p(k[10], c[10]),
    ].map((v) => v.map((x) => Math.fround(x)));
  });
}

function flip(x: Arr3): Arr3 {
  return x.map((fr) => {
    const y = fr.map((p) => [-p[0], p[1], p[2]]);
    const out = y.map((p) => p.slice());
    H36M_LEFT.forEach((l, i) => { out[l] = y[H36M_RIGHT[i]]; out[H36M_RIGHT[i]] = y[l]; });
    return out;
  });
}

/** "track" normalisation: pelvis-centred (smoothed), scale ~ body height (slowly varying). */
export function normalise(seq: Arr3): Arr3 {
  const T = seq.length;
  const cx = uniformFilter1d(seq.map((f) => f[0][0]), Math.min(T, 5));
  const cy = uniformFilter1d(seq.map((f) => f[0][1]), Math.min(T, 5));
  const h = seq.map((f) => Math.hypot(f[10][0] - (f[3][0] + f[6][0]) / 2, f[10][1] - (f[3][1] + f[6][1]) / 2));
  const hv = h.filter((_, t) => seq[t][10][2] > 0.2 && seq[t][3][2] > 0.2 && seq[t][6][2] > 0.2);
  const body = hv.length ? median(hv) : median(h) + 1e-3;
  let hs = h.map((v) => (Number.isFinite(v) && v > 0.3 * body ? v : body));
  hs = uniformFilter1d(hs, Math.min(T, T < 30 ? Math.trunc(0.6 * T) + 1 : 31));
  hs = hs.map((v) => Math.min(1.6 * body, Math.max(0.6 * body, v)));
  return seq.map((f, t) => f.map((p) => [(p[0] - cx[t]) / hs[t], (p[1] - cy[t]) / hs[t], p[2]]));
}

export class Lifter {
  private constructor(private s: ort.InferenceSession) {}

  static async load(onProgress?: (f: number) => void): Promise<Lifter> {
    // int8 MatMuls run on the WebAssembly backend
    return new Lifter(await createSession("motionbert_lite_int8.onnx", onProgress, false));
  }

  private async run(batch: Arr3[]): Promise<Arr3[]> {
    const B = batch.length, T = batch[0].length;
    const f = new Float32Array(B * T * 17 * 3);
    let o = 0;
    for (const x of batch) for (const fr of x) for (const p of fr) { f[o++] = p[0]; f[o++] = p[1]; f[o++] = p[2]; }
    const out = await this.s.run({ x: new ort.Tensor("float32", f, [B, T, 17, 3]) });
    const y = out.y.data as Float32Array;
    const res: Arr3[] = [];
    let q = 0;
    for (let b = 0; b < B; b++) {
      const seq: Arr3 = [];
      for (let t = 0; t < T; t++) {
        const fr: number[][] = [];
        for (let j = 0; j < 17; j++) { fr.push([y[q], y[q + 1], y[q + 2]]); q += 3; }
        seq.push(fr);
      }
      res.push(seq);
    }
    return res;
  }

  /** (T,17,3) H36M pixels+conf -> (T,17,3) 3D in normalised units (y down). Flip TTA, overlapping windows. */
  async lift(seqH36m: Arr3, flipTTA = true): Promise<Arr3> {
    const x = normalise(seqH36m);
    const T = x.length;
    if (!T) return [];
    let windows: [number, number][];
    if (T <= CLIP_LEN) windows = [[0, T]];
    else {
      const stride = CLIP_LEN - 81;
      const starts: number[] = [];
      for (let s = 0; s <= T - CLIP_LEN; s += stride) starts.push(s);
      if (starts[starts.length - 1] !== T - CLIP_LEN) starts.push(T - CLIP_LEN);
      windows = starts.map((s) => [s, s + CLIP_LEN]);
    }
    const acc = Array.from({ length: T }, () => Array.from({ length: 17 }, () => [0, 0, 0]));
    const wsum = new Array(T).fill(0);
    for (const [s, e] of windows) {
      const inp = x.slice(s, e);
      const pred = await this.run(flipTTA ? [inp, flip(inp)] : [inp]);
      const fl = flipTTA ? flip(pred[1]) : null;
      const out = fl ? pred[0].map((fr, t) => fr.map((p, j) => p.map((v, c) => (v + fl[t][j][c]) / 2))) : pred[0];
      const n = e - s;
      for (let t = 0; t < n; t++) {
        const ramp = Math.min(40, Math.min(t + 1, n - t));
        for (let j = 0; j < 17; j++) for (let c = 0; c < 3; c++) acc[s + t][j][c] += out[t][j][c] * ramp;
        wsum[s + t] += ramp;
      }
    }
    return acc.map((fr, t) => fr.map((p) => p.map((v) => v / Math.max(wsum[t], 1e-9))));
  }

  /** MotionBERT was trained on 50 fps H36M: resample the 2D to ~50 fps, lift, and map back. */
  async liftResampled(seq: Arr3, fps: number): Promise<Arr3> {
    const T = seq.length;
    if ((fps >= 40 && fps <= 65) || T < 8) return this.lift(seq);
    if (fps > 65) {
      const k = Math.round(fps / 50);
      const out: Arr3 = new Array(T);
      for (let ph = 0; ph < k; ph++) {
        let idx: number[] = [];
        for (let i = ph; i < T; i += k) idx.push(i);
        if (idx.length < 4) idx = [...Array(T).keys()];
        const y = await this.lift(idx.map((i) => seq[i]));
        idx.forEach((i, n) => { out[i] = y[n]; });
      }
      return out;
    }
    // low fps (e.g. 25/30): upsample with linear interpolation, lift, sample back
    const tSrc = seq.map((_, i) => i / fps);
    const nDst = Math.floor(tSrc[T - 1] * 50) + 1;
    const tDst = Array.from({ length: nDst }, (_, i) => i / 50);
    const up: Arr3 = tDst.map(() => Array.from({ length: 17 }, () => [0, 0, 0]));
    for (let j = 0; j < 17; j++) for (let c = 0; c < 3; c++) {
      const fp = seq.map((f) => f[j][c]);
      tDst.forEach((t, i) => { up[i][j][c] = interp(t, tSrc, fp); });
    }
    const X50 = await this.lift(up);
    const out: Arr3 = tSrc.map(() => Array.from({ length: 17 }, () => [0, 0, 0]));
    for (let j = 0; j < 17; j++) for (let c = 0; c < 3; c++) {
      const fp = X50.map((f) => f[j][c]);
      tSrc.forEach((t, i) => { out[i][j][c] = interp(t, tDst, fp); });
    }
    return out;
  }
}
