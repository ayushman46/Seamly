import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { api } from "../api";
import type { AnalysisResult } from "../types";
import { J, armSpeed, replayScript, replayState, sampleJoints, sceneJoints, sides, speedColor, LANDING_X, LANDING_Z, type Callout, type V3 } from "../lib/biomech";
import { BoneBody } from "../lib/bones";
import { clipExt, clipMime } from "../lib/clip";
import { IDownload, IPause, IPlay, IRefresh, IUpload, IX } from "./Icons";

/**
 * Bio-mech replay: the delivery as a broadcast-style sequence (lib/biomech.ts has the timeline). One canvas holds the
 * whole picture (the video or the 3D scene, then the titles and callouts drawn on top), so what is saved as a video is
 * exactly what is on screen.
 */

const FONT = `"Barlow Condensed", "Roboto Condensed", "Arial Narrow", Inter, -apple-system, sans-serif`;
const SUB = 4;   // ribbon samples per video frame
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
    const wood = new THREE.MeshStandardMaterial({ color: 0xe2c98f, roughness: 0.5 });
    for (const x of [-0.114, 0, 0.114]) {
      const s = new THREE.Mesh(new THREE.CylinderGeometry(0.019, 0.019, 0.711, 12), wood);
      s.position.set(x, 0.355, bowl); s.castShadow = true;
      scene.add(s);
    }
    for (const x of [-0.057, 0.057]) {
      const b = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.11, 8), wood);
      b.rotation.z = Math.PI / 2; b.position.set(x, 0.72, bowl);
      scene.add(b);
    }
  }
  // the line the bowler runs along, and where the front foot lands
  const run = new THREE.Mesh(new THREE.PlaneGeometry(0.02, 9), new THREE.MeshBasicMaterial({ color: 0xf59e0b, transparent: true, opacity: 0.32 }));
  run.rotation.x = -Math.PI / 2; run.position.set(landX, 0.009, 2.4);
  scene.add(run);
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.3, 0.325, 48), new THREE.MeshBasicMaterial({ color: 0x5b8def, transparent: true, opacity: 0.9, side: THREE.DoubleSide }));
  ring.rotation.x = -Math.PI / 2; ring.position.set(landX, 0.01, LANDING_Z - 0.06);
  scene.add(ring);
}

