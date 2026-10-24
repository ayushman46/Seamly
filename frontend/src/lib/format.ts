/** A number for display: fixed decimals, a true minus sign (−) and no "-0". */
export const fmt = (v: number | null | undefined, d = 0) => {
  if (v === null || v === undefined || !isFinite(v)) return "–";
  const s = v.toFixed(d);
  return /^-0(\.0+)?$/.test(s) ? s.slice(1) : s.replace(/^-/, "−");
};
/** Unit after a number: degrees and % sit right after it, words get a (non-breaking) space ("120 ms"). */
export const unitLabel = (u: string) => (u === "deg" ? "°" : u === "% height" ? "% ht" : u === "%" || !u ? u : `\u00a0${u}`);
export function ago(ts: number): string {
  const s = Math.max(1, Math.floor(Date.now() / 1000 - ts));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ts * 1000).toLocaleDateString(DATE_LOCALE, { day: "numeric", month: "short", year: "numeric" });
}
/** Seconds of video converted to real (filmed) time for slowed-down clips. */
export const realSec = (s: number, slowmo: number | null | undefined) => s / Math.max(1, slowmo || 1);
export const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
/** Day-month dates ("25 Oct 2026", "Mon 26 Oct"), as cricket's audience writes them, whatever the browser's locale. */
export const DATE_LOCALE = "en-GB";
/** "24 Oct 2026, 03:40" (day and time, the same style everywhere in the app). */
export const dateTime = (ts: number, year = true) =>
  new Date(ts * 1000).toLocaleString(DATE_LOCALE, { day: "numeric", month: "short", ...(year ? { year: "numeric" } : {}), hour: "2-digit", minute: "2-digit" });
