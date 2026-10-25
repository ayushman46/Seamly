/**
 * YOLO11-pose in the browser (ONNX Runtime Web, WebGPU with a WebAssembly fallback).
 * Port of backend/bowlnet/detect.py: a fast full-frame model for detection/tracking (YOLO11n @ 640) and an
 * accurate top-down model on bowler crops (YOLO11s @ 384) with horizontal-flip test-time augmentation.
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
export interface RefinedPose { frame: number; box: number[]; kps: number[][]; kcs: number[]; matched_iou: number }

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

// Where the models are downloaded from, in order. jsDelivr serves them straight from the public GitHub repo, pinned
// to the commit that added them (so the files never change under a URL), which keeps the ~70 MB first download off
// the site's own bandwidth; the site's copy is the fallback. Files over 20 MB are stored in parts (jsDelivr's limit).
// When a model file changes, point MODEL_CDN at a commit that contains the new file (or drop it until then).
const MODEL_CDN = "https://cdn.jsdelivr.net/gh/ayushman46/Seamly@8c7b916642ef10edd25713339d99c18ec225be3e/frontend/public/models/";
export const MODEL_SOURCES: string[] = [MODEL_CDN, MODEL_BASE];
const MODEL_PARTS: Record<string, string[]> = { "yolo11s-pose.onnx": ["yolo11s-pose.onnx.part1", "yolo11s-pose.onnx.part2"] };

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

/** imageSize: square input size of a detector (checked with a warm-up run on WebGPU). */
export async function createSession(name: string, onProgress?: (f: number) => void, preferGPU = true,
  imageSize?: number): Promise<ort.InferenceSession> {
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

async function createFrom(bytes: Uint8Array, name: string, preferGPU: boolean, imageSize?: number): Promise<ort.InferenceSession> {
  const gpu = preferGPU && !forcedWasm() && (await hasWebGPU());
  if (gpu) {
    try {
      const s = await ort.InferenceSession.create(bytes, { executionProviders: ["webgpu"], graphOptimizationLevel: "all" });
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
async function warmUp(s: ort.InferenceSession, size: number): Promise<void> {
  const out = await s.run({ images: new ort.Tensor("float32", new Float32Array(3 * size * size).fill(0.45), [1, 3, size, size]) });
  const d = out[s.outputNames[0]].data as Float32Array;
  for (let i = 0; i < d.length; i += 97) if (!Number.isFinite(d[i])) throw new Error("WebGPU returned non-finite output");
}

function canvas(w: number, h: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return c;
}
type Ctx2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

/** RGBA pixels -> CHW float32 in [0,1]; optionally mirrored horizontally. */
function toTensor(ctx: Ctx2D, size: number, flip = false): ort.Tensor {
  const { data } = ctx.getImageData(0, 0, size, size);
  const n = size * size;
  const f = new Float32Array(3 * n);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + (flip ? size - 1 - x : x)) * 4, i = y * size + x;
      f[i] = data[o] / 255; f[n + i] = data[o + 1] / 255; f[2 * n + i] = data[o + 2] / 255;
    }
  }
  return new ort.Tensor("float32", f, [1, 3, size, size]);
}

/** Decode YOLO pose output (1, 56, N) -> person candidates in input pixels, NMS'd (ultralytics defaults). */
function decode(out: ort.Tensor, conf: number, iouThr = 0.7, maxDet = 100): PersonDets {
  const d = out.data as Float32Array;
  const N = out.dims[2];
  const cand: { s: number; i: number }[] = [];
  for (let i = 0; i < N; i++) {
    const s = d[4 * N + i];
    if (s > conf) cand.push({ s, i });
  }
  cand.sort((a, b) => b.s - a.s);
  const boxes: number[][] = [], confs: number[] = [], kps: number[][][] = [], kcs: number[][] = [];
  for (const { s, i } of cand) {
    const cx = d[i], cy = d[N + i], w = d[2 * N + i], h = d[3 * N + i];
    const b = [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2];
    if (boxes.some((q) => iou(q, b) > iouThr)) continue;
    boxes.push(b); confs.push(s);
    const k: number[][] = [], kc: number[] = [];
    for (let j = 0; j < 17; j++) {
      k.push([d[(5 + 3 * j) * N + i], d[(6 + 3 * j) * N + i]]);
      kc.push(d[(7 + 3 * j) * N + i]);
    }
    kps.push(k); kcs.push(kc);
    if (boxes.length >= maxDet) break;
  }
  return { boxes, confs, kps, kcs };
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
  static readonly REFINE = 384;

  static async load(onProgress?: (f: number) => void): Promise<PoseModels> {
    let a = 0, b = 0;
    const report = () => onProgress?.(0.25 * a + 0.75 * b);
    const [scan, refine] = await Promise.all([
      createSession("yolo11n-pose.onnx", (f) => { a = f; report(); }, true, PoseModels.SCAN),
      createSession("yolo11s-pose.onnx", (f) => { b = f; report(); }, true, PoseModels.REFINE),
    ]);
    return new PoseModels(scan, refine, canvas(PoseModels.SCAN, PoseModels.SCAN), canvas(PoseModels.REFINE, PoseModels.REFINE));
  }

  /** Only the full-frame model, for the live camera check (it never refines crops). */
  static async scanOnly(onProgress?: (f: number) => void): Promise<PoseModels> {
    const scan = await createSession("yolo11n-pose.onnx", onProgress, true, PoseModels.SCAN);
    return new PoseModels(scan, scan, canvas(PoseModels.SCAN, PoseModels.SCAN), canvas(PoseModels.REFINE, PoseModels.REFINE));
  }

  /** Full-frame people + keypoints in source pixels (letterboxed like ultralytics). */
  async detect(src: CanvasImageSource, w: number, h: number, conf = DET_CONF): Promise<PersonDets> {
    const S = PoseModels.SCAN;
    const r = Math.min(S / w, S / h);
    const nw = Math.round(w * r), nh = Math.round(h * r);
    const px = (S - nw) / 2, py = (S - nh) / 2;
    const ctx = this.scanCanvas.getContext("2d", { willReadFrequently: true }) as Ctx2D;
    ctx.fillStyle = "rgb(114,114,114)";
    ctx.fillRect(0, 0, S, S);
    ctx.drawImage(src, 0, 0, w, h, Math.round(px - 0.1), Math.round(py - 0.1), nw, nh);
    const out = await this.scan.run({ images: toTensor(ctx, S) });
    const det = decode(out.output0, conf);
    const ox = Math.round(px - 0.1), oy = Math.round(py - 0.1);
    // like ultralytics: scale back to source pixels, then clip boxes and keypoints to the image
    const back = (x: number, y: number) => [Math.min(w, Math.max(0, (x - ox) / r)), Math.min(h, Math.max(0, (y - oy) / r))];
    return {
      boxes: det.boxes.map((b) => { const p = back(b[0], b[1]), q = back(b[2], b[3]); return [p[0], p[1], q[0], q[1]]; }),
      confs: det.confs,
      kps: det.kps.map((k) => k.map(([x, y]) => back(x, y))),
      kcs: det.kcs,
    };
  }

  /**
   * Top-down pose on a square crop around `box` (scaled by `pad`). Picks the person matching the tracked box
   * (crops can contain the umpire/batter); horizontal-flip TTA averages out jitter.
   */
  async refineCrop(src: CanvasImageSource, w: number, h: number, box: number[], frame: number, pad = 1.35,
    flipTTA = true): Promise<RefinedPose | null> {
    const S = PoseModels.REFINE;
    const cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
    const side = Math.max(32, Math.max(box[2] - box[0], box[3] - box[1]) * pad);
    const s = S / side;
    const ctx = this.cropCanvas.getContext("2d", { willReadFrequently: true }) as Ctx2D;
    ctx.fillStyle = "rgb(114,114,114)";
    ctx.fillRect(0, 0, S, S);
    // crop -> src: x = (u - S/2) / s + cx; draw the source region that lands inside the crop
    const sx0 = cx - side / 2, sy0 = cy - side / 2;
    const ix0 = Math.max(0, sx0), iy0 = Math.max(0, sy0), ix1 = Math.min(w, sx0 + side), iy1 = Math.min(h, sy0 + side);
    if (ix1 - ix0 < 2 || iy1 - iy0 < 2) return null;
    ctx.drawImage(src, ix0, iy0, ix1 - ix0, iy1 - iy0, (ix0 - sx0) * s, (iy0 - sy0) * s, (ix1 - ix0) * s, (iy1 - iy0) * s);
    const toSrc = (u: number, v: number) => [u / s + sx0, v / s + sy0];
    const pick = (det: PersonDets, flipped: boolean) => {
      let best: { box: number[]; kps: number[][]; kcs: number[]; iou: number } | null = null, bestScore = -1;
      det.boxes.forEach((b0, i) => {
        let b = b0, k = det.kps[i];
        if (flipped) { b = [S - b0[2], b0[1], S - b0[0], b0[3]]; k = k.map(([x, y]) => [S - x, y]); }
        const p = toSrc(b[0], b[1]), q = toSrc(b[2], b[3]);
        const sb = [p[0], p[1], q[0], q[1]];
        const o = iou(sb, box);
        const kcm = det.kcs[i].reduce((a2, c) => a2 + c, 0) / 17;
        const score = o + 0.1 * kcm;
        if (score > bestScore) { bestScore = score; best = { box: sb, kps: k.map(([x, y]) => toSrc(x, y)), kcs: det.kcs[i].slice(), iou: o }; }
      });
      return best && (best as { iou: number }).iou >= 0.2 ? best as { box: number[]; kps: number[][]; kcs: number[]; iou: number } : null;
    };
    const clipTo = (d: PersonDets): PersonDets => {   // predictions are clipped to the crop, as ultralytics does
      const c = (v: number) => Math.min(S, Math.max(0, v));
      return { ...d, boxes: d.boxes.map((b) => b.map(c)), kps: d.kps.map((k) => k.map(([x, y]) => [c(x), c(y)])) };
    };
    const r1 = clipTo(decode((await this.refine.run({ images: toTensor(ctx, S) })).output0, 0.15));
    const best = pick(r1, false);
    if (!best) return null;
    let { kps, kcs } = best;
    if (flipTTA) {
      const r2 = clipTo(decode((await this.refine.run({ images: toTensor(ctx, S, true) })).output0, 0.15));
      const bf = pick(r2, true);
      if (bf && iou(bf.box, best.box) > 0.6) {
        const kpf = COCO_FLIP.map((j) => bf.kps[j]), kcf = COCO_FLIP.map((j) => bf.kcs[j]);
        const bh = best.box[3] - best.box[1];
        kps = kps.map((p, j) => {
          const agree = Math.hypot(p[0] - kpf[j][0], p[1] - kpf[j][1]) < 0.08 * bh;
          if (!agree) return p;
          const w1 = kcs[j] + 1e-3, w2 = kcf[j] + 1e-3;
          return [(p[0] * w1 + kpf[j][0] * w2) / (w1 + w2), (p[1] * w1 + kpf[j][1] * w2) / (w1 + w2)];
        });
        kcs = kcs.map((c, j) => (Math.hypot(best.kps[j][0] - kpf[j][0], best.kps[j][1] - kpf[j][1]) < 0.08 * bh ? Math.max(c, kcf[j]) : c * 0.85));
      }
    }
    return { frame, box: best.box, kps, kcs, matched_iou: best.iou };
  }
}
