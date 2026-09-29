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


def _openrouter_block(cfg: dict) -> dict[str, Any]:
    o = cfg.get("openrouter")
    return o if isinstance(o, dict) else {}


def _llm_block(cfg: dict) -> dict[str, Any]:
    llm = cfg.get("llm")
    return llm if isinstance(llm, dict) else {}


def _providers_block(cfg: dict) -> dict[str, Any]:
    raw = _llm_block(cfg).get("providers")
    return raw if isinstance(raw, dict) else {}


def resolve_role_provider(cfg: dict, role: str | None = None) -> str:
    """
    Provider for a model role (talk_model / brain_model / memory_model / vision_model).

    Priority: openrouter.<role>.provider → llm.provider → BACKEND → openrouter.
    Enables dual-backend: e.g. talk on openrouter, brain/memory/vision on aihope.
    """
    if role:
        or_block = _openrouter_block(cfg)
        role_cfg = or_block.get(role)
        if isinstance(role_cfg, dict):
            p = str(role_cfg.get("provider") or "").strip().lower()
            if p:
                return p
    llm = _llm_block(cfg)
    p = str(llm.get("provider") or "").strip().lower()
    if p:
        return p
    return str(cfg.get("BACKEND") or "openrouter").strip().lower() or "openrouter"


def _model_id_from_role(or_block: dict[str, Any], role_key: str) -> str:
    """ID модели: строка в корне роли или dict с ключами model / id."""
    raw = or_block.get(role_key)
    if isinstance(raw, dict):
        mid = raw.get("model") if raw.get("model") is not None else raw.get("id")
        if mid is not None and str(mid).strip():
            return str(mid).strip()
        return ""
    if isinstance(raw, str) and raw.strip():
        return raw.strip()
    return ""


def expand_openrouter_nested(or_block: dict[str, Any]) -> dict[str, Any]:
    """
    Разворачивает вложенные talk_model / brain_model / memory_model / vision_model в плоские ключи,
    которые читает agent (`brain_max_tokens`, `reply_max_tokens`, …).
    Строковые роли остаются как есть (для resolved_*_model).
    """
    base: dict[str, Any] = {}
    for k, v in or_block.items():
        if k in _ROLE_KEYS and isinstance(v, dict):
            continue
        base[k] = v

    tm = or_block.get("talk_model")
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

    bm = or_block.get("brain_model")
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

    mm = or_block.get("memory_model")
    if isinstance(mm, dict):
        if mm.get("max_tokens") is not None:
            base["reflection_max_tokens"] = mm["max_tokens"]
        if mm.get("temperature") is not None:
            base["reflection_temperature"] = mm["temperature"]
        if mm.get("timeout_seconds") is not None:
            base["reflection_timeout_seconds"] = mm["timeout_seconds"]
        if mm.get("max_retries") is not None:
            base["reflection_max_retries"] = mm["max_retries"]

    vm = or_block.get("vision_model")
    if isinstance(vm, dict):
        if vm.get("max_tokens") is not None:
            base["vision_max_tokens"] = vm["max_tokens"]
        if vm.get("temperature") is not None:
            base["vision_temperature"] = vm["temperature"]
        if vm.get("timeout_seconds") is not None:
            base["vision_timeout_seconds"] = vm["timeout_seconds"]

    return base


def resolved_talk_model(cfg: dict, provider: str) -> str:
    """Финальный текст пользователю (talk_model): llm.model → openrouter.talk_model → legacy model/primary_model."""
    llm = cfg.get("llm") or {}
    or_block = _openrouter_block(cfg)
    if isinstance(llm, dict) and llm.get("model"):
        return str(llm["model"]).strip()
    if isinstance(or_block, dict):
        mid = _model_id_from_role(or_block, "talk_model")
        if mid:
            return DEPRECATED_MODEL_MAP.get(mid, mid)
        for key in ("model", "primary_model"):
            v = or_block.get(key)
            if v is not None and str(v).strip():
                logger.warning(
                    "Deprecated: openrouter.%s — задайте openrouter.talk_model (этап F).",
                    key,
                )
                raw = str(v).strip()
                return DEPRECATED_MODEL_MAP.get(raw, raw)
    preset = _OPENAI_COMPATIBLE_PRESETS.get(provider, {})
    dm = preset.get("default_model")
    if dm:
        return str(dm).strip()
    return "gpt-4o-mini"


