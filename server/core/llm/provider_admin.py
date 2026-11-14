"""Провайдеры LLM, зрения и речи для админки: каталог и безопасные проверки.

Чистые помощники без FastAPI: чтение состояния провайдеров из конфига, проверка
имени и base_url, каталог популярных сервисов для карточек «Подключить». Секреты
здесь не выдаются и не сохраняются: только флаг «ключ задан» и его источник.

Вид провайдера (``provider_type``) определяет набор полей:

* ``llm``    — текстовые модели, лейны talk / brain / memory;
* ``vision`` — модели, которые принимают изображения (лейн vision);
* ``stt``    — распознавание речи;
* ``tts``    — синтез речи.

Настройки провайдера, кроме ключа, лежат в ``llm.providers.<name>.fields``.
Ключ по-прежнему хранится только в шифрованном vault по имени провайдера.
"""

from __future__ import annotations

import re
from typing import Any, Iterable, Mapping
from urllib.parse import urlparse

# Идентификатор провайдера: строчные латинские буквы, цифры, точка, дефис, _.
PROVIDER_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")

LANES: tuple[str, ...] = ("talk", "brain", "memory", "vision")

PROVIDER_TYPES: tuple[str, ...] = ("llm", "vision", "stt", "tts")

PROVIDER_TYPE_LABELS: dict[str, str] = {
    "llm": "LLM",
    "vision": "Vision",
    "stt": "Речь → текст",
    "tts": "Текст → речь",
}

PROVIDER_KINDS: tuple[str, ...] = ("openai", "local", "proxy", "cli")


def _field(
    key: str,
    label: str,
    *,
    kind: str = "text",
    required: bool = False,
    placeholder: str = "",
    help: str = "",
    default: Any = "",
    options: Iterable[Mapping[str, str]] = (),
    min_value: float | None = None,
    max_value: float | None = None,
    max_length: int = 200,
) -> dict[str, Any]:
    """Описание одного необязательного (не секретного) поля пресета."""
    item: dict[str, Any] = {
        "key": key,
        "label": label,
        "kind": kind,
        "required": required,
        "placeholder": placeholder,
        "help": help,
        "default": default,
        "options": [{"value": str(o.get("value", "")), "label": str(o.get("label", ""))} for o in options],
        "max_length": max_length,
    }
    if min_value is not None:
        item["min"] = min_value
    if max_value is not None:
        item["max"] = max_value
    return item


