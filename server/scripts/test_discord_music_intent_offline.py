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
        finalize_music_route,
        has_play_verb,
        plan_music_route,
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

    assert has_play_verb("включить пожалуйста трек")
    assert has_play_verb("врубай disco")
    assert PLAY_VERB_RE.search("включи музыку")

    # Negatives: prefix matches that must NOT be play verbs.
    for bad in (
        "вклад в банке какой лучше?",
        "вкладку открой в браузере",
        "я не врубился что ты сказал",
        "включил комп утром",
    ):
        assert not has_play_verb(bad), bad
        assert candidate_music_intent(bad) is None, bad

    play2 = candidate_music_intent("поставь музыку")
    assert play2 is not None, play2

    url = candidate_music_intent("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
    assert url is not None, url

    assert candidate_music_intent("просто болтаем про трек в чате") is None

    # Soft path via shared plan/finalize (same as bot).
    plan = plan_music_route(lyrics)
    assert plan.needs_classifier is True, plan
    route, use, _ = finalize_music_route(plan, classifier_route="PLAY_MUSIC")
    assert route == "CHAT" and use is False, (route, use)
    assert soft_play_allowed(lyrics) is False

    short = "классный трек"
    plan_s = plan_music_route(short)
    assert plan_s.needs_classifier is True, plan_s
    assert soft_play_allowed(short) is True
    route2, use2 = resolve_music_route(short, classifier_route="PLAY_MUSIC")
    assert route2 == "PLAY_MUSIC" and use2 is True, (route2, use2)

    route3, use3 = resolve_music_route("включи трек x", classifier_route=None)
    assert route3 == "PLAY_MUSIC" and use3 is True, (route3, use3)

    from modules.discord.music import (
        ONLY_YOUTUBE_VIDEO_URLS,
        _canonical_youtube_url_from_text,
        _looks_like_url,
        _normalize_play_query,
        _youtube_video_id,
    )

    assert _normalize_play_query("включи <https://youtu.be/abc123XYZ>") == (
        "https://www.youtube.com/watch?v=abc123XYZ",
        None,
    )
    assert _youtube_video_id("https://www.youtube.com/watch?v=LLhpBVfH2Zg&list=foo") == "LLhpBVfH2Zg"
    assert _youtube_video_id("https://www.youtube.com/shorts/AbCdEf12GhI") == "AbCdEf12GhI"
    assert _canonical_youtube_url_from_text("https://youtube.com.evil.example/watch?v=x") == ""
    assert _canonical_youtube_url_from_text("http://127.0.0.1/admin") == ""
    assert _normalize_play_query("включи http://192.168.1.1/") == ("", ONLY_YOUTUBE_VIDEO_URLS)
    assert _normalize_play_query("включи icy://127.0.0.1:8000/stream") == ("", ONLY_YOUTUBE_VIDEO_URLS)
    assert _normalize_play_query("включи //192.168.1.1/x") == ("", ONLY_YOUTUBE_VIDEO_URLS)
    assert _normalize_play_query("включи ftp://10.0.0.1/") == ("", ONLY_YOUTUBE_VIDEO_URLS)
    assert _normalize_play_query("включи <http://127.0.0.1>") == ("", ONLY_YOUTUBE_VIDEO_URLS)
    assert _normalize_play_query("включи https://soundcloud.com/artist/track") == (
        "",
        ONLY_YOUTUBE_VIDEO_URLS,
    )
    assert _normalize_play_query("Playboi Carti") == ("Playboi Carti", None)
    assert _normalize_play_query("включи") == ("", None)
    assert _normalize_play_query("включи трамбалон колю в очко") == ("трамбалон колю в очко", None)
    assert _normalize_play_query("включи https://www.youtube.com/watch?v=LLhpBVfH2Zg") == (
        "https://www.youtube.com/watch?v=LLhpBVfH2Zg",
        None,
    )
    assert _looks_like_url("icy://127.0.0.1/")
    assert _looks_like_url("//192.168.1.1/x")
    assert not _looks_like_url("трамбалон колю в очко")

    print("OK test_discord_music_intent_offline")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
