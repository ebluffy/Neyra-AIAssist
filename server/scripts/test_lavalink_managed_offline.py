"""Offline smoke for managed Lavalink helper (no JVM required)."""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from modules.discord.lavalink_process import ensure_managed_lavalink  # noqa: E402


def main() -> int:
    errs: list[str] = []

    # Disabled → ok without jar
    ok, detail = ensure_managed_lavalink(
        {"discord": {"music": {"managed_lavalink": False, "nodes": [{"uri": "http://127.0.0.1:2333"}]}}},
        ROOT / "modules" / "discord",
    )
    if not ok or "disabled" not in detail:
        errs.append(f"disabled want ok+disabled, got {ok!r} {detail!r}")

    # Remote-only node → skip
    ok, detail = ensure_managed_lavalink(
        {"discord": {"music": {"nodes": [{"uri": "http://10.0.0.5:2333"}]}}},
        ROOT / "modules" / "discord",
    )
    if not ok or "skip" not in detail:
        errs.append(f"remote want ok+skip, got {ok!r} {detail!r}")

    # Missing jar under empty plugin dir → fail clearly
    with tempfile.TemporaryDirectory() as td:
        plugin = Path(td)
        (plugin / "lavalink").mkdir()
        ok, detail = ensure_managed_lavalink(
            {"discord": {"music": {"nodes": [{"uri": "http://127.0.0.1:2333"}]}}},
            plugin,
        )
        if ok or "Lavalink.jar" not in detail:
            errs.append(f"missing jar want fail mention jar, got {ok!r} {detail!r}")

    if errs:
        print("FAIL")
        for e in errs:
            print(" -", e)
        return 1
    print("ok managed_lavalink offline checks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
