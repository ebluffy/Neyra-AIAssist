"""AR #29 hardening and persisted optional subsystem controls."""

import asyncio
import json
import threading
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
import yaml
from fastapi.testclient import TestClient

from core.api.app import build_app
from core.memory.affect import event_for
from core.memory.sqlite_store import SqliteStore
from core.runtime.config_loader import load_layered_config, load_layered_yaml, validate_config_schema
from core.runtime.features import FEATURE_DEFAULTS, feature_enabled
from offline_support import offline_agent, offline_config
from test_affect import hub, person, apply


@pytest.fixture
def api(tmp_path):
    agent = offline_agent(tmp_path)
    agent._setup_llm = MagicMock()
    app = build_app(agent.config, shared_agent=agent,
        shared_monitor=MagicMock(run_once=AsyncMock(return_value={"ok": True})),
        shared_backup_manager=MagicMock(), project_root=tmp_path)
    with TestClient(app) as client:
        yield agent, client, {"Authorization": "Bearer offline-admin-token"}
    agent.memory_hub.close()


@pytest.mark.parametrize("key", FEATURE_DEFAULTS)
def test_flags_persist_and_reload_without_llm_rebind(api, tmp_path, key):
    agent, client, headers = api
    original = client.get('/v1/config/runtime', headers=headers).json()['data']['values']
    expected = agent.config
    for part in key.split('.'):
        expected = expected.get(part, {}) if isinstance(expected, dict) else {}
    assert original[key] == (expected if isinstance(expected, bool) else FEATURE_DEFAULTS[key])
    result = client.post('/v1/config/update', headers=headers, json={'updates': {key: False}})
    assert result.status_code == 200, result.text
    assert result.json()['data']['llm_rebound'] is False
    agent._setup_llm.assert_not_called()
    if key == 'mcp_client.enabled':
        assert result.json()['data']['persisted'] == ['config/modules.yaml']
    loaded = load_layered_yaml(tmp_path)
    for part in key.split('.'):
        loaded = loaded[part]
    assert loaded is False
    assert client.get('/v1/config/runtime', headers=headers).json()['data']['values'][key] is False
    assert client.post('/v1/config/update', headers=headers, json={'updates': {key: True}}).status_code == 200


@pytest.mark.parametrize('bad', ['false', 0, None, [], {}])
def test_invalid_boolean_never_changes_disk_or_runtime(api, tmp_path, bad):
    agent, client, headers = api
    result = client.post('/v1/config/update', headers=headers, json={'updates': {'memory.mood.enabled': bad}})
    assert result.status_code == 400
    assert not (tmp_path / 'config' / 'memory.yaml').exists()
    assert 'mood' not in agent.config['memory']
    cfg = dict(agent.config, memory=dict(agent.config['memory'], mood={'enabled': bad}))
    assert any('memory.mood.enabled' in error for error in validate_config_schema(cfg))


OPTIONAL_FEATURE_PARENTS = sorted({key.rsplit('.', 1)[0] for key in FEATURE_DEFAULTS if key.count('.') == 2})


@pytest.mark.parametrize('parent', OPTIONAL_FEATURE_PARENTS)
def test_empty_optional_yaml_block_loads_with_feature_defaults(tmp_path, monkeypatch, parent):
    monkeypatch.delenv('NEYRA_DATA_DIR', raising=False)
    cfg = offline_config(tmp_path)
    section, block = parent.split('.')
    cfg[section][block] = None
    assert validate_config_schema(cfg) == []
    (tmp_path / 'config.yaml').write_text(yaml.safe_dump(cfg), encoding='utf-8')
    loaded = load_layered_config(tmp_path, validate=True)
    for key, default in FEATURE_DEFAULTS.items():
        if key.startswith(parent + '.'):
            assert feature_enabled(loaded, key) is default


@pytest.mark.parametrize('bad', [True, 'true', []])
def test_invalid_optional_parent_still_rejected(tmp_path, bad):
    cfg = offline_config(tmp_path)
    cfg['memory']['mood'] = bad
    assert 'memory.mood.enabled: parent must be a mapping' in validate_config_schema(cfg)


@pytest.mark.parametrize('key', FEATURE_DEFAULTS)
@pytest.mark.parametrize('bad', [None, 'true'])
def test_empty_or_quoted_boolean_leaf_still_rejected(tmp_path, key, bad):
    cfg = offline_config(tmp_path)
    target = cfg
    parts = key.split('.')
    for part in parts[:-1]:
        target = target.setdefault(part, {})
    target[parts[-1]] = bad
    assert f'{key}: expected boolean' in validate_config_schema(cfg)


