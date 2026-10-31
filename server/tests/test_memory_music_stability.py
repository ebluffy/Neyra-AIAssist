"""Real temporary storage and offline adapters for the reported Discord regressions."""

import asyncio
import json
from datetime import datetime, timezone
from types import SimpleNamespace as NS
from unittest.mock import AsyncMock, Mock

import pytest

from core.agent.conversation_scope import conversation_scope
from core.agent.discord_context import context_from_message
from core.agent.people_context import known_discord_mentions, split_people_context
from core.memory.hub import MemoryHub
from core.reflection.engine import ReflectionEngine
from core.runtime.identity import UnifiedIdentityMapper
from core.tools import builtins
from modules.discord.music_intent import finalize_music_route, plan_music_route, resolve_music_route
from offline_support import offline_agent
from test_stage3a import discord_message


@pytest.fixture
def hub(tmp_path, monkeypatch):
    h = MemoryHub({'memory': {'sqlite_path': str(tmp_path / 'hub.db'), 'rag_enabled': False}})
    monkeypatch.setattr(builtins, '_memory_hub', h)
    builtins.clear_turn_memory_scope()
    yield h
    builtins.clear_turn_memory_scope()
    h.close()


def person(hub, account_id='123'):
    return hub.ensure_person_for_account(platform='discord', platform_user_id=account_id,
        handle='same', display_name='Same Name')


def evidence(hub, account_id='123', text='Я изучаю Python и разрабатываю программное обеспечение.', role='user', channel='shared', **kwargs):
    return hub.append_chat(role=role, text=text, user_id=UnifiedIdentityMapper.resolve_from_discord(account_id),
        channel_id=channel, meta={'discord_id': account_id, 'visibility': 'channel'}, **kwargs)


def proposal(pid, mid, quote, fact='Человек изучает Python и разрабатывает программное обеспечение.'):
    return {'person_hint': pid, 'source_message_id': mid, 'evidence_quote': quote, 'fact': fact}


@pytest.mark.parametrize('invalid', ['assistant', 'other_author', 'invented_quote', 'no_source', 'deleted_source'])
def test_reflection_rejects_unsupported_attribution(hub, invalid):
    a, b = person(hub), person(hub, '456')
    quote = 'Я Нейра, живу в этом чате.'
    mid = evidence(hub, text=quote, role='assistant' if invalid == 'assistant' else 'user', account_id='456' if invalid == 'other_author' else '123')
    item = proposal(a['id'], mid, quote)
    if invalid == 'invented_quote':
        item['evidence_quote'] = 'Words that do not exist in the source'
    if invalid == 'no_source':
        item.pop('source_message_id')
    if invalid == 'deleted_source':
        hub.sqlite.clear_table('chat_log')
    engine = ReflectionEngine.__new__(ReflectionEngine)
    engine.agent = NS(memory_hub=hub)
    engine._apply_reflection_result({'people_updates': [item]})
    assert not hub.list_person_facts(a['id'])
    assert not hub.list_person_facts(b['id'])


def test_reflection_requires_and_saves_original_human_source(hub):
    p = person(hub)
    quote = 'Я изучаю Python'
    mid = evidence(hub)
    engine = ReflectionEngine.__new__(ReflectionEngine)
    engine.agent = NS(memory_hub=hub)
    item = proposal(p['id'], mid, quote)
    engine._apply_reflection_result({'people_updates': [item, item]})
    rows = hub.list_person_facts(p['id'])
    assert len(rows) == 1
    assert rows[0]['meta']['chat_message_id'] == mid
    assert rows[0]['meta']['evidence_quote'] == quote
    assert rows[0]['meta']['visibility'] == 'channel'


