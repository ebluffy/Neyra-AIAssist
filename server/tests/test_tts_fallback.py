"""Tests for TTS dispatcher with fallback logic."""

import asyncio
from functools import partial
from unittest.mock import AsyncMock

import httpx
import pytest

from core.voice import deepgram_tts, tts, yandex_tts
from core.voice.config import collect_voice_soft_errors, resolve_tts_runtime


@pytest.fixture(autouse=True)
def clean_provider_env(monkeypatch):
    for key in ("DEEPGRAM_API_KEY", "YANDEX_API_KEY", "YANDEX_FOLDER_ID", "YANDEX_ID_KEY"):
        monkeypatch.delenv(key, raising=False)


def cloud_config(**cloud):
    return {"voice": {"tts": {"cloud": {"enable": True, **cloud}}}}


def fallback_config(**deepgram):
    return cloud_config(
        deepgram={"api_key": "test-deepgram", **deepgram},
        yandex={"api_key": "test-yandex", "folder_id": "test-folder"},
    )


@pytest.mark.parametrize("nested", [False, True])
def test_missing_deepgram_key_runtime_and_fallback(monkeypatch, caplog, nested):
    credentials = {"api_key": "test-yandex", "folder_id": "test-folder"}
    config = cloud_config(provider="deepgram", **({"yandex": credentials} if nested else credentials))
    assert resolve_tts_runtime(config)["available"]
    assert not [e for e in collect_voice_soft_errors(config) if "TTS" in e]
    dg = AsyncMock()
    ya = AsyncMock(return_value=b"yandex")
    monkeypatch.setattr(deepgram_tts, "synthesize_to_wav_bytes", dg)
    monkeypatch.setattr(yandex_tts, "synthesize_to_wav_bytes", ya)
    assert asyncio.run(tts.synthesize_from_config("test", config)) == b"yandex"
    dg.assert_not_called()
    ya.assert_awaited_once()
    assert not caplog.records


def test_deepgram_primary_success_skips_yandex(monkeypatch):
    dg = AsyncMock(return_value=b"deepgram")
    ya = AsyncMock()
    monkeypatch.setattr(deepgram_tts, "synthesize_to_wav_bytes", dg)
    monkeypatch.setattr(yandex_tts, "synthesize_to_wav_bytes", ya)
    assert asyncio.run(tts.synthesize_from_config("test", fallback_config())) == b"deepgram"
    dg.assert_awaited_once()
    ya.assert_not_called()


def test_no_provider_credentials_unavailable():
    config = cloud_config(provider="deepgram")
    assert not resolve_tts_runtime(config)["available"]
    assert asyncio.run(tts.synthesize_from_config("test", config)) == b""


def test_unknown_provider_does_not_dispatch(monkeypatch, caplog):
    config = fallback_config()
    config["voice"]["tts"]["cloud"]["provider"] = "deepgramm"
    dg = AsyncMock()
    ya = AsyncMock()
    monkeypatch.setattr(deepgram_tts, "synthesize_to_wav_bytes", dg)
    monkeypatch.setattr(yandex_tts, "synthesize_to_wav_bytes", ya)
    assert asyncio.run(tts.synthesize_from_config("test", config)) == b""
    dg.assert_not_called()
    ya.assert_not_called()
    assert "unknown cloud TTS provider" in caplog.text


@pytest.mark.parametrize("failure", [b"", OSError("private text and headers")])
def test_empty_or_unexpected_deepgram_failure_falls_back(monkeypatch, caplog, failure):
    dg = AsyncMock(side_effect=failure) if isinstance(failure, Exception) else AsyncMock(return_value=failure)
    ya = AsyncMock(return_value=b"yandex")
    monkeypatch.setattr(deepgram_tts, "synthesize_to_wav_bytes", dg)
    monkeypatch.setattr(yandex_tts, "synthesize_to_wav_bytes", ya)
    assert asyncio.run(tts.synthesize_from_config("private text", fallback_config())) == b"yandex"
    dg.assert_awaited_once()
    ya.assert_awaited_once()
    assert "private text" not in caplog.text
    assert "fallback" in caplog.text
    if isinstance(failure, Exception):
        assert "OSError" in caplog.text


@pytest.mark.parametrize("shape", ["modality", "is_local", "flat"])
def test_legacy_flat_yandex_settings(monkeypatch, shape):
    cloud = dict(
        provider="yandex", api_key="test-yandex", folder_id="test-folder",
        voice="alena", role="good", endpoint="https://example.test/tts",
        speed=0.9, pitch_shift_hz=0, timeout_seconds=12,
    )
    if shape == "modality":
        config = cloud_config(**cloud)
    elif shape == "is_local":
        config = {"voice": {"is_local": False, "cloud": {"tts": cloud}}}
    else:
        config = {"voice_cloud": {"tts": cloud}}
    ya = AsyncMock(return_value=b"legacy")
    dg = AsyncMock()
    monkeypatch.setattr(yandex_tts, "synthesize_to_wav_bytes", ya)
    monkeypatch.setattr(deepgram_tts, "synthesize_to_wav_bytes", dg)
    assert resolve_tts_runtime(config)["available"]
    assert asyncio.run(tts.synthesize_from_config("test", config)) == b"legacy"
    dg.assert_not_called()
    ya.assert_awaited_once_with(
        "test", api_key="test-yandex", folder_id="test-folder", voice="alena",
        role="good", endpoint="https://example.test/tts", speed=0.9,
        pitch_shift_hz=0.0, timeout=12.0,
    )


