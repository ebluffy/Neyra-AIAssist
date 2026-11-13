"""AR regressions at the trusted boundary and the real offline turn pipeline."""
import asyncio
import time
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from starlette.testclient import WebSocketDenialResponse

from core.agent.discord_context import context_from_message
from core.agent.turn_prep import prepare_turn
from core.api.app import build_app
from test_stage3a import discord_message
from test_web_identity import TEST_SECRET, claims, token, headers, identity_env, identity_hub
from tests.offline_support import offline_agent


@pytest.fixture
def real_api(tmp_path, api_config, stub_monitor, stub_backup):
    agent = offline_agent(tmp_path / 'agent')
    root = tmp_path / 'project'
    (root / 'logs').mkdir(parents=True)
    (root / 'modules').mkdir()
    app = build_app(api_config, shared_agent=agent, shared_monitor=stub_monitor,
                    shared_backup_manager=stub_backup, project_root=root)
    try:
        with TestClient(app, client=('127.0.0.1', 51000)) as http:
            yield http, agent
    finally:
        agent.memory_hub.close()


def test_discord_mention_does_not_replace_author_affect(tmp_path):
    agent = offline_agent(tmp_path / 'mentions')
    hub = agent.memory_hub
    author = hub.ensure_person_for_account(platform='discord', platform_user_id='123')['id']
    mentioned = hub.ensure_person_for_account(platform='discord', platform_user_id='456')['id']
    context = context_from_message(discord_message(), '999')
    async def run():
        return await prepare_turn(agent, user_message='hello', username='same', discord_user_id='123',
            channel_id='77', vision_images=None, author_display_name=None, lyrics_marker='[GET_LYRICS]', discord_context=context)
    try:
        prep = asyncio.run(run())
        assert prep.affect_data['relation']['person_id'] == author
        assert prep.affect_data['relation']['person_id'] != mentioned
    finally:
        hub.close()


@pytest.mark.parametrize('path', ['short', 'long', 'people', 'diary', 'journal', 'affect', 'stats', 'policies', 'people/duplicates', 'people/merge-log', 'people/merge-proposals', 'people/not-my-id', 'unrecognised-future-route'])
def test_web_user_cannot_read_unscoped_memory(client, auth_headers, path):
    response = client.get('/v1/memory/' + path, headers=headers(auth_headers, role='admin'))
    assert response.status_code == 403
    assert response.json()['error']['code'] == 'web_memory_forbidden'


def test_web_user_only_reads_exact_own_card(real_api, auth_headers):
    http, agent = real_api
    hub = agent.memory_hub
    me = http.get('/v1/web/me', headers=headers(auth_headers)).json()['data']['person_id']
    victim = hub.ensure_person_for_account(platform='discord', platform_user_id='victim')['id']
    hub.add_person_fact(victim, 'VICTIM_PRIVATE_FACT')
    assert http.get('/v1/memory/people/' + me, headers=headers(auth_headers)).status_code == 200
    response = http.get('/v1/memory/people/' + victim, headers=headers(auth_headers))
    assert response.status_code == 403
    assert 'VICTIM_PRIVATE_FACT' not in response.text
    assert http.patch('/v1/memory/people/' + me, json={'names':['attack']}, headers=headers(auth_headers, role='admin')).status_code == 403
    # Admin JWT retains the existing privileged listing, as does a legacy API caller.
    assert http.get('/v1/memory/people', headers=headers(auth_headers, token(claims(role='admin')))).status_code == 200
    assert http.get('/v1/memory/people', headers=auth_headers['maint']).status_code == 200


def test_merged_account_uses_survivor_for_me_turn_and_diary(real_api, auth_headers):
    http, agent = real_api
    hub = agent.memory_hub
    source = hub.ensure_person_for_account(platform='web', platform_user_id='web-user-1')['id']
    survivor = hub.ensure_person_for_account(platform='discord', platform_user_id='survivor')['id']
    hub.merge_people(survivor, source)
    response = http.get('/v1/web/me', headers=headers(auth_headers))
    assert response.json()['data']['person_id'] == survivor
    agent.config['memory']['diary_after_turn'] = True
    result = http.post('/v1/chat', json={'text':'спасибо', 'channel_id':'merge-chat'}, headers=headers(auth_headers, role='admin'))
    assert result.status_code == 200
    assert hub.get_person(source) is None
    assert hub.list_chat(user_id=survivor)
    deadline = time.monotonic() + 2
    while not hub.list_diary_notes(owner_id=survivor) and time.monotonic() < deadline:
        time.sleep(.01)
    notes = hub.list_diary_notes(owner_id=survivor)
    assert notes and notes[0]['meta']['person_id'] == survivor
    assert not hub.list_diary_notes(owner_id=source)
    assert http.get('/v1/memory/people/' + survivor, headers=headers(auth_headers)).status_code == 200
    assert http.get('/v1/memory/people/' + source, headers=headers(auth_headers)).status_code == 403
    assert hub.affect_snapshot(survivor)['relation']['observed']


def test_second_identity_request_does_not_write_or_overwrite_name(real_api, auth_headers):
    http, agent = real_api
    hub = agent.memory_hub
    first = http.get('/v1/web/me', headers=headers(auth_headers))
    pid = first.json()['data']['person_id']
    hub.upsert_person(pid, display_name='Admin-chosen name')
    with patch.object(hub.sqlite, 'upsert_person_account', wraps=hub.sqlite.upsert_person_account) as writes:
        assert http.get('/v1/web/me', headers=headers(auth_headers, token(claims(name='JWT changed name')))).status_code == 200
        assert writes.call_count == 0
    assert hub.sqlite.get_person(pid)['display_name'] == 'Admin-chosen name'


