/** Light, shared pieces of the engine (no model runtime), so the UI can use them without loading the pipeline. */
import { clip } from "./nd";

export class AnalysisError extends Error {
  suggest: Record<string, number>;
  constructor(message: string, suggest?: Record<string, number>) { super(message); this.suggest = suggest ?? {}; }
}

export const SLOWMO_CHOICES = [1, 2, 3, 4, 5, 6, 8, 10];
export const MIN_FPS = 20;
export const DEFAULT_HEIGHT_M = 1.8;
export const MAX_VIDEO_SECONDS = 60;

export interface Options {
  bowling_arm: "auto" | "right" | "left";
  height_m: number | null;
  slowmo_factor: number;
  shot: number | null;
  candidate: number | null;
  gender?: number;
}

export function optionsFrom(d: Partial<Options> | null | undefined): Options {
  const o: Options = { bowling_arm: "auto", height_m: null, slowmo_factor: 1, shot: null, candidate: null };
  const src = d ?? {};
  if (src.bowling_arm === "left" || src.bowling_arm === "right") o.bowling_arm = src.bowling_arm;
  const h = Number(src.height_m);
  o.height_m = src.height_m != null && Number.isFinite(h) ? clip(h, 1.2, 2.3) : null;
  const f = Number(src.slowmo_factor ?? 1);
  o.slowmo_factor = Number.isFinite(f) ? clip(f, 1, 20) : 1;
  for (const k of ["shot", "candidate"] as const) {
    const v = src[k];
    o[k] = typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null;
  }
  return o;
}


let backendName: "webgpu" | "wasm" | null = null;
/** Which ONNX Runtime backend the models run on (set once the models are loaded). */
export const backend = () => backendName;
export const setBackend = (b: "webgpu" | "wasm") => { backendName = b; };
