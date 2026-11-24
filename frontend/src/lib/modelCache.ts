/** Where the analysis models are kept after the first download (shared with the engine, which is a separate chunk). */
// bump the name when a model file changes
export const MODEL_CACHE = "seamly-models-v3";
const MODELS = ["rtmo-s.onnx", "rtmpose-l-halpe26-384.onnx", "motionbert_lite_int8.onnx"];
// the models of earlier versions are no longer used: give their 50 MB back
try { for (const old of ["seamly-models-v1", "seamly-models-v2"]) void caches.delete(old).catch(() => undefined); } catch { /* no Cache Storage */ }

/** Whether every model is already in this browser (so no big download is coming). */
export async function modelsCached(): Promise<boolean> {
  try {
    const keys = await (await caches.open(MODEL_CACHE)).keys();
    return MODELS.every((m) => keys.some((k) => k.url.endsWith("/" + m)));
  } catch {
    return false;
  }
}
