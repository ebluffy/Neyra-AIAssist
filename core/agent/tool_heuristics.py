"""Deterministic tool heuristics (pre-LLM context / triggers)."""

from __future__ import annotations

import logging
import re
from typing import Any, Callable

logger = logging.getLogger("neyra.agent.tool_heuristics")

_LYRICS_MARKER_RE = re.compile(
    r"\[SYSTEM HIDDEN INSTRUCTION:.*?\]",
    flags=re.IGNORECASE | re.DOTALL,
)


def sanitize_websearch_query(text: str, *, max_len: int = 160) -> str:
    """
    Build a short search query from user/agent text.
    Lyrics turns often include long Russian instructions + hidden marker — those must
    never be sent to DuckDuckGo/Brave as the query string.
    """
    raw = (text or "").strip()
    if not raw:
        return ""
    cleaned = _LYRICS_MARKER_RE.sub(" ", raw)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()

    # Prefer quoted song title from Discord lyrics builder / prompts.
    m = re.search(
        r"(?:текст\s+песн\w*|lyrics|песн[ияю])\s*[«\"“]([^»\"”]{2,100})[»\"”]",
        cleaned,
        flags=re.IGNORECASE,
    )
    if m:
        song = m.group(1).strip()
        return f"{song} текст песни lyrics"[:max_len]

    m = re.search(r"[«\"“]([^»\"”]{2,100})[»\"”]", cleaned)
    if m and (
        "lyrics" in cleaned.lower()
        or "текст песни" in cleaned.lower()
        or "слова песни" in cleaned.lower()
        or "FULL lyrics" in cleaned
        or "web_search" in cleaned.lower()
    ):
        song = m.group(1).strip()
        return f"{song} текст песни lyrics"[:max_len]

    # Drop instructional fluff if somehow still present.
    cleaned = re.sub(
        r"(?i)найди\s+через\s+web_search.*?[«\"“]",
        "",
        cleaned,
    )
    cleaned = re.sub(
        r"(?i)(не включай музыку|не предлагай ссылки|сохрани переносы|полный текст|"
        r"you must use|do not generate|critical:|override any brevity).*$",
        "",
        cleaned,
    )
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" .,;:!?-")
    if len(cleaned) > max_len:
        cleaned = cleaned[: max_len - 1].rsplit(" ", 1)[0] + "…"
    return cleaned


def collect_tool_context(
    tools: dict[str, Any],
    *,
    text: str,
    rag_enabled: bool,
    detect_mentioned_names: Callable[[str], list[str]],
) -> str:
    """
    Deterministic tool calls by phrase heuristics.
    Goal: less waiting on trigger words; more relevant memory/dossier auto-inject.
    """
    parts: list[str] = []
    tl = text.lower().strip()

    time_phrases = (
        "который час",
        "сколько времени",
        "какое время",
        "которая сейчас дата",
        "какой сегодня день",
        "какая сегодня дата",
        "какое сегодня число",
    )
    if any(p in tl for p in time_phrases) and "погода" not in tl:
        try:
            out = tools["get_current_time"].invoke({})
            parts.append(f"[время]\n{out}")
        except Exception as e:
            logger.debug("get_current_time: %s", e)

    sys_markers = (
        "железо",
        "загрузка проц",
        "загрузка цп",
        "оператив",
        "uptime",
        "сколько места",
        "место на диск",
        " диск ",
        "диск ",
        "озу ",
    )
    if ("систем" in tl and "контекст" not in tl) or any(s in tl for s in sys_markers):
        cmd = "uptime"
        if "диск" in tl or "место" in tl:
            cmd = "disk"
        elif "оператив" in tl or "озу" in tl:
            cmd = "memory"
        elif "проц" in tl or "cpu" in tl or "цп" in tl:
            cmd = "cpu"
        elif "python" in tl:
            cmd = "python"
        try:
            raw = tools["check_system"].invoke({"command": cmd})
            parts.append(f"[система:{cmd}]\n{raw[:2500]}")
        except Exception as e:
            logger.debug("check_system: %s", e)

    mem_starts = ("вспомни про", "вспомни что", "вспомни,", "что мы говорили про", "что мы обсуждали")
    mem_extra = ("найди в памяти", "поиск в памяти")
    wants_mem = rag_enabled and (
        (tl.startswith("вспомни ") and len(text.strip()) > 10)
        or any(m in tl for m in mem_starts)
        or any(m in tl for m in mem_extra)
    )
    if wants_mem:
        q = text.strip()
        low = q.lower()
        for prefix in ("вспомни про ", "вспомни что ", "вспомни, ", "вспомни "):
            if low.startswith(prefix):
                q = q[len(prefix) :].strip()
                break
        else:
            for needle in (
                "что мы говорили про ",
                "что мы обсуждали ",
                "найди в памяти ",
                "поиск в памяти диалог ",
            ):
                if needle in low:
                    q = q[low.find(needle) + len(needle) :].strip()
                    break
        if len(q) < 3:
            q = text.strip()
        try:
            out = tools["search_memory"].invoke({"query": q[:800]})
            parts.append(f"[память]\n{out[:3000]}")
        except Exception as e:
            logger.debug("search_memory: %s", e)

    m = re.search(r"(?:досье|инфа)\s+(?:на|про)\s+(.+)", text.strip(), flags=re.IGNORECASE)
    if m:
        who = m.group(1).strip().strip("?.!, ")
        if who:
            try:
                out = tools["get_person_info"].invoke({"name_or_id": who[:120]})
                parts.append(f"[досье:{who}]\n{out[:2500]}")
            except Exception as e:
                logger.debug("get_person_info: %s", e)

    try:
        mentioned = detect_mentioned_names(text)
        for pid in mentioned[:2]:
            out = tools["get_person_info"].invoke({"name_or_id": pid})
            parts.append(f"[авто-досье:{pid}]\n{str(out)[:1400]}")
    except Exception as e:
        logger.debug("auto get_person_info: %s", e)

    mem_hints = (
        "помнишь",
        "как там",
        "что там было",
        "мы говорили",
        "раньше",
        "вчера",
        "в прошлый раз",
        "опять про",
        "продолжим",
    )
    if rag_enabled and (
        any(h in tl for h in mem_hints)
        or (len(tl) >= 18 and ("кто " in tl or "что " in tl or "почему " in tl) and "?" in tl)
    ):
        try:
            out = tools["search_memory"].invoke({"query": text[:800]})
            parts.append(f"[авто-память]\n{str(out)[:2200]}")
        except Exception as e:
            logger.debug("auto search_memory: %s", e)

    style_hints = ("будь", "говори", "тон", "стиль", "помягче", "пожестче", "характер")
    if any(h in tl for h in style_hints):
        try:
            out = tools["get_character_profile"].invoke({})
            parts.append(f"[профиль-характера]\n{str(out)[:900]}")
        except Exception as e:
            logger.debug("get_character_profile: %s", e)

    return "\n\n".join(parts) if parts else ""


