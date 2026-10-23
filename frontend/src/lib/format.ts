export const fmt = (v: number | null | undefined, d = 0) => (v === null || v === undefined || !isFinite(v) ? "–" : v.toFixed(d));
export const unitLabel = (u: string) => (u === "deg" ? "°" : u === "% height" ? "% ht" : u);
export function ago(ts: number): string {
  const s = Math.max(1, Math.floor(Date.now() / 1000 - ts));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ts * 1000).toLocaleDateString();
}
/** Seconds of video converted to real (filmed) time for slowed-down clips. */
export const realSec = (s: number, slowmo: number | null | undefined) => s / Math.max(1, slowmo || 1);
export const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
/** "24 Oct 2026, 03:40" (day and time, the same style everywhere in the app). */
export const dateTime = (ts: number, year = true) =>
  new Date(ts * 1000).toLocaleString(undefined, { day: "numeric", month: "short", ...(year ? { year: "numeric" } : {}), hour: "2-digit", minute: "2-digit" });
