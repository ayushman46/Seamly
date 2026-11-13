import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { J, type V3 } from "./biomech";

/**
 * The skeleton of the replay, posed on the 17 joints of the analysis every frame. BoneBody uses real bone surfaces
 * (the OpenSim full-body model of Rajagopal et al. 2016, MIT Use Agreement: public/skeleton); SimpleBody is built
 * here from simple shapes and stands in if that file can't be loaded.
 */

export type Limb = "leg_r" | "leg_l" | "arm_r" | "arm_l" | "trunk";
export interface Body {
  readonly group: THREE.Group;
  /** Pose on one frame's joints; `hinges` are the axes the limbs bend about (right leg, left leg, right arm, left arm). */
  update(P: V3[], hinges?: V3[]): void;
  /** Colour some limbs (the ones a callout is about), or give them back their bone colour. */
  tint(limbs: Limb[], color: number | null): void;
  dispose(): void;
}

const BONE = 0xf3eddc;

/** A long bone along +Y from 0 to 1 (shaft radius 1, flared ends): scaled to its length and thickness when placed. */
function longBone(): THREE.BufferGeometry {
  const prof: [number, number][] = [[0, 0], [1.5, 0.012], [2.1, 0.05], [1.9, 0.09], [1.25, 0.16], [1.0, 0.26], [0.92, 0.5], [1.0, 0.74],
    [1.25, 0.84], [1.9, 0.91], [2.1, 0.95], [1.5, 0.988], [0, 1]];
  return new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(r, y)), 14);
}

/** Two thin bones side by side (shin, forearm), in the same unit space as longBone. */
function pairedBone(gap: number, thin: number): THREE.BufferGeometry {
  const a = longBone(); a.translate(gap, 0, 0);
  const b = longBone(); b.scale(thin, 1, thin); b.translate(-gap * 1.2, 0, 0);
  const g = mergeGeometries([a, b])!;
  a.dispose(); b.dispose();
  return g;
}

/** The rib cage in its own space: bottom at y = 0, top at y = 1, half-width 1 at its widest, front towards -z. */
function ribCage(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const N = 10;
  for (let i = 0; i < N; i++) {
    const v = i / (N - 1);                                   // 0 at the lowest rib, 1 at the top
    const a = 0.5 + 0.5 * Math.sin(Math.PI * (0.22 + 0.62 * v)) - 0.28 * v * v;   // half-width: widest low-middle, narrow at the neck
    const b = a * 0.74;
    const y = 0.06 + 0.9 * v;
    const pts: THREE.Vector3[] = [];
    for (let k = 0; k <= 40; k++) {
      // open at the front below the sternum for the lower ribs
      const span = i < 3 ? Math.PI * (0.66 + 0.1 * i) : Math.PI;
      const th = -span + (2 * span * k) / 40;                // 0 at the spine (back, +z), ±π at the sternum (front)
      const x = a * Math.sin(th), z = b * Math.cos(th);
      pts.push(new THREE.Vector3(x, y - 0.075 * (1 - Math.cos(th)) * 0.5 * (1.4 - v), z));   // ribs slope down to the front
    }
    parts.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 40, 0.028, 6, false));
  }
  const sternum = new THREE.BoxGeometry(0.2, 0.52, 0.05);
  sternum.translate(0, 0.62, -0.6);
  parts.push(sternum);
  const g = mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)))!;
  parts.forEach((p) => p.dispose());
  return g;
}

