"""Каталог провайдеров: виды llm/vision/stt/tts, поля пресетов, валидация.

Offline: только чистые помощники provider_admin. Ни сети, ни конфига на диске.
"""

from __future__ import annotations

import pytest

from core.llm.provider_admin import (
    PROVIDER_TYPE_LABELS,
    PROVIDER_TYPES,
    ProviderAdminError,
    preset_catalog,
    preset_for,
    provider_config_updates,
    provider_fields,
    provider_rows,
    validate_provider_fields,
)


REQUIRED_IDS = {
    "openai",
    "anthropic",
    "openrouter",
    "groq",
    "mistral",
    "together",
    "fireworks",
    "ollama",
    "lmstudio",
    "vllm",
    "deepgram-stt",
    "deepgram-tts",
    "yandex-stt",
    "yandex-tts",
    "openai-stt",
    "openai-tts",
    "custom",
}


def test_catalog_has_required_providers_and_valid_types():
    catalog = preset_catalog()
    ids = {item["id"] for item in catalog}
    assert REQUIRED_IDS <= ids
    assert len(ids) == len(catalog)
    for item in catalog:
        assert item["type"] in PROVIDER_TYPES, item["id"]
        assert item["type_label"] == PROVIDER_TYPE_LABELS[item["type"]]
        assert item["label"]
        if item["id"] != "custom":
            assert item["docs_url"].startswith("https://"), item["id"]
        keys = [field["key"] for field in item["fields"]]
        assert len(keys) == len(set(keys)), item["id"]


def test_catalog_copies_are_isolated():
    first = preset_catalog()
    first[0]["fields"].append({"key": "hacked"})
    first[0]["label"] = "changed"
    second = preset_catalog()
    assert second[0]["label"] != "changed"
    assert all(field["key"] != "hacked" for field in second[0]["fields"])


def test_yandex_requires_folder_id_and_applies_defaults():
    with pytest.raises(ProviderAdminError) as missing:
        validate_provider_fields("yandex-stt", {})
    assert "Folder ID" in missing.value.message

    fields = validate_provider_fields("yandex-stt", {"folder_id": " b1g-test "})
    assert fields == {"folder_id": "b1g-test", "language": "ru-RU", "model": "general"}


def test_field_validation_rejects_unknown_and_bad_values():
    with pytest.raises(ProviderAdminError) as unknown:
        validate_provider_fields("deepgram-stt", {"api_key": "sk-must-not-be-here"})
    assert "Неизвестные параметры" in unknown.value.message

    with pytest.raises(ProviderAdminError):
        validate_provider_fields("deepgram-stt", {"model": "no-such-model"})
    with pytest.raises(ProviderAdminError):
        validate_provider_fields("deepgram-tts", {"expressivity": 9})
    with pytest.raises(ProviderAdminError):
        validate_provider_fields("deepgram-tts", {"expressivity": "громко"})


def test_number_and_default_fields_are_normalized():
    assert validate_provider_fields("deepgram-tts", {"expressivity": "1,5"}) == {
        "model": "flux-polina-ru",
        "expressivity": 1.5,
        "sample_rate": "24000",
    }
    assert validate_provider_fields("openai-tts", {}) == {
        "model": "gpt-4o-mini-tts",
        "voice": "alloy",
    }


def test_provider_config_updates_keep_secrets_out_of_yaml():
    updates = provider_config_updates(
        "work-tts",
        base_url="https://api.deepgram.com/v1/",
        kind="openai",
        preset="deepgram-tts",
        provider_type="tts",
        fields={"model": "flux-polina-ru", "expressivity": 0},
    )
    assert updates == {
        "llm.providers.work-tts.base_url": "https://api.deepgram.com/v1",
        "llm.providers.work-tts.kind": "openai",
        "llm.providers.work-tts.preset": "deepgram-tts",
        "llm.providers.work-tts.provider_type": "tts",
        "llm.providers.work-tts.fields": {
            "model": "flux-polina-ru",
            "expressivity": 0,
            "sample_rate": "24000",
        },
    }
    assert "api_key" not in str(updates)


def test_provider_config_updates_reject_wrong_type_for_preset():
    with pytest.raises(ProviderAdminError) as wrong:
        provider_config_updates(
            "yandex-tts",
            base_url="https://tts.api.cloud.yandex.net/tts/v3",
            preset="yandex-tts",
            provider_type="stt",
            fields={"folder_id": "b1g"},
        )
    assert "относится к виду tts" in wrong.value.message


def test_free_provider_without_preset_allows_llm_only():
    updates = provider_config_updates(
        "my-gpu",
        base_url="http://192.168.1.10:8000/v1",
        kind="local",
        fields={},
    )
    assert updates["llm.providers.my-gpu.provider_type"] == "llm"
    assert updates["llm.providers.my-gpu.preset"] == ""
    assert updates["llm.providers.my-gpu.fields"] == {}

    # Свободное имя может быть и речевым провайдером: пресет не ограничивает вид.
    stt = provider_config_updates(
        "my-stt",
        base_url="http://192.168.1.10:9000/v1",
        provider_type="stt",
        fields={},
    )
    assert stt["llm.providers.my-stt.provider_type"] == "stt"


def test_provider_rows_report_type_fields_and_never_secret():
    cfg = {
        "llm": {
            "stt_model": {"provider": "work-tts"},
            "providers": {
                "work-tts": {
                    "base_url": "https://api.deepgram.com/v1",
                    "preset": "deepgram-tts",
                    "provider_type": "tts",
                    "fields": {"model": "flux-polina-ru", "expressivity": 0, "api_key": "leak"},
                    "api_key": "sk-plain-yaml",
                },
                "legacy": {"base_url": "https://legacy.example/v1"},
            },
        }
    }
    rows = {row["name"]: row for row in provider_rows(cfg, vault_names=[], env={})}
    row = rows["work-tts"]
    assert row["label"] == "Deepgram TTS"
    assert row["provider_type"] == "tts"
    assert row["provider_type_label"] == "Текст → речь"
    assert row["preset"] == "deepgram-tts"
    assert row["fields"] == {"model": "flux-polina-ru", "expressivity": 0}
    assert row["key_source"] == "yaml"
    assert "api_key" not in row["fields"]
    assert "sk-plain-yaml" not in str(row)

    legacy = rows["legacy"]
    assert legacy["provider_type"] == "llm"
    assert legacy["preset"] == ""
    assert legacy["fields"] == {}


def test_unknown_preset_id_is_not_builtin():
    assert preset_for("deepgram-tts") is not None
    assert preset_for("nope") is None
    assert provider_fields("nope") == []
