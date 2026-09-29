"""
OpenRouter: баланс / лимиты по API ключа (только для провайдера openrouter).
"""

from __future__ import annotations

from typing import Any

import httpx

OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key"


async def fetch_openrouter_key_usage(api_key: str) -> dict[str, Any]:
    """
    GET https://openrouter.ai/api/v1/key — лимиты и usage по ключу.
    """
    key = (api_key or "").strip()
    if not key:
        return {"_error": "missing_api_key"}

    async with httpx.AsyncClient(timeout=20.0) as client:
        r = await client.get(OPENROUTER_KEY_URL, headers={"Authorization": f"Bearer {key}"})

    try:
        payload = r.json() if r.content else {}
    except Exception:
        payload = {}

    if r.status_code != 200:
        return {
            "_error": "openrouter_http_error",
            "status_code": r.status_code,
            "body": str(payload)[:800],
        }

    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, dict):
        return {"_error": "unexpected_response", "raw": payload}

    return {
        "label": data.get("label"),
        "limit": data.get("limit"),
        "limit_remaining": data.get("limit_remaining"),
        "limit_reset": data.get("limit_reset"),
        "include_byok_in_limit": data.get("include_byok_in_limit"),
        "usage": data.get("usage"),
        "usage_daily": data.get("usage_daily"),
        "usage_weekly": data.get("usage_weekly"),
        "usage_monthly": data.get("usage_monthly"),
        "byok_usage": data.get("byok_usage"),
        "is_free_tier": data.get("is_free_tier"),
    }
