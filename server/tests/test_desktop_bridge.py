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
from core.desktop.routes import desktop_owner_id, router_for
from core.desktop.bridge import ACTIVE_DESKTOP, brain_tools
from core.voice.desktop import DesktopVoice


class Agent:
    memory_hub = None
    def __init__(self, reply='Привет'):
        self.turns = []
        self.reply = reply
    async def chat_stream(self, text, **kwargs):
        self.turns.append((text, kwargs, ACTIVE_DESKTOP.get()))
        if self.reply:
            yield {'type': 'token', 'text': self.reply}
        yield {'type': 'done', 'text': self.reply, 'model_trace': {'calls': []}}


def make_client(agent=None, config=None):
    agent = agent or Agent()
    app = FastAPI()
    def auth(header):
        if header in ('Bearer owner-a', 'Bearer owner-b', 'Bearer owner-rotated'):
            return 'admin'
        if header == 'Bearer viewer':
            return 'viewer'
        raise PermissionError
    app.include_router(router_for(agent, config or {}, auth))
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
    # Admin tokens share stable desktop_owner_id — both PCs belong to one owner.
    client, agent = make_client()
    a, b = manifest(), manifest()
    with client, client.websocket_connect('/v1/desktop/bridge', headers={'Authorization': 'Bearer owner-a'}) as first:
        first.send_json(a.model_dump(mode='json')); first.receive_json()
        first.send_json({'type': 'chat', 'text': 'hello', 'target_device_id': str(b.device_id)})
        assert first.receive_json()['code'] == 'device_unavailable'
        with client.websocket_connect('/v1/desktop/bridge', headers={'Authorization': 'Bearer owner-b'}) as second:
            second.send_json(b.model_dump(mode='json')); second.receive_json()
            first.send_json({'type': 'chat', 'text': 'hello', 'target_device_id': str(b.device_id)})
            first.receive_json(); assert first.receive_json()['type'] == 'done'
    assert agent.turns[0][2][3] == str(b.device_id)
    assert agent.turns[0][1]['channel_id'] == 'desktop:' + str(a.session_id)


def test_desktop_owner_id_survives_token_rotation():
    assert desktop_owner_id({'api': {'token': 'old'}}) == desktop_owner_id({'api': {'token': 'new'}})
    assert desktop_owner_id({'api': {'desktop_owner_id': 'alice'}}) != desktop_owner_id({'api': {'desktop_owner_id': 'bob'}})
    client, agent = make_client(config={'api': {'desktop_owner_id': 'stable-owner'}})
    m = manifest()
    with client, client.websocket_connect('/v1/desktop/bridge', headers={'Authorization': 'Bearer owner-a'}) as ws:
        ws.send_json(m.model_dump(mode='json')); ws.receive_json()
        ws.send_json({'type': 'chat', 'text': 'hello'})
        ws.receive_json(); ws.receive_json()
    with client, client.websocket_connect('/v1/desktop/bridge', headers={'Authorization': 'Bearer owner-rotated'}) as ws:
        ws.send_json(m.model_dump(mode='json')); ws.receive_json()
        ws.send_json({'type': 'chat', 'text': 'again'})
        ws.receive_json(); ws.receive_json()
    assert agent.turns[0][1]['username'] == agent.turns[1][1]['username']
    assert agent.turns[0][1]['username'] == 'desktop:' + desktop_owner_id({'api': {'desktop_owner_id': 'stable-owner'}})


def test_capability_update_cannot_change_identity():
    client, _ = make_client()
    with client, client.websocket_connect('/v1/desktop/bridge', headers={'Authorization': 'Bearer owner-a'}) as ws:
        ws.send_json(manifest().model_dump(mode='json')); ws.receive_json()
        ws.send_json({'type': 'capabilities', 'manifest': manifest().model_dump(mode='json')})
        with pytest.raises(WebSocketDisconnect):
            ws.receive_json()


def test_disconnect_device_closes_socket_and_blocks_reregister():
    client, _ = make_client()
    target = manifest()
    with client, client.websocket_connect('/v1/desktop/bridge', headers={'Authorization': 'Bearer owner-a'}) as requester:
        requester.send_json(manifest().model_dump(mode='json')); requester.receive_json()
        with client.websocket_connect('/v1/desktop/bridge', headers={'Authorization': 'Bearer owner-b'}) as victim:
            victim.send_json(target.model_dump(mode='json')); victim.receive_json()
            requester.send_json({'type': 'disconnect_device', 'target_device_id': str(target.device_id)})
            devices = requester.receive_json()
            assert devices['type'] == 'devices'
            assert all(d['device_id'] != str(target.device_id) for d in devices['devices'])
            revoked = victim.receive_json()
            assert revoked['type'] == 'revoked'
            with pytest.raises(WebSocketDisconnect):
                victim.send_json({'type': 'capabilities', 'manifest': target.model_dump(mode='json')})
                victim.receive_json()
        # Dead-target revoke must not break the requester.
        requester.send_json({'type': 'disconnect_device', 'target_device_id': str(target.device_id)})
        assert requester.receive_json()['type'] == 'devices'
        requester.send_json({'type': 'ping'})
        assert requester.receive_json()['type'] == 'pong'


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


def test_voice_empty_chat_response_is_terminal(monkeypatch):
    async def transcribe(self, pcm):
        return 'тишина'
    monkeypatch.setattr(DesktopVoice, 'transcribe', transcribe)
    client, _ = make_client(Agent(reply=''))
    with client, client.websocket_connect('/v1/desktop/voice', headers={'Authorization': 'Bearer owner-a'}) as ws:
        ws.send_json(manifest().model_dump(mode='json')); ws.receive_json()
        ws.send_bytes(b'\0\0'); ws.send_json({'type': 'commit'})
        assert ws.receive_json()['type'] == 'transcript.final'
        assert ws.receive_json()['type'] == 'done'
        err = ws.receive_json()
        assert err['type'] == 'error' and err['code'] == 'empty_response'


