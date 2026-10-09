#!/usr/bin/env python3
"""Read-only status of Memory Hub schema_migrations (+ optional dashboard_auth)."""

from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path

SERVER_ROOT = Path(__file__).resolve().parent.parent
if str(SERVER_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVER_ROOT))


def _versions(db: Path) -> list[int]:
    if not db.is_file():
        return []
    conn = sqlite3.connect(str(db))
    try:
        try:
            rows = conn.execute("SELECT version FROM schema_migrations ORDER BY version").fetchall()
        except sqlite3.Error:
            return []
        return [int(r[0]) for r in rows]
    finally:
        conn.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="Show Neyra DB migration status (read-only).")
    parser.add_argument("--status", action="store_true", default=True, help="Print applied versions")
    parser.add_argument("--data-dir", default="", help="Override data dir")
    args = parser.parse_args()

    from core.runtime.paths import resolve_data_dir

    try:
        from core.runtime.config_loader import load_config

        cfg = load_config(SERVER_ROOT)
    except Exception:
        cfg = {}
    data_dir = Path(args.data_dir) if args.data_dir else resolve_data_dir(SERVER_ROOT, cfg if isinstance(cfg, dict) else {})
    mem_db = data_dir / "memory" / "neyra_memory.db"
    dash_db = data_dir / "dashboard_auth.sqlite"

    from core.memory.migrations import MIGRATIONS

    expected = [v for v, _ in MIGRATIONS]
    applied = _versions(mem_db)
    print(f"memory_db: {mem_db}")
    print(f"  expected: {expected}")
    print(f"  applied:  {applied or '(missing db)'}")
    missing = [v for v in expected if v not in applied]
    print(f"  missing:  {missing or 'none'}")

    dash_vers = _versions(dash_db)
    print(f"dashboard_auth: {dash_db}")
    print(f"  applied: {dash_vers or '(none / legacy)'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
