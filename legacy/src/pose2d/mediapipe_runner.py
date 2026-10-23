"""
MediaPipe Pose Runner with YOLO Detection - High Precision Mode

This module provides HIGHLY ACCURATE joint placement for cricket bowling analysis.
Key improvements:
- High-resolution processing (2x upscaling)
- Anatomical joint refinement
- Multi-scale landmark fusion
- Sub-pixel coordinate precision
"""
from typing import Dict, List, Optional, Tuple
import cv2
import numpy as np
import mediapipe as mp

try:
    from ultralytics import YOLO
    YOLO_AVAILABLE = True
except ImportError:
    YOLO_AVAILABLE = False

mp_pose = mp.solutions.pose

# All 33 MediaPipe landmarks
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

# Anatomical constraints: (joint, parent, min_ratio, max_ratio) relative to torso length
ANATOMICAL_CONSTRAINTS = {
    "arm_upper": (0.25, 0.45),  # Upper arm relative to torso
    "arm_lower": (0.20, 0.40),  # Forearm relative to torso
    "leg_upper": (0.40, 0.60),  # Thigh relative to torso
    "leg_lower": (0.35, 0.55),  # Lower leg relative to torso
}

_yolo_model = None
_pose_model = None


def _get_yolo_model():
    global _yolo_model
    if _yolo_model is None and YOLO_AVAILABLE:
        _yolo_model = YOLO("yolov8n.pt")
    return _yolo_model


def _get_pose_model():
    """Get persistent pose model for consistency."""
    global _pose_model
    if _pose_model is None:
        _pose_model = mp_pose.Pose(
            static_image_mode=True,
            model_complexity=2,  # Highest accuracy
            enable_segmentation=False,
            min_detection_confidence=0.1,
            min_tracking_confidence=0.1,
        )
    return _pose_model


def _detect_people_yolo(frame_bgr: np.ndarray) -> List[Tuple[int, int, int, int, float]]:
    """Detect all people using YOLO."""
    model = _get_yolo_model()
    if model is None:
        return []
    
    results = model(frame_bgr, classes=[0], verbose=False)
    
    boxes = []
    for r in results:
        for box in r.boxes:
            x1, y1, x2, y2 = box.xyxy[0].cpu().numpy()
            conf = float(box.conf[0].cpu().numpy())
            if conf > 0.2:
                boxes.append((int(x1), int(y1), int(x2), int(y2), conf))
    
    return boxes


def _expand_bbox(bbox, frame_width, frame_height):
    """Expand bounding box to capture full body including raised arms."""
    x1, y1, x2, y2 = bbox
    w, h = x2 - x1, y2 - y1
    
    # Expand upward significantly for raised arms
    y1_new = max(0, y1 - int(h * 0.5))
    y2_new = min(frame_height, y2 + int(h * 0.1))
    
    # Moderate sideways expansion
    x1_new = max(0, x1 - int(w * 0.2))
    x2_new = min(frame_width, x2 + int(w * 0.2))
    
    return (x1_new, y1_new, x2_new, y2_new)


def _high_quality_upscale(image: np.ndarray, scale: float = 2.0) -> np.ndarray:
    """Upscale image with high-quality interpolation for better landmark detection."""
    return cv2.resize(image, None, fx=scale, fy=scale, interpolation=cv2.INTER_LANCZOS4)


def _preprocess_for_accuracy(frame_rgb: np.ndarray) -> List[Tuple[np.ndarray, float]]:
    """
    Create preprocessed versions optimized for joint placement accuracy.
    Returns list of (image, scale) tuples.
    """
    versions = []
    
    # 1. Original at 2x scale - primary high-res detection
    upscaled_2x = _high_quality_upscale(frame_rgb, 2.0)
    versions.append((upscaled_2x, 2.0))
    
    # 2. Enhanced contrast at 2x - for white clothing
    contrast = cv2.convertScaleAbs(frame_rgb, alpha=1.3, beta=5)
    contrast_2x = _high_quality_upscale(contrast, 2.0)
    versions.append((contrast_2x, 2.0))
    
    # 3. CLAHE enhanced at 2x - best for limbs
    lab = cv2.cvtColor(frame_rgb, cv2.COLOR_RGB2LAB)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    lab[:, :, 0] = clahe.apply(lab[:, :, 0])
    clahe_img = cv2.cvtColor(lab, cv2.COLOR_LAB2RGB)
    clahe_2x = _high_quality_upscale(clahe_img, 2.0)
    versions.append((clahe_2x, 2.0))
    
    # 4. Original scale for speed/fallback
    versions.append((frame_rgb, 1.0))
    
    return versions