/** The pelvis in its own space: hip joints at x = ±1, y = 0; front towards -z. */
function pelvis(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (const sx of [-1, 1]) {
    const wing = new THREE.SphereGeometry(1, 16, 12);
    wing.scale(0.5, 0.56, 0.11);
    wing.rotateY(sx * 0.62); wing.rotateZ(-sx * 0.3);
    wing.translate(sx * 0.8, 0.5, 0.1);
    parts.push(wing);
    const socket = new THREE.SphereGeometry(0.15, 10, 8);
    socket.translate(sx, 0, 0);
    parts.push(socket);
    const ischium = new THREE.TorusGeometry(0.26, 0.075, 6, 14);
    ischium.rotateY(sx * 0.4);
    ischium.translate(sx * 0.5, -0.3, -0.1);
    parts.push(ischium);
  }
  const sacrum = new THREE.ConeGeometry(0.34, 0.85, 8);
  sacrum.rotateX(Math.PI);
  sacrum.scale(1, 1, 0.45);
  sacrum.translate(0, 0.5, 0.36);
  parts.push(sacrum);
  const pubis = new THREE.BoxGeometry(0.9, 0.16, 0.14);
  pubis.translate(0, -0.12, -0.42);
  parts.push(pubis);
  const g = mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)))!;
  parts.forEach((p) => p.dispose());
  return g;
}

/** The skull in metres: the top of the head at y = 0, the face towards -z. Returns the bone and the dark hollows. */
function skull(): [THREE.BufferGeometry, THREE.BufferGeometry] {
  const bone: THREE.BufferGeometry[] = [];
  const cranium = new THREE.SphereGeometry(0.094, 22, 16);
  cranium.scale(0.84, 0.95, 1.06);
  cranium.translate(0, -0.092, 0.012);
  bone.push(cranium);
  const face = new THREE.BoxGeometry(0.104, 0.07, 0.06, 2, 2, 2);
  face.translate(0, -0.15, -0.062);
  bone.push(face);
  const jaw = new THREE.CylinderGeometry(0.05, 0.036, 0.058, 12, 1, false);
  jaw.scale(1, 1, 0.9);
  jaw.translate(0, -0.208, -0.05);
  bone.push(jaw);
  for (const sx of [-1, 1]) {
    const cheek = new THREE.SphereGeometry(0.024, 8, 6);
    cheek.translate(sx * 0.052, -0.142, -0.066);
    bone.push(cheek);
  }
  const dark: THREE.BufferGeometry[] = [];
  for (const sx of [-1, 1]) {
    const eye = new THREE.SphereGeometry(0.023, 10, 8);
    eye.scale(1.1, 1, 0.6);
    eye.translate(sx * 0.034, -0.112, -0.094);
    dark.push(eye);
  }
  const nose = new THREE.ConeGeometry(0.014, 0.034, 3);
  nose.scale(1, 1, 0.5);
  nose.translate(0, -0.152, -0.096);
  dark.push(nose);
  const teeth = new THREE.BoxGeometry(0.062, 0.006, 0.01);
  teeth.translate(0, -0.192, -0.094);
  dark.push(teeth);
  const merge = (ps: THREE.BufferGeometry[]) => { const g = mergeGeometries(ps.map((p) => (p.index ? p.toNonIndexed() : p)))!; ps.forEach((p) => p.dispose()); return g; };
  return [merge(bone), merge(dark)];
}

const v = (p: V3) => new THREE.Vector3(p[0], p[1], p[2]);

export class SimpleBody implements Body {
  readonly group = new THREE.Group();
  private mat = new THREE.MeshStandardMaterial({ color: BONE, roughness: 0.62, metalness: 0.02, emissive: 0x3a3426, emissiveIntensity: 0.7 });
  private dark = new THREE.MeshStandardMaterial({ color: 0x15130f, roughness: 0.9 });
  private long = longBone();
  private shin = pairedBone(0.75, 0.5);
  private fore = pairedBone(0.95, 0.85);
  private seg: Record<string, THREE.Mesh> = {};
  private ribs: THREE.Mesh; private hips: THREE.Mesh; private head: THREE.Group; private spine: THREE.InstancedMesh;
  private m = new THREE.Matrix4(); private q = new THREE.Quaternion(); private one = new THREE.Vector3(1, 1, 1);
  private x = new THREE.Vector3(); private y = new THREE.Vector3(); private z = new THREE.Vector3();

