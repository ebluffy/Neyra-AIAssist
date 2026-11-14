"""Discord catalog: migration 8, queued writes, admin queries and API (offline)."""

import sqlite3
from pathlib import Path

import pytest

from core.memory import discord_catalog as catalog
from core.memory.migrations import MIGRATIONS
from core.memory.sqlite_store import SqliteStore, _split_sql_statements
from test_web_identity_review import real_api  # noqa: F401  (fixture)

ADMIN = {"Authorization": "Bearer admin-secret-token-xxxxxxxx"}
VIEWER = {"Authorization": "Bearer viewer-secret-token-xxxxxxx"}
OFFLINE_ADMIN = {"Authorization": "Bearer offline-admin-token"}

NEW_COLUMNS = ("platform", "guild_id", "native_message_id", "native_created_at")


def make_v7(path: Path, *, chat_rows: int = 0) -> None:
    """Create a schema-7 database the way the previous release left it."""
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    try:
        conn.execute("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)")
        for version, sql in MIGRATIONS:
            if version > 7:
                continue
            for statement in _split_sql_statements(sql):
                conn.execute(statement)
            conn.execute("INSERT INTO schema_migrations(version, applied_at) VALUES (?, '2026-01-01T00:00:00+00:00')", (version,))
        for index in range(chat_rows):
            conn.execute(
                "INSERT INTO chat_log(ts, role, user_id, display_name, channel_id, source, text, turn_id)"
                " VALUES (?, 'user', 'person-old', 'Old', 'chan-1', 'chat', ?, ?)",
                (f"2026-11-01T00:0{index}:00+00:00", f"old message {index}", f"turn-old-{index}"),
            )
        conn.commit()
    finally:
        conn.close()


def columns(store: SqliteStore, table: str) -> set[str]:
    return {row[1] for row in store._conn.execute(f"PRAGMA table_info({table})").fetchall()}


def downgrade_to_7(store: SqliteStore) -> None:
    """Test-only reverse of migration 8 (no production downgrade path is shipped)."""
    with store.lock:
        store._conn.execute("DROP INDEX IF EXISTS idx_chat_log_guild_channel_ts")
        for column in NEW_COLUMNS:
            store._conn.execute(f"ALTER TABLE chat_log DROP COLUMN {column}")
        store._conn.execute("DROP TABLE IF EXISTS discord_members")
        store._conn.execute("DROP TABLE IF EXISTS discord_channels")
        store._conn.execute("DROP TABLE IF EXISTS discord_guilds")
        store._conn.execute("DELETE FROM schema_migrations WHERE version = 8")


def seed_catalog(store: SqliteStore) -> None:
    catalog.upsert_guild(store, guild_id="g1", name="Neyra Lab", icon_url="https://cdn.example/icon.png",
                         description="test guild", joined_at="2026-10-01T00:00:00+00:00")
    catalog.upsert_channel(store, channel_id="c1", guild_id="g1", name="general", channel_type="text")
    catalog.upsert_channel(store, channel_id="c2", guild_id="g1", name="voice", channel_type="voice", parent_id="c1")
    catalog.upsert_member(store, guild_id="g1", discord_id="d1", username="dmitry", display_name="Дмитрий")
    catalog.upsert_member(store, guild_id="g1", discord_id="d2", username="bot", display_name="Bot", is_bot=True)


