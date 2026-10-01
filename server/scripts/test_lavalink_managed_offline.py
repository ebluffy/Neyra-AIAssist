"""Offline smoke for managed Lavalink helper (no JVM required)."""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from modules.discord.lavalink_process import (  # noqa: E402
    _ensure_application_yml,
    ensure_managed_lavalink,
    stop_managed_lavalink,
)


def main() -> int:
    errs: list[str] = []

    ok, detail = ensure_managed_lavalink(
        {"discord": {"music": {"managed_lavalink": False, "nodes": [{"uri": "http://127.0.0.1:2333"}]}}},
        ROOT / "modules" / "discord",
    )
    if not ok or "disabled" not in detail:
        errs.append(f"disabled want ok+disabled, got {ok!r} {detail!r}")

    ok, detail = ensure_managed_lavalink(
        {"discord": {"music": {"nodes": [{"uri": "http://10.0.0.5:2333"}]}}},
        ROOT / "modules" / "discord",
    )
    if not ok or "skip" not in detail:
        errs.append(f"remote want ok+skip, got {ok!r} {detail!r}")

    with tempfile.TemporaryDirectory() as td:
        plugin = Path(td)
        lava = plugin / "lavalink"
        lava.mkdir()
        ok, detail = ensure_managed_lavalink(
            {"discord": {"music": {"nodes": [{"uri": "http://127.0.0.1:2333"}]}}},
            plugin,
        )
        if ok or "Lavalink.jar" not in detail:
            errs.append(f"missing jar want fail mention jar, got {ok!r} {detail!r}")

        # Copy-from-example / repair aligns password + loopback bind
        example = ROOT / "modules" / "discord" / "lavalink" / "application.example.yml"
        if example.is_file():
            (lava / "application.example.yml").write_text(example.read_text(encoding="utf-8"), encoding="utf-8")
            yml = _ensure_application_yml(lava, password="youshallnotpass")
            text = yml.read_text(encoding="utf-8")
            if 'password: "youshallnotpass"' not in text:
                errs.append("copied yml password not aligned")
            if "address: 127.0.0.1" not in text and "address:127.0.0.1" not in text:
                errs.append(f"copied yml address not loopback: {text[:200]!r}")

            # Stale yml (CHANGE_ME / 0.0.0.0) must be repaired in place
            yml.write_text(
                'server:\n  address: 0.0.0.0\nlavalink:\n  server:\n    password: "CHANGE_ME"\n',
                encoding="utf-8",
            )
            _ensure_application_yml(lava, password="youshallnotpass")
            fixed = yml.read_text(encoding="utf-8")
            if 'password: "youshallnotpass"' not in fixed:
                errs.append("stale yml password not repaired")
            if "address: 127.0.0.1" not in fixed:
                errs.append("stale yml address not repaired")

        msg = stop_managed_lavalink(plugin)
        if "nothing" not in msg and "stopped" not in msg:
            errs.append(f"stop unexpected: {msg!r}")

    if errs:
        print("FAIL")
        for e in errs:
            print(" -", e)
        return 1
    print("ok managed_lavalink offline checks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
