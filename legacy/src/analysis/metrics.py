"""
Cricket Bowling Metrics - Comprehensive Analysis
=================================================
Computes cricket-specific bowling action metrics from 3D joint data.

Metrics include:
- Bowling Action Legality (ICC elbow extension rules)
- Arm Position & Release Point Analysis
- Body Alignment & Balance
- Action Type Classification (pace vs spin indicators)
- Biomechanical Efficiency Scores
"""
from typing import Dict, Any, Tuple
import numpy as np


def compute_joint_angle(j1: np.ndarray, j2: np.ndarray, j3: np.ndarray) -> float:
    """
    Compute the angle at joint j2 formed by j1-j2 and j3-j2 in degrees.
    """
    v1 = j1 - j2
    v2 = j3 - j2
    v1_norm = v1 / (np.linalg.norm(v1) + 1e-8)
    v2_norm = v2 / (np.linalg.norm(v2) + 1e-8)
    dot = np.clip(np.dot(v1_norm, v2_norm), -1.0, 1.0)
    angle_rad = np.arccos(dot)
    return float(np.degrees(angle_rad))


def compute_vector_angle(v1: np.ndarray, v2: np.ndarray) -> float:
    """Compute angle between two vectors in degrees."""
    v1_norm = v1 / (np.linalg.norm(v1) + 1e-8)
    v2_norm = v2 / (np.linalg.norm(v2) + 1e-8)
    dot = np.clip(np.dot(v1_norm, v2_norm), -1.0, 1.0)
    return float(np.degrees(np.arccos(dot)))


def get_joint_positions(joints_3d: np.ndarray, right_handed: bool = True) -> Dict[str, np.ndarray]:
    """
    Extract key joint positions from SPIN output.
    
    SPIN returns 49 joints (24 SMPL + 25 extra joints from regressor).
    Key joint indices:
    - 0: pelvis
    - 1, 2: left_hip, right_hip
    - 12: neck/thorax
    - 16, 17: left_shoulder, right_shoulder
    - 18, 19: left_elbow, right_elbow
    - 20, 21: left_wrist, right_wrist
    """
    J = joints_3d
    
    if len(J) < 22:
        raise ValueError(f"Expected at least 22 joints, got {len(J)}")
    
    joints = {
        "pelvis": J[0],
        "left_hip": J[1],
        "right_hip": J[2],
        "neck": J[12],
        "left_shoulder": J[16],
        "right_shoulder": J[17],
        "left_elbow": J[18],
        "right_elbow": J[19],
        "left_wrist": J[20],
        "right_wrist": J[21],
    }
    
    # Set bowling arm based on handedness
    if right_handed:
        joints["bowling_shoulder"] = J[17]
        joints["bowling_elbow"] = J[19]
        joints["bowling_wrist"] = J[21]
        joints["front_shoulder"] = J[16]
        joints["front_elbow"] = J[18]
        joints["front_wrist"] = J[20]
    else:
        joints["bowling_shoulder"] = J[16]
        joints["bowling_elbow"] = J[18]
        joints["bowling_wrist"] = J[20]
        joints["front_shoulder"] = J[17]
        joints["front_elbow"] = J[19]
        joints["front_wrist"] = J[21]
    
    return joints


