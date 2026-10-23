import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// ONNX Runtime's 22 MB WebAssembly binary is loaded from jsDelivr at run time (src/engine/detector.ts sets
// ort.env.wasm.wasmPaths); don't also ship the copy the bundler discovers (it would push the site past 100 MB).
const dropOrtWasm: Plugin = {
  name: "drop-ort-wasm",
  apply: "build",
  generateBundle(_, bundle) {
    for (const k of Object.keys(bundle)) if (/ort-wasm.*\.wasm$/.test(k)) delete bundle[k];
  },
};

// VITE_BASE: sub-path the site is served from (e.g. "/Seamly/" on GitHub Pages); "/" on Vercel.
export default defineConfig({
  base: process.env.VITE_BASE || "/",
  plugins: [react(), dropOrtWasm],
  server: {
    port: 5173,
    // only used by the self-hosted server build (VITE_API=server)
    proxy: { "/api": { target: "http://127.0.0.1:8000", changeOrigin: true } },
  },
  build: { chunkSizeWarningLimit: 900, target: "es2021" },
  optimizeDeps: { exclude: ["onnxruntime-web"] },
});
