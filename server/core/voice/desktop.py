"""Bounded desktop voice service. No microphone capture or permanent audio on the server."""
from __future__ import annotations

import asyncio
import io
import wave
from dataclasses import dataclass

from core.voice.conversion import ConversionError, VoiceConversion
from core.voice.sentences import plain_text


@dataclass(frozen=True)
class Speech:
    """TTS result. ``conversion`` is off | applied | passthrough:<code> | stopped:<code>."""
    audio: bytes
    conversion: str = 'off'


class DesktopVoice:
    def __init__(self, config, conversion: VoiceConversion | None = None):
        self.config = config
        self.conversion = conversion or VoiceConversion(config)
        self._stt = None
        self._lock = asyncio.Lock()
        self._inflight: asyncio.Future | None = None

    async def transcribe(self, pcm: bytes) -> str:
        if not pcm or len(pcm) % 2 or len(pcm) > 16000 * 2 * 30:
            raise ValueError('invalid_audio')

        def run():
            from core.voice.stt import STTEngine
            if self._stt is None:
                self._stt = STTEngine(self.config)
            with io.BytesIO() as buffer:
                with wave.open(buffer, 'wb') as wav:
                    wav.setnchannels(1)
                    wav.setsampwidth(2)
                    wav.setframerate(16000)
                    wav.writeframes(pcm)
                return self._stt.transcribe_bytes(buffer.getvalue(), suffix='.wav')

        # Queue concurrent commits (multi-PC): wait for a cancelled-but-still-running
        # provider job before starting the next, instead of a global busy reject.
        async with self._lock:
            if self._inflight is not None and not self._inflight.done():
                try:
                    await asyncio.shield(self._inflight)
                except Exception:
                    pass
            job = asyncio.get_running_loop().run_in_executor(None, run)
            self._inflight = job

            def released(_):
                if self._inflight is job:
                    self._inflight = None

            job.add_done_callback(released)
            # Cancelling the turn discards its result; a synchronous provider must finish before reuse.
            return await asyncio.shield(job)

    async def synthesize(self, text: str) -> bytes:
        from core.voice.yandex_tts import synthesize_from_config
        plain = plain_text(text)
        if not plain:
            return b''
        audio = await synthesize_from_config(plain[:1200], self.config)
        if len(audio) > 8 * 1024 * 1024:
            raise ValueError('audio_too_large')
        return audio

    async def speak(self, text: str) -> Speech:
        """TTS, then optional conversion with the configured error policy."""
        audio = await self.synthesize(text)
        if not audio or not self.conversion.settings.enabled:
            return Speech(audio)
        try:
            return Speech(await self.conversion.convert(audio), 'applied')
        except ConversionError as exc:
            if self.conversion.settings.on_error == 'passthrough':
                return Speech(audio, 'passthrough:' + exc.code)
            return Speech(b'', 'stopped:' + exc.code)
