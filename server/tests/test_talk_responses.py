"""Real turn pipeline, isolated SQLite and deterministic Responses HTTP contracts."""
import asyncio
import json
import threading
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace as NS
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest
from fastapi.testclient import TestClient
from langchain_core.messages import HumanMessage, SystemMessage

from core.agent.conversation_scope import conversation_scope
from core.agent.discord_context import context_from_message
from core.agent.model_trace import ACTIVE_TRACE, TurnTrace
from core.agent.responses_talk import ResponsesTalk
from core.agent.talk_sessions import MAX_TURNS, sessions_for
from core.api.app import build_app
from core.llm.profile import OpenAICompatibleConnection
from offline_support import offline_agent, OfflineResponsesGateway as Gateway
from test_stage3a import discord_message




@pytest.fixture
def setup(tmp_path):
    agent = offline_agent(tmp_path)
    agent.config['agent']['de_repeat'] = {'enabled': False}
    agent.config['llm']['talk_model']['responses'] = {'enabled': True, 'warmup_on_start': False}
    agent._llm_conn_talk = OpenAICompatibleConnection('offline', 'http://gateway.invalid/v1', 'synthetic-secret')
    gateway = Gateway()
    agent._responses_transport = httpx.MockTransport(gateway)
    yield agent, gateway
    agent.memory_hub.close()


async def turn(agent, text='hello', uid='123', channel='77', stream=False, context=None):
    kwargs = {'discord_context': context} if context else {'discord_user_id': uid, 'channel_id': channel}
    if stream:
        chunks = [c async for c in agent.chat_stream(text, **kwargs)]
        assert 'PRIVATE REASONING' not in str(chunks)
        return chunks[-1]
    return await agent.chat(text, **kwargs)


@pytest.mark.parametrize('stream', [False, True])
def test_continuation_sends_persona_once_and_reports_evidence(setup, stream):
    agent, gateway = setup
    async def run():
        first = await turn(agent, stream=stream)
        second = await turn(agent, text='second', stream=stream)
        assert 'code' not in first and 'code' not in second
        assert gateway.requests[0]['input'][0]['role'] == 'system'
        assert 'Offline persona' in str(gateway.requests[0])
        assert gateway.requests[1]['previous_response_id'] == 'resp-1'
        assert 'Offline persona' not in str(gateway.requests[1])
        assert first['text'] not in str(gateway.requests[1]['input'])
        assert len(sessions_for(agent).chains) == 1
        call = second['model_trace']['calls'][-1]
        assert call['reported_model'] == 'confirmed-model'
        assert call['provider_response_id'] == 'resp-2'
        assert call['provider_request_id'] == 'req-resp-2'
        assert call['usage']['cache_read_tokens'] == 10
    asyncio.run(run())


def test_warmup_seed_branches_without_user_data_and_tracks_cost(setup):
    agent, gateway = setup
    agent.config['llm']['talk_model']['responses']['warmup_on_start'] = True
    async def run():
        agent.start_talk_sessions()
        manager = sessions_for(agent)
        assert manager.status()['warmup_state'] == 'warming'
        await manager.warmup_job
        assert manager.status()['warmup_state'] == 'ready'
        assert len(gateway.requests) == 1
        from core.text_resources import prompt_text
        assert prompt_text('talk.state_policy') not in gateway.requests[0]['input'][0]['content']
        assert '[ASSISTANT STATE DATA]' not in str(gateway.requests[0])
        assert '[TURN CONTEXT DATA]' not in str(gateway.requests[0])
        assert 'current_user' not in str(gateway.requests[0])
        await turn(agent, uid='user-a')
        await turn(agent, uid='user-b')
        assert prompt_text('talk.state_policy') in gateway.requests[1]['instructions']
        assert gateway.requests[1]['previous_response_id'] == 'resp-1'
        assert gateway.requests[2]['previous_response_id'] == 'resp-1'
        assert 'Offline persona' not in str(gateway.requests[1])
        assert len(manager.chains) == 2
        report = agent.model_activity.recent(3)[-1]
        assert report['kind'] == 'background'
        assert report['calls'][0]['purpose'] == 'persona_warmup'
        assert manager.start_warmup() is False
        await agent.stop_talk_sessions()
        assert not manager.chains
    asyncio.run(run())


