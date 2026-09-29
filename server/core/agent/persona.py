"""Persona / appearance artifacts for Stage 2A.

Canonical:
  assistant.persona_path → character, tone, bounds (talk always; brain optional cap)
  assistant.appearance_path → visual canon (only when relevant or appearance_always)

Fallback: assistant.system_prompt if persona file missing/empty.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger("neyra.agent.persona")

_APPEARANCE_MARKERS = (
    "как ты выгля",
    "как выглядишь",
    "твоя внешность",
    "опиши себя",
    "опиши свою внешность",
    "как ты выглядишь",
    "внешность",
    "аватар",
    "визуал",
    "нарисуй себя",
    "свой вид",
    "как ты выглядела",
    "how do you look",
    "what do you look like",
    "your appearance",
)


def _assistant_block(config: dict[str, Any]) -> dict[str, Any]:
    raw = config.get("assistant")
    return raw if isinstance(raw, dict) else {}


def resolve_prompt_path(project_root: Path, raw_path: str) -> Path:
    p = Path(str(raw_path or "").strip())
    if not p.is_absolute():
        p = project_root / p
    return p.resolve()


def _read_text_file(path: Path) -> str:
    try:
        if not path.is_file():
            return ""
        return path.read_text(encoding="utf-8").strip()
    except OSError as e:
        logger.warning("Не удалось прочитать %s: %s", path, e)
        return ""


def load_persona_text(config: dict[str, Any], project_root: Path) -> str:
    """Persona for talk lane. File first; else ``assistant.system_prompt``."""
    asst = _assistant_block(config)
    rel = str(asst.get("persona_path") or "").strip()
    if rel:
        text = _read_text_file(resolve_prompt_path(project_root, rel))
        if text:
            return text
        logger.warning(
            "persona_path=%s не найден или пуст — fallback на assistant.system_prompt",
            rel,
        )
    return str(asst.get("system_prompt") or "").strip()


def load_appearance_text(config: dict[str, Any], project_root: Path) -> str:
    """Appearance artifact; empty if missing (soft)."""
    asst = _assistant_block(config)
    rel = str(asst.get("appearance_path") or "").strip()
    if not rel:
        return ""
    text = _read_text_file(resolve_prompt_path(project_root, rel))
    if not text:
        logger.debug("appearance_path=%s отсутствует — визуальный канон не подмешан", rel)
    return text


def appearance_is_relevant(
    user_message: str,
    *,
    has_vision_images: bool = False,
) -> bool:
    if has_vision_images:
        return True
    text = (user_message or "").lower()
    if not text:
        return False
    return any(m in text for m in _APPEARANCE_MARKERS)


def should_inject_appearance(
    config: dict[str, Any],
    *,
    user_message: str,
    has_vision_images: bool,
) -> bool:
    asst = _assistant_block(config)
    if bool(asst.get("appearance_always")):
        return True
    return appearance_is_relevant(user_message, has_vision_images=has_vision_images)


def format_appearance_section(
    appearance_text: str,
    *,
    always: bool,
    max_chars: int,
) -> str:
    text = (appearance_text or "").strip()
    if not text:
        return ""
    if always and max_chars > 0 and len(text) > max_chars:
        text = text[:max_chars].rstrip() + "…"
    return (
        "\n\n# ВНЕШНОСТЬ / ВИЗУАЛЬНЫЙ КАНОН\n"
        "Используй только когда речь о виде, аватаре, картинке или образе. "
        "Не навязывай описание внешности в обычном текстовом чате.\n"
        f"{text}"
    )


def build_talk_base_prompt(
    config: dict[str, Any],
    project_root: Path,
    *,
    include_appearance: bool,
) -> str:
    persona = load_persona_text(config, project_root)
    if not include_appearance:
        return persona
    asst = _assistant_block(config)
    appearance = load_appearance_text(config, project_root)
    section = format_appearance_section(
        appearance,
        always=bool(asst.get("appearance_always")),
        max_chars=int(asst.get("appearance_max_chars") or 0),
    )
    return persona + section


def persona_brain_snippet(
    config: dict[str, Any],
    project_root: Path,
    *,
    max_chars: Optional[int] = None,
) -> str:
    """Compact identity for brain lane (no full talk style dump by default)."""
    asst = _assistant_block(config)
    if asst.get("persona_in_brain") is False:
        return ""
    persona = load_persona_text(config, project_root)
    if not persona:
        return ""
    limit = max_chars
    if limit is None:
        limit = int(asst.get("persona_brain_max_chars") or 600)
    if limit > 0 and len(persona) > limit:
        persona = persona[:limit].rstrip() + "…"
    name = str(asst.get("name") or "Neyra").strip() or "Neyra"
    # Collapse excessive blank lines for brain compactness
    persona = re.sub(r"\n{3,}", "\n\n", persona)
    return (
        f"# IDENTITY (компактно; не копируй стиль talk-модели дословно)\n"
        f"Ассистент: {name}.\n{persona}"
    )