export default function BioReplay({ id, result, name, onClose }: { id: string; result: AnalysisResult; name: string; onClose: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const script = useMemo(() => replayScript(result), [result]);
  const frames = useMemo(() => sceneJoints(result), [result]);
  const speeds = useMemo(() => armSpeed(result), [result]);
  const time = useRef(0);
  const playingRef = useRef(true);
  const user = useRef({ az: 0, el: 0 });
  const [playing, setPlaying] = useState(true);
  const [shown, setShown] = useState(0);          // the time on the scrub bar (updated a few times a second)
  const [caption, setCaption] = useState("");     // what a screen reader hears: the phase and its numbers
  const [failed, setFailed] = useState(false);
  const [rec, setRec] = useState<"idle" | "recording" | "done">("idle");
  const [clip, setClip] = useState<{ url: string; file: File } | null>(null);
  const recRef = useRef<{ rec: MediaRecorder; chunks: Blob[] } | null>(null);
  const portrait = useMemo(() => typeof window !== "undefined" && window.innerWidth < window.innerHeight * 0.8, []);
  const [W, H] = portrait ? [720, 960] : [1280, 720];
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
    const scene = new THREE.Scene();
    const sky = skyTexture();
    scene.background = sky;
    scene.fog = new THREE.Fog(0x0b1424, 26, 95);
    const camera = new THREE.PerspectiveCamera(portrait ? 38 : 30, W / H, 0.1, 300);
    scene.add(new THREE.HemisphereLight(0xf2f5ff, 0x2a4a30, 1.45));
    const sun = new THREE.DirectionalLight(0xfff6e6, 2.4);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    Object.assign(sun.shadow.camera, { left: -3, right: 3, top: 3, bottom: -3, near: 1, far: 30 });
    sun.shadow.bias = -0.0015;
    scene.add(sun, sun.target);
    const right = result.bowling_arm.arm === "right";
    const S = sides(right);
    buildPitch(scene, LANDING_X * (right ? -1 : 1));
    const body = new BoneBody();
    scene.add(body.group);

    // the ball in the hand, and the ribbon the bowling arm sweeps (built once, revealed as the action plays)
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.037, 16, 12), new THREE.MeshStandardMaterial({ color: 0xc81e2c, roughness: 0.45 }));
    ball.castShadow = true;
    scene.add(ball);
    const T = frames.length, br = script.br, t0 = script.trailFrom;
    const nS = Math.max(2, (br - t0) * SUB + 1);
    const top = Math.max(1e-6, ...speeds.slice(t0, br + 1));
    const pos = new Float32Array(nS * 2 * 3), col = new Float32Array(nS * 2 * 3), edge = new Float32Array(nS * 3), edgeCol = new Float32Array(nS * 3);
    const spoke: number[] = [], spokeCol: number[] = [];
    const tmp: V3[] = frames[0].map(() => [0, 0, 0]);
    const hand = (P: V3[]): V3 => {
      const e = P[S.elbow], w = P[S.wrist], d = Math.hypot(w[0] - e[0], w[1] - e[1], w[2] - e[2]) || 1;
      return [w[0] + ((w[0] - e[0]) / d) * 0.13, w[1] + ((w[1] - e[1]) / d) * 0.13, w[2] + ((w[2] - e[2]) / d) * 0.13];
    };
    for (let i = 0; i < nS; i++) {
      const tf = Math.min(br, t0 + i / SUB);
      const P = sampleJoints(frames, tf, tmp);
      const o = hand(P), sh = P[S.shoulder];
      const inner: V3 = [sh[0] + (o[0] - sh[0]) * 0.52, sh[1] + (o[1] - sh[1]) * 0.52, sh[2] + (o[2] - sh[2]) * 0.52];
      const k = Math.floor(tf), u = tf - k;
      const sp = (speeds[k] * (1 - u) + speeds[Math.min(T - 1, k + 1)] * u) / top;
      const c = speedColor(sp);
      pos.set(inner, i * 6); pos.set(o, i * 6 + 3);
      col.set([c[0] * 0.7, c[1] * 0.7, c[2] * 0.7], i * 6); col.set(c, i * 6 + 3);
      edge.set(o, i * 3); edgeCol.set(c, i * 3);
      if (i % 2 === 0) { spoke.push(...inner, ...o); spokeCol.push(...c, ...c); }
    }
    const index: number[] = [];
    for (let i = 0; i < nS - 1; i++) index.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    const ribbonG = new THREE.BufferGeometry();
    ribbonG.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    ribbonG.setAttribute("color", new THREE.BufferAttribute(col, 3));
    ribbonG.setIndex(index);
    const ribbon = new THREE.Mesh(ribbonG, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false }));
    const spokeG = new THREE.BufferGeometry();
    spokeG.setAttribute("position", new THREE.Float32BufferAttribute(spoke, 3));
    spokeG.setAttribute("color", new THREE.Float32BufferAttribute(spokeCol, 3));
    const spokes = new THREE.LineSegments(spokeG, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85 }));
    const edgeG = new THREE.BufferGeometry();
    edgeG.setAttribute("position", new THREE.BufferAttribute(edge, 3));
    edgeG.setAttribute("color", new THREE.BufferAttribute(edgeCol, 3));
    const rim = new THREE.Line(edgeG, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95 }));
    for (const o of [ribbon, spokes, rim]) { o.frustumCulled = false; o.renderOrder = 5; scene.add(o); }
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

    const k = portrait ? 1.38 : (W / 1280) * 1.22;          // sizes are for a 1280-wide picture
    const font = (px: number, w = 600) => `${w} ${Math.round(px * k)}px ${FONT}`;
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
        ctx.font = font(21, 700);
        const tw = ctx.measureText(c.title).width;
        ctx.font = font(13.5, 500);
        const bw = Math.max(tw, ctx.measureText(c.detail).width) + 26 * k, bh = 56 * k;
        let bx = c.side > 0 ? ax + 34 * k : ax - 34 * k - bw, by = ay - bh - 6 * k;
        bx = Math.max(10 * k, Math.min(W - bw - 10 * k, bx));
        by = Math.max(54 * k, Math.min(H - bh - 70 * k, by));
        for (let n = 0; n < 8 && placed.some(([px, py, pw, ph]) => bx < px + pw + 8 && px < bx + bw + 8 && by < py + ph + 8 && py < by + bh + 8); n++) by += bh + 10 * k;
        placed.push([bx, by, bw, bh]);
        ctx.save();
        ctx.globalAlpha = a;
        // leader: from the joint to the bar on the box's near side
        const lx = c.side > 0 || bx > ax ? bx : bx + bw;
        ctx.strokeStyle = "rgba(240,244,250,0.95)"; ctx.lineWidth = 1.6 * k;
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(lx, ay); ctx.lineTo(lx, by + bh / 2); ctx.stroke();
        ctx.beginPath(); ctx.arc(ax, ay, 3.2 * k, 0, Math.PI * 2); ctx.fillStyle = "#f4f6fa"; ctx.fill();
        ctx.fillStyle = "rgba(14,18,24,0.9)";
        ctx.fillRect(bx, by, bw, bh);
        ctx.fillStyle = "#f4f6fa"; ctx.fillRect(lx === bx ? bx : bx + bw - 2.5 * k, by, 2.5 * k, bh);
        ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
        ctx.font = font(21, 700); ctx.fillStyle = "#ffffff";
        ctx.fillText(c.title, bx + 13 * k, by + 25 * k);
        ctx.font = font(13.5, 500); ctx.fillStyle = "rgba(226,232,240,0.86)";
        ctx.fillText(c.detail, bx + 13 * k, by + 44 * k);
        ctx.restore();
      }
    };

    const drawVideo = (tf: number, alpha: number) => {
      const t = Math.max(0, Math.min(T - 1, Math.round(tf)));
      const im = imgs.get(f0 + t);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = "#03050a"; ctx.fillRect(0, 0, W, H);
      const s = zoom, [cx, cy] = centres[t];
      const ox = Math.min(0, Math.max(W - vw * s, W / 2 - cx * s)), oy = Math.min(0, Math.max(H - vh * s, H / 2 - cy * s));
      const fx = vw * s < W ? (W - vw * s) / 2 : ox, fy = vh * s < H ? (H - vh * s) / 2 : oy;
      if (im && im.complete && im.naturalWidth) ctx.drawImage(im, fx, fy, vw * s, vh * s);
      // the tracked body over the picture
      ctx.lineCap = "round"; ctx.lineWidth = 3 * k;
      for (const [a2, b2] of COCO_LIMBS) {
        if (kc[t][a2] < 0.25 || kc[t][b2] < 0.25) continue;
        const isBow = bow.includes(a2) && bow.includes(b2), isFront = frontLeg.includes(a2) && frontLeg.includes(b2);
        ctx.strokeStyle = isBow ? "#f472b6" : isFront ? "#34d399" : "rgba(20,24,32,0.9)";
        ctx.beginPath(); ctx.moveTo(kp[t][a2][0] * s + fx, kp[t][a2][1] * s + fy); ctx.lineTo(kp[t][b2][0] * s + fx, kp[t][b2][1] * s + fy); ctx.stroke();
      }
      for (let j = 5; j < 17; j++) {
        if (kc[t][j] < 0.25) continue;
        ctx.beginPath(); ctx.arc(kp[t][j][0] * s + fx, kp[t][j][1] * s + fy, 4 * k, 0, Math.PI * 2);
        ctx.fillStyle = bow.includes(j) ? "#f472b6" : "#22d3ee"; ctx.fill();
      }
      ctx.restore();
    };

    const drawHud = (title: string, scene3d: number) => {
      ctx.save();
      ctx.textBaseline = "middle"; ctx.textAlign = "left";
      if (title) {
        ctx.globalAlpha = Math.max(0.0, scene3d);
        ctx.fillStyle = "#ec4899"; ctx.fillRect(12 * k, 14 * k, 4 * k, 28 * k);
        ctx.font = font(19, 700); spaced(1.6); ctx.fillStyle = "#ffffff";
        ctx.fillText(title.toUpperCase(), 26 * k, 29 * k);
      }
      ctx.globalAlpha = scene3d;
      ctx.font = font(18, 700); spaced(0.8); ctx.fillStyle = "#ffffff";
      ctx.fillText("ARM SPEED", 40 * k, H - 76 * k);
      const g = ctx.createLinearGradient(40 * k, 0, 200 * k, 0);
      for (let i = 0; i <= 8; i++) { const c = speedColor(i / 8); g.addColorStop(i / 8, `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`); }
      ctx.fillStyle = g; ctx.fillRect(40 * k, H - 52 * k, 160 * k, 5 * k);
      ctx.font = font(11, 600); spaced(0);
      ctx.fillStyle = "#7fb0ff"; ctx.fillText("slow", 40 * k, H - 38 * k);
      ctx.fillStyle = "#ff8f87"; ctx.textAlign = "right"; ctx.fillText("fast", 200 * k, H - 38 * k);
      ctx.font = font(11, 500); ctx.fillStyle = "rgba(226,232,240,0.5)";
      ctx.fillText("3D body estimated from the video · pitch drawn for scale", W - 14 * k, H - 14 * k);
      ctx.globalAlpha = 1;
      ctx.textAlign = "center"; ctx.font = font(13, 700); spaced(2.4); ctx.fillStyle = "rgba(255,255,255,0.72)";
      ctx.fillText("SEAMLY BIO MECH", W / 2, H - 22 * k);
      spaced(0);
      ctx.restore();
    };

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
        body.update(P);
        // the camera circles the hips; a drag adds to the shot's angle
        const az = ((st.shot.az + user.current.az) * Math.PI) / 180, el = (Math.max(3, Math.min(70, st.shot.el + user.current.el)) * Math.PI) / 180;
        const tx = P[0][0], ty = portrait ? 1.0 : 0.98, tz = P[0][2] - 0.25;
        camera.position.set(tx + st.shot.dist * Math.sin(az) * Math.cos(el), ty + st.shot.dist * Math.sin(el), tz + st.shot.dist * Math.cos(az) * Math.cos(el));
        camera.lookAt(tx, ty, tz);
        sun.position.set(tx + 3.5, 9, tz + 4.5); sun.target.position.set(tx, 0, tz); sun.target.updateMatrixWorld();
        // the ribbon so far, and the ball: in the hand until release, then away down the pitch
        const shownTrail = st.segment.trail ? Math.max(0, Math.min(nS, Math.floor((st.tf - t0) * SUB) + 1)) : 0;
        ribbon.visible = spokes.visible = rim.visible = shownTrail > 1;
        ribbonG.setDrawRange(0, Math.max(0, shownTrail - 1) * 6);
        spokeG.setDrawRange(0, Math.ceil(shownTrail / 2) * 2);
        edgeG.setDrawRange(0, shownTrail);
        const h = hand(P);
        if (st.tf <= br) { ball.visible = true; ball.position.set(h[0], h[1], h[2]); }
        else {
          const s = (st.tf - br) / fps;
          ball.visible = s < 0.45;
          ball.position.set(pB[0] + dir.x * 33 * s, Math.max(0.04, pB[1] + dir.y * 33 * s - 4.9 * s * s), pB[2] + dir.z * 33 * s);
        }
        renderer.render(scene, camera);
        ctx.globalAlpha = 1;
        ctx.drawImage(renderer.domElement, 0, 0, W, H);
        if (st.callout > 0) drawCallouts(st.segment.callouts, P, st.callout);
      }
      if (st.video > 0) drawVideo(st.tf, st.video);
      drawHud(st.title, 1 - st.video);
      if (Math.abs(time.current - lastShown) > 0.1 || !playingRef.current) { lastShown = time.current; setShown(time.current); }
      const cap = st.video >= 1 ? "The video" : [st.title, ...(st.callout > 0.5 ? st.segment.callouts.map((c) => `${c.title}: ${c.detail}`) : [])].filter(Boolean).join(". ");
      if (cap !== lastCaption) { lastCaption = cap; setCaption(cap); }
    };
    const start = () => { last = performance.now(); raf = requestAnimationFrame(frame); };
    // the condensed face is loaded before the first title is drawn (the canvas doesn't wait for fonts by itself)
    (document.fonts?.load ? Promise.race([document.fonts.load(`700 20px "Barlow Condensed"`), new Promise((r) => setTimeout(r, 1200))]) : Promise.resolve()).then(start, start);

    return () => {
      cancelAnimationFrame(raf);
      const r = recRef.current;
      if (r && r.rec.state !== "inactive") { r.rec.ondataavailable = null; r.rec.onstop = null; r.rec.stop(); }
      recRef.current = null;
      body.dispose();
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        const mat = m.material as (THREE.Material & { map?: THREE.Texture | null }) | THREE.Material[] | undefined;
        for (const x of Array.isArray(mat) ? mat : mat ? [mat] : []) { (x as { map?: THREE.Texture | null }).map?.dispose(); x.dispose(); }
      });
      sky.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      imgs.forEach((im) => { im.src = ""; });
    };
  }, [id, result, frames, speeds, script, W, H, portrait]);

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
    const r = new MediaRecorder(c.captureStream(30), { mimeType: mime, videoBitsPerSecond: 7_000_000 });
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
            {rec === "done" && clip && (
              <div className="bio-saved" role="status">
                <span>Video ready ({(clip.file.size / 1e6).toFixed(1)} MB).</span>
                <a className="btn sm primary" href={clip.url} download={clip.file.name}><IDownload size={14} /> Download</a>
                {canShare && <button type="button" className="btn sm" onClick={share}><IUpload size={14} /> Share</button>}
              </div>
            )}
            <p className="faint bio-note">
              Drag the picture to look round the bowler (double-click to reset). The 3D body is estimated from the video and its run through the crease
              is rebuilt from the foot contacts; the numbers shown are the ones this clip measured.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
