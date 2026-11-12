"""Web JWT boundary and real API request paths; no network/LLM/database."""
import time
from unittest.mock import MagicMock

import jwt
import pytest

from core.runtime.identity import UnifiedIdentityMapper

# Public fixture key only; never read the host's actual signing configuration.
TEST_SECRET = 'web-identity-test-fixture-not-a-real-secret-000000000000000000000000'


def claims(**changes):
    now = int(time.time())
    return {"sub": "web-user-1", "role": "user", "name": "Тест", "chat_id": "chat-1",
            "message_id": "message-1", "task": "chat", "iat": now, "exp": now + 60, **changes}


def token(payload=None, *, key=TEST_SECRET, algorithm='HS256'):
    return jwt.encode(claims() if payload is None else payload, key, algorithm=algorithm)


@pytest.fixture(autouse=True)
def identity_env(monkeypatch):
    monkeypatch.setenv('NEYRA_IDENTITY_JWT_SECRET', TEST_SECRET)


def headers(auth_headers, signed=None, role='maint'):
    return {**auth_headers[role], 'X-Neyra-Identity': token() if signed is None else signed}


def test_me_uses_production_mapper(client, auth_headers):
    response = client.get('/v1/web/me', headers=headers(auth_headers))
    assert response.status_code == 200
    assert response.json()['data'] == {
        'person_id': UnifiedIdentityMapper.resolve('web', 'web-user-1'),
        'role': 'user', 'name': 'Тест', 'user_id': 'web-user-1',
    }


@pytest.mark.parametrize('change', [
    {'iat': 1, 'exp': 61}, {'iat': int(time.time()) + 120, 'exp': int(time.time()) + 180},
    {'sub': ''}, {'sub': '   '}, {'sub': 123}, {'role': 'owner'}, {'name': []},
    {'iat': True}, {'iat': '10'}, {'exp': str(int(time.time()) + 60)},
    {'exp': int(time.time()) + 3600}, {'exp': int(time.time()), 'iat': int(time.time())},
])
def test_invalid_claims_are_401(client, auth_headers, change):
    response = client.get('/v1/web/me', headers=headers(auth_headers, token(claims(**change))))
    assert response.status_code == 401
    assert response.json()['error']['code'] == 'invalid_web_identity'


@pytest.mark.parametrize('missing', ['sub', 'iat', 'exp', 'role', 'name'])
def test_required_claims(client, auth_headers, missing):
    payload = claims()
    del payload[missing]
    assert client.get('/v1/web/me', headers=headers(auth_headers, token(payload))).status_code == 401


@pytest.mark.parametrize('bad', [
    lambda: token(key='different-test-secret-0000000000000000000000000000000000000000000000'),
    lambda: token(key=None, algorithm='none'), lambda: token(algorithm='HS512'),
    lambda: 'not-a-jwt', lambda: '', lambda: 'a' * 8193,
])
def test_bad_signature_algorithm_or_encoding(client, auth_headers, bad):
    response = client.get('/v1/meta', headers=headers(auth_headers, bad()))
    assert response.status_code == 401
    assert TEST_SECRET not in response.text


def test_missing_secret_fails_closed_only_for_identity(client, auth_headers, monkeypatch):
    monkeypatch.delenv('NEYRA_IDENTITY_JWT_SECRET')
    assert client.get('/v1/web/me', headers=headers(auth_headers)).status_code == 401
    assert client.get('/v1/meta', headers=auth_headers['viewer']).status_code == 200


def test_me_requires_both_identity_and_bearer(client, auth_headers):
    assert client.get('/v1/web/me', headers=auth_headers['maint']).status_code == 401
    assert client.get('/v1/web/me', headers={'X-Neyra-Identity': token()}).status_code == 401
    assert client.get('/v1/web/me', headers={**headers(auth_headers), 'Authorization': 'Bearer wrong'}).status_code == 401


def test_duplicate_identity_headers_rejected(client, auth_headers):
    h = list(auth_headers['maint'].items()) + [('X-Neyra-Identity', token()), ('X-Neyra-Identity', token())]
    assert client.get('/v1/web/me', headers=h).status_code == 401


def test_identity_does_not_elevate_api_token_role(client, auth_headers):
    response = client.post('/v1/memory/search', json={'query': 'test'}, headers=headers(auth_headers, token(claims(role='admin')), role='viewer'))
    assert response.status_code == 403


@pytest.mark.parametrize('use_hub', [True, False])
@pytest.mark.parametrize('supplied', ['victim-id', None])
def test_semantic_search_cannot_spoof_owner(client, auth_headers, stub_agent, use_hub, supplied):
    hub = MagicMock()
    hub.search_semantic.return_value = []
    stub_agent.memory_hub = hub if use_hub else None
    stub_agent.long_memory.search.return_value = []
    body = {'query': 'needle', 'top_k': 2}
    if supplied is not None:
        body['user_id'] = supplied
    response = client.post('/v1/memory/search', json=body, headers=headers(auth_headers))
    assert response.status_code == 200
    expected = UnifiedIdentityMapper.resolve('web', 'web-user-1')
    search = hub.search_semantic if use_hub else stub_agent.long_memory.search
    search.assert_called_once_with('needle', n_results=2, user_id=expected)
    assert response.json()['data']['user_id'] == expected


