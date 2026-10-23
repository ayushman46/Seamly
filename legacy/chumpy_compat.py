"""
Compatibility shim for chumpy with Python 3.12+ and modern numpy.

This module patches the Python environment to make chumpy (designed for Python 2.7/3.6)
work with Python 3.12/3.13 and numpy 1.x/2.x.

Import this BEFORE importing chumpy or any module that imports chumpy.
"""
import sys
import inspect
import numpy as np


def _np_scalar_fallback(name: str):
    """Return a safe replacement for removed numpy scalar aliases.

    NumPy 2.x removed attributes like np.float, np.int, np.bool, etc. Accessing
    some of the legacy underscored variants (e.g. np.float_) can also fail,
    depending on the version/build.

    We resolve these lazily to avoid AttributeError at import-time.
    """
    # Prefer python builtins for the core aliases.
    builtin_map = {
        'bool': bool,
        'int': int,
        'float': float,
        'complex': complex,
        'object': object,
        'str': str,
        'unicode': str,
    }
    if name in builtin_map:
        return builtin_map[name]

    # Fallback to numpy dtypes if requested.
    dtype_map = {
        'float64': np.dtype('float64').type,
        'complex128': np.dtype('complex128').type,
    }
    return dtype_map.get(name)

def patch_environment():
    """Apply all necessary patches for chumpy compatibility."""
    
    # Patch 1: inspect.getargspec -> inspect.getfullargspec (removed in Python 3.11+)
    if not hasattr(inspect, 'getargspec'):
        inspect.getargspec = inspect.getfullargspec
        print("[OK] Patched inspect.getargspec")
    
    # Patch 2: numpy type aliases (removed in numpy 1.20+, blocked in numpy 2.0+)
    # Chumpy tries: from numpy import bool, int, float, complex, object, unicode, str
    # On numpy 2.x, these are intentionally gone AND numpy blocks re-adding them.
    # So we:
    #   1) best-effort set attributes only if allowed
    #   2) patch numpy.__getattr__ to return safe fallbacks

    type_mappings = [
        ('bool', _np_scalar_fallback('bool')),
        ('int', _np_scalar_fallback('int')),
        ('float', _np_scalar_fallback('float')),
        ('complex', _np_scalar_fallback('complex')),
        ('object', _np_scalar_fallback('object')),
        ('unicode', _np_scalar_fallback('unicode')),
        ('str', _np_scalar_fallback('str')),
    ]

    for name, replacement in type_mappings:
        try:
            # On numpy 1.x, these may still exist; don't override.
            if not hasattr(np, name) and replacement is not None:
                setattr(np, name, replacement)
        except Exception:
            # numpy 2.0+ blocks setting these attributes; ignore.
            pass
    
    # For numpy 2.0+, we need to patch the module's __getattr__
    _original_getattr = getattr(np, '__getattr__', None)
    
    def _patched_getattr(name):
        # Resolve lazily so this function doesn't itself crash on import.
        if name in {'bool', 'int', 'float', 'complex', 'object', 'unicode', 'str'}:
            repl = _np_scalar_fallback(name)
            if repl is not None:
                return repl
        if _original_getattr is not None:
            return _original_getattr(name)
        raise AttributeError(f"module 'numpy' has no attribute '{name}'")
    
    try:
        np.__getattr__ = _patched_getattr
    except (AttributeError, TypeError):
        pass  # If we can't patch it, chumpy may not work
    
    print("[OK] Patched numpy type aliases")

# Apply patches immediately when this module is imported
patch_environment()
