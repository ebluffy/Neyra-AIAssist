"""Client IP resolution for rate-limit / setup-guard (no FastAPI dependency)."""

from __future__ import annotations

from typing import Mapping


def is_loopback_ip(host: str) -> bool:
    """True for localhost / IPv4 loopback / ::1."""
    h = (host or "").strip().lower().strip("[]")
    return h in ("127.0.0.1", "::1", "localhost") or h.startswith("127.")


def _header_first(headers: Mapping[str, str], *names: str) -> str:
    for name in names:
        val = (headers.get(name) or "").strip()
        if val:
            return val
    return ""


def has_edge_client_headers(headers: Mapping[str, str]) -> bool:
    """True if CF-Connecting-IP or X-Real-IP is present (frp / reverse-proxy edge)."""
    return bool(
        _header_first(headers, "cf-connecting-ip", "CF-Connecting-IP")
        or _header_first(headers, "x-real-ip", "X-Real-IP")
    )


def is_console_local_client(*, peer: str, headers: Mapping[str, str]) -> bool:
    """Direct loopback console only — no edge headers (blocks forged CF/X-Real → 127.0.0.1).

    Behind frpc the peer is always 127.0.0.1, but nginx sets CF/X-Real. Presence of those
    headers means the caller is not a local console bootstrap, even if the header value
    is forged to loopback.
    """
    if not is_loopback_ip(peer):
        return False
    if has_edge_client_headers(headers):
        return False
    return True


def resolve_client_ip(*, peer: str, headers: Mapping[str, str]) -> str:
    """Trust CF-Connecting-IP / X-Real-IP only when peer is loopback (frpc).

    Never trust client X-Forwarded-For. When peer is a public address (origin
    bypass), ignore forgeable CF-Connecting-IP and return the socket peer.

    Edge header values that are themselves loopback are ignored (forged
    ``CF-Connecting-IP: 127.0.0.1`` must not masquerade as a real client IP for
    rate-limit / logs — setup uses :func:`is_console_local_client` separately).
    """
    host = (peer or "unknown").strip() or "unknown"
    if is_loopback_ip(host):
        for raw in (
            _header_first(headers, "cf-connecting-ip", "CF-Connecting-IP"),
            _header_first(headers, "x-real-ip", "X-Real-IP"),
        ):
            if raw and not is_loopback_ip(raw):
                return raw
        return host
    return host
