"""Dashboard gate key store (SQLite). One access key for the web UI login."""

from __future__ import annotations

import hashlib
import hmac
import logging
import sqlite3
import threading
from pathlib import Path

logger = logging.getLogger("neyra.dashboard_auth")

_MIN_KEY_LEN = 4


class DashboardAuthStore:
    def __init__(self, db_path: Path) -> None:
        self.path = Path(db_path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._init_db()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.path), timeout=10)
        conn.execute("PRAGMA journal_mode=WAL")
        return conn

    def _init_db(self) -> None:
        with self._lock:
            with self._connect() as conn:
                conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS dashboard_gate (
                        id INTEGER PRIMARY KEY CHECK (id = 1),
                        salt TEXT NOT NULL,
                        key_hash TEXT NOT NULL,
                        created_at TEXT NOT NULL DEFAULT (datetime('now'))
                    )
                    """
                )
                conn.commit()

    @staticmethod
    def _hash(salt: str, key: str) -> str:
        return hashlib.sha256(f"{salt}:{key}".encode("utf-8")).hexdigest()

    def is_configured(self) -> bool:
        with self._lock:
            with self._connect() as conn:
                row = conn.execute("SELECT 1 FROM dashboard_gate WHERE id = 1").fetchone()
                return row is not None

    def setup(self, key: str) -> None:
        clean = (key or "").strip()
        if len(clean) < _MIN_KEY_LEN:
            raise ValueError(f"Key must be at least {_MIN_KEY_LEN} characters")
        import secrets

        salt = secrets.token_hex(16)
        digest = self._hash(salt, clean)
        with self._lock:
            with self._connect() as conn:
                existing = conn.execute("SELECT 1 FROM dashboard_gate WHERE id = 1").fetchone()
                if existing:
                    raise RuntimeError("Dashboard access key already configured")
                conn.execute(
                    "INSERT INTO dashboard_gate (id, salt, key_hash) VALUES (1, ?, ?)",
                    (salt, digest),
                )
                conn.commit()
        logger.info("Dashboard access key created")

    def verify(self, key: str) -> bool:
        clean = (key or "").strip()
        if not clean:
            return False
        with self._lock:
            with self._connect() as conn:
                row = conn.execute(
                    "SELECT salt, key_hash FROM dashboard_gate WHERE id = 1"
                ).fetchone()
        if not row:
            return False
        salt, expected = row
        got = self._hash(str(salt), clean)
        try:
            return hmac.compare_digest(got, str(expected))
        except Exception:
            return False