def seed_messages(store: SqliteStore) -> None:
    rows = [
        {"role": "user", "text": "привет", "user_id": "p1", "display_name": "Дмитрий",
         "channel_id": "c1", "source": "chat_stream", "turn_id": "t1", "ts": "2026-11-10T10:00:00+00:00",
         "platform": "discord", "guild_id": "g1", "native_message_id": "m1",
         "native_created_at": "2026-11-10T10:00:00+00:00", "meta": {"discord_id": "d1", "username": "dmitry"}},
        {"role": "assistant", "text": "здравствуй", "user_id": "p1", "display_name": "Нейра",
         "channel_id": "c1", "source": "chat_stream", "turn_id": "t1", "ts": "2026-11-10T10:00:05+00:00",
         "platform": "discord", "guild_id": "g1", "meta": {"discord_id": "d1", "username": "dmitry"}},
        {"role": "user", "text": "как дела", "user_id": "p2", "display_name": "Гость",
         "channel_id": "c2", "source": "chat", "turn_id": "t2", "ts": "2026-11-11T12:00:00+00:00",
         "platform": "discord", "guild_id": "g1"},
        {"role": "user", "text": "старая строка", "user_id": "p-old", "channel_id": "web:u:chat",
         "source": "chat", "turn_id": "t3", "ts": "2026-11-09T09:00:00+00:00"},
    ]
    store.append_chat_rows(rows)


@pytest.fixture()
def store(tmp_path: Path) -> SqliteStore:
    item = SqliteStore(tmp_path / "hub.db")
    try:
        yield item
    finally:
        item.close()