def _run_pose_single(pose_model, image: np.ndarray, scale: float, 
                     orig_width: int, orig_height: int,
                     x_offset: float, y_offset: float) -> Optional[Dict]:
    """Run pose detection on single image and convert coordinates back."""
    results = pose_model.process(image)
    
    if not results.pose_landmarks:
        return None
    
    landmarks = {}
    total_confidence = 0
    count = 0
    
    for i, lm in enumerate(results.pose_landmarks.landmark):
        if i < len(LANDMARK_NAMES):
            # Convert scaled coordinates back to original
            x = (lm.x * orig_width * scale) / scale + x_offset
            y = (lm.y * orig_height * scale) / scale + y_offset
            vis = lm.visibility
            
            landmarks[LANDMARK_NAMES[i]] = (float(x), float(y), float(vis))
            total_confidence += vis
            count += 1
    
    if count > 0:
        landmarks["_avg_confidence"] = total_confidence / count
    
    return landmarks


def _weighted_average_landmarks(detections: List[Dict]) -> Dict:
    """
    Merge landmark detections using WEIGHTED averaging based on visibility.
    This produces smoother, more accurate joint positions.
    """
    if not detections:
        return {}
    if len(detections) == 1:
        return detections[0]
    
    merged = {}
    
    for name in LANDMARK_NAMES:
        total_weight = 0
        weighted_x = 0
        weighted_y = 0
        max_vis = 0
        
        for det in detections:
            if name in det:
                x, y, vis = det[name]
                if vis > 0.05:  # Only include if somewhat visible
                    # Use visibility^2 as weight to strongly prefer high-confidence
                    weight = vis * vis
                    weighted_x += x * weight
                    weighted_y += y * weight
                    total_weight += weight
                    max_vis = max(max_vis, vis)
        
        if total_weight > 0:
            merged[name] = (
                weighted_x / total_weight,
                weighted_y / total_weight,
                max_vis
            )
    
    return merged