# Пресеты для карточек «Подключить»: пользователь выбирает сервис и вставляет
# ключ, остальные поля уже с подсказками. base_url можно менять — у
# OpenAI-совместимых шлюзов адрес часто свой.
PROVIDER_PRESETS: tuple[dict[str, Any], ...] = (
    # ── LLM ──────────────────────────────────────────────────────────────
    {
        "id": "openai",
        "label": "OpenAI",
        "type": "llm",
        "base_url": "https://api.openai.com/v1",
        "kind": "openai",
        "needs_key": True,
        "hint": "Официальный API OpenAI; ключ вида sk-…",
        "docs_url": "https://platform.openai.com/docs",
        "fields": (),
    },
    {
        "id": "anthropic",
        "label": "Anthropic",
        "type": "llm",
        "base_url": "https://api.anthropic.com/v1",
        "kind": "openai",
        "needs_key": True,
        "hint": "Claude; нужен OpenAI-совместимый адрес (обычно через прокси или OpenRouter)",
        "docs_url": "https://docs.anthropic.com",
        "fields": (),
    },
    {
        "id": "openrouter",
        "label": "OpenRouter",
        "type": "llm",
        "base_url": "https://openrouter.ai/api/v1",
        "kind": "openai",
        "needs_key": True,
        "hint": "Сотни моделей через один ключ; удобно для Claude и Gemini",
        "docs_url": "https://openrouter.ai/docs",
        "fields": (),
    },
    {
        "id": "groq",
        "label": "Groq",
        "type": "llm",
        "base_url": "https://api.groq.com/openai/v1",
        "kind": "openai",
        "needs_key": True,
        "hint": "Быстрый инференс открытых моделей",
        "docs_url": "https://console.groq.com/docs",
        "fields": (),
    },
    {
        "id": "mistral",
        "label": "Mistral",
        "type": "llm",
        "base_url": "https://api.mistral.ai/v1",
        "kind": "openai",
        "needs_key": True,
        "hint": "Mistral и Codestral",
        "docs_url": "https://docs.mistral.ai",
        "fields": (),
    },
    {
        "id": "together",
        "label": "Together AI",
        "type": "llm",
        "base_url": "https://api.together.xyz/v1",
        "kind": "openai",
        "needs_key": True,
        "hint": "Открытые модели по API",
        "docs_url": "https://docs.together.ai",
        "fields": (),
    },
    {
        "id": "fireworks",
        "label": "Fireworks AI",
        "type": "llm",
        "base_url": "https://api.fireworks.ai/inference/v1",
        "kind": "openai",
        "needs_key": True,
        "hint": "Открытые модели, быстрый хостинг",
        "docs_url": "https://docs.fireworks.ai",
        "fields": (),
    },
    {
        "id": "ollama",
        "label": "Ollama (локально)",
        "type": "llm",
        "base_url": "http://127.0.0.1:11434/v1",
        "kind": "local",
        "needs_key": False,
        "hint": "Локальные модели на этом же сервере; ключ не нужен",
        "docs_url": "https://docs.ollama.com",
        "fields": (),
    },
    {
        "id": "lmstudio",
        "label": "LM Studio (локально)",
        "type": "llm",
        "base_url": "http://127.0.0.1:1234/v1",
        "kind": "local",
        "needs_key": False,
        "hint": "Локальный сервер LM Studio",
        "docs_url": "https://lmstudio.ai/docs",
        "fields": (),
    },
    {
        "id": "vllm",
        "label": "vLLM / свой шлюз",
        "type": "llm",
        "base_url": "",
        "kind": "local",
        "needs_key": False,
        "hint": "Любой OpenAI-совместимый адрес: ноутбук, vLLM, LiteLLM, прокси",
        "docs_url": "https://docs.vllm.ai",
        "fields": (),
    },
    # ── Vision ───────────────────────────────────────────────────────────
    {
        "id": "openai-vision",
        "label": "OpenAI Vision",
        "type": "vision",
        "base_url": "https://api.openai.com/v1",
        "kind": "openai",
        "needs_key": True,
        "hint": "Модель, которая видит изображения; отдельный провайдер для лейна vision",
        "docs_url": "https://platform.openai.com/docs/guides/vision",
        "fields": (
            _field("model", "Модель", placeholder="gpt-4o-mini", help="Пусто — выберите модель в разделе «Модели»"),
        ),
    },
    {
        "id": "openrouter-vision",
        "label": "OpenRouter Vision",
        "type": "vision",
        "base_url": "https://openrouter.ai/api/v1",
        "kind": "openai",
        "needs_key": True,
        "hint": "Любая мультимодальная модель OpenRouter",
        "docs_url": "https://openrouter.ai/docs/features/multimodal",
        "fields": (
            _field("model", "Модель", placeholder="openai/gpt-4o-mini", help="Пусто — выберите модель в разделе «Модели»"),
        ),
    },
    # ── STT ──────────────────────────────────────────────────────────────
    {
        "id": "deepgram-stt",
        "label": "Deepgram STT",
        "type": "stt",
        "base_url": "https://api.deepgram.com/v1",
        "kind": "openai",
        "needs_key": True,
        "hint": "Распознавание речи; тот же ключ, что у Deepgram TTS",
        "docs_url": "https://developers.deepgram.com/docs/stt",
        "fields": (
            _field(
                "model",
                "Модель",
                kind="select",
                default="nova-3",
                options=(
                    {"value": "nova-3", "label": "Nova 3"},
                    {"value": "nova-2", "label": "Nova 2"},
                    {"value": "enhanced", "label": "Enhanced"},
                    {"value": "base", "label": "Base"},
                ),
            ),
            _field("language", "Язык", placeholder="ru", help="Код языка; пусто — автоопределение"),
        ),
    },
    {
        "id": "yandex-stt",
        "label": "Yandex SpeechKit STT",
        "type": "stt",
        "base_url": "https://stt.api.cloud.yandex.net/speech/v1",
        "kind": "openai",
        "needs_key": True,
        "hint": "Распознавание речи Yandex Cloud; нужен folder_id",
        "docs_url": "https://yandex.cloud/ru/docs/speechkit/stt",
        "fields": (
            _field("folder_id", "Folder ID", required=True, placeholder="b1g…", help="Идентификатор каталога Yandex Cloud"),
            _field(
                "language",
                "Язык",
                kind="select",
                default="ru-RU",
                options=(
                    {"value": "ru-RU", "label": "Русский"},
                    {"value": "en-US", "label": "English"},
                    {"value": "kk-KK", "label": "Қазақша"},
                    {"value": "tr-TR", "label": "Türkçe"},
                ),
            ),
            _field("model", "Модель", default="general", placeholder="general", help="general / general:rc"),
        ),
    },
    {
        "id": "openai-stt",
        "label": "OpenAI-совместимый STT",
        "type": "stt",
        "base_url": "https://api.openai.com/v1",
        "kind": "openai",
        "needs_key": True,
        "hint": "Любой шлюз с /audio/transcriptions: OpenAI, Groq, OpenRouter, локальный",
        "docs_url": "https://platform.openai.com/docs/guides/speech-to-text",
        "fields": (
            _field(
                "model",
                "Модель",
                kind="select",
                default="whisper-1",
                options=(
                    {"value": "whisper-1", "label": "whisper-1"},
                    {"value": "gpt-4o-transcribe", "label": "gpt-4o-transcribe"},
                    {"value": "gpt-4o-mini-transcribe", "label": "gpt-4o-mini-transcribe"},
                ),
            ),
            _field("language", "Язык", placeholder="ru", help="ISO-639-1; пусто — автоопределение"),
        ),
    },
    {
        "id": "groq-stt",
        "label": "Groq STT",
        "type": "stt",
        "base_url": "https://api.groq.com/openai/v1",
        "kind": "openai",
        "needs_key": True,
        "hint": "Быстрое распознавание Whisper на Groq",
        "docs_url": "https://console.groq.com/docs/speech-to-text",
        "fields": (
            _field("model", "Модель", default="whisper-large-v3-turbo", placeholder="whisper-large-v3-turbo"),
            _field("language", "Язык", placeholder="ru", help="ISO-639-1; пусто — автоопределение"),
        ),
    },
    # ── TTS ──────────────────────────────────────────────────────────────
    {
        "id": "deepgram-tts",
        "label": "Deepgram TTS",
        "type": "tts",
        "base_url": "https://api.deepgram.com/v1",
        "kind": "openai",
        "needs_key": True,
        "hint": "Озвучка Deepgram; русский голос flux-polina-ru",
        "docs_url": "https://developers.deepgram.com/docs/tts",
        "fields": (
            _field("model", "Голос / модель", default="flux-polina-ru", placeholder="flux-polina-ru"),
            _field("expressivity", "Выразительность", kind="number", default=0, min_value=-2, max_value=2),
            _field(
                "sample_rate",
                "Частота",
                kind="select",
                default="24000",
                options=(
                    {"value": "24000", "label": "24 кГц"},
                    {"value": "16000", "label": "16 кГц"},
                    {"value": "48000", "label": "48 кГц"},
                ),
            ),
        ),
    },
    {
        "id": "yandex-tts",
        "label": "Yandex SpeechKit TTS",
        "type": "tts",
        "base_url": "https://tts.api.cloud.yandex.net/tts/v3",
        "kind": "openai",
        "needs_key": True,
        "hint": "Озвучка Yandex Cloud; нужен folder_id",
        "docs_url": "https://yandex.cloud/ru/docs/speechkit/tts",
        "fields": (
            _field("folder_id", "Folder ID", required=True, placeholder="b1g…", help="Идентификатор каталога Yandex Cloud"),
            _field(
                "language",
                "Язык",
                kind="select",
                default="ru-RU",
                options=(
                    {"value": "ru-RU", "label": "Русский"},
                    {"value": "en-US", "label": "English"},
                    {"value": "kk-KK", "label": "Қазақша"},
                ),
            ),
            _field("model", "Голос / модель", default="masha", placeholder="masha"),
            _field(
                "role",
                "Роль",
                kind="select",
                default="friendly",
                options=(
                    {"value": "friendly", "label": "Дружелюбная"},
                    {"value": "neutral", "label": "Нейтральная"},
                    {"value": "strict", "label": "Строгая"},
                ),
            ),
            _field("speed", "Скорость", kind="number", default=1.0, min_value=0.1, max_value=3.0),
        ),
    },
    {
        "id": "openai-tts",
        "label": "OpenAI-совместимый TTS",
        "type": "tts",
        "base_url": "https://api.openai.com/v1",
        "kind": "openai",
        "needs_key": True,
        "hint": "Любой шлюз с /audio/speech: OpenAI или совместимый",
        "docs_url": "https://platform.openai.com/docs/guides/text-to-speech",
        "fields": (
            _field(
                "model",
                "Модель",
                kind="select",
                default="gpt-4o-mini-tts",
                options=(
                    {"value": "gpt-4o-mini-tts", "label": "gpt-4o-mini-tts"},
                    {"value": "tts-1", "label": "tts-1"},
                    {"value": "tts-1-hd", "label": "tts-1-hd"},
                ),
            ),
            _field(
                "voice",
                "Голос",
                kind="select",
                default="alloy",
                options=(
                    {"value": "alloy", "label": "alloy"},
                    {"value": "echo", "label": "echo"},
                    {"value": "fable", "label": "fable"},
                    {"value": "onyx", "label": "onyx"},
                    {"value": "nova", "label": "nova"},
                    {"value": "shimmer", "label": "shimmer"},
                ),
            ),
        ),
    },
    # ── Свободный провайдер ──────────────────────────────────────────────
    {
        "id": "custom",
        "label": "Свой провайдер",
        "type": "llm",
        "base_url": "",
        "kind": "openai",
        "needs_key": True,
        "hint": "Свободное имя и адрес /v1 — подходит любой OpenAI-совместимый сервис",
        "docs_url": "",
        "fields": (),
    },
)