def test_nightly_uses_role_labelled_sources_not_first_person_diary(tmp_path):
    agent = offline_agent(tmp_path)
    hub = agent.memory_hub
    p = person(hub)
    human = evidence(hub)
    bot = evidence(hub, text='Я Нейра и живу в этом чате.', role='assistant')
    hub.add_diary_note('Я Нейра, живу в этом чате, считаю собеседника главным.', source='turn_diary',
        owner_id=UnifiedIdentityMapper.resolve_from_discord('123'), channel_id='shared', meta={'person_id': p['id']})
    config = {**agent.config, 'logging': {'chat_log': str(tmp_path / 'chat.log')},
        'memory': {**agent.config['memory'], 'reflection_json_path': str(tmp_path / 'reflection.json')}}
    engine = ReflectionEngine(config, agent)
    captured = []
    async def analyze(data, date):
        captured.extend(json.loads(line) for line in data.splitlines())
        return {'people_updates': [proposal(p['id'], human, 'Я изучаю Python'),
            proposal(p['id'], bot, 'Я Нейра и живу в этом чате.')], 'global_lore': [], 'behavior_rules': []}
    engine._analyze_diary_json = analyze
    asyncio.run(engine.reflect(force=True))
    assert {row['role'] for row in captured} == {'user', 'assistant'}
    assert all('считаю собеседника главным' not in row['text'] for row in captured)
    assert len(hub.list_person_facts(p['id'])) == 1
    hub.close()


def test_shared_history_and_private_history_cannot_cross_scope(hub):
    evidence(hub, text='public A', display_name='Author A')
    evidence(hub, '456', text='public B', display_name='Author B')
    evidence(hub, '456', text='foreign private', channel='private-B')
    evidence(hub, text='own private', channel='private-A')
    owner = UnifiedIdentityMapper.resolve_from_discord('123')
    builtins.set_turn_memory_scope(user_id=owner, channel_id='shared', shared_channel=True)
    result = builtins.recall_chat.func(user_id='forged', channel_id='private-B')
    assert 'public A' in result and 'public B' in result
    assert 'Author B' in result
    assert 'private' not in result
    builtins.set_turn_memory_scope(user_id=owner, channel_id='private-A')
    result = builtins.recall_chat.func(user_id=UnifiedIdentityMapper.resolve_from_discord('456'), channel_id='private-B')
    assert 'own private' in result and 'foreign private' not in result and 'public B' not in result
    builtins.clear_turn_memory_scope()
    assert 'unavailable' in builtins.recall_chat.func(channel_id='shared')


def test_history_time_window_is_utc_normalized_and_empty_is_not_denial(hub):
    evidence(hub, text='yesterday message', ts='2026-10-20T21:22:00+03:00')
    evidence(hub, text='today message', ts='2026-10-21T21:22:00+03:00')
    builtins.set_turn_memory_scope(user_id=UnifiedIdentityMapper.resolve_from_discord('123'), channel_id='shared', shared_channel=True)
    result = builtins.recall_chat.func(after='2026-10-20T00:00:00+03:00', before='2026-10-21T00:00:00+03:00')
    assert 'yesterday message' in result and 'today message' not in result
    assert 'does not establish' in builtins.recall_chat.func(offset=99)
    assert 'Invalid' in builtins.recall_chat.func(before='not a timestamp')


def test_parallel_history_scope_isolation(hub):
    evidence(hub, text='A')
    evidence(hub, '456', text='B')
    async def run_one(shared):
        builtins.set_turn_memory_scope(user_id=UnifiedIdentityMapper.resolve_from_discord('123'), channel_id='shared', shared_channel=shared)
        await asyncio.sleep(0)
        return builtins.recall_chat.func()
    async def run():
        return await asyncio.gather(run_one(True), run_one(False))
    shared, private = asyncio.run(run())
    assert ': B' in shared and ': B' not in private


def test_typed_mentions_only_resolve_existing_accounts_and_filter_private_facts(hub):
    a, b = person(hub), person(hub, '456')
    message = discord_message(uid='123')
    message.mentions = [NS(id=456, name='same', display_name='Same Name'), NS(id=987, name='unknown', display_name='Same Name')]
    context = context_from_message(message, '999')
    assert known_discord_mentions(hub, context) == [b['id']]
    hub.add_person_fact(b['id'], 'Public fact in this channel', meta={'visibility': 'channel', 'channel_id': context.channel.id})
    hub.add_person_fact(b['id'], 'Secret from private DM', meta={'visibility': 'private', 'channel_id': 'DM'})
    hub.add_person_fact(b['id'], 'Legacy fact without provenance')
    _, others = split_people_context(hub, [b['id']], 'same', '123', context.channel.id)
    assert 'Public fact in this channel' in others
    assert 'Secret from private DM' not in others and 'Legacy fact without provenance' not in others
    assert len(hub.list_people()) == 2


