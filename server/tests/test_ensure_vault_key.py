"""Deploy helper vault: перенос vault.key в .env и v1 -> v2."""

from __future__ import annotations

import base64
import json
import stat
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import ensure_vault_key as helper  # noqa: E402

from core.llm.provider_secrets import (  # noqa: E402
    ProviderSecretStore,
    ProviderSecretsError,
    _derive_legacy,
    _legacy_encrypt,
)


def _read_key(env_path: Path) -> str:
    for line in env_path.read_text(encoding="utf-8").splitlines():
        if line.startswith("NEYRA_VAULT_KEY="):
            return line.split("=", 1)[1].strip()
    return ""


def _write_legacy_store(data_dir: Path, raw_key: str, value: str = "legacy-secret") -> None:
    secrets_dir = data_dir / "secrets"
    secrets_dir.mkdir(parents=True, exist_ok=True)
    master = _derive_legacy(raw_key)
    nonce = b"0123456789abcdef"
    ct, tag = _legacy_encrypt(master, nonce, value.encode(), b"legacy")
    (secrets_dir / "providers.json").write_text(
        json.dumps(
            {
                "version": 1,
                "items": {
                    "legacy": {
                        "nonce": base64.b64encode(nonce).decode(),
                        "ct": base64.b64encode(ct).decode(),
                        "tag": base64.b64encode(tag).decode(),
                    }
                },
            }
        ),
        encoding="utf-8",
    )


def test_generated_key_is_written_0600_and_idempotent(tmp_path: Path):
    env_path = tmp_path / ".env"
    data_dir = tmp_path / "data"
    assert helper.ensure_vault_key(env_path, data_dir) == "generated"
    first = _read_key(env_path)
    assert first
    assert stat.S_IMODE(env_path.stat().st_mode) == 0o600
    ProviderSecretStore(data_dir / "secrets", env={"NEYRA_VAULT_KEY": first}).verify()

    assert helper.ensure_vault_key(env_path, data_dir) == "env"
    assert _read_key(env_path) == first


def test_old_vault_key_is_moved_to_env_and_v1_reencrypted(tmp_path: Path):
    env_path = tmp_path / ".env"
    env_path.write_text("OTHER=1\n", encoding="utf-8")
    data_dir = tmp_path / "data"
    old_key = "old-local-vault-key"
    _write_legacy_store(data_dir, old_key)
    (data_dir / "secrets" / "vault.key").write_text(old_key + "\n", encoding="utf-8")

    assert helper.ensure_vault_key(env_path, data_dir) == "vault.key"
    assert _read_key(env_path) == old_key
    assert "OTHER=1" in env_path.read_text(encoding="utf-8")
    assert not (data_dir / "secrets" / "vault.key").exists()
    raw = json.loads((data_dir / "secrets" / "providers.json").read_text(encoding="utf-8"))
    assert raw["version"] == 2
    assert raw["items"]["legacy"]["v"] == 2
    assert (
        ProviderSecretStore(data_dir / "secrets", env={"NEYRA_VAULT_KEY": old_key}).get_strict("legacy")
        == "legacy-secret"
    )


def test_wrong_existing_env_key_does_not_rewrite_env(tmp_path: Path):
    env_path = tmp_path / ".env"
    env_path.write_text("NEYRA_VAULT_KEY=wrong-key\n", encoding="utf-8")
    data_dir = tmp_path / "data"
    _write_legacy_store(data_dir, "right-key")
    with pytest.raises(ProviderSecretsError):
        helper.ensure_vault_key(env_path, data_dir)
    assert _read_key(env_path) == "wrong-key"


def test_existing_secrets_without_any_key_do_not_start_silently(tmp_path: Path):
    env_path = tmp_path / ".env"
    data_dir = tmp_path / "data"
    secrets_dir = data_dir / "secrets"
    secrets_dir.mkdir(parents=True)
    ProviderSecretStore(secrets_dir, env={"NEYRA_VAULT_KEY": "real-key"}).set("openai", "sk-secret")  # gitleaks:allow
    with pytest.raises(ProviderSecretsError, match="не расшифровывается|не может расшифровать"):
        helper.ensure_vault_key(env_path, data_dir)
    assert not env_path.exists()


def test_items_not_object_is_corrupt(tmp_path: Path):
    data_dir = tmp_path / "data"
    secrets_dir = data_dir / "secrets"
    secrets_dir.mkdir(parents=True)
    (secrets_dir / "providers.json").write_text('{"version": 2, "items": []}', encoding="utf-8")
    with pytest.raises(ProviderSecretsError, match="повреждён"):
        helper.ensure_vault_key(tmp_path / ".env", data_dir)


def test_write_env_value_drops_duplicate_key(tmp_path: Path):
    env_path = tmp_path / ".env"
    env_path.write_text("A=1\nNEYRA_VAULT_KEY=old\nB=2\nNEYRA_VAULT_KEY=older\n", encoding="utf-8")
    helper._write_env_value(env_path, "new-key")
    text = env_path.read_text(encoding="utf-8")
    assert text.count("NEYRA_VAULT_KEY=") == 1
    assert "NEYRA_VAULT_KEY=new-key" in text
    assert "A=1" in text and "B=2" in text
