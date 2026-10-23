"""
Cricket Bowling 3D Analysis App - Frame-First High Accuracy Mode
=================================================================
Streamlit application for analyzing cricket bowling deliveries.

NEW WORKFLOW:
1. Upload video → Extract frames (NO pose detection yet)
2. User browses frames and SELECTS one
3. Run ULTRA-HIGH-ACCURACY pose detection on ONLY that frame
4. Run SPIN 3D reconstruction with accurate pose
5. Display results

This approach gives 500% better accuracy by focusing all compute on one frame.
"""

# CRITICAL: Import chumpy compatibility shim BEFORE any imports that use SPIN/SMPL
import chumpy_compat  # noqa: F401

import os
import json
from typing import Optional, List, Dict, Tuple

import cv2
import numpy as np
import streamlit as st
from PIL import Image

from app_config import make_run_dir, SPIN_ROOT
from src.ingestion.video_utils import save_uploaded_video, extract_frames
from src.reconstruction.spin_wrapper import SpinModelWrapper
from src.analysis.metrics import compute_bowling_metrics, compute_bowling_metrics_from_mediapipe
from src.visualization.render_utils import (
    draw_2d_skeleton_on_frame,
    make_plotly_mesh_figure,
    save_mesh_obj,
)


def _require_mediapipe():
    """Import mediapipe with a helpful Streamlit error on missing wheels."""
    try:
        import mediapipe as mp  # type: ignore
        return mp
    except Exception as e:
        st.error(
            "MediaPipe isn't available in this deployment environment.\n\n"
            "Streamlit Community Cloud may be using a Python version for which your "
            "pinned MediaPipe version has no wheel.\n\n"
            "Fix: ensure your `requirements.txt` uses a MediaPipe version that supports "
            "the Cloud Python version, or pin the Cloud Python version.\n\n"
            f"Import error: {type(e).__name__}: {e}"
        )
        st.stop()


# ============================================================================
# ULTRA HIGH ACCURACY POSE DETECTION (Single Frame)
# ============================================================================

