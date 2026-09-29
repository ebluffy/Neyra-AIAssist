"""SQLite schema migrations for Memory Hub v2."""

from __future__ import annotations

# Version 1: chat_log + structured placeholders + outbox.
# schema_migrations is created by SqliteStore.migrate() before this script runs.
MIGRATION_001_SQL = """
CREATE TABLE IF NOT EXISTS chat_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    role TEXT NOT NULL,
    user_id TEXT,
    display_name TEXT,
    channel_id TEXT,
    source TEXT,
    text TEXT NOT NULL,
    turn_id TEXT,
    latency_ms REAL,
    emotion TEXT,
    mood TEXT,
    meta TEXT
);

CREATE INDEX IF NOT EXISTS idx_chat_log_ts ON chat_log(ts);
CREATE INDEX IF NOT EXISTS idx_chat_log_user_ts ON chat_log(user_id, ts);
CREATE INDEX IF NOT EXISTS idx_chat_log_channel_ts ON chat_log(channel_id, ts);
CREATE INDEX IF NOT EXISTS idx_chat_log_turn ON chat_log(turn_id);

CREATE TABLE IF NOT EXISTS people (
    person_id TEXT PRIMARY KEY,
    display_name TEXT,
    aliases TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    meta TEXT
);

CREATE TABLE IF NOT EXISTS person_facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    person_id TEXT NOT NULL,
    fact TEXT NOT NULL,
    emotion_note TEXT,
    created_at TEXT NOT NULL,
    source TEXT,
    meta TEXT,
    FOREIGN KEY(person_id) REFERENCES people(person_id)
);

CREATE INDEX IF NOT EXISTS idx_person_facts_person ON person_facts(person_id);

CREATE TABLE IF NOT EXISTS diary_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    text TEXT NOT NULL,
    source TEXT,
    emotion TEXT,
    meta TEXT
);

CREATE INDEX IF NOT EXISTS idx_diary_ts ON diary_notes(ts);

CREATE TABLE IF NOT EXISTS journal_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    title TEXT,
    text TEXT NOT NULL,
    kind TEXT,
    meta TEXT
);

CREATE INDEX IF NOT EXISTS idx_journal_ts ON journal_entries(ts);

CREATE TABLE IF NOT EXISTS working_memory_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    ts TEXT NOT NULL,
    content TEXT NOT NULL,
    meta TEXT
);

CREATE INDEX IF NOT EXISTS idx_wm_user_ts ON working_memory_snapshots(user_id, ts);

CREATE TABLE IF NOT EXISTS semantic_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    source_row_id TEXT,
    error TEXT
);
"""

MIGRATIONS: list[tuple[int, str]] = [
    (1, MIGRATION_001_SQL),
]
