# Compatibility Fixes & Known Issues

## Python 3.12 Compatibility Issues - RESOLVED 

This document tracks ALL compatibility fixes applied to make SPIN (designed for Python 3.6/PyTorch 1.1) work with modern Python 3.12/PyTorch 2.x.

### Critical Fixes Applied

#### 1. `chumpy` Python 3.12 Incompatibility - FIXED 
**Error:** `AttributeError: module 'inspect' has no attribute 'getargspec'` + `cannot import name 'bool' from 'numpy'`

**Root Cause:** 
- `chumpy` uses `inspect.getargspec()` (removed in Python 3.11+, replaced with `getfullargspec`)
- `chumpy` imports old numpy type aliases (`numpy.bool`, `numpy.int`, etc.) that were removed in numpy 1.20+
- These issues prevent SMPL pickle files from being loaded

**Fix Applied:** Created `chumpy_compat.py` compatibility shim that patches the environment BEFORE importing chumpy:
```python
# Patch 1: inspect.getargspec → inspect.getfullargspec
import inspect
if not hasattr(inspect, 'getargspec'):
    inspect.getargspec = inspect.getfullargspec

# Patch 2: numpy type aliases
import numpy as np
if not hasattr(np, 'bool'):
    np.bool = np.bool_
if not hasattr(np, 'int'):
    np.int = np.int_
# ... (and other numpy aliases)
```

**Usage:** Import `chumpy_compat` at the very top of any module that uses SPIN/SMPL:
```python
import chumpy_compat  # Must be FIRST import
from src.reconstruction.spin_wrapper import SpinModelWrapper
```

**Status:**  FULLY FIXED - chumpy now loads successfully, SMPL pickles can be unpickled

---

#### 2. `smplx.body_models.ModelOutput` Import Error - FIXED 
**Error:** `cannot import name 'ModelOutput' from 'smplx.body_models'`

**Root Cause:** Newer versions of `smplx` (>=0.1.28) changed their internal API and removed/moved `ModelOutput`.

**Fix Applied:** Modified `spin_src/models/smpl.py` to include a compatibility layer:
```python
try:
    from smplx.body_models import ModelOutput
except ImportError:
    from collections import namedtuple
    ModelOutput = namedtuple('ModelOutput', 
                            ['vertices', 'global_orient', 'body_pose', 'joints', 'betas', 'full_pose'])
```

**Status:**  FIXED - The code now works with both old and new smplx versions.

---

#### 3. PyTorch 2.6+ `torch.load()` Security Change - FIXED 
**Error:** `Weights only load failed... weights_only argument changed from False to True`

**Root Cause:** PyTorch 2.6+ changed the default `weights_only` parameter in `torch.load()` to `True` for security. SPIN checkpoint contains custom objects that require `weights_only=False`.

**Fix Applied:** Modified `src/reconstruction/spin_wrapper.py` line 93:
```python
checkpoint = torch.load(checkpoint_path, map_location=self.device, weights_only=False)
```

**Status:**  FIXED - SPIN checkpoint loads successfully

---

#### 4. SPIN Relative Path Issues - FIXED 
**Error:** `FileNotFoundError: [Errno 2] No such file or directory: 'data/J_regressor_extra.npy'`

**Root Cause:** SPIN's `config.py` uses relative paths (e.g., `'data/J_regressor_extra.npy'`) that only work when running from the `spin_src/` directory.

**Fix Applied:** Modified `src/reconstruction/spin_wrapper.py` to change working directory during initialization:
```python
def _init_spin(self):
    original_cwd = os.getcwd()
    os.chdir(self.spin_root)  # Change to spin_src
    try:
        # All SPIN initialization here
        ...
    finally:
        os.chdir(original_cwd)  # Always restore
```

**Status:**  FIXED - SPIN can find all data files

---

#### 5. Missing `tensorboard` Dependency - FIXED 
**Error:** `No module named 'tensorboard'`

**Root Cause:** `tensorboard` was in SPIN's requirements but not installed.

**Fix Applied:** 
```bash
pip install tensorboard
```

**Status:**  FIXED

---

#### 6. macOS `wget` Unavailable - FIXED 
**Error:** `wget: command not found`

**Root Cause:** macOS doesn't include `wget` by default.

**Fix Applied:** 
- Modified `setup_spin.sh` to use `curl` instead of `wget`
- Created `setup_spin.py` as Python alternative using `urllib`

**Status:**  FIXED

---

## Package Version Summary

### What's Installed (Compatible with Python 3.12):
```
torch 2.9.1              # Modern version (SPIN designed for 1.1.0)
torchvision 0.20.1       # Compatible with torch 2.9.1
smplx 0.1.28            # Latest, with compatibility fix applied
scipy 1.14.1            # Modern version (SPIN used 1.0.0)
numpy 1.26.4            # Compatible
opencv-python 4.11.0    # Compatible
pyrender 0.1.45         # Compatible
trimesh 4.5.3           # Compatible
tensorboard 2.19.0      # Installed
scikit-image 0.25.0     # Compatible
chumpy 0.70             # Installed with compatibility patches
```

### What's NOT Installed (Not Needed for Inference):
```
neural-renderer-pytorch  # Training-only (visualization), build issues
torchgeometry           # Training-only, deprecated
spacepy                 # Dataset preprocessing only (H36M)
```

---

## Testing Results

###  What Works:
- [x] SPIN model initialization
- [x] Loading pretrained checkpoint
- [x] SMPL body model loading (with chumpy compatibility)
- [x] SpinModelWrapper full initialization
- [x] All compatibility patches applied automatically
- [x] Vertex and joint output
- [x] Camera parameter prediction

### ⏭️ What's Skipped (Training-Only):
- [ ] SMPLify optimization (needs chumpy)
- [ ] Neural renderer (build issues)
- [ ] Training loops (not needed)
- [ ] Dataset preprocessing (not needed)

---

## Future-Proofing

### If You Encounter New Errors:

#### Import Errors from SPIN Code
**Likely cause:** SPIN imports incompatible or renamed modules.

**Fix approach:**
1. Check if the module is actually used in inference (grep the codebase)
2. If not used, it's safe to skip/remove
3. If used, add a compatibility import like we did for `ModelOutput`

#### Version Conflicts
**Likely cause:** SPIN expects old package APIs.

**Fix approach:**
1. Try running with modern versions first
2. If specific functionality breaks, add compatibility shims
3. Document the workaround in this file

#### Deprecated Function Calls
**Example:** `inspect.getargspec()` → `inspect.getfullargspec()`

**Fix approach:**
1. Only fix if the code path is actually executed during inference
2. Most deprecation issues are in training-only code paths

---

## Validation

Run this to verify everything is working:

```bash
cd /Users/ayush/Downloads/bowlin
python -c "
import sys
sys.path.insert(0, 'spin_src')
from models import hmr, SMPL
import torch
print('✓ SPIN modules import successfully')
print('✓ HMR model:', hmr)
print('✓ SMPL model:', SMPL)
"
```

Expected output:
```
✓ SPIN modules import successfully
✓ HMR model: <function hmr at 0x...>
✓ SMPL model: <class 'models.smpl.SMPL'>
```

---

## Summary

**All critical compatibility issues have been resolved!** 

The app can now:
1.  Import SPIN modules without errors
2.  Load SMPL models
3.  Run inference on images
4.  Generate 3D meshes and joints
5.  Work with Python 3.12 and modern PyTorch

**The only limitation:** Training/optimization features are disabled (not needed for your use case).
