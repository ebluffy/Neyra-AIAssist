#!/usr/bin/env python3
"""Связка .env сайта с ядром Neyra: NEYRA_* без дублей, атомарно, без печати значений.

Идемпотентно. Секреты (service key, identity secret) всегда приводятся к значениям
ядра; URL заполняются только если пусты, чтобы не затирать явную настройку.
Identity-issuer — одно значение для ядра и сайта: по умолчанию "neyra-web";
уже заданное непустое не перезаписывается, расхождение сайта с ядром
приводится к значению ядра с предупреждением.
Коды выхода: 0 — всё связано; 2 — частично (чат не готов), 1 — фатальная ошибка.
"""
from __future__ import annotations

import os
import secrets
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from env_parse import parse_env, read_env  # noqa: E402

WEB_ENV = Path(os.environ.get("WEB", "/opt/neyra/web")) / ".env"
CORE_DIR = Path(os.environ.get("CORE", "/opt/neyra/server"))
CORE_ENV = CORE_DIR / ".env"
DEFAULT_ISSUER = "neyra-web"

def serialize(key: str, value: str) -> str:
    # Одинарные кавычки понимают и systemd EnvironmentFile, и dotenv; shell-раскрытия нет.
    if any(ch in value for ch in ("'", "\n", "\r", "\0")):
        raise ValueError(f"{key}: значение содержит недопустимые для .env символы")
    return f"{key}='{value}'"


def write_atomic(path: Path, updates: dict[str, str]) -> None:
    """Заменить/добавить ключи, убрать дубли, сохранить владельца; права 0600."""
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
        os.chmod(tmp, 0o600)
        if st is not None and hasattr(os, "chown"):
            os.chown(tmp, st.st_uid, st.st_gid)
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

    web = read_env(WEB_ENV)
    core = read_env(CORE_ENV) if CORE_ENV.is_file() else {}

    service_key = (core.get("API_TOKEN") or core.get("API_KEY") or "").strip()
    identity_secret = (core.get("NEYRA_IDENTITY_JWT_SECRET") or "").strip()
    core_issuer = (core.get("NEYRA_IDENTITY_JWT_ISSUER") or "").strip()
    web_issuer = (web.get("NEYRA_IDENTITY_JWT_ISSUER") or "").strip()
    core_ok = CORE_ENV.is_file()

    status = 0
    core_changed = False
    if not identity_secret:
        identity_secret = secrets.token_hex(32)
        core_changed = core_ok
        if not core_ok:
            print(f"нет {CORE_ENV}: секрет identity записан только сайту, чат не заработает", file=sys.stderr)
            status = 2

    updates: dict[str, str] = {}
    # Issuer (#73): ядро требует NEYRA_IDENTITY_JWT_ISSUER без дефолта, сайт подписывает
    # iss ровно им. Одно значение на оба .env: заданное непустое не трогаем, при
    # расхождении сайта с ядром приводим сайт к ядру (сайт обязан совпадать).
    if not core_issuer and not web_issuer:
        core_issuer = DEFAULT_ISSUER
        web_issuer = DEFAULT_ISSUER
        if core_ok:
            core_changed = True
        else:
            print(f"нет {CORE_ENV}: issuer '{DEFAULT_ISSUER}' записан только сайту", file=sys.stderr)
            status = 2
        updates["NEYRA_IDENTITY_JWT_ISSUER"] = web_issuer
    elif not core_issuer:
        # В ядре пусто, у сайта задано — одно значение на двоих: перенимаем сайтовское.
        core_issuer = web_issuer
        if core_ok:
            core_changed = True
        else:
            print(f"нет {CORE_ENV}: issuer сайта не записан ядру", file=sys.stderr)
            status = 2
    elif not web_issuer:
        updates["NEYRA_IDENTITY_JWT_ISSUER"] = core_issuer
    elif web_issuer != core_issuer:
        print(
            f"внимание: issuer сайта отличается от ядра — сайт приведён к '{core_issuer}'",
            file=sys.stderr,
        )
        updates["NEYRA_IDENTITY_JWT_ISSUER"] = core_issuer
        web_issuer = core_issuer

    port = core_port()
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
    # Всё, что пишем, обязано читаться тем же парсером: иначе loader отвергнет файл.
    for key, value in updates.items():
        if parse_env(serialize(key, value)).get(key) != value:
            raise ValueError(f"{key}: значение не переживает запись в .env")

    if core_changed:
        core_updates = {}
        if not (core.get("NEYRA_IDENTITY_JWT_SECRET") or "").strip():
            core_updates["NEYRA_IDENTITY_JWT_SECRET"] = identity_secret
        if (core.get("NEYRA_IDENTITY_JWT_ISSUER") or "").strip() != core_issuer:
            core_updates["NEYRA_IDENTITY_JWT_ISSUER"] = core_issuer
        if core_updates:
            write_atomic(CORE_ENV, core_updates)
            print(f"identity (секрет/issuer) добавлен в {CORE_ENV} (значения не печатаю)")
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
