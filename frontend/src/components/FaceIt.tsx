import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import type { AnalysisResult, PaceRecord } from "../types";
import { buildMotion, sampleJoints, sampleTrack, sides, type V3 } from "../lib/biomech";
import { BoneBody, SimpleBody, loadBones, type Body, type BoneData } from "../lib/bones";
import { buildPitch, skyTexture } from "../lib/pitchScene";
import { BALL_R, CREASE_Z, LENGTHS, MAX_SWING, REACTION_S, STUMPS_Z, STUMPS_W, STUMP_H, aimAt, ballAt, lengthName, measuredBall, readDelivery, releaseOf, type Read } from "../lib/flight";
import { IRefresh, IX } from "./Icons";

/**
 * Face it: this delivery from the batter's end. The bowler is the 3D skeleton rebuilt from the clip, running in and
 * letting go in real time; the ball then flies by physics (lib/flight.ts) from the hand's place at release, at the
 * clip's measured pace when it has one, to the length and line chosen here. Beside the picture: what that release
 * point is worth (the angle the ball must leave the hand at, the time the batter gets, where it passes the stumps).
 */

type View = "eye" | "tracker" | "side";
const EYE_H = 1.55;       // a batter's eyes in the stance, metres
const EYE_X = 0.12;       // towards the leg side of middle stump
const BAND_COLORS = [0xef4444, 0xf59e0b, 0x22c55e, 0x3b82f6, 0x8b5cf6];
const BAND_CSS = ["#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#8b5cf6"];

/** A tube along a run of points (straight between them, so the bounce stays a corner). */
class Poly extends THREE.Curve<THREE.Vector3> {
  constructor(private pts: V3[]) { super(); }
  getPoint(t: number, target = new THREE.Vector3()): THREE.Vector3 {
    const n = this.pts.length - 1, x = Math.max(0, Math.min(1, t)) * n, i = Math.min(n - 1, Math.floor(x)), u = x - i, a = this.pts[i], b = this.pts[i + 1];
    return target.set(a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u);
  }
}
const RADIAL = 8;

/** A release angle in words: degrees below the horizontal, or above it for a slow ball that has to be lobbed. */
const angle = (down: number) => `${Math.abs(down).toFixed(1)}° ${down >= 0 ? "down" : "up"}`;
const cm = (m: number) => `${Math.round(Math.abs(m) * 100)} cm`;
/** How high that is on a batter of about 1.8 m. */
function heightWord(h: number): string {
  return h < 0.12 ? "at the toes" : h < 0.32 ? "ankle high" : h < 0.6 ? "knee high" : h < 0.95 ? "thigh high" : h < 1.15 ? "waist high"
    : h < 1.45 ? "chest high" : h < 1.8 ? "head high" : "over the head";
}
/** The line at the stumps in a batter's words (off: metres towards the off side of middle stump). */
function lineWord(off: number): string {
  const a = Math.abs(off), side = off >= 0 ? "off" : "leg";
  if (a < 0.04) return "middle stump";
  if (a < 0.15) return `${side} stump`;
  if (off < 0) return a < 0.3 ? "just down the leg side" : "down the leg side";
  return a < 0.26 ? "just outside off stump" : a < 0.5 ? "outside off stump" : "wide outside off stump";
}

