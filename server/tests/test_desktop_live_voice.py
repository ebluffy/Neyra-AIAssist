"""Live desktop voice: sentence TTS, barge-in, playback window, voice conversion policy."""
import asyncio
import base64
from uuid import uuid4

import pytest
from starlette.websockets import WebSocketDisconnect

from core.voice import conversion as conversion_module
from core.voice.conversion import ConversionError, ConversionSettings, VoiceConversion, model_path
from core.voice.desktop import DesktopVoice, Speech
from core.voice.live import LiveSpeech
from core.voice.sentences import SentenceSplitter, plain_text
from test_desktop_bridge import make_client, manifest

AUTH = {'Authorization': 'Bearer owner-a'}
REPLY = ['Привет! Это первая фраза ответа. ', 'А вот вторая фраза, ', 'она длиннее первой. ', 'И третья.']


class TokenAgent:
    memory_hub = None

    def __init__(self, tokens=REPLY):
        self.tokens = tokens
        self.turns = []

    async def chat_stream(self, text, **kwargs):
        self.turns.append(text)
        for token in self.tokens:
            yield {'type': 'token', 'text': token}
        yield {'type': 'done', 'text': ''.join(self.tokens), 'model_trace': {}}


def wav(tag: str) -> bytes:
    return b'RIFF' + tag.encode()


def connect_live(ws):
    ws.send_json(manifest().model_dump(mode='json'))
    hello = ws.receive_json()
    assert hello['protocol'] == 'neyra.voice.v2'
    assert hello['partial_transcripts'] is False and hello['streaming_stt'] is False
    return hello


def say(ws, request_id, pcm=b'\0\0' * 160):
    ws.send_json({'type': 'listen.begin', 'request_id': request_id})
    ws.send_bytes(pcm)
    ws.send_json({'type': 'commit', 'mode': 'live', 'request_id': request_id})


def receive_until(ws, kinds):
    seen = []
    while True:
        packet = ws.receive_json()
        seen.append(packet)
        if packet['type'] in kinds:
            return seen


# --- sentences ---------------------------------------------------------------

def test_splitter_streams_sentences_and_skips_code():
    s = SentenceSplitter(min_chars=10)
    out = []
    for token in ['Первая фраза готова. Вто', 'рая тоже! ```python\nprint("secret")\n', '``` Код не читаем. ', 'Хвост']:
        out += s.feed(token)
    out += s.flush()
    assert out == ['Первая фраза готова.', 'Вторая тоже!', 'Код не читаем.', 'Хвост']
    assert all('print' not in x for x in out)


def test_splitter_bounds_long_text_without_punctuation():
    s = SentenceSplitter(min_chars=10, max_chars=40)
    out = s.feed('слово ' * 30) + s.flush()
    assert len(out) > 2 and all(len(x) <= 40 for x in out)


def test_plain_text_drops_markdown_links_and_fences():
    assert plain_text('**Жирный** [сайт](https://x.y) ```code``` `x`') == 'Жирный сайт x'


# --- conversion --------------------------------------------------------------

def test_conversion_models_stay_in_server_models():
    # The existing RVC files are read in place; nothing renames or moves them.
    for name, suffix in [('whisper_girl_e257_s3598.pth', '.pth'), ('whisper_girl_e183_s2562.pth', '.pth'), ('whisper_girl.index', '.index')]:
        path = model_path(name, suffix)
        assert path.parent == conversion_module.MODELS_DIR.resolve()


@pytest.mark.parametrize('name', ['../config.example.yaml', 'sub/whisper_girl.pth', '.hidden.pth', 'model.bin', ''])
def test_conversion_model_name_is_a_plain_file_in_models(name):
    with pytest.raises(ConversionError) as exc:
        model_path(name, '.pth')
    assert exc.value.code == 'model_invalid'


def test_conversion_missing_model_is_reported():
    with pytest.raises(ConversionError) as exc:
        model_path('absent.pth', '.pth')
    assert exc.value.code == 'model_missing'


def test_conversion_unknown_policy_fails_closed():
    s = ConversionSettings.from_config({'voice': {'conversion': {'enabled': True, 'on_error': 'swap'}}})
    assert s.on_error == 'stop'
    assert ConversionSettings.from_config({}).enabled is False