def test_group_is_shared_dm_and_channels_are_isolated_and_memory_identity_stays_personal(setup):
    agent, gateway = setup
    async def run():
        a = context_from_message(discord_message(uid='123'), '999')
        b = context_from_message(discord_message(uid='456'), '999')
        await turn(agent, text='public-one', context=a)
        await turn(agent, text='public-two', context=b)
        assert gateway.requests[1]['previous_response_id'] == 'resp-1'
        assert '123' in str(gateway.requests[0]['input']) and '456' in str(gateway.requests[1]['input'])
        assert 'BRAIN FACTS' not in str(gateway.requests[1]['input'])
        assert 'BRAIN FACTS' in gateway.requests[1]['instructions']
        group = [w for w in agent.short_memory.windows() if w['owner_id'].startswith('shared:')]
        assert len(group) == 1 and len(group[0]['messages']) == 4
        assert '[author_id: 123]' in group[0]['messages'][0]['content']
        assert '[author_id: 456]' in group[0]['messages'][2]['content']
        brain_prompt = str(agent.llm_brain.messages[-1])
        assert 'public-one' in brain_prompt
        assert agent._resolve_internal_user_id('123', None) != agent._resolve_internal_user_id('456', None)
        for uid in ('123', '456'):
            dm = context_from_message(discord_message(uid=uid, guild=False), '999')
            await turn(agent, context=dm)
            assert 'previous_response_id' not in gateway.requests[-1]
            assert 'public-one' not in str(gateway.requests[-1])
        changed = b.model_copy(update={'channel': b.channel.model_copy(update={'id': '88'}),
                                      'response_target': b.response_target.model_copy(update={'channel_id': '88'})})
        await turn(agent, context=changed)
        assert 'previous_response_id' not in gateway.requests[-1]
        assert len(sessions_for(agent).chains) == 4
    asyncio.run(run())


def test_group_dm_scope_and_future_app_scope():
    context = context_from_message(discord_message(guild=False), '999')
    context = context.model_copy(update={'channel': context.channel.model_copy(update={'type': 'group'})})
    assert conversation_scope('one', '77', context) == conversation_scope('two', '77', context)
    assert conversation_scope('one', '77') != conversation_scope('two', '77')


@pytest.mark.parametrize('change', ['persona', 'model', 'mode', 'feature', 'reset', 'trim', 'ttl', 'turn_limit'])
def test_rebase_on_policy_context_and_lifetime_changes(setup, change):
    agent, gateway = setup
    async def run():
        await turn(agent)
        manager = sessions_for(agent)
        if change == 'persona': agent.config['assistant']['system_prompt'] = 'Changed persona'
        if change == 'model': agent.llm_talk_model = 'changed-model'
        if change == 'mode': agent.config['agent']['conversation_mode'] = 'technical'
        if change == 'feature': agent.config['memory']['mood'] = {'enabled': False}
        if change == 'reset': agent.reset_context('77', user_id=agent._resolve_internal_user_id('123', None))
        if change == 'trim':
            window = next(iter(agent.short_memory._windows.values()))
            window.clear()
        if change == 'ttl': next(iter(manager.chains.values())).touched -= 1900
        if change == 'turn_limit': next(iter(manager.chains.values())).turns = MAX_TURNS
        await turn(agent, text='next')
        assert 'previous_response_id' not in gateway.requests[-1]
        assert any(i['role'] == 'system' for i in gateway.requests[-1]['input'])
    asyncio.run(run())