@pytest.mark.parametrize('guild', [False, True])
def test_chat_pipeline_binds_shared_scope_from_metadata(tmp_path, guild):
    agent = offline_agent(tmp_path)
    captured = []
    async def brain(**kwargs):
        captured.append(builtins._turn_history_shared.get())
        return 'Known facts.'
    agent._run_brain_tool_phase = brain
    context = context_from_message(discord_message(guild=guild), '999')
    account = person(agent.memory_hub, context.current_user.id)
    owner = UnifiedIdentityMapper.resolve_from_discord(context.current_user.id)
    agent.memory_hub.add_person_fact(account['id'], 'dm-profile-pipeline-sentinel', meta={'visibility': 'private', 'owner_id': owner})
    agent.config['memory']['pre_context'] = {'enabled': True, 'sources': ['wm'], 'inject_lane': 'both'}
    agent._read_working_memory_for_prompt = lambda uid: 'private-wm-pipeline-sentinel'
    asyncio.run(agent.chat('hello', discord_context=context))
    assert captured == [conversation_scope('owner', context.channel.id, context).kind == 'shared']
    talk_input = '\n'.join(str(message.content) for message in agent.llm_talk.messages[-1])
    assert ('dm-profile-pipeline-sentinel' in talk_input) is (not guild)
    assert ('private-wm-pipeline-sentinel' in talk_input) is (not guild)
    agent.memory_hub.close()


@pytest.mark.parametrize('text', [
    'https://tenor.com/view/funny-cat-12345',
    'https://giphy.com/gifs/music-play-stop-abc',
    'https://media.discordapp.net/attachments/1/2/reaction.mp4?x=1',
    'https://cdn.discordapp.com/attachments/1/2/a.gif',
    'https://imgur.com/a/abc',
    'музыка https://imgur.com/a/abc',
    'поставь реакцию на гифку', 'покажи гифку', 'мем про музыку',
    'не включай трек test', 'do not play song test',
    'включи https://tenor.com/view/abc',
    'https://example.test/path/stop', 'https://example.test/play-song',
    'https://[invalid',
])
def test_gif_urls_and_negations_cannot_reenter_classifier_music_path(text):
    plan = plan_music_route(text)
    assert finalize_music_route(plan, classifier_route='PLAY_MUSIC')[:2] == ('CHAT', False)


@pytest.mark.parametrize('text', ['play song test', 'включи трек test', 'https://youtu.be/abc123XYZ', 'пауза', 'join voice'])
def test_music_commands_survive_media_guard(text):
    plan = plan_music_route(text, has_media=True)
    route, use, _ = finalize_music_route(plan)
    assert route == 'PLAY_MUSIC' and use


def test_unsupported_media_is_rejected_before_voice_or_lavalink(monkeypatch):
    from modules.discord import music
    resolve = Mock(side_effect=AssertionError('must not access Discord'))
    monkeypatch.setattr(music, '_resolve_bot', resolve)
    service = NS(adapter=NS(connected=False, connect=AsyncMock()))
    result = asyncio.run(music._handle_action_async(NS(), service, 'music.play', {'query': 'https://giphy.com/gifs/cat'}))
    assert not result['ok'] and 'YouTube' in result['error']
    resolve.assert_not_called()
    service.adapter.connect.assert_not_called()