@pytest.mark.parametrize('mood_on,relations_on', [(False, False), (False, True), (True, False), (True, True)])
def test_controls_really_stop_updates_and_talk_injection(tmp_path, mood_on, relations_on):
    agent = offline_agent(tmp_path)
    hub = agent.memory_hub
    pid = person(hub)
    async def run():
        await agent.chat('first', discord_user_id='123', channel_id='77')
        before = hub.affect.snapshot(pid)
        agent.config['memory'].update(mood={'enabled': mood_on}, relations={'enabled': relations_on})
        hub.invalidate_affect_turns()
        agent.llm_talk.messages.clear()
        await agent.chat('спасибо', discord_user_id='123', channel_id='77')
        after = hub.affect.snapshot(pid)
        assert (after['mood']['updated_at'] != before['mood']['updated_at']) == mood_on
        assert (after['relation']['updated_at'] != before['relation']['updated_at']) == relations_on
        blocks = [message.content for messages in agent.llm_talk.messages for message in messages
                  if isinstance(message.content, str) and message.content.startswith('[ASSISTANT STATE DATA]\n')]
        if mood_on or relations_on:
            data = json.loads(blocks[0].split('\n', 1)[1])
            assert ('mood' in data) == mood_on
            assert ('relation' in data) == relations_on
        else:
            assert not blocks
        agent.config['memory'].update(mood={'enabled': True}, relations={'enabled': True})
        hub.invalidate_affect_turns()
        await agent.chat('next', discord_user_id='123', channel_id='77')
        assert hub.affect.snapshot(pid)['relation']['updated_at'] != before['relation']['updated_at']
    try:
        asyncio.run(run())
    finally:
        hub.close()


def test_feature_toggle_invalidates_inflight_generation(api):
    agent, client, headers = api
    hub = agent.memory_hub
    old = hub.affect_generations()
    assert client.post('/v1/config/update', headers=headers, json={'updates': {'memory.mood.enabled': False}}).status_code == 200
    assert client.post('/v1/config/update', headers=headers, json={'updates': {'memory.mood.enabled': True}}).status_code == 200
    assert not hub.apply_affect_turn(turn_id='old', discord_id='123', text='спасибо', generations=old)


@pytest.mark.parametrize('text,code', [
    ('извини', 'apology'), ('извините пожалуйста', 'apology'), ('простите', 'apology'),
    ("you're stupid", 'insult'), ("you're useless", 'insult'), ('you’re stupid', 'insult'),
])
def test_common_cue_forms(text, code):
    assert event_for(text)[0] == code


def test_one_author_cannot_exhaust_global_mood_and_window_is_rolling(hub):
    pid = person(hub)
    person(hub, '456')
    now = datetime(2026, 1, 1, tzinfo=timezone.utc)
    hub.affect.clock = lambda: now
    for index in range(100):
        apply(hub, str(index), text='ты тупая')
    assert hub.affect.snapshot(pid)['mood']['valence'] == pytest.approx(-0.2)
    assert hub.affect.snapshot(pid)['relation']['affinity'] == -1
    apply(hub, 'other-person', '456', text='ты тупая')
    assert hub.affect.snapshot()['mood']['valence'] == pytest.approx(-0.3)
    now += timedelta(minutes=59)
    before = hub.affect.snapshot()['mood']['valence']
    apply(hub, 'before-hour', text='ты тупая')
    assert hub.affect.snapshot()['mood']['valence'] == pytest.approx(before)
    now += timedelta(minutes=2)
    before = hub.affect.snapshot()['mood']['valence']
    apply(hub, 'after-hour', text='ты тупая')
    assert hub.affect.snapshot()['mood']['valence'] == pytest.approx(before - 0.1)


def test_ledger_expires_old_turns_and_retains_fresh_duplicates(hub):
    person(hub)
    now = datetime(2026, 1, 1, tzinfo=timezone.utc)
    hub.affect.clock = lambda: now
    apply(hub, 'old')
    now += timedelta(days=31)
    apply(hub, 'fresh')
    assert not hub.affect.has_turn('old')
    assert hub.affect.has_turn('fresh')
    assert not apply(hub, 'fresh')
    assert [row[0] for row in hub.sqlite._conn.execute('SELECT turn_id FROM affect_turns')] == ['fresh']