@pytest.mark.parametrize('stream', [False, True])
def test_missing_parent_retries_fresh_and_keeps_per_attempt_trace(setup, stream):
    agent, gateway = setup
    async def run():
        await turn(agent)
        gateway.failures.append(404)
        out = await turn(agent, text='retry', stream=stream)
        assert 'code' not in out
        assert 'previous_response_id' in gateway.requests[-2]
        assert 'previous_response_id' not in gateway.requests[-1]
        assert 'hello' in str(gateway.requests[-1]['input'])
        calls = [c for c in out['model_trace']['calls'] if c['lane'] == 'talk']
        assert [(c['attempt'], c['status']) for c in calls] == [(1, 'failed'), (2, 'completed')]
        assert calls[0]['retry_layer'] is None and calls[0]['error_class'] == 'ResponsesRetryable'
        assert calls[0]['http_status'] == 404 and calls[1]['http_status'] == 200
        # Stream retries inside the talk stream wrapper; non-stream retries inside invoke.
        assert calls[1]['retry_layer'] == ('stream_error' if stream else 'responses_history')
    asyncio.run(run())


def test_empty_and_missing_reported_model_are_honest(setup):
    agent, gateway = setup
    gateway.empty, gateway.report_model = True, False
    out = asyncio.run(turn(agent))
    calls = [c for c in out['model_trace']['calls'] if c['lane'] == 'talk']
    assert len(calls) == 2 and calls[0]['status'] == 'failed'
    assert all(c['reported_model'] is None for c in calls)
    assert out['model_trace']['status'] == 'completed'


def test_auth_failure_does_not_record_history(setup):
    agent, gateway = setup
    gateway.failures = [401, 401]
    out = asyncio.run(turn(agent, stream=True))
    assert out['type'] == 'error'
    assert not sessions_for(agent).chains
    assert all(not w['messages'] for w in agent.short_memory.windows())


@pytest.mark.parametrize('failure', ['incomplete', 'bad_stream'])
def test_partial_visible_errors_keep_local_history_without_remote_chain(setup, failure):
    agent, gateway = setup
    if failure == 'incomplete': gateway.incomplete = True
    if failure == 'bad_stream': gateway.bad_stream = True
    out = asyncio.run(turn(agent, stream=True))
    assert out['type'] == 'done'
    assert 'Ответ' in out['text']
    assert any(w['messages'] for w in agent.short_memory.windows())
    assert out['model_trace']['error_class'] == 'ResponsesError'
    assert not sessions_for(agent).chains
    assert len(gateway.requests) == 1


def test_cancelled_waiter_does_not_overtake_and_scopes_run_in_parallel(setup):
    agent, _ = setup
    manager = sessions_for(agent)
    scope = conversation_scope('one', 'channel')
    async def run():
        first = await manager.enter(scope)
        waiter = asyncio.create_task(manager.enter(scope))
        await asyncio.sleep(0)
        waiter.cancel()
        with pytest.raises(asyncio.CancelledError): await waiter
        third = asyncio.create_task(manager.enter(scope))
        other = await asyncio.wait_for(manager.enter(conversation_scope('two', 'channel')), 1)
        await asyncio.sleep(0)
        assert not third.done()
        other.close()
        first.close()
        (await asyncio.wait_for(third, 1)).close()
        assert not manager.gates
    asyncio.run(run())


def test_cross_event_loop_serialization(setup):
    agent, _ = setup
    manager = sessions_for(agent)
    scope = conversation_scope('one', 'channel')
    entered, release, second = threading.Event(), threading.Event(), threading.Event()
    async def first():
        tx = await manager.enter(scope)
        entered.set()
        await asyncio.to_thread(release.wait, 3)
        tx.close()
    async def next_turn():
        tx = await manager.enter(scope)
        second.set()
        tx.close()
    with ThreadPoolExecutor(2) as pool:
        a = pool.submit(asyncio.run, first())
        assert entered.wait(2)
        b = pool.submit(asyncio.run, next_turn())
        assert not second.wait(.05)
        release.set()
        a.result(3); b.result(3)
        assert second.is_set() and not manager.gates