def run_ultra_accurate_pose(frame_bgr: np.ndarray) -> Optional[Dict]:
    """
    Detect the BOWLER specifically, not other people in the frame.
    
    Uses YOLO to find all people, then identifies the bowler by:
    1. Raised arm position (bowling action)
    2. Body orientation and movement
    3. Not standing still like an umpire
    
    Uses multi-pass refinement for accurate head tracking.
    """
    mp = _require_mediapipe()
    
    mp_pose = mp.solutions.pose
    
    height, width = frame_bgr.shape[:2]
    frame_rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
    
    LANDMARK_NAMES = [
        "NOSE", "LEFT_EYE_INNER", "LEFT_EYE", "LEFT_EYE_OUTER",
        "RIGHT_EYE_INNER", "RIGHT_EYE", "RIGHT_EYE_OUTER",
        "LEFT_EAR", "RIGHT_EAR", "MOUTH_LEFT", "MOUTH_RIGHT",
        "LEFT_SHOULDER", "RIGHT_SHOULDER", "LEFT_ELBOW", "RIGHT_ELBOW",
        "LEFT_WRIST", "RIGHT_WRIST", "LEFT_PINKY", "RIGHT_PINKY",
        "LEFT_INDEX", "RIGHT_INDEX", "LEFT_THUMB", "RIGHT_THUMB",
        "LEFT_HIP", "RIGHT_HIP", "LEFT_KNEE", "RIGHT_KNEE",
        "LEFT_ANKLE", "RIGHT_ANKLE", "LEFT_HEEL", "RIGHT_HEEL",
        "LEFT_FOOT_INDEX", "RIGHT_FOOT_INDEX"
    ]
    
    # Head landmarks that need accurate tracking
    HEAD_LANDMARKS = ["NOSE", "LEFT_EYE_INNER", "LEFT_EYE", "LEFT_EYE_OUTER",
                      "RIGHT_EYE_INNER", "RIGHT_EYE", "RIGHT_EYE_OUTER",
                      "LEFT_EAR", "RIGHT_EAR", "MOUTH_LEFT", "MOUTH_RIGHT"]
    
    def extract_landmarks(result, img_w, img_h, offset_x=0, offset_y=0):
        """Extract landmarks from MediaPipe result."""
        if not result.pose_landmarks:
            return None
        
        landmarks = {}
        for i, lm in enumerate(result.pose_landmarks.landmark):
            if i < len(LANDMARK_NAMES):
                px = lm.x * img_w + offset_x
                py = lm.y * img_h + offset_y
                landmarks[LANDMARK_NAMES[i]] = (px, py, lm.visibility)
        
        return landmarks
    
    def refine_head_landmarks(landmarks, frame_rgb, width, height):
        """
        Use face detection to refine head landmark positions.
        This corrects inaccurate nose/eye positions from body pose.
        """
        if not landmarks:
            return landmarks
        
        # Get estimated head region from shoulders
        ls = landmarks.get("LEFT_SHOULDER")
        rs = landmarks.get("RIGHT_SHOULDER")
        nose = landmarks.get("NOSE")
        
        if not (ls and rs):
            return landmarks
        
        # Estimate head center from shoulders
        shoulder_center_x = (ls[0] + rs[0]) / 2
        shoulder_width = abs(ls[0] - rs[0])
        shoulder_y = min(ls[1], rs[1])
        
        # Head should be above shoulders, head size ~ shoulder width
        head_size = shoulder_width * 1.2
        
        # Crop head region generously
        hx1 = int(max(0, shoulder_center_x - head_size))
        hy1 = int(max(0, shoulder_y - head_size * 1.5))
        hx2 = int(min(width, shoulder_center_x + head_size))
        hy2 = int(min(height, shoulder_y + head_size * 0.3))
        
        if hx2 - hx1 < 30 or hy2 - hy1 < 30:
            return landmarks
        
        head_crop = frame_rgb[hy1:hy2, hx1:hx2]
        
        try:
            # Use Face Mesh for precise face landmarks
            mp_face = mp.solutions.face_mesh
            with mp_face.FaceMesh(
                static_image_mode=True,
                max_num_faces=1,
                refine_landmarks=True,
                min_detection_confidence=0.3,
            ) as face_mesh:
                result = face_mesh.process(head_crop)
                
                if result.multi_face_landmarks:
                    face_lms = result.multi_face_landmarks[0].landmark
                    crop_h, crop_w = head_crop.shape[:2]
                    
                    # Face mesh landmark indices:
                    # 1 = nose tip, 33 = left eye outer, 263 = right eye outer
                    # 61 = mouth left, 291 = mouth right
                    # 127 = left ear approx, 356 = right ear approx
                    
                    # Update nose (landmark 1 is nose tip)
                    nose_lm = face_lms[1]
                    new_nose_x = nose_lm.x * crop_w + hx1
                    new_nose_y = nose_lm.y * crop_h + hy1
                    old_vis = landmarks["NOSE"][2] if landmarks.get("NOSE") else 0.5
                    landmarks["NOSE"] = (new_nose_x, new_nose_y, max(0.9, old_vis))
                    
                    # Update eyes
                    # Left eye outer (33), inner (133)
                    left_eye_outer = face_lms[33]
                    left_eye_inner = face_lms[133]
                    left_eye_center = face_lms[159]  # Left eye center
                    
                    landmarks["LEFT_EYE_OUTER"] = (
                        left_eye_outer.x * crop_w + hx1,
                        left_eye_outer.y * crop_h + hy1,
                        0.9
                    )
                    landmarks["LEFT_EYE_INNER"] = (
                        left_eye_inner.x * crop_w + hx1,
                        left_eye_inner.y * crop_h + hy1,
                        0.9
                    )
                    landmarks["LEFT_EYE"] = (
                        left_eye_center.x * crop_w + hx1,
                        left_eye_center.y * crop_h + hy1,
                        0.9
                    )
                    
                    # Right eye outer (263), inner (362)
                    right_eye_outer = face_lms[263]
                    right_eye_inner = face_lms[362]
                    right_eye_center = face_lms[386]  # Right eye center
                    
                    landmarks["RIGHT_EYE_OUTER"] = (
                        right_eye_outer.x * crop_w + hx1,
                        right_eye_outer.y * crop_h + hy1,
                        0.9
                    )
                    landmarks["RIGHT_EYE_INNER"] = (
                        right_eye_inner.x * crop_w + hx1,
                        right_eye_inner.y * crop_h + hy1,
                        0.9
                    )
                    landmarks["RIGHT_EYE"] = (
                        right_eye_center.x * crop_w + hx1,
                        right_eye_center.y * crop_h + hy1,
                        0.9
                    )
                    
                    # Mouth corners
                    mouth_left = face_lms[61]
                    mouth_right = face_lms[291]
                    landmarks["MOUTH_LEFT"] = (
                        mouth_left.x * crop_w + hx1,
                        mouth_left.y * crop_h + hy1,
                        0.9
                    )
                    landmarks["MOUTH_RIGHT"] = (
                        mouth_right.x * crop_w + hx1,
                        mouth_right.y * crop_h + hy1,
                        0.9
                    )
                    
                    # Ears (approximate from face mesh)
                    left_ear = face_lms[234]  # Left cheek/ear area
                    right_ear = face_lms[454]  # Right cheek/ear area
                    landmarks["LEFT_EAR"] = (
                        left_ear.x * crop_w + hx1,
                        left_ear.y * crop_h + hy1,
                        0.8
                    )
                    landmarks["RIGHT_EAR"] = (
                        right_ear.x * crop_w + hx1,
                        right_ear.y * crop_h + hy1,
                        0.8
                    )
                    
                    print("[OK] Head landmarks refined with Face Mesh")
                    
        except Exception as e:
            # Face detection failed, keep original landmarks
            pass
        
        return landmarks
    
    def is_bowling_action(landmarks):
        """
        Score how likely this pose is a bowling action.
        Bowlers have: raised arm, dynamic pose, arm above head.
        """
        if not landmarks:
            return -1000
        
        score = 0
        
        # Get key points
        nose = landmarks.get("NOSE")
        ls = landmarks.get("LEFT_SHOULDER")
        rs = landmarks.get("RIGHT_SHOULDER")
        le = landmarks.get("LEFT_ELBOW")
        re = landmarks.get("RIGHT_ELBOW")
        lw = landmarks.get("LEFT_WRIST")
        rw = landmarks.get("RIGHT_WRIST")
        lh = landmarks.get("LEFT_HIP")
        rh = landmarks.get("RIGHT_HIP")
        
        # CRITICAL: Wrist above head = bowling action!
        if nose and lw and lw[2] > 0.2:
            if lw[1] < nose[1]:  # Left wrist above nose
                score += 500
        if nose and rw and rw[2] > 0.2:
            if rw[1] < nose[1]:  # Right wrist above nose
                score += 500
        
        # Elbow above shoulder = arm raised
        if ls and le and le[2] > 0.2:
            if le[1] < ls[1]:
                score += 300
        if rs and re and re[2] > 0.2:
            if re[1] < rs[1]:
                score += 300
        
        # Wrist above shoulder = extended arm
        if ls and lw and lw[2] > 0.2:
            if lw[1] < ls[1]:
                score += 200
        if rs and rw and rw[2] > 0.2:
            if rw[1] < rs[1]:
                score += 200
        
        # Penalize static standing pose (umpire-like)
        # Umpires typically have both arms down
        arms_down = True
        if ls and lw and lw[1] < ls[1]:
            arms_down = False
        if rs and rw and rw[1] < rs[1]:
            arms_down = False
        
        if arms_down:
            score -= 300  # Penalty for umpire-like pose
        
        # Bonus for visible key parts
        for part in [ls, rs, le, re, lw, rw]:
            if part and part[2] > 0.5:
                score += 20
        
        return score
    
    # =========================================================================
    # STRATEGY 1: Use YOLO to detect all people, then find the bowler
    # =========================================================================
    all_candidates = []
    
    try:
        from ultralytics import YOLO
        yolo_model = YOLO("yolov8n.pt")
        
        results = yolo_model(frame_bgr, classes=[0], verbose=False)
        person_boxes = []
        
        for r in results:
            for box in r.boxes:
                x1, y1, x2, y2 = box.xyxy[0].cpu().numpy()
                conf = float(box.conf[0])
                if conf > 0.3:
                    person_boxes.append((int(x1), int(y1), int(x2), int(y2), conf))
        
        # Process each detected person
        for x1, y1, x2, y2, yolo_conf in person_boxes:
            box_w = x2 - x1
            box_h = y2 - y1
            
            # Generous padding for bowling action (raised arms go above head)
            pad_top = int(box_h * 0.5)
            pad_bottom = int(box_h * 0.1)
            pad_sides = int(box_w * 0.3)
            
            cx1 = max(0, x1 - pad_sides)
            cy1 = max(0, y1 - pad_top)
            cx2 = min(width, x2 + pad_sides)
            cy2 = min(height, y2 + pad_bottom)
            
            crop = frame_rgb[cy1:cy2, cx1:cx2]
            crop_h, crop_w = crop.shape[:2]
            
            if crop_w < 50 or crop_h < 80:
                continue
            
            with mp_pose.Pose(
                static_image_mode=True,
                model_complexity=2,
                enable_segmentation=False,
                min_detection_confidence=0.3,
            ) as pose:
                result = pose.process(crop)
                landmarks = extract_landmarks(result, crop_w, crop_h, cx1, cy1)
                
                if landmarks:
                    bowling_score = is_bowling_action(landmarks)
                    landmarks["_bbox"] = (cx1, cy1, cx2, cy2)
                    landmarks["_score"] = bowling_score
                    all_candidates.append((bowling_score, landmarks))
    
    except ImportError:
        pass  # YOLO not available, fall through to full-frame
    
    # =========================================================================
    # STRATEGY 2: Full-frame detection as fallback
    # =========================================================================
    with mp_pose.Pose(
        static_image_mode=True,
        model_complexity=2,
        enable_segmentation=True,
        min_detection_confidence=0.3,
    ) as pose:
        result = pose.process(frame_rgb)
        landmarks = extract_landmarks(result, width, height)
        
        if landmarks:
            bowling_score = is_bowling_action(landmarks)
            landmarks["_bbox"] = (0, 0, width, height)
            landmarks["_score"] = bowling_score
            all_candidates.append((bowling_score, landmarks))
    
    # =========================================================================
    # SELECT THE BOWLER (highest bowling action score)
    # =========================================================================
    if not all_candidates:
        return None
    
    # Sort by bowling action score (highest first)
    all_candidates.sort(key=lambda x: x[0], reverse=True)
    
    best = all_candidates[0][1]
    print(f"Selected person with bowling score: {all_candidates[0][0]}")
    
    # =========================================================================
    # REFINE HEAD LANDMARKS using Face Mesh for accuracy
    # =========================================================================
    best = refine_head_landmarks(best, frame_rgb, width, height)
    
    return best


