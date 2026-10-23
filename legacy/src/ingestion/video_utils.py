import os
from typing import Dict, Any, List, Tuple

import cv2
import numpy as np


def save_uploaded_video(uploaded_file, run_dir: str) -> str:
    """
    Save a Streamlit uploaded file object to disk as input_video.mp4.
    Returns the full path.
    """
    video_path = os.path.join(run_dir, "input_video.mp4")
    with open(video_path, "wb") as f:
        f.write(uploaded_file.getbuffer())
    return video_path


def extract_frames(
    video_path: str,
    sample_stride: int = 1
) -> Tuple[List[np.ndarray], List[int], List[float], float]:
    """
    Extract frames from the given video file.
    
    Args:
        video_path: Path to the video file.
        sample_stride: Sample every Nth frame (default=1 means all frames).
        
    Returns:
        frames: List of BGR images (np.ndarray).
        frame_indices: List of original frame indices.
        timestamps: List of timestamps in seconds.
        fps: Video FPS.
        
    Note: Frames are returned in BGR format (OpenCV default).
    """
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise RuntimeError(f"Could not open video: {video_path}")

    fps = cap.get(cv2.CAP_PROP_FPS)
    if fps <= 0:
        fps = 30.0  # fallback

    frames: List[np.ndarray] = []
    frame_indices: List[int] = []
    timestamps: List[float] = []
    
    frame_idx = 0
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        
        if frame_idx % sample_stride == 0:
            frames.append(frame)  # BGR format
            frame_indices.append(frame_idx)
            timestamps.append(frame_idx / fps)
        
        frame_idx += 1

    cap.release()
    return frames, frame_indices, timestamps, float(fps)


def load_frame(video_path: str, frame_idx: int) -> np.ndarray:
    """
    Random-access a specific frame index from the video.
    Returns an RGB image (H, W, 3).
    """
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise RuntimeError(f"Could not open video: {video_path}")

    cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
    ret, frame_bgr = cap.read()
    cap.release()
    if not ret:
        raise RuntimeError(f"Could not read frame {frame_idx} from {video_path}")

    frame_rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
    return frame_rgb
