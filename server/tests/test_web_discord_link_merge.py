"""Web account linking must adopt the existing Discord person and merge memory."""

import pytest

from core.api.web_identity import WebIdentity, provision_web_identity
from core.memory.stores import LongTermMemory
from core.memory.hub import MemoryHub


class FakeSemantic:
    rag_enabled = False

    def __init__(self, *, fail=False, fail_at=None):
        self.calls = []
        self.fail = fail
        self.fail_at = fail_at

    def migrate_user_id(self, old_user_id, new_user_id, ids=None):
        if self.fail or (self.fail_at is not None and len(self.calls) + 1 == self.fail_at):
            raise RuntimeError("chroma down")
        self.calls.append((old_user_id, new_user_id, list(ids or [])))
        return list(ids) if ids else ["doc-1"]


def _hub(tmp_path, semantic=None):
    return MemoryHub(
        {"memory": {"sqlite_path": str(tmp_path / "hub.db"), "rag_enabled": False}},
        semantic=semantic,
    )


def test_web_link_adopts_existing_discord_person(tmp_path):
    hub = _hub(tmp_path)
    discord = hub.ensure_person_for_account(platform="discord", platform_user_id="123", display_name="Dima")
    identity = WebIdentity(
        person_id="web-person",
        role="user",
        name="dima@example.test",
        user_id="web-user",
        discord_id="123",
    )
    out = provision_web_identity(hub, identity)
    assert out.person_id == discord["id"]
    assert hub.sqlite.get_account("web", "web-user")["person_id"] == discord["id"]
    hub.close()


def test_web_link_merges_existing_web_person_into_discord(tmp_path):
    hub = _hub(tmp_path)
    discord = hub.ensure_person_for_account(platform="discord", platform_user_id="456", display_name="Dima")
    web = hub.ensure_person_for_account(platform="web", platform_user_id="web-user-2", display_name="dima@example.test")
    hub.add_person_fact(discord["id"], "Discord fact", source="test")
    hub.add_person_fact(web["id"], "Web fact", source="test")
    identity = WebIdentity(
        person_id=web["id"],
        role="user",
        name="dima@example.test",
        user_id="web-user-2",
        discord_id="456",
    )
    out = provision_web_identity(hub, identity)
    assert out.person_id == discord["id"]
    assert hub.sqlite.get_account("web", "web-user-2")["person_id"] == discord["id"]
    facts = hub.list_person_facts(discord["id"], limit=20)
    texts = {item["fact"] for item in facts}
    assert {"Discord fact", "Web fact"} <= texts
    hub.close()


def test_web_without_linked_discord_keeps_web_person(tmp_path):
    hub = _hub(tmp_path)
    identity = WebIdentity(
        person_id="web-person",
        role="user",
        name="dima@example.test",
        user_id="web-user-3",
    )
    out = provision_web_identity(hub, identity)
    assert hub.sqlite.get_account("web", "web-user-3")["person_id"] == out.person_id
    hub.close()


def test_undo_merge_is_not_repeated_by_provision(tmp_path):
    hub = _hub(tmp_path)
    discord = hub.ensure_person_for_account(platform="discord", platform_user_id="789", display_name="Dima")
    web = hub.ensure_person_for_account(platform="web", platform_user_id="web-user-4", display_name="email")
    identity = WebIdentity(person_id=web["id"], role="user", name="email", user_id="web-user-4", discord_id="789")
    provision_web_identity(hub, identity)
    assert hub.sqlite.get_account("web", "web-user-4")["person_id"] == discord["id"]
    hub.undo_merge(1)
    out = provision_web_identity(hub, identity)
    assert out.person_id == web["id"]
    assert hub.sqlite.get_account("web", "web-user-4")["person_id"] == web["id"]
    proposals = hub.sqlite.list_merge_proposals(status="pending")
    assert len(proposals) == 1
    provision_web_identity(hub, identity)
    assert len(hub.sqlite.list_merge_proposals(status="pending")) == 1
    hub.close()