def analyze_elbow_legality(joints: Dict[str, np.ndarray]) -> Dict[str, Any]:
    """
    Analyze bowling arm elbow angle for ICC legality.
    
    ICC Rules:
    - Elbow extension must not exceed 15 degrees during delivery
    - ≤15° = Legal
    - 15-20° = Borderline (may need review)
    - >20° = Likely illegal (throwing action)
    
    Note: We measure the current elbow angle - a fully extended arm is ~180°.
    The "extension" is how far the arm straightens from bent to straight.
    """
    shoulder = joints["bowling_shoulder"]
    elbow = joints["bowling_elbow"]
    wrist = joints["bowling_wrist"]
    
    # Compute elbow angle (angle at elbow joint)
    elbow_angle = compute_joint_angle(shoulder, elbow, wrist)
    
    # A straight arm is ~180°, typical bent arm during bowling is 150-170°
    # The "flex" from straight would be (180 - elbow_angle)
    arm_flexion = 180.0 - elbow_angle
    
    # Determine legality status
    if arm_flexion <= 15:
        legality_status = "LEGAL"
        legality_detail = "Elbow extension within ICC 15° limit"
        legality_color = "green"
    elif arm_flexion <= 20:
        legality_status = "BORDERLINE"
        legality_detail = "Elbow extension 15-20° - may require biomechanics test"
        legality_color = "yellow"
    elif arm_flexion <= 25:
        legality_status = "SUSPICIOUS"
        legality_detail = "Elbow extension 20-25° - likely needs official review"
        legality_color = "orange"
    else:
        legality_status = "ILLEGAL"
        legality_detail = f"Elbow extension {arm_flexion:.1f}° exceeds limits significantly"
        legality_color = "red"
    
    return {
        "elbow_angle_deg": float(elbow_angle),
        "arm_flexion_deg": float(arm_flexion),
        "legality_status": legality_status,
        "legality_detail": legality_detail,
        "legality_color": legality_color,
    }


def analyze_release_point(joints: Dict[str, np.ndarray]) -> Dict[str, Any]:
    """
    Analyze the bowling arm release point position.
    
    Key metrics:
    - Release height: How high the wrist is at release
    - Arm angle: Angle of bowling arm from vertical
    - Release position: Whether releasing in front of/behind the crease line
    """
    pelvis = joints["pelvis"]
    neck = joints["neck"]
    shoulder = joints["bowling_shoulder"]
    wrist = joints["bowling_wrist"]
    
    # Torso height for normalization
    torso_height = np.linalg.norm(neck - pelvis)
    
    # Release height relative to shoulder
    wrist_above_shoulder = wrist[1] - shoulder[1]  # y-coordinate difference
    relative_release_height = wrist_above_shoulder / (torso_height + 1e-8)
    
    # Arm vector
    arm_vector = wrist - shoulder
    
    # Vertical vector (y-up in SMPL)
    vertical = np.array([0.0, 1.0, 0.0])
    
    # Angle from vertical (0° = straight up, 90° = horizontal)
    arm_angle_from_vertical = compute_vector_angle(arm_vector, vertical)
    
    # Release point classification
    if wrist[1] > shoulder[1] + 0.1 * torso_height:
        release_position = "HIGH"
        release_detail = "Arm well above shoulder - classic pace/seam action"
    elif wrist[1] > shoulder[1] - 0.1 * torso_height:
        release_position = "SHOULDER_HEIGHT"
        release_detail = "Arm at shoulder level - could be transition point"
    else:
        release_position = "LOW"
        release_detail = "Arm below shoulder - spin or unconventional action"
    
    return {
        "release_height_relative": float(relative_release_height),
        "arm_angle_from_vertical_deg": float(arm_angle_from_vertical),
        "release_position": release_position,
        "release_detail": release_detail,
    }


