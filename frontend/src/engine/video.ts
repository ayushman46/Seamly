/**
 * Video probing and frame access in the browser (counterpart of backend/bowlnet/video.py).
 *
 * Frame-accurate access uses the container's sample table (MP4/MOV via mp4box) for exact frame times and
 * seeks an HTMLVideoElement to the middle of each frame's display interval. WebM/MKV fall back to the frame
 * rate measured while the video plays.
 */
import { median } from "./nd";

export class VideoError extends Error {}

export interface Shot { start: number; end: number }

export interface VideoInfo {
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  duration: number;
  timestamps: number[];   // seconds, one per frame
  shots: Shot[];
  frameDiff: Map<number, number>;   // frame -> mean abs grey diff to the previous frame (where measured)
}

export const videoInfoDict = (v: VideoInfo) => ({
  width: v.width, height: v.height, fps: Math.round(v.fps * 1000) / 1000, frame_count: v.frameCount,
  duration: Math.round(v.duration * 1000) / 1000, shots: v.shots.map((s) => ({ start: s.start, end: s.end })),
});

/** Presentation times of the video track's samples, from the container (MP4/MOV only). */
async function sampleTimes(file: Blob): Promise<number[] | null> {
  try {
    const mod = await import("mp4box");
    const MP4Box = (mod.default ?? mod) as unknown as {
      createFile(): {
        onReady?: (info: { tracks: { id: number; type?: string; video?: unknown; timescale: number; nb_samples: number }[] }) => void;
        onError?: (e: unknown) => void;
        onSamples?: (id: number, user: unknown, samples: { cts: number; timescale: number }[]) => void;
        appendBuffer(b: ArrayBuffer & { fileStart?: number }): number;
        setExtractionOptions(id: number, user: unknown, opts: { nbSamples: number }): void;
        start(): void;
        flush(): void;
        getTrackById?(id: number): { samples?: { cts: number; timescale: number }[] };
        getTrackSamplesInfo?(id: number): { cts: number; timescale: number }[];
      };
    };
    const mp = MP4Box.createFile();
    return await new Promise<number[] | null>((resolve) => {
      let done = false;
      mp.onError = () => { if (!done) { done = true; resolve(null); } };
      mp.onReady = (info) => {
        const tr = info.tracks.find((t) => t.video || t.type === "video");
        if (!tr) { done = true; resolve(null); return; }
        // the sample table is in moov: read cts of every sample without extracting data
        const samples = mp.getTrackSamplesInfo?.(tr.id) ?? mp.getTrackById?.(tr.id)?.samples;
        if (samples && samples.length) {
          const ts = samples.map((s) => s.cts / s.timescale).sort((a, b) => a - b);
          done = true;
          resolve(ts.map((t) => t - ts[0]));
        } else {
          done = true;
          resolve(null);
        }
      };
      // feed the file in chunks until the sample table (moov) is parsed: phone clips can be hundreds of MB, and
      // mp4box tells us where to continue (it jumps over the media data when moov is at the end)
      (async () => {
        const CHUNK = 4 << 20;
        let pos = 0, steps = 0;
        while (!done && pos < file.size && steps++ < 200) {
          const buf = (await file.slice(pos, Math.min(file.size, pos + CHUNK)).arrayBuffer()) as ArrayBuffer & { fileStart?: number };
          buf.fileStart = pos;
          const next = mp.appendBuffer(buf);
          pos = typeof next === "number" && next > pos ? next : pos + buf.byteLength;
        }
        if (!done) mp.flush();
        setTimeout(() => { if (!done) { done = true; resolve(null); } }, 50);
      })().catch(() => { if (!done) { done = true; resolve(null); } });
      setTimeout(() => { if (!done) { done = true; resolve(null); } }, 15000);
    });
  } catch {
    return null;
  }
}

/** Frame rate measured from presented frames while the video plays (fallback for WebM/MKV). */
function measureFps(v: HTMLVideoElement): Promise<number | null> {
  const rvfc = (v as HTMLVideoElement & { requestVideoFrameCallback?: (cb: (now: number, md: { mediaTime: number }) => void) => number })
    .requestVideoFrameCallback;
  if (!rvfc) return Promise.resolve(null);
  return new Promise((resolve) => {
    const times: number[] = [];
    const finish = () => {
      v.pause();
      const d = times.slice(1).map((t, i) => t - times[i]).filter((x) => x > 1e-4);
      resolve(d.length >= 5 ? 1 / median(d) : null);
    };
    const cb = (_: number, md: { mediaTime: number }) => {
      times.push(md.mediaTime);
      if (times.length < 25) rvfc.call(v, cb); else finish();
    };
    rvfc.call(v, cb);
    v.muted = true;
    v.play().catch(() => resolve(null));
    setTimeout(finish, 2500);
  });
}

