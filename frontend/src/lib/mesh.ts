/** Loads the compact body-model binaries produced by the backend and skins them on the CPU. */
export interface MeshData {
  V: number;
  F: number;
  B: number;
  T: number;
  rest: Float32Array; // V*3
  index: Uint16Array; // F*3
  skinIndex: Uint8Array; // V*4
  skinWeight: Float32Array; // V*4
  pose: Float32Array; // T*B*12
}

export async function loadMesh(restUrl: string, poseUrl: string, meta: { vertices: number; faces: number; bones: number }): Promise<MeshData> {
  const [rb, pb] = await Promise.all([
    fetch(restUrl).then((r) => {
      if (!r.ok) throw new Error("mesh unavailable");
      return r.arrayBuffer();
    }),
    fetch(poseUrl).then((r) => {
      if (!r.ok) throw new Error("pose unavailable");
      return r.arrayBuffer();
    }),
  ]);
  const { vertices: V, faces: F, bones: B } = meta;
  let o = 0;
  const rest = new Float32Array(rb, o, V * 3); o += V * 12;
  const index = new Uint16Array(rb, o, F * 3); o += F * 6;
  const skinIndex = new Uint8Array(rb, o, V * 4); o += V * 4;
  // the weights start right after; copy to guarantee 4-byte alignment
  const skinWeight = new Float32Array(rb.slice(o, o + V * 16));
  const pose = new Float32Array(pb);
  const T = Math.floor(pose.length / (B * 12));
  return { V, F, B, T, rest, index, skinIndex, skinWeight, pose };
}

/** Writes skinned vertex positions for frame t into `out` (length V*3). */
export function skinFrame(m: MeshData, t: number, out: Float32Array) {
  const { V, B, rest, skinIndex: si, skinWeight: sw, pose } = m;
  const base = Math.max(0, Math.min(m.T - 1, t)) * B * 12;
  for (let v = 0; v < V; v++) {
    const x = rest[v * 3], y = rest[v * 3 + 1], z = rest[v * 3 + 2];
    let ox = 0, oy = 0, oz = 0;
    for (let k = 0; k < 4; k++) {
      const w = sw[v * 4 + k];
      if (w <= 0) continue;
      const p = base + si[v * 4 + k] * 12;
      ox += w * (pose[p] * x + pose[p + 1] * y + pose[p + 2] * z + pose[p + 3]);
      oy += w * (pose[p + 4] * x + pose[p + 5] * y + pose[p + 6] * z + pose[p + 7]);
      oz += w * (pose[p + 8] * x + pose[p + 9] * y + pose[p + 10] * z + pose[p + 11]);
    }
    out[v * 3] = ox; out[v * 3 + 1] = oy; out[v * 3 + 2] = oz;
  }
}