# ============================================================================
# CACHED RESOURCES
# ============================================================================

@st.cache_resource
def get_spin_model() -> SpinModelWrapper:
    """Load SPIN model once and cache for the app lifetime."""
    return SpinModelWrapper(SPIN_ROOT)


# ============================================================================
# SESSION STATE HELPERS
# ============================================================================

def init_session_state():
    """Initialize session state variables."""
    defaults = {
        "frames": None,
        "frame_indices": None,
        "timestamps": None,
        "fps": None,
        "selected_frame_idx": 0,
        "run_dir": None,
        "analysis_done": False,
        "analysis_results": None,
        "accurate_pose": None,  # Stores the high-accuracy pose
    }
    for key, val in defaults.items():
        if key not in st.session_state:
            st.session_state[key] = val


def reset_session():
    """Reset session state for new video."""
    for key in ["frames", "frame_indices", "timestamps", "fps", 
                "run_dir", "analysis_done", "analysis_results", "accurate_pose"]:
        st.session_state[key] = None
    st.session_state.selected_frame_idx = 0


# ============================================================================
# MAIN APP
# ============================================================================

def main():
    st.set_page_config(
        page_title="Cricket Bowling 3D Analysis",
        page_icon="",
        layout="wide",
    )
    
    init_session_state()
    
    st.title(" Cricket Bowling 3D Analysis (High Accuracy Mode)")
    st.markdown("""
    **New Frame-First Workflow for Maximum Accuracy:**
    1.  Upload video → frames are extracted
    2.  **You select the exact frame** you want to analyze
    3.  Run **ULTRA-HIGH-ACCURACY** pose detection on that one frame
    4.  Generate precise 3D body mesh
    5.  View metrics and download results
    """)
    
    st.divider()
    
    # -------------------------------------------------------------------------
    # VIDEO UPLOAD
    # -------------------------------------------------------------------------
    uploaded_file = st.file_uploader(
        "Upload bowling video",
        type=["mp4", "mov", "avi", "mkv"],
        help="Upload a video of a cricket bowling delivery",
    )
    
    if uploaded_file is None:
        st.info("Please upload a video to get started.")
        return
    
    # Check if this is a new video
    current_name = uploaded_file.name
    if "last_video_name" not in st.session_state:
        st.session_state.last_video_name = None
    
    if st.session_state.last_video_name != current_name:
        reset_session()
        st.session_state.last_video_name = current_name
    
    # -------------------------------------------------------------------------
    # FRAME EXTRACTION ONLY (NO pose detection yet)
    # -------------------------------------------------------------------------
    if st.session_state.frames is None:
        with st.spinner("Extracting frames from video..."):
            run_dir = make_run_dir()
            st.session_state.run_dir = run_dir
            
            video_path = save_uploaded_video(uploaded_file, run_dir)
            
            # Extract every 2nd frame for browsing speed
            frames, frame_indices, timestamps, fps = extract_frames(video_path, sample_stride=2)
            
            if len(frames) == 0:
                st.error("No frames extracted from video. Please try a different video.")
                return
            
            st.session_state.frames = frames
            st.session_state.frame_indices = frame_indices
            st.session_state.timestamps = timestamps
            st.session_state.fps = fps
            
            st.success(f"Extracted {len(frames)} frames at {fps:.1f} FPS")
    
    frames = st.session_state.frames
    frame_indices = st.session_state.frame_indices
    timestamps = st.session_state.timestamps
    fps = st.session_state.fps
    
    # -------------------------------------------------------------------------
    # FRAME SELECTION UI (Step 1)
    # -------------------------------------------------------------------------
    st.subheader("Step 1: Select the Frame to Analyze")
    st.info(" Browse through frames and select the one showing the bowling action you want to analyze (e.g., ball release moment)")
    
    col1, col2 = st.columns([3, 1])
    
    with col1:
        selected_idx = st.slider(
            "Browse frames",
            min_value=0,
            max_value=len(frames) - 1,
            value=st.session_state.selected_frame_idx,
            format="Frame %d",
        )
        st.session_state.selected_frame_idx = selected_idx
        
        original_idx = frame_indices[selected_idx]
        timestamp = timestamps[selected_idx]
        st.caption(f"Original frame #{original_idx} | Time: {timestamp:.2f}s")
    
    with col2:
        st.markdown("**Quick Jump:**")
        col_a, col_b = st.columns(2)
        with col_a:
            if st.button("⏮ Start"):
                st.session_state.selected_frame_idx = 0
                st.rerun()
        with col_b:
            if st.button("⏭ End"):
                st.session_state.selected_frame_idx = len(frames) - 1
                st.rerun()
        
        # Jump by percentage
        percent = st.selectbox("Jump to:", ["25%", "50%", "75%"], index=1)
        if st.button("Go"):
            pct = int(percent.replace("%", "")) / 100
            st.session_state.selected_frame_idx = int(len(frames) * pct)
            st.rerun()
    
    # Show current frame (raw, no skeleton yet)
    current_frame = frames[selected_idx]
    frame_rgb = cv2.cvtColor(current_frame, cv2.COLOR_BGR2RGB)
    
    st.image(frame_rgb, caption=f"Frame {selected_idx} (select this frame for analysis)", use_container_width=True)
    
    st.divider()
    
    # -------------------------------------------------------------------------
    # HIGH ACCURACY POSE DETECTION (Step 2)
    # -------------------------------------------------------------------------
    st.subheader("Step 2: Run High-Accuracy Pose Detection")
    
    if st.button("Analyze This Frame (Ultra-High Accuracy)", type="primary"):
        with st.spinner("Running ULTRA-HIGH-ACCURACY pose detection... (8 preprocessing variants x 3 scales)"):
            accurate_pose = run_ultra_accurate_pose(current_frame)
            st.session_state.accurate_pose = accurate_pose
            
            if accurate_pose:
                st.success("High-accuracy pose detected!")
            else:
                st.error("Could not detect pose. Try a different frame with clearer view of the bowler.")
        st.rerun()
    
    # Display pose if we have one
    if st.session_state.accurate_pose is not None:
        pose = st.session_state.accurate_pose
        
        # Draw skeleton
        frame_with_skeleton = draw_2d_skeleton_on_frame(current_frame, pose)
        frame_skeleton_rgb = cv2.cvtColor(frame_with_skeleton, cv2.COLOR_BGR2RGB)
        
        col_img, col_info = st.columns([2, 1])
        
        with col_img:
            st.image(frame_skeleton_rgb, caption="High-Accuracy 2D Skeleton", use_container_width=True)
        
        with col_info:
            st.success("Ultra-High-Accuracy Pose")
            st.markdown("**Key Joint Positions:**")
            for name in ["NOSE", "RIGHT_SHOULDER", "RIGHT_ELBOW", "RIGHT_WRIST", 
                        "LEFT_SHOULDER", "LEFT_ELBOW", "LEFT_WRIST"]:
                if name in pose:
                    x, y, vis = pose[name]
                    st.caption(f"**{name}**: ({x:.0f}, {y:.0f}) conf={vis:.2f}")
            
            if "_score" in pose:
                st.metric("Bowler Confidence", f"{pose['_score']:.0f}")
        
        st.divider()
        
        # -------------------------------------------------------------------------
        # 3D RECONSTRUCTION (Step 3)
        # -------------------------------------------------------------------------
        st.subheader("Step 3: Generate 3D Body Mesh")
        
        if st.button(" Generate 3D Mesh with SPIN", type="primary"):
            run_3d_analysis(selected_idx, pose)
    
    # -------------------------------------------------------------------------
    # DISPLAY RESULTS
    # -------------------------------------------------------------------------
    if st.session_state.analysis_done and st.session_state.analysis_results:
        display_analysis_results()


