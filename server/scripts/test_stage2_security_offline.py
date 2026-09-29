#!/usr/bin/env python3
"""Offline checks for Stage 2 security / archive scoping (no live core)."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def _test_diary_digest_no_user_lines() -> None:
    from core.agent.session_archive import format_diary_digest

    hist = [
        {"role": "user", "content": "alice secret passphrase"},
        {"role": "assistant", "content": "ok"},
    ]
    note = format_diary_digest(hist, reason="overflow", max_chars=400)
    assert "alice secret" not in note
    assert "U:" not in note
    assert "session_archive/overflow" in note


def _test_contextvar_isolation() -> None:
    from core.tools.builtins import (
        clear_turn_memory_scope,
        get_turn_memory_scope,
        set_turn_memory_scope,
    )

    async def one(uid: str) -> str:
        set_turn_memory_scope(user_id=uid, channel_id="c")
        await asyncio.sleep(0.01)
        return get_turn_memory_scope()["user_id"]

    async def run() -> None:
        a, b = await asyncio.gather(one("userA"), one("userB"))
        assert a == "userA" and b == "userB", (a, b)
        clear_turn_memory_scope()
        assert get_turn_memory_scope()["user_id"] == ""

    asyncio.run(run())


def _test_rag_postfilter_shared_only_knowledge() -> None:
    """Mirror LongTermMemory.search post-filter rule."""

    def allow(uid: str, owner: str, typ: str) -> bool:
        owner = (owner or "").strip()
        typ = (typ or "").strip().lower()
        return owner == uid or typ == "knowledge"

    assert allow("bob", "bob", "session_archive_digest")
    assert not allow("bob", "alice", "session_archive_digest")
    assert not allow("bob", "", "session_archive_digest")
    assert allow("bob", "", "knowledge")
    assert allow("bob", "alice", "knowledge")


def _test_scoped_archive_skips_foreign_stm() -> None:
    from core.agent.session_archive import archive_session

    class FakeSTM:
        def __init__(self, h):
            self._h = h

        def get_history(self):
            return list(self._h)

        def clear(self):
            self._h.clear()

        def __len__(self):
            return len(self._h)

    class FakeHub:
        def __init__(self, rows):
            self.rows = rows
            self.diary: list[str] = []
            self.knowledge: list[tuple] = []

        def list_chat(self, **kw):
            uid = kw.get("user_id")
            cid = kw.get("channel_id")
            filtered = [
                r
                for r in self.rows
                if (not uid or r.get("user_id") == uid)
                and (not cid or r.get("channel_id") == cid)
            ]
            return list(reversed(filtered))[: kw.get("limit", 40)]

        def add_diary_note(self, text, **kw):
            self.diary.append(text)
            return 1

        def remember_knowledge(self, text, meta=None):
            self.knowledge.append((text, meta))
            return True, "id1"

    class FakeAgent:
        def __init__(self, stm, hub):
            self.short_memory = stm
            self.memory_hub = hub
            self.config = {
                "memory": {
                    "session_archive": {
                        "enabled": True,
                        "on_overflow": True,
                        "write_diary": True,
                        "write_ltm_digest": True,
                        "clear_stm_after": False,
                        "max_window_chars": 8000,
                        "max_diary_chars": 400,
                    }
                }
            }
            self.event_bus = None

        async def summarize_ltm_corpus(self, window, consolidation=False):
            return "DIGEST:" + window[:120]

    stm = FakeSTM(
        [
            {"role": "user", "content": "alice secret"},
            {"role": "assistant", "content": "reply alice"},
            {"role": "user", "content": "bob hi"},
            {"role": "assistant", "content": "reply bob"},
        ]
    )
    hub = FakeHub(
        [
            {"role": "user", "user_id": "bob", "channel_id": "c1", "text": "bob hi"},
            {
                "role": "assistant",
                "user_id": "bob",
                "channel_id": "c1",
                "text": "reply bob",
            },
            {
                "role": "user",
                "user_id": "alice",
                "channel_id": "c2",
                "text": "alice secret",
            },
            {
                "role": "assistant",
                "user_id": "alice",
                "channel_id": "c2",
                "text": "reply alice",
            },
        ]
    )
    agent = FakeAgent(stm, hub)

    async def run() -> None:
        r = await archive_session(
            agent, reason="overflow", user_id="bob", channel_id="c1"
        )
        assert r["ran"] and r["ltm_digest_written"], r
        assert r["history_source"] == "chat_log", r
        text, meta = hub.knowledge[0]
        assert "alice secret" not in text
        assert "bob hi" in text
        assert meta["user_id"] == "bob"

        hub_empty = FakeHub([])
        agent2 = FakeAgent(stm, hub_empty)
        r2 = await archive_session(
            agent2, reason="overflow", user_id="bob", channel_id="c1"
        )
        assert r2["ran"] and not r2["ltm_digest_written"], r2
        assert "A-tail" not in hub_empty.diary[0]

    asyncio.run(run())


def _test_diary_prompt_skips_session_archive() -> None:
    from core.memory.hub import MemoryHub

    class _FakeSqlite:
        def list_diary_notes(self, *, limit=20, newest_first=True):
            return [
                {
                    "ts": "2026-01-01T00:00:00Z",
                    "source": "session_archive",
                    "text": "should not appear in prompt",
                    "emotion": "",
                    "meta": {},
                },
                {
                    "ts": "2026-01-01T00:01:00Z",
                    "source": "manual",
                    "text": "ok note",
                    "emotion": "",
                    "meta": {},
                },
            ]

    hub = MemoryHub.__new__(MemoryHub)
    hub.sqlite = _FakeSqlite()
    text = hub.diary_recent_text(limit=10)
    assert "should not appear" not in text
    assert "ok note" in text


def _test_memory_model_429_backoff() -> None:
    from core.llm.retry import ainvoke_with_rate_limit_backoff, is_retryable_llm_error

    assert is_retryable_llm_error(RuntimeError("HTTP 429 rate limit"))
    assert not is_retryable_llm_error(RuntimeError("boom 500"))

    class Flaky:
        def __init__(self) -> None:
            self.n = 0

        async def ainvoke(self, messages):
            self.n += 1
            if self.n < 3:
                raise RuntimeError("Error code: 429 - rate limit exceeded")
            return "ok"

    async def run() -> None:
        llm = Flaky()
        out = await ainvoke_with_rate_limit_backoff(
            llm,
            ["x"],
            lane="memory_model",
            max_attempts=5,
            base_delay_seconds=0.01,
            max_delay_seconds=0.05,
        )
        assert out == "ok" and llm.n == 3

    asyncio.run(run())


def main() -> int:
    _test_diary_digest_no_user_lines()
    _test_contextvar_isolation()
    _test_rag_postfilter_shared_only_knowledge()
    _test_scoped_archive_skips_foreign_stm()
    _test_diary_prompt_skips_session_archive()
    _test_memory_model_429_backoff()
    print("stage2 security offline: OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