def test_person_tool_cannot_bypass_private_fact_filter(hub):
    a, b = person(hub), person(hub, '456')
    hub.add_person_fact(b['id'], 'Secret personal fact', meta={'visibility': 'private'})
    hub.add_person_fact(b['id'], 'Public channel fact', meta={'visibility': 'channel', 'channel_id': 'shared'})
    builtins.set_turn_memory_scope(user_id=UnifiedIdentityMapper.resolve_from_discord('123'), channel_id='shared', shared_channel=True)
    result = builtins.get_person_info.func(b['id'])
    assert 'Public channel fact' in result and 'Secret personal fact' not in result
    builtins.set_turn_memory_scope(user_id=UnifiedIdentityMapper.resolve_from_discord('456'), channel_id='private')
    assert 'Secret personal fact' in builtins.get_person_info.func(b['id'])


@pytest.mark.parametrize('transport', ['stdio', 'sse'])
def test_missing_mcp_sdk_is_not_reported_as_missing_executable(monkeypatch, transport):
    from core.runtime import mcp_client
    monkeypatch.setattr(mcp_client, '_HAS_MCP', False)
    manager = mcp_client.MCPClientManager({'mcp_client': {'enabled': True, 'servers': {'browsermcp': {'transport': transport, 'command': 'any', 'url': 'https://example.test/events'}}}})
    async def run():
        await manager.start()
        assert manager.last_errors()['browsermcp'] == 'missing MCP SDK'
        await manager._run_server_forever('browsermcp', manager._specs['browsermcp'])
        await asyncio.wait_for(manager._wait_for_sessions(10), timeout=.5)
    asyncio.run(run())
    assert manager._errors['browsermcp'] == 'missing MCP SDK'


@pytest.mark.parametrize('mode', ['fallback', 'failure', 'empty'])
def test_websearch_distinguishes_failure_and_does_not_claim_backend(monkeypatch, caplog, mode):
    import sys
    import logging
    class DDGS:
        def __enter__(self):
            return self
        def __exit__(self, *args):
            pass
        def text(self, query, **kwargs):
            if mode == 'failure':
                raise RuntimeError('query-secret should not be logged')
            if mode == 'empty':
                return []
            return [{'title': 'Result', 'body': 'Evidence', 'href': 'https://example.test/source'}]
    monkeypatch.setitem(sys.modules, 'ddgs', NS(DDGS=DDGS))
    monkeypatch.setattr(builtins, '_websearch_cooldown_until', {})
    monkeypatch.setattr(builtins, '_websearch_fail_count', {})
    with caplog.at_level(logging.DEBUG, logger='neyra.tools'):
        result = builtins.web_search.func('query-secret')
    if mode == 'failure':
        assert 'недоступен' in result
    elif mode == 'empty':
        assert 'Ничего не нашла' in result
    else:
        assert 'https://example.test/source' in result
        assert 'reported_backend=unknown' in caplog.text
    assert 'query-secret' not in caplog.text


@pytest.mark.parametrize('explicit_coder', [False, True])
def test_coder_uses_configured_gateway_and_never_openrouter(tmp_path, monkeypatch, explicit_coder):
    import httpx
    import uuid
    from core.plugins import builder
    key = uuid.uuid4().hex
    monkeypatch.setenv('AIHOPE_API_KEY', key)
    config = {'llm': {'brain_model': {'provider': 'aihope', 'model': 'brain-offline'},
        'providers': {'aihope': {'base_url': 'https://gateway.example.test/v1'}}}}
    if explicit_coder:
        config['llm']['coder_model'] = {'provider': 'aihope', 'model': 'coder-offline'}
    seen = []
    def reply(request):
        seen.append(request)
        generated = {'files': [{'path': 'main.py', 'content': 'def run(): return True\n'}, {'path': 'plugin.yaml', 'content': 'main_script: main.py\n'}]}
        return httpx.Response(200, json={'model': 'reported-coder', 'choices': [{'message': {'content': json.dumps(generated)}}]})
    factory = httpx.Client
    monkeypatch.setattr(builder.httpx, 'Client', lambda **kwargs: factory(transport=httpx.MockTransport(reply), **kwargs))
    monkeypatch.setattr(builder, '_repo_root', lambda: tmp_path)
    result = builder.create_or_edit_plugin_impl('diagnostic_demo', 'Create an offline test module', config=config)
    assert result['ok']
    assert str(seen[0].url) == 'https://gateway.example.test/v1/chat/completions'
    assert json.loads(seen[0].content)['model'] == ('coder-offline' if explicit_coder else 'brain-offline')
    assert (tmp_path / 'modules/diagnostic_demo/main.py').is_file()