def test_two_wipes_same_second_preserve_both_backups(hub, tmp_path, monkeypatch):
    import core.memory.hub as module
    monkeypatch.setattr(module, 'datetime', SimpleNamespace(utcnow=lambda: datetime(2026, 1, 1)))
    person(hub)
    apply(hub)
    first = hub.wipe(['mood'], backup_dir=tmp_path / 'backups')['backup']
    second = hub.wipe(['relations'], backup_dir=tmp_path / 'backups')['backup']
    assert first != second
    one, two = SqliteStore(first), SqliteStore(second)
    try:
        assert one._conn.execute('SELECT COUNT(*) FROM neyra_state').fetchone()[0] == 1
        assert two._conn.execute('SELECT COUNT(*) FROM neyra_state').fetchone()[0] == 0
        with pytest.raises(FileExistsError):
            hub.sqlite.backup_to(first)
        assert one._conn.execute('SELECT COUNT(*) FROM neyra_state').fetchone()[0] == 1
    finally:
        one.close()
        two.close()


def test_reset_audit_identifies_person_and_backup(api, monkeypatch):
    import core.api.app as module
    agent, client, headers = api
    pid = person(agent.memory_hub)
    rows = []
    monkeypatch.setattr(module, '_audit_file_append', lambda cfg, root, row: rows.append(row))
    result = client.post('/v1/memory/affect/reset', headers=headers, json={'scope': 'relations', 'person_id': pid, 'confirm': 'WIPE'})
    assert result.status_code == 200
    assert rows[-1]['person_id'] == pid
    assert rows[-1]['backup'] == result.json()['data']['backup']


def test_finalize_waiting_for_wipe_never_stalls_event_loop(tmp_path):
    from langchain_core.messages import AIMessage
    agent = offline_agent(tmp_path)
    hub = agent.memory_hub
    backup_started, release, apply_started, backup_done = (threading.Event() for _ in range(4))
    backup = hub.sqlite.backup_to
    apply_original = hub.apply_affect_turn
    def slow_backup(path):
        backup_started.set()
        release.wait(5)
        backup_done.set()
        backup(path)
    def blocked_apply(**kwargs):
        apply_started.set()
        return apply_original(**kwargs)
    hub.sqlite.backup_to = slow_backup
    hub.apply_affect_turn = blocked_apply
    async def run():
        ready, respond = asyncio.Event(), asyncio.Event()
        async def talk(messages):
            ready.set()
            await respond.wait()
            return AIMessage(content='offline answer')
        agent.llm_talk.ainvoke = talk
        turn = asyncio.create_task(agent.chat('спасибо', discord_user_id='123', channel_id='77'))
        await ready.wait()
        wipe = asyncio.create_task(asyncio.to_thread(hub.wipe, ['mood'], backup_dir=tmp_path / 'backups'))
        assert await asyncio.to_thread(backup_started.wait, 1)
        respond.set()
        try:
            assert await asyncio.to_thread(apply_started.wait, 1)
            await asyncio.sleep(0)
            assert not backup_done.is_set()
        finally:
            release.set()
            await wipe
            await turn
    try:
        asyncio.run(run())
    finally:
        release.set()
        hub.close()


def test_de_repeat_can_be_disabled_without_calling_model(tmp_path):
    agent = offline_agent(tmp_path)
    agent.config['agent']['de_repeat'] = {'enabled': False}
    try:
        assert asyncio.run(agent._de_repeat_reply('user', 'same answer')) == 'same answer'
        assert agent.llm_talk.messages == []
    finally:
        agent.memory_hub.close()


def test_scheduler_master_off_registers_no_jobs():
    from core.reflection.engine import ReflectionEngine
    engine = ReflectionEngine.__new__(ReflectionEngine)
    engine.config = {'memory': {'reflection_enabled': False}}
    assert engine.start_scheduler() is None


@pytest.mark.parametrize('enabled', [True, False])
def test_turn_diary_switch_stops_new_memory_model_work(tmp_path, enabled):
    agent = offline_agent(tmp_path)
    agent.config['memory']['diary_after_turn'] = enabled
    async def run():
        await agent.chat('message', discord_user_id='123', channel_id='77')
        await asyncio.gather(*list(getattr(agent, '_background_jobs', [])), return_exceptions=True)
        assert bool(agent.llm_memory.messages) == enabled
        assert bool(agent.memory_hub.list_diary_notes()) == enabled
    try:
        asyncio.run(run())
    finally:
        agent.memory_hub.close()


def test_rag_write_mode_applies_to_hub_without_restart(api):
    agent, client, headers = api
    result = client.post('/v1/config/update', headers=headers, json={'updates': {'memory.rag_write_mode': 'important_only'}})
    assert result.status_code == 200
    assert agent.memory_hub.rag_write_mode == 'important_only'
    assert client.post('/v1/config/update', headers=headers, json={'updates': {'memory.rag_write_mode': 'unknown'}}).status_code == 400