class StubBackend:
    def __init__(self, fail=False):
        self.fail = fail
        self.calls = 0

    def convert(self, data):
        self.calls += 1
        if self.fail:
            raise RuntimeError('gpu fell over')
        return b'RIFF-converted'


def voice_with(policy, backend, monkeypatch):
    config = {'voice': {'conversion': {'enabled': True, 'model': 'whisper_girl_e257_s3598.pth', 'on_error': policy}}}
    service = DesktopVoice(config, VoiceConversion(config, lambda settings: backend))

    async def synthesize(self, text):
        return wav('tts')
    monkeypatch.setattr(DesktopVoice, 'synthesize', synthesize)
    return service


def test_conversion_applied_after_tts(monkeypatch):
    backend = StubBackend()
    speech = asyncio.run(voice_with('stop', backend, monkeypatch).speak('Привет'))
    assert speech == Speech(b'RIFF-converted', 'applied') and backend.calls == 1


def test_conversion_passthrough_keeps_original_and_says_so(monkeypatch):
    speech = asyncio.run(voice_with('passthrough', StubBackend(fail=True), monkeypatch).speak('Привет'))
    assert speech.audio == wav('tts') and speech.conversion == 'passthrough:convert_failed'


def test_conversion_stop_policy_returns_no_audio(monkeypatch):
    speech = asyncio.run(voice_with('stop', StubBackend(fail=True), monkeypatch).speak('Привет'))
    assert speech.audio == b'' and speech.conversion == 'stopped:convert_failed'


def test_conversion_rejects_non_wav_output(monkeypatch):
    class Garbage(StubBackend):
        def convert(self, data):
            return b'not-a-wav'
    speech = asyncio.run(voice_with('stop', Garbage(), monkeypatch).speak('Привет'))
    assert speech.conversion == 'stopped:bad_output'


def test_conversion_without_backend_package_is_explicit(monkeypatch):
    import builtins
    real_import = builtins.__import__

    def blocked(name, *args, **kwargs):
        if name.startswith('rvc_python'):
            raise ImportError(name)
        return real_import(name, *args, **kwargs)
    monkeypatch.setattr(builtins, '__import__', blocked)
    config = {'voice': {'conversion': {'enabled': True, 'model': 'whisper_girl_e257_s3598.pth'}}}
    with pytest.raises(ConversionError) as exc:
        asyncio.run(VoiceConversion(config).convert(wav('tts')))
    assert exc.value.code == 'backend_unavailable'


# --- live websocket ----------------------------------------------------------

def stub_voice(monkeypatch, transcribe_delay=0.0, speak=None):
    async def transcribe(self, pcm):
        await asyncio.sleep(transcribe_delay)
        return 'как дела'

    async def default_speak(self, text):
        return Speech(wav(text[:12]))
    monkeypatch.setattr(DesktopVoice, 'transcribe', transcribe)
    monkeypatch.setattr(DesktopVoice, 'speak', speak or default_speak)


def test_live_turn_speaks_each_sentence_in_order(monkeypatch):
    stub_voice(monkeypatch)
    client, agent = make_client(TokenAgent())
    rid = str(uuid4())
    with client, client.websocket_connect('/v1/desktop/voice', headers=AUTH) as ws:
        connect_live(ws)
        say(ws, rid)
        packets = []
        while True:
            packet = ws.receive_json()
            packets.append(packet)
            if packet['type'] == 'audio.segment':
                ws.send_json({'type': 'audio.ack', 'request_id': rid, 'seq': packet['seq']})
            if packet['type'] in ('audio.done', 'error'):
                break
    kinds = [p['type'] for p in packets]
    assert kinds[:2] == ['transcript.final', 'status']
    assert all(p['request_id'] == rid for p in packets)
    segments = [p['seq'] for p in packets if p['type'] == 'audio.segment']
    assert segments == list(range(len(segments))) and len(segments) >= 2
    # The first sentence is spoken before the reply is finished.
    assert kinds.index('audio.segment') < kinds.index('done')
    assert packets[-1] == {'type': 'audio.done', 'mime': 'audio/wav', 'segments': len(segments), 'request_id': rid}
    first_audio = next(p for p in packets if p['type'] == 'audio.chunk')
    assert base64.b64decode(first_audio['data']).startswith(b'RIFF')
    assert agent.turns == ['как дела']