export class FrameSource {
  readonly video: HTMLVideoElement;
  readonly url: string;
  info!: VideoInfo;
  private constructor(video: HTMLVideoElement, url: string) { this.video = video; this.url = url; }

  static async open(file: Blob, maxSeconds: number): Promise<FrameSource> {
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    v.muted = true; v.playsInline = true; v.preload = "auto";
    v.setAttribute("playsinline", ""); v.setAttribute("muted", "");
    // Safari only decodes frames of a video that is in the document (kept invisible)
    v.style.cssText = "position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none;z-index:-1";
    document.body.appendChild(v);
    v.src = url;
    try {
      await new Promise<void>((resolve, reject) => {
        v.onloadeddata = () => resolve();
        v.onerror = () => reject(new VideoError("This browser couldn't open the video. Try an MP4 (H.264) file, or open Seamly in Chrome or Safari."));
        setTimeout(() => reject(new VideoError("The video took too long to load.")), 30000);
        v.load();
      });
      // a muted play() primes the decoder on iOS; failure is harmless elsewhere
      await v.play().then(() => v.pause(), () => undefined);
    } catch (e) {
      v.remove();
      URL.revokeObjectURL(url);
      throw e;
    }
    const fs = new FrameSource(v, url);
    if (!v.videoWidth || !v.videoHeight || !Number.isFinite(v.duration)) throw new VideoError("The video contains no decodable frames.");
    if (v.duration > maxSeconds + 0.5) {
      throw new VideoError(`Video is ${v.duration.toFixed(0)}s long; please trim it to under ${maxSeconds.toFixed(0)}s around the delivery.`);
    }
    let ts = await sampleTimes(file);
    let fps: number;
    if (ts && ts.length >= 3) {
      const d = ts.slice(1).map((t, i) => t - ts![i]).filter((x) => x > 0);
      fps = d.length ? 1 / median(d) : 30;
      // drop samples past the playable duration (edit lists can trim the end)
      ts = ts.filter((t) => t < v.duration + 0.5 / fps);
    } else {
      fps = (await measureFps(v)) ?? 30;
      fps = snapFps(fps);
      const n = Math.max(1, Math.floor(v.duration * fps + 1e-6));
      ts = Array.from({ length: n }, (_, i) => i / fps);
    }
    if (!(fps > 1 && fps < 1001)) fps = 30;
    fs.info = { width: v.videoWidth, height: v.videoHeight, fps, frameCount: ts.length, duration: ts[ts.length - 1] + 1 / fps,
      timestamps: ts, shots: [{ start: 0, end: ts.length }], frameDiff: new Map() };
    return fs;
  }

  /** Show frame i (seek to the middle of its display interval). */
  async seek(i: number): Promise<void> {
    const v = this.video, ts = this.info.timestamps;
    const next = i + 1 < ts.length ? ts[i + 1] : ts[i] + 1 / this.info.fps;
    const t = Math.min(v.duration - 1e-3, (ts[i] + next) / 2);
    if (Math.abs(v.currentTime - t) < 1e-6 && v.readyState >= 2) return;
    await new Promise<void>((resolve, reject) => {
      const to = setTimeout(() => { cleanup(); reject(new VideoError("Seeking in the video timed out.")); }, 10000);
      const cleanup = () => { clearTimeout(to); v.removeEventListener("seeked", on); };
      const on = () => { cleanup(); resolve(); };
      v.addEventListener("seeked", on);
      v.currentTime = t;
    });
    // make sure the decoded frame is the one presented (Chrome/Safari)
    const rvfc = (v as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number }).requestVideoFrameCallback;
    if (rvfc && v.readyState < 2) await new Promise<void>((r) => rvfc.call(v, () => r()));
  }

  close() {
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
    this.video.remove();
    URL.revokeObjectURL(this.url);
  }
}

function snapFps(f: number): number {
  for (const c of [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 100, 119.88, 120, 239.76, 240]) if (Math.abs(f - c) / c < 0.03) return c;
  return f;
}

// ---------------- shot signatures (cuts) and frame differences ----------------
export interface Signature { hist: Float32Array; grey: Float32Array }

