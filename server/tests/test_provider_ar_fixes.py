"""Регрессии AR по PR #75: SSRF/probe, ключ при смене URL, vault/bak, CLI."""

from __future__ import annotations

import http.server
import json
import os
import socket
import threading
from pathlib import Path

import pytest

from test_web_identity_review import real_api  # noqa: F401  (fixture)

from core.llm.provider_admin import ProviderAdminError, validate_base_url
from core.llm.provider_secrets import ProviderSecretStore, ProviderSecretsError
from core.runtime.config_loader import (
    persist_allowlisted_updates,
    persist_dotted_removals,
    scrub_layer_backups,
)

ADMIN = "admin"
RAW_KEY = "sk-ar-test-0123456789abcdef"  # gitleaks:allow


# ── AR-7: SSRF и редиректы ───────────────────────────────────────────────
def test_metadata_and_link_local_base_urls_are_rejected():
    for url in (
        "http://169.254.169.254/latest/meta-data",
        "http://[fd00:ec2::254]/latest",
        "http://[fe80::1]/v1",
        "http://metadata.google.internal/computeMetadata/v1",
        "http://instance-data/latest",
        "http://2852039166/latest",
        "http://0xa9fea9fe/latest",
    ):
        with pytest.raises(ProviderAdminError):
            validate_base_url(url)
    for url in (
        "http://127.0.0.1:11434/v1",
        "http://192.168.1.10:8000/v1",
        "https://api.openai.com/v1",
        "http://100.121.199.40:11435/v1",
    ):
        assert validate_base_url(url) == url.rstrip("/")


def test_probe_rejects_dns_resolving_to_metadata(monkeypatch):
    from core.llm.provider_probe import probe_models

    def fake_getaddrinfo(host, port, *args, **kwargs):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("169.254.169.254", port))]

    monkeypatch.setattr(socket, "getaddrinfo", fake_getaddrinfo)
    result = probe_models("http://metadata.example/v1", force=True, timeout=0.2)
    assert result.state == "unreachable"
    assert "metadata" in result.message


def test_probe_does_not_follow_redirects():
    from core.llm.provider_probe import probe_models

    hits: list[str] = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            if self.path.endswith("/target"):
                hits.append(self.path)
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"data":[]}')
                return
            self.send_response(302)
            self.send_header("Location", "/target")
            self.end_headers()

        def log_message(self, *args):
            return

    server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        result = probe_models(f"http://127.0.0.1:{server.server_address[1]}/v1", force=True, timeout=2)
        assert result.state == "unreachable"
        assert hits == []
    finally:
        server.shutdown()


# ── AR-7: смена base_url сбрасывает ключ ─────────────────────────────────
def test_base_url_change_resets_vault_key(real_api, auth_headers, api_config):
    http, agent = real_api
    agent._setup_llm = lambda: None

    first = http.put(
        "/v1/providers/rotate",
        json={"base_url": "https://first.example/v1", "kind": "openai"},
        headers=auth_headers[ADMIN],
    )
    assert first.status_code == 200, first.text
    assert http.put(
        "/v1/providers/rotate/secret",
        json={"api_key": RAW_KEY},
        headers=auth_headers[ADMIN],
    ).status_code == 200
    assert next(r for r in http.get("/v1/providers", headers=auth_headers[ADMIN]).json()["data"]["providers"] if r["name"] == "rotate")["has_key"] is True

    changed = http.put(
        "/v1/providers/rotate",
        json={"base_url": "https://second.example/v1", "kind": "openai"},
        headers=auth_headers[ADMIN],
    )
    assert changed.status_code == 200, changed.text
    assert changed.json()["data"]["key_reset"] is True
    assert changed.json()["data"]["provider"]["has_key"] is False
    from core.llm.provider_secrets import store_for

    assert store_for(api_config["paths"]["data_dir"]).get("rotate") == ""

    same = http.put(
        "/v1/providers/rotate",
        json={"base_url": "https://second.example/v1", "kind": "openai"},
        headers=auth_headers[ADMIN],
    )
    assert same.json()["data"]["key_reset"] is False


# ── AR-4: миграция ключа ─────────────────────────────────────────────────
def test_migrate_refuses_when_vault_cannot_decrypt(real_api, auth_headers, api_config, monkeypatch):
    http, agent = real_api
    agent._setup_llm = lambda: None
    legacy = "sk-yaml-broken-vault-0123456789"  # gitleaks:allow
    api_config.setdefault("llm", {}).setdefault("providers", {})["broken"] = {
        "base_url": "https://broken.example/v1",
        "api_key": legacy,
    }

    def boom(self, name, *, strict=False):
        raise ProviderSecretsError("decrypt failed")

    monkeypatch.setattr(ProviderSecretStore, "get_strict", boom)
    response = http.post("/v1/providers/broken/migrate-secret", headers=auth_headers[ADMIN])
    assert response.status_code == 500
    assert "decrypt failed" not in response.text
    assert api_config["llm"]["providers"]["broken"]["api_key"] == legacy


