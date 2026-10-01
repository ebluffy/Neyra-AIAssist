"""Client IP resolution for rate-limit / setup-guard (no FastAPI dependency)."""

from __future__ import annotations

from typing import Mapping


def resolve_client_ip(*, peer: str, headers: Mapping[str, str]) -> str:
    """Trust CF-Connecting-IP / X-Real-IP only when peer is loopback (frpc).

    Never trust client X-Forwarded-For. When peer is a public address (origin
    bypass), ignore forgeable CF-Connecting-IP and return the socket peer.
    """
    host = (peer or "unknown").strip() or "unknown"
    if host in ("127.0.0.1", "::1"):
        cf = (headers.get("cf-connecting-ip") or headers.get("CF-Connecting-IP") or "").strip()
        if cf:
            return cf
        xri = (headers.get("x-real-ip") or headers.get("X-Real-IP") or "").strip()
        if xri:
            return xri
        return host
    return host
