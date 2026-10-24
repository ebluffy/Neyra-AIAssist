"""Automatic memory writes cannot create nickname cards or revive merged identities."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace as NS
from unittest.mock import AsyncMock

import pytest

from core.memory.hub import MemoryHub
from core.memory.stores import PeopleDB
from core.reflection.engine import ReflectionEngine
from core.tools import builtins
from offline_support import offline_agent


@pytest.fixture
def people(tmp_path, monkeypatch):
    hub = MemoryHub({'memory': {'sqlite_path': str(tmp_path / 'hub.db'), 'rag_enabled': False}})
    db = PeopleDB({})
    db.memory_hub = hub
    monkeypatch.setattr(builtins, '_memory_hub', hub)
    monkeypatch.setattr(builtins, '_people_db', db)
    yield hub, db
    hub.close()


def account(hub, uid='123', handle='oldnick', display='Name'):
    return hub.ensure_person_for_account(platform='discord', platform_user_id=uid,
        handle=handle, display_name=display, avatar_url='https://cdn.discordapp.com/avatars/test.png')


def test_unknown_tool_identity_never_creates_slug_or_uuid(people):
    hub, _ = people
    account(hub)
    for hint in ['someone-new', 'Name-misspelling', '999999', '11111111-1111-4111-8111-111111111111']:
        result = builtins.update_person_fact.func(hint, 'Likes tea')
        assert 'не создаёт людей' in result
    assert len(hub.list_people()) == 1


def test_current_alias_resolves_without_duplicate_or_avatar_loss(people):
    hub, _ = people
    person = account(hub)
    assert 'Записала' in builtins.update_person_fact.func('oldnick', 'Likes tea')
    refreshed = account(hub, handle='newnick')
    assert person['id'] == refreshed['id']
    assert 'Записала' in builtins.update_person_fact.func('newnick', 'Likes coffee')
    assert len(hub.list_people()) == 1
    assert len(hub.list_person_facts(person['id'])) == 2
    assert hub.sqlite.get_account('discord', '123')['avatar_url'].endswith('test.png')


def test_ambiguous_names_never_choose_first_person(people):
    hub, _ = people
    a = account(hub, '123', 'same', 'Same Name')
    b = account(hub, '456', 'same', 'Same Name')
    assert hub.find_person('same') is None
    assert 'не создаёт людей' in builtins.update_person_fact.func('same', 'Ambiguous fact')
    assert 'Записала' in builtins.update_person_fact.func(a['id'], 'Exact fact')
    assert not hub.list_person_facts(b['id'])
    assert len(hub.list_people()) == 2


def test_stale_cache_after_merge_cannot_recreate_source(people):
    hub, db = people
    target = account(hub)
    hub.upsert_person('oldnick', aliases=['oldnick'], display_name='Legacy nick')
    db.hydrate_from_hub(hub)
    merge = hub.merge_people(target['id'], 'oldnick')
    assert 'oldnick' in db._cache
    assert db.update_fact('oldnick', 'Late background fact') is False
    assert 'Записала' in builtins.update_person_fact.func('oldnick', 'Current fact')
    assert hub.get_person('oldnick') is None
    assert len(hub.list_people()) == 1
    assert hub.sqlite.get_account('discord', '123')['person_id'] == target['id']
    assert hub.sqlite.get_account('discord', '123')['avatar_url']
    hub.undo_merge(merge['merge_log_id'])
    assert hub.get_person('oldnick') is not None


def test_reflection_skips_old_id_after_merge(people):
    hub, db = people
    target = account(hub)
    hub.upsert_person('legacy', aliases=['legacy'])
    hub.merge_people(target['id'], 'legacy')
    engine = ReflectionEngine.__new__(ReflectionEngine)
    engine.agent = NS(memory_hub=hub, people_db=db)
    engine._is_high_signal_fact = lambda fact: True
    engine._apply_reflection_result({'people_updates': [{'person_hint': 'legacy', 'fact': 'Likes coffee'}]})
    assert hub.get_person('legacy') is None


def test_atomic_account_refresh_after_merge_keeps_survivor(people):
    hub, _ = people
    source = account(hub)
    target = account(hub, '456', 'other')
    hub.merge_people(target['id'], source['id'])
    with ThreadPoolExecutor(4) as pool:
        rows = list(pool.map(lambda _: account(hub), range(20)))
    assert {p['id'] for p in rows} == {target['id']}
    assert len(hub.list_people()) == 1
    assert hub.get_person(source['id']) is None


@pytest.mark.parametrize('guild', [False, True])
def test_real_discord_turns_rename_and_reflection_keep_one_person(tmp_path, monkeypatch, guild):
    from test_stage3a import discord_message
    from core.agent.discord_context import context_from_message
    agent = offline_agent(tmp_path)
    db = PeopleDB({}); db.memory_hub = agent.memory_hub; agent.people_db = db
    monkeypatch.setattr(builtins, '_memory_hub', agent.memory_hub)
    monkeypatch.setattr(builtins, '_people_db', db)
    async def brain(**kwargs):
        assert 'не создаёт людей' in builtins.update_person_fact.func('misspelled-identity', 'Unsupported identity')
        person = agent.memory_hub.find_person('', discord_id='123')
        assert 'Записала' in builtins.update_person_fact.func(person['id'], 'Likes tea')
        return 'A verified fact was saved.'
    agent._run_brain_tool_phase = brain
    async def run():
        ctx = context_from_message(discord_message(uid='123', guild=guild), '999')
        await agent.chat('hello', discord_context=ctx, avatar_url='https://cdn.discordapp.com/avatar.png')
        renamed = ctx.model_copy(update={'current_user': ctx.current_user.model_copy(update={'handle': 'renamed', 'display_name': 'Renamed'})})
        await agent.chat('I study programming', discord_context=renamed)
        people = agent.memory_hub.list_people()
        assert len(people) == 1
        record = agent.memory_hub.sqlite.get_account('discord', '123')
        assert record['avatar_url'] == 'https://cdn.discordapp.com/avatar.png'
        assert record['handle'] == 'renamed'
        engine = ReflectionEngine.__new__(ReflectionEngine); engine.agent = agent
        engine._is_high_signal_fact = lambda fact: True
        source = next(row for row in agent.memory_hub.list_chat() if row['role'] == 'user')
        engine._apply_reflection_result({'people_updates': [{'person_hint': people[0]['id'], 'fact': 'Studies programming',
            'source_message_id': source['id'], 'evidence_quote': 'I study programming'},
            {'person_hint': 'renamed', 'fact': 'Cannot guess an ID', 'source_message_id': source['id'], 'evidence_quote': 'I study programming'}]})
        assert len(agent.memory_hub.list_people()) == 1
        assert len(agent.memory_hub.list_person_facts(people[0]['id'])) == 3
    asyncio.run(run())
    agent.memory_hub.close()


def test_known_discord_id_is_resolved_as_account_not_new_person(people):
    hub, _ = people
    person = account(hub)
    assert 'Записала' in builtins.update_person_fact.func('123', 'Likes music')
    assert len(hub.list_people()) == 1
    assert len(hub.list_person_facts(person['id'])) == 1


def test_merge_between_tool_lookup_and_write_does_not_revive_source(people, monkeypatch):
    hub, _ = people
    a = account(hub)
    b = account(hub, '456', 'other')
    original = hub.add_person_fact
    def raced(*args, **kwargs):
        hub.merge_people(b['id'], a['id'])
        return original(*args, **kwargs)
    monkeypatch.setattr(hub, 'add_person_fact', raced)
    assert 'объединена' in builtins.update_person_fact.func(a['id'], 'Late fact')
    assert hub.get_person(a['id']) is None and len(hub.list_people()) == 1


def test_merge_history_exposes_labels_without_full_private_snapshots(tmp_path):
    from fastapi.testclient import TestClient
    from unittest.mock import MagicMock
    from core.api.app import build_app
    agent = offline_agent(tmp_path)
    hub = agent.memory_hub
    a = account(hub, '123', 'alice', 'Alice')
    b = account(hub, '456', 'bob', 'Bob')
    hub.add_person_fact(b['id'], 'PRIVATE-SNAPSHOT-FACT')
    merge = hub.merge_people(a['id'], b['id'])
    app = build_app(agent.config, shared_agent=agent, shared_monitor=NS(start=lambda: None, run_once=AsyncMock()), shared_backup_manager=MagicMock(), project_root=tmp_path)
    headers = {'Authorization': 'Bearer offline-admin-token'}
    with TestClient(app) as client:
        assert client.get('/v1/memory/people/merge-log').status_code == 401
        response = client.get('/v1/memory/people/merge-log?limit=50', headers=headers)
        assert response.status_code == 200
        row = response.json()['data']['merges'][0]
        assert row['source_label'] == 'Bob' and row['survivor_label'] == 'Alice'
        assert 'PRIVATE-SNAPSHOT-FACT' not in response.text
        assert client.post(f"/v1/memory/people/merge/{merge['merge_log_id']}/undo", headers=headers, json={}).status_code == 200
        assert client.get('/v1/memory/people/merge-log', headers=headers).json()['data']['merges'][0]['undone_at']
    hub.close()
