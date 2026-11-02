"""Deepgram Flux batch TTS — Russian voice (flux-polina-ru).

API: https://developers.deepgram.com/docs/tts-rest
Model: flux-polina-ru (Russian), expressivity: int {-2,-1,0,1,2}.
Container=none (raw PCM 16-bit mono LE) + manual WAV header (Deepgram's container=wav has bogus length).
"""

from __future__ import annotations

import logging
import re
import struct
from typing import Any

import httpx

logger = logging.getLogger("neyra.deepgram_tts")

DEFAULT_MODEL = "flux-polina-ru"
DEFAULT_SAMPLE_RATE = 24000
DEFAULT_EXPRESSIVITY = 0


def _validate_expressivity(value: Any) -> int:
    """
    Deepgram expressivity must be an integer in {-2, -1, 0, 1, 2}.
    Invalid values → warning + return 0.
    """
    try:
        e = int(value)
        valid = not isinstance(value, bool) and float(value) == e and e in (-2, -1, 0, 1, 2)
    except (ValueError, TypeError, OverflowError):
        valid = False
    if not valid:
        logger.warning("Deepgram TTS: invalid expressivity; expected integer in {-2,-1,0,1,2}; using 0")
        return 0
    return e


def _build_wav_header(pcm_data: bytes, sample_rate: int) -> bytes:
    """
    Build correct WAV header for mono 16-bit PCM.
    Deepgram's container=wav returns a placeholder length — we build ours.
    """
    num_channels = 1
    bits_per_sample = 16
    byte_rate = sample_rate * num_channels * bits_per_sample // 8
    block_align = num_channels * bits_per_sample // 8
    data_size = len(pcm_data)
    # RIFF header
    header = b"RIFF"
    header += struct.pack("<I", 36 + data_size)  # file size - 8
    header += b"WAVE"
    # fmt chunk
    header += b"fmt "
    header += struct.pack("<I", 16)  # fmt chunk size
    header += struct.pack("<H", 1)  # audio format (PCM=1)
    header += struct.pack("<H", num_channels)
    header += struct.pack("<I", sample_rate)
    header += struct.pack("<I", byte_rate)
    header += struct.pack("<H", block_align)
    header += struct.pack("<H", bits_per_sample)
    # data chunk
    header += b"data"
    header += struct.pack("<I", data_size)
    return header + pcm_data


async def synthesize_to_wav_bytes(
    text: str,
    *,
    api_key: str,
    model: str = DEFAULT_MODEL,
    expressivity: int = DEFAULT_EXPRESSIVITY,
    sample_rate: int = DEFAULT_SAMPLE_RATE,
    timeout: float = 60.0,
    transport: httpx.AsyncBaseTransport | None = None,
) -> bytes:
    """
    Synthesize text via Deepgram Flux batch TTS (Russian voice).

    Returns WAV bytes (PCM 16-bit mono).

    Raises:
        ValueError: if api_key is missing or empty response from Deepgram.
        RuntimeError: on HTTP errors (status + Deepgram err_code if present).

    Never logs request text, response body, or the api_key.
    """
    api_key = api_key.strip()
    if not api_key:
        raise ValueError("DEEPGRAM_API_KEY is not set")

    # Validate expressivity as int
    expr_int = _validate_expressivity(expressivity)

    # Build URL with query params
    url = "https://api.deepgram.com/v2/speak"
    params = {"model": model, "expressivity": str(expr_int), "encoding": "linear16",
              "container": "none", "sample_rate": str(sample_rate)}

    headers = {
        "Authorization": f"Token {api_key}",
        "Content-Type": "application/json",
    }

    body = {"text": text}

    connect_timeout = min(10.0, timeout)
    timeout_config = httpx.Timeout(connect=connect_timeout, read=timeout, write=timeout, pool=timeout)

    try:
        async with httpx.AsyncClient(timeout=timeout_config, transport=transport) as client:
            resp = await client.post(url, params=params, headers=headers, json=body)

            if resp.status_code >= 400:
                # Parse Deepgram error code if present (truncated to 64 chars)
                err_code = ""
                try:
                    err_json = resp.json()
                    raw_code = err_json.get("err_code")
                    if isinstance(raw_code, str) and re.fullmatch(r"[A-Za-z0-9_-]+", raw_code):
                        err_code = raw_code[:64]
                except Exception:
                    pass

                # Safe error message: status + err_code only
                err_msg = f"Deepgram TTS HTTP {resp.status_code}"
                if err_code:
                    err_msg += f" (err_code={err_code})"
                raise RuntimeError(err_msg)

            pcm_data = resp.content

            # Empty response = failure (trigger fallback)
            if not pcm_data:
                raise ValueError("Deepgram TTS: пустой ответ от API")

            # Build correct WAV header
            return _build_wav_header(pcm_data, sample_rate)

    except httpx.TimeoutException:
        raise RuntimeError("Deepgram TTS: request timed out") from None
    except httpx.RequestError:
        # Network error — safe message without exposing request details
        raise RuntimeError("Deepgram TTS: network error") from None
