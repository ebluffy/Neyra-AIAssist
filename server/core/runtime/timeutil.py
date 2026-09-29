"""Time helpers for Memory Hub / reflection.

Storage (SQLite `ts` TEXT): always UTC ISO with offset — so ORDER BY ts is chronological.
Wall-clock windows / display: host OS timezone by default, optional IANA override via
`configure_timezone()` / `system.timezone` (e.g. Europe/Moscow).
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone, tzinfo
from typing import Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

_cached_override: Optional[tzinfo] = None
_cached_override_name: Optional[str] = None


def host_tz() -> tzinfo:
    """Timezone of the host OS (includes current DST offset)."""
    return datetime.now().astimezone().tzinfo or timezone.utc


def configure_timezone(tz_name: Optional[str] = None) -> tzinfo:
    """
    Set optional IANA override for the process (empty/None → host OS TZ).
    Called from MemoryHub init when config.system.timezone is set.
    """
    global _cached_override, _cached_override_name
    name = (tz_name or "").strip() or None
    _cached_override = None
    _cached_override_name = None
    if not name:
        return host_tz()
    try:
        tz = ZoneInfo(name)
    except ZoneInfoNotFoundError:
        return host_tz()
    _cached_override = tz
    _cached_override_name = name
    return tz


def resolve_tz(tz_name: Optional[str] = None) -> tzinfo:
    """Resolve IANA name, else configured override, else host local TZ."""
    name = (tz_name or "").strip()
    if name:
        if _cached_override is not None and _cached_override_name == name:
            return _cached_override
        try:
            return ZoneInfo(name)
        except ZoneInfoNotFoundError:
            return host_tz()
    if _cached_override is not None:
        return _cached_override
    return host_tz()


def now_local(tz_name: Optional[str] = None) -> datetime:
    """Current wall-clock in host/override TZ, always timezone-aware."""
    return datetime.now(resolve_tz(tz_name))


def now_iso(tz_name: Optional[str] = None) -> str:
    """Local wall-clock ISO (host/override) — for display / WM templates."""
    return now_local(tz_name).isoformat()


def now_storage_iso() -> str:
    """UTC ISO for SQLite ts columns (stable TEXT ORDER BY)."""
    return datetime.now(timezone.utc).isoformat()


def parse_ts(raw: Optional[str], *, tz_name: Optional[str] = None) -> Optional[datetime]:
    """
    Parse ISO timestamp to aware datetime.
    - Aware values keep their zone.
    - Naive values (legacy jsonl) are treated as host/override wall time.
    - Trailing Z → UTC.
    """
    s = (raw or "").strip()
    if not s:
        return None
    try:
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        dt = datetime.fromisoformat(s)
    except Exception:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=resolve_tz(tz_name))
    return dt


def to_utc_iso(raw_or_dt: Optional[str | datetime] = None) -> str:
    """Normalize any timestamp to UTC ISO for storage."""
    if raw_or_dt is None:
        return now_storage_iso()
    if isinstance(raw_or_dt, datetime):
        dt = raw_or_dt
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=resolve_tz())
        return dt.astimezone(timezone.utc).isoformat()
    parsed = parse_ts(str(raw_or_dt))
    if parsed is None:
        return now_storage_iso()
    return parsed.astimezone(timezone.utc).isoformat()


def to_local(dt: datetime, *, tz_name: Optional[str] = None) -> datetime:
    """Convert any datetime to host/override local, always aware."""
    tz = resolve_tz(tz_name)
    if dt.tzinfo is None:
        return dt.replace(tzinfo=tz)
    return dt.astimezone(tz)


def cutoff_hours(hours: float, *, tz_name: Optional[str] = None) -> datetime:
    return now_local(tz_name) - timedelta(hours=max(0.0, float(hours)))
