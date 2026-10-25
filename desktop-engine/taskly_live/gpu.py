"""Make the venv's NVIDIA runtime wheels visible to CTranslate2 (Windows).

CTranslate2's wheels link CUDA 12 dynamically: `cublas64_12.dll` and
cuDNN 9 must be loadable or every GPU decode dies with "cublas64_12.dll
not found". Rather than a system-wide CUDA toolkit, the model server PC
installs them into the engine's own venv:

    .venv\\Scripts\\pip install nvidia-cublas-cu12 "nvidia-cudnn-cu12==9.*"

pip unpacks them under `site-packages/nvidia/<lib>/bin`, which Windows
doesn't search. `add_nvidia_dll_dirs()` adds those folders (to the DLL
search path and PATH, since CTranslate2 loads cuBLAS lazily with a plain
LoadLibrary) before ctranslate2 is imported. Elsewhere it does nothing:
Linux wheels find their libraries through rpath/LD_LIBRARY_PATH.
"""

from __future__ import annotations

import logging
import os
import sys
from pathlib import Path

log = logging.getLogger(__name__)

_done = False


def add_nvidia_dll_dirs() -> list[str]:
    """The `nvidia/*/bin` folders made searchable (once per process)."""
    global _done
    if _done or os.name != "nt":
        return []
    _done = True
    added: list[str] = []
    for base in {Path(p) for p in sys.path if p and p.endswith("site-packages")}:
        nvidia = base / "nvidia"
        if not nvidia.is_dir():
            continue
        for bin_dir in sorted(nvidia.glob("*/bin")):
            if not any(bin_dir.glob("*.dll")):
                continue
            try:
                os.add_dll_directory(str(bin_dir))
            except OSError:
                continue
            added.append(str(bin_dir))
    if added:
        os.environ["PATH"] = os.pathsep.join(added + [os.environ.get("PATH", "")])
        log.debug("CUDA runtime from the venv: %s", ", ".join(added))
    return added