def resolved_primary_model(cfg: dict, provider: str) -> str:
    """Deprecated alias для совместимости — см. resolved_talk_model."""
    return resolved_talk_model(cfg, provider)


def resolved_brain_model(cfg: dict, provider: str) -> str:
    """Маршрутизатор с инструментами (левое полушарие). Fallback: тот же id, что и talk."""
    or_block = _openrouter_block(cfg)
    mid = _model_id_from_role(or_block, "brain_model")
    if mid:
        return DEPRECATED_MODEL_MAP.get(mid, mid)
    return resolved_talk_model(cfg, provider)


def resolved_brain_model_deep(cfg: dict, provider: str) -> str:
    """Глубокая логика (правое полушарие): brain_model.model_deep → brain_model.model → talk."""
    or_block = _openrouter_block(cfg)
    bm = or_block.get("brain_model")
    if isinstance(bm, dict):
        deep = bm.get("model_deep")
        if deep is not None and str(deep).strip():
            raw = str(deep).strip()
            return DEPRECATED_MODEL_MAP.get(raw, raw)
    return resolved_brain_model(cfg, provider)


def resolved_memory_model(cfg: dict, provider: str) -> str:
    """Рефлексии, LTM digest, async diary notes — единая модель."""
    or_block = _openrouter_block(cfg)
    mid = _model_id_from_role(or_block, "memory_model")
    if mid:
        return DEPRECATED_MODEL_MAP.get(mid, mid)
    ar = cfg.get("async_reflection") if isinstance(cfg.get("async_reflection"), dict) else {}
    if ar.get("model"):
        logger.warning("Deprecated: async_reflection.model — задайте openrouter.memory_model.")
        raw = str(ar.get("model")).strip()
        return DEPRECATED_MODEL_MAP.get(raw, raw)
    rm = or_block.get("reflection_model")
    if rm is not None and str(rm).strip():
        logger.warning("Deprecated: openrouter.reflection_model — задайте openrouter.memory_model.")
        raw = str(rm).strip()
        return DEPRECATED_MODEL_MAP.get(raw, raw)
    return resolved_talk_model(cfg, provider)


_VISION_PIPELINE_KEYS = frozenset(
    {
        "enabled",
        "use_brain_model_for_vision",
        "use_main_model_for_vision",
        "max_images_per_message",
        "max_image_bytes",
        "max_image_width",
        "max_image_height",
        "remember_last_image",
        "last_image_note_max_chars",
    }
)


def merged_vision_pipeline(cfg: dict) -> dict[str, Any]:
    """
    Настройки vision-пайплайна (Discord вложения, память последнего скрина, флаги агента).

    Источник истины: ``openrouter.vision_model`` (mapping): модель VL, лимиты токенов/HTTP
    и параметры контура (enabled, размеры изображений, …).

    Устаревший корневой блок ``vision:`` подмешивается с предупреждением и **ниже приоритета**,
    чем ``openrouter.vision_model``.
    """
    defaults: dict[str, Any] = {
        "enabled": False,
        "use_brain_model_for_vision": False,
        "use_main_model_for_vision": False,
        "max_images_per_message": 4,
        "max_image_bytes": 8388608,
        "max_image_width": 1920,
        "max_image_height": 1080,
        "remember_last_image": True,
        "last_image_note_max_chars": 1200,
    }
    out = dict(defaults)
    or_block = _openrouter_block(cfg)

    legacy = cfg.get("vision") if isinstance(cfg.get("vision"), dict) else {}
    if legacy:
        logger.warning(
            "Устарело: корневой блок vision: удалён из шаблона; перенесите ключи в openrouter.vision_model."
        )
        for k in _VISION_PIPELINE_KEYS:
            if k in legacy and legacy[k] is not None:
                out[k] = legacy[k]

    vm = or_block.get("vision_model")
    if isinstance(vm, dict):
        for k in _VISION_PIPELINE_KEYS:
            if k in vm and vm[k] is not None:
                out[k] = vm[k]
        mid = _model_id_from_role(or_block, "vision_model")
        if mid and "enabled" not in vm:
            out["enabled"] = True
    elif isinstance(vm, str) and vm.strip():
        out["enabled"] = True

    out["enabled"] = bool(out["enabled"])
    if out.get("use_main_model_for_vision") and not out.get("use_brain_model_for_vision"):
        logger.warning(
            "Deprecated: openrouter.vision_model.use_main_model_for_vision — "
            "переименуйте в use_brain_model_for_vision."
        )
    out["use_brain_model_for_vision"] = bool(
        out.get("use_brain_model_for_vision") or out.get("use_main_model_for_vision")
    )
    out["use_main_model_for_vision"] = out["use_brain_model_for_vision"]
    out["remember_last_image"] = bool(out["remember_last_image"])
    out["max_images_per_message"] = max(1, int(out["max_images_per_message"]))
    out["max_image_bytes"] = int(out["max_image_bytes"])
    out["max_image_width"] = max(16, int(out["max_image_width"]))
    out["max_image_height"] = max(16, int(out["max_image_height"]))
    out["last_image_note_max_chars"] = max(100, int(out["last_image_note_max_chars"]))
    return out


