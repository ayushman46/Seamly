import { describe, expect, it } from "vitest";
import { snapCorner } from "../src/lib/snap";

/** A turf-coloured picture with pale lines of a given width drawn on it (anti-aliased), plus a little noise. */
function picture(w: number, h: number, lines: { a: [number, number]; b: [number, number]; width: number }[], noise = 4) {
  const d = new Uint8ClampedArray(w * h * 4);
  let seed = 3;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let cover = 0;
    for (const l of lines) {
      const dx = l.b[0] - l.a[0], dy = l.b[1] - l.a[1], L = dx * dx + dy * dy;
      const u = Math.max(0, Math.min(1, ((x - l.a[0]) * dx + (y - l.a[1]) * dy) / L));
      const dist = Math.hypot(x - l.a[0] - u * dx, y - l.a[1] - u * dy);
      cover = Math.max(cover, Math.max(0, Math.min(1, l.width / 2 + 0.5 - dist)));
    }
    const o = (y * w + x) * 4, n = noise * rnd() * 2;
    d[o] = 150 + 85 * cover + n; d[o + 1] = 140 + 90 * cover + n; d[o + 2] = 90 + 110 * cover + n; d[o + 3] = 255;
  }
  return d;
}

describe("snapping a tap to a crease corner", () => {
  it("finds an L corner to within half a pixel from a tap ten pixels off", () => {
    const img = picture(120, 100, [{ a: [20.3, 60.6], b: [110, 58.2], width: 3 }, { a: [20.3, 60.6], b: [26.1, 12], width: 4 }]);
    const p = snapCorner(img, 120, 100, [28, 53], 16)!;
    expect(p).not.toBeNull();
    expect(Math.hypot(p[0] - 20.3, p[1] - 60.6)).toBeLessThan(0.7);
  });
  it("finds a T junction", () => {
    const img = picture(120, 100, [{ a: [0, 50.4], b: [120, 51.6], width: 3 }, { a: [60.2, 51], b: [57, 95], width: 3 }]);
    const p = snapCorner(img, 120, 100, [66, 45], 16)!;
    expect(Math.hypot(p[0] - 60.2, p[1] - 51)).toBeLessThan(0.8);
  });
  it("leaves the tap alone on plain turf, and on a single line with no corner", () => {
    expect(snapCorner(picture(120, 100, []), 120, 100, [60, 50])).toBeNull();
    expect(snapCorner(picture(120, 100, [{ a: [0, 50], b: [120, 52], width: 3 }]), 120, 100, [60, 48])).toBeNull();
  });
});
