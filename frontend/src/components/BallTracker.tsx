import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AnalysisMeta, AnalysisResult } from "../types";
import { api } from "../api";
import { FrameSource } from "../engine/video";
import { solveCamera, isCamera, project, cameraEnd, lookDown, worldOf as worldOfMark, PITCH_LEN, POPPING, RETURN_X, STUMP_TOP, STUMP_X, type Camera, type CameraProblem, type Mark, type MarkKind, type End, type Pt } from "../lib/camcal";
import { snapCorner } from "../lib/snap";
import { findPitch, pitchFound } from "../lib/autopitch";
import { poseHints, scan, autoTrack, refit, withDoubt, recordOf, shiftsOf, priorsOf, type Scan, type Sighting, type Upright, type TrackRecord } from "../lib/tracker";
import { isTracked, type Tracked, type TrackProblem } from "../lib/balltrack";
import { applyShift, invertShift, STILL, type Shift } from "../lib/ballfind";
import { LENGTHS, lengthName, STUMPS_Z, STUMP_H, STUMPS_W, BALL_R } from "../lib/flight";
import { cm, heightWord, lineWord, plusMinus } from "../lib/words";
import type { V3 } from "../lib/biomech";
import { measureOnPitch } from "../lib/onpitch";
import { ICheck, IEye, INext, IPrev, IRefresh, ISun, ITarget, ITrash, IX } from "./Icons";

/**
 * Track the ball: the real flight of this delivery, measured from the video.
 *
 *   1. Mark the pitch: a few crease corners and stumps on one frame. The pitch's known measurements turn those into
 *      the camera (lib/camcal.ts); the pitch is then drawn back over the picture so the fit can be checked by eye.
 *   2. Find the ball: the frames after release are searched for the ball and its shadow (lib/ballfind.ts) and a
 *      flight is fitted through the sightings (lib/balltrack.ts). Every sighting can be checked frame by frame, moved,
 *      added or removed, and the flight re-fits at once.
 *   3. The result: speed, where it pitched, swing, movement off the pitch, and where it passed the stumps, each with
 *      its uncertainty. Saved with the analysis; "Face it" then replays this very ball.
 */

type PKind = "pop_l" | "pop_r" | "bowl_l" | "bowl_r" | "stump_base" | "stump_top";
interface PMark { near: boolean; kind: PKind; px: Pt }   // a mark as the picture shows it: near or far end, left or right
const TARGETS: { near: boolean; kind: PKind; label: string }[] = [
  { near: false, kind: "pop_l", label: "Far end: popping crease meets the left return crease" },
  { near: false, kind: "pop_r", label: "Far end: popping crease meets the right return crease" },
  { near: true, kind: "pop_l", label: "Near end: popping crease meets the left return crease" },
  { near: true, kind: "pop_r", label: "Near end: popping crease meets the right return crease" },
  { near: false, kind: "bowl_l", label: "Far end: stump line (bowling crease) meets the left return crease" },
  { near: false, kind: "bowl_r", label: "Far end: stump line (bowling crease) meets the right return crease" },
  { near: true, kind: "bowl_l", label: "Near end: stump line (bowling crease) meets the left return crease" },
  { near: true, kind: "bowl_r", label: "Near end: stump line (bowling crease) meets the right return crease" },
  { near: false, kind: "stump_base", label: "Far end: foot of the middle stump" },
  { near: false, kind: "stump_top", label: "Far end: top of the middle stump" },
  { near: true, kind: "stump_base", label: "Near end: foot of the middle stump" },
  { near: true, kind: "stump_top", label: "Near end: top of the middle stump" },
];
const other = (e: End): End => (e === "bowler" ? "batter" : "bowler");
const flipSide = (k: string) => (/_[lr]$/.test(k) ? k.slice(0, -1) + (k.endsWith("l") ? "r" : "l") : k);
/** Picture to pitch: from behind the bowler, the picture's left is the pitch's -x; from behind the batter it is +x. */
const toWorld = (m: PMark, nearEnd: End): Mark => ({ end: m.near ? nearEnd : other(nearEnd), kind: (nearEnd === "batter" ? flipSide(m.kind) : m.kind) as MarkKind, px: m.px });
const fromWorld = (m: Mark, nearEnd: End): PMark => ({ near: m.end === nearEnd, kind: (nearEnd === "batter" ? flipSide(m.kind) : m.kind) as PKind, px: m.px });

// the pitch as lines, to draw back over the picture
const WIRE: [V3, V3][] = (() => {
  const L: [V3, V3][] = [], X = RETURN_X;
  for (const [z0, to] of [[0, -1], [-PITCH_LEN, 1]] as const) {
    L.push([[-X, 0, z0], [X, 0, z0]], [[-1.83, 0, z0 + to * POPPING], [1.83, 0, z0 + to * POPPING]]);
    for (const sx of [-1, 1]) L.push([[sx * X, 0, z0 + to * POPPING], [sx * X, 0, z0 - to * POPPING]]);
    for (const sx of [-STUMP_X, 0, STUMP_X]) L.push([[sx, 0, z0], [sx, STUMP_TOP, z0]]);
    L.push([[-STUMP_X, STUMP_TOP, z0], [STUMP_X, STUMP_TOP, z0]]);
  }
  for (const sx of [-1.525, 1.525]) L.push([[sx, 0, POPPING], [sx, 0, -PITCH_LEN - POPPING]]);
  return L;
})();

const BAND_CSS = ["#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#8b5cf6"];

