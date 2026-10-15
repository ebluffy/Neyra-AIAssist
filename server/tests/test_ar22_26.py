"""Regression coverage for the review of 808391e; no live integrations."""

import asyncio
from types import SimpleNamespace as NS

import pytest

from core.agent.model_trace import MEMORY_JOB
from offline_support import offline_agent


@pytest.mark.parametrize("failure", ["empty", "provider", "write"])
def test_mixed_owner_consolidation_rolls_back_and_can_retry(tmp_path, failure):
    from core.memory.ltm_maintenance import _legacy_execute_ltm_summarize
    stored, archived = {}, []
    failing = True

    async def summarize(text, **kwargs):
        if failing and text == "owner-b":
            if failure == "empty":
                return ""
            if failure == "provider":
                raise RuntimeError("provider unavailable")
        return f"digest {text}"

    def add(text, meta):
        if failing and failure == "write" and meta["user_id"] == "b":
            return False, "write failed"
        key = f"digest-{meta['user_id']}"
        assert key not in stored, "retry must not duplicate an earlier partial digest"
        stored[key] = text
        return True, key

    agent = NS(summarize_ltm_corpus=summarize, long_memory=NS(
        add_knowledge=add,
        delete_document_ids=lambda ids: [stored.pop(key) for key in ids],
        archive_older_than=lambda *args, **kwargs: (archived.append(True) or {"archived": 2}),
    ))
    rows = [("a", {"user_id": "a"}, "owner-a"), ("b", {"user_id": "b"}, "owner-b")]

    async def run():
        return await _legacy_execute_ltm_summarize(agent, {}, tmp_path, rows=rows, older_than_days=30,
            types=None, max_entries=20, compress_with_llm=True, digest_source="test")
    with pytest.raises(RuntimeError):
        asyncio.run(run())
    assert not stored and not archived
    failing = False
    assert asyncio.run(run())["archived"] == 2
    assert len(stored) == 2 and len(archived) == 1


@pytest.mark.parametrize("scope,other_scope", [
    (scope, other) for scope in ("working_memory", "ltm", "people", "journal")
    for other in ("diary", "journal", "ltm", "working_memory", "people") if scope != other
])
def test_scoped_wipes_only_invalidate_their_own_writes(tmp_path, scope, other_scope):
    agent = offline_agent(tmp_path)
    hub = agent.memory_hub
    writers = {
        "working_memory": lambda: hub.save_wm_snapshot("retained", user_id="u"),
        "ltm": lambda: hub.mutate_semantic(lambda: "retained"),
        "people": lambda: hub.add_person_fact("p", "fact", display_name="person"),
        "journal": lambda: hub.add_journal_entry("retained"),
    }
    token = MEMORY_JOB.set((hub, dict(hub._generations)))
    try:
        hub.wipe([other_scope])
        writers[scope]()
        hub.wipe([scope])
        with pytest.raises(asyncio.CancelledError):
            writers[scope]()
    finally:
        MEMORY_JOB.reset(token)
        hub.close()


def test_deprecated_diary_options_do_not_create_duplicate_jobs(tmp_path):
    from offline_support import OfflineModel
    agent = offline_agent(tmp_path)
    agent.llm_memory = OfflineModel("memory")
    agent.config["llm"]["async_reflection"] = {"enabled": True}
    agent.config["memory"]["emotional_layer"] = {"enabled": True, "diary_after_turn": True}
    async def run():
        await agent.chat("first", discord_user_id="123", channel_id="77")
        assert not getattr(agent, "_background_jobs", set())
        agent.config["memory"]["diary_after_turn"] = True
        await agent.chat("second", discord_user_id="123", channel_id="77")
        await asyncio.gather(*list(agent._background_jobs))
        notes = agent.memory_hub.list_diary_notes()
        assert len(notes) == 1 and notes[0]["source"] == "turn_diary"
        assert len(agent.llm_memory.messages) == 1
    asyncio.run(run())
    agent.memory_hub.close()


def test_nested_job_cannot_bypass_a_prior_scoped_wipe(tmp_path):
    from core.agent.model_trace import spawn_background
    agent = offline_agent(tmp_path)
    hub = agent.memory_hub
    async def run():
        token = MEMORY_JOB.set((hub, dict(hub._generations)))
        try:
            hub.wipe(["diary"])
            async def child():
                hub.add_diary_note("must not return")
            with pytest.raises(asyncio.CancelledError):
                await spawn_background(agent, "nested-diary", child)
            assert hub.list_diary_notes() == []
        finally:
            MEMORY_JOB.reset(token)
    asyncio.run(run())
    hub.close()
