"""Провайдеры LLM: свободные шлюзы, шифрованный vault и админ-API.

Offline: временный корень проекта, никаких сетевых вызовов. Проверяем, что
любой OpenAI-совместимый провайдер работает без правки пресетов, что ключ
ложится только в зашифрованный файл и что API не отдаёт секреты.
"""

import json
from pathlib import Path

import pytest

from test_web_identity_review import real_api  # noqa: F401  (fixture)

ADMIN = "admin"
RAW_KEY = "sk-local-test-0123456789abcdef"


# ── чистые помощники ─────────────────────────────────────────────────────
def test_provider_name_and_base_url_validation():
    from core.llm.provider_admin import (
        ProviderAdminError,
        normalize_provider_name,
        validate_base_url,
    )

    assert normalize_provider_name(" My-GPU_1 ") == "my-gpu_1"
    with pytest.raises(ProviderAdminError):
        normalize_provider_name("Провайдер")
    with pytest.raises(ProviderAdminError):
        normalize_provider_name("../etc/passwd")

    assert validate_base_url("http://192.168.1.10:8000/v1/") == "http://192.168.1.10:8000/v1"
    with pytest.raises(ProviderAdminError):
        validate_base_url("ftp://example.com")
    with pytest.raises(ProviderAdminError):
        validate_base_url("https://user:pass@example.com/v1")


def test_custom_provider_passes_resolution():
    """Провайдер без пресета работает, если у него есть base_url."""
    from core.llm.profile import resolve_openai_compatible_connection

    cfg = {
        "llm": {
            "talk_model": {"provider": "my-gpu", "model": "qwen3-32b"},
            "providers": {"my-gpu": {"base_url": "http://192.168.1.10:8000/v1"}},
        }
    }
    conn = resolve_openai_compatible_connection(cfg, role="talk_model")
    assert conn.base_url == "http://192.168.1.10:8000/v1"
    assert conn.provider == "my-gpu"


def test_unknown_provider_without_base_url_still_fails():
    from core.llm.profile import resolve_openai_compatible_connection

    cfg = {"llm": {"talk_model": {"provider": "ghost", "model": "x"}, "providers": {}}}
    with pytest.raises(ValueError):
        resolve_openai_compatible_connection(cfg, role="talk_model")


def test_provider_rows_report_key_source(tmp_path: Path, monkeypatch):
    from core.llm.provider_admin import provider_rows
    from core.llm.provider_secrets import store_for

    monkeypatch.delenv("MY_GPU_KEY", raising=False)
    cfg = {
        "llm": {
            "talk_model": {"provider": "my-gpu", "model": "qwen"},
            "providers": {
                "my-gpu": {"base_url": "http://127.0.0.1:8000/v1"},
                "from-env": {"base_url": "https://env.example/v1", "api_key_env": ["MY_GPU_KEY"]},
            },
        }
    }
    store_for(tmp_path).set("my-gpu", RAW_KEY)
    rows = {row["name"]: row for row in provider_rows(cfg, vault_names=store_for(tmp_path).names())}

    assert rows["my-gpu"]["has_key"] is True
    assert rows["my-gpu"]["key_source"] == "vault"
    assert rows["my-gpu"]["lanes"] == ["talk"]
    assert rows["from-env"]["has_key"] is False
    assert rows["my-gpu"]["base_url"] == "http://127.0.0.1:8000/v1"


# ── vault ────────────────────────────────────────────────────────────────
def test_vault_encrypts_and_roundtrips(tmp_path: Path):
    from core.llm.provider_secrets import store_for

    store = store_for(tmp_path)
    store.set("local", RAW_KEY)
    assert store.has("local")
    assert store.get("local") == RAW_KEY
    assert store.updated_at("local")

    raw = (tmp_path / "secrets" / "providers.json").read_text(encoding="utf-8")
    assert RAW_KEY not in raw
    assert json.loads(raw)["items"]["local"]["ct"]

    assert store.delete("local") is True
    assert store.get("local") == ""


def test_vault_rejects_empty_key(tmp_path: Path):
    from core.llm.provider_secrets import ProviderSecretsError, store_for

    with pytest.raises(ProviderSecretsError):
        store_for(tmp_path).set("local", "   ")


