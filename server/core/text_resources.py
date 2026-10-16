"""Static English service prompts and localized messages, separate from persona/data."""

from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path
from string import Formatter

_ROOT = Path(__file__).resolve().parent.parent / "resources"
_FORMATTER = Formatter()


class TextResourceError(ValueError):
    """Missing or invalid shipped text; never include substituted data in errors."""


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise TextResourceError(f"Duplicate resource key: {key}")
        result[key] = value
    return result


def _parameters(template):
    names = set()
    try:
        for _, name, spec, conversion in _FORMATTER.parse(template):
            if name is None:
                continue
            if not re.fullmatch(r"[a-z][a-z0-9_]*", name) or spec or conversion:
                raise TextResourceError("Only named parameters without formatting are supported")
            names.add(name)
    except ValueError as exc:
        raise TextResourceError("Invalid resource template") from exc
    return names


@lru_cache(maxsize=3)
def _catalog(kind, locale):
    if (kind, locale) not in {("prompts", "en"), ("messages", "en"), ("messages", "ru")}:
        raise TextResourceError("Unsupported resource catalog")
    try:
        data = json.loads((_ROOT / kind / f"{locale}.json").read_text(encoding="utf-8"), object_pairs_hook=_unique_object)
    except (OSError, ValueError) as exc:
        raise TextResourceError(f"Cannot load text catalog: {kind}/{locale}.json") from exc
    if not isinstance(data, dict) or not data:
        raise TextResourceError(f"Empty or invalid catalog: {kind}/{locale}.json")
    for key, value in data.items():
        if not re.fullmatch(r"[a-z][a-z0-9_.]*", key) or not isinstance(value, str) or not value:
            raise TextResourceError(f"Invalid resource entry: {key}")
        _parameters(value)
    return data


def _render(template, parameters):
    if _parameters(template) != set(parameters):
        raise TextResourceError("Resource parameters do not match template")
    return template.format_map(parameters)


def prompt_text(key: str, **parameters) -> str:
    """Service policy is always English, independent of message/UI language."""
    try:
        template = _catalog("prompts", "en")[key]
    except KeyError as exc:
        raise TextResourceError(f"Unknown prompt resource: {key}") from exc
    return _render(template, parameters)


def message_text(key: str, *, locale: str = "ru", **parameters) -> str:
    """Russian by default; unsupported locale or absent translation falls back to English."""
    base = _catalog("messages", "en")
    if key not in base:
        raise TextResourceError(f"Unknown message resource: {key}")
    translated = _catalog("messages", "ru") if locale == "ru" else {}
    template = translated.get(key, base[key])
    if _parameters(template) != _parameters(base[key]):
        raise TextResourceError(f"Translation parameters differ: {key}")
    return _render(template, parameters)


def validate_text_resources() -> dict[str, int]:
    prompts = _catalog("prompts", "en")
    base = _catalog("messages", "en")
    translated = _catalog("messages", "ru")
    for key, value in translated.items():
        if key not in base or _parameters(value) != _parameters(base[key]):
            raise TextResourceError(f"Translation does not match English resource: {key}")
    return {"prompts": len(prompts), "messages_en": len(base), "messages_ru": len(translated)}
