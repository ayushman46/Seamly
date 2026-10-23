#!/usr/bin/env python3
"""
Python version of setup script to download SPIN model data files.
Works on all platforms without requiring wget or curl.
"""

import os
import sys
import urllib.request
import tarfile
from pathlib import Path


def download_file(url, destination, description="file"):
    """Download a file with progress indication."""
    print(f"Downloading {description}...")
    
    def progress_hook(block_num, block_size, total_size):
        downloaded = block_num * block_size
        if total_size > 0:
            percent = min(downloaded * 100 / total_size, 100)
            size_mb = total_size / 1024 / 1024
            downloaded_mb = downloaded / 1024 / 1024
            sys.stdout.write(f"\r  Progress: {percent:.1f}% ({downloaded_mb:.1f}/{size_mb:.1f} MB)")
            sys.stdout.flush()
    
    try:
        urllib.request.urlretrieve(url, destination, progress_hook)
        print(f"\n {description} downloaded successfully")
        return True
    except Exception as e:
        print(f"\n✗ Error downloading {description}: {e}")
        return False


def extract_tarfile(tar_path, destination):
    """Extract a tar.gz file."""
    print(f"Extracting {tar_path}...")
    try:
        with tarfile.open(tar_path, "r:gz") as tar:
            tar.extractall(destination)
        print(" Extraction complete")
        return True
    except Exception as e:
        print(f"✗ Error extracting: {e}")
        return False


def main():
    print("=" * 60)
    print("SPIN Data Setup Script (Python version)")
    print("=" * 60)
    print()
    
    # Get paths
    script_dir = Path(__file__).parent
    spin_dir = script_dir / "spin_src"
    
    if not spin_dir.exists():
        print(f"ERROR: spin_src directory not found at {spin_dir}")
        print("Please ensure you have cloned the SPIN repository into spin_src/")
        return 1
    
    print(f"Working in: {spin_dir}")
    print()
    
    # Create data directory
    data_dir = spin_dir / "data"
    data_dir.mkdir(exist_ok=True)
    
    # Download model checkpoint
    checkpoint_path = data_dir / "model_checkpoint.pt"
    if not checkpoint_path.exists():
        success = download_file(
            "http://visiondata.cis.upenn.edu/spin/model_checkpoint.pt",
            checkpoint_path,
            "SPIN model checkpoint (~300MB)"
        )
        if not success:
            return 1
    else:
        print(" Model checkpoint already exists")
    
    # Download and extract data files
    mean_params_path = data_dir / "smpl_mean_params.npz"
    if not mean_params_path.exists():
        print()
        print("Downloading SPIN data package (includes mean params, regressors, etc.)...")
        tar_path = spin_dir / "data.tar.gz"
        
        success = download_file(
            "http://visiondata.cis.upenn.edu/spin/data.tar.gz",
            tar_path,
            "SPIN data package (~200MB)"
        )
        
        if success:
            print()
            success = extract_tarfile(tar_path, spin_dir)
            
            if success:
                # Clean up tar file
                tar_path.unlink()
                print(" SPIN data files ready")
        
        if not success:
            return 1
    else:
        print(" SMPL mean parameters already exist")
    
    # Check for SMPL models
    print()
    print("Checking SMPL model files...")
    smpl_dir = data_dir / "smpl"
    
    if not smpl_dir.exists():
        smpl_dir.mkdir(exist_ok=True)
    
    smpl_models = {
        "SMPL_NEUTRAL.pkl": "required",
        "SMPL_MALE.pkl": "optional",
        "SMPL_FEMALE.pkl": "optional",
    }
    
    missing_required = False
    for model_name, status in smpl_models.items():
        model_path = smpl_dir / model_name
        if model_path.exists():
            size_mb = model_path.stat().st_size / 1024 / 1024
            print(f" {model_name} ({size_mb:.1f} MB)")
        else:
            symbol = "✗" if status == "required" else "⚠"
            print(f"{symbol} {model_name} - {status}")
            if status == "required":
                missing_required = True
    
    if missing_required:
        print()
        print("=" * 60)
        print("WARNING: Required SMPL model files not found!")
        print("=" * 60)
        print()
        print("You need to manually download the SMPL models from:")
        print("  - Neutral model (required): http://smplify.is.tue.mpg.de")
        print("  - Male/Female models (optional): http://smpl.is.tue.mpg.de")
        print()
        print("After downloading, rename them to:")
        print("  - SMPL_NEUTRAL.pkl")
        print("  - SMPL_MALE.pkl")
        print("  - SMPL_FEMALE.pkl")
        print()
        print(f"And place them in: {smpl_dir}")
        print()
        print("NOTE: Registration is required to download SMPL models.")
    
    print()
    print("=" * 60)
    print("Setup Complete!")
    print("=" * 60)
    print()
    print("Next steps:")
    print("1. Ensure SMPL models are in place (see above if missing)")
    print("2. Install Python dependencies:")
    print("   pip install -r requirements.txt")
    print("   pip install -r spin_src/requirements.txt")
    print("3. Validate setup:")
    print("   python validate_setup.py")
    print("4. Run the app:")
    print("   streamlit run app.py")
    print()
    
    return 0


if __name__ == "__main__":
    sys.exit(main())
