"""Security / cache headers for Control API + dashboard static (pure ASGI)."""

from __future__ import annotations

from typing import Callable

# Default CSP for API + SPA (no third-party scripts).
CSP = (
    "default-src 'self'; "
    "script-src 'self'; "
    "style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data: https://cdn.discordapp.com https://media.discordapp.net; "
    "font-src 'self'; "
    "connect-src 'self'; "
    "frame-ancestors 'none'; "
    "base-uri 'none'; "
    "form-action 'self'"
)

# AR-65: Swagger UI / ReDoc load CDN scripts + inline bootstraps.
CSP_DOCS = (
    "default-src 'self'; "
    "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; "
    "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; "
    "img-src 'self' data: https://fastapi.tiangolo.com https://cdn.jsdelivr.net; "
    "font-src 'self' data: https://cdn.jsdelivr.net; "
    "connect-src 'self'; "
    "frame-ancestors 'none'; "
    "base-uri 'none'; "
    "form-action 'self'"
)


class SecurityHeadersMiddleware:
    """ASGI middleware — avoids BaseHTTPMiddleware exception-swallowing quirks."""

    def __init__(self, app: Callable) -> None:
        self.app = app

    async def __call__(self, scope, receive, send) -> None:  # type: ignore[no-untyped-def]
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        path = scope.get("path") or ""

        async def send_wrapper(message):  # type: ignore[no-untyped-def]
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                csp = CSP_DOCS if path in ("/docs", "/redoc", "/openapi.json") else CSP
                headers.setdefault("content-security-policy", csp)
                headers.setdefault("x-content-type-options", "nosniff")
                headers.setdefault("referrer-policy", "no-referrer")
                headers.setdefault("x-robots-tag", "noindex, nofollow")
                if path.startswith("/v1"):
                    headers.setdefault("cache-control", "no-store")
                elif "/assets/" in path:
                    headers.setdefault("cache-control", "public, max-age=31536000, immutable")
                elif path in ("/", "/index.html") or path.endswith(".html"):
                    headers.setdefault("cache-control", "no-cache")
            await send(message)

        await self.app(scope, receive, send_wrapper)


# Local import after class to keep starlette optional at type-check time for scripts.
from starlette.datastructures import MutableHeaders  # noqa: E402
