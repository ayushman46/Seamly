/** Parity of engine/body.ts with backend/bowlnet/body (export_mesh binaries, info dict, ground offsets). */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { bodyInstance, exportMesh, exportMeshWith, frameObj, loadBodyModel, setBodyAssetLoader, worldToThree, type BodyModel }
  from "../src/engine/body";
import { skinFrame, type MeshData } from "../src/lib/mesh";
import { FIXTURES, loadFixture, maxAbsDiff } from "./fixtures";

const PUBLIC = join(__dirname, "..", "public", "models");
const b64 = (s: string) => {
  const b = Buffer.from(s, "base64");
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};
const f32 = (buf: ArrayBuffer, off = 0, n?: number) => Array.from(new Float32Array(buf.slice(off, n === undefined ? undefined : off + n * 4)));

let model: BodyModel;
beforeAll(async () => {
  setBodyAssetLoader(async () => {
    const bin = readFileSync(join(PUBLIC, "anny_body.bin"));
    return { header: JSON.parse(readFileSync(join(PUBLIC, "anny_body.json"), "utf8")),
      bin: bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) };
  });
  model = await loadBodyModel();
});

describe.each(FIXTURES)("body %s", (name) => {
  it("matches export_mesh (info, pose.bin, mesh_rest.bin, ground offset)", async () => {
    const fx = loadFixture(name);
    const rec = fx.calls.export_mesh[0];
    const { W, height, gender, bowling_arm } = rec.args;
    const out = exportMeshWith(model, W, height, gender, bowling_arm);
    expect(new Uint8Array((await exportMesh(W, height, gender, bowling_arm)).pose)).toEqual(new Uint8Array(out.pose));

    expect(JSON.stringify(out.info)).toBe(JSON.stringify(rec.out));
    expect(out.info).toEqual(fx.result.mesh);

    const pose = b64(rec.files["pose.bin"]);
    expect(out.pose.byteLength).toBe(pose.byteLength);
    const dPose = maxAbsDiff(f32(out.pose), f32(pose));
    expect(dPose).toBeLessThan(1e-4);

    if (rec.files["mesh_rest.bin"]) {
      const rest = b64(rec.files["mesh_rest.bin"]);
      const { V, F } = { V: rec.out.vertices, F: rec.out.faces };
      expect(out.rest.byteLength).toBe(rest.byteLength);
      expect(maxAbsDiff(f32(out.rest, 0, V * 3), f32(rest, 0, V * 3))).toBeLessThan(1e-4);
      // faces, skin indices and skin weights are copied from the asset: byte-identical
      const tail = V * 12;
      expect(Buffer.from(out.rest.slice(tail)).equals(Buffer.from(rest.slice(tail)))).toBe(true);
      expect(F * 6 + V * 20).toBe(rest.byteLength - tail);
    }

    // result.skeleton3d.joints = round(world_to_three(W + ground_offset), 4)
    const joints = worldToThree(W.map((fr: number[][], t: number) => fr.map((p) => p.map((v, k) => v + out.groundOffset[t][k]))));
    const dJ = maxAbsDiff(joints, fx.result.skeleton3d.joints);
    expect(dJ).toBeLessThanOrEqual(5e-5 + 1e-7);
    // after Python's rounding, only values within the fixture's 1e-7 rounding of W of a 4-decimal tie may differ
    const flat = (a: number[][][]) => a.flat(2);
    const ref = flat(fx.result.skeleton3d.joints), mine = flat(joints).map((v) => Math.round(v * 1e4) / 1e4);
    const off = mine.filter((v, i) => Math.abs(v - ref[i]) > 1e-9).length;
    expect(off / ref.length).toBeLessThan(1e-3);
    console.log(`${name}: pose max|d|=${dPose.toExponential(2)}, joints max|d|=${dJ.toExponential(2)}, `
      + `rounded joints differing: ${off}/${ref.length}`);
  });
});

describe("body model", () => {
  it("instances stand on z=0 at the requested stature for any gender", () => {
    for (const [h, g] of [[1.55, 0.4], [1.92, 1], [1.2, 0], [2.6, 0.7]]) {
      const inst = bodyInstance(model, h, g);
      const z = inst.restVertices.filter((_, k) => k % 3 === 2);
      expect(Math.min(...z)).toBe(0);
      expect(Math.abs(Math.max(...z) - h)).toBeLessThan(1e-12);
    }
  });

  it("frameObj matches the lib/mesh.ts skinning of the same binaries", () => {
    const rec = loadFixture("synth_side").calls.export_mesh[0];
    const rest = b64(rec.files["mesh_rest.bin"]), pose = b64(rec.files["pose.bin"]);
    const { vertices: V, faces: F, bones: B, frames: T } = rec.out;
    const o = V * 12 + F * 6;
    const m: MeshData = { V, F, B, T, rest: new Float32Array(rest.slice(0, V * 12)), index: new Uint16Array(rest.slice(V * 12, o)),
      skinIndex: new Uint8Array(rest.slice(o, o + V * 4)), skinWeight: new Float32Array(rest.slice(o + V * 4)), pose: new Float32Array(pose) };
    const lines = frameObj(rest, pose, rec.out, 40).trimEnd().split("\n");
    expect(lines.length).toBe(2 + V + F);
    expect(lines[1]).toBe("# frame index 40");
    const out = new Float32Array(V * 3);
    skinFrame(m, 40, out);
    const v = lines.slice(2, 2 + V).flatMap((l) => l.split(" ").slice(1).map(Number));
    expect(maxAbsDiff(v, Array.from(out))).toBeLessThan(1e-5);
    expect(lines[2 + V]).toBe(`f ${m.index[0] + 1} ${m.index[1] + 1} ${m.index[2] + 1}`);
  });
});
