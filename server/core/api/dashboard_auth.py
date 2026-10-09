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
# OWASP recommendation for PBKDF2-HMAC-SHA256 (2023+).
_PBKDF2_ITERATIONS = 600_000
_LEGACY_DEFAULT_ITERS = 210_000
_SALT_BYTES = 16
_SESSION_TTL_SECONDS = 12 * 3600
_SESSION_BYTES = 32


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
                    CREATE TABLE IF NOT EXISTS schema_migrations (
                        version INTEGER PRIMARY KEY,
                        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
                    )
                    """
                )
                conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS dashboard_gate (
                        id INTEGER PRIMARY KEY CHECK (id = 1),
                        salt TEXT NOT NULL,
                        key_hash TEXT NOT NULL,
                        iterations INTEGER NOT NULL DEFAULT 600000,
                        created_at TEXT NOT NULL DEFAULT (datetime('now'))
                    )
                    """
                )
                cols = {r[1] for r in conn.execute("PRAGMA table_info(dashboard_gate)").fetchall()}
                if "iterations" not in cols:
                    conn.execute(
                        "ALTER TABLE dashboard_gate ADD COLUMN iterations INTEGER NOT NULL DEFAULT 210000"
                    )
                conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS dashboard_sessions (
                        token_hash TEXT PRIMARY KEY,
                        expires_at REAL NOT NULL
                    )
                    """
                )
                # Version 1 = baseline schema above.
                row = conn.execute("SELECT MAX(version) FROM schema_migrations").fetchone()
                if not row or row[0] is None:
                    conn.execute("INSERT INTO schema_migrations (version) VALUES (1)")
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
        iters = int(iterations or _LEGACY_DEFAULT_ITERS)
        try:
            got = self._hash(str(salt), clean, iters)
            if not hmac.compare_digest(got, str(expected)):
                return False
        except Exception:
            return False
        # Transparent rehash to current PBKDF2 iterations on successful login.
        if iters != _PBKDF2_ITERATIONS:
            self._rehash(clean)
        return True

    def _rehash(self, key: str) -> None:
        salt = secrets.token_hex(_SALT_BYTES)
        digest = self._hash(salt, key, _PBKDF2_ITERATIONS)
        with self._lock:
            with self._connect() as conn:
                conn.execute(
                    "UPDATE dashboard_gate SET salt = ?, key_hash = ?, iterations = ? WHERE id = 1",
                    (salt, digest, _PBKDF2_ITERATIONS),
                )
                conn.commit()
        logger.info("Dashboard access key rehashed to %s iterations", _PBKDF2_ITERATIONS)

    def rotate(self, current_key: str, new_key: str) -> None:
        """Replace access key and revoke all sessions."""
        clean_new = (new_key or "").strip()
        if len(clean_new) < MIN_KEY_LEN:
            raise ValueError(f"New key must be at least {MIN_KEY_LEN} characters")
        if not self.verify(current_key):
            raise PermissionError("Current access key is invalid")
        salt = secrets.token_hex(_SALT_BYTES)
        digest = self._hash(salt, clean_new, _PBKDF2_ITERATIONS)
        with self._lock:
            with self._connect() as conn:
                conn.execute(
                    "UPDATE dashboard_gate SET salt = ?, key_hash = ?, iterations = ? WHERE id = 1",
                    (salt, digest, _PBKDF2_ITERATIONS),
                )
                conn.execute("DELETE FROM dashboard_sessions")
                conn.commit()
        logger.info("Dashboard access key rotated; all sessions revoked")

    def reset_key(self, new_key: str) -> None:
        """Console-only reset: set new key and wipe sessions (no current-key check)."""
        clean_new = (new_key or "").strip()
        if len(clean_new) < MIN_KEY_LEN:
            raise ValueError(f"New key must be at least {MIN_KEY_LEN} characters")
        salt = secrets.token_hex(_SALT_BYTES)
        digest = self._hash(salt, clean_new, _PBKDF2_ITERATIONS)
        with self._lock:
            with self._connect() as conn:
                row = conn.execute("SELECT 1 FROM dashboard_gate WHERE id = 1").fetchone()
                if row:
                    conn.execute(
                        "UPDATE dashboard_gate SET salt = ?, key_hash = ?, iterations = ? WHERE id = 1",
                        (salt, digest, _PBKDF2_ITERATIONS),
                    )
                else:
                    conn.execute(
                        "INSERT INTO dashboard_gate (id, salt, key_hash, iterations) VALUES (1, ?, ?, ?)",
                        (salt, digest, _PBKDF2_ITERATIONS),
                    )
                conn.execute("DELETE FROM dashboard_sessions")
                conn.commit()
        logger.info("Dashboard access key reset via console script")

    def issue_session(self) -> str:
        """Random session token accepted as admin Bearer until TTL (no PBKDF2 per request).

        Persists to SQLite and revokes all prior sessions so a new login is the only live admin Bearer.
        """
        token = secrets.token_urlsafe(_SESSION_BYTES)
        th = self._session_hash(token)
        exp = time.time() + _SESSION_TTL_SECONDS
        with self._lock:
            with self._connect() as conn:
                conn.execute("DELETE FROM dashboard_sessions")
                conn.execute(
                    "INSERT INTO dashboard_sessions (token_hash, expires_at) VALUES (?, ?)",
                    (th, exp),
                )
                conn.commit()
        return token

    def revoke_session(self, token: str) -> None:
        th = self._session_hash((token or "").strip())
        with self._lock:
            with self._connect() as conn:
                conn.execute("DELETE FROM dashboard_sessions WHERE token_hash = ?", (th,))
                conn.commit()

    def revoke_all_sessions(self) -> int:
        with self._lock:
            with self._connect() as conn:
                cur = conn.execute("DELETE FROM dashboard_sessions")
                conn.commit()
                return int(cur.rowcount or 0)

    def verify_session(self, token: str) -> bool:
        clean = (token or "").strip()
        if not clean:
            return False
        th = self._session_hash(clean)
        now = time.time()
        with self._lock:
            with self._connect() as conn:
                self._purge_sessions_locked(conn, now)
                row = conn.execute(
                    "SELECT expires_at FROM dashboard_sessions WHERE token_hash = ?",
                    (th,),
                ).fetchone()
                if not row:
                    return False
                exp = float(row[0])
                if now > exp:
                    conn.execute("DELETE FROM dashboard_sessions WHERE token_hash = ?", (th,))
                    conn.commit()
                    return False
                return True

    @staticmethod
    def _purge_sessions_locked(conn: sqlite3.Connection, now: float | None = None) -> None:
        ts = time.time() if now is None else now
        conn.execute("DELETE FROM dashboard_sessions WHERE expires_at < ?", (ts,))
        conn.commit()
