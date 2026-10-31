"""Bounded push-to-talk service. No microphone capture or permanent audio on the server."""
from __future__ import annotations

import asyncio
import io
import re
import wave


class DesktopVoice:
    def __init__(self, config):
        self.config = config
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
        plain = re.sub(r'```.*?```', ' ', text, flags=re.S)
        plain = re.sub(r'\[([^]]+)\]\([^)]*\)', r'\1', plain)
        plain = re.sub(r'[*_`#]+', '', plain).strip()
        if not plain:
            return b''
        audio = await synthesize_from_config(plain[:1200], self.config)
        if len(audio) > 8 * 1024 * 1024:
            raise ValueError('audio_too_large')
        return audio