def test_migrate_removes_yaml_key_and_scrubs_backups(real_api, auth_headers, api_config, tmp_path, monkeypatch):
    http, agent = real_api
    agent._setup_llm = lambda: None
    legacy = "sk-yaml-good-vault-0123456789"  # gitleaks:allow
    api_config.setdefault("llm", {}).setdefault("providers", {})["legacy2"] = {
        "base_url": "https://legacy2.example/v1",
        "api_key": legacy,
    }
    config_dir = tmp_path / "project" / "config"
    config_dir.mkdir(parents=True, exist_ok=True)
    layer = config_dir / "llm.yaml"
    layer.write_text(
        "llm:\n  providers:\n    legacy2:\n      base_url: https://legacy2.example/v1\n"
        f"      api_key: {legacy}\n",
        encoding="utf-8",
    )
    (config_dir / "llm.yaml.bak").write_text(layer.read_text(encoding="utf-8"), encoding="utf-8")
    (config_dir / "llm.yaml.20260101T000000000000Z.bak").write_text(
        layer.read_text(encoding="utf-8"), encoding="utf-8"
    )

    response = http.post("/v1/providers/legacy2/migrate-secret", headers=auth_headers[ADMIN])
    assert response.status_code == 200, response.text
    assert api_config["llm"]["providers"]["legacy2"].get("api_key") is None
    for path in config_dir.glob("llm.yaml*"):
        assert legacy not in path.read_text(encoding="utf-8"), path


# ── AR-8: атомарная запись и backup ──────────────────────────────────────
def test_persist_updates_keeps_original_on_failed_replace(tmp_path, monkeypatch):
    config_dir = tmp_path / "config"
    config_dir.mkdir()
    layer = config_dir / "llm.yaml"
    original = "llm:\n  providers:\n    a:\n      base_url: https://a.example/v1\n"
    layer.write_text(original, encoding="utf-8")

    from core.runtime import config_loader

    real_replace = os.replace
    failed = False

    def flaky(src, dst):
        nonlocal failed
        if str(dst) == str(layer) and not failed:
            failed = True
            raise OSError("disk full")
        return real_replace(src, dst)

    monkeypatch.setattr(config_loader.os, "replace", flaky)
    with pytest.raises(OSError):
        persist_allowlisted_updates(
            tmp_path,
            {"llm.providers.a.base_url": "https://b.example/v1"},
            keep_backup=True,
        )
    assert layer.read_text(encoding="utf-8") == original
    assert layer.with_name("llm.yaml.bak").read_text(encoding="utf-8") == original
    assert list(config_dir.glob("llm.yaml.*.bak"))


def test_persist_removals_without_backup_leaves_no_key_in_any_backup(tmp_path):
    config_dir = tmp_path / "config"
    config_dir.mkdir()
    layer = config_dir / "llm.yaml"
    secret = "sk-very-secret-0123456789"  # gitleaks:allow
    layer.write_text(
        f"llm:\n  providers:\n    a:\n      base_url: https://a.example/v1\n      api_key: {secret}\n",
        encoding="utf-8",
    )
    (config_dir / "llm.yaml.bak").write_text(layer.read_text(encoding="utf-8"), encoding="utf-8")
    persist_dotted_removals(tmp_path, ["llm.providers.a.api_key"], keep_backup=False)
    for path in config_dir.glob("llm.yaml*"):
        assert secret not in path.read_text(encoding="utf-8")


def test_scrub_backups_removes_dotted_key(tmp_path):
    config_dir = tmp_path / "config"
    config_dir.mkdir()
    bak = config_dir / "llm.yaml.bak"
    bak.write_text(
        "llm:\n  providers:\n    a:\n      api_key: sk-only-in-backup\n      base_url: https://a/v1\n",  # gitleaks:allow
        encoding="utf-8",
    )
    assert scrub_layer_backups(tmp_path, "llm.yaml", ["llm.providers.a.api_key"]) == 1
    assert "sk-only-in-backup" not in bak.read_text(encoding="utf-8")  # gitleaks:allow


def test_backup_rotation_keeps_five_timestamped_copies(tmp_path):
    config_dir = tmp_path / "config"
    config_dir.mkdir()
    (config_dir / "llm.yaml").write_text("llm:\n  providers: {}\n", encoding="utf-8")
    for index in range(7):
        persist_allowlisted_updates(
            tmp_path,
            {f"llm.providers.p{index}.base_url": f"https://p{index}.example/v1"},
            keep_backup=True,
        )
    stamped = sorted(config_dir.glob("llm.yaml.*.bak"))
    assert 1 <= len(stamped) <= 5
    assert (config_dir / "llm.yaml.bak").is_file()


def test_probe_rejects_literal_metadata_without_network():
    from core.llm.provider_probe import probe_models

    result = probe_models("http://169.254.169.254/v1", force=True, timeout=0.1)
    assert result.state == "unreachable"
    assert "metadata" in result.message


def test_malformed_ipv6_base_url_is_rejected():
    with pytest.raises(ProviderAdminError):
        validate_base_url("http://[bad/v1")


def test_key_reset_failure_rolls_back_base_url(real_api, auth_headers, monkeypatch):
    http, agent = real_api
    agent._setup_llm = lambda: None
    http.put(
        "/v1/providers/rollback",
        json={"base_url": "https://old.example/v1", "kind": "openai"},
        headers=auth_headers[ADMIN],
    )
    http.put(
        "/v1/providers/rollback/secret",
        json={"api_key": RAW_KEY},
        headers=auth_headers[ADMIN],
    )

    def boom(self, name):
        raise ProviderSecretsError("vault write failed")

    monkeypatch.setattr(ProviderSecretStore, "delete", boom)
    response = http.put(
        "/v1/providers/rollback",
        json={"base_url": "https://new.example/v1", "kind": "openai"},
        headers=auth_headers[ADMIN],
    )
    assert response.status_code == 500
    row = next(
        item for item in http.get("/v1/providers", headers=auth_headers[ADMIN]).json()["data"]["providers"]
        if item["name"] == "rollback"
    )
    assert row["base_url"] == "https://old.example/v1"
    assert row["has_key"] is True