def analyze_body_alignment(joints: Dict[str, np.ndarray]) -> Dict[str, Any]:
    """
    Analyze body alignment and balance during delivery.
    
    Metrics:
    - Shoulder alignment: Whether shoulders are level
    - Hip-shoulder separation: Rotation between hips and shoulders
    - Spine tilt: Forward/backward lean
    - Side-on vs chest-on action
    """
    pelvis = joints["pelvis"]
    neck = joints["neck"]
    left_shoulder = joints["left_shoulder"]
    right_shoulder = joints["right_shoulder"]
    left_hip = joints["left_hip"]
    right_hip = joints["right_hip"]
    
    # Spine tilt (angle from vertical)
    spine_vector = neck - pelvis
    vertical = np.array([0.0, 1.0, 0.0])
    spine_tilt = compute_vector_angle(spine_vector, vertical)
    
    # Shoulder tilt (difference in Y between shoulders)
    shoulder_diff = abs(left_shoulder[1] - right_shoulder[1])
    shoulder_width = np.linalg.norm(left_shoulder - right_shoulder)
    shoulder_tilt_angle = float(np.degrees(np.arcsin(np.clip(shoulder_diff / (shoulder_width + 1e-8), -1, 1))))
    
    # Hip-shoulder separation (rotation difference in horizontal plane)
    shoulder_vec = right_shoulder - left_shoulder
    hip_vec = right_hip - left_hip
    
    # Project to horizontal plane (x-z)
    shoulder_xz = np.array([shoulder_vec[0], shoulder_vec[2]])
    hip_xz = np.array([hip_vec[0], hip_vec[2]])
    
    shoulder_xz_norm = np.linalg.norm(shoulder_xz)
    hip_xz_norm = np.linalg.norm(hip_xz)
    
    if shoulder_xz_norm > 1e-8 and hip_xz_norm > 1e-8:
        shoulder_xz /= shoulder_xz_norm
        hip_xz /= hip_xz_norm
        dot = np.clip(np.dot(shoulder_xz, hip_xz), -1.0, 1.0)
        hip_shoulder_separation = float(np.degrees(np.arccos(dot)))
    else:
        hip_shoulder_separation = 0.0
    
    # Classify action type based on hip-shoulder separation
    if hip_shoulder_separation > 40:
        action_type = "SIDE-ON"
        action_detail = "Classic side-on action - good for pace bowling"
    elif hip_shoulder_separation > 20:
        action_type = "SEMI-OPEN"
        action_detail = "Semi-open action - mixed technique"
    else:
        action_type = "CHEST-ON"
        action_detail = "Chest-on action - common in spin bowling"
    
    # Spine tilt classification
    if spine_tilt < 10:
        spine_status = "UPRIGHT"
    elif spine_tilt < 25:
        spine_status = "SLIGHT_LEAN"
    else:
        spine_status = "SIGNIFICANT_LEAN"
    
    return {
        "spine_tilt_deg": float(spine_tilt),
        "spine_status": spine_status,
        "shoulder_tilt_deg": float(shoulder_tilt_angle),
        "hip_shoulder_separation_deg": float(hip_shoulder_separation),
        "action_type": action_type,
        "action_detail": action_detail,
    }


def analyze_bowling_arm(joints: Dict[str, np.ndarray]) -> Dict[str, Any]:
    """
    Detailed analysis of bowling arm position and mechanics.
    """
    shoulder = joints["bowling_shoulder"]
    elbow = joints["bowling_elbow"]
    wrist = joints["bowling_wrist"]
    neck = joints["neck"]
    pelvis = joints["pelvis"]
    
    # Upper arm angle (shoulder to elbow)
    upper_arm = elbow - shoulder
    torso = neck - pelvis
    shoulder_abduction = compute_vector_angle(upper_arm, torso)
    
    # Forearm angle (elbow to wrist)
    forearm = wrist - elbow
    forearm_angle = compute_vector_angle(forearm, upper_arm)
    
    # Total arm length ratio (for detecting full extension)
    upper_arm_len = np.linalg.norm(upper_arm)
    forearm_len = np.linalg.norm(forearm)
    arm_ratio = forearm_len / (upper_arm_len + 1e-8)
    
    # Arm position relative to body
    if shoulder_abduction > 150:
        arm_position = "FULLY_RAISED"
        arm_detail = "Arm fully raised - peak of bowling action"
    elif shoulder_abduction > 120:
        arm_position = "HIGH"
        arm_detail = "Arm high - approaching or leaving release point"
    elif shoulder_abduction > 90:
        arm_position = "HORIZONTAL"
        arm_detail = "Arm around horizontal level"
    else:
        arm_position = "LOW"
        arm_detail = "Arm below horizontal"
    
    return {
        "shoulder_abduction_deg": float(shoulder_abduction),
        "forearm_angle_deg": float(forearm_angle),
        "arm_length_ratio": float(arm_ratio),
        "arm_position": arm_position,
        "arm_position_detail": arm_detail,
    }


