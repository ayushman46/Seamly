# Quick Start Guide

## TL;DR - Get Running in 5 Minutes

### Step 1: Download SPIN Data
```bash
cd /Users/ayush/Downloads/bowlin
./setup_spin.sh
```

This downloads the SPIN model checkpoint (~300MB) and required data files.

### Step 2: Verify SMPL Models

Check that your SMPL models are in place:
```bash
ls -lh spin_src/data/smpl/*.pkl
```

You should see:
- `SMPL_NEUTRAL.pkl` (required)
- `SMPL_MALE.pkl` (optional)
- `SMPL_FEMALE.pkl` (optional)

If missing, download from http://smplify.is.tue.mpg.de (requires registration).

### Step 3: Install Dependencies

```bash
# Activate your virtual environment (if not already active)
source .venv/bin/activate

# Install all dependencies
pip install -r requirements.txt
pip install tensorboard  # SPIN dependency
```

**Note**: Some SPIN packages are skipped as they're incompatible with Python 3.12 or only needed for training (not inference). This is normal and expected. See `COMPATIBILITY_FIXES.md` for details.

**Note**: If you get errors about scipy or deprecated functions, this is expected. The app has fallbacks.

### Step 4: Validate Setup

```bash
python validate_setup.py
```

This will check all dependencies and data files. All critical checks should pass.

### Step 5: Run the App

```bash
streamlit run app.py
```

The app will open at http://localhost:8501 in your browser.

### Step 6: Process a Video

1. Click "Upload bowling video"
2. Select a cricket bowling video (MP4, MOV, or AVI)
   - Side view works best
   - Person should be relatively centered
3. Click "Process Video"
4. Wait 1-3 minutes for processing
5. View results and download outputs!

## What You Get

After processing, you'll see:

1. **Delivery Frame Detection**: The detected moment of ball release with 2D skeleton overlay
2. **3D Mesh**: A rendered view of the reconstructed 3D body model
3. **Biomechanics Metrics**:
   - Elbow angle
   - Spine tilt
   - Shoulder abduction
   - Hip-shoulder separation
   - Release wrist height

4. **Downloads**:
   - `mesh.obj` - 3D model (open in Blender, MeshLab, etc.)
   - `joints_3d.npy` - NumPy array of joint positions
   - `metrics.json` - All computed metrics
   - `delivery_frame.jpg` - The detected frame

## Troubleshooting Quick Fixes

### "SPIN checkpoint not found"
```bash
./setup_spin.sh
```

### "SMPL model files not found"
Verify files are at `spin_src/data/smpl/SMPL_*.pkl`. Download from http://smplify.is.tue.mpg.de if missing.

### "No pose detected"
- Ensure person is visible and centered in video
- Try a different video with better lighting

### Import errors
```bash
pip install -r requirements.txt
pip install -r spin_src/requirements.txt
```

### PyRender/OpenGL errors (Linux)
```bash
export PYOPENGL_PLATFORM=egl
# Or install mesa:
sudo apt-get install libosmesa6-dev
```

## Expected Processing Time

- Short video (10-20 seconds): ~1 minute
- Medium video (30-60 seconds): ~2-3 minutes
- GPU available: ~30-50% faster

## File Structure After First Run

```
bowlin/
├── results/
│   └── session_<uuid>/
│       ├── input_video.mp4
│       ├── frames/
│       ├── delivery_frame.jpg
│       ├── delivery_frame_with_skeleton.jpg
│       ├── mesh.obj
│       ├── joints_3d.npy
│       ├── metrics.json
│       └── ...
└── ...
```

## Tips for Best Results

1. **Video Quality**: Use clear, well-lit videos
2. **Camera Angle**: Side view (perpendicular to bowling direction) works best
3. **Person Framing**: Bowler should be centered and fully visible
4. **Video Length**: Include the full bowling action (run-up to follow-through)
5. **Resolution**: 720p or higher recommended

## Next Steps

- See `README.md` for detailed documentation
- Check `validate_setup.py` output for any warnings
- Experiment with different videos to understand the system

## Support

If you encounter issues:

1. Run `python validate_setup.py` to check setup
2. Check the terminal output for error messages
3. Review `README.md` troubleshooting section
4. Ensure all dependencies are installed correctly

## Performance Notes

**With GPU (CUDA)**:
- SPIN inference: ~0.5-1 second
- Total per video: ~1-2 minutes

**CPU Only**:
- SPIN inference: ~3-5 seconds
- Total per video: ~2-5 minutes

The app will automatically use GPU if available.
