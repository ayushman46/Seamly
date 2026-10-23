import importlib
import sys
from pathlib import Path


# Allow importing repo root modules when running pytest from elsewhere.
ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def test_import_chumpy_compat_does_not_raise():
    # Should be safe on numpy 1.x and 2.x.
    importlib.import_module("chumpy_compat")
