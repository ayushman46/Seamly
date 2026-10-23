/**
 * The UI's data layer. Default build: analysis runs in this browser (api.local.ts). VITE_API=server builds
 * against a self-hosted Python backend instead (api.remote.ts). The choice is made at build time, so only
 * one of them ends up in the bundle.
 */
import { api as local } from "./api.local";
import { api as remote } from "./api.remote";

export const MODE: "browser" | "server" = import.meta.env.VITE_API === "server" ? "server" : "browser";
export const api: typeof local = MODE === "server" ? (remote as unknown as typeof local) : local;
