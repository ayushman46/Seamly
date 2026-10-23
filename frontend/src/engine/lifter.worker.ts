/**
 * Runs the MotionBERT lifter off the main thread (its int8 MatMuls run on WebAssembly and would freeze the page
 * for seconds). Same ONNX Runtime build as the main thread, so the cached runtime file is reused.
 */
import * as ort from "onnxruntime-web/webgpu";
import { ORT_WASM_PATHS } from "./ortPaths";

ort.env.wasm.wasmPaths = ORT_WASM_PATHS;
ort.env.wasm.numThreads = 1;

let session: Promise<ort.InferenceSession> | null = null;

type Msg = { id: number; type: "load"; bytes: ArrayBuffer } | { id: number; type: "run"; data: Float32Array; dims: number[] };

self.onmessage = async (e: MessageEvent<Msg>) => {
  const m = e.data;
  try {
    if (m.type === "load") {
      session = ort.InferenceSession.create(new Uint8Array(m.bytes), { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
      await session;
      (self as unknown as Worker).postMessage({ id: m.id, ok: true });
    } else {
      if (!session) throw new Error("lifter not loaded");
      const s = await session;
      const out = await s.run({ x: new ort.Tensor("float32", m.data, m.dims) });
      const y = out.y.data as Float32Array;
      (self as unknown as Worker).postMessage({ id: m.id, ok: true, data: y, dims: out.y.dims }, [y.buffer]);
    }
  } catch (err) {
    (self as unknown as Worker).postMessage({ id: m.id, ok: false, error: String((err as Error)?.message ?? err) });
  }
};