  constructor() {
    const add = (name: string, g: THREE.BufferGeometry) => { const mesh = new THREE.Mesh(g, this.mat); mesh.castShadow = true; mesh.matrixAutoUpdate = false; this.group.add(mesh); this.seg[name] = mesh; };
    for (const n of ["femurR", "femurL", "humerusR", "humerusL", "clavR", "clavL"]) add(n, this.long);
    for (const n of ["shinR", "shinL"]) add(n, this.shin);
    for (const n of ["foreR", "foreL"]) add(n, this.fore);
    const hand = new THREE.SphereGeometry(1, 10, 8); hand.scale(0.03, 0.5, 0.013); hand.translate(0, 0.5, 0);
    for (const n of ["handR", "handL"]) add(n, hand);
    const foot = new THREE.BoxGeometry(0.062, 1, 0.03, 2, 6, 2);
    {
      // a wedge: thicker at the heel, flat at the toes
      const p = foot.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < p.count; i++) { const yy = p.getY(i) + 0.5; p.setY(i, yy); p.setZ(i, p.getZ(i) * (1.5 - 1.1 * yy)); p.setX(i, p.getX(i) * (0.7 + 0.5 * Math.sin(Math.PI * Math.min(1, 0.15 + yy * 0.8)))); }
      foot.computeVertexNormals();
    }
    for (const n of ["footR", "footL"]) add(n, foot);
    this.ribs = new THREE.Mesh(ribCage(), this.mat); this.hips = new THREE.Mesh(pelvis(), this.mat);
    const [sk, hollow] = skull();
    this.head = new THREE.Group();
    this.head.add(new THREE.Mesh(sk, this.mat), new THREE.Mesh(hollow, this.dark));
    const vert = new THREE.CylinderGeometry(0.017, 0.017, 0.015, 8);
    this.spine = new THREE.InstancedMesh(vert, this.mat, 24);
    for (const o of [this.ribs, this.hips, this.head, this.spine]) { o.matrixAutoUpdate = false; this.group.add(o); }
    this.group.traverse((o) => { (o as THREE.Mesh).castShadow = true; o.frustumCulled = false; });
  }

  /** Put a unit bone from a to b: its length along the line, `r` its thickness, rolled so its local x follows `hint`. */
  private place(mesh: THREE.Object3D, a: THREE.Vector3, b: THREE.Vector3, r: number, hint: THREE.Vector3, rz = r) {
    this.y.subVectors(b, a);
    const len = Math.max(1e-4, this.y.length());
    this.y.divideScalar(len);
    this.z.crossVectors(hint, this.y);
    if (this.z.lengthSq() < 1e-6) this.z.set(0, 0, 1).cross(this.y);
    this.z.normalize();
    this.x.crossVectors(this.y, this.z);
    this.m.makeBasis(this.x, this.y, this.z);
    this.q.setFromRotationMatrix(this.m);
    mesh.matrix.compose(a, this.q, this.one.set(r, len, rz));
  }

  /** Pose the skeleton on the 17 joints of one frame (metres, y up). */
  update(P: V3[]) {
    const p = P.map(v);
    const hipR = p[J.rHip], hipL = p[J.lHip], shR = p[J.rShoulder], shL = p[J.lShoulder];
    const up = new THREE.Vector3().subVectors(p[J.thorax], p[J.pelvis]).normalize();
    const right = new THREE.Vector3().subVectors(hipR, hipL);
    const hipW = Math.max(0.12, right.length());
    right.addScaledVector(up, -right.dot(up)).normalize();
    const back = new THREE.Vector3().crossVectors(right, up).normalize();        // the body's back (its front is -back)
    const fwdFlat = new THREE.Vector3(-back.x, 0, -back.z);
    if (fwdFlat.lengthSq() < 1e-6) fwdFlat.set(0, 0, -1);
    fwdFlat.normalize();

    // legs
    const S = this.seg;
    this.place(S.femurR, hipR, p[J.rKnee], 0.019, right);
    this.place(S.femurL, hipL, p[J.lKnee], 0.019, right);
    this.place(S.shinR, p[J.rKnee], p[J.rAnkle], 0.0145, right);
    this.place(S.shinL, p[J.lKnee], p[J.lAnkle], 0.0145, right);
    for (const [name, ankle, knee] of [["footR", p[J.rAnkle], p[J.rKnee]], ["footL", p[J.lAnkle], p[J.lKnee]]] as const) {
      // on the ground the foot lies flat along the body's heading; in the air it hangs from the shin
      const air = Math.min(1, Math.max(0, (ankle.y - 0.12) / 0.2));
      const shin = new THREE.Vector3().subVectors(ankle, knee).normalize();
      const dir = new THREE.Vector3().copy(fwdFlat).multiplyScalar(1 - 0.55 * air).addScaledVector(shin, 0.75 * air).normalize();
      const heel = new THREE.Vector3().copy(ankle).addScaledVector(dir, -0.055); heel.y -= Math.min(0.07, Math.max(0, ankle.y - 0.03)) * (1 - 0.3 * air);
      const toe = new THREE.Vector3().copy(heel).addScaledVector(dir, 0.235); toe.y = Math.max(0.02, toe.y - 0.012 * (1 - air));
      heel.y = Math.max(0.028, heel.y);
      this.place(S[name], heel, toe, 1, right);
    }
    // arms
    const chest = new THREE.Vector3().copy(p[J.thorax]).addScaledVector(back, -0.045);
    this.place(S.clavR, chest, shR, 0.0075, up);
    this.place(S.clavL, chest, shL, 0.0075, up);
    this.place(S.humerusR, shR, p[J.rElbow], 0.0155, back);
    this.place(S.humerusL, shL, p[J.lElbow], 0.0155, back);
    this.place(S.foreR, p[J.rElbow], p[J.rWrist], 0.0085, back);
    this.place(S.foreL, p[J.lElbow], p[J.lWrist], 0.0085, back);
    for (const [name, el, wr] of [["handR", p[J.rElbow], p[J.rWrist]], ["handL", p[J.lElbow], p[J.lWrist]]] as const) {
      const d = new THREE.Vector3().subVectors(wr, el).normalize();
      this.place(S[name], wr, new THREE.Vector3().copy(wr).addScaledVector(d, 0.14), 1, back);
    }

    // pelvis: hip joints at ±1 in its own space
    this.m.makeBasis(right, up, back);
    this.q.setFromRotationMatrix(this.m);
    const hw = hipW / 2;
    this.hips.matrix.compose(new THREE.Vector3().addVectors(hipR, hipL).multiplyScalar(0.5), this.q, this.one.set(hw * 1.12, hw * 1.12, hw * 1.12));

    // rib cage: from a little above the mid-spine joint to the shoulder line, as wide as the shoulders allow
    const tUp = new THREE.Vector3().subVectors(p[J.thorax], p[J.spine]);
    const tLen = Math.max(0.12, tUp.length());
    tUp.normalize();
    const tRight = new THREE.Vector3().subVectors(shR, shL);
    const shW = Math.max(0.2, tRight.length());
    tRight.addScaledVector(tUp, -tRight.dot(tUp)).normalize();
    const tBack = new THREE.Vector3().crossVectors(tRight, tUp).normalize();
    this.m.makeBasis(tRight, tUp, tBack);
    this.q.setFromRotationMatrix(this.m);
    const half = shW * 0.4;
    const base = new THREE.Vector3().copy(p[J.spine]).addScaledVector(tUp, -tLen * 0.12);
    this.ribs.matrix.compose(base, this.q, this.one.set(half, tLen * 1.14, half));

    // skull: the head joint is the top; the face looks where the nose joint is
    const hUp = new THREE.Vector3().subVectors(p[J.head], p[J.thorax]).normalize();
    const mid = new THREE.Vector3().addVectors(p[J.head], p[J.thorax]).multiplyScalar(0.5);
    const hF = new THREE.Vector3().subVectors(p[J.nose], mid);
    hF.addScaledVector(hUp, -hF.dot(hUp));
    if (hF.length() < 0.02) hF.copy(back).negate().addScaledVector(hUp, back.dot(hUp));
    hF.normalize();
    const hRight = new THREE.Vector3().crossVectors(hF, hUp).normalize();
    this.m.makeBasis(hRight, hUp, new THREE.Vector3().copy(hF).negate());
    this.q.setFromRotationMatrix(this.m);
    const top = new THREE.Vector3().copy(p[J.head]).addScaledVector(hUp, 0.035);
    this.head.matrix.compose(top, this.q, this.one.set(1, 1, 1));

    // spine: vertebrae along the back, pelvis to the base of the skull
    const skullBase = new THREE.Vector3().copy(top).addScaledVector(hUp, -0.2).addScaledVector(hF, -0.02);
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3().copy(p[J.pelvis]).addScaledVector(up, 0.03).addScaledVector(back, 0.05),
      new THREE.Vector3().copy(p[J.spine]).addScaledVector(tBack, 0.085),
      new THREE.Vector3().copy(p[J.thorax]).addScaledVector(tBack, 0.07).addScaledVector(tUp, -0.03),
      skullBase,
    ]);
    const n = this.spine.count, pos = new THREE.Vector3(), tan = new THREE.Vector3(), yAxis = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < n; i++) {
      const u = i / (n - 1);
      curve.getPoint(u, pos); curve.getTangent(u, tan);
      this.q.setFromUnitVectors(yAxis, tan.normalize());
      const s = 1.15 - 0.5 * u;
      this.spine.setMatrixAt(i, this.m.compose(pos, this.q, this.one.set(s, 1, s)));
    }
    this.spine.instanceMatrix.needsUpdate = true;
  }

  tint() { /* one material: no highlights on the simple skeleton */ }

  dispose() {
    this.group.traverse((o) => { const g = (o as THREE.Mesh).geometry; g?.dispose(); });
    this.long.dispose(); this.shin.dispose(); this.fore.dispose();
    this.mat.dispose(); this.dark.dispose();
  }
}

