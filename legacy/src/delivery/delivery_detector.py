"""
Delivery frame detection for cricket bowling analysis.

Uses MediaPipe pose data to detect the ball release moment.
"""
from typing import Dict, Any, List, Optional, Tuple


def detect_delivery_frame(
    poses: List[Optional[Dict[str, Tuple[float, float, float]]]],
    fps: float = 30.0
) -> Optional[int]:
    """
    Detect the delivery (ball release) frame from a list of pose dictionaries.
    
    Uses heuristics:
    1. Wrist height relative to shoulder (arm raised high)
    2. Wrist velocity (arm moving fast during release)
    3. Arm extension (elbow relatively straight)
    
    Args:
        poses: List of pose dictionaries from MediaPipe, each mapping
               landmark names to (x, y, visibility) tuples.
               None entries indicate no pose detected.
        fps: Video FPS for velocity calculation.
        
    Returns:
        Index into the poses list for the detected delivery frame,
        or None if detection fails.
    """
    if not poses or len(poses) < 2:
        return None
    
    # Extract right wrist trajectory (assuming right-handed bowler)
    wrist_data = []
    for idx, pose in enumerate(poses):
        if pose is None:
            continue
        
        right_wrist = pose.get("RIGHT_WRIST")
        right_shoulder = pose.get("RIGHT_SHOULDER")
        right_elbow = pose.get("RIGHT_ELBOW")
        
        if right_wrist is None or right_shoulder is None:
            continue
        
        wrist_x, wrist_y, wrist_vis = right_wrist
        shoulder_x, shoulder_y, shoulder_vis = right_shoulder
        
        if wrist_vis < 0.3 or shoulder_vis < 0.3:
            continue
        
        # Wrist height relative to shoulder (negative = wrist above shoulder)
        rel_height = wrist_y - shoulder_y
        
        # Elbow angle (if available)
        elbow_angle = None
        if right_elbow is not None and right_elbow[2] > 0.3:
            elbow_angle = _compute_elbow_extension(right_shoulder, right_elbow, right_wrist)
        
        wrist_data.append({
            "idx": idx,
            "x": wrist_x,
            "y": wrist_y,
            "rel_height": rel_height,
            "elbow_angle": elbow_angle,
        })
    
    if len(wrist_data) < 2:
        return None
    
    # Compute velocities
    for i in range(1, len(wrist_data)):
        prev = wrist_data[i - 1]
        curr = wrist_data[i]
        dt = (curr["idx"] - prev["idx"]) / fps
        if dt > 0:
            curr["velocity"] = ((curr["x"] - prev["x"])**2 + (curr["y"] - prev["y"])**2)**0.5 / dt
        else:
            curr["velocity"] = 0.0
    wrist_data[0]["velocity"] = 0.0
    
    # Score each frame based on delivery heuristics
    # Higher score = more likely to be delivery frame
    scores = []
    for d in wrist_data:
        score = 0.0
        
        # Wrist above or at shoulder level (negative rel_height is good)
        if d["rel_height"] < 0:
            score += 30  # Wrist above shoulder
        elif d["rel_height"] < 50:
            score += 15  # Wrist near shoulder level
        
        # High velocity during delivery
        score += min(d["velocity"] / 10.0, 30)  # Cap at 30 points
        
        # Extended arm (elbow close to 180 degrees)
        if d["elbow_angle"] is not None and d["elbow_angle"] > 150:
            score += 20
        
        scores.append((d["idx"], score))
    
    if not scores:
        return None
    
    # Find frame with highest score
    best_idx, best_score = max(scores, key=lambda x: x[1])
    
    # Sanity check: require minimum score
    if best_score < 10:
        return None
    
    return best_idx


def _compute_elbow_extension(
    shoulder: Tuple[float, float, float],
    elbow: Tuple[float, float, float],
    wrist: Tuple[float, float, float]
) -> float:
    """
    Compute the elbow angle in degrees (180 = fully extended).
    """
    import math
    
    # Vectors
    v1 = (shoulder[0] - elbow[0], shoulder[1] - elbow[1])
    v2 = (wrist[0] - elbow[0], wrist[1] - elbow[1])
    
    # Dot product and magnitudes
    dot = v1[0] * v2[0] + v1[1] * v2[1]
    mag1 = math.sqrt(v1[0]**2 + v1[1]**2)
    mag2 = math.sqrt(v2[0]**2 + v2[1]**2)
    
    if mag1 < 1e-8 or mag2 < 1e-8:
        return 0.0
    
    cos_angle = max(-1.0, min(1.0, dot / (mag1 * mag2)))
    angle_rad = math.acos(cos_angle)
    angle_deg = math.degrees(angle_rad)
    
    return angle_deg