def analyze_front_arm(joints: Dict[str, np.ndarray]) -> Dict[str, Any]:
    """
    Analyze the non-bowling (front) arm position.
    Important for balance and generating power.
    """
    shoulder = joints["front_shoulder"]
    elbow = joints["front_elbow"]
    wrist = joints["front_wrist"]
    bowling_shoulder = joints["bowling_shoulder"]
    
    # Front arm angle
    front_arm_vec = wrist - shoulder
    
    # Height relative to bowling shoulder
    front_arm_height = wrist[1] - bowling_shoulder[1]
    
    # Front arm extension (how straight is it)
    front_elbow_angle = compute_joint_angle(shoulder, elbow, wrist)
    
    if front_arm_height > 0.1:
        front_arm_status = "HIGH"
        front_arm_detail = "Front arm high - helps with balance and pull-down"
    elif front_arm_height > -0.1:
        front_arm_status = "LEVEL"
        front_arm_detail = "Front arm level - transitional position"
    else:
        front_arm_status = "LOW"
        front_arm_detail = "Front arm pulled down - generating rotation"
    
    return {
        "front_arm_elbow_angle_deg": float(front_elbow_angle),
        "front_arm_status": front_arm_status,
        "front_arm_detail": front_arm_detail,
    }


def classify_bowling_type(metrics: Dict[str, Any]) -> Dict[str, Any]:
    """
    Attempt to classify bowling type based on body position.
    This is indicative only - a single frame can't definitively classify.
    """
    hip_shoulder_sep = metrics.get("hip_shoulder_separation_deg", 0)
    spine_tilt = metrics.get("spine_tilt_deg", 0)
    release_pos = metrics.get("release_position", "")
    arm_position = metrics.get("arm_position", "")
    
    # Scoring for different types
    pace_score = 0
    spin_score = 0
    
    # Side-on action favors pace
    if hip_shoulder_sep > 35:
        pace_score += 30
    elif hip_shoulder_sep < 15:
        spin_score += 20
    
    # High release favors pace
    if release_pos == "HIGH":
        pace_score += 25
    elif release_pos == "LOW":
        spin_score += 15
    
    # Arm position
    if arm_position == "FULLY_RAISED":
        pace_score += 20
    
    # Significant lean often seen in pace
    if spine_tilt > 20:
        pace_score += 15
    
    # Determine type
    if pace_score > spin_score + 20:
        bowling_type = "PACE"
        type_confidence = "HIGH" if pace_score > 60 else "MEDIUM"
        type_detail = f"Body position indicates pace bowling (score: {pace_score})"
    elif spin_score > pace_score + 10:
        bowling_type = "SPIN"
        type_confidence = "HIGH" if spin_score > 40 else "MEDIUM"
        type_detail = f"Body position indicates spin bowling (score: {spin_score})"
    else:
        bowling_type = "UNDETERMINED"
        type_confidence = "LOW"
        type_detail = "Cannot clearly distinguish from single frame"
    
    return {
        "bowling_type_guess": bowling_type,
        "type_confidence": type_confidence,
        "type_detail": type_detail,
        "pace_indicators": pace_score,
        "spin_indicators": spin_score,
    }