// ---------- the real bones ----------

interface SegInfo { v: number; t: number; pos: number; idx: number; tip?: V3; toes?: V3; hip_r?: V3; back?: V3; shoulder_r?: V3; neck?: V3; top?: V3; min: V3; max: V3 }
export interface BoneData { segments: Record<string, SegInfo>; buffer: ArrayBuffer; base: number }

/** Load the bone file (see tools/build_skeleton.py for its layout). */
export async function loadBones(url: string): Promise<BoneData> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`bones: ${res.status}`);
  const buffer = await res.arrayBuffer();
  const n = new DataView(buffer).getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, n))) as { segments: Record<string, SegInfo> };
  return { segments: header.segments, buffer, base: 4 + n };
}

const LIMB_OF: Record<string, Limb> = { femur_r: "leg_r", shin_r: "leg_r", foot_r: "leg_r", femur_l: "leg_l", shin_l: "leg_l", foot_l: "leg_l",
  humerus_r: "arm_r", forearm_r: "arm_r", hand_r: "arm_r", humerus_l: "arm_l", forearm_l: "arm_l", hand_l: "arm_l", pelvis: "trunk", trunk: "trunk", head: "trunk" };
const BONE_REAL = 0xe9e3d2;

/** The OpenSim skeleton. Every segment is in its own frame (x forward, y up, z to the body's right), origin at the
 * joint it hangs from; each frame it gets the rotation that puts its length along the measured bone and its hinge
 * axis across the plane the limb bends in. The trunk is bent between the pelvis and the chest. */