@pytest.mark.parametrize('supplied', ['victim-id', None])
def test_chat_recall_forces_owner_even_with_other_channel(client, auth_headers, stub_agent, supplied):
    hub = stub_agent.memory_hub = MagicMock()
    hub.list_chat.return_value = []
    body = {'channel_id': 'other-channel', 'limit': 3, 'offset': 2, 'newest_first': False}
    if supplied is not None:
        body['user_id'] = supplied
    response = client.post('/v1/memory/chat/recall', json=body, headers=headers(auth_headers))
    assert response.status_code == 200
    hub.list_chat.assert_called_once_with(user_id=UnifiedIdentityMapper.resolve('web', 'web-user-1'),
                                         channel_id='other-channel', limit=3, offset=2, newest_first=False)


def test_absent_identity_preserves_legacy_memory_filters(client, auth_headers, stub_agent):
    hub = stub_agent.memory_hub = MagicMock()
    hub.search_semantic.return_value = []
    hub.list_chat.return_value = []
    h = auth_headers['maint']
    assert client.post('/v1/memory/search', json={'query': 'q', 'user_id': 'legacy-id'}, headers=h).status_code == 200
    hub.search_semantic.assert_called_once_with('q', n_results=3, user_id='legacy-id')
    assert client.post('/v1/memory/search', json={'query': 'q'}, headers=h).status_code == 400
    assert client.post('/v1/memory/chat/recall', json={'channel_id': 'legacy-channel'}, headers=h).status_code == 200
    assert hub.list_chat.call_args.kwargs['user_id'] is None
    assert hub.list_chat.call_args.kwargs['channel_id'] == 'legacy-channel'


def test_bad_identity_stops_memory_before_backend(client, auth_headers, stub_agent):
    hub = stub_agent.memory_hub = MagicMock()
    response = client.post('/v1/memory/search', json={'query': 'q', 'user_id': 'victim'}, headers=headers(auth_headers, 'broken'))
    assert response.status_code == 401
    hub.search_semantic.assert_not_called()


def test_websocket_invalid_identity_denies_handshake(client, auth_headers):
    from starlette.testclient import WebSocketDenialResponse
    with pytest.raises(WebSocketDenialResponse) as error:
        with client.websocket_connect('/v1/ws/chat', headers=headers(auth_headers, 'broken')):
            pass
    assert error.value.status_code == 401


@pytest.mark.parametrize('with_identity', [False, True])
def test_websocket_legacy_and_signed_identity_keep_protocol(client, auth_headers, with_identity):
    h = headers(auth_headers, role='admin') if with_identity else auth_headers['admin']
    with client.websocket_connect('/v1/ws/chat', headers=h) as socket:
        hello = socket.receive_json()
        assert hello['type'] == 'hello'
        assert hello['protocol'] == 'neyra.ws.chat.v1'
        socket.send_json({'type': 'ping'})
        assert socket.receive_json()['type'] == 'pong'


def test_identity_cannot_use_anonymous_console_exception(client, api_config, auth_headers):
    for key in ['token', 'viewer_token', 'maint_token']:
        api_config['api'][key] = ''
    assert client.get('/v1/meta').status_code == 200
    assert client.get('/v1/web/me', headers=headers(auth_headers)).status_code == 401


def test_signed_identity_wins_over_platform_fallback():
    """Память веб-пользователя идёт по person_id из подписанного токена."""
    from types import SimpleNamespace

    from core.neyra import NeyraAgent
    from core.runtime.identity import UnifiedIdentityMapper

    stub = SimpleNamespace(identity=UnifiedIdentityMapper)
    resolve = NeyraAgent._resolve_internal_user_id.__get__(stub, NeyraAgent)
    person = "11111111-1111-4111-8111-111111111111"
    discord = UnifiedIdentityMapper.resolve_from_discord("discord-42")
    assert resolve("discord-42", "someone") == discord
    assert resolve("discord-42", "someone", person) == person


def test_web_identity_owner_reaches_turn_prep(tmp_path):
    """prepare_turn не перезаписывает доверенного владельца discord/console-id."""
    import asyncio

    from core.agent.model_trace import ACTIVE_TRACE, TurnTrace
    from core.agent.turn_prep import prepare_turn
    from core.runtime.identity import UnifiedIdentityMapper
    from tests.offline_support import offline_agent

    agent = offline_agent(tmp_path / "web-owner")
    person = UnifiedIdentityMapper.resolve("web", "site-user-1")

    async def run():
        trace = TurnTrace(None, "chat-1", agent.config)
        token = ACTIVE_TRACE.set(trace)
        try:
            prep = await prepare_turn(
                agent,
                user_message="привет",
                username="web@example.com",
                discord_user_id=None,
                channel_id="chat-1",
                vision_images=None,
                author_display_name=None,
                lyrics_marker="[GET_LYRICS]",
                person_id=person,
            )
        finally:
            ACTIVE_TRACE.reset(token)
        assert prep.internal_uid == person
        assert trace.memory_owner_id == person

    try:
        asyncio.run(run())
    finally:
        agent.memory_hub.close()
