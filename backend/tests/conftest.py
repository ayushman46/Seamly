import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
REPO = BACKEND.parent
sys.path.insert(0, str(BACKEND))

# Real broadcast clips used for regression tests (kept out of git; tests skip if absent).
CLIPS = {
    "bumrah_behind": REPO / "results" / "07ac01a5" / "input_video.mp4",
    "shami_behind": REPO / "results" / "3bddba70" / "input_video.mp4",
    "anderson_behind": REPO / "results" / "4a1bcad2" / "input_video.mp4",
}


def pytest_configure(config):
    config.addinivalue_line("markers", "slow: runs the full ML pipeline on real video (minutes)")


@pytest.fixture
def clip():
    def get(name):
        p = CLIPS[name]
        if not p.exists():
            pytest.skip(f"test clip {name} not available")
        return p
    return get