def _refine_landmarks_anatomical(landmarks: Dict, orig_width: int, orig_height: int) -> Dict:
    """
    Apply anatomical refinement to improve joint placement accuracy.
    Uses body proportions to correct obviously wrong positions.
    """
    if not landmarks:
        return landmarks
    
    refined = dict(landmarks)
    
    # Get key reference points
    left_shoulder = landmarks.get("LEFT_SHOULDER")
    right_shoulder = landmarks.get("RIGHT_SHOULDER")
    left_hip = landmarks.get("LEFT_HIP")
    right_hip = landmarks.get("RIGHT_HIP")
    
    # Need at least shoulders and hips for refinement
    if not all([left_shoulder, right_shoulder, left_hip, right_hip]):
        return landmarks
    
    # Calculate torso length (for proportional checks)
    shoulder_mid = ((left_shoulder[0] + right_shoulder[0]) / 2,
                    (left_shoulder[1] + right_shoulder[1]) / 2)
    hip_mid = ((left_hip[0] + right_hip[0]) / 2,
               (left_hip[1] + right_hip[1]) / 2)
    torso_length = np.sqrt((shoulder_mid[0] - hip_mid[0])**2 + 
                           (shoulder_mid[1] - hip_mid[1])**2)
    
    if torso_length < 10:  # Too small to process
        return landmarks
    
    # Shoulder width for reference
    shoulder_width = np.sqrt((left_shoulder[0] - right_shoulder[0])**2 +
                             (left_shoulder[1] - right_shoulder[1])**2)
    
    # Refine elbow positions - should be roughly between shoulder and wrist
    for side in ["LEFT", "RIGHT"]:
        shoulder = landmarks.get(f"{side}_SHOULDER")
        elbow = landmarks.get(f"{side}_ELBOW")
        wrist = landmarks.get(f"{side}_WRIST")
        
        if shoulder and elbow and wrist:
            # Check if elbow is reasonable (between shoulder and wrist)
            shoulder_to_wrist = np.sqrt((shoulder[0] - wrist[0])**2 + 
                                        (shoulder[1] - wrist[1])**2)
            shoulder_to_elbow = np.sqrt((shoulder[0] - elbow[0])**2 + 
                                        (shoulder[1] - elbow[1])**2)
            
            # Elbow should be 35-65% of the way from shoulder to wrist
            if shoulder_to_wrist > 10:
                ratio = shoulder_to_elbow / shoulder_to_wrist
                
                if ratio < 0.30 or ratio > 0.70:
                    # Elbow position seems off, use geometric interpolation
                    # Place elbow at 45% along shoulder-wrist vector
                    new_x = shoulder[0] + 0.45 * (wrist[0] - shoulder[0])
                    new_y = shoulder[1] + 0.45 * (wrist[1] - shoulder[1])
                    
                    # Blend with original (don't completely override)
                    blend = 0.3  # 30% correction
                    refined[f"{side}_ELBOW"] = (
                        elbow[0] * (1 - blend) + new_x * blend,
                        elbow[1] * (1 - blend) + new_y * blend,
                        elbow[2]
                    )
    
    # Refine knee positions - should be between hip and ankle
    for side in ["LEFT", "RIGHT"]:
        hip = landmarks.get(f"{side}_HIP")
        knee = landmarks.get(f"{side}_KNEE")
        ankle = landmarks.get(f"{side}_ANKLE")
        
        if hip and knee and ankle:
            hip_to_ankle = np.sqrt((hip[0] - ankle[0])**2 + 
                                   (hip[1] - ankle[1])**2)
            hip_to_knee = np.sqrt((hip[0] - knee[0])**2 + 
                                  (hip[1] - knee[1])**2)
            
            if hip_to_ankle > 10:
                ratio = hip_to_knee / hip_to_ankle
                
                if ratio < 0.35 or ratio > 0.65:
                    # Knee position seems off
                    new_x = hip[0] + 0.50 * (ankle[0] - hip[0])
                    new_y = hip[1] + 0.50 * (ankle[1] - hip[1])
                    
                    blend = 0.25
                    refined[f"{side}_KNEE"] = (
                        knee[0] * (1 - blend) + new_x * blend,
                        knee[1] * (1 - blend) + new_y * blend,
                        knee[2]
                    )
    
    # Refine wrist to be at end of forearm (if hand landmarks are available)
    for side in ["LEFT", "RIGHT"]:
        wrist = landmarks.get(f"{side}_WRIST")
        index = landmarks.get(f"{side}_INDEX")
        pinky = landmarks.get(f"{side}_PINKY")
        
        if wrist and index and pinky:
            # Average of index and pinky gives approximate hand center
            hand_center_x = (index[0] + pinky[0]) / 2
            hand_center_y = (index[1] + pinky[1]) / 2
            
            # Wrist should be slightly before hand center
            # If hand center is detected with higher confidence, adjust wrist
            if index[2] > wrist[2] * 1.2 or pinky[2] > wrist[2] * 1.2:
                elbow = landmarks.get(f"{side}_ELBOW")
                if elbow:
                    # Wrist is between elbow and hand center
                    new_x = elbow[0] + 0.85 * (hand_center_x - elbow[0])
                    new_y = elbow[1] + 0.85 * (hand_center_y - elbow[1])
                    
                    blend = 0.2
                    refined[f"{side}_WRIST"] = (
                        wrist[0] * (1 - blend) + new_x * blend,
                        wrist[1] * (1 - blend) + new_y * blend,
                        max(wrist[2], (index[2] + pinky[2]) / 2)
                    )
    
    return refined


def _smooth_landmarks(landmarks: Dict, window_size: int = 3) -> Dict:
    """
    Apply gaussian-like smoothing to reduce jitter in landmark positions.
    This operates on a single frame's landmarks to reduce noise.
    """
    if not landmarks:
        return landmarks
    
    # For single-frame smoothing, we can use neighboring joint positions
    # to validate and slightly adjust each joint
    smoothed = dict(landmarks)
    
    # Pairs of joints that should have consistent relative positions
    joint_pairs = [
        ("LEFT_SHOULDER", "LEFT_ELBOW"),
        ("LEFT_ELBOW", "LEFT_WRIST"),
        ("RIGHT_SHOULDER", "RIGHT_ELBOW"),
        ("RIGHT_ELBOW", "RIGHT_WRIST"),
        ("LEFT_HIP", "LEFT_KNEE"),
        ("LEFT_KNEE", "LEFT_ANKLE"),
        ("RIGHT_HIP", "RIGHT_KNEE"),
        ("RIGHT_KNEE", "RIGHT_ANKLE"),
    ]
    
    # For each pair, ensure the joint positions make anatomical sense
    for joint1, joint2 in joint_pairs:
        pos1 = landmarks.get(joint1)
        pos2 = landmarks.get(joint2)
        
        if pos1 and pos2 and pos1[2] > 0.1 and pos2[2] > 0.1:
            # Check the distance between joints
            dist = np.sqrt((pos1[0] - pos2[0])**2 + (pos1[1] - pos2[1])**2)
            
            # If distance is very small (joints overlapping), spread them apart
            if dist < 5:
                # Move joint2 away from joint1 slightly
                direction_x = 0.1 if pos2[0] >= pos1[0] else -0.1
                direction_y = 0.1 if pos2[1] >= pos1[1] else -0.1
                
                smoothed[joint2] = (
                    pos2[0] + direction_x * 20,
                    pos2[1] + direction_y * 20,
                    pos2[2]
                )
    
    return smoothed


