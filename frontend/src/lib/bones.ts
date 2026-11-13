import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { J, type V3 } from "./biomech";

/**
 * A bone skeleton drawn from the 17 joints of the analysis: skull, spine, rib cage, pelvis and the long bones, all
 * built here from simple shapes (no model file to download or license). Each bone is placed between its two joints
 * every frame, so the skeleton takes exactly the pose that was measured.
 */

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

export class BoneBody {
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

  dispose() {
    this.group.traverse((o) => { const g = (o as THREE.Mesh).geometry; g?.dispose(); });
    this.long.dispose(); this.shin.dispose(); this.fore.dispose();
    this.mat.dispose(); this.dark.dispose();
  }
}