def test_changing_linked_discord_does_not_merge_two_discord_people(tmp_path):
    hub = _hub(tmp_path)
    second = hub.ensure_person_for_account(platform="discord", platform_user_id="222", display_name="Second")
    web = hub.ensure_person_for_account(platform="web", platform_user_id="web-user-5", display_name="email")
    hub.sqlite.upsert_person_account(person_id=web["id"], platform="discord", platform_user_id="111")
    identity = WebIdentity(person_id=web["id"], role="user", name="email", user_id="web-user-5", discord_id="222")
    out = provision_web_identity(hub, identity)
    assert out.person_id == web["id"]
    assert hub.sqlite.get_account("web", "web-user-5")["person_id"] == web["id"]
    assert hub.sqlite.get_account("discord", "222")["person_id"] == second["id"]
    assert hub.sqlite.get_account("discord", "111")["person_id"] == web["id"]
    assert len(hub.sqlite.list_merge_proposals(status="pending")) == 1
    hub.close()


def test_merge_moves_web_chat_history_and_undo_restores_it(tmp_path):
    hub = _hub(tmp_path)
    discord = hub.ensure_person_for_account(platform="discord", platform_user_id="321", display_name="Dima")
    web = hub.ensure_person_for_account(platform="web", platform_user_id="web-user-6", display_name="email")
    hub.append_chat(role="user", user_id=web["id"], channel_id="web:web-user-6:c1", text="web history")
    identity = WebIdentity(person_id=web["id"], role="user", name="email", user_id="web-user-6", discord_id="321")
    provision_web_identity(hub, identity)
    assert [r["text"] for r in hub.list_chat(user_id=discord["id"], limit=10)] == ["web history"]
    hub.undo_merge(1)
    assert [r["text"] for r in hub.list_chat(user_id=web["id"], limit=10)] == ["web history"]
    assert hub.list_chat(user_id=discord["id"], limit=10) == []
    hub.close()


def test_merge_moves_working_memory_snapshot_and_undo_restores(tmp_path):
    hub = _hub(tmp_path)
    discord = hub.ensure_person_for_account(platform="discord", platform_user_id="654", display_name="D")
    web = hub.ensure_person_for_account(platform="web", platform_user_id="web-user-7", display_name="e")
    hub.save_wm_snapshot("Web memory", user_id=web["id"])
    identity = WebIdentity(person_id=web["id"], role="user", name="e", user_id="web-user-7", discord_id="654")
    provision_web_identity(hub, identity)
    assert hub.sqlite.latest_wm_snapshot(user_id=discord["id"])["content"] == "Web memory"
    hub.undo_merge(1)
    assert hub.sqlite.latest_wm_snapshot(user_id=web["id"])["content"] == "Web memory"
    assert hub.sqlite.latest_wm_snapshot(user_id=discord["id"]) is None
    hub.close()


def test_rejected_proposal_is_not_recreated(tmp_path):
    hub = _hub(tmp_path)
    hub.ensure_person_for_account(platform="discord", platform_user_id="777", display_name="D")
    web = hub.ensure_person_for_account(platform="web", platform_user_id="web-user-8", display_name="e")
    hub.sqlite.upsert_person_account(person_id=web["id"], platform="discord", platform_user_id="111")
    identity = WebIdentity(person_id=web["id"], role="user", name="e", user_id="web-user-8", discord_id="777")
    provision_web_identity(hub, identity)
    proposal = hub.sqlite.list_merge_proposals(status="pending")[0]
    hub.sqlite.resolve_merge_proposal(int(proposal["id"]), status="rejected")
    provision_web_identity(hub, identity)
    assert hub.sqlite.list_merge_proposals(status="pending") == []
    hub.close()


def test_merge_failure_keeps_web_account_and_propagates(tmp_path, monkeypatch):
    hub = _hub(tmp_path)
    hub.ensure_person_for_account(platform="discord", platform_user_id="888", display_name="D")
    web = hub.ensure_person_for_account(platform="web", platform_user_id="web-user-9", display_name="e")
    identity = WebIdentity(person_id=web["id"], role="user", name="e", user_id="web-user-9", discord_id="888")

    def boom(*args, **kwargs):
        raise RuntimeError("merge failed")

    monkeypatch.setattr(hub, "merge_people", boom)
    with pytest.raises(RuntimeError):
        provision_web_identity(hub, identity)
    assert hub.sqlite.get_account("web", "web-user-9")["person_id"] == web["id"]
    hub.close()


def test_semantic_migration_uses_migrated_ids_on_undo(tmp_path):
    semantic = FakeSemantic()
    hub = _hub(tmp_path, semantic)
    discord = hub.ensure_person_for_account(platform="discord", platform_user_id="901", display_name="D")
    web = hub.ensure_person_for_account(platform="web", platform_user_id="web-user-10", display_name="e")
    identity = WebIdentity(person_id=web["id"], role="user", name="e", user_id="web-user-10", discord_id="901")
    provision_web_identity(hub, identity)
    assert semantic.calls == [(web["id"], discord["id"], [])]
    hub.undo_merge(1)
    assert semantic.calls[-1] == (discord["id"], web["id"], ["doc-1"])
    hub.close()


