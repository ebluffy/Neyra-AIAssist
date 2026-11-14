"""Провайдеры LLM для админки: каталог пресетов и безопасные операции.

Чистые помощники без FastAPI: чтение состояния провайдеров из конфига, проверка
имени и base_url, каталог популярных шлюзов для быстрого добавления. Секреты
здесь не выдаются — только флаг «ключ задан» и его источник.
"""

from __future__ import annotations

import ipaddress
import re
from typing import Any, Mapping
from urllib.parse import urlparse

# Идентификатор провайдера: строчные латинские буквы, цифры, точка, дефис, _.
PROVIDER_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")

LANES: tuple[str, ...] = ("talk", "brain", "memory", "vision")

# Пресеты для кнопки «Добавить»: пользователь выбирает карточку и вставляет ключ.
# base_url можно менять — у OpenAI-совместимых шлюзов адрес часто свой.
PROVIDER_PRESETS: tuple[dict[str, Any], ...] = (
    {
        "id": "openai",
        "label": "OpenAI",
        "base_url": "https://api.openai.com/v1",
        "kind": "openai",
        "needs_key": True,
        "hint": "Официальный API OpenAI; ключ вида sk-…",
    },
    {
        "id": "openrouter",
        "label": "OpenRouter",
        "base_url": "https://openrouter.ai/api/v1",
        "kind": "openai",
        "needs_key": True,
        "hint": "Сотни моделей через один ключ; удобно для Claude и Gemini",
    },
    {
        "id": "anthropic",
        "label": "Anthropic",
        "base_url": "https://api.anthropic.com/v1",
        "kind": "openai",
        "needs_key": True,
        "hint": "Claude; нужен OpenAI-совместимый адрес (обычно через прокси или OpenRouter)",
    },
    {
        "id": "groq",
        "label": "Groq",
        "base_url": "https://api.groq.com/openai/v1",
        "kind": "openai",
        "needs_key": True,
        "hint": "Быстрый инференс открытых моделей",
    },
    {
        "id": "mistral",
        "label": "Mistral",
        "base_url": "https://api.mistral.ai/v1",
        "kind": "openai",
        "needs_key": True,
        "hint": "Mistral и Codestral",
    },
    {
        "id": "together",
        "label": "Together AI",
        "base_url": "https://api.together.xyz/v1",
        "kind": "openai",
        "needs_key": True,
        "hint": "Открытые модели по API",
    },
    {
        "id": "fireworks",
        "label": "Fireworks AI",
        "base_url": "https://api.fireworks.ai/inference/v1",
        "kind": "openai",
        "needs_key": True,
        "hint": "Открытые модели, быстрый хостинг",
    },
    {
        "id": "ollama",
        "label": "Ollama (локально)",
        "base_url": "http://127.0.0.1:11434/v1",
        "kind": "local",
        "needs_key": False,
        "hint": "Локальные модели на этом же сервере; ключ не нужен",
    },
    {
        "id": "lmstudio",
        "label": "LM Studio (локально)",
        "base_url": "http://127.0.0.1:1234/v1",
        "kind": "local",
        "needs_key": False,
        "hint": "Локальный сервер LM Studio",
    },
    {
        "id": "vllm",
        "label": "vLLM / свой шлюз",
        "base_url": "",
        "kind": "local",
        "needs_key": False,
        "hint": "Любой OpenAI-совместимый адрес: ноутбук, vLLM, LiteLLM, прокси",
    },
    {
        "id": "custom",
        "label": "Свой провайдер",
        "base_url": "",
        "kind": "openai",
        "needs_key": True,
        "hint": "Свободное имя и адрес /v1 — подходит любой OpenAI-совместимый сервис",
    },
)


