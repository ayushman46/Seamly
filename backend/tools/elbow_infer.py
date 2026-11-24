"""The pose model run the way the app runs it (one crop round the bowler, and its mirror image), for the arm tracer's
training data: any SimCC model whose first 17 joints are COCO's."""
import cv2
import numpy as np

MEAN = np.array([123.675, 116.28, 103.53], np.float32); STD = np.array([58.395, 57.12, 57.375], np.float32)
F17 = [0, 2, 1, 4, 3, 6, 5, 8, 7, 10, 9, 12, 11, 14, 13, 16, 15]


def simcc(sess, img, box, flip=True, pad=1.25):
    inp = sess.get_inputs()[0]; CH, CW = inp.shape[2], inp.shape[3]
    cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2; bw, bh = (box[2] - box[0]) * pad, (box[3] - box[1]) * pad
    if bw > bh * CW / CH:
        bh = bw / (CW / CH)
    else:
        bw = bh * CW / CH
    s = CW / bw; M = np.array([[s, 0, -s * (cx - bw / 2)], [0, s, -s * (cy - bh / 2)]], np.float32)
    crop = cv2.warpAffine(img, M, (CW, CH), flags=cv2.INTER_LINEAR)

    def look(c):
        x = ((cv2.cvtColor(c, cv2.COLOR_BGR2RGB).astype(np.float32) - MEAN) / STD).transpose(2, 0, 1)[None]
        sx, sy = sess.run(None, {inp.name: x}); sx, sy = sx[0][:17], sy[0][:17]
        return np.stack([sx.argmax(1) / 2, sy.argmax(1) / 2], 1), np.minimum(sx.max(1), sy.max(1))
    k, c = look(crop)
    if flip:
        k2, c2 = look(crop[:, ::-1].copy()); k2 = k2[F17]; k2[:, 0] = CW - 1 - k2[:, 0]; c2 = c2[F17]
        ok = np.linalg.norm(k - k2, axis=1) < 0.08 * (box[3] - box[1]) * s
        k = np.where(ok[:, None], (k * c[:, None] + k2 * c2[:, None]) / (c + c2 + 1e-6)[:, None], k)
    return k / s + np.array([cx - bw / 2, cy - bh / 2]), c