# ── API ──────────────────────────────────────────────────────────────────
def test_providers_api_requires_admin(client, auth_headers):
    assert client.get("/v1/providers").status_code == 401
    assert client.get("/v1/providers", headers=auth_headers["viewer"]).status_code == 403


def test_provider_create_update_delete(real_api, auth_headers):
    http, agent = real_api
    agent._setup_llm = lambda: None  # rebind без сети

    created = http.put(
        "/v1/providers/my-gpu",
        json={"base_url": "http://192.168.1.10:8000/v1", "kind": "local"},
        headers=auth_headers[ADMIN],
    )
    assert created.status_code == 200, created.text
    provider = created.json()["data"]["provider"]
    assert provider["name"] == "my-gpu"
    assert provider["base_url"] == "http://192.168.1.10:8000/v1"

    listed = http.get("/v1/providers", headers=auth_headers[ADMIN]).json()["data"]
    assert "my-gpu" in [row["name"] for row in listed["providers"]]
    assert any(preset["id"] == "openai" for preset in listed["presets"])

    secret = http.put(
        "/v1/providers/my-gpu/secret",
        json={"api_key": RAW_KEY},
        headers=auth_headers[ADMIN],
    )
    assert secret.status_code == 200, secret.text
    assert secret.json()["data"]["provider"]["has_key"] is True
    assert RAW_KEY not in json.dumps(secret.json())

    assert http.delete("/v1/providers/my-gpu", headers=auth_headers[ADMIN]).status_code == 200
    assert "my-gpu" not in [row["name"] for row in http.get("/v1/providers", headers=auth_headers[ADMIN]).json()["data"]["providers"]]


def test_provider_delete_blocked_when_lane_uses_it(real_api, auth_headers):
    http, agent = real_api
    agent._setup_llm = lambda: None
    http.put(
        "/v1/providers/busy",
        json={"base_url": "http://127.0.0.1:9999/v1"},
        headers=auth_headers[ADMIN],
    )
    switched = http.put(
        "/v1/config",
        json={"updates": {"llm.talk_model.provider": "busy", "llm.talk_model.model": "qwen3"}},
        headers=auth_headers[ADMIN],
    )
    assert switched.status_code == 200, switched.text

    blocked = http.delete("/v1/providers/busy", headers=auth_headers[ADMIN])
    assert blocked.status_code == 409
    assert blocked.json()["error"]["code"] == "provider_in_use"


def test_provider_secret_validation(real_api, auth_headers):
    http, agent = real_api
    agent._setup_llm = lambda: None
    http.put("/v1/providers/k", json={"base_url": "http://127.0.0.1:1/v1"}, headers=auth_headers[ADMIN])

    short = http.put("/v1/providers/k/secret", json={"api_key": "x"}, headers=auth_headers[ADMIN])
    assert short.status_code == 400
    removed = http.delete("/v1/providers/k/secret", headers=auth_headers[ADMIN])
    assert removed.status_code == 200


def test_private_endpoint_detection():
    from core.llm.profile import is_private_endpoint

    for url in (
        "http://127.0.0.1:11434/v1",
        "http://192.168.1.5:8000/v1",
        "http://100.121.199.40:11435/v1",
        "http://laptop.local:1234/v1",
        "http://host.tailnet.ts.net:1/v1",
        "http://localhost:8080/v1",
    ):
        assert is_private_endpoint(url), url
    for url in ("https://api.openai.com/v1", "https://openrouter.ai/api/v1", ""):
        assert not is_private_endpoint(url), url


def test_local_provider_without_key_gets_placeholder():
    """Локальный шлюз без ключа не должен валить ядро Missing credentials."""
    from core.llm.profile import resolve_openai_compatible_connection

    cfg = {
        "llm": {
            "talk_model": {"provider": "llama", "model": "qwen3"},
            "providers": {"llama": {"base_url": "http://100.121.199.40:11435/v1", "kind": "local"}},
        }
    }
    conn = resolve_openai_compatible_connection(cfg, role="talk_model")
    assert conn.api_key == "local"


def test_remote_provider_without_key_keeps_core_alive():
    from core.llm.profile import resolve_openai_compatible_connection

    cfg = {
        "llm": {
            "talk_model": {"provider": "remote", "model": "x"},
            "providers": {"remote": {"base_url": "https://gateway.example/v1"}},
        }
    }
    conn = resolve_openai_compatible_connection(cfg, role="talk_model")
    assert conn.api_key == "missing-api-key"