export default function FaceIt({ result, name, pace, onClose }: {
  result: AnalysisResult; name: string; pace?: PaceRecord | null; onClose: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const clockEl = useRef<HTMLSpanElement>(null);
  const motion = useMemo(() => buildMotion(result), [result]);
  const release = useMemo(() => releaseOf(result), [result]);
  const fps = Math.max(1, result.fps_real || result.fps);
  const right = result.bowling_arm.arm === "right";

  // the pace: the clip's own when it was measured; and the length, when the frame it pitched was marked too
  const measured = useMemo(() => (release ? measuredBall(result, release, pace) : { kmh: null, length: null }), [result, release, pace]);
  const measuredKmh = measured.kmh !== null ? Math.max(70, Math.min(160, Math.round(measured.kmh))) : null;
  const measuredLength = measured.length !== null ? Math.max(0.6, Math.min(13, Math.round(measured.length * 10) / 10)) : null;
  const [kmh, setKmh] = useState(measuredKmh ?? 130);
  const [length, setLength] = useState(measuredLength ?? 7);
  const [off, setOff] = useState(0.1);         // the line at the stumps: metres to the off side of middle stump
  const [swing, setSwing] = useState(0);       // side-force coefficient: positive is away from the batter
  const [batter, setBatter] = useState<"right" | "left">("right");
  const [view, setView] = useState<View>("eye");
  const [rate, setRate] = useState(1);
  const [phase, setPhase] = useState<"run" | "flight" | "done">("run");
  const [tap, setTap] = useState<number | null>(null);   // when the viewer played the shot, seconds after release
  const [failed, setFailed] = useState(false);
  const [bones, setBones] = useState<BoneData | null | undefined>(undefined);
  useEffect(() => { let live = true; loadBones(`${import.meta.env.BASE_URL}skeleton/bones.bin`).then((b) => live && setBones(b), () => live && setBones(null)); return () => { live = false; }; }, []);

  // a right-hander's off side is -x in the scene (the side a right-arm bowler over the wicket runs in on)
  const offSign = batter === "right" ? -1 : 1;
  const read: Read | null = useMemo(() => (release ? readDelivery(release.from, kmh / 3.6, { length, line: off * offSign }, swing * offSign) : null),
    [release, kmh, length, off, swing, offSign]);
  // the release angle each length band needs from this hand, at this pace
  const bands = useMemo(() => {
    if (!release) return [];
    const down = (len: number) => { const a = aimAt(release.from, kmh / 3.6, { length: len, line: off * offSign }, swing * offSign); return a ? (-a.elev * 180) / Math.PI : null; };
    return LENGTHS.map((b) => ({ ...b, a: down(Math.max(0.4, b.from)), b: down(b.to) }));
  }, [release, kmh, off, swing, offSign]);

  const portrait = useMemo(() => typeof window !== "undefined" && window.innerWidth < window.innerHeight * 0.8, []);
  const big = useMemo(() => typeof window !== "undefined" && window.innerWidth * (window.devicePixelRatio || 1) >= 1500, []);
  const [W, H] = portrait ? (big ? [1080, 1440] : [720, 960]) : big ? [1920, 1080] : [1280, 720];

  // what the drawing loop reads each frame
  const live = useRef({ read, view, rate, batter, clock: 0, playing: true, restart: "full" as "full" | "short" | null, tap: null as number | null });
  if (live.current.read !== read) { live.current.read = read; live.current.restart = live.current.restart ?? "short"; }
  live.current.view = view; live.current.rate = rate; live.current.batter = batter;

  const lead = Math.min(2.4, (release?.frame ?? 0) / fps);   // seconds of run-in the clip has before release
  const again = () => { live.current.restart = "full"; };
  const play = () => {   // the shot: once a ball, while it is on its way
    const L = live.current;
    if (!L.read) return;
    if (!L.playing) { again(); return; }
    if (L.tap === null && L.clock > -0.4) { L.tap = L.clock; setTap(L.clock); }
  };
  const playRef = useRef(play);
  playRef.current = play;

  // the dialog: Esc closes, Tab stays inside, the page behind doesn't scroll; Space plays the shot
  useEffect(() => {
    const before = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    (canvasRef.current ?? closeRef.current)?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
      const tag = (e.target as HTMLElement).tagName;
      if (e.key === " " && tag !== "BUTTON" && tag !== "INPUT" && tag !== "SELECT") { e.preventDefault(); playRef.current(); return; }
      if (e.key !== "Tab" || !dialogRef.current) return;
      const items = [...dialogRef.current.querySelectorAll<HTMLElement>("canvas[tabindex], button:not([disabled]), input:not([disabled]), a[href]")];
      if (!items.length) return;
      e.preventDefault();
      const at = items.indexOf(document.activeElement as HTMLElement);
      items[at < 0 ? 0 : (at + (e.shiftKey ? -1 : 1) + items.length) % items.length].focus();
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = before; };
  }, [onClose]);

  useEffect(() => {
    if (bones === undefined || !release) return;
    const canvas = canvasRef.current!;
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true }); }
    catch { setFailed(true); return; }
    renderer.setPixelRatio(1);
    renderer.setSize(W, H, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.NeutralToneMapping;
    const scene = new THREE.Scene();
    const sky = skyTexture();
    scene.background = sky;
    scene.fog = new THREE.Fog(0x0b1424, 40, 130);
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = envTex;
    scene.environmentIntensity = 0.3;
    const camera = new THREE.PerspectiveCamera(40, W / H, 0.03, 300);
    scene.add(new THREE.HemisphereLight(0xf2f5ff, 0x2a4a30, 1.2));
    const sun = new THREE.DirectionalLight(0xfff6e6, 2.4);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.radius = 5;
    Object.assign(sun.shadow.camera, { left: -3, right: 3, top: 3, bottom: -3, near: 1, far: 30 });
    sun.shadow.bias = -0.0015;
    scene.add(sun, sun.target);
    buildPitch(scene, null);
    // the sightscreen behind the bowler's arm: dark, for a white ball
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(9, 4.6), new THREE.MeshBasicMaterial({ color: 0x0c1220 }));
    screen.position.set(0, 2.3, 34); screen.rotation.y = Math.PI;
    scene.add(screen);

    const body: Body = bones ? new BoneBody(bones) : new SimpleBody();
    scene.add(body.group);
    const frames = motion.joints, T = frames.length, br = release.frame;
    const hingeTracks = [0, 1, 2, 3].map((l) => motion.hinges.map((h) => h[l]));
    const P: V3[] = frames[0].map(() => [0, 0, 0]);
    const S = sides(right);
    const hand = (Q: V3[]): V3 => {
      const e = Q[S.elbow], w = Q[S.wrist], d = Math.hypot(w[0] - e[0], w[1] - e[1], w[2] - e[2]) || 1;
      return [w[0] + ((w[0] - e[0]) / d) * 0.13, w[1] + ((w[1] - e[1]) / d) * 0.13, w[2] + ((w[2] - e[2]) / d) * 0.13];
    };

    // the ball, true to size, with a soft glow so it can be picked up on a small screen
    const ball = new THREE.Mesh(new THREE.SphereGeometry(BALL_R, 20, 16), new THREE.MeshStandardMaterial({ color: 0xe5202f, roughness: 0.4, emissive: 0xff2a3a, emissiveIntensity: 0.55 }));
    ball.castShadow = true;
    const glowTex = (() => {
      const c = document.createElement("canvas"); c.width = c.height = 64;
      const g = c.getContext("2d")!, gr = g.createRadialGradient(32, 32, 2, 32, 32, 31);
      gr.addColorStop(0, "rgba(255,120,110,0.95)"); gr.addColorStop(0.35, "rgba(255,70,70,0.3)"); gr.addColorStop(1, "rgba(255,60,60,0)");
      g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
      return new THREE.CanvasTexture(c);
    })();
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, transparent: true, depthWrite: false, opacity: 0.55, toneMapped: false }));
    glow.scale.setScalar(0.24);
    ball.add(glow);
    scene.add(ball);
    // its shadow on the pitch: how far up the pitch the ball is can be read from it
    const shadeTex = (() => {
      const c = document.createElement("canvas"); c.width = c.height = 64;
      const g = c.getContext("2d")!, gr = g.createRadialGradient(32, 32, 2, 32, 32, 31);
      gr.addColorStop(0, "rgba(0,0,0,0.8)"); gr.addColorStop(0.6, "rgba(0,0,0,0.35)"); gr.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
      return new THREE.CanvasTexture(c);
    })();
    const shade = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.2), new THREE.MeshBasicMaterial({ map: shadeTex, transparent: true, depthWrite: false }));
    shade.rotation.x = -Math.PI / 2; shade.renderOrder = 2;
    scene.add(shade);

    // the length bands across the pitch
    const bandMeshes = LENGTHS.map((b, i) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(3.05, b.to - b.from), new THREE.MeshBasicMaterial({ color: BAND_COLORS[i], transparent: true, opacity: 0.2, depthWrite: false, toneMapped: false }));
      m.rotation.x = -Math.PI / 2; m.position.set(0, 0.011, STUMPS_Z + (b.from + b.to) / 2); m.renderOrder = 2;
      scene.add(m);
      return m;
    });
    // where it pitched, where it passed the stumps, and the batter's last look
    const basic = (color: number, opacity = 1) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false, toneMapped: false });
    const pitchMark = new THREE.Mesh(new THREE.RingGeometry(0.07, 0.13, 40), basic(0xffffff, 0.95));
    pitchMark.rotation.x = -Math.PI / 2; pitchMark.renderOrder = 4;
    const stumpMark = new THREE.Mesh(new THREE.RingGeometry(0.045, 0.075, 32), basic(0xffffff, 0.95));
    stumpMark.renderOrder = 4;
    const look = new THREE.Mesh(new THREE.SphereGeometry(0.06, 16, 12), basic(0xfbbf24, 0.95));
    look.renderOrder = 4;
    scene.add(pitchMark, stumpMark, look);
    const trailMat = [basic(0x7dd3fc, 0.9), basic(0xfbbf24, 0.9)];
    let trails: THREE.Mesh[] = [], trailN = [0, 0], shownRead: Read | null = null;
    const buildTrail = (r: Read) => {
      for (const t of trails) { scene.remove(t); t.geometry.dispose(); }
      const s = r.path.samples, tp = r.path.pitch?.t ?? Infinity;
      const pre: V3[] = [], post: V3[] = [];
      for (let i = 0; i < s.length; i += 6) (s[i].t <= tp ? pre : post).push(s[i].p);
      if (r.path.pitch) { const q: V3 = [r.path.pitch.p[0], BALL_R, r.path.pitch.p[2]]; pre.push(q); post.unshift(q); }
      post.push(s[s.length - 1].p);
      trails = [pre, post].map((pts, i) => {
        const n = Math.max(1, pts.length - 1);
        trailN[i] = n;
        const m = new THREE.Mesh(pts.length > 1 ? new THREE.TubeGeometry(new Poly(pts), n, 0.018, RADIAL, false) : new THREE.BufferGeometry(), trailMat[i]);
        m.frustumCulled = false; m.renderOrder = 3;
        scene.add(m);
        return m;
      });
      const pp = r.path.pitch;
      pitchMark.visible = !!pp;
      if (pp) pitchMark.position.set(pp.p[0], 0.014, pp.p[2]);
      const st = r.path.stumps;
      stumpMark.visible = !!st;
      if (st) { stumpMark.position.set(st.p[0], st.p[1], STUMPS_Z + 0.03); (stumpMark.material as THREE.MeshBasicMaterial).color.set(r.atStumps?.hitting ? 0xff5a5a : 0xffffff); }
      const q = ballAt(r.path, r.seconds - REACTION_S);
      look.position.set(q[0], q[1], q[2]);
      shownRead = r;
    };

    const L = live.current;
    const gaze = new THREE.Vector3(release.from[0], release.from[1], release.from[2]);
    const want = new THREE.Vector3(), bp: V3 = [0, 0, 0];
    let raf = 0, last = performance.now(), lastPhase = "", lastClock = "";
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const wall = Math.min(0.05, (now - last) / 1000);
      last = now;
      const r = L.read;
      if (!r) return;
      if (r !== shownRead) buildTrail(r);
      const end = (r.path.stumps?.t ?? r.seconds) + 0.9;
      if (L.restart) {
        L.clock = L.restart === "full" ? -lead : Math.max(-lead, -0.6);
        L.restart = null; L.playing = true; L.tap = null; setTap(null);
        // the eyes start on the ball in the hand
        const h0 = hand(sampleJoints(frames, br + L.clock * fps, P));
        gaze.set(h0[0], h0[1], h0[2]);
      }
      const dt = L.playing ? wall * L.rate : 0;
      if (L.playing) { L.clock += dt; if (L.clock >= end) { L.clock = end; L.playing = false; } }
      const clock = L.clock, done = !L.playing;
      // the bowler, in real time either side of release
      sampleJoints(frames, Math.max(0, Math.min(T - 1, br + clock * fps)), P);
      body.update(P, hingeTracks.map((tr) => sampleTrack(tr, Math.max(0, Math.min(T - 1, br + clock * fps)))));
      const pel = P[0];
      sun.position.set(pel[0] + 3.5, 9, pel[2] + 4.5); sun.target.position.set(pel[0], 0, pel[2]); sun.target.updateMatrixWorld();
      // the ball: in the hand, then on its way
      if (clock <= 0) { const h = hand(P); bp[0] = h[0]; bp[1] = h[1]; bp[2] = h[2]; } else ballAt(r.path, clock, bp);
      ball.position.set(bp[0], bp[1], bp[2]);
      shade.visible = clock > 0;
      shade.position.set(bp[0], 0.013, bp[2]);
      (shade.material as THREE.MeshBasicMaterial).opacity = 0.75 * Math.max(0.25, 1 - bp[1] / 2.5);
      // the drawn flight: it follows the ball from above and from the side; from the batter's eye it comes up afterwards
      const view = L.view, drawn = view !== "eye" || done;
      const tp = r.path.pitch?.t ?? Infinity, tEnd = r.path.stumps?.t ?? r.seconds;
      const upTo = done ? Infinity : clock;
      const part = [Math.max(0, Math.min(1, upTo / Math.min(tp, tEnd))), tp === Infinity ? 0 : Math.max(0, Math.min(1, (upTo - tp) / Math.max(1e-6, tEnd - tp)))];
      trails.forEach((t, i) => { t.visible = drawn && part[i] > 0 && trailN[i] > 0 && !!t.geometry.index; if (t.visible) t.geometry.setDrawRange(0, Math.floor(part[i] * trailN[i]) * RADIAL * 6); });
      for (const m of bandMeshes) m.visible = drawn;
      pitchMark.visible = drawn && !!r.path.pitch && (done || clock >= tp);
      stumpMark.visible = drawn && !!r.path.stumps && (done || clock >= tEnd);
      look.visible = drawn && r.commit !== null && (done || clock >= r.seconds - REACTION_S);
      glow.visible = view === "eye";

      const aspect = W / H;
      if (view === "eye") {
        // the batter's eyes: on the ball, in the hand and then all the way down (they lag a little, as eyes do)
        const ex = EYE_X * (L.batter === "right" ? 1 : -1);
        camera.position.set(ex, EYE_H, CREASE_Z);
        if (done) { const pp = r.path.pitch?.p; want.set(pp ? pp[0] : 0, 0.3, pp ? Math.min(pp[2], CREASE_Z + 3) : CREASE_Z + 4); }
        else if (bp[2] > CREASE_Z + 1.2) want.set(bp[0], bp[1], bp[2]);
        gaze.lerp(want, 1 - Math.exp(-(done ? wall / 0.5 : dt / 0.045)));
        // a long look at the bowler's hand, opening out as the ball comes (the timing stays real)
        const near = done ? 1 : Math.max(0, Math.min(1, (17 - (bp[2] - CREASE_Z)) / 11)), ease = near * near * (3 - 2 * near);
        camera.fov = (portrait ? 34 : 24) + ((portrait ? 56 : 44) - (portrait ? 34 : 24)) * ease;
        camera.lookAt(gaze);
      } else if (view === "tracker") {
        camera.position.set(0, 9, 21);
        camera.fov = portrait ? 34 : 19;
        camera.lookAt(0, 0.4, -9.5);
      } else {
        // from square of the wicket, on the bowling arm's side: the whole pitch
        const dist = 15, half = Math.atan(12.2 / dist);
        camera.position.set((right ? 1 : -1) * dist, 1.9, -9.6);
        camera.fov = Math.min(100, (2 * Math.atan(Math.tan(half) / aspect) * 180) / Math.PI);
        camera.lookAt(0, 1.2, -9.6);
      }
      camera.updateProjectionMatrix();
      renderer.render(scene, camera);

      const ph = done ? "done" : clock < 0 ? "run" : "flight";
      if (ph !== lastPhase) { lastPhase = ph; setPhase(ph); }
      const text = clock < 0 ? "0" : String(Math.round(Math.min(clock, r.seconds) * 1000));
      if (text !== lastClock && clockEl.current) { lastClock = text; clockEl.current.textContent = text; }
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      body.dispose();
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        const mat = m.material as (THREE.Material & { map?: THREE.Texture | null }) | THREE.Material[] | undefined;
        for (const x of Array.isArray(mat) ? mat : mat ? [mat] : []) { (x as { map?: THREE.Texture | null }).map?.dispose(); x.dispose(); }
      });
      for (const m of trailMat) m.dispose();
      sky.dispose(); glowTex.dispose(); shadeTex.dispose(); envTex.dispose(); pmrem.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      L.restart = "full";
    };
  }, [result, motion, release, bones, W, H, portrait, right, fps, lead]);

  // the shot the viewer played, against when the ball arrived
  const shot = (() => {
    if (tap === null || !read || phase === "run") return null;
    const d = tap - read.seconds;
    const far = Math.abs(ballAt(read.path, Math.max(0, tap))[2] - CREASE_Z);
    if (Math.abs(d) <= 0.015) return { text: `On time: within ${Math.max(1, Math.round(Math.abs(d) * 1000))} ms of the ball`, good: true };
    return { text: d < 0 ? `${Math.round(-d * 1000)} ms early: the ball was still ${far.toFixed(1)} m away` : `${Math.round(d * 1000)} ms late: the ball was ${far < 1.22 ? cm(far) : `${far.toFixed(1)} m`} past you`, good: false };
  })();

  const st = read?.atStumps ?? null;
  const stumpsText = !st ? "" : st.hitting ? `hitting the stumps, ${cm(st.height)} up`
    : st.height > STUMP_H + BALL_R && Math.abs(st.x) <= STUMPS_W / 2 + BALL_R ? `over the stumps by ${cm(st.height - STUMP_H)}`
    : `missing ${st.x * offSign > 0 ? "off" : "leg"} stump by ${cm(Math.abs(st.x) - STUMPS_W / 2)}${st.height > STUMP_H + BALL_R ? ", and over them" : ""}`;
  const swungCm = read ? Math.round(Math.abs(read.path.swung) * 100) : 0;
  const stature = result.skeleton.stature_m, ownHeight = result.skeleton.height_source === "user";
  const summary = read ? `${kmh} km/h, ${lengthName(length).toLowerCase()}, ${lineWord(off)}. Reaches the batter in ${Math.round(read.seconds * 1000)} milliseconds at ${Math.round(read.arriveKmh)} km/h, ${heightWord(read.height)}; ${stumpsText}.` : "";

  return (
    <div className="bio-overlay" role="dialog" aria-modal="true" aria-labelledby="face-title" ref={dialogRef}>
      <div className={`bio-sheet face-sheet ${portrait ? "portrait" : ""}`}>
        <div className="bio-head">
          <h2 id="face-title">Face it: the batter's eye</h2>
          <button ref={closeRef} type="button" className="btn icon sm ghost" onClick={onClose} aria-label="Close (Esc)"><IX size={16} /></button>
        </div>
        {failed || !release ? (
          <div className="notice warn" role="alert">{failed ? "This browser couldn't start 3D graphics, so this view can't be shown here." : "This analysis has no release to bowl from."}</div>
        ) : (
          <>
            <div className="face-stage">
              <canvas ref={canvasRef} width={W} height={H} className="bio-canvas face-canvas" role="img" tabIndex={0} onPointerDown={() => play()}
                aria-label={`The delivery from the batter's end, in 3D: ${name}'s action rebuilt from the clip, and the ball's flight to the batter`} />
              <div className="face-hud" aria-hidden="true">
                <div className="face-tag">{view === "eye" ? "BATTER'S EYE" : view === "tracker" ? "BALL TRACKER" : "SIDE ON"} · {rate === 1 ? "REAL TIME" : rate === 0.5 ? "HALF SPEED" : "QUARTER SPEED"}</div>
                <div className="face-pace"><b>{kmh}</b><span>km/h{measuredKmh !== null && kmh === measuredKmh ? " · measured" : ""}</span></div>
                <div className="face-clock"><b><span ref={clockEl}>0</span></b><span>ms since release</span></div>
                {phase === "done" && read && (
                  <div className="face-result">
                    <b>{Math.round(read.seconds * 1000)} ms</b> hand to bat · {lengthName(length)} · {heightWord(read.height)} · {stumpsText}
                    {shot && <span className={shot.good ? "good" : "miss"}>Your shot: {shot.text}</span>}
                  </div>
                )}
                {phase !== "done" && view === "eye" && tap === null && <div className="face-hint">Tap the picture (or press Space) when you would hit it</div>}
              </div>
            </div>
            <p className="sr-only" role="status">{phase === "done" ? summary + (shot ? ` Your shot: ${shot.text}.` : "") : ""}</p>
            <div className="bio-tools">
              <button type="button" className="btn sm" onClick={again}><IRefresh size={14} /> Bowl it again</button>
              <div className="seg" role="group" aria-label="Camera">
                {([["eye", "Batter's eye"], ["tracker", "Tracker"], ["side", "Side on"]] as const).map(([v, label]) => (
                  <button key={v} type="button" className={view === v ? "on" : ""} aria-pressed={view === v} onClick={() => setView(v)}>{label}</button>
                ))}
              </div>
              <div className="seg" role="group" aria-label="Speed of the replay">
                {([[1, "Real time"], [0.5, "½"], [0.25, "¼"]] as const).map(([v, label]) => (
                  <button key={v} type="button" className={rate === v ? "on" : ""} aria-pressed={rate === v} onClick={() => setRate(v)}>{label}</button>
                ))}
              </div>
              <div className="seg" role="group" aria-label="The batter">
                {(["right", "left"] as const).map((v) => (
                  <button key={v} type="button" className={batter === v ? "on" : ""} aria-pressed={batter === v} onClick={() => setBatter(v)}>{v === "right" ? "Right-hander" : "Left-hander"}</button>
                ))}
              </div>
            </div>
            <div className="face-grid">
              <div className="face-controls">
                <label><span>Pace <b>{kmh} km/h</b>{measuredKmh !== null ? <em> measured on this clip: {measuredKmh}{pace ? ` (${Math.round(pace.lo)}–${Math.round(pace.hi)})` : ""}</em> : <em> not measured on this clip: set it here</em>}</span>
                  <input type="range" min={70} max={160} step={1} value={kmh} onChange={(e) => setKmh(Number(e.target.value))} aria-valuetext={`${kmh} kilometres an hour`} /></label>
                <label><span>Length <b>{length.toFixed(1)} m from the stumps</b> <em>{lengthName(length)}{measuredLength !== null && Math.abs(length - measuredLength) < 0.06 ? ", from the frame you marked" : ""}</em></span>
                  <input type="range" min={0.6} max={13} step={0.1} value={length} onChange={(e) => setLength(Number(e.target.value))} aria-valuetext={`${length.toFixed(1)} metres, ${lengthName(length)}`} /></label>
                <label><span>Line <b>{lineWord(off)}</b> <em>{Math.abs(off) < 0.005 ? "" : `${cm(off)} to the ${off > 0 ? "off" : "leg"} side`}</em></span>
                  <input type="range" min={-0.45} max={0.75} step={0.01} value={off} onChange={(e) => setOff(Number(e.target.value))} aria-valuetext={lineWord(off)} /></label>
                <label><span>Swing <b>{swungCm < 1 ? "none" : `${swungCm} cm ${swing > 0 ? "away from" : "in to"} the batter`}</b></span>
                  <input type="range" min={-MAX_SWING} max={MAX_SWING} step={0.01} value={swing} onChange={(e) => setSwing(Math.abs(Number(e.target.value)) < 0.015 ? 0 : Number(e.target.value))}
                    aria-valuetext={swungCm < 1 ? "no swing" : `${swungCm} centimetres ${swing > 0 ? "away" : "in"}`} /></label>
              </div>
              {read ? (
                <dl className="face-read">
                  <div><dt>Release point</dt><dd><b>{release.from[1].toFixed(2)} m</b> high, {cm(release.from[0])} wide of middle stump</dd></div>
                  <div><dt>Leaves the hand</dt><dd><b>{Math.abs(read.down).toFixed(1)}°</b> {read.down >= 0 ? "below" : "above"} the horizontal</dd></div>
                  <div><dt>The batter gets</dt><dd><b>{Math.round(read.seconds * 1000)} ms</b>; the ball arrives at {Math.round(read.arriveKmh)} km/h</dd></div>
                  {read.commit !== null && <div><dt>Last look</dt><dd><b>{read.commit.toFixed(1)} m</b> away when a shot can no longer be changed (0.2 s out)</dd></div>}
                  {read.path.pitch && <div><dt>Pitches</dt><dd>coming down at <b>{read.path.pitch.angle.toFixed(1)}°</b>, {Math.round(read.path.pitch.speedIn * 3.6)} → {Math.round(read.path.pitch.speedOut * 3.6)} km/h off the pitch</dd></div>}
                  <div><dt>At the batter</dt><dd><b>{heightWord(read.height)}</b> ({cm(read.height)}); {stumpsText}</dd></div>
                  <div><dt>Margin</dt><dd><b>1°</b> of release angle moves the length <b>{read.perDegree.toFixed(1)} m</b>{read.window !== null ? <>; a good length is a {read.window.toFixed(1)}° window</> : null}</dd></div>
                  <div><dt>Height pays</dt><dd>letting go 10 cm higher {Math.abs(read.perTen) < 0.005 ? "changes nothing at this length" : <>brings this ball through <b>{cm(read.perTen)} {read.perTen > 0 ? "higher" : "lower"}</b></>}</dd></div>
                </dl>
              ) : <div className="notice warn" role="alert">At {kmh} km/h the ball can't be pitched there from this release point.</div>}
            </div>
            <div className="face-bands" role="table" aria-label="The release angle each length needs from this release point, at this pace">
              {bands.map((b, i) => (
                <div key={b.name} role="row" className={lengthName(length) === b.name ? "on" : ""}>
                  <span role="cell" className="sw" style={{ background: BAND_CSS[i] }} />
                  <span role="cell" className="nm">{b.name}</span>
                  <span role="cell" className="rg">{b.from}–{b.to} m</span>
                  <span role="cell" className="an">{b.a !== null && b.b !== null ? `${angle(b.a)} to ${angle(b.b)}` : "out of reach"}</span>
                </div>
              ))}
            </div>
            <p className="faint bio-note">
              From the clip: the bowler's action, and where the hand is at release ({release.heightMeasured ? "its height is measured on the video" : "its height is the 3D estimate's"}{ownHeight ? "" : `, for a bowler taken as ${stature.toFixed(2)} m tall`}){measuredKmh !== null ? "; the pace, from the frames you marked" : ""}.
              How wide of the stumps the bowler stands is not measured. The flight is physics, not footage: gravity, air drag on a new ball, swing as a steady side force until it pitches, and a firm pitch
              that keeps 55% of the ball's vertical speed and 87% of its speed along the ground; seam movement and spin are left out. The line, the length and the swing are yours to set.
              The batter's-eye picture starts on a long lens and opens out as the ball comes; the ball is true to size, drawn with a glow; the amber dot marks where it is 0.2 s before it arrives.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
