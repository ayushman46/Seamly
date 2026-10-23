/** Where ONNX Runtime fetches its WebAssembly binary (jsDelivr keeps the site under Vercel's 100 MB limit). */
export const ORT_VERSION = "1.20.1";
export const ORT_WASM_PATHS = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
