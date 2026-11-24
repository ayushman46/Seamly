# Models in this folder

| File | Model | Licence | Source |
|---|---|---|---|
| `rtmo-s.onnx.part1..2` | RTMO-s, body7, 640x640 (one-stage multi-person pose) | Apache-2.0 | OpenMMLab MMPose, `projects/rtmo`: `rtmo-s_8xb32-600e_body7-640x640-dac2bf74_20231211` |
| `rtmpose-l-halpe26-384.onnx.part1..6` | RTMPose-l, body7 + Halpe26, 384x288 (top-down pose, 26 keypoints) | Apache-2.0 | OpenMMLab MMPose, `projects/rtmpose`: `rtmpose-l_simcc-body7_pt-body7-halpe26_700e-384x288-734182ce_20230605` |
| `motionbert_lite_int8.onnx` | MotionBERT-Lite (2D to 3D lifting), int8 | Apache-2.0 | github.com/Walter0807/MotionBERT |
| `anny_body.bin`, `anny_body.json` | Anny body model asset | see the repository README | github.com/naver/anny |

The `.partN` files are the ONNX file cut into pieces under 20 MB (a CDN limit); joined in order they are the original
file byte for byte. The pose models are unmodified exports published by OpenMMLab at download.openmmlab.com.
