import numpy as np

from bowlnet.pose2d import butter_smooth, fix_swaps, interpolate_gaps


def _walk(T=60):
    t = np.arange(T)
    kp = np.zeros((T, 17, 2), np.float32)
    for j in range(17):
        kp[:, j, 0] = 300 + (j % 2) * 40 + 2 * t       # left joints at x, right joints at x+40
        kp[:, j, 1] = 100 + 20 * (j // 2)
    return kp, np.ones((T, 17), np.float32)


def test_isolated_left_right_swaps_are_repaired():
    kp, kc = _walk()
    bad = kp.copy()
    L, R = [5, 7, 9], [6, 8, 10]
    for t in (20, 21, 40):
        bad[t, L + R] = bad[t, R + L]
    fixed, _, n = fix_swaps(bad, kc)
    assert n >= 3
    assert np.allclose(fixed, kp)


def test_consistent_labelling_is_left_alone():
    kp, kc = _walk()
    fixed, _, n = fix_swaps(kp, kc)
    assert n == 0 and np.allclose(fixed, kp)


def test_gap_interpolation_marks_low_confidence():
    kp, kc = _walk()
    kc[10:14, 9] = 0
    out, c = interpolate_gaps(kp, kc, fps=30)
    assert np.allclose(out[10:14, 9], kp[10:14, 9], atol=1e-3)
    assert np.all(c[10:14, 9] < 0.2)


def test_butterworth_keeps_slow_signal():
    t = np.arange(120) / 120.0
    x = np.sin(2 * np.pi * 2 * t)[:, None]
    y = butter_smooth(x, fps=120, cutoff_hz=10)
    assert np.max(np.abs(y - x)) < 0.05