def test_private_context_and_rewrite_guard_are_ephemeral(setup):
    agent, gateway = setup
    async def run():
        manager = sessions_for(agent)
        tx = await manager.enter(conversation_scope('owner', 'channel'))
        model = ResponsesTalk(agent, agent.llm_talk, tx)
        messages = [SystemMessage(content='PERSONA'), SystemMessage(content='REWRITE THIS TURN'),
                    HumanMessage(content='SECRET CURRENT CONTEXT', additional_kwargs={'neyra_ephemeral': True}),
                    HumanMessage(content='PUBLIC INPUT')]
        await model.ainvoke(messages)
        body = gateway.requests[-1]
        assert 'SECRET' not in str(body['input']) and 'REWRITE' not in str(body['input'])
        assert 'SECRET' in body['instructions'] and 'REWRITE' in body['instructions']
        tx.close()
    asyncio.run(run())


def test_reset_during_flight_cannot_resurrect_chain(setup):
    agent, _ = setup
    async def run():
        manager = sessions_for(agent)
        tx = await manager.enter(conversation_scope('owner', 'channel'))
        tx.prepare('system', [])
        tx.candidate('old-response', 'visible', 10)
        manager.invalidate()
        tx.commit(agent, 'visible')
        tx.close()
        assert not manager.chains and 'old-response' in manager.garbage
    asyncio.run(run())


def test_session_api_permissions_persistence_and_wipe(setup, tmp_path):
    agent, gateway = setup
    app = build_app(agent.config, shared_agent=agent, shared_monitor=MagicMock(run_once=AsyncMock()),
                    shared_backup_manager=MagicMock(), project_root=tmp_path)
    admin = {'Authorization': 'Bearer offline-admin-token'}
    viewer = {'Authorization': 'Bearer offline-viewer-token'}
    with TestClient(app) as client:
        assert client.get('/v1/llm/sessions').status_code == 401
        assert client.post('/v1/llm/sessions/warmup', headers=viewer).status_code == 403
        assert client.post('/v1/llm/sessions/warmup', headers=admin).status_code == 200
        import time
        for _ in range(100):
            status = client.get('/v1/llm/sessions', headers=viewer).json()['data']
            if status['warmup_state'] != 'warming': break
            time.sleep(.01)
        assert status['warmup_state'] == 'ready'
        assert 'resp-' not in json.dumps(status) and 'synthetic-secret' not in json.dumps(status)
        assert client.post('/v1/chat', headers=admin, json={'text': 'hello', 'platform_user_id': '123', 'channel_id': '77'}).status_code == 200
        assert client.get('/v1/llm/sessions', headers=viewer).json()['data']['active_sessions'] == 1
        assert client.post('/v1/memory/wipe', headers=admin, json={'scopes': ['stm'], 'confirm': 'WIPE'}).status_code == 200
        assert not sessions_for(agent).chains
        agent._setup_llm = MagicMock()
        result = client.post('/v1/config/update', headers=admin, json={'updates': {'llm.talk_model.responses.enabled': False}})
        assert result.status_code == 200
        agent._setup_llm.assert_not_called()
        assert 'enabled: false' in (tmp_path / 'config/llm.yaml').read_text()
        assert client.post('/v1/llm/sessions/warmup', headers=admin).status_code == 409


def test_shared_history_also_works_with_responses_off(setup):
    agent, gateway = setup
    agent.config['llm']['talk_model']['responses']['enabled'] = False
    async def run():
        for uid, text in [('123', 'public-shared-message'), ('456', 'another-participant')]:
            await turn(agent, text=text, context=context_from_message(discord_message(uid=uid), '999'))
        assert not gateway.requests
        assert 'public-shared-message' in str(agent.llm_talk.messages[-1])
        assert '123' in str(agent.llm_talk.messages[-1])
        dm = context_from_message(discord_message(uid='456', guild=False), '999')
        await turn(agent, context=dm)
        assert 'public-shared-message' not in str(agent.llm_talk.messages[-1])
    asyncio.run(run())