def _run_high_precision_pose(
    frame_rgb: np.ndarray,
    x_offset: float = 0,
    y_offset: float = 0
) -> Optional[Dict[str, Tuple[float, float, float]]]:
    """
    Run HIGH PRECISION pose detection with multi-scale processing and refinement.
    """
    height, width = frame_rgb.shape[:2]
    
    # Get preprocessed versions at different scales
    versions = _preprocess_for_accuracy(frame_rgb)
    
    pose_model = _get_pose_model()
    all_detections = []
    
    for img, scale in versions:
        result = _run_pose_single(
            pose_model, img, scale, 
            width, height, x_offset, y_offset
        )
        if result:
            all_detections.append(result)
    
    if not all_detections:
        return None
    
    # Weighted merge of all detections
    merged = _weighted_average_landmarks(all_detections)
    
    # Apply anatomical refinement
    refined = _refine_landmarks_anatomical(merged, width, height)
    
    # Apply smoothing
    smoothed = _smooth_landmarks(refined)
    
    return smoothed


def _score_as_bowler(landmarks, bbox, frame_width, frame_height):
    """Score how likely this person is the bowler."""
    score = 0.0
    x1, y1, x2, y2 = bbox
    
    right_wrist = landmarks.get("RIGHT_WRIST")
    left_wrist = landmarks.get("LEFT_WRIST")
    right_shoulder = landmarks.get("RIGHT_SHOULDER")
    left_shoulder = landmarks.get("LEFT_SHOULDER")
    right_elbow = landmarks.get("RIGHT_ELBOW")
    left_elbow = landmarks.get("LEFT_ELBOW")
    nose = landmarks.get("NOSE")
    
    if not right_shoulder or not left_shoulder:
        return 0.0
    
    center_x = (x1 + x2) / 2
    
    # Strong indicator: Arm raised high above head (bowling action)
    if nose:
        nose_y = nose[1]
        
        # Right arm above head
        if right_wrist and right_wrist[2] > 0.1 and right_wrist[1] < nose_y - 20:
            score += 150
        if right_elbow and right_elbow[2] > 0.1 and right_elbow[1] < nose_y:
            score += 50
            
        # Left arm above head  
        if left_wrist and left_wrist[2] > 0.1 and left_wrist[1] < nose_y - 20:
            score += 150
        if left_elbow and left_elbow[2] > 0.1 and left_elbow[1] < nose_y:
            score += 50
    
    # Arm above shoulder (any raised arm is good indicator)
    if right_wrist and right_shoulder and right_wrist[1] < right_shoulder[1]:
        score += 60
    if left_wrist and left_shoulder and left_wrist[1] < left_shoulder[1]:
        score += 60
    
    # Position in frame (bowler usually on left side in standard camera angles)
    rel_x = center_x / frame_width
    if rel_x < 0.35:
        score += 50
    elif rel_x > 0.65:
        score -= 40  # Likely umpire or batsman
    
    # Size of person (bowler usually larger/closer)
    box_area = (x2 - x1) * (y2 - y1)
    frame_area = frame_width * frame_height
    if box_area > frame_area * 0.06:
        score += 35
    
    # Body orientation (shoulders not perfectly horizontal = action pose)
    if left_shoulder and right_shoulder:
        shoulder_slope = abs(left_shoulder[1] - right_shoulder[1])
        if shoulder_slope > 15:  # Tilted shoulders = dynamic pose
            score += 30
    
    return score


