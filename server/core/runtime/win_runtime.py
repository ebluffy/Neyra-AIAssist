"""Патчи рантайма Windows: UTF-8 в консоли, mimetypes без чтения реестра."""

from __future__ import annotations

import sys


def apply_runtime_patches() -> None:
    if sys.platform == "win32":
        for stream in (sys.stdout, sys.stderr):
            try:
                stream.reconfigure(encoding="utf-8", errors="replace")
            except Exception:
                pass
    _patch_mimetypes_registry()


def _patch_mimetypes_registry() -> None:
    import mimetypes

    if getattr(mimetypes, "_neyra_registry_patched", False):
        return

    def _noop_read_windows_registry(self) -> None:
        return

    mimetypes.MimeTypes.read_windows_registry = _noop_read_windows_registry  # type: ignore[method-assign]
    try:
        if not mimetypes.inited:
            mimetypes.init()
    except PermissionError:
        mimetypes.init(files=[])
    mimetypes._neyra_registry_patched = True  # type: ignore[attr-defined]
