import { createHash } from "node:crypto";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { ORT_WASM_PATHS } from "./src/engine/ortPaths";

// ONNX Runtime's 22 MB WebAssembly binary is loaded from jsDelivr at run time (src/engine/detector.ts sets
// ort.env.wasm.wasmPaths); don't also ship the copy the bundler discovers (it would push the site past 100 MB).
const dropOrtWasm: Plugin = {
  name: "drop-ort-wasm",
  apply: "build",
  generateBundle(_, bundle) {
    for (const k of Object.keys(bundle)) if (/ort-wasm.*\.wasm$/.test(k)) delete bundle[k];
  },
};

// Offline use (at the nets, with no signal): a service worker keeps the app's own files once visited. The analysis
// models are already kept in Cache Storage by the app (lib/modelCache.ts). Generated at build time with the list of
// files to keep, so every lazy chunk (engine, 3D viewer, worker) is there, not only the ones already opened.
const PUBLIC_SHELL = ["favicon.svg", "favicon-32.png", "apple-touch-icon.png", "icon-192.png", "icon-512.png", "site.webmanifest"];
function serviceWorker(): Plugin {
  let base = "/";
  return {
    name: "seamly-sw",
    apply: "build",
    configResolved(c) { base = c.base; },
    generateBundle(_, bundle) {
      const files = Object.keys(bundle).filter((f) => /\.(js|css|woff2?)$/.test(f)).sort();
      const shell = [base, ...files.map((f) => base + f), ...PUBLIC_SHELL.map((f) => base + f)];
      const version = createHash("sha256").update(shell.join("\n")).digest("hex").slice(0, 12);
      this.emitFile({ type: "asset", fileName: "sw.js", source: swSource(version, shell, base) });
    },
  };
}

function swSource(version: string, shell: string[], base: string): string {
  return `// Seamly service worker (generated at build time): keeps the app usable offline once it has been opened.
const SHELL = "seamly-shell-${version}";
const RUNTIME = "seamly-runtime";
const FILES = ${JSON.stringify(shell)};
const BASE = ${JSON.stringify(base)};
const ORT = ${JSON.stringify(ORT_WASM_PATHS)};

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k.startsWith("seamly-shell-") && k !== SHELL).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
const keep = (cache, req, res) => { if (res.ok) { const copy = res.clone(); caches.open(cache).then((c) => c.put(req, copy)); } return res; };
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (req.mode === "navigate" && url.origin === location.origin) {
    // the page itself: newest from the network when online (so a new release shows up at once), else the kept copy
    e.respondWith(fetch(req).then((res) => (url.pathname === BASE ? keep(SHELL, BASE, res) : res))
      .catch(() => caches.match(BASE).then((hit) => hit || Response.error())));
    return;
  }
  const own = url.origin === location.origin && url.pathname.startsWith(BASE + "assets/");
  // ONNX Runtime's WebAssembly files (fixed version, never change) and the web fonts
  const runtime = url.href.startsWith(ORT) || url.origin === "https://fonts.googleapis.com" || url.origin === "https://fonts.gstatic.com";
  if (!own && !runtime) return;
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => keep(own ? SHELL : RUNTIME, req, res))));
});
`;
}

// VITE_SITE_URL: absolute site URL (trailing slash) for social preview images in index.html; relative by default
process.env.VITE_SITE_URL ??= "/";

// VITE_BASE: sub-path the site is served from (e.g. "/Seamly/" on GitHub Pages); "/" on Vercel.
export default defineConfig({
  base: process.env.VITE_BASE || "/",
  plugins: [react(), dropOrtWasm, serviceWorker()],
  server: {
    port: 5173,
    // only used by the self-hosted server build (VITE_API=server)
    proxy: { "/api": { target: "http://127.0.0.1:8000", changeOrigin: true } },
  },
  build: { chunkSizeWarningLimit: 900, target: "es2021" },
  worker: { format: "es", plugins: () => [dropOrtWasm] },
  optimizeDeps: { exclude: ["onnxruntime-web"] },
});
