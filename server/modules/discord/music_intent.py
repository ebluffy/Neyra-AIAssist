"""Discord music routing helpers — no discord.py dependency (CI-safe)."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Optional
from urllib.parse import urlsplit

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
_IMPERATIVE_VERBS = (
    "включи",
    "включите",
    "включай",
    "вруби",
    "врубай",
    "врубите",
    "поставь",
    "поставьте",
    "заиграй",
    "заиграйте",
    "play",
)
_INFINITIVE_VERBS = ("включить",)
_PLAY_VERBS = _IMPERATIVE_VERBS + _INFINITIVE_VERBS
_VERBS_PATTERN = "|".join(_IMPERATIVE_VERBS)
PLAY_VERB_RE = re.compile(
    r"\b(" + "|".join(_PLAY_VERBS) + r")\b",
    re.IGNORECASE,
)
_URL_RE = re.compile(r"(?:[a-z][a-z0-9+.-]*:)?//[^\s<>\"']+", re.IGNORECASE)


_LEAD_WORDS = (
    r"эй|ну|а\s+может|а|слушай|нейра|neyra|ты|вы|давай|может|можешь|можно|"
    r"пожалуйста|плиз|please|can\s+you|could\s+you"
)
_LEAD_RE = re.compile(r"^(?:(?:" + _LEAD_WORDS + r")[\s,:;-]*){0,3}", re.IGNORECASE)
_IMPERATIVE_VERBS_RE = re.compile(r"^(?:" + _VERBS_PATTERN + r")\b", re.IGNORECASE)
_FUTURE_REQUEST_RE = re.compile(r"^(?:включишь|врубишь|поставишь)\b", re.IGNORECASE)
_FUTURE_LEAD_RE = re.compile(
    r"(?:а\s+может|может|можешь|можно|давай|пожалуйста|плиз|can\s+you|could\s+you)",
    re.IGNORECASE,
)
_INFINITIVE_RE = re.compile(r"^(?:включить)\b", re.IGNORECASE)
_MODAL_RE = re.compile(r"(?:можешь|может|можно|can\s+you|could\s+you)", re.IGNORECASE)
_VOICE_JOIN_RE = re.compile(
    r"^(?:(?:" + _LEAD_WORDS + r")[\s,:;-]*){0,3}"
    r"(?:зайди|зайдите|зайти|join)\s+(?:в\s+)?(?:войс|голос\w*|voice|vc)\b",
    re.IGNORECASE,
)
_COMPLAINT_RE = re.compile(
    r"[?]|\b(?:почему|зачем|где|куда|опять|замолч\w*|пропал\w*|выключ\w*|играет|нет)\b|\bне\s",
    re.IGNORECASE,
)
_VOLUME_RE = re.compile(r"\b(?:по)?(?:громче|тише)\b", re.IGNORECASE)
_VOLUME_ONLY_RE = re.compile(
    r"(?:по)?(?:громче|тише)(?:[\s,.!?;:…—-]+музык\w*)?[\s,.!?;:…—-]*",
    re.IGNORECASE,
)
_PLAY_ANY_RE = re.compile(r"\b(?:" + _VERBS_PATTERN + r")\b", re.IGNORECASE)
_ADDRESS_RE = re.compile(r"^[,\s]*(?:(?:нейра|neyra)[\s,:;-]*)+", re.IGNORECASE)
_POLITE_RE = re.compile(r"^[,\s]*(?:-ка\b|(?:пожалуйста|плиз|там)\b)[\s,.:;-]*", re.IGNORECASE)


def _strip_all_polite_tail(text: str) -> str:
    return re.sub(
        r"(?:(?:^|[\s,—-]+)(?:пожалуйста|плиз|please))+[\s.!]*$",
        "",
        text,
        flags=re.IGNORECASE,
    ).rstrip(" ,.!")


def _strip_polite_tail(text: str) -> str:
    if re.search(r"[—-]\s*(?:Пожалуйста|Плиз|Please)[\s.!]*$", text):
        return text
    probe = text + " "
    prefix = re.match(
        r"((?:пожалуйста|плиз|please)[\s,]+)(?:\1)+",
        probe,
        re.IGNORECASE,
    )
    if prefix:
        end = min(prefix.end(), len(text))
        rest = _strip_all_polite_tail(text[end:])
        head = text[:end].rstrip(" ,")
        return f"{head} {rest}".strip() if rest else head
    return _strip_all_polite_tail(text)
_MUSIC_VERB_STEM_RE = re.compile(
    r"\b(?:включ\w*|постав\w*|вруб\w*|заигр\w*|просил\w*|прошу|просим)\b",
    re.IGNORECASE,
)


def _routing_text(text: str) -> str:
    return _URL_RE.sub(" ", text or "")


def _supported_music_link(text: str) -> bool:
    from modules.discord.music import _canonical_youtube_url_from_text, _normalize_allowed_music_url
    return bool(_canonical_youtube_url_from_text(text) or _normalize_allowed_music_url(text))


def _music_blocked(text: str, *, has_media: bool = False) -> bool:
    text = text or ""
    words = _routing_text(text)
    if _URL_RE.search(text) and not _supported_music_link(text) and not has_play_verb(words):
        return True
    if re.search(r"\b(?:не|don't|do\s+not)\s+(?:надо\s+|нужно\s+)?(?:" + "|".join(_PLAY_VERBS) + r"|стоп|stop|pause|skip|очищай|выключай)\b", words, re.I):
        return True
    media_link = False
    for match in _URL_RE.finditer(text):
        try:
            url = urlsplit(match.group() if "://" in match.group() else "https:" + match.group())
            host = (url.hostname or "").casefold()
        except ValueError:
            return True
        media_link |= any(host == h or host.endswith("." + h) for h in ("tenor.com", "giphy.com", "giphy.net", "imgur.com")) or bool(re.search(r"\.(?:gif|gifv|mp4|webm|png|jpe?g|webp)(?:$|[?#])", match.group(), re.I))
    if media_link and not _supported_music_link(text):
        return True
    media_nouns = r"(?:гифк(?:а|у|и|ой|ами|ах)|gifs?|мем(?:а|у|ом|е|ы|ов|ами|ах|чик)?|реакци(?:я|ю|и|ей|ями|ях)|картинк(?:а|у|и|ой|ами|ах)|изображени(?:е|я|ю|ем|и))"
    media_words = bool(re.search(r"\b" + media_nouns + r"\b", words, re.I))
    explicit_media_action = bool(re.search(r"\b(?:поставь|покажи|отправь|пришли|включи)\s+" + media_nouns + r"\b", words, re.I))
    music_noun = bool(re.search(r"\b(?:трек\w*|песн\w*|музык\w*|song|track|music)\b", words, re.I))
    if media_words and (not has_play_verb(words) or (explicit_media_action and not music_noun)):
        return True
    control = bool(re.fullmatch(r"\s*(?:стоп|stop|пауза|pause|скип|skip|resume|продолжи|очередь|queue|(?:зайди|join)\s+(?:в\s+)?(?:войс|voice|vc))\s*[.!]?", words, re.I))
    return has_media and not has_play_verb(words) and not control and not _supported_music_link(text)


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
    t = _routing_text(text).lower()
    return bool(
        re.search(
            r"(музык|песн|трек|плейлист|саунд|soundcloud|spotify|youtu\.?be|"
            r"войс|голос(ов|ой)|лавалинк|lavalink|послуш|поставь\s+что|"
            r"давай\s+(что|трек|песн|музык)|заиграй|включи\s+что)",
            t,
        )
    )


def has_play_verb(text: str) -> bool:
    return bool(PLAY_VERB_RE.search(_routing_text(text)))


def imperative_play_end(text: str, *, soft: bool = False) -> int:
    """End index of a leading play command, or 0 when the text is not a command."""
    t = (text or "").strip()
    lead = _LEAD_RE.match(t)
    rest = t[lead.end():]
    modal = bool(_MODAL_RE.search(lead.group(0)))
    verb = _IMPERATIVE_VERBS_RE.match(rest)
    if verb is None and modal:
        verb = _INFINITIVE_RE.match(rest)
    if verb is None and soft and _FUTURE_LEAD_RE.search(lead.group(0)):
        verb = _FUTURE_REQUEST_RE.match(rest)
    if verb is None:
        return 0
    return lead.end() + verb.end()


def imperative_play(text: str) -> bool:
    """Play verb must lead the command; a complaint may mention it mid-sentence."""
    return imperative_play_end(text) > 0


def imperative_voice_join(text: str) -> bool:
    """Only a leading join command counts; mentions of being in voice do not."""
    return bool(_VOICE_JOIN_RE.match((text or "").strip()))


def soft_play_allowed(text: str, *, soft_music: Optional[bool] = None) -> bool:
    """Classifier-only PLAY: imperative, or a short noun phrase without complaint/negation."""
    content = text or ""
    end = imperative_play_end(content, soft=True)
    rest = _strip_all_polite_tail(content[end:].strip() if end else content.strip())
    if _VOLUME_ONLY_RE.fullmatch(rest):
        return False
    if end:
        return True
    soft = soft_music_hint(content) if soft_music is None else bool(soft_music)
    if not soft:
        return False
    if _MUSIC_VERB_STEM_RE.search(content) or _COMPLAINT_RE.search(content):
        return False
    return len(re.findall(r"\w+", content, flags=re.UNICODE)) <= 6


def candidate_music_intent(text: str) -> Optional[dict[str, str]]:
    """Hard music intent from regex (no LLM)."""
    raw = (text or "").strip()
    if not raw or _music_blocked(raw):
        return None
    lowered = _routing_text(raw).lower()
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

    wants_voice_play = imperative_voice_join(raw)
    end = imperative_play_end(raw)
    link = _supported_music_link(raw)
    if not end and not link and not wants_voice_play:
        return None
    if wants_voice_play and not end:
        q = _VOICE_JOIN_RE.sub("", raw, count=1)
    else:
        q = raw[end:] if end else raw
    for _ in range(2):
        q = _ADDRESS_RE.sub("", q)
        q = _POLITE_RE.sub("", q)
    q = re.sub(r"^[\s,.!?;:-]+", "", q)
    if wants_voice_play:
        q = re.sub(r"^(?:и\s+)?" + _PLAY_ANY_RE.pattern + r"[\s,]*", "", q, flags=re.IGNORECASE)
        q = re.sub(r"^[\s,.!?;:-]+", "", q)
    q = re.sub(
        r"^(трек|track|песн[юяуи]|музык[ауеи]|плейлист|playlist)\s+",
        "",
        q,
        flags=re.IGNORECASE,
    ).strip()
    q = re.sub(r"^[\s,.!?;:-]+", "", q).strip()
    q = re.sub(
        r"(зайди|зайти)\s+в\s+(войс|голос\w*)\s*(и\s+)?|"
        r"\b(в\s+войс[еу]?|в\s+голос(овой)?\s*канал[еу]?)\b",
        " ",
        q,
        flags=re.IGNORECASE,
    )
    q = re.sub(r"\s+", " ", q).strip(" .,!?;:-…—")
    volume_probe = _strip_all_polite_tail(q).strip(" .,!?;:-…—")
    if _VOLUME_ONLY_RE.fullmatch(volume_probe):
        return None
    q = _strip_polite_tail(q).strip(" .,!?;:-…—")
    if _VOLUME_ONLY_RE.fullmatch(q):
        return None
    stripped_q = re.sub(r"(?:,\s*|(?<=\s)по)(?:громче|тише)\s*$", "", q, flags=re.IGNORECASE).strip()
    volume_deferred = bool(stripped_q == q and _VOLUME_RE.search(q))
    q = stripped_q.strip(" .,!?;:-…—")
    plain_q = _URL_RE.sub(" ", q)
    deferred = volume_deferred or bool(_COMPLAINT_RE.search(plain_q))
    if end:
        complaint_zone = raw[:end]
    elif wants_voice_play:
        voice = _VOICE_JOIN_RE.match(raw)
        after_voice = voice.end() if voice else 0
        play_verb = _PLAY_ANY_RE.search(raw, after_voice)
        complaint_zone = raw[: play_verb.start()] if play_verb else raw
    else:
        complaint_zone = plain_q
    negated = bool(
        re.search(r"\bне\s+(?:надо|нужно|включай|ставь|играй)\b", complaint_zone, re.IGNORECASE)
        or re.search(r"\b(?:почему|зачем)\b", complaint_zone, re.IGNORECASE)
    )
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
    candidate = {"intent": "music_control", "action": MUSIC_PLAY, "query": q}
    if deferred:
        candidate["defer"] = "1"
    if negated:
        candidate["block"] = "1"
    return candidate


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
    blocked: bool = False


def plan_music_route(content: str, *, has_media: bool = False) -> MusicRoutePlan:
    """Pure step 1: decide if classifier is needed (bot inserts LLM call between steps)."""
    if _music_blocked(content, has_media=has_media):
        return MusicRoutePlan(content, None, False, False, False, False, "CHAT", blocked=True)
    music_candidate = candidate_music_intent(content)
    lyrics_hint = lyrics_request_hint(content)
    soft_music = soft_music_hint(content)
    play_verb = has_play_verb(content)

    if music_candidate and music_candidate.get("defer"):
        return MusicRoutePlan(
            content=content,
            music_candidate=music_candidate,
            lyrics_hint=lyrics_hint,
            soft_music=soft_music,
            play_verb=play_verb,
            needs_classifier=True,
            tentative_route="CHAT",
        )
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
    if music_candidate or lyrics_hint or soft_music or imperative_play_end(content, soft=True):
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
    if plan.blocked:
        return "CHAT", False, None
    music_candidate = plan.music_candidate
    if music_candidate and music_candidate.get("block"):
        return "CHAT", False, music_candidate
    lyrics_hint = plan.lyrics_hint
    play_verb = plan.play_verb

    if not plan.needs_classifier:
        route = plan.tentative_route
    else:
        route = (classifier_route or "CHAT").strip().upper() or "CHAT"
        if route == "CHAT" and music_candidate and not lyrics_hint and not music_candidate.get("defer"):
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
