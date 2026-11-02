"""Tests for TTS dispatcher with fallback logic."""
import pytest
from core.voice import tts
from core.voice.config import collect_voice_soft_errors, resolve_tts_runtime
from core.runtime.secrets import apply_env_secrets
from unittest.mock import AsyncMock


@pytest.fixture(autouse=True)
def clean_provider_env(monkeypatch):
    for key in ("DEEPGRAM_API_KEY", "YANDEX_API_KEY", "YANDEX_FOLDER_ID", "YANDEX_ID_KEY"):
        monkeypatch.delenv(key, raising=False)


def cloud_config(**cloud):
    return {"voice": {"tts": {"cloud": {"enable": True, **cloud}}}}


@pytest.mark.asyncio
async def test_fallback_deepgram_to_yandex_missing_key():
    """When Deepgram key is missing, should fall back to Yandex."""
    import os
    from unittest.mock import patch
    
    config = {
        "voice": {
            "tts": {
                "enabled": True,
                "cloud": {
                    "provider": "deepgram",
                    "yandex": {
                        "api_key": "fake_yandex_key",
                        "folder_id": "fake_folder",
                    }
                }
            }
        }
    }
    
    with patch.dict(os.environ, {}, clear=True):
        # Mock yandex synthesize to return test data
        with patch("core.voice.yandex_tts.synthesize_to_wav_bytes") as mock_yandex:
            mock_yandex.return_value = b"YANDEX_AUDIO_DATA"
            
            result = await tts.synthesize_from_config("test", config)
            
            # Should have fallen back to yandex
            assert result == b"YANDEX_AUDIO_DATA"
            mock_yandex.assert_called_once()


@pytest.mark.asyncio
async def test_fallback_deepgram_to_yandex_on_error():
    """When Deepgram fails, should fall back to Yandex."""
    import os
    from unittest.mock import patch
    
    config = {
        "voice": {
            "tts": {
                "enabled": True,
                "cloud": {
                    "provider": "deepgram",
                    "deepgram": {"api_key": "fake_dg_key"},
                    "yandex": {
                        "api_key": "fake_yandex_key",
                        "folder_id": "fake_folder",
                    }
                }
            }
        }
    }
    
    with patch.dict(os.environ, {"DEEPGRAM_API_KEY": "fake_dg_key"}):
        # Mock deepgram to raise error
        with patch("core.voice.deepgram_tts.synthesize_to_wav_bytes") as mock_deepgram:
            mock_deepgram.side_effect = Exception("Network error")
            
            # Mock yandex to succeed
            with patch("core.voice.yandex_tts.synthesize_to_wav_bytes") as mock_yandex:
                mock_yandex.return_value = b"YANDEX_AUDIO_DATA"
                
                result = await tts.synthesize_from_config("test", config)
                
                # Should have fallen back to yandex
                assert result == b"YANDEX_AUDIO_DATA"
                mock_deepgram.assert_called_once()
                mock_yandex.assert_called_once()


@pytest.mark.asyncio
@pytest.mark.parametrize("nested", [False, True])
async def test_missing_deepgram_key_runtime_and_fallback(monkeypatch, nested):
    credentials = {"api_key": "test-yandex", "folder_id": "test-folder"}
    config = cloud_config(provider="deepgram", **({"yandex": credentials} if nested else credentials))
    assert resolve_tts_runtime(config)["available"]
    assert not [e for e in collect_voice_soft_errors(config) if "TTS" in e]
    dg = AsyncMock()
    ya = AsyncMock(return_value=b"yandex")
    monkeypatch.setattr("core.voice.deepgram_tts.synthesize_to_wav_bytes", dg)
    monkeypatch.setattr("core.voice.yandex_tts.synthesize_to_wav_bytes", ya)
    assert await tts.synthesize_from_config("test", config) == b"yandex"
    dg.assert_not_called()
    ya.assert_awaited_once()


def test_no_provider_credentials_unavailable():
    assert not resolve_tts_runtime(cloud_config(provider="deepgram"))["available"]


def test_env_injection_and_runtime(monkeypatch):
    monkeypatch.setenv("DEEPGRAM_API_KEY", "test-deepgram")
    config = cloud_config(provider="deepgram")
    apply_env_secrets(config)
    assert config["voice"]["tts"]["cloud"]["deepgram"]["api_key"] == "test-deepgram"
    assert resolve_tts_runtime(config)["available"]


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", [b"", RuntimeError("private text and headers")])
async def test_empty_or_failed_deepgram_falls_back(monkeypatch, caplog, failure):
    config = cloud_config(deepgram={"api_key": "test-deepgram"}, yandex={"api_key": "test-yandex", "folder_id": "test-folder"})
    dg = AsyncMock(side_effect=failure) if isinstance(failure, Exception) else AsyncMock(return_value=failure)
    monkeypatch.setattr("core.voice.deepgram_tts.synthesize_to_wav_bytes", dg)
    monkeypatch.setattr("core.voice.yandex_tts.synthesize_to_wav_bytes", AsyncMock(return_value=b"yandex"))
    assert await tts.synthesize_from_config("private text", config) == b"yandex"
    assert "private text" not in caplog.text