def test_semantic_failure_rolls_back_merge(tmp_path):
    semantic = FakeSemantic(fail=True)
    hub = _hub(tmp_path, semantic)
    discord = hub.ensure_person_for_account(platform="discord", platform_user_id="902", display_name="D")
    web = hub.ensure_person_for_account(platform="web", platform_user_id="web-user-11", display_name="e")
    identity = WebIdentity(person_id=web["id"], role="user", name="e", user_id="web-user-11", discord_id="902")
    with pytest.raises(RuntimeError):
        provision_web_identity(hub, identity)
    assert hub.sqlite.get_account("web", "web-user-11")["person_id"] == web["id"]
    assert hub.sqlite.get_person(discord["id"]) is not None
    assert hub.sqlite.get_person(web["id"]) is not None
    hub.close()


class _FakeChromaCollection:
    def __init__(self, docs):
        self.docs = {doc_id: dict(meta) for doc_id, meta in docs.items()}

    def get(self, where=None, include=None):
        ids = []
        metas = []
        for doc_id, meta in self.docs.items():
            if where and any(meta.get(k) != v for k, v in where.items()):
                continue
            ids.append(doc_id)
            metas.append(dict(meta))
        return {"ids": ids, "metadatas": metas}

    def update(self, ids, metadatas):
        for doc_id, meta in zip(ids, metadatas):
            self.docs[doc_id] = dict(meta)


def test_migrate_user_metadata_moves_only_requested_ids(tmp_path):
    memory = LongTermMemory({"memory": {"rag_enabled": True, "chroma_db_path": str(tmp_path / "chroma")}})
    memory._collection = _FakeChromaCollection({
        "web-doc": {"user_id": "web"},
        "discord-doc": {"user_id": "discord"},
        "other-doc": {"user_id": "other"},
    })
    moved = memory.migrate_user_metadata("web", "discord")
    assert moved == ["web-doc"]
    assert memory._collection.docs["web-doc"]["user_id"] == "discord"
    assert memory._collection.docs["discord-doc"]["user_id"] == "discord"
    back = memory.migrate_user_metadata("discord", "web", ["web-doc"])
    assert back == ["web-doc"]
    assert memory._collection.docs["web-doc"]["user_id"] == "web"
    assert memory._collection.docs["discord-doc"]["user_id"] == "discord"
    assert memory.migrate_user_metadata("discord", "web", []) == []


def test_semantic_failure_then_retry_merges(tmp_path):
    semantic = FakeSemantic(fail=True)
    hub = _hub(tmp_path, semantic)
    discord = hub.ensure_person_for_account(platform="discord", platform_user_id="903", display_name="D")
    web = hub.ensure_person_for_account(platform="web", platform_user_id="web-user-12", display_name="e")
    identity = WebIdentity(person_id=web["id"], role="user", name="e", user_id="web-user-12", discord_id="903")
    with pytest.raises(RuntimeError):
        provision_web_identity(hub, identity)
    assert hub.sqlite.merge_log_count() == 0
    semantic.fail = False
    out = provision_web_identity(hub, identity)
    assert out.person_id == discord["id"]
    hub.close()


def test_provision_is_idempotent_after_merge(tmp_path):
    hub = _hub(tmp_path)
    discord = hub.ensure_person_for_account(platform="discord", platform_user_id="904", display_name="D")
    web = hub.ensure_person_for_account(platform="web", platform_user_id="web-user-13", display_name="e")
    identity = WebIdentity(person_id=web["id"], role="user", name="e", user_id="web-user-13", discord_id="904")
    provision_web_identity(hub, identity)
    assert hub.sqlite.merge_log_count() == 1
    provision_web_identity(hub, identity)
    assert hub.sqlite.merge_log_count() == 1
    assert hub.sqlite.get_account("web", "web-user-13")["person_id"] == discord["id"]
    hub.close()


