/** Data layer for a self-hosted Seamly server (the Python backend in backend/, which can run SAM 3D Body).
 *  Selected at build time with VITE_API=server; the default build analyses in the browser (api.local.ts). */
import type { AnalysisMeta, AnalysisResult, EventKey, Insights, Player, PlayerProgress } from "./types";

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.detail) msg = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch {
      /* not json */
    }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

const JSON_HDR = { "Content-Type": "application/json" };

export const api = {
  health: () => fetch("/api/health").then((r) => j<{ ok: boolean; device: string; missing_models: string[] }>(r)),
  list: () => fetch("/api/analyses").then((r) => j<AnalysisMeta[]>(r)),
  get: (id: string) => fetch(`/api/analyses/${id}`).then((r) => j<{ meta: AnalysisMeta; result?: AnalysisResult }>(r)),
  status: (id: string) => fetch(`/api/analyses/${id}/status`).then((r) => j<AnalysisMeta>(r)),
  remove: (id: string) => fetch(`/api/analyses/${id}`, { method: "DELETE" }).then((r) => j<{ deleted: string }>(r)),
  recompute: (id: string, body: { events?: Partial<Record<EventKey, number | null>>; bowling_arm?: string; height_m?: number; view?: string }) =>
    fetch(`/api/analyses/${id}/recompute`, { method: "POST", headers: JSON_HDR, body: JSON.stringify(body) }).then((r) =>
      j<{ meta: AnalysisMeta; result: AnalysisResult }>(r)),
  reset: (id: string, eventsOnly = false) =>
    fetch(`/api/analyses/${id}/reset`, { method: "POST", headers: JSON_HDR, body: JSON.stringify({ events_only: eventsOnly }) }).then((r) =>
      j<{ meta: AnalysisMeta; result: AnalysisResult }>(r)),
  rerun: (id: string, body: { candidate?: number; bowling_arm?: string; height_m?: number; slowmo_factor?: number }) =>
    fetch(`/api/analyses/${id}/rerun`, { method: "POST", headers: JSON_HDR, body: JSON.stringify(body) }).then((r) => j<{ id: string }>(r)),
  demo: (_which?: string) => fetch("/api/demo", { method: "POST" }).then((r) => j<{ id: string }>(r)),
  analyseSample: (_which?: string) => fetch("/api/demo", { method: "POST" }).then((r) => j<{ id: string }>(r)),
  patch: (id: string, body: { name?: string; player_id?: string | null }) =>
    fetch(`/api/analyses/${id}`, { method: "PATCH", headers: JSON_HDR, body: JSON.stringify(body) }).then((r) => j<AnalysisMeta>(r)),
  insights: (id: string) => fetch(`/api/analyses/${id}/insights`).then((r) => j<Insights>(r)),
  players: () => fetch("/api/players").then((r) => j<Player[]>(r)),
  createPlayer: (body: Partial<Player>) =>
    fetch("/api/players", { method: "POST", headers: JSON_HDR, body: JSON.stringify(body) }).then((r) => j<Player>(r)),
  updatePlayer: (pid: string, body: Partial<Player>) =>
    fetch(`/api/players/${pid}`, { method: "PATCH", headers: JSON_HDR, body: JSON.stringify(body) }).then((r) => j<Player>(r)),
  removePlayer: (pid: string) => fetch(`/api/players/${pid}`, { method: "DELETE" }).then((r) => j<{ deleted: string }>(r)),
  progress: (pid: string) => fetch(`/api/players/${pid}/progress`).then((r) => j<PlayerProgress>(r)),
  upload: (file: File, opts: { bowling_arm: string; height_cm?: number; slowmo_factor: number; player_id?: string | null }, onProgress?: (f: number) => void) =>
    new Promise<{ id: string }>((resolve, reject) => {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("bowling_arm", opts.bowling_arm);
      if (opts.height_cm) fd.append("height_cm", String(opts.height_cm));
      fd.append("slowmo_factor", String(opts.slowmo_factor));
      if (opts.player_id) {
        fd.append("player_id", opts.player_id);
        fd.append("profile_defaults", "false");   // the form was pre-filled from the profile; keep what the user chose
      }
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/analyses");
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
      xhr.onload = () => {
        try {
          const body = JSON.parse(xhr.responseText || "{}");
          if (xhr.status >= 200 && xhr.status < 300) resolve(body);
          else reject(new Error(body?.detail || `Upload failed (${xhr.status})`));
        } catch {
          reject(new Error(`Upload failed (${xhr.status})`));
        }
      };
      xhr.onerror = () => reject(new Error("Network error - is the Seamly server running?"));
      xhr.send(fd);
    }),
  frameUrl: (id: string, frame: number) => `/api/analyses/${id}/frames/${frame}.jpg`,
  meshUrl: (id: string, name: "mesh_rest.bin" | "pose.bin") => `/api/analyses/${id}/mesh/${name}`,
  exportUrl: (id: string, kind: "json" | "csv") => `/api/analyses/${id}/export/${kind}`,
  objUrl: (id: string, frame: number) => `/api/analyses/${id}/export/obj?frame=${frame}`,
  videoUrl: (id: string) => `/api/analyses/${id}/video`,
};