def test_working_memory_provider_failure_keeps_snapshot_and_next_refresh_recovers(tmp_path, monkeypatch, caplog):
    from core.memory.working_memory import refresh_working_memory_async
    from core.llm import retry
    from langchain_core.messages import AIMessage
    import httpx
    agent = offline_agent(tmp_path)
    agent.config['memory']['working_memory'] = {'enabled': True}
    agent.memory_hub.save_wm_snapshot('Previous verified document', user_id='owner')
    async def failure(*args, **kwargs):
        raise httpx.HTTPStatusError('provider-body-private-sentinel', request=httpx.Request('POST', 'https://example.test/v1/chat/completions'), response=httpx.Response(502))
    monkeypatch.setattr(retry, 'ainvoke_with_rate_limit_backoff', failure)
    params = dict(root=tmp_path, internal_user_id='owner', user_message='test', assistant_text='reply', stm_tail='', speaker_label='Test', reason='offline')
    asyncio.run(refresh_working_memory_async(agent, agent.config, **params))
    assert agent.memory_hub.sqlite.latest_wm_snapshot(user_id='owner')['content'] == 'Previous verified document'
    assert 'provider-body-private-sentinel' not in caplog.text
    assert 'HTTPStatusError' in caplog.text
    async def success(*args, **kwargs):
        return AIMessage(content='Updated verified working-memory document. ' * 4)
    monkeypatch.setattr(retry, 'ainvoke_with_rate_limit_backoff', success)
    asyncio.run(refresh_working_memory_async(agent, agent.config, **params))
    assert 'Updated verified' in agent.memory_hub.sqlite.latest_wm_snapshot(user_id='owner')['content']
    agent.memory_hub.close()


def test_shared_channel_history_excludes_private_app_rows_with_same_channel_id(hub):
    evidence(hub, text='Real Discord public message')
    hub.append_chat(role='user', user_id='private-app-owner', channel_id='shared', text='Private app message', meta={'visibility': 'private'})
    hub.append_chat(role='user', user_id='legacy-owner', channel_id='shared', text='Legacy Discord public message', meta={'discord_id': '456'})
    builtins.set_turn_memory_scope(user_id=UnifiedIdentityMapper.resolve_from_discord('123'), channel_id='shared', shared_channel=True)
    result = builtins.recall_chat.func()
    assert 'Real Discord public message' in result and 'Legacy Discord public message' in result
    assert 'Private app message' not in result


def test_ambiguous_alias_does_not_override_account_or_explicit_uuid(hub):
    from core.agent.people_context import detect_mentioned_names
    a, b = person(hub), person(hub, '456')
    names = hub.get_all_names_map()
    assert 'same' not in names
    assert detect_mentioned_names('same', names) == []
    hub.upsert_person(b['id'], aliases=[a['id']])
    assert hub.get_all_names_map()[a['id']] == a['id']


def test_self_private_facts_hidden_in_shared_tools_and_active_context(hub):
    a = person(hub)
    owner = UnifiedIdentityMapper.resolve_from_discord('123')
    hub.add_person_fact(a['id'], 'DM private sentinel', meta={'owner_id': owner, 'visibility': 'private', 'channel_id': 'dm'})
    hub.add_person_fact(a['id'], 'Legacy self profile fact')
    builtins.set_turn_memory_scope(user_id=owner, channel_id='shared', shared_channel=True)
    assert 'DM private sentinel' not in builtins.get_person_info.func(a['id'])
    active, _ = split_people_context(hub, [], 'same', '123', 'shared', memory_owner_id=owner, shared_context=True)
    assert 'DM private sentinel' not in active and 'Legacy self profile fact' not in active
    builtins.set_turn_memory_scope(user_id=owner, channel_id='dm')
    private = builtins.get_person_info.func(a['id'])
    assert 'DM private sentinel' in private and 'Legacy self profile fact' in private


