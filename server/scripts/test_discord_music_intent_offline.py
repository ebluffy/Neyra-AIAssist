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
        ONLY_ALLOWED_MUSIC_URLS,
        _canonical_youtube_url_from_text,
        _looks_like_url,
        _normalize_allowed_music_url,
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

    # Security: SSRF protection.
    assert _normalize_play_query("включи http://192.168.1.1/") == ("", ONLY_ALLOWED_MUSIC_URLS)
    assert _normalize_play_query("включи icy://127.0.0.1:8000/stream") == ("", ONLY_ALLOWED_MUSIC_URLS)
    assert _normalize_play_query("включи //192.168.1.1/x") == ("", ONLY_ALLOWED_MUSIC_URLS)
    assert _normalize_play_query("включи ftp://10.0.0.1/") == ("", ONLY_ALLOWED_MUSIC_URLS)
    assert _normalize_play_query("включи <http://127.0.0.1>") == ("", ONLY_ALLOWED_MUSIC_URLS)
    assert _normalize_play_query("включи http://user@soundcloud.com.evil.com/x") == ("", ONLY_ALLOWED_MUSIC_URLS)

    # Allowed music sources.
    sc_url, sc_err = _normalize_play_query("включи https://soundcloud.com/artist/track")
    assert sc_err is None and "soundcloud.com" in sc_url, (sc_url, sc_err)

    short_sc = _normalize_allowed_music_url("https://on.soundcloud.com/abc123")
    assert short_sc and "on.soundcloud.com" in short_sc, short_sc

    bc_url, bc_err = _normalize_play_query("вруби https://artist.bandcamp.com/track/song")
    assert bc_err is None and "bandcamp.com" in bc_url, (bc_url, bc_err)

    # Reject spoofed hostnames.
    assert _normalize_allowed_music_url("http://soundcloud.com.evil.com/x") == ""
    assert _normalize_allowed_music_url("http://user@soundcloud.com/x") == ""
    assert _normalize_allowed_music_url("http://127.0.0.1/") == ""

    # Bare "включи <link>" extraction.
    wrapped_url, _ = _normalize_play_query("включи <https://soundcloud.com/artist/track>")
    assert "soundcloud.com" in wrapped_url, wrapped_url

    # Dmitry's Discord case: «вруби <soundcloud link>» must route to music and keep the link.
    sc_cmd = "вруби https://soundcloud.com/mouse-trap-bee/track?si=abc#t=10"
    r_sc, u_sc = resolve_music_route(sc_cmd, classifier_route=None)
    assert r_sc == "PLAY_MUSIC" and u_sc is True, (r_sc, u_sc)
    assert _normalize_play_query(sc_cmd) == ("https://soundcloud.com/mouse-trap-bee/track?si=abc", None)
    # Custom ports / non-standard forms are rejected; http is upgraded to https.
    assert _normalize_allowed_music_url("https://soundcloud.com:8080/x") == ""
    assert _normalize_allowed_music_url("http://vimeo.com/123") == "https://vimeo.com/123"
    assert _normalize_allowed_music_url("https://evilbandcamp.com/x") == ""

    # Still reject old non-allowed URLs.
    assert _normalize_play_query("включи https://example.com/music.mp3") == ("", ONLY_ALLOWED_MUSIC_URLS)
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

    # AR-31: bare text must use TrackSource.YouTube (not default YouTubeMusic + ytsearch: prefix).
    import asyncio
    from types import SimpleNamespace

    from modules.discord import music as music_mod

    class _FakeTrackSource:
        YouTube = object()
        YouTubeMusic = object()

    calls: list[dict] = []

    class _FakePlayable:
        @staticmethod
        async def search(raw, *, source=None, node=None):
            calls.append({"raw": raw, "source": source, "node": node})
            return [SimpleNamespace(title=raw)]

    class _FakePool:
        @staticmethod
        async def fetch_tracks(raw, *, node=None):
            calls.append({"fetch": raw, "node": node})
            return [SimpleNamespace(title=raw)]

    fake_wl = SimpleNamespace(
        Playable=_FakePlayable,
        Pool=_FakePool,
        TrackSource=_FakeTrackSource,
    )
    node = object()

    async def _run_search_cases() -> None:
        calls.clear()
        out = await music_mod._search_tracks(fake_wl, "Playboi Carti", node)
        assert out and calls, calls
        assert calls[0]["raw"] == "Playboi Carti", calls
        assert calls[0]["source"] is _FakeTrackSource.YouTube, calls
        assert "ytsearch:" not in str(calls[0]["raw"])

        calls.clear()
        out = await music_mod._search_tracks(
            fake_wl, "https://www.youtube.com/watch?v=LLhpBVfH2Zg", node
        )
        assert out and calls, calls
        assert calls[0]["raw"].startswith("https://"), calls
        assert calls[0].get("source") is None, calls

        calls.clear()
        out = await music_mod._search_tracks(fake_wl, "icy://127.0.0.1/", node)
        assert out == [] and calls == [], calls

        calls.clear()
        out = await music_mod._search_tracks(fake_wl, "ytsearch:foo bar", node)
        assert out and calls, calls
        assert calls[0].get("fetch") == "ytsearch:foo bar" or calls[0].get("raw") == "ytsearch:foo bar", calls

        # Test SoundCloud URL passthrough.
        calls.clear()
        out = await music_mod._search_tracks(fake_wl, "https://soundcloud.com/artist/track", node)
        assert out and calls, calls
        assert calls[0]["raw"].startswith("https://soundcloud.com/"), calls
        assert calls[0].get("source") is None, calls

        # Test scsearch: prefix.
        calls.clear()
        out = await music_mod._search_tracks(fake_wl, "scsearch:artist track", node)
        assert out and calls, calls
        assert calls[0].get("fetch") == "scsearch:artist track" or calls[0].get("raw") == "scsearch:artist track", calls

    asyncio.run(_run_search_cases())

    # AR-1: Multiple URLs in one query must not call Playable.search at all.
    async def _run_ar1_tests() -> None:
        calls.clear()
        out = await music_mod._search_tracks(fake_wl, "https://soundcloud.com/x icy://127.0.0.1/", node)
        assert out == [] and calls == [], f"Multiple URLs should return [] without search calls: {calls}"

        calls.clear()
        out = await music_mod._search_tracks(fake_wl, "https://youtu.be/abc icy://127.0.0.1/", node)
        assert out == [] and calls == [], f"YouTube + malicious URL should return [] without search calls: {calls}"

        calls.clear()
        out = await music_mod._search_tracks(fake_wl, "https://soundcloud.com/x#t=1", node)
        assert out and calls, f"Single SoundCloud URL with fragment should work: {calls}"
        assert "soundcloud.com/x" in calls[0]["raw"], f"Fragment should be stripped: {calls[0]['raw']}"
        assert "#t=1" not in calls[0]["raw"], f"Fragment should not be in normalized URL: {calls[0]['raw']}"

    asyncio.run(_run_ar1_tests())

    # AR-2: Test all hostname normalization variants.
    assert music_mod._normalize_allowed_music_url("https://www.soundcloud.com/artist") == "https://soundcloud.com/artist"
    assert music_mod._normalize_allowed_music_url("https://m.soundcloud.com/artist") == "https://soundcloud.com/artist"
    assert music_mod._normalize_allowed_music_url("https://on.soundcloud.com/abc") == "https://on.soundcloud.com/abc"
    assert music_mod._normalize_allowed_music_url("https://www.vimeo.com/123") == "https://vimeo.com/123"
    assert music_mod._normalize_allowed_music_url("https://player.vimeo.com/video/123?h=abc") == "https://vimeo.com/123?h=abc"
    assert music_mod._normalize_allowed_music_url("https://www.twitch.tv/channel") == "https://www.twitch.tv/channel"
    assert music_mod._normalize_allowed_music_url("https://m.twitch.tv/channel") == "https://www.twitch.tv/channel"
    assert music_mod._normalize_allowed_music_url("https://clips.twitch.tv/ClipSlug") == "https://clips.twitch.tv/ClipSlug"
    assert music_mod._normalize_allowed_music_url("https://artist.bandcamp.com/track") == "https://artist.bandcamp.com/track"

    # AR-5: player.vimeo.com strict validation
    assert music_mod._normalize_allowed_music_url("https://player.vimeo.com/foo") == ""
    assert music_mod._normalize_allowed_music_url("https://player.vimeo.com/") == ""
    assert music_mod._normalize_allowed_music_url("https://player.vimeo.com/video/") == ""
    assert music_mod._normalize_allowed_music_url("https://player.vimeo.com/video/abc") == ""
    assert music_mod._normalize_allowed_music_url("https://player.vimeo.com/video/123") == "https://vimeo.com/123"
    assert music_mod._normalize_allowed_music_url("https://player.vimeo.com/video/123/") == "https://vimeo.com/123"
    # AR-5: twitch.tv bare host normalization
    assert music_mod._normalize_allowed_music_url("https://twitch.tv/somechannel") == "https://www.twitch.tv/somechannel"

    print("OK test_discord_music_intent_offline")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
