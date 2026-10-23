/** Where the analysis models are kept after the first download (shared with the engine, which is a separate chunk). */
// bump the name when a model file changes
export const MODEL_CACHE = "seamly-models-v1";
const MODELS = ["yolo11n-pose.onnx", "yolo11s-pose.onnx", "motionbert_lite_int8.onnx"];

/** Whether every model is already in this browser (so no big download is coming). */
export async function modelsCached(): Promise<boolean> {
  try {
    const keys = await (await caches.open(MODEL_CACHE)).keys();
    return MODELS.every((m) => keys.some((k) => k.url.endsWith("/" + m)));
  } catch {
    return false;
  }
}
