"""TTS dispatcher with provider selection and automatic fallback.

Routes to Deepgram or Yandex based on voice.tts.cloud.provider config.
Falls back to Yandex if Deepgram fails or API key is missing.
"""

from __future__ import annotations

import logging
from typing import Any

from core.voice.config import (
    resolve_tts_providers,
    resolve_tts_runtime,
    tts_api_key,
    tts_folder_id,
)

# Re-export for backward compat
from core.voice.yandex_tts import synthesize_to_wav_bytes

logger = logging.getLogger("neyra.tts")

__all__ = ["synthesize_to_wav_bytes", "synthesize_from_config"]


async def synthesize_from_config(text: str, config: dict[str, Any]) -> bytes:
    """
    TTS via ``voice.tts`` modality with provider selection and fallback.

    Primary: deepgram (if provider="deepgram" and key is set) or yandex.
    Fallback: tries yandex if deepgram fails or key is missing.

    Soft-fail: empty bytes + diagnostic log, never crashes core.
    """
    rt = resolve_tts_runtime(config)
    if not rt.get("available"):
        for e in rt.get("soft_errors") or []:
            logger.error("TTS недоступен (soft): %s — озвучка пропущена, ядро живо", e)
        return b""

    lane = rt.get("primary_lane")
    block = dict(rt.get("tts") or {})
    if lane == "local":
        logger.error(
            "TTS(local): провайдер ещё не подключён (Stage 4) — озвучка пропущена, ядро живо"
        )
        return b""

    providers = resolve_tts_providers(config)
    for index, provider in enumerate(providers):
        if provider == "deepgram":
            result = await _try_deepgram(text, block)
        else:
            result = await _try_yandex(text, block)
        if result:
            return result
        if index + 1 < len(providers):
            logger.warning("TTS(%s): fallback на %s", provider, providers[index + 1])
    return b""


async def _try_deepgram(text: str, block: dict[str, Any]) -> bytes | None:
    """Try Deepgram TTS. Returns None if key missing or error occurs."""
    from core.voice import deepgram_tts

    try:
        dg_block = dict(block.get("deepgram") or {})
        sample_rate = int(dg_block.get("sample_rate", 24000))
        timeout = float(dg_block.get("timeout_seconds", 60.0))
    except (TypeError, ValueError, OverflowError) as exc:
        logger.warning("TTS(Deepgram): invalid numeric settings (%s)", type(exc).__name__)
        return None

    try:
        result = await deepgram_tts.synthesize_to_wav_bytes(
            text,
            api_key=tts_api_key(block, "deepgram"),
            model=str(dg_block.get("model") or "flux-polina-ru"),
            expressivity=deepgram_tts._validate_expressivity(dg_block.get("expressivity", 0)),
            sample_rate=sample_rate,
            timeout=timeout,
        )
        return result or None
    except (RuntimeError, ValueError) as exc:
        # Deepgram sanitizes these errors before exposing them to callers.
        logger.warning("TTS(Deepgram) failed: %s", exc)
        return None
    except Exception as exc:
        logger.warning("TTS(Deepgram) failed: %s", type(exc).__name__)
        return None


async def _try_yandex(text: str, block: dict[str, Any]) -> bytes | None:
    """Try Yandex TTS. Returns None if key missing or error occurs."""
    from core.voice import yandex_tts

    try:
        ya_block = dict(block.get("yandex") or {})
        return await yandex_tts.synthesize_to_wav_bytes(
            text,
            api_key=tts_api_key(block, "yandex"),
            folder_id=tts_folder_id(block),
            voice=str(ya_block.get("voice") or block.get("voice") or "masha"),
            role=str(ya_block.get("role") or block.get("role") or "friendly"),
            speed=float(ya_block.get("speed", block.get("speed", 1.15))),
            pitch_shift_hz=float(ya_block.get("pitch_shift_hz", block.get("pitch_shift_hz", 150.0))),
            endpoint=str(ya_block.get("endpoint") or block.get("endpoint") or yandex_tts.DEFAULT_ENDPOINT),
            timeout=float(ya_block.get("timeout_seconds") or block.get("timeout_seconds", 60.0)),
        )
    except Exception as exc:
        logger.error("TTS(Yandex) soft-fail (%s) — ядро продолжает работу", type(exc).__name__)
        return None
