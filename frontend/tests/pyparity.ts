/** Deep comparison against Python JSON output: same keys in the same order, same strings/booleans/nulls, numbers
 * within `tol` (-0 equals 0). Returns the differing paths (empty = parity). */
export function deepDiff(a: unknown, b: unknown, tol = 1e-6, path = ""): string[] {
  if (typeof a === "number" && typeof b === "number") {
    if (Number.isNaN(a) && Number.isNaN(b)) return [];
    return Math.abs(a - b) <= tol || a === b ? [] : [`${path}: ${a} != ${b}`];
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return [`${path}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`];
    if (a.length !== b.length) return [`${path}: length ${a.length} != ${b.length}`];
    return a.flatMap((x, i) => deepDiff(x, b[i], tol, `${path}[${i}]`));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.join() !== kb.join()) return [`${path}: keys [${ka}] != [${kb}]`];
    return ka.flatMap((k) => deepDiff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], tol, `${path}.${k}`));
  }
  return a === b ? [] : [`${path}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`];
}
