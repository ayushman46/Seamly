/**
 * Body pose in the browser (ONNX Runtime Web, WebGPU with a WebAssembly fallback), with models that are free to use
 * in any product (Apache-2.0, OpenMMLab):
 *   - RTMO-t on the whole frame (416 px): every person and a first set of keypoints, in one pass. Finds the bowler.
 *   - RTMPose-m (Halpe 26 keypoints, 256x192) on the bowler's crop, with horizontal-flip test-time augmentation:
 *     the keypoints the analysis is built on. The first 17 are the COCO joints the rest of the engine uses; the
 *     other nine (head top, neck, mid-hip, toes and heels) are kept alongside.
 * They replace YOLO11n/s-pose (AGPL-3.0). On 334 people in real cricket frames RTMPose-m sits 0.070 torso lengths
 * from a far larger reference model against 0.111 for YOLO11s, at about a quarter of the arithmetic.
 */
import * as ort from "onnxruntime-web/webgpu";
import { COCO_FLIP } from "./types";
import { setBackend } from "./common";

import { ORT_WASM_PATHS } from "./ortPaths";
import { MODEL_CACHE } from "../lib/modelCache";

// the 22 MB WebAssembly runtime comes from the CDN (keeps the site small); models are served by the site
ort.env.wasm.wasmPaths = ORT_WASM_PATHS;
ort.env.wasm.numThreads = typeof crossOriginIsolated !== "undefined" && crossOriginIsolated
  ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;

export const MODEL_BASE = `${import.meta.env.BASE_URL}models/`;
export const DET_CONF = 0.25;

export interface PersonDets { boxes: number[][]; confs: number[]; kps: number[][][]; kcs: number[][] }
/** `extra`: Halpe keypoints 17-25 (head top, neck, mid-hip, left/right big toe, left/right small toe, left/right heel) as [x, y, confidence]. */
export interface RefinedPose { frame: number; box: number[]; kps: number[][]; kcs: number[]; matched_iou: number; extra?: number[][] }

export { backend } from "./common";

async function hasWebGPU(): Promise<boolean> {
  try {
    const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    return !!gpu && !!(await gpu.requestAdapter());
  } catch {
    return false;
  }
}

// models are kept in Cache Storage after the first download (the HTTP cache alone can drop 40 MB files)

// Where the models are downloaded from, in order: jsDelivr, then GitHub's own raw-file host, both serving them
// straight from the public repository at the commit that added them (so the files never change under a URL), which
// keeps the ~110 MB first download off the site's own bandwidth; the site's copy is the last resort. jsDelivr
// serves files up to 20 MB (hence the parts) and refuses some of them for a repository this size ("package size
// exceeded"), which is what the second source is for.
// When a model file changes, point MODEL_COMMIT at a commit that contains the new file.
const MODEL_COMMIT = "0704330bc412b896ae9985268b9cb7bf5127e8b4";
const MODEL_CDN = `https://cdn.jsdelivr.net/gh/ayushman46/Seamly@${MODEL_COMMIT}/frontend/public/models/`;
const MODEL_RAW = `https://raw.githubusercontent.com/ayushman46/Seamly/${MODEL_COMMIT}/frontend/public/models/`;
export const MODEL_SOURCES: string[] = [MODEL_CDN, MODEL_RAW, MODEL_BASE];
export const SCAN_MODEL = "rtmo-s.onnx", REFINE_MODEL = "rtmpose-m-halpe26.onnx";
const MODEL_PARTS: Record<string, string[]> = {
  [SCAN_MODEL]: [1, 2].map((i) => `${SCAN_MODEL}.part${i}`),
  [REFINE_MODEL]: [1, 2, 3].map((i) => `${REFINE_MODEL}.part${i}`),
};