def test_live_barge_in_cancels_old_turn_and_drops_its_late_packets(monkeypatch):
    stub_voice(monkeypatch, transcribe_delay=0.3)
    client, agent = make_client(TokenAgent(['Короткий ответ на вопрос.']))
    old, new = str(uuid4()), str(uuid4())
    with client, client.websocket_connect('/v1/desktop/voice', headers=AUTH) as ws:
        connect_live(ws)
        say(ws, old)
        ws.send_json({'type': 'listen.begin', 'request_id': new})
        cancelled = ws.receive_json()
        assert cancelled == {'type': 'cancelled', 'request_id': old, 'reason': 'barge_in'}
        ws.send_bytes(b'\0\0' * 160)
        ws.send_json({'type': 'commit', 'mode': 'live', 'request_id': new})
        packets = receive_until(ws, {'audio.segment'})
        ws.send_json({'type': 'audio.ack', 'request_id': new, 'seq': 0})
        packets += receive_until(ws, {'audio.done'})
    assert all(p['request_id'] == new for p in packets)
    assert agent.turns == ['как дела']


def test_live_commit_needs_open_utterance():
    client, _ = make_client(TokenAgent())
    with client, client.websocket_connect('/v1/desktop/voice', headers=AUTH) as ws:
        connect_live(ws)
        ws.send_bytes(b'\0\0')
        ws.send_json({'type': 'commit', 'mode': 'live', 'request_id': str(uuid4())})
        with pytest.raises(WebSocketDisconnect) as exc:
            ws.receive_json()
        assert exc.value.code == 1008


def test_live_listen_cancel_discards_false_start(monkeypatch):
    heard = []

    async def transcribe(self, pcm):
        heard.append(pcm)
        return 'да'
    monkeypatch.setattr(DesktopVoice, 'transcribe', transcribe)
    stub_voice_speak = Speech(wav('x'))

    async def speak(self, text):
        return stub_voice_speak
    monkeypatch.setattr(DesktopVoice, 'speak', speak)
    client, _ = make_client(TokenAgent(['Да.']))
    first, second = str(uuid4()), str(uuid4())
    with client, client.websocket_connect('/v1/desktop/voice', headers=AUTH) as ws:
        connect_live(ws)
        ws.send_json({'type': 'listen.begin', 'request_id': first})
        ws.send_bytes(b'\1\1' * 50)
        ws.send_json({'type': 'listen.cancel', 'request_id': first})
        say(ws, second, b'\2\2' * 20)
        receive_until(ws, {'audio.done', 'error'})
    assert heard == [b'\2\2' * 20]


@pytest.mark.parametrize('seq', [-1, 'one', True])
def test_audio_ack_must_be_a_segment_number(seq):
    client, _ = make_client(TokenAgent())
    with client, client.websocket_connect('/v1/desktop/voice', headers=AUTH) as ws:
        connect_live(ws)
        ws.send_json({'type': 'audio.ack', 'request_id': str(uuid4()), 'seq': seq})
        with pytest.raises(WebSocketDisconnect):
            ws.receive_json()


def test_live_conversion_stop_ends_speech_with_explicit_error(monkeypatch):
    async def speak(self, text):
        return Speech(b'', 'stopped:timeout')
    stub_voice(monkeypatch, speak=speak)
    client, _ = make_client(TokenAgent())
    rid = str(uuid4())
    with client, client.websocket_connect('/v1/desktop/voice', headers=AUTH) as ws:
        connect_live(ws)
        say(ws, rid)
        packets = receive_until(ws, {'error', 'audio.done'})
    kinds = [p['type'] for p in packets]
    assert 'audio.chunk' not in kinds
    assert {'type': 'voice.conversion', 'status': 'stopped', 'code': 'timeout', 'request_id': rid} in packets
    assert packets[-1]['code'] == 'conversion_failed'


