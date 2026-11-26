"""When the brain planner is worth a second LLM call.

Brain is not a summarizer only: it owns the tool loop (desktop/MCP) and native
vision planning. For plain text turns talk already receives the code-assembled
context, so a second call is pure latency. The policy keeps brain for:
deep think (explicit), native vision, and messages that look like tool actions.
"""

from __future__ import annotations

import logging
import re
from typing import Any, Optional

logger = logging.getLogger("neyra.agent.brain_policy")

BRAIN_MODES = frozenset({"auto", "off", "always"})

# Phrases are grouped by tool family and cover both RU and EN. Keep this list
# next to the actual tool catalog: a new tool without a phrase must fail CI.
_TOOL_FAMILY_HINTS: dict[str, tuple[str, ...]] = {
    "shell": ("запусти программу", "выполни команду", "в терминале", "run program", "execute command", "in terminal"),
    "fs": (
        "открой файл", "прочитай файл", "запиши в файл", "создай файл", "удали файл",
        "найди файл", "покажи файлы", "список файлов", "перемести файл",
        "открой папку", "создай папку", "удали папку", "покажи папку",
        "open file", "read file", "write file", "create file", "delete file",
        "find file", "list files", "move file", "open folder", "create folder", "delete folder",
    ),
    "screenshot": ("сделай скрин", "скриншот", "что на экране", "take a screenshot", "what is on screen"),
    "input": (
        "кликни", "нажми", "напечатай", "введи",
        "click on", "press", "type text", "key press",
    ),
    "computer": ("элемент окна", "кликни по кнопке", "введи в поле", "accessibility", "click element"),
    "open_url": (
        "открой сайт", "открой ссылку", "открой ютуб", "открой браузер",
        "open url", "open website", "open youtube", "open browser",
    ),
    "search_web": ("найди в интернете", "поищи в интернете", "загугли", "search the web", "google"),
    "apps": ("открой приложение", "запусти приложение", "open app", "launch app"),
    "windows": (
        "список окон", "какие окна", "переключись на окно", "закрой окно",
        "list windows", "focus window", "close window",
    ),
    "media": (
        "поставь на паузу", "пауза", "трек", "музык", "следующий трек",
        "предыдущий трек", "включи музыку", "pause music", "pause the music",
        "next track", "previous track", "play music", "play the music",
    ),
    "volume": (
        "громче", "тише", "звук", "сделай громче", "сделай погромче",
        "сделай тише", "сделай потише", "выключи звук", "включи звук",
        "volume up", "volume down", "mute",
    ),
    "remember": ("запомни", "сохрани в память", "remember that", "save to memory"),
    "person_fact": ("запомни обо мне", "это про меня", "remember about me"),
    "person_info": ("кто такой", "кто такая", "что известно о", "who is", "what do you know about"),
    "recall": (
        "что мы обсуждали", "о чём говорили", "о чём мы говорили", "говорили вчера",
        "помнишь", "discussed", "remember when",
    ),
    "merge": ("объедини людей", "merge people", "дубликат"),
    "time": ("который час", "сколько времени", "what time", "current time"),
    "system": ("проверь систему", "статус системы", "system status", "health check"),
    "weather": ("погода", "курс доллара", "курс евро", "новости", "weather", "exchange rate", "news"),
    "memory_search": ("найди в памяти", "что помнишь", "search memory"),
    "profile": ("профиль персонажа", "character profile"),
    "deep_logic": ("подумай глубже", "deep logic", "delegate"),
    "plugin": ("создай плагин", "edit plugin"),
}

# Actual tool names → family. Both desktop bridge and server builtins are covered.
TOOL_FAMILY: dict[str, str] = {
    "client.shell_exec": "shell",
    "client.fs_list": "fs",
    "client.fs_read": "fs",
    "client.fs_search": "fs",
    "client.fs_write": "fs",
    "client.fs_mkdir": "fs",
    "client.fs_move": "fs",
    "client.screenshot": "screenshot",
    "client.input": "input",
    "client.computer_snapshot": "computer",
    "client.computer_click": "computer",
    "client.computer_type": "input",
    "client.computer_press": "input",
    "client.open_url": "open_url",
    "client.search_web": "search_web",
    "client.list_apps": "apps",
    "client.open_app": "apps",
    "client.list_windows": "windows",
    "client.focus_window": "windows",
    "client.close_window": "windows",
    "client.media": "media",
    "client.volume": "volume",
    "get_current_time": "time",
    "check_system": "system",
    "web_search": "weather",
    "search_memory": "memory_search",
    "recall_chat": "recall",
    "remember_knowledge": "remember",
    "update_person_fact": "person_fact",
    "propose_people_merge": "merge",
    "get_person_info": "person_info",
    "get_character_profile": "profile",
    "delegate_to_deep_logic": "deep_logic",
    "create_or_edit_plugin": "plugin",
}

