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
    # Read-only URI so status never mutates a live Hub DB (AR-67).
    uri = db.resolve().as_uri() + "?mode=ro"
    try:
        conn = sqlite3.connect(uri, uri=True)
    except sqlite3.Error:
        return []
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
    parser.add_argument("--data-dir", default="", help="Inspect a standard data-directory copy instead of configured paths")
    args = parser.parse_args()

    from core.runtime.paths import resolve_data_dir

    if args.data_dir:
        # An explicit copy must never silently select the configured live DB.
        data_dir = Path(args.data_dir).expanduser().resolve()
        mem_db = data_dir / "memory" / "neyra_memory.db"
    else:
        try:
            from core.runtime.config_loader import load_layered_config
            from core.runtime.secrets import load_dotenv_file

            load_dotenv_file(SERVER_ROOT)
            cfg = load_layered_config(SERVER_ROOT, validate=True)
            data_dir = resolve_data_dir(SERVER_ROOT, cfg)
            mem_db = Path(cfg["memory"]["sqlite_path"])
        except Exception as exc:
            print(f"Configuration could not be loaded ({type(exc).__name__}); no database inspected.", file=sys.stderr)
            return 2
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
    return 1 if missing else 0


if __name__ == "__main__":
    raise SystemExit(main())