/** Download with progress (the models are tens of MB), served from Cache Storage after the first time. */
export async function fetchModel(name: string, onProgress?: (f: number) => void): Promise<Uint8Array> {
  const url = new URL(MODEL_BASE + name, location.href).href;   // the cache key, whichever source it came from
  try {
    const hit = await (await caches.open(MODEL_CACHE)).match(url);
    if (hit) {
      const b = new Uint8Array(await hit.arrayBuffer());
      onProgress?.(1);
      return b;
    }
  } catch { /* Cache Storage unavailable (e.g. some private windows): download normally */ }
  let bytes: Uint8Array | null = null;
  for (const [i, base] of MODEL_SOURCES.entries()) {
    try {
      bytes = await downloadParts(base, MODEL_PARTS[name] ?? [name], name, onProgress);
      break;
    } catch (e) {
      if (i === MODEL_SOURCES.length - 1) throw e;
      console.warn(`Model source ${base} failed, trying the next one`, e);
    }
  }
  if (!bytes) throw new Error(`Could not download the analysis model (${name}).`);
  void caches.open(MODEL_CACHE).then((c) => c.put(url, new Response(bytes, { headers: { "Content-Type": "application/octet-stream" } })))
    .catch(() => undefined);
  return bytes;
}

/** Download a model's parts from one source and join them. */
async function downloadParts(base: string, parts: string[], name: string, onProgress?: (f: number) => void): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for (const [i, part] of parts.entries()) {
    chunks.push(await download(new URL(base + part, location.href).href, name, (f) => onProgress?.((i + f) / parts.length)));
  }
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