export default function BallTracker({ id, result, meta, name, onClose, onMeta, onFace, flash, onPitch }: {
  id: string; result: AnalysisResult; meta: AnalysisMeta; name: string; onClose: () => void;
  onMeta: (m: AnalysisMeta) => void; onFace: () => void; flash: (text: string, bad?: boolean) => void;
  /** Only the pitch is wanted (for measuring the bowler on it): called with the marks once the camera fits. */
  onPitch?: (rec: { w: number; h: number; markFrame: number; marks: Mark[] }) => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLCanvasElement>(null);
  const loupeRef = useRef<HTMLCanvasElement>(null);
  const frameCanvas = useRef<HTMLCanvasElement | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const [src, setSrc] = useState<{ fs: FrameSource; w: number; h: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<"marks" | "ball">("marks");
  const [frame, setFrame] = useState(result.events.br?.frame ?? result.frames.start);
  const [markFrame, setMarkFrame] = useState(frame);
  const [pm, setPm] = useState<PMark[]>([]);
  const [target, setTarget] = useState(0);
  const [nearEnd, setNearEnd] = useState<End>(result.view.view === "front_on" ? "batter" : "bowler");
  const [sc, setSc] = useState<Scan | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [sightings, setSightings] = useState<Sighting[]>([]);
  const [upright, setUpright] = useState<Upright | null>(null);
  const [mode, setMode] = useState<"ball" | "shadow" | "sun1" | "sun2">("ball");
  const [tracked, setTracked] = useState<Tracked | TrackProblem | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [aim, setAim] = useState<Pt | null>(null);
  const cancel = useRef(false);
  // how the pitch gets marked: found from its creases with no help, around two taps on the stumps, or corner by corner
  const [pitchMode, setPitchMode] = useState<"auto" | "taps" | "hand">("auto");
  const [looking, setLooking] = useState(false);
  const [taps, setTaps] = useState<Pt[]>([]);
  const [foundBy, setFoundBy] = useState<"auto" | "taps" | null>(null);
  const [tapsFailed, setTapsFailed] = useState(false);
  const goOn = useRef(false);
  const canView = result.view.view !== "side_on";

  // the video, frame by frame
  useEffect(() => {
    let live = true, opened: FrameSource | null = null;
    (async () => {
      try {
        const blob = await (await fetch(api.videoUrl(id))).blob();
        const fs = await FrameSource.open(blob, 1e9);
        opened = fs;
        if (!live) { fs.close(); return; }
        const k = Math.min(1, 1920 / fs.info.width), w = Math.round(fs.info.width * k), h = Math.round(fs.info.height * k);
        const c = document.createElement("canvas"); c.width = w; c.height = h;
        frameCanvas.current = c;
        setSrc({ fs, w, h });
      } catch (e) { if (live) setError((e as Error).message || "The video could not be opened."); }
    })();
    return () => { live = false; cancel.current = true; opened?.close(); };
  }, [id]);

  // the release frame: the bowling analysis's, unless it is put right here (then nothing else is taken from the pose)
  const [relFrame, setRelFrame] = useState<number | null>(null);
  const [relLoose, setRelLoose] = useState(false);   // the release was taken from the ball, not set by hand
  const hints = useMemo(() => {
    const h0 = src ? poseHints(result, src.w) : null;
    // the release measured on the pitch, when this clip has one: where the ball starts is then measured, not assumed
    const ms = meta.track?.measured ?? (meta.onpitch?.release && meta.onpitch.releaseSigma ? [meta.onpitch.release[2], meta.onpitch.front ? 0.25 : 0.45, meta.onpitch.release[1], meta.onpitch.releaseSigma[1]] : null);
    const h = h0 && ms ? { ...h0, measured: { z: ms[0], zSigma: ms[1], height: ms[2], heightSigma: ms[3], frame: ms.length > 4 ? ms[4] : null } } : h0;
    return h && relFrame !== null && relFrame !== h.releaseFrame ? { ...h, releaseFrame: relFrame, releaseTSigma: relLoose ? 1.5 : undefined, hand: null, ankles: [], releaseHeight: null } : h;
  }, [result, src, relFrame, relLoose, meta.track?.measured, meta.onpitch?.release]);   // eslint-disable-line react-hooks/exhaustive-deps
  const marks = useMemo(() => pm.map((m) => toWorld(m, nearEnd)), [pm, nearEnd]);
  const cam: Camera | CameraProblem | null = useMemo(() => (src && marks.length >= 4 ? solveCamera(marks, src.w, src.h) : null), [marks, src]);
  const camera = isCamera(cam) ? cam : null;
  const tr = isTracked(tracked) ? tracked : null;

  // one frame at a time through the video element
  const enqueue = useCallback(<T,>(job: () => Promise<T>): Promise<T> => {
    const p = queue.current.then(job, job);
    queue.current = p.catch(() => undefined);
    return p;
  }, []);
  const grab = useCallback(async (f: number) => {
    const { fs, w, h } = src!, g = frameCanvas.current!.getContext("2d", { willReadFrequently: true })!;
    await fs.seek(Math.max(0, Math.min(fs.info.frameCount - 1, f)));
    g.drawImage(fs.video, 0, 0, w, h);
    return g;
  }, [src]);

  // what the painter needs, always current
  const V = useRef({ frame, markFrame, pm, target, step, camera, sc, sightings, upright, tr, mode, shown: -1, aim, taps });
  V.current = { ...V.current, frame, markFrame, pm, target, step, camera, sc, sightings, upright, tr, mode, aim, taps };

  const shiftOf = (f: number): Shift | null => V.current.sc?.shifts.get(f) ?? (f === V.current.markFrame ? STILL : null);
  const paint = useCallback(() => {
    const c = stageRef.current, fc = frameCanvas.current, v = V.current;
    if (!c || !fc) return;
    const g = c.getContext("2d")!, k = c.width / Math.max(1, c.getBoundingClientRect().width);
    g.drawImage(fc, 0, 0);
    if (v.shown !== v.frame) return;
    const m = shiftOf(v.frame), back = m ? invertShift(m) : null;
    const here = (p: Pt | null): Pt | null => (p && back ? applyShift(back, p) : null);   // marked frame's pixels -> this frame's
    g.lineCap = "round"; g.lineJoin = "round";
    if (v.camera && back) {
      g.strokeStyle = "rgba(56, 189, 248, 0.9)"; g.lineWidth = 1.4 * k;
      g.beginPath();
      for (const [a, b] of WIRE) { const p = here(project(v.camera, a)), q = here(project(v.camera, b)); if (p && q) { g.moveTo(p[0], p[1]); g.lineTo(q[0], q[1]); } }
      g.stroke();
    }
    const dot = (p: Pt, r: number, fill: string | null, stroke: string | null, lw = 2) => {
      g.beginPath(); g.arc(p[0], p[1], r * k, 0, 2 * Math.PI);
      if (fill) { g.fillStyle = fill; g.fill(); }
      if (stroke) { g.strokeStyle = stroke; g.lineWidth = lw * k; g.stroke(); }
    };
    if (v.step === "marks") for (const tp of v.taps) { dot(tp, 9, null, "#fbbf24", 2); dot(tp, 2, "#fbbf24", null); }
    if (v.step === "marks" && v.frame === v.markFrame) {
      v.pm.forEach((mk) => {
        const cur = TARGETS[v.target] && TARGETS[v.target].near === mk.near && TARGETS[v.target].kind === mk.kind;
        dot(mk.px, 7, null, cur ? "#fbbf24" : "#f472b6", 2); dot(mk.px, 1.6, cur ? "#fbbf24" : "#f472b6", null);
      });
    }
    if (v.step === "ball") {
      const t = v.tr;
      if (t && v.camera && back) {
        // the fitted flight: blue to the bounce, amber after it
        const tp = t.pitch?.t ?? Infinity;
        for (const part of [0, 1]) {
          g.beginPath(); let started = false;
          for (const s of t.samples) {
            if (part === 0 ? s.t > tp + 0.004 : s.t < tp - 0.004) continue;
            const p = here(project(v.camera, s.p));
            if (!p) continue;
            if (started) g.lineTo(p[0], p[1]); else { g.moveTo(p[0], p[1]); started = true; }
          }
          g.strokeStyle = part === 0 ? "rgba(125, 211, 252, 0.95)" : "rgba(251, 191, 36, 0.95)"; g.lineWidth = 2 * k; g.stroke();
        }
        if (t.pitch) { const p = here(project(v.camera, [t.pitch.p[0], 0, t.pitch.p[2]])); if (p) dot(p, 6, null, "#ffffff", 2); }
      }
      for (const s of v.sightings) {
        const ms = shiftOf(s.frame);
        if (!ms) continue;
        const p = here(applyShift(ms, s.px));
        if (!p) continue;
        if (s.frame === v.frame) {
          dot(p, 11, null, "#ffffff", 2);
          if (s.shadow) { const q = here(applyShift(ms, s.shadow)); if (q) dot(q, 8, null, "#22d3ee", 2); }
        } else dot(p, 1.5, s.auto === false ? "rgba(251, 191, 36, 0.9)" : "rgba(255, 255, 255, 0.75)", null);
      }
      if (v.upright) {
        const mu = shiftOf(v.upright.frame);
        if (mu) { const a = here(applyShift(mu, v.upright.foot)), b = here(applyShift(mu, v.upright.tip)); if (a && b) { g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.strokeStyle = "#fde047"; g.lineWidth = 2 * k; g.stroke(); dot(a, 3, "#fde047", null); dot(b, 3, "#fde047", null); } }
      }
    }
    // the magnifier
    const lp = loupeRef.current;
    if (lp) {
      const a = v.aim;
      lp.style.display = a ? "block" : "none";
      if (a) {
        const lg = lp.getContext("2d")!, Z = 5, half = lp.width / (2 * Z);
        lg.imageSmoothingEnabled = false;
        lg.fillStyle = "#000"; lg.fillRect(0, 0, lp.width, lp.height);
        lg.drawImage(c, a[0] - half, a[1] - half, 2 * half, 2 * half, 0, 0, lp.width, lp.height);
        lg.strokeStyle = "rgba(255,255,255,0.9)"; lg.lineWidth = 1;
        lg.beginPath(); lg.moveTo(lp.width / 2, 0); lg.lineTo(lp.width / 2, lp.height / 2 - 6); lg.moveTo(lp.width / 2, lp.height / 2 + 6); lg.lineTo(lp.width / 2, lp.height);
        lg.moveTo(0, lp.height / 2); lg.lineTo(lp.width / 2 - 6, lp.height / 2); lg.moveTo(lp.width / 2 + 6, lp.height / 2); lg.lineTo(lp.width, lp.height / 2); lg.stroke();
        lp.style.left = a[0] < c.width / 2 ? "auto" : "8px"; lp.style.right = a[0] < c.width / 2 ? "8px" : "auto";
      }
    }
  }, []);

  // show the current frame
  useEffect(() => {
    if (!src || progress !== null || looking) return;
    let live = true;
    enqueue(async () => { if (!live) return; await grab(frame); V.current.shown = frame; paint(); }).catch(() => undefined);
    return () => { live = false; };
  }, [src, frame, progress, looking, enqueue, grab, paint]);
  useEffect(() => { paint(); });

  // a saved track: put everything back as it was left
  const restored = useRef(false);
  useEffect(() => {
    const rec = meta.track;
    if (!src || !hints || restored.current) return;
    restored.current = true;
    if (onPitch && meta.onpitch?.marks?.length && !rec) {
      // the pitch was marked before, for measuring on it: the same marks, to check or put right
      const o = meta.onpitch, k = src.w / o.w;
      const ms: Mark[] = o.marks.map((m) => ({ ...m, px: [m.px[0] * k, m.px[1] * k] }));
      const c0 = solveCamera(ms, src.w, src.h), ne = isCamera(c0) ? cameraEnd(c0) : nearEnd;
      setPitchMode("hand"); setNearEnd(ne); setPm(ms.map((m) => fromWorld(m, ne))); setMarkFrame(o.markFrame); setFrame(o.markFrame); setTarget(TARGETS.length);
      return;
    }
    if (!rec && !onPitch && meta.onpitch?.marks?.length) {
      // the pitch was already found for this clip (measuring on it): the same camera, straight on to the ball
      const o = meta.onpitch, k = src.w / o.w;
      // (with the batter's wicket when it was found: the ball has to be followed to that end)
      const ms: Mark[] = (o.far?.length ? [...o.marks.filter((m) => m.end === "bowler"), ...o.far] : o.marks).map((m) => ({ ...m, px: [m.px[0] * k, m.px[1] * k] }));
      const c0 = solveCamera(ms, src.w, src.h);
      if ((o.far?.length || o.marks.some((m) => m.end === "batter")) && isCamera(c0) && c0.rms < Math.max(4, src.w / 300)) {
        const ne = cameraEnd(c0);
        setPitchMode("auto"); setFoundBy("auto"); setNearEnd(ne); setPm(ms.map((m) => fromWorld(m, ne))); setMarkFrame(o.markFrame); setFrame(o.markFrame); setTarget(TARGETS.length);
        looked.current = true; goOn.current = true;
        return;
      }
    }
    if (!rec || rec.v !== 1 || !rec.marks?.length) return;
    setPitchMode("hand");
    const k = src.w / rec.w, sp = (p: Pt): Pt => [p[0] * k, p[1] * k];
    const ms: Mark[] = rec.marks.map((m) => ({ ...m, px: sp(m.px) }));
    const c0 = solveCamera(ms, src.w, src.h);
    if (!isCamera(c0)) return;
    const ne = cameraEnd(c0), shifts = new Map([...shiftsOf(rec)].map(([f, m]) => [f, { ...m, dx: m.dx * k, dy: m.dy * k }]));
    const st = rec.sightings.map((s) => ({ ...s, px: sp(s.px), shadow: s.shadow ? sp(s.shadow) : null }));
    const up = rec.upright ? { frame: rec.upright.frame, foot: sp(rec.upright.foot), tip: sp(rec.upright.tip) } : null;
    setNearEnd(ne); setPm(ms.map((m) => fromWorld(m, ne))); setMarkFrame(rec.markFrame); setTarget(TARGETS.length);
    if (rec.release != null) { setRelFrame(rec.release); setRelLoose((rec.releaseSigma ?? 0) > 1); }
    setSc({ frames: [...shifts.keys()].sort((a, b) => a - b), shifts, cands: new Map(), still: false });
    setSightings(st); setUpright(up); setStep("ball"); setFrame(st[0]?.frame ?? rec.markFrame);
    const h0 = rec.release != null && rec.release !== hints.releaseFrame ? { ...hints, releaseFrame: rec.release, releaseTSigma: rec.releaseSigma ?? undefined, hand: null, ankles: [], releaseHeight: null } : hints;
    const t = refit(c0, st, shifts, h0, up);
    setTracked(isTracked(t) ? withDoubt(t, c0, ms, st, shifts, h0, up) : t);
  }, [src, hints, meta.track]);

  // marks from the pitch finder, as if they had been tapped
  const adopt = (ms: Mark[], f: number, by: "auto" | "taps") => {
    setPm(ms.map((m) => ({ near: m.end === "bowler", kind: m.kind as PKind, px: m.px })));
    setMarkFrame(f); setFrame(f); setTarget(TARGETS.length); setFoundBy(by); setTaps([]); setTapsFailed(false);
    setSc(null); setSightings([]); setTracked(null);
  };
  // on opening: look for the pitch with no help, on a few frames around the release (a crease hidden behind the
  // bowler in one is clear in another). Found: straight on to the ball. Not found: ask for two taps.
  const looked = useRef(false);
  useEffect(() => {
    if (!src || !hints || looked.current) return;
    looked.current = true;
    const had = meta.track?.marks?.length || (onPitch && meta.onpitch?.marks?.length);
    if (had || !canView || onPitch) { if (!had) setPitchMode("taps"); return; }
    let live = true;
    setLooking(true);
    (async () => {
      const clamp = (f: number) => Math.max(hints.first, Math.min(hints.last, f));
      const tries = [...new Set([hints.releaseFrame - Math.round(0.45 * hints.fps), hints.releaseFrame + Math.round(0.12 * hints.fps), hints.releaseFrame - Math.round(0.9 * hints.fps)].map(clamp))];
      let got: { marks: Mark[]; f: number } | null = null;
      for (const f of tries) {
        const img = await enqueue(async () => (await grab(f)).getImageData(0, 0, src.w, src.h).data);
        await new Promise((r) => setTimeout(r, 0));
        if (!live) return;
        const r = findPitch(img, src.w, src.h);
        if (pitchFound(r)) { got = { marks: r.marks, f }; break; }
      }
      if (!live) return;
      V.current.shown = -1;
      if (got) { adopt(got.marks, got.f, "auto"); setPitchMode("auto"); goOn.current = true; } else setPitchMode("taps");
      setLooking(false);
    })().catch(() => { if (live) { setPitchMode("taps"); setLooking(false); } });
    return () => { live = false; };
  }, [src, hints]);   // eslint-disable-line react-hooks/exhaustive-deps

  // the dialog: Esc closes, the page behind stays put, arrows step frames
  const frames = step === "ball" && sc ? sc.frames : null;
  const stepFrame = useCallback((d: number) => {
    setFrame((f) => {
      if (frames) { const i = frames.indexOf(f), j = Math.max(0, Math.min(frames.length - 1, (i < 0 ? 0 : i) + d)); return frames[j]; }
      return Math.max(hints?.first ?? 0, Math.min(hints?.last ?? f, f + d));
    });
  }, [frames, hints]);
  useEffect(() => {
    const before = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "SELECT") return;
      if (e.key === "ArrowLeft") { e.preventDefault(); stepFrame(-1); }
      if (e.key === "ArrowRight") { e.preventDefault(); stepFrame(1); }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = before; };
  }, [onClose, stepFrame]);

  const fitNow = (st: Sighting[], up: Upright | null, c: Camera | null = camera, s: Scan | null = sc, ms: Mark[] = marks) => {
    if (!c || !s || !hints) return;
    const t = refit(c, st, s.shifts, hints, up);
    setTracked(isTracked(t) ? withDoubt(t, c, ms, st, s.shifts, hints, up) : t);
    setDirty(true);
  };

  // a press on the picture: aim with the magnifier, let go to place
  const at = (e: React.PointerEvent): Pt => {
    const c = stageRef.current!, r = c.getBoundingClientRect();
    return [((e.clientX - r.left) * c.width) / r.width, ((e.clientY - r.top) * c.height) / r.height];
  };
  const place = (p: Pt) => {
    if (!src || V.current.shown !== frame) return;
    if (step === "marks" && pitchMode !== "hand" && onPitch) {
      // Measuring on the pitch: four taps, the foot and the top of the middle stump at each end, in any order. They
      // pair up by standing one above the other; the taller pair is the near stump. A level camera follows from
      // them alone (lib/camcal.ts), and the stump's own height is the ruler for every height.
      if (pm.length || looking) return;
      const four = [...taps, p].slice(-4);
      setTaps(four);
      if (four.length < 4) return;
      let best: [Pt, Pt, Pt, Pt] | null = null, cost = Infinity;
      for (const [a, b, c, d] of [[0, 1, 2, 3], [0, 2, 1, 3], [0, 3, 1, 2]]) {
        const e = Math.abs(four[a][0] - four[b][0]) + Math.abs(four[c][0] - four[d][0]);
        if (e < cost) { cost = e; best = [four[a], four[b], four[c], four[d]]; }
      }
      const pair = (u: Pt, v: Pt) => (u[1] >= v[1] ? { base: u, top: v } : { base: v, top: u });
      const s1 = pair(best![0], best![1]), s2 = pair(best![2], best![3]);
      const tall = (q: { base: Pt; top: Pt }) => q.base[1] - q.top[1];
      const [near, far] = tall(s1) >= tall(s2) ? [s1, s2] : [s2, s1];
      if (tall(far) < 4 || tall(near) < 1.15 * tall(far)) { setTaps([]); setTapsFailed(true); return; }
      const stumps: PMark[] = [{ near: true, kind: "stump_base", px: near.base }, { near: true, kind: "stump_top", px: near.top }, { near: false, kind: "stump_base", px: far.base }, { near: false, kind: "stump_top", px: far.top }];
      let all = stumps;
      // the creases, when they can be picked out around the stumps AND agree with the camera the stumps give
      const c0 = solveCamera(stumps.map((m) => toWorld(m, nearEnd)), src.w, src.h);
      if (isCamera(c0)) {
        const img = frameCanvas.current!.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, src.w, src.h);
        const r = findPitch(img.data, src.w, src.h, { near: near.base, far: far.base });
        if (pitchFound(r, true)) {
          const cr: PMark[] = r.marks.map((m) => ({ near: m.end === "bowler", kind: m.kind as PKind, px: m.px }));
          const tol = Math.max(5, src.w / 250);
          const agree = cr.every((m) => { const q = project(c0, worldOfMark(toWorld(m, nearEnd))); return !!q && Math.hypot(q[0] - m.px[0], q[1] - m.px[1]) < tol; });
          const c1 = agree ? solveCamera([...stumps, ...cr].map((m) => toWorld(m, nearEnd)), src.w, src.h) : null;
          if (isCamera(c1) && c1.rms < tol / 2) all = [...stumps, ...cr];
        }
      }
      setPm(all); setMarkFrame(frame); setTarget(TARGETS.length); setFoundBy("taps"); setTaps([]); setTapsFailed(false);
      return;
    }
    if (step === "marks" && pitchMode !== "hand") {
      if (pm.length || looking) return;
      const two = [...taps, p].slice(-2);
      setTaps(two);
      if (two.length < 2) return;
      // two taps on the stumps: find the creases around them
      const [far, near] = two[0][1] <= two[1][1] ? two : [two[1], two[0]];
      const img = frameCanvas.current!.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, src.w, src.h);
      const r = Math.hypot(near[0] - far[0], near[1] - far[1]) > 0.08 * src.h ? findPitch(img.data, src.w, src.h, { near, far }) : null;
      if (pitchFound(r, true)) adopt(r.marks, frame, "taps");
      else { setTaps([]); setTapsFailed(true); }
      return;
    }
    if (step === "marks") {
      if (frame !== markFrame && pm.length) return;
      const tg = TARGETS[Math.min(target, TARGETS.length - 1)];
      let px = p;
      if (tg.kind !== "stump_base" && tg.kind !== "stump_top") {
        const img = frameCanvas.current!.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, src.w, src.h);
        px = snapCorner(img.data, src.w, src.h, p, Math.max(8, src.w / 140)) ?? p;
      }
      if (!pm.length) setMarkFrame(frame);
      const rest = pm.filter((m) => !(m.near === tg.near && m.kind === tg.kind));
      setPm([...rest, { near: tg.near, kind: tg.kind, px }]);
      // on to the next one not yet marked
      const done = new Set([...rest, tg].map((m) => `${m.near}${m.kind}`));
      let nx = target;
      for (let i = 1; i <= TARGETS.length; i++) { const j = (target + i) % TARGETS.length; if (!done.has(`${TARGETS[j].near}${TARGETS[j].kind}`)) { nx = j; break; } }
      setTarget(nx === target ? TARGETS.length : nx);
      setSc(null); setSightings([]); setTracked(null);
      return;
    }
    if (!sc?.shifts.has(frame)) return;
    if (mode === "sun1") { setUpright({ frame, foot: p, tip: p }); setMode("sun2"); return; }
    if (mode === "sun2" && upright) { const up = { ...upright, tip: p }; setUpright(up); setMode("ball"); fitNow(sightings, up); return; }
    const cur = sightings.find((s) => s.frame === frame);
    let next: Sighting[];
    if (mode === "shadow") {
      if (!cur) { flash("Mark the ball in this frame first.", true); return; }
      next = sightings.map((s) => (s === cur ? { ...s, shadow: p } : s));
      setMode("ball");
    } else {
      // the nearest moving blob, when the tap is on one: its centre is better than a fingertip
      let best: Pt | null = null, bd = Math.max(7, src.w / 200);
      for (const c of sc.cands.get(frame) ?? []) { const d = Math.hypot(c.raw[0] - p[0], c.raw[1] - p[1]); if (d < bd) { bd = d; best = c.raw; } }
      const s: Sighting = { frame, px: best ?? p, shadow: cur?.shadow ?? null, auto: !!best };
      next = [...sightings.filter((x) => x.frame !== frame), s].sort((a, b) => a.frame - b.frame);
    }
    setSightings(next); setNotFound(false);
    fitNow(next, upright);
  };

  const findBall = async () => {
    if (!src || !camera || !hints) return;
    cancel.current = false;
    setProgress(0); setNotFound(false);
    try {
      // localStorage "seamly:debug" = "1" prints how the ball was looked for (for diagnosing a clip)
      let dbg: ((l: string) => void) | undefined;
      try { if (localStorage.getItem("seamly:debug") === "1") dbg = (l) => console.info("[track] " + l.slice(0, 600)); } catch { /* no storage */ }
      const tm = { seek: 0, read: 0, n: 0 }, t0 = performance.now();
      const getter = { w: src.w, h: src.h, get: (f: number) => enqueue(async () => { const a = performance.now(); const g = await grab(f); const b = performance.now(); const d = g.getImageData(0, 0, src.w, src.h).data; tm.seek += b - a; tm.read += performance.now() - b; tm.n++; return d; }) };
      const s = await scan(getter, camera, markFrame, hints, (d, n) => setProgress(d / n), () => cancel.current);
      dbg?.(`scan ${Math.round(performance.now() - t0)} ms for ${tm.n} frames: seeking ${Math.round(tm.seek)} ms, reading pixels ${Math.round(tm.read)} ms`);
      if (!s) { if (!cancel.current) flash("There are too few frames after the release to look for the ball.", true); return; }
      // which end is which: the bowler's front foot is at the bowler's end
      let c = camera, ms = marks;
      const foot = priorsOf(c, hints, s.shifts).foot;
      if (foot && foot[2] < -PITCH_LEN / 2) {
        const ne = other(nearEnd), ms2 = pm.map((m) => toWorld(m, ne)), c2 = solveCamera(ms2, src.w, src.h);
        if (isCamera(c2)) { c = c2; ms = ms2; setNearEnd(ne); }
      }
      dbg?.(`release frame ${hints.releaseFrame}, hand ${hints.hand?.map((v) => Math.round(v))}, ankles ${JSON.stringify(hints.ankles.map((p) => p.map((v) => Math.round(v))))}, release height ${hints.releaseHeight}, frames ${s.frames[0]}-${s.frames[s.frames.length - 1]}, still ${s.still}`);
      let a = autoTrack(c, s, hints, upright, dbg);
      if (!a && !(foot && foot[2] > -PITCH_LEN / 2)) {
        // the other way round (when the bowler's front foot has not already said which end is which): the ball goes from the bowler's end, so try taking the far end as the bowler's
        const ne = other(cameraEnd(c)), ms2 = pm.map((m) => toWorld(m, ne)), c2 = solveCamera(ms2, src.w, src.h);
        const a2 = isCamera(c2) ? autoTrack(c2, s, hints, upright) : null;
        if (a2 && isCamera(c2)) { a = a2; c = c2; ms = ms2; setNearEnd(ne); }
      }

      setSc(s); setStep("ball"); setMode("ball");
      if (a && a.hints.releaseFrame !== hints.releaseFrame) { setRelFrame(a.hints.releaseFrame); setRelLoose(true); }
      if (a) { setSightings(a.sightings); setTracked(withDoubt(a.tracked, c, ms, a.sightings, s.shifts, a.hints, upright)); setFrame(a.sightings[0].frame); setDirty(true); }
      else { setSightings([]); setTracked(null); setNotFound(true); setFrame(hints.releaseFrame); }
    } catch (e) { flash((e as Error).message || "Looking for the ball failed.", true); }
    finally { setProgress(null); V.current.shown = -1; }
  };

  // the pitch alone: hand the marks over. Which end is the bowler's is settled by where the front foot lands.
  const givePitch = () => {
    if (!src || !camera || !onPitch) return;
    let ms = marks;
    const o = measureOnPitch(result, camera, markFrame), foot = o?.front ?? o?.back;
    if (foot && foot.heel[2] < -PITCH_LEN / 2) {
      const ms2 = pm.map((m) => toWorld(m, other(nearEnd)));
      if (isCamera(solveCamera(ms2, src.w, src.h))) ms = ms2;
    }
    onPitch({ w: src.w, h: src.h, markFrame, marks: ms });
  };

  const save = async (thenFace = false) => {
    if (!camera || !sc || !tr || !hints) return;
    try {
      onMeta(await api.patch(id, { track: { ...recordOf(camera, markFrame, marks, upright, sightings, sc.shifts, tr, hints), measured: hints.measured ? [hints.measured.z, hints.measured.zSigma, hints.measured.height, hints.measured.heightSigma, ...(hints.measured.frame != null ? [hints.measured.frame] : [])] : null, release: relFrame, releaseSigma: relLoose ? 1.5 : null } }));
      setDirty(false);
      if (thenFace) onFace(); else flash("Ball tracking saved with this analysis.");
    } catch (e) { flash((e as Error).message, true); }
  };
  const remove = async () => {
    try { onMeta(await api.patch(id, { track: null })); } catch (e) { flash((e as Error).message, true); return; }
    setPm([]); setTarget(0); setSc(null); setSightings([]); setUpright(null); setTracked(null); setStep("marks"); setDirty(false);
    setPitchMode("taps"); setFoundBy(null); setTaps([]);
    setFrame(hints?.releaseFrame ?? frame);
  };

  const curSight = sightings.find((s) => s.frame === frame);
  const since = hints ? hints.time(frame) - hints.time(hints.releaseFrame) : 0;
  const worstMark = useMemo(() => {
    if (!camera) return null;
    let w = 0, wi = -1;
    marks.forEach((m, i) => { const p = project(camera, worldOfMark(m)); const e = p ? Math.hypot(p[0] - m.px[0], p[1] - m.px[1]) : 99; if (e > w) { w = e; wi = i; } });
    return wi >= 0 ? { err: w, label: TARGETS.find((t) => t.near === pm[wi]?.near && t.kind === pm[wi]?.kind)?.label ?? "" } : null;
  }, [camera, marks, pm]);
  const usable = camera && camera.rms < Math.max(4, (src?.w ?? 1920) / 300);
  // measuring heights needs something of known height: a stump's top
  // (or the creases at both ends: six or more corners on the ground fix the camera as well)
  const hasTop = pm.some((m) => m.kind === "stump_top") || (pm.filter((m) => m.kind !== "stump_top" && m.near).length >= 3 && pm.filter((m) => m.kind !== "stump_top" && !m.near).length >= 3);
  // the pitch was found with no help: go straight on to the ball
  useEffect(() => {
    if (goOn.current && camera && usable && progress === null && step === "marks") { goOn.current = false; if (!onPitch) void findBall(); }
  });

  return (
    <div className="bio-overlay trk-overlay" role="dialog" aria-modal="true" aria-labelledby="trk-title" ref={dialogRef}>
      <div className="bio-sheet trk-sheet">
        <div className="bio-head">
          <h2 id="trk-title">{onPitch ? "Find the pitch" : "Track the ball"} <span className="trk-steps" hidden={!!onPitch}><b className={step === "marks" ? "on" : ""}>1 Find the pitch</b><b className={step === "ball" && !tr ? "on" : ""}>2 Find the ball</b><b className={tr ? "on" : ""}>3 The delivery</b></span></h2>
          <button type="button" className="btn icon sm ghost" onClick={onClose} aria-label="Close (Esc)"><IX size={16} /></button>
        </div>
        {error ? <div className="notice warn" role="alert">{error}</div> : !hints && src ? <div className="notice warn" role="alert">This analysis has no release frame, so there is nowhere to start looking for the ball.</div> : (
          <div className="trk-body">
            <div className="trk-left">
              <div className="trk-stage">
                <canvas ref={stageRef} width={src?.w ?? 1280} height={src?.h ?? 720} className="trk-canvas" role="img"
                  aria-label={`Frame ${frame} of ${name}'s delivery${step === "ball" ? ", with the ball's sightings and fitted flight drawn over it" : ", for marking the pitch"}`}
                  onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture(e.pointerId); setAim(at(e)); }}
                  onPointerMove={(e) => { if (aim || e.pointerType === "mouse") setAim(at(e)); }}
                  onPointerUp={(e) => { const p = at(e); if (e.pointerType !== "mouse") setAim(null); place(p); }}
                  onPointerLeave={() => setAim(null)} />
                <canvas ref={loupeRef} width={170} height={170} className="trk-loupe" aria-hidden="true" />
                {!src && <div className="trk-wait">Opening the video…</div>}
                {looking && <div className="trk-wait"><div>Looking for the pitch…</div></div>}
                {progress !== null && <div className="trk-wait"><div>Looking for the ball… {Math.round(progress * 100)}%</div><progress value={progress} max={1} /><button type="button" className="btn sm" onClick={() => { cancel.current = true; }}>Stop</button></div>}
              </div>
              <div className="trk-scrub">
                <button type="button" className="btn icon sm" onClick={() => stepFrame(-1)} aria-label="Previous frame"><IPrev size={15} /></button>
                <input type="range" aria-label="Frame" disabled={progress !== null || looking || (step === "marks" && pm.length > 0)}
                  min={frames ? 0 : hints?.first ?? 0} max={frames ? frames.length - 1 : hints?.last ?? 0} value={frames ? Math.max(0, frames.indexOf(frame)) : frame}
                  onChange={(e) => setFrame(frames ? frames[Number(e.target.value)] : Number(e.target.value))} />
                <button type="button" className="btn icon sm" onClick={() => stepFrame(1)} aria-label="Next frame"><INext size={15} /></button>
                <span className="trk-when">frame {frame}{hints ? ` · ${since >= 0 ? `${Math.round(since * 1000)} ms after` : `${Math.round(-since * 1000)} ms before`} release` : ""}</span>
              </div>
              {hints && frame !== hints.releaseFrame && progress === null && (
                <div className="trk-rel">{relFrame !== null ? (relLoose ? "The release was taken from the ball's first sighting: about" : "You set the release at") : "The analysis found the release at"} frame {hints.releaseFrame}. If the ball really leaves the hand in the frame shown,
                  <button type="button" className="btn sm ghost" onClick={() => { setRelFrame(frame); setRelLoose(false); setSc(null); setSightings([]); setTracked(null); setNotFound(false); setStep("marks"); if (pm.length) setFrame(markFrame); }}>set the release here</button></div>
              )}
            </div>

            <div className="trk-side">
              {step === "marks" ? (
                <>
                  {!canView && <div className="notice warn">This clip was filmed from the side. {onPitch ? "Measuring on the pitch" : "Tracking the ball"} needs the camera behind the bowler's arm or behind the batter, with both ends of the pitch in view.</div>}
                  {looking ? <p className="trk-lead"><span className="pulse" /> Looking for the pitch: its creases are painted at distances the Laws fix, and that is all the camera needs.</p>
                    : pitchMode !== "hand" && !pm.length ? (
                      <>
                        {onPitch ? <p className="trk-lead"><b>Tap the foot and the top of the middle stump, at each end</b>: four taps, in any order. Press, slide to aim with the magnifier, let go. The stumps are 71.1 cm tall and 20.12 m apart, and that is all the camera needs.{" "}
                          {taps.length ? `${4 - taps.length} to go.` : "Pick a frame where both sets of stumps are in view first (the slider)."}</p>
                          : <p className="trk-lead"><b>Tap the middle stump at each end</b>, where it meets the ground. Seamly finds the creases around your two taps and works the camera out from them.{" "}
                          {taps.length === 1 ? "Now the other end." : "Pick a frame where both ends are in view first (the slider)."}</p>}
                        {tapsFailed && <div className="notice warn" role="status">{onPitch ? "Those four taps do not make two stumps, one near and one far. Tap the foot and the top of the middle stump at each end again." : "The creases could not be picked out around those taps: they may be faint, worn or hidden in this frame. Try another frame, or mark the corners yourself."}</div>}
                        <div className="trk-row">
                          <button type="button" className="btn sm" disabled={!taps.length} onClick={() => setTaps([])}>Clear</button>
                          <button type="button" className="btn sm ghost" onClick={() => { setPitchMode("hand"); setTaps([]); }}>Mark the corners by hand instead</button>
                        </div>
                      </>
                    ) : pitchMode !== "hand" ? (
                      <>
                        <p className="trk-lead"><ICheck size={14} /> <b>{onPitch ? `Camera worked out from the stumps${pm.length > 4 ? " and the creases" : ""}.` : `Pitch found ${foundBy === "auto" ? "on its own" : "around your two taps"}.`}</b> The blue lines are the pitch as the camera sees it: they should sit on the creases{onPitch ? " and stand on the stumps" : ""} at both ends.</p>
                        <div className="trk-row">
                          <button type="button" className="btn sm" onClick={() => { setPm([]); setTarget(0); setFoundBy(null); setTaps([]); setPitchMode("taps"); }}>Not right: tap the stumps again</button>
                          <button type="button" className="btn sm ghost" onClick={() => setPitchMode("hand")}>Adjust the corners by hand</button>
                        </div>
                      </>
                    ) : (
                      <>
                        <p className="trk-lead">Tap the crease corners and stumps you can see, <b>at least four, from both ends</b>. More marks make a better camera. Press, slide to aim with the magnifier, let go.{pm.length === 0 ? " Pick a frame where both ends are in view first (the slider)." : ""}</p>
                        <PitchDiagram pm={pm} target={target} onPick={setTarget} />
                        <p className="trk-now">{target < TARGETS.length ? <><span className="pulse" /> {TARGETS[target].label}</> : "All points marked."}
                          {target < TARGETS.length && <button type="button" className="btn sm ghost" onClick={() => setTarget((target + 1) % TARGETS.length)}>Skip</button>}</p>
                        <div className="trk-row">
                          <button type="button" className="btn sm" disabled={!pm.length} onClick={() => { const last = pm[pm.length - 1]; setPm(pm.slice(0, -1)); setTarget(TARGETS.findIndex((t) => t.near === last.near && t.kind === last.kind)); }}>Undo</button>
                          <button type="button" className="btn sm" disabled={!pm.length} onClick={() => { setPm([]); setTarget(0); }}>Clear</button>
                        </div>
                        {cam && !isCamera(cam) && <div className="notice warn" role="status">{cam.text}</div>}
                        {camera && (
                          <div className={`trk-cam ${usable ? "ok" : "bad"}`} role="status">
                            <b>{usable ? <><ICheck size={14} /> Camera found</> : "The marks don't agree yet"}</b>
                            <span>{pm.length} marks agree to {camera.rms.toFixed(1)} px. The camera is {camera.pos[1].toFixed(1)} m up, {Math.abs(cameraEnd(camera) === "bowler" ? camera.pos[2] : camera.pos[2] + PITCH_LEN).toFixed(0)} m behind the {cameraEnd(camera) === "bowler" ? "bowler's" : "batter's"} stumps, looking down {lookDown(camera).toFixed(0)}°.</span>
                            <span>The blue lines are the pitch as this camera sees it: they should sit on the creases and stumps.{!usable && worstMark ? ` Furthest out: ${worstMark.label.toLowerCase()} (${worstMark.err.toFixed(0)} px). Tap it in the diagram and mark it again.` : ""}</span>
                          </div>
                        )}
                        <div className="trk-row"><button type="button" className="btn sm ghost" onClick={() => { setPm([]); setTarget(0); setFoundBy(null); setTaps([]); setPitchMode("taps"); }}>Start again with two taps on the stumps</button></div>
                      </>
                    )}
                  {pitchMode !== "hand" && camera && (
                    <div className={`trk-cam ${usable ? "ok" : "bad"}`} role="status">
                      <b>{usable ? <><ICheck size={14} /> Camera found</> : "The camera does not fit yet"}</b>
                      <span>The camera is {camera.pos[1].toFixed(1)} m up, {Math.abs(cameraEnd(camera) === "bowler" ? camera.pos[2] : camera.pos[2] + PITCH_LEN).toFixed(0)} m behind the {cameraEnd(camera) === "bowler" ? "bowler's" : "batter's"} stumps, looking down {lookDown(camera).toFixed(0)}°.</span>
                    </div>
                  )}
                  {onPitch && pitchMode === "hand" && camera && !hasTop && <p className="trk-now"><span className="pulse" /> Mark the top of a middle stump as well, or three or more crease corners at each end: heights are measured against them.</p>}
                  {onPitch ? <button type="button" className="btn primary" disabled={!usable || !canView || looking || !hasTop} onClick={givePitch}><ICheck size={15} /> Measure on this pitch</button>
                    : <button type="button" className="btn primary" disabled={!usable || progress !== null || !canView || looking} onClick={findBall}><ITarget size={15} /> Find the ball</button>}
                </>
              ) : (
                <>
                  {notFound && <div className="notice warn" role="status">The ball could not be picked out on its own in this clip. Step through the frames after release and tap the ball in at least four of them, three before it pitches.</div>}
                  {tracked && !isTracked(tracked) && <div className="notice warn" role="status">{tracked.text}</div>}
                  {tr && relLoose && <div className="notice" role="status">The ball does not start where the bowling analysis put the release, so the release was taken from the ball itself, to within a frame or two. For a sharper speed, step to the frame where the ball leaves the hand and set the release there.</div>}
                  {tr && <Result tr={tr} />}
                  <div className="trk-edit">
                    <div className="seg" role="group" aria-label="What a tap on the picture marks">
                      <button type="button" className={mode === "ball" ? "on" : ""} aria-pressed={mode === "ball"} onClick={() => setMode("ball")}>Ball</button>
                      <button type="button" className={mode === "shadow" ? "on" : ""} aria-pressed={mode === "shadow"} onClick={() => setMode("shadow")}>Its shadow</button>
                      <button type="button" className={mode === "sun1" || mode === "sun2" ? "on" : ""} aria-pressed={mode === "sun1" || mode === "sun2"} onClick={() => setMode("sun1")}><ISun size={13} /> Sun</button>
                    </div>
                    <p className="faint">{mode === "ball" ? "Tap the ball in this frame to move or add its mark." : mode === "shadow" ? "Tap the ball's shadow on the ground in this frame."
                      : mode === "sun1" ? "Sharper speed in sunshine: tap the foot of something upright (a stump, an umpire standing straight)…" : "…now tap the end of its shadow."}</p>
                    <div className="trk-row">
                      <button type="button" className="btn sm" disabled={!curSight} onClick={() => { const next = sightings.filter((s) => s.frame !== frame); setSightings(next); fitNow(next, upright); }}><ITrash size={13} /> Remove this frame's mark</button>
                      {upright && <button type="button" className="btn sm" onClick={() => { setUpright(null); fitNow(sightings, null); }}>Forget the sun</button>}
                    </div>
                  </div>
                  <div className="trk-row end">
                    <button type="button" className="btn sm" onClick={() => { setStep("marks"); setFrame(markFrame); }}>Back to the pitch marks</button>
                    <button type="button" className="btn sm" disabled={progress !== null} onClick={findBall}><IRefresh size={13} /> Find it again</button>
                    {meta.track && <button type="button" className="btn sm" onClick={remove}><ITrash size={13} /> Remove</button>}
                    <button type="button" className="btn" disabled={!tr || !dirty} onClick={() => save()}><ICheck size={15} /> {dirty || !meta.track ? "Save" : "Saved"}</button>
                    <button type="button" className="btn primary" disabled={!tr} onClick={() => (dirty || !meta.track ? save(true) : onFace())}><IEye size={15} /> Face it</button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
        <p className="faint bio-note">
          Measured from the video, not simulated: the camera comes from the pitch's own markings (the Laws fix them to the millimetre), the ball from the frames, and the flight is the one path through the air and off the pitch that passes through every sighting.
          Each figure carries its own ± from how well that path fits and how surely the pitch was marked. One camera sees along its line of sight least well, so the speed leans on where the front foot lands and, in sunshine, on the ball's shadow;
          what the ball keeps off the pitch along the ground leans on what cricket balls usually keep. Not checked against a radar or Hawk-Eye on your ground: see the accuracy notes.
        </p>
      </div>
    </div>
  );
}


/** A plan of the pitch as the picture shows it (far end at the top), to choose which point to mark. */
function PitchDiagram({ pm, target, onPick }: { pm: PMark[]; target: number; onPick: (i: number) => void }) {
  const W = 220, H = 150, cx = W / 2;
  const row = (near: boolean) => { const y0 = near ? H - 26 : 26, to = near ? -1 : 1, hw = near ? 78 : 58; return { stump: y0, pop: y0 + to * 16, hw }; };
  const pos = (t: { near: boolean; kind: PKind }): [number, number] => {
    const r = row(t.near);
    switch (t.kind) {
      case "pop_l": return [cx - r.hw, r.pop]; case "pop_r": return [cx + r.hw, r.pop];
      case "bowl_l": return [cx - r.hw, r.stump]; case "bowl_r": return [cx + r.hw, r.stump];
      case "stump_base": return [cx, r.stump]; default: return [cx, r.stump + (t.near ? -1 : 1) * -13];
    }
  };
  const done = (t: { near: boolean; kind: PKind }) => pm.some((m) => m.near === t.near && m.kind === t.kind);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="trk-diagram" role="group" aria-label="The points that can be marked">
      <polygon points={`${cx - 62},14 ${cx + 62},14 ${cx + 84},${H - 12} ${cx - 84},${H - 12}`} className="turf" />
      {[true, false].map((near) => { const r = row(near), back = r.stump + (near ? 14 : -14); return (
        <g key={String(near)} className="lines">
          <line x1={cx - r.hw - 14} y1={r.pop} x2={cx + r.hw + 14} y2={r.pop} /><line x1={cx - r.hw} y1={r.stump} x2={cx + r.hw} y2={r.stump} />
          <line x1={cx - r.hw} y1={r.pop} x2={cx - r.hw} y2={back} /><line x1={cx + r.hw} y1={r.pop} x2={cx + r.hw} y2={back} />
          <line x1={cx} y1={r.stump} x2={cx} y2={r.stump - 13} className="stump" />
          <text x={cx + r.hw + 20} y={r.stump + 4}>{near ? "near" : "far"}</text>
        </g>); })}
      {TARGETS.map((t, i) => { const [x, y] = pos(t); return (
        <g key={i} role="button" tabIndex={0} aria-label={`${t.label}${done(t) ? " (marked)" : ""}`} onClick={() => onPick(i)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(i); } }}
          className={`pt ${done(t) ? "done" : ""} ${i === target ? "cur" : ""}`}><circle cx={x} cy={y} r={9} className="hit" /><circle cx={x} cy={y} r={i === target ? 5 : 3.6} /></g>); })}
    </svg>
  );
}

