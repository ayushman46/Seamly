"""
Visualization utilities for cricket bowling analysis.

Provides:
- 2D skeleton overlay on frames
- Interactive 3D mesh rendering via Plotly WebGL (no pyrender/OSMesa needed)
"""
from typing import Dict, Any, Optional, Tuple, List

import cv2
import numpy as np
import plotly.graph_objects as go


# Complete MediaPipe skeleton connections for full body visualization
SKELETON_CONNECTIONS = [
    # Face
    ("NOSE", "LEFT_EYE"),
    ("NOSE", "RIGHT_EYE"),
    ("LEFT_EYE", "LEFT_EAR"),
    ("RIGHT_EYE", "RIGHT_EAR"),
    
    # Arms - LEFT
    ("LEFT_SHOULDER", "LEFT_ELBOW"),
    ("LEFT_ELBOW", "LEFT_WRIST"),
    ("LEFT_WRIST", "LEFT_PINKY"),
    ("LEFT_WRIST", "LEFT_INDEX"),
    ("LEFT_WRIST", "LEFT_THUMB"),
    ("LEFT_PINKY", "LEFT_INDEX"),
    
    # Arms - RIGHT
    ("RIGHT_SHOULDER", "RIGHT_ELBOW"),
    ("RIGHT_ELBOW", "RIGHT_WRIST"),
    ("RIGHT_WRIST", "RIGHT_PINKY"),
    ("RIGHT_WRIST", "RIGHT_INDEX"),
    ("RIGHT_WRIST", "RIGHT_THUMB"),
    ("RIGHT_PINKY", "RIGHT_INDEX"),
    
    # Torso
    ("LEFT_SHOULDER", "RIGHT_SHOULDER"),
    ("LEFT_SHOULDER", "LEFT_HIP"),
    ("RIGHT_SHOULDER", "RIGHT_HIP"),
    ("LEFT_HIP", "RIGHT_HIP"),
    
    # Spine (virtual connections for visualization)
    ("NOSE", "LEFT_SHOULDER"),
    ("NOSE", "RIGHT_SHOULDER"),
    
    # Legs - LEFT
    ("LEFT_HIP", "LEFT_KNEE"),
    ("LEFT_KNEE", "LEFT_ANKLE"),
    ("LEFT_ANKLE", "LEFT_HEEL"),
    ("LEFT_ANKLE", "LEFT_FOOT_INDEX"),
    ("LEFT_HEEL", "LEFT_FOOT_INDEX"),
    
    # Legs - RIGHT
    ("RIGHT_HIP", "RIGHT_KNEE"),
    ("RIGHT_KNEE", "RIGHT_ANKLE"),
    ("RIGHT_ANKLE", "RIGHT_HEEL"),
    ("RIGHT_ANKLE", "RIGHT_FOOT_INDEX"),
    ("RIGHT_HEEL", "RIGHT_FOOT_INDEX"),
]


def draw_2d_skeleton_on_frame(
    frame_bgr: np.ndarray,
    landmarks: Optional[Dict[str, Tuple[float, float, float]]],
    threshold: float = 0.3,
) -> np.ndarray:
    """
    Draw a 2D skeleton overlay on a BGR frame using MediaPipe landmarks.
    
    Args:
        frame_bgr: BGR image (OpenCV format).
        landmarks: Dictionary mapping landmark names to (x, y, visibility) tuples.
        threshold: Minimum visibility to draw a landmark.
        
    Returns:
        BGR image with skeleton overlay.
    """
    frame = frame_bgr.copy()
    
    if landmarks is None:
        # Draw "No pose detected" message
        cv2.putText(frame, "No pose detected", (50, 50),
                    cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 0, 255), 2)
        return frame
    
    # Compute tight bounding box from actual landmarks (for SPIN crop visualization)
    valid_points = []
    for name, value in landmarks.items():
        if name.startswith("_"):
            continue
        x, y, vis = value
        if vis > 0.1:
            valid_points.append((x, y))
    
    if valid_points:
        xs = [p[0] for p in valid_points]
        ys = [p[1] for p in valid_points]
        lm_x1, lm_y1 = int(min(xs)), int(min(ys))
        lm_x2, lm_y2 = int(max(xs)), int(max(ys))
        
        # Draw tight landmark-based box (this is what SPIN uses)
        pad = 20
        cv2.rectangle(frame, (lm_x1 - pad, lm_y1 - pad), (lm_x2 + pad, lm_y2 + pad), 
                      (0, 255, 255), 2)  # Yellow box for SPIN crop area
        cv2.putText(frame, "SPIN Crop Area", (lm_x1 - pad, lm_y1 - pad - 10),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 255), 1)
    
    # Draw YOLO detection box if available (cyan, thinner)
    if "_bbox" in landmarks:
        bbox = landmarks["_bbox"]
        x1, y1, x2, y2 = int(bbox[0]), int(bbox[1]), int(bbox[2]), int(bbox[3])
        cv2.rectangle(frame, (x1, y1), (x2, y2), (255, 255, 0), 1)
        
        if "_score" in landmarks:
            score = landmarks["_score"]
            cv2.putText(frame, f"Bowler (score: {score:.0f})", (x1, y2 + 20),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 0), 1)
    
    # Draw keypoints with different colors based on visibility
    for name, value in landmarks.items():
        if name.startswith("_"):
            continue
        x, y, vis = value
        pt = (int(x), int(y))
        
        if vis >= threshold:
            # Good visibility - green
            cv2.circle(frame, pt, 5, (0, 255, 0), -1)
        elif vis >= 0.1:
            # Low visibility - orange (still tracked)
            cv2.circle(frame, pt, 4, (0, 165, 255), -1)
        # Very low visibility - don't draw
    
    # Draw skeleton connections
    for start_name, end_name in SKELETON_CONNECTIONS:
        if start_name not in landmarks or end_name not in landmarks:
            continue
        
        x1, y1, vis1 = landmarks[start_name]
        x2, y2, vis2 = landmarks[end_name]
        
        # Draw even for low visibility (helps see the full skeleton)
        if vis1 < 0.1 or vis2 < 0.1:
            continue
        
        pt1 = (int(x1), int(y1))
        pt2 = (int(x2), int(y2))
        cv2.line(frame, pt1, pt2, (0, 255, 0), 2)
    
    return frame