_PRESET_BY_ID: dict[str, dict[str, Any]] = {str(item["id"]): item for item in PROVIDER_PRESETS}


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
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ProviderAdminError("invalid_base_url", "base_url должен начинаться с http:// или https://")
    if parsed.username or parsed.password:
        raise ProviderAdminError("invalid_base_url", "В base_url нельзя передавать логин и пароль.")
    return value.rstrip("/")


def preset_for(preset_id: Any) -> dict[str, Any] | None:
    """Пресет по id (регистр не важен); неизвестный id — ``None``."""
    return _PRESET_BY_ID.get(str(preset_id or "").strip().lower())


def normalize_provider_type(raw: Any, *, preset: Mapping[str, Any] | None = None) -> str:
    """Вид провайдера; для пресета допускается только его собственный вид."""
    fallback = str((preset or {}).get("type") or "llm").strip().lower()
    value = str(raw or fallback).strip().lower()
    if value not in PROVIDER_TYPES:
        raise ProviderAdminError(
            "invalid_provider_type",
            "Вид провайдера: llm, vision, stt или tts.",
        )
    expected = str((preset or {}).get("type") or "").strip().lower()
    if expected and value != expected and (preset or {}).get("id") != "custom":
        raise ProviderAdminError(
            "invalid_provider_type",
            f"Пресет «{(preset or {}).get('label', '')}» относится к виду {expected}.",
        )
    return value


