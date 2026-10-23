import os
import uuid

# Root folder where results for each run will be stored
RESULTS_ROOT = "results"

# Path to the SPIN repo (relative to project root)
SPIN_ROOT = os.path.join(os.path.dirname(__file__), "..", "spin_src")
SPIN_ROOT = os.path.abspath(SPIN_ROOT)


def make_run_dir() -> str:
    """
    Create a new run directory under RESULTS_ROOT, named with a short UUID.
    Returns the absolute path to the new run directory.
    """
    os.makedirs(RESULTS_ROOT, exist_ok=True)
    run_id = str(uuid.uuid4())[:8]
    run_dir = os.path.join(RESULTS_ROOT, run_id)
    os.makedirs(run_dir, exist_ok=True)
    return os.path.abspath(run_dir)