def compute_efficiency_score(metrics: Dict[str, Any]) -> Dict[str, Any]:
    """
    Compute an overall biomechanical efficiency score (0-100).
    Based on ideal bowling mechanics.
    """
    score = 50  # Start at neutral
    
    # Elbow legality is critical
    legality = metrics.get("legality_status", "")
    if legality == "LEGAL":
        score += 20
    elif legality == "BORDERLINE":
        score += 5
    elif legality == "ILLEGAL":
        score -= 20
    
    # Good hip-shoulder separation
    hip_sep = metrics.get("hip_shoulder_separation_deg", 0)
    if 25 <= hip_sep <= 45:
        score += 15  # Optimal range
    elif 15 <= hip_sep <= 55:
        score += 8
    
    # High release point
    release = metrics.get("release_position", "")
    if release == "HIGH":
        score += 10
    elif release == "SHOULDER_HEIGHT":
        score += 5
    
    # Arm fully raised
    arm_pos = metrics.get("arm_position", "")
    if arm_pos == "FULLY_RAISED":
        score += 10
    elif arm_pos == "HIGH":
        score += 5
    
    # Controlled spine lean (not too much, not too little)
    spine = metrics.get("spine_tilt_deg", 0)
    if 10 <= spine <= 30:
        score += 5
    
    # Clamp to 0-100
    score = max(0, min(100, score))
    
    # Grade
    if score >= 80:
        grade = "A"
        grade_detail = "Excellent bowling mechanics"
    elif score >= 65:
        grade = "B"
        grade_detail = "Good bowling mechanics with minor improvements possible"
    elif score >= 50:
        grade = "C"
        grade_detail = "Average mechanics - several areas for improvement"
    elif score >= 35:
        grade = "D"
        grade_detail = "Below average - significant improvements needed"
    else:
        grade = "F"
        grade_detail = "Poor mechanics - major biomechanical concerns"
    
    return {
        "efficiency_score": int(score),
        "efficiency_grade": grade,
        "efficiency_detail": grade_detail,
    }


def compute_bowling_metrics(
    joints_3d: np.ndarray,
    scale_info: Dict[str, Any] | None = None,
    right_handed: bool = True,
) -> Dict[str, Any]:
    """
    Compute comprehensive cricket bowling metrics from 3D joints.
    
    Args:
        joints_3d: 3D joint positions from SPIN (49 joints)
        scale_info: Optional scaling info for real-world measurements
        right_handed: Whether bowler is right-handed
    
    Returns:
        Dictionary with all cricket-specific metrics
    """
    # Get joint positions
    joints = get_joint_positions(joints_3d, right_handed)
    
    # Analyze each aspect
    elbow_analysis = analyze_elbow_legality(joints)
    release_analysis = analyze_release_point(joints)
    body_analysis = analyze_body_alignment(joints)
    arm_analysis = analyze_bowling_arm(joints)
    front_arm_analysis = analyze_front_arm(joints)
    
    # Combine all metrics
    metrics = {}
    metrics.update(elbow_analysis)
    metrics.update(release_analysis)
    metrics.update(body_analysis)
    metrics.update(arm_analysis)
    metrics.update(front_arm_analysis)
    
    # Classify bowling type
    type_analysis = classify_bowling_type(metrics)
    metrics.update(type_analysis)
    
    # Compute efficiency score
    efficiency = compute_efficiency_score(metrics)
    metrics.update(efficiency)
    
    # Add metadata
    metrics["right_handed"] = right_handed
    metrics["joint_count"] = len(joints_3d)
    
    return metrics


def save_metrics(metrics_dict: Dict[str, Any], output_path: str) -> None:
    """Save metrics to JSON file."""
    import json
    
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(metrics_dict, f, indent=2)


def compute_2d_angle(p1: Tuple[float, float], p2: Tuple[float, float], p3: Tuple[float, float]) -> float:
    """
    Compute angle at p2 formed by p1-p2-p3 in 2D (degrees).
    p1, p2, p3 are (x, y) tuples.
    """
    v1 = np.array([p1[0] - p2[0], p1[1] - p2[1]])
    v2 = np.array([p3[0] - p2[0], p3[1] - p2[1]])
    
    v1_norm = v1 / (np.linalg.norm(v1) + 1e-8)
    v2_norm = v2 / (np.linalg.norm(v2) + 1e-8)
    
    dot = np.clip(np.dot(v1_norm, v2_norm), -1.0, 1.0)
    angle_rad = np.arccos(dot)
    return float(np.degrees(angle_rad))