def test_migration_up_on_empty_database(tmp_path: Path):
    db = tmp_path / "empty.db"
    item = SqliteStore(db)
    try:
        assert [int(r[0]) for r in item._conn.execute("SELECT version FROM schema_migrations ORDER BY version")] == [version for version, _ in MIGRATIONS]
        tables = {r[0] for r in item._conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        assert {"discord_guilds", "discord_channels", "discord_members"} <= tables
        assert set(NEW_COLUMNS) <= columns(item, "chat_log")
        indexes = {r[0] for r in item._conn.execute("SELECT name FROM sqlite_master WHERE type='index'")}
        assert {"idx_discord_members_guild", "idx_discord_channels_guild", "idx_chat_log_guild_channel_ts"} <= indexes
    finally:
        item.close()


def test_migration_up_keeps_populated_v7_rows_with_nulls(tmp_path: Path):
    db = tmp_path / "populated.db"
    make_v7(db, chat_rows=3)
    item = SqliteStore(db)
    try:
        assert [int(r[0]) for r in item._conn.execute("SELECT version FROM schema_migrations ORDER BY version")] == [version for version, _ in MIGRATIONS]
        rows = item._conn.execute("SELECT text, platform, guild_id, native_message_id, native_created_at FROM chat_log ORDER BY id").fetchall()
        assert len(rows) == 3
        assert all(row["text"].startswith("old message") for row in rows)
        assert all(row["platform"] is None and row["guild_id"] is None for row in rows)
        assert all(row["native_message_id"] is None and row["native_created_at"] is None for row in rows)
    finally:
        item.close()


def test_migration_round_trip_down_and_up(tmp_path: Path):
    db = tmp_path / "roundtrip.db"
    make_v7(db, chat_rows=2)
    item = SqliteStore(db)
    try:
        seed_catalog(item)
        downgrade_to_7(item)
        assert "platform" not in columns(item, "chat_log")
        assert not {r[0] for r in item._conn.execute("SELECT name FROM sqlite_master WHERE type='table'")} & {
            "discord_guilds", "discord_channels", "discord_members"
        }
        assert item._conn.execute("SELECT COUNT(*) FROM chat_log").fetchone()[0] == 2
        item.migrate()
        assert [int(r[0]) for r in item._conn.execute("SELECT version FROM schema_migrations ORDER BY version")] == [version for version, _ in MIGRATIONS]
        assert set(NEW_COLUMNS) <= columns(item, "chat_log")
        assert item._conn.execute("SELECT COUNT(*) FROM chat_log").fetchone()[0] == 2
    finally:
        item.close()


def test_catalog_upserts_update_instead_of_duplicating(store: SqliteStore):
    seed_catalog(store)
    first_seen = store._conn.execute("SELECT first_seen FROM discord_members WHERE discord_id = 'd1'").fetchone()[0]
    catalog.upsert_member(store, guild_id="g1", discord_id="d1", username="dmitry2", display_name="Дмитрий Н.")
    row = store._conn.execute("SELECT * FROM discord_members WHERE discord_id = 'd1'").fetchone()
    assert row["username"] == "dmitry2"
    assert row["first_seen"] == first_seen
    assert store._conn.execute("SELECT COUNT(*) FROM discord_members").fetchone()[0] == 2

    catalog.delete_channel(store, "c2")
    assert store._conn.execute("SELECT COUNT(*) FROM discord_channels").fetchone()[0] == 1
    catalog.remove_member(store, guild_id="g1", discord_id="d2")
    assert store._conn.execute("SELECT COUNT(*) FROM discord_members").fetchone()[0] == 1


def test_writer_batches_and_survives_bad_items(store: SqliteStore):
    writer = catalog.DiscordCatalogWriter(store)
    written = writer.apply_batch([
        ("guild", {"guild_id": "g1", "name": "Lab"}),
        ("channel", {"channel_id": "c1", "guild_id": "g1", "name": "general", "channel_type": "text"}),
        ("member", {"guild_id": "g1", "discord_id": "d1", "username": "dmitry"}),
        ("member", {"guild_id": "g1"}),  # missing discord_id → ignored
        ("unknown", {"x": 1}),
        ("channel_delete", {"channel_id": "missing"}),
    ])
    assert written == 5
    assert writer.written == 5
    assert store._conn.execute("SELECT COUNT(*) FROM discord_guilds").fetchone()[0] == 1


def test_queries_on_empty_catalog(store: SqliteStore):
    assert catalog.list_guilds(store) == {"items": [], "total": 0, "limit": 50, "offset": 0}
    assert catalog.get_guild(store, "nope") is None
    assert catalog.list_members(store)["items"] == []
    assert catalog.list_messages(store)["items"] == []
    stats = catalog.person_stats(store, "nobody")
    assert stats["messages"] == 0 and stats["days"] == [] and stats["channels"] == []


def test_guild_and_member_queries(store: SqliteStore):
    seed_catalog(store)
    guilds = catalog.list_guilds(store)
    assert guilds["total"] == 1
    item = guilds["items"][0]
    assert item["channel_count"] == 2 and item["member_count"] == 2

    detail = catalog.get_guild(store, "g1")
    assert detail is not None
    assert {channel["name"] for channel in detail["channels"]} == {"general", "voice"}
    assert detail["counts"] == {"channels": 2, "members": 2}

    found = catalog.list_members(store, guild_id="g1", q="дмит")
    assert [row["discord_id"] for row in found["items"]] == ["d1"]
    page = catalog.list_members(store, limit=1, offset=1)
    assert page["total"] == 2 and len(page["items"]) == 1


def test_message_filters_cursor_and_legacy_nulls(store: SqliteStore):
    seed_messages(store)
    everything = catalog.list_messages(store, limit=10)
    assert everything["total"] == 4
    assert [row["ts"] for row in everything["items"]] == sorted((row["ts"] for row in everything["items"]), reverse=True)

    by_guild = catalog.list_messages(store, guild_id="g1", limit=10)
    assert by_guild["total"] == 3
    by_channel = catalog.list_messages(store, channel_id="c2", limit=10)
    assert [row["text"] for row in by_channel["items"]] == ["как дела"]
    by_person = catalog.list_messages(store, person_id="p1", limit=10)
    assert {row["role"] for row in by_person["items"]} == {"user", "assistant"}
    by_text = catalog.list_messages(store, q="привет", limit=10)
    assert [row["text"] for row in by_text["items"]] == ["привет"]
    by_date = catalog.list_messages(store, date_from="2026-11-10T00:00:00+00:00", date_to="2026-11-10T23:59:59+00:00", limit=10)
    assert by_date["total"] == 2

    first = catalog.list_messages(store, limit=2)
    assert first["next_cursor"] == first["items"][-1]["id"]
    second = catalog.list_messages(store, limit=2, cursor=first["next_cursor"])
    assert {row["id"] for row in first["items"]} & {row["id"] for row in second["items"]} == set()

    legacy = [row for row in everything["items"] if row["text"] == "старая строка"][0]
    assert legacy["platform"] is None and legacy["guild_id"] is None
    assert legacy["native_message_id"] is None and legacy["discord_id"] is None

    first_row = [row for row in everything["items"] if row["text"] == "привет"][0]
    assert first_row["discord_id"] == "d1" and first_row["discord_username"] == "dmitry"
    assert first_row["native_message_id"] == "m1"


def test_person_stats_counts_messages_turns_channels_and_days(store: SqliteStore):
    seed_messages(store)
    stats = catalog.person_stats(store, "p1")
    assert stats["messages"] == 2
    assert stats["turns"] == 1
    assert stats["channels"][0]["channel_id"] == "c1"
    assert stats["first_contact"] == "2026-11-10T10:00:00+00:00"
    assert stats["last_contact"] == "2026-11-10T10:00:05+00:00"
    assert stats["days"] == [{"date": "2026-11-10", "messages": 2}]


def test_admin_api_requires_admin_and_returns_catalog(real_api, auth_headers):
    http, agent = real_api
    store = agent.memory_hub.sqlite
    seed_catalog(store)
    seed_messages(store)

    assert http.get("/v1/admin/discord/guilds").status_code == 401
    assert http.get("/v1/admin/discord/guilds", headers=auth_headers["viewer"]).status_code == 403
    assert http.get("/v1/admin/discord/members", headers=auth_headers["maint"]).status_code == 403

    guilds = http.get("/v1/admin/discord/guilds", headers=auth_headers["admin"])
    assert guilds.status_code == 200
    body = guilds.json()["data"]
    assert body["available"] is True and body["total"] == 1
    assert body["items"][0]["channel_count"] == 2

    detail = http.get("/v1/admin/discord/guilds/g1", headers=auth_headers["admin"])
    assert detail.status_code == 200
    assert detail.json()["data"]["counts"]["members"] == 2
    assert http.get("/v1/admin/discord/guilds/unknown", headers=auth_headers["admin"]).status_code == 404

    members = http.get("/v1/admin/discord/members?guild_id=g1&q=дмит", headers=auth_headers["admin"])
    assert members.status_code == 200
    assert [item["discord_id"] for item in members.json()["data"]["items"]] == ["d1"]

    stats = http.get("/v1/admin/discord/users/p1/stats?days=30", headers=auth_headers["admin"])
    assert stats.status_code == 200
    assert stats.json()["data"]["turns"] == 1

    messages = http.get("/v1/admin/discord/messages?guild_id=g1&limit=2", headers=auth_headers["admin"])
    assert messages.status_code == 200
    page = messages.json()["data"]
    assert page["total"] == 3 and len(page["items"]) == 2 and page["next_cursor"]
    next_page = http.get(
        f"/v1/admin/discord/messages?guild_id=g1&limit=2&cursor={page['next_cursor']}",
        headers=auth_headers["admin"],
    )
    assert next_page.json()["data"]["items"]

    bad_date = http.get("/v1/admin/discord/messages?from=вчера", headers=auth_headers["admin"])
    assert bad_date.status_code == 400
    assert http.get("/v1/admin/discord/messages?limit=0", headers=auth_headers["admin"]).status_code == 422


def test_admin_api_survives_agent_without_memory(client, auth_headers):
    for path in (
        "/v1/admin/discord/guilds",
        "/v1/admin/discord/members",
        "/v1/admin/discord/users/p1/stats",
        "/v1/admin/discord/messages",
    ):
        response = client.get(path, headers=auth_headers["admin"])
        assert response.status_code == 200, path
        assert response.json()["data"]["available"] is False
        assert response.json()["data"]["items" if "stats" not in path else "days"] == []
