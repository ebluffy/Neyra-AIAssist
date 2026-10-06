"""Discord music routing helpers — no discord.py dependency (CI-safe)."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Optional

from core.runtime.event_bus import (
    MUSIC_CLEAR,
    MUSIC_PAUSE,
    MUSIC_PLAY,
    MUSIC_QUEUE,
    MUSIC_RESUME,
    MUSIC_SKIP,
    MUSIC_STOP,
)

# Explicit forms only — ``вкл\\w*`` falsely matches «вклад»/«вкладка»/«включил».
_PLAY_VERBS = (
    "включи",
    "включите",
    "включить",
    "включай",
    "вруби",
    "врубай",
    "врубите",
    "поставь",
    "заиграй",
    "play",
)
PLAY_VERB_RE = re.compile(
    r"\b(" + "|".join(_PLAY_VERBS) + r")\b",
    re.IGNORECASE,
)
PLAY_VERB_STRIP_RE = re.compile(
    r"^(" + "|".join(_PLAY_VERBS) + r"|music|музыка)\s+",
    re.IGNORECASE,
)


def lyrics_request_hint(text: str) -> bool:
    """Грубый признак запроса текста песни."""
    t = (text or "").lower()
    return bool(
        re.search(
            r"(текст\s+песн\w*|слова\s+песн\w*|lyrics|куплет(а|ы)?\b|реплик(а|и)\s+текст|"
            r"дай\s+текст|найди\s+текст|покажи\s+текст|скинь\s+текст|текст\s+трека|слова\s+трека|"
            r"^(текст|слова)\s*$)",
            t,
        )
    )


def soft_music_hint(text: str) -> bool:
    """Слабый признак «про музыку/войс» без жёсткого глагола."""
    t = (text or "").lower()
    return bool(
        re.search(
            r"(музык|песн|трек|плейлист|саунд|soundcloud|spotify|youtu\.?be|"
            r"войс|голос(ов|ой)|лавалинк|lavalink|послуш|поставь\s+что|"
            r"давай\s+(что|трек|песн|музык)|заиграй|включи\s+что)",
            t,
        )
    )


def has_play_verb(text: str) -> bool:
    return bool(PLAY_VERB_RE.search(text or ""))


def soft_play_allowed(text: str, *, soft_music: Optional[bool] = None) -> bool:
    """Classifier-only PLAY needs short command line or explicit play verb."""
    content = text or ""
    soft = soft_music_hint(content) if soft_music is None else bool(soft_music)
    if not soft:
        return False
    if has_play_verb(content):
        return True
    return len(re.findall(r"\w+", content, flags=re.UNICODE)) <= 8


def candidate_music_intent(text: str) -> Optional[dict[str, str]]:
    """Hard music intent from regex (no LLM)."""
    raw = (text or "").strip()
    if not raw:
        return None
    lowered = raw.lower()
    if re.search(r"\b(читы|чит|hack|hax|aimbot)\b", lowered):
        return None
    if lyrics_request_hint(raw) and not has_play_verb(raw):
        return None
    direct = [
        (MUSIC_PAUSE, r"\b(пауза|pause|приостанови)\b"),
        (MUSIC_RESUME, r"\b(продолжи|resume|возобнови)\b"),
        (MUSIC_SKIP, r"\b(скип|skip|следующ|пропусти)\b"),
        (MUSIC_STOP, r"\b(стоп|stop|выключи музыку|останови музыку)\b"),
        (MUSIC_CLEAR, r"\b(очисти очередь|clear queue|clear)\b"),
        (MUSIC_QUEUE, r"\b(очередь|queue|что играет|что в очереди)\b"),
    ]
    for action, pattern in direct:
        if re.search(pattern, lowered):
            return {"intent": "music_control", "action": action, "query": ""}

    if re.fullmatch(
        r"(пожалуйста[, ]*)?(зайди|зайти|зайди\s+пожалуйста|join)\s+"
        r"(в\s+)?(войс|голос(овой)?(\s+канал)?|voice(\s+channel)?|vc)\s*[.!]?",
        lowered,
    ):
        return {
            "intent": "music_control",
            "action": MUSIC_PLAY,
            "query": "",
            "join_only": "1",
        }

    wants_voice_play = bool(
        re.search(
            r"(в\s+войс|в\s+голос(овой)?|зайди\s+в\s+войс|зайти\s+в\s+войс|"
            r"join\s+voice|play\s+in\s+vc)",
            lowered,
        )
    )
    has_url = bool(re.search(r"https?://\S+", raw))
    if not has_play_verb(raw) and not has_url and not wants_voice_play:
        return None
    q = re.sub(r"^(эй\s+нейра|нейра|please|пожалуйста)[,:\s-]*", "", raw, flags=re.IGNORECASE).strip()
    q = PLAY_VERB_STRIP_RE.sub("", q).strip()
    q = re.sub(
        r"^(трек|track|песн[юяуи]|музык[ауеи]|плейлист|playlist)\s+",
        "",
        q,
        flags=re.IGNORECASE,
    ).strip()
    q = re.sub(
        r"(зайди|зайти)\s+в\s+(войс|голос\w*)\s*(и\s+)?|"
        r"\b(в\s+войс[еу]?|в\s+голос(овой)?\s*канал[еу]?)\b",
        " ",
        q,
        flags=re.IGNORECASE,
    )
    q = re.sub(r"\s+", " ", q).strip(" .,!?;:-")
    if not q or q.lower() in {
        "музыку",
        "музыка",
        "песню",
        "трек",
        "что-нибудь",
        "что нибудь",
        "какую-нибудь",
        "какой-нибудь",
    }:
        q = "upbeat happy music"
    return {"intent": "music_control", "action": MUSIC_PLAY, "query": q}


@dataclass
class MusicRoutePlan:
    """First pass before optional LLM classifier."""

    content: str
    music_candidate: Optional[dict[str, str]]
    lyrics_hint: bool
    soft_music: bool
    play_verb: bool
    needs_classifier: bool
    tentative_route: str


def plan_music_route(content: str) -> MusicRoutePlan:
    """Pure step 1: decide if classifier is needed (bot inserts LLM call between steps)."""
    music_candidate = candidate_music_intent(content)
    lyrics_hint = lyrics_request_hint(content)
    soft_music = soft_music_hint(content)
    play_verb = has_play_verb(content)

    if lyrics_hint and not play_verb:
        return MusicRoutePlan(
            content=content,
            music_candidate=music_candidate,
            lyrics_hint=lyrics_hint,
            soft_music=soft_music,
            play_verb=play_verb,
            needs_classifier=False,
            tentative_route="GET_LYRICS",
        )
    if music_candidate and str(music_candidate.get("action") or "") != MUSIC_PLAY:
        return MusicRoutePlan(
            content=content,
            music_candidate=music_candidate,
            lyrics_hint=lyrics_hint,
            soft_music=soft_music,
            play_verb=play_verb,
            needs_classifier=False,
            tentative_route="PLAY_MUSIC",
        )
    if music_candidate and not lyrics_hint:
        return MusicRoutePlan(
            content=content,
            music_candidate=music_candidate,
            lyrics_hint=lyrics_hint,
            soft_music=soft_music,
            play_verb=play_verb,
            needs_classifier=False,
            tentative_route="PLAY_MUSIC",
        )
    if music_candidate or lyrics_hint or soft_music:
        return MusicRoutePlan(
            content=content,
            music_candidate=music_candidate,
            lyrics_hint=lyrics_hint,
            soft_music=soft_music,
            play_verb=play_verb,
            needs_classifier=True,
            tentative_route="CHAT",
        )
    return MusicRoutePlan(
        content=content,
        music_candidate=music_candidate,
        lyrics_hint=lyrics_hint,
        soft_music=soft_music,
        play_verb=play_verb,
        needs_classifier=False,
        tentative_route="CHAT",
    )


def finalize_music_route(
    plan: MusicRoutePlan,
    *,
    classifier_route: Optional[str] = None,
) -> tuple[str, bool, Optional[dict[str, str]]]:
    """Pure step 2: final route + use_music after optional classifier."""
    music_candidate = plan.music_candidate
    lyrics_hint = plan.lyrics_hint
    play_verb = plan.play_verb

    if not plan.needs_classifier:
        route = plan.tentative_route
    else:
        route = (classifier_route or "CHAT").strip().upper() or "CHAT"
        if route == "CHAT" and music_candidate and not lyrics_hint:
            route = "PLAY_MUSIC"
        if lyrics_hint and route == "PLAY_MUSIC" and not play_verb:
            route = "GET_LYRICS"

    soft_ok = soft_play_allowed(plan.content, soft_music=plan.soft_music)
    use_music = route == "PLAY_MUSIC" and not lyrics_hint and (
        bool(music_candidate) or soft_ok
    )
    if route == "PLAY_MUSIC" and not use_music and not lyrics_hint:
        route = "CHAT"
    return route, use_music, music_candidate


def resolve_music_route(
    content: str,
    *,
    classifier_route: Optional[str] = None,
) -> tuple[str, bool]:
    """Convenience for tests: plan + finalize in one call."""
    plan = plan_music_route(content)
    route, use, _ = finalize_music_route(plan, classifier_route=classifier_route)
    return route, use
