"""Regression tests for real BackupManager integrated with Control API (/v1/backup/*).

Verifies:
1. RBAC permissions (viewer vs maint vs admin vs unauthenticated).
2. Path disclosure prevention (no absolute host paths in response data).
3. Input validation (confirm matching archive name, path traversal rejection, 404 for missing).
4. End-to-end backup, mutation, staging, pre-restore backup, and restore on synthetic SQLite data.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

import core.api.app as api_app
from core.api.app import build_app
from core.runtime.backup import BackupManager


@pytest.fixture()
def real_backup_env(tmp_path: Path, monkeypatch, stub_agent, stub_monitor):
    """Setup an isolated real BackupManager environment with synthetic SQLite DB."""
    # Ensure current working directory is inside tmp_path for .neyra_pending_restore isolation
    monkeypatch.chdir(tmp_path)

    data_dir = tmp_path / "data"
    mem_dir = data_dir / "memory"
    mem_dir.mkdir(parents=True, exist_ok=True)
    chroma_dir = mem_dir / "chroma_db"
    chroma_dir.mkdir(parents=True, exist_ok=True)
    (chroma_dir / "index.txt").write_text("synthetic-chroma-content", encoding="utf-8")

    db_path = mem_dir / "neyra_memory.db"
    conn = sqlite3.connect(str(db_path))
    try:
        conn.execute("CREATE TABLE synthetic_users (id INTEGER PRIMARY KEY, username TEXT, role TEXT)")
        conn.execute("INSERT INTO synthetic_users VALUES (1, 'synthetic_alice', 'researcher')")
        conn.commit()
    finally:
        conn.close()

    backups_dir = tmp_path / "backups"
    backups_dir.mkdir(parents=True, exist_ok=True)
    logs_dir = tmp_path / "logs"
    logs_dir.mkdir(parents=True, exist_ok=True)
    project_root = tmp_path / "project"
    (project_root / "logs").mkdir(parents=True, exist_ok=True)
    (project_root / "modules").mkdir(parents=True, exist_ok=True)

    cfg: dict[str, Any] = {
        "api": {
            "host": "127.0.0.1",
            "port": 50000,
            "auth_required": True,
            "token": "admin-secret-token-xxxxxxxx",
            "viewer_token": "viewer-secret-token-xxxxxxx",
            "maint_token": "maint-secret-token-xxxxxxxx",
            "state_dir": str(data_dir),
            "audit_log_enabled": False,
            "rate_limit_requests_per_minute": 0,
        },
        "backup": {
            "local_dir": str(backups_dir),
        },
        "memory": {
            "chroma_db_path": str(chroma_dir),
            "sqlite_path": str(db_path),
        },
        "dashboard": {"enabled": False},
        "logging": {"level": "INFO", "system_log": str(logs_dir / "system.log")},
    }

    backup_mgr = BackupManager(cfg)

    scheduled_exits: list[str] = []
    monkeypatch.setattr(
        api_app, "_schedule_exit_after_response", lambda reason="x": scheduled_exits.append(reason)
    )

    app = build_app(
        cfg,
        shared_agent=stub_agent,
        shared_monitor=stub_monitor,
        shared_backup_manager=backup_mgr,
        project_root=project_root,
    )

    client = TestClient(app, client=("127.0.0.1", 50000))

    headers = {
        "admin": {"Authorization": "Bearer admin-secret-token-xxxxxxxx"},
        "maint": {"Authorization": "Bearer maint-secret-token-xxxxxxxx"},
        "viewer": {"Authorization": "Bearer viewer-secret-token-xxxxxxx"},
    }

    return {
        "client": client,
        "backup_mgr": backup_mgr,
        "headers": headers,
        "db_path": db_path,
        "chroma_dir": chroma_dir,
        "backups_dir": backups_dir,
        "scheduled_exits": scheduled_exits,
        "tmp_path": tmp_path,
    }


def test_backup_list_and_run_rbac(real_backup_env):
    """RBAC matrix and safe projection for /v1/backup/list and /v1/backup/run."""
    client = real_backup_env["client"]
    headers = real_backup_env["headers"]
    backup_mgr = real_backup_env["backup_mgr"]

    # 1. Unauthenticated requests
    assert client.get("/v1/backup/list").status_code == 401
    assert client.post("/v1/backup/run").status_code == 401

    # 2. Viewer role: forbidden
    assert client.get("/v1/backup/list", headers=headers["viewer"]).status_code == 403
    assert client.post("/v1/backup/run", headers=headers["viewer"]).status_code == 403

    # 3. Maint role: allowed
    r_list_empty = client.get("/v1/backup/list", headers=headers["maint"])
    assert r_list_empty.status_code == 200
    assert r_list_empty.json()["ok"] is True
    assert r_list_empty.json()["data"]["archives"] == []

    # Run backup to produce non-empty list
    r_run = client.post("/v1/backup/run", headers=headers["maint"])
    assert r_run.status_code == 200
    run_data = r_run.json()["data"]
    assert "archive" in run_data
    assert not run_data["archive"].startswith("/")
    # Security: ensure no internal filesystem paths are exposed
    assert "path" not in run_data
    assert "chroma_db_path" not in run_data

    # 4. Non-empty list safe projection (archives[].path must be excluded)
    r_list_nonempty = client.get("/v1/backup/list", headers=headers["maint"])
    assert r_list_nonempty.status_code == 200
    archives = r_list_nonempty.json()["data"]["archives"]
    assert len(archives) == 1
    arch_item = archives[0]
    assert arch_item["name"] == run_data["archive"]
    assert "bytes" in arch_item and isinstance(arch_item["bytes"], int)
    assert "mtime" in arch_item and isinstance(arch_item["mtime"], str)
    assert "path" not in arch_item, "archives[].path must not be exposed to API clients"

    # 5. last_restore_apply safe projection (aside_path and sqlite_aside_paths must be redacted)
    fake_aside = "/tmp/synthetic_secret_dir/memory.pre-restore-20261110"
    fake_sqlite_aside = "/tmp/synthetic_secret_dir/neyra_memory.db.pre-restore-20261110"
    backup_mgr.write_last_apply_result(
        {
            "status": "rollback_failed",
            "archive_name": run_data["archive"],
            "error": "simulated_error",
            "aside_path": fake_aside,
            "sqlite_aside_paths": [fake_sqlite_aside],
        }
    )

    r_list_with_apply = client.get("/v1/backup/list", headers=headers["maint"])
    assert r_list_with_apply.status_code == 200
    data_with_apply = r_list_with_apply.json()["data"]
    last_apply = data_with_apply["last_restore_apply"]
    assert last_apply is not None
    assert last_apply["status"] == "rollback_failed"
    assert last_apply["archive_name"] == run_data["archive"]
    assert last_apply.get("has_aside") is True
    assert last_apply.get("has_sqlite_asides") is True
    # Ensure internal paths are completely absent from API response
    assert "aside_path" not in last_apply
    assert "sqlite_aside_paths" not in last_apply
    assert "memory_root" not in last_apply
    assert "path" not in last_apply
    assert fake_aside not in r_list_with_apply.text
    assert fake_sqlite_aside not in r_list_with_apply.text


def test_backup_run_does_not_leak_external_storage_path(real_backup_env, tmp_path):
    """LocalFolderStorageAdapter returns an absolute path; the API must expose only its file name."""
    from core.runtime.external_storage import LocalFolderStorageAdapter

    client = real_backup_env["client"]
    headers = real_backup_env["headers"]
    backup_mgr = real_backup_env["backup_mgr"]
    remote_dir = tmp_path / "remote-share"
    backup_mgr.external_adapter = LocalFolderStorageAdapter(remote_dir)

    r_run = client.post("/v1/backup/run", headers=headers["maint"])
    assert r_run.status_code == 200
    data = r_run.json()["data"]
    assert data["external_uploaded"] is True
    assert data["external_name"] == data["archive"]
    assert str(remote_dir) not in r_run.text
    assert str(tmp_path) not in r_run.text
    assert list(remote_dir.glob("neyra-backup-*.zip")), "external copy must still be created"
    assert "external_ref" not in data


def test_backup_restore_rbac_and_validation(real_backup_env):
    """RBAC and validation for /v1/backup/restore."""
    client = real_backup_env["client"]
    headers = real_backup_env["headers"]

    # 1. Unauthenticated & viewer: 401 / 403
    assert client.post("/v1/backup/restore", json={"archive_name": "x.zip", "confirm": "x.zip"}).status_code == 401
    assert client.post(
        "/v1/backup/restore", headers=headers["viewer"], json={"archive_name": "x.zip", "confirm": "x.zip"}
    ).status_code == 403

    # 2. Maint role: restore requires ADMIN, so maint must receive 403
    r_maint = client.post(
        "/v1/backup/restore", headers=headers["maint"], json={"archive_name": "x.zip", "confirm": "x.zip"}
    )
    assert r_maint.status_code == 403, "Maintenance role must not be permitted to trigger backup restore"

    # 3. Admin validation errors
    # Mismatched confirm
    r_bad_confirm = client.post(
        "/v1/backup/restore",
        headers=headers["admin"],
        json={"archive_name": "neyra-backup-20261110.zip", "confirm": "RESTORE"},
    )
    assert r_bad_confirm.status_code == 400
    assert r_bad_confirm.json()["error"]["code"] == "restore_confirm_required"

    # Path traversal attack
    r_traversal = client.post(
        "/v1/backup/restore",
        headers=headers["admin"],
        json={"archive_name": "../evil.zip", "confirm": "../evil.zip"},
    )
    assert r_traversal.status_code == 400

    # Non-existent archive
    r_missing = client.post(
        "/v1/backup/restore",
        headers=headers["admin"],
        json={"archive_name": "neyra-backup-missing.zip", "confirm": "neyra-backup-missing.zip"},
    )
    assert r_missing.status_code == 404


def test_backup_restore_end_to_end_flow(real_backup_env):
    """Full roundtrip: backup creation, mutation, restore staging, and apply on synthetic data."""
    client = real_backup_env["client"]
    headers = real_backup_env["headers"]
    db_path = real_backup_env["db_path"]
    backup_mgr = real_backup_env["backup_mgr"]
    scheduled_exits = real_backup_env["scheduled_exits"]

    # Step 1: Create backup via API
    r_run = client.post("/v1/backup/run", headers=headers["admin"])
    assert r_run.status_code == 200
    archive_name = r_run.json()["data"]["archive"]
    assert archive_name.endswith(".zip")

    # Step 2: Verify archive appears in /v1/backup/list
    r_list = client.get("/v1/backup/list", headers=headers["admin"])
    assert r_list.status_code == 200
    archives = r_list.json()["data"]["archives"]
    assert len(archives) >= 1
    assert any(a["name"] == archive_name for a in archives)

    # Step 3: Mutate live database and live Chroma directory
    chroma_dir = real_backup_env["chroma_dir"]
    conn = sqlite3.connect(str(db_path))
    try:
        conn.execute("INSERT INTO synthetic_users VALUES (2, 'synthetic_bob', 'tester')")
        conn.execute("DELETE FROM synthetic_users WHERE id = 1")
        conn.commit()
        rows = conn.execute("SELECT id, username FROM synthetic_users ORDER BY id").fetchall()
        assert rows == [(2, "synthetic_bob")]
    finally:
        conn.close()

    (chroma_dir / "index.txt").write_text("mutated-chroma-content-bob", encoding="utf-8")
    (chroma_dir / "unwanted_mutated.tmp").write_text("clutter", encoding="utf-8")

    # Step 4: Initiate restore via API
    r_restore = client.post(
        "/v1/backup/restore",
        headers=headers["admin"],
        json={"archive_name": archive_name, "confirm": archive_name},
    )
    assert r_restore.status_code == 200
    data = r_restore.json()["data"]
    assert data["pending"] is True
    assert data["archive_name"] == archive_name
    assert data["restart_scheduled"] is True
    assert "pre_restore_backup_name" in data
    # Security: verify no absolute host paths leaked
    assert "path" not in data
    assert "archive_path" not in data
    assert "restored_from" not in data
    assert "memory_root" not in data
    assert len(scheduled_exits) == 1
    assert f"backup_restore:{archive_name}" in scheduled_exits[0]

    # Step 5: Simulate process restart and apply pending restore
    apply_result = backup_mgr.apply_pending_restore()
    assert apply_result is not None
    assert apply_result["applied"] is True
    assert apply_result["status"] == "applied"

    # Step 6: Verify both SQLite database and Chroma tree are restored to original state
    conn = sqlite3.connect(str(db_path))
    try:
        rows = conn.execute("SELECT id, username, role FROM synthetic_users ORDER BY id").fetchall()
        assert rows == [(1, "synthetic_alice", "researcher")], f"Expected alice restored, got {rows}"
    finally:
        conn.close()

    assert (chroma_dir / "index.txt").read_text(encoding="utf-8") == "synthetic-chroma-content", "Chroma content was not restored!"
    assert not (chroma_dir / "unwanted_mutated.tmp").exists(), "Extraneous file in Chroma was not cleaned up during restore!"


def test_backup_collision_preserves_first_archive_content_frozen_clock(real_backup_env, monkeypatch):
    """Deterministic test: same-second calls allocate distinct archives and NEVER overwrite existing archives."""
    import hashlib
    import zipfile
    from datetime import datetime
    import core.runtime.backup as backup_module

    backup_mgr = real_backup_env["backup_mgr"]
    db_path = real_backup_env["db_path"]

    frozen_now = datetime(2026, 11, 10, 12, 0, 0)

    class MockDateTime:
        @classmethod
        def now(cls):
            return frozen_now

        @classmethod
        def fromtimestamp(cls, ts):
            return datetime.fromtimestamp(ts)

    monkeypatch.setattr(backup_module, "datetime", MockDateTime)

    # 1. First backup at frozen time
    res1 = backup_mgr.run_backup("run1_initial")
    p1 = Path(res1["archive"])
    assert p1.name == "neyra-backup-20261110-120000.zip"
    sha1 = hashlib.sha256(p1.read_bytes()).hexdigest()

    # Verify initial content in archive 1
    with zipfile.ZipFile(p1) as zf:
        manifest1 = json.loads(zf.read("backup_manifest.json").decode("utf-8"))
        assert manifest1["reason"] == "run1_initial"

    # 2. Mutate live DB
    conn = sqlite3.connect(str(db_path))
    try:
        conn.execute("INSERT INTO synthetic_users VALUES (2, 'synthetic_bob', 'tester')")
        conn.execute("DELETE FROM synthetic_users WHERE id = 1")
        conn.commit()
    finally:
        conn.close()

    # 3. Second backup at the EXACT same frozen timestamp
    res2 = backup_mgr.run_backup("run2_mutated")
    p2 = Path(res2["archive"])
    assert p2.name == "neyra-backup-20261110-120000-1.zip"
    sha2 = hashlib.sha256(p2.read_bytes()).hexdigest()

    # CRITICAL: Verify archive 1 was NOT overwritten or modified in any way
    assert hashlib.sha256(p1.read_bytes()).hexdigest() == sha1, "First archive was clobbered by same-second backup!"
    assert sha2 != sha1, "Second archive has same hash as first despite data mutation"

    with zipfile.ZipFile(p2) as zf:
        manifest2 = json.loads(zf.read("backup_manifest.json").decode("utf-8"))
        assert manifest2["reason"] == "run2_mutated"

    # 4. Third backup at the same frozen timestamp (pre-restore test)
    res3 = backup_mgr.prepare_restore(p1.name)
    assert res3["archive_name"] == p1.name
    # First archive must still be strictly identical
    assert hashlib.sha256(p1.read_bytes()).hexdigest() == sha1

    # 5. Apply restore and verify restored content matches archive 1
    apply_res = backup_mgr.apply_pending_restore()
    assert apply_res["applied"] is True

    conn = sqlite3.connect(str(db_path))
    try:
        rows = conn.execute("SELECT id, username, role FROM synthetic_users ORDER BY id").fetchall()
        assert rows == [(1, "synthetic_alice", "researcher")]
    finally:
        conn.close()


def test_concurrent_synthetic_backups_two_instances(real_backup_env):
    """Parallel backups across multiple instances allocate distinct archives without staging clobber."""
    import concurrent.futures
    import zipfile

    cfg = real_backup_env["backup_mgr"].config
    mgr1 = BackupManager(cfg)
    mgr2 = BackupManager(cfg)

    def do_backup(mgr, reason: str):
        return mgr.run_backup(reason)

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        f1 = executor.submit(do_backup, mgr1, "concurrent_1")
        f2 = executor.submit(do_backup, mgr2, "concurrent_2")
        res1 = f1.result()
        res2 = f2.result()

    p1 = Path(res1["archive"])
    p2 = Path(res2["archive"])
    assert p1.is_file()
    assert p2.is_file()
    assert p1 != p2, f"Concurrent backups clobbered to the same path: {p1}"

    # Both must be valid zip archives
    with zipfile.ZipFile(p1) as z1:
        assert "backup_manifest.json" in z1.namelist()
    with zipfile.ZipFile(p2) as z2:
        assert "backup_manifest.json" in z2.namelist()

    all_backups = [b["name"] for b in mgr1.list_backups()]
    assert p1.name in all_backups
    assert p2.name in all_backups


def test_backup_allocation_exhaustion_fails_closed_without_overwriting(real_backup_env, monkeypatch):
    """With a small real candidate list, run_backup fails closed and keeps existing archives intact."""
    import hashlib
    from datetime import datetime as real_datetime

    import core.runtime.backup as backup_module

    backup_mgr = real_backup_env["backup_mgr"]
    backups_dir = real_backup_env["backups_dir"]

    class FrozenDatetime(real_datetime):
        @classmethod
        def now(cls, tz=None):  # noqa: ARG003 - fixed clock for deterministic candidate names
            return cls(2026, 11, 10, 12, 0, 0)

    monkeypatch.setattr(backup_module, "datetime", FrozenDatetime)
    monkeypatch.setattr(backup_module, "ARCHIVE_NAME_LIMIT", 3)

    existing = [
        backups_dir / "neyra-backup-20261110-120000.zip",
        backups_dir / "neyra-backup-20261110-120000-1.zip",
        backups_dir / "neyra-backup-20261110-120000-2.zip",
    ]
    before = {}
    for index, path in enumerate(existing):
        payload = b"PRE_EXISTING_" + str(index).encode()
        path.write_bytes(payload)
        before[path] = (payload, hashlib.sha256(payload).hexdigest())

    with pytest.raises(RuntimeError, match="could not allocate unique backup archive name"):
        backup_mgr.run_backup("fail_closed_test")

    for path, (payload, digest) in before.items():
        assert path.read_bytes() == payload
        assert hashlib.sha256(path.read_bytes()).hexdigest() == digest

    leftovers = [p.name for p in backups_dir.iterdir() if p.name.endswith((".part", ".zip"))]
    assert sorted(leftovers) == sorted(path.name for path in existing)



def test_backup_fallback_publish_without_hardlinks(real_backup_env, monkeypatch):
    """The copy fallback publishes unique archives and leaves no partial files behind."""
    import errno
    import hashlib
    import zipfile
    from datetime import datetime as real_datetime

    import core.runtime.backup as backup_module

    backup_mgr = real_backup_env["backup_mgr"]
    backups_dir = real_backup_env["backups_dir"]

    class FrozenDatetime(real_datetime):
        @classmethod
        def now(cls, tz=None):  # noqa: ARG003 - fixed clock for deterministic names
            return cls(2026, 11, 10, 12, 0, 0)

    monkeypatch.setattr(backup_module, "datetime", FrozenDatetime)
    monkeypatch.setattr(
        backup_module.os,
        "link",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            OSError(errno.EPERM, "hardlinks unavailable")
        ),
    )

    first = Path(backup_mgr.run_backup("fallback_first")["archive"])
    assert first.name == "neyra-backup-20261110-120000.zip"
    digest = hashlib.sha256(first.read_bytes()).hexdigest()
    with zipfile.ZipFile(first) as zf:
        assert json.loads(zf.read("backup_manifest.json"))["reason"] == "fallback_first"

    second = Path(backup_mgr.run_backup("fallback_second")["archive"])
    assert second.name == "neyra-backup-20261110-120000-1.zip"
    with zipfile.ZipFile(second) as zf:
        assert json.loads(zf.read("backup_manifest.json"))["reason"] == "fallback_second"

    assert hashlib.sha256(first.read_bytes()).hexdigest() == digest
    leftovers = [p.name for p in backups_dir.iterdir() if p.name.startswith(".part")]
    assert leftovers == []
    assert not list(backups_dir.glob(".tmp_archive_staging-*"))
    assert not list(backups_dir.glob(".active-staging-*.lock"))
    assert Path(second).stat().st_size > 0


def test_fallback_archive_is_invisible_until_complete_rename(real_backup_env, monkeypatch):
    """AR-6: list/restore cannot observe a half-written final archive name."""
    import errno
    import threading
    from datetime import datetime as real_datetime

    import core.runtime.backup as backup_module

    backup_mgr = real_backup_env["backup_mgr"]
    started = threading.Event()
    release = threading.Event()
    result: list[dict[str, Any]] = []
    errors: list[BaseException] = []
    real_replace = backup_module.os.replace

    class FrozenDatetime(real_datetime):
        @classmethod
        def now(cls, tz=None):  # noqa: ARG003 - fixed time forces a stable target name
            return cls(2026, 11, 10, 12, 0, 0)

    def slow_replace(src, dst):
        started.set()
        if not release.wait(30):
            raise RuntimeError("test did not release atomic publication")
        return real_replace(src, dst)

    monkeypatch.setattr(backup_module, "datetime", FrozenDatetime)
    monkeypatch.setattr(
        backup_module.os,
        "link",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            OSError(errno.EPERM, "hardlinks unavailable")
        ),
    )
    monkeypatch.setattr(backup_module.os, "replace", slow_replace)

    def _publish() -> None:
        try:
            result.append(backup_mgr.run_backup("atomic_visibility"))
        except BaseException as exc:  # noqa: BLE001 - surfaced by the assertion below
            errors.append(exc)

    worker = threading.Thread(target=_publish, name="backup-publisher-under-test")
    worker.start()
    try:
        assert started.wait(30), "backup never reached the atomic rename"
        target = real_backup_env["backups_dir"] / "neyra-backup-20261110-120000.zip"
        assert not target.exists()
        assert backup_mgr.list_backups() == []
    finally:
        release.set()
        worker.join(60)

    assert not worker.is_alive(), "backup publisher did not finish"
    assert not errors, errors
    assert len(result) == 1
    assert Path(result[0]["archive"]).is_file()


def test_concurrent_fallback_publish_is_atomic_and_never_overwrites(real_backup_env, monkeypatch):
    """AR-6: concurrent no-hardlink publishers expose only complete unique archives."""
    import concurrent.futures
    import errno
    import zipfile
    from datetime import datetime as real_datetime

    import core.runtime.backup as backup_module

    backup_mgr = real_backup_env["backup_mgr"]

    class FrozenDatetime(real_datetime):
        @classmethod
        def now(cls, tz=None):  # noqa: ARG003 - fixed time forces a real name collision
            return cls(2026, 11, 10, 12, 0, 0)

    monkeypatch.setattr(backup_module, "datetime", FrozenDatetime)
    monkeypatch.setattr(
        backup_module.os,
        "link",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            OSError(errno.EPERM, "hardlinks unavailable")
        ),
    )

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        futures = [
            pool.submit(backup_mgr.run_backup, reason)
            for reason in ("parallel_fallback_a", "parallel_fallback_b")
        ]
        results = [future.result(timeout=60) for future in futures]

    archives = {Path(result["archive"]).name: Path(result["archive"]) for result in results}
    assert set(archives) == {
        "neyra-backup-20261110-120000.zip",
        "neyra-backup-20261110-120000-1.zip",
    }
    reasons = set()
    for archive in archives.values():
        with zipfile.ZipFile(archive) as zf:
            assert zf.testzip() is None
            reasons.add(json.loads(zf.read("backup_manifest.json"))["reason"])
    assert reasons == {"parallel_fallback_a", "parallel_fallback_b"}


def test_backup_replace_failure_leaves_no_empty_archive(real_backup_env, monkeypatch):
    """A failed replace leaves no archive or staging; only the reusable lock remains."""
    import errno

    import core.runtime.backup as backup_module

    backup_mgr = real_backup_env["backup_mgr"]
    backups_dir = real_backup_env["backups_dir"]

    monkeypatch.setattr(
        backup_module.os,
        "link",
        lambda *args, **kwargs: (_ for _ in ()).throw(OSError(errno.EPERM, "no link")),
    )
    monkeypatch.setattr(
        backup_module.os,
        "replace",
        lambda *args, **kwargs: (_ for _ in ()).throw(OSError(errno.ENOSPC, "disk full")),
    )

    with pytest.raises(OSError):
        backup_mgr.run_backup("replace_failure")

    published = [p for p in backups_dir.iterdir() if p.name.startswith("neyra-backup-")]
    assert published == [], f"failed publish left files: {[p.name for p in published]}"
    leftovers = {p.name for p in backups_dir.iterdir()}
    persistent_locks = {".neyra-backup-publish.lock"}
    assert leftovers == persistent_locks, f"unexpected leftovers: {sorted(leftovers)}"


def test_successful_backup_leaves_no_staging_or_marker_lock(real_backup_env):
    backup_mgr = real_backup_env["backup_mgr"]
    backups_dir = real_backup_env["backups_dir"]

    result = backup_mgr.run_backup("staging_cleanup")

    assert Path(result["archive"]).is_file()
    assert not list(backups_dir.glob(".tmp_backup_staging-*"))
    assert not list(backups_dir.glob(".tmp_archive_staging-*"))
    assert not list(backups_dir.glob(".active-staging-*.lock"))


def test_restore_prepare_leaves_no_staging_or_marker_lock(real_backup_env):
    backup_mgr = real_backup_env["backup_mgr"]
    archive = Path(backup_mgr.run_backup("restore_staging_cleanup")["archive"])

    result = backup_mgr.prepare_restore(archive.name)

    assert result["pending"] is True
    assert not list(real_backup_env["backups_dir"].glob(".tmp_restore-*"))
    assert not list(real_backup_env["backups_dir"].glob(".active-staging-*.lock"))


def test_list_backups_orders_numeric_suffixes(real_backup_env):
    """Suffixes sort numerically: -10 is newer than -2, and the base name is oldest."""
    backup_mgr = real_backup_env["backup_mgr"]
    backups_dir = real_backup_env["backups_dir"]
    names = [
        "neyra-backup-20261110-120000.zip",
        "neyra-backup-20261110-120000-1.zip",
        "neyra-backup-20261110-120000-2.zip",
        "neyra-backup-20261110-120000-10.zip",
    ]
    for name in names:
        (backups_dir / name).write_bytes(b"x")

    listed = [row["name"] for row in backup_mgr.list_backups()]
    assert listed == [
        "neyra-backup-20261110-120000-10.zip",
        "neyra-backup-20261110-120000-2.zip",
        "neyra-backup-20261110-120000-1.zip",
        "neyra-backup-20261110-120000.zip",
    ]


def test_cleanup_stale_artifacts_removes_only_old_entries(real_backup_env):
    """Crash leftovers older than an hour are removed; live staging is kept."""
    import os
    import time

    backup_mgr = real_backup_env["backup_mgr"]
    backups_dir = real_backup_env["backups_dir"]
    old = time.time() - 2 * 3600

    stale_dir = backups_dir / ".tmp_backup_staging-old"
    stale_dir.mkdir()
    (stale_dir / "memory.bin").write_bytes(b"old")
    os.utime(stale_dir, (old, old))
    stale_part = backups_dir / ".part-old.zip"
    stale_part.write_bytes(b"old")
    os.utime(stale_part, (old, old))
    stale_archive_stage = backups_dir / ".tmp_archive_staging-old"
    stale_archive_stage.mkdir()
    os.utime(stale_archive_stage, (old, old))
    fresh_part = backups_dir / ".part-fresh.zip"
    fresh_part.write_bytes(b"fresh")

    # Cleanup also runs on first construction per process; calling it directly keeps
    # this test independent of when the fixture manager was built (see AR-11 test).
    backup_mgr.cleanup_stale_artifacts()

    assert not stale_dir.exists()
    assert not stale_part.exists()
    assert not stale_archive_stage.exists()
    assert fresh_part.exists()


def test_concurrent_manager_does_not_delete_live_staging(real_backup_env, monkeypatch):
    """AR-11: a BackupManager created during a running backup must keep its staging.

    ``reflection/engine.py`` constructs a new ``BackupManager`` while the server is
    up, and a long copy leaves the staging directory with an old mtime, so cleanup
    must not rely on mtime alone nor repeat on every construction.
    """
    import os
    import shutil
    import threading
    import time

    backup_mgr = real_backup_env["backup_mgr"]
    backups_dir = real_backup_env["backups_dir"]
    started = threading.Event()
    release = threading.Event()
    errors: list[BaseException] = []
    real_copytree = shutil.copytree

    def slow_copytree(src, dst, *args, **kwargs):
        started.set()
        if not release.wait(30):
            raise RuntimeError("test did not release the copy")
        return real_copytree(src, dst, *args, **kwargs)

    monkeypatch.setattr("core.runtime.backup.shutil.copytree", slow_copytree)

    def _run_backup() -> None:
        try:
            backup_mgr.run_backup("concurrent")
        except BaseException as exc:  # noqa: BLE001 - surfaced by the assertion below
            errors.append(exc)

    worker = threading.Thread(target=_run_backup, name="backup-under-test")
    worker.start()
    try:
        assert started.wait(30), "backup never reached the copy stage"
        staging = [p for p in backups_dir.iterdir() if p.name.startswith(".tmp_backup_staging-")]
        assert len(staging) == 1, staging
        old = time.time() - 2 * 3600
        os.utime(staging[0], (old, old))

        # Mid-run construction (same call the reflection engine makes) must not delete it.
        BackupManager(backup_mgr.config)
        assert staging[0].exists()

        # Even an explicit cleanup has to skip a staging directory in active use.
        backup_mgr.cleanup_stale_artifacts()
        assert staging[0].exists()
    finally:
        release.set()
        worker.join(60)

    assert not worker.is_alive(), "backup thread did not finish"
    assert not errors, errors
    archives = backup_mgr.list_backups()
    assert len(archives) == 1, archives


def test_subprocess_cleanup_does_not_delete_live_staging(real_backup_env, monkeypatch):
    """AR-12: a fresh process cannot remove another process's live staging directory."""
    import os
    import shutil
    import subprocess
    import sys
    import threading
    import time

    backup_mgr = real_backup_env["backup_mgr"]
    backups_dir = real_backup_env["backups_dir"]
    started = threading.Event()
    release = threading.Event()
    errors: list[BaseException] = []
    real_copytree = shutil.copytree
    server_root = Path(__file__).resolve().parents[1]

    def slow_copytree(src, dst, *args, **kwargs):
        started.set()
        if not release.wait(30):
            raise RuntimeError("test did not release the copy")
        return real_copytree(src, dst, *args, **kwargs)

    monkeypatch.setattr("core.runtime.backup.shutil.copytree", slow_copytree)

    def _run_backup() -> None:
        try:
            backup_mgr.run_backup("subprocess_cleanup")
        except BaseException as exc:  # noqa: BLE001 - surfaced by the assertion below
            errors.append(exc)

    worker = threading.Thread(target=_run_backup, name="backup-under-test")
    worker.start()
    try:
        assert started.wait(30), "backup never reached the copy stage"
        staging = [p for p in backups_dir.iterdir() if p.name.startswith(".tmp_backup_staging-")]
        assert len(staging) == 1, staging
        old = time.time() - 2 * 3600
        os.utime(staging[0], (old, old))

        env = os.environ.copy()
        env["PYTHONPATH"] = os.pathsep.join(
            item for item in (str(server_root), env.get("PYTHONPATH", "")) if item
        )
        code = (
            "import sys; from core.runtime.backup import BackupManager; "
            "BackupManager({'backup': {'local_dir': sys.argv[1]}})"
        )
        child = subprocess.run(
            [sys.executable, "-c", code, str(backups_dir)],
            cwd=server_root,
            env=env,
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        assert child.returncode == 0, child.stderr
        assert staging[0].exists(), "fresh-process cleanup removed live staging"
        assert (backups_dir / f".active-staging-{staging[0].name}.lock").exists()
    finally:
        release.set()
        worker.join(60)

    assert not worker.is_alive(), "backup thread did not finish"
    assert not errors, errors
    assert len(backup_mgr.list_backups()) == 1
