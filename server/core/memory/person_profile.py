"""People v2 helpers — no анкетные profile fields.

Bio (name, birthday, city, …) lives only in free-form ``person_facts``.
Identity is ``person_accounts`` + aliases.
"""

from __future__ import annotations

import re
from typing import Any, Optional

# Kept empty so legacy callers that still import PROFILE_KEYS do not crash.
PROFILE_KEYS: tuple[str, ...] = ()
PROFILE_LABELS_RU: dict[str, str] = {}

_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]+")
MAX_SPEAKER_LABEL_LENGTH = 64


def clean_speaker_label(value: Optional[str]) -> str:
    text = _CONTROL_RE.sub(" ", str(value or ""))
    return re.sub(r"\s+", " ", text).strip()[:MAX_SPEAKER_LABEL_LENGTH]


_GENERIC_LABELS = {"user", "api_user", "ws_user", "unknown", "пользователь"}
# Технические заглушки app.py для webhook/WS/API без имени. Настоящие ники
# вроде dark_user сюда не попадают.
_KNOWN_PLACEHOLDER_LABELS = {
    "webhook_user",
    "telegram_user",
    "discord_user",
    "slack_user",
    "whatsapp_user",
    "matrix_user",
    "email_user",
    "console_user",
    "desktop_user",
    "app_user",
    "plugin_user",
    "openai_user",
    "openrouter_user",
    "anthropic_user",
    "google_user",
    "gemini_user",
    "local_user",
    "ollama_user",
}


def is_generic_speaker_label(value: Optional[str]) -> bool:
    text = clean_speaker_label(value).casefold()
    return not text or text in _GENERIC_LABELS or text in _KNOWN_PLACEHOLDER_LABELS


_KNOWN_NAME_RE = re.compile(
    r"(?i)^\s*(?:зовут|имя|real\s*name|called)\s*[:\-]?\s*(.+?)\s*$"
)


def empty_profile() -> dict[str, str]:
    return {}


def coerce_profile(_raw: Any = None) -> dict[str, str]:
    """Legacy no-op — structured profile removed in Memory v2."""
    return {}


def split_static_facts(raw: Any) -> tuple[dict[str, str], list[str]]:
    """Convert any leftover static_facts dict into free-form fact lines."""
    leftovers: list[str] = []
    if not isinstance(raw, dict):
        return {}, leftovers
    for key, val in raw.items():
        k = str(key or "").strip()
        v = str(val or "").strip()
        if not k or not v:
            continue
        leftovers.append(f"{k}: {v}")
    return {}, leftovers


def display_name_from_profile(_profile: Any = None, fallback: str = "") -> str:
    return (fallback or "").strip()


def profile_summary_lines(_profile: Any = None) -> list[str]:
    return []


def merge_profile(_existing: Any = None, _patch: Any = None) -> dict[str, str]:
    return {}


def known_name_from_facts(facts: list[Any]) -> str:
    """First explicit 'зовут X' / 'имя: X' fact, else empty."""
    for item in facts or []:
        text = ""
        if isinstance(item, dict):
            text = str(item.get("fact") or "").strip()
        else:
            text = str(item or "").strip()
        if not text:
            continue
        m = _KNOWN_NAME_RE.match(text)
        if m:
            name = m.group(1).strip().strip("«»\"'")
            if name:
                return name
    return ""


def speaker_ref_from_account(
    *,
    handle: Optional[str] = None,
    display_name: Optional[str] = None,
    known_name: Optional[str] = None,
) -> str:
    """Label for prompts: known name + nick, else display/handle only."""
    nick = clean_speaker_label(display_name) or clean_speaker_label(handle)
    if is_generic_speaker_label(nick):
        nick = ""
    kn = clean_speaker_label(known_name)
    if is_generic_speaker_label(kn):
        kn = ""
    if kn and nick and kn.casefold() != nick.casefold():
        return f"{kn} (ник: {nick})"
    if kn:
        return kn
    return nick