TOOL_FAMILY_HINTS = _TOOL_FAMILY_HINTS
_TOOL_HINTS = tuple(hint for hints in _TOOL_FAMILY_HINTS.values() for hint in hints)
_ASCII_HINT_RES = {
    hint: re.compile(rf"(?<![a-z]){re.escape(hint)}(?![a-z])")
    for hint in _TOOL_HINTS
    if hint.isascii()
}
_RU_HINT_RES = {
    hint: re.compile(rf"(?<![а-яё]){re.escape(hint)}")
    for hint in _TOOL_HINTS
    if not hint.isascii()
}


def brain_mode(config: dict[str, Any]) -> str:
    section = config.get("agent") if isinstance(config.get("agent"), dict) else {}
    brain = section.get("brain") if isinstance(section.get("brain"), dict) else {}
    mode = str(brain.get("mode") or "auto").strip().lower()
    return mode if mode in BRAIN_MODES else "auto"


_EN_ACTION = (
    r"(?:open|close|read|write|create|delete|remove|move|rename|find|search|list|show|run|execute|"
    r"launch|take|click|press|type|focus|mute|pause|play|next|previous|turn|remember|save)"
)
_EN_OBJECT = (
    r"(?:files?|folders?|director(?:y|ies)|screenshots?|screens?|commands?|programs?|apps?|"
    r"applications?|windows?|urls?|websites?|pages?|music|tracks?|songs?|volume|sound|memory|"
    r"facts?|people|persons?|time|weather|news|rates?|systems?|plugins?|elements?|buttons?|texts?)"
)
_EN_ACTION_OBJECT_RE = re.compile(
    rf"(?<![a-z]){_EN_ACTION}(?:\s+\w+){{0,3}}\s+{_EN_OBJECT}(?![a-z])"
)
_RU_ACTION_RE = re.compile(
    r"(?<![а-яё])(?:удал|перемест|откр|закр|прочит|запиш|созда|найд|покаж|запуст|выполн|"
    r"скрин|нажм|клик|напечат|введи|переключ|сделай|выключ|включ|постав|погромч|потиш|"
    r"запомн|сохран|вспомн|обсуд|говор|помниш|посчит|вычисл|провер|лежит)"
)
_RU_OBJECT_RE = re.compile(
    r"(?<![а-яё])(?:файл|папк|скрин|экран|команд|программ|приложен|окн|сайт|ссылк|страниц|"
    r"музык|трек|звук|громч|погромч|тиш|потиш|памят|факт|человек|люд|врем|погод|новост|"
    r"курс|систем|плагин|кнопк|текст|пол|ютуб|браузер|клавиш|enter)"
)


def looks_like_tool_request(text: str) -> bool:
    normalized = " ".join((text or "").lower().split())
    if not normalized:
        return False
    for hint in _TOOL_HINTS:
        matcher = _ASCII_HINT_RES.get(hint) or _RU_HINT_RES.get(hint)
        if matcher is not None and matcher.search(normalized):
            return True
    if _EN_ACTION_OBJECT_RE.search(normalized):
        return True
    return bool(_RU_ACTION_RE.search(normalized) and _RU_OBJECT_RE.search(normalized))


def tools_available(agent: Any) -> bool:
    """Desktop tools count only while a session is active; MCP only when enabled."""
    try:
        from core.desktop.bridge import brain_tools

        if brain_tools():
            return True
    except Exception:
        logger.debug("desktop tools probe failed", exc_info=True)
    mcp_cfg = agent.config.get("mcp_client") if isinstance(getattr(agent, "config", None), dict) else {}
    mcp_on = bool(isinstance(mcp_cfg, dict) and mcp_cfg.get("llm_tool_calls"))
    return bool(mcp_on and getattr(agent, "tools", None))


def should_run_brain(
    agent: Any,
    prep: Any,
    *,
    deep_think: bool,
    user_message: str,
    vision_images: Optional[list] = None,
    tools_available_override: Optional[bool] = None,
) -> tuple[bool, str]:
    """Return (run, reason) for logs and tests."""
    if deep_think:
        return True, "deep_think"
    # Native vision is a capability requirement, not an optional auto turn:
    # disabling auto must not silently drop image understanding.
    if vision_images and bool(getattr(prep, "brain_native_vis", False)):
        return True, "native_vision"
    mode = brain_mode(getattr(agent, "config", {}) or {})
    if mode == "always":
        return True, "mode_always"
    if mode == "off":
        return False, "mode_off"
    available = tools_available(agent) if tools_available_override is None else tools_available_override
    if not available:
        return False, "no_tools"
    capabilities = getattr(agent, "llm_brain_capabilities", None)
    if isinstance(capabilities, dict) and not capabilities.get("supports_tool_calls", True):
        return False, "tools_unsupported"
    if looks_like_tool_request(user_message):
        return True, "tool_intent"
    return False, "plain_chat"
