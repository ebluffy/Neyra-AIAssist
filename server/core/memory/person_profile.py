"""Canonical person profile fields for Memory Hub / dashboard / prompts.

Only a short shared summary lives in ``meta.static_facts``:
first_name, last_name, birth_date, city — all optional.

Nicknames, Discord IDs, job, relation, cars, quirks, etc. belong in
``person_facts`` (free-form). Identity helpers (names / discord_ids) may still
live in meta for lookup, but are not profile summary fields.
"""

from __future__ import annotations

import re
from typing import Any

PROFILE_KEYS: tuple[str, ...] = (
    "first_name",
    "last_name",
    "birth_date",
    "city",
)

PROFILE_LABELS_RU: dict[str, str] = {
    "first_name": "Имя",
    "last_name": "Фамилия",
    "birth_date": "Дата рождения",
    "city": "Город",
}

# Legacy static_facts keys → profile or free-form fact line.
_LEGACY_TO_PROFILE: dict[str, str] = {
    "birth_year": "birth_date",
    "age": "birth_date",
}

_MOVED_TO_FACTS: frozenset[str] = frozenset(
    {
        "occupation",
        "relation",
        "work",
        "study",
        "relation_to",
        "grade",
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

_DATE_ONLY = re.compile(
    r"^("
    r"\d{4}"  # year
    r"|\d{4}-\d{2}-\d{2}"  # ISO
    r"|\d{1,2}\.\d{1,2}\.\d{4}"  # D.M.YYYY
    r"|\d{1,2}/\d{1,2}/\d{4}"
    r"|~\d{4}"
    r")$"
)


def empty_profile() -> dict[str, str]:
    return {k: "" for k in PROFILE_KEYS}


def normalize_birth_date(raw: Any) -> str:
    """Keep date-like values; empty if blank. Soft: year / ISO / D.M.Y / ~year."""
    text = str(raw or "").strip()
    if not text:
        return ""
    # Allow short free labels that still look like dates; otherwise keep as-is
    # only if it matches common patterns, else still store (Neyra may write "лето 2004").
    if _DATE_ONLY.match(text):
        return text
    # strip "г." / "год"
    cleaned = re.sub(r"\s*(г\.?|год|года)\s*$", "", text, flags=re.I).strip()
    if _DATE_ONLY.match(cleaned):
        return cleaned
    return text[:64]


def coerce_profile(raw: Any) -> dict[str, str]:
    """Keep only PROFILE_KEYS; stringify values. All fields optional."""
    out = empty_profile()
    if not isinstance(raw, dict):
        return out
    for key in PROFILE_KEYS:
        val = raw.get(key)
        if val is None:
            continue
        if key == "birth_date":
            out[key] = normalize_birth_date(val)
            continue
        if isinstance(val, (list, tuple)):
            text = ", ".join(str(x).strip() for x in val if str(x).strip())
        else:
            text = str(val).strip()
        out[key] = text[:120]
    return out


def _fact_line(key: str, val: Any) -> str:
    label = PROFILE_LABELS_RU.get(key, key)
    if key in ("occupation", "relation", "work", "study", "relation_to", "grade"):
        label = {
            "occupation": "Занятие",
            "relation": "Связь",
            "work": "Работа",
            "study": "Учёба",
            "relation_to": "Связь",
            "grade": "Класс/курс",
        }.get(key, key)
    if isinstance(val, (list, tuple)):
        text = ", ".join(str(x).strip() for x in val if str(x).strip())
    else:
        text = str(val).strip()
    if not text:
        return ""
    return f"{label}: {text}"


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
        if k in _MOVED_TO_FACTS or k not in PROFILE_KEYS:
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
        if key == "birth_date":
            base[key] = normalize_birth_date(val)
        else:
            base[key] = str(val).strip()[:120]
    return base