class ProviderAdminError(ValueError):
    """Проверка не прошла; несёт безопасное сообщение и HTTP-статус."""

    def __init__(self, code: str, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


def normalize_provider_name(raw: Any) -> str:
    name = str(raw or "").strip().lower()
    if not PROVIDER_NAME_RE.match(name):
        raise ProviderAdminError(
            "invalid_provider",
            "Имя провайдера: строчные латинские буквы, цифры, точка, дефис или _ (до 64 символов).",
        )
    return name


def validate_base_url(raw: Any, *, allow_empty: bool = False) -> str:
    value = str(raw or "").strip()
    if not value:
        if allow_empty:
            return ""
        raise ProviderAdminError("invalid_base_url", "Укажите base_url провайдера.")
    if len(value) > 300:
        raise ProviderAdminError("invalid_base_url", "base_url слишком длинный.")
    try:
        parsed = urlparse(value)
    except ValueError as e:
        raise ProviderAdminError("invalid_base_url", "base_url содержит некорректный хост.") from e
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ProviderAdminError("invalid_base_url", "base_url должен начинаться с http:// или https://")
    if parsed.username or parsed.password:
        raise ProviderAdminError("invalid_base_url", "В base_url нельзя передавать логин и пароль.")
    _reject_metadata_host(parsed.hostname or "")
    return value.rstrip("/")


_BLOCKED_HOSTNAMES = frozenset({"metadata.google.internal", "metadata", "instance-data"})


def _is_blocked_address(address: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    if address.is_link_local or address.is_multicast or address.is_unspecified:
        return True
    if isinstance(address, ipaddress.IPv6Address):
        if address.ipv4_mapped is not None:
            return _is_blocked_address(address.ipv4_mapped)
        # AWS/GCP IPv6 metadata endpoint.
        if address == ipaddress.IPv6Address("fd00:ec2::254"):
            return True
    return False


def _reject_metadata_host(hostname: str) -> None:
    """Запретить link-local и облачные metadata-адреса (SSRF в probe/провайдере)."""
    host = str(hostname or "").strip().strip("[]").lower().rstrip(".")
    if not host:
        raise ProviderAdminError("invalid_base_url", "В base_url нет имени хоста.")
    if host in _BLOCKED_HOSTNAMES:
        raise ProviderAdminError(
            "invalid_base_url",
            "Link-local и metadata-адреса запрещены: укажите публичный или локальный шлюз модели.",
        )
    # Числовой/hex-хост (2852039166, 0xa9fea9fe) ОС трактует как IP.
    if re.fullmatch(r"(?:0[xX][0-9a-fA-F]+|[0-9]+)", host):
        raise ProviderAdminError(
            "invalid_base_url",
            "Числовой или hex-адрес запрещён: используйте обычное имя хоста или IPv4/IPv6.",
        )
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        # Dotted numeric forms (0251.0376...) ОС тоже может трактовать как IP.
        if re.fullmatch(r"[0-9.]+", host):
            raise ProviderAdminError(
                "invalid_base_url",
                "Числовой или hex-адрес запрещён: используйте обычное имя хоста или IPv4/IPv6.",
            )
        return
    if _is_blocked_address(address):
        raise ProviderAdminError(
            "invalid_base_url",
            "Link-local и metadata-адреса запрещены: укажите публичный или локальный шлюз модели.",
        )


def _providers_block(cfg: Mapping[str, Any]) -> dict[str, Any]:
    llm = cfg.get("llm") if isinstance(cfg.get("llm"), Mapping) else {}
    providers = llm.get("providers") if isinstance(llm, Mapping) else None
    return dict(providers) if isinstance(providers, Mapping) else {}


def lanes_for_provider(cfg: Mapping[str, Any], name: str) -> list[str]:
    llm = cfg.get("llm") if isinstance(cfg.get("llm"), Mapping) else {}
    out: list[str] = []
    for lane in LANES:
        role = llm.get(f"{lane}_model") if isinstance(llm, Mapping) else None
        provider = str((role or {}).get("provider") or "").strip() if isinstance(role, Mapping) else ""
        if provider == name:
            out.append(lane)
    return out


def provider_rows(
    cfg: Mapping[str, Any],
    *,
    vault_names: list[str] | None = None,
    env: Mapping[str, str] | None = None,
) -> list[dict[str, Any]]:
    """Состояние провайдеров без секретов: адрес, вид, ключ, занятые лейны."""
    import os

    source = os.environ if env is None else env
    vault = set(vault_names or [])
    preset_map = {p["id"]: p for p in PROVIDER_PRESETS}
    rows: list[dict[str, Any]] = []
    for name, raw in sorted(_providers_block(cfg).items()):
        block = raw if isinstance(raw, Mapping) else {}
        preset = preset_map.get(str(name), {})
        base_url = str(block.get("base_url") or preset.get("base_url") or "").strip()
        env_names = [n for n in block.get("api_key_env") or [] if isinstance(n, str)] if isinstance(block.get("api_key_env"), list) else []
        env_set = any((source.get(n) or "").strip() for n in env_names)
        yaml_key = bool(str(block.get("api_key") or "").strip())
        in_vault = str(name) in vault
        if in_vault:
            key_source = "vault"
        elif yaml_key:
            key_source = "yaml"
        elif env_set:
            key_source = "env"
        else:
            key_source = "none"
        rows.append(
            {
                "name": str(name),
                "label": str(preset.get("label") or name),
                "base_url": base_url,
                "kind": str(block.get("kind") or preset.get("kind") or "openai"),
                "builtin": str(name) in preset_map,
                "has_key": key_source != "none",
                "key_source": key_source,
                "lanes": lanes_for_provider(cfg, str(name)),
            }
        )
    return rows


def preset_catalog() -> list[dict[str, Any]]:
    return [dict(item) for item in PROVIDER_PRESETS]
