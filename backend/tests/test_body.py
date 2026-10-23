import numpy as np

from bowlnet.body.fit import Fitter
from bowlnet.body.model import BodyModel


def test_rest_pose_reproduces_rest_mesh():
    m = BodyModel.get()
    inst = m.instance(1.80)
    T, B = 1, len(m.labels)
    D = np.tile(np.eye(3), (T, B, 1, 1))
    V = m.skin(inst, D, inst.rest_head[None])
    assert np.abs(V[0] - inst.rest_vertices).max() < 1e-6


def test_stature_matches_request():
    m = BodyModel.get()
    for h in (1.55, 1.80, 2.02):
        inst = m.instance(h)
        assert abs(inst.rest_vertices[:, 2].max() - h) < 1e-6


def test_fit_follows_limb_directions():
    m = BodyModel.get()
    inst = m.instance(1.80)
    f = Fitter(m, inst)
    # synthetic standing skeleton (H36M order, world axes x fwd, y left, z up)
    J = np.zeros((1, 17, 3))
    J[0] = [[0, 0, 0], [0, -0.12, -0.02], [0, -0.13, -0.45], [0, -0.13, -0.87], [0, 0.12, -0.02], [0, 0.13, -0.45],
            [0, 0.13, -0.87], [0, 0, 0.25], [0, 0, 0.5], [0.08, 0, 0.62], [0, 0, 0.75], [0, 0.19, 0.48],
            [0, 0.19, 0.2], [0.25, 0.19, 0.2], [0, -0.19, 0.48], [0, -0.19, 0.76], [0, -0.19, 1.02]]
    out = f.fit(J)
    H = out["heads"][0]
    b = f.b
    # right arm straight up: elbow and wrist above the shoulder
    assert H[b["lowerarm01.R"], 2] > H[b["upperarm01.R"], 2] + 0.2
    assert H[b["wrist.R"], 2] > H[b["lowerarm01.R"], 2] + 0.15
    # left forearm points forward (+x)
    assert H[b["wrist.L"], 0] - H[b["lowerarm01.L"], 0] > 0.15
