// Local engine test harness only (not used by the build): no reloads while files change, plus a dev-only
// endpoint that writes the browser engine's output into public/samples/ (to regenerate the bundled samples).
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

const saveSample: Plugin = {
  name: "save-sample",
  configureServer(server) {
    server.middlewares.use("/__save", (req, res) => {
      const rel = normalize(new URL(req.url ?? "", "http://x").searchParams.get("path") ?? "");
      if (!rel.startsWith("samples/") || rel.includes("..")) { res.statusCode = 400; res.end("bad path"); return; }
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const out = join(__dirname, "public", rel);
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, Buffer.concat(chunks));
        res.end("ok");
      });
    });
  },
};

export default defineConfig({
  plugins: [react(), saveSample],
  server: { port: 5180, strictPort: true, hmr: false, watch: { ignored: ["**/*"] } },
  optimizeDeps: { include: ["mp4box"], exclude: ["onnxruntime-web"] },
});