def handle_memory_trigger(
    *,
    people_db: Any,
    memory_hub: Any,
    text: str,
    mentioned: list[str],
    username: str,
) -> list[str]:
    """Heuristic remember/write-fact trigger (bypass for weak tool-calling models)."""
    saved: list[str] = []
    text_lower = text.lower()
    if not any(w in text_lower for w in ["запиши", "запомни", "добавь"]):
        return saved

    # Guard: users cannot overwrite critical roles; only ebluffy may write odd things.
    if username != "ebluffy":
        forbidden = ["хозяин", "создатель", "владелец", "лучше чем", "забудь", "удали", "перепиши"]
        if any(bad in text_lower for bad in forbidden):
            logger.warning("Блокирована попытка взлома памяти от %s: %s", username, text)
            return saved

    match = re.search(
        r"(?:запиши|запомни|добавь)[^:,]*(?:[:,]\s*|что\s+)(.+)",
        text,
        flags=re.IGNORECASE,
    )
    raw_fact = match.group(1).strip() if match else text
    if len(raw_fact) < 5:
        return saved

    fact = f"(Со слов {username or 'друга'}): {raw_fact}"
    author_p = memory_hub.find_person(username) if username else None
    mentioned_others = [m for m in mentioned if not (author_p and m == author_p["id"])]

    if mentioned_others:
        targets = mentioned_others
    elif author_p:
        targets = [author_p["id"]]
    else:
        targets = []

    for uid in targets:
        if people_db.update_fact(uid, fact):
            saved.append(f"{uid}: {raw_fact}")
    return saved


def handle_websearch_trigger(tools: dict[str, Any], text: str) -> str:
    """Heuristic web search for news/fresh facts without explicit tool calls."""
    text_lower = text.lower()

    internal_dev_markers = (
        "create_or_edit_plugin",
        "plugin.yaml",
        "main_script",
        "hot-reload",
        "hot reload",
        "rollback",
        "плагин",
        "плагины",
        "interfaces/",
        "interfaces\\",
        "core/",
        "core\\",
        "нейра",
    )
    if any(m in text_lower for m in internal_dev_markers):
        return ""

    if "погода" in text_lower:
        try:
            import requests

            match = re.search(r"погода(?: в)?\s+([а-яА-Яa-zA-Z\-]+)", text_lower)
            city = match.group(1) if match else "Воронеж"
            res = requests.get(
                f"https://wttr.in/{city}?format=%l:+%c+%t,+ветер+%w,+влажность+%h",
                timeout=5,
            )
            if res.status_code == 200:
                weather_text = res.content.decode("utf-8").strip()
                weather_text = re.sub(r"[^\w\s\.,:\+\-°%]", "", weather_text)
                logger.info("Сработал триггер Погода: %s", weather_text)
                return f"Результат поиска (Погода в реальном времени): {weather_text}"
        except Exception as e:
            logger.error("Weather heuristic error: %s", e)

    triggers = ["новости", "найди", "погугли", "гугл", "интернет", "кто так", "что так"]
    fresh_markers = (
        "сегодня",
        "сейчас",
        "последние",
        "актуаль",
        "в этом году",
        "в 2025",
        "в 2026",
        "новое",
        "обновлен",
    )
    factual_question = (
        "?" in text_lower
        and any(q in text_lower for q in ("кто", "что", "где", "когда", "почему", "сколько"))
        and len(text_lower) > 22
    )
    personal_markers = ("мы", "помнишь", "про меня", "досье", "в памяти", "наш", "мой")
    wants_web = (
        any(t in text_lower for t in triggers)
        or any(t in text_lower for t in fresh_markers)
        or factual_question
    ) and not any(pm in text_lower for pm in personal_markers)

    if wants_web:
        try:
            query = sanitize_websearch_query(text)
            if not query:
                return ""
            logger.info("Авто-WebSearch: %s", query[:140])
            out = tools["web_search"].invoke({"query": query})
            if out:
                return str(out)[:2200]
        except Exception as e:
            logger.error("Heuristic WebSearch ошибка: %s", e)

    return ""
