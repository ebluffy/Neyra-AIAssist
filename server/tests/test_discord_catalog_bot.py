"""Discord bot → catalog handlers: backpressure, prune markers and guild lifecycle."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

from modules.discord.bot import NeyraDiscordBot


class FakeCatalog:
    def __init__(self):
        self.submitted: list[tuple[str, dict]] = []
        self.waited: list[tuple[str, dict]] = []
        self.dropped = 0

    def submit(self, kind, **payload):
        self.submitted.append((kind, payload))
        return True

    async def submit_wait(self, kind, **payload):
        self.waited.append((kind, payload))


def make_bot(catalog, *, person="person-1", store=None):
    bot = SimpleNamespace(
        _catalog=catalog,
        _catalog_store=lambda: store,
        _person_for_discord_id=lambda discord_id: person,
        guilds=[],
    )
    for name in ("_sync_catalog", "_queue_guild", "on_guild_update", "on_guild_remove"):
        setattr(bot, name, getattr(NeyraDiscordBot, name).__get__(bot, SimpleNamespace))
    return bot


def make_guild():
    icon = SimpleNamespace(url="https://cdn.example/icon.png")
    me = SimpleNamespace(joined_at=SimpleNamespace(isoformat=lambda: "2026-11-01T00:00:00+00:00"))
    channel = SimpleNamespace(id=10, name="general", type="text", parent_id=None)
    member = SimpleNamespace(id=20, name="user", display_name="User", bot=False, guild=None)
    guild = SimpleNamespace(
        id=1, name="Guild", icon=icon, description="d", me=me,
        channels=[channel], members=[member],
    )
    member.guild = guild
    return guild


def test_sync_uses_backpressure_and_prune_marker():
    catalog = FakeCatalog()
    bot = make_bot(catalog)
    guild = make_guild()
    bot.guilds = [guild]

    asyncio.run(bot._sync_catalog())

    kinds = [kind for kind, _ in catalog.waited]
    assert kinds == ["guild", "channel", "member", "guild_prune"]
    member_payload = next(payload for kind, payload in catalog.waited if kind == "member")
    assert member_payload["person_id"] == "person-1"
    assert catalog.waited[-1][1]["guild_id"] == "1"


def test_guild_update_and_remove_handlers():
    catalog = FakeCatalog()
    bot = make_bot(catalog)
    guild = make_guild()

    asyncio.run(bot.on_guild_update(None, guild))
    asyncio.run(bot.on_guild_remove(guild))

    assert [kind for kind, _ in catalog.submitted] == ["guild", "guild_delete"]


def test_person_lookup_reads_existing_account_and_never_creates():
    class Store:
        def __init__(self):
            self.calls = 0

        def get_account(self, platform, platform_user_id):
            self.calls += 1
            assert platform == "discord"
            return {"person_id": "p-existing"}

    store = Store()
    bot = make_bot(FakeCatalog(), store=store)
    bot._person_for_discord_id = NeyraDiscordBot._person_for_discord_id.__get__(bot, SimpleNamespace)
    assert bot._person_for_discord_id("42") == "p-existing"
    assert store.calls == 1
