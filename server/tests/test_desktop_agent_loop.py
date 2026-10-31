"""Abuse cases for Contour 3–4 on the server: result shape, no blind retry, bounded agent loop."""

import asyncio
import json
import uuid

import pytest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from core.agent import brain_phase
from core.agent.brain_phase import desktop_loop_limits, run_brain_tool_phase
from core.desktop.bridge import (
    ACTIVE_DESKTOP, DESKTOP_TURN, SCREENSHOT_LIMIT, BridgeRegistry, DesktopTurn, Manifest, _desktop_action,
    checked_result,
)

ALL = ['client.open_url', 'client.shell_exec', 'client.fs_read', 'client.fs_write', 'client.screenshot', 'client.input']


def manifest(tools):
    return Manifest(device_id=str(uuid.uuid4()), session_id=str(uuid.uuid4()), name='PC',
                    platform='linux-x11', tools=tools)


class FakeClient:
    """Answers client_tool_call packets like a PC would; records everything it receives."""

    def __init__(self, registry, owner='owner', reply=None, hang=()):
        self.registry, self.owner, self.packets = registry, owner, []
        self.reply = reply or (lambda tool, args: {'status': 'ok'})
        self.hang = set(hang)
        self.connection = None

    async def send(self, packet):
        self.packets.append(packet)
        if packet.get('type') == 'client_tool_call' and packet['tool'] not in self.hang:
            result = self.reply(packet['tool'], packet['arguments'])
            asyncio.get_running_loop().call_soon(
                self.registry.result, self.owner, self.connection, packet['call_id'], result)


def connect(tools=ALL, **kwargs):
    registry = BridgeRegistry()
    client = FakeClient(registry, **kwargs)
    m = manifest(tools)
    client.connection = registry.connect('owner', m, client.send)
    return registry, client, m


def test_only_screenshots_may_carry_image_bytes_and_results_are_bounded():
    shot = {'status': 'ok', 'mime': 'image/jpeg', 'data': 'QUJD', 'screenshot_id': 'x'}
    assert checked_result('client.screenshot', shot) == shot
    assert checked_result('client.screenshot', {**shot, 'mime': 'text/html'})['code'] == 'bad_screenshot'
    assert checked_result('client.screenshot', {**shot, 'data': 'A' * (SCREENSHOT_LIMIT + 1)})['code'] == 'bad_screenshot'
    assert checked_result('client.fs_read', {'status': 'ok', 'data': 'QUJD'})['code'] == 'result_too_large'
    assert checked_result('client.shell_exec', {'status': 'ok', 'stdout': 'x' * 70000})['code'] == 'result_too_large'
    assert checked_result('client.shell_exec', ['not', 'a', 'dict'])['code'] == 'bad_result'
    cyrillic = 'я' * 24_000
    assert checked_result('client.shell_exec', {'status': 'ok', 'stdout': cyrillic})['status'] == 'ok'
    assert checked_result('client.shell_exec', {'status': 'ok', 'stdout': 'я' * 40_000})['code'] == 'result_too_large'


def test_large_non_result_packets_still_close_the_socket():
    from tests.test_desktop_bridge import make_client
    from starlette.websockets import WebSocketDisconnect
    client, _ = make_client()
    with client.websocket_connect('/v1/desktop/bridge', headers={'Authorization': 'Bearer owner-a'}) as ws:
        ws.send_json(manifest(['client.open_url']).model_dump(mode='json'))
        assert ws.receive_json()['type'] == 'hello'
        ws.send_text(json.dumps({'type': 'chat', 'text': 'x', 'call_id': '', 'result': {'pad': 'y' * 40000}}))
        with pytest.raises(WebSocketDisconnect):
            ws.receive_json()


def test_unknown_outcome_blocks_further_changes_but_not_reads():
    async def scenario():
        registry, client, m = connect(hang={'client.fs_write'})
        turn = DesktopTurn()
        token = DESKTOP_TURN.set(turn)
        try:
            task = asyncio.create_task(_desktop_action(registry, 'owner', str(m.session_id), str(m.device_id),
                                                       'client.fs_write', {'path': '/x', 'content': 'y', 'mode': 'create'}))
            await asyncio.sleep(0.01)
            registry.disconnect(client.connection)
            out = await task
            assert out['status'] == 'unknown' and out['retry'] is False
            assert turn.outcome_unknown
            # The PC reconnects: still no blind repeat of a change in this turn.
            client.connection = registry.connect('owner', m, client.send)
            sent_before = len(client.packets)
            again = await _desktop_action(registry, 'owner', str(m.session_id), str(m.device_id),
                                          'client.fs_write', {'path': '/x', 'content': 'y', 'mode': 'create'})
            assert again['code'] == 'previous_outcome_unknown'
            assert len(client.packets) == sent_before
            read = await _desktop_action(registry, 'owner', str(m.session_id), str(m.device_id),
                                         'client.fs_read', {'path': '/x'})
            assert read['status'] == 'ok'
        finally:
            DESKTOP_TURN.reset(token)
    asyncio.run(scenario())


