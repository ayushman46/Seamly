"""The tracker must keep identities when a fast bowler runs past a static umpire (the classic broadcast
failure that the bundled ultralytics trackers get wrong)."""
import numpy as np

import cv2

from bowlnet.tracking import FrameDets, _camera_motion, _static_mask, track


def _person(cx, cy, h, colour):
    box = np.array([cx - 0.2 * h, cy - 0.5 * h, cx + 0.2 * h, cy + 0.5 * h], np.float32)
    kp = np.stack([np.linspace(box[0], box[2], 17), np.linspace(box[1], box[3], 17)], 1).astype(np.float32)
    app = np.zeros(96, np.float32)
    app[colour] = 1.0
    app[48 + colour] = 1.0
    return box, kp, app


def test_bowler_passes_umpire_without_id_switch():
    frames = []
    eye = np.array([[1, 0, 0], [0, 1, 0]], np.float32)
    for t in range(40):
        bowler = _person(100 + 12 * t, 300, 200, 3)        # moves right 12 px/frame
        umpire = _person(400, 300, 210, 20)                # static, different clothing
        order = [bowler, umpire] if t % 2 == 0 else [umpire, bowler]   # detector order shuffles
        boxes = np.stack([o[0] for o in order]); kps = np.stack([o[1] for o in order])
        apps = np.stack([o[2] for o in order])
        frames.append(FrameDets(t, boxes, np.array([0.9, 0.9], np.float32), kps, np.ones((2, 17), np.float32), apps, eye))
    dets = track(frames, fps=30)
    ids_by_kind = {"bowler": set(), "umpire": set()}
    for d in dets:
        cx = (d.box[0] + d.box[2]) / 2
        # identify ground truth by the frame's known positions
        kind = "umpire" if abs(cx - 400) < 1 else "bowler"
        if abs(cx - 400) < 1 and abs((100 + 12 * d.frame) - 400) < 1:
            continue  # exact overlap frame: ambiguous by construction
        ids_by_kind[kind].add(d.track)
    assert len(ids_by_kind["bowler"]) == 1, ids_by_kind
    assert len(ids_by_kind["umpire"]) == 1, ids_by_kind
    assert ids_by_kind["bowler"] != ids_by_kind["umpire"]


def test_camera_pan_compensated():
    """A static person under a panning camera keeps one id."""
    frames = []
    for t in range(30):
        shift = -15.0 * t
        M = np.array([[1, 0, -15.0], [0, 1, 0]], np.float32) if t else np.array([[1, 0, 0], [0, 1, 0]], np.float32)
        b, kp, app = _person(600 + shift, 300, 200, 5)
        frames.append(FrameDets(t, b[None], np.array([0.9], np.float32), kp[None], np.ones((1, 17), np.float32), app[None], M))
    dets = track(frames, fps=30)
    assert len({d.track for d in dets}) == 1


def test_zoom_recovered_under_static_score_bar():
    """A broadcast zoom must be measured even though a pixel-identical score bar covers part of the frame."""
    rng = np.random.default_rng(0)
    base = cv2.GaussianBlur(rng.integers(0, 255, (480, 640), dtype=np.uint8), (0, 0), 3)
    base = cv2.normalize(base, None, 0, 255, cv2.NORM_MINMAX)
    grays, zoom = [], 1.02
    for t in range(6):
        z = zoom ** t
        M = np.array([[z, 0, 320 * (1 - z)], [0, z, 240 * (1 - z)]], np.float32)
        g = cv2.warpAffine(base, M, (640, 480), borderMode=cv2.BORDER_REFLECT)
        g[400:470, 40:600] = 200                                  # static overlay
        g[420:450, 60:300] = 30
        grays.append(g)
    diffs = [cv2.absdiff(a, b) for a, b in zip(grays, grays[1:])][:-1]
    none = np.zeros((0, 4), np.float32)
    M = _camera_motion(grays[-2], grays[-1], none, 1.0, none, _static_mask(diffs))
    assert abs(np.sqrt(np.linalg.det(M[:, :2])) - zoom) < 0.002
    # a tripod (nothing changes) must stay identity
    still = [grays[0]] * 6
    M = _camera_motion(still[0], still[1], none, 1.0, none, _static_mask([cv2.absdiff(still[0], still[1])] * 4))
    assert np.allclose(M, [[1, 0, 0], [0, 1, 0]], atol=1e-4)


def test_duplicate_box_at_release_keeps_one_id():
    """At release the detector can return two boxes for the bowler (with and without the outstretched arm,
    IoU ~0.65, which survives NMS). The spare must not start a track that takes the bowler over; a second
    person overlapping just as much (different pose) must still get their own track."""
    eye = np.array([[1, 0, 0], [0, 1, 0]], np.float32)
    frames = []
    for t in range(30):
        b, kp, app = _person(200 + 10 * t, 300, 200, 3)
        boxes, kps, apps, confs = [b], [kp], [app], [0.9]
        if t in (12, 13):   # duplicate: same keypoints, box widened by the bowling arm
            wide = b.copy(); wide[2] += 0.45 * 200
            boxes.insert(0, wide); kps.insert(0, kp.copy()); apps.insert(0, app); confs.insert(0, 0.95)
        if t >= 20:         # another player overlapping as much, different pose
            o, okp, oapp = _person(200 + 10 * t + 40, 300, 200, 20)
            boxes.append(o); kps.append(okp[::-1].copy()); apps.append(oapp); confs.append(0.9)
        n = len(boxes)
        frames.append(FrameDets(t, np.stack(boxes), np.array(confs, np.float32), np.stack(kps),
                                np.ones((n, 17), np.float32), np.stack(apps), eye))
    tracks: dict[int, list[int]] = {}
    for d in track(frames, fps=25):
        tracks.setdefault(d.track, []).append(d.frame)
    bowler = [fr for fr in tracks.values() if fr[0] == 0]
    assert len(bowler) == 1 and bowler[0] == list(range(30)), tracks
    assert len(tracks) == 2 and any(fr[0] == 20 for fr in tracks.values()), tracks
