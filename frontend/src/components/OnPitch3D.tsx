import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { AnalysisMeta, AnalysisResult } from "../types";
import { api } from "../api";
import { FrameSource } from "../engine/video";
import { solveCameraPoints, isCamera, worldOf, cameraEnd, PITCH_LEN, POPPING, RETURN_X, STUMP_TOP, STUMP_X, type Camera } from "../lib/camcal";
import { measureWithDoubt, recordOnPitch, PROTECTED_X, PROTECTED_Z, type Est, type Foot, type FrameShifts, type OnPitch, type OnPitchRecord } from "../lib/onpitch";
import { grayOf, motion, chain, invertShift, STILL, type Gray, type Shift } from "../lib/ballfind";
import type { V3 } from "../lib/biomech";
import { buildPitch } from "../lib/pitchScene";
import { fromRecord } from "../lib/tracker";
import { trackedAt, type Tracked } from "../lib/balltrack";
import { lengthName } from "../lib/flight";
import { ICheck, IPause, IPlay, IRefresh, IX } from "./Icons";

/**
 * On the pitch: the delivery rebuilt in real metres on the ground it was bowled on.
 *
 * It opens as the camera saw it: the 3D pitch drawn over the video frame from the camera's own worked-out position,
 * so the fit can be judged by eye (the lines sit on the creases, the skeleton on the bowler). Then the picture lets go
 * of the video and the same scene can be walked round on a pitch drawn to the Laws: the feet are where they landed,
 * and the hand is where the ball left it.
 */

type View = "camera" | "orbit" | "top" | "side" | "ball";
const EDGES: [number, number][] = [[5, 7], [7, 9], [6, 8], [8, 10], [5, 6], [11, 12], [5, 11], [6, 12], [11, 13], [13, 15], [12, 14], [14, 16]];
const cmTxt = (m: number) => `${Math.round(Math.abs(m) * 100)} cm`;
const pm = (e: Est, unit: "m" | "cm" = "cm") => (unit === "m" ? `${e.value.toFixed(2)} m ± ${Math.max(1, Math.round(e.sigma * 100))} cm` : `${Math.round(Math.abs(e.value) * 100)} cm ± ${Math.max(1, Math.round(e.sigma * 100))}`);

/** Text that always faces the viewer and keeps its size on the screen. */
function label(text: string, color = "#ffffff"): THREE.Sprite {
  const c = document.createElement("canvas"), g = c.getContext("2d")!;
  const font = "600 44px 'Barlow Condensed', 'Arial Narrow', Inter, sans-serif";
  g.font = font;
  const w = Math.ceil(g.measureText(text).width) + 36;
  c.width = w; c.height = 64;
  g.font = font;
  g.fillStyle = "rgba(6, 10, 18, 0.78)";
  g.beginPath(); g.roundRect(0, 0, w, 64, 14); g.fill();
  g.fillStyle = color; g.textBaseline = "middle"; g.fillText(text, 18, 34);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: false, depthWrite: false, transparent: true, toneMapped: false }));
  s.userData.aspect = w / 64;
  s.renderOrder = 20;
  return s;
}