def test_action_budget_is_enforced():
    async def scenario():
        registry, client, m = connect()
        token = DESKTOP_TURN.set(DesktopTurn(max_actions=2))
        try:
            outs = [await _desktop_action(registry, 'owner', str(m.session_id), str(m.device_id),
                                          'client.fs_read', {'path': '/x'}) for _ in range(3)]
        finally:
            DESKTOP_TURN.reset(token)
        assert [o['status'] for o in outs] == ['ok', 'ok', 'blocked']
        assert outs[2]['code'] == 'action_budget_exhausted'
        assert sum(p['type'] == 'client_tool_call' for p in client.packets) == 2
    asyncio.run(scenario())


def test_loop_limits_have_hard_caps():
    assert desktop_loop_limits({}) == {'max_steps': 8, 'max_seconds': 180, 'max_actions': 24}
    capped = desktop_loop_limits({'desktop_agent': {'max_steps': 999, 'max_seconds': 99999, 'max_actions': -5}})
    assert capped == {'max_steps': 16, 'max_seconds': 600, 'max_actions': 1}
    assert desktop_loop_limits({'desktop_agent': {'max_steps': 'many'}})['max_steps'] == 8


# ---------- brain loop ----------

class ScriptedBrain:
    """bind_tools() records each binding; every call returns the next scripted tool call."""

    def __init__(self, script, on_call=None):
        self.script, self.bindings, self.seen, self.on_call = list(script), [], [], on_call

    def bind_tools(self, tools):
        names = {t.name for t in tools}
        self.bindings.append(names)
        brain = self

        class Bound:
            async def ainvoke(self, messages, **kwargs):
                brain.seen.append(list(messages))
                if brain.on_call:
                    brain.on_call(len(brain.seen))
                if not brain.script:
                    return AIMessage(content='done')
                name, args = brain.script.pop(0)
                return AIMessage(content='', tool_calls=[{'id': str(uuid.uuid4()), 'name': name, 'args': args}])
        return Bound()

    async def ainvoke(self, messages, **kwargs):
        return AIMessage(content='plain')


class FakeAgent:
    def __init__(self, brain, config=None, vision=True):
        self.config = config or {'mcp_client': {'llm_tool_calls': False}}
        self.tools = {'server_secret_tool': object()}
        self.llm_brain = brain
        self.llm_vision = None
        self.vision = vision
        self.executed_server_tools = []
        self.lyrics_reply_max_tokens = 64
        self.brain_max_tokens = None
        self.short_memory = type('SM', (), {'get_history': lambda self: []})()

    def _format_spoken_user_message(self, um, speaker_label):
        return um

    def _uses_brain_native_vision(self):
        return self.vision

    def _make_human_turn(self, text, images, **kwargs):
        return HumanMessage(content=[{'type': 'text', 'text': text},
                                     {'type': 'image_url', 'image_url': {'url': f'data:{images[0][0]};base64,{images[0][1]}'}}])

    def _log_model_route(self, *a, **k):
        pass

    def _extract_model_name(self, response):
        return 'offline'

    async def _ainvoke_text_with_fallback(self, messages, llm=None, **kwargs):
        return await llm.ainvoke(messages)

    async def _execute_tool(self, name, **kwargs):
        self.executed_server_tools.append(name)
        return 'server-tool-ran'


def run_turn(agent, registry, m):
    token = ACTIVE_DESKTOP.set((registry, 'owner', str(m.session_id), str(m.device_id)))
    try:
        return asyncio.run(run_brain_tool_phase(agent, user_message='do it', speaker_label='user', vision_caption=None,
                                                brain_system='sys', lyrics_mode=False, context_data=''))
    finally:
        ACTIVE_DESKTOP.reset(token)


def test_step_budget_stops_an_endless_tool_loop():
    registry, client, m = connect()
    brain = ScriptedBrain([('client_fs_read', {'arguments': {'path': '/x'}})] * 50)
    agent = FakeAgent(brain, {'mcp_client': {'llm_tool_calls': False}, 'desktop_agent': {'max_steps': 3}})
    out = json.loads(run_turn(agent, registry, m))
    assert out['tool_budget_exhausted'] and out['stop_reason'] == 'step_budget'
    assert sum(p['type'] == 'client_tool_call' for p in client.packets) == 3


def test_slow_model_invoke_is_cut_by_the_wall_clock(monkeypatch):
    recorded = []

    async def expire(awaitable, timeout):
        recorded.append(timeout)
        awaitable.close()
        raise TimeoutError

    monkeypatch.setattr(brain_phase.asyncio, 'wait_for', expire)
    registry, client, m = connect()

    class Hung(ScriptedBrain):
        def bind_tools(self, tools):
            self.bindings.append({t.name for t in tools})

            class Bound:
                async def ainvoke(self, messages, **kwargs):
                    await asyncio.sleep(60)
                    return AIMessage(content='late')

            return Bound()

    agent = FakeAgent(Hung([]), {'mcp_client': {'llm_tool_calls': False}, 'desktop_agent': {'max_seconds': 30, 'max_steps': 4}})
    out = json.loads(run_turn(agent, registry, m))
    assert out['stop_reason'] == 'wall_clock_budget'
    assert recorded and recorded[0] >= 1
    assert not any(p.get('type') == 'client_tool_call' for p in client.packets)


