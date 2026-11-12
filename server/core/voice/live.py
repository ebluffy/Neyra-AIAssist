"""Live voice reply: speak each finished sentence while the reply is still being written."""
from __future__ import annotations

import asyncio
import base64

from core.voice.sentences import SentenceSplitter

LIVE_PLAYBACK_WINDOW = 3
LIVE_SLOW_SECONDS = 4.0
LIVE_MAX_CHARS = 4000
CHUNK_BYTES = 48000


async def announce_conversion(send, status: str) -> None:
    """Tell the client when conversion did not run as configured. Never a silent swap."""
    state, _, code = status.partition(':')
    if state in ('passthrough', 'stopped'):
        await send(dict(type='voice.conversion', status=state, code=code))


class LiveSpeech:
    """Bounded sentence pipeline: splitter -> queue(3) -> TTS/conversion -> client window.

    ``playback['acked']`` is the last segment the client finished playing. The server
    keeps at most ``window`` unplayed segments on the client, so a slow speaker slows
    TTS, and a full queue slows reading the reply stream.
    """

    def __init__(self, voice, send, playback: dict, acked: asyncio.Event, *, window: int = LIVE_PLAYBACK_WINDOW,
                 max_chars: int = LIVE_MAX_CHARS, ack_timeout: float = 30.0, queue_size: int = 3):
        self.voice = voice
        self.send = send
        self.playback = playback
        self.acked = acked
        self.window = window
        self.max_chars = max_chars
        self.ack_timeout = ack_timeout
        self.splitter = SentenceSplitter()
        self.queue: asyncio.Queue = asyncio.Queue(maxsize=queue_size)
        self.task: asyncio.Task | None = None
        self.failure: str | None = None
        self.seq = 0
        self.chars = 0
        self.truncated = False
        self.started = False
        self.announced = False

    async def feed(self, text: str) -> None:
        self.started = True
        for sentence in self.splitter.feed(text):
            await self._enqueue(sentence)

    async def finish(self, has_response: bool) -> None:
        for sentence in self.splitter.flush():
            await self._enqueue(sentence)
        if self.task is None:
            if has_response:
                await self.send(dict(type='audio.done', mime='audio/wav', segments=0))
            else:
                await self.send(dict(type='error', code='empty_response'))
            return
        await self.queue.put(None)
        await self.task
        if self.failure:
            await self.send(dict(type='error', code=self.failure))
        else:
            await self.send(dict(type='audio.done', mime='audio/wav', segments=self.seq))

    async def close(self) -> None:
        if self.task and not self.task.done():
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)

    async def _enqueue(self, sentence: str) -> None:
        if self.failure or self.truncated:
            return
        if self.chars + len(sentence) > self.max_chars:
            self.truncated = True
            await self.send(dict(type='status', state='truncated'))
            return
        self.chars += len(sentence)
        if self.task is None:
            self.task = asyncio.create_task(self._speaker())
        await self.queue.put(sentence)

    async def _speaker(self) -> None:
        while True:
            sentence = await self.queue.get()
            if sentence is None:
                return
            if self.failure:
                continue
            try:
                spoken = await asyncio.wait_for(self.voice.speak(sentence), 60)
            except asyncio.CancelledError:
                raise
            except Exception:
                self.failure = 'tts_unavailable'
                continue
            if spoken.conversion != 'off' and spoken.conversion != 'applied' and not self.announced:
                self.announced = True
                await announce_conversion(self.send, spoken.conversion)
            if spoken.conversion.startswith('stopped:'):
                self.failure = 'conversion_failed'
                continue
            if not spoken.audio:
                self.failure = 'tts_unavailable'
                continue
            if not await self._wait_window():
                self.failure = 'playback_stalled'
                continue
            for offset in range(0, len(spoken.audio), CHUNK_BYTES):
                data = base64.b64encode(spoken.audio[offset:offset + CHUNK_BYTES]).decode()
                await self.send(dict(type='audio.chunk', seq=self.seq, data=data))
            await self.send(dict(type='audio.segment', seq=self.seq, mime='audio/wav'))
            self.seq += 1

    async def _wait_window(self) -> bool:
        while self.seq - self.playback['acked'] > self.window:
            self.acked.clear()
            if self.seq - self.playback['acked'] <= self.window:
                break
            try:
                await asyncio.wait_for(self.acked.wait(), self.ack_timeout)
            except asyncio.TimeoutError:
                return False
        return True
