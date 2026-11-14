/** Small pieces of plain wording shared by the ball views (components/FaceIt.tsx, components/BallTracker.tsx). */

/** A release angle in words: degrees below the horizontal, or above it for a slow ball that has to be lobbed. */
export const angle = (down: number) => `${Math.abs(down).toFixed(1)}° ${down >= 0 ? "down" : "up"}`;
export const cm = (m: number) => `${Math.round(Math.abs(m) * 100)} cm`;
/** How high that is on a batter of about 1.8 m. */
export function heightWord(h: number): string {
  return h < 0.12 ? "at the toes" : h < 0.32 ? "ankle high" : h < 0.6 ? "knee high" : h < 0.95 ? "thigh high" : h < 1.15 ? "waist high"
    : h < 1.45 ? "chest high" : h < 1.8 ? "head high" : "over the head";
}
/** The line at the stumps in a batter's words (off: metres towards the off side of middle stump). */
export function lineWord(off: number): string {
  const a = Math.abs(off), side = off >= 0 ? "off" : "leg";
  if (a < 0.04) return "middle stump";
  if (a < 0.15) return `${side} stump`;
  if (off < 0) return a < 0.3 ? "just down the leg side" : "down the leg side";
  return a < 0.26 ? "just outside off stump" : a < 0.5 ? "outside off stump" : "wide outside off stump";
}
/** A measured value with its uncertainty: "138.9 ± 2.9". */
export function plusMinus(value: number, sigma: number, digits = 1, scale = 1): string {
  const v = (value * scale).toFixed(digits);
  return Number.isFinite(sigma) && sigma > 0 ? `${v} ± ${(sigma * scale).toFixed(digits)}` : v;
}