def test_yandex_compat_wrapper_delegates(monkeypatch):
    dispatch = AsyncMock(return_value=b"dispatch")
    monkeypatch.setattr(tts, "synthesize_from_config", dispatch)
    config = cloud_config()
    assert asyncio.run(yandex_tts.synthesize_from_config("test", config)) == b"dispatch"
    dispatch.assert_awaited_once_with("test", config)


def test_dispatcher_expressivity_and_timeout(monkeypatch):
    config = cloud_config(deepgram={"api_key": "test-deepgram", "expressivity": 0.5, "timeout_seconds": 7})
    dg = AsyncMock(return_value=b"audio")
    monkeypatch.setattr(deepgram_tts, "synthesize_to_wav_bytes", dg)
    assert asyncio.run(tts.synthesize_from_config("test", config)) == b"audio"
    assert dg.call_args.kwargs["expressivity"] == 0
    assert type(dg.call_args.kwargs["expressivity"]) is int
    assert dg.call_args.kwargs["timeout"] == 7


@pytest.mark.parametrize("setting,value", [("sample_rate", "24k"), ("timeout_seconds", ""), ("sample_rate", None)])
def test_invalid_deepgram_numbers_fall_back(monkeypatch, caplog, setting, value):
    config = fallback_config(**{setting: value})
    dg = AsyncMock()
    ya = AsyncMock(return_value=b"fallback")
    monkeypatch.setattr(deepgram_tts, "synthesize_to_wav_bytes", dg)
    monkeypatch.setattr(yandex_tts, "synthesize_to_wav_bytes", ya)
    assert asyncio.run(tts.synthesize_from_config("private text", config)) == b"fallback"
    dg.assert_not_called()
    ya.assert_awaited_once()
    assert "invalid numeric settings" in caplog.text
    assert "private text" not in caplog.text


@pytest.mark.parametrize("nested", [False, True])
@pytest.mark.parametrize("setting", ["speed", "pitch_shift_hz", "timeout_seconds"])
def test_invalid_yandex_numbers_soft_fail(monkeypatch, caplog, nested, setting):
    settings = {"api_key": "test-yandex", "folder_id": "test-folder", setting: "invalid-private-value"}
    config = cloud_config(provider="yandex", **({"yandex": settings} if nested else settings))
    ya = AsyncMock()
    monkeypatch.setattr(yandex_tts, "synthesize_to_wav_bytes", ya)
    assert asyncio.run(tts.synthesize_from_config("private text", config)) == b""
    ya.assert_not_called()
    assert "soft-fail" in caplog.text
    assert "invalid-private-value" not in caplog.text
    assert "private text" not in caplog.text


def test_flat_yandex_key_does_not_authenticate_deepgram():
    config = cloud_config(provider="deepgram", api_key="yandex-key")
    assert not resolve_tts_runtime(config)["available"]
    assert any("DEEPGRAM_API_KEY" in e for e in collect_voice_soft_errors(config))


@pytest.mark.parametrize("failure", ["unauthorized", "empty"])
def test_actual_http_failure_logs_safe_reason_and_falls_back(monkeypatch, caplog, failure):
    private_text = "PRIVATE_REQUEST_TEXT"
    private_key = "PRIVATE_API_KEY"
    config = fallback_config(api_key=private_key)
    if failure == "unauthorized":
        response = httpx.Response(401, json={"err_code": "INVALID_AUTH", "message": private_text + private_key})
        reason = "HTTP 401 (err_code=INVALID_AUTH)"
    else:
        response = httpx.Response(200, content=b"")
        reason = "пустой ответ от API"
    transport = httpx.MockTransport(lambda request: response)
    monkeypatch.setattr(
        deepgram_tts, "synthesize_to_wav_bytes",
        partial(deepgram_tts.synthesize_to_wav_bytes, transport=transport),
    )
    yandex = AsyncMock(return_value=b"fallback")
    monkeypatch.setattr(yandex_tts, "synthesize_to_wav_bytes", yandex)
    assert asyncio.run(tts.synthesize_from_config(private_text, config)) == b"fallback"
    yandex.assert_awaited_once()
    assert reason in caplog.text
    assert private_text not in caplog.text
    assert private_key not in caplog.text


def test_deepgram_failure_without_fallback_soft_fails(monkeypatch, caplog):
    config = cloud_config(deepgram={"api_key": "test-deepgram"})
    monkeypatch.setattr(
        deepgram_tts, "synthesize_to_wav_bytes",
        AsyncMock(side_effect=RuntimeError("Deepgram TTS: network error")),
    )
    ya = AsyncMock()
    monkeypatch.setattr(yandex_tts, "synthesize_to_wav_bytes", ya)
    assert asyncio.run(tts.synthesize_from_config("test", config)) == b""
    ya.assert_not_called()
    assert "network error" in caplog.text
    assert "fallback" not in caplog.text
