import os
import sys
from typing import Any, Dict, Optional

# CRITICAL: Import chumpy compatibility shim BEFORE any SPIN/SMPL imports
# This patches inspect.getargspec and numpy type aliases for Python 3.12 compatibility
import chumpy_compat  # noqa: F401

import numpy as np
import torch
import torch.nn as nn
from torchvision.transforms import Normalize
import cv2


class SpinModelWrapper:
    """
    Wrapper around the SPIN model for 3D human pose and shape reconstruction.
    Integrates with the official SPIN repository (nkolot/SPIN).
    """

    def __init__(self, spin_root: str):
        self.spin_root = os.path.abspath(spin_root)
        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        self.model = None
        self.smpl = None
        self.faces = None
        self.normalize_img = None
        self.input_res = 224

        self._init_spin()

    def _init_spin(self) -> None:
        """
        Initialize SPIN model by importing from the spin_src repo,
        loading the pretrained checkpoint and SMPL model.
        """
        # Add SPIN repo to path AT THE BEGINNING to ensure it's found first
        if self.spin_root in sys.path:
            sys.path.remove(self.spin_root)
        sys.path.insert(0, self.spin_root)

        # Import SPIN modules using importlib to avoid config name collision
        import importlib.util
        
        try:
            # Load SPIN's config module explicitly from file
            config_path = os.path.join(self.spin_root, "config.py")
            spec = importlib.util.spec_from_file_location("spin_config_internal", config_path)
            spin_config = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(spin_config)
            
            # Now import other SPIN modules normally
            from models import hmr, SMPL
            import constants as spin_constants
        except Exception as e:
            raise ImportError(
                f"Could not import SPIN modules from {self.spin_root}. "
                "Make sure spin_src is the official SPIN repo. "
                f"Error: {e}"
            ) from e

        # Set up image normalization (same as SPIN demo)
        self.normalize_img = Normalize(
            mean=spin_constants.IMG_NORM_MEAN,
            std=spin_constants.IMG_NORM_STD
        )
        self.input_res = spin_constants.IMG_RES

        # Build absolute paths to data files
        smpl_mean_params_path = os.path.join(self.spin_root, spin_config.SMPL_MEAN_PARAMS)
        smpl_model_dir = os.path.join(self.spin_root, spin_config.SMPL_MODEL_DIR)
        checkpoint_path = os.path.join(self.spin_root, "data", "model_checkpoint.pt")
        
        if not os.path.exists(smpl_mean_params_path):
            raise FileNotFoundError(
                f"SMPL mean params not found at {smpl_mean_params_path}. "
                "Please run 'cd spin_src && ./fetch_data.sh' to download required data files."
            )
        
        if not os.path.exists(smpl_model_dir):
            raise FileNotFoundError(
                f"SMPL model directory not found at {smpl_model_dir}. "
                "Please ensure SMPL models are placed in spin_src/data/smpl/"
            )

        # Load HMR model
        model = hmr(smpl_mean_params_path).to(self.device)
        
        # Load checkpoint
        if not os.path.exists(checkpoint_path):
            raise FileNotFoundError(
                f"SPIN checkpoint not found at {checkpoint_path}. "
                "Please download it by running:\n"
                "  cd spin_src\n"
                "  wget http://visiondata.cis.upenn.edu/spin/model_checkpoint.pt --directory-prefix=data\n"
                "Or run the full fetch_data.sh script."
            )
        
        # PyTorch 2.6+ compatibility: Need weights_only=False for SPIN checkpoint
        # The checkpoint contains custom objects, not just tensors
        checkpoint = torch.load(checkpoint_path, map_location=self.device, weights_only=False)
        model.load_state_dict(checkpoint['model'], strict=False)
        model.eval()

        # SPIN's SMPL model uses relative paths in its __init__, so we must change directory
        original_cwd = os.getcwd()
        os.chdir(self.spin_root)
        
        try:
            # Load SMPL model (this internally loads J_regressor_extra.npy using relative paths)
            smpl = SMPL(
                spin_config.SMPL_MODEL_DIR,  # Use relative path since we're in spin_root
                batch_size=1,
                create_transl=False
            ).to(self.device)

            # Get faces from SMPL
            faces = smpl.faces.astype(np.int32)

            self.model = model
            self.smpl = smpl
            self.faces = faces
            
        finally:
            # Always restore original working directory
            os.chdir(original_cwd)

    def _enhance_for_spin(self, image_rgb: np.ndarray) -> np.ndarray:
        """
        Enhance image for better SPIN mesh reconstruction.
        Improves edge detection and body boundary visibility.
        """
        # Convert to LAB for better processing
        lab = cv2.cvtColor(image_rgb, cv2.COLOR_RGB2LAB)
        
        # Apply CLAHE to L channel (contrast enhancement)
        clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
        lab[:, :, 0] = clahe.apply(lab[:, :, 0])
        
        # Convert back to RGB
        enhanced = cv2.cvtColor(lab, cv2.COLOR_LAB2RGB)
        
        # Slight sharpening to improve body edges
        kernel = np.array([[-0.5, -0.5, -0.5],
                          [-0.5,  5.0, -0.5],
                          [-0.5, -0.5, -0.5]]) / 2.0
        enhanced = cv2.filter2D(enhanced, -1, kernel)
        enhanced = np.clip(enhanced, 0, 255).astype(np.uint8)
        
        return enhanced

    def _preprocess_image(self, image_rgb: np.ndarray) -> torch.Tensor:
        """
        Preprocess image following SPIN's demo.py approach with ENHANCED quality.
        Uses high-quality interpolation and contrast enhancement for better mesh.
        """
        height, width = image_rgb.shape[:2]
        
        # Assume person is centered (for bowling video this is usually true)
        center = np.array([width // 2, height // 2])
        scale = max(height, width) / 200.0
        
        # ENHANCEMENT 1: Apply contrast enhancement before processing
        # This helps SPIN detect body edges better
        enhanced = self._enhance_for_spin(image_rgb)
        
        # Try using SPIN's crop utility, fall back to high-quality resize
        try:
            sys.path.insert(0, self.spin_root)
            from utils.imutils import crop
            img_cropped = crop(enhanced, center, scale, (self.input_res, self.input_res))
        except Exception as e:
            # ENHANCEMENT 2: Use Lanczos interpolation for highest quality
            print(f"Warning: SPIN crop failed ({e}), using high-quality resize")
            img_cropped = cv2.resize(enhanced, (self.input_res, self.input_res), 
                                     interpolation=cv2.INTER_LANCZOS4)
        
        # Normalize
        img_cropped = img_cropped.astype(np.float32) / 255.0
        img_tensor = torch.from_numpy(img_cropped).permute(2, 0, 1)  # HWC -> CHW
        img_normalized = self.normalize_img(img_tensor.clone())[None]  # Add batch dim
        
        return img_normalized.to(self.device)

    def run(self, image_rgb: np.ndarray) -> Dict[str, Any]:
        """
        Run SPIN on a single RGB image to get 3D mesh and joints.
        
        Args:
            image_rgb: RGB image as numpy array (H, W, 3)
            
        Returns:
            Dictionary containing:
                - vertices: (V, 3) numpy array
                - faces: (F, 3) numpy array
                - joints_3d: (J, 3) numpy array
                - smpl_params: dict with betas, pose (as rotmat), camera
        """
        if self.model is None or self.smpl is None:
            raise RuntimeError("SPIN model is not initialized.")

        with torch.no_grad():
            # Preprocess input
            input_tensor = self._preprocess_image(image_rgb)

            # Forward pass through HMR
            pred_rotmat, pred_betas, pred_camera = self.model(input_tensor)

            # Run SMPL to get vertices and joints
            smpl_output = self.smpl(
                betas=pred_betas,
                body_pose=pred_rotmat[:, 1:],
                global_orient=pred_rotmat[:, 0].unsqueeze(1),
                pose2rot=False
            )
            
            vertices = smpl_output.vertices[0].cpu().numpy()  # (6890, 3)
            joints_3d = smpl_output.joints[0].cpu().numpy()   # (49, 3) - SPIN returns extended joints

            # Prepare SMPL parameters
            smpl_params = {
                "betas": pred_betas[0].cpu().numpy(),
                "rotmat": pred_rotmat[0].cpu().numpy(),
                "camera": pred_camera[0].cpu().numpy(),
            }

        result = {
            "vertices": vertices,
            "faces": self.faces,
            "joints_3d": joints_3d,
            "smpl_params": smpl_params,
        }
        return result

    def run_with_pose_correction(
        self, 
        image_rgb: np.ndarray, 
        keypoints_2d: Dict[str, tuple]
    ) -> Dict[str, Any]:
        """
        Run SPIN and then correct the pose (especially knees) to match MediaPipe detection.
        
        This method:
        1. Runs standard SPIN inference
        2. Calculates knee bend angles from MediaPipe 2D keypoints
        3. Applies knee rotation corrections to the SMPL model
        4. Regenerates the mesh with corrected pose
        
        Args:
            image_rgb: RGB image as numpy array (H, W, 3)
            keypoints_2d: Dict mapping landmark names to (x, y, visibility)
            
        Returns:
            Dictionary containing corrected vertices, faces, joints, and params
        """
        if self.model is None or self.smpl is None:
            raise RuntimeError("SPIN model is not initialized.")
        
        height, width = image_rgb.shape[:2]
        
        # First, run standard SPIN
        with torch.no_grad():
            input_tensor = self._preprocess_image(image_rgb)
            pred_rotmat, pred_betas, pred_camera = self.model(input_tensor)
        
        # Calculate knee angles from MediaPipe 2D keypoints
        def get_2d_angle(p1, p2, p3):
            """Calculate angle at p2 formed by p1-p2-p3."""
            if p1 is None or p2 is None or p3 is None:
                return None
            v1 = np.array([p1[0] - p2[0], p1[1] - p2[1]])
            v2 = np.array([p3[0] - p2[0], p3[1] - p2[1]])
            v1_norm = v1 / (np.linalg.norm(v1) + 1e-8)
            v2_norm = v2 / (np.linalg.norm(v2) + 1e-8)
            dot = np.clip(np.dot(v1_norm, v2_norm), -1.0, 1.0)
            return np.degrees(np.arccos(dot))
        
        def get_point(name):
            if name in keypoints_2d:
                x, y, vis = keypoints_2d[name]
                if vis > 0.3:
                    return (x, y)
            return None
        
        # Get knee angles from MediaPipe
        left_hip = get_point("LEFT_HIP")
        left_knee = get_point("LEFT_KNEE")
        left_ankle = get_point("LEFT_ANKLE")
        right_hip = get_point("RIGHT_HIP")
        right_knee = get_point("RIGHT_KNEE")
        right_ankle = get_point("RIGHT_ANKLE")
        
        left_knee_angle = get_2d_angle(left_hip, left_knee, left_ankle)
        right_knee_angle = get_2d_angle(right_hip, right_knee, right_ankle)
        
        print(f"MediaPipe knee angles - Left: {left_knee_angle:.1f} deg, Right: {right_knee_angle:.1f} deg" 
              if left_knee_angle and right_knee_angle else "Could not detect knee angles")
        
        # SMPL joint indices for knees:
        # Body pose is 23 joints (excluding root), each with 3x3 rotation matrix
        # Joint order: 0=pelvis(root), 1=left_hip, 2=right_hip, 3=spine1,
        # 4=left_knee, 5=right_knee, 6=spine2, 7=left_ankle, 8=right_ankle, ...
        # So in body_pose (without root): left_knee=3, right_knee=4
        LEFT_KNEE_IDX = 3   # Index in body_pose (0-indexed, after root)
        RIGHT_KNEE_IDX = 4
        
        # Clone the rotation matrices for modification
        corrected_rotmat = pred_rotmat.clone()
        
        def create_knee_rotation(angle_deg, axis='x'):
            """Create a rotation matrix for knee bend around X axis."""
            # Knee bends around the X axis (medial-lateral axis)
            # A straight leg is 180 degrees, so the bend amount is (180 - angle)
            bend_rad = np.radians(180.0 - angle_deg)
            
            c, s = np.cos(bend_rad), np.sin(bend_rad)
            if axis == 'x':
                rot = np.array([
                    [1, 0, 0],
                    [0, c, -s],
                    [0, s, c]
                ], dtype=np.float32)
            return torch.tensor(rot, device=self.device, dtype=torch.float32)
        
        # Apply knee corrections if we have valid angles
        if left_knee_angle is not None and left_knee_angle < 170:
            # Significant knee bend detected
            new_rot = create_knee_rotation(left_knee_angle)
            corrected_rotmat[0, LEFT_KNEE_IDX + 1] = new_rot  # +1 because index 0 is global orient
            print(f"Applied left knee correction: {180 - left_knee_angle:.1f} deg bend")
        
        if right_knee_angle is not None and right_knee_angle < 170:
            # Significant knee bend detected
            new_rot = create_knee_rotation(right_knee_angle)
            corrected_rotmat[0, RIGHT_KNEE_IDX + 1] = new_rot  # +1 because index 0 is global orient
            print(f"Applied right knee correction: {180 - right_knee_angle:.1f} deg bend")
        
        # Regenerate mesh with corrected pose
        with torch.no_grad():
            smpl_output = self.smpl(
                betas=pred_betas,
                body_pose=corrected_rotmat[:, 1:],
                global_orient=corrected_rotmat[:, 0].unsqueeze(1),
                pose2rot=False
            )
            
            vertices = smpl_output.vertices[0].cpu().numpy()
            joints_3d = smpl_output.joints[0].cpu().numpy()
        
        smpl_params = {
            "betas": pred_betas[0].cpu().numpy(),
            "rotmat": corrected_rotmat[0].cpu().numpy(),
            "camera": pred_camera[0].cpu().numpy(),
        }
        
        result = {
            "vertices": vertices,
            "faces": self.faces,
            "joints_3d": joints_3d,
            "smpl_params": smpl_params,
            "knee_correction_applied": True,
            "left_knee_angle": left_knee_angle,
            "right_knee_angle": right_knee_angle,
        }
        return result

    def run_with_keypoints(
        self, 
        image_rgb: np.ndarray, 
        keypoints_2d: Dict[str, tuple],
        num_iterations: int = 100
    ) -> Dict[str, Any]:
        """
        Run SPIN with 2-stage keypoint refinement.
        
        Stage 1: Adjust camera and global orientation only
        Stage 2: Gently refine body pose while staying close to SPIN prediction
        
        Args:
            image_rgb: RGB image as numpy array (H, W, 3)
            keypoints_2d: Dict mapping landmark names to (x, y, visibility)
            num_iterations: Number of optimization iterations per stage
            
        Returns:
            Dictionary containing refined vertices, faces, joints, and params
        """
        if self.model is None or self.smpl is None:
            raise RuntimeError("SPIN model is not initialized.")
        
        height, width = image_rgb.shape[:2]
        
        # First, run standard SPIN to get initial estimate
        with torch.no_grad():
            input_tensor = self._preprocess_image(image_rgb)
            pred_rotmat, pred_betas, pred_camera = self.model(input_tensor)
        
        # SPIN uses SMPL joints with extended joints (49 total)
        # Indices 0-23 are body joints, 24-48 are extended
        # SMPL body joint order:
        # 0: pelvis, 1: left_hip, 2: right_hip, 3: spine1
        # 4: left_knee, 5: right_knee, 6: spine2, 7: left_ankle
        # 8: right_ankle, 9: spine3, 10: left_foot, 11: right_foot
        # 12: neck, 13: left_collar, 14: right_collar, 15: head
        # 16: left_shoulder, 17: right_shoulder, 18: left_elbow, 19: right_elbow
        # 20: left_wrist, 21: right_wrist, 22: left_hand, 23: right_hand
        
        # MediaPipe to SMPL joint mapping
        # NOTE: MediaPipe "LEFT" is the person's left side as seen from BEHIND
        # SMPL "left" is also the person's left side
        # So they should match directly
        mp_to_smpl = {
            "LEFT_HIP": 1, "RIGHT_HIP": 2,
            "LEFT_KNEE": 4, "RIGHT_KNEE": 5,
            "LEFT_ANKLE": 7, "RIGHT_ANKLE": 8,
            "LEFT_SHOULDER": 16, "RIGHT_SHOULDER": 17,
            "LEFT_ELBOW": 18, "RIGHT_ELBOW": 19,
            "LEFT_WRIST": 20, "RIGHT_WRIST": 21,
            # Add more joints for better alignment
            "NOSE": 15,  # Use head joint for nose
        }
        
        # Collect visible keypoints with extra weight for arm joints
        target_joints_2d = []
        joint_indices = []
        joint_weights = []
        
        # Arm joints are critical for bowling action - give them higher weight
        arm_joints = {"LEFT_SHOULDER", "RIGHT_SHOULDER", "LEFT_ELBOW", "RIGHT_ELBOW", 
                      "LEFT_WRIST", "RIGHT_WRIST"}
        
        for mp_name, smpl_idx in mp_to_smpl.items():
            if mp_name in keypoints_2d:
                x, y, vis = keypoints_2d[mp_name]
                if vis > 0.2:  # Lower threshold to include more points
                    x_norm = (x / width) * 2 - 1
                    y_norm = (y / height) * 2 - 1
                    target_joints_2d.append([x_norm, y_norm])
                    joint_indices.append(smpl_idx)
                    
                    # Extra weight for arm joints (critical for bowling)
                    weight = vis * 3.0 if mp_name in arm_joints else vis
                    joint_weights.append(weight)
        
        if len(target_joints_2d) < 4:
            print("Not enough keypoints, using standard SPIN output")
            return self.run(image_rgb)
        
        print(f"Refining with {len(target_joints_2d)} keypoints (arm-weighted)")
        
        target_joints_2d = torch.tensor(target_joints_2d, dtype=torch.float32, device=self.device)
        joint_indices = torch.tensor(joint_indices, dtype=torch.long, device=self.device)
        joint_weights = torch.tensor(joint_weights, dtype=torch.float32, device=self.device)
        joint_weights = joint_weights / joint_weights.sum()
        
        # ========== STAGE 1: Camera + Global Orientation ==========
        opt_global_orient = pred_rotmat[:, 0:1].clone().detach().requires_grad_(True)
        opt_camera = pred_camera.clone().detach().requires_grad_(True)
        fixed_body_pose = pred_rotmat[:, 1:].detach()
        fixed_betas = pred_betas.detach()
        
        optimizer1 = torch.optim.Adam([
            {'params': opt_global_orient, 'lr': 0.01},
            {'params': opt_camera, 'lr': 0.02},
        ])
        
        for i in range(num_iterations):
            optimizer1.zero_grad()
            
            smpl_output = self.smpl(
                betas=fixed_betas,
                body_pose=fixed_body_pose,
                global_orient=opt_global_orient,
                pose2rot=False
            )
            
            joints_3d = smpl_output.joints[0, :24]
            selected_joints = joints_3d[joint_indices]
            
            cam_s, cam_tx, cam_ty = opt_camera[0, 0], opt_camera[0, 1], opt_camera[0, 2]
            proj_x = cam_s * selected_joints[:, 0] + cam_tx
            proj_y = cam_s * selected_joints[:, 1] + cam_ty
            projected_2d = torch.stack([proj_x, proj_y], dim=1)
            
            loss = (joint_weights * (projected_2d - target_joints_2d).pow(2).sum(dim=1)).sum()
            loss.backward()
            optimizer1.step()
            
            with torch.no_grad():
                U, _, V = torch.svd(opt_global_orient[0, 0])
                opt_global_orient[0, 0] = torch.mm(U, V.t())
        
        stage1_loss = loss.item()
        print(f"Stage 1 done. Loss: {stage1_loss:.4f}")
        
        # ========== STAGE 2: Gentle Body Pose Refinement ==========
        # Now also optimize body pose, but with strong regularization
        opt_body_pose = fixed_body_pose.clone().requires_grad_(True)
        init_body_pose = fixed_body_pose.clone()  # For regularization
        
        optimizer2 = torch.optim.Adam([
            {'params': opt_global_orient, 'lr': 0.01},
            {'params': opt_camera, 'lr': 0.02},
            {'params': opt_body_pose, 'lr': 0.02},  # Higher LR for pose to fix arm positions
        ])
        
        best_loss = float('inf')
        best_orient = opt_global_orient.clone()
        best_camera = opt_camera.clone()
        best_body_pose = opt_body_pose.clone()
        
        for i in range(num_iterations):
            optimizer2.zero_grad()
            
            smpl_output = self.smpl(
                betas=fixed_betas,
                body_pose=opt_body_pose,
                global_orient=opt_global_orient,
                pose2rot=False
            )
            
            joints_3d = smpl_output.joints[0, :24]
            selected_joints = joints_3d[joint_indices]
            
            cam_s, cam_tx, cam_ty = opt_camera[0, 0], opt_camera[0, 1], opt_camera[0, 2]
            proj_x = cam_s * selected_joints[:, 0] + cam_tx
            proj_y = cam_s * selected_joints[:, 1] + cam_ty
            projected_2d = torch.stack([proj_x, proj_y], dim=1)
            
            # 2D keypoint loss (weighted - arms have higher weight)
            loss_2d = (joint_weights * (projected_2d - target_joints_2d).pow(2).sum(dim=1)).sum()
            
            # Regularization: stay close to SPIN's body pose prediction
            # Lower regularization to allow bigger arm adjustments
            reg_loss = 0.02 * (opt_body_pose - init_body_pose).pow(2).mean()
            
            loss = loss_2d + reg_loss
            loss.backward()
            optimizer2.step()
            
            # Keep rotation matrices valid (orthogonalize)
            with torch.no_grad():
                U, _, V = torch.svd(opt_global_orient[0, 0])
                opt_global_orient[0, 0] = torch.mm(U, V.t())
                for j in range(opt_body_pose.shape[1]):
                    U, _, V = torch.svd(opt_body_pose[0, j])
                    opt_body_pose[0, j] = torch.mm(U, V.t())
            
            if loss.item() < best_loss:
                best_loss = loss.item()
                best_orient = opt_global_orient.clone()
                best_camera = opt_camera.clone()
                best_body_pose = opt_body_pose.clone()
        
        print(f"Stage 2 done. Loss: {best_loss:.4f}")
        
        # Final output
        with torch.no_grad():
            smpl_output = self.smpl(
                betas=fixed_betas,
                body_pose=best_body_pose,
                global_orient=best_orient,
                pose2rot=False
            )
            
            vertices = smpl_output.vertices[0].cpu().numpy()
            joints_3d = smpl_output.joints[0].cpu().numpy()
            
            full_rotmat = torch.cat([best_orient, best_body_pose], dim=1)
            
            smpl_params = {
                "betas": fixed_betas[0].cpu().numpy(),
                "rotmat": full_rotmat[0].cpu().numpy(),
                "camera": best_camera[0].cpu().numpy(),
            }
        
        return {
            "vertices": vertices,
            "faces": self.faces,
            "joints_3d": joints_3d,
            "smpl_params": smpl_params,
            "optimization_applied": True,
            "final_loss": best_loss,
        }
    
    def _compute_keypoint_loss_v2(
        self, opt_rotmat, opt_betas, opt_camera,
        target_joints_2d, joint_indices, joint_weights,
        init_rotmat, init_betas,
        regularization_weight=0.001
    ):
        """Compute the 2D keypoint reprojection loss with improved formulation."""
        # Run SMPL
        smpl_output = self.smpl(
            betas=opt_betas,
            body_pose=opt_rotmat[:, 1:],
            global_orient=opt_rotmat[:, 0].unsqueeze(1),
            pose2rot=False
        )
        
        # Get all joints (use the first 24 SMPL joints)
        joints_3d = smpl_output.joints[0, :24]  # (24, 3)
        
        # Project to 2D using weak perspective camera
        cam_scale = opt_camera[0, 0]
        cam_trans = opt_camera[0, 1:3]
        
        # Select joints we're optimizing
        selected_joints = joints_3d[joint_indices]  # (N, 3)
        
        # Weak perspective projection: x' = s * x + tx, y' = s * y + ty
        proj_x = cam_scale * selected_joints[:, 0] + cam_trans[0]
        proj_y = cam_scale * selected_joints[:, 1] + cam_trans[1]
        projected_2d = torch.stack([proj_x, proj_y], dim=1)  # (N, 2)
        
        # Weighted L1 loss (more robust than L2)
        diff = torch.abs(projected_2d - target_joints_2d)
        loss_2d = (joint_weights.unsqueeze(1) * diff).sum()
        
        # Very light regularization to allow pose to change significantly
        reg_pose = regularization_weight * (opt_rotmat - init_rotmat.detach()).pow(2).mean()
        reg_shape = regularization_weight * 0.1 * (opt_betas - init_betas.detach()).pow(2).mean()
        
        return loss_2d + reg_pose + reg_shape
    
    def _orthogonalize_rotmats(self, rotmat):
        """Ensure rotation matrices stay valid SO(3)."""
        with torch.no_grad():
            for j in range(rotmat.shape[1]):
                U, _, V = torch.svd(rotmat[0, j])
                rotmat[0, j] = torch.mm(U, V.t())


def save_mesh_and_joints(
    result_dict: Dict[str, Any],
    mesh_path: str,
    joints_path: str,
    smpl_params_path: str,
) -> None:
    """
    Save mesh as OBJ, joints as NPY, and SMPL params as NPZ.
    """
    vertices = result_dict["vertices"]  # (V, 3)
    faces = result_dict["faces"]        # (F, 3)
    joints_3d = result_dict["joints_3d"]
    smpl_params = result_dict["smpl_params"]

    # Save mesh as OBJ (1-based indexing)
    with open(mesh_path, "w", encoding="utf-8") as f:
        for v in vertices:
            f.write(f"v {v[0]} {v[1]} {v[2]}\n")
        for tri in faces:
            f.write(f"f {tri[0] + 1} {tri[1] + 1} {tri[2] + 1}\n")

    # Save joints
    np.save(joints_path, joints_3d)

    # Save SMPL params
    np.savez(smpl_params_path, **smpl_params)