def resolved_vision_model_id(cfg: dict, provider: str) -> str:
    """VL-модель: openrouter.vision_model (строка или model/id во вложении) → talk_model."""
    or_block = _openrouter_block(cfg)
    mid = _model_id_from_role(or_block, "vision_model")
    if mid:
        return DEPRECATED_MODEL_MAP.get(mid, mid)
    return resolved_talk_model(cfg, provider)


def merge_llm_tuning_options(cfg: dict) -> dict[str, Any]:
    """
    Параметры сэмплинга, таймаутов и т.д.: блок openrouter + переопределения из llm.

    Вложенные dict talk_model / brain_model / memory_model / vision_model разворачиваются
    в плоские ключи (см. expand_openrouter_nested).

    Зарезервированные ключи llm не попадают в «тюнинг».
    """
    reserved = {
        "provider",
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
    }
    or_raw = cfg.get("openrouter") if isinstance(cfg.get("openrouter"), dict) else {}
    out: dict[str, Any] = expand_openrouter_nested(or_raw)
    llm = cfg.get("llm") or {}
    if not isinstance(llm, dict):
        return out
    for k, v in llm.items():
        if k in reserved:
            continue
        if v is not None:
            out[k] = v
    return out


def resolve_openai_compatible_connection(
    cfg: dict,
    *,
    role: str | None = None,
) -> OpenAICompatibleConnection:
    """
    Собирает base_url / api_key / заголовки для OpenAI-compatible клиента.

    Приоритет провайдера: openrouter.<role>.provider → llm.provider → BACKEND → openrouter.
    Per-provider overrides: llm.providers.<name>.{base_url,api_key,default_headers}.
    """
    if not isinstance(cfg, dict):
        raise TypeError("config must be a dict")

    provider = resolve_role_provider(cfg, role)
    if not provider:
        provider = "openrouter"

    if provider not in _OPENAI_COMPATIBLE_PRESETS:
        known = ", ".join(sorted(_OPENAI_COMPATIBLE_PRESETS))
        raise ValueError(
            f"Неизвестный LLM-провайдер '{provider}'. "
            f"Допустимые значения: {known}. "
            "Для кастомного endpoint используйте провайдер с дефолтным URL и задайте llm.base_url."
        )

    preset = _OPENAI_COMPATIBLE_PRESETS[provider]
    llm = _llm_block(cfg)
    or_block = _openrouter_block(cfg)
    prov_over = _providers_block(cfg).get(provider)
    if not isinstance(prov_over, dict):
        prov_over = {}

    base_url = str(
        prov_over.get("base_url")
        or llm.get("base_url")
        or (or_block.get("base_url") if provider == "openrouter" else "")
        or preset.get("base_url")
        or ""
    ).strip()
    if preset.get("requires_base_url") and not base_url:
        raise ValueError(
            f"Провайдер '{provider}' требует явного llm.base_url / llm.providers.{provider}.base_url "
            "на OpenAI-compatible endpoint."
        )
    if preset.get("requires_openai_compatible_base_url") and not base_url:
        raise ValueError(
            f"Провайдер '{provider}' не использует нативный OpenAI Chat Completions API. "
            "Укажите llm.base_url на OpenAI-compatible шлюз (например OpenRouter, LiteLLM proxy)."
        )

    api_key = str(
        prov_over.get("api_key")
        or (or_block.get("api_key") if provider == "openrouter" else "")
        or llm.get("api_key")
        or ""
    ).strip()
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


def is_local_openai_compatible_provider(provider: str) -> bool:
    """Локальные/self-host профили для подсказок в системном промпте."""
    return provider.strip().lower() in {"ollama", "lmstudio", "vllm"}
