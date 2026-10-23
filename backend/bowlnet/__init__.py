"""BowlNet: cricket bowling biomechanics from a single video.

Pipeline (see pipeline.py):
    video -> shot segmentation -> YOLO11 pose + tracking -> bowler identification
    -> top-down 2D refinement -> temporal cleanup -> MotionBERT 3D lifting
    -> skeleton refinement (constant bone lengths, metric scale) -> delivery events
    -> biomechanics metrics + coaching -> Anny body mesh fitting
"""

__version__ = "2.0.0"
