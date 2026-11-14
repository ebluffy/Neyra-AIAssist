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

import json
import logging
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from threading import Lock

logger = logging.getLogger("neyra.provider_probe")

PROBE_TIMEOUT_SECONDS = 2.5
PROBE_TTL_SECONDS = 60.0

_cache: dict[str, tuple[float, "ProbeResult"]] = {}
_lock = Lock()


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


def _probe_uncached(base_url: str, timeout: float) -> ProbeResult:
    request = urllib.request.Request(
        _endpoint(base_url),
        headers={"Accept": "application/json", "User-Agent": "Neyra-Core/1"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
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