@pytest.mark.parametrize('transport', ['http', 'ws'])
def test_spoofed_platform_id_never_reaches_prompt_or_persistence(real_api, auth_headers, transport):
    http, agent = real_api
    hub = agent.memory_hub
    victim = hub.ensure_person_for_account(platform='discord', platform_user_id='victim-account', handle='Victim')['id']
    hub.add_person_fact(victim, 'VICTIM_PRIVATE_FACT')
    own = hub.ensure_person_for_account(platform='web', platform_user_id='web-user-1')['id']
    before = hub.affect_snapshot(victim)['relation']
    body = {'text':'спасибо', 'platform_user_id':'victim-account', 'username':'Victim', 'channel_id':'web-chat',
            'discord_context': context_from_message(discord_message(uid='victim-account'), '999').model_dump(mode='json')}
    with patch.object(hub, 'search_semantic', wraps=hub.search_semantic) as searches:
        if transport == 'http':
            response = http.post('/v1/chat', json=body, headers=headers(auth_headers, role='admin'))
            assert response.status_code == 200
        else:
            with http.websocket_connect('/v1/ws/chat', headers=headers(auth_headers, role='admin')) as socket:
                assert socket.receive_json()['type'] == 'hello'
                socket.send_json({'type':'chat', **body})
                while True:
                    event = socket.receive_json()
                    assert event['type'] != 'error', event
                    if event['type'] == 'done': break
        assert searches.call_args.kwargs['user_id'] == own
    rows = hub.list_chat(user_id=own)
    assert rows
    assert all(row['meta'].get('discord_id') != 'victim-account' for row in rows)
    assert 'victim-account' not in str(agent.short_memory.get_history())
    assert 'VICTIM_PRIVATE_FACT' not in str(agent.llm_talk.messages)
    assert 'victim-account' not in str(agent.llm_talk.messages)
    assert hub.affect_snapshot(victim)['relation'] == before


def test_31_byte_secret_rejected(client, auth_headers, monkeypatch):
    short = 'x' * 31
    monkeypatch.setenv('NEYRA_IDENTITY_JWT_SECRET', short)
    assert client.get('/v1/web/me', headers=headers(auth_headers, token(key=short))).status_code == 401


@pytest.mark.parametrize('issuer', [None, 'wrong-issuer'])
def test_issuer_is_required_and_checked(client, auth_headers, issuer):
    payload = claims()
    if issuer is None: payload.pop('iss')
    else: payload['iss'] = issuer
    assert client.get('/v1/web/me', headers=headers(auth_headers, token(payload))).status_code == 401


def test_identity_websocket_accepts_legacy_query_service_key(client, auth_headers):
    with client.websocket_connect('/v1/ws/chat?token=admin-secret-token-xxxxxxxx', headers={'X-Neyra-Identity': token()}) as socket:
        assert socket.receive_json()['type'] == 'hello'


def test_ws_storage_failure_returns_traceable_503(client, stub_agent, auth_headers):
    stub_agent.memory_hub = identity_hub()
    stub_agent.memory_hub.ensure_person_for_account.side_effect = RuntimeError('PRIVATE-storage-error')
    with pytest.raises(WebSocketDenialResponse) as error:
        with client.websocket_connect('/v1/ws/chat', headers=headers(auth_headers, role='admin')):
            pass
    response = error.value
    assert response.status_code == 503
    payload = response.json()
    assert payload['error']['code'] == 'identity_storage_unavailable'
    assert payload['trace_id'] == response.headers['x-trace-id']
    assert 'PRIVATE-storage-error' not in response.text


@pytest.mark.parametrize('secret', ['x' * 32, 'я' * 16])
def test_secret_minimum_is_utf8_bytes(client, auth_headers, monkeypatch, secret):
    monkeypatch.setenv('NEYRA_IDENTITY_JWT_SECRET', secret)
    assert client.get('/v1/web/me', headers=headers(auth_headers, token(key=secret))).status_code == 200


def test_missing_issuer_configuration_is_fail_closed(client, auth_headers, monkeypatch):
    monkeypatch.delenv('NEYRA_IDENTITY_JWT_ISSUER')
    assert client.get('/v1/web/me', headers=headers(auth_headers)).status_code == 401
    assert client.get('/v1/meta', headers=auth_headers['viewer']).status_code == 200


def test_ws_storage_failure_without_denial_extension(app, stub_agent, auth_headers):
    stub_agent.memory_hub = identity_hub()
    stub_agent.memory_hub.ensure_person_for_account.side_effect = RuntimeError('PRIVATE-storage-error')
    sent = []
    scope = {'type':'websocket', 'asgi':{'version':'3.0'}, 'scheme':'ws', 'path':'/v1/ws/chat',
             'query_string':b'', 'root_path':'', 'client':('127.0.0.1', 51001), 'server':('test',80),
             'headers':[(k.lower().encode(), v.encode()) for k,v in headers(auth_headers, role='admin').items()],
             'subprotocols':[], 'extensions':{}}
    async def receive(): return {'type':'websocket.connect'}
    async def send(message): sent.append(message)
    asyncio.run(app(scope, receive, send))
    assert sent == [{'type':'websocket.close', 'code':1011, 'reason':''}]
    assert 'PRIVATE-storage-error' not in str(sent)


def test_mounted_api_cannot_bypass_default_memory_deny(app, stub_agent, auth_headers):
    from fastapi import FastAPI
    outer = FastAPI()
    outer.mount('/core', app)
    stub_agent.memory_hub = identity_hub()
    with TestClient(outer, client=('127.0.0.1', 51002)) as http:
        response = http.get('/core/v1/memory/long', headers=headers(auth_headers))
        assert response.status_code == 403
        assert response.json()['error']['code'] == 'web_memory_forbidden'