/** The measured delivery: the figures, where it pitched, and where it passed the stumps. */
function Result({ tr }: { tr: Tracked }) {
  const p = tr.pitch, st = tr.stumps;
  const off = st ? -st.x.value : 0;   // to a right-hander
  const stumpsText = !st ? "" : st.hitting === "hitting" ? `hitting the stumps, ${cm(st.height.value)} up`
    : st.hitting === "close" ? "too close to call on the stumps"
    : st.height.value > STUMP_H + BALL_R && Math.abs(st.x.value) <= STUMPS_W / 2 + BALL_R ? `over the stumps by ${cm(st.height.value - STUMP_H)}`
    : `missing ${off > 0 ? "off" : "leg"} stump by ${cm(Math.abs(st.x.value) - STUMPS_W / 2)}${st.height.value > STUMP_H + BALL_R ? ", and over them" : ""}`;
  // a speed that could be out by more than an eighth is a rough guide, and is shown as one
  const loose = tr.release.kmh.sigma > 0.125 * tr.release.kmh.value;
  const swingCm = Math.abs(tr.swing.value) * 100, swingSure = Math.abs(tr.swing.value) > 1.5 * tr.swing.sigma && swingCm >= 3;
  return (
    <div className="trk-result">
      <div className="trk-headline">
        <div className={loose ? "loose" : ""}><b>{loose ? "≈ " : ""}{tr.release.kmh.value.toFixed(loose ? 0 : 1)}</b><span>km/h out of the hand <em>± {tr.release.kmh.sigma.toFixed(loose ? 0 : 1)}</em></span></div>
        {p && <div><b>{p.length.value.toFixed(2)} m</b><span>{lengthName(p.length.value)} <em>± {cm(p.length.sigma)}</em></span></div>}
      </div>
      {loose && <div className="notice warn" role="status">The speed is only a rough guide on this clip: {!tr.pitch || tr.afterBounce < 2 ? "the ball was not seen pitching and coming on, so there is nothing on the ground to fix how far away it was" : "the moment of release is not known to the frame"}. Where it pitched and its line do not depend on that.</div>}
      <div className="trk-pics">
        <PitchMap tr={tr} />
        <StumpsView tr={tr} />
      </div>
      <dl className="trk-read">
        <div><dt>Release</dt><dd><b>{tr.release.p[1].toFixed(2)} m</b> high, {cm(tr.release.p[0])} {tr.release.p[0] < 0 ? "left" : "right"} of middle stump, leaving {Math.abs(tr.release.down).toFixed(1)}° {tr.release.down >= 0 ? "below" : "above"} level</dd></div>
        {p && <div><dt>Pitched</dt><dd><b>{p.length.value.toFixed(2)} m</b> from the batter's stumps, {cm(p.line.value)} {Math.abs(p.line.value) < 0.005 ? "on" : p.line.value < 0 ? "to the off side of" : "to the leg side of"} middle (right-hander) <em>± {cm(p.line.sigma)}</em>; {Math.round(p.kmhIn)} → {Math.round(p.kmhOut)} km/h off the pitch</dd></div>}
        <div><dt>In the air</dt><dd>{swingSure ? <><b>{Math.round(swingCm)} cm</b> of swing to the {tr.swing.value < 0 ? "left" : "right"} as the bowler sees it</> : <>no swing beyond what can be told apart ({plusMinus(tr.swing.value, tr.swing.sigma, 0, 100)} cm)</>}</dd></div>
        {tr.deviation && <div><dt>Off the pitch</dt><dd><b>{Math.abs(tr.deviation.value).toFixed(1)}°</b> {Math.abs(tr.deviation.value) < Math.max(0.3, 1.5 * tr.deviation.sigma) ? "(straight on, within what can be told)" : `to the ${tr.deviation.value < 0 ? "left" : "right"}`} <em>± {tr.deviation.sigma.toFixed(1)}°</em></dd></div>}
        {st && <div><dt>At the stumps</dt><dd><b>{heightWord(st.height.value)}</b>, {cm(st.height.value)} up <em>± {cm(st.height.sigma)}</em>; {lineWord(off)} to a right-hander; <b>{stumpsText}</b>{st.measured ? "" : " (the bounce was not seen: this is where a usual bounce would take it)"}</dd></div>}
        {tr.seconds !== null && tr.crease && <div><dt>The batter got</dt><dd><b>{Math.round(tr.seconds * 1000)} ms</b>; the ball arrived at {Math.round(tr.crease.kmh)} km/h</dd></div>}
        <div><dt>How it was measured</dt><dd>{tr.used} sightings of the ball ({tr.afterBounce} after it pitched) sit {tr.rmsPx.toFixed(1)} px from the fitted flight{tr.sun ? `; its shadow in ${tr.sun.used} frames (${tr.sun.rmsPx.toFixed(1)} px), sun ${Math.round(tr.sun.elevation)}° up` : "; no shadow used"}</dd></div>
      </dl>
    </div>
  );
}

/** The pitch from above (bowler at the bottom): the length bands, the ball's path along the ground, where it pitched. */
function PitchMap({ tr }: { tr: Tracked }) {
  const W = 150, H = 300, WX = 2.5, m = (H - 20) / (PITCH_LEN + 2 * POPPING), cx = W / 2;
  const X = (x: number) => cx + x * m * WX, Y = (z: number) => H - 10 - (POPPING - z) * m;   // z = 1.22 at the bottom
  const pre: string[] = [], post: string[] = [], tp = tr.pitch?.t ?? Infinity;
  for (let i = 0; i < tr.samples.length; i += 3) { const s = tr.samples[i]; (s.t <= tp ? pre : post).push(`${X(s.p[0]).toFixed(1)},${Y(s.p[2]).toFixed(1)}`); }
  if (tr.pitch) { const q = `${X(tr.pitch.p[0]).toFixed(1)},${Y(tr.pitch.p[2]).toFixed(1)}`; pre.push(q); post.unshift(q); }
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="trk-map" role="img" aria-label={tr.pitch ? `Pitch map: the ball pitched ${tr.pitch.length.value.toFixed(1)} metres from the batter's stumps` : "Pitch map"}>
      <rect x={X(-1.525)} y={Y(-PITCH_LEN - POPPING)} width={3.05 * m * WX} height={(PITCH_LEN + 2 * POPPING) * m} className="strip" />
      {LENGTHS.map((b, i) => <rect key={b.name} x={X(-1.525)} y={Y(STUMPS_Z + b.to)} width={3.05 * m * WX} height={(b.to - b.from) * m} fill={BAND_CSS[i]} opacity={0.22} />)}
      {[0, -PITCH_LEN].map((z) => <g key={z} className="crease"><line x1={X(-RETURN_X)} y1={Y(z)} x2={X(RETURN_X)} y2={Y(z)} /><line x1={X(-1.525)} y1={Y(z + (z ? 1 : -1) * POPPING)} x2={X(1.525)} y2={Y(z + (z ? 1 : -1) * POPPING)} />
        {[-STUMP_X, 0, STUMP_X].map((sx) => <circle key={sx} cx={X(sx)} cy={Y(z)} r={1.6} className="stump" />)}</g>)}
      <polyline points={pre.join(" ")} className="pre" /><polyline points={post.join(" ")} className="post" />
      {tr.pitch && <><ellipse cx={X(tr.pitch.p[0])} cy={Y(tr.pitch.p[2])} rx={Math.max(2.5, 2 * tr.pitch.line.sigma * m * WX)} ry={Math.max(2.5, 2 * tr.pitch.length.sigma * m)} className="doubt" /><circle cx={X(tr.pitch.p[0])} cy={Y(tr.pitch.p[2])} r={2.6} className="hit" /></>}
      <text x={4} y={H - 3} className="cap">bowler</text><text x={4} y={9} className="cap">batter · width ×{WX}</text>
    </svg>
  );
}