def test_warmup_failure_unblocks_dialog_and_cancel_before_start_unblocks_waiters(setup):
    agent, gateway = setup
    agent.config['llm']['talk_model']['responses']['warmup_on_start'] = True
    async def run():
        manager = sessions_for(agent)
        gateway.failures = [401]
        manager.start_warmup()
        result = await asyncio.wait_for(turn(agent), 2)
        assert 'code' not in result
        assert manager.status()['warmup_state'] == 'failed'
        assert not manager.gates
        assert manager.start_warmup(manual=True)
        await agent.stop_talk_sessions()
        assert manager.warming is None
    asyncio.run(run())


def test_vision_input_and_rewrite_fork_from_committed_parent(setup):
    agent, gateway = setup
    async def run():
        manager = sessions_for(agent)
        tx = await manager.enter(conversation_scope('one', 'channel'))
        model = ResponsesTalk(agent, agent.llm_talk, tx)
        messages = [SystemMessage(content='Persona'), HumanMessage(content=[
            {'type': 'text', 'text': 'What is in the image?'},
            {'type': 'image_url', 'image_url': {'url': 'data:image/png;base64,AAAA', 'detail': 'low'}},
        ])]
        await model.ainvoke(messages)
        assert gateway.requests[-1]['input'][-1]['content'][-1]['type'] == 'input_image'
        first = gateway.responses['resp-1']['output'][0]['content'][0]['text']
        tx.commit(agent, first)
        tx.close()
        tx = await manager.enter(conversation_scope('one', 'channel'))
        model = ResponsesTalk(agent, agent.llm_talk, tx)
        from langchain_core.messages import AIMessage
        history = AIMessage(content=first, additional_kwargs={'neyra_history': True})
        messages = [SystemMessage(content='Persona'), HumanMessage(content='previous', additional_kwargs={'neyra_history': True}), history, HumanMessage(content='next')]
        await model.ainvoke(messages)
        await model.ainvoke([messages[0], SystemMessage(content='Rewrite this reply'), *messages[1:]])
        assert gateway.requests[-1]['previous_response_id'] == 'resp-1'
        assert gateway.requests[-2]['previous_response_id'] == 'resp-1'
        rewritten = gateway.responses['resp-3']['output'][0]['content'][0]['text']
        tx.commit(agent, rewritten)
        tx.close()
        assert next(iter(manager.chains.values())).parent == 'resp-3'
        assert 'resp-2' in manager.garbage and 'resp-3' not in manager.garbage
    asyncio.run(run())


def test_cancelled_public_stream_does_not_store_partial_and_releases_gate(setup):
    agent, _ = setup
    async def run():
        stream = agent.chat_stream('cancel halfway', discord_user_id='123', channel_id='77')
        token = await anext(stream)
        assert token['type'] == 'token'
        assert ACTIVE_TRACE.get() is None
        await stream.aclose()
        manager = sessions_for(agent)
        assert not manager.chains and not manager.gates
        assert all(not w['messages'] for w in agent.short_memory.windows())
        result = await asyncio.wait_for(turn(agent), 1)
        assert 'code' not in result
    asyncio.run(run())


def test_incomplete_and_empty_evidence_keeps_provider_id_and_usage(setup):
    agent, gateway = setup
    gateway.incomplete = True
    out = asyncio.run(turn(agent))
    call = [c for c in out['model_trace']['calls'] if c['lane'] == 'talk'][0]
    assert call['status'] == 'failed'
    assert call['provider_response_id'] == 'resp-1'
    assert call['usage']['input_tokens'] == 21


def test_unknown_parent_of_warmup_seed_is_not_reused(setup):
    agent, gateway = setup
    async def run():
        manager = sessions_for(agent)
        manager.start_warmup(manual=True)
        await manager.warmup_job
        gateway.failures.append(404)
        await turn(agent)
        assert manager.seed is None
        assert manager.status()['warmup_state'] == 'failed'
        await turn(agent, uid='new-user')
        assert 'previous_response_id' not in gateway.requests[-1]
    asyncio.run(run())