export class BoneBody implements Body {
  readonly group = new THREE.Group();
  private mesh: Record<string, THREE.Mesh> = {};
  private info: Record<string, SegInfo>;
  private rest: Record<string, THREE.Matrix4> = {};     // the inverse of each limb segment's own basis (length, hinge)
  private trunkRest: Float32Array;
  private prevZ: Record<string, THREE.Vector3> = {};

  /** `ghost`: a see-through copy in one colour (a moment left standing), casting no shadow. */
  constructor(data: BoneData, ghost?: number) {
    this.info = data.segments;
    for (const [name, s] of Object.entries(data.segments)) {
      const g = new THREE.BufferGeometry();
      const pos = new Float32Array(data.buffer.slice(data.base + s.pos, data.base + s.pos + s.v * 12));
      g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      g.setIndex(new THREE.BufferAttribute(new Uint32Array(data.buffer.slice(data.base + s.idx, data.base + s.idx + s.t * 12)), 1));
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, ghost === undefined
        ? new THREE.MeshStandardMaterial({ color: BONE_REAL, roughness: 0.5, metalness: 0.02, emissive: 0x2c2920, emissiveIntensity: 0.4 })
        : new THREE.MeshStandardMaterial({ color: ghost, roughness: 0.6, transparent: true, opacity: 0, depthWrite: false, emissive: ghost, emissiveIntensity: 0.25 }));
      m.castShadow = ghost === undefined; m.frustumCulled = false; m.matrixAutoUpdate = false;
      if (ghost !== undefined) m.renderOrder = 3;
      this.group.add(m);
      this.mesh[name] = m;
      if (s.tip) {
        // the segment's own basis: y from the far joint to its origin, z its hinge axis
        const y = new THREE.Vector3(-s.tip[0], -s.tip[1], -s.tip[2]).normalize();
        const z = new THREE.Vector3(0, 0, 1); z.addScaledVector(y, -z.dot(y)).normalize();
        const x = new THREE.Vector3().crossVectors(y, z);
        this.rest[name] = new THREE.Matrix4().makeBasis(x, y, z).transpose();
      }
    }
    this.trunkRest = (this.mesh.trunk.geometry.attributes.position.array as Float32Array).slice();
  }

  /** A ghost's strength (0: not there). */
  fade(opacity: number) {
    this.group.visible = opacity > 0.01;
    for (const m of Object.values(this.mesh)) (m.material as THREE.MeshStandardMaterial).opacity = opacity;
  }

  tint(limbs: Limb[], color: number | null) {
    for (const [name, m] of Object.entries(this.mesh)) {
      const mat = m.material as THREE.MeshStandardMaterial;
      mat.color.setHex(color !== null && limbs.includes(LIMB_OF[name]) ? color : BONE_REAL);
    }
  }

  /** A limb segment from joint a to joint b, its hinge axis along `hinge` (kept from flipping between frames). */
  private limb(name: string, a: THREE.Vector3, b: THREE.Vector3, hinge: THREE.Vector3, out?: THREE.Matrix4): number {
    const s = this.info[name], len = Math.hypot(...(s.tip as V3));
    const y = new THREE.Vector3().subVectors(a, b);
    const scale = Math.max(1e-3, y.length()) / len;
    y.normalize();
    const z = new THREE.Vector3().copy(hinge); z.addScaledVector(y, -z.dot(y));
    if (z.lengthSq() < 1e-8) z.copy(this.prevZ[name] ?? new THREE.Vector3(1, 0, 0)).addScaledVector(y, -(this.prevZ[name] ?? new THREE.Vector3(1, 0, 0)).dot(y));
    z.normalize();
    (this.prevZ[name] ??= new THREE.Vector3()).copy(z);
    const x = new THREE.Vector3().crossVectors(y, z);
    const m = new THREE.Matrix4().makeBasis(x, y, z).multiply(this.rest[name]);
    m.scale(new THREE.Vector3(scale, scale, scale)).setPosition(a);
    this.mesh[name].matrix.copy(m);
    out?.copy(m);
    return scale;
  }

  update(P: V3[], hinges?: V3[]) {
    const p = P.map(v);
    const hipR = p[J.rHip], hipL = p[J.lHip], shR = p[J.rShoulder], shL = p[J.lShoulder];
    // the pelvis: right along the hips, up towards the spine
    const right = new THREE.Vector3().subVectors(hipR, hipL);
    const hipW = Math.max(0.1, right.length());
    right.normalize();
    const up = new THREE.Vector3().subVectors(p[J.spine], p[J.pelvis]); up.addScaledVector(right, -up.dot(right)).normalize();
    const fwd = new THREE.Vector3().crossVectors(up, right).normalize();
    const pelvisS = Math.max(0.85, Math.min(1.12, hipW / (2 * (this.info.pelvis.hip_r as V3)[2])));
    const mid = new THREE.Vector3().addVectors(hipR, hipL).multiplyScalar(0.5);
    const Rp = new THREE.Matrix4().makeBasis(fwd, up, right);
    this.mesh.pelvis.matrix.copy(Rp).scale(new THREE.Vector3(pelvisS, pelvisS, pelvisS)).setPosition(mid);
    const fwdFlat = new THREE.Vector3(fwd.x, 0, fwd.z); if (fwdFlat.lengthSq() < 1e-6) fwdFlat.set(0, 0, -1); fwdFlat.normalize();

    // legs: the knee's hinge is across the plane the leg bends in (the body's right when the leg is straight)
    for (const [side, hip, knee, ankle] of [["r", hipR, p[J.rKnee], p[J.rAnkle]], ["l", hipL, p[J.lKnee], p[J.lAnkle]]] as const) {
      const thigh = new THREE.Vector3().subVectors(knee, hip).normalize(), shin = new THREE.Vector3().subVectors(ankle, knee).normalize();
      const given = hinges?.[side === "r" ? 0 : 1];
      const hinge = given ? new THREE.Vector3(given[0], given[1], given[2]) : new THREE.Vector3().crossVectors(shin, thigh).addScaledVector(right, 0.3);
      // the foot: its sole on the ground when the ankle is low, hanging from the shin in the air
      const foot = this.info[`foot_${side}`], shinLen = Math.hypot(...(this.info[`shin_${side}`].tip as V3));
      const fs = Math.max(0.85, Math.min(1.25, knee.distanceTo(ankle) / shinLen));
      const sole = -foot.min[1] * fs;
      const air = Math.min(1, Math.max(0, (ankle.y - 0.13) / 0.18));
      const a2 = new THREE.Vector3().copy(ankle);
      if (ankle.y < 0.2) a2.y = Math.max(sole + 0.004, ankle.y - (ankle.y - sole) * (1 - air));
      this.limb(`femur_${side}`, hip, knee, hinge);
      this.limb(`shin_${side}`, knee, a2, hinge);
      const shin2 = new THREE.Vector3().subVectors(a2, knee).normalize();
      const fx = new THREE.Vector3().copy(fwdFlat).multiplyScalar(1 - 0.5 * air).addScaledVector(shin2, 0.8 * air);
      if (air < 1) fx.y *= air;
      fx.normalize();
      const fz = new THREE.Vector3().copy(hinge); fz.addScaledVector(fx, -fz.dot(fx)).normalize();
      const fy = new THREE.Vector3().crossVectors(fz, fx);
      this.mesh[`foot_${side}`].matrix.makeBasis(fx, fy, fz).scale(new THREE.Vector3(fs, fs, fs)).setPosition(a2);
    }

    // the trunk: bent between the pelvis (its lumbar end) and the chest (shoulders on the measured shoulders)
    const T = this.info.trunk, sh = T.shoulder_r as V3, back = this.info.pelvis.back as V3;
    const lumbar = new THREE.Vector3(back[0], back[1], back[2]).multiplyScalar(pelvisS).applyMatrix4(Rp).add(mid);
    const shMid = new THREE.Vector3().addVectors(shR, shL).multiplyScalar(0.5);
    const cUp = new THREE.Vector3().subVectors(p[J.thorax], p[J.spine]).normalize();
    const cRight = new THREE.Vector3().subVectors(shR, shL);
    const shW = Math.max(0.2, cRight.length());
    cRight.addScaledVector(cUp, -cRight.dot(cUp)).normalize();
    const cFwd = new THREE.Vector3().crossVectors(cUp, cRight).normalize();
    const sy = Math.max(0.75, Math.min(1.35, shMid.distanceTo(lumbar) / sh[1]));
    const sw = Math.max(0.8, Math.min(1.3, shW / (2 * sh[2])));
    const sc = new THREE.Vector3(sw, sy, sw);
    const Rc = new THREE.Matrix4().makeBasis(cFwd, cUp, cRight);
    const chestO = new THREE.Vector3(sh[0] * sw, sh[1] * sy, 0).applyMatrix4(Rc).multiplyScalar(-1).add(shMid);
    const Mc = new THREE.Matrix4().copy(Rc).scale(sc).setPosition(chestO);
    const lUp = new THREE.Vector3().subVectors(p[J.spine], lumbar); lUp.addScaledVector(right, -lUp.dot(right)).normalize();
    const Ml = new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(lUp, right).normalize(), lUp, right).scale(sc).setPosition(lumbar);
    const rest = this.trunkRest, attr = this.mesh.trunk.geometry.attributes.position as THREE.BufferAttribute, out = attr.array as Float32Array;
    const a = Ml.elements, c = Mc.elements;
    for (let i = 0; i < rest.length; i += 3) {
      const x = rest[i], y = rest[i + 1], z = rest[i + 2];
      const u = Math.min(1, Math.max(0, (y - 0.02) / 0.2)), w = u * u * (3 - 2 * u);
      const lx = a[0] * x + a[4] * y + a[8] * z + a[12], ly = a[1] * x + a[5] * y + a[9] * z + a[13], lz = a[2] * x + a[6] * y + a[10] * z + a[14];
      const cx = c[0] * x + c[4] * y + c[8] * z + c[12], cy = c[1] * x + c[5] * y + c[9] * z + c[13], cz = c[2] * x + c[6] * y + c[10] * z + c[14];
      out[i] = lx + (cx - lx) * w; out[i + 1] = ly + (cy - ly) * w; out[i + 2] = lz + (cz - lz) * w;
    }
    attr.needsUpdate = true;
    this.mesh.trunk.geometry.computeVertexNormals();
    this.mesh.trunk.matrix.identity();

    // arms: the elbow's hinge across the plane the arm bends in (the chest's right when it is straight); the hand follows
    for (const [side, shd, el, wr] of [["r", shR, p[J.rElbow], p[J.rWrist]], ["l", shL, p[J.lElbow], p[J.lWrist]]] as const) {
      const upper = new THREE.Vector3().subVectors(el, shd).normalize(), fore = new THREE.Vector3().subVectors(wr, el).normalize();
      const given = hinges?.[side === "r" ? 2 : 3];
      const hinge = given ? new THREE.Vector3(given[0], given[1], given[2]) : new THREE.Vector3().crossVectors(upper, fore).addScaledVector(cRight, 0.3);
      this.limb(`humerus_${side}`, shd, el, hinge);
      const m = new THREE.Matrix4();
      const s = this.limb(`forearm_${side}`, el, wr, hinge, m);
      // the hand keeps the forearm's turn, at the wrist
      const hs = Math.max(0.9, Math.min(1.2, s));
      const e = m.elements, k = hs / s;
      this.mesh[`hand_${side}`].matrix.set(e[0] * k, e[4] * k, e[8] * k, wr.x, e[1] * k, e[5] * k, e[9] * k, wr.y, e[2] * k, e[6] * k, e[10] * k, wr.z, 0, 0, 0, 1);
    }

    // the skull: on top of the neck, facing where the nose joint is
    const neck = T.neck as V3;
    const base = new THREE.Vector3(neck[0], neck[1], neck[2]).applyMatrix4(Mc);
    const hUp = new THREE.Vector3().subVectors(p[J.head], p[J.thorax]).normalize();
    const hF = new THREE.Vector3().subVectors(p[J.nose], new THREE.Vector3().addVectors(p[J.head], p[J.thorax]).multiplyScalar(0.5));
    hF.addScaledVector(hUp, -hF.dot(hUp));
    if (hF.length() < 0.02) hF.copy(cFwd).addScaledVector(hUp, -cFwd.dot(hUp));
    hF.normalize();
    const hR = new THREE.Vector3().crossVectors(hF, hUp).normalize();
    const hs = Math.max(0.9, Math.min(1.15, sy));
    this.mesh.head.matrix.makeBasis(hF, hUp, hR).scale(new THREE.Vector3(hs, hs, hs)).setPosition(base);
  }

  dispose() {
    for (const m of Object.values(this.mesh)) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); }
  }
}
