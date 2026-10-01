"""Pure reply post-processing helpers (sound tags, think blocks, empty salvage)."""

from __future__ import annotations

import logging
import re

logger = logging.getLogger("neyra.agent.reply_postprocess")

EMPTY_REPLY_PLACEHOLDER = "Затупила на секунду. Повтори коротко, пожалуйста."


def extract_sound_tags(text: str, *, preserve_line_breaks: bool = True) -> tuple[str, list[str]]:
    """Cut ``[SOUND: tag]`` markers; return (clean text, tags).

    Newlines are kept by default (Discord / structured replies). ``preserve_line_breaks``
    remains for callers; ``False`` still only collapses runs of spaces *within* a line,
    never turns the whole reply into one line.
    """
    # Models sometimes emit the two-char sequence \\n instead of real newlines.
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

    lines = [re.sub(r"[ \t]+", " ", ln).rstrip() for ln in clean.splitlines()]
    clean = "\n".join(lines).strip()
    clean = re.sub(r"\n{3,}", "\n\n", clean)
    if not preserve_line_breaks:
        # Legacy: compact blank lines only — never squash all whitespace to one line.
        clean = re.sub(r"\n{2,}", "\n", clean).strip()
    clean = clean.replace('""', '"').replace("''", "'")
    clean = _strip_model_garbage_tail(clean)
    return clean, tags


def _strip_model_garbage_tail(text: str) -> str:
    """Drop trailing model junk (end tokens / sudden CJK run after mostly Cyrillic/Latin)."""
    t = (text or "").strip()
    if not t:
        return t
    t = re.sub(r"(?:<\|endoftext\|>|<\|im_end\|>|</s>)+\s*$", "", t, flags=re.IGNORECASE).rstrip()
    # If body is primarily Cyrillic/Latin and ends with a Han run, drop the Han run.
    cyr_lat = len(re.findall(r"[A-Za-zА-Яа-яЁё0-9]", t))
    if cyr_lat >= 20:
        t2 = re.sub(r"[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]{2,}\s*$", "", t).rstrip()
        if t2 and t2 != t:
            t = t2
    return t


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
    preserve_line_breaks: bool = True,
    empty_placeholder: str = EMPTY_REPLY_PLACEHOLDER,
) -> str:
    """Guarantee a non-empty user-facing reply after cleanup filters."""
    c = (clean_text or "").strip()
    if c:
        return c
    t = re.sub(r"\[SOUND:\s*\w+\]", "", (text_no_think or ""), flags=re.IGNORECASE)
    lines = [re.sub(r"[ \t]+", " ", ln).strip() for ln in t.splitlines()]
    t = "\n".join(lines).strip()
    if not preserve_line_breaks:
        t = re.sub(r"\n{2,}", "\n", t).strip()
    if t:
        return t
    logger.warning("Пустой ответ после очистки: fallback-фраза")
    return empty_placeholder
