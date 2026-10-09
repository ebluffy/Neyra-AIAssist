#!/usr/bin/env python3
"""Restore the latest backup into a temp dir and verify integrity (offline drill)."""

from __future__ import annotations

import json
import shutil
import sqlite3
import sys
import tempfile
import zipfile
from pathlib import Path

SERVER_ROOT = Path(__file__).resolve().parent.parent
if str(SERVER_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVER_ROOT))


def main() -> int:
    from core.runtime.backup import BackupManager
    from core.runtime.config_loader import load_config

    try:
        cfg = load_config(SERVER_ROOT)
    except Exception:
        cfg = {"memory": {"backup": {"local_dir": "./data/backups"}}}

    bm = BackupManager(cfg if isinstance(cfg, dict) else {})
    rows = bm.list_backups()
    if not rows:
        print("FAIL: no backups found")
        return 2
    name = str(rows[0].get("name") or "")
    archive = bm.resolve_archive_path(name)
    tmp = Path(tempfile.mkdtemp(prefix="neyra_drill_"))
    report: dict = {"archive": name, "ok": False}
    try:
        with zipfile.ZipFile(archive, "r") as zf:
            zf.extractall(tmp)
        # Prefer staged sqlite under data/memory or memory/
        candidates = list(tmp.rglob("neyra_memory.db")) + list(tmp.rglob("*.db"))
        db_ok = True
        checked = 0
        for db in candidates[:5]:
            if not db.is_file():
                continue
            checked += 1
            conn = sqlite3.connect(str(db))
            try:
                row = conn.execute("PRAGMA integrity_check").fetchone()
                if not row or str(row[0]).lower() != "ok":
                    db_ok = False
                    report["integrity"] = str(row[0] if row else "fail")
            finally:
                conn.close()
        report["sqlite_checked"] = checked
        report["ok"] = db_ok and checked > 0
        out = SERVER_ROOT / "logs" / "backup_drill_last.json"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0 if report["ok"] else 1
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
