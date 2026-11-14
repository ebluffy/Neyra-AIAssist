"""Проверка OpenAI-совместимого шлюза без ключа.

Локальный сервер (Ollama, LM Studio, llama.cpp, vLLM в Tailscale) часто не
требует ключа. Вместо догадок ядро спрашивает ``GET {base_url}/models``:

* 200 — шлюз открыт, ключ не нужен, знаем число моделей;
* 401/403 — шлюз требует ключ;
* иначе — не ответил (ноут спит, порт закрыт).

Результат кэшируется, чтобы старт не ходил в сеть лишний раз, и попадает в
``GET /v1/providers`` как справка для панели. Ошибки сети не мешают запуску.
"""

from __future__ import annotations

import ipaddress
import json
import logging
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from threading import Lock

logger = logging.getLogger("neyra.provider_probe")

PROBE_TIMEOUT_SECONDS = 2.5
PROBE_TTL_SECONDS = 60.0

_cache: dict[str, tuple[float, "ProbeResult"]] = {}
_lock = Lock()


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Probe не ходит по редиректам: иначе base_url можно увести на metadata."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        return None


_opener = urllib.request.build_opener(_NoRedirect())


@dataclass(frozen=True)
class ProbeResult:
    state: str  # "open" | "auth_required" | "unreachable"
    models: int | None
    message: str
    checked_at: float

    def as_payload(self) -> dict[str, object]:
        return {
            "state": self.state,
            "models": self.models,
            "message": self.message,
            "checked_ago_seconds": max(0, int(time.time() - self.checked_at)),
        }


def _endpoint(base_url: str) -> str:
    return f"{str(base_url or '').rstrip('/')}/models"


def probe_models(base_url: str, *, timeout: float = PROBE_TIMEOUT_SECONDS, force: bool = False) -> ProbeResult:
    """Спросить шлюз про список моделей. Кэш на минуту, без исключений наружу."""
    key = str(base_url or "").rstrip("/")
    if not key:
        return ProbeResult("unreachable", None, "base_url не задан", time.time())
    now = time.time()
    with _lock:
        cached = _cache.get(key)
        if cached and not force and now - cached[0] < PROBE_TTL_SECONDS:
            return cached[1]

    result = _probe_uncached(key, timeout)
    with _lock:
        _cache[key] = (time.time(), result)
    return result


def _blocked_address(address: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    if address.is_link_local or address.is_multicast or address.is_unspecified:
        return True
    if isinstance(address, ipaddress.IPv6Address):
        if address.ipv4_mapped is not None:
            return _blocked_address(address.ipv4_mapped)
        if address == ipaddress.IPv6Address("fd00:ec2::254"):
            return True
    return False


def _resolve(host: str, port: int) -> list[ipaddress.IPv4Address | ipaddress.IPv6Address]:
    """Резолв с коротким таймаутом; getaddrinfo сам таймаут не принимает."""
    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            infos = pool.submit(
                socket.getaddrinfo, host, port, 0, socket.SOCK_STREAM
            ).result(timeout=1.0)
    except Exception:
        return []
    out: list[ipaddress.IPv4Address | ipaddress.IPv6Address] = []
    for info in infos:
        try:
            out.append(ipaddress.ip_address(str(info[4][0]).split("%", 1)[0]))
        except ValueError:
            continue
    return out


def _target_block_reason(base_url: str) -> str:
    parsed = urllib.parse.urlparse(base_url)
    host = parsed.hostname or ""
    if not host:
        return "base_url без хоста"
    try:
        addresses = [ipaddress.ip_address(host)]
    except ValueError:
        try:
            port = int(parsed.port or (443 if parsed.scheme == "https" else 80))
        except (TypeError, ValueError):
            return "base_url с некорректным портом"
        addresses = _resolve(host, port)
        if not addresses:
            return "DNS не разрешился"
    if any(_blocked_address(address) for address in addresses):
        return "link-local или metadata-адрес запрещён"
    return ""


def _probe_uncached(base_url: str, timeout: float) -> ProbeResult:
    blocked = _target_block_reason(base_url)
    if blocked:
        return ProbeResult("unreachable", None, blocked, time.time())
    request = urllib.request.Request(
        _endpoint(base_url),
        headers={"Accept": "application/json", "User-Agent": "Neyra-Core/1"},
        method="GET",
    )
    try:
        with _opener.open(request, timeout=timeout) as response:
            status = int(getattr(response, "status", 200))
            body = response.read(65536)
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            return ProbeResult("auth_required", None, "шлюз требует API-ключ", time.time())
        return ProbeResult("unreachable", None, f"шлюз ответил {e.code}", time.time())
    except Exception as e:  # таймаут, DNS, закрытый порт
        logger.info("Probe %s failed: %s", base_url, e)
        return ProbeResult("unreachable", None, "шлюз не ответил", time.time())

    count: int | None = None
    try:
        payload = json.loads(body.decode("utf-8", "replace"))
        data = payload.get("data") if isinstance(payload, dict) else None
        if isinstance(data, list):
            count = len(data)
    except Exception:
        count = None
    if status >= 400:
        return ProbeResult("unreachable", count, f"шлюз ответил {status}", time.time())
    return ProbeResult("open", count, "шлюз открыт без ключа", time.time())


def cached_probe(base_url: str) -> ProbeResult | None:
    """Только кэш, без сетевого вызова (для снимка провайдеров)."""
    with _lock:
        cached = _cache.get(str(base_url or "").rstrip("/"))
    return cached[1] if cached else None