def provider_fields(preset_id: Any) -> list[dict[str, Any]]:
    """Поля выбранного пресета (копии, чтобы вызывающий не менял каталог)."""
    preset = preset_for(preset_id)
    if not preset:
        return []
    return [dict(field) for field in preset.get("fields", ())]


def _normalize_field(spec: Mapping[str, Any], raw: Any) -> Any:
    kind = str(spec.get("kind") or "text")
    key = str(spec.get("key") or "")
    label = str(spec.get("label") or key)
    if kind == "number":
        text = str(raw).strip().replace(",", ".")
        if not text:
            if spec.get("required"):
                raise ProviderAdminError("invalid_field", f"Заполните «{label}».")
            default = spec.get("default", "")
            return default
        try:
            value = float(text)
        except ValueError as exc:
            raise ProviderAdminError("invalid_field", f"«{label}»: нужно число.") from exc
        minimum = spec.get("min")
        maximum = spec.get("max")
        if isinstance(minimum, (int, float)) and value < minimum:
            raise ProviderAdminError("invalid_field", f"«{label}»: не меньше {minimum}.")
        if isinstance(maximum, (int, float)) and value > maximum:
            raise ProviderAdminError("invalid_field", f"«{label}»: не больше {maximum}.")
        return int(value) if value.is_integer() else value

    text = "" if raw is None else str(raw).strip()
    if not text:
        if spec.get("required"):
            raise ProviderAdminError("invalid_field", f"Заполните «{label}».")
        default = spec.get("default", "")
        return "" if default is None else default
    max_length = int(spec.get("max_length") or 200)
    if len(text) > max_length:
        raise ProviderAdminError("invalid_field", f"«{label}»: не длиннее {max_length} символов.")
    if kind == "select":
        allowed = {str(item.get("value")) for item in spec.get("options", ())}
        if text not in allowed:
            raise ProviderAdminError("invalid_field", f"«{label}»: недопустимое значение.")
    elif kind == "url":
        parsed = urlparse(text)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ProviderAdminError("invalid_field", f"«{label}»: нужен адрес http:// или https://.")
    return text


