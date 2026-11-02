"""Deepgram Flux — TTS batch REST API (Russian voice flux-polina-ru).

Documentation: https://developers.deepgram.com/docs/tts-models
"""

from __future__ import annotations

import logging
import struct
from typing import Any

import httpx

logger = logging.getLogger("neyra.deepgram_tts")

DEFAULT_ENDPOINT = "https://api.deepgram.com/v2/speak"
DEFAULT_MODEL = "flux-polina-ru"
DEFAULT_EXPRESSIVITY = 0
DEFAULT_SAMPLE_RATE = 24000


def _build_wav_header(pcm_data: bytes, sample_rate: int) -> bytes:
    """Build a correct WAV header for raw PCM 16-bit mono data."""
    num_channels = 1
    bits_per_sample = 16
    byte_rate = sample_rate * num_channels * (bits_per_sample // 8)
    block_align = num_channels * (bits_per_sample // 8)
    data_size = len(pcm_data)
    file_size = 36 + data_size

    header = b"RIFF"
    header += struct.pack("<I", file_size)
    header += b"WAVE"
    header += b"fmt "
    header += struct.pack("<I", 16)  # fmt chunk size
    header += struct.pack("<H", 1)   # audio format (PCM)
    header += struct.pack("<H", num_channels)
    header += struct.pack("<I", sample_rate)
    header += struct.pack("<I", byte_rate)
    header += struct.pack("<H", block_align)
    header += struct.pack("<H", bits_per_sample)
    header += b"data"
    header += struct.pack("<I", data_size)
    
    return header


async def synthesize_to_wav_bytes(
    text: str,
    *,
    api_key: str,
    model: str = DEFAULT_MODEL,
    expressivity: int = DEFAULT_EXPRESSIVITY,
    sample_rate: int = DEFAULT_SAMPLE_RATE,
    endpoint: str = DEFAULT_ENDPOINT,
    timeout: float = 60.0,
    transport = None,  # For testing: optional httpx transport override
) -> bytes:
    """
    Synthesize text to WAV using Deepgram Flux batch REST API.
    
    Args:
        text: Text to synthesize
        api_key: Deepgram API key
        model: TTS model (default: flux-polina-ru)
        expressivity: Expressivity level 0-2 (default: 0)
        sample_rate: Sample rate in Hz (default: 24000)
        endpoint: API endpoint (default: https://api.deepgram.com/v2/speak)
        timeout: Request timeout in seconds (default: 60.0)
        
    Returns:
        WAV audio bytes with correct header
        
    Raises:
        ValueError: If API key is empty
        RuntimeError: If HTTP request fails
    """
    if not api_key.strip():
        raise ValueError("Deepgram TTS: пустой api_key")

    # Build query parameters
    params = {
        "model": model,
        "expressivity": str(expressivity),
        "encoding": "linear16",
        "container": "none",
        "sample_rate": str(sample_rate),
    }

    headers = {
        "Authorization": f"Token {api_key.strip()}",
        "Content-Type": "application/json",
    }

    body = {"text": text}

    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(timeout, connect=10.0, read=timeout),
            transport=transport,
        ) as client:
            resp = await client.post(
                endpoint.strip(),
                headers=headers,
                params=params,
                json=body,
            )

            if resp.status_code >= 400:
                # Parse error code if available (don't log full response or request text)
                err_code = "unknown"
                try:
                    err_json = resp.json()
                    err_code = err_json.get("err_code", err_json.get("code", "unknown"))
                except Exception:
                    pass
                raise RuntimeError(
                    f"Deepgram TTS HTTP {resp.status_code}: err_code={err_code}"
                )

            pcm_data = resp.content
            if not pcm_data:
                logger.error("Deepgram TTS: пустой ответ от API")
                return b""

            # Build correct WAV header (Deepgram's container=wav has bogus placeholder length)
            wav_header = _build_wav_header(pcm_data, sample_rate)
            return wav_header + pcm_data

    except httpx.TimeoutException as e:
        raise RuntimeError(f"Deepgram TTS: timeout after {timeout}s") from e
    except httpx.RequestError as e:
        raise RuntimeError(f"Deepgram TTS: network error: {type(e).__name__}") from e


async def synthesize_from_config(text: str, config: dict[str, Any]) -> bytes:
    """
    TTS via ``voice.tts`` modality. Soft-fail: empty bytes + ERROR log, never crashes core.
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

    provider = str(block.get("provider") or "").strip().lower()
    if provider != "deepgram":
        logger.error(
            "TTS(cloud): неизвестный/пустой provider=%r — озвучка пропущена, ядро живо",
            provider,
        )
        return b""

    import os

    api_key = str(block.get("api_key") or "").strip() or (
        os.environ.get("DEEPGRAM_API_KEY") or ""
    ).strip()
    
    if not api_key:
        logger.error(
            "TTS(Deepgram): DEEPGRAM_API_KEY is not set — озвучка пропущена, "
            "задайте DEEPGRAM_API_KEY в .env или voice.tts.cloud"
        )
        return b""

    # Get Deepgram-specific settings
    deepgram_block = dict(block.get("deepgram") or {})
    
    try:
        return await synthesize_to_wav_bytes(
            text,
            api_key=api_key,
            model=str(deepgram_block.get("model") or block.get("model") or DEFAULT_MODEL),
            expressivity=int(deepgram_block.get("expressivity", block.get("expressivity", DEFAULT_EXPRESSIVITY))),
            sample_rate=int(deepgram_block.get("sample_rate", block.get("sample_rate", DEFAULT_SAMPLE_RATE))),
            endpoint=str(deepgram_block.get("endpoint") or block.get("endpoint") or DEFAULT_ENDPOINT),
            timeout=float(block.get("timeout_seconds", 60.0)),
        )
    except Exception as e:
        logger.error("TTS(Deepgram) soft-fail: %s — ядро продолжает работу", e)
        return b""
