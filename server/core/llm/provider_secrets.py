"""Шифрованное хранилище API-ключей провайдеров (vault).

Ключи не попадают ни в YAML, ни в снимок конфига, ни в логи. Файл лежит в
``<data_dir>/secrets/providers.json`` с правами 0600 и содержит только
зашифрованные значения AES-256-GCM:

    {"version": 1, "items": {"openrouter": {"nonce": "b64", "ct": "b64", "updated_at": "..."}}}

Мастер-ключ берётся из окружения ``NEYRA_VAULT_KEY`` (любая строка, из неё
выводится 32-байтный ключ через scrypt). Если переменная пуста, ключ
создаётся один раз рядом с файлом (``vault.key``, 0600) — так стенд работает
без обязательного нового секрета в .env.
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import secrets
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

logger = logging.getLogger("neyra.provider_secrets")

VAULT_VERSION = 1
_KEY_FILE_NAME = "vault.key"
_SECRETS_FILE_NAME = "providers.json"
_SCRYPT_SALT = b"neyra-provider-vault-v1"


class ProviderSecretsError(RuntimeError):
    """Vault cannot be read or written (missing dependency, bad file, io)."""


def _b64e(raw: bytes) -> str:
    return base64.b64encode(raw).decode("ascii")


def _b64d(text: str) -> bytes:
    return base64.b64decode(text.encode("ascii"))


def _aesgcm():
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    except Exception as e:  # pragma: no cover - dependency is pinned in requirements
        raise ProviderSecretsError("Модуль cryptography недоступен") from e
    return AESGCM


def _derive(raw: str) -> bytes:
    return hashlib.scrypt(
        raw.encode("utf-8"),
        salt=_SCRYPT_SALT,
        n=2**14,
        r=8,
        p=1,
        dklen=32,
    )


class ProviderSecretStore:
    """File-backed encrypted key store. One instance per process."""

    def __init__(self, secrets_dir: Path, *, env: dict[str, str] | None = None) -> None:
        self.dir = Path(secrets_dir)
        self.path = self.dir / _SECRETS_FILE_NAME
        self._key_path = self.dir / _KEY_FILE_NAME
        self._env = dict(os.environ if env is None else env)
        self._key: bytes | None = None
        self._items: dict[str, dict[str, str]] | None = None

    # ── key ──────────────────────────────────────────────────────────────
    def _master_key(self) -> bytes:
        if self._key is not None:
            return self._key
        raw = (self._env.get("NEYRA_VAULT_KEY") or "").strip()
        if raw:
            self._key = _derive(raw)
            return self._key
        self.dir.mkdir(parents=True, exist_ok=True)
        try:
            existing = self._key_path.read_bytes()
        except FileNotFoundError:
            existing = b""
        except OSError as e:
            raise ProviderSecretsError("Не удалось прочитать ключ vault") from e
        if not existing:
            fresh = secrets.token_urlsafe(48)
            fd = os.open(self._key_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(fresh)
            existing = fresh.encode("utf-8")
        self._key = _derive(existing.decode("utf-8").strip())
        return self._key

    # ── file ─────────────────────────────────────────────────────────────
    def _load(self) -> dict[str, dict[str, str]]:
        if self._items is not None:
            return self._items
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            self._items = {}
            return self._items
        except (OSError, ValueError) as e:
            raise ProviderSecretsError("Файл секретов повреждён") from e
        items = raw.get("items") if isinstance(raw, dict) else None
        self._items = items if isinstance(items, dict) else {}
        return self._items

    def _save(self, items: dict[str, dict[str, str]]) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        payload = {"version": VAULT_VERSION, "items": items}
        text = json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True)
        fd, tmp = tempfile.mkstemp(dir=str(self.dir), prefix=".providers-", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(text)
            os.chmod(tmp, 0o600)
            os.replace(tmp, self.path)
        except Exception:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
        self._items = items

    # ── api ──────────────────────────────────────────────────────────────
    def names(self) -> list[str]:
        return sorted(self._load().keys())

    def has(self, name: str) -> bool:
        return str(name).strip().lower() in self._load()

    def set(self, name: str, api_key: str) -> None:
        key_id = str(name).strip().lower()
        value = (api_key or "").strip()
        if not key_id:
            raise ProviderSecretsError("Пустое имя провайдера")
        if not value:
            raise ProviderSecretsError("Пустой API-ключ")
        items = dict(self._load())
        nonce = secrets.token_bytes(12)
        ct = _aesgcm()(self._master_key()).encrypt(nonce, value.encode("utf-8"), key_id.encode("utf-8"))
        items[key_id] = {
            "nonce": _b64e(nonce),
            "ct": _b64e(ct),
            "updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }
        self._save(items)
        logger.info("Provider secret stored | provider=%s", key_id)

    def get(self, name: str) -> str:
        key_id = str(name).strip().lower()
        item = self._load().get(key_id)
        if not isinstance(item, dict):
            return ""
        try:
            nonce = _b64d(str(item.get("nonce") or ""))
            ct = _b64d(str(item.get("ct") or ""))
        except ValueError:
            return ""
        if not nonce or not ct:
            return ""
        try:
            plain = _aesgcm()(self._master_key()).decrypt(nonce, ct, key_id.encode("utf-8"))
        except Exception:
            logger.warning("Provider secret cannot be decrypted | provider=%s", key_id)
            return ""
        return plain.decode("utf-8", "replace")

    def delete(self, name: str) -> bool:
        key_id = str(name).strip().lower()
        items = dict(self._load())
        if key_id not in items:
            return False
        items.pop(key_id, None)
        self._save(items)
        return True

    def updated_at(self, name: str) -> str | None:
        item = self._load().get(str(name).strip().lower())
        if not isinstance(item, dict):
            return None
        return str(item.get("updated_at") or "") or None


# ── process-wide instance ────────────────────────────────────────────────
_store: ProviderSecretStore | None = None


def store_for(data_dir: str | os.PathLike[str]) -> ProviderSecretStore:
    """Один store на процесс; путь строится от ``paths.data_dir``."""
    global _store
    secrets_dir = Path(data_dir) / "secrets"
    if _store is None or _store.dir != secrets_dir:
        _store = ProviderSecretStore(secrets_dir)
    return _store
