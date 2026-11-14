#!/usr/bin/env python3
"""Deploy helper: обеспечить NEYRA_VAULT_KEY и перевести vault на формат v2.

Запускать на хосте ядра при обновлении, до старта сервиса:

    .venv/bin/python scripts/ensure_vault_key.py \
        --env .env --data data

Поведение:
* в .env уже есть непустой NEYRA_VAULT_KEY — проверить, что сохранённые
  секреты расшифровываются, и ничего не менять;
* ключа нет, но есть data/secrets/vault.key — взять его содержимое, записать
  в .env (0600), перешифровать старые записи v1 в AES-GCM v2, проверить и
  только после этого удалить vault.key;
* ключа и vault.key нет — сгенерировать случайный ключ и записать в .env.

Скрипт запускается от root при обновлении ядра, поэтому созданные им ``.env``
и ``providers.json`` получают владельца прежнего файла (или каталога), а не
root: иначе служба под openbot не сможет их прочитать.

Значение ключа никогда не печатается.
"""

from __future__ import annotations

import argparse
import os
import secrets
import sys
import tempfile
from pathlib import Path

SERVER_ROOT = Path(__file__).resolve().parents[1]
if str(SERVER_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVER_ROOT))

from core.llm.provider_secrets import (  # noqa: E402
    ProviderSecretStore,
    ProviderSecretsError,
)

_KEY = "NEYRA_VAULT_KEY"
_KEY_FILE = "vault.key"


def _read_env_value(env_path: Path) -> str:
    if not env_path.is_file():
        return ""
    for line in env_path.read_text(encoding="utf-8").splitlines():
        text = line.strip()
        if not text or text.startswith("#") or "=" not in text:
            continue
        name, value = text.split("=", 1)
        if name.strip() != _KEY:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            value = value[1:-1]
        return value.strip()
    return ""


def _owner_of(path: Path) -> tuple[int, int] | None:
    try:
        st = path.stat()
    except OSError:
        return None
    return st.st_uid, st.st_gid


def _restore_owner(path: Path, owner: tuple[int, int] | None) -> None:
    """Вернуть файлу владельца, от имени которого работает служба."""
    if owner is None or os.geteuid() != 0 or not path.exists():
        return
    st = path.stat()
    if (st.st_uid, st.st_gid) == owner:
        return
    try:
        os.chown(path, *owner)
    except OSError as e:
        raise ProviderSecretsError(
            f"Не удалось вернуть владельца {path} ({owner[0]}:{owner[1]}): "
            "служба не сможет прочитать файл"
        ) from e


def _write_env_value(env_path: Path, value: str) -> None:
    owner = _owner_of(env_path) or _owner_of(env_path.parent)
    env_path.parent.mkdir(parents=True, exist_ok=True)
    lines = env_path.read_text(encoding="utf-8").splitlines() if env_path.is_file() else []
    out: list[str] = []
    replaced = False
    for line in lines:
        stripped = line.strip()
        name = stripped.split("=", 1)[0].strip() if "=" in stripped and not stripped.startswith("#") else ""
        if name == _KEY:
            if not replaced:
                out.append(f"{_KEY}={value}")
                replaced = True
            # duplicate keys are dropped
            continue
        out.append(line)
    if not replaced:
        if out and out[-1].strip():
            out.append("")
        out.append(f"{_KEY}={value}")

    fd, tmp = tempfile.mkstemp(dir=str(env_path.parent), prefix=".env.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write("\n".join(out) + "\n")
        os.chmod(tmp, 0o600)
        if owner is not None and os.geteuid() == 0:
            os.chown(tmp, *owner)
        os.replace(tmp, env_path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _store(data_dir: Path, raw_key: str) -> ProviderSecretStore:
    return ProviderSecretStore(data_dir / "secrets", env={_KEY: raw_key})


def ensure_vault_key(env_path: Path, data_dir: Path) -> str:
    """Вернуть источник ключа: 'env' | 'vault.key' | 'generated'."""
    existing = _read_env_value(env_path)
    vault_key_path = data_dir / "secrets" / _KEY_FILE
    if existing:
        _store(data_dir, existing).verify()
        return "env"

    old_key = ""
    if vault_key_path.is_file():
        try:
            old_key = vault_key_path.read_text(encoding="utf-8").strip()
        except OSError as e:
            raise ProviderSecretsError("Не удалось прочитать data/secrets/vault.key") from e
        if not old_key:
            raise ProviderSecretsError("data/secrets/vault.key пуст: задайте NEYRA_VAULT_KEY вручную")

    raw_key = old_key or secrets.token_urlsafe(48)
    secrets_dir = vault_key_path.parent
    secrets_owner = _owner_of(secrets_dir) or _owner_of(data_dir)
    store = _store(data_dir, raw_key)
    names = store.names()
    for name in names:
        value = store.get_strict(name)
        store.set(name, value)  # v1 -> v2; v2 re-encrypts with a fresh nonce
    store.verify()
    _restore_owner(secrets_dir, secrets_owner)
    _restore_owner(store.path, secrets_owner)

    # Сначала .env, затем удаление файла: при сбое записи старый ключ остаётся.
    _write_env_value(env_path, raw_key)
    if old_key and vault_key_path.is_file():
        vault_key_path.unlink()
        parent = vault_key_path.parent
        if not any(parent.iterdir()):
            parent.rmdir()
    return "vault.key" if old_key else "generated"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Ensure NEYRA_VAULT_KEY in the core .env")
    parser.add_argument("--env", default=".env", help="path to the core .env")
    parser.add_argument("--data", default="data", help="path to the core data directory")
    args = parser.parse_args(argv)
    env_path = Path(args.env)
    data_dir = Path(args.data)
    try:
        source = ensure_vault_key(env_path, data_dir)
    except Exception as e:
        print(f"ОШИБКА vault: {e}", file=sys.stderr)
        return 1
    print(f"Vault: ключ {_KEY} в {env_path} (источник: {source})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
