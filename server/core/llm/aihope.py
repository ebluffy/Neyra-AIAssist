"""AIHope OpenAI-compatible API helpers (balance + thin endpoint wrappers).

Canonical chat path for the agent remains LangChain ChatOpenAI against
``https://aihope.fun/v1`` (POST ``/chat/completions``). Extra endpoints below
are for Control API / future tools (images, Responses API, Claude Messages).
"""

from __future__ import annotations

from typing import Any

import httpx

AIHOPE_API_BASE = "https://aihope.fun/v1"
AIHOPE_BALANCE_URL = "https://aihope.fun/api/usage/token/"
AIHOPE_MODELS_PATH = "/models"
AIHOPE_CHAT_PATH = "/chat/completions"
AIHOPE_RESPONSES_PATH = "/responses"
AIHOPE_MESSAGES_PATH = "/messages"
AIHOPE_IMAGES_PATH = "/images/generations"


def _auth_headers(api_key: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {(api_key or '').strip()}",
        "Content-Type": "application/json",
    }


async def fetch_aihope_token_usage(api_key: str) -> dict[str, Any]:
    """GET https://aihope.fun/api/usage/token/ — usage / balance for the key."""
    key = (api_key or "").strip()
    if not key:
        return {"_error": "missing_api_key"}

    async with httpx.AsyncClient(timeout=20.0) as client:
        r = await client.get(AIHOPE_BALANCE_URL, headers=_auth_headers(key))

    try:
        payload = r.json() if r.content else {}
    except Exception:
        payload = {}

    if r.status_code != 200:
        return {
            "_error": "aihope_http_error",
            "status_code": r.status_code,
            "body": str(payload)[:800],
        }

    if isinstance(payload, dict):
        return {k: v for k, v in payload.items()}
    return {"_error": "unexpected_response", "raw": payload}


async def aihope_list_models(api_key: str, *, base_url: str = AIHOPE_API_BASE) -> dict[str, Any]:
    """GET {base}/models — OpenAI-compatible model list."""
    key = (api_key or "").strip()
    if not key:
        return {"_error": "missing_api_key"}
    url = f"{base_url.rstrip('/')}{AIHOPE_MODELS_PATH}"
    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.get(url, headers=_auth_headers(key))
    try:
        payload = r.json() if r.content else {}
    except Exception:
        payload = {}
    if r.status_code != 200:
        return {
            "_error": "aihope_http_error",
            "status_code": r.status_code,
            "body": str(payload)[:800],
        }
    return payload if isinstance(payload, dict) else {"data": payload}


async def aihope_post(
    api_key: str,
    path: str,
    body: dict[str, Any],
    *,
    base_url: str = AIHOPE_API_BASE,
    timeout: float = 120.0,
) -> dict[str, Any]:
    """POST helper for /chat/completions, /responses, /messages, /images/generations."""
    key = (api_key or "").strip()
    if not key:
        return {"_error": "missing_api_key"}
    url = f"{base_url.rstrip('/')}/{path.lstrip('/')}"
    async with httpx.AsyncClient(timeout=timeout) as client:
        r = await client.post(url, headers=_auth_headers(key), json=body)
    try:
        payload = r.json() if r.content else {}
    except Exception:
        payload = {"raw": (r.text or "")[:800]}
    if r.status_code >= 400:
        return {
            "_error": "aihope_http_error",
            "status_code": r.status_code,
            "body": str(payload)[:800],
        }
    return payload if isinstance(payload, dict) else {"data": payload}
