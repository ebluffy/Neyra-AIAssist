#!/usr/bin/env python3
"""Offline checks: Discord music hard/soft intent (no discord.py)."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def main() -> int:
    from modules.discord.music_intent import (
        PLAY_VERB_RE,
        candidate_music_intent,
        has_play_verb,
        resolve_music_route,
        soft_play_allowed,
    )

    # Lyric paste with bare «трек» — must NOT become PLAY.
    lyrics = (
        "этот трек не для тверка да и похуй дискотека, дискотека, "
        "дискотека дискотека, это дискотека века"
    )
    assert candidate_music_intent(lyrics) is None, candidate_music_intent(lyrics)

    play = candidate_music_intent("включи трек disco forever")
    assert play is not None and play.get("action"), play
    assert "disco" in (play.get("query") or "").lower() or "forever" in (play.get("query") or "").lower(), play

    # Unified verb regex: «включить» and «врубай» both count.
    assert has_play_verb("включить пожалуйста трек")
    assert has_play_verb("врубай disco")
    assert PLAY_VERB_RE.search("включи музыку")

    play2 = candidate_music_intent("поставь музыку")
    assert play2 is not None, play2

    url = candidate_music_intent("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
    assert url is not None, url

    assert candidate_music_intent("просто болтаем про трек в чате") is None

    # Soft path: long paste with «трек» + classifier PLAY → stay CHAT (not use_music).
    route, use = resolve_music_route(lyrics, classifier_route="PLAY_MUSIC")
    assert route == "CHAT" and use is False, (route, use)
    assert soft_play_allowed(lyrics) is False

    # Soft path: short command-like line may allow soft PLAY when classifier says PLAY.
    short = "классный трек"
    assert soft_play_allowed(short) is True
    route2, use2 = resolve_music_route(short, classifier_route="PLAY_MUSIC")
    assert route2 == "PLAY_MUSIC" and use2 is True, (route2, use2)

    # Explicit play verb still hard-routes without classifier.
    route3, use3 = resolve_music_route("включи трек x", classifier_route=None)
    assert route3 == "PLAY_MUSIC" and use3 is True, (route3, use3)

    print("OK test_discord_music_intent_offline")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