def validate_provider_fields(preset_id: Any, raw_fields: Any) -> dict[str, Any]:
    """Проверить несекретные настройки строго по полям пресета.

    Неизвестные ключи отвергаются, чтобы через API нельзя было записать в
    конфиг произвольные данные (включая секреты мимо vault).
    """
    preset = preset_for(preset_id)
    allowed = {str(field["key"]): field for field in (preset or {}).get("fields", ())}
    if raw_fields is None:
        raw_fields = {}
    if not isinstance(raw_fields, Mapping):
        raise ProviderAdminError("invalid_field", "Поля провайдера должны быть объектом.")
    unknown = sorted(str(key) for key in raw_fields if str(key) not in allowed)
    if unknown:
        raise ProviderAdminError(
            "invalid_field",
            "Неизвестные параметры провайдера: " + ", ".join(unknown),
        )
    result: dict[str, Any] = {}
    for key, spec in allowed.items():
        if key in raw_fields:
            result[key] = _normalize_field(spec, raw_fields[key])
            continue
        default = spec.get("default", "")
        if spec.get("required"):
            raise ProviderAdminError("invalid_field", f"Заполните «{spec.get('label') or key}».")
        if default not in (None, ""):
            result[key] = default
    return result


def provider_config_updates(
    provider: Any,
    *,
    base_url: Any,
    kind: Any = "openai",
    preset: Any = None,
    provider_type: Any = None,
    fields: Any = None,
) -> dict[str, Any]:
    """Собрать dotted-обновления ``llm.yaml`` для одного провайдера.

    Функция ничего не пишет: app.py передаёт результат в
    ``persist_allowlisted_updates``. Секретов в результате нет.
    """
    name = normalize_provider_name(provider)
    preset_id = str(preset or name).strip().lower()
    spec = preset_for(preset_id)
    if preset_id and not spec and preset_id != "custom":
        # Свободный провайдер может называться как угодно; пресет ему не нужен.
        preset_id = ""
    ptype = normalize_provider_type(provider_type, preset=spec)
    clean_fields = validate_provider_fields(preset_id, fields)
    transport = str(kind or "openai").strip().lower()
    if transport not in PROVIDER_KINDS:
        transport = "openai"
    url = validate_base_url(base_url)
    return {
        f"llm.providers.{name}.base_url": url,
        f"llm.providers.{name}.kind": transport,
        f"llm.providers.{name}.preset": preset_id,
        f"llm.providers.{name}.provider_type": ptype,
        f"llm.providers.{name}.fields": clean_fields,
    }


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


def _preset_id_for(name: str, block: Mapping[str, Any]) -> str:
    raw = str(block.get("preset") or "").strip().lower()
    if raw in _PRESET_BY_ID:
        return raw
    if str(name) in _PRESET_BY_ID:
        return str(name)
    return ""


def provider_rows(
    cfg: Mapping[str, Any],
    *,
    vault_names: list[str] | None = None,
    env: Mapping[str, str] | None = None,
) -> list[dict[str, Any]]:
    """Состояние провайдеров без секретов: адрес, вид, поля, ключ, занятые лейны."""
    import os

    source = os.environ if env is None else env
    vault = set(vault_names or [])
    rows: list[dict[str, Any]] = []
    for name, raw in sorted(_providers_block(cfg).items()):
        block = raw if isinstance(raw, Mapping) else {}
        preset_id = _preset_id_for(str(name), block)
        preset = _PRESET_BY_ID.get(preset_id, {})
        ptype = str(block.get("provider_type") or preset.get("type") or "llm").strip().lower()
        if ptype not in PROVIDER_TYPES:
            ptype = "llm"
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
        raw_fields = block.get("fields") if isinstance(block.get("fields"), Mapping) else {}
        allowed_fields = {str(field["key"]) for field in preset.get("fields", ())}
        fields_out = {
            str(key): value
            for key, value in raw_fields.items()
            if str(key) in allowed_fields and isinstance(value, (str, int, float, bool))
        }
        rows.append(
            {
                "name": str(name),
                "label": str(preset.get("label") or name),
                "base_url": base_url,
                "kind": str(block.get("kind") or preset.get("kind") or "openai"),
                "builtin": bool(preset),
                "preset": preset_id,
                "provider_type": ptype,
                "provider_type_label": PROVIDER_TYPE_LABELS.get(ptype, ptype),
                "fields": fields_out,
                "needs_key": bool(preset.get("needs_key", True)),
                "has_key": key_source != "none",
                "key_source": key_source,
                "lanes": lanes_for_provider(cfg, str(name)),
            }
        )
    return rows


def preset_catalog() -> list[dict[str, Any]]:
    """Каталог пресетов для карточек. Копии; секретов и ключей здесь нет."""
    return [
        {
            **{key: value for key, value in item.items() if key != "fields"},
            "type_label": PROVIDER_TYPE_LABELS.get(str(item.get("type")), str(item.get("type") or "")),
            "fields": [dict(field) for field in item.get("fields", ())],
        }
        for item in PROVIDER_PRESETS
    ]