def test_ptt_conversion_passthrough_is_announced_before_audio(monkeypatch):
    async def speak(self, text):
        return Speech(wav('orig'), 'passthrough:backend_unavailable')
    stub_voice(monkeypatch, speak=speak)
    client, _ = make_client(TokenAgent(['Привет.']))
    with client, client.websocket_connect('/v1/desktop/voice', headers=AUTH) as ws:
        connect_live(ws)
        ws.send_bytes(b'\0\0'); ws.send_json({'type': 'commit'})
        packets = receive_until(ws, {'audio.done', 'error'})
    kinds = [p['type'] for p in packets]
    assert kinds.index('voice.conversion') < kinds.index('audio.chunk')
    assert packets[-1]['type'] == 'audio.done'


def test_ptt_conversion_stop_is_terminal_without_audio(monkeypatch):
    async def speak(self, text):
        return Speech(b'', 'stopped:convert_failed')
    stub_voice(monkeypatch, speak=speak)
    client, _ = make_client(TokenAgent(['Привет.']))
    with client, client.websocket_connect('/v1/desktop/voice', headers=AUTH) as ws:
        connect_live(ws)
        ws.send_bytes(b'\0\0'); ws.send_json({'type': 'commit'})
        packets = receive_until(ws, {'audio.done', 'error'})
    assert packets[-1]['code'] == 'conversion_failed'
    assert 'audio.chunk' not in [p['type'] for p in packets]


def test_ptt_frames_during_turn_still_close(monkeypatch):
    stub_voice(monkeypatch, transcribe_delay=1.0)
    client, _ = make_client(TokenAgent())
    with client, client.websocket_connect('/v1/desktop/voice', headers=AUTH) as ws:
        connect_live(ws)
        ws.send_bytes(b'\0\0'); ws.send_json({'type': 'commit'})
        ws.send_bytes(b'\0\0')
        with pytest.raises(WebSocketDisconnect):
            ws.receive_json()


# --- playback window ---------------------------------------------------------

class Recorder:
    def __init__(self):
        self.packets = []

    async def __call__(self, packet):
        self.packets.append(packet)


class FixedVoice:
    async def speak(self, text):
        return Speech(wav(text))


def test_window_waits_for_client_playback_then_stalls():
    async def scenario():
        send = Recorder()
        playback = dict(acked=-1)
        speech = LiveSpeech(FixedVoice(), send, playback, asyncio.Event(), window=1, ack_timeout=0.2)
        speech.splitter.min_chars = 1
        await speech.feed('Раз. Два. Три. ')
        await speech.finish(True)
        return send.packets
    packets = asyncio.run(scenario())
    # Window 1: one unplayed segment on the client; the next waits for an ack that never comes.
    assert [p['seq'] for p in packets if p['type'] == 'audio.segment'] == [0]
    assert packets[-1] == {'type': 'error', 'code': 'playback_stalled'}


def test_window_moves_when_client_acks():
    async def scenario():
        send = Recorder()
        playback = dict(acked=-1)
        event = asyncio.Event()
        speech = LiveSpeech(FixedVoice(), send, playback, event, window=1, ack_timeout=2)
        speech.splitter.min_chars = 1

        async def client_plays():
            while True:
                await asyncio.sleep(0.01)
                done = [p['seq'] for p in send.packets if p['type'] == 'audio.segment']
                if done and done[-1] > playback['acked']:
                    playback['acked'] = done[-1]
                    event.set()
        player = asyncio.create_task(client_plays())
        await speech.feed('Раз. Два. Три. ')
        await speech.finish(True)
        player.cancel()
        return send.packets
    packets = asyncio.run(scenario())
    assert [p['seq'] for p in packets if p['type'] == 'audio.segment'] == [0, 1, 2]
    assert packets[-1]['type'] == 'audio.done'


def test_live_speech_caps_spoken_text():
    async def scenario():
        send = Recorder()
        speech = LiveSpeech(FixedVoice(), send, dict(acked=10**6), asyncio.Event(), max_chars=30)
        speech.splitter.min_chars = 1
        await speech.feed('Первая фраза тут. Вторая фраза уже не влезет. ')
        await speech.finish(True)
        return send.packets
    packets = asyncio.run(scenario())
    assert {'type': 'status', 'state': 'truncated'} in packets
    assert [p['seq'] for p in packets if p['type'] == 'audio.segment'] == [0]