def make_plotly_mesh_figure(
    vertices: np.ndarray,
    faces: np.ndarray,
    joints_3d: np.ndarray = None,
    color: str = "lightpink",
    title: str = "3D Body Mesh (SPIN)"
) -> go.Figure:
    """
    Create an interactive Plotly 3D mesh figure for WebGL rendering.
    Simple approach: just display the mesh as SPIN outputs it.
    """
    verts = vertices.copy()
    
    # Center the mesh
    verts = verts - verts.mean(axis=0)
    
    # SMPL outputs Y-up by default, which is what we want for Plotly
    # Just ensure the mesh faces the camera (flip if needed)
    
    x, y, z = verts.T
    i, j, k = faces.T
    
    mesh = go.Mesh3d(
        x=x,
        y=y,
        z=z,
        i=i,
        j=j,
        k=k,
        color=color,
        opacity=1.0,
        flatshading=True,
        lighting=dict(
            ambient=0.6,
            diffuse=0.5,
            specular=0.3,
            roughness=0.5,
        ),
        lightposition=dict(x=100, y=200, z=100),
        hoverinfo="skip",
    )
    
    fig = go.Figure(data=[mesh])
    
    # Camera: look from positive Z towards origin, Y is up
    fig.update_layout(
        title=dict(text=title, x=0.5, xanchor="center"),
        scene=dict(
            aspectmode="data",
            xaxis=dict(visible=False, showgrid=False, zeroline=False),
            yaxis=dict(visible=False, showgrid=False, zeroline=False),
            zaxis=dict(visible=False, showgrid=False, zeroline=False),
            bgcolor="rgb(30, 30, 40)",
            camera=dict(
                up=dict(x=0, y=1, z=0),  # Y is up
                center=dict(x=0, y=0, z=0),
                eye=dict(x=0, y=0, z=2.5)  # Looking from front
            ),
        ),
        margin=dict(l=0, r=0, t=40, b=0),
        paper_bgcolor="rgb(30, 30, 40)",
    )
    
    return fig


def make_plotly_mesh_with_joints(
    vertices: np.ndarray,
    faces: np.ndarray,
    joints_3d: Optional[np.ndarray] = None,
    mesh_color: str = "lightpink",
    joint_color: str = "red",
    title: str = "3D Body Mesh with Joints"
) -> go.Figure:
    """
    Create a Plotly figure with both mesh and joint markers.
    
    Args:
        vertices: (N, 3) array of vertex positions.
        faces: (F, 3) array of face indices.
        joints_3d: Optional (J, 3) array of joint positions.
        mesh_color: Mesh color.
        joint_color: Joint marker color.
        title: Plot title.
        
    Returns:
        Plotly Figure object.
    """
    fig = make_plotly_mesh_figure(vertices, faces, mesh_color, title)
    
    if joints_3d is not None and len(joints_3d) > 0:
        # Add joint markers
        jx, jy, jz = joints_3d.T
        
        joints_trace = go.Scatter3d(
            x=jx,
            y=jy,
            z=jz,
            mode="markers",
            marker=dict(
                size=4,
                color=joint_color,
                opacity=0.8,
            ),
            hoverinfo="skip",
            name="Joints",
        )
        
        fig.add_trace(joints_trace)
    
    return fig


def save_mesh_obj(
    vertices: np.ndarray,
    faces: np.ndarray,
    output_path: str
) -> None:
    """
    Save a mesh as OBJ file.
    
    Args:
        vertices: (N, 3) array of vertex positions.
        faces: (F, 3) array of face indices (0-indexed).
        output_path: Output file path.
    """
    with open(output_path, "w") as f:
        f.write("# SPIN mesh export\n")
        
        # Write vertices
        for v in vertices:
            f.write(f"v {v[0]:.6f} {v[1]:.6f} {v[2]:.6f}\n")
        
        # Write faces (OBJ uses 1-indexed)
        for face in faces:
            f.write(f"f {face[0]+1} {face[1]+1} {face[2]+1}\n")
