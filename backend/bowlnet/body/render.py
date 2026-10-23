"""Tiny dependency-free mesh renderer (orthographic, flat Lambert shading) for thumbnails and tests."""
from __future__ import annotations

import cv2
import numpy as np


def render(V: np.ndarray, F: np.ndarray, view: str = "side", size: int = 512, skeleton: np.ndarray | None = None,
           edges=None, colour=(200, 170, 150), bg=(250, 250, 250)) -> np.ndarray:
    """V (N,3) world coords (x fwd, y left, z up). view: side (from the bowler's right), front, behind, top."""
    if view == "side":
        R = np.array([[1, 0, 0], [0, 0, 1], [0, -1, 0]], float)      # screen x = fwd, screen up = z, depth = -y
    elif view == "behind":
        R = np.array([[0, -1, 0], [0, 0, 1], [1, 0, 0]], float)      # looking along +x
    elif view == "front":
        R = np.array([[0, 1, 0], [0, 0, 1], [-1, 0, 0]], float)
    else:  # top
        R = np.array([[1, 0, 0], [0, 1, 0], [0, 0, 1]], float)
    Q = V @ R.T
    lo, hi = Q[:, :2].min(0), Q[:, :2].max(0)
    sc = 0.85 * size / max(hi - lo)
    c = (lo + hi) / 2
    px = np.empty((len(Q), 2))
    px[:, 0] = (Q[:, 0] - c[0]) * sc + size / 2
    px[:, 1] = size / 2 - (Q[:, 1] - c[1]) * sc
    img = np.full((size, size, 3), bg, np.uint8)
    tri = Q[F]
    n = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)
    light = np.array([0.3, 0.5, 0.8]); light /= np.linalg.norm(light)
    shade = np.clip(np.abs(n @ light), 0.15, 1.0)
    depth = tri[:, :, 2].mean(1)
    order = np.argsort(-depth)
    P = px[F].astype(np.int32)
    col = np.array(colour, float)
    for i in order:
        cv2.fillConvexPoly(img, P[i], tuple(int(x) for x in col * (0.35 + 0.65 * shade[i])), lineType=cv2.LINE_AA)
    if skeleton is not None and edges is not None:
        S = skeleton @ R.T
        sp = np.stack([(S[:, 0] - c[0]) * sc + size / 2, size / 2 - (S[:, 1] - c[1]) * sc], 1).astype(int)
        for a, b in edges:
            cv2.line(img, tuple(sp[a]), tuple(sp[b]), (0, 120, 255), 2, cv2.LINE_AA)
    return img