/** The batter's wicket from the front: where the ball passed, true to size, with its uncertainty. */
function StumpsView({ tr }: { tr: Tracked }) {
  const st = tr.stumps;
  const W = 150, H = 300, s = 150, cx = W / 2, gy = H - 22;   // 150 px to the metre
  const X = (x: number) => cx - x * s, Y = (y: number) => gy - y * s;   // seen from the bowler's end... mirrored so off (to a right-hander) is on the left as the batter sees it
  if (!st) return <svg viewBox={`0 0 ${W} ${H}`} className="trk-wicket" role="img" aria-label="The ball did not reach the stumps" />;
  const bx = Math.max(-0.46, Math.min(0.46, st.x.value)), by = Math.max(0.03, Math.min(1.78, st.height.value));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="trk-wicket" role="img" aria-label={`At the stumps: ${cm(st.height.value)} up, ${st.hitting}`}>
      <line x1={0} y1={gy} x2={W} y2={gy} className="ground" />
      {[-STUMP_X, 0, STUMP_X].map((sx) => <rect key={sx} x={X(sx) - 0.019 * s} y={Y(STUMP_H)} width={0.038 * s} height={STUMP_H * s} rx={2} className="stump" />)}
      <rect x={X(STUMP_X) - 0.019 * s} y={Y(STUMP_H) - 3} width={STUMPS_W * s + 0.038 * s} height={3} className="stump" />
      <ellipse cx={X(bx)} cy={Y(by)} rx={BALL_R * s + 2 * st.x.sigma * s} ry={BALL_R * s + 2 * st.height.sigma * s} className="doubt" />
      <circle cx={X(bx)} cy={Y(by)} r={BALL_R * s} className={`ball ${st.hitting}`} />
      <text x={4} y={H - 6} className="cap">from the bowler's end · {st.hitting === "close" ? "too close to call" : st.hitting}</text>
    </svg>
  );
}

export type { TrackRecord };
