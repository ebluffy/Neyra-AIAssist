"""Cloud TTS provider resolution and shared credential rules."""

import pytest

from core.voice.config import (
    collect_voice_soft_errors,
    print_voice_preflight,
    resolve_tts_providers,
    resolve_tts_runtime,
    tts_api_key,
    tts_folder_id,
    tts_provider,
    tts_provider_usable,
)


@pytest.fixture(autouse=True)
def clean_provider_env(monkeypatch):
    for key in ("DEEPGRAM_API_KEY", "YANDEX_API_KEY", "YANDEX_FOLDER_ID", "YANDEX_ID_KEY"):
        monkeypatch.delenv(key, raising=False)


def voice_config(shape, cloud):
    if shape == "modality":
        return {"voice": {"tts": {"cloud": {"enable": True, **cloud}}}}
    if shape == "is_local":
        return {"voice": {"is_local": False, "cloud": {"tts": cloud}}}
    return {"voice_cloud": {"tts": cloud}}


@pytest.mark.parametrize("shape", ["modality", "is_local", "flat"])
def test_unknown_tts_provider_is_unavailable_and_reported(shape, capsys):
    cloud = {
        "provider": "deepgramm",
        "deepgram": {"api_key": "test-deepgram"},
        "yandex": {"api_key": "test-yandex", "folder_id": "test-folder"},
    }
    config = voice_config(shape, cloud)

    assert resolve_tts_providers(config) == []
    runtime = resolve_tts_runtime(config)
    assert not runtime["available"]
    assert runtime["soft_errors"] == ["unknown cloud TTS provider: 'deepgramm'"]
    assert any("unknown cloud TTS provider: 'deepgramm'" in e for e in collect_voice_soft_errors(config))
    assert print_voice_preflight(config) == 0
    assert "unknown cloud TTS provider: 'deepgramm'" in capsys.readouterr().out


@pytest.mark.parametrize("shape", ["modality", "is_local", "flat"])
def test_default_tts_provider_order_and_legacy_yandex_fallback(shape):
    cloud = {
        "deepgram": {"api_key": "test-deepgram"},
        "api_key": "test-yandex",
        "folder_id": "test-folder",
    }
    config = voice_config(shape, cloud)

    assert tts_provider(cloud) == "deepgram"
    assert resolve_tts_providers(config) == ["deepgram", "yandex"]
    del cloud["deepgram"]
    assert resolve_tts_providers(voice_config(shape, cloud)) == ["yandex"]
    assert resolve_tts_runtime(voice_config(shape, cloud))["available"]


def test_shared_tts_credentials_respect_nested_flat_env_precedence(monkeypatch):
    monkeypatch.setenv("DEEPGRAM_API_KEY", "env-deepgram")
    monkeypatch.setenv("YANDEX_API_KEY", "env-yandex")
    monkeypatch.setenv("YANDEX_FOLDER_ID", "env-folder")
    block = {
        "deepgram": {"api_key": " nested-deepgram "},
        "yandex": {"api_key": " nested-yandex ", "folder_id": "nested-folder"},
        "api_key": "flat-yandex",
        "folder_id": "flat-folder",
    }

    assert tts_api_key(block, "deepgram") == "nested-deepgram"
    assert tts_api_key(block, "yandex") == "nested-yandex"
    assert tts_folder_id(block) == "nested-folder"
    del block["deepgram"]
    del block["yandex"]
    assert tts_api_key(block, "deepgram") == "env-deepgram"
    assert tts_api_key(block, "yandex") == "flat-yandex"
    assert tts_folder_id(block) == "flat-folder"
    assert tts_api_key({}, "yandex") == "env-yandex"
    assert tts_folder_id({}) == "env-folder"
    monkeypatch.delenv("YANDEX_FOLDER_ID")
    monkeypatch.setenv("YANDEX_ID_KEY", "legacy-env-folder")
    assert tts_folder_id({}) == "legacy-env-folder"


def test_unknown_tts_provider_cannot_use_yandex_credentials(monkeypatch):
    monkeypatch.setenv("YANDEX_API_KEY", "env-yandex")
    config = voice_config("modality", {"api_key": "test-yandex", "folder_id": "test-folder"})
    assert tts_api_key(config["voice"]["tts"]["cloud"], "deepgramm") == ""
    assert not tts_provider_usable(config, "deepgramm")
