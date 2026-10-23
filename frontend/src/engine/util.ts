/** Python-compatible rounding and formatting helpers. */

/** Python f"{x:.{n}f}": correctly rounded on the exact binary value, exact ties to even (toFixed ties away). */
export function fmt(x: number, n = 0): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  const neg = x < 0 || Object.is(x, -0);
  const ax = Math.abs(x);
  let s = ax.toFixed(n);   // exact except for ties
  // a tie is only possible if the (n+1)-digit rendering ends in 5; then look at the exact expansion
  if (ax.toFixed(n + 1).endsWith("5")) {
    const exact = ax.toFixed(Math.min(100, n + 80));
    const dot = exact.indexOf(".");
    const frac = exact.slice(dot + 1);
    if (frac[n] === "5" && /^0*$/.test(frac.slice(n + 1))) {
      const trunc = n > 0 ? exact.slice(0, dot + 1 + n) : exact.slice(0, dot);
      if (Number(trunc[trunc.length - 1]) % 2 === 0) s = trunc;
    }
  }
  return (neg ? "-" : "") + s;
}

/** Python round(x, n). */
export function round(x: number, n = 0): number {
  if (!Number.isFinite(x)) return x;
  return Number(fmt(x, n)) + 0;
}

/** zlib.crc32 of a UTF-8 string (insights uses it for stable checkbox ids). */
export function crc32(s: string): number {
  let c = ~0 >>> 0;
  const bytes = new TextEncoder().encode(s);
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return (~c) >>> 0;
}
