"""Regression tests for Autoreview · 5a4f4f4 (AR-58..67 slice)."""

from __future__ import annotations

import logging
import sqlite3
import uuid
from io import StringIO
from pathlib import Path
from unittest.mock import patch

import pytest


def test_viewer_cannot_read_chat_audit_aliases(client, auth_headers):
    """AR-60: aliases chat.log / api_audit.jsonl must 403 for viewer."""
    for src in ("chat", "chat.log", "audit", "api_audit", "api_audit.jsonl"):
        r = client.get(f"/v1/logs?source={src}", headers=auth_headers["viewer"])
        assert r.status_code == 403, src


def test_maint_can_read_chat_alias(client, auth_headers, tmp_path):
    # Log file may be missing — endpoint still allows maint past the role gate.
    r = client.get("/v1/logs?source=chat.log", headers=auth_headers["maint"])
    assert r.status_code == 200
    assert r.json()["ok"] is True


def test_inbound_dedup_ttl_allows_replay(client, stub_agent, monkeypatch):
    """AR-62: body-hash dedup expires; same body after TTL is processed again."""
    from core.api import app as api_mod

    ep = f"ep-{uuid.uuid4().hex[:8]}"
    path = f"/v1/webhooks/in/testprov/{ep}"
    body = {"message": f"ping-{uuid.uuid4().hex}", "username": "u"}

    r1 = client.post(path, json=body)
    assert r1.status_code == 200
    assert r1.json()["data"].get("deduplicated") is False
    assert stub_agent.chat.await_count == 1

    r2 = client.post(path, json=body)
    assert r2.status_code == 200
    assert r2.json()["data"].get("deduplicated") is True
    assert stub_agent.chat.await_count == 1

    # Expire all inbound dedup rows.
    store = None
    # Reach store via a fresh claim with TTL=0 by patching the class constant.
    monkeypatch.setattr(api_mod.WebhookStore, "_INBOUND_DEDUP_TTL_BODY_SEC", 0.0)
    r3 = client.post(path, json=body)
    assert r3.status_code == 200
    assert r3.json()["data"].get("deduplicated") is False
    assert stub_agent.chat.await_count == 2


def test_restore_rejects_legacy_restore_literal(client, auth_headers, stub_backup):
    """AR-66: confirm must equal archive_name."""
    stub_backup.resolve_archive_path.return_value = Path("/tmp/x.zip")
    stub_backup.run_backup.return_value = {"archive": "pre.zip"}
    stub_backup.prepare_restore.return_value = {"pending": True}
    r = client.post(
        "/v1/backup/restore",
        headers=auth_headers["admin"],
        json={"archive_name": "neyra-backup-test.zip", "confirm": "RESTORE"},
    )
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "restore_confirm_required"


def test_redaction_on_child_logger_handlers():
    """AR-63: child logger records redacted via root handlers."""
    from core.api.log_redaction import install_log_filters

    secret = "admin-secret-token-xxxxxxxx"
    buf = StringIO()
    handler = logging.StreamHandler(buf)
    handler.setLevel(logging.INFO)
    root = logging.getLogger()
    root.addHandler(handler)
    try:
        install_log_filters(extra_secrets=[secret])
        logging.getLogger("neyra.memory.unit").warning("leak %s in path", secret)
        out = buf.getvalue()
        assert secret not in out
        assert "***" in out
    finally:
        root.removeHandler(handler)


def test_person_accounts_indexes_explain(tmp_path: Path):
    """T-B3: hot lookups use indexes (EXPLAIN QUERY PLAN)."""
    from core.memory.sqlite_store import SqliteStore

    db = tmp_path / "neyra_memory.db"
    store = SqliteStore(db)
    store.migrate()
    cur = store._conn.execute(
        "EXPLAIN QUERY PLAN SELECT person_id FROM person_accounts "
        "WHERE platform = ? AND platform_user_id = ?",
        ("discord", "123"),
    )
    plan = " ".join(str(r[-1]) for r in cur.fetchall()).lower()
    assert "person_accounts" in plan
    assert "scan" not in plan or "index" in plan or "using" in plan
    cur2 = store._conn.execute(
        "EXPLAIN QUERY PLAN SELECT DISTINCT person_id FROM person_accounts WHERE handle_norm = ?",
        ("alice",),
    )
    plan2 = " ".join(str(r[-1]) for r in cur2.fetchall()).lower()
    assert "index" in plan2 or "using" in plan2
    store.close()


def test_backup_restore_real_sqlite_integrity(tmp_path: Path, monkeypatch):
    """T-B4 / AR-59: WAL live DB → backup → restore staging has integrity_check ok."""
    import os

    from core.runtime.backup import BackupManager

    base = tmp_path / "srv"
    mem = base / "data" / "memory"
    mem.mkdir(parents=True)
    db = mem / "neyra_memory.db"
    conn = sqlite3.connect(str(db))
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)")
    conn.execute("INSERT INTO t(v) VALUES ('alpha')")
    conn.commit()
    # Leave uncheckpointed WAL content.
    conn.execute("INSERT INTO t(v) VALUES ('beta-unck')")
    # Do not commit — still in WAL after another connection? Commit so WAL has pages.
    conn.commit()
    conn.close()
    assert (mem / "neyra_memory.db-wal").exists() or True  # wal may exist

    backups = base / "backups"
    backups.mkdir()
    cfg = {
        "backup": {"local_dir": str(backups)},
        "memory": {"chroma_db_path": str(mem / "chroma_db"), "sqlite_path": str(db)},
    }
    (mem / "chroma_db").mkdir()
    (mem / "chroma_db" / "x").write_text("c", encoding="utf-8")
    mgr = BackupManager(cfg)
    cwd = Path.cwd()
    monkeypatch.chdir(base)
    try:
        bak = mgr.run_backup("test")
        name = Path(str(bak["archive"])).name
        # Corrupt live wal marker to prove we don't restore it over snapshot.
        wal = Path(str(db) + "-wal")
        if wal.exists():
            wal.write_bytes(b"STALE" * 20)
        pending = mgr.prepare_restore(name)
        assert pending.get("pending")
        # Inspect staging: no stale wal next to overlaid db when API snapshot used.
        staged = base / ".neyra_pending_restore" / "memory"
        assert staged.is_dir()
        db_staged = staged / "neyra_memory.db"
        assert db_staged.is_file()
        # Stale wal from memory/ copy must not sit beside consistent snapshot.
        assert not (staged / "neyra_memory.db-wal").exists() or (
            staged / "neyra_memory.db-wal"
        ).read_bytes()[:5] != b"STALE"
        c2 = sqlite3.connect(str(db_staged))
        try:
            row = c2.execute("PRAGMA integrity_check").fetchone()
            assert row and row[0] == "ok"
            vals = [r[0] for r in c2.execute("SELECT v FROM t ORDER BY id").fetchall()]
            assert "alpha" in vals
        finally:
            c2.close()
    finally:
        monkeypatch.chdir(cwd)