def test_keyerror_race_returns_already_merged_person(tmp_path, monkeypatch):
    hub = _hub(tmp_path)
    discord = hub.ensure_person_for_account(platform="discord", platform_user_id="905", display_name="D")
    web = hub.ensure_person_for_account(platform="web", platform_user_id="web-user-14", display_name="e")
    identity = WebIdentity(person_id=web["id"], role="user", name="e", user_id="web-user-14", discord_id="905")

    def merge_then_raise(survivor, source, **kwargs):
        hub.sqlite.merge_people_atomic(survivor_id=survivor, source_id=source, reason="race")
        raise KeyError(source)

    monkeypatch.setattr(hub, "merge_people", merge_then_raise)
    out = provision_web_identity(hub, identity)
    assert out.person_id == discord["id"]
    hub.close()


def test_undo_semantic_failure_queues_and_retries(tmp_path):
    semantic = FakeSemantic(fail_at=2)
    hub = _hub(tmp_path, semantic)
    discord = hub.ensure_person_for_account(platform="discord", platform_user_id="906", display_name="D")
    web = hub.ensure_person_for_account(platform="web", platform_user_id="web-user-15", display_name="e")
    identity = WebIdentity(person_id=web["id"], role="user", name="e", user_id="web-user-15", discord_id="906")
    provision_web_identity(hub, identity)
    hub._semantic_retry_at = 0
    stats = hub.undo_merge(1)
    assert stats["semantic_restore_pending"] is True
    semantic.fail = False
    semantic.fail_at = None
    assert hub.sqlite.pending_semantic_restores()
    hub._semantic_retry_at = 0
    assert hub.retry_semantic_restores() == 1
    assert hub.sqlite.pending_semantic_restores() == []
    assert semantic.calls[-1] == (stats["survivor_id"], stats["restored_id"], ["doc-1"])
    before = len(semantic.calls)
    hub._semantic_retry_at = 0
    assert hub.retry_semantic_restores() == 0
    assert len(semantic.calls) == before
    hub.close()


def test_apply_merge_proposal_migrates_semantic(tmp_path):
    semantic = FakeSemantic()
    hub = _hub(tmp_path, semantic)
    hub.ensure_person_for_account(platform="discord", platform_user_id="907", display_name="D")
    web = hub.ensure_person_for_account(platform="web", platform_user_id="web-user-16", display_name="e")
    hub.sqlite.upsert_person_account(person_id=web["id"], platform="discord", platform_user_id="111")
    identity = WebIdentity(person_id=web["id"], role="user", name="e", user_id="web-user-16", discord_id="907")
    provision_web_identity(hub, identity)
    proposal = hub.sqlite.list_merge_proposals(status="pending")[0]
    hub.apply_merge_proposal(int(proposal["id"]))
    assert semantic.calls[-1][0] == web["id"]
    hub.close()


def test_migrate_raises_when_rag_enabled_but_collection_missing(tmp_path, monkeypatch):
    memory = LongTermMemory({"memory": {"rag_enabled": True, "chroma_db_path": str(tmp_path / "chroma")}})
    monkeypatch.setattr(memory, "initialize", lambda: None)
    memory._collection = None
    with pytest.raises(RuntimeError, match="semantic_collection_unavailable"):
        memory.migrate_user_metadata("a", "b")


def test_missing_semantic_ids_stop_after_three_attempts(tmp_path):
    semantic = FakeSemantic()
    hub = _hub(tmp_path, semantic)
    hub.sqlite.queue_semantic_restore(1, "survivor", "source", ["deleted-doc"])
    semantic.migrate_user_id = lambda old, new, ids=None: []
    for _ in range(3):
        hub._semantic_retry_at = 0
        hub.retry_semantic_restores()
    assert hub.sqlite.pending_semantic_restores() == []
    hub.close()


def test_wipe_people_clears_semantic_restore_queue(tmp_path):
    hub = _hub(tmp_path)
    hub.sqlite.queue_semantic_restore(1, "survivor", "source", ["doc"])
    hub.sqlite.add_merge_proposal(person_a="a", person_b="b", reason="test")
    out = hub.wipe(["people"])["deleted"]
    assert hub.sqlite.pending_semantic_restores() == []
    assert out["semantic_restore"] == 1
    assert out["merge_proposals"] == 1
    assert hub.sqlite.list_merge_proposals() == []
    hub.close()


def test_semantic_restore_queue_is_healed_on_startup(tmp_path):
    hub = _hub(tmp_path)
    hub.sqlite._conn.execute("DROP TABLE semantic_restore_queue")
    hub.close()
    hub = _hub(tmp_path)
    hub.sqlite.queue_semantic_restore(1, "survivor", "source", ["doc"])
    assert hub.sqlite.pending_semantic_restores()[0]["chroma_ids"] == ["doc"]
    hub.close()
