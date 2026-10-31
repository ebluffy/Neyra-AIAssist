import asyncio
import uuid

import pytest

from core.desktop.bridge import BridgeRegistry, Manifest


def manifest(device=None, tools=None):
    return Manifest(device_id=device or str(uuid.uuid4()), session_id=str(uuid.uuid4()),
                    name='Test PC', platform='linux-wayland', tools=tools or ['client.open_url'])


def test_manifest_rejects_future_tools():
    with pytest.raises(ValueError):
        manifest(tools=['client.shell_exec'])


def test_route_never_falls_back_to_other_owner_or_device():
    async def scenario():
        registry = BridgeRegistry()
        packets = []
        async def send(packet):
            packets.append(packet)
        m = manifest()
        connection = registry.connect('owner-a', m, send)
        with pytest.raises(PermissionError):
            await registry.call('owner-b', m.session_id, m.device_id, 'client.open_url', {'url': 'https://example.com'})
        task = asyncio.create_task(registry.call('owner-a', m.session_id, m.device_id, 'client.open_url', {'url': 'https://example.com'}))
        await asyncio.sleep(0)
        assert len(packets) == 1
        packet = packets[0]
        assert not registry.result('owner-b', connection, packet['call_id'], {'status': 'ok'})
        assert registry.result('owner-a', connection, packet['call_id'], {'status': 'ok'})
        assert (await task)['status'] == 'ok'
        assert not registry.result('owner-a', connection, packet['call_id'], {'status': 'ok'})
    asyncio.run(scenario())


def test_disconnect_and_revocation_cancel_waiters():
    async def scenario():
        registry = BridgeRegistry()
        async def send(packet):
            pass
        m = manifest()
        connection = registry.connect('owner', m, send)
        task = asyncio.create_task(registry.call('owner', m.session_id, m.device_id, 'client.open_url', {'url': 'https://example.com'}))
        await asyncio.sleep(0)
        registry.disconnect(connection)
        with pytest.raises(ConnectionError):
            await task
        assert registry.devices('owner') == []
    asyncio.run(scenario())

from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect
from core.desktop.routes import router_for
from core.desktop.bridge import ACTIVE_DESKTOP, brain_tools
from core.voice.desktop import DesktopVoice


class Agent:
    memory_hub = None
    def __init__(self):
        self.turns = []
    async def chat_stream(self, text, **kwargs):
        self.turns.append((text, kwargs, ACTIVE_DESKTOP.get()))
        yield {'type': 'token', 'text': 'Привет'}
        yield {'type': 'done', 'text': 'Привет', 'model_trace': {'calls': []}}


def make_client(agent=None):
    agent = agent or Agent()
    app = FastAPI()
    def auth(header):
        if header in ('Bearer owner-a', 'Bearer owner-b'):
            return 'admin'
        if header == 'Bearer viewer':
            return 'viewer'
        raise PermissionError
    app.include_router(router_for(agent, {}, auth))
    return TestClient(app), agent


@pytest.mark.parametrize('path', ['/v1/desktop/bridge', '/v1/desktop/voice'])
@pytest.mark.parametrize('headers', [{}, {'Authorization': 'Bearer viewer'}])
def test_desktop_auth_rejects_anonymous_and_viewer(path, headers):
    client, _ = make_client()
    with client, pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(path, headers=headers):
            pass


def test_chat_runs_in_private_authenticated_scope_and_tools_not_global():
    client, agent = make_client()
    m = manifest()
    with client, client.websocket_connect('/v1/desktop/bridge', headers={'Authorization': 'Bearer owner-a'}) as ws:
        ws.send_json(m.model_dump(mode='json'))
        assert ws.receive_json()['type'] == 'hello'
        ws.send_json({'type': 'chat', 'text': 'hello'})
        assert ws.receive_json()['type'] == 'token'
        assert ws.receive_json()['type'] == 'done'
        ws.send_json({'type': 'devices'})
        assert len(ws.receive_json()['devices']) == 1
    text, params, scope = agent.turns[0]
    assert params['username'].startswith('desktop:')
    assert params['channel_id'] == 'desktop:' + str(m.session_id)
    assert 'discord_user_id' not in params
    assert scope[3] == str(m.device_id)
    assert brain_tools() == {}


def test_two_pcs_route_only_to_explicit_device_of_same_owner():
    client, agent = make_client()
    a, b = manifest(), manifest()
    with client, client.websocket_connect('/v1/desktop/bridge', headers={'Authorization': 'Bearer owner-a'}) as first:
        first.send_json(a.model_dump(mode='json')); first.receive_json()
        with client.websocket_connect('/v1/desktop/bridge', headers={'Authorization': 'Bearer owner-b'}) as foreign:
            foreign.send_json(b.model_dump(mode='json')); foreign.receive_json()
            first.send_json({'type': 'chat', 'text': 'hello', 'target_device_id': str(b.device_id)})
            assert first.receive_json()['code'] == 'device_unavailable'
        with client.websocket_connect('/v1/desktop/bridge', headers={'Authorization': 'Bearer owner-a'}) as second:
            second.send_json(b.model_dump(mode='json')); second.receive_json()
            first.send_json({'type': 'chat', 'text': 'hello', 'target_device_id': str(b.device_id)})
            first.receive_json(); assert first.receive_json()['type'] == 'done'
    assert agent.turns[0][2][3] == str(b.device_id)
    assert agent.turns[0][1]['channel_id'] == 'desktop:' + str(a.session_id)