def run_mediapipe_on_frame(
    frame_bgr: np.ndarray,
    detect_bowler: bool = True
) -> Optional[Dict[str, Tuple[float, float, float]]]:
    """
    Run HIGH PRECISION pose detection with bowler identification.
    Returns dictionary of landmark names to (x, y, visibility) tuples.
    """
    height, width = frame_bgr.shape[:2]
    frame_rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
    
    if not detect_bowler or not YOLO_AVAILABLE:
        return _run_high_precision_pose(frame_rgb)
    
    # Detect people
    person_boxes = _detect_people_yolo(frame_bgr)
    
    if not person_boxes:
        # No people detected by YOLO, try full frame
        return _run_high_precision_pose(frame_rgb)
    
    candidates = []
    
    for bbox in person_boxes:
        x1, y1, x2, y2, conf = bbox
        
        # Expand for raised arms
        x1_exp, y1_exp, x2_exp, y2_exp = _expand_bbox((x1, y1, x2, y2), width, height)
        
        # Crop person region
        crop = frame_rgb[y1_exp:y2_exp, x1_exp:x2_exp]
        crop_h, crop_w = crop.shape[:2]
        
        if crop_w < 50 or crop_h < 80:
            continue
        
        # Run HIGH PRECISION pose on crop
        landmarks = _run_high_precision_pose(crop, x_offset=x1_exp, y_offset=y1_exp)
        
        if landmarks:
            score = _score_as_bowler(landmarks, (x1, y1, x2, y2), width, height)
            candidates.append((score, landmarks, (x1_exp, y1_exp, x2_exp, y2_exp)))
    
    if not candidates:
        return None
    
    # Select best candidate (highest bowler score)
    candidates.sort(key=lambda x: x[0], reverse=True)
    best_score, best_landmarks, best_bbox = candidates[0]
    
    # Store metadata
    best_landmarks["_bbox"] = best_bbox
    best_landmarks["_score"] = best_score
    
    return best_landmarks


def run_mediapipe_on_frames_fast(
    frames: List[np.ndarray],
    detect_bowler: bool = True
) -> List[Optional[Dict[str, Tuple[float, float, float]]]]:
    """
    Process multiple frames with bowler detection and temporal consistency.
    """
    if not frames:
        return []
    
    height, width = frames[0].shape[:2]
    poses = []
    bowler_region = None
    prev_landmarks = None
    
    for i, frame_bgr in enumerate(frames):
        # First 10 frames or no bowler region: full detection
        if i < 10 or bowler_region is None:
            pose = run_mediapipe_on_frame(frame_bgr, detect_bowler=True)
            if pose and "_bbox" in pose:
                bbox = pose["_bbox"]
                if bowler_region is None:
                    bowler_region = list(bbox)
                else:
                    # Smooth tracking update
                    for j in range(4):
                        bowler_region[j] = int(0.7 * bowler_region[j] + 0.3 * bbox[j])
            
            # Apply temporal smoothing with previous frame
            if prev_landmarks and pose:
                pose = _temporal_smooth(pose, prev_landmarks)
            
            prev_landmarks = pose
            poses.append(pose)
        else:
            # Use tracked bowler region for efficiency
            x1, y1, x2, y2 = bowler_region
            x1_exp, y1_exp, x2_exp, y2_exp = _expand_bbox((x1, y1, x2, y2), width, height)
            
            frame_rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
            crop = frame_rgb[y1_exp:y2_exp, x1_exp:x2_exp]
            
            landmarks = _run_high_precision_pose(crop, x_offset=x1_exp, y_offset=y1_exp)
            
            if landmarks:
                landmarks["_bbox"] = (x1_exp, y1_exp, x2_exp, y2_exp)
                
                # Apply temporal smoothing
                if prev_landmarks:
                    landmarks = _temporal_smooth(landmarks, prev_landmarks)
                
                # Update tracking region
                if "RIGHT_SHOULDER" in landmarks and "LEFT_HIP" in landmarks:
                    rs = landmarks["RIGHT_SHOULDER"]
                    lh = landmarks["LEFT_HIP"]
                    bowler_region[0] = int(0.8 * bowler_region[0] + 0.2 * (min(rs[0], lh[0]) - 30))
                    bowler_region[2] = int(0.8 * bowler_region[2] + 0.2 * (max(rs[0], lh[0]) + 30))
                
                prev_landmarks = landmarks
                poses.append(landmarks)
            else:
                # Fallback to full detection
                pose = run_mediapipe_on_frame(frame_bgr, detect_bowler=True)
                if pose and "_bbox" in pose:
                    bowler_region = list(pose["_bbox"])
                prev_landmarks = pose
                poses.append(pose)
    
    return poses


def _temporal_smooth(current: Dict, previous: Dict, alpha: float = 0.3) -> Dict:
    """
    Apply temporal smoothing between consecutive frames to reduce jitter.
    alpha: weight for current frame (1-alpha for previous)
    """
    if not current or not previous:
        return current
    
    smoothed = dict(current)
    
    for name in LANDMARK_NAMES:
        curr = current.get(name)
        prev = previous.get(name)
        
        if curr and prev and curr[2] > 0.1 and prev[2] > 0.1:
            # Blend positions
            new_x = alpha * curr[0] + (1 - alpha) * prev[0]
            new_y = alpha * curr[1] + (1 - alpha) * prev[1]
            
            smoothed[name] = (new_x, new_y, curr[2])
    
    return smoothed
