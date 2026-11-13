#!/usr/bin/env python3
"""Связка .env сайта с ядром Neyra: NEYRA_* без дублей, атомарно, без печати значений.

Идемпотентно. Секреты (service key, identity secret) всегда приводятся к значениям
ядра; URL заполняются только если пусты, чтобы не затирать явную настройку.
Коды выхода: 0 — всё связано; 2 — частично (чат не готов), 1 — фатальная ошибка.
"""
from __future__ import annotations

import os
import re
import secrets
import stat
import sys
import tempfile
from pathlib import Path

WEB_ENV = Path(os.environ.get("WEB", "/opt/neyra/web")) / ".env"
CORE_DIR = Path(os.environ.get("CORE", "/opt/neyra/server"))
CORE_ENV = CORE_DIR / ".env"

SECRET_KEYS = ("NEYRA_SERVICE_KEY", "NEYRA_IDENTITY_JWT_SECRET")
URL_KEYS = ("NEYRA_WS_URL", "NEYRA_API_URL")


def parse_env(path: Path) -> dict[str, str]:
    """dotenv-подобный разбор: последнее присваивание побеждает, кавычки снимаются."""
    values: dict[str, str] = {}
    if not path.is_file():
        return values
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        values[key] = value
    return values


def serialize(key: str, value: str) -> str:
    # Одинарные кавычки понимают и systemd EnvironmentFile, и dotenv; shell-раскрытия нет.
    if any(ch in value for ch in ("'", "\n", "\r", "\0")):
        raise ValueError(f"{key}: значение содержит недопустимые для .env символы")
    return f"{key}='{value}'"


def write_atomic(path: Path, updates: dict[str, str]) -> None:
    """Заменить/добавить ключи, убрать их дубли, сохранить владельца и права."""
    lines: list[str] = []
    if path.is_file():
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            stripped = line.strip()
            if stripped and not stripped.startswith("#") and "=" in line:
                key = line.partition("=")[0].strip()
                if key in updates:
                    continue
            lines.append(line)
    for key, value in updates.items():
        lines.append(serialize(key, value))
    data = "\n".join(lines).rstrip("\n") + "\n"

    st = path.stat() if path.exists() else None
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".env.", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp, stat.S_IMODE(st.st_mode) if st else 0o600)
        if st is not None and hasattr(os, "chown"):
            try:
                os.chown(tmp, st.st_uid, st.st_gid)
            except PermissionError:
                pass
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def core_port() -> int:
    config = CORE_DIR / "config" / "server.yaml"
    try:
        import yaml  # noqa: PLC0415

        data = yaml.safe_load(config.read_text(encoding="utf-8")) or {}
        port = int((data.get("api") or {}).get("port") or 0)
        if port > 0:
            return port
    except Exception:
        pass
    return 8787


def main() -> int:
    if not WEB_ENV.is_file():
        print(f"нет {WEB_ENV} — сначала запусти neyra-web-setup.sh", file=sys.stderr)
        return 1

    web = parse_env(WEB_ENV)
    core = parse_env(CORE_ENV)

    service_key = (core.get("API_TOKEN") or core.get("API_KEY") or "").strip()
    identity_secret = (core.get("NEYRA_IDENTITY_JWT_SECRET") or "").strip()
    core_ok = CORE_ENV.is_file()

    status = 0
    core_changed = False
    if not identity_secret:
        identity_secret = secrets.token_hex(32)
        if core_ok:
            write_atomic(CORE_ENV, {"NEYRA_IDENTITY_JWT_SECRET": identity_secret})
            core_changed = True
            print(f"секрет identity добавлен в {CORE_ENV} (значение не печатаю)")
        else:
            print(f"нет {CORE_ENV}: секрет identity записан только сайту, чат не заработает", file=sys.stderr)
            status = 2

    port = core_port()
    updates: dict[str, str] = {}
    for key, value in (("NEYRA_WS_URL", f"ws://127.0.0.1:{port}"),
                       ("NEYRA_API_URL", f"http://127.0.0.1:{port}")):
        if not (web.get(key) or "").strip():
            updates[key] = value
    if identity_secret and (web.get("NEYRA_IDENTITY_JWT_SECRET") or "").strip() != identity_secret:
        # Секрет сайта всегда равен ядру: иначе подпись отклоняется.
        updates["NEYRA_IDENTITY_JWT_SECRET"] = identity_secret
    if service_key:
        updates["NEYRA_SERVICE_KEY"] = service_key
    else:
        print(f"внимание: в {CORE_ENV} нет API_TOKEN/API_KEY — впиши NEYRA_SERVICE_KEY вручную", file=sys.stderr)
        status = 2
    if updates:
        write_atomic(WEB_ENV, updates)

    if core_changed:
        print("ядру нужен один перезапуск: sudo systemctl restart neyra.service")
    print(f"env сайта синхронизирован: {WEB_ENV}")
    if status == 0:
        print("связка с ядром готова: NEYRA_* заполнены")
    return status


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError) as exc:
        print(f"env сайта не обновлён: {exc}", file=sys.stderr)
        raise SystemExit(1)