def test_targeted_reset_preserves_other_active_dialogs(setup):
    agent, _ = setup
    async def run():
        manager = sessions_for(agent)
        a = await manager.enter(conversation_scope('owner-a', 'same-channel'))
        b = await manager.enter(conversation_scope('owner-b', 'same-channel'))
        for tx, rid in [(a, 'a'), (b, 'b')]:
            tx.prepare('system', [])
            tx.candidate(rid, 'visible', 10)
        manager.invalidate(owner='owner-a', channel='same-channel')
        a.commit(agent, 'visible'); b.commit(agent, 'visible')
        a.close(); b.close()
        assert [chain.parent for chain in manager.chains.values()] == ['b']
        assert not manager.active and not manager.invalidated
    asyncio.run(run())


@pytest.mark.parametrize('stream', [False, True])
def test_reset_before_finalize_never_resurrects_old_stm(setup, stream):
    agent, gateway = setup
    async def reset_before_finish(*args, **kwargs):
        agent.reset_context('77', user_id=agent._resolve_internal_user_id('123', None))
        return args[1] if len(args) > 1 else ''
    agent._de_repeat_reply = reset_before_finish
    out = asyncio.run(turn(agent, stream=stream))
    assert out['code'] == 'generation_failed'
    assert not sessions_for(agent).chains
    assert all(not w['messages'] for w in agent.short_memory.windows())
    assert out['model_trace']['status'] == 'failed'


@pytest.mark.parametrize('stream', [False, True])
def test_overflow_replays_bounded_history_without_repeating_brain(setup, stream):
    agent, gateway = setup
    normal = gateway.__call__
    def handler(request):
        if request.method == 'POST' and len(gateway.requests) == 4:
            body = json.loads(request.content)
            gateway.requests.append(body)
            return httpx.Response(400, json={'error': {'code': 'context_length_exceeded'}})
        return normal(request)
    agent._responses_transport = httpx.MockTransport(handler)
    async def run():
        for n in range(4): await turn(agent, text=f'public {n}')
        before = len(agent.llm_brain.messages)
        out = await turn(agent, text='overflow-turn', stream=stream)
        assert 'code' not in out
        assert len(agent.llm_brain.messages) == before + 1
        assert 'previous_response_id' not in gateway.requests[-1]
        assert 'public 0' not in str(gateway.requests[-1]['input'])
        assert 'public 3' in str(gateway.requests[-1]['input'])
        calls = [c for c in out['model_trace']['calls'] if c['lane'] == 'talk']
        assert [c['status'] for c in calls] == ['failed', 'completed']
    asyncio.run(run())


def test_cleanup_uses_original_provider_after_configuration_change(setup):
    agent, gateway = setup
    requests = []
    original = agent._responses_transport
    async def run():
        await turn(agent)
        sessions_for(agent).invalidate()
        agent._llm_conn_talk = OpenAICompatibleConnection('new', 'https://other.invalid/v1', 'new-key')
        def cleanup(request):
            requests.append((request.url.host, request.headers['authorization']))
            return httpx.Response(200, json={'deleted': True})
        agent._responses_transport = httpx.MockTransport(cleanup)
        await sessions_for(agent).cleanup()
        assert requests == [('gateway.invalid', 'Bearer synthetic-secret')]
        agent._responses_transport = original
    asyncio.run(run())


@pytest.mark.parametrize('stream', [False, True])
def test_reset_fast_path_does_not_fall_through_to_brain(setup, monkeypatch, stream):
    from core.agent.talk_sessions import ConversationReset
    agent, gateway = setup
    monkeypatch.setattr('core.agent.fast_path.try_handle_fast_path', AsyncMock(side_effect=ConversationReset('reset')))
    out = asyncio.run(turn(agent, stream=stream))
    assert out['code'] == 'generation_failed'
    assert not agent.llm_brain.messages and not gateway.requests
    assert out['model_trace']['without_llm']


def test_output_budget_is_separate_from_the_visible_reply_cap(setup):
    agent, gateway = setup
    asyncio.run(turn(agent))
    assert gateway.requests[0]['max_output_tokens'] == agent.reply_max_tokens + 2048
    agent.config['llm']['talk_model']['max_output_tokens'] = 900
    asyncio.run(turn(agent, text='next'))
    assert gateway.requests[-1]['max_output_tokens'] == 900