def compute_bowling_metrics_from_mediapipe(
    pose_landmarks: Dict[str, Tuple[float, float, float]],
    right_handed: bool = True,
) -> Dict[str, Any]:
    """
    Compute cricket bowling metrics from MediaPipe 2D pose landmarks.
    This uses the accurate 2D detection instead of SPIN 3D estimation.
    
    Args:
        pose_landmarks: Dict mapping landmark names to (x, y, visibility)
        right_handed: Whether bowler is right-handed
    
    Returns:
        Dictionary with all cricket-specific metrics
    """
    metrics = {}
    
    # Helper to get point as (x, y) or None
    def get_point(name: str) -> Tuple[float, float] | None:
        if name in pose_landmarks:
            x, y, vis = pose_landmarks[name]
            if vis > 0.3:
                return (x, y)
        return None
    
    # Get key landmarks
    left_shoulder = get_point("LEFT_SHOULDER")
    right_shoulder = get_point("RIGHT_SHOULDER")
    left_elbow = get_point("LEFT_ELBOW")
    right_elbow = get_point("RIGHT_ELBOW")
    left_wrist = get_point("LEFT_WRIST")
    right_wrist = get_point("RIGHT_WRIST")
    left_hip = get_point("LEFT_HIP")
    right_hip = get_point("RIGHT_HIP")
    left_knee = get_point("LEFT_KNEE")
    right_knee = get_point("RIGHT_KNEE")
    left_ankle = get_point("LEFT_ANKLE")
    right_ankle = get_point("RIGHT_ANKLE")
    nose = get_point("NOSE")
    
    # Set bowling arm based on handedness
    if right_handed:
        bowl_shoulder = right_shoulder
        bowl_elbow = right_elbow
        bowl_wrist = right_wrist
        front_shoulder = left_shoulder
        front_elbow = left_elbow
        front_wrist = left_wrist
    else:
        bowl_shoulder = left_shoulder
        bowl_elbow = left_elbow
        bowl_wrist = left_wrist
        front_shoulder = right_shoulder
        front_elbow = right_elbow
        front_wrist = right_wrist
    
    # ========== ELBOW ANGLE (Critical for legality) ==========
    if bowl_shoulder and bowl_elbow and bowl_wrist:
        elbow_angle = compute_2d_angle(bowl_shoulder, bowl_elbow, bowl_wrist)
        arm_flexion = 180.0 - elbow_angle
        
        # ICC legality assessment
        if arm_flexion <= 15:
            legality_status = "LEGAL"
            legality_detail = "Elbow extension within ICC 15° limit"
            legality_color = "green"
        elif arm_flexion <= 20:
            legality_status = "BORDERLINE"
            legality_detail = "Elbow extension 15-20° - may require review"
            legality_color = "yellow"
        elif arm_flexion <= 25:
            legality_status = "SUSPICIOUS"
            legality_detail = "Elbow extension 20-25° - needs official review"
            legality_color = "orange"
        else:
            legality_status = "ILLEGAL"
            legality_detail = f"Elbow extension {arm_flexion:.1f}° exceeds limits"
            legality_color = "red"
        
        metrics["elbow_angle_deg"] = float(elbow_angle)
        metrics["arm_flexion_deg"] = float(arm_flexion)
        metrics["legality_status"] = legality_status
        metrics["legality_detail"] = legality_detail
        metrics["legality_color"] = legality_color
    else:
        metrics["elbow_angle_deg"] = None
        metrics["legality_status"] = "UNKNOWN"
        metrics["legality_detail"] = "Bowling arm not fully visible"
        metrics["legality_color"] = "gray"
    
    # ========== RELEASE POINT ==========
    if bowl_shoulder and bowl_wrist:
        # Check if wrist is above shoulder (y-axis: lower y = higher position)
        wrist_above = bowl_wrist[1] < bowl_shoulder[1]
        height_diff = bowl_shoulder[1] - bowl_wrist[1]  # Positive = wrist above
        
        if left_shoulder and right_shoulder:
            shoulder_width = abs(left_shoulder[0] - right_shoulder[0])
            relative_height = height_diff / (shoulder_width + 1e-8)
            metrics["release_height_relative"] = float(relative_height)
        
        if wrist_above and height_diff > 50:
            metrics["release_position"] = "HIGH"
            metrics["release_detail"] = "Arm raised high - classic pace action"
        elif wrist_above:
            metrics["release_position"] = "SHOULDER_HEIGHT"
            metrics["release_detail"] = "Arm at shoulder level"
        else:
            metrics["release_position"] = "LOW"
            metrics["release_detail"] = "Arm below shoulder - spin or roundarm"
    
    # ========== ARM ANGLE FROM VERTICAL ==========
    if bowl_shoulder and bowl_wrist:
        arm_vec = (bowl_wrist[0] - bowl_shoulder[0], bowl_wrist[1] - bowl_shoulder[1])
        vertical = (0, -1)  # Up in image coordinates
        
        # Angle from vertical
        arm_len = np.sqrt(arm_vec[0]**2 + arm_vec[1]**2) + 1e-8
        arm_norm = (arm_vec[0] / arm_len, arm_vec[1] / arm_len)
        
        dot = arm_norm[0] * vertical[0] + arm_norm[1] * vertical[1]
        angle_from_vertical = np.degrees(np.arccos(np.clip(dot, -1, 1)))
        metrics["arm_angle_from_vertical_deg"] = float(angle_from_vertical)
    
    # ========== FRONT ARM ANALYSIS ==========
    if front_shoulder and front_elbow and front_wrist:
        front_elbow_angle = compute_2d_angle(front_shoulder, front_elbow, front_wrist)
        metrics["front_elbow_angle_deg"] = float(front_elbow_angle)
        
        if front_elbow_angle > 160:
            metrics["front_arm_style"] = "EXTENDED"
            metrics["front_arm_detail"] = "Front arm fully extended - good drive"
        elif front_elbow_angle > 120:
            metrics["front_arm_style"] = "SEMI_BENT"
            metrics["front_arm_detail"] = "Front arm partially bent"
        else:
            metrics["front_arm_style"] = "BENT"
            metrics["front_arm_detail"] = "Front arm bent - may limit rotation"
    
    # ========== SHOULDER ALIGNMENT ==========
    if left_shoulder and right_shoulder:
        shoulder_slope = (right_shoulder[1] - left_shoulder[1]) / (
            abs(right_shoulder[0] - left_shoulder[0]) + 1e-8
        )
        shoulder_tilt_deg = np.degrees(np.arctan(abs(shoulder_slope)))
        
        metrics["shoulder_tilt_deg"] = float(shoulder_tilt_deg)
        
        if shoulder_tilt_deg < 10:
            metrics["shoulder_alignment"] = "LEVEL"
            metrics["shoulder_detail"] = "Shoulders level - balanced action"
        elif shoulder_tilt_deg < 25:
            metrics["shoulder_alignment"] = "TILTED"
            metrics["shoulder_detail"] = "Moderate shoulder tilt - common in pace bowling"
        else:
            metrics["shoulder_alignment"] = "HEAVILY_TILTED"
            metrics["shoulder_detail"] = "Significant shoulder drop - may cause strain"
    
    # ========== HIP-SHOULDER SEPARATION ==========
    if left_shoulder and right_shoulder and left_hip and right_hip:
        # Shoulder line angle
        shoulder_angle = np.degrees(np.arctan2(
            right_shoulder[1] - left_shoulder[1],
            right_shoulder[0] - left_shoulder[0]
        ))
        
        # Hip line angle
        hip_angle = np.degrees(np.arctan2(
            right_hip[1] - left_hip[1],
            right_hip[0] - left_hip[0]
        ))
        
        separation = abs(shoulder_angle - hip_angle)
        if separation > 180:
            separation = 360 - separation
        
        metrics["hip_shoulder_separation_deg"] = float(separation)
        
        if separation > 30:
            metrics["action_type"] = "SIDE_ON"
            metrics["action_detail"] = "Strong side-on action - good hip-shoulder separation"
        elif separation > 15:
            metrics["action_type"] = "SEMI_OPEN"
            metrics["action_detail"] = "Semi-open action - mixed technique"
        else:
            metrics["action_type"] = "CHEST_ON"
            metrics["action_detail"] = "Chest-on action - common in modern pace bowling"
    
    # ========== KNEE DRIVE (Front leg) ==========
    if right_handed:
        front_hip = left_hip
        front_knee = left_knee
        front_ankle = left_ankle
    else:
        front_hip = right_hip
        front_knee = right_knee
        front_ankle = right_ankle
    
    if front_hip and front_knee and front_ankle:
        front_knee_angle = compute_2d_angle(front_hip, front_knee, front_ankle)
        metrics["front_knee_angle_deg"] = float(front_knee_angle)
        
        if front_knee_angle > 170:
            metrics["front_leg_style"] = "BRACED"
            metrics["front_leg_detail"] = "Front leg braced - strong base for pace"
        elif front_knee_angle > 140:
            metrics["front_leg_style"] = "SEMI_BRACED"
            metrics["front_leg_detail"] = "Front leg semi-braced"
        else:
            metrics["front_leg_style"] = "BENT"
            metrics["front_leg_detail"] = "Front leg bent - may reduce pace"
    
    # ========== BOWLING TYPE CLASSIFICATION ==========
    if metrics.get("release_position") == "HIGH" and metrics.get("action_type") in ["SIDE_ON", "SEMI_OPEN"]:
        metrics["bowling_type"] = "PACE"
        metrics["bowling_type_detail"] = "Action consistent with pace bowling"
    elif metrics.get("release_position") == "LOW":
        metrics["bowling_type"] = "SPIN"
        metrics["bowling_type_detail"] = "Lower release point suggests spin bowling"
    else:
        metrics["bowling_type"] = "MEDIUM"
        metrics["bowling_type_detail"] = "Medium pace or all-round action"
    
    # ========== EFFICIENCY SCORE ==========
    score = 50  # Base score
    
    # Elbow legality
    if metrics.get("legality_status") == "LEGAL":
        score += 20
    elif metrics.get("legality_status") == "BORDERLINE":
        score += 10
    elif metrics.get("legality_status") == "SUSPICIOUS":
        score -= 10
    else:
        score -= 20
    
    # Release height
    if metrics.get("release_position") == "HIGH":
        score += 15
    elif metrics.get("release_position") == "SHOULDER_HEIGHT":
        score += 5
    
    # Front arm
    if metrics.get("front_arm_style") == "EXTENDED":
        score += 10
    elif metrics.get("front_arm_style") == "SEMI_BENT":
        score += 5
    
    # Hip-shoulder separation
    if metrics.get("action_type") == "SIDE_ON":
        score += 10
    elif metrics.get("action_type") == "SEMI_OPEN":
        score += 5
    
    # Front leg brace
    if metrics.get("front_leg_style") == "BRACED":
        score += 10
    elif metrics.get("front_leg_style") == "SEMI_BRACED":
        score += 5
    
    score = max(0, min(100, score))
    
    if score >= 80:
        grade = "A"
        grade_detail = "Excellent bowling mechanics"
    elif score >= 65:
        grade = "B"
        grade_detail = "Good bowling mechanics"
    elif score >= 50:
        grade = "C"
        grade_detail = "Average mechanics - room for improvement"
    elif score >= 35:
        grade = "D"
        grade_detail = "Below average - significant improvements needed"
    else:
        grade = "F"
        grade_detail = "Poor mechanics - major concerns"
    
    metrics["efficiency_score"] = int(score)
    metrics["efficiency_grade"] = grade
    metrics["efficiency_detail"] = grade_detail
    metrics["right_handed"] = right_handed
    metrics["source"] = "MediaPipe 2D"
    
    return metrics
