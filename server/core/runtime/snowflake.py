"""Serialize config values so Discord snowflakes survive browser JSON.parse."""

from __future__ import annotations

from typing import Any

# IEEE-754 float64 exact integer range (JS Number). Discord snowflakes are ~18 digits.
_JS_SAFE_INT_MAX = (1 << 53) - 1


def json_safe_config(value: Any) -> Any:
    """Recursively stringify integers outside JS safe range (and integer-valued floats)."""
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        if abs(value) > _JS_SAFE_INT_MAX:
            return str(value)
        return value
    if isinstance(value, float):
        if value.is_integer() and abs(int(value)) > _JS_SAFE_INT_MAX:
            return str(int(value))
        return value
    if isinstance(value, list):
        return [json_safe_config(v) for v in value]
    if isinstance(value, dict):
        return {str(k): json_safe_config(v) for k, v in value.items()}
    return value


def parse_snowflake(raw: Any) -> int | None:
    """Parse a Discord snowflake from int/str without float rounding."""
    if raw is None:
        return None
    if isinstance(raw, bool):
        return None
    if isinstance(raw, int):
        return raw if raw > 0 else None
    if isinstance(raw, float):
        # Already potentially corrupted — still use int() but callers should prefer strings.
        if not raw.is_integer() or raw <= 0:
            return None
        return int(raw)
    s = str(raw).strip()
    if not s or s.lower() in {"null", "none", ""}:
        return None
    if not s.isdigit():
        return None
    return int(s)


def parse_snowflake_list(raw: Any) -> list[int]:
    if not isinstance(raw, list):
        return []
    out: list[int] = []
    for item in raw:
        n = parse_snowflake(item)
        if n is not None:
            out.append(n)
    return out
