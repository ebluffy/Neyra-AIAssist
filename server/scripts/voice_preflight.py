#!/usr/bin/env python3
"""Soft STT/TTS preflight for Windows/Linux launchers (never blocks core start)."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# Windows consoles often mishandle UTF-8 unless forced.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
except Exception:
    pass

from core.voice.config import print_voice_preflight  # noqa: E402


if __name__ == "__main__":
    raise SystemExit(print_voice_preflight())
