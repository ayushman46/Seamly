import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { api } from "../api";
import type { AnalysisResult } from "../types";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { J, armSpeed, buildMotion, gaussian, kineticChain, replayScript, replayState, sampleJoints, sampleTrack, sides, speedColor, LANDING_X, LANDING_Z, type Callout, type V3 } from "../lib/biomech";
import { BoneBody, SimpleBody, loadBones, type Body, type BoneData, type Limb } from "../lib/bones";
import { clipExt, clipMime } from "../lib/clip";
import { IDownload, IPause, IPlay, IRefresh, IUpload, IX } from "./Icons";

/**
 * Bio-mech replay: the delivery as a broadcast-style sequence (lib/biomech.ts has the timeline). One canvas holds the
 * whole picture (the video or the 3D scene, then the titles and callouts drawn on top), so what is saved as a video is
 * exactly what is on screen.
 */

const FONT = `"Barlow Condensed", "Roboto Condensed", "Arial Narrow", Inter, -apple-system, sans-serif`;
const FONT_SEMI = `"Barlow Semi Condensed", "Barlow Condensed", "Roboto Condensed", Inter, -apple-system, sans-serif`;
const SUB = 8;   // ribbon samples per video frame
const COCO_LIMBS: [number, number, "b" | "f" | "t"][] = [[5, 7, "t"], [7, 9, "t"], [6, 8, "t"], [8, 10, "t"], [5, 6, "t"], [5, 11, "t"], [6, 12, "t"],
  [11, 12, "t"], [11, 13, "t"], [13, 15, "t"], [12, 14, "t"], [14, 16, "t"]];

function stripeTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 256; c.height = 256;
  const g = c.getContext("2d")!;
  for (let i = 0; i < 8; i++) { g.fillStyle = i % 2 ? "#1f6a2c" : "#1a5c26"; g.fillRect(0, i * 32, 256, 32); }
  // a little grain so the grass isn't flat
  for (let i = 0; i < 2600; i++) { g.fillStyle = `rgba(${Math.random() < 0.5 ? "255,255,255" : "0,0,0"},${0.02 + Math.random() * 0.03})`; g.fillRect(Math.random() * 256, Math.random() * 256, 2, 2); }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(10, 10);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function skyTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 8; c.height = 256;
  const g = c.getContext("2d")!;
  const gr = g.createLinearGradient(0, 0, 0, 256);
  gr.addColorStop(0, "#05070f"); gr.addColorStop(0.55, "#0a1020"); gr.addColorStop(1, "#122036");
  g.fillStyle = gr; g.fillRect(0, 0, 8, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function buildPitch(scene: THREE.Scene, landX: number) {
  const flat = (w: number, d: number, color: number, x: number, z: number, y: number, opacity = 1) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshStandardMaterial({ color, roughness: 1, transparent: opacity < 1, opacity }));
    m.rotation.x = -Math.PI / 2; m.position.set(x, y, z); m.receiveShadow = true;
    scene.add(m);
    return m;
  };
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(240, 240), new THREE.MeshStandardMaterial({ map: stripeTexture(), roughness: 1 }));
  ground.rotation.x = -Math.PI / 2; ground.position.set(0, 0, -10); ground.receiveShadow = true;
  scene.add(ground);
  flat(3.05, 24.6, 0xb7a47c, 0, -10.06, 0.004);                      // the strip
  for (const z of [-0.5, -19.6]) flat(2.3, 3.4, 0x9c8a63, 0, z, 0.006, 0.75);   // worn ends
  const line = (w: number, d: number, x: number, z: number) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshBasicMaterial({ color: 0xf4f4f0 }));
    m.rotation.x = -Math.PI / 2; m.position.set(x, 0.008, z);
    scene.add(m);
  };
  for (const [bowl, pop, dir] of [[0, -1.22, 1], [-20.12, -18.9, -1]] as const) {
    line(2.64, 0.05, 0, bowl);                                         // bowling crease
    line(3.9, 0.05, 0, pop);                                           // popping crease
    for (const x of [-1.32, 1.32]) line(0.05, 2.44, x, pop + dir * 1.22);   // return creases
    const wood = new THREE.MeshStandardMaterial({ color: 0xe9dfc6, roughness: 0.6 }), cap = new THREE.MeshStandardMaterial({ color: 0xd9a520, roughness: 0.45 });
    for (const x of [-0.05, 0, 0.05]) {
      const s = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.024, 0.711, 14), wood);
      s.position.set(x, 0.355, bowl); s.castShadow = true;
      scene.add(s);
    }
    const top = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.022, 0.05), cap);
    top.position.set(0, 0.722, bowl); top.castShadow = true;
    scene.add(top);
  }
  // the line the bowler runs along, and where the front foot lands
  const run = new THREE.Mesh(new THREE.PlaneGeometry(0.02, 9), new THREE.MeshBasicMaterial({ color: 0xf59e0b, transparent: true, opacity: 0.32 }));
  run.rotation.x = -Math.PI / 2; run.position.set(landX, 0.009, 2.4);
  scene.add(run);
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.3, 0.325, 48), new THREE.MeshBasicMaterial({ color: 0x5b8def, transparent: true, opacity: 0.9, side: THREE.DoubleSide }));
  ring.rotation.x = -Math.PI / 2; ring.position.set(landX, 0.01, LANDING_Z - 0.06);
  scene.add(ring);
}