@pytest.mark.parametrize('stream', [False, True])
def test_max_output_truncation_finishes_with_the_partial_answer(setup, stream):
    agent, gateway = setup
    gateway.incomplete = True
    gateway.incomplete_reason = 'max_output_tokens'
    out = asyncio.run(turn(agent, stream=stream))
    assert out.get('type', 'done') != 'error'
    assert 'Ответ' in out['text']
    purpose = 'stream_reply' if stream else 'reply'
    call = next(c for c in out['model_trace']['calls'] if c['purpose'] == purpose and c['status'] == 'completed')
    assert call['truncated'] is True
    assert call['terminal_event'] == 'response.incomplete'
    assert call['incomplete_reason'] == 'max_output_tokens'
    assert call['usage']['reasoning_tokens'] == 40
    assert call['usage']['output_tokens'] == 7
    assert len(sessions_for(agent).chains) == 1
    assert 'PRIVATE' not in json.dumps(out['model_trace'])


def test_visible_cap_stops_the_stream_and_matches_the_saved_reply(setup):
    from langchain_core.messages import AIMessageChunk
    from core.agent.responses_talk import ResponsesTalk
    agent, _gateway = setup
    agent.reply_max_tokens = 2
    consumed = {'n': 0}
    original = ResponsesTalk.astream

    async def fake(self, messages):
        for _ in range(20):
            consumed['n'] += 1
            yield AIMessageChunk(content='abcdefghij')

    ResponsesTalk.astream = fake

    async def collect():
        return [chunk async for chunk in agent.chat_stream('hello', discord_user_id='123', channel_id='77')]

    try:
        chunks = asyncio.run(collect())
        assert consumed['n'] == 1
        shown = ''.join(chunk['text'] for chunk in chunks if chunk['type'] == 'token')
        assert chunks[-1]['type'] == 'done'
        assert chunks[-1]['text'] == shown == 'abcdefgh'
        call = next(c for c in chunks[-1]['model_trace']['calls'] if c['purpose'] == 'stream_reply')
        assert call['truncated'] is True
        assert call['incomplete_reason'] == 'visible_cap'
        assert call['status'] == 'completed'
        assert not sessions_for(agent).chains
        saved = ' '.join(str(window['messages']) for window in agent.short_memory.windows())
        assert 'abcdefghij' not in saved
        assert 'abcdefgh' in saved
    finally:
        ResponsesTalk.astream = original


def test_responses_flag_without_a_session_does_not_clip_chat_completions(setup):
    from langchain_core.messages import AIMessageChunk
    agent, _gateway = setup
    agent.reply_max_tokens = 2
    long_text = 'abcdefghij' * 3

    async def stream(messages):
        yield AIMessageChunk(content=long_text)

    agent.llm_talk.astream = stream
    chunks = asyncio.run(_collect(agent))
    assert chunks[-1]['type'] == 'done'
    assert chunks[-1]['text'] == long_text
    talk = next(c for c in chunks[-1]['model_trace']['calls'] if c['purpose'] == 'stream_reply')
    assert talk['truncated'] is False


def test_nonstream_visible_clip_is_marked_on_the_talk_call(setup):
    from langchain_core.messages import AIMessage
    from core.agent.responses_talk import ResponsesTalk
    agent, _gateway = setup
    agent.reply_max_tokens = 2
    original = ResponsesTalk.ainvoke

    async def fake(self, messages):
        return AIMessage(content='abcdefghij' * 3)

    ResponsesTalk.ainvoke = fake
    try:
        out = asyncio.run(turn(agent))
        assert out['text'] == 'abcdefgh'
        call = next(c for c in out['model_trace']['calls'] if c['purpose'] == 'reply' and c['status'] == 'completed')
        assert call['truncated'] is True
        assert call['incomplete_reason'] == 'visible_cap'
    finally:
        ResponsesTalk.ainvoke = original


def _collect(agent):
    async def run():
        return [chunk async for chunk in agent.chat_stream('hello')]
    return run()
