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
    # Reach store via a fresh claim with TTL=0 by patching the class constant.
    monkeypatch.setattr(api_mod.WebhookStore, "_INBOUND_DEDUP_TTL_BODY_SEC", 0.0)
    r3 = client.post(path, json=body)
    assert r3.status_code == 200
    assert r3.json()["data"].get("deduplicated") is False
    assert stub_agent.chat.await_count == 2


def test_inbound_cancel_clears_inflight_for_retry(client, stub_agent, tmp_path):
    """AR-62: CancelledError releases inflight; provider retry gets 200."""
    import asyncio
    import concurrent.futures
    import json
    from unittest.mock import AsyncMock

    from core.api.app import WebhookStore

    ep = f"ep-{uuid.uuid4().hex[:8]}"
    path = f"/v1/webhooks/in/testprov/{ep}"
    body = {"message": f"cancel-{uuid.uuid4().hex}", "username": "u"}
    headers = {"Idempotency-Key": f"ik-{uuid.uuid4().hex}"}

    stub_agent.chat = AsyncMock(side_effect=asyncio.CancelledError())
    cancelled = False
    try:
        client.post(path, json=body, headers=headers)
    except (asyncio.CancelledError, concurrent.futures.CancelledError):
        cancelled = True
    assert cancelled, "first request must surface cancel"

    # Retry after cancel must not be stuck on 409 inflight.
    stub_agent.chat = AsyncMock(return_value={"reply": "ok-after-cancel"})
    r2 = client.post(path, json=body, headers=headers)
    assert r2.status_code == 200, r2.text
    assert r2.json()["data"].get("deduplicated") is False
    assert stub_agent.chat.await_count == 1

    # Restart clears leftover inflight rows (disk).
    state_path = tmp_path / "project" / "logs" / "webhooks_state.json"
    raw = state_path.read_text(encoding="utf-8") if state_path.is_file() else "{}"
    data = json.loads(raw) if raw.strip() else {}
    data.setdefault("inbound_dedup", {})["hdr:stuck"] = {
        "key": "hdr:stuck",
        "status": "inflight",
        "stored_at": "2000-01-01T00:00:00+00:00",
    }
    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_path.write_text(json.dumps(data), encoding="utf-8")
    ws = WebhookStore(tmp_path / "project")
    assert "hdr:stuck" not in (ws._state.get("inbound_dedup") or {})


def test_inbound_owned_blocks_parallel_after_disk_ttl(app, stub_agent, monkeypatch):
    """AR-70: process-owned inflight ignores short disk TTL; parallel same key → chat once."""
    import asyncio
    from unittest.mock import AsyncMock

    import httpx
    from httpx import ASGITransport

    from core.api import app as api_mod

    monkeypatch.setattr(api_mod.WebhookStore, "_INBOUND_DEDUP_TTL_INFLIGHT_SEC", 0.05)

    entered = asyncio.Event()

    async def slow_chat(*_a, **_k):
        entered.set()
        await asyncio.sleep(0.25)  # longer than disk inflight TTL
        return {"reply": "once"}

    stub_agent.chat = AsyncMock(side_effect=slow_chat)
    ep = f"ep-{uuid.uuid4().hex[:8]}"
    path = f"/v1/webhooks/in/testprov/{ep}"
    body = {"message": f"slow-{uuid.uuid4().hex}", "username": "u"}
    headers = {"Idempotency-Key": f"ik-{uuid.uuid4().hex}"}

    async def _run() -> None:
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            t1 = asyncio.create_task(ac.post(path, json=body, headers=headers))
            await asyncio.wait_for(entered.wait(), timeout=2.0)
            await asyncio.sleep(0.12)  # past disk TTL; ownership must still block
            t2 = asyncio.create_task(ac.post(path, json=body, headers=headers))
            r1, r2 = await asyncio.gather(t1, t2)
            assert r1.status_code == 200, r1.text
            assert r2.status_code == 409, r2.text
            assert stub_agent.chat.await_count == 1

    asyncio.run(_run())


def test_inbound_eviction_skips_owned_keys(tmp_path: Path, monkeypatch):
    """AR-72: MAX overflow must not evict owned A — claim(A) stays inflight."""
    import asyncio

    from core.api.app import WebhookStore

    monkeypatch.setattr(WebhookStore, "_INBOUND_DEDUP_MAX", 2)
    root = tmp_path / "prj"
    (root / "logs").mkdir(parents=True)
    ws = WebhookStore(root)

    async def _run() -> None:
        assert (await ws.claim_inbound_dedup("hdr:A"))[0] == "proceed"
        assert (await ws.claim_inbound_dedup("hdr:B"))[0] == "proceed"
        assert (await ws.claim_inbound_dedup("hdr:C"))[0] == "proceed"
        assert (await ws.claim_inbound_dedup("hdr:D"))[0] == "proceed"
        # Flood kept A owned; retry must not get proceed (would double-process).
        assert (await ws.claim_inbound_dedup("hdr:A"))[0] == "inflight"
        assert "hdr:A" in ws._owned_inbound

    asyncio.run(_run())


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
    """T-B4 / AR-69: keep WAL open during backup; archive must not ship -wal; beta present."""
    import zipfile

    from core.runtime.backup import BackupManager

    base = tmp_path / "srv"
    mem = base / "data" / "memory"
    mem.mkdir(parents=True)
    db = mem / "neyra_memory.db"
    wal = Path(str(db) + "-wal")
    conn = sqlite3.connect(str(db))
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA wal_autocheckpoint=0")
    conn.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)")
    conn.execute("INSERT INTO t(v) VALUES ('alpha')")
    conn.commit()
    # beta stays only in WAL while connection stays open.
    conn.execute("INSERT INTO t(v) VALUES ('beta')")
    conn.commit()
    assert wal.exists(), "WAL must exist while connection is open"

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
        archive = Path(str(bak["archive"]))
        name = archive.name
        with zipfile.ZipFile(archive) as zf:
            names = zf.namelist()
            assert not any(n.endswith("neyra_memory.db-wal") for n in names), names
            assert any(n.endswith("neyra_memory.db") for n in names), names

        # Corrupt live WAL after backup — must not land in staging.
        wal.write_bytes(b"STALE" * 20)
        pending = mgr.prepare_restore(name)
        assert pending.get("pending")
        staged = base / ".neyra_pending_restore" / "memory"
        assert staged.is_dir()
        db_staged = staged / "neyra_memory.db"
        assert db_staged.is_file()
        assert not (staged / "neyra_memory.db-wal").exists()
        c2 = sqlite3.connect(f"file:{db_staged}?mode=ro", uri=True)
        try:
            row = c2.execute("PRAGMA integrity_check").fetchone()
            assert row and row[0] == "ok"
            vals = [r[0] for r in c2.execute("SELECT v FROM t ORDER BY id").fetchall()]
            assert "alpha" in vals
            assert "beta" in vals
        finally:
            c2.close()
    finally:
        conn.close()
        monkeypatch.chdir(cwd)
