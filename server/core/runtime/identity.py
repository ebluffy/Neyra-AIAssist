"""
Единый внутренний user_id для сквозной памяти и событий.

Пока без ручного связывания аккаунтов между платформами: один и тот же человек
на Discord и в Telegram получит разные user_id, пока не будет отдельной таблицы link.
"""

from __future__ import annotations

import uuid
from typing import Optional

# Фиксированный namespace (не DNS UUID): стабильные uuid5 между перезапусками.
_NEYRA_ID_NAMESPACE = uuid.UUID("a3f2c8d1-4b0e-5f6a-9c7d-8e1f2a3b4c5d")


class UnifiedIdentityMapper:
    """Трансляция (platform, platform_user_id) → стабильный внутренний user_id."""

    __slots__ = ()

    @staticmethod
    def resolve(platform: str, platform_user_id: str) -> str:
        p = (platform or "unknown").strip().lower()
        uid = (platform_user_id or "").strip()
        if not uid:
            uid = "_empty"
        key = f"{p}:{uid}"
        return str(uuid.uuid5(_NEYRA_ID_NAMESPACE, key))

    @staticmethod
    def resolve_from_discord(discord_user_id: Optional[str]) -> Optional[str]:
        if not discord_user_id or not str(discord_user_id).strip():
            return None
        return UnifiedIdentityMapper.resolve("discord", str(discord_user_id).strip())

    @staticmethod
    def resolve_console(username: Optional[str]) -> str:
        handle = (username or "anonymous").strip() or "anonymous"
        return UnifiedIdentityMapper.resolve("console", handle)
