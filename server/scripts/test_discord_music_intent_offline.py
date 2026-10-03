#!/usr/bin/env python3
"""Offline checks: Discord music hard-intent must not fire on lyric pastes."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def _candidate(text: str):
    from modules.discord.bot import NeyraDiscordBot

    return NeyraDiscordBot._candidate_music_intent(None, text)  # type: ignore[arg-type]


def main() -> int:
    # Lyric paste with bare «трек» — must NOT become PLAY.
    lyrics = (
        "этот трек не для тверка да и похуй дискотека, дискотека, "
        "дискотека дискотека, это дискотека века"
    )
    assert _candidate(lyrics) is None, _candidate(lyrics)

    # Explicit play — still works.
    play = _candidate("включи трек disco forever")
    assert play is not None and play.get("action"), play
    assert "disco" in (play.get("query") or "").lower() or "forever" in (play.get("query") or "").lower(), play

    play2 = _candidate("поставь музыку")
    assert play2 is not None, play2

    url = _candidate("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
    assert url is not None, url

    assert _candidate("просто болтаем про трек в чате") is None

    print("OK test_discord_music_intent_offline")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