@pytest.mark.asyncio
async def test_legacy_flat_yandex_settings(monkeypatch):
    config = cloud_config(provider="yandex", api_key="test-yandex", folder_id="test-folder", voice="alena", role="good", endpoint="https://example.test/tts", speed=0.9, pitch_shift_hz=0, timeout_seconds=12)
    ya = AsyncMock(return_value=b"legacy")
    monkeypatch.setattr("core.voice.yandex_tts.synthesize_to_wav_bytes", ya)
    assert resolve_tts_runtime(config)["available"]
    assert await tts.synthesize_from_config("test", config) == b"legacy"
    ya.assert_awaited_once_with("test", api_key="test-yandex", folder_id="test-folder", voice="alena", role="good", endpoint="https://example.test/tts", speed=0.9, pitch_shift_hz=0.0, timeout=12.0)


@pytest.mark.asyncio
async def test_compat_wrapper_delegates(monkeypatch):
    from core.voice import yandex_tts
    dispatch = AsyncMock(return_value=b"dispatch")
    monkeypatch.setattr(tts, "synthesize_from_config", dispatch)
    config = cloud_config()
    assert await yandex_tts.synthesize_from_config("test", config) == b"dispatch"
    dispatch.assert_awaited_once_with("test", config)


@pytest.mark.asyncio
async def test_dispatcher_expressivity_and_timeout(monkeypatch):
    config = cloud_config(deepgram={"api_key": "test-deepgram", "expressivity": 0.5, "timeout_seconds": 7})
    dg = AsyncMock(return_value=b"audio")
    monkeypatch.setattr("core.voice.deepgram_tts.synthesize_to_wav_bytes", dg)
    assert await tts.synthesize_from_config("test", config) == b"audio"
    assert dg.call_args.kwargs["expressivity"] == 0
    assert type(dg.call_args.kwargs["expressivity"]) is int
    assert dg.call_args.kwargs["timeout"] == 7


def test_env_secrets_inject_deepgram(monkeypatch):
    from core.runtime.secrets import apply_env_secrets
    monkeypatch.setenv("DEEPGRAM_API_KEY", "test-env-key")
    config = {"voice": {"tts": {"cloud": {"provider": "deepgram"}}}}
    apply_env_secrets(config)
    assert config["voice"]["tts"]["cloud"]["deepgram"]["api_key"] == "test-env-key"
    assert resolve_tts_runtime(config)["available"]


def test_flat_yandex_key_does_not_authenticate_deepgram():
    config = {"voice": {"tts": {"cloud": {"provider": "deepgram", "api_key": "yandex-key"}}}}
    assert not resolve_tts_runtime(config)["available"]
    assert any("DEEPGRAM_API_KEY" in e for e in collect_voice_soft_errors(config))


@pytest.mark.asyncio
async def test_yandex_compat_wrapper_delegates(monkeypatch):
    from core.voice import yandex_tts
    dispatch = AsyncMock(return_value=b"audio")
    monkeypatch.setattr(tts, "synthesize_from_config", dispatch)
    config = {}
    assert await yandex_tts.synthesize_from_config("test", config) == b"audio"
    dispatch.assert_awaited_once_with("test", config)


@pytest.mark.asyncio
async def test_actual_empty_http_response_falls_back(monkeypatch):
    import httpx
    from core.voice import deepgram_tts
    from functools import partial
    config = {"voice": {"tts": {"cloud": {"provider": "deepgram",
        "deepgram": {"api_key": "test-key"},
        "yandex": {"api_key": "yandex-key", "folder_id": "folder"}}}}}
    transport = httpx.MockTransport(lambda request: httpx.Response(200, content=b""))
    monkeypatch.setattr(deepgram_tts, "synthesize_to_wav_bytes",
                        partial(deepgram_tts.synthesize_to_wav_bytes, transport=transport))
    yandex = AsyncMock(return_value=b"fallback")
    monkeypatch.setattr("core.voice.yandex_tts.synthesize_to_wav_bytes", yandex)
    assert await tts.synthesize_from_config("private text", config) == b"fallback"
    yandex.assert_awaited_once()