def test_wall_clock_budget_stops_the_loop(monkeypatch):
    registry, client, m = connect()
    clock = [1000.0]
    monkeypatch.setattr(brain_phase.time, 'monotonic', lambda: clock[0])

    def tick(n):
        clock[0] += 120
    brain = ScriptedBrain([('client_fs_read', {'arguments': {'path': '/x'}})] * 10, on_call=tick)
    agent = FakeAgent(brain, {'mcp_client': {'llm_tool_calls': False}, 'desktop_agent': {'max_seconds': 200, 'max_steps': 10}})
    out = json.loads(run_turn(agent, registry, m))
    assert out['stop_reason'] == 'wall_clock_budget'
    assert len(brain.seen) == 2


def test_capability_switched_off_mid_turn_is_unbound_next_step():
    registry, client, m = connect(tools=['client.fs_read', 'client.shell_exec'])

    def revoke_shell(n):
        if n == 1:
            registry.disconnect(client.connection)
            client.connection = registry.connect('owner', m.model_copy(update={'tools': ['client.fs_read']}), client.send)
    brain = ScriptedBrain([('client_fs_read', {'arguments': {'path': '/x'}}),
                           ('client_shell_exec', {'arguments': {'program': 'rm'}})], on_call=revoke_shell)
    agent = FakeAgent(brain)
    run_turn(agent, registry, m)
    assert brain.bindings[0] == {'client_fs_read', 'client_shell_exec'}
    assert brain.bindings[-1] == {'client_fs_read'}
    assert not any(p.get('tool') == 'client.shell_exec' for p in client.packets)


def test_revoked_device_stops_the_loop():
    registry, client, m = connect(tools=['client.fs_read'])

    def revoke(n):
        if n == 1:
            registry.disconnect(client.connection)
    brain = ScriptedBrain([('client_fs_read', {'arguments': {'path': '/x'}})] * 5, on_call=revoke)
    out = json.loads(run_turn(FakeAgent(brain), registry, m))
    assert out['stop_reason'] == 'tools_revoked'


def test_hallucinated_server_tool_is_not_executed_when_llm_tool_calls_off():
    registry, client, m = connect(tools=['client.fs_read'])
    brain = ScriptedBrain([('server_secret_tool', {})])
    agent = FakeAgent(brain)
    run_turn(agent, registry, m)
    assert agent.executed_server_tools == []
    assert brain.bindings[0] == {'client_fs_read'}


def test_screenshot_reaches_brain_as_image_not_tool_text():
    data = 'SU1BR0VEQVRB'
    registry, client, m = connect(reply=lambda tool, args: (
        {'status': 'ok', 'mime': 'image/jpeg', 'data': data, 'screenshot_id': str(uuid.uuid4()), 'width': 10, 'height': 10}
        if tool == 'client.screenshot' else {'status': 'ok'}))
    brain = ScriptedBrain([('client_screenshot', {'arguments': {}})])
    run_turn(FakeAgent(brain), registry, m)
    last = brain.seen[-1]
    tool_texts = [msg.content for msg in last if isinstance(msg, ToolMessage)]
    assert tool_texts and all(data not in t for t in tool_texts)
    assert 'attached_to_next_message' in tool_texts[0]
    images = [msg for msg in last if isinstance(msg, HumanMessage) and isinstance(msg.content, list)]
    assert images and data in json.dumps(images[-1].content)


def test_screenshot_without_vision_is_not_guessed():
    registry, client, m = connect(reply=lambda tool, args: (
        {'status': 'ok', 'mime': 'image/jpeg', 'data': 'QUJD', 'screenshot_id': str(uuid.uuid4())}))
    brain = ScriptedBrain([('client_screenshot', {'arguments': {}})])
    run_turn(FakeAgent(brain, vision=False), registry, m)
    notes = [msg.content for msg in brain.seen[-1] if isinstance(msg, HumanMessage) and isinstance(msg.content, str)]
    assert any('cannot see images' in n for n in notes)


def test_stop_cancels_turn_and_sends_cancel_to_pc():
    async def scenario():
        registry, client, m = connect(tools=['client.input'], hang={'client.input'})
        brain = ScriptedBrain([('client_input', {'arguments': {'steps': [{'op': 'key', 'keys': 'enter'}]}})])
        agent = FakeAgent(brain)
        token = ACTIVE_DESKTOP.set((registry, 'owner', str(m.session_id), str(m.device_id)))
        try:
            task = asyncio.create_task(run_brain_tool_phase(
                agent, user_message='x', speaker_label='u', vision_caption=None, brain_system='s',
                lyrics_mode=False, context_data=''))
            for _ in range(50):
                await asyncio.sleep(0.01)
                if any(p['type'] == 'client_tool_call' for p in client.packets):
                    break
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        finally:
            ACTIVE_DESKTOP.reset(token)
        call = next(p for p in client.packets if p['type'] == 'client_tool_call')
        assert {'type': 'cancel', 'call_id': call['call_id']} in client.packets
        assert DESKTOP_TURN.get() is None
    asyncio.run(scenario())
