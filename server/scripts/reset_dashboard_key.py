#!/usr/bin/env python3
"""Reset dashboard access key from the server console (no HTTP).

Usage (from server/ or repo root with PYTHONPATH=server):
  python scripts/reset_dashboard_key.py --key '<new-32+-char-key>'
  python scripts/reset_dashboard_key.py --generate
"""

from __future__ import annotations

import argparse
import secrets
import sys
from pathlib import Path

SERVER_ROOT = Path(__file__).resolve().parent.parent
if str(SERVER_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVER_ROOT))


def main() -> int:
    parser = argparse.ArgumentParser(description="Reset Neyra dashboard access key (console only).")
    parser.add_argument("--key", default="", help="New access key (≥32 chars)")
    parser.add_argument("--generate", action="store_true", help="Generate a random 32-byte hex key")
    parser.add_argument(
        "--data-dir",
        default="",
        help="Override data dir (default: resolve from config / NEYRA_DATA_DIR)",
    )
    args = parser.parse_args()

    if args.generate:
        new_key = secrets.token_hex(16)  # 32 hex chars
    else:
        new_key = (args.key or "").strip()
    if len(new_key) < 32:
        print("ERROR: key must be at least 32 characters (or pass --generate)", file=sys.stderr)
        return 2

    from core.api.dashboard_auth import DashboardAuthStore, MIN_KEY_LEN
    from core.runtime.paths import resolve_data_dir

    if args.data_dir:
        data_dir = Path(args.data_dir)
    else:
        try:
            from core.runtime.config_loader import load_config

            cfg = load_config(SERVER_ROOT)
        except Exception:
            cfg = {}
        data_dir = resolve_data_dir(SERVER_ROOT, cfg if isinstance(cfg, dict) else {})

    db = data_dir / "dashboard_auth.sqlite"
    store = DashboardAuthStore(db)
    store.reset_key(new_key)
    print(f"OK: dashboard key reset (min {MIN_KEY_LEN} chars). DB={db}")
    if args.generate:
        print(f"NEW_KEY={new_key}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
