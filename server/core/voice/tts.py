"""TTS dispatcher with provider selection and automatic fallback.

Routes to Deepgram or Yandex based on voice.tts.cloud.provider config.
Falls back to Yandex if Deepgram fails or API key is missing.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger("neyra.tts")

# Re-export for backward compat
from core.voice.yandex_tts import synthesize_to_wav_bytes

__all__ = ["synthesize_to_wav_bytes", "synthesize_from_config"]


async def synthesize_from_config(text: str, config: dict[str, Any]) -> bytes:
    """
    TTS via ``voice.tts`` modality with provider selection and fallback.
    
    Primary: deepgram (if provider="deepgram" and key is set) or yandex.
    Fallback: tries yandex if deepgram fails or key is missing.
    
    Soft-fail: empty bytes + ERROR log, never crashes core.
    """
    from core.voice.config import resolve_tts_runtime

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

    provider = str(block.get("provider") or "deepgram").strip().lower()
    
    # Try primary provider
    if provider == "deepgram":
        result = await _try_deepgram(text, config, block)
        if result is not None:
            return result
        # Deepgram failed or key missing, try fallback to yandex
        logger.warning("TTS(deepgram): недоступен или ошибка — fallback на yandex")
        return await _try_yandex(text, config, block) or b""
    
    elif provider == "yandex":
        result = await _try_yandex(text, config, block)
        if result is not None:
            return result
        return b""
    
    else:
        logger.error(
            "TTS(cloud): неизвестный provider=%r — озвучка пропущена, ядро живо",
            provider,
        )
        return b""


async def _try_deepgram(text: str, config: dict[str, Any], block: dict[str, Any]) -> bytes | None:
    """Try Deepgram TTS. Returns None if key missing or error occurs."""
    import os
    from core.voice import deepgram_tts
    
    dg_block = dict(block.get("deepgram") or {})
    api_key = str(dg_block.get("api_key") or "").strip() or (
        os.environ.get("DEEPGRAM_API_KEY") or ""
    ).strip()
    
    if not api_key:
        logger.error(
            "TTS(Deepgram): нет DEEPGRAM_API_KEY — озвучка пропущена, "
            "задайте DEEPGRAM_API_KEY в .env или voice.tts.cloud.deepgram"
        )
        return None
    
    expressivity = deepgram_tts._validate_expressivity(dg_block.get("expressivity", 0))

    try:
        result = await deepgram_tts.synthesize_to_wav_bytes(
            text,
            api_key=api_key,
            model=str(dg_block.get("model") or "flux-polina-ru"),
            expressivity=expressivity,
            sample_rate=int(dg_block.get("sample_rate", 24000)),
            timeout=float(dg_block.get("timeout_seconds", 60.0)),
        )
        return result or None
    except Exception:
        logger.warning("TTS(Deepgram) failed; trying configured fallback")
        return None


async def _try_yandex(text: str, config: dict[str, Any], block: dict[str, Any]) -> bytes | None:
    """Try Yandex TTS. Returns None if key missing or error occurs."""
    import os
    from core.voice import yandex_tts
    
    ya_block = dict(block.get("yandex") or {})
    # Also try legacy top-level keys for backward compat
    api_key = str(ya_block.get("api_key") or block.get("api_key") or "").strip() or (
        os.environ.get("YANDEX_API_KEY") or ""
    ).strip()
    folder_id = str(ya_block.get("folder_id") or block.get("folder_id") or "").strip() or (
        os.environ.get("YANDEX_FOLDER_ID") or os.environ.get("YANDEX_ID_KEY") or ""
    ).strip()
    
    if not api_key or not folder_id:
        logger.error(
            "TTS(Yandex): нет api_key/folder_id — озвучка пропущена, "
            "задайте YANDEX_* в .env или voice.tts.cloud.yandex"
        )
        return None
    
    try:
        return await yandex_tts.synthesize_to_wav_bytes(
            text,
            api_key=api_key,
            folder_id=folder_id,
            voice=str(ya_block.get("voice") or block.get("voice") or "masha"),
            role=str(ya_block.get("role") or block.get("role") or "friendly"),
            speed=float(ya_block.get("speed", block.get("speed", 1.15))),
            pitch_shift_hz=float(ya_block.get("pitch_shift_hz", block.get("pitch_shift_hz", 150.0))),
            endpoint=str(ya_block.get("endpoint") or block.get("endpoint") or yandex_tts.DEFAULT_ENDPOINT),
            timeout=float(ya_block.get("timeout_seconds") or block.get("timeout_seconds", 60.0)),
        )
    except Exception:
        logger.error("TTS(Yandex) soft-fail — ядро продолжает работу")
        return None