def test_private_notes_about_someone_else_belong_to_note_owner(hub):
    a, b = person(hub), person(hub, '456')
    owner = UnifiedIdentityMapper.resolve_from_discord('123')
    other = UnifiedIdentityMapper.resolve_from_discord('456')
    builtins.set_turn_memory_scope(user_id=owner, channel_id='dm-A')
    builtins.update_person_fact.func(b['id'], 'Private A note about B')
    assert 'Private A note about B' in builtins.get_person_info.func(b['id'])
    builtins.set_turn_memory_scope(user_id=other, channel_id='dm-B')
    assert 'Private A note about B' not in builtins.get_person_info.func(b['id'])
    builtins.set_turn_memory_scope(user_id=owner, channel_id='shared', shared_channel=True)
    assert 'Private A note about B' not in builtins.get_person_info.func(b['id'])


def test_nightly_unmapped_console_author_cannot_be_bound_by_display_name(hub):
    a = person(hub)
    mid = hub.append_chat(role='user', user_id=UnifiedIdentityMapper.resolve_console('same'), display_name='same', text='Я изучаю Python',
        meta={'username': 'same'}, source='local_voice')
    engine = ReflectionEngine.__new__(ReflectionEngine)
    engine.agent = NS(memory_hub=hub)
    assert engine._source_person_id(hub, hub.get_chat_message(mid)) is None
    engine._apply_reflection_result({'people_updates': [proposal(a['id'], mid, 'Я изучаю Python')]})
    assert not hub.list_person_facts(a['id'])


@pytest.mark.parametrize('group_count', [1, 21])
def test_nightly_reports_bounded_rows_and_groups_without_message_text(hub, caplog, group_count):
    import logging
    person(hub)
    hub.append_chat_batch([dict(role='user', text='content-not-for-logs', user_id=UnifiedIdentityMapper.resolve_from_discord('123'),
        channel_id=f'channel-{i % group_count}', meta={'discord_id': '123'}) for i in range(510)])
    engine = ReflectionEngine.__new__(ReflectionEngine)
    engine.agent = NS(memory_hub=hub)
    with caplog.at_level(logging.INFO, logger='neyra.reflection'):
        groups = engine._durable_evidence_groups(hub)
    selected_rows = sum(len(data.splitlines()) for data, _ in groups)
    assert selected_rows < 510
    assert f'skipped_rows={510-selected_rows}' in caplog.text
    assert f'skipped_groups={max(0, group_count-20)}' in caplog.text
    assert 'content-not-for-logs' not in caplog.text


@pytest.mark.parametrize('text', ['поставь музыку из мема', 'включи Мемфис', 'play Memphis'])
def test_media_guard_preserves_explicit_music_names(text):
    assert resolve_music_route(text) == ('PLAY_MUSIC', True)


@pytest.mark.parametrize('fallback', [False, True])
def test_shared_semantic_search_excludes_owner_dm_and_foreign_channel(fallback):
    from core.memory.stores import LongTermMemory
    memory = LongTermMemory.__new__(LongTermMemory)
    memory.top_k = 10
    memory._init = lambda: None
    memory._embedder = NS(encode=lambda *args, **kwargs: NS(tolist=lambda: [1.0]))
    docs = ['own DM', 'foreign DM', 'shared knowledge', 'this channel', 'other channel', 'owned knowledge']
    metas = [{'user_id': 'owner', 'visibility': 'private'}, {'user_id': 'other', 'visibility': 'private'},
        {'type': 'knowledge'}, {'user_id': 'other', 'visibility': 'channel', 'channel_id': 'public'},
        {'user_id': 'owner', 'visibility': 'channel', 'channel_id': 'elsewhere'}, {'type': 'knowledge', 'user_id': 'owner'}]
    def query(**kwargs):
        if fallback and 'where' in kwargs:
            raise ValueError('where unsupported')
        return {'documents': [docs], 'metadatas': [metas]}
    memory._collection = NS(count=lambda: len(docs), query=query)
    assert memory.search('test', user_id='owner', shared_only=True, channel_id='public') == ['shared knowledge', 'this channel']
    assert memory.search('test', user_id='owner', shared_only=True, channel_id='') == []


