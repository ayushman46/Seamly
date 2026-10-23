"""Re-encode the bundled sample clips for the web app (H.264 MP4, browser-playable).

    cd backend && ../.venv/bin/python -m tools.make_web_samples <club_clip> <synthetic_clip> <out_dir>

club_clip: "Epping Foresters CC v Great Totham CC at Epping, Essex, England Video 1" by Acabashi,
CC BY-SA 4.0 (Wikimedia Commons); trimmed to the delivery and scaled to 720p (the derivative is CC BY-SA 4.0 too).
"""
import sys
from pathlib import Path

import cv2


def encode(src: str, dst: Path, start: int, end: int | None, max_side: int):
    cap = cv2.VideoCapture(src)
    fps = cap.get(cv2.CAP_PROP_FPS)
    w, h = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    s = min(1.0, max_side / max(w, h))
    size = (int(round(w * s / 2)) * 2, int(round(h * s / 2)) * 2)
    out = cv2.VideoWriter(str(dst), cv2.VideoWriter_fourcc(*"avc1"), fps, size)
    i = n = 0
    while True:
        ok, f = cap.read()
        if not ok or (end is not None and i >= end):
            break
        if i >= start:
            out.write(cv2.resize(f, size, interpolation=cv2.INTER_AREA) if s < 1 else f)
            n += 1
        i += 1
    out.release()
    print(dst.name, f"{n} frames @ {fps:.2f} fps, {size}, {dst.stat().st_size / 1e6:.2f} MB")


if __name__ == "__main__":
    club, synth, out = sys.argv[1], sys.argv[2], Path(sys.argv[3])
    out.mkdir(parents=True, exist_ok=True)
    encode(club, out / "club-side-on.mp4", 20, 150, 1280)
    encode(synth, out / "synthetic-side-on.mp4", 0, None, 1280)