def test_voice_rejects_oversized_frame_without_stt():
    client, _ = make_client()
    with client, client.websocket_connect('/v1/desktop/voice', headers={'Authorization': 'Bearer owner-a'}) as ws:
        ws.send_json(manifest().model_dump(mode='json')); ws.receive_json()
        ws.send_bytes(b'\0' * 32769)
        with pytest.raises(WebSocketDisconnect):
            ws.receive_json()


def test_bridge_binary_frame_closes_with_protocol_error():
    client, _ = make_client()
    with client, client.websocket_connect('/v1/desktop/bridge', headers={'Authorization': 'Bearer owner-a'}) as ws:
        ws.send_json(manifest().model_dump(mode='json')); ws.receive_json()
        ws.send_bytes(b'\0\0')
        with pytest.raises(WebSocketDisconnect) as exc:
            ws.receive_json()
        assert exc.value.code == 1008


def test_voice_non_string_request_id_closes_with_protocol_error():
    client, _ = make_client()
    with client, client.websocket_connect('/v1/desktop/voice', headers={'Authorization': 'Bearer owner-a'}) as ws:
        ws.send_json(manifest().model_dump(mode='json')); ws.receive_json()
        ws.send_bytes(b'\0\0')
        ws.send_json({'type': 'commit', 'request_id': 123})
        with pytest.raises(WebSocketDisconnect) as exc:
            ws.receive_json()
        assert exc.value.code == 1008


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


def test_brain_with_llm_tool_calls_off_binds_only_desktop_tools(tmp_path, monkeypatch):
    """AR-1: connecting a PC must not re-enable MCP/server tools when llm_tool_calls is false."""
    from unittest.mock import AsyncMock
    from langchain_core.messages import AIMessage
    from core.agent.brain_phase import run_brain_tool_phase

    class Bound:
        def __init__(self, tools):
            self.tools = tools
            self.calls = []
        async def ainvoke(self, messages, **kwargs):
            self.calls.append(list(self.tools))
            return AIMessage(content='ok-no-tools')

    class FakeBrain:
        def __init__(self):
            self.bound = None
            self.plain_calls = 0
        def bind_tools(self, tools):
            self.bound = Bound(tools)
            return self.bound
        async def ainvoke(self, messages, **kwargs):
            self.plain_calls += 1
            return AIMessage(content='routing-only')

    class FakeAgent:
        def __init__(self):
            self.config = {'mcp_client': {'llm_tool_calls': False, 'llm_tool_max_steps': 2}}
            self.tools = {'server_lookup': object(), 'mcp_search': object()}
            self.llm_brain = FakeBrain()
            self.lyrics_reply_max_tokens = 64
            self.brain_max_tokens = None
            self.short_memory = type('SM', (), {'get_history': lambda self: []})()
        def _format_spoken_user_message(self, um, speaker_label):
            return um
        def _make_human_turn(self, *a, **k):
            raise AssertionError('vision path unused')
        def _log_model_route(self, *a, **k):
            pass
        def _extract_model_name(self, response):
            return 'offline'
        async def _ainvoke_text_with_fallback(self, messages, llm=None, **kwargs):
            return await llm.ainvoke(messages)

    agent = FakeAgent()
    registry = BridgeRegistry()
    async def send(packet):
        pass
    m = manifest(tools=['client.open_url'])
    registry.connect('owner', m, send)
    token = ACTIVE_DESKTOP.set((registry, 'owner', str(m.session_id), str(m.device_id)))
    try:
        text = asyncio.run(run_brain_tool_phase(
            agent, user_message='open a site', speaker_label='user', vision_caption=None,
            brain_system='sys', lyrics_mode=False, context_data=''))
        assert text == 'ok-no-tools'
        assert agent.llm_brain.bound is not None
        names = {getattr(t, 'name', None) or str(t) for t in agent.llm_brain.bound.tools}
        assert names == {'client_open_url'}
        assert 'server_lookup' not in names and 'mcp_search' not in names
    finally:
        ACTIVE_DESKTOP.reset(token)


def test_cancelled_stt_queues_until_provider_finishes(monkeypatch):
    import sys, types, threading
    started = threading.Event()
    release = threading.Event()
    class STT:
        def __init__(self, config): pass
        def transcribe_bytes(self, data, suffix):
            started.set()
            release.wait(2)
            return 'queued'
    monkeypatch.setitem(sys.modules, 'core.voice.stt', types.SimpleNamespace(STTEngine=STT))
    async def scenario():
        service = DesktopVoice({})
        first = asyncio.create_task(service.transcribe(b'\0\0'))
        await asyncio.to_thread(started.wait, 1)
        first.cancel()
        with pytest.raises(asyncio.CancelledError):
            await first
        second = asyncio.create_task(service.transcribe(b'\0\0\0\0'))
        await asyncio.sleep(0.05)
        assert not second.done()
        release.set()
        assert await second == 'queued'
    try:
        asyncio.run(scenario())
    finally:
        release.set()


def test_desktop_routes_reuse_real_api_roles(client, auth_headers):
    for role in ['viewer', 'maint']:
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect('/v1/desktop/bridge', headers=auth_headers[role]):
                pass
    with client.websocket_connect('/v1/desktop/bridge', headers=auth_headers['admin']) as ws:
        ws.send_json(manifest().model_dump(mode='json'))
        assert ws.receive_json()['type'] == 'hello'
