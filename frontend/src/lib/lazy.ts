import { lazy } from "react";
import type React from "react";

// A new build replaces the hashed chunks; a tab opened before the update then fails to load a page chunk.
// Reload once to pick up the new index.html (the flag prevents a reload loop if the server is really down).
const RELOAD_KEY = "bowlnet-chunk-reload";
export function lazyPage<T extends React.ComponentType<any>>(load: () => Promise<{ default: T }>) {
  return lazy(() => load().then((m) => {
    try { sessionStorage.removeItem(RELOAD_KEY); } catch { /* storage unavailable */ }
    return m;
  }, (err) => {
    let reloaded = true;
    try { reloaded = !!sessionStorage.getItem(RELOAD_KEY); if (!reloaded) sessionStorage.setItem(RELOAD_KEY, "1"); } catch { /* storage unavailable */ }
    if (!reloaded) {
      window.location.reload();
      return new Promise<{ default: T }>(() => undefined);
    }
    throw err;
  }));
}
