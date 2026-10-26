import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { api } from "../api";
import type { AnalysisResult, EventKey } from "../types";
import { loadMesh, skinFrame, type MeshData } from "../lib/mesh";
import { EVENTS, EVENT_HEX, SERIES_INFO, measuredForView } from "../lib/constants";
import { IPause, IPlay } from "./Icons";
import { fmt, unitLabel } from "../lib/format";

type Preset = "side_r" | "side_l" | "behind" | "front" | "top";
const TAG_NAME: Record<string, string> = { front_knee_2d: "Knee", elbow_flexion_2d: "Elbow bend", trunk_angle_2d: "Trunk",
  bowling_arm_elevation: "Arm", hip_shoulder_separation: "Hips–shoulders", bowling_wrist_height_pct: "Wrist" };
const PRESETS: { key: Preset; label: string; title: string }[] = [
  { key: "side_r", label: "Side R", title: "Side-on, from the right" },
  { key: "side_l", label: "Side L", title: "Side-on, from the left" },
  { key: "behind", label: "Behind", title: "From behind the bowler" },
  { key: "front", label: "Batter", title: "The batter's view" },
  { key: "top", label: "Top", title: "From above" },
];

export default function Viewer3D({ id, result, frame, playing, onTogglePlay, onSeek }: {
  id: string; result: AnalysisResult; frame: number;
  playing?: boolean; onTogglePlay?: () => void; onSeek?: (f: number) => void;   // playback, offered in the enlarged view
}) {
  const host = useRef<HTMLDivElement>(null);
  const st = useRef<{
    renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera; controls: OrbitControls;
    mesh?: THREE.Mesh; geom?: THREE.BufferGeometry; data?: MeshData; skel: THREE.LineSegments; joints: THREE.InstancedMesh;
    ghosts: THREE.Group; follow: THREE.Vector3; raf: number; invalidate: () => void;
    tags: { el: HTMLDivElement; at: THREE.Vector3; key: string; joint: number }[];
  } | null>(null);
  const tagHost = useRef<HTMLDivElement>(null);
  const [showTags, setShowTags] = useState(true);
  const [big, setBig] = useState(false);   // the 3D view enlarged over the page
  const bigRef = useRef(false);
  bigRef.current = big;
  const cardRef = useRef<HTMLDivElement>(null);
  const expandRef = useRef<HTMLButtonElement>(null);
  const wasBig = useRef(false);
  useEffect(() => {
    if (!big) {
      // back to the page: focus returns to the Expand button
      if (wasBig.current) { wasBig.current = false; expandRef.current?.focus({ preventScroll: true }); }
      return;
    }
    wasBig.current = true;
    // the page behind doesn't scroll while the enlarged view is open
    const before = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); setBig(false); setActive(false); return; }
      // a dialog: Tab cycles through its own controls
      if (e.key !== "Tab" || !cardRef.current) return;
      const items = [...cardRef.current.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled])")];
      if (!items.length) return;
      e.preventDefault();
      const at = items.indexOf(document.activeElement as HTMLElement);
      items[at < 0 ? 0 : (at + (e.shiftKey ? -1 : 1) + items.length) % items.length].focus();
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = before; };
  }, [big]);
  const [mode, setMode] = useState<"mesh" | "both" | "skeleton">("both");
  const [preset, setPreset] = useState<Preset>(result.view.view === "side_on" ? "side_r" : "behind");
  const [presetN, setPresetN] = useState(0);   // a click on the current preset re-applies it
  const [orbited, setOrbited] = useState(false);   // moved by hand since the last preset: no preset is highlighted
  const [ghost, setGhost] = useState(false);
  const [follow, setFollow] = useState(true);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  // the canvas only takes the mouse wheel and touch gestures once the user asks for it, so it never traps page scrolling
  const [active, setActive] = useState(false);
  const f0 = result.frames.start;
  const parents = result.skeleton3d.parents;
  const right = result.bowling_arm.arm === "right";
  const [bowlingIdx, frontIdx] = useMemo(() => (right ? [[14, 15, 16], [11, 12, 13]] : [[11, 12, 13], [14, 15, 16]]), [right]);

  // which angles get a live tag, and the 3D joint each one sits at (H36M order: 2/5 knees, 12/15 elbows, 8 thorax,
  // 11/14 shoulders, 13/16 wrists, 0 pelvis)
  const tagSpecs = useMemo(() => {
    const fKnee = right ? 5 : 2, bElbow = bowlingIdx[1], bShoulder = bowlingIdx[0], bWrist = bowlingIdx[2];
    // below ~90 distinct frames a second the elbow isn't measurable (as on the video overlay): no number for it
    const elbowOk = result.fps_real * (1 - (result.quality.repeated_frames ?? 0)) >= 90;
    return result.view.view === "side_on"
      ? [{ key: "front_knee_2d", joint: fKnee, cls: "front" }, ...(elbowOk ? [{ key: "elbow_flexion_2d", joint: bElbow, cls: "bowl" }] : []),
        { key: "trunk_angle_2d", joint: 8, cls: "" }, { key: "bowling_arm_elevation", joint: bShoulder, cls: "bowl" }]
      : [{ key: "trunk_angle_2d", joint: 8, cls: "" }, { key: "bowling_arm_elevation", joint: bShoulder, cls: "bowl" },
        { key: "hip_shoulder_separation", joint: 0, cls: "" }, { key: "bowling_wrist_height_pct", joint: bWrist, cls: "bowl" }];
  }, [result.view.view, result.fps_real, result.quality.repeated_frames, right, bowlingIdx]);

  // ---------- init scene once ----------
  useEffect(() => {
    const el = host.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(32, 1, 0.05, 200);
    camera.position.set(4.5, 1.6, 0);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.09;
    controls.minDistance = 1.2;
    controls.maxDistance = 25;
    controls.maxPolarAngle = Math.PI * 0.495;
    controls.enabled = false;
    renderer.domElement.style.touchAction = "pan-y";

    scene.add(new THREE.HemisphereLight(0xdbeafe, 0x1e293b, 1.15));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(3, 6, 4);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x93c5fd, 0.8);
    rim.position.set(-4, 3, -5);
    scene.add(rim);

    // ground + pitch strip (22 yards = 20.12 m along -z) with creases
    const ground = new THREE.Mesh(new THREE.CircleGeometry(30, 64), new THREE.MeshStandardMaterial({ color: 0x0f2a1d, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);
    const pitch = new THREE.Mesh(new THREE.PlaneGeometry(3.05, 24), new THREE.MeshStandardMaterial({ color: 0x8a7a55, roughness: 1 }));
    pitch.rotation.x = -Math.PI / 2;
    pitch.position.set(0, 0.002, -8);
    scene.add(pitch);
    const lineMat = new THREE.MeshBasicMaterial({ color: 0xf8fafc });
    for (const z of [0, -1.22, -20.12, -18.9]) {
      const l = new THREE.Mesh(new THREE.PlaneGeometry(3.66, 0.05), lineMat);
      l.rotation.x = -Math.PI / 2;
      l.position.set(0, 0.004, z);
      scene.add(l);
    }
    const grid = new THREE.GridHelper(30, 30, 0x1e3a2b, 0x15291f);
    grid.position.y = 0.001;
    scene.add(grid);

    const skel = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true }));
    skel.renderOrder = 10;
    scene.add(skel);
    const joints = new THREE.InstancedMesh(new THREE.SphereGeometry(0.028, 12, 10), new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false }), 17);
    joints.renderOrder = 11;
    scene.add(joints);
    const ghosts = new THREE.Group();
    scene.add(ghosts);

    // draw only when something changed (a frame, the camera, a setting), not 60 times a second: a phone's battery
    // and the page's scrolling are worth more than an idle animation loop
    const s = { renderer, scene, camera, controls, skel, joints, ghosts, follow: new THREE.Vector3(), raf: 0, invalidate: () => undefined as void,
      tags: [] as { el: HTMLDivElement; at: THREE.Vector3; key: string; joint: number }[] };
    const v = new THREE.Vector3();
    const draw = () => {
      s.raf = 0;
      const moving = controls.update();   // true while the orbit is still easing to a stop
      renderer.render(scene, camera);
      // live angle tags: each follows its joint on screen as the body moves and the camera orbits
      const w = el.clientWidth, h = el.clientHeight;
      const placed: [number, number, number][] = [];   // x, y, width of the tags already placed (they must not overlap)
      for (const tag of s.tags) {
        v.copy(tag.at).project(camera);
        const off = v.z > 1 || Math.abs(v.x) > 1.05 || Math.abs(v.y) > 1.05;
        tag.el.style.display = off ? "none" : "";
        if (off) continue;
        const x = ((v.x + 1) / 2) * w + 10, tw = tag.el.offsetWidth || 80;
        let y = ((1 - v.y) / 2) * h - 10;
        for (let k = 0; k < 6 && placed.some(([px, py, pw]) => x < px + pw && px < x + tw && Math.abs(py - y) < 22); k++) y += 22;
        placed.push([x, y, tw]);
        tag.el.style.transform = `translate(${x}px, ${y}px)`;
      }
      if (moving) s.raf = requestAnimationFrame(draw);
    };
    s.invalidate = () => { if (!s.raf) s.raf = requestAnimationFrame(draw); };
    controls.addEventListener("change", s.invalidate);
    controls.addEventListener("start", s.invalidate);
    controls.addEventListener("start", () => setOrbited(true));   // fired by the user's drag/zoom only
    st.current = s;
    const resize = () => {
      const w = el.clientWidth, h = el.clientHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
      s.invalidate();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();
    return () => {
      cancelAnimationFrame(s.raf);
      ro.disconnect();
      controls.dispose();
      disposeTree(scene);
      renderer.dispose();
      renderer.forceContextLoss();   // release the WebGL context now, not at GC time
      el.removeChild(renderer.domElement);
      st.current = null;
    };
  }, []);

  useEffect(() => {
    const s = st.current, hostEl = tagHost.current;
    if (!s || !hostEl) return;
    hostEl.replaceChildren();
    s.tags = tagSpecs.filter((spec) => result.series[spec.key]).map((spec) => {
      const el = document.createElement("div");
      el.className = `viewer-tag ${spec.cls}`;
      hostEl.appendChild(el);
      return { el, at: new THREE.Vector3(), key: spec.key, joint: spec.joint };
    });
    s.invalidate();
  }, [tagSpecs, result.series]);

  // ---------- load body mesh ----------
  useEffect(() => {
    const s = st.current;
    if (!s) return;
    let cancelled = false;
    setStatus("loading");
    loadMesh(api.meshUrl(id, "mesh_rest.bin"), api.meshUrl(id, "pose.bin"), result.mesh)
      .then((data) => {
        if (cancelled || !st.current) return;
        if (s.mesh) { s.scene.remove(s.mesh); s.geom?.dispose(); (s.mesh.material as THREE.Material).dispose(); }
        const geom = new THREE.BufferGeometry();
        geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(data.V * 3), 3));
        geom.setIndex(new THREE.BufferAttribute(data.index, 1));
        // tint by role (dominant bone influence): bowling arm coral, front leg green, rest steel blue
        const arm = new Set(result.mesh.bone_groups?.bowling_arm ?? []);
        const leg = new Set(result.mesh.bone_groups?.front_leg ?? []);
        const col = new Float32Array(data.V * 3);
        const base = new THREE.Color(0x9fb4d6), cArm = new THREE.Color(0xf08a9a), cLeg = new THREE.Color(0x6fd3a8);
        for (let v = 0; v < data.V; v++) {
          let best = 0, bw = -1;
          for (let k = 0; k < 4; k++) if (data.skinWeight[v * 4 + k] > bw) { bw = data.skinWeight[v * 4 + k]; best = data.skinIndex[v * 4 + k]; }
          const c = arm.has(best) ? cArm : leg.has(best) ? cLeg : base;
          col[v * 3] = c.r; col[v * 3 + 1] = c.g; col[v * 3 + 2] = c.b;
        }
        geom.setAttribute("color", new THREE.BufferAttribute(col, 3));
        const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.05, transparent: true, opacity: 0.96 });
        const mesh = new THREE.Mesh(geom, mat);
        s.scene.add(mesh);
        Object.assign(s, { mesh, geom, data });
        setStatus("ready");
        s.invalidate();
      })
      .catch(() => !cancelled && setStatus("error"));
    return () => { cancelled = true; };
    // reload when the analysis is recomputed (height/arm edits rebuild the mesh)
  }, [id, result.mesh, result.skeleton.stature_m]);

  // ---------- per-frame update ----------
  useEffect(() => {
    const s = st.current;
    if (!s) return;
    const t = Math.max(0, Math.min(result.skeleton3d.joints.length - 1, frame - f0));
    const J = result.skeleton3d.joints[t];
    if (s.mesh && s.data && s.geom) {
      const pos = s.geom.attributes.position as THREE.BufferAttribute;
      skinFrame(s.data, t, pos.array as Float32Array);
      pos.needsUpdate = true;
      s.geom.computeVertexNormals();
      s.geom.computeBoundingSphere();
      s.mesh.visible = mode !== "skeleton";
      (s.mesh.material as THREE.MeshStandardMaterial).opacity = mode === "both" ? 0.55 : 0.97;
      (s.mesh.material as THREE.MeshStandardMaterial).depthWrite = mode !== "both";
    }
    // skeleton lines (buffers allocated once, updated in place)
    const pts: number[] = [], cols: number[] = [];
    const cB = new THREE.Color(0xfb7185), cF = new THREE.Color(0x34d399), cT = new THREE.Color(0xe2e8f0);
    parents.forEach((p, j) => {
      if (p < 0) return;
      pts.push(...J[j], ...J[p]);
      const c = bowlingIdx.includes(j) ? cB : frontIdx.includes(j) ? cF : cT;
      cols.push(c.r, c.g, c.b, c.r, c.g, c.b);
    });
    const g = s.skel.geometry;
    for (const [name, data] of [["position", pts], ["color", cols]] as const) {
      const attr = g.getAttribute(name) as THREE.BufferAttribute | undefined;
      if (attr && attr.array.length === data.length) { (attr.array as Float32Array).set(data); attr.needsUpdate = true; }
      else g.setAttribute(name, new THREE.Float32BufferAttribute(data, 3));
    }
    g.computeBoundingSphere();
    s.skel.visible = mode !== "mesh";
    s.joints.visible = mode !== "mesh";
    const m4 = new THREE.Matrix4();
    J.forEach((p, j) => { m4.makeTranslation(p[0], p[1], p[2]); s.joints.setMatrixAt(j, m4); });
    s.joints.instanceMatrix.needsUpdate = true;
    // live angle tags at the joints they describe: the same per-frame values as "At this frame" (measured on the video
    // where this camera view sees that angle, the 3D model's estimate otherwise, marked ≈)
    for (const tag of s.tags) {
      tag.at.set(J[tag.joint][0], J[tag.joint][1], J[tag.joint][2]);
      const val = result.series[tag.key]?.[t];
      const info = SERIES_INFO[tag.key];
      const ok = measuredForView(tag.key, info.plane, result.view.view);
      tag.el.textContent = val === null || val === undefined || !Number.isFinite(val) ? ""
        : `${TAG_NAME[tag.key] ?? info.label} ${ok ? "" : "≈"}${fmt(val, 0)}${info.unit === "deg" ? "°" : unitLabel(info.unit)}`;
      tag.el.title = `${info.label}${ok ? "" : " (3D estimate: this camera view doesn't see this angle)"}`;
      tag.el.style.visibility = showTags && tag.el.textContent ? "visible" : "hidden";
    }
    // follow the pelvis
    if (follow) {
      const target = new THREE.Vector3(J[0][0], Math.max(0.85, J[0][1]), J[0][2]);
      const delta = target.clone().sub(s.controls.target);
      s.controls.target.add(delta);
      s.camera.position.add(delta);
    }
    s.invalidate();
  }, [frame, mode, follow, result, f0, parents, bowlingIdx, frontIdx, status, showTags, tagSpecs]);

  // ---------- camera presets ----------
  useEffect(() => {
    const s = st.current;
    if (!s) return;
    const t = Math.max(0, Math.min(result.skeleton3d.joints.length - 1, frame - f0));
    const P = result.skeleton3d.joints[t][0];
    const tgt = new THREE.Vector3(P[0], 1.0, P[2]);
    const d = 5.2;
    const off: Record<Preset, [number, number, number]> = {
      side_r: [d, 0.5, 0], side_l: [-d, 0.5, 0], behind: [0, 0.8, d], front: [0, 0.6, -d], top: [0, 4.2, 0.02],   // top: pitch runs up the screen
    };
    s.controls.target.copy(tgt);
    s.camera.position.set(tgt.x + off[preset][0], tgt.y + off[preset][1], tgt.z + off[preset][2]);
    s.controls.update();
    s.invalidate();
    setOrbited(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset, presetN]);

  // ---------- ghost bodies at key events ----------
  useEffect(() => {
    const s = st.current;
    if (!s) return;
    disposeTree(s.ghosts);
    s.ghosts.clear();
    s.invalidate();
    if (!ghost || !s.data) return;
    (["bfc", "ffc", "br"] as EventKey[]).forEach((k) => {
      const e = result.events[k];
      if (!e) return;
      const g = new THREE.BufferGeometry();
      const arr = new Float32Array(s.data!.V * 3);
      skinFrame(s.data!, e.frame - f0, arr);
      g.setAttribute("position", new THREE.BufferAttribute(arr, 3));
      g.setIndex(new THREE.BufferAttribute(s.data!.index, 1));
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: new THREE.Color(EVENT_HEX[k]), transparent: true, opacity: 0.16, depthWrite: false }));
      s.ghosts.add(m);
    });
    s.invalidate();
  }, [ghost, status, result.events, f0]);

  useEffect(() => {
    const s = st.current;
    if (!s) return;
    s.controls.enabled = active;
    s.renderer.domElement.style.touchAction = active ? "none" : "pan-y";
    if (!active) return;
    doneRef.current?.focus({ preventScroll: true });
    // a click outside the 3D picture ends exploring, except inside the enlarged view (its own controls)
    const out = (e: PointerEvent) => {
      const box = bigRef.current ? cardRef.current : host.current;
      if (box && !box.contains(e.target as Node)) setActive(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape" && !bigRef.current) release(); };   // enlarged: Esc closes it
    document.addEventListener("pointerdown", out);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("pointerdown", out); document.removeEventListener("keydown", esc); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
  // hand keyboard focus back to the "explore" button once the viewer is released
  const doneRef = useRef<HTMLButtonElement>(null);
  const activateRef = useRef<HTMLButtonElement>(null);
  const handBack = useRef(false);
  const release = () => { handBack.current = true; setActive(false); };
  useEffect(() => {
    if (!active && handBack.current) { handBack.current = false; activateRef.current?.focus({ preventScroll: true }); }
  }, [active]);

  return (
    <div ref={cardRef} className={`card viewer ${big ? "big" : ""}`} role={big ? "dialog" : undefined} aria-modal={big || undefined} aria-label={big ? "3D view, enlarged" : undefined}>
      <div className="viewer-stage" ref={host}>
        <div className="viewer-tags" ref={tagHost} aria-hidden="true" />
        {!active && status === "ready" && (
          <button type="button" ref={activateRef} className="viewer-activate" onClick={() => setActive(true)} aria-label="Explore the 3D body: rotate and zoom">
            <span className="mouse">Click to rotate and zoom</span><span className="touch">Tap to rotate and zoom</span>
          </button>
        )}
        {active && !big && <button type="button" ref={doneRef} className="btn sm viewer-done" onClick={release} aria-label="Done exploring the 3D body (Esc)">Done</button>}
        {status === "loading" && <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}><div className="spinner" /></div>}
        {status === "error" && <div className="notice warn" style={{ position: "absolute", left: 12, right: 12, top: 12 }}>3D body model unavailable for this analysis.</div>}
        {active && <div className="viewer-legend"><span className="mouse">Drag to orbit · scroll to zoom · right-drag to pan</span><span className="touch">Drag to orbit · pinch to zoom · two-finger drag to pan</span></div>}
        <div className="viewer-angle">
          <span className="chip" style={{ background: "rgba(10,10,11,.72)" }}><span className="dot" style={{ background: "#fb7185" }} /> Bowling arm</span>
          <span className="chip" style={{ background: "rgba(10,10,11,.72)" }}><span className="dot" style={{ background: "#34d399" }} /> Front side</span>
        </div>
      </div>
      {big && onSeek && (
        <div className="viewer-play">
          {onTogglePlay && <button type="button" className="btn icon sm" onClick={onTogglePlay} aria-label={playing ? "Pause" : "Play"}>{playing ? <IPause size={14} /> : <IPlay size={14} />}</button>}
          <input type="range" min={f0} max={result.frames.end - 1} value={frame} aria-label="Frame"
            onChange={(e) => onSeek(Number(e.target.value))} />
          <span className="mono faint" style={{ minWidth: 92, textAlign: "right" }}>
            {EVENTS.find((e) => result.events[e.key]?.frame === frame)?.label ?? `frame ${frame}`}
          </span>
        </div>
      )}
      <div className="viewer-bar">
        <div className="seg">
          {PRESETS.map((p) => {
            const on = preset === p.key && !orbited;
            return <button key={p.key} className={on ? "on" : ""} aria-pressed={on} title={p.title} onClick={() => { setPreset(p.key); setPresetN((n) => n + 1); }}>{p.label}</button>;
          })}
        </div>
        <div className="seg">
          {(["mesh", "both", "skeleton"] as const).map((m) => <button key={m} className={mode === m ? "on" : ""} aria-pressed={mode === m} onClick={() => setMode(m)}>{m === "both" ? "Body + bones" : m === "mesh" ? "Body" : "Bones"}</button>)}
        </div>
        <button className={`btn sm ${ghost ? "active" : ""}`} aria-pressed={ghost} onClick={() => setGhost((g) => !g)} title="Overlay the body at BFC, FFC and release">Ghosts</button>
        <button className={`btn sm ${follow ? "active" : ""}`} aria-pressed={follow} onClick={() => setFollow((f) => !f)} title="Camera follows the bowler">Follow</button>
        <button className={`btn sm ${showTags ? "active" : ""}`} aria-pressed={showTags} onClick={() => setShowTags((x) => !x)} title="Live joint angles on the body">Angles</button>
        <button ref={expandRef} className={`btn sm ${big ? "active" : ""}`} aria-pressed={big} onClick={() => { if (!big) setActive(true); else setActive(false); setBig((x) => !x); }} title={big ? "Back to the page (Esc)" : "Enlarge the 3D view"}>{big ? "Close" : "Expand"}</button>
      </div>
    </div>
  );
}

/** Free GPU buffers of everything under `root` (geometries and materials are not freed by removal alone). */
function disposeTree(root: THREE.Object3D) {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    m.geometry?.dispose();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    (Array.isArray(mat) ? mat : mat ? [mat] : []).forEach((x) => x.dispose());
  });
}
