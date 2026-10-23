"""Download and verify the model weights BowlNet needs (about 225 MB total).

    python -m tools.download_models            # from backend/
    python -m tools.download_models --sam3d    # also the image-based 3D model (SAM 3D Body, gated, ~2.5 GB)

Sources (all official, public, non-gated):
  * YOLO11 pose (Ultralytics, AGPL-3.0)              github.com/ultralytics/assets releases
  * MotionBERT-Lite H36M (Zhu et al., Apache-2.0)    huggingface.co/walterzhu/MotionBERT
  * Body model: exported from NAVER Anny (Apache-2.0 code, CC0 assets) by tools/export_body_model.py;
    shipped in the repo as models/body/anny_body.npz (4.6 MB). Re-export with `pip install anny`.
  * Optional, --sam3d: SAM 3D Body ViT-H (Meta, SAM License) from huggingface.co/facebook/sam-3d-body-vith. It is
    gated: accept Meta's licence on that page and log in with `hf auth login` first (your own account and token;
    BowlNet never handles it). Its MHR body rig (Apache-2.0) comes from github.com/facebookresearch/MHR releases.
"""
from __future__ import annotations

import hashlib
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "models"

FILES = [
    ("yolo/yolo11m-pose.pt", "https://github.com/ultralytics/assets/releases/download/v8.3.0/yolo11m-pose.pt",
     "29b17eaf3a3117cbea906090dbedf9159f7c6a49db58ec8b99ed2dfde1cf6eb2"),
    ("yolo/yolo11x-pose.pt", "https://github.com/ultralytics/assets/releases/download/v8.3.0/yolo11x-pose.pt",
     "013c43543b0751b8918486ba96e01ee44a59040683a07f96cc22bcc2cb7785f8"),
    ("motionbert/FT_MB_lite_MB_ft_h36m_global_lite.bin",
     "https://huggingface.co/walterzhu/MotionBERT/resolve/main/checkpoint/pose3d/FT_MB_lite_MB_ft_h36m_global_lite/best_epoch.bin",
     "9811155371db4ca5d20f31a36a232d41012e12e1333882888a564d741861148f"),
]
BODY = ("body/anny_body.npz", "e57cb79fcfcf8c53025c125bb070758bc17b189424c98b4ad2ad0618b86570b9")


def sha256(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def fetch(url: str, dest: Path) -> None:
    tmp = dest.with_suffix(dest.suffix + ".part")
    dest.parent.mkdir(parents=True, exist_ok=True)

    def hook(n, bs, total):
        if total > 0:
            sys.stdout.write(f"\r  {dest.name}: {min(100, n * bs * 100 / total):5.1f}%")
            sys.stdout.flush()

    urllib.request.urlretrieve(url, tmp, hook)
    print()
    tmp.replace(dest)


MHR_ZIP = "https://github.com/facebookresearch/MHR/releases/download/v1.0.1/assets.zip"
MHR_SHA = "352e271a6c42729c68554ceaea0c955e866970160c31e35506d782dc0f7377bc"   # assets/mhr_model.pt


def fetch_sam3d() -> bool:
    import zipfile

    d = ROOT / "sam3d"
    d.mkdir(parents=True, exist_ok=True)
    mhr = d / "mhr_model.pt"
    if mhr.exists() and sha256(mhr) == MHR_SHA:
        print("ok       sam3d/mhr_model.pt")
    else:
        print("download sam3d/mhr_model.pt (MHR release, ~200 MB zip)")
        z = d / "mhr_assets.zip"
        fetch(MHR_ZIP, z)
        with zipfile.ZipFile(z) as zf:
            with zf.open("assets/mhr_model.pt") as src, open(mhr, "wb") as dst:
                while chunk := src.read(1 << 20):
                    dst.write(chunk)
        z.unlink(missing_ok=True)
        if sha256(mhr) != MHR_SHA:
            print("ERROR    checksum mismatch for sam3d/mhr_model.pt")
            mhr.unlink(missing_ok=True)
            return False
    if (d / "model.ckpt").exists() and (d / "model_config.yaml").exists():
        print("ok       sam3d/model.ckpt")
        return True
    try:
        from huggingface_hub import hf_hub_download
        for name in ("model_config.yaml", "model.ckpt"):
            print(f"download sam3d/{name} (facebook/sam-3d-body-vith)")
            hf_hub_download("facebook/sam-3d-body-vith", name, local_dir=d)
    except Exception as e:   # noqa: BLE001 - gated repo: explain what the user has to do
        print(f"ERROR    couldn't download SAM 3D Body ({type(e).__name__}). Accept the licence at "
              "https://huggingface.co/facebook/sam-3d-body-vith, then run `hf auth login` and try again.")
        return False
    return True


def main() -> int:
    ok = True
    if "--sam3d" in sys.argv:
        ok = fetch_sam3d()
    for rel, url, digest in FILES:
        p = ROOT / rel
        if p.exists() and sha256(p) == digest:
            print(f"ok       {rel}")
            continue
        print(f"download {rel}")
        fetch(url, p)
        if sha256(p) != digest:
            print(f"ERROR    checksum mismatch for {rel}")
            p.unlink(missing_ok=True)
            ok = False
    body = ROOT / BODY[0]
    if not body.exists():
        print("missing  body/anny_body.npz -> run: pip install anny && python -m tools.export_body_model")
        ok = False
    elif sha256(body) != BODY[1]:
        print("note     body/anny_body.npz differs from the reference export (fine if you re-exported it)")
    else:
        print(f"ok       {BODY[0]}")
    print("all models ready" if ok else "some models are missing")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
