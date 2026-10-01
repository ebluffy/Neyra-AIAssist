"""Canonical person profile fields for Memory Hub / dashboard / prompts.

Free-form traits, cars, games, notes, etc. belong in ``person_facts``, not in
ad-hoc ``static_facts`` keys. ``static_facts`` (meta) holds only PROFILE_KEYS.
"""

from __future__ import annotations

from typing import Any

# Stable keys stored in meta.static_facts (and shown as the dossier summary).
PROFILE_KEYS: tuple[str, ...] = (
    "first_name",
    "last_name",
    "birth_date",
    "city",
    "occupation",
    "relation",
)

PROFILE_LABELS_RU: dict[str, str] = {
    "first_name": "Имя",
    "last_name": "Фамилия",
    "birth_date": "Дата рождения",
    "city": "Город",
    "occupation": "Занятие",
    "relation": "Связь / кем приходится",
}

# Legacy static_facts keys → profile or free-form fact line.
_LEGACY_TO_PROFILE: dict[str, str] = {
    "birth_year": "birth_date",
    "age": "birth_date",
    "work": "occupation",
    "study": "occupation",
    "relation_to": "relation",
    "grade": "occupation",
}

_LEGACY_FACT_KEYS: frozenset[str] = frozenset(
    {
        "living",
        "car",
        "games",
        "notes",
        "trigger",
        "traits",
        "girlfriend",
        "frequency",
        "rule",
    }
)


def empty_profile() -> dict[str, str]:
    return {k: "" for k in PROFILE_KEYS}


def coerce_profile(raw: Any) -> dict[str, str]:
    """Keep only PROFILE_KEYS; stringify values."""
    out = empty_profile()
    if not isinstance(raw, dict):
        return out
    for key in PROFILE_KEYS:
        val = raw.get(key)
        if val is None:
            continue
        if isinstance(val, (list, tuple)):
            text = ", ".join(str(x).strip() for x in val if str(x).strip())
        else:
            text = str(val).strip()
        out[key] = text
    return out


def _fact_line(key: str, val: Any) -> str:
    label = PROFILE_LABELS_RU.get(key, key)
    if isinstance(val, (list, tuple)):
        text = ", ".join(str(x).strip() for x in val if str(x).strip())
    else:
        text = str(val).strip()
    if not text:
        return ""
    return f"{label}: {text}" if key in PROFILE_KEYS else f"{key}: {text}"


def split_static_facts(raw: Any) -> tuple[dict[str, str], list[str]]:
    """Normalize mixed/legacy static_facts → (profile, leftover fact strings)."""
    profile = empty_profile()
    leftovers: list[str] = []
    if not isinstance(raw, dict):
        return profile, leftovers

    for key, val in raw.items():
        k = str(key or "").strip()
        if not k:
            continue
        if k in PROFILE_KEYS:
            profile[k] = coerce_profile({k: val})[k]
            continue
        mapped = _LEGACY_TO_PROFILE.get(k)
        if mapped and not profile.get(mapped):
            profile[mapped] = coerce_profile({mapped: val})[mapped]
            continue
        line = _fact_line(k, val)
        if line:
            leftovers.append(line)
    return profile, leftovers


def display_name_from_profile(profile: dict[str, str], fallback: str = "") -> str:
    first = (profile.get("first_name") or "").strip()
    last = (profile.get("last_name") or "").strip()
    if first and last:
        return f"{first} {last}"
    return first or last or fallback


def profile_summary_lines(profile: dict[str, str]) -> list[str]:
    lines: list[str] = []
    for key in PROFILE_KEYS:
        val = (profile.get(key) or "").strip()
        if not val:
            continue
        lines.append(f"  {PROFILE_LABELS_RU[key]}: {val}")
    return lines


def merge_profile(existing: Any, patch: Any) -> dict[str, str]:
    base = coerce_profile(existing)
    if not isinstance(patch, dict):
        return base
    for key in PROFILE_KEYS:
        if key not in patch:
            continue
        val = patch[key]
        if val is None:
            continue
        base[key] = str(val).strip()
    return base
