/** The cricket pitch both 3D views stand on (the bio-mech replay and the batter's-eye view): to scale, by the Laws. */
import * as THREE from "three";
import { LANDING_Z } from "./biomech";

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

export function skyTexture(): THREE.CanvasTexture {
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

/** The ground, the strip, both sets of creases and stumps; with `landX`, the bowler's run-in line and landing ring. */
export function buildPitch(scene: THREE.Scene, landX: number | null) {
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
  if (landX === null) return;
  const run = new THREE.Mesh(new THREE.PlaneGeometry(0.02, 9), new THREE.MeshBasicMaterial({ color: 0xf59e0b, transparent: true, opacity: 0.32 }));
  run.rotation.x = -Math.PI / 2; run.position.set(landX, 0.009, 2.4);
  scene.add(run);
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.3, 0.325, 48), new THREE.MeshBasicMaterial({ color: 0x5b8def, transparent: true, opacity: 0.9, side: THREE.DoubleSide }));
  ring.rotation.x = -Math.PI / 2; ring.position.set(landX, 0.01, LANDING_Z - 0.06);
  scene.add(ring);
}

