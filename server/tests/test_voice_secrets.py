"""Voice secret injection preserves the YAML configuration shape."""

import os
from copy import deepcopy
from unittest.mock import patch

import pytest

from core.runtime.secrets import apply_env_secrets
from core.voice.config import normalize_voice_config, resolve_tts_providers, resolve_tts_runtime


@pytest.mark.parametrize(
    ("config", "tts_path"),
    [
        (
            {"voice": {"tts": {"prefer": "cloud", "cloud": {"enable": True}}}},
            ("voice", "tts", "cloud"),
        ),
        (
            {"voice": {"is_local": False, "cloud": {"tts": {}}}},
            ("voice", "cloud", "tts"),
        ),
    ],
    ids=["modality", "is_local"],
)
def test_deepgram_tts_secret_reaches_runtime_without_environment(config, tts_path):
    with patch.dict(os.environ, {"DEEPGRAM_API_KEY": "test-deepgram"}, clear=True):
        apply_env_secrets(config)

    tts_block = config
    for part in tts_path:
        tts_block = tts_block[part]
    assert tts_block["deepgram"]["api_key"] == "test-deepgram"
    with patch.dict(os.environ, {}, clear=True):
        assert resolve_tts_providers(config) == ["deepgram"]
        assert resolve_tts_runtime(config)["available"] is True
        assert normalize_voice_config(config)["tts"]["cloud"]["deepgram"]["api_key"] == "test-deepgram"

    if "is_local" in config["voice"]:
        assert "tts" not in config["voice"]
        assert "stt" not in config["voice"]


@pytest.mark.parametrize("with_flat_tts", [False, True], ids=["no_tts", "flat_tts"])
def test_deepgram_secret_preserves_legacy_flat_tts(with_flat_tts):
    config = {
        "voice": {"stt": {"engine": "deepgram"}},
        "voice_cloud": {"tts": {"api_key": "test-yandex", "folder_id": "test-folder"}},
    }
    if with_flat_tts:
        config["voice"]["tts"] = {"voice": "masha", "speed": 1.15}
    original_tts = deepcopy(config["voice"].get("tts"))
    original_cloud_tts = deepcopy(config["voice_cloud"]["tts"])

    with patch.dict(os.environ, {"DEEPGRAM_API_KEY": "test-deepgram"}, clear=True):
        apply_env_secrets(config)
        assert resolve_tts_providers(config) == ["deepgram", "yandex"]

    assert config["voice"].get("tts") == original_tts
    assert ("tts" in config["voice"]) is with_flat_tts
    assert config["voice_cloud"]["tts"] == original_cloud_tts
    assert config["voice"]["stt"]["deepgram"]["api_key"] == "test-deepgram"
    with patch.dict(os.environ, {}, clear=True):
        assert resolve_tts_providers(config) == ["yandex"]
        assert resolve_tts_runtime(config)["available"] is True
