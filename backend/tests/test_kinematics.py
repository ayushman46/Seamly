import numpy as np

from bowlnet.kinematics import bone_lengths, estimate_world_frame, reconstruct


def _skeleton(T=40):
    rng = np.random.default_rng(0)
    base = np.array([[0, 0, 0], [-0.12, 0.02, 0], [-0.13, 0.45, 0.02], [-0.13, 0.87, 0], [0.12, 0.02, 0],
                     [0.13, 0.45, -0.02], [0.13, 0.87, 0], [0, -0.25, 0], [0, -0.5, 0], [0, -0.6, -0.08],
                     [0, -0.75, 0], [0.19, -0.48, 0], [0.22, -0.2, 0.05], [0.24, 0.05, 0.1], [-0.19, -0.48, 0],
                     [-0.25, -0.75, 0.05], [-0.3, -1.0, 0.1]], float)
    P = np.repeat(base[None], T, 0)
    ang = np.linspace(0, np.pi, T)
    P[:, 16, 2] = 0.3 * np.sin(ang)           # bowling wrist sweeps through depth
    return P + rng.normal(0, 0.002, P.shape)


def test_reconstruct_recovers_constant_bone_lengths_and_reprojects():
    P = _skeleton()
    k = 200.0
    kp2d = P[..., :2] * k + 500
    conf = np.ones(P.shape[:2])
    noisy = P * (1 + 0.15 * np.random.default_rng(1).normal(size=(len(P), 1, 1)))   # lifter scale jitter
    sk = reconstruct(noisy, kp2d, conf, stature_m=1.8, fps=30)
    L = bone_lengths(sk.joints)
    assert (L.std(0) / L.mean(0)).max() < 0.05
    assert np.median(sk.reproj_err_px) < 3.0


def test_world_frame_is_orthonormal_and_pitch_sign():
    P = np.zeros((1, 17, 3))
    # behind view, camera pitched down 10 deg: forward ground vector appears to rise in the image (-y)
    th = np.radians(10)
    P[0, 6] = [0.0, -np.sin(th) * 0.7, np.cos(th) * 0.7]     # left (front) ankle ahead
    # back ankle: on the ground 0.7 m behind, lifted 8 cm (heel up) along world up = (0, -cos, -sin)
    P[0, 3] = [0.0, np.sin(th) * 0.7 - 0.08 * np.cos(th), -np.cos(th) * 0.7 - 0.08 * np.sin(th)]
    wf = estimate_world_frame(P, 0, None, 6, 3, forward_hint=np.array([0, 0, 1.0]))
    R = np.stack([wf.forward, wf.lateral, wf.up])
    assert np.allclose(R @ R.T, np.eye(3), atol=1e-6)
    assert 5 < wf.camera_pitch_deg < 15
