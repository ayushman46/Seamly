#!/usr/bin/env python3
"""
Convert SMPL .pkl files from chumpy format to plain numpy format.
This fixes the "No module named 'chumpy'" error when loading SMPL models.
"""

import pickle
import numpy as np
import os
from pathlib import Path


class ChumpyStub:
    """Stub class to handle chumpy objects during unpickling."""
    pass


def load_smpl_with_chumpy_stub(pkl_path):
    """Load SMPL .pkl file by stubbing out chumpy."""
    # Create a stub module for chumpy
    import sys
    import types
    
    # Create fake chumpy module
    fake_chumpy = types.ModuleType('chumpy')
    fake_chumpy.Ch = ChumpyStub
    sys.modules['chumpy'] = fake_chumpy
    
    # Also create ch submodule
    fake_ch = types.ModuleType('ch')
    sys.modules['chumpy.ch'] = fake_ch
    
    # Now try to load
    with open(pkl_path, 'rb') as f:
        data = pickle.load(f, encoding='latin1')
    
    # Clean up
    del sys.modules['chumpy']
    if 'chumpy.ch' in sys.modules:
        del sys.modules['chumpy.ch']
    
    return data


def convert_chumpy_to_numpy(obj):
    """Recursively convert chumpy arrays to numpy arrays."""
    if isinstance(obj, ChumpyStub):
        # If it has an 'r' attribute (chumpy array result), use that
        if hasattr(obj, 'r'):
            return np.array(obj.r)
        # Otherwise try to convert directly
        return np.array(obj)
    elif isinstance(obj, dict):
        return {k: convert_chumpy_to_numpy(v) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [convert_chumpy_to_numpy(item) for item in obj]
    elif isinstance(obj, tuple):
        return tuple(convert_chumpy_to_numpy(item) for item in obj)
    else:
        return obj


def convert_smpl_file(input_path, output_path=None):
    """Convert SMPL .pkl file from chumpy to numpy format."""
    if output_path is None:
        # Create backup
        backup_path = str(input_path) + '.chumpy_backup'
        if not os.path.exists(backup_path):
            print(f"  Creating backup: {backup_path}")
            import shutil
            shutil.copy2(input_path, backup_path)
        output_path = input_path
    
    print(f"  Loading: {input_path}")
    data = load_smpl_with_chumpy_stub(input_path)
    
    print(f"  Converting chumpy arrays to numpy...")
    converted_data = convert_chumpy_to_numpy(data)
    
    print(f"  Saving: {output_path}")
    with open(output_path, 'wb') as f:
        pickle.dump(converted_data, f, protocol=2)
    
    print(f"   Converted successfully")


def main():
    print("=" * 60)
    print("SMPL File Converter (chumpy → numpy)")
    print("=" * 60)
    print()
    
    spin_src = Path(__file__).parent / "spin_src"
    smpl_dir = spin_src / "data" / "smpl"
    
    if not smpl_dir.exists():
        print(f"ERROR: SMPL directory not found: {smpl_dir}")
        return 1
    
    smpl_files = list(smpl_dir.glob("SMPL_*.pkl"))
    
    if not smpl_files:
        print(f"ERROR: No SMPL_*.pkl files found in {smpl_dir}")
        return 1
    
    print(f"Found {len(smpl_files)} SMPL files to convert:")
    for f in smpl_files:
        print(f"  - {f.name}")
    print()
    
    for smpl_file in smpl_files:
        print(f"\nConverting {smpl_file.name}...")
        try:
            convert_smpl_file(smpl_file)
        except Exception as e:
            print(f"  ✗ Error: {e}")
            import traceback
            traceback.print_exc()
            return 1
    
    print()
    print("=" * 60)
    print(" All SMPL files converted successfully!")
    print("=" * 60)
    print()
    print("The SMPL files have been converted to numpy format.")
    print("Backups of the original files are saved with .chumpy_backup extension.")
    print()
    print("You can now use SMPL models without chumpy!")
    
    return 0


if __name__ == "__main__":
    import sys
    sys.exit(main())
