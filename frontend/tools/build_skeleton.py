"""Builds public/skeleton/bones.bin from the OpenSim full-body model's bone meshes (Rajagopal et al. 2016, SimTK
"MIT Use Agreement"; geometry from github.com/opensim-org/opensim-models). Usage:
    python tools/build_skeleton.py <Rajagopal2016.osim> <dir with the .vtp files> public/skeleton/bones.bin
Each segment is written in its own frame (x forward, y up, z to the body's right, metres) with its origin at the joint
it hangs from, in the model's neutral pose. Layout: uint32 header length, JSON header, then float32 positions and
uint32 triangle indices for each segment (offsets in the header)."""
import json, re, struct, sys
import xml.etree.ElementTree as ET
import numpy as np

osim, geo, out = sys.argv[1:4]
model = ET.parse(osim).getroot().find("Model")

def vtp(name, scale=(1, 1, 1)):
    piece = ET.parse(f"{geo}/{name}").getroot().find("PolyData").find("Piece")
    pts = np.array(piece.find("Points").find("DataArray").text.split(), dtype=np.float64).reshape(-1, 3) * np.array(scale)
    arrs = {d.get("Name"): np.array(d.text.split(), dtype=np.int64) for d in piece.find("Polys").findall("DataArray")}
    tris, start = [], 0
    for end in arrs["offsets"]:
        poly = arrs["connectivity"][start:end]; start = end
        for k in range(1, len(poly) - 1): tris.append((poly[0], poly[k], poly[k + 1]))
    return pts, np.array(tris, dtype=np.int64)

bodies = {}
for b in model.find("BodySet").find("objects"):
    bodies[b.get("name")] = [(m.findtext("mesh_file").strip(), tuple(float(v) for v in m.findtext("scale_factors").split())) for m in b.iter("Mesh")]
V = lambda *a: np.array(a, dtype=np.float64)

def merged(parts):
    """parts: (body name, offset of that body's frame in the segment's frame, optional mesh-name filter)."""
    P, T, n = [], [], 0
    for body, off, keep in parts:
        for f, s in bodies[body]:
            if keep and not re.search(keep, f): continue
            p, t = vtp(f, s)
            P.append(p + off); T.append(t + n); n += len(p)
    return np.vstack(P), np.vstack(T)

segs = {}
def seg(name, parts, origin=V(0, 0, 0), **marks):
    p, t = merged(parts)
    if name == "femur_r": p = p * np.array([1, 1, -1]); t = t[:, ::-1]
    segs[name] = (p - origin, t, {k: (np.array(v) - origin).round(5).tolist() for k, v in marks.items()})

O = V(0, 0, 0)
for s, z in (("r", 1), ("l", -1)):
    hip = V(-0.056276, -0.07849, 0.07726 * z)
    knee = V(-0.00809, -0.40796, -0.00275 * z)
    seg(f"femur_{s}", [("femur_l", O, None)], tip=knee)   # the right femur's file is a coarse one: the left one is mirrored
    seg(f"shin_{s}", [(f"tibia_{s}", O, None)], tip=V(-0.01, -0.4, 0))
    calcn = V(-0.04877, -0.04195, 0.00792 * z); toes = calcn + V(0.1788, -0.002, 0.00108 * z)
    seg(f"foot_{s}", [(f"talus_{s}", O, None), (f"calcn_{s}", calcn, None), (f"toes_{s}", toes, None)], toes=toes)
    seg(f"humerus_{s}", [(f"humerus_{s}", O, None)], tip=V(0.013144, -0.286273, -0.009595 * z))
    rad = V(-0.006727, -0.013007, 0.026083 * z); wrist = rad + V(-0.008797, -0.235841, 0.01361 * z)
    seg(f"forearm_{s}", [(f"ulna_{s}", O, None), (f"radius_{s}", rad, None)], tip=wrist)
    seg(f"hand_{s}", [(f"hand_{s}", O, None)])
hipMid = V(-0.056276, -0.07849, 0)
seg("pelvis", [("pelvis", O, None)], origin=hipMid, hip_r=V(-0.056276, -0.07849, 0.07726), back=V(-0.1007, 0.0815, 0))
ph, th = merged([("torso", O, "skull|jaw")])
print("skull bounds", ph.min(0).round(3), ph.max(0).round(3))
seg("trunk", [("torso", O, "spine|ribs")], shoulder_r=V(0.003155, 0.3715, 0.17), neck=V(float(ph[:, 0].mean()) - 0.02, float(ph[:, 1].min()) + 0.02, 0))
seg("head", [("torso", O, "skull|jaw")], origin=V(float(ph[:, 0].mean()) - 0.02, float(ph[:, 1].min()) + 0.02, 0), top=V(0, float(ph[:, 1].max()), 0))

header, blobs, at = {"credit": "Bone geometry: Rajagopal et al. (2016) full-body model, OpenSim / SimTK (MIT Use Agreement)", "segments": {}}, [], 0
for name, (p, t, marks) in segs.items():
    # weld duplicate points so normals come out smooth
    key = np.round(p, 5); _, first, inv = np.unique(key, axis=0, return_index=True, return_inverse=True)
    p = p[first]; t = inv.reshape(-1)[t]
    t = t[(t[:, 0] != t[:, 1]) & (t[:, 1] != t[:, 2]) & (t[:, 0] != t[:, 2])]
    pb, tb = p.astype("<f4").tobytes(), t.astype("<u4").tobytes()
    header["segments"][name] = {"v": len(p), "t": len(t), "pos": at, "idx": at + len(pb), **marks,
                                "min": p.min(0).round(4).tolist(), "max": p.max(0).round(4).tolist()}
    blobs += [pb, tb]; at += len(pb) + len(tb)
    print(f"{name:12s} verts {len(p):6d} tris {len(t):6d}  min {p.min(0).round(3)} max {p.max(0).round(3)} {marks}")
h = json.dumps(header, separators=(",", ":")).encode()
h += b" " * (-len(h) % 4)
open(out, "wb").write(struct.pack("<I", len(h)) + h + b"".join(blobs))
print("wrote", out, (4 + len(h) + at) // 1000, "kB")