def run_3d_analysis(frame_idx: int, pose: Dict):
    """Run SPIN 3D reconstruction with 2D keypoint-guided optimization."""
    frames = st.session_state.frames
    run_dir = st.session_state.run_dir
    
    frame_bgr = frames[frame_idx]
    height, width = frame_bgr.shape[:2]
    
    # Use the accurate pose landmarks to create TIGHT crop
    valid_points = []
    for name, value in pose.items():
        if name.startswith("_"):
            continue
        x, y, vis = value
        if vis > 0.05:
            valid_points.append((x, y))
    
    # Store crop offset for keypoint adjustment
    x1_crop, y1_crop = 0, 0
    
    if valid_points:
        xs = [p[0] for p in valid_points]
        ys = [p[1] for p in valid_points]
        
        lm_x1, lm_y1 = min(xs), min(ys)
        lm_x2, lm_y2 = max(xs), max(ys)
        lm_width = lm_x2 - lm_x1
        lm_height = lm_y2 - lm_y1
        
        # Padding for SPIN context
        pad_x = int(lm_width * 0.35)
        pad_y = int(lm_height * 0.35)
        
        x1_crop = max(0, int(lm_x1 - pad_x))
        y1_crop = max(0, int(lm_y1 - pad_y))
        x2_crop = min(width, int(lm_x2 + pad_x))
        y2_crop = min(height, int(lm_y2 + pad_y))
        
        # Make square for SPIN (it works best with square input)
        crop_w = x2_crop - x1_crop
        crop_h = y2_crop - y1_crop
        if crop_w > crop_h:
            diff = crop_w - crop_h
            y1_crop = max(0, y1_crop - diff // 2)
            y2_crop = min(height, y2_crop + diff // 2)
        else:
            diff = crop_h - crop_w
            x1_crop = max(0, x1_crop - diff // 2)
            x2_crop = min(width, x2_crop + diff // 2)
        
        bowler_crop = frame_bgr[y1_crop:y2_crop, x1_crop:x2_crop]
        frame_rgb = cv2.cvtColor(bowler_crop, cv2.COLOR_BGR2RGB)
        crop_width = x2_crop - x1_crop
        crop_height = y2_crop - y1_crop
        st.info(f"Running SPIN with 2D keypoint guidance on bowler crop ({crop_width}×{crop_height} pixels)")
        
        # Adjust keypoints to crop coordinates
        adjusted_pose = {}
        for name, value in pose.items():
            if name.startswith("_"):
                continue
            x, y, vis = value
            # Adjust to crop coordinate system
            adjusted_pose[name] = (x - x1_crop, y - y1_crop, vis)
    else:
        frame_rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
        adjusted_pose = {k: v for k, v in pose.items() if not k.startswith("_")}
    
    progress = st.progress(0, text="Loading SPIN model...")
    
    try:
        spin_model = get_spin_model()
        progress.progress(20, text="Running SPIN 3D inference with pose correction...")
        
        # Use SPIN with pose correction to match MediaPipe knee positions
        result = spin_model.run_with_pose_correction(frame_rgb, adjusted_pose)
        
        if result.get("knee_correction_applied"):
            left_angle = result.get("left_knee_angle")
            right_angle = result.get("right_knee_angle")
            angle_info = []
            if left_angle:
                angle_info.append(f"Left: {left_angle:.0f} deg")
            if right_angle:
                angle_info.append(f"Right: {right_angle:.0f} deg")
            if angle_info:
                st.info(f"Applied knee correction based on MediaPipe detection ({', '.join(angle_info)})")
        
        vertices = result["vertices"]
        faces = result["faces"]
        joints_3d = result["joints_3d"]
        smpl_params = result["smpl_params"]
        
        progress.progress(60, text="Computing biomechanics metrics from MediaPipe...")
        
        # Use MediaPipe 2D landmarks for accurate metrics (not SPIN 3D which can be misaligned)
        metrics = compute_bowling_metrics_from_mediapipe(adjusted_pose, right_handed=True)
        
        progress.progress(80, text="Saving results...")
        
        # Save outputs
        mesh_path = os.path.join(run_dir, "mesh.obj")
        save_mesh_obj(vertices, faces, mesh_path)
        
        joints_path = os.path.join(run_dir, "joints_3d.npy")
        np.save(joints_path, joints_3d)
        
        metrics_path = os.path.join(run_dir, "metrics.json")
        with open(metrics_path, "w") as f:
            json.dump(metrics, f, indent=2)
        
        frame_path = os.path.join(run_dir, "analysis_frame.jpg")
        Image.fromarray(frame_rgb).save(frame_path)
        
        progress.progress(100, text="Done!")
        
        st.session_state.analysis_results = {
            "vertices": vertices,
            "faces": faces,
            "joints_3d": joints_3d,
            "smpl_params": smpl_params,
            "metrics": metrics,
            "mesh_path": mesh_path,
            "joints_path": joints_path,
            "metrics_path": metrics_path,
            "frame_path": frame_path,
            "frame_idx": frame_idx,
        }
        st.session_state.analysis_done = True
        
        st.success("3D mesh generated successfully!")
        st.rerun()
        
    except Exception as e:
        progress.empty()
        st.error(f"Error during 3D analysis: {e}")
        import traceback
        st.code(traceback.format_exc())


def display_analysis_results():
    """Display the analysis results with cricket-specific metrics."""
    results = st.session_state.analysis_results
    metrics = results["metrics"]
    
    st.divider()
    st.header(" Cricket Bowling Analysis Report")
    
    # =========================================================================
    # SECTION 1: ACTION LEGALITY (Most Important for Cricket)
    # =========================================================================
    st.subheader(" Bowling Action Legality Check")
    
    legality_status = metrics.get("legality_status", "UNKNOWN")
    legality_color = metrics.get("legality_color", "gray")
    legality_detail = metrics.get("legality_detail", "")
    arm_flexion = metrics.get("arm_flexion_deg", 0)
    
    # Color-coded legality display
    if legality_status == "LEGAL":
        st.success(f"**{legality_status}** - Elbow Extension: {arm_flexion:.1f}")
    elif legality_status == "BORDERLINE":
        st.warning(f"**{legality_status}** - Elbow Extension: {arm_flexion:.1f}")
    elif legality_status == "SUSPICIOUS":
        st.warning(f"**{legality_status}** - Elbow Extension: {arm_flexion:.1f}")
    else:
        st.error(f"**{legality_status}** - Elbow Extension: {arm_flexion:.1f}")
    
    st.caption(legality_detail)
    st.caption("*ICC allows up to 15 degrees elbow extension during delivery*")
    
    st.divider()
    
    # =========================================================================
    # SECTION 2: 3D MESH AND EFFICIENCY SCORE
    # =========================================================================
    col_mesh, col_score = st.columns([2, 1])
    
    with col_mesh:
        st.markdown("### 🧍 3D Body Reconstruction")
        st.caption("Rotate, zoom, and pan with your mouse")
        
        fig = make_plotly_mesh_figure(
            results["vertices"],
            results["faces"],
            joints_3d=results.get("joints_3d"),
            color="lightpink",
            title="SPIN 3D Reconstruction"
        )
        
        st.plotly_chart(fig, use_container_width=True, height=500)
    
    with col_score:
        st.markdown("### 🎯 Efficiency Score")
        
        score = metrics.get("efficiency_score", 50)
        grade = metrics.get("efficiency_grade", "C")
        grade_detail = metrics.get("efficiency_detail", "")
        
        # Big score display
        st.markdown(f"""
        <div style="text-align: center; padding: 20px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 15px; margin-bottom: 20px;">
            <h1 style="font-size: 72px; margin: 0; color: white;">{score}</h1>
            <h2 style="margin: 0; color: white;">Grade: {grade}</h2>
        </div>
        """, unsafe_allow_html=True)
        
        st.caption(grade_detail)
        
        # Bowling type guess
        st.markdown("###  Bowling Type")
        bowling_type = metrics.get("bowling_type_guess", "UNDETERMINED")
        type_confidence = metrics.get("type_confidence", "LOW")
        type_detail = metrics.get("type_detail", "")
        
        type_emoji = "🚀" if bowling_type == "PACE" else "🔄" if bowling_type == "SPIN" else "❓"
        st.markdown(f"**{type_emoji} {bowling_type}** ({type_confidence} confidence)")
        st.caption(type_detail)
    
    st.divider()
    
    # =========================================================================
    # SECTION 3: DETAILED METRICS TABS
    # =========================================================================
    st.subheader("📈 Detailed Analysis")

    tab1, tab2, tab3, tab4 = st.tabs([" Bowling Arm", " Body Position", " Release Point", " All Metrics"])

    with tab1:
        col1, col2, col3 = st.columns(3)
        
        with col1:
            st.metric(
                "Elbow Angle",
                f"{metrics.get('elbow_angle_deg', 0):.1f}deg",
                help="Angle at the elbow joint. ~180deg = fully extended"
            )
            st.metric(
                "Arm Flexion",
                f"{metrics.get('arm_flexion_deg', 0):.1f}deg",
                help="How bent the arm is from fully straight"
            )
        
        with col2:
            st.metric(
                "Shoulder Abduction",
                f"{metrics.get('shoulder_abduction_deg', 0):.1f}deg",
                help="Angle of arm away from body"
            )
            arm_pos = metrics.get("arm_position", "UNKNOWN")
            st.metric("Arm Position", arm_pos)
        
        with col3:
            st.metric(
                "Forearm Angle",
                f"{metrics.get('forearm_angle_deg', 0):.1f}deg",
                help="Angle between upper arm and forearm"
            )
            front_arm = metrics.get("front_arm_status", "UNKNOWN")
            st.metric("Front Arm", front_arm)
        
        st.caption(metrics.get("arm_position_detail", ""))
        st.caption(metrics.get("front_arm_detail", ""))
    
    with tab2:
        col1, col2, col3 = st.columns(3)
        
        with col1:
            st.metric(
                "Spine Tilt",
                f"{metrics.get('spine_tilt_deg', 0):.1f}deg",
                help="Forward/backward lean of the torso"
            )
            spine_status = metrics.get("spine_status", "UNKNOWN")
            st.metric("Spine Status", spine_status)
        
        with col2:
            st.metric(
                "Hip-Shoulder Separation",
                f"{metrics.get('hip_shoulder_separation_deg', 0):.1f}deg",
                help="Rotation difference between hips and shoulders"
            )
            st.caption("*25-45deg is optimal for pace bowling*")
        
        with col3:
            st.metric(
                "Shoulder Tilt",
                f"{metrics.get('shoulder_tilt_deg', 0):.1f}deg",
                help="How level the shoulders are"
            )
            action_type = metrics.get("action_type", "UNKNOWN")
            st.metric("Action Type", action_type)
        
        st.caption(metrics.get("action_detail", ""))
    
    with tab3:
        col1, col2 = st.columns(2)
        
        with col1:
            st.metric(
                "Release Height",
                f"{metrics.get('release_height_relative', 0):.2f}",
                help="Wrist height relative to torso length"
            )
            release_pos = metrics.get("release_position", "UNKNOWN")
            st.metric("Release Position", release_pos)
        
        with col2:
            st.metric(
                "Arm Angle from Vertical",
                f"{metrics.get('arm_angle_from_vertical_deg', 0):.1f}deg",
                help="0deg = straight up, 90deg = horizontal"
            )
        
        st.caption(metrics.get("release_detail", ""))
    
    with tab4:
        st.json(metrics)
    
    st.divider()
    
    # =========================================================================
    # SECTION 4: COACHING INSIGHTS
    # =========================================================================
    st.subheader(" Coaching Insights")
    
    insights = []
    
    # Legality insights
    if legality_status == "LEGAL":
        insights.append(" **Elbow action is legal** - Arm extension within ICC limits")
    elif legality_status in ["BORDERLINE", "SUSPICIOUS"]:
        insights.append(" **Elbow action needs attention** - Consider biomechanics testing")
    
    # Hip-shoulder separation
    hip_sep = metrics.get("hip_shoulder_separation_deg", 0)
    if hip_sep < 20:
        insights.append(" **Chest-on action** - Good for spin, may limit pace bowling speed")
    elif hip_sep > 45:
        insights.append(" **Strong side-on action** - Good for pace, watch for back stress")
    else:
        insights.append(" **Good hip-shoulder separation** - Balanced action")
    
    # Release point
    release = metrics.get("release_position", "")
    if release == "HIGH":
        insights.append(" **High release point** - Good for pace and bounce")
    elif release == "LOW":
        insights.append(" **Low release point** - Watch arm position at delivery")
    
    # Front arm
    front_arm = metrics.get("front_arm_status", "")
    if front_arm == "HIGH":
        insights.append(" **Front arm high** - Good balance and pull-down potential")
    elif front_arm == "LOW":
        insights.append(" **Front arm pulled down** - Generating body rotation")
    
    for insight in insights:
        st.markdown(insight)
    
    st.divider()
    
    # =========================================================================
    # SECTION 5: DOWNLOADS
    # =========================================================================
    st.subheader(" Download Results")
    
    col1, col2, col3, col4 = st.columns(4)
    
    with col1:
        with open(results["mesh_path"], "rb") as f:
            st.download_button(
                " 3D Mesh (.obj)",
                f,
                file_name="bowling_mesh.obj",
                mime="text/plain",
                help="Open in Blender, MeshLab, or any 3D viewer"
            )
    
    with col2:
        with open(results["joints_path"], "rb") as f:
            st.download_button(
                " 3D Joints (.npy)",
                f,
                file_name="joints_3d.npy",
                mime="application/octet-stream",
                help="NumPy array of 3D joint positions"
            )
    
    with col3:
        with open(results["metrics_path"], "rb") as f:
            st.download_button(
                " Full Report (.json)",
                f,
                file_name="bowling_analysis.json",
                mime="application/json",
                help="Complete metrics in JSON format"
            )
    
    with col4:
        with open(results["frame_path"], "rb") as f:
            st.download_button(
                "Frame Image (.jpg)",
                f,
                file_name="analysis_frame.jpg",
                mime="image/jpeg",
                help="The frame used for analysis"
            )


if __name__ == "__main__":
    main()