def test_capability_update_cannot_change_identity():
    client, _ = make_client()
    with client, client.websocket_connect('/v1/desktop/bridge', headers={'Authorization': 'Bearer owner-a'}) as ws:
        ws.send_json(manifest().model_dump(mode='json')); ws.receive_json()
        ws.send_json({'type': 'capabilities', 'manifest': manifest().model_dump(mode='json')})
        with pytest.raises(WebSocketDisconnect):
            ws.receive_json()


def test_ptt_transcript_chat_and_audio_share_text_session(monkeypatch):
    async def transcribe(self, pcm):
        assert pcm == b'\0\0' * 320
        return 'проверка голоса'
    async def synthesize(self, text):
        assert text == 'Привет'
        return b'RIFF-stub-audio'
    monkeypatch.setattr(DesktopVoice, 'transcribe', transcribe)
    monkeypatch.setattr(DesktopVoice, 'synthesize', synthesize)
    client, agent = make_client()
    m = manifest()
    with client, client.websocket_connect('/v1/desktop/voice', headers={'Authorization': 'Bearer owner-a'}) as ws:
        ws.send_json(m.model_dump(mode='json'))
        assert ws.receive_json()['format'] == 'pcm_s16le'
        ws.send_bytes(b'\0\0' * 320); ws.send_json({'type': 'commit'})
        transcript = ws.receive_json()
        assert transcript['type'] == 'transcript.final' and transcript['text'] == 'проверка голоса'
        assert ws.receive_json()['type'] == 'token'
        assert ws.receive_json()['type'] == 'done'
        packet = ws.receive_json()
        import base64
        assert base64.b64decode(packet['data']) == b'RIFF-stub-audio'
        assert ws.receive_json()['type'] == 'audio.done'
    assert agent.turns[0][1]['channel_id'] == 'desktop:' + str(m.session_id)


def test_voice_rejects_oversized_frame_without_stt():
    client, _ = make_client()
    with client, client.websocket_connect('/v1/desktop/voice', headers={'Authorization': 'Bearer owner-a'}) as ws:
        ws.send_json(manifest().model_dump(mode='json')); ws.receive_json()
        ws.send_bytes(b'\0' * 32769)
        with pytest.raises(WebSocketDisconnect):
            ws.receive_json()


def test_voice_stop_cancels_generation(monkeypatch):
    async def transcribe(self, pcm):
        await asyncio.sleep(60)
        return 'must not return'
    monkeypatch.setattr(DesktopVoice, 'transcribe', transcribe)
    client, agent = make_client()
    with client, client.websocket_connect('/v1/desktop/voice', headers={'Authorization': 'Bearer owner-a'}) as ws:
        ws.send_json(manifest().model_dump(mode='json')); ws.receive_json()
        ws.send_bytes(b'\0\0'); ws.send_json({'type': 'commit'})
        ws.send_json({'type': 'stop'})
        assert ws.receive_json()['type'] == 'cancelled'
    assert not agent.turns


def test_desktop_audio_wraps_bounded_pcm_in_wav(monkeypatch):
    import sys, types, io, wave
    captures = []
    class STT:
        def __init__(self, config): pass
        def transcribe_bytes(self, data, suffix):
            with wave.open(io.BytesIO(data)) as wav:
                assert (wav.getframerate(), wav.getnchannels(), wav.getsampwidth()) == (16000, 1, 2)
                captures.append(wav.readframes(100))
            return 'audio'
    monkeypatch.setitem(sys.modules, 'core.voice.stt', types.SimpleNamespace(STTEngine=STT))
    service = DesktopVoice({})
    assert asyncio.run(service.transcribe(b'\0\0'*100)) == 'audio'
    assert captures == [b'\0\0'*100]
    with pytest.raises(ValueError):
        asyncio.run(service.transcribe(b'odd'))


def test_brain_sees_only_current_devices_advertised_tools():
    async def scenario():
        registry=BridgeRegistry()
        async def send(packet): pass
        m=manifest(tools=['client.open_url'])
        registry.connect('owner',m,send)
        token=ACTIVE_DESKTOP.set((registry,'owner',str(m.session_id),str(m.device_id)))
        try:
            tools=brain_tools()
            assert set(tools)=={'client_open_url'}
            assert 'client_shell_exec' not in tools
        finally:
            ACTIVE_DESKTOP.reset(token)
        assert brain_tools()=={}
    asyncio.run(scenario())


def test_cancelled_stt_worker_is_not_reused_while_provider_still_runs(monkeypatch):
    import sys,types,threading
    started=threading.Event();release=threading.Event()
    class STT:
        def __init__(self,config): pass
        def transcribe_bytes(self,data,suffix):
            started.set();release.wait(2);return 'text'
    monkeypatch.setitem(sys.modules,'core.voice.stt',types.SimpleNamespace(STTEngine=STT))
    async def scenario():
        service=DesktopVoice({})
        task=asyncio.create_task(service.transcribe(b'\0\0'))
        await asyncio.to_thread(started.wait,1)
        task.cancel()
        with pytest.raises(asyncio.CancelledError): await task
        with pytest.raises(ValueError,match='stt_busy'): await service.transcribe(b'\0\0')
        release.set()
    try: asyncio.run(scenario())
    finally: release.set()


def test_desktop_routes_reuse_real_api_roles(client,auth_headers):
    for role in ['viewer','maint']:
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect('/v1/desktop/bridge',headers=auth_headers[role]): pass
    with client.websocket_connect('/v1/desktop/bridge',headers=auth_headers['admin']) as ws:
        ws.send_json(manifest().model_dump(mode='json'))
        assert ws.receive_json()['type']=='hello'