async function download(url: string, name: string, onProgress?: (f: number) => void): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not download the analysis model (${name}: ${res.status}). Check your connection and try again.`);
  const total = Number(res.headers.get("content-length")) || 0;
  if (!res.body || !total) {
    const b = new Uint8Array(await res.arrayBuffer());
    onProgress?.(1);
    return b;
  }
  const reader = res.body.getReader();
  const buf = new Uint8Array(total);
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (got + value.length > buf.length) {   // content-length was of the compressed body
      const all = new Uint8Array(Math.max(buf.length * 2, got + value.length));
      all.set(buf.subarray(0, got));
      return finish(all, got, value, reader, onProgress);
    }
    buf.set(value, got);
    got += value.length;
    onProgress?.(Math.min(1, got / total));
  }
  return buf.subarray(0, got);
}

async function finish(buf: Uint8Array, got: number, first: Uint8Array, reader: ReadableStreamDefaultReader<Uint8Array>,
  onProgress?: (f: number) => void): Promise<Uint8Array> {
  const parts = [buf.subarray(0, got), first];
  let n = got + first.length;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    n += value.length;
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  onProgress?.(1);
  return out;
}

// ONNX Runtime initialises its WebAssembly once and rejects concurrent first calls: create sessions one at a time
let sessionChain: Promise<unknown> = Promise.resolve();

/** imageSize: [height, width] of a detector's input (checked with a warm-up run on WebGPU). */
export async function createSession(name: string, onProgress?: (f: number) => void, preferGPU = true,
  imageSize?: [number, number]): Promise<ort.InferenceSession> {
  const bytes = await fetchModel(name, onProgress);   // downloads still run in parallel
  const p = sessionChain.then(() => createFrom(bytes, name, preferGPU, imageSize));
  sessionChain = p.catch(() => undefined);
  return p;
}

let wasmOnly = false;
/** Use WebAssembly from now on (WebGPU failed at run time). */
export const forceWasm = () => { wasmOnly = true; };

/** localStorage "seamly:backend" = "wasm" forces the WebAssembly backend (for testing the no-WebGPU path). */
function forcedWasm(): boolean {
  if (wasmOnly) return true;
  try { return localStorage.getItem("seamly:backend") === "wasm"; } catch { return false; }
}

/** A WebAssembly session from already downloaded model bytes (serialised with the other session creations). */
export function sessionFrom(bytes: Uint8Array): Promise<ort.InferenceSession> {
  const p = sessionChain.then(() => ort.InferenceSession.create(bytes, { executionProviders: ["wasm"], graphOptimizationLevel: "all" }));
  sessionChain = p.catch(() => undefined);
  return p;
}

async function createFrom(bytes: Uint8Array, name: string, preferGPU: boolean, imageSize?: [number, number]): Promise<ort.InferenceSession> {
  const gpu = preferGPU && !forcedWasm() && (await hasWebGPU());
  if (gpu) {
    try {
      const verbose = (() => { try { return localStorage.getItem("seamly:debug") === "ort"; } catch { return false; } })();
      const s = await ort.InferenceSession.create(bytes, { executionProviders: ["webgpu"], graphOptimizationLevel: "all", ...(verbose ? { logSeverityLevel: 0 as const, logVerbosityLevel: 0 } : {}) });
      if (imageSize) { await warmUp(s, imageSize); setBackend("webgpu"); }
      return s;
    } catch (e) {
      console.warn("WebGPU unavailable for", name, e);
    }
  }
  const s = await ort.InferenceSession.create(bytes, { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
  if (imageSize) setBackend("wasm");   // the detectors decide what the UI reports (the lifter always runs on wasm)
  return s;
}

/** A WebGPU session can be created yet fail (or return NaN) at run time on some GPUs/browsers: run it once on a
 *  blank image so a broken backend is caught at load time and the WebAssembly one is used instead. */
async function warmUp(s: ort.InferenceSession, [h, w]: [number, number]): Promise<void> {
  const out = await s.run({ [s.inputNames[0]]: new ort.Tensor("float32", new Float32Array(3 * h * w).fill(0.45), [1, 3, h, w]) });
  for (const name of s.outputNames) {
    const d = out[name].data as Float32Array;
    for (let i = 0; i < d.length; i += 97) if (!Number.isFinite(d[i])) throw new Error("WebGPU returned non-finite output");
  }
}

function canvas(w: number, h: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return c;
}
type Ctx2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

/**
 * RGBA pixels -> CHW float32, optionally mirrored. `order` is the channel order the model was trained on and
 * `mean`/`std` its normalisation (per channel in that order; none means raw 0-255).
 */
function toTensor(ctx: Ctx2D, w: number, h: number, order: "rgb" | "bgr", mean?: number[], std?: number[], flip = false): ort.Tensor {
  const { data } = ctx.getImageData(0, 0, w, h);
  const n = w * h, f = new Float32Array(3 * n), ch = order === "rgb" ? [0, 1, 2] : [2, 1, 0];
  for (let c = 0; c < 3; c++) {
    const src = ch[c], m = mean ? mean[c] : 0, sd = std ? std[c] : 1, base = c * n;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) f[base + row + x] = (data[(row + (flip ? w - 1 - x : x)) * 4 + src] - m) / sd;
    }
  }
  return new ort.Tensor("float32", f, [1, 3, h, w]);
}

/** RTMO output (people already de-duplicated inside the model): dets (1, N, 5) and keypoints (1, N, 17, 3), input pixels. */
/** Two skeletons of one person: their joints lie, on average, within 12% of the skeleton's size of each other. */
export function sameSkeleton(a: number[][], b: number[][]): boolean {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, sum = 0;
  for (let j = 0; j < a.length; j++) {
    x0 = Math.min(x0, a[j][0]); x1 = Math.max(x1, a[j][0]); y0 = Math.min(y0, a[j][1]); y1 = Math.max(y1, a[j][1]);
    sum += Math.hypot(a[j][0] - b[j][0], a[j][1] - b[j][1]);
  }
  return sum / a.length < 0.12 * Math.max(1, Math.hypot(x1 - x0, y1 - y0));
}

function decode(dets: ort.Tensor, kpts: ort.Tensor, conf: number, maxDet = 100): PersonDets {
  const d = dets.data as Float32Array, k = kpts.data as Float32Array, N = dets.dims[1];
  const order = Array.from({ length: N }, (_, i) => i).filter((i) => d[i * 5 + 4] > conf).sort((a, b) => d[b * 5 + 4] - d[a * 5 + 4]).slice(0, maxDet);
  const boxes: number[][] = [], confs: number[] = [], kps: number[][][] = [], kcs: number[][] = [];
  for (const i of order) {
    const b = [d[i * 5], d[i * 5 + 1], d[i * 5 + 2], d[i * 5 + 3]];
    if (!(b[2] > b[0] && b[3] > b[1])) continue;
    const kk: number[][] = [], kc: number[] = [];
    for (let j = 0; j < 17; j++) { const o = (i * 17 + j) * 3; kk.push([k[o], k[o + 1]]); kc.push(Math.min(1, Math.max(0, k[o + 2]))); }
    // RTMO's own suppression goes by box overlap, and it often returns one person two or three times: the same
    // skeleton with a tight box and with a loose one. The same skeleton is the same person (strongest first, so
    // the best-scored copy is the one kept); two people side by side have skeletons a body width apart.
    if (kps.some((q) => sameSkeleton(q, kk))) continue;
    boxes.push(b); confs.push(d[i * 5 + 4]);
    kps.push(kk); kcs.push(kc);
  }
  return { boxes, confs, kps, kcs };
}

// RTMPose: ImageNet normalisation on RGB; SimCC bins are half pixels
const RTM_MEAN = [123.675, 116.28, 103.53], RTM_STD = [58.395, 57.12, 57.375];
const HALPE_FLIP = [...COCO_FLIP, 17, 18, 19, 21, 20, 23, 22, 25, 24];
/** SimCC output -> keypoints in crop pixels with a confidence. The raw peak height runs to about 0.9 on a clearly
 *  seen joint (a seen joint's median is 0.72): it is stretched so that the engine's thresholds, set on YOLO's
 *  0-1 confidences, mean what they meant. */
function simcc(sx: ort.Tensor, sy: ort.Tensor): { kps: number[][]; kcs: number[] } {
  const X = sx.data as Float32Array, Y = sy.data as Float32Array, K = sx.dims[1], nx = sx.dims[2], ny = sy.dims[2];
  const kps: number[][] = [], kcs: number[] = [];
  for (let j = 0; j < K; j++) {
    let bx = 0, vx = -Infinity, by = 0, vy = -Infinity;
    for (let i = 0; i < nx; i++) { const v = X[j * nx + i]; if (v > vx) { vx = v; bx = i; } }
    for (let i = 0; i < ny; i++) { const v = Y[j * ny + i]; if (v > vy) { vy = v; by = i; } }
    kps.push([bx / 2, by / 2]); kcs.push(Math.min(1, Math.max(0, Math.min(vx, vy) / 0.75)));
  }
  return { kps, kcs };
}

export function iou(a: number[], b: number[]): number {
  const ix1 = Math.max(a[0], b[0]), iy1 = Math.max(a[1], b[1]), ix2 = Math.min(a[2], b[2]), iy2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
  const ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return ua > 0 ? inter / ua : 0;
}

export class PoseModels {
  private constructor(private scan: ort.InferenceSession, private refine: ort.InferenceSession,
    private scanCanvas: OffscreenCanvas | HTMLCanvasElement, private cropCanvas: OffscreenCanvas | HTMLCanvasElement) {}

  static readonly SCAN = 640;
  static readonly CROP_W = 192;
  static readonly CROP_H = 256;

  static async load(onProgress?: (f: number) => void): Promise<PoseModels> {
    let a = 0, b = 0;
    const report = () => onProgress?.(0.33 * a + 0.67 * b);
    const [scan, refine] = await Promise.all([
      createSession(SCAN_MODEL, (f) => { a = f; report(); }, true, [PoseModels.SCAN, PoseModels.SCAN]),
      createSession(REFINE_MODEL, (f) => { b = f; report(); }, true, [PoseModels.CROP_H, PoseModels.CROP_W]),
    ]);
    return new PoseModels(scan, refine, canvas(PoseModels.SCAN, PoseModels.SCAN), canvas(PoseModels.CROP_W, PoseModels.CROP_H));
  }

  /** Only the full-frame model, for the live camera check (it never refines crops). */
  static async scanOnly(onProgress?: (f: number) => void): Promise<PoseModels> {
    const scan = await createSession(SCAN_MODEL, onProgress, true, [PoseModels.SCAN, PoseModels.SCAN]);
    return new PoseModels(scan, scan, canvas(PoseModels.SCAN, PoseModels.SCAN), canvas(PoseModels.CROP_W, PoseModels.CROP_H));
  }

  /** Frees the models' memory (WebGPU buffers or WebAssembly heap). */
  async release(): Promise<void> {
    await this.scan.release();
    if (this.refine !== this.scan) await this.refine.release();
  }

  /** Full-frame people + keypoints in source pixels (the frame fitted into the top-left of a grey square, as RTMO was trained). */
  async detect(src: CanvasImageSource, w: number, h: number, conf = DET_CONF): Promise<PersonDets> {
    const S = PoseModels.SCAN;
    const r = Math.min(S / w, S / h);
    const nw = Math.round(w * r), nh = Math.round(h * r);
    const ctx = this.scanCanvas.getContext("2d", { willReadFrequently: true }) as Ctx2D;
    ctx.fillStyle = "rgb(114,114,114)";
    ctx.fillRect(0, 0, S, S);
    ctx.drawImage(src, 0, 0, w, h, 0, 0, nw, nh);
    const out = await this.scan.run({ [this.scan.inputNames[0]]: toTensor(ctx, S, S, "bgr") });
    const det = decode(out.dets, out.keypoints, conf);
    const back = (x: number, y: number) => [Math.min(w, Math.max(0, x / r)), Math.min(h, Math.max(0, y / r))];
    return {
      boxes: det.boxes.map((b) => { const p = back(b[0], b[1]), q = back(b[2], b[3]); return [p[0], p[1], q[0], q[1]]; }),
      confs: det.confs,
      kps: det.kps.map((k) => k.map(([x, y]) => back(x, y))),
      kcs: det.kcs,
    };
  }

  /**
   * Top-down pose on the person in `box`: the box grown by `pad` and widened or heightened to 3:4, as RTMPose was
   * trained. Horizontal-flip TTA averages out jitter, and a joint the two looks disagree on keeps the first look
   * at a lower confidence.
   */
  async refineCrop(src: CanvasImageSource, w: number, h: number, box: number[], frame: number, pad = 1.25,
    flipTTA = true): Promise<RefinedPose | null> {
    const CW = PoseModels.CROP_W, CH = PoseModels.CROP_H;
    const cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
    let bw = Math.max(16, (box[2] - box[0]) * pad), bh = Math.max(16, (box[3] - box[1]) * pad);
    if (bw > bh * (CW / CH)) bh = bw / (CW / CH); else bw = bh * (CW / CH);
    const s = CW / bw, sx0 = cx - bw / 2, sy0 = cy - bh / 2;
    const ctx = this.cropCanvas.getContext("2d", { willReadFrequently: true }) as Ctx2D;
    ctx.fillStyle = "rgb(0,0,0)";
    ctx.fillRect(0, 0, CW, CH);
    const ix0 = Math.max(0, sx0), iy0 = Math.max(0, sy0), ix1 = Math.min(w, sx0 + bw), iy1 = Math.min(h, sy0 + bh);
    if (ix1 - ix0 < 2 || iy1 - iy0 < 2) return null;
    ctx.drawImage(src, ix0, iy0, ix1 - ix0, iy1 - iy0, (ix0 - sx0) * s, (iy0 - sy0) * s, (ix1 - ix0) * s, (iy1 - iy0) * s);
    const input = this.refine.inputNames[0];
    const look = async (flip: boolean) => {
      const o = await this.refine.run({ [input]: toTensor(ctx, CW, CH, "rgb", RTM_MEAN, RTM_STD, flip) });
      const r = simcc(o.simcc_x, o.simcc_y);
      if (!flip) return r;
      const K = r.kps.length, map = K === HALPE_FLIP.length ? HALPE_FLIP : COCO_FLIP;
      return { kps: map.map((j) => [CW - 1 - r.kps[j][0], r.kps[j][1]]), kcs: map.map((j) => r.kcs[j]) };
    };
    const a = await look(false);
    let kps = a.kps, kcs = a.kcs;
    if (flipTTA) {
      const b = await look(true), lim = 0.08 * (box[3] - box[1]) * s;
      kps = a.kps.map((p, j) => {
        if (Math.hypot(p[0] - b.kps[j][0], p[1] - b.kps[j][1]) >= lim) return p;
        const w1 = a.kcs[j] + 1e-3, w2 = b.kcs[j] + 1e-3;
        return [(p[0] * w1 + b.kps[j][0] * w2) / (w1 + w2), (p[1] * w1 + b.kps[j][1] * w2) / (w1 + w2)];
      });
      kcs = a.kcs.map((c, j) => (Math.hypot(a.kps[j][0] - b.kps[j][0], a.kps[j][1] - b.kps[j][1]) < lim ? Math.max(c, b.kcs[j]) : c * 0.85));
    }
    const mean17 = kcs.slice(0, 17).reduce((q, c) => q + c, 0) / 17;
    if (mean17 < 0.15) return null;   // nobody there
    const out = kps.map(([u, v]) => [u / s + sx0, v / s + sy0]);
    return { frame, box: box.slice(), kps: out.slice(0, 17), kcs: kcs.slice(0, 17), matched_iou: 1,
      extra: out.length > 17 ? out.slice(17).map((p, i) => [p[0], p[1], kcs[17 + i]]) : undefined };
  }
}
