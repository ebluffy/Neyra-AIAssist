"""Зашифрованное хранилище API-ключей провайдеров (vault).

Ключи не попадают ни в YAML, ни в снимок конфига, ни в логи. Файл лежит в
``<data_dir>/secrets/providers.json`` с правами 0600 и содержит только
зашифрованные значения:

    {"version": 2, "items": {"openrouter": {"v": 2, "nonce": "b64", "ct": "b64", "updated_at": "..."}}}

Формат v2 — AES-256-GCM (``cryptography.hazmat.primitives.ciphers.aead``):
scrypt(мастер-ключ) → 32 байта, nonce 12 байт, AAD = имя провайдера с
префиксом версии. Тег входит в ``ct``. Старые записи v1 (самодельный
encrypt-then-MAC) только читаются, при следующей записи провайдер
пересохраняется в v2.

Мастер-ключ берётся из ``NEYRA_VAULT_KEY``. Без него vault не работает:
это боевой режим. Для локальной разработки можно явно задать
``NEYRA_VAULT_DEV=1`` — тогда ключ один раз создаётся в
``<data_dir>/secrets/vault.key`` (0600). ``verify()`` на старте проверяет,
что все сохранённые секреты расшифровываются; потеря ключа — громкий отказ.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import secrets
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
except ImportError as exc:  # pragma: no cover - broken install must fail at import, not on first key
    raise ImportError(
        "Для vault провайдеров нужен пакет cryptography (AES-256-GCM). "
        "Установите server/requirements.txt в venv ядра."
    ) from exc

logger = logging.getLogger("neyra.provider_secrets")

VAULT_VERSION = 2
_LEGACY_VERSION = 1
_KEY_FILE_NAME = "vault.key"
_SECRETS_FILE_NAME = "providers.json"
_AEAD_SALT = b"neyra-provider-vault-v4"
_LEGACY_SCRYPT_SALT = b"neyra-provider-vault-v3"
_LEGACY_ENC_INFO = b"neyra-vault-enc"
_LEGACY_MAC_INFO = b"neyra-vault-mac"
_AEAD_AAD_PREFIX = b"neyra-provider-v2:"


class ProviderSecretsError(RuntimeError):
    """Vault cannot be read or written (missing dependency, bad file, io)."""


def _b64e(raw: bytes) -> str:
    return base64.b64encode(raw).decode("ascii")


def _b64d(text: str) -> bytes:
    return base64.b64decode(text.encode("ascii"), validate=True)


def _derive_aead(raw: str) -> bytes:
    """32-байтовый ключ AES-256-GCM."""
    return hashlib.scrypt(
        raw.encode("utf-8"),
        salt=_AEAD_SALT,
        n=2**14,
        r=8,
        p=1,
        dklen=32,
    )


def _derive_legacy(raw: str) -> bytes:
    """64 байта старого формата: 32 шифрование + 32 MAC."""
    return hashlib.scrypt(
        raw.encode("utf-8"),
        salt=_LEGACY_SCRYPT_SALT,
        n=2**14,
        r=8,
        p=1,
        dklen=64,
    )


def _legacy_split(master: bytes) -> tuple[bytes, bytes]:
    enc = hmac.new(master, _LEGACY_ENC_INFO, hashlib.sha256).digest()
    mac = hmac.new(master, _LEGACY_MAC_INFO, hashlib.sha256).digest()
    return enc, mac


def _legacy_keystream(enc_key: bytes, nonce: bytes, length: int) -> bytes:
    out = bytearray()
    counter = 0
    while len(out) < length:
        block = hmac.new(enc_key, nonce + counter.to_bytes(4, "big"), hashlib.sha256).digest()
        out.extend(block)
        counter += 1
    return bytes(out[:length])


def _legacy_encrypt(master: bytes, nonce: bytes, plaintext: bytes, aad: bytes) -> tuple[bytes, bytes]:
    enc_key, mac_key = _legacy_split(master)
    stream = _legacy_keystream(enc_key, nonce + b"|" + aad, len(plaintext))
    ct = bytes(a ^ b for a, b in zip(plaintext, stream))
    tag = hmac.new(mac_key, nonce + b"|" + aad + b"|" + ct, hashlib.sha256).digest()
    return ct, tag


def _legacy_decrypt(master: bytes, nonce: bytes, ct: bytes, tag: bytes, aad: bytes) -> bytes:
    enc_key, mac_key = _legacy_split(master)
    expected = hmac.new(mac_key, nonce + b"|" + aad + b"|" + ct, hashlib.sha256).digest()
    if not hmac.compare_digest(expected, tag):
        raise ProviderSecretsError("Тег vault не совпал: ключ повреждён или подменён")
    stream = _legacy_keystream(enc_key, nonce + b"|" + aad, len(ct))
    return bytes(a ^ b for a, b in zip(ct, stream))


def _aad(key_id: str) -> bytes:
    return _AEAD_AAD_PREFIX + key_id.encode("utf-8")


def _aead_encrypt(master: bytes, nonce: bytes, plaintext: bytes, key_id: str) -> bytes:
    return AESGCM(master).encrypt(nonce, plaintext, _aad(key_id))


def _aead_decrypt(master: bytes, nonce: bytes, ciphertext: bytes, key_id: str) -> bytes:
    return AESGCM(master).decrypt(nonce, ciphertext, _aad(key_id))


class ProviderSecretStore:
    """File-backed encrypted key store. One instance per process."""

    def __init__(self, secrets_dir: Path, *, env: dict[str, str] | None = None) -> None:
        self.dir = Path(secrets_dir)
        self.path = self.dir / _SECRETS_FILE_NAME
        self._key_path = self.dir / _KEY_FILE_NAME
        self._env = dict(os.environ if env is None else env)
        self._key: bytes | None = None
        self._legacy_key: bytes | None = None
        self._items: dict[str, dict[str, Any]] | None = None

    # ── key ──────────────────────────────────────────────────────────────
    def _raw_master(self) -> str:
        raw = (self._env.get("NEYRA_VAULT_KEY") or "").strip()
        if raw:
            return raw
        if (self._env.get("NEYRA_VAULT_DEV") or "").strip() != "1":
            raise ProviderSecretsError(
                "NEYRA_VAULT_KEY не задан: vault провайдеров отключён. "
                "Задайте ключ в окружении (deploy/secret manager). "
                "Для локальной разработки разрешён NEYRA_VAULT_DEV=1."
            )
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
            logger.warning(
                "Vault: создан dev-ключ %s. Для боевого режима задайте NEYRA_VAULT_KEY.",
                self._key_path,
            )
        return existing.decode("utf-8").strip()

    def _master_key(self) -> bytes:
        if self._key is None:
            self._key = _derive_aead(self._raw_master())
        return self._key

    def _legacy_master_key(self) -> bytes:
        if self._legacy_key is None:
            self._legacy_key = _derive_legacy(self._raw_master())
        return self._legacy_key

    # ── file ─────────────────────────────────────────────────────────────
    def _load(self) -> dict[str, dict[str, Any]]:
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
        if not isinstance(items, dict):
            raise ProviderSecretsError("Файл секретов повреждён")
        self._items = items
        return self._items

    def _save(self, items: dict[str, dict[str, Any]]) -> None:
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

    # ── crypto ───────────────────────────────────────────────────────────
    def _decrypt_item(self, key_id: str, item: dict[str, Any]) -> str:
        try:
            nonce = _b64d(str(item.get("nonce") or ""))
            ct = _b64d(str(item.get("ct") or ""))
        except ValueError as e:
            raise ProviderSecretsError("Секрет vault повреждён (base64)") from e
        if not nonce or not ct:
            raise ProviderSecretsError("Секрет vault повреждён (пустые поля)")
        version = item.get("v")
        if version == 2:
            if len(nonce) != 12:
                raise ProviderSecretsError("Секрет vault повреждён (nonce)")
            plain = _aead_decrypt(self._master_key(), nonce, ct, key_id)
        else:
            try:
                tag = _b64d(str(item.get("tag") or ""))
            except ValueError as e:
                raise ProviderSecretsError("Секрет vault повреждён (tag)") from e
            if len(nonce) != 16 or not tag:
                raise ProviderSecretsError("Секрет vault повреждён (legacy nonce/tag)")
            plain = _legacy_decrypt(self._legacy_master_key(), nonce, ct, tag, key_id.encode("utf-8"))
        return plain.decode("utf-8", "replace")

    def verify(self) -> None:
        """Проверить мастер-ключ и расшифровку всех сохранённых секретов.

        Пустой vault не требует ключа: расшифровывать нечего, и ядро должно
        стартовать на чистой площадке без NEYRA_VAULT_KEY. Как только в vault
        появился хотя бы один секрет, без ключа старт падает громко.
        """
        items = self._load()
        if not items:
            return
        self._master_key()
        failed: list[str] = []
        for key_id, item in items.items():
            if not isinstance(item, dict):
                failed.append(str(key_id))
                continue
            try:
                self._decrypt_item(str(key_id), item)
            except Exception:
                logger.error("Vault: секрет не расшифровывается | provider=%s", key_id)
                failed.append(str(key_id))
        if failed:
            raise ProviderSecretsError(
                "Vault не может расшифровать сохранённые ключи: "
                + ", ".join(sorted(failed))
                + ". Проверьте NEYRA_VAULT_KEY; ключи не будут молча проигнорированы."
            )

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
        ct = _aead_encrypt(self._master_key(), nonce, value.encode("utf-8"), key_id)
        items[key_id] = {
            "v": 2,
            "nonce": _b64e(nonce),
            "ct": _b64e(ct),
            "updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }
        self._save(items)
        logger.info("Provider secret stored | provider=%s", key_id)

    def get(self, name: str, *, strict: bool = False) -> str:
        key_id = str(name).strip().lower()
        item = self._load().get(key_id)
        if not isinstance(item, dict):
            return ""
        try:
            return self._decrypt_item(key_id, item)
        except Exception:
            logger.warning("Provider secret cannot be decrypted | provider=%s", key_id)
            if strict:
                raise ProviderSecretsError(
                    f"Ключ провайдера '{key_id}' не расшифровывается: проверьте NEYRA_VAULT_KEY"
                )
            return ""

    def get_strict(self, name: str) -> str:
        return self.get(name, strict=True)

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
