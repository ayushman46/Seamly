Vendored from https://github.com/facebookresearch/sam-3d-body (main, fetched 2026-10-23) under the SAM License
(LICENSE-SAM). Only the model package is included; the demo, detectors and visualisation are not used.

Local changes (marked "BowlNet:" in the code):
- models/meta_arch/sam3d_body.py: hard-coded .cuda() calls replaced with the input tensor's device, so the
  model runs on Apple MPS and CPU.
- models/heads/mhr_head.py: the TorchScript MHR body model is loaded on CPU and moved with the model.
Checkpoints are not included: they are gated on Hugging Face (facebook/sam-3d-body-dinov3, -vith) and are
downloaded into backend/models/sam3d/ after the user has accepted Meta's licence.
- models/heads/mhr_head.py: the MHR TorchScript runs on the CPU in float32 (it uses float64 internally, which
  Apple MPS doesn't support) via a small _CPUOnly wrapper; the network itself runs on MPS.
