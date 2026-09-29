"""
Единый слой подключения к LLM через OpenAI-compatible HTTP API.

Провайдеры с нативно не-OpenAI API (anthropic, gemini) поддерживаются только
если задан llm.base_url на совместимый шлюз (OpenRouter, LiteLLM, прокси).
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from typing import Any, Mapping

logger = logging.getLogger("neyra.llm_profile")

# Пресеты: дефолтный base_url и переменные окружения для api_key (в порядке приоритета).
_OPENAI_COMPATIBLE_PRESETS: dict[str, dict[str, Any]] = {
    "openrouter": {
        "base_url": "https://openrouter.ai/api/v1",
        "api_key_env": ("OPENROUTER_API_KEY",),
        "default_model": "qwen/qwen-2.5-72b-instruct",
    },
    "openai": {
        "base_url": "https://api.openai.com/v1",
        "api_key_env": ("OPENAI_API_KEY",),
    },
    "aihope": {
        "base_url": "https://aihope.fun/v1",
        "api_key_env": ("AIHOPE_API_KEY",),
    },
    "ollama": {
        "base_url": "http://127.0.0.1:11434/v1",
        "api_key_env": (),
    },
    "lmstudio": {
        "base_url": "http://127.0.0.1:1234/v1",
        "api_key_env": (),
    },
    "vllm": {
        "base_url": "",
        "api_key_env": ("VLLM_API_KEY", "OPENAI_API_KEY"),
        "requires_base_url": True,
    },
    "groq": {
        "base_url": "https://api.groq.com/openai/v1",
        "api_key_env": ("GROQ_API_KEY",),
    },
    "mistral": {
        "base_url": "https://api.mistral.ai/v1",
        "api_key_env": ("MISTRAL_API_KEY",),
    },
    "together": {
        "base_url": "https://api.together.xyz/v1",
        "api_key_env": ("TOGETHER_API_KEY",),
    },
    "fireworks": {
        "base_url": "https://api.fireworks.ai/inference/v1",
        "api_key_env": ("FIREWORKS_API_KEY",),
    },
    # Нужен OpenAI-compatible endpoint в llm.base_url
    "anthropic": {
        "base_url": "",
        "api_key_env": ("ANTHROPIC_API_KEY", "LLM_API_KEY"),
        "requires_openai_compatible_base_url": True,
    },
    "gemini": {
        "base_url": "",
        "api_key_env": ("GEMINI_API_KEY", "GOOGLE_API_KEY", "LLM_API_KEY"),
        "requires_openai_compatible_base_url": True,
    },
}

_DEFAULT_CAPABILITIES: dict[str, bool] = {
    "supports_stream": True,
    "supports_vision": True,
    "supports_tool_calls": False,
}


@dataclass(frozen=True)
class OpenAICompatibleConnection:
    """Параметры подключения ChatOpenAI (LangChain)."""

    provider: str
    base_url: str
    api_key: str
    default_headers: Mapping[str, str] = field(default_factory=dict)
    capabilities: dict[str, bool] = field(default_factory=dict)


def _first_env(*names: str) -> str:
    for name in names:
        v = (os.environ.get(name) or "").strip()
        if v:
            return v
    return ""


# Совпадает с legacy DEPRECATED_OPENROUTER_MODELS в core/agent.py для ID моделей.
DEPRECATED_MODEL_MAP: dict[str, str] = {
    "openrouter/elephant-alpha": "inclusionai/ling-2.6-flash:free",
}

_ROLE_KEYS = frozenset({"talk_model", "brain_model", "memory_model", "vision_model"})
LLM_ROLE_ORDER: tuple[str, ...] = ("talk_model", "brain_model", "memory_model", "vision_model")


def _llm_block(cfg: dict) -> dict[str, Any]:
    llm = cfg.get("llm")
    return llm if isinstance(llm, dict) else {}


def _providers_block(cfg: dict) -> dict[str, Any]:
    raw = _llm_block(cfg).get("providers")
    return raw if isinstance(raw, dict) else {}


def _models_root(cfg: dict) -> dict[str, Any]:
    """Canonical model roles: only ``llm`` (talk_model / brain_model / …)."""
    return _llm_block(cfg)


def resolve_role_provider(cfg: dict, role: str | None = None) -> str:
    """
    Provider for a model role.

    Priority: llm.<role>.provider → llm.provider → first role with provider → ``aihope``.
    """
    root = _models_root(cfg)
    if role:
        role_cfg = root.get(role)
        if isinstance(role_cfg, dict):
            p = str(role_cfg.get("provider") or "").strip().lower()
            if p:
                return p
    p = str(root.get("provider") or "").strip().lower()
    if p:
        return p
    for rk in LLM_ROLE_ORDER:
        block = root.get(rk)
        if isinstance(block, dict):
            rp = str(block.get("provider") or "").strip().lower()
            if rp:
                return rp
    return "aihope"


def _model_id_from_role(root: dict[str, Any], role_key: str) -> str:
    """ID модели: строка в корне роли или dict с ключами model / id."""
    raw = root.get(role_key)
    if isinstance(raw, dict):
        mid = raw.get("model") if raw.get("model") is not None else raw.get("id")
        if mid is not None and str(mid).strip():
            return str(mid).strip()
        return ""
    if isinstance(raw, str) and raw.strip():
        return raw.strip()
    return ""


def expand_role_nested(root: dict[str, Any]) -> dict[str, Any]:
    """
    Разворачивает вложенные talk_model / brain_model / memory_model / vision_model в плоские ключи,
    которые читает agent (`brain_max_tokens`, `reply_max_tokens`, …).
    """
    base: dict[str, Any] = {}
    for k, v in root.items():
        if k in _ROLE_KEYS and isinstance(v, dict):
            continue
        if k in {"providers", "provider", "base_url", "api_key", "capabilities", "default_headers"}:
            continue
        base[k] = v

    tm = root.get("talk_model")
    if isinstance(tm, dict):
        _nk = {
            "reply_max_tokens": "reply_max_tokens",
            "lyrics_reply_max_tokens": "lyrics_reply_max_tokens",
            "temperature": "temperature",
            "top_p": "top_p",
            "presence_penalty": "presence_penalty",
            "frequency_penalty": "frequency_penalty",
            "timeout_seconds": "timeout_seconds",
            "max_retries": "max_retries",
            "primary_first_token_timeout_seconds": "primary_first_token_timeout_seconds",
        }
        for nk, fk in _nk.items():
            if tm.get(nk) is not None:
                base[fk] = tm[nk]

    bm = root.get("brain_model")
    if isinstance(bm, dict):
        if bm.get("max_tokens") is not None:
            base["brain_max_tokens"] = bm["max_tokens"]
        if bm.get("temperature") is not None:
            base["brain_temperature"] = bm["temperature"]
        if bm.get("top_p") is not None:
            base["brain_top_p"] = bm["top_p"]
        if bm.get("timeout_seconds") is not None:
            base["brain_timeout_seconds"] = bm["timeout_seconds"]
        if bm.get("max_retries") is not None:
            base["brain_max_retries"] = bm["max_retries"]

    mm = root.get("memory_model")
    if isinstance(mm, dict):
        if mm.get("max_tokens") is not None:
            base["reflection_max_tokens"] = mm["max_tokens"]
        if mm.get("temperature") is not None:
            base["reflection_temperature"] = mm["temperature"]
        if mm.get("timeout_seconds") is not None:
            base["reflection_timeout_seconds"] = mm["timeout_seconds"]
        if mm.get("max_retries") is not None:
            base["reflection_max_retries"] = mm["max_retries"]

    vm = root.get("vision_model")
    if isinstance(vm, dict):
        if vm.get("max_tokens") is not None:
            base["vision_max_tokens"] = vm["max_tokens"]
        if vm.get("temperature") is not None:
            base["vision_temperature"] = vm["temperature"]
        if vm.get("timeout_seconds") is not None:
            base["vision_timeout_seconds"] = vm["timeout_seconds"]

    # Drop obsolete global caps if still present under llm
    base.pop("context_window", None)
    base.pop("max_tokens", None)
    base.pop("api_key", None)
    return base


def resolved_talk_model(cfg: dict, provider: str) -> str:
    """Финальный текст пользователю: llm.talk_model.model (или preset default)."""
    root = _models_root(cfg)
    mid = _model_id_from_role(root, "talk_model")
    if mid:
        return DEPRECATED_MODEL_MAP.get(mid, mid)
    preset = _OPENAI_COMPATIBLE_PRESETS.get(provider, {})
    dm = preset.get("default_model")
    if dm:
        return str(dm).strip()
    return "gpt-4o-mini"


def resolved_brain_model(cfg: dict, provider: str) -> str:
    """Маршрутизатор с инструментами. Fallback: talk model id."""
    root = _models_root(cfg)
    mid = _model_id_from_role(root, "brain_model")
    if mid:
        return DEPRECATED_MODEL_MAP.get(mid, mid)
    return resolved_talk_model(cfg, provider)


def resolved_brain_model_deep(cfg: dict, provider: str) -> str:
    """Глубокая логика: brain_model.model_deep → brain_model.model → talk."""
    root = _models_root(cfg)
    bm = root.get("brain_model")
    if isinstance(bm, dict):
        deep = bm.get("model_deep")
        if deep is not None and str(deep).strip():
            raw = str(deep).strip()
            return DEPRECATED_MODEL_MAP.get(raw, raw)
    return resolved_brain_model(cfg, provider)


def resolved_memory_model(cfg: dict, provider: str) -> str:
    """Рефлексии / LTM — llm.memory_model. Fallback: talk."""
    root = _models_root(cfg)
    mid = _model_id_from_role(root, "memory_model")
    if mid:
        return DEPRECATED_MODEL_MAP.get(mid, mid)
    return resolved_talk_model(cfg, provider)


_VISION_PIPELINE_KEYS = frozenset(
    {
        "enabled",
        "use_brain_model_for_vision",
        "max_images_per_message",
        "max_image_bytes",
        "max_image_width",
        "max_image_height",
        "remember_last_image",
        "last_image_note_max_chars",
    }
)


def merged_vision_pipeline(cfg: dict) -> dict[str, Any]:
    """Vision pipeline settings from ``llm.vision_model`` only."""
    defaults: dict[str, Any] = {
        "enabled": False,
        "use_brain_model_for_vision": False,
        "max_images_per_message": 4,
        "max_image_bytes": 8388608,
        "max_image_width": 1920,
        "max_image_height": 1080,
        "remember_last_image": True,
        "last_image_note_max_chars": 1200,
    }
    out = dict(defaults)
    root = _models_root(cfg)

    vm = root.get("vision_model")
    if isinstance(vm, dict):
        for k in _VISION_PIPELINE_KEYS:
            if k in vm and vm[k] is not None:
                out[k] = vm[k]
        mid = _model_id_from_role(root, "vision_model")
        if mid and "enabled" not in vm:
            out["enabled"] = True
    elif isinstance(vm, str) and vm.strip():
        out["enabled"] = True

    out["enabled"] = bool(out["enabled"])
    out["use_brain_model_for_vision"] = bool(out.get("use_brain_model_for_vision"))
    out["remember_last_image"] = bool(out["remember_last_image"])
    out["max_images_per_message"] = max(1, int(out["max_images_per_message"]))
    out["max_image_bytes"] = int(out["max_image_bytes"])
    out["max_image_width"] = max(16, int(out["max_image_width"]))
    out["max_image_height"] = max(16, int(out["max_image_height"]))
    out["last_image_note_max_chars"] = max(100, int(out["last_image_note_max_chars"]))
    return out


def resolved_vision_model_id(cfg: dict, provider: str) -> str:
    """VL model id from llm.vision_model → talk."""
    root = _models_root(cfg)
    mid = _model_id_from_role(root, "vision_model")
    if mid:
        return DEPRECATED_MODEL_MAP.get(mid, mid)
    return resolved_talk_model(cfg, provider)


def merge_llm_tuning_options(cfg: dict) -> dict[str, Any]:
    """
    Flat sampling/timeouts from llm role dicts (see expand_role_nested).
    Meta keys (providers, api_key, …) never enter tuning.
    """
    reserved = {
        "provider",
        "providers",
        "base_url",
        "api_key",
        "model",
        "talk_model",
        "brain_model",
        "memory_model",
        "vision_model",
        "reflection_model",
        "primary_model",
        "capabilities",
        "default_headers",
        "referer",
        "app_title",
        "micro_planning",
        "async_reflection",
        "context_window",
        "max_tokens",
    }
    root = _models_root(cfg)
    out: dict[str, Any] = expand_role_nested(root)
    # Re-attach nested blocks needed by llm_setup
    for key in ("micro_planning", "async_reflection"):
        if isinstance(root.get(key), dict):
            out[key] = root[key]
    for k in list(out.keys()):
        if k in reserved and k not in {"micro_planning", "async_reflection"}:
            out.pop(k, None)
    return out


def resolve_openai_compatible_connection(
    cfg: dict,
    *,
    role: str | None = None,
) -> OpenAICompatibleConnection:
    """
    base_url / api_key / headers for an OpenAI-compatible client.

    Provider: llm.<role>.provider (required for dual). Keys only from
    llm.providers.<name>.api_key or env (never yaml api_key at role root).
    """
    if not isinstance(cfg, dict):
        raise TypeError("config must be a dict")

    provider = resolve_role_provider(cfg, role)
    if not provider:
        provider = "aihope"

    if provider not in _OPENAI_COMPATIBLE_PRESETS:
        known = ", ".join(sorted(_OPENAI_COMPATIBLE_PRESETS))
        raise ValueError(
            f"Неизвестный LLM-провайдер '{provider}'. "
            f"Допустимые значения: {known}."
        )

    preset = _OPENAI_COMPATIBLE_PRESETS[provider]
    llm = _llm_block(cfg)
    prov_over = _providers_block(cfg).get(provider)
    if not isinstance(prov_over, dict):
        prov_over = {}

    base_url = str(
        prov_over.get("base_url")
        or llm.get("base_url")
        or preset.get("base_url")
        or ""
    ).strip()
    if preset.get("requires_base_url") and not base_url:
        raise ValueError(
            f"Провайдер '{provider}' требует llm.providers.{provider}.base_url"
        )
    if preset.get("requires_openai_compatible_base_url") and not base_url:
        raise ValueError(
            f"Провайдер '{provider}' требует OpenAI-compatible llm.providers.{provider}.base_url"
        )

    api_key = str(prov_over.get("api_key") or "").strip()
    if not api_key:
        for env_name in preset.get("api_key_env") or ():
            api_key = _first_env(env_name)
            if api_key:
                break
    if not api_key and provider == "openrouter":
        api_key = _first_env("OPENROUTER_API_KEY")
    if not api_key and provider == "aihope":
        api_key = _first_env("AIHOPE_API_KEY")
    if not api_key and provider == "ollama":
        api_key = "ollama"

    caps = dict(_DEFAULT_CAPABILITIES)
    raw_caps = llm.get("capabilities")
    if isinstance(raw_caps, dict):
        for k, v in raw_caps.items():
            if k in _DEFAULT_CAPABILITIES:
                caps[k] = bool(v)

    headers: dict[str, str] = {}
    if isinstance(llm.get("default_headers"), dict):
        for hk, hv in llm["default_headers"].items():
            if hk and hv is not None:
                headers[str(hk)] = str(hv)
    if isinstance(prov_over.get("default_headers"), dict):
        for hk, hv in prov_over["default_headers"].items():
            if hk and hv is not None:
                headers[str(hk)] = str(hv)

    if provider == "openrouter":
        referer = str(llm.get("referer") or "https://aiassist.local").strip()
        title = str(llm.get("app_title") or "Neyra AI").strip()
        headers.setdefault("HTTP-Referer", referer)
        headers.setdefault("X-Title", title)

    return OpenAICompatibleConnection(
        provider=provider,
        base_url=base_url.rstrip("/"),
        api_key=api_key,
        default_headers=headers,
        capabilities=caps,
    )


def iter_unique_provider_connections(cfg: dict) -> list[OpenAICompatibleConnection]:
    """
    One connection per distinct provider across llm roles (talk → vision order).

    Used by health/console probes so dual-backend does not report OK when only talk works.
    """
    seen: set[str] = set()
    out: list[OpenAICompatibleConnection] = []
    for role in LLM_ROLE_ORDER:
        conn = resolve_openai_compatible_connection(cfg, role=role)
        if conn.provider in seen:
            continue
        seen.add(conn.provider)
        out.append(conn)
    if not out:
        out.append(resolve_openai_compatible_connection(cfg))
    return out


def connection_for_provider(cfg: dict, provider: str) -> OpenAICompatibleConnection:
    """Connection for ``provider`` via the first role that uses it (else default)."""
    want = str(provider or "").strip().lower()
    for role in LLM_ROLE_ORDER:
        conn = resolve_openai_compatible_connection(cfg, role=role)
        if conn.provider == want:
            return conn
    return resolve_openai_compatible_connection(cfg)


def is_local_openai_compatible_provider(provider: str) -> bool:
    """Локальные/self-host профили для подсказок в системном промпте."""
    return provider.strip().lower() in {"ollama", "lmstudio", "vllm"}
