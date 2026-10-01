"""Dashboard gate key store (SQLite) + short-lived session tokens for SPA Bearer."""

from __future__ import annotations

import hashlib
import hmac
import logging
import secrets
import sqlite3
import threading
import time
from pathlib import Path

logger = logging.getLogger("neyra.dashboard_auth")

MIN_KEY_LEN = 32
_PBKDF2_ITERATIONS = 210_000
_SALT_BYTES = 16
_SESSION_TTL_SECONDS = 12 * 3600
_SESSION_BYTES = 32


class DashboardAuthStore:
    def __init__(self, db_path: Path) -> None:
        self.path = Path(db_path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        # token_hash -> expiry unix
        self._sessions: dict[str, float] = {}
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
                        iterations INTEGER NOT NULL DEFAULT 210000,
                        created_at TEXT NOT NULL DEFAULT (datetime('now'))
                    )
                    """
                )
                cols = {r[1] for r in conn.execute("PRAGMA table_info(dashboard_gate)").fetchall()}
                if "iterations" not in cols:
                    conn.execute(
                        "ALTER TABLE dashboard_gate ADD COLUMN iterations INTEGER NOT NULL DEFAULT 210000"
                    )
                conn.commit()

    @staticmethod
    def _hash(salt_hex: str, key: str, iterations: int = _PBKDF2_ITERATIONS) -> str:
        return hashlib.pbkdf2_hmac(
            "sha256",
            key.encode("utf-8"),
            bytes.fromhex(salt_hex),
            int(iterations),
        ).hex()

    @staticmethod
    def _session_hash(token: str) -> str:
        return hashlib.sha256(token.encode("utf-8")).hexdigest()

    def is_configured(self) -> bool:
        with self._lock:
            with self._connect() as conn:
                row = conn.execute("SELECT 1 FROM dashboard_gate WHERE id = 1").fetchone()
                return row is not None

    def setup(self, key: str) -> None:
        clean = (key or "").strip()
        if len(clean) < MIN_KEY_LEN:
            raise ValueError(f"Key must be at least {MIN_KEY_LEN} characters")
        salt = secrets.token_hex(_SALT_BYTES)
        digest = self._hash(salt, clean, _PBKDF2_ITERATIONS)
        with self._lock:
            with self._connect() as conn:
                existing = conn.execute("SELECT 1 FROM dashboard_gate WHERE id = 1").fetchone()
                if existing:
                    raise RuntimeError("Dashboard access key already configured")
                conn.execute(
                    "INSERT INTO dashboard_gate (id, salt, key_hash, iterations) VALUES (1, ?, ?, ?)",
                    (salt, digest, _PBKDF2_ITERATIONS),
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
                    "SELECT salt, key_hash, iterations FROM dashboard_gate WHERE id = 1"
                ).fetchone()
        if not row:
            return False
        salt, expected, iterations = row
        iters = int(iterations or _PBKDF2_ITERATIONS)
        try:
            got = self._hash(str(salt), clean, iters)
            return hmac.compare_digest(got, str(expected))
        except Exception:
            return False

    def issue_session(self) -> str:
        """Random session token accepted as admin Bearer until TTL (no PBKDF2 per request).

        Revokes all prior sessions so a new login is the only live admin Bearer.
        """
        token = secrets.token_urlsafe(_SESSION_BYTES)
        th = self._session_hash(token)
        exp = time.time() + _SESSION_TTL_SECONDS
        with self._lock:
            self._sessions.clear()
            self._sessions[th] = exp
        return token

    def revoke_session(self, token: str) -> None:
        th = self._session_hash((token or "").strip())
        with self._lock:
            self._sessions.pop(th, None)

    def verify_session(self, token: str) -> bool:
        clean = (token or "").strip()
        if not clean:
            return False
        th = self._session_hash(clean)
        now = time.time()
        with self._lock:
            exp = self._sessions.get(th)
            if exp is None:
                return False
            if now > exp:
                self._sessions.pop(th, None)
                return False
            return True

    def _purge_sessions_locked(self) -> None:
        now = time.time()
        dead = [k for k, exp in self._sessions.items() if now > exp]
        for k in dead:
            del self._sessions[k]