def test_shared_search_tool_uses_channel_filter_and_tags_new_knowledge(hub, monkeypatch):
    captured = {}
    monkeypatch.setattr(hub, 'search_semantic', lambda query, **kwargs: captured.update(kwargs) or ['public evidence'])
    builtins.set_turn_memory_scope(user_id='owner', channel_id='public', shared_channel=True)
    assert 'public evidence' in builtins.search_memory.func('test', user_id='forged')
    assert captured == {'user_id': 'owner', 'shared_only': True, 'channel_id': 'public'}
    monkeypatch.setattr(hub, 'remember_knowledge', lambda text, metadata: (captured.update(metadata) or True, 'offline'))
    builtins.remember_knowledge.func('Public knowledge')
    assert captured['visibility'] == 'channel' and captured['channel_id'] == 'public'


def test_legacy_semantic_adapter_does_not_fallback_to_private_results(hub):
    hub.semantic = NS(rag_enabled=True, search=lambda query, n_results=None, user_id=None: ['private sentinel'])
    assert hub.search_semantic('test', user_id='owner', shared_only=True, channel_id='public') == []


@pytest.mark.parametrize('reader', ['summary', 'tool', 'prompt'])
def test_own_channel_facts_survive_private_recall_without_cross_channel_leaks(hub, reader):
    a = person(hub)
    owner = UnifiedIdentityMapper.resolve_from_discord('123')
    hub.add_person_fact(a['id'], 'Own channel fact sentinel',
        meta={'owner_id': owner, 'channel_id': 'channel-x', 'visibility': 'channel'})

    def read(channel, shared):
        if reader == 'summary':
            return hub.get_person_summary(a['id'], restrict_to_channel=True,
                public_channel_id=channel, private_owner_id=None if shared else owner)
        if reader == 'tool':
            builtins.set_turn_memory_scope(user_id=owner, channel_id=channel, shared_channel=shared)
            return builtins.get_person_info.func(a['id'])
        return split_people_context(hub, [], 'same', '123', channel,
            memory_owner_id=owner, shared_context=shared)[0]

    assert 'Own channel fact sentinel' in read('dm', False)
    assert 'Own channel fact sentinel' in read('channel-x', True)
    assert 'Own channel fact sentinel' not in read('channel-y', True)


def test_channel_note_about_someone_else_follows_note_owner_in_private(hub):
    a, b = person(hub), person(hub, '456')
    owner_a = UnifiedIdentityMapper.resolve_from_discord('123')
    owner_b = UnifiedIdentityMapper.resolve_from_discord('456')
    hub.add_person_fact(b['id'], 'A channel note about B sentinel',
        meta={'owner_id': owner_a, 'channel_id': 'channel-x', 'visibility': 'channel'})
    for owner, channel, shared, expected in [
        (owner_a, 'dm-a', False, True),
        (owner_b, 'dm-b', False, False),
        (owner_a, 'channel-x', True, True),
        (owner_b, 'channel-x', True, True),
        (owner_a, 'channel-y', True, False),
        (owner_b, 'channel-y', True, False),
    ]:
        builtins.set_turn_memory_scope(user_id=owner, channel_id=channel, shared_channel=shared)
        assert ('A channel note about B sentinel' in builtins.get_person_info.func(b['id'])) is expected


def test_legacy_channel_fact_visible_only_to_own_profile_in_private(hub):
    a, b = person(hub), person(hub, '456')
    owner_a = UnifiedIdentityMapper.resolve_from_discord('123')
    owner_b = UnifiedIdentityMapper.resolve_from_discord('456')
    hub.add_person_fact(a['id'], 'Legacy channel self fact sentinel',
        meta={'channel_id': 'channel-x', 'visibility': 'channel'})
    for owner, expected in [(owner_a, True), (owner_b, False)]:
        result = hub.get_person_summary(a['id'], restrict_to_channel=True,
            public_channel_id='dm', private_owner_id=owner)
        assert ('Legacy channel self fact sentinel' in result) is expected