/** 64x36 HSV histogram (16x8 H/S bins, L2-normalised) + grey thumbnail, like video._shot_signature. */
export function signature(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, src: CanvasImageSource, w: number, h: number): Signature {
  ctx.drawImage(src, 0, 0, w, h, 0, 0, 64, 36);
  const { data } = ctx.getImageData(0, 0, 64, 36);
  const hist = new Float32Array(128), grey = new Float32Array(64 * 36);
  for (let i = 0; i < 64 * 36; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    const v = Math.max(r, g, b), mn = Math.min(r, g, b), d = v - mn;
    const s = v === 0 ? 0 : (255 * d) / v;
    let hh = 0;
    if (d > 0) {
      if (v === r) hh = (60 * (g - b)) / d; else if (v === g) hh = 120 + (60 * (b - r)) / d; else hh = 240 + (60 * (r - g)) / d;
      if (hh < 0) hh += 360;
    }
    hist[Math.min(15, Math.floor(hh / 2 / 11.25)) * 8 + Math.min(7, Math.floor(s / 32))] += 1;
    grey[i] = 0.299 * r + 0.587 * g + 0.114 * b;
  }
  let n2 = 0;
  for (const x of hist) n2 += x * x;
  const nn = Math.sqrt(n2) || 1;
  for (let i = 0; i < 128; i++) hist[i] /= nn;
  return { hist, grey };
}

export function sigDistance(a: Signature, b: Signature): [number, number] {
  // 1 - correlation of the histograms, mean abs grey difference
  const n = a.hist.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a.hist[i]; mb += b.hist[i]; }
  ma /= n; mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { const x = a.hist[i] - ma, y = b.hist[i] - mb; num += x * y; da += x * x; db += y * y; }
  const corr = da > 0 && db > 0 ? num / Math.sqrt(da * db) : 1;
  let pd = 0;
  for (let i = 0; i < a.grey.length; i++) pd += Math.abs(a.grey[i] - b.grey[i]);
  return [1 - corr, pd / a.grey.length];
}

/** Hard cuts: a histogram jump that is large both absolutely and relative to the local motion level. */
export function segmentShots(histD: number[], pixD: number[], frames: number[], n: number, fps: number): Shot[] {
  if (n < 2 || frames.length < 2) return [{ start: 0, end: n }];
  const cuts: number[] = [];
  for (let i = 0; i < histD.length; i++) {
    const lo = Math.max(0, i - 8), hi = Math.min(histD.length, i + 9);
    const around = [...histD.slice(lo, i), ...histD.slice(i + 1, hi)];
    const local = around.length ? median(around) : 0;
    const h = histD[i], p = pixD[i];
    const strong = (h > 0.45 && p > 18) || p > 45;
    const relative = h > 4.0 * local + 0.15 && p > 12;
    if (strong || relative) cuts.push(frames[i + 1]);   // cut happens before this frame
  }
  const bounds = [0, ...cuts, n];
  let shots: Shot[] = [];
  for (let i = 0; i + 1 < bounds.length; i++) if (bounds[i + 1] > bounds[i]) shots.push({ start: bounds[i], end: bounds[i + 1] });
  // merge flashes / transition frames (< ~0.2 s) into the previous shot
  const minLen = Math.max(3, Math.round(0.2 * fps));
  const merged: Shot[] = [];
  for (const s of shots) {
    if (merged.length && s.end - s.start < minLen) merged[merged.length - 1] = { start: merged[merged.length - 1].start, end: s.end };
    else merged.push(s);
  }
  if (merged.length > 1 && merged[0].end - merged[0].start < minLen) {
    merged[1] = { start: merged[0].start, end: merged[1].end };
    merged.shift();
  }
  shots = merged;
  return shots;
}

/**
 * Share of frames in [start, end) that repeat the previous frame (frame-doubling slow motion or frame-rate
 * conversion): (near) pixel-identical while a genuinely new frame nearby clearly differs.
 */
export function repeatedFraction(info: VideoInfo, start: number, end: number): number {
  if (end - start < 6) return 0;
  const d: number[] = [];
  for (let f = Math.max(1, start); f < end; f++) if (info.frameDiff.has(f)) d.push(info.frameDiff.get(f)!);
  if (!d.length) return 0;
  let rep = 0;
  for (let i = 0; i < d.length; i++) {
    let lm = 0;
    for (let k = Math.max(0, i - 4); k < Math.min(d.length, i + 5); k++) lm = Math.max(lm, d[k]);
    if (d[i] < 0.15 && d[i] < 0.1 * lm) rep++;
  }
  return rep / d.length;
}