export default function BioReplay({ id, result, name, others = [], onClose }: {
  id: string; result: AnalysisResult; name: string; onClose: () => void;
  others?: { id: string; name: string }[];   // other analyses that can stand in the scene as a ghost, to compare
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const script = useMemo(() => replayScript(result), [result]);
  const motion = useMemo(() => buildMotion(result), [result]);
  const frames = motion.joints;
  // the arm's speed, eased over time so the ribbon's colour flows
  const speeds = useMemo(() => gaussian(armSpeed(result), 0.02 * Math.max(1, result.fps_real || result.fps)), [result]);
  const time = useRef(0);
  const playingRef = useRef(true);
  const user = useRef({ az: 0, el: 0 });
  // a fixed camera chosen by the viewer, instead of the directed sequence's
  const [view, setView] = useState<"director" | "side" | "behind" | "batter" | "top">("director");
  const viewRef = useRef(view);
  viewRef.current = view;
  // another delivery in the same scene: a second skeleton, in step from its own release, landing on the same spot
  const [ghostId, setGhostId] = useState("");
  const [ghost, setGhost] = useState<{ result: AnalysisResult; name: string } | null>(null);
  useEffect(() => {
    let live = true;
    if (!ghostId) { setGhost(null); return; }
    api.get(ghostId).then((g) => { if (live && g.result) setGhost({ result: g.result, name: others.find((o) => o.id === ghostId)?.name ?? "other delivery" }); }).catch(() => live && setGhost(null));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ghostId]);
  const [playing, setPlaying] = useState(true);
  const [shown, setShown] = useState(0);          // the time on the scrub bar (updated a few times a second)
  const [caption, setCaption] = useState("");     // what a screen reader hears: the phase and its numbers
  const [failed, setFailed] = useState(false);
  // the real bone surfaces; null if they couldn't be loaded (the simple skeleton stands in)
  const [bones, setBones] = useState<BoneData | null | undefined>(undefined);
  useEffect(() => { let live = true; loadBones(`${import.meta.env.BASE_URL}skeleton/bones.bin`).then((b) => live && setBones(b), () => live && setBones(null)); return () => { live = false; }; }, []);
  const [rec, setRec] = useState<"idle" | "recording" | "done">("idle");
  const [clip, setClip] = useState<{ url: string; file: File } | null>(null);
  const recRef = useRef<{ rec: MediaRecorder; chunks: Blob[] } | null>(null);
  const portrait = useMemo(() => typeof window !== "undefined" && window.innerWidth < window.innerHeight * 0.8, []);
  // full HD on a screen that can show it; the picture's own sizes all scale with it
  const big = useMemo(() => typeof window !== "undefined" && window.innerWidth * (window.devicePixelRatio || 1) >= 1500, []);
  const [W, H] = portrait ? (big ? [1080, 1440] : [720, 960]) : big ? [1920, 1080] : [1280, 720];
  const mime = useMemo(() => clipMime(false), []);
  playingRef.current = playing;

  // the dialog: Esc closes, Tab stays inside, the page behind doesn't scroll
  useEffect(() => {
    const before = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
      if (e.key === " " && (e.target as HTMLElement).tagName !== "BUTTON" && (e.target as HTMLElement).tagName !== "INPUT") { e.preventDefault(); setPlaying((p) => !p); return; }
      if (e.key !== "Tab" || !dialogRef.current) return;
      const items = [...dialogRef.current.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), a[href]")];
      if (!items.length) return;
      e.preventDefault();
      const at = items.indexOf(document.activeElement as HTMLElement);
      items[at < 0 ? 0 : (at + (e.shiftKey ? -1 : 1) + items.length) % items.length].focus();
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = before; };
  }, [onClose]);

  useEffect(() => () => { if (clip) URL.revokeObjectURL(clip.url); }, [clip]);

  useEffect(() => {
    if (bones === undefined) return;   // the bones are still loading
    const out = canvasRef.current!;
    const ctx = out.getContext("2d")!;
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true }); }
    catch { setFailed(true); return; }
    renderer.setPixelRatio(1);
    renderer.setSize(W, H, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.NeutralToneMapping;   // keeps the grass, the pitch and the ribbon's colours true
    renderer.toneMappingExposure = 1.0;
    const scene = new THREE.Scene();
    const sky = skyTexture();
    scene.background = sky;
    scene.fog = new THREE.Fog(0x0b1424, 26, 95);
    // soft light from all round (a small studio environment), so the bones have gentle highlights instead of flat shading
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = envTex;
    scene.environmentIntensity = 0.3;
    const camera = new THREE.PerspectiveCamera(portrait ? 44 : 36, W / H, 0.1, 300);
    scene.add(new THREE.HemisphereLight(0xf2f5ff, 0x2a4a30, 1.2));
    const sun = new THREE.DirectionalLight(0xfff6e6, 2.4);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.radius = 5;
    Object.assign(sun.shadow.camera, { left: -3, right: 3, top: 3, bottom: -3, near: 1, far: 30 });
    sun.shadow.bias = -0.0015;
    scene.add(sun, sun.target);
    const right = result.bowling_arm.arm === "right";
    const S = sides(right);
    buildPitch(scene, LANDING_X * (right ? -1 : 1));
    const body: Body = bones ? new BoneBody(bones) : new SimpleBody();
    scene.add(body.group);
    // the action strobe: the body at its earlier key moments, left standing where it was
    const ghosts = bones ? script.ghosts.map((g) => {
      const b = new BoneBody(bones, 0x9cc8ff);
      b.update(frames[g.frame], motion.hinges[g.frame]);
      b.fade(0);
      scene.add(b.group);
      return { body: b, label: g.label, head: frames[g.frame][J.head] };
    }) : [];
    const chain = kineticChain(result);
    // the delivery being compared: its own motion, on its own clock from release
    const rival = ghost && bones ? (() => {
      const m2 = buildMotion(ghost.result), b = new BoneBody(bones, 0xffb54a);
      const f2 = Math.max(1, ghost.result.fps_real || ghost.result.fps);
      const br2 = Math.max(0, Math.min(m2.joints.length - 1, (ghost.result.events.br?.frame ?? ghost.result.frames.start) - ghost.result.frames.start));
      scene.add(b.group);
      return { body: b, m: m2, fps: f2, br: br2, tracks: [0, 1, 2, 3].map((l) => m2.hinges.map((h) => h[l])), P: m2.joints[0].map(() => [0, 0, 0] as V3) };
    })() : null;

    // soft dark patches on the ground under each foot and the body, darker the nearer the ground (they tie the feet down)
    const blobTex = (() => {
      const c = document.createElement("canvas"); c.width = c.height = 128;
      const g = c.getContext("2d")!, gr = g.createRadialGradient(64, 64, 4, 64, 64, 62);
      gr.addColorStop(0, "rgba(0,0,0,0.75)"); gr.addColorStop(0.5, "rgba(0,0,0,0.32)"); gr.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
      return new THREE.CanvasTexture(c);
    })();
    const blobs = [0.2, 0.2, 0.62].map((r) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(2 * r, 2 * r), new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false, opacity: 0.6 }));
      m.rotation.x = -Math.PI / 2; m.renderOrder = 2;
      scene.add(m);
      return m;
    });

    // the ball in the hand, and the ribbon the bowling arm sweeps (built once, revealed as the action plays)
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.043, 18, 14), new THREE.MeshStandardMaterial({ color: 0xc81e2c, roughness: 0.45 }));
    ball.castShadow = true;
    scene.add(ball);
    const T = frames.length, br = script.br, t0 = script.trailFrom;
    // (a slow-motion clip has many frames in the swing: fewer samples a frame keep the ribbon to a few hundred)
    const perFrame = Math.max(1, Math.min(SUB, Math.round(480 / Math.max(1, br - t0))));
    const nS = Math.max(2, (br - t0) * perFrame + 1);
    // the ribbon mostly travels with the bowler (three-quarters of the way), so a fast run-in doesn't smear the arm's
    // circle out along the pitch; at release it is exactly where the arm was
    const CARRY = 0.75, pelBr = frames[br][0];
    const top = Math.max(1e-6, ...speeds.slice(t0, br + 1));
    // three rows of points per sample: the shoulder (nearly clear), most of the way out, and the hand (the bright rim)
    const pos = new Float32Array(nS * 3 * 3), col = new Float32Array(nS * 3 * 4);
    const spoke: number[] = [], spokeCol: number[] = [];
    const tmp: V3[] = frames[0].map(() => [0, 0, 0]);
    const hand = (P: V3[]): V3 => {
      const e = P[S.elbow], w = P[S.wrist], d = Math.hypot(w[0] - e[0], w[1] - e[1], w[2] - e[2]) || 1;
      return [w[0] + ((w[0] - e[0]) / d) * 0.13, w[1] + ((w[1] - e[1]) / d) * 0.13, w[2] + ((w[2] - e[2]) / d) * 0.13];
    };
    const mix = (a2: V3, b2: V3, u: number): V3 => [a2[0] + (b2[0] - a2[0]) * u, a2[1] + (b2[1] - a2[1]) * u, a2[2] + (b2[2] - a2[2]) * u];
    for (let i = 0; i < nS; i++) {
      const tf = Math.min(br, t0 + i / perFrame);
      const P = sampleJoints(frames, tf, tmp);
      const cx = CARRY * (P[0][0] - pelBr[0]), cz = CARRY * (P[0][2] - pelBr[2]);
      const o0 = hand(P), o: V3 = [o0[0] - cx, o0[1], o0[2] - cz], sh: V3 = [P[S.shoulder][0] - cx, P[S.shoulder][1], P[S.shoulder][2] - cz];
      const k = Math.floor(tf), u = tf - k;
      const sp = (speeds[k] * (1 - u) + speeds[Math.min(T - 1, k + 1)] * u) / top;
      const c = speedColor(sp);
      pos.set(mix(sh, o, 0.15), i * 9); pos.set(mix(sh, o, 0.92), i * 9 + 3); pos.set(o, i * 9 + 6);
      const age = 0.35 + 0.65 * Math.min(1, i / (0.35 * nS));   // the swing's start is fainter
      col.set([c[0], c[1], c[2], 0.03 * age], i * 12); col.set([c[0], c[1], c[2], 0.55 * age], i * 12 + 4); col.set([Math.min(1, c[0] * 1.15 + 0.08), Math.min(1, c[1] * 1.15 + 0.08), Math.min(1, c[2] * 1.15 + 0.08), age], i * 12 + 8);
      if (i % 2 === 0) { spoke.push(...mix(sh, o, 0.22), ...o); spokeCol.push(Math.min(1, c[0] + 0.3), Math.min(1, c[1] + 0.3), Math.min(1, c[2] + 0.3), 0.15, Math.min(1, c[0] + 0.35), Math.min(1, c[1] + 0.35), Math.min(1, c[2] + 0.35), 1); }
    }
    const index: number[] = [];
    for (let i = 0; i < nS - 1; i++) for (const r of [0, 1]) { const a2 = i * 3 + r, b2 = a2 + 3; index.push(a2, a2 + 1, b2, a2 + 1, b2 + 1, b2); }
    const ribbonG = new THREE.BufferGeometry();
    ribbonG.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    ribbonG.setAttribute("color", new THREE.BufferAttribute(col, 4));
    ribbonG.setIndex(index);
    const ribbon = new THREE.Mesh(ribbonG, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, side: THREE.DoubleSide, depthWrite: false, toneMapped: false }));
    const spokeG = new THREE.BufferGeometry();
    spokeG.setAttribute("position", new THREE.Float32BufferAttribute(spoke, 3));
    spokeG.setAttribute("color", new THREE.Float32BufferAttribute(spokeCol, 4));
    const spokes = new THREE.LineSegments(spokeG, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, toneMapped: false }));
    for (const o of [ribbon, spokes]) { o.frustumCulled = false; o.renderOrder = 5; scene.add(o); }
    // the ball's flight after release: the hand's direction at release, at a bowler's pace (the speed isn't measured here)
    const pA = hand(sampleJoints(frames, Math.max(0, br - 0.5), tmp)), pB = hand(sampleJoints(frames, br, tmp));
    const dir = new THREE.Vector3(pB[0] - pA[0], Math.min(0, pB[1] - pA[1]) * 0.3, Math.min(-0.05, pB[2] - pA[2])).normalize();
    const fps = Math.max(1, result.fps_real || result.fps);

    // the video's frames (small JPEGs), for the way in and the way out
    const f0 = result.frames.start, imgs = new Map<number, HTMLImageElement>();
    for (let f = f0; f < result.frames.end; f++) { const im = new Image(); im.src = api.frameUrl(id, f); imgs.set(f, im); }
    const vw = result.video.width * result.display_scale, vh = result.video.height * result.display_scale;
    const kp = result.keypoints2d.xy, kc = result.keypoints2d.conf;
    const bow = right ? [6, 8, 10] : [5, 7, 9], frontLeg = right ? [11, 13, 15] : [12, 14, 16];
    // the video fills the picture, zoomed in so a small (broadcast) bowler stands about half its height, and follows
    // the bowler smoothly
    const heights: number[] = [], rawC: [number, number][] = [];
    for (let t = 0; t < T; t++) {
      const pts = kp[t].filter((_, j) => kc[t][j] > 0.2);
      if (pts.length < 4) { rawC.push(rawC[t - 1] ?? [vw / 2, vh / 2]); continue; }
      const ys = pts.map((q) => q[1]), xs = pts.map((q) => q[0]);
      heights.push(Math.max(...ys) - Math.min(...ys));
      rawC.push([(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2]);
    }
    heights.sort((a2, b2) => a2 - b2);
    const cover = Math.max(W / vw, H / vh), tall = heights.length ? heights[heights.length >> 1] : vh;
    const zoom = Math.max(cover, Math.min(cover * 2.6, (0.5 * H) / Math.max(1, tall)));
    const centres = rawC.map((_, t) => {
      let x = 0, y = 0, n = 0;
      for (let d = -4; d <= 4; d++) { const q = rawC[Math.max(0, Math.min(T - 1, t + d))]; x += q[0]; y += q[1]; n++; }
      return [x / n, y / n] as [number, number];
    });

    const k = portrait ? 1.4 : (W / 1280) * 1.3;          // sizes are for a 1280-wide picture
    const font = (px: number, w = 600) => `${w} ${Math.round(px * k)}px ${FONT}`;
    const semi = (px: number, w = 600) => `${w} ${Math.round(px * k)}px ${FONT_SEMI}`;
    const spaced = (px: number) => { try { (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${px * k}px`; } catch { /* older browsers: unspaced */ } };
    const v3 = new THREE.Vector3();
    const project = (p: V3 | THREE.Vector3): [number, number, boolean] => {
      if (Array.isArray(p)) v3.set(p[0], p[1], p[2]); else v3.copy(p);
      v3.project(camera);
      return [((v3.x + 1) / 2) * W, ((1 - v3.y) / 2) * H, v3.z < 1];
    };
    const path = (pts: V3[], close = false) => {
      ctx.beginPath();
      pts.forEach((p, i) => { const [x, y] = project(p); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
      if (close) ctx.closePath();
    };
    const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    const norm = (a: V3): V3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
    /** A wedge at joint `at` between the directions to `a` and `b` (the angle being read out). */
    const wedge = (at: V3, a: V3, b: V3, r: number): V3[] => {
      const u = norm(sub(a, at)), w = norm(sub(b, at)), pts: V3[] = [at];
      for (let i = 0; i <= 14; i++) {
        const s = i / 14, d = norm([u[0] * (1 - s) + w[0] * s, u[1] * (1 - s) + w[1] * s, u[2] * (1 - s) + w[2] * s]);
        pts.push([at[0] + d[0] * r, at[1] + d[1] * r, at[2] + d[2] * r]);
      }
      return pts;
    };

    const drawGraphic = (c: Callout, P: V3[], a: number) => {
      ctx.save();
      ctx.globalAlpha = a;
      ctx.lineWidth = 2.5 * k; ctx.lineJoin = "round"; ctx.lineCap = "round";
      if (c.graphic === "knee_front" || c.graphic === "knee_back") {
        const [hip, knee, ankle] = c.graphic === "knee_front" ? [S.frontHip, S.frontKnee, S.frontAnkle] : [S.backHip, S.backKnee, S.backAnkle];
        path(wedge(P[knee], P[hip], P[ankle], 0.24), true);
        ctx.fillStyle = "rgba(170,205,255,0.42)"; ctx.fill();
        ctx.strokeStyle = "rgba(215,232,255,0.95)"; ctx.stroke();
      } else if (c.graphic === "stride") {
        const a0: V3 = [P[S.backAnkle][0], 0.03, P[S.backAnkle][2]], a1: V3 = [P[S.frontAnkle][0], 0.03, P[S.frontAnkle][2]];
        ctx.strokeStyle = "rgba(225,236,255,0.96)"; ctx.lineWidth = 5 * k;
        path([a0, a1]); ctx.stroke();
        ctx.lineWidth = 3 * k;
        for (const q of [a0, a1]) { path([q, [q[0], 0.16, q[2]]]); ctx.stroke(); }
      } else if (c.graphic === "height") {
        const h = hand(P), g: V3 = [h[0], 0.01, h[2]];
        ctx.strokeStyle = "rgba(236,240,248,0.96)"; ctx.lineWidth = 4 * k;
        path([g, h]); ctx.stroke();
        const ring: V3[] = [];
        for (let i = 0; i <= 28; i++) ring.push([g[0] + 0.2 * Math.cos((i / 28) * 2 * Math.PI), 0.01, g[2] + 0.2 * Math.sin((i / 28) * 2 * Math.PI)]);
        ctx.lineWidth = 2.5 * k; path(ring); ctx.stroke();
        const [tx, ty] = project(h);
        ctx.beginPath(); ctx.moveTo(tx - 13 * k, ty); ctx.lineTo(tx + 13 * k, ty); ctx.stroke();
      } else if (c.graphic === "clearance") {
        // a pole from the ground up to the lower foot: how far the bowler is off the ground
        const f = P[J.rAnkle][1] < P[J.lAnkle][1] ? P[J.rAnkle] : P[J.lAnkle], top: V3 = [f[0], Math.max(0.05, f[1] - 0.07), f[2]], g: V3 = [f[0], 0.01, f[2]];
        ctx.strokeStyle = "rgba(236,240,248,0.96)"; ctx.lineWidth = 4 * k;
        path([g, [g[0], g[1] + (top[1] - g[1]) * a, g[2]]]); ctx.stroke();
        const ring: V3[] = [];
        for (let i = 0; i <= 28; i++) ring.push([g[0] + 0.17 * Math.cos((i / 28) * 2 * Math.PI), 0.01, g[2] + 0.17 * Math.sin((i / 28) * 2 * Math.PI)]);
        ctx.lineWidth = 2.5 * k; path(ring); ctx.stroke();
        const [tx, ty] = project(top);
        ctx.beginPath(); ctx.moveTo(tx - 15 * k, ty); ctx.lineTo(tx + 15 * k, ty); ctx.stroke();
      } else if (c.graphic === "trunk") {
        const pel = P[J.pelvis], th = P[J.thorax], len = Math.hypot(...sub(th, pel));
        const upP: V3 = [pel[0], pel[1] + len, pel[2]];
        ctx.setLineDash([5 * k, 5 * k]); ctx.strokeStyle = "rgba(236,240,248,0.8)"; ctx.lineWidth = 2 * k;
        path([pel, upP]); ctx.stroke(); ctx.setLineDash([]);
        path(wedge(pel, upP, th, len * 0.7), true);
        ctx.fillStyle = "rgba(170,205,255,0.32)"; ctx.fill();
        ctx.strokeStyle = "rgba(215,232,255,0.9)"; ctx.stroke();
      }
      ctx.restore();
    };

    const drawCallouts = (list: Callout[], P: V3[], a: number) => {
      const placed: [number, number, number, number][] = [];
      for (const c of list) drawGraphic(c, P, a);
      for (const c of list) {
        const m: V3 = [0, 0, 0];
        for (const j of c.anchor) { m[0] += P[j][0] / c.anchor.length; m[1] += P[j][1] / c.anchor.length; m[2] += P[j][2] / c.anchor.length; }
        if (c.graphic === "height") { const h = hand(P); m[0] = h[0]; m[1] = h[1] * 0.62; m[2] = h[2]; }
        if (c.graphic === "stride") m[1] = 0.05;
        const [ax, ay] = project(m);
        ctx.font = semi(25, 600);
        const tw = ctx.measureText(c.title).width;
        ctx.font = semi(15, 500);
        const bw = Math.max(tw, ctx.measureText(c.detail).width) + 28 * k, bh = 64 * k, gap = 7 * k;
        let bx = c.side > 0 ? ax + 30 * k + gap : ax - 30 * k - gap - bw, by = ay - bh - 4 * k;
        bx = Math.max(12 * k + gap, Math.min(W - bw - 12 * k, bx));
        by = Math.max(60 * k, Math.min(H - bh - 84 * k, by));
        for (let n = 0; n < 8 && placed.some(([px, py, pw, ph]) => bx < px + pw + 14 && px < bx + bw + 14 && by < py + ph + 8 && py < by + bh + 8); n++) by += bh + 10 * k;
        placed.push([bx, by, bw, bh]);
        ctx.save();
        // it arrives: the leader draws out from the joint, then the box eases in beside it
        const lead = Math.min(1, a * 2), box = Math.max(0, Math.min(1, a * 2 - 0.6));
        const left0 = bx > ax;
        bx += (left0 ? -1 : 1) * (1 - box) * 16 * k;
        const left = left0, barX = left ? bx - gap : bx + bw + gap;
        ctx.globalAlpha = Math.min(1, lead * 1.5);
        ctx.strokeStyle = "rgba(244,246,250,0.96)"; ctx.lineCap = "round";
        ctx.lineWidth = 1.8 * k;
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(ax + (barX - ax) * lead, ay); ctx.stroke();
        ctx.globalAlpha = box;
        ctx.lineWidth = 3.2 * k;
        ctx.beginPath(); ctx.moveTo(barX, Math.min(by, ay)); ctx.lineTo(barX, Math.max(by + bh, ay)); ctx.stroke();
        ctx.globalAlpha = Math.min(1, lead * 1.5);
        ctx.beginPath(); ctx.arc(ax, ay, 3.4 * k, 0, Math.PI * 2); ctx.fillStyle = "#f4f6fa"; ctx.fill();
        ctx.globalAlpha = box;
        ctx.fillStyle = "rgba(24,28,32,0.88)";
        ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 5 * k); ctx.fill();
        ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
        ctx.font = semi(25, 600); ctx.fillStyle = "#ffffff";
        ctx.fillText(c.title, bx + 14 * k, by + 29 * k);
        ctx.font = semi(15, 500); ctx.fillStyle = "rgba(226,232,240,0.9)";
        ctx.fillText(c.detail, bx + 14 * k, by + 51 * k);
        ctx.restore();
      }
    };

    const drawVideo = (tf: number, alpha: number, ribbon2d: boolean) => {
      const tA = Math.max(0, Math.min(T - 1, Math.floor(tf))), mixB = Math.max(0, Math.min(1, tf - tA));
      const t = Math.max(0, Math.min(T - 1, Math.round(tf)));
      const im = imgs.get(f0 + tA), im2 = imgs.get(f0 + Math.min(T - 1, tA + 1));
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = "#03050a"; ctx.fillRect(0, 0, W, H);
      const s = zoom, cA = centres[tA], cB = centres[Math.min(T - 1, tA + 1)];
      const cx = cA[0] + (cB[0] - cA[0]) * mixB, cy = cA[1] + (cB[1] - cA[1]) * mixB;
      // the tracked points between the two frames
      const kB = kp[Math.min(T - 1, tA + 1)], KP = kp[tA].map((q, j) => [q[0] + (kB[j][0] - q[0]) * mixB, q[1] + (kB[j][1] - q[1]) * mixB]);
      const ox = Math.min(0, Math.max(W - vw * s, W / 2 - cx * s)), oy = Math.min(0, Math.max(H - vh * s, H / 2 - cy * s));
      const fx = vw * s < W ? (W - vw * s) / 2 : ox, fy = vh * s < H ? (H - vh * s) / 2 : oy;
      if (im && im.complete && im.naturalWidth) ctx.drawImage(im, fx, fy, vw * s, vh * s);
      // the next frame over this one, as far as the time between them has gone
      if (mixB > 0.02 && im2 && im2.complete && im2.naturalWidth) { ctx.globalAlpha = alpha * mixB; ctx.drawImage(im2, fx, fy, vw * s, vh * s); ctx.globalAlpha = alpha; }
      // the arm's speed over the picture: the fan the bowling arm has swept so far
      if (ribbon2d) {
        const [iS, , iW] = bow, from = Math.max(0, t0);
        for (let q = from; q < Math.min(t, br); q++) {
          if (Math.min(kc[q][iS], kc[q][iW], kc[q + 1][iS], kc[q + 1][iW]) < 0.2) continue;
          const c = speedColor(speeds[q] / top), rgb = `${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)}`;
          const X = (p: number[]) => p[0] * s + fx, Y = (p: number[]) => p[1] * s + fy;
          const g = ctx.createLinearGradient(X(kp[q][iS]), Y(kp[q][iS]), X(kp[q][iW]), Y(kp[q][iW]));
          g.addColorStop(0.1, `rgba(${rgb},0.04)`); g.addColorStop(1, `rgba(${rgb},0.6)`);
          ctx.fillStyle = g;
          ctx.beginPath(); ctx.moveTo(X(kp[q][iS]), Y(kp[q][iS])); ctx.lineTo(X(kp[q][iW]), Y(kp[q][iW])); ctx.lineTo(X(kp[q + 1][iW]), Y(kp[q + 1][iW])); ctx.lineTo(X(kp[q + 1][iS]), Y(kp[q + 1][iS])); ctx.closePath(); ctx.fill();
          ctx.strokeStyle = `rgba(${rgb},0.95)`; ctx.lineWidth = 3 * k;
          ctx.beginPath(); ctx.moveTo(X(kp[q][iW]), Y(kp[q][iW])); ctx.lineTo(X(kp[q + 1][iW]), Y(kp[q + 1][iW])); ctx.stroke();
          ctx.strokeStyle = `rgba(${rgb},0.55)`; ctx.lineWidth = 1.2 * k;
          ctx.beginPath(); ctx.moveTo((X(kp[q][iS]) + X(kp[q][iW])) / 2, (Y(kp[q][iS]) + Y(kp[q][iW])) / 2); ctx.lineTo(X(kp[q][iW]), Y(kp[q][iW])); ctx.stroke();
        }
      }
      // the tracked body over the picture
      ctx.lineCap = "round"; ctx.lineWidth = 3 * k;
      for (const [a2, b2] of COCO_LIMBS) {
        if (kc[t][a2] < 0.25 || kc[t][b2] < 0.25) continue;
        const isBow = bow.includes(a2) && bow.includes(b2), isFront = frontLeg.includes(a2) && frontLeg.includes(b2);
        ctx.strokeStyle = isBow ? "#f472b6" : isFront ? "#34d399" : "rgba(20,24,32,0.9)";
        ctx.beginPath(); ctx.moveTo(KP[a2][0] * s + fx, KP[a2][1] * s + fy); ctx.lineTo(KP[b2][0] * s + fx, KP[b2][1] * s + fy); ctx.stroke();
      }
      for (let j = 5; j < 17; j++) {
        if (kc[t][j] < 0.25) continue;
        ctx.beginPath(); ctx.arc(KP[j][0] * s + fx, KP[j][1] * s + fy, 4 * k, 0, Math.PI * 2);
        ctx.fillStyle = bow.includes(j) ? "#f472b6" : "#22d3ee"; ctx.fill();
      }
      ctx.restore();
    };

    const drawHud = (title: string, sub: string, scene3d: number) => {
      ctx.save();
      if (scene3d > 0) {
        // darker towards the corners, as a broadcast graphic is lit
        const vg = ctx.createRadialGradient(W / 2, H * 0.52, Math.min(W, H) * 0.45, W / 2, H * 0.52, Math.hypot(W, H) * 0.62);
        vg.addColorStop(0, "rgba(0,0,0,0)"); vg.addColorStop(1, "rgba(0,0,0,0.42)");
        ctx.globalAlpha = scene3d; ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1;
      }
      ctx.textBaseline = "middle"; ctx.textAlign = "left";
      if (title) {
        ctx.globalAlpha = scene3d;
        ctx.font = font(21, 600); spaced(1.4);
        const tw = ctx.measureText(title.toUpperCase()).width;
        ctx.fillStyle = "rgba(20,24,28,0.6)";
        ctx.beginPath(); ctx.roundRect(10 * k, 9 * k, tw + 30 * k, 36 * k, 4 * k); ctx.fill();
        ctx.fillStyle = "#ec4899"; ctx.fillRect(10 * k, 9 * k, 3.5 * k, 36 * k);
        ctx.fillStyle = "#ffffff";
        ctx.fillText(title.toUpperCase(), 23 * k, 28 * k);
        if (sub) { spaced(0); ctx.font = semi(12.5, 500); ctx.fillStyle = "rgba(226,232,240,0.85)"; ctx.fillText(sub, 12 * k, 58 * k); }
      }
      ctx.globalAlpha = scene3d;
      ctx.font = font(23, 600); spaced(0.6); ctx.fillStyle = "#ffffff";
      ctx.fillText("ARM SPEED", 36 * k, H - 88 * k);
      const x0 = 36 * k, x1 = 218 * k;
      const g = ctx.createLinearGradient(x0, 0, x1, 0);
      for (let i = 0; i <= 8; i++) { const c = speedColor(i / 8); g.addColorStop(i / 8, `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`); }
      ctx.fillStyle = g; ctx.fillRect(x0, H - 62 * k, x1 - x0, 6 * k);
      ctx.font = semi(12, 500); spaced(0);
      ctx.fillStyle = "#7fb0ff"; ctx.fillText("slow", x0, H - 44 * k);
      ctx.fillStyle = "#ff8f87"; ctx.textAlign = "right"; ctx.fillText("fast", x1, H - 44 * k);
      ctx.font = semi(10.5, 500); ctx.fillStyle = "rgba(226,232,240,0.45)";
      if (!portrait) ctx.fillText(motion.assumed ? "3D body estimated · run-in and stride assumed" : "3D body estimated from the video · pitch drawn for scale", W - 12 * k, H - 12 * k);   // on a phone the note under the picture says it
      ctx.globalAlpha = 1;
      ctx.textAlign = "center"; ctx.font = font(16, 600); spaced(2.2); ctx.fillStyle = "rgba(255,255,255,0.78)";
      ctx.fillText("SEAMLY BIO MECH", W / 2, H - 20 * k);
      spaced(0);
      ctx.restore();
    };

    // each ghost is named above its head
    const drawGhostLabels = (a: number) => {
      ctx.save();
      ctx.globalAlpha = a; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      const taken: [number, number, number][] = [];
      ctx.font = font(15, 600); spaced(1.2);
      for (const g of [...ghosts.map((x) => ({ label: x.label, head: x.head })), { label: "Release", head: P[J.head] }]) {
        const pr = project([g.head[0], g.head[1] + 0.3, g.head[2]]);
        if (!pr[2]) continue;
        const x = pr[0], w = ctx.measureText(g.label.toUpperCase()).width + 16 * k;
        let y = pr[1];
        // labels that would sit on each other step upwards
        for (let n = 0; n < 4 && taken.some(([tx, ty, tw]) => Math.abs(tx - x) < (tw + w) / 2 + 4 && Math.abs(ty - y) < 26 * k); n++) y -= 28 * k;
        taken.push([x, y, w]);
        ctx.fillStyle = "rgba(20,24,28,0.72)"; ctx.beginPath(); ctx.roundRect(x - w / 2, y - 12 * k, w, 24 * k, 4 * k); ctx.fill();
        ctx.fillStyle = "#dbeafe"; ctx.fillText(g.label.toUpperCase(), x, y + 1 * k);
      }
      spaced(0);
      ctx.restore();
    };
    // the kinetic chain: how fast the hips, shoulder, elbow and hand are moving now, each against its own fastest, with a
    // tick left where each one peaked
    const chainFrom = Math.max(0, Math.min(...chain.peak) - 0.25 * fps);
    const drawChain = (tf: number, a: number) => {
      const show = Math.max(0, Math.min(1, (tf - chainFrom + 1) / 2)) * a;
      if (show < 0.02 || portrait) return;
      ctx.save();
      ctx.globalAlpha = show;
      const x0 = W - 250 * k, y0 = H - 168 * k, bw = 150 * k;
      ctx.textBaseline = "middle"; ctx.textAlign = "left";
      ctx.font = font(18, 600); spaced(0.6); ctx.fillStyle = "#ffffff";
      ctx.fillText("KINETIC CHAIN", x0, y0);
      spaced(0);
      chain.names.forEach((nm, i) => {
        const y = y0 + (24 + i * 19) * k, i0 = Math.max(0, Math.min(chain.speed[i].length - 2, Math.floor(tf))), u = Math.max(0, Math.min(1, tf - i0));
        const v = chain.speed[i][i0] * (1 - u) + chain.speed[i][i0 + 1] * u, c = speedColor(v);
        ctx.font = semi(12.5, 500); ctx.fillStyle = "rgba(226,232,240,0.9)"; ctx.fillText(nm, x0, y);
        ctx.fillStyle = "rgba(255,255,255,0.14)"; ctx.fillRect(x0 + 62 * k, y - 3.5 * k, bw, 7 * k);
        ctx.fillStyle = `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`;
        ctx.fillRect(x0 + 62 * k, y - 3.5 * k, bw * v, 7 * k);
        if (tf >= chain.peak[i]) { ctx.fillStyle = "#ffffff"; ctx.fillRect(x0 + 62 * k + bw - 2 * k, y - 6.5 * k, 2.5 * k, 13 * k); }
      });
      if (tf >= Math.max(...chain.peak)) {
        ctx.font = semi(11.5, 500);
        ctx.fillStyle = chain.ordered === null ? "rgba(226,232,240,0.6)" : chain.ordered ? "#86efac" : "#fcd34d";
        ctx.fillText(chain.ordered === null ? "slow motion needed to time the order" : chain.ordered ? "hips to hand, in sequence" : "out of sequence", x0, y0 + 104 * k);
      }
      ctx.restore();
    };
    // the bones a callout is about light up: pale blue, or green when it reads well
    let tinted = "";
    const tintFor = (list: Callout[]) => {
      const limbs = new Set<Limb>();
      let good = false;
      for (const c of list) for (const l of c.limbs) {
        const frontRight = !right;   // the front leg is the one opposite the bowling arm
        limbs.add(l === "leg_front" ? (frontRight ? "leg_r" : "leg_l") : l === "leg_back" ? (frontRight ? "leg_l" : "leg_r") : l === "arm" ? (right ? "arm_r" : "arm_l") : "trunk");
        good ||= c.good;
      }
      const key = [...limbs].sort().join() + good;
      if (key === tinted) return;
      tinted = key;
      body.tint([...limbs], limbs.size ? (good ? 0x4ade80 : 0xb4c8ea) : null);
    };
    const hingeTracks = [0, 1, 2, 3].map((l) => motion.hinges.map((h) => h[l]));
    const P: V3[] = frames[0].map(() => [0, 0, 0]);
    let raf = 0, last = performance.now(), lastShown = -1, lastCaption = "";
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.25, (now - last) / 1000);   // a slow device drops frames rather than running slow
      last = now;
      if (playingRef.current) {
        time.current += dt;
        if (time.current >= script.total) {
          time.current = script.total;
          playingRef.current = false; setPlaying(false);
          const r = recRef.current;
          if (r && r.rec.state !== "inactive") r.rec.stop();
        }
      }
      const st = replayState(script, time.current);
      if (st.video < 1) {
        sampleJoints(frames, st.tf, P);
        body.update(P, hingeTracks.map((tr) => sampleTrack(tr, st.tf)));
        [P[J.rAnkle], P[J.lAnkle], P[J.pelvis]].forEach((q, i) => {
          blobs[i].position.set(q[0], 0.012 + i * 0.001, q[2] + (i < 2 ? -0.05 : 0));
          (blobs[i].material as THREE.MeshBasicMaterial).opacity = i < 2 ? 0.75 * Math.max(0, 1 - (q[1] - 0.08) / 0.45) : 0.32;
        });
        tintFor(st.callout > 0.08 ? st.segment.callouts : []);
        // the camera circles the hips; a drag adds to the shot's angle
        const open = right ? -1 : 1, vw2 = viewRef.current;
        // the viewer's camera: beside the bowler, behind the arm, from above, or where the batter stands (a long lens down the pitch)
        const fixed = vw2 === "side" ? { az: 90 * open, el: 5, dist: 5.2, fov: 0 } : vw2 === "behind" ? { az: 8 * open, el: 12, dist: 6, fov: 0 }
          : vw2 === "top" ? { az: 0.1, el: 82, dist: 7.5, fov: 0 } : vw2 === "batter" ? { az: 180 - 2 * open, el: 3.2, dist: 17.5, fov: 9 } : null;
        const fov = fixed?.fov || (portrait ? 44 : 36);
        if (Math.abs(camera.fov - fov) > 0.01) { camera.fov = fov; camera.updateProjectionMatrix(); }
        const sh0 = fixed ?? st.shot;
        const az = ((sh0.az + user.current.az) * Math.PI) / 180, el = (Math.max(2, Math.min(86, sh0.el + user.current.el)) * Math.PI) / 180;
        const fc = sampleTrack(motion.focus, st.tf);
        const tx = fc[0], ty = portrait ? 1.0 : 0.98, tz = fc[2] - 0.25;
        camera.position.set(tx + sh0.dist * Math.sin(az) * Math.cos(el), ty + sh0.dist * Math.sin(el), tz + sh0.dist * Math.cos(az) * Math.cos(el));
        camera.lookAt(tx, ty, tz);
        sun.position.set(tx + 3.5, 9, tz + 4.5); sun.target.position.set(tx, 0, tz); sun.target.updateMatrixWorld();
        // the ribbon so far, and the ball: in the hand until release, then away down the pitch
        const shownTrail = st.segment.trail ? Math.max(0, Math.min(nS, Math.floor((st.tf - t0) * perFrame) + 1)) : 0;
        const now = Math.min(st.tf, br), pj = now === st.tf ? P[0] : frames[br][0];
        for (const o of [ribbon, spokes]) o.position.set(CARRY * (pj[0] - pelBr[0]), 0, CARRY * (pj[2] - pelBr[2]));
        ribbon.visible = spokes.visible = shownTrail > 1;
        ribbonG.setDrawRange(0, Math.max(0, shownTrail - 1) * 12);
        spokeG.setDrawRange(0, Math.ceil(shownTrail / 2) * 2);
        const h = hand(P);
        if (st.tf <= br) { ball.visible = true; ball.position.set(h[0], h[1], h[2]); }
        else {
          const s = (st.tf - br) / fps;
          ball.visible = s < 0.45;
          ball.position.set(pB[0] + dir.x * 33 * s, Math.max(0.04, pB[1] + dir.y * 33 * s - 4.9 * s * s), pB[2] + dir.z * 33 * s);
        }
        const strobe = st.segment.strobe ? Math.min(1, (st.u * st.segment.dur) / 1.4) * Math.min(1, ((1 - st.u) * st.segment.dur) / 0.5) : 0;
        ghosts.forEach((g) => g.body.fade(strobe * 0.34));
        if (rival) {
          // the same moment relative to release, in real time
          const t2 = rival.br + ((st.tf - br) / fps) * rival.fps;
          const inside = t2 >= 0 && t2 <= rival.m.joints.length - 1;
          if (inside) rival.body.update(sampleJoints(rival.m.joints, t2, rival.P), rival.tracks.map((tr) => sampleTrack(tr, t2)));
          rival.body.fade(inside ? 0.55 * (1 - strobe) : 0);
        }
        renderer.render(scene, camera);
        ctx.globalAlpha = 1;
        ctx.drawImage(renderer.domElement, 0, 0, W, H);
        if (strobe > 0.02) drawGhostLabels(strobe);
        drawChain(st.tf, 1 - st.video);
        if (st.callout > 0) drawCallouts(st.segment.callouts, P, st.callout);
      }
      if (st.video > 0) drawVideo(st.tf, st.video, st.segment.trail);
      drawHud(st.title, st.sub, 1 - st.video);
      if (Math.abs(time.current - lastShown) > 0.1 || !playingRef.current) { lastShown = time.current; setShown(time.current); }
      const cap = st.video >= 1 ? "The video" : [st.title, ...(st.callout > 0.5 ? st.segment.callouts.map((c) => `${c.title}: ${c.detail}`) : [])].filter(Boolean).join(". ");
      if (cap !== lastCaption) { lastCaption = cap; setCaption(cap); }
    };
    const start = () => { last = performance.now(); raf = requestAnimationFrame(frame); };
    // the condensed face is loaded before the first title is drawn (the canvas doesn't wait for fonts by itself)
    (document.fonts?.load ? Promise.race([Promise.all([document.fonts.load(`600 20px "Barlow Condensed"`), document.fonts.load(`600 20px "Barlow Semi Condensed"`), document.fonts.load(`500 20px "Barlow Semi Condensed"`)]), new Promise((r) => setTimeout(r, 1500))]) : Promise.resolve()).then(start, start);

    return () => {
      cancelAnimationFrame(raf);
      const r = recRef.current;
      if (r && r.rec.state !== "inactive") { r.rec.ondataavailable = null; r.rec.onstop = null; r.rec.stop(); }
      recRef.current = null;
      body.dispose(); ghosts.forEach((g) => g.body.dispose()); rival?.body.dispose();
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        const mat = m.material as (THREE.Material & { map?: THREE.Texture | null }) | THREE.Material[] | undefined;
        for (const x of Array.isArray(mat) ? mat : mat ? [mat] : []) { (x as { map?: THREE.Texture | null }).map?.dispose(); x.dispose(); }
      });
      sky.dispose(); blobTex.dispose(); envTex.dispose(); pmrem.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      imgs.forEach((im) => { im.src = ""; });
    };
  }, [id, result, motion, frames, speeds, script, W, H, portrait, bones, ghost]);

  // drag on the picture to look round the bowler; double-click puts the camera back
  const drag = useRef<{ x: number; y: number } | null>(null);
  const onDown = (e: React.PointerEvent) => { drag.current = { x: e.clientX, y: e.clientY }; (e.target as HTMLElement).setPointerCapture(e.pointerId); };
  const onMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    user.current.az -= (e.clientX - drag.current.x) * 0.35;
    user.current.el = Math.max(-25, Math.min(55, user.current.el + (e.clientY - drag.current.y) * 0.2));
    drag.current = { x: e.clientX, y: e.clientY };
  };
  const onUp = () => { drag.current = null; };

  const restart = () => { time.current = 0; user.current = { az: 0, el: 0 }; setPlaying(true); };
  const seek = (t: number) => { time.current = t; setShown(t); };
  const record = () => {
    const c = canvasRef.current;
    if (!c || !mime) return;
    const chunks: Blob[] = [];
    const r = new MediaRecorder(c.captureStream(60), { mimeType: mime, videoBitsPerSecond: big ? 5_000_000 : 4_000_000 });
    r.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    r.onstop = () => {
      recRef.current = null;
      const blob = new Blob(chunks, { type: mime.split(";")[0] });
      if (!blob.size) { setRec("idle"); return; }
      const base = (name || "delivery").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "delivery";
      const file = new File([blob], `${base}-bio-mech.${clipExt(mime)}`, { type: blob.type });
      setClip({ url: URL.createObjectURL(blob), file });
      setRec("done");
    };
    recRef.current = { rec: r, chunks };
    time.current = 0; user.current = { az: 0, el: 0 };
    setView("director");
    setClip(null); setRec("recording"); setPlaying(true);
    r.start(500);
  };
  const stopRecording = () => { const r = recRef.current; if (r && r.rec.state !== "inactive") { r.rec.ondataavailable = null; r.rec.onstop = null; r.rec.stop(); } recRef.current = null; setRec("idle"); };
  const canShare = !!clip && typeof navigator.canShare === "function" && navigator.canShare({ files: [clip.file] });
  const share = async () => { if (clip) { try { await navigator.share({ files: [clip.file], title: "Bio-mech replay from Seamly" }); } catch { /* cancelled */ } } };
  const ended = !playing && shown >= script.total - 0.05;

  return (
    <div className="bio-overlay" role="dialog" aria-modal="true" aria-labelledby="bio-title" ref={dialogRef}>
      <div className={`bio-sheet ${portrait ? "portrait" : ""}`}>
        <div className="bio-head">
          <h2 id="bio-title">Bio-mech replay</h2>
          <button ref={closeRef} type="button" className="btn icon sm ghost" onClick={onClose} aria-label="Close the replay (Esc)"><IX size={16} /></button>
        </div>
        {failed ? (
          <div className="notice warn" role="alert">This browser couldn't start 3D graphics, so the replay can't be shown here.</div>
        ) : (
          <>
            <canvas ref={canvasRef} width={W} height={H} className="bio-canvas" role="img"
              aria-label="The delivery replayed in 3D: a bone skeleton on a cricket pitch, with the bowling arm's speed drawn as a coloured ribbon"
              onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onDoubleClick={() => { user.current = { az: 0, el: 0 }; }} />
            <p className="sr-only" role="status">{caption}</p>
            <div className="bio-bar">
              <button type="button" className="btn icon sm" onClick={() => (ended ? restart() : setPlaying((p) => !p))} disabled={rec === "recording"}
                aria-label={ended ? "Play again" : playing ? "Pause" : "Play"}>{ended ? <IRefresh size={15} /> : playing ? <IPause size={15} /> : <IPlay size={15} />}</button>
              <input type="range" min={0} max={script.total} step={0.05} value={shown} disabled={rec === "recording"} aria-label="Position in the replay"
                aria-valuetext={`${Math.round(shown)} of ${Math.round(script.total)} seconds`} onChange={(e) => seek(Number(e.target.value))} />
              {rec === "recording"
                ? <button type="button" className="btn sm" onClick={stopRecording}>Recording… {Math.round((shown / script.total) * 100)}% · Cancel</button>
                : mime && <button type="button" className="btn sm" onClick={record} title="Plays the replay through once and saves it as a video">{rec === "done" ? "Save again" : "Save as video"}</button>}
            </div>
            <div className="bio-tools">
              <div className="seg" role="group" aria-label="Camera">
                {([["director", "Director"], ["side", "Side"], ["behind", "Behind"], ["batter", "Batter's eye"], ["top", "Top"]] as const).map(([v, label]) => (
                  <button key={v} type="button" className={view === v ? "on" : ""} aria-pressed={view === v} disabled={rec === "recording"}
                    onClick={() => { user.current = { az: 0, el: 0 }; setView(v); }}>{label}</button>
                ))}
              </div>
              {others.length > 0 && (
                <label className="bio-ghost">
                  <span>Compare in 3D</span>
                  <select className="input" value={ghostId} onChange={(e) => setGhostId(e.target.value)} disabled={rec === "recording"}>
                    <option value="">No ghost</option>
                    {others.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                  </select>
                </label>
              )}
              {ghost && <span className="chip"><span className="dot" style={{ background: "#ffb54a" }} /> Ghost: {ghost.name}, in step from release</span>}
            </div>
            {rec === "done" && clip && (
              <div className="bio-saved" role="status">
                <span>Video ready ({(clip.file.size / 1e6).toFixed(1)} MB).</span>
                <a className="btn sm primary" href={clip.url} download={clip.file.name}><IDownload size={14} /> Download</a>
                {canShare && <button type="button" className="btn sm" onClick={share}><IUpload size={14} /> Share</button>}
              </div>
            )}
            <p className="faint bio-note">
              Drag the picture to look round the bowler (double-click to reset). The 3D body is estimated from the video and its run through the crease
              is rebuilt from the foot contacts{motion.assumed ? " (from behind or in front the camera can't see along the pitch, so the run-in speed and the stride's length are assumed)" : ""}; the pitch is drawn for scale; the numbers shown are the ones this clip measured (≈ marks a 3D estimate). Bone shapes: OpenSim full-body model (Rajagopal et al. 2016).
            </p>
          </>
        )}
      </div>
    </div>
  );
}