export default function OnPitch3D({ id, result, meta, name, others, onClose, onMeta, onRemark }: {
  id: string; result: AnalysisResult; meta: AnalysisMeta; name: string;
  /** the same bowler's other deliveries that were measured on the pitch */
  others: { id: string; name: string; rec: OnPitchRecord }[];
  onClose: () => void; onMeta: (m: AnalysisMeta) => void; onRemark: () => void; flash?: (text: string, bad?: boolean) => void;
}) {
  const rec = meta.onpitch!;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const backRef = useRef<HTMLImageElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  // (keyed by the marks themselves: the record is saved again with its figures, and that must not rebuild the scene)
  const marksKey = JSON.stringify([rec.w, rec.h, rec.markFrame, rec.marks]);
  const cam: Camera | null = useMemo(() => { const c = solveCameraPoints(rec.marks.map((m) => ({ world: worldOf(m), px: m.px })), rec.w, rec.h); return isCamera(c) ? c : null; }, [marksKey]);   // eslint-disable-line react-hooks/exhaustive-deps
  const othersKey = JSON.stringify(others.map((x) => [x.id, x.rec.release, x.rec.front]));
  // the ball itself, when it was tracked on this clip (lib/tracker.ts): its measured flight goes into the same scene
  const trackKey = JSON.stringify(meta.track ?? null);
  const tracked: Tracked | null = useMemo(() => (meta.track ? fromRecord(meta.track, result)?.tracked ?? null : null), [trackKey, result]);   // eslint-disable-line react-hooks/exhaustive-deps
  // how the camera moved through the delivery, measured on the frames themselves (undefined: still being worked out)
  const [shifts, setShifts] = useState<FrameShifts | null | undefined>(undefined);
  const o: OnPitch | null = useMemo(() => (cam && shifts !== undefined ? measureWithDoubt(result, rec.marks, rec.w, rec.h, rec.markFrame, shifts, rec.tapPx ?? 1.2)?.o ?? null : null), [cam, result, shifts]);   // eslint-disable-line react-hooks/exhaustive-deps
  const f0 = result.frames.start, T = result.keypoints2d.xy.length;
  const br = (result.events.br?.frame ?? f0) - f0;
  const [view, setView] = useState<View>("camera");
  const [frame, setFrame] = useState(br);
  const [playing, setPlaying] = useState(false);
  const [session, setSession] = useState(true);
  const [ghostsOn, setGhostsOn] = useState(true);
  const [failed, setFailed] = useState(false);
  const aspect = rec.w / rec.h;
  const W = aspect >= 1 ? 1280 : Math.round(960 * aspect), H = aspect >= 1 ? Math.round(1280 / aspect) : 960;
  const live = useRef({ view, frame, playing, session, ghosts: true, moved: 0, drag: null as null | { x: number; y: number }, az: 0.9, el: 0.42, dist: 7.5, intro: true });
  live.current.view = view; live.current.playing = playing; live.current.session = session; live.current.ghosts = ghostsOn;
  if (!playing) live.current.frame = frame;

  // keep the figures with the analysis (for lists, and for setting this ball beside the bowler's others)
  useEffect(() => {
    if (!o || !cam) return;
    const next = recordOnPitch(o, cam, rec.markFrame, rec.marks, rec);
    if (JSON.stringify(next) === JSON.stringify(rec)) return;
    api.patch(id, { onpitch: next }).then(onMeta, () => undefined);
  }, [o, cam]);   // eslint-disable-line react-hooks/exhaustive-deps
  // let go of the graphics context when the view closes
  const glCanvas = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => () => { glCanvas.current?.getContext("webgl2")?.getExtension("WEBGL_lose_context")?.loseContext(); }, []);

  // How the camera moved, from the video itself: each frame is lined up with the marked one by its background (a
  // tripod gives no movement; a broadcast camera's zoom and pan are followed).
  useEffect(() => {
    if (!cam) return;
    let alive = true, opened: FrameSource | null = null;
    setShifts(undefined);
    (async () => {
      const blob = await (await fetch(api.videoUrl(id))).blob();
      const fs = await FrameSource.open(blob, 1e9);
      opened = fs;
      const w = rec.w, h = rec.h;
      const c = document.createElement("canvas"); c.width = w; c.height = h;
      const g = c.getContext("2d", { willReadFrequently: true })!;
      const last = Math.min(fs.info.frameCount - 1, f0 + T - 1), mf = Math.max(f0, Math.min(last, rec.markFrame));
      const step = Math.max(1, Math.ceil(T / 45));
      const list = new Set<number>([mf, last]);
      for (let f = f0; f <= last; f += step) list.add(f);
      const frames = [...list].sort((a, b) => a - b), r = frames.indexOf(mf);
      const grays: Gray[] = [];
      for (const f of frames) {
        if (!alive) return;
        await fs.seek(f);
        g.drawImage(fs.video, 0, 0, w, h);
        grays.push(grayOf(g.getImageData(0, 0, w, h).data, w, h));
      }
      if (!alive) return;
      const fwd: Shift[] = [];
      for (let j = 1; j < frames.length; j++) fwd.push(motion(grays[j - 1], grays[j]));
      const toRef: Shift[] = new Array(frames.length);
      toRef[r] = STILL;
      for (let j = r + 1; j < frames.length; j++) toRef[j] = chain(invertShift(fwd[j - 1]), toRef[j - 1]);
      for (let j = r - 1; j >= 0; j--) toRef[j] = chain(fwd[j], toRef[j + 1]);
      const moved = !fwd.every((m) => Math.abs(m.s - 1) < 0.0015 && Math.hypot(m.dx, m.dy) < 1.0);
      const sh: FrameShifts = new Map();
      frames.forEach((f, i) => sh.set(f, moved ? toRef[i] : STILL));
      setShifts(sh);
    })().catch(() => { if (alive) setShifts(null); });
    return () => { alive = false; opened?.close(); };
  }, [id, cam]);   // eslint-disable-line react-hooks/exhaustive-deps

  // the dialog: Esc closes, the page behind stays put, arrows step frames, Space plays
  useEffect(() => {
    const before = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "SELECT") return;
      if (e.key === "ArrowLeft") { e.preventDefault(); setPlaying(false); setFrame((f) => Math.max(0, f - 1)); }
      if (e.key === "ArrowRight") { e.preventDefault(); setPlaying(false); setFrame((f) => Math.min(T - 1, f + 1)); }
      if (e.key === " " && tag !== "BUTTON") { e.preventDefault(); setPlaying((p) => !p); }
      if (e.key === "Tab" && dialogRef.current) {
        const items = [...dialogRef.current.querySelectorAll<HTMLElement>("canvas[tabindex], button:not([disabled]), input:not([disabled]), a[href]")];
        if (!items.length) return;
        e.preventDefault();
        const at = items.indexOf(document.activeElement as HTMLElement);
        items[at < 0 ? 0 : (at + (e.shiftKey ? -1 : 1) + items.length) % items.length].focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = before; };
  }, [onClose, T]);

  // the frame behind the 3D picture, as the camera saw it
  const shown = Math.max(0, Math.min(T - 1, Math.round(frame)));
  const backFrame = f0 + shown;
  const shiftsRef = useRef<FrameShifts | null>(null);
  shiftsRef.current = o && !o.still ? shifts ?? null : null;

  useEffect(() => {
    if (!cam || !o) return;
    const canvas = canvasRef.current!;
    glCanvas.current = canvas;
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true }); }
    catch { setFailed(true); return; }
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setSize(W, H, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(0x000000, 0);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, W / H, 0.05, 400);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x334433, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4); sun.position.set(4, 10, 6); scene.add(sun);
    const disposables: { dispose: () => void }[] = [];
    const keep = <X extends { dispose: () => void }>(x: X): X => { disposables.push(x); return x; };
    const basic = (color: number, opacity = 1, depthTest = true) => keep(new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity, side: THREE.DoubleSide, depthWrite: opacity >= 1, depthTest, toneMapped: false }));

    // ---- the world the video is replaced by: a dark dome, a far ground, and the clip's own ground laid flat ----
    const world = new THREE.Group();
    scene.add(world);
    const domeMat = keep(new THREE.ShaderMaterial({ side: THREE.BackSide, transparent: true, depthWrite: false, uniforms: { op: { value: 0 } },
      vertexShader: "varying vec3 p; void main(){ p = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
      fragmentShader: "varying vec3 p; uniform float op; void main(){ float h = clamp(normalize(p).y, 0.0, 1.0); vec3 c = mix(vec3(0.055, 0.085, 0.14), vec3(0.012, 0.02, 0.04), pow(h, 0.55)); gl_FragColor = vec4(c, op); }" }));
    const dome = new THREE.Mesh(keep(new THREE.SphereGeometry(300, 32, 16)), domeMat);
    dome.renderOrder = -10;
    world.add(dome);
    // the pitch to walk round: to scale, by the Laws (the video's own picture belongs to the camera's view only)
    buildPitch(world as unknown as THREE.Scene, null);
    const fade: { m: THREE.Material; o: number }[] = [];
    world.traverse((x) => { const m = (x as THREE.Mesh).material as THREE.Material | undefined; if (m && m !== domeMat) { fade.push({ m, o: m.opacity }); m.transparent = true; disposables.push(m); const gm = (x as THREE.Mesh).geometry; if (gm) disposables.push(gm); } });
    // ---- the pitch by the Laws, as thin bright lines (the same lines that were fitted to the video) ----
    const lines: number[] = [];
    const seg = (a: V3, b: V3) => lines.push(...a, ...b);
    for (const [z0, to] of [[0, -1], [-PITCH_LEN, 1]] as const) {
      seg([-RETURN_X, 0.01, z0], [RETURN_X, 0.01, z0]); seg([-1.83, 0.01, z0 + to * POPPING], [1.83, 0.01, z0 + to * POPPING]);
      for (const sx of [-1, 1]) seg([sx * RETURN_X, 0.01, z0 + to * POPPING], [sx * RETURN_X, 0.01, z0 - to * POPPING]);
      for (const sx of [-STUMP_X, 0, STUMP_X]) seg([sx, 0, z0], [sx, STUMP_TOP, z0]);
      seg([-STUMP_X, STUMP_TOP, z0], [STUMP_X, STUMP_TOP, z0]);
    }
    for (const sx of [-1.525, 1.525]) seg([sx, 0.01, POPPING], [sx, 0.01, -PITCH_LEN - POPPING]);
    const lineGeo = keep(new THREE.BufferGeometry()); lineGeo.setAttribute("position", new THREE.Float32BufferAttribute(lines, 3));
    const wire = new THREE.LineSegments(lineGeo, keep(new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.95, toneMapped: false })));
    wire.renderOrder = 5;
    scene.add(wire);
    // the protected area (Law 41.13): from 1.52 m in front of the popping crease, 30.48 cm either side of middle
    const dangerMat = basic(o.danger ? 0xef4444 : 0xfbbf24, o.danger ? 0.3 : 0.1);
    const dz0 = PROTECTED_Z, dz1 = -PITCH_LEN - PROTECTED_Z;
    const danger = new THREE.Mesh(keep(new THREE.PlaneGeometry(2 * PROTECTED_X, Math.abs(dz1 - dz0))), dangerMat);
    danger.rotation.x = -Math.PI / 2; danger.position.set(0, 0.012, (dz0 + dz1) / 2); danger.renderOrder = 1;
    scene.add(danger);

    // ---- the feet, where they landed, each with its doubt as an ellipse on the ground ----
    const labels: THREE.Sprite[] = [];
    const addLabel = (text: string, at: V3, color?: string) => { const s = label(text, color); s.position.set(at[0], at[1], at[2]); s.userData.anchor = new THREE.Vector3(at[0], at[1], at[2]); scene.add(s); labels.push(s); return s; };
    const shoe = (f: Foot, color: number, strong = true) => {
      const g = new THREE.Group();
      const dir = f.toe && Math.hypot(f.toe[0] - f.heel[0], f.toe[2] - f.heel[2]) > 0.12 ? Math.atan2(f.toe[0] - f.heel[0], f.toe[2] - f.heel[2]) : Math.PI;
      const sh = new THREE.Shape(); sh.absellipse(0, 0, 0.05, 0.14, 0, Math.PI * 2);
      const m = new THREE.Mesh(keep(new THREE.ShapeGeometry(sh, 24)), basic(color, strong ? 0.95 : 0.5, false));
      m.rotation.x = -Math.PI / 2; m.rotation.z = -dir; m.position.set(Math.sin(dir) * 0.14, 0.016, Math.cos(dir) * 0.14); m.renderOrder = 6;
      const d = new THREE.Mesh(keep(new THREE.RingGeometry(0.985, 1, 48)), basic(color, 0.9, false));
      d.rotation.x = -Math.PI / 2; d.scale.set(Math.max(0.02, 2 * f.sx), Math.max(0.02, 2 * f.sz), 1); d.position.y = 0.014; d.renderOrder = 6;
      const dot = new THREE.Mesh(keep(new THREE.CircleGeometry(0.022, 20)), basic(0xffffff, 1, false));
      dot.rotation.x = -Math.PI / 2; dot.position.y = 0.018; dot.renderOrder = 7;
      g.add(m, d, dot); g.position.set(f.heel[0], 0, f.heel[2]);
      scene.add(g);
      return g;
    };
    if (o.back) shoe(o.back, 0x60a5fa);
    if (o.front) shoe(o.front, 0xfbbf24);
    for (const s of o.steps) shoe(s, s === o.danger ? 0xef4444 : 0xcbd5e1, s === o.danger);
    const ruler = (a: V3, b: V3, color: number) => {
      const g = keep(new THREE.BufferGeometry()); g.setAttribute("position", new THREE.Float32BufferAttribute([...a, ...b], 3));
      const l = new THREE.Line(g, keep(new THREE.LineDashedMaterial({ color, dashSize: 0.06, gapSize: 0.04, depthTest: false, transparent: true, toneMapped: false })));
      l.computeLineDistances(); l.renderOrder = 8;
      scene.add(l);
    };
    if (o.back && o.front && o.stride) {
      ruler([o.back.heel[0], 0.02, o.back.heel[2]], [o.front.heel[0], 0.02, o.front.heel[2]], 0xffffff);
      addLabel(`stride ${o.stride.value.toFixed(2)} m`, [(o.back.heel[0] + o.front.heel[0]) / 2 + 0.45, 0.05, (o.back.heel[2] + o.front.heel[2]) / 2]);
    }
    if (o.front && o.popping) {
      ruler([o.front.heel[0], 0.02, o.front.heel[2]], [o.front.heel[0], 0.02, -POPPING], o.popping.verdict === "no_ball" ? 0xef4444 : 0x4ade80);
      addLabel(o.popping.margin.value >= 0 ? `heel ${cmTxt(o.popping.margin.value)} behind the line` : `heel ${cmTxt(o.popping.margin.value)} over the line`, [o.front.heel[0] - 0.55, 0.05, -POPPING - 0.25], o.popping.verdict === "no_ball" ? "#fca5a5" : "#86efac");
    }
    // ---- the release: the ball where it left the hand, its height and its distance from the line of the stumps ----
    if (o.release) {
      // (its height from the start of the ball's tracked flight, when the ball was tracked from this release: the same figure the page shows)
      const bh = tracked && meta.track?.measured && Math.abs(tracked.release.p[1] - o.release.p[1]) < 0.25 ? tracked.release.p[1] : null;
      const p: [number, number, number] = bh != null ? [o.release.p[0], bh, o.release.p[2]] : o.release.p;
      const ball = new THREE.Mesh(keep(new THREE.SphereGeometry(0.036, 20, 14)), basic(0xef4444));
      ball.position.set(p[0], p[1], p[2]); ball.renderOrder = 9;
      const doubt = new THREE.Mesh(keep(new THREE.SphereGeometry(1, 24, 16)), basic(0xef4444, 0.16));
      doubt.position.copy(ball.position); doubt.scale.set(Math.max(0.03, o.release.across.sigma), Math.max(0.03, o.release.height.sigma), 0.3); doubt.renderOrder = 8;
      scene.add(ball, doubt);
      ruler([p[0], 0.02, p[2]], p, 0xfca5a5);
      ruler([0, 0.02, p[2]], [p[0], 0.02, p[2]], 0xfca5a5);
      addLabel(`${p[1].toFixed(2)} m high`, [p[0] + (p[0] >= 0 ? 0.5 : -0.5), p[1] + 0.12, p[2]], "#fecaca");
      addLabel(`${cmTxt(p[0])} ${p[0] < 0 ? "left" : "right"} of middle stump`, [p[0] / 2, 0.05, p[2] + 0.5], "#fecaca");
      // every other ball of this bowler's that was measured: where each left the hand
      const grp = new THREE.Group(); grp.name = "session";
      for (const x of others) if (x.rec.release) {
        const s = new THREE.Mesh(keep(new THREE.SphereGeometry(0.03, 14, 10)), basic(0xf8fafc, 0.75));
        s.position.set(x.rec.release[0], x.rec.release[1], x.rec.release[2]);
        grp.add(s);
        if (x.rec.front) { const d = new THREE.Mesh(keep(new THREE.CircleGeometry(0.04, 16)), basic(0xfde68a, 0.7, false)); d.rotation.x = -Math.PI / 2; d.position.set(x.rec.front[0], 0.017, x.rec.front[1]); grp.add(d); }
      }
      scene.add(grp);
    }
    // ---- the ball: the flight measured on this clip, from the hand to the batter's stumps ----
    const ballMesh = new THREE.Mesh(keep(new THREE.SphereGeometry(0.036, 20, 14)), basic(0xff3b3b));
    ballMesh.visible = false; ballMesh.renderOrder = 10;
    scene.add(ballMesh);
    let ballClock: ((frame: number) => number) | null = null;   // seconds since the ball left the hand, for a frame of the analysis
    if (tracked) {
      const sm = tracked.samples, tp = tracked.pitch?.t ?? Infinity;
      const pre: THREE.Vector3[] = [], post: THREE.Vector3[] = [];
      for (let i = 0; i < sm.length; i += 3) (sm[i].t <= tp ? pre : post).push(new THREE.Vector3(sm[i].p[0], sm[i].p[1], sm[i].p[2]));
      if (tracked.pitch) { const q = new THREE.Vector3(tracked.pitch.p[0], 0.036, tracked.pitch.p[2]); pre.push(q); post.unshift(q.clone()); }
      for (const [pts, color] of [[pre, 0x7dd3fc], [post, 0xfbbf24]] as const) {
        if (pts.length < 2) continue;
        const path = new THREE.CurvePath<THREE.Vector3>();
        for (let i = 1; i < pts.length; i++) path.add(new THREE.LineCurve3(pts[i - 1], pts[i]));
        const tube = new THREE.Mesh(keep(new THREE.TubeGeometry(path, pts.length * 2, 0.014, 6, false)), basic(color, 0.9));
        tube.renderOrder = 7;
        scene.add(tube);
      }
      if (tracked.pitch) {
        const ring = new THREE.Mesh(keep(new THREE.RingGeometry(0.07, 0.12, 36)), basic(0xffffff, 0.95, false));
        ring.rotation.x = -Math.PI / 2; ring.position.set(tracked.pitch.p[0], 0.015, tracked.pitch.p[2]); ring.renderOrder = 6;
        scene.add(ring);
        addLabel(`pitched ${tracked.pitch.length.value.toFixed(1)} m from the batter's stumps`, [tracked.pitch.p[0] + 0.9, 0.05, tracked.pitch.p[2]], "#fde68a");
      }
      addLabel(`${Math.round(tracked.release.kmh.value)} km/h`, [tracked.release.p[0] - (tracked.release.p[0] >= 0 ? -0.55 : 0.55), tracked.release.p[1] - 0.25, tracked.release.p[2] - 0.6], "#bae6fd");
      const slow = Math.max(1, result.options.slowmo_factor || 1), fpsV = result.video.fps || result.fps, t0 = tracked.release.t;
      ballClock = (fr) => { const i = Math.max(0, Math.min(T - 1, Math.floor(fr))), u = fr - i, a = result.frames.times[i] ?? i / fpsV, b = result.frames.times[Math.min(T - 1, i + 1)] ?? a + 1 / fpsV; return (a + (b - a) * u) / slow - t0; };
    }
    // where the camera stood
    {
      const g = new THREE.Group();
      const body = new THREE.Mesh(keep(new THREE.BoxGeometry(0.16, 0.09, 0.03)), basic(0xe2e8f0));
      g.add(body);
      g.position.set(cam.pos[0], cam.pos[1], cam.pos[2]);
      g.lookAt(0, 0.8, cameraEnd(cam) === "bowler" ? -6 : -PITCH_LEN + 6);
      g.name = "phone";
      scene.add(g);
      ruler([cam.pos[0], 0, cam.pos[2]], cam.pos as V3, 0x94a3b8);
      const l = addLabel(`your camera · ${cam.pos[1].toFixed(1)} m up`, [cam.pos[0], cam.pos[1] + 0.25, cam.pos[2]], "#cbd5e1");
      l.name = "phoneLabel";
    }

    // ---- the bowler: every joint where its line of sight meets its distance down the pitch ----
    // a little smoothing through time (the joints are measured frame by frame)
    const J: (V3[] | null)[] = o.body.map((fr, t) => {
      if (!fr) return null;
      return fr.map((p, j) => {
        let sx = 0, sy = 0, sz = 0, sw = 0;
        for (let d = -2; d <= 2; d++) { const q = o.body[t + d]?.[j]; if (!q) continue; const w = d === 0 ? 0.4 : Math.abs(d) === 1 ? 0.22 : 0.08; sx += w * q[0]; sy += w * q[1]; sz += w * q[2]; sw += w; }
        return sw ? [sx / sw, sy / sw, sz / sw] as V3 : p;
      });
    });
    const right = o.side === "right";
    const boneMat = keep(new THREE.MeshStandardMaterial({ color: 0xe8eef7, roughness: 0.45, emissive: 0x5b8def, emissiveIntensity: 0.25 }));
    const armMat = keep(new THREE.MeshStandardMaterial({ color: 0xfde68a, roughness: 0.4, emissive: 0xf59e0b, emissiveIntensity: 0.6 }));
    const unitCyl = keep(new THREE.CylinderGeometry(1, 1, 1, 12)), unitSph = keep(new THREE.SphereGeometry(1, 16, 12));
    const isArm = (a: number, b: number) => (right ? (a === 6 && b === 8) || (a === 8 && b === 10) : (a === 5 && b === 7) || (a === 7 && b === 9));
    const bones = EDGES.map(([a, b]) => { const m = new THREE.Mesh(unitCyl, isArm(a, b) ? armMat : boneMat); scene.add(m); return m; });
    const dots = Array.from({ length: 17 }, (_, j) => { const m = new THREE.Mesh(unitSph, (right ? [8, 10] : [7, 9]).includes(j) ? armMat : boneMat); m.scale.setScalar(j === 0 ? 0.105 : j < 5 ? 0 : 0.034); scene.add(m); return m; });
    const spine = new THREE.Mesh(unitCyl, boneMat), neck = new THREE.Mesh(unitCyl, boneMat);
    scene.add(spine, neck);
    const va = new THREE.Vector3(), vb = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    const stick = (m: THREE.Mesh, a: V3, b: V3, r: number) => {
      va.set(a[0], a[1], a[2]); vb.set(b[0], b[1], b[2]);
      const len = va.distanceTo(vb);
      m.position.copy(va).add(vb).multiplyScalar(0.5);
      m.scale.set(r, Math.max(1e-4, len), r);
      m.quaternion.setFromUnitVectors(up, vb.sub(va).normalize());
    };
    // the three moments of the delivery stride, standing where they happened: back foot down, front foot down, release
    const ghosts = new THREE.Group(); ghosts.name = "ghosts";
    {
      const moments: [number | null | undefined, number][] = [[result.events.bfc?.frame, 0x60a5fa], [result.events.ffc?.frame, 0xfbbf24], [result.events.br?.frame, 0xf8fafc]];
      for (const [f, color] of moments) {
        const P = f == null ? null : J[Math.max(0, Math.min(T - 1, f - f0))];
        if (!P) continue;
        const mat = keep(new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.2, depthWrite: false, toneMapped: false }));
        for (const [a, b] of EDGES) { const m = new THREE.Mesh(unitCyl, mat); stick(m, P[a], P[b], a >= 11 ? 0.04 : 0.03); ghosts.add(m); }
        const sh: V3 = [(P[5][0] + P[6][0]) / 2, (P[5][1] + P[6][1]) / 2, (P[5][2] + P[6][2]) / 2], hip: V3 = [(P[11][0] + P[12][0]) / 2, (P[11][1] + P[12][1]) / 2, (P[11][2] + P[12][2]) / 2];
        const sp = new THREE.Mesh(unitCyl, mat); stick(sp, hip, sh, 0.05); ghosts.add(sp);
        const hd = new THREE.Mesh(unitSph, mat); hd.position.set(P[0][0], P[0][1], P[0][2]); hd.scale.setScalar(0.105); ghosts.add(hd);
      }
      scene.add(ghosts);
    }
    const lerpJ = (x: number): V3[] | null => {
      const i = Math.max(0, Math.min(T - 1, Math.floor(x))), k = Math.min(T - 1, i + 1), u = x - i, A = J[i], B = J[k];
      if (!A) return B ?? null;
      if (!B) return A;
      return A.map((p, j) => [p[0] + (B[j][0] - p[0]) * u, p[1] + (B[j][1] - p[1]) * u, p[2] + (B[j][2] - p[2]) * u] as V3);
    };
    // the hand's path through the delivery stride, up to the release
    {
      const wr = right ? 10 : 9, el = right ? 8 : 7, pts: THREE.Vector3[] = [];
      const from = Math.max(0, (result.events.bfc?.frame ?? f0 + br - 12) - f0);
      for (let t = from; t <= Math.min(T - 1, br); t++) { const q = J[t]; if (q) pts.push(new THREE.Vector3(q[wr][0] + 0.35 * (q[wr][0] - q[el][0]), q[wr][1] + 0.35 * (q[wr][1] - q[el][1]), q[wr][2] + 0.35 * (q[wr][2] - q[el][2]))); }
      if (pts.length >= 3) {
        const tube = new THREE.Mesh(keep(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), pts.length * 6, 0.012, 8, false)), basic(0xfbbf24, 0.85));
        tube.renderOrder = 7;
        scene.add(tube);
      }
    }

    // ---- cameras: the real one (exactly as worked out), and ones to walk round with ----
    const fovReal = (2 * Math.atan(cam.h / (2 * cam.f)) * 180) / Math.PI;
    const realPos = new THREE.Vector3(cam.pos[0], cam.pos[1], cam.pos[2]);
    const realQ = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(
      new THREE.Vector3(cam.R[0], cam.R[1], cam.R[2]), new THREE.Vector3(-cam.R[3], -cam.R[4], -cam.R[5]), new THREE.Vector3(-cam.R[6], -cam.R[7], -cam.R[8])));
    const focus = new THREE.Vector3(o.front?.heel[0] ?? o.release?.p[0] ?? 0, 1.0, o.front?.heel[2] ?? o.release?.p[2] ?? -1);
    const L = live.current;
    L.az = (right ? 1 : -1) * 0.95; L.el = 0.36; L.dist = 7.5; L.intro = true; L.moved = 0;
    const curPos = realPos.clone(), curQ = realQ.clone();
    let curFov = fovReal, mix = 0;   // mix: 0 the video, 1 the rebuilt world
    const wantPos = new THREE.Vector3(), wantQ = new THREE.Quaternion(), m4 = new THREE.Matrix4();
    const phone = scene.getObjectByName("phone")!, phoneLabel = scene.getObjectByName("phoneLabel")!, sessionGrp = scene.getObjectByName("session");
    let raf = 0, last = performance.now(), t0 = last, shownFrame = -1;
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      // the opening: a second and a half as the camera saw it, then out into the open
      if (L.intro && now - t0 > 1800) { L.intro = false; if (L.view === "camera") setView("orbit"); }
      if (L.playing) {
        L.frame += dt * Math.max(1, result.fps_real || result.fps) * 0.25;
        if (L.frame >= T - 1) L.frame = 0;
        const f = Math.round(L.frame);
        if (f !== shownFrame) { shownFrame = f; setFrame(f); }
      }
      const P = lerpJ(L.frame);
      const vis = !!P;
      for (const b of bones) b.visible = vis;
      for (const d of dots) d.visible = vis;
      spine.visible = neck.visible = vis;
      if (P) {
        EDGES.forEach(([a, b], i) => stick(bones[i], P[a], P[b], isArm(a, b) ? 0.03 : a >= 11 ? 0.04 : 0.028));
        P.forEach((p, j) => dots[j].position.set(p[0], p[1], p[2]));
        const sh: V3 = [(P[5][0] + P[6][0]) / 2, (P[5][1] + P[6][1]) / 2, (P[5][2] + P[6][2]) / 2], hip: V3 = [(P[11][0] + P[12][0]) / 2, (P[11][1] + P[12][1]) / 2, (P[11][2] + P[12][2]) / 2];
        stick(spine, hip, sh, 0.05); stick(neck, sh, P[0], 0.03);
      }
      // the ball, once it has left the hand
      if (tracked && ballClock) {
        const tb = ballClock(L.frame), last = tracked.samples[tracked.samples.length - 1].t;
        ballMesh.visible = tb >= 0 && tb <= last + 0.02;
        if (ballMesh.visible) { const q = trackedAt(tracked, tb); ballMesh.position.set(q[0], q[1], q[2]); }
      }
      const v = L.view;
      if (v === "camera") { wantPos.copy(realPos); wantQ.copy(realQ); }
      else {
        if (v === "orbit") { if (!L.drag && now - L.moved > 2500) L.az += dt * 0.12; wantPos.set(focus.x + L.dist * Math.cos(L.el) * Math.sin(L.az), focus.y + L.dist * Math.sin(L.el), focus.z + L.dist * Math.cos(L.el) * Math.cos(L.az)); }
        else if (v === "top") wantPos.set(focus.x, 9.5, focus.z + 0.01);
        else if (v === "ball") wantPos.set(right ? 2.6 : -2.6, 7.5, 16);
        else wantPos.set(focus.x + (right ? 1 : -1) * 8, 1.3, focus.z);
        m4.lookAt(wantPos, v === "top" ? new THREE.Vector3(focus.x, 0, focus.z) : v === "ball" ? new THREE.Vector3(0, 0.3, -11) : focus, v === "top" ? new THREE.Vector3(0, 0, -1) : up);
        wantQ.setFromRotationMatrix(m4);
      }
      const k = 1 - Math.exp(-dt / 0.28);
      curPos.lerp(wantPos, k); curQ.slerp(wantQ, k);
      curFov += ((v === "camera" ? fovReal : v === "top" ? 40 : v === "ball" ? 30 : 36) - curFov) * k;
      mix += ((v === "camera" ? 0 : 1) - mix) * (1 - Math.exp(-dt / 0.35));
      camera.position.copy(curPos); camera.quaternion.copy(curQ); camera.fov = curFov; camera.updateProjectionMatrix();
      domeMat.uniforms.op.value = mix;
      for (const x of fade) x.m.opacity = x.o * mix;
      world.visible = mix > 0.003;
      if (backRef.current) {
        backRef.current.style.opacity = String(1 - mix);
        // a camera that moved: this frame's picture is slid and zoomed to where the marked frame's camera would have seen it
        const sh = shiftsRef.current;
        let tf = "";
        if (sh && sh.size) {
          const f = f0 + Math.round(L.frame), ks = [...sh.keys()];
          let near = ks[0];
          for (const q of ks) if (Math.abs(q - f) < Math.abs(near - f)) near = q;
          const m = sh.get(near)!;
          tf = `translate(${(m.dx / cam.w) * 100}%, ${(m.dy / cam.h) * 100}%) scale(${m.s})`;
        }
        if (backRef.current.style.transform !== tf) backRef.current.style.transform = tf;
      }
      phone.visible = phoneLabel.visible = mix > 0.5;
      if (sessionGrp) sessionGrp.visible = L.session;
      ghosts.visible = L.ghosts && mix > 0.5;
      // labels keep their size on the screen, and step up out of each other's way
      camera.updateMatrixWorld();
      const camUp = new THREE.Vector3(0, 1, 0).applyQuaternion(curQ), placed: { x: number; y: number; w: number }[] = [];
      for (const s of labels) {
        if (!s.visible) continue;
        const a = s.userData.anchor as THREE.Vector3, d = camera.position.distanceTo(a), unit = d * Math.tan((curFov * Math.PI) / 360), sc = unit * 0.062;
        s.scale.set(sc * (s.userData.aspect as number), sc, 1);
        const ndc = a.clone().project(camera), hw = (0.062 * (s.userData.aspect as number)) / (2 * (W / H)) * 2, hh = 0.062 * 1.15;
        let y = ndc.y;
        for (let pass = 0; pass < 6; pass++) { const hit = placed.find((q) => Math.abs(q.x - ndc.x) < (q.w + hw) / 2 && Math.abs(q.y - y) < hh); if (!hit) break; y = hit.y + hh; }
        placed.push({ x: ndc.x, y, w: hw });
        s.position.copy(a).addScaledVector(camUp, (y - ndc.y) * unit);
      }
      renderer.render(scene, camera);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      for (const s of labels) { s.material.map?.dispose(); s.material.dispose(); }
      for (const d of disposables) d.dispose();
      renderer.dispose();
    };
  }, [cam, o, W, H, othersKey, tracked, result, T, br, f0]);   // eslint-disable-line react-hooks/exhaustive-deps

  // drag to walk round, wheel or pinch to come closer
  const onDown = (e: React.PointerEvent) => { if (view !== "orbit") { setView("orbit"); } live.current.intro = false; live.current.drag = { x: e.clientX, y: e.clientY }; (e.target as HTMLElement).setPointerCapture(e.pointerId); };
  const onMove = (e: React.PointerEvent) => {
    const L = live.current;
    if (!L.drag) return;
    L.az -= (e.clientX - L.drag.x) * 0.006; L.el = Math.max(0.04, Math.min(1.45, L.el + (e.clientY - L.drag.y) * 0.005));
    L.drag = { x: e.clientX, y: e.clientY }; L.moved = performance.now();
  };
  const onUp = () => { live.current.drag = null; live.current.moved = performance.now(); };
  const onWheel = (e: React.WheelEvent) => { live.current.dist = Math.max(2.5, Math.min(30, live.current.dist * (e.deltaY > 0 ? 1.08 : 0.93))); live.current.moved = performance.now(); };

  // how repeatable the release is across this bowler's measured balls (this one included)
  const spread = useMemo(() => {
    const pts = [...others.map((x) => x.rec.release), o?.release ? o.release.p : null].filter((p): p is [number, number, number] => !!p);
    if (pts.length < 3) return null;
    const sd = (i: number) => { const m = pts.reduce((s, p) => s + p[i], 0) / pts.length; return Math.sqrt(pts.reduce((s, p) => s + (p[i] - m) ** 2, 0) / (pts.length - 1)); };
    return { n: pts.length, across: sd(0), height: sd(1) };
  }, [others, o]);

  const st = o?.stature ?? null;
  // the release height from the ball's own flight, when the ball was tracked starting from this measured release
  const ballH = tracked && meta.track?.measured && o?.release && Math.abs(tracked.release.p[1] - o.release.height.value) < 0.25 ? tracked.release.p[1] : null;
  return (
    <div className="bio-overlay" role="dialog" aria-modal="true" aria-labelledby="onp-title" ref={dialogRef}>
      <div className={`bio-sheet onp-sheet ${aspect < 1 ? "portrait" : ""}`}>
        <div className="bio-head">
          <h2 id="onp-title">On the pitch <span className="onp-sub">measured in metres, the stumps as the ruler</span></h2>
          <button ref={closeRef} type="button" className="btn icon sm ghost" onClick={onClose} aria-label="Close (Esc)"><IX size={16} /></button>
        </div>
        {cam && shifts === undefined && !failed ? (
          <div className="onp-wait" role="status"><span className="pulse" /> Reading the clip: lining every frame up with the pitch…</div>
        ) : failed || !cam || !o ? (
          <div className="notice warn" role="alert">{failed ? "This browser couldn't start 3D graphics, so this view can't be shown here." : !cam ? "The pitch marks no longer fit a camera. Mark the pitch again." : "This analysis has no release to measure from."}
            {!failed && <button type="button" className="btn sm" onClick={onRemark}>Mark the pitch again</button>}</div>
        ) : (
          <>
            <div className="onp-stage" style={{ aspectRatio: `${W} / ${H}` }}>
              <img ref={backRef} className="onp-back" src={api.frameUrl(id, backFrame)} alt="" aria-hidden="true" />
              <canvas ref={canvasRef} width={W} height={H} className="onp-canvas" role="img" tabIndex={0}
                onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onWheel={onWheel}
                aria-label={`${name}'s delivery rebuilt on the pitch in 3D: the feet where they landed, the ball where it left the hand, and the pitch's own lines`} />
              <div className="onp-tag" aria-hidden="true">{view === "camera" ? "AS YOUR CAMERA SAW IT · the blue lines are the pitch by the Laws" : view === "orbit" ? "DRAG TO WALK ROUND" : view === "top" ? "FROM ABOVE" : view === "ball" ? "THE BALL'S MEASURED FLIGHT" : "FROM THE SIDE"}</div>
            </div>
            <div className="bio-tools">
              <button type="button" className="btn sm" onClick={() => setPlaying((p) => !p)} aria-pressed={playing}>{playing ? <><IPause size={14} /> Pause</> : <><IPlay size={14} /> Play ¼ speed</>}</button>
              <input type="range" className="onp-scrub" aria-label="Frame" min={0} max={T - 1} value={shown} onChange={(e) => { setPlaying(false); setFrame(Number(e.target.value)); }} />
              <div className="seg" role="group" aria-label="View">
                {([["camera", "Your camera"], ["orbit", "Walk round"], ["top", "Above"], ["side", "Side"], ...(tracked ? [["ball", "Ball"] as const] : [])] as const).map(([v, text]) => (
                  <button key={v} type="button" className={view === v ? "on" : ""} aria-pressed={view === v} onClick={() => { live.current.intro = false; setView(v); }}>{text}</button>
                ))}
              </div>
              <label className="onp-check"><input type="checkbox" checked={ghostsOn} onChange={(e) => setGhostsOn(e.target.checked)} /> Key moments</label>
              {others.length > 0 && <label className="onp-check"><input type="checkbox" checked={session} onChange={(e) => setSession(e.target.checked)} /> Other balls ({others.length})</label>}
              <button type="button" className="btn sm ghost" onClick={onRemark} title="Only if the blue lines do not sit on the pitch in the camera's view"><IRefresh size={13} /> Correct the pitch</button>
            </div>
            <dl className="face-read onp-read">
              {o.release && <div><dt>Release point</dt><dd><b>{(ballH ?? o.release.height.value).toFixed(2)} m</b> high <em>± {cmTxt(o.release.height.sigma)}</em>, <b>{cmTxt(o.release.across.value)}</b> {o.release.across.value < 0 ? "left" : "right"} of middle stump as the camera looks <em>± {cmTxt(o.release.across.sigma)}</em>
                {st ? <>; {Math.round(((ballH ?? o.release.height.value) / st.value) * 100)}% of the bowler's height</> : null}
                {ballH != null ? <>. <em>Read off the start of the ball's tracked flight (the arm alone gave {o.release.height.value.toFixed(2)} m)</em></> : null}
                {o.release.arc && o.release.p[1] - o.release.caught > 0.03 ? <>. <em>This is the top of the hand's arc, where the ball leaves (the shoulder plus the arm's {o.release.arm ? `${Math.round(o.release.arm * 100)} cm` : "length"} along the arm's line); the release frame itself caught the hand {cmTxt(o.release.p[1] - o.release.caught)} short of it, as {Math.round(result.fps_real || result.fps)} frames a second will.</em></>
                  : !o.release.arc && o.release.timing > 0.035 ? <>. <em>The arm could not be followed over the top in this clip, so this is the hand as the release frame caught it; not knowing the moment within one frame is ± {cmTxt(o.release.timing)} of that on its own.</em></> : null}</dd></div>}
              {o.stride && <div><dt>Delivery stride</dt><dd><b>{o.stride.value.toFixed(2)} m</b> heel to heel <em>± {cmTxt(o.stride.sigma)}</em>{st ? <>, {Math.round((o.stride.value / st.value) * 100)}% of height</> : null}
                {o.across && o.alignDeg ? <>; the front foot lands <b>{cmTxt(o.across.value)}</b> to the {o.across.value < 0 ? "left" : "right"} of the back foot's line ({Math.abs(o.alignDeg.value).toFixed(0)}° ± {Math.max(1, Math.round(o.alignDeg.sigma))}°)</> : null}</dd></div>}
              {!o.frontSeen && <div><dt>Front foot</dt><dd>hidden behind the back leg where it landed, so the stride and the front-foot line are not measured on this clip. The release point is placed a usual stride ahead of the back foot, and its ± is wider for it.</dd></div>}
              {o.popping && <div><dt>Front foot</dt><dd>heel <b>{o.popping.margin.value >= 0 ? `${cmTxt(o.popping.margin.value)} behind` : `${cmTxt(o.popping.margin.value)} over`}</b> the back edge of the popping crease <em>± {cmTxt(o.popping.margin.sigma)}</em>:{" "}
                <b className={o.popping.verdict === "no_ball" ? "bad" : o.popping.verdict === "legal" ? "good" : ""}>{o.popping.verdict === "legal" ? "a fair delivery" : o.popping.verdict === "no_ball" ? "a no-ball" : "too close to call"}</b></dd></div>}
              {o.returnGap && o.back && <div><dt>Back foot</dt><dd>{o.returnGap.value > 1.5 * o.returnGap.sigma ? <>inside the return crease by <b>{cmTxt(o.returnGap.value)}</b></> : o.returnGap.value < -1.5 * o.returnGap.sigma ? <><b className="bad">on or outside the return crease</b> (a no-ball)</> : <>within {cmTxt(o.returnGap.sigma)} of the return crease: too close to call</>}</dd></div>}
              {tracked && <div><dt>The ball</dt><dd><b>{tracked.release.kmh.value.toFixed(0)} km/h</b> out of the hand <em>± {Math.max(1, Math.round(tracked.release.kmh.sigma))}</em>{tracked.pitch ? <>, pitched <b>{tracked.pitch.length.value.toFixed(1)} m</b> from the batter's stumps ({lengthName(tracked.pitch.length.value).toLowerCase()}) <em>± {cmTxt(tracked.pitch.length.sigma)}</em></> : null}
                {tracked.stumps ? <>; at the stumps {cmTxt(tracked.stumps.height.value)} up, {tracked.stumps.hitting === "hitting" ? "hitting" : tracked.stumps.hitting === "close" ? "too close to call" : "missing"}</> : null}. Measured from {tracked.used} sightings of the ball in this clip.</dd></div>}
              {st && <div><dt>Bowler's height</dt><dd><b>{st.value.toFixed(2)} m</b> <em>± {cmTxt(st.sigma)}</em>, measured against the stumps{result.skeleton.height_source === "user" ? ` (you entered ${result.skeleton.stature_m.toFixed(2)} m)` : ""}</dd></div>}
              {o.runup && <div><dt>Run-up</dt><dd><b>{o.runup.value.toFixed(0)} km/h</b> into the delivery stride <em>± {Math.max(1, Math.round(o.runup.sigma))}</em></dd></div>}
              <div><dt>Follow-through</dt><dd>{o.danger ? <><b className="bad">a foot lands on the protected area</b> ({cmTxt(o.danger.heel[0])} from the middle, {(-o.danger.heel[2] - POPPING).toFixed(1)} m past the popping crease): umpires warn for this</> : o.steps.length ? "no foot seen landing on the protected area (the red strip down the middle)" : "the clip ends before the next steps land"}</dd></div>
              {spread && <div><dt>Repeatability</dt><dd>over {spread.n} measured balls the release moves <b>{pm({ value: spread.height, sigma: 0 }).split(" ±")[0]}</b> up and down and <b>{cmTxt(spread.across)}</b> side to side (one standard deviation)</dd></div>}
              <div><dt>The camera</dt><dd><ICheck size={13} /> {cam.pos[1].toFixed(1)} m up, {Math.abs(cameraEnd(cam) === "bowler" ? cam.pos[2] : cam.pos[2] + PITCH_LEN).toFixed(1)} m behind the stumps; {rec.auto ? `found by Seamly from ${rec.auto === "creases" ? "the painted creases" : rec.auto === "near creases" ? "the creases at the bowler's end" : rec.auto === "stumps" ? "the two wickets" : "the wickets and the creases"}` : `the ${rec.marks.length} pitch marks agree to ${cam.rms.toFixed(1)} px`}{o.still ? "" : "; the camera moved, and its movement is followed"}</dd></div>
            </dl>
            <p className="faint bio-note">
              Measured, not assumed: the creases and stumps are a ruler the Laws fix to the millimetre, and from them the camera's place, direction and zoom follow. A heel on the ground then has one place on the pitch, and the hand above the planted front foot has one height.
              Each ± is worked out for this camera from how exactly a joint can be placed in the picture and how well the hand's distance down the pitch is known. The skeleton shows each joint on its measured line of sight; how far forward or back each joint sits along that line is an estimate.
              Checked against rendered deliveries with exact answers (see the accuracy notes); not yet against a motion-capture lab.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
