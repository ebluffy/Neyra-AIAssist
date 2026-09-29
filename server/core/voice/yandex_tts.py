"""Yandex Cloud SpeechKit — TTS API v3 (utteranceSynthesis).

Документация: https://aistudio.yandex.ru/docs/ru/speechkit/quickstart/tts-quickstart-v3.html
REST: https://aistudio.yandex.ru/docs/ru/speechkit/tts/api/tts-v3-rest.html
"""

from __future__ import annotations

import base64
import json
import logging
from typing import Any, Iterator

import httpx

logger = logging.getLogger("neyra.yandex_tts")

DEFAULT_ENDPOINT = "https://tts.api.cloud.yandex.net/tts/v3/utteranceSynthesis"


def _iter_audio_b64_chunks(obj: Any) -> Iterator[str]:
    if isinstance(obj, dict):
        ac = obj.get("audioChunk") or obj.get("audio_chunk")
        if isinstance(ac, dict):
            d = ac.get("data")
            if isinstance(d, str) and d:
                yield d
        for v in obj.values():
            yield from _iter_audio_b64_chunks(v)
    elif isinstance(obj, list):
        for it in obj:
            yield from _iter_audio_b64_chunks(it)


def _decode_response_body(raw: bytes, content_type: str) -> bytes:
    """Собирает WAV/PCM из JSON или NDJSON с полями audioChunk.data (base64)."""
    ct = (content_type or "").lower()
    audio_parts: list[bytes] = []

    if "ndjson" in ct or "x-ndjson" in ct:
        for line in raw.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            for b64 in _iter_audio_b64_chunks(obj):
                try:
                    audio_parts.append(base64.b64decode(b64))
                except Exception:
                    continue
        return b"".join(audio_parts)

    try:
        obj = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        logger.error("Yandex TTS: не удалось разобрать JSON ответ: %s", e)
        return b""

    for b64 in _iter_audio_b64_chunks(obj):
        try:
            audio_parts.append(base64.b64decode(b64))
        except Exception:
            continue
    return b"".join(audio_parts)


async def synthesize_to_wav_bytes(
    text: str,
    *,
    api_key: str,
    folder_id: str,
    voice: str = "masha",
    role: str = "friendly",
    speed: float = 1.15,
    pitch_shift_hz: float = 150.0,
    endpoint: str = DEFAULT_ENDPOINT,
    timeout: float = 60.0,
) -> bytes:
    if not api_key.strip():
        raise ValueError("Yandex TTS: пустой api_key")
    if not folder_id.strip():
        raise ValueError("Yandex TTS: пустой folder_id (каталог Yandex Cloud)")

    hints: list[dict[str, Any]] = [
        {"voice": voice},
        {"role": role},
        {"speed": float(speed)},
        {"pitchShift": float(pitch_shift_hz)},
    ]
    body: dict[str, Any] = {
        "text": text,
        "hints": hints,
        "outputAudioSpec": {
            "containerAudio": {"containerAudioType": "WAV"},
        },
    }

    headers = {
        "Authorization": f"Api-Key {api_key.strip()}",
        "x-folder-id": folder_id.strip(),
        "Content-Type": "application/json",
        "Accept": "application/json",
    }

    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(endpoint.strip(), headers=headers, json=body)
        if resp.status_code >= 400:
            raise RuntimeError(f"Yandex TTS HTTP {resp.status_code}: {resp.text[:500]}")
        raw = resp.content
        ct = resp.headers.get("content-type", "")
        audio = _decode_response_body(raw, ct)
        if not audio:
            logger.error("Yandex TTS: в ответе нет audioChunk (первые 200 символов): %r", raw[:200])
        return audio


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
    if provider != "yandex":
        logger.error(
            "TTS(cloud): неизвестный/пустой provider=%r — озвучка пропущена, ядро живо",
            provider,
        )
        return b""

    import os

    api_key = str(block.get("api_key") or "").strip() or (
        os.environ.get("YANDEX_API_KEY") or ""
    ).strip()
    folder_id = str(block.get("folder_id") or "").strip() or (
        os.environ.get("YANDEX_FOLDER_ID") or os.environ.get("YANDEX_ID_KEY") or ""
    ).strip()
    if not api_key or not folder_id:
        logger.error(
            "TTS(Yandex): нет api_key/folder_id — озвучка пропущена, "
            "задайте YANDEX_* в .env или voice.tts.cloud"
        )
        return b""

    try:
        return await synthesize_to_wav_bytes(
            text,
            api_key=api_key,
            folder_id=folder_id,
            voice=str(block.get("voice") or "masha"),
            role=str(block.get("role") or "friendly"),
            speed=float(block.get("speed", 1.15)),
            pitch_shift_hz=float(block.get("pitch_shift_hz", 150.0)),
            endpoint=str(block.get("endpoint") or DEFAULT_ENDPOINT),
            timeout=float(block.get("timeout_seconds", 60.0)),
        )
    except Exception as e:
        logger.error("TTS(Yandex) soft-fail: %s — ядро продолжает работу", e)
        return b""
