"""Pure reply post-processing helpers (sound tags, think blocks, empty salvage)."""

from __future__ import annotations

import logging
import re

logger = logging.getLogger("neyra.agent.reply_postprocess")

EMPTY_REPLY_PLACEHOLDER = "Затупила на секунду. Повтори коротко, пожалуйста."


def extract_sound_tags(text: str, *, preserve_line_breaks: bool = False) -> tuple[str, list[str]]:
    """Cut ``[SOUND: tag]`` markers; return (clean text, tags)."""
    if preserve_line_breaks:
        # Models sometimes emit literal backslash-n when asked for "\\n" line breaks.
        text = (text or "").replace("\\r\\n", "\n").replace("\\n", "\n").replace("\\r", "\n")
    pattern = r"\[SOUND:\s*(\w+)\]"
    tags = re.findall(pattern, text)
    clean = re.sub(pattern, "", text).strip()

    # Drop other [Roleplay] / [action] brackets if the model hallucinates them
    clean = re.sub(r"\[[^\]]*\]", "", clean)
    clean = re.sub(r"\*[^\*]{2,150}\*", "", clean)
    clean = re.sub(r"\([^\)]*[А-Яа-яЁё][^\)]*\)", "", clean)
    clean = re.sub(r"~[^a-zA-Zа-яА-ЯёЁ]{1,20}~", "", clean)
    if clean.startswith('"') and clean.endswith('"'):
        clean = clean[1:-1]

    if preserve_line_breaks:
        lines = [re.sub(r"[ \t]+", " ", ln).rstrip() for ln in clean.splitlines()]
        clean = "\n".join(lines).strip()
    else:
        clean = re.sub(r"\s+", " ", clean).strip()
    clean = clean.replace('""', '"').replace("''", "'")
    return clean, tags


def extract_think_blocks(text: str) -> tuple[str, str]:
    """Cut ``<think>`` / ``<thought>`` blocks; return (clean text, joined thoughts)."""
    pattern = r"<(?:redacted_thinking|think|thought)>(.*?)</(?:redacted_thinking|think|thought)>"
    thoughts = re.findall(pattern, text, re.DOTALL | re.IGNORECASE)
    clean = re.sub(pattern, "", text, flags=re.DOTALL | re.IGNORECASE)
    clean = re.sub(
        r"</?(?:redacted_thinking|think|thought)>",
        "",
        clean,
        flags=re.IGNORECASE,
    )
    clean = clean.strip()
    clean = re.sub(r"^[\s.,;:\-–—]+", "", clean).strip()
    return clean, "\n---\n".join(thoughts)


def ensure_nonempty_reply(
    text_no_think: str,
    clean_text: str,
    *,
    preserve_line_breaks: bool = False,
    empty_placeholder: str = EMPTY_REPLY_PLACEHOLDER,
) -> str:
    """Guarantee a non-empty user-facing reply after cleanup filters."""
    c = (clean_text or "").strip()
    if c:
        return c
    t = re.sub(r"\[SOUND:\s*\w+\]", "", (text_no_think or ""), flags=re.IGNORECASE)
    if preserve_line_breaks:
        t = "\n".join(re.sub(r"[ \t]+", " ", ln).strip() for ln in t.splitlines()).strip()
    else:
        t = re.sub(r"\s+", " ", t).strip()
    if t:
        return t
    logger.warning("Пустой ответ после очистки: fallback-фраза")
    return empty_placeholder
